import { getApi } from '../api.ts'
import type { ToolDef } from './types.ts'
import { subscribeRegistry, getRegisteredMcp } from './registry.ts'

/**
 * MCP（Model Context Protocol）客户端：只做 HTTP/SSE，不做 stdio。
 *
 * 启动器没有 MCP 实现，也没有通用 HTTP 客户端：所有请求都走
 * `proxyFetch`（CORS 代理）。之所以用**非流式** proxyFetch 而不是
 * proxyFetchStream：
 *   - 需要读响应头里的 `Mcp-Session-Id`（stream 通道不回传响应头）；
 *   - MCP 的 SSE 响应体是有限长度的（一次 JSON-RPC 响应），代理缓冲完
 *     再整体返回即可，手动解析 `data:` 行。
 *
 * 注意：启动器代理把 timeoutMs 夹在 1000–60000ms，所以这里的 120s 常量
 * 实际最多 60s；工具调用超时会以错误结果返回，不会打断整轮对话。
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']
const LIST_TIMEOUT = 30000
const CALL_TIMEOUT = 60000
const RUNTIME_TTL = 5 * 60 * 1000
const DEFS_TTL = 30 * 1000
const MAX_TOOLS = 200
const MAX_PAGES = 10
const MAX_RESULT_CHARS = 20000
const META_TOOL = 'McpListTools'

export interface McpServerConfig {
  id: string
  name: string
  url: string
  headers?: Record<string, string>
  enabled: boolean
  /** config = 设置页手工添加；plugin = 第三方运行期注册 */
  source?: 'config' | 'plugin'
  verified?: boolean
}

export interface McpToolInfo {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ServerSession {
  protocolVersion: string
  sessionId?: string
  serverInfo?: any
}

interface ServerRuntime {
  key: string
  at: number
  tools: McpToolInfo[]
  error?: string
  session?: ServerSession
}

let settings = { enabled: true, servers: [] as McpServerConfig[] }
let runtimeCache = new Map<string, ServerRuntime>()
let defsCache: { at: number; key: string; defs: ToolDef[] } | null = null
let refreshPromise: Promise<void> | null = null
let aliasMap = new Map<string, { serverId: string; toolName: string }>()
let discoverErrors: Record<string, string> = {}
let currentSignal: AbortSignal | undefined
let notifier: ((msg: string) => void) | null = null
let reportedErrors = new Set<string>()
let rpcSeq = 0

// ---------- 配置 ----------
function normalizeServer(raw: any): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  const url = String(raw.url || '').trim()
  if (!id || !/^https?:\/\//i.test(url)) return null
  const headers: Record<string, string> = {}
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      const key = String(k || '').trim()
      if (!key || /^host$/i.test(key) || /^content-length$/i.test(key)) continue
      headers[key] = String(v ?? '')
    }
  }
  return {
    id,
    name: String(raw.name || id),
    url,
    headers: Object.keys(headers).length ? headers : undefined,
    enabled: raw.enabled !== false,
    source: raw.source === 'plugin' ? 'plugin' : 'config',
    verified: raw.verified === true,
  }
}

export function configureMcp(next: { enabled?: boolean; servers?: McpServerConfig[] }): void {
  const enabled = next.enabled !== undefined ? next.enabled === true : settings.enabled
  const servers = next.servers !== undefined ? (next.servers.map(normalizeServer).filter(Boolean) as McpServerConfig[]) : settings.servers
  const changed = enabled !== settings.enabled || JSON.stringify(servers) !== JSON.stringify(settings.servers)
  settings = { enabled, servers }
  if (changed) invalidateMcpCache()
}

export function getMcpSettings(): { enabled: boolean; servers: McpServerConfig[] } {
  return { enabled: settings.enabled, servers: settings.servers.slice() }
}

export function invalidateMcpCache(): void {
  runtimeCache = new Map()
  defsCache = null
  aliasMap = new Map()
  discoverErrors = {}
  reportedErrors = new Set()
}

export function setMcpNotifier(fn: ((msg: string) => void) | null): void {
  notifier = fn
}

/** 引擎在每次工具调用前设置当前 AbortSignal（停止生成时中断 MCP 请求）。 */
export function setToolAbortSignal(signal: AbortSignal | undefined): void {
  currentSignal = signal
}

subscribeRegistry(() => invalidateMcpCache())

function allServers(): McpServerConfig[] {
  const reg: McpServerConfig[] = getRegisteredMcp().map((r) => ({
    id: `plugin:${r.providerId}/${r.id}`,
    name: r.name,
    url: r.url,
    headers: r.headers,
    enabled: r.enabled,
    source: 'plugin',
    verified: r.verified,
  }))
  const seen = new Set(settings.servers.map((s) => s.id))
  return [...settings.servers, ...reg.filter((s) => !seen.has(s.id))]
}

function serverKey(s: McpServerConfig): string {
  return JSON.stringify([s.id, s.url, s.headers || {}])
}

function findServer(id: string): McpServerConfig | undefined {
  return allServers().find((s) => s.id === id)
}

// ---------- HTTP / JSON-RPC ----------
function lowerHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h || typeof h !== 'object') return out
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v)
  return out
}

function buildHeaders(s: McpServerConfig, session?: ServerSession, protocol?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocol || session?.protocolVersion || PROTOCOL_VERSIONS[0],
  }
  const custom = s.headers || {}
  for (const [k, v] of Object.entries(custom)) {
    if (/^host$/i.test(k) || /^content-length$/i.test(k)) continue
    headers[k] = v
  }
  if (session?.sessionId) headers['Mcp-Session-Id'] = session.sessionId
  return headers
}

interface RawResponse {
  status: number
  headers: Record<string, string>
  text: string
}

async function postJsonRpc(
  server: McpServerConfig,
  body: unknown,
  session: ServerSession | undefined,
  protocol: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  const headers = buildHeaders(server, session, protocol)
  const payload = JSON.stringify(body)
  const api = getApi()
  if (api && api.call) {
    const res: any = await api.call('proxyFetch', {
      url: server.url,
      method: 'POST',
      headers,
      body: payload,
      timeoutMs: Math.min(Math.max(timeoutMs, 1000), CALL_TIMEOUT),
      ...(currentSignal ? { signal: currentSignal } : {}),
    })
    if (!res) throw new Error('代理没有返回响应')
    return { status: Number(res.status) || 0, headers: lowerHeaders(res.headers), text: String(res.body ?? '') }
  }

  // 开发模式（浏览器直开、没有 __PLUGIN_API__）：直接 fetch，便于用本地 mock 验收
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (currentSignal) {
    if (currentSignal.aborted) controller.abort()
    else currentSignal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetch(server.url, { method: 'POST', headers, body: payload, signal: controller.signal })
    const text = await res.text()
    const h: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      h[k.toLowerCase()] = v
    })
    return { status: res.status, headers: h, text }
  } finally {
    clearTimeout(timer)
    if (currentSignal) currentSignal.removeEventListener('abort', onAbort)
  }
}

interface JsonRpcError {
  code?: number
  message?: string
  data?: unknown
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: any
  error?: JsonRpcError
}

/** 手动解析 SSE：按空行分帧，`event: ping` 忽略，按 id 匹配。 */
function parseSseForId(text: string, expectedId?: number): JsonRpcResponse | null {
  let event = ''
  let data: string[] = []
  const frames: { event: string; data: string }[] = []
  const flush = () => {
    if (data.length || event) frames.push({ event, data: data.join('\n') })
    event = ''
    data = []
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx < 0 ? line : line.slice(0, idx)
    let value = idx < 0 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  flush()

  let fallback: JsonRpcResponse | null = null
  for (const f of frames) {
    if (f.event === 'ping') continue
    const payload = f.data.trim()
    if (!payload) continue
    let json: JsonRpcResponse | null = null
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    if (!json || typeof json !== 'object') continue
    if (expectedId !== undefined && json.id === expectedId) return json
    if (!fallback) fallback = json
  }
  return expectedId === undefined ? fallback : null
}

function parseRpcBody(res: RawResponse, expectedId?: number): JsonRpcResponse | null {
  const text = String(res.text || '').trim()
  if (!text) return null
  const contentType = res.headers['content-type'] || ''
  const looksJson = text.startsWith('{') || text.startsWith('[')
  if (looksJson && !contentType.includes('text/event-stream')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return expectedId === undefined ? (parsed[0] || null) : parsed.find((p: any) => p && p.id === expectedId) || null
      }
      return parsed
    } catch {
      // 落到 SSE 解析
    }
  }
  return parseSseForId(text, expectedId)
}

function httpErrorMessage(res: RawResponse): string {
  const text = String(res.text || '').slice(0, 400)
  if (text) {
    try {
      const j = JSON.parse(String(res.text))
      const msg = j?.error?.message || j?.message || j?.error
      if (typeof msg === 'string' && msg) return `${res.status}: ${msg}`
    } catch {
      /* ignore */
    }
    return `${res.status}: ${text}`
  }
  return `HTTP ${res.status}`
}

async function rpcCall(
  server: McpServerConfig,
  session: ServerSession | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  protocol?: string,
): Promise<any> {
  const id = ++rpcSeq
  const res = await postJsonRpc(server, { jsonrpc: '2.0', id, method, params: params || {} }, session, protocol, timeoutMs)
  if (res.status === 401 || res.status === 403) {
    throw new Error(`HTTP ${res.status}（服务器拒绝访问，请检查 headers / token）`)
  }
  if (res.status < 200 || res.status >= 300) throw new Error(httpErrorMessage(res))
  const body = parseRpcBody(res, id)
  if (!body) throw new Error(`MCP ${method} 返回空响应或无法解析（可能不是 JSON-RPC 服务）`)
  if (body.error) throw new Error(`MCP ${method} 失败: ${body.error.message || '未知错误'}`)
  return body.result
}

async function initialize(server: McpServerConfig, protocolVersion: string): Promise<{ session: ServerSession; result: any }> {
  const id = ++rpcSeq
  const res = await postJsonRpc(
    server,
    {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'Qomicex AI Assistant', version: '3.2.0' },
      },
    },
    undefined,
    protocolVersion,
    LIST_TIMEOUT,
  )
  if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}（服务器拒绝访问，请检查 headers / token）`)
  if (res.status < 200 || res.status >= 300) throw new Error(httpErrorMessage(res))
  const body = parseRpcBody(res, id)
  if (!body) throw new Error('MCP initialize 返回空响应或无法解析（可能不是 JSON-RPC 服务）')
  if (body.error) throw new Error(`MCP initialize 失败: ${body.error.message || '未知错误'}`)
  const result = body.result
  // 会话 id 在 initialize 的响应头里（不是 notifications 的响应头）
  const session: ServerSession = {
    protocolVersion: String(result?.protocolVersion || protocolVersion),
    sessionId: res.headers['mcp-session-id'] || undefined,
    serverInfo: result?.serverInfo,
  }
  try {
    await postJsonRpc(
      server,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      session,
      session.protocolVersion,
      LIST_TIMEOUT,
    )
  } catch {
    // 通知失败不影响后续 tools/list；部分服务器直接返回 202/204 或拒绝通知
  }
  return { session, result }
}

async function ensureSession(server: McpServerConfig, runtime: ServerRuntime | undefined, force: boolean): Promise<ServerSession> {
  const key = serverKey(server)
  if (!force && runtime && runtime.key === key && runtime.session && Date.now() - runtime.at < RUNTIME_TTL) {
    return runtime.session
  }
  let lastError: unknown = null
  for (const v of PROTOCOL_VERSIONS) {
    try {
      const { session } = await initialize(server, v)
      return session
    } catch (e) {
      lastError = e
      if (currentSignal?.aborted) throw e
      // 协议版本不被接受时回退到旧版本；其它错误也试一次，成本很低
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'MCP initialize 失败'))
}

async function listTools(server: McpServerConfig, session: ServerSession): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES && out.length < MAX_TOOLS; page++) {
    const result = await rpcCall(
      server,
      session,
      'tools/list',
      cursor ? { cursor } : {},
      LIST_TIMEOUT,
      session.protocolVersion,
    )
    const tools: any[] = Array.isArray(result?.tools) ? result.tools : []
    for (const t of tools) {
      if (!t || typeof t.name !== 'string' || !t.name) continue
      out.push({
        serverId: server.id,
        serverName: server.name,
        name: t.name,
        description: String(t.description || ''),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      })
      if (out.length >= MAX_TOOLS) break
    }
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
    if (!cursor) break
  }
  return out
}

async function serverTools(
  server: McpServerConfig,
  force: boolean,
): Promise<{ tools: McpToolInfo[]; error?: string }> {
  const key = serverKey(server)
  const cached = runtimeCache.get(server.id)
  if (!force && cached && cached.key === key && Date.now() - cached.at < RUNTIME_TTL) {
    return { tools: cached.tools, error: cached.error }
  }
  let session: ServerSession | undefined = !force && cached && cached.key === key ? cached.session : undefined
  try {
    session = await ensureSession(server, cached, force || !session)
    let tools: McpToolInfo[]
    try {
      tools = await listTools(server, session)
    } catch (e) {
      // session 过期（服务器重启/回收）时重新 initialize 一次
      if (currentSignal?.aborted) throw e
      session = await ensureSession(server, undefined, true)
      tools = await listTools(server, session)
    }
    runtimeCache.set(server.id, { key, at: Date.now(), tools, session })
    return { tools }
  } catch (e: any) {
    const aborted = currentSignal?.aborted
    const msg = aborted ? '请求已中断' : String((e && e.message) || e || '未知错误')
    // 用户停止生成导致的中断不是服务器故障：不要把错误写进 5 分钟缓存
    if (aborted) return { tools: cached?.tools || [] }
    runtimeCache.set(server.id, {
      key,
      at: Date.now(),
      tools: [],
      session,
      error: msg,
    })
    return { tools: [], error: msg }
  }
}

// ---------- 工具发现 ----------
const SYSTEM_PROMPT_TOOL_LIMIT_TOTAL = 40
const SYSTEM_PROMPT_TOOL_LIMIT_SERVER = 25

function cleanSchema(schema: any): Record<string, unknown> {
  const out =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? { ...(schema as Record<string, unknown>) }
      : ({ type: 'object', properties: {} } as Record<string, unknown>)
  delete out.$schema
  delete out.additionalProperties
  if (!out.type) out.type = 'object'
  if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) out.properties = {}
  return out
}

function sanitizeSeg(v: string): string {
  return String(v || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80) || 'x'
}

function makeAlias(serverId: string, toolName: string, used: Set<string>): string {
  const prefix = 'mcp__'
  const max = 64 - prefix.length
  let s = sanitizeSeg(serverId)
  let t = sanitizeSeg(toolName)
  if (s.length + 2 + t.length > max) {
    t = t.slice(0, Math.max(1, max - 2 - Math.min(s.length, 12)))
    s = s.slice(0, Math.max(1, max - 2 - t.length))
  }
  let name = (prefix + s + '__' + t).slice(0, 64)
  let n = 2
  while (used.has(name)) {
    const suffix = '_' + n++
    name = name.slice(0, 64 - suffix.length) + suffix
  }
  used.add(name)
  return name
}

function buildDefs(tools: McpToolInfo[]): { defs: ToolDef[]; aliases: Map<string, { serverId: string; toolName: string }>; meta: boolean } {
  const perServer: Record<string, number> = {}
  for (const t of tools) perServer[t.serverId] = (perServer[t.serverId] || 0) + 1
  const tooMany = tools.length > SYSTEM_PROMPT_TOOL_LIMIT_TOTAL || Object.values(perServer).some((n) => n > SYSTEM_PROMPT_TOOL_LIMIT_SERVER)
  if (tooMany) {
    return {
      defs: [
        {
          type: 'function',
          function: {
            name: META_TOOL,
            description:
              `MCP 工具较多（共 ${tools.length} 个），已折叠。` +
              '不传参数时列出各服务器的工具与参数结构；传 serverId 只列该服务器；' +
              '要调用某个工具时传 serverId + tool + arguments（arguments 为 JSON 对象）。',
            parameters: {
              type: 'object',
              properties: {
                serverId: { type: 'string', description: '服务器 id（可选）' },
                tool: { type: 'string', description: '要调用的工具名（可选；留空则只列出工具）' },
                arguments: { type: 'object', description: '调用工具的参数对象（仅当传了 tool 时使用）' },
              },
            },
          },
        },
      ],
      aliases: new Map(),
      meta: true,
    }
  }

  const used = new Set<string>()
  const aliases = new Map<string, { serverId: string; toolName: string }>()
  const defs: ToolDef[] = tools.map((t) => {
    const alias = makeAlias(t.serverId, t.name, used)
    aliases.set(alias, { serverId: t.serverId, toolName: t.name })
    const desc = t.description.length > 200 ? t.description.slice(0, 200) + '…' : t.description || t.name
    return {
      type: 'function',
      function: {
        name: alias,
        description: `[MCP ${t.serverName}] ${desc}`,
        parameters: cleanSchema(t.inputSchema),
      },
    } satisfies ToolDef
  })
  return { defs, aliases, meta: false }
}

async function discover(force: boolean): Promise<{ tools: McpToolInfo[]; errors: Record<string, string> }> {
  const servers = allServers().filter((s) => s.enabled)
  const errors: Record<string, string> = {}
  if (!servers.length) return { tools: [], errors }
  const results = await Promise.all(
    servers.map(async (s) => ({ server: s, r: await serverTools(s, force) })),
  )
  const tools: McpToolInfo[] = []
  for (const { server, r } of results) {
    if (r.error) {
      errors[server.id] = r.error
      const key = server.id + '|' + r.error
      if (!reportedErrors.has(key)) {
        reportedErrors.add(key)
        if (notifier && !currentSignal?.aborted) notifier(`MCP 服务器「${server.name}」不可用：${r.error}`)
      }
    } else {
      tools.push(...r.tools)
    }
  }
  return { tools, errors }
}

async function refreshRuntime(key: string, force: boolean): Promise<void> {
  const { tools, errors } = await discover(force)
  // 用户点了停止：这一轮结果不可靠，直接丢弃，下一轮重新发现
  if (currentSignal?.aborted) return
  const built = buildDefs(tools)
  aliasMap = built.aliases
  discoverErrors = errors
  defsCache = { at: Date.now(), key, defs: built.defs }
}

/**
 * 32 秒/30 秒缓存 + 首轮最多等 6 秒：
 * MCP 探测是网络 IO，绝不能因为它把整轮对话卡住。目录已缓存时直接返回并后台刷新；
 * 首次没有缓存时最多等 6 秒，超时就先不带 MCP 工具发车，后台结果下一轮生效。
 */
export async function getMcpToolDefs(force = false): Promise<ToolDef[]> {
  if (!settings.enabled) {
    aliasMap = new Map()
    defsCache = null
    return []
  }
  const key = JSON.stringify(
    allServers()
      .filter((s) => s.enabled)
      .map((s) => [s.id, s.url, s.headers || {}]),
  )
  const fresh = !!defsCache && defsCache.key === key && Date.now() - defsCache.at < DEFS_TTL
  if (fresh && !force) {
    if (!refreshPromise) {
      refreshPromise = refreshRuntime(key, false)
        .catch(() => {})
        .finally(() => {
          refreshPromise = null
        })
    }
    return defsCache!.defs
  }
  if (!refreshPromise) {
    refreshPromise = refreshRuntime(key, force || !fresh)
      .catch(() => {})
      .finally(() => {
        refreshPromise = null
      })
  }
  await Promise.race([
    refreshPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 6000)),
  ])
  return defsCache && defsCache.key === key ? defsCache.defs : []
}

export async function refreshMcp(): Promise<void> {
  invalidateMcpCache()
  await getMcpToolDefs(true)
}

// ---------- 工具调用 ----------
function normalizeCallResult(result: any): { text: string; isError: boolean } {
  const isError = result?.isError === true
  const parts: string[] = []
  const content: any[] = Array.isArray(result?.content) ? result.content : []
  for (const c of content) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (c.type === 'image') parts.push(`[图片 ${c.mimeType || ''}]`)
    else if (c.type === 'audio') parts.push(`[音频 ${c.mimeType || ''}]`)
    else if (c.type === 'resource') parts.push(`[资源 ${c.resource?.uri || ''}] ${String(c.resource?.text || '')}`)
    else if (c.type === 'resource_link') parts.push(`[资源链接] ${c.uri || c.name || ''}`)
    else parts.push(JSON.stringify(c))
  }
  if (result?.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent))
    } catch {
      /* ignore */
    }
  }
  let text = parts.join('\n').trim()
  if (!text) {
    try {
      text = JSON.stringify(result)
    } catch {
      text = String(result)
    }
  }
  return { text, isError }
}

async function callTool(server: McpServerConfig, toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const cached = runtimeCache.get(server.id)
  let session = await ensureSession(server, cached, false)
  try {
    const result = await rpcCall(server, session, 'tools/call', { name: toolName, arguments: args || {} }, CALL_TIMEOUT, session.protocolVersion)
    return normalizeCallResult(result)
  } catch (e) {
    if (currentSignal?.aborted) throw e
    session = await ensureSession(server, undefined, true)
    const result = await rpcCall(server, session, 'tools/call', { name: toolName, arguments: args || {} }, CALL_TIMEOUT, session.protocolVersion)
    return normalizeCallResult(result)
  }
}

function truncateResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false }
  return { text: text.slice(-MAX_RESULT_CHARS), truncated: true }
}

export async function toolCallMcp(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const server = findServer(serverId)
  if (!server) return { error: `MCP 服务器不存在：${serverId}（可能已被删除）` }
  if (!server.enabled) return { error: `MCP 服务器「${server.name}」已禁用` }
  try {
    const { text, isError } = await callTool(server, toolName, args || {})
    const cut = truncateResult(text)
    const body = cut.truncated
      ? `（结果超过 ${MAX_RESULT_CHARS} 字符，仅保留末尾）\n` + cut.text
      : cut.text
    if (isError) {
      return {
        error: `MCP 工具 ${server.name}/${toolName} 返回错误：${body.slice(0, 1000)}`,
        __raw_text: `ERROR ${server.name}/${toolName}\n${body}`,
      }
    }
    return {
      __ui_summary: `MCP ${server.name}/${toolName} 完成`,
      __raw_text: `MCP 工具 ${server.name}/${toolName} 返回：\n${body}`,
    }
  } catch (e: any) {
    const aborted = currentSignal?.aborted
    const msg = aborted ? '已停止' : String((e && e.message) || e || '未知错误')
    return { error: `MCP 工具调用失败（${server.name}/${toolName}）：${msg}` }
  }
}

/** 折叠模式下的元工具：列工具，或按需直调。 */
async function toolMcpListTools(args: Record<string, any>): Promise<unknown> {
  const servers = allServers().filter((s) => s.enabled)
  const serverId = String(args.serverId || '').trim()
  const tool = String(args.tool || '').trim()
  if (serverId && tool) {
    let callArgs: any = args.arguments
    if (typeof callArgs === 'string') {
      try {
        callArgs = JSON.parse(callArgs)
      } catch {
        callArgs = {}
      }
    }
    if (!callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs)) callArgs = {}
    return toolCallMcp(serverId, tool, callArgs)
  }
  const selected = serverId ? servers.filter((s) => s.id === serverId) : servers
  if (!selected.length) {
    return {
      error: serverId ? `没找到启用的 MCP 服务器：${serverId}` : '当前没有启用的 MCP 服务器',
      __ui_summary: 'MCP 工具列表为空',
      __raw_text: '当前没有启用的 MCP 服务器。请让用户在设置里添加并启用。',
    }
  }
  const lines: string[] = []
  for (const s of selected) {
    const r = await serverTools(s, false)
    if (r.error) {
      lines.push(`## ${s.name} (${s.id})\n不可用：${r.error}`)
      continue
    }
    lines.push(`## ${s.name} (${s.id}) · ${r.tools.length} 个工具`)
    for (const t of r.tools) {
      lines.push(`- ${t.name}: ${t.description.slice(0, 200) || '(无描述)'}`)
      lines.push('  parameters: ' + JSON.stringify(cleanSchema(t.inputSchema)))
    }
  }
  const text = lines.join('\n')
  const errText = Object.entries(discoverErrors)
    .map(([id, err]) => `- ${id}: ${err}`)
    .join('\n')
  return {
    __ui_summary: `MCP 工具列表（${selected.length} 个服务器）`,
    __raw_text:
      text +
      (errText ? '\n\n## 发现失败\n' + errText : '') +
      '\n\n调用方式：McpListTools(serverId, tool, arguments)。',
  }
}

/** 静态 handlers 未命中时由 engine 调用；返回 undefined 表示不是 MCP 工具。 */
export function resolveMcpHandler(name: string): ((a: Record<string, any>) => Promise<unknown>) | undefined {
  if (name === META_TOOL) return toolMcpListTools
  const hit = aliasMap.get(name)
  if (hit) return (args) => toolCallMcp(hit.serverId, hit.toolName, args || {})
  if (name.startsWith('mcp__')) {
    return async () => ({
      error: '这个 MCP 工具已失效（服务器配置或工具列表已变化）。请重新查看可用工具后再试。',
    })
  }
  return undefined
}

/** 工具卡片上的中文名；未命中时回退原名（engine 负责）。 */
export function describeMcpTool(name: string): string | null {
  if (name === META_TOOL) return 'MCP 工具列表'
  const hit = aliasMap.get(name)
  if (!hit) return null
  const server = findServer(hit.serverId)
  return `MCP·${server?.name || hit.serverId}/${hit.toolName}`
}

export function getMcpDiscoveryErrors(): Record<string, string> {
  return { ...discoverErrors }
}

// ---------- 设置页 ----------
export interface McpTestResult {
  ok: boolean
  toolCount?: number
  tools?: string[]
  protocolVersion?: string
  error?: string
}

export async function testMcpServer(server: McpServerConfig): Promise<McpTestResult> {
  const normalized = normalizeServer(server)
  if (!normalized) return { ok: false, error: 'url 必须是 http(s) 地址' }
  try {
    const session = await ensureSession(normalized, undefined, true)
    const tools = await listTools(normalized, session)
    // 测试成功顺手刷新运行期缓存，用户回到对话不用再等一轮
    runtimeCache.set(normalized.id, { key: serverKey(normalized), at: Date.now(), tools, session })
    defsCache = null
    return {
      ok: true,
      toolCount: tools.length,
      tools: tools.slice(0, 30).map((t) => t.name),
      protocolVersion: session.protocolVersion,
    }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e || '未知错误') }
  }
}

export async function listMcpStatus(): Promise<
  Array<{ id: string; name: string; url: string; source?: string; enabled: boolean; verified?: boolean; toolCount?: number; error?: string }>
> {
  const servers = allServers()
  return servers.map((s) => {
    const rt = runtimeCache.get(s.id)
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      source: s.source,
      enabled: s.enabled,
      verified: s.verified,
      toolCount: rt ? rt.tools.length : undefined,
      error: rt?.error,
    }
  })
}
