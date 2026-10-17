import { useEffect, useState } from 'react'
import ChatView from '../chat/ChatView.tsx'
import { ensureCurrentConversationId, takePendingMessage } from '../chat/pending.ts'
import { getSnapshot, init, openConversation } from '../chat/engine.ts'

/**
 * 胶囊展开后的悬浮窗内容（由 overlay.create 注入本插件的 overlay.html 加载）。
 * 启动时续接「当前会话」并消费胶囊留下的待发消息。
 */
export default function OverlayChat() {
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      init()
      await new Promise((r) => setTimeout(r, 120))
      const id = await ensureCurrentConversationId()
      const snap = getSnapshot()
      if (snap.conversationId !== id) {
        await openConversation(id)
      }
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
  return <ChatView variant="overlay" initialMessage={pending} />
}
