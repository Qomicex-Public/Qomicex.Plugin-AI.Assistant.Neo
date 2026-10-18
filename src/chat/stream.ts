import type { ChatMessage, ToolCall, ToolDef, ReasoningEffort } from './types.ts'
import { getApi } from '../api.ts'

export interface StreamTurnCtx {
  model: string
  baseUrl: string
  apiKey: string
  tools: ToolDef[]
  /** 'off'（或未设置）时不发送 reasoning_effort 字段 */
  reasoningEffort?: ReasoningEffort
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
export function buildPayload(model: string, messages: ChatMessage[], effort?: ReasoningEffort): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 4096,
  }
  if (effort && effort !== 'off') payload.reasoning_effort = effort
  return payload
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
  return api
    .call('proxyFetch', {
      url: (ctx.baseUrl || 'https://api.deepseek.com/v1') + '/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ctx.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: 120000,
    })
    .then((res: any) => {
      if (!res || res.status !== 200) {
        let errMsg = 'API error: ' + (res && res.status)
        try {
          const d = JSON.parse(res.body || '{}')
          if (d.error && d.error.message) errMsg = d.error.message
        } catch (e) {}
        throw new Error(errMsg)
      }
      const data = JSON.parse(res.body)
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
    max_tokens: 4096,
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