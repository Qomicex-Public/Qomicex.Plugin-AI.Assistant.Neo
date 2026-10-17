export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ChatConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxCtx: number
  showToolProcess: boolean
}

export type UiMsgKind = 'user' | 'ai' | 'thinking' | 'tool' | 'progress'

export interface ToolEntryLine {
  args?: string
  result?: string
}

export interface UiMessage {
  id: number
  kind: UiMsgKind
  content?: string
  html?: string
  streaming?: boolean
  thinkingStart?: number
  done?: boolean
  toolName?: string
  toolArgsText?: string
  toolTimeMs?: number
  toolLines?: ToolEntryLine[]
  collapsed?: boolean
  /** 思考条目的展开内容（模型思考过程）；为空时该条目不可展开 */
  detail?: string
  /** 用于 AI 消息渲染时避免与工具块标记冲突 */
  rawText?: string
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}