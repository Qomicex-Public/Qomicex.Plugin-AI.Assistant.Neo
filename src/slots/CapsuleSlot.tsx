import { useCallback, useEffect, useRef, useState } from 'react'
import { getApi } from '../api.ts'
import { buildOverlayPayload } from '../chat/overlayHtml.ts'
import { ensureCurrentConversationId, setCurrentConversationId, setPendingMessage } from '../chat/pending.ts'

/**
 * 标题栏胶囊（contributes.slots → header:right）。
 *
 * 交互：默认收起为一个小圆点；鼠标靠近（悬停）展开成输入条；输入后回车/点发送：
 *   1. 续接「当前会话 id」（与悬浮窗/路由页同一会话）
 *   2. 写待发消息到 cache
 *   3. 动态创建悬浮窗（overlay.create）并定位到胶囊下方；已存在则 setHtml + show
 *   4. 清空输入、收起
 *
 * 胶囊自身不跑对话：它是独立沙箱，与悬浮窗/路由页各自一份运行时，只通过 cache 协作。
 */

const OVERLAY_ID_KEY = 'assistant:capsuleOverlayId'
const OVERLAY_W = 460
const OVERLAY_H = 640

export default function CapsuleSlot() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!err) return
    const t = setTimeout(() => setErr(''), 4000)
    return () => clearTimeout(t)
  }, [err])

  const submit = useCallback(async () => {
    const value = text.trim()
    if (!value || busy) return
    const api = getApi()
    if (!api) {
      setErr('插件桥接不可用')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const id = await ensureCurrentConversationId()
      await setCurrentConversationId(id)
      await setPendingMessage(value)

      const payload = await buildOverlayPayload()
      if (!payload) {
        setErr('无法加载悬浮窗内容')
        return
      }

      setText('')
      setOpen(false)

      // 位置交给启动器决定：插件运行在 sandbox iframe 里（opaque origin），
      // 读不到宿主窗口的尺寸/位置，任何基于自身 getBoundingClientRect 的换算都会落到
      // 错误坐标系。悬浮窗本身可拖拽，落点由启动器默认值决定即可。
      const existing = await readOverlayId()
      if (existing) {
        // 缓存的悬浮窗可能已随上次会话销毁（启动器重启后 id 失效，且 setHtml/show
        // 对不存在的 id 是静默 no-op，无法据此判断存活）。因此统一先销毁再新建，
        // 保证一定能拿到一个可用的悬浮窗，同时避免多开堆叠。
        try {
          await api.call('overlay.destroy', existing)
        } catch {
          /* 已不存在则忽略 */
        }
        await writeOverlayId(null)
      }
      const created = await api.call('overlay.create', {
        title: 'AI 助手',
        html: payload.html,
        width: OVERLAY_W,
        height: OVERLAY_H,
        minimizable: true,
        resizable: true,
      })
      if (typeof created === 'string') await writeOverlayId(created)
    } catch (e: any) {
      setErr('打开悬浮窗失败: ' + (e?.message || e))
    } finally {
      setBusy(false)
    }
  }, [text, busy])

  return (
    <div className="capsule-host">
      <div
        className={'capsule' + (open ? ' capsule--open' : '')}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          if (!text) setOpen(false)
        }}
      >
        <button className="capsule-dot" type="button" title="AI 助手 — 点击提问" aria-label="AI 助手" onClick={() => setOpen((v) => !v)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" />
            <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
          </svg>
        </button>
        <input
          ref={inputRef}
          className="capsule-input"
          value={text}
          placeholder={err || '问 AI 助手…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              setText('')
              setOpen(false)
            }
          }}
        />
        <button className="capsule-send" type="button" title="发送" disabled={!text.trim() || busy} onClick={() => void submit()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  )
}

async function readOverlayId(): Promise<string | null> {
  const api = getApi()
  if (!api) return null
  try {
    const v: any = await api.call('getCache', OVERLAY_ID_KEY)
    if (v && typeof v === 'object' && typeof v.id === 'string') return v.id
  } catch {
    /* ignore */
  }
  return null
}

async function writeOverlayId(id: string | null) {
  const api = getApi()
  if (!api) return
  try {
    await api.call('setCache', OVERLAY_ID_KEY, id ? { id } : null)
  } catch {
    /* ignore */
  }
}
