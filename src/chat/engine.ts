import type { ChatMessage, UiMessage, ToolEntryLine, ReasoningEffort, Modality, MessagePart, FilePermission } from './types.ts'
import { getApi } from '../api.ts'
import { SYSTEM_PROMPT, UI_CONTROL_PROMPT } from './systemPrompt.ts'
import { toolDefs } from './toolDefs.ts'
import { uiToolDefs } from './uiTools.ts'
import { handlers, setApiRef, toolNamesCN, type ToolArgs } from './handlers.ts'
import { setToolPermission } from './fileTools.ts'
import { setUiControlEnabled } from './uiControl.ts'
import { workspacePromptSection, isWindowsPlatform } from './permissions.ts'
import { streamTurn, type StreamTurnCtx } from './stream.ts'
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

const CURSOR = '<span class="stream-cursor">&#9621;</span>'

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
    /** 「启动器操作」（UI 自动化）总开关 */
    uiControl: boolean
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
  /** 单次回复输出上限（思考与正文共享） */
  maxTokens: 8192,
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
      uiControl: state.uiControl,
      configured: !!state.apiKey,
      thinking: state.thinking,
    },
    view: view,
    ui: ui,
    ctxUsage: ctxUsage,
    conversationId: conversationId,
    conversationTitle: conversationTitle,
    conversations: conversations,
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
  const cn = toolNamesCN[toolName] || toolName
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
  state.thinking = false
  abortCtrl = null
  stopRequested = false
  emit()
}

export function stopGeneration() {  stopRequested = true
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
      ? '只读：只能用 Read / Grep，禁止 Write / Edit / Bash / Compress / Decompress。'
      : perm === 'write'
        ? '可写：Read / Write / Edit / Grep / Bash / Compress / Decompress 均可用；首次访问未授权目录时启动器会弹窗要用户授权。'
        : '完全访问：所有文件与命令工具均可用，不再逐一确认。仍应避免破坏性操作。'
  // 界面操作章节只在开关打开时给：没开就不提，模型才不会以为自己能点界面
  const uiText = state.uiControl && isWindowsPlatform() ? `\n${UI_CONTROL_PROMPT}` : ''
  return `${SYSTEM_PROMPT}\n${cachedWorkspaceSection}\n\n## 当前文件权限\n${permText}${uiText}`
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
 */
function getActiveToolDefs(): typeof toolDefs {
  if (!state.uiControl || !isWindowsPlatform()) return toolDefs
  const extra = uiToolDefs.filter(
    (t) => t.function.name !== 'UiScreenshot' || state.modalities.includes('image'),
  )
  return [...toolDefs, ...extra]
}

function streamCtx(): StreamTurnCtx {
  return {
    model: state.model,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    tools: getActiveToolDefs(),
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

/** 会话内切换文件权限（只影响当前会话，不改全局设置）。 */
export function setSessionPermission(perm: FilePermission | null) {
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
    state.uiControl = s.uiControl === true
    if (s.filePermission) state.filePermission = s.filePermission as FilePermission
    if (s.reasoningEffort) state.reasoningEffort = s.reasoningEffort as ReasoningEffort
    if (Array.isArray(s.modalities) && s.modalities.length) state.modalities = s.modalities as Modality[]
    if (typeof s.maxTokens === 'number' && s.maxTokens > 0) state.maxTokens = s.maxTokens
    if (s.showToolProcess !== undefined) state.showToolProcess = s.showToolProcess !== false
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
    let loops = 10
    let t0 = Date.now()
    // 消息一入队就落盘一次：保证「有用户消息的会话」立刻出现在历史里
    await persistCurrent()
    let turn = await streamTurn(msgs, signal, onDelta, streamCtx(), (r) => setThinkingDetail(thinkingId, r))
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
        const handler = handlers[tc.function.name]
        let result: unknown
        try {
          // 每次工具调用前同步权限（会话覆盖优先），确保门禁与下拉框一致
          syncToolPermission()
          result = handler ? await handler(args) : { error: 'unknown tool' }
        } catch (e: any) {
          result = { error: e.message || String(e) }
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
      turn = await streamTurn(msgs, signal, onDelta, streamCtx(), (r) => setThinkingDetail(tId, r))
      finishThinking(tId)
      if (stopRequested) {
        return
      }
    }

    if (loops <= 0) {
      finishThinking(thinkingId)
      ensureAiDiv()
      updateAiHtml(aiMsgId!, '抱歉，工具调用次数过多，请重试。', false)
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
      updateAiHtml(aiMsgId!, '出错了: ' + e.message, false)
    }
  } finally {
    // 无论正常结束、停止、还是出错，都保证当前会话落盘（历史不丢）
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
        const d = JSON.parse(r.body || '{}')
        throw new Error(d.error?.message || 'HTTP ' + (r && r.status))
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
      const d = JSON.parse((r && r.body) || '{}')
      throw new Error(d.error?.message || 'HTTP ' + (r && r.status))
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
      const d = JSON.parse((r && r.body) || '{}')
      throw new Error(d.error?.message || 'HTTP ' + (r && r.status))
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
    uiControl?: boolean
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
  if (cfg.uiControl !== undefined) state.uiControl = cfg.uiControl === true
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
    .then(() => api.call('setSettings', 'modalities', state.modalities))
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
  loadDsTokenizer().then(() => updateCtxDisplay())
  if (!api || !api.call) {
    view = 'config'
    emit()
    return
  }
  api
    .call('getSettings')
    .then((s: any) => {
      const settings = s || {}
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