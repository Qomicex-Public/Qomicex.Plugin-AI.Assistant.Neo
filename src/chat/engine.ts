import type { ChatMessage, UiMessage, ToolEntryLine, ReasoningEffort, Modality, MessagePart, FilePermission, ToolDef, PermissionRequest } from './types.ts'
import { getApi } from '../api.ts'
import { SYSTEM_PROMPT, UI_CONTROL_PROMPT, MCP_PROMPT } from './systemPrompt.ts'
import { toolDefs } from './toolDefs.ts'
import { uiToolDefs } from './uiTools.ts'
import { resolveHandler, setApiRef, toolDisplayName, type ToolArgs } from './handlers.ts'
import { configureSkills, isSkillToolAvailable, skillsPromptSection } from './skills.ts'
import { configureMcp, getMcpToolDefs, setMcpNotifier, setToolAbortSignal, type McpServerConfig } from './mcp.ts'
import { ensureRegistryLoaded, initRegistry, reloadRegistryFromCache } from './registry.ts'
import { setPermissionRequester, type WritePermissionResult } from './permissionTools.ts'
import { setToolPermission } from './fileTools.ts'
import { setUiControlEnabled } from './uiControl.ts'
import { workspacePromptSection, isWindowsPlatform, permissionAllows } from './permissions.ts'
import { streamTurn, describeHttpError, type StreamTurnCtx } from './stream.ts'
import { compressContext, manualCompress, summarizeToolResult, estimateTokens, loadDsTokenizer, type CompressDeps } from './compress.ts'
import { renderMd, renderMdSync } from './markdown.ts'
import {
  type ConversationMeta,
  deleteConversation as histDelete,
  listConversations,
  loadConversation,
  newConversationId,
  renameConversation as histRename,
  saveConversation,
} from './history.ts'
import { setCurrentConversationId } from './pending.ts'
import { pluginLog } from '../lib/pluginLog.ts'

const CURSOR = '<span class="stream-cursor">&#9621;</span>'

/**
 * 单次提问内允许的工具调用轮数（默认值；用户可在设置里改）。
 *
 * 原来是硬编码 10，实测多步任务（读文件 → 改 → 构建 → 修错 → 再构建）几分钟就用完，
 * 用户看到「工具调用次数过多」被打断，且这句提示容易被误读成被服务商限流。
 * 默认 45：正常任务够用，同时保留上限兜底——防止模型在工具间死循环时
 * 无限燃烧 token（每一轮都是一次完整请求）。
 */
export const DEFAULT_TOOL_ROUNDS = 45

const WELCOME = '你好！我是 AI 助手。有什么需要帮忙的？'

export interface EngineSnapshot {
  cfg: {
    apiKey: string
    baseUrl: string
    model: string
    maxCtx: number
    showToolProcess: boolean
    /** 全局默认思考强度 */
    reasoningEffort: ReasoningEffort
    /** 当前生效的思考强度（会话覆盖优先） */
    effectiveEffort: ReasoningEffort
    /** 该模型支持的模态 */
    modalities: Modality[]
    /** 全局默认文件权限 */
    filePermission: FilePermission
    /** 当前生效的文件权限（会话覆盖优先） */
    effectivePermission: FilePermission
    /** 单次回复输出上限 */
    maxTokens: number
    /** 单次提问内允许的工具调用轮数 */
    maxToolRounds: number
    /** 「启动器操作」（UI 自动化）总开关 */
    uiControl: boolean
    /** 技能总开关 */
    skillsEnabled: boolean
    /** 用户技能目录（空 = 不启用） */
    skillsDir: string
    /** 被禁用的技能 id */
    disabledSkills: string[]
    /** MCP 总开关 */
    mcpEnabled: boolean
    /** MCP 服务器配置 */
    mcpServers: McpServerConfig[]
    configured: boolean
    thinking: boolean
  }
  view: 'chat' | 'config' | 'history'
  ui: UiMessage[]
  ctxUsage: { text: string; warn: boolean }
  /** 当前会话 id */
  conversationId: string
  /** 当前会话标题 */
  conversationTitle: string
  /** 历史会话索引 */
  conversations: ConversationMeta[]
  /** 等待用户确认的权限提升请求 */
  permissionRequest: PermissionRequest | null
}

// ---------- 内部状态 ----------
const state = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  maxCtx: 200,
  showToolProcess: true,
  reasoningEffort: 'off' as ReasoningEffort,
  modalities: ['text'] as Modality[],
  /** 全局默认文件权限 */
  filePermission: 'readonly' as FilePermission,
  /** 「启动器操作」开关：开启后才会把这组 UI 自动化工具挂给模型 */
  uiControl: false,
  /** 技能总开关（关闭后目录与 Skill 工具都不可见） */
  skillsEnabled: true,
  /** 用户技能目录；空 = 不扫描 */
  skillsDir: '',
  /** 被禁用的技能 id（来源隔离的稳定 id） */
  disabledSkills: [] as string[],
  /** MCP 总开关 */
  mcpEnabled: false,
  /** MCP 服务器配置（设置页维护；第三方注册的服务器由 registry 合并） */
  mcpServers: [] as McpServerConfig[],
  /** 单次回复输出上限（思考与正文共享） */
  maxTokens: 8192,
  /** 单次提问内允许的工具调用轮数 */
  maxToolRounds: DEFAULT_TOOL_ROUNDS,
  /** 会话级文件权限覆盖；null = 跟随全局默认 */
  permissionOverride: null as FilePermission | null,
  /** 会话级思考强度覆盖；null = 跟随全局默认 */
  effortOverride: null as ReasoningEffort | null,
  thinking: false,
  messages: [] as ChatMessage[],
}
let view: 'chat' | 'config' | 'history' = 'chat'
let ui: UiMessage[] = []
let ctxUsage = { text: '', warn: false }
let conversationId = newConversationId()
let conversationTitle = '新对话'
let conversations: ConversationMeta[] = []
let abortCtrl: AbortController | null = null
let stopRequested = false
/** 权限提升请求：同一时间只允许一个；由 UI 确认/取消 */
let pendingPermission: PermissionRequest | null = null
let permissionResolver: ((ok: boolean) => void) | null = null
let permissionTimer: ReturnType<typeof setTimeout> | null = null
let permissionSeq = 0
let permissionTimedOut = false
/** 用户拒绝后 15 秒内不再弹窗，避免模型反复申请骚扰用户 */
let lastPermissionDeniedAt = 0
const PERMISSION_TIMEOUT_MS = 120000
let thinkingStart = 0
let uiSeq = 0
function nextId() {
  return ++uiSeq
}

const listeners = new Set<() => void>()

function buildSnapshot(): EngineSnapshot {
  return {
    cfg: {
      apiKey: state.apiKey,
      baseUrl: state.baseUrl,
      model: state.model,
      maxCtx: state.maxCtx,
      showToolProcess: state.showToolProcess,
      reasoningEffort: state.reasoningEffort,
      effectiveEffort: state.effortOverride ?? state.reasoningEffort,
      modalities: state.modalities,
      filePermission: state.filePermission,
      effectivePermission: state.permissionOverride ?? state.filePermission,
      maxTokens: state.maxTokens,
      maxToolRounds: state.maxToolRounds,
      uiControl: state.uiControl,
      skillsEnabled: state.skillsEnabled,
      skillsDir: state.skillsDir,
      disabledSkills: state.disabledSkills,
      mcpEnabled: state.mcpEnabled,
      mcpServers: state.mcpServers,
      configured: !!state.apiKey,
      thinking: state.thinking,
    },
    view: view,
    ui: ui,
    ctxUsage: ctxUsage,
    conversationId: conversationId,
    conversationTitle: conversationTitle,
    conversations: conversations,
    permissionRequest: pendingPermission,
  }
}

let currentSnapshot: EngineSnapshot = buildSnapshot()

function emit() {
  currentSnapshot = buildSnapshot()
  listeners.forEach((l) => l())
}

function getSnapshot(): EngineSnapshot {
  return currentSnapshot
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// ---------- UI 操作 ----------
function pushUi(partial: Partial<UiMessage> & { kind: UiMessage['kind'] }): number {
  const id = nextId()
  ui = [...ui, { id: id, ...partial } as UiMessage]
  emit()
  return id
}

function updateAiPlain(id: number, content: string) {
  ui = ui.map((m) => (m.id === id ? { ...m, content: content, streaming: true } : m))
  emit()
}

function updateAiHtml(id: number, html: string, streaming?: boolean, content?: string) {
  ui = ui.map((m) => (m.id === id ? { ...m, html: html, streaming: streaming ?? m.streaming, content: content ?? m.content } : m))
  emit()
}

function addProgress(msg: string, type: string) {
  if (!state.showToolProcess) return
  pushUi({ kind: 'progress', content: (type === 'error' ? '  ✗' : type === 'result' ? '  ←' : type === 'call' ? '  →' : type === 'thought' ? '+ Thought' : '  •') + ' ' + msg })
}

function addToolEntry(toolName: string, argsText: string, timeMs: number): number {
  // 「显示工具调用过程」关闭时仍要执行工具，只是不渲染条目。返回 -1 供调用方跳过结果写入。
  if (!state.showToolProcess) return -1
  const cn = toolDisplayName(toolName)
  const base = '✦ 调用 ' + cn + ' (' + toolName + ') · ' + timeMs + 'ms'
  const id = pushUi({ kind: 'tool', toolName: toolName, content: base, toolArgsText: argsText, toolLines: [], collapsed: true })
  return id
}

function addToolResult(detailId: number, resultText: string, image?: string) {
  if (detailId < 0) return
  const line: ToolEntryLine = { result: resultText }
  // 带截图的结果默认展开：图就是结论，折叠起来等于让用户多点一次
  ui = ui.map((m) =>
    m.id === detailId ? { ...m, toolLines: [...(m.toolLines || []), line], ...(image ? { image: image, collapsed: false } : {}) } : m,
  )
  emit()
}

/**
 * 摘出界面截图的 data URL（就地删除，避免它被序列化进工具消息）。
 *
 * UiScreenshot 的结果里带着几百 KB 的 base64，**绝不能作为 tool 消息发出去** ——
 * 那会瞬间吃掉整个上下文，而且它本身也不是文本。所以这里摘掉，由调用方作为一条
 * 独立的「带图片的 user 消息」发给模型。
 */
function takeUiImages(result: unknown): string[] {
  const out: string[] = []
  if (!result || typeof result !== 'object' || Array.isArray(result)) return out
  const holder = result as Record<string, any>
  const img = holder.__ui_image
  if (typeof img === 'string' && img) out.push(img)
  else if (img && typeof img.dataUrl === 'string' && img.dataUrl) out.push(img.dataUrl)
  if (img !== undefined) delete holder.__ui_image
  return out
}

/**
 * 工具结果 → 发给模型的文本。
 *
 * 默认走 summarizeToolResult（对象只保留 4 个键、每值 80 字），这对普通 API 结果
 * 够用，但会把界面快照的元素清单削光。所以界面类工具自己在 handler 里排好版并用
 * __ui_text 给出已按字符预算裁剪的正文，这里直接透传。
 */
function toolResultText(name: string, result: unknown): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const t = (result as Record<string, unknown>).__ui_text
    if (typeof t === 'string' && t) return t
  }
  return summarizeToolResult(name, result)
}

/** 工具卡片上显示的一行摘要（界面类工具自带更可读的 __ui_summary）。 */
function toolSummary(result: unknown): string {
  if (Array.isArray(result)) return '返回 ' + result.length + ' 项'
  if (result && typeof result === 'object') {
    const r = result as Record<string, any>
    if (typeof r.__ui_summary === 'string' && r.__ui_summary) return r.__ui_summary
    return r.error ? '错误: ' + r.error : '完成'
  }
  return String(result).slice(0, 50)
}

export function toggleToolEntry(id: number) {
  ui = ui.map((m) => (m.id === id ? { ...m, collapsed: !m.collapsed } : m))
  emit()
}

/** 展开/收起思考过程（与上下文压缩无关）。默认收起，首次点击展开。 */
export function toggleThinking(id: number) {
  ui = ui.map((m) => (m.id !== id || m.kind !== 'thinking' ? m : { ...m, collapsed: !m.collapsed }))
  emit()
}

function finishThinking(id: number, doneText?: string) {
  ui = ui.map((m) => {
    if (m.id !== id || m.kind !== 'thinking' || m.done) return m
    const start = m.thinkingStart || Date.now()
    const text = doneText || '已思考 ' + formatDuration(Date.now() - start)
    // 思考结束即收起（用户可再点开查看过程）
    return { ...m, done: true, content: text, collapsed: true }
  })
  emit()
}

/** 把模型思考内容写进对应的思考条目（供点击展开）；没有内容就保持纯时长。 */
function setThinkingDetail(id: number, reasoning: string) {
  if (!reasoning) return
  ui = ui.map((m) => {
    if (m.id !== id || m.kind !== 'thinking') return m
    // 思考进行中自动展开，便于实时看到过程（结束后由 finishThinking 收起）
    return { ...m, detail: reasoning, collapsed: m.done ? m.collapsed : false }
  })
  emit()
}

function addTotalTime(ms: number) {
  pushUi({ kind: 'progress', content: '总耗时 ' + formatDuration(ms) })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  if (s < 60) return Math.round(s * 10) / 10 + 's'
  return Math.floor(s / 60) + 'min' + Math.round(s % 60) + 's'
}

// ---------- 上下文显示 ----------
function updateCtxDisplay() {
  const tokens = estimateTokens(state.messages)
  const maxK = state.maxCtx || 200
  const pct = maxK > 0 ? (tokens / (maxK * 1000)) * 100 : 0
  ctxUsage = {
    text: (tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : tokens + '') + ' (' + pct.toFixed(0) + '%)',
    warn: pct > 70,
  }
  emit()
}

const compressDeps: CompressDeps = {
  getState: () => ({
    apiKey: state.apiKey,
    baseUrl: state.baseUrl,
    model: state.model,
    maxCtx: state.maxCtx,
    thinking: state.thinking,
    messages: state.messages,
  }),
  setMessages: (m) => {
    state.messages = m
  },
  addProgress: (msg, type) => addProgress(msg, type),
  updateCtxDisplay: () => updateCtxDisplay(),
}

// ---------- 对话控制 ----------
function welcomeUi(): UiMessage {
  return { id: nextId(), kind: 'ai', content: WELCOME, streaming: false }
}

/** 采集现有 ui 里的最大 id，推进 uiSeq，避免恢复历史后新建条目与之撞 id。 */
function syncUiSeq() {
  for (const m of ui) {
    if (typeof m.id === 'number' && m.id > uiSeq) uiSeq = m.id
  }
}

/** 新对话：清空当前会话并生成新 id（写回 cache 供胶囊续接）。 */
export function newChat() {
  cancelPermissionRequest()
  state.messages = []
  if (abortCtrl) {
    abortCtrl.abort()
    abortCtrl = null
  }
  state.thinking = false
  conversationId = newConversationId()
  conversationTitle = '新对话'
  ui = [welcomeUi()]
  updateCtxDisplay()
  void setCurrentConversationId(conversationId)
}

/** 刷新历史索引（供侧边栏/历史面板展示）。 */
export async function refreshConversations(): Promise<void> {
  conversations = await listConversations()
  emit()
}

/**
 * 载入历史会话（从缓存恢复对话，UI 由 messages 重建）。
 *
 * 注意：即使缓存里还没有该会话的数据（例如胶囊刚建好的空会话），也必须**先接管这个 id**，
 * 否则本界面会用自己随机生成的 id 落盘，与胶囊/其他界面引用的 id 分叉，
 * 「继续当前会话」就失效了。
 */
export async function openConversation(id: string): Promise<void> {
  if (state.thinking) return
  const data = await loadConversation(id)
  conversationId = id
  conversationTitle = data?.title || '新对话'
  state.messages = data?.messages ? data.messages.slice() : []
  ui = rebuildUi(state.messages)
  if (ui.length === 0) ui = [welcomeUi()]
  // 必须先同步 uiSeq 再生成新条目，否则新 id 会与恢复的条目重复，
  // 后续 updateAiHtml/updateAiPlain 会命中错误条目（实测表现为「思考」气泡里显示回答正文）。
  syncUiSeq()
  view = 'chat'
  updateCtxDisplay()
  void setCurrentConversationId(id)
  // 补齐历史 AI 消息的 HTML（Markdown 兜底渲染）
  for (const m of ui) {
    if (m.kind === 'ai' && !m.html && m.content) {
      const id2 = m.id
      const text = m.content
      renderMd(text).then((html) => {
        ui = ui.map((x) => (x.id === id2 && x.kind === 'ai' ? { ...x, html } : x))
        emit()
      })
    }
  }
}

/**
 * 由对话消息重建 UI 列表。
 *
 * 只依赖 messages 而不是持久化 ui：ui 含流式中间态（未收尾的思考、半截 html、光标），
 * 存下来无法忠实还原（实测恢复后会出现缺失气泡、残留光标、id 撞号）。重建规则：
 *   - user → 用户气泡
 *   - assistant 有正文 → AI 气泡
 *   - assistant 只有 tool_calls → 「已思考」（工具过程不持久化，避免历史里堆一堆工具卡）
 *   - tool → 跳过（内容已进上下文，展示价值低）
 */
function rebuildUi(messages: ChatMessage[]): UiMessage[] {
  const out: UiMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // 用户消息可能是纯文本，也可能是多模态 parts 数组（文本 + 图片/视频附件）——
      // 后者要拆成「正文 + 附件缩略图」，否则气泡里会显示 [object Object]
      if (Array.isArray(m.content)) {
        const text = m.content
          .filter((p) => p && p.type === 'text')
          .map((p) => String(p.text || ''))
          .join(' ')
          .trim()
        const attachments = m.content.filter((p) => p && p.type !== 'text')
        out.push({
          id: nextId(),
          kind: 'user',
          content: text,
          attachments: attachments.length ? attachments : undefined,
        })
      } else {
        out.push({ id: nextId(), kind: 'user', content: String(m.content || '') })
      }
    } else if (m.role === 'assistant') {
      const text = String(m.content || '')
      if (!text && m.tool_calls && m.tool_calls.length) {
        out.push({ id: nextId(), kind: 'thinking', done: true, content: '已思考' })
      } else if (text) {
        out.push({ id: nextId(), kind: 'ai', content: text, streaming: false })
      }
    }
  }
  return out
}

export async function removeConversation(id: string): Promise<void> {
  await histDelete(id)
  conversations = conversations.filter((m) => m.id !== id)
  emit()
  if (id === conversationId) newChat()
}

export async function renameConv(id: string, title: string): Promise<void> {
  await histRename(id, title)
  if (id === conversationId) conversationTitle = title
  await refreshConversations()
}

export function showHistoryView() {
  view = 'history'
  emit()
  void refreshConversations()
}

/** 持久化当前会话（在用户消息与助手回复落定后调用）。 */
async function persistCurrent() {
  if (!state.apiKey) return
  const meta = await saveConversation({ id: conversationId, title: conversationTitle, messages: state.messages })
  if (meta) {
    conversationTitle = meta.title
    const idx = conversations.findIndex((m) => m.id === meta.id)
    if (idx >= 0) conversations[idx] = meta
    else conversations = [meta, ...conversations]
    emit()
  }
}

// ---------- 对话控制 ----------

function cleanup() {
  cancelPermissionRequest()
  state.thinking = false
  abortCtrl = null
  stopRequested = false
  emit()
}

export function stopGeneration() {
  cancelPermissionRequest()
  stopRequested = true
  if (abortCtrl) {
    abortCtrl.abort()
    abortCtrl = null
  }
  state.thinking = false
  ui = ui.filter((m) => m.kind !== 'thinking')
  pushUi({ kind: 'ai', content: '（已停止）', streaming: false })
}

/**
 * 组装系统提示词：基础规则 + 工作区路径 + 当前文件权限。
 *
 * 工作区路径每次会话开始时解析一次并缓存（resolveWorkspace 内部有 cache），
 * 权限则实时反映当前生效值，让 AI 知道现在能做什么、不能做什么。
 */
let cachedWorkspaceSection: string | null = null
async function buildSystemPrompt(): Promise<string> {
  // 第三方注册表可能还在异步载入；技能目录要合并它，先等一拍（已载入时是空 Promise）
  await ensureRegistryLoaded()
  if (cachedWorkspaceSection === null) {
    try {
      cachedWorkspaceSection = await workspacePromptSection()
    } catch {
      cachedWorkspaceSection = ''
    }
  }
  const perm = state.permissionOverride ?? state.filePermission
  const permText =
    perm === 'readonly'
      ? '只读：只能用 Read / Grep / GetProcessLogs，禁止 Write / Edit / Bash / RunProcess / StopProcess / DownloadFile / Compress / Decompress。确实需要写操作时调用 RequestWritePermission 向用户申请（会弹确认窗，确认后本会话切到可写）。'
      : perm === 'write'
        ? '可写：Read / Write / Edit / Grep / Bash / RunProcess / GetProcessLogs / StopProcess / DownloadFile / Compress / Decompress 均可用；首次访问未授权目录时启动器会弹窗要用户授权。'
        : '完全访问：所有文件与命令工具均可用，不再逐一确认。仍应避免破坏性操作。'
  // 界面操作章节只在开关打开时给：没开就不提，模型才不会以为自己能点界面
  const uiText = state.uiControl && isWindowsPlatform() ? `\n${UI_CONTROL_PROMPT}` : ''
  // 技能目录：只放名称/描述，正文由 Skill 工具按需加载；内容稳定，利于前缀缓存
  let skillText = ''
  try {
    skillText = await skillsPromptSection()
  } catch {
    skillText = ''
  }
  // 没启用 MCP 时不提，避免白占 token
  const mcpText = state.mcpEnabled ? `\n${MCP_PROMPT}` : ''
  return `${SYSTEM_PROMPT}\n${cachedWorkspaceSection}\n\n## 当前文件权限\n${permText}${uiText}${skillText}${mcpText}`
}

/**
 * 本次请求实际可用的工具集。
 *
 * 「启动器操作」是独立开关（与文件权限解耦）。关闭时这 6 个工具**根本不进工具列表**
 * —— 比让模型调用后再吃一个「未开启」的拒绝更省 token，也更不容易让它误判能力边界。
 *
 * 两个额外过滤：
 *   - 非 Windows 不提供（驱动依赖 UIAutomation + Win32 消息投递）。
 *   - 模型没声明 image 模态时不提供 UiScreenshot：截了也没法看，纯浪费一次抓屏。
 *
 * MCP 工具是运行期的，不进静态表；技能工具在没有可用技能时也隐藏。
 */
async function getActiveToolDefs(): Promise<ToolDef[]> {
  const canWrite = permissionAllows(effectivePermission(), 'write')
  const defs: ToolDef[] = toolDefs.filter((t) => {
    const name = t.function.name
    if (name === 'Skill' && !isSkillToolAvailable()) return false
    // 已经有写权限时不再提供「申请提权」，避免模型无意义地弹窗
    if (name === 'RequestWritePermission' && canWrite) return false
    return true
  })
  if (state.uiControl && isWindowsPlatform()) {
    const extra = uiToolDefs.filter(
      (t) => t.function.name !== 'UiScreenshot' || state.modalities.includes('image'),
    )
    defs.push(...extra)
  }
  const mcpDefs = await getMcpToolDefs()
  if (mcpDefs.length) defs.push(...mcpDefs)
  return defs
}

function streamCtx(tools: ToolDef[]): StreamTurnCtx {
  return {
    model: state.model,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    tools: tools,
    // 会话覆盖优先，其次全局默认；'off' 时 stream 层不会发送 reasoning_effort
    reasoningEffort: state.effortOverride ?? state.reasoningEffort,
    maxTokens: state.maxTokens,
  }
}

/** 会话内切换思考强度（只影响当前会话，不改全局设置）。 */
export function setSessionEffort(effort: ReasoningEffort | null) {
  state.effortOverride = effort
  emit()
}

/** 文件权限等级：只读 < 可写 < 完全访问。 */
function permissionRank(p: FilePermission): number {
  return p === 'readonly' ? 0 : p === 'write' ? 1 : 2
}

function effectivePermission(): FilePermission {
  return state.permissionOverride ?? state.filePermission
}

/**
 * UI 调用：用户点了「允许」或「保持只读」。
 * 允许时只提升当前会话：若全局已经是可写/完全访问，就清掉会话覆盖跟随全局；
 * 否则写入会话覆盖为 write。
 */
export function resolvePermissionRequest(allow: boolean): void {
  const resolve = permissionResolver
  if (!pendingPermission || !resolve) return
  permissionResolver = null
  if (permissionTimer) {
    clearTimeout(permissionTimer)
    permissionTimer = null
  }
  pendingPermission = null
  permissionTimedOut = false
  if (allow) {
    state.permissionOverride = permissionRank(state.filePermission) >= permissionRank('write') ? null : 'write'
    syncToolPermission()
  } else {
    lastPermissionDeniedAt = Date.now()
  }
  emit()
  resolve(allow)
}

/** 停止生成 / 新建对话 / 异常收尾时取消待确认请求（不计入「用户拒绝」冷却）。 */
function cancelPermissionRequest(): void {
  const resolve = permissionResolver
  if (!pendingPermission || !resolve) return
  permissionResolver = null
  if (permissionTimer) {
    clearTimeout(permissionTimer)
    permissionTimer = null
  }
  pendingPermission = null
  permissionTimedOut = false
  emit()
  resolve(false)
}

/**
 * 工具层调用：真正实现「弹窗 → 等用户确认」。
 * 超时 120 秒自动取消；同一时间只允许一个请求。
 */
async function requestWritePermission(reason: string): Promise<WritePermissionResult> {
  const cur = effectivePermission()
  if (permissionRank(cur) >= permissionRank('write')) {
    return { ok: true, permission: cur, already: true }
  }
  if (pendingPermission) {
    return { ok: false, permission: cur, error: '已有一个待确认的权限请求，请等待用户处理后再试。' }
  }
  if (Date.now() - lastPermissionDeniedAt < 15000) {
    return {
      ok: false,
      permission: cur,
      error: '用户刚刚拒绝了提权请求，不要立即重复申请。请先说明为什么必须写入，或改用只读方案。',
    }
  }

  const req: PermissionRequest = {
    id: ++permissionSeq,
    reason: (String(reason || '').replace(/\s+/g, ' ').trim() || '需要写入文件或执行命令').slice(0, 200),
    from: cur,
    to: 'write',
  }
  pendingPermission = req
  permissionTimedOut = false
  emit()

  const allowed = await new Promise<boolean>((resolve) => {
    permissionResolver = resolve
    permissionTimer = setTimeout(() => {
      if (permissionResolver !== resolve) return
      permissionResolver = null
      permissionTimer = null
      pendingPermission = null
      permissionTimedOut = true
      lastPermissionDeniedAt = Date.now()
      emit()
      resolve(false)
    }, PERMISSION_TIMEOUT_MS)
  })

  if (!allowed) {
    return {
      ok: false,
      permission: effectivePermission(),
      canceled: true,
      timedOut: permissionTimedOut,
      error: permissionTimedOut
        ? `用户未在 ${Math.round(PERMISSION_TIMEOUT_MS / 1000)} 秒内确认，已取消提权；当前仍为只读。`
        : '用户拒绝了提权，当前仍为只读。请改用只读方案，或询问用户是否需要切换权限。',
    }
  }
  return { ok: true, permission: effectivePermission() }
}

/** 会话内切换文件权限（只影响当前会话，不改全局设置）。 */
export function setSessionPermission(perm: FilePermission | null) {
  // 用户在确认窗还开着时手动改了下拉框：按新选择直接结束这次请求
  if (pendingPermission) {
    const next = perm ?? state.filePermission
    resolvePermissionRequest(permissionRank(next) >= permissionRank('write'))
  }
  state.permissionOverride = perm
  syncToolPermission()
  emit()
}

/** 把当前生效的权限同步给工具层（每次工具调用前也会再同步一次）。 */
function syncToolPermission() {
  setToolPermission(state.permissionOverride ?? state.filePermission)
  setUiControlEnabled(state.uiControl)
}

/**
 * 发送前轻量同步「全局默认」里会影响本次请求的字段。
 *
 * 聊天页 / 悬浮窗 / 设置页是彼此独立的 iframe，内存不互通：用户在设置页改了默认值，
 * 聊天页的 engine 实例并不知道。不同步就会出现「设置里明明开了启动器操作，聊天里
 * 却没有那几个工具」。这里只取能力类字段，不碰会话级覆盖。
 */
async function resyncGlobals(): Promise<void> {
  const api = getApi()
  if (!api || !api.call) return
  try {
    const s: any = (await api.call('getSettings')) || {}
    // 注册表可能在另一个 iframe（设置页）里被禁用/删除，发送前同步一次
    await reloadRegistryFromCache()
    state.uiControl = s.uiControl === true
    if (s.filePermission) state.filePermission = s.filePermission as FilePermission
    if (s.reasoningEffort) state.reasoningEffort = s.reasoningEffort as ReasoningEffort
    if (Array.isArray(s.modalities) && s.modalities.length) state.modalities = s.modalities as Modality[]
    if (typeof s.maxTokens === 'number' && s.maxTokens > 0) state.maxTokens = s.maxTokens
    if (typeof s.maxToolRounds === 'number' && s.maxToolRounds > 0) state.maxToolRounds = s.maxToolRounds
    if (s.showToolProcess !== undefined) state.showToolProcess = s.showToolProcess !== false
    state.skillsEnabled = s.skillsEnabled !== false
    state.skillsDir = typeof s.skillsDir === 'string' ? s.skillsDir : ''
    state.disabledSkills = Array.isArray(s.disabledSkills) ? s.disabledSkills.map(String) : []
    state.mcpEnabled = s.mcpEnabled === true
    state.mcpServers = Array.isArray(s.mcpServers) ? (s.mcpServers as McpServerConfig[]) : []
    configureSkills({ enabled: state.skillsEnabled, dir: state.skillsDir, disabled: state.disabledSkills })
    configureMcp({ enabled: state.mcpEnabled, servers: state.mcpServers })
    syncToolPermission()
    emit()
  } catch {
    // 读不到就沿用当前值，绝不因为一次读取失败阻断发送
  }
}

export async function sendMessage(text: string, parts?: MessagePart[]): Promise<void> {
  if (state.thinking) return
  state.thinking = true
  emit()

  // 三个界面内存不互通：发送前同步一次能力类全局设置（启动器操作开关、权限、模态…）
  await resyncGlobals()

  const hasParts = Array.isArray(parts) && parts.length > 0
  pushUi({ kind: 'user', content: text, attachments: hasParts ? parts.filter((p) => p.type !== 'text') : undefined })
  // 有附件时用 content parts（文本 + 图片/视频）；否则保持纯字符串，兼容性最好
  state.messages.push({ role: 'user', content: hasParts ? parts! : text })
  await compressContext(false, compressDeps)
  updateCtxDisplay()

  abortCtrl = new AbortController()
  const signal = abortCtrl.signal
  setToolAbortSignal(signal)
  stopRequested = false
  thinkingStart = Date.now()

  const thinkingId = pushUi({ kind: 'thinking', thinkingStart: Date.now() })
  let aiMsgId: number | null = null
  let fullContent = ''
  let lastRender = 0
  let lastEmit = 0
  let lastHtml = ''
  let renderSeq = 0
  let aiDivCreated = false

  function ensureAiDiv() {
    if (aiMsgId != null) return
    aiMsgId = nextId()
    ui = [...ui, { id: aiMsgId, kind: 'ai', content: '', html: '', streaming: true }]
    emit()
    aiDivCreated = true
  }

  /**
   * 生成过程中的节流落盘（每 2.5s 一次）：
   * 停止/出错/关闭窗口时可能不会走到收尾分支（例如 abort 会让 streamTurn 抛出），
   * 若只在收尾落盘，历史对话会整段丢失。此处在消息推进时定期持久化兜底。
   */
  let lastPersist = 0
  function persistThrottled() {
    const now = Date.now()
    if (now - lastPersist < 2500) return
    lastPersist = now
    void persistCurrent()
  }

  /**
   * 把「上一个 HTML」和「新 HTML」的差异包进渐入标签。
   *
   * 不能用长度前缀切分：重建的 HTML 在标签中间长度会变（`**b` → `<strong>b`），
   * 前缀切分会把 `<span>` 插进标签内部，产出非法 HTML（实测 `<td>` 被切断导致
   * 表格坍缩、代码块被破坏）。
   *
   * 这里只做**可证明安全**的注入：找到公共前缀后，仅当插入点位于文本内容中
   * （不在标签内部），且新增片段的开头是纯文本时，才把这段纯文本包进 `<span>`；
   * 其余情况（结构性变化、标签内部、片段以标签开头）一律整体替换，不做动画。
   */
  function markDelta(prev: string, next: string): string {
    if (!prev || prev === next) return next
    let p = 0
    const max = Math.min(prev.length, next.length)
    while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++
    if (p >= next.length) return next
    // p 落在标签内部（其前面最近的 '<' 尚未被 '>' 闭合）→ 注入会破坏标签
    if (next.lastIndexOf('<', p - 1) > next.lastIndexOf('>', p - 1)) return next
    const delta = next.slice(p)
    const lt = delta.search(/[<>]/)
    const text = lt < 0 ? delta : delta.slice(0, lt)
    if (!text) return next
    return next.slice(0, p) + '<span class="stream-fade">' + text + '</span>' + next.slice(p + text.length)
  }

  function onDelta(content: string) {
    fullContent = content
    ensureAiDiv()
    persistThrottled()
    const now = Date.now()
    if (now - lastRender < 70) {
      // 节流窗口内先给纯文本，保证首字立刻可见（不等 Markdown 重排）
      if (now - lastEmit > 90) {
        lastEmit = now
        updateAiPlain(aiMsgId!, content)
      }
      return
    }
    lastRender = now
    const seq = ++renderSeq
    const prev = lastHtml
    const html = renderMdSync(content)
    lastHtml = html
    if (seq !== renderSeq) return
    updateAiHtml(aiMsgId!, markDelta(prev, html) + CURSOR, true, content)
  }

  function finalizeContent() {
    renderSeq++
    return renderMd(fullContent || '').then((html) => {
      ensureAiDiv()
      updateAiHtml(aiMsgId!, html, false, fullContent || '')
    })
  }

  try {
    let msgs: ChatMessage[] = [{ role: 'system', content: await buildSystemPrompt() }, ...state.messages]
    let loops = state.maxToolRounds
    let t0 = Date.now()
    // 消息一入队就落盘一次：保证「有用户消息的会话」立刻出现在历史里
    await persistCurrent()
    let turn = await streamTurn(msgs, signal, onDelta, streamCtx(await getActiveToolDefs()), (r) => setThinkingDetail(thinkingId, r))
    finishThinking(thinkingId)
    if (stopRequested) {
      return
    }

    while (turn.finishReason === 'tool_calls' && loops > 0) {
      loops--
      if (aiDivCreated && aiMsgId != null) {
        const mid = aiMsgId
        renderMd(fullContent || '').then((html) => {
          updateAiHtml(mid, html, false, fullContent || '')
        })
        lastHtml = ''
        aiDivCreated = false
      }
      aiMsgId = null
      fullContent = ''
      lastRender = 0
      state.messages.push({ role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls })
      const elapsed = Date.now() - t0
      /** 本轮工具调用产出的界面截图（data URL），循环结束后作为带图消息发给模型 */
      const uiImages: string[] = []
      for (const tc of turn.toolCalls) {
        const args: ToolArgs = {}
        try {
          Object.assign(args, JSON.parse(tc.function.arguments))
        } catch (e) {}
        const detailId = addToolEntry(tc.function.name, JSON.stringify(args).slice(0, 80), elapsed)
        const handler = resolveHandler(tc.function.name)
        let result: unknown
        try {
          // 每次工具调用前同步权限（会话覆盖优先），确保门禁与下拉框一致
          syncToolPermission()
          result = handler ? await handler(args) : { error: 'unknown tool' }
        } catch (e: any) {
          result = { error: e.message || String(e) }
          // 工具抛异常时模型只看得到一行 error，落盘留原始栈便于复现
          pluginLog('warn', '工具调用异常', {
            tool: tc.function.name,
            args: JSON.stringify(args).slice(0, 500),
            error: e && e.message,
            stack: e && e.stack,
          })
        }
        const images = takeUiImages(result)
        uiImages.push(...images)
        addToolResult(detailId, toolSummary(result), images[0])
        state.messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultText(tc.function.name, result) })
      }
      if (uiImages.length) {
        state.messages.push({
          role: 'user',
          content: [
            { type: 'text', text: '（上面 UiScreenshot 抓到的启动器界面截图，供你核对界面状态）' },
            ...uiImages.map((url) => ({ type: 'image_url' as const, image_url: { url: url } })),
          ],
        })
      }
      updateCtxDisplay()
      t0 = Date.now()
      msgs = [{ role: 'system', content: await buildSystemPrompt() }, ...state.messages]
      const tId = pushUi({ kind: 'thinking', thinkingStart: Date.now() })
      turn = await streamTurn(msgs, signal, onDelta, streamCtx(await getActiveToolDefs()), (r) => setThinkingDetail(tId, r))
      finishThinking(tId)
      if (stopRequested) {
        return
      }
    }

    if (loops <= 0) {
      finishThinking(thinkingId)
      ensureAiDiv()
      // 说清是「轮数到顶」而不是被限流；并保留已经写出的正文，别让用户以为白跑
      const msg =
        (fullContent ? '\n\n---\n' : '') +
        '⚠️ 本次已连续执行 ' + state.maxToolRounds + ' 轮工具调用，达到单次提问的上限，先停在这里。\n\n' +
        '上面已经完成的步骤都保留在对话里，直接回复「继续」即可接着做；感到频繁中断可在设置里调大「工具调用轮数上限」。'
      fullContent = (fullContent || '') + msg
      updateAiHtml(aiMsgId!, renderMdSync(fullContent), false, fullContent)
      state.messages.push({ role: 'assistant', content: fullContent })
      updateCtxDisplay()
      addTotalTime(Date.now() - thinkingStart)
      return
    }

    /**
     * 输出被 max_tokens 截断时的明确提示。
     *
     * 思考与正文共享 max_tokens：若思考阶段就把预算用尽，会出现
     * finish_reason=length 且**正文为空**——用户只会看到一坨思考内容，
     * 误以为"回答跑进思考块了"。这里必须显式告知并提供可操作建议。
     */
    if (turn.finishReason === 'length') {
      const hadContent = !!fullContent.trim()
      const msg = hadContent
        ? '\n\n---\n⚠️ 输出达到上限被截断（finish_reason=length）。可在设置中调大「单次回复上限」，或让回答更简短。'
        : '⚠️ 本次没有生成正文：思考过程消耗完了输出上限（finish_reason=length），正文预算为 0。\n\n' +
          '建议：调小「思考强度」，或在设置中调大「单次回复上限」后重试。'
      fullContent = (fullContent || '') + msg
      ensureAiDiv()
      updateAiHtml(aiMsgId!, renderMdSync(fullContent), false, fullContent)
      finishThinking(thinkingId)
      state.messages.push({ role: 'assistant', content: fullContent })
      updateCtxDisplay()
      addTotalTime(Date.now() - thinkingStart)
      return
    }

    state.messages.push({ role: 'assistant', content: fullContent || '' })
    updateCtxDisplay()
    finalizeContent()
    finishThinking(thinkingId)
    addTotalTime(Date.now() - thinkingStart)
  } catch (e: any) {
    finishThinking(thinkingId)
    ensureAiDiv()
    if (e.name === 'AbortError') {
      updateAiHtml(aiMsgId!, fullContent + '（已停止）', false)
    } else {
      const text = (fullContent ? fullContent + '\n\n' : '') + '⚠️ ' + (e.message || String(e))
      // 纯文本渲染：错误信息里有响应片段，不走 Markdown/HTML，避免内容被吞或注入
      ui = ui.map((m) => (m.id === aiMsgId ? { ...m, html: '', content: text, streaming: false } : m))
      emit()
      // 气泡之外再留一份：落盘到启动器日志（plugin:log），事后可查
      pluginLog('error', '请求失败', {
        model: state.model,
        baseUrl: state.baseUrl,
        keySet: !!state.apiKey,
        message: e && e.message,
        stack: e && e.stack,
      })
    }
  } finally {
    // 无论正常结束、停止、还是出错，都保证当前会话落盘（历史不丢）
    setToolAbortSignal(undefined)
    cleanup()
    await persistCurrent()
  }
}

// ---------- 配置 ----------
export function showConfigView() {
  view = 'config'
  emit()
}

export function showChatView() {
  view = 'chat'
  emit()
}

export function fetchModels(key: string, baseUrl: string): Promise<{ models: { id: string }[]; error?: string }> {
  const api = getApi()
  if (!api || !api.call) return Promise.resolve({ models: [], error: 'API 桥接不可用' })
  return api
    .call('proxyFetch', {
      url: (baseUrl || 'https://api.deepseek.com/v1') + '/models',
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key },
      timeoutMs: 20000,
    })
    .then((r: any) => {
      if (!r || r.status !== 200) {
        throw new Error(describeHttpError(r, { baseUrl: baseUrl, apiKey: key, path: '/models' }))
      }
      const data = JSON.parse(r.body)
      const models = data.data || []
      return { models: models }
    })
    .catch((e) => {
      return { models: [], error: '获取失败，可手动输入模型名' + (e.message ? ': ' + e.message : '') }
    })
}

export function testConnection(key: string, baseUrl: string, model: string): Promise<{ ok: boolean; error?: string }> {
  const api = getApi()
  if (!api || !api.call) return Promise.resolve({ ok: false, error: 'API 桥接不可用' })
  return api
    .call('proxyFetch', {
      url: (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: model || 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      timeoutMs: 30000,
    })
    .then((r: any) => {
      if (r && r.status === 200) return { ok: true }
      throw new Error(describeHttpError(r, { baseUrl: baseUrl, model: model || 'deepseek-chat', apiKey: key }))
    })
    .catch((e) => ({ ok: false, error: e.message }))
}

export function testModel(key: string, baseUrl: string, model: string): Promise<{ ok: boolean; error?: string }> {
  const api = getApi()
  if (!api || !api.call) return Promise.resolve({ ok: false, error: 'API 桥接不可用' })
  return api
    .call('proxyFetch', {
      url: (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: model, messages: [{ role: 'user', content: '返回ok' }], max_tokens: 10 }),
      timeoutMs: 30000,
    })
    .then((r: any) => {
      if (r && r.status === 200) return { ok: true }
      throw new Error(describeHttpError(r, { baseUrl: baseUrl, model: model, apiKey: key }))
    })
    .catch((e) => ({ ok: false, error: e.message }))
}

export function saveConfig(
  cfg: {
    apiKey: string
    baseUrl: string
    model: string
    maxCtx: number
    showToolProcess: boolean
    reasoningEffort?: ReasoningEffort
    modalities?: Modality[]
    filePermission?: FilePermission
    maxTokens?: number
    maxToolRounds?: number
    uiControl?: boolean
    skillsEnabled?: boolean
    skillsDir?: string
    disabledSkills?: string[]
    mcpEnabled?: boolean
    mcpServers?: McpServerConfig[]
  },
  opts: {
    /**
     * settingsMode：由「设置 → 插件 → 插件设置」调用。设置页是独立 iframe，
     * 不该影响聊天运行时（重置会话/切换视图），只负责把配置写盘。
     */
    settingsMode?: boolean
  } = {}
): Promise<{ ok: boolean; error?: string }> {
  state.apiKey = cfg.apiKey
  state.baseUrl = (cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  state.model = cfg.model
  state.maxCtx = cfg.maxCtx || 200
  state.showToolProcess = cfg.showToolProcess !== false
  if (cfg.reasoningEffort !== undefined) state.reasoningEffort = cfg.reasoningEffort
  if (cfg.modalities) state.modalities = cfg.modalities.length ? cfg.modalities : ['text']
  if (cfg.filePermission) state.filePermission = cfg.filePermission
  if (cfg.maxTokens) state.maxTokens = cfg.maxTokens
  if (cfg.maxToolRounds) state.maxToolRounds = cfg.maxToolRounds
  if (cfg.uiControl !== undefined) state.uiControl = cfg.uiControl === true
  if (cfg.skillsEnabled !== undefined) state.skillsEnabled = cfg.skillsEnabled === true
  if (cfg.skillsDir !== undefined) state.skillsDir = String(cfg.skillsDir || '').trim()
  if (cfg.disabledSkills !== undefined) state.disabledSkills = Array.isArray(cfg.disabledSkills) ? cfg.disabledSkills.map(String) : []
  if (cfg.mcpEnabled !== undefined) state.mcpEnabled = cfg.mcpEnabled === true
  if (cfg.mcpServers !== undefined) state.mcpServers = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []
  configureSkills({ enabled: state.skillsEnabled, dir: state.skillsDir, disabled: state.disabledSkills })
  configureMcp({ enabled: state.mcpEnabled, servers: state.mcpServers })
  // 全局默认变化后，会话级覆盖失效
  state.effortOverride = null
  state.permissionOverride = null
  syncToolPermission()
  if (!opts.settingsMode) newChat()
  const api = getApi()
  if (!api || !api.call) return Promise.resolve({ ok: false, error: 'API 桥接不可用' })
  return api
    .call('setSettings', 'deepseekApiKey', cfg.apiKey)
    .then(() => api.call('setSettings', 'deepseekModel', cfg.model))
    .then(() => api.call('setSettings', 'baseUrl', state.baseUrl))
    .then(() => api.call('setSettings', 'maxCtx', state.maxCtx))
    .then(() => api.call('setSettings', 'showToolProcess', state.showToolProcess))
    .then(() => api.call('setSettings', 'reasoningEffort', state.reasoningEffort))
    .then(() => api.call('setSettings', 'filePermission', state.filePermission))
    .then(() => api.call('setSettings', 'uiControl', state.uiControl))
    .then(() => api.call('setSettings', 'maxTokens', state.maxTokens))
    .then(() => api.call('setSettings', 'maxToolRounds', state.maxToolRounds))
    .then(() => api.call('setSettings', 'modalities', state.modalities))
    .then(() => api.call('setSettings', 'skillsEnabled', state.skillsEnabled))
    .then(() => api.call('setSettings', 'skillsDir', state.skillsDir))
    .then(() => api.call('setSettings', 'disabledSkills', state.disabledSkills))
    .then(() => api.call('setSettings', 'mcpEnabled', state.mcpEnabled))
    .then(() => api.call('setSettings', 'mcpServers', state.mcpServers))
    .then(() => {
      if (!opts.settingsMode) showChatView()
      return { ok: true }
    })
    .catch((e) => ({ ok: false, error: e.message || String(e) }))
}

export function manualCompressCtx() {
  manualCompress(compressDeps)
}

// ---------- 初始化 ----------
let initialized = false

export function init(): void {
  if (initialized) return
  initialized = true
  const api = getApi()
  setApiRef(api)
  // 工具层 → engine 的权限请求入口（弹窗逻辑在 engine 里）
  setPermissionRequester(requestWritePermission)
  // 跨插件注册接口：即使还没配置 API Key 也要先挂上（别的插件可能随时来注册）
  initRegistry()
  setMcpNotifier((msg) => {
    if (state.thinking) addProgress(msg, 'error')
  })
  loadDsTokenizer().then(() => updateCtxDisplay())
  if (!api || !api.call) {
    view = 'config'
    emit()
    return
  }
  void ensureRegistryLoaded()
  api
    .call('getSettings')
    .then((s: any) => {
      const settings = s || {}
      // 能力类配置与 API Key 无关：即使还没配置模型，也要让注册表/技能/MCP 状态正确
      state.skillsEnabled = settings.skillsEnabled !== false
      state.skillsDir = typeof settings.skillsDir === 'string' ? settings.skillsDir : ''
      state.disabledSkills = Array.isArray(settings.disabledSkills) ? settings.disabledSkills.map(String) : []
      state.mcpEnabled = settings.mcpEnabled === true
      state.mcpServers = Array.isArray(settings.mcpServers) ? (settings.mcpServers as McpServerConfig[]) : []
      configureSkills({ enabled: state.skillsEnabled, dir: state.skillsDir, disabled: state.disabledSkills })
      configureMcp({ enabled: state.mcpEnabled, servers: state.mcpServers })
      if (settings.deepseekApiKey) {
        state.apiKey = settings.deepseekApiKey
        state.baseUrl = (settings.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
        state.model = settings.deepseekModel || 'deepseek-chat'
        state.maxCtx = settings.maxCtx || 200
        state.showToolProcess = settings.showToolProcess !== false
        state.reasoningEffort = (settings.reasoningEffort as ReasoningEffort) || 'off'
        state.modalities = Array.isArray(settings.modalities) && settings.modalities.length
          ? (settings.modalities as Modality[])
          : ['text']
        state.filePermission = (settings.filePermission as FilePermission) || 'readonly'
        state.uiControl = settings.uiControl === true
        state.maxTokens = typeof settings.maxTokens === 'number' && settings.maxTokens > 0 ? settings.maxTokens : 8192
        state.maxToolRounds =
          typeof settings.maxToolRounds === 'number' && settings.maxToolRounds > 0
            ? settings.maxToolRounds
            : DEFAULT_TOOL_ROUNDS
        syncToolPermission()
        view = 'chat'
        // 注意：这里**不能**调用 newChat()——newChat 会生成新会话 id 并写回 cache，
        // 把胶囊/其他界面正在使用的「当前会话」覆盖掉，「继续当前会话」就失效了。
        // 会话的续接统一由各界面 bootstrap 调 ensureCurrentConversationId + openConversation 完成。
        ui = [welcomeUi()]
      } else {
        view = 'config'
        ui = []
      }
      emit()
    })
    .catch(() => {
      view = 'config'
      emit()
    })
}

export function registerFileDropHandler(): void {
  const api = getApi()
  if (api && api.registerMethod) {
    api.registerMethod('handleFileDrop', (paths: unknown) => {
      if (!Array.isArray(paths) || !paths.length) return { ok: false }
      const text = paths.map((p) => '"' + p + '"').join(' ')
      appendInput(text)
      return { ok: true, count: paths.length }
    })
  }
}

let inputRef: { value: string; set: (v: string) => void; focus: () => void } | null = null

export function bindInput(api: { value: string; set: (v: string) => void; focus: () => void }) {
  inputRef = api
}

function appendInput(text: string) {
  if (inputRef) {
    inputRef.set(inputRef.value ? inputRef.value + ' ' + text : text)
    inputRef.focus()
  }
}

export function insertDroppedFiles(filePaths: string[]) {
  const paths = filePaths.map((p) => '"' + p + '"')
  appendInput(paths.join(' '))
}

export { getSnapshot, subscribe, state }