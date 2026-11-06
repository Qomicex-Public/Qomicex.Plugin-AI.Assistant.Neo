import type { ChatMessage, ToolCall, ToolDef, ReasoningEffort } from './types.ts'
import { getApi } from '../api.ts'

export interface StreamTurnCtx {
  model: string
  baseUrl: string
  apiKey: string
  tools: ToolDef[]
  /** 'off'（或未设置）时不发送 reasoning_effort 字段 */
  reasoningEffort?: ReasoningEffort
  /**
   * 单次回复的输出上限。注意：思考（reasoning）与正文共享这一预算，
   * 开启高思考强度时若上限过小，模型可能把预算全用在思考上，
   * 导致 finish_reason=length 且正文为空。
   */
  maxTokens?: number
}

export interface StreamResult {
  finishReason: string | null
  content: string
  toolCalls: ToolCall[]
  /** 模型思考过程（reasoner / reasoning 类模型返回；普通模型为空串） */
  reasoning: string
}

/**
 * 从响应对象里取思考片段。
 *
 * 只认「思考」字段本身，**绝不回退到 content**——部分服务端会在同一帧同时下发
 * `content` 与 `reasoning_content`（实测 step-3.7-flash 即如此），若做字段回退
 * 会把正文误判成思考过程。
 *
 * 字段名兼容：reasoning_content / reasoning / thinking / thinking_content。
 */
function pickReasoning(obj: any): string {
  if (!obj || typeof obj !== 'object') return ''
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'thinking_content']) {
    const v = (obj as any)[key]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

/** 在 delta / message / 顶层中寻找思考片段（仍只认思考字段）。 */
function pickReasoningDeep(node: any): string {
  if (!node || typeof node !== 'object') return ''
  return (
    pickReasoning(node.delta) ||
    pickReasoning(node.message) ||
    pickReasoning(node) ||
    (Array.isArray(node.choices) && node.choices[0]
      ? pickReasoning(node.choices[0].delta) || pickReasoning(node.choices[0].message) || pickReasoning(node.choices[0])
      : '')
  )
}

/**
 * 组装请求体：思考强度仅在非 off 时下发。
 * 注意 reasoning_effort 是 OpenAI 风格字段；部分提供商可能不识别，
 * 那种情况由服务端返回错误，用户可在设置里关掉。
 */
export function buildPayload(model: string, messages: ChatMessage[], effort?: ReasoningEffort, maxTokens = 8192): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
  }
  if (effort && effort !== 'off') payload.reasoning_effort = effort
  return payload
}

/** 常见 HTTP 状态的可操作提示：401 只说「API error」等于没说。 */
const STATUS_HINT: Record<number, string> = {
  400: '请求被拒：常见于模型名不被该端点接受，或参数（如 reasoning_effort）不受支持。',
  401: 'API Key 无效或已过期：核对 Key 是否属于当前 baseUrl 的账号，是否带了空格/换行。',
  402: '余额不足：到服务商控制台充值或更换 Key。',
  403: 'Key 无权限、被风控或地区限制：确认账号状态与该模型是否已开通。',
  404: '端点或模型不存在：baseUrl 应形如 https://api.deepseek.com/v1（不要带 /chat/completions）。',
  422: '参数校验失败：检查模型名与请求字段。',
  429: '触发限流或配额用尽：稍后重试，或换模型/降低并发。',
}

export interface ApiErrorCtx {
  baseUrl?: string
  model?: string
  apiKey?: string
  /** 请求路径，默认 /chat/completions（/models 等其它端点要显式给） */
  path?: string
}

/** 响应片段里可能回显 Key，打码后再展示。 */
function redact(s: string, key: string): string {
  let out = s
  if (key && key.length >= 6) out = out.split(key).join(key.slice(0, 4) + '***')
  return out.replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1***')
}

function headerValue(res: any, names: string[]): string {
  const h = res && (res.headers || (res.data && res.data.headers))
  if (!h || typeof h !== 'object') return ''
  const lower: Record<string, string> = {}
  for (const k of Object.keys(h)) lower[k.toLowerCase()] = String(h[k])
  for (const n of names) {
    const v = lower[n]
    if (v) return v
  }
  return ''
}

/**
 * 把上游失败整理成能定位问题的一段文字：状态码 + 服务端原因 + 端点/模型/Key 状态
 * + 请求 id + 响应片段。这些信息缺一个，用户就只能对着 401 发呆。
 * 输出为纯文本（错误气泡按 pre-wrap 渲染，不经过 Markdown）。
 */
export function describeHttpError(res: any, ctx: ApiErrorCtx): string {
  const status = res && typeof res.status === 'number' ? res.status : 0
  const base = String(ctx.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const path = ctx.path || '/chat/completions'
  const key = ctx.apiKey || ''
  const lines: string[] = []

  // 服务端正文可能是 JSON（OpenAI 风格）也可能是网关的 HTML/纯文本
  let serverMsg = ''
  let serverCode = ''
  const raw = res && typeof res.body === 'string' ? res.body : ''
  try {
    const d = raw ? JSON.parse(raw) : null
    const err = d && (d.error || d)
    if (err && typeof err.message === 'string') serverMsg = err.message
    if (err && (typeof err.code === 'string' || typeof err.type === 'string')) {
      serverCode = String(err.code || err.type)
    }
    if (!serverMsg && d && typeof d.message === 'string') serverMsg = d.message
  } catch (e) {
    /* 非 JSON，下面用响应片段兜底 */
  }

  const head = status ? 'HTTP ' + status : '没有收到 HTTP 响应'
  lines.push('请求失败：' + head + (serverMsg ? ' · ' + redact(serverMsg, key) : ''))
  lines.push('')

  if (status === 0) {
    lines.push('原因：请求没到服务商（网络不通、代理层拒绝、baseUrl 不可访问）')
  } else if (STATUS_HINT[status]) {
    lines.push('原因：' + STATUS_HINT[status])
  } else if (status >= 500) {
    lines.push('原因：服务商上游故障，稍后重试；持续出现请查服务商状态页。')
  }

  lines.push('端点：' + base + path)
  lines.push('模型：' + (ctx.model || '(未设置)'))
  if (!key) {
    lines.push('API Key：未设置（到「设置 → 插件 → AI 助手」填写）')
  } else if (key !== key.trim()) {
    lines.push('API Key：含首尾空格或换行，这本身就会导致 401')
  } else {
    lines.push('API Key：已设置（' + key.length + ' 位）')
  }
  if (serverCode) lines.push('错误码：' + serverCode)
  const reqId = headerValue(res, ['x-request-id', 'request-id', 'x-ds-request-id', 'cf-ray'])
  if (reqId) lines.push('请求 id：' + reqId + '（联系服务商时出示）')
  if (raw) {
    lines.push('响应片段：' + redact(raw.replace(/\s+/g, ' ').slice(0, 300), key))
  } else if (res && res.bodyBase64) {
    lines.push('响应：二进制内容，已省略')
  } else {
    // 空 body 的 401/403 多半是本地代理或网关拦下的，不是服务商返回的
    lines.push('响应：空（服务端未返回任何内容，常见于代理/网关拦截，而非服务商拒绝）')
    const h = res && res.headers
    if (h && typeof h === 'object') {
      const keys = Object.keys(h).filter((k) => !/cookie|authorization/i.test(k)).slice(0, 6)
      if (keys.length) lines.push('响应头：' + keys.map((k) => k + '=' + String(h[k]).slice(0, 80)).join('; '))
    }
  }
  return lines.join('\n')
}

interface TurnPayload {
  model: string
  messages: ChatMessage[]
  max_tokens: number
  tools?: ToolDef[]
  tool_choice?: string
  reasoning_effort?: ReasoningEffort
}

function streamTurnNonStream(
  payload: TurnPayload,
  onDelta: ((c: string) => void) | undefined,
  ctx: StreamTurnCtx,
  onReasoning?: (r: string) => void
): Promise<StreamResult> {
  const api = getApi()
  if (!api) return Promise.reject(new Error('API 桥接不可用'))
  const endpoint = (ctx.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions'
  return api
    .call('proxyFetch', {
      url: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ctx.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: 120000,
    })
    .then((res: any) => {
      if (!res || res.status !== 200) {
        throw new Error(describeHttpError(res, { baseUrl: ctx.baseUrl, model: ctx.model, apiKey: ctx.apiKey }))
      }
      let data: any
      try {
        data = JSON.parse(res.body)
      } catch (e) {
        throw new Error(
          '响应不是合法 JSON（HTTP 200）\n' +
            '端点：' + (ctx.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '') + '/chat/completions\n' +
            '模型：' + ctx.model + '\n' +
            '响应片段：' + String(res.body || '').replace(/\s+/g, ' ').slice(0, 300)
        )
      }
      const choice = data.choices && data.choices[0]
      if (!choice) return { finishReason: null, content: '', toolCalls: [] as ToolCall[], reasoning: '' }
      const content = (choice.message && choice.message.content) || ''
      const reasoning = pickReasoning(choice.message) || pickReasoningDeep(choice)
      if (onReasoning && reasoning) onReasoning(reasoning)
      if (onDelta && content) onDelta(content)
      return {
        finishReason: choice.finish_reason || null,
        content: content,
        toolCalls: (choice.message && choice.message.tool_calls) || [],
        reasoning: reasoning,
      }
    })
}

export function streamTurn(
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  onDelta: (c: string) => void,
  ctx: StreamTurnCtx,
  onReasoning?: (r: string) => void
): Promise<StreamResult> {
  const payload: TurnPayload = {
    model: ctx.model,
    messages: messages,
    // 思考与正文共享该预算：默认放宽到 8192，避免高思考强度把预算吃光导致正文为空
    max_tokens: ctx.maxTokens && ctx.maxTokens > 0 ? ctx.maxTokens : 8192,
  }
  if (ctx.reasoningEffort && ctx.reasoningEffort !== 'off') payload.reasoning_effort = ctx.reasoningEffort
  if (ctx.model !== 'deepseek-reasoner') {
    payload.tools = ctx.tools
    payload.tool_choice = 'auto'
  }
  const api = getApi()
  if (!api) return Promise.reject(new Error('API 桥接不可用'))

  if (api.proxyFetchStream) {
    return new Promise<StreamResult>((resolve, reject) => {
      let content = ''
      let reasoning = ''
      const toolCalls: (ToolCall | undefined)[] = []
      let finishReason: string | null = null
      let settled = false
      function settle() {
        if (settled) return
        settled = true
        resolve({
          finishReason: finishReason,
          content: content,
          toolCalls: toolCalls.filter(Boolean) as ToolCall[],
          reasoning: reasoning,
        })
      }
      api
        .proxyFetchStream(
          {
            url: (ctx.baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ctx.apiKey },
            body: JSON.stringify({ ...payload, stream: true }),
            timeoutMs: 120000,
            signal: signal,
          },
          {
            onChunk(chunk) {
              const raw = String(chunk || '')
              const lines = raw.split('\n')
              for (let li = 0; li < lines.length; li++) {
                const line = lines[li].trim()
                if (!line) continue
                let l = line
                if (l.indexOf('data:') === 0) l = l.slice(5).trim()
                if (l === '[DONE]') {
                  if (!finishReason) finishReason = 'stop'
                  continue
                }
                let json: any
                try {
                  json = JSON.parse(l)
                } catch (e) {
                  continue
                }
                const choice = json.choices && json.choices[0]
                if (!choice) continue
                const delta = choice.delta || {}
                /**
                 * 思考与正文必须**各自独立累加**。
                 * 实测该端点会在同一帧同时给出二者（如 {content:"2", reasoning:"。"}），
                 * 所以这里只从 delta 的思考字段取值，不做跨字段/跨层回退，
                 * 也不允许 reasoning 与 content 互相顶替。
                 */
                const rc = pickReasoning(delta)
                if (rc) {
                  reasoning += rc
                  if (onReasoning) onReasoning(reasoning)
                }
                if (delta.content) {
                  content += delta.content
                  if (onDelta) onDelta(content)
                }
                if (delta.tool_calls) {
                  for (let j = 0; j < delta.tool_calls.length; j++) {
                    const tc = delta.tool_calls[j]
                    const idx = tc.index || 0
                    if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } }
                    if (tc.id) toolCalls[idx]!.id = tc.id
                    if (tc.function) {
                      if (tc.function.name) toolCalls[idx]!.function.name += tc.function.name
                      if (tc.function.arguments) toolCalls[idx]!.function.arguments += tc.function.arguments
                    }
                  }
                }
                if (choice.finish_reason) finishReason = choice.finish_reason
              }
            },
            onError(e) {
              if (settled) return
              settled = true
              if (e && e.name === 'AbortError') reject(e)
              else reject(new Error((e && e.message) || 'stream error'))
            },
          }
        )
        .then(
          () => settle(),
          (e) => {
            if (!settled) {
              settled = true
              reject(e)
            }
          }
        )
    })
      .then((result) => {
        if (!result.content && !result.toolCalls.length && !result.finishReason) {
          return streamTurnNonStream(payload, onDelta, ctx, onReasoning)
        }
        return result
      })
      .catch((e) => {
        if (e && e.name === 'AbortError') throw e
        return streamTurnNonStream(payload, onDelta, ctx, onReasoning)
      })
  }

  return streamTurnNonStream(payload, onDelta, ctx, onReasoning)
}