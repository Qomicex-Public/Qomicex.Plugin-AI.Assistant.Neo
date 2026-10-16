import { useEffect, useState } from 'react'
import ChatView from '../chat/ChatView.tsx'
import { takePendingMessage } from '../chat/pending.ts'
import { getSnapshot, init, openConversation, showChatView } from '../chat/engine.ts'

/**
 * 侧边栏点击后打开的独立 agent 路由页（/plugins/p/top.qomicex.assistant）。
 * 左侧常驻历史对话，右侧聊天。启动时续接「当前会话」，并消费胶囊留下的待发消息。
 */
export default function AgentApp() {
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      init()
      // 等待 init 载入配置
      await new Promise((r) => setTimeout(r, 120))
      const id = await (await import('../chat/pending.ts')).ensureCurrentConversationId()
      const snap = getSnapshot()
      // 续接当前会话（若已有消息则保持）
      if (snap.conversationId !== id) {
        await openConversation(id)
      }
      showChatView()
      const text = await takePendingMessage()
      if (!cancelled) {
        setPending(text)
        setReady(true)
      }
    }
    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  if (!ready) {
    return (
      <div className="agent-boot">
        <span className="stream-cursor">&#9621;</span>
      </div>
    )
  }
  return <ChatView variant="page" initialMessage={pending} />
}
