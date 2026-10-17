import { getApi } from '../api.ts'
import type { ChatMessage } from './types.ts'

/**
 * 会话历史的本地持久化（走插件缓存 cache.json，不污染 settings.json）。
 *
 * 结构：
 *   assistant:conversations            -> ConversationMeta[]（索引，最多 MAX_KEEP 条）
 *   assistant:conversation:<id>        -> { messages, ui, id, title, createdAt, updatedAt }
 *
 * 说明：ui 里不存渲染后的 html（体积大且可从 content 重建），读取时按需重渲染。
 */

export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  count: number
}

export interface ConversationData {
  messages: ChatMessage[]
}

interface StoredConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

const INDEX_KEY = 'assistant:conversations'
const DATA_KEY = (id: string) => 'assistant:conversation:' + id
/** 仅保留最近 N 条会话，超出按 updatedAt 淘汰最旧。 */
export const MAX_KEEP = 50

function bridge() {
  const api = getApi()
  if (!api || !api.call) return null
  return api
}

export function newConversationId(): string {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 由首条用户消息派生会话标题。 */
export function deriveTitle(text: string): string {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return '新对话'
  return t.length > 24 ? t.slice(0, 24) + '…' : t
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const api = bridge()
  if (!api) return []
  try {
    const v = await api.call('getCache', INDEX_KEY)
    if (!Array.isArray(v)) return []
    return (v as ConversationMeta[])
      .filter((m) => m && typeof m.id === 'string')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  } catch {
    return []
  }
}

export async function loadConversation(id: string): Promise<StoredConversation | null> {
  const api = bridge()
  if (!api || !id) return null
  try {
    const v = await api.call('getCache', DATA_KEY(id))
    if (!v || typeof v !== 'object') return null
    const d = v as StoredConversation
    return {
      id: d.id || id,
      title: d.title || '新对话',
      createdAt: d.createdAt || Date.now(),
      updatedAt: d.updatedAt || Date.now(),
      messages: Array.isArray(d.messages) ? d.messages : [],
    }
  } catch {
    return null
  }
}

/**
 * 保存会话：写数据 + 更新索引。标题只在当前为默认值时用首条用户消息覆盖。
 * 超过 MAX_KEEP 时淘汰最旧会话的数据文件与索引项。
 *
 * 只存 messages（不存渲染后的 ui）：ui 里含有流式中间态（未收尾的思考、半截 html、
 * 光标），持久化后无法忠实还原，恢复时会出现缺失气泡/多余光标/id 撞号等问题。
 * 渲染结果由 messages 重建（见 engine.openConversation）。
 */
export async function saveConversation(data: ConversationData & { id: string; title: string }): Promise<ConversationMeta | null> {
  const api = bridge()
  if (!api || !data.id) return null
  const now = Date.now()
  const list = await listConversations()
  const prev = list.find((m) => m.id === data.id)
  const createdAt = prev?.createdAt || now
  // 标题：没有标题或仍是占位时，用首条用户消息派生
  const firstUser = data.messages.find((m) => m.role === 'user' && m.content)
  const derived = firstUser ? deriveTitle(String(firstUser.content)) : ''
  const title = !data.title || data.title === '新对话' ? derived || data.title || '新对话' : data.title

  const stored: StoredConversation = {
    id: data.id,
    title,
    createdAt,
    updatedAt: now,
    messages: data.messages,
  }

  try {
    await api.call('setCache', DATA_KEY(data.id), stored)
  } catch {
    return null
  }

  const meta: ConversationMeta = { id: data.id, title, createdAt, updatedAt: now, count: data.messages.filter((m) => m.role !== 'system').length }
  const next = [meta, ...list.filter((m) => m.id !== data.id)].sort((a, b) => b.updatedAt - a.updatedAt)
  const keep = next.slice(0, MAX_KEEP)
  const dropped = next.slice(MAX_KEEP)
  for (const d of dropped) {
    try {
      await api.call('setCache', DATA_KEY(d.id), null)
    } catch {
      /* 淘汰失败不阻塞 */
    }
  }
  try {
    await api.call('setCache', INDEX_KEY, keep)
  } catch {
    /* ignore */
  }
  return meta
}

export async function deleteConversation(id: string): Promise<void> {
  const api = bridge()
  if (!api || !id) return
  try {
    await api.call('setCache', DATA_KEY(id), null)
    const list = await listConversations()
    await api.call('setCache', INDEX_KEY, list.filter((m) => m.id !== id))
  } catch {
    /* ignore */
  }
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const api = bridge()
  if (!api || !id) return
  const list = await listConversations()
  const idx = list.findIndex((m) => m.id === id)
  if (idx >= 0) {
    list[idx] = { ...list[idx], title: title || list[idx].title, updatedAt: Date.now() }
    try {
      await api.call('setCache', INDEX_KEY, list.sort((a, b) => b.updatedAt - a.updatedAt))
    } catch {
      /* ignore */
    }
  }
  const data = await loadConversation(id)
  if (data) {
    try {
      await api.call('setCache', DATA_KEY(id), { ...data, title: title || data.title, updatedAt: Date.now() })
    } catch {
      /* ignore */
    }
  }
}
