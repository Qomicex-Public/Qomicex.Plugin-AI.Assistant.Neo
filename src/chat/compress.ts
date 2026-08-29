import type { ChatMessage } from './types.ts'
import { getApi, getPluginId } from '../api.ts'
import { SYSTEM_PROMPT } from './systemPrompt.ts'
import { toolDefs } from './toolDefs.ts'

// ---------- token 估算（无 tokenizer 时兜底） ----------
export function estimateTokenCount(str: string): number {
  const s = String(str || '')
  const cjk = (s.match(/[\u2e80-\u2eff\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length
  const ascii = s.length - cjk
  return Math.ceil(cjk + ascii / 4)
}

export const TOOL_RESULT_MAX = 4000
export const TOOL_RESULT_TRIM_ITEMS = 8
export const TOOL_RESULT_PRIO_KEYS = [
  'name', 'title', 'id', 'projectId', 'versionId', 'fileName', 'filename', 'version', 'loader', 'gameVersion', 'url', 'type', 'source', 'status', 'stage', 'message', 'path', 'error',
]

export function truncateStr(s: unknown, max: number): string {
  const str = String(s == null ? '' : s)
  return str.length <= max ? str : str.slice(0, max) + '…（已截断）'
}

function compactItem(item: any): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const keys = TOOL_RESULT_PRIO_KEYS.concat(Object.keys(item))
    const picked: string[] = []
    const used: Record<string, boolean> = {}
    for (let i = 0; i < keys.length && picked.length < 4; i++) {
      const k = keys[i]
      const v = item[k]
      if (used[k] || v == null || v === '') continue
      used[k] = true
      let val = v
      if (val && typeof val === 'object') val = JSON.stringify(val)
      picked.push(k + '=' + truncateStr(val, 80))
    }
    return picked.join('|')
  }
  return truncateStr(item, 120)
}

export function summarizeToolResult(_name: string, result: any): string {
  if (Array.isArray(result)) {
    const parts = result.slice(0, TOOL_RESULT_TRIM_ITEMS).map(compactItem)
    if (result.length > TOOL_RESULT_TRIM_ITEMS) parts.push('…共 ' + result.length + ' 项，已截断')
    return truncateStr(parts.join('\n'), TOOL_RESULT_MAX)
  }
  return truncateStr(compactItem(result), TOOL_RESULT_MAX)
}

// ---------- tokenizer（DeepSeek BPE） ----------
const dsTok: { loaded: boolean; vocab: Record<string, number> | null; mergeMap: Map<string, number> | null; byteEncoder: Record<string, string> | null; loading: Promise<boolean> | null } = {
  loaded: false,
  vocab: null,
  mergeMap: null,
  byteEncoder: null,
  loading: null,
}

function bytesToUnicode(): Record<string, string> {
  const map: Record<string, string> = {}
  let n = 0
  for (let b = 0; b < 256; b++) {
    const keep = b === 9 || b === 10 || b === 13 || (32 <= b && b <= 126)
    map[String.fromCharCode(b)] = keep ? String.fromCharCode(b) : String.fromCharCode(256 + n++)
  }
  return map
}

export function loadDsTokenizer(): Promise<boolean> {
  if (dsTok.loaded) return Promise.resolve(true)
  if (dsTok.loading) return dsTok.loading
  dsTok.loading = new Promise<boolean>((resolve) => {
    const api = getApi()
    if (!api || !api.call) {
      resolve(false)
      return
    }
    const id = getPluginId()
    api
      .call('callBackend', '/plugins/' + id + '/files/dist/tokenizer.json')
      .then((data: any) => {
        if (data && data.vocab && data.merges) {
          dsTok.vocab = data.vocab
          dsTok.mergeMap = new Map((data.merges as string[]).map((m, i) => [m, i]))
          dsTok.byteEncoder = bytesToUnicode()
          dsTok.loaded = true
          resolve(true)
        } else {
          resolve(false)
        }
      })
      .catch(() => resolve(false))
  })
  return dsTok.loading
}

function dsTokenize(text: string): string[] | null {
  const { vocab, mergeMap, byteEncoder } = dsTok
  if (!dsTok.loaded || !vocab || !mergeMap || !byteEncoder) return null
  const pattern = /[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu
  const tokens: string[] = []
  const matches = String(text).match(pattern) || []
  const enc = new TextEncoder()
  for (const m of matches) {
    const arr = enc.encode(m)
    let b = ''
    for (const byte of arr) b += byteEncoder[String.fromCharCode(byte)]
    const pieces = bpeMerge(b)
    for (const p of pieces) {
      if (Object.prototype.hasOwnProperty.call(vocab, p)) tokens.push(p)
    }
  }
  return tokens
}

function bpeMerge(token: string): string[] {
  const { vocab, mergeMap } = dsTok
  if (!vocab || !mergeMap) return [token]
  if (Object.prototype.hasOwnProperty.call(vocab, token)) return [token]
  let word = token.split('')
  while (word.length > 1) {
    let bestPair: string | null = null
    let bestIdx = Infinity
    for (let i = 0; i < word.length - 1; i++) {
      const pair = word[i] + word[i + 1]
      const rank = mergeMap.get(pair)
      if (rank !== undefined && (bestPair === null || rank < bestIdx)) {
        bestPair = pair
        bestIdx = rank
      }
    }
    if (bestPair === null) break
    const newWord: string[] = []
    for (let i = 0; i < word.length; i++) {
      if (i < word.length - 1 && word[i] + word[i + 1] === bestPair) {
        newWord.push(bestPair)
        i++
      } else newWord.push(word[i])
    }
    word = newWord
  }
  return word
}

// ---------- 估算 ----------
export function estimateTokens(msgs: ChatMessage[]): number {
  let full = ''
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.content) full += m.content + ' '
    if (m.tool_calls) full += JSON.stringify(m.tool_calls) + ' '
  }
  if (dsTok.loaded) {
    const toks = dsTokenize(full)
    if (toks) return toks.length
  }
  return estimateTokenCount(full)
}

let OVERHEAD_EST: number | null = null

function estimateFixedOverhead(): number {
  if (OVERHEAD_EST == null) {
    OVERHEAD_EST = estimateTokenCount(SYSTEM_PROMPT + '\n' + JSON.stringify(toolDefs)) + 512
  }
  return OVERHEAD_EST
}

// ---------- 上下文压缩 ----------
export interface CompressDeps {
  getState: () => { apiKey: string; baseUrl: string; model: string; maxCtx: number; thinking: boolean; messages: ChatMessage[] }
  setMessages: (m: ChatMessage[]) => void
  addProgress: (msg: string, type: string) => void
  updateCtxDisplay: () => void
}

const SUMMARY_MAX_MSGS = 40

export async function compressContext(force: boolean, deps: CompressDeps): Promise<void> {
  const st = deps.getState()
  const limit = (st.maxCtx || 200) * 1000
  const threshold = Math.ceil(limit * 0.7)
  const dropTarget = Math.ceil(limit * 0.5)
  const cur = estimateTokens(st.messages) + estimateFixedOverhead()
  if (!force && cur <= threshold) return
  if (st.messages.length <= 2) return

  const keepCount = Math.max(Math.ceil(st.messages.length * 0.5), 10)
  const oldMsgs = st.messages.slice(0, -keepCount)

  if (force && oldMsgs.length >= 3) {
    deps.addProgress('正在压缩上下文...', 'thought')
    const ok = await tryAiSummary(oldMsgs, deps)
    if (ok) {
      deps.updateCtxDisplay()
      return
    }
    deps.addProgress('AI 压缩失败，改用裁剪', 'error')
  }

  let r = 0
  while (deps.getState().messages.length > 4 && estimateTokens(deps.getState().messages) + estimateFixedOverhead() > dropTarget) {
    deps.setMessages(deps.getState().messages.slice(1))
    r++
  }
  if (r > 0) deps.addProgress('已裁剪 ' + r + ' 条旧消息以控制 token 消耗', 'thought')
  deps.updateCtxDisplay()
}

async function tryAiSummary(oldMsgs: ChatMessage[], deps: CompressDeps): Promise<boolean> {
  const summaryMsgs: ChatMessage[] = []
  const sliceStart = Math.max(0, oldMsgs.length - SUMMARY_MAX_MSGS)
  for (let i = sliceStart; i < oldMsgs.length; i++) {
    const m = oldMsgs[i]
    if (m.role === 'system' || m.role === 'tool') continue
    let c = m.content
    if (!c && m.tool_calls) c = '(调用了 ' + m.tool_calls.map((t) => t.function.name).join(', ') + ')'
    summaryMsgs.push({ role: m.role, content: truncateStr(c || '', 2000) })
  }
  const st = deps.getState()
  const api = getApi()
  if (!summaryMsgs.length || !api || !api.call) return false
  const promptMsgs: ChatMessage[] = [{ role: 'user', content: '请用一段话概括以上对话的核心要点，以便后续继续对话时不丢失上下文。只返回概括内容，不要任何前缀。' }, ...summaryMsgs]
  const res = (await api.call('proxyFetch', {
    url: (st.baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st.apiKey },
    body: JSON.stringify({
      model: st.model,
      messages: promptMsgs,
      max_tokens: 512,
    }),
    timeoutMs: 60000,
  })) as any
  if (!res || res.status !== 200) {
    const errData = JSON.parse((res && res.body) || '{}')
    throw new Error(errData.error?.message || 'HTTP ' + (res && res.status))
  }
  const data = JSON.parse(res.body)
  const summary = data.choices[0].message.content
  const cur = deps.getState().messages
  const merged: ChatMessage[] = [{ role: 'system', content: '【历史摘要】' + summary }, ...cur.slice(-Math.max(Math.ceil(cur.length * 0.5), 10))]
  deps.setMessages(merged)
  deps.addProgress('上下文已压缩，保留摘要', 'result')
  return true
}

export function manualCompress(deps: CompressDeps): void {
  const st = deps.getState()
  if (st.thinking) {
    deps.addProgress('AI 回复中，请稍后再压缩', 'error')
    return
  }
  if (st.messages.length <= 2) {
    deps.addProgress('暂无内容可压缩', 'error')
    return
  }
  deps.addProgress('手动压缩中...', 'thought')
  compressContext(true, deps)
}