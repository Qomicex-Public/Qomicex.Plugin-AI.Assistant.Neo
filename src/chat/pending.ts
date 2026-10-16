import { getApi } from '../api.ts'
import { newConversationId } from './history.ts'

/**
 * 跨界面 handoff（胶囊 → 悬浮窗 / 路由页）。
 *
 * 为什么需要：胶囊、悬浮窗、路由页各自是独立 iframe，各自加载一份 bundle，
 * 内存里的 engine 状态互不相通（只有 cache 共享）。因此：
 *   - 「当前会话 id」必须落 cache，任何一个界面启动时据此续接同一会话；
 *   - 胶囊不自己跑对话，只把待发消息写 cache，再拉起悬浮窗由它消费。
 */

const CURRENT_KEY = 'assistant:current'
const PENDING_KEY = 'assistant:pending'

function bridge() {
  const api = getApi()
  if (!api || !api.call) return null
  return api
}

export async function getCurrentConversationId(): Promise<string | null> {
  const api = bridge()
  if (!api) return null
  try {
    const v = await api.call('getCache', CURRENT_KEY)
    if (v && typeof v === 'object' && typeof (v as any).id === 'string') return (v as any).id as string
  } catch {
    /* ignore */
  }
  return null
}

export async function setCurrentConversationId(id: string): Promise<void> {
  const api = bridge()
  if (!api || !id) return
  try {
    await api.call('setCache', CURRENT_KEY, { id })
  } catch {
    /* ignore */
  }
}

/** 取得当前会话 id，没有则新建并落库。 */
export async function ensureCurrentConversationId(): Promise<string> {
  const existing = await getCurrentConversationId()
  if (existing) return existing
  const id = newConversationId()
  await setCurrentConversationId(id)
  return id
}

export async function setPendingMessage(text: string): Promise<void> {
  const api = bridge()
  if (!api || !text) return
  try {
    await api.call('setCache', PENDING_KEY, { text, at: Date.now() })
  } catch {
    /* ignore */
  }
}

/** 读取并清除待发消息（只消费一次）。 */
export async function takePendingMessage(): Promise<string | null> {
  const api = bridge()
  if (!api) return null
  try {
    const v = await api.call('getCache', PENDING_KEY)
    if (v && typeof v === 'object' && typeof (v as any).text === 'string') {
      const text = (v as any).text as string
      await api.call('setCache', PENDING_KEY, null)
      return text
    }
  } catch {
    /* ignore */
  }
  return null
}
