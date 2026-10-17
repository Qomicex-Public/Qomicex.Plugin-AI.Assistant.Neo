import type { ChatMessage, UiMessage, ToolEntryLine, ReasoningEffort, Modality, MessagePart } from './types.ts'
import { getApi } from '../api.ts'
import { SYSTEM_PROMPT } from './systemPrompt.ts'
import { toolDefs } from './toolDefs.ts'
import { handlers, setApiRef, toolNamesCN, type ToolArgs } from './handlers.ts'
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

function addToolResult(detailId: number, resultText: string) {
  if (detailId < 0) return
  const line: ToolEntryLine = { result: resultText }
  ui = ui.map((m) => (m.id === detailId ? { ...m, toolLines: [...(m.toolLines || []), line] } : m))
  emit()
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
      out.push({ id: nextId(), kind: 'user', content: String(m.content || '') })
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

function streamCtx(): StreamTurnCtx {
  return {
    model: state.model,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    tools: toolDefs,
    // 会话覆盖优先，其次全局默认；'off' 时 stream 层不会发送 reasoning_effort
    reasoningEffort: state.effortOverride ?? state.reasoningEffort,
  }
}

/** 会话内切换思考强度（只影响当前会话，不改全局设置）。 */
export function setSessionEffort(effort: ReasoningEffort | null) {
  state.effortOverride = effort
  emit()
}

export async function sendMessage(text: string, parts?: MessagePart[]): Promise<void> {
  if (state.thinking) return
  state.thinking = true
  emit()

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
    let msgs: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...state.messages]
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
      for (const tc of turn.toolCalls) {
        const args: ToolArgs = {}
        try {
          Object.assign(args, JSON.parse(tc.function.arguments))
        } catch (e) {}
        const detailId = addToolEntry(tc.function.name, JSON.stringify(args).slice(0, 80), elapsed)
        const handler = handlers[tc.function.name]
        let result: unknown
        try {
          result = handler ? await handler(args) : { error: 'unknown tool' }
        } catch (e: any) {
          result = { error: e.message || String(e) }
        }
        const summary =
          typeof result === 'object' && result !== null
            ? Array.isArray(result)
              ? '返回 ' + result.length + ' 项'
              : (result as any).error
                ? '错误: ' + (result as any).error
                : '完成'
            : String(result).slice(0, 50)
        addToolResult(detailId, summary)
        state.messages.push({ role: 'tool', tool_call_id: tc.id, content: summarizeToolResult(tc.function.name, result) })
      }
      updateCtxDisplay()
      t0 = Date.now()
      msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...state.messages]
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
  // 全局默认变化后，会话级覆盖失效
  state.effortOverride = null
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