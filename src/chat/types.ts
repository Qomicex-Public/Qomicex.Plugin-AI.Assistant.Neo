export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 纯文本，或多模态内容块数组（OpenAI content parts） */
  content: string | null | MessagePart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ChatConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxCtx: number
  showToolProcess: boolean
  /** 全局默认思考强度（会话内可覆盖） */
  reasoningEffort: ReasoningEffort
  /** 该模型支持的输入模态（决定聊天框能否附加图片/视频） */
  modalities: Modality[]
  /** 文件操作权限（全局默认） */
  filePermission: FilePermission
}

export type UiMsgKind = 'user' | 'ai' | 'thinking' | 'tool' | 'progress'

/** 文件操作权限：只读 / 可写 / 完全访问 */
export type FilePermission = 'readonly' | 'write' | 'full'

/** 思考强度：off 时不发送 reasoning_effort 字段 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

/** 模型支持的输入模态 */
export type Modality = 'text' | 'image' | 'video'

/** 消息里的多模态内容块（OpenAI content parts 风格） */
export interface MessagePart {
  type: 'text' | 'image_url' | 'video_url'
  text?: string
  image_url?: { url: string }
  video_url?: { url: string }
}

export interface ChatConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxCtx: number
  showToolProcess: boolean
  reasoningEffort: ReasoningEffort
  modalities: Modality[]
}

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
  /** 用户消息携带的附件（图片/视频），仅用于气泡内展示 */
  attachments?: MessagePart[]
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