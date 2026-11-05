import { getApi } from '../api.ts'
import { parseSkillMarkdown } from './skillFormat.ts'

/**
 * 开放注册接口：其它插件在运行期通过 `callPlugin('top.qomicex.assistant', 'ai.*')`
 * 向 AI 助手注册 Skill / MCP。
 *
 * 为什么是运行期注册而不是 manifest 字段：
 *   - 启动器 manifest 反序列化是严格 struct，自定义字段会被丢弃；
 *   - callPlugin 在目标插件未加载时会直接 reject，启动器也没有跨插件依赖注入；
 *   - 注册是内存态 + cache 持久化，插件卸载后已注册内容仍可用。
 *
 * 身份限制（已知且无法在插件侧修复）：`__plugin_registry_call` 不带 caller
 * pluginId，所以 payload 里的 providerId 不可信。这里只校验「该插件确实装了」，
 * 设置页标注 verified=false，不把它当安全边界。
 */

const CACHE_KEY = 'ai.registry.v1'
const ID_RE = /^[a-z0-9._-]+$/

export const MAX_SKILL_BYTES = 64 * 1024
export const MAX_SKILL_FILES = 10
export const MAX_SKILL_FILE_BYTES = 32 * 1024
export const MAX_SKILLS_PER_PROVIDER = 20
export const MAX_MCP_PER_PROVIDER = 10
export const MAX_SKILLS_GLOBAL = 100
export const MAX_MCP_GLOBAL = 30
export const MAX_MCP_SERVERS_CAPABILITY = 10
const MAX_HEADER_VALUE = 2048
const MAX_HEADERS = 20
const NAME_MAX = 64
const DESC_MAX = 500

export interface RegisteredFile {
  path: string
  content: string
}

export interface RegisteredSkill {
  providerId: string
  id: string
  name: string
  description: string
  content: string
  files?: RegisteredFile[]
  enabled: boolean
  verified: boolean
  registeredAt: string
}

export interface RegisteredMcp {
  providerId: string
  id: string
  name: string
  url: string
  headers?: Record<string, string>
  enabled: boolean
  verified: boolean
  registeredAt: string
}

interface RegistryState {
  v: 1
  skills: RegisteredSkill[]
  mcp: RegisteredMcp[]
}

let state: RegistryState = { v: 1, skills: [], mcp: [] }
let loaded = false
let loadPromise: Promise<void> | null = null
let methodsRegistered = false
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* 订阅方异常不能影响注册流程 */
    }
  })
}

export function subscribeRegistry(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function api() {
  return getApi()
}

// ---------- 持久化 ----------
function normalizeSkill(v: any): RegisteredSkill | null {
  if (!v || typeof v !== 'object') return null
  const providerId = String(v.providerId || '')
  const id = String(v.id || '')
  if (!ID_RE.test(providerId) || !ID_RE.test(id)) return null
  return {
    providerId,
    id,
    name: String(v.name || id).slice(0, NAME_MAX),
    description: String(v.description || '').slice(0, DESC_MAX),
    content: String(v.content || ''),
    files: Array.isArray(v.files)
      ? v.files
          .filter((f: any) => f && typeof f.path === 'string')
          .slice(0, MAX_SKILL_FILES)
          .map((f: any) => ({ path: String(f.path), content: String(f.content || '') }))
      : undefined,
    enabled: v.enabled !== false,
    verified: v.verified === true,
    registeredAt: typeof v.registeredAt === 'string' ? v.registeredAt : new Date(0).toISOString(),
  }
}

function normalizeMcp(v: any): RegisteredMcp | null {
  if (!v || typeof v !== 'object') return null
  const providerId = String(v.providerId || '')
  const id = String(v.id || '')
  if (!ID_RE.test(providerId) || !ID_RE.test(id)) return null
  const url = String(v.url || '')
  if (!/^https?:\/\//i.test(url)) return null
  return {
    providerId,
    id,
    name: String(v.name || id).slice(0, NAME_MAX),
    url,
    headers: v.headers && typeof v.headers === 'object' ? (v.headers as Record<string, string>) : undefined,
    enabled: v.enabled !== false,
    verified: v.verified === true,
    registeredAt: typeof v.registeredAt === 'string' ? v.registeredAt : new Date(0).toISOString(),
  }
}

function applyRaw(raw: any): boolean {
  const skills = raw && Array.isArray(raw.skills) ? raw.skills.map(normalizeSkill).filter(Boolean) : []
  const mcp = raw && Array.isArray(raw.mcp) ? raw.mcp.map(normalizeMcp).filter(Boolean) : []
  const next: RegistryState = { v: 1, skills: skills as RegisteredSkill[], mcp: mcp as RegisteredMcp[] }
  const changed = JSON.stringify(next) !== JSON.stringify(state)
  state = next
  return changed
}

export function ensureRegistryLoaded(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const a = api()
    if (a) {
      try {
        applyRaw(await a.call('getCache', CACHE_KEY))
      } catch {
        // 读不到就当空注册表；不阻塞对话
      }
    }
    loaded = true
  })().finally(() => {
    loadPromise = null
  })
  return loadPromise
}

/**
 * 重新从 cache 同步注册表。
 *
 * 设置页 / 悬浮窗 / agent 是不同 iframe，内存不互通：在设置页禁用/删除第三方
 * 注册项后，聊天 iframe 必须重新读一次 cache 才能看见。每次发送前调用一次
 * （一次 IPC，成本很低），只有内容真的变化才通知目录缓存失效。
 */
export async function reloadRegistryFromCache(): Promise<void> {
  const a = api()
  if (!a) return
  try {
    if (applyRaw(await a.call('getCache', CACHE_KEY))) notify()
  } catch {
    // 忽略：沿用内存中的注册表
  }
}

async function persist(): Promise<void> {
  const a = api()
  if (!a) return
  try {
    await a.call('setCache', CACHE_KEY, state)
  } catch {
    // cache 写失败不影响本次运行期使用
  }
}

// ---------- 校验 ----------
function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function safeRelPath(p: unknown): string | null {
  const s = String(p || '')
    .replace(/\\/g, '/')
    .trim()
  if (!s || s.length > 200) return null
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  if (s.split('/').some((seg) => seg === '..')) return null
  return s
}

/** 名称/描述来自不可信插件：压成单行，避免伪造提示词章节。 */
function oneLine(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

function sanitizeHeaders(input: unknown): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, headers: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'headers 必须是对象' }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > MAX_HEADERS) return { ok: false, error: `headers 最多 ${MAX_HEADERS} 项` }
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    const key = String(k || '').trim()
    if (!key || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) return { ok: false, error: `header 名称非法：${key}` }
    if (/^host$/i.test(key) || /^content-length$/i.test(key)) return { ok: false, error: `不允许设置 ${key}（由启动器代理决定）` }
    const value = String(v ?? '')
    if (value.length > MAX_HEADER_VALUE) return { ok: false, error: `header ${key} 的值超过 ${MAX_HEADER_VALUE} 字符` }
    out[key] = value
  }
  return { ok: true, headers: out }
}

// ---------- provider 校验（不可信，仅标注） ----------
let pluginIdsCache: { at: number; ids: Set<string> } | null = null
const PLUGIN_IDS_TTL = 60 * 1000

async function installedPluginIds(): Promise<Set<string> | null> {
  const now = Date.now()
  if (pluginIdsCache && now - pluginIdsCache.at < PLUGIN_IDS_TTL) return pluginIdsCache.ids
  const a = api()
  if (!a) return null
  try {
    const list: any = await a.call('callBackend', '/plugins')
    if (!Array.isArray(list)) return null
    const ids = new Set<string>()
    for (const p of list) {
      const id = p && (p.manifest?.id || p.id)
      if (typeof id === 'string' && id) ids.add(id)
    }
    pluginIdsCache = { at: now, ids }
    return ids
  } catch {
    return null
  }
}

async function verifyProvider(providerId: string): Promise<boolean> {
  if (providerId === 'top.qomicex.assistant') return true
  const ids = await installedPluginIds()
  return !!(ids && ids.has(providerId))
}

function countByProvider<T extends { providerId: string }>(list: T[], providerId: string): number {
  return list.filter((x) => x.providerId === providerId).length
}

// ---------- 注册 ----------
export async function registerSkill(payload: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await ensureRegistryLoaded()
  if (!payload || typeof payload !== 'object') return fail('payload 必须是对象')
  const p = payload as any
  const providerId = String(p.providerId || '').trim()
  const id = String(p.id || '').trim()
  if (!ID_RE.test(providerId)) return fail('providerId 必须匹配 /^[a-z0-9._-]+$/')
  if (!ID_RE.test(id)) return fail('id 必须匹配 /^[a-z0-9._-]+$/')
  if (typeof p.content !== 'string' || !p.content.trim()) return fail('content 必填且不能为空')
  if (p.content.length > MAX_SKILL_BYTES) return fail(`content 超过 ${Math.round(MAX_SKILL_BYTES / 1024)}KB（${p.content.length} 字符）`)

  const parsed = parseSkillMarkdown(p.content)
  if (!parsed.body.trim()) return fail('content 正文为空（frontmatter 之后没有内容）')
  const name = oneLine(p.name || parsed.meta.name || id, NAME_MAX)
  const description = oneLine(p.description || parsed.meta.description || '', DESC_MAX)
  if (!name) return fail('name 必填')
  if (!description) return fail('description 必填（系统提示词靠它判断何时加载技能）')

  let files: RegisteredFile[] | undefined
  if (p.files !== undefined) {
    if (!Array.isArray(p.files)) return fail('files 必须是数组')
    if (p.files.length > MAX_SKILL_FILES) return fail(`files 最多 ${MAX_SKILL_FILES} 个`)
    files = []
    for (const f of p.files) {
      if (!f || typeof f !== 'object') return fail('files 的每一项必须是 { path, content }')
      const rel = safeRelPath(f.path)
      if (!rel) return fail(`文件路径非法（不能是绝对路径或包含 ..）：${String(f.path)}`)
      const content = String(f.content ?? '')
      if (content.length > MAX_SKILL_FILE_BYTES) return fail(`文件 ${rel} 超过 ${Math.round(MAX_SKILL_FILE_BYTES / 1024)}KB`)
      files.push({ path: rel, content })
    }
  }

  const existing = state.skills.find((s) => s.providerId === providerId && s.id === id)
  if (!existing && countByProvider(state.skills, providerId) >= MAX_SKILLS_PER_PROVIDER) {
    return fail(`每个提供者最多注册 ${MAX_SKILLS_PER_PROVIDER} 个技能`)
  }
  if (!existing && state.skills.length >= MAX_SKILLS_GLOBAL) return fail(`全局技能数量已达上限 ${MAX_SKILLS_GLOBAL}`)

  const verified = await verifyProvider(providerId)
  const entry: RegisteredSkill = {
    providerId,
    id,
    name,
    description,
    // 注册内容按纯文本处理；frontmatter 由我们剥离，正文里的任何代码/脚本都不会执行
    content: parsed.body,
    files,
    enabled: p.enabled !== false,
    verified,
    registeredAt: new Date().toISOString(),
  }
  if (existing) state.skills = state.skills.map((s) => (s === existing ? entry : s))
  else state.skills = [...state.skills, entry]
  await persist()
  notify()
  return { ok: true, id: `plugin:${providerId}/${id}` }
}

export async function registerMcp(payload: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await ensureRegistryLoaded()
  if (!payload || typeof payload !== 'object') return fail('payload 必须是对象')
  const p = payload as any
  const providerId = String(p.providerId || '').trim()
  const id = String(p.id || '').trim()
  if (!ID_RE.test(providerId)) return fail('providerId 必须匹配 /^[a-z0-9._-]+$/')
  if (!ID_RE.test(id)) return fail('id 必须匹配 /^[a-z0-9._-]+$/')
  const name = oneLine(p.name || id, NAME_MAX)
  if (!name) return fail('name 必填')
  const url = String(p.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return fail('url 只允许 http(s) 地址')
  if (url.length > 4096) return fail('url 过长')
  const h = sanitizeHeaders(p.headers)
  if (!h.ok) return fail(h.error)

  const existing = state.mcp.find((s) => s.providerId === providerId && s.id === id)
  if (!existing && countByProvider(state.mcp, providerId) >= MAX_MCP_PER_PROVIDER) {
    return fail(`每个提供者最多注册 ${MAX_MCP_PER_PROVIDER} 个 MCP 服务器`)
  }
  if (!existing && state.mcp.length >= MAX_MCP_GLOBAL) return fail(`全局 MCP 服务器数量已达上限 ${MAX_MCP_GLOBAL}`)

  const verified = await verifyProvider(providerId)
  const entry: RegisteredMcp = {
    providerId,
    id,
    name,
    url,
    headers: Object.keys(h.headers).length ? h.headers : undefined,
    enabled: p.enabled !== false,
    verified,
    registeredAt: new Date().toISOString(),
  }
  if (existing) state.mcp = state.mcp.map((s) => (s === existing ? entry : s))
  else state.mcp = [...state.mcp, entry]
  await persist()
  notify()
  return { ok: true, id: `plugin:${providerId}/${id}` }
}

export async function unregister(payload: unknown): Promise<{ ok: true; removed?: boolean } | { ok: false; error: string }> {
  await ensureRegistryLoaded()
  if (!payload || typeof payload !== 'object') return fail('payload 必须是对象')
  const p = payload as any
  const providerId = String(p.providerId || '').trim()
  const type = String(p.type || '').trim()
  const id = String(p.id || '').trim()
  if (!ID_RE.test(providerId)) return fail('providerId 非法')
  if (type !== 'skill' && type !== 'mcp') return fail("type 必须是 'skill' 或 'mcp'")
  if (!ID_RE.test(id)) return fail('id 非法')

  let removed = false
  if (type === 'skill') {
    const next = state.skills.filter((s) => !(s.providerId === providerId && s.id === id))
    removed = next.length !== state.skills.length
    state.skills = next
  } else {
    const next = state.mcp.filter((s) => !(s.providerId === providerId && s.id === id))
    removed = next.length !== state.mcp.length
    state.mcp = next
  }
  await persist()
  notify()
  return { ok: true, removed }
}

export function getRegisteredSkills(): RegisteredSkill[] {
  return state.skills
}

export function getRegisteredMcp(): RegisteredMcp[] {
  return state.mcp
}

export interface RegisteredSkillMeta {
  providerId: string
  id: string
  name: string
  description: string
  enabled: boolean
  verified: boolean
  registeredAt: string
}

export interface RegisteredMcpMeta {
  providerId: string
  id: string
  name: string
  url: string
  enabled: boolean
  verified: boolean
  registeredAt: string
}

export async function listRegistered(): Promise<{ skills: RegisteredSkillMeta[]; mcp: RegisteredMcpMeta[] }> {
  await ensureRegistryLoaded()
  return {
    skills: state.skills.map((s) => ({
      providerId: s.providerId,
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      verified: s.verified,
      registeredAt: s.registeredAt,
    })),
    mcp: state.mcp.map((s) => ({
      providerId: s.providerId,
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      verified: s.verified,
      registeredAt: s.registeredAt,
    })),
  }
}

/** 设置页：启用/禁用第三方注册项（持久化）。 */
export async function setRegisteredEnabled(
  type: 'skill' | 'mcp',
  providerId: string,
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  await ensureRegistryLoaded()
  const list: any[] = type === 'skill' ? state.skills : state.mcp
  const hit = list.find((s) => s.providerId === providerId && s.id === id)
  if (!hit) return { ok: false, error: '未找到该注册项' }
  hit.enabled = enabled === true
  await persist()
  notify()
  return { ok: true }
}

/** 设置页：删除第三方注册项。 */
export async function removeRegistered(type: 'skill' | 'mcp', providerId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await unregister({ providerId, type, id })
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

// ---------- 对外方法注册 ----------
const CAPABILITIES = {
  version: 1,
  accepts: ['skill', 'mcp'] as const,
  maxSkillBytes: MAX_SKILL_BYTES,
  maxServers: MAX_MCP_SERVERS_CAPABILITY,
}

/** 在 engine.init() 里调用；重复调用无副作用。 */
export function initRegistry(): void {
  if (methodsRegistered) return
  methodsRegistered = true
  const a = api()
  if (!a || !a.registerMethod) return

  const register = (name: string, fn: (...args: unknown[]) => unknown) => {
    try {
      a.registerMethod(name, fn)
    } catch {
      // dev / 无 registry 环境下静默失败
    }
  }

  register('ai.capabilities', () => CAPABILITIES)
  register('ai.registerSkill', async (payload: unknown) => {
    try {
      return await registerSkill(payload)
    } catch (e: any) {
      return fail('注册技能失败：' + String((e && e.message) || e || '未知错误'))
    }
  })
  register('ai.registerMcp', async (payload: unknown) => {
    try {
      return await registerMcp(payload)
    } catch (e: any) {
      return fail('注册 MCP 失败：' + String((e && e.message) || e || '未知错误'))
    }
  })
  register('ai.unregister', async (payload: unknown) => {
    try {
      return await unregister(payload)
    } catch (e: any) {
      return fail('注销失败：' + String((e && e.message) || e || '未知错误'))
    }
  })
  register('ai.list', async () => {
    try {
      return await listRegistered()
    } catch {
      return { skills: [], mcp: [] }
    }
  })
}
