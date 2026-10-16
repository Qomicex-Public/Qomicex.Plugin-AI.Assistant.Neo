import type { ChatMessage, UiMessage, ToolEntryLine } from './types.ts'
import { getApi } from '../api.ts'
import { SYSTEM_PROMPT } from './systemPrompt.ts'
import { toolDefs } from './toolDefs.ts'
import { handlers, setApiRef, toolNamesCN, type ToolArgs } from './handlers.ts'
import { streamTurn, type StreamTurnCtx } from './stream.ts'
import { compressContext, manualCompress, summarizeToolResult, estimateTokens, loadDsTokenizer, type CompressDeps } from './compress.ts'
import { renderMd, renderMdSync } from './markdown.ts'

const CURSOR = '<span class="stream-cursor">&#9621;</span>'

export interface EngineSnapshot {
  cfg: {
    apiKey: string
    baseUrl: string
    model: string
    maxCtx: number
    showToolProcess: boolean
    configured: boolean
    thinking: boolean
  }
  view: 'chat' | 'config'
  ui: UiMessage[]
  ctxUsage: { text: string; warn: boolean }
}

// ---------- 内部状态 ----------
const state = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  maxCtx: 200,
  showToolProcess: true,
  thinking: false,
  messages: [] as ChatMessage[],
}
let view: 'chat' | 'config' = 'chat'
let ui: UiMessage[] = []
let ctxUsage = { text: '', warn: false }
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
      configured: !!state.apiKey,
      thinking: state.thinking,
    },
    view: view,
    ui: ui,
    ctxUsage: ctxUsage,
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

function toggleToolEntry(id: number) {
  ui = ui.map((m) => (m.id === id ? { ...m, collapsed: !m.collapsed } : m))
  emit()
}

function finishThinking(id: number, doneText?: string) {
  ui = ui.map((m) => {
    if (m.id !== id || m.kind !== 'thinking' || m.done) return m
    const start = m.thinkingStart || Date.now()
    const text = doneText || '已思考 ' + formatDuration(Date.now() - start)
    return { ...m, done: true, content: text }
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
export function newChat() {
  state.messages = []
  if (abortCtrl) {
    abortCtrl.abort()
    abortCtrl = null
  }
  state.thinking = false
  ui = [
    {
      id: nextId(),
      kind: 'ai',
      content: '你好！我是 AI 助手。有什么需要帮忙的？',
      streaming: false,
    },
  ]
  updateCtxDisplay()
}

function cleanup() {
  state.thinking = false
  abortCtrl = null
  stopRequested = false
  emit()
}

export function stopGeneration() {
  stopRequested = true
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
  }
}

export async function sendMessage(text: string): Promise<void> {
  if (state.thinking) return
  state.thinking = true
  emit()

  pushUi({ kind: 'user', content: text })
  state.messages.push({ role: 'user', content: text })
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
    let turn = await streamTurn(msgs, signal, onDelta, streamCtx())
    finishThinking(thinkingId)
    if (stopRequested) {
      cleanup()
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
      turn = await streamTurn(msgs, signal, onDelta, streamCtx())
      finishThinking(tId)
      if (stopRequested) {
        cleanup()
        return
      }
    }

    if (loops <= 0) {
      finishThinking(thinkingId)
      ensureAiDiv()
      updateAiHtml(aiMsgId!, '抱歉，工具调用次数过多，请重试。', false)
      cleanup()
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
  }
  cleanup()
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

export function saveConfig(cfg: { apiKey: string; baseUrl: string; model: string; maxCtx: number; showToolProcess: boolean }): Promise<{ ok: boolean; error?: string }> {
  state.apiKey = cfg.apiKey
  state.baseUrl = (cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  state.model = cfg.model
  state.maxCtx = cfg.maxCtx || 200
  state.showToolProcess = cfg.showToolProcess !== false
  newChat()
  const api = getApi()
  if (!api || !api.call) return Promise.resolve({ ok: false, error: 'API 桥接不可用' })
  return api
    .call('setSettings', 'deepseekApiKey', cfg.apiKey)
    .then(() => api.call('setSettings', 'deepseekModel', cfg.model))
    .then(() => api.call('setSettings', 'baseUrl', state.baseUrl))
    .then(() => api.call('setSettings', 'maxCtx', state.maxCtx))
    .then(() => api.call('setSettings', 'showToolProcess', state.showToolProcess))
    .then(() => {
      showChatView()
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
        view = 'chat'
        newChat()
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

export { getSnapshot, subscribe, toggleToolEntry, state }