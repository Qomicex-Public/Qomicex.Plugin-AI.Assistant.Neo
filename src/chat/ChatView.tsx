import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { UiMessage, MessagePart, ReasoningEffort, FilePermission } from './types.ts'
import { getApi } from '../api.ts'
import {
  getSnapshot,
  subscribe,
  init,
  registerFileDropHandler,
  bindInput,
  sendMessage,
  stopGeneration,
  newChat,
  showChatView,
  manualCompressCtx,
  toggleToolEntry,
  toggleThinking,
  setSessionEffort,
  setSessionPermission,
  refreshConversations,
  openConversation,
  removeConversation,
  renameConv,
} from './engine.ts'
import { loadGridImages, loadInfoImages } from './images.ts'
import ConfigForm from '../components/ConfigForm.tsx'
import { copyText, openExternal } from '../lib/clipboard.ts'

export interface ChatViewProps {
  /** page = agent 路由页（历史常驻侧栏）；overlay = 悬浮窗（历史抽屉） */
  variant?: 'page' | 'overlay'
  /** 启动后自动发送的文本（胶囊 handoff 用） */
  initialMessage?: string | null
}

function FlowingText({ text }: { text: string }) {
  return (
    <span className="flowing">
      {text.split('').map((c, i) => (
        <span key={i} className="flow-char" style={{ animationDelay: i * 0.12 + 's' }}>
          {c}
        </span>
      ))}
    </span>
  )
}

type IconName = 'stop' | 'refresh' | 'plus' | 'settings' | 'chevron' | 'copy' | 'check' | 'history' | 'close' | 'trash' | 'send' | 'attach'
function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'stop':
      return (
        <svg {...p}>
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'refresh':
      return (
        <svg {...p}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.2 14.4a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V20a1.94 1.94 0 1 1-3.88 0v-.1a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H4a1.94 1.94 0 1 1 0-3.88h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08A1.6 1.6 0 0 0 10 4.1V4a1.94 1.94 0 1 1 3.88 0v.1a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.97H20a1.94 1.94 0 1 1 0 3.88h-.1a1.6 1.6 0 0 0-1.47.97z" />
        </svg>
      )
    case 'history':
      return (
        <svg {...p}>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      )
    case 'chevron':
      return (
        <svg {...p}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...p}>
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...p}>
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </svg>
      )
    case 'close':
      return (
        <svg {...p}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )
    case 'send':
      return (
        <svg {...p}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      )
    case 'attach':
      return (
        <svg {...p}>
          <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      )
    case 'check':
    default:
      return (
        <svg {...p}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
  }
}

function bindLinks(container: Element) {
  const links = container.querySelectorAll('a[href]')
  for (let i = 0; i < links.length; i++) {
    const a = links[i] as HTMLAnchorElement
    const href = a.getAttribute('href')
    if (!href || /^#|^javascript:/.test(href)) continue
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openExternal(href)
    })
  }
}

function enhanceCodeBlocks(container: Element) {
  const pres = container.querySelectorAll('pre')
  for (let i = 0; i < pres.length; i++) {
    const pre = pres[i] as HTMLElement
    if (pre.dataset.enhanced === '1') continue
    pre.dataset.enhanced = '1'
    const code = pre.querySelector('code')
    const langMatch = code ? /language-([\w+#-]+)/.exec(code.className) : null
    const wrap = document.createElement('div')
    wrap.className = 'code-block'
    const bar = document.createElement('div')
    bar.className = 'code-bar'
    const lang = document.createElement('span')
    lang.className = 'code-lang'
    lang.textContent = langMatch ? langMatch[1] : 'text'
    const btn = document.createElement('button')
    btn.className = 'code-copy'
    btn.type = 'button'
    btn.textContent = '复制'
    btn.addEventListener('click', () => {
      void copyText(code ? (code as HTMLElement).innerText : pre.innerText).then((ok) => {
        btn.textContent = ok ? '已复制' : '复制失败'
        setTimeout(() => (btn.textContent = '复制'), 1500)
      })
    })
    bar.appendChild(lang)
    bar.appendChild(btn)
    pre.parentNode?.insertBefore(wrap, pre)
    wrap.appendChild(bar)
    wrap.appendChild(pre)
  }
}

const lineStyle: CSSProperties = {
  color: 'hsl(var(--muted-foreground))',
  opacity: 0.9,
  padding: '1px 0 1px 18px',
  fontSize: 11.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/** 打开启动器系统级插件设置并定位到本插件。 */
export function openPluginSettings() {
  const api = getApi()
  if (api && api.call) api.call('openPluginSettings').catch(() => {})
}

export default function ChatView({ variant = 'overlay', initialMessage = null }: ChatViewProps) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const inputElRef = useRef<HTMLTextAreaElement>(null)
  const msgsRef = useRef<HTMLDivElement>(null)
  const processedRef = useRef<Set<number>>(new Set())
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  /** 待发送的图片/视频附件（base64 data URL，仅本会话内存） */
  const [pending, setPending] = useState<MessagePart[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bootstrapped = useRef(false)
  /** 有文件正被拖到页面上（显示整页提示层） */
  const [dragActive, setDragActive] = useState(false)
  /** 输入区下方的一行临时提示（如：模型未启用图片模态） */
  const [hint, setHint] = useState('')
  const hintTimer = useRef<number | null>(null)
  /** 拖入/粘贴的监听只绑定一次，用 ref 读最新模态，避免闭包过期 */
  const modalitiesRef = useRef<string[]>(snapshot.cfg.modalities)
  modalitiesRef.current = snapshot.cfg.modalities

  useEffect(() => {
    init()
    registerFileDropHandler()
    bindInput({
      get value() {
        return inputRef.current
      },
      set: (v: string) => {
        inputRef.current = v
        setInput(v)
      },
      focus: () => inputElRef.current?.focus(),
    })
    if (variant === 'page') void refreshConversations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 胶囊 handoff：初次挂载时消费待发消息
  useEffect(() => {
    if (bootstrapped.current || !initialMessage) return
    bootstrapped.current = true
    void sendMessage(initialMessage)
  }, [initialMessage])

  /**
   * 拖入 / 粘贴：图片与视频直接变成附件（与点「添加图片」同一条路），
   * 其它文件保持原有行为 —— 把路径插进输入框，交给 AI 用 Read / Bash 处理。
   */
  useEffect(() => {
    function dragHasFiles(e: DragEvent) {
      const types = e.dataTransfer?.types
      return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0
    }
    function onDragOver(e: DragEvent) {
      // 纯文本/链接的拖入交给浏览器默认行为，不拦截
      if (!dragHasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    }
    function onDragLeave(e: DragEvent) {
      // 在子元素之间移动也会触发 leave，只有真正离开窗口（relatedTarget 为空）才收起
      if (e.relatedTarget === null) setDragActive(false)
    }
    function onDrop(e: DragEvent) {
      const files = e.dataTransfer?.files
      if (!files || !files.length) return
      e.preventDefault()
      setDragActive(false)
      const media: File[] = []
      const others: File[] = []
      for (const f of Array.from(files)) {
        const tp = f.type || ''
        if (tp.startsWith('image/') || tp.startsWith('video/')) media.push(f)
        else others.push(f)
      }
      if (media.length) addAttachments(media)
      if (others.length) {
        const paths = others.map((f) => {
          const fp = (f as any).path
          return '"' + (fp !== undefined && fp !== null && fp !== '' ? String(fp) : f.name) + '"'
        })
        inputRef.current = (inputRef.current ? inputRef.current + ' ' : '') + paths.join(' ')
        setInput(inputRef.current)
        inputElRef.current?.focus()
      }
    }
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of Array.from(items)) {
        if (it.kind !== 'file') continue
        const f = it.getAsFile()
        if (f) files.push(f)
      }
      // 剪贴板里没有图片/视频文件 → 不干预，走浏览器默认的文本粘贴
      if (!files.length) return
      // 在别的输入控件里粘贴时不劫持（例如重命名会话的输入框）
      const t = e.target as HTMLElement | null
      if (t && t !== inputElRef.current && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      e.preventDefault()
      addAttachments(files)
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const finished = snapshot.ui.filter((m) => m.kind === 'ai' && m.html && !m.streaming && !processedRef.current.has(m.id))
    for (const m of finished) {
      const node = el.querySelector('[data-msg-id="' + m.id + '"]')
      if (node) {
        loadGridImages(node)
        loadInfoImages(node)
        bindSuggestChips(node)
        bindLinks(node)
        enhanceCodeBlocks(node)
        processedRef.current.add(m.id)
      }
    }
    el.scrollTop = el.scrollHeight
  }, [snapshot.ui, historyOpen])

  function bindSuggestChips(container: Element) {
    const chips = container.querySelectorAll('.suggest-chip')
    for (let i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', () => {
        const text = chips[i].getAttribute('data-suggest')
        if (!text || snapshot.cfg.thinking) return
        inputRef.current = ''
        setInput('')
        void sendMessage(text)
      })
    }
  }

  function doSend() {
    const text = input.trim()
    if (!text && pending.length === 0) return
    inputRef.current = ''
    setInput('')
    if (text === '/compact' && pending.length === 0) {
      manualCompressCtx()
      return
    }
    // 无文字时不要塞一个空的 text part（部分厂商会拒），直接只发附件
    const parts: MessagePart[] | undefined = pending.length
      ? [...(text ? ([{ type: 'text', text }] as MessagePart[]) : []), ...pending]
      : undefined
    setPending([])
    void sendMessage(text, parts)
  }

  /** 在输入区下方显示一行临时提示（约 3.6 秒后自动消失）。 */
  function notice(text: string) {
    setHint(text)
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setHint(''), 3600)
  }

  /**
   * 把 File 对象转成待发送附件 —— 点按钮 / 拖入 / 粘贴共用这一条路。
   *
   * 只收模型声明支持的模态（避免必然失败的请求）；被滤掉时不再静默丢弃，
   * 而是给一行提示说明怎么开启 —— 拖进来一张图却毫无反应比报错更让人困惑。
   */
  function addAttachments(files: FileList | File[] | null): number {
    if (!files) return 0
    const list = Array.from(files)
    if (!list.length) return 0
    const modes = modalitiesRef.current || []
    let added = 0
    let skippedImage = 0
    let skippedVideo = 0
    for (const f of list) {
      const isImage = f.type.startsWith('image/')
      const isVideo = f.type.startsWith('video/')
      if (!isImage && !isVideo) continue
      if (isImage && modes.indexOf('image') < 0) {
        skippedImage++
        continue
      }
      if (isVideo && modes.indexOf('video') < 0) {
        skippedVideo++
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result || '')
        if (!url) return
        setPending((prev) => [
          ...prev,
          isImage ? { type: 'image_url', image_url: { url } } : { type: 'video_url', video_url: { url } },
        ])
      }
      reader.readAsDataURL(f)
      added++
    }
    const skipped = skippedImage + skippedVideo
    if (skipped > 0) {
      const kinds = [skippedImage ? '图片' : '', skippedVideo ? '视频' : ''].filter(Boolean).join('、')
      notice(`当前模型未启用「${kinds}」模态，已忽略 ${skipped} 个文件；如需发送请在「设置 → 模型支持的模态」里勾选「${kinds}」`)
    }
    return added
  }

  function doCopyAi(m: UiMessage) {
    const text = m.content || ''
    if (!text) return
    void copyText(text).then((ok) => {
      if (ok) {
        setCopiedId(m.id)
        setTimeout(() => setCopiedId((v) => (v === m.id ? null : v)), 1500)
      }
    })
  }

  function renderMessage(m: UiMessage) {
    switch (m.kind) {
      case 'user':
        return (
          <div key={m.id} className="msg-row msg-row--user">
            <div className="msg-bubble msg-user">
              {m.content}
              {m.attachments && m.attachments.length > 0 && (
                <div className="msg-attachments">
                  {m.attachments.map((a, i) =>
                    a.type === 'image_url' && a.image_url ? (
                      <img key={i} className="msg-attach-img" src={a.image_url.url} alt="附件图片" />
                    ) : a.type === 'video_url' && a.video_url ? (
                      <video key={i} className="msg-attach-img" src={a.video_url.url} controls />
                    ) : null
                  )}
                </div>
              )}
            </div>
          </div>
        )
      case 'ai':
        return (
          <div key={m.id} className="msg-row msg-row--ai">
            <div className="msg-col">
              <div className="msg-bubble msg-ai" data-msg-id={m.id}>
                {m.html ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: m.html }} />
                ) : m.streaming ? (
                  <span className="stream-cursor">&#9621;</span>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                )}
              </div>
              {!m.streaming && m.content ? (
                <button className="msg-copy" type="button" title="复制回答" onClick={() => doCopyAi(m)}>
                  <Icon name={copiedId === m.id ? 'check' : 'copy'} size={13} />
                  {copiedId === m.id ? '已复制' : '复制'}
                </button>
              ) : null}
            </div>
          </div>
        )
      case 'thinking': {
        // 「已思考」只负责展开思考过程；上下文压缩在顶部用量徽标上，两者不该混为一谈。
        const hasDetail = !!(m.detail && m.detail.trim())
        return (
          <div key={m.id} className="msg-row msg-row--ai">
            <div className="msg-col">
              <button
                className={'thinking-chip' + (hasDetail ? ' thinking-chip--expandable' : '')}
                type="button"
                title={hasDetail ? (m.collapsed === false ? '收起思考过程' : '展开思考过程') : '该模型未返回思考过程'}
                disabled={!hasDetail}
                onClick={() => hasDetail && toggleThinking(m.id)}
              >
                {hasDetail && (
                  <span className={'tool-caret' + (m.collapsed === false ? ' tool-caret--open' : '')}>
                    <Icon name="chevron" size={11} />
                  </span>
                )}
                {m.done ? m.content : <FlowingText text="正在思考" />}
              </button>
              {hasDetail && m.collapsed === false && <div className="thinking-detail">{m.detail}</div>}
            </div>
          </div>
        )
      }
      case 'tool':
        return (
          <div key={m.id} className="msg-row msg-row--ai">
            <div className="tool-card">
              <button className="tool-head" type="button" onClick={() => toggleToolEntry(m.id)}>
                <span className={'tool-caret' + (m.collapsed ? '' : ' tool-caret--open')}>
                  <Icon name="chevron" size={12} />
                </span>
                <span className="tool-title">{m.content}</span>
              </button>
              {!m.collapsed && (
                <div className="tool-body">
                  {m.toolName && m.toolArgsText ? (
                    <div style={lineStyle}>
                      → {m.toolName}({m.toolArgsText})
                    </div>
                  ) : null}
                  {(m.toolLines || []).map((l, i) =>
                    l.result ? (
                      <div key={i} style={lineStyle}>
                        ← {l.result}
                      </div>
                    ) : null
                  )}
                  {m.image ? (
                    // 界面截图：直接内联预览，点击可看原图（新窗口打开 data URL）
                    <img
                      className="tool-shot"
                      src={m.image}
                      alt="界面截图"
                      title="点击查看原图"
                      onClick={() => window.open(m.image, '_blank')}
                    />
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )
      case 'progress':
        return (
          <div key={m.id} className="progress-line">
            {m.content}
          </div>
        )
      default:
        return null
    }
  }

  const historyList = useMemo(() => {
    const list = snapshot.conversations
    return list.map((c) => ({
      ...c,
      label: c.title || '新对话',
      time: formatWhen(c.updatedAt),
    }))
  }, [snapshot.conversations])

  function closeHistory() {
    setHistoryOpen(false)
    setRenamingId(null)
  }

  const historyPanel = (
    <div className={variant === 'page' ? 'history-side' : 'history-drawer'}>
      <div className="history-head">
        <span className="history-title">历史对话</span>
        <div className="history-head-actions">
          <button
            className="icon-btn"
            type="button"
            title="新对话"
            onClick={() => {
              newChat()
              closeHistory()
            }}
          >
            <Icon name="plus" size={13} />
          </button>
          {variant === 'overlay' && (
            <button className="icon-btn" type="button" title="关闭" onClick={closeHistory}>
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="history-list">
        {historyList.length === 0 && <div className="history-empty">还没有历史对话</div>}
        {historyList.map((c) => (
          <div key={c.id} className={'history-item' + (c.id === snapshot.conversationId ? ' history-item--active' : '')}>
            {renamingId === c.id ? (
              <input
                className="history-rename"
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onBlur={() => {
                  void renameConv(c.id, renameText.trim() || c.label)
                  setRenamingId(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
              />
            ) : (
              <button
                className="history-item-main"
                type="button"
                onClick={() => {
                  void openConversation(c.id)
                  closeHistory()
                }}
                onDoubleClick={() => {
                  setRenamingId(c.id)
                  setRenameText(c.label)
                }}
                title="双击重命名"
              >
                <span className="history-item-title">{c.label}</span>
                <span className="history-item-meta">
                  {c.time}
                  {c.count ? ' · ' + c.count + ' 条' : ''}
                </span>
              </button>
            )}
            <button
              className="history-del"
              type="button"
              title="删除"
              onClick={() => void removeConversation(c.id)}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className={'chat-root' + (variant === 'page' ? ' chat-root--page' : '')}>
      {variant === 'page' && historyPanel}
      {dragActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-box">
            <Icon name="attach" size={22} />
            <div className="drop-overlay-title">松开即可添加图片</div>
            <div className="drop-overlay-sub">图片 / 视频会成为待发送附件；其它文件会插入文件路径</div>
          </div>
        </div>
      )}
      <div className="chat-main">
        <header className="chat-head">
          <div className="chat-head-left">
            {variant === 'overlay' && (
              <button
                className="icon-btn"
                type="button"
                title="历史对话"
                onClick={() => {
                  const next = !historyOpen
                  setHistoryOpen(next)
                  if (next) void refreshConversations()
                }}
              >
                <Icon name="history" />
              </button>
            )}
            <span className="chat-title">{snapshot.cfg.configured ? snapshot.conversationTitle : 'AI 助手'}</span>
            {snapshot.cfg.configured && snapshot.ctxUsage.text && (
              <button
                className={'ctx-badge' + (snapshot.ctxUsage.warn ? ' ctx-badge--warn' : '')}
                title="上下文用量，点击手动压缩"
                type="button"
                onClick={manualCompressCtx}
              >
                {snapshot.ctxUsage.text}
              </button>
            )}
            {snapshot.cfg.configured && (
              <select
                className="effort-select"
                title="文件操作权限（仅影响当前会话）"
                value={snapshot.cfg.effectivePermission}
                onChange={(e) => setSessionPermission(e.target.value as FilePermission)}
              >
                <option value="readonly">权限:只读</option>
                <option value="write">可写</option>
                <option value="full">完全访问</option>
              </select>
            )}
            {snapshot.cfg.configured && (
              <select
                className="effort-select"
                title="思考强度（仅影响当前会话）"
                value={snapshot.cfg.effectiveEffort}
                onChange={(e) => setSessionEffort(e.target.value as ReasoningEffort)}
              >
                <option value="off">思考:关</option>
                <option value="minimal">最低</option>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="max">最高</option>
              </select>
            )}
          </div>
          <div className="chat-head-actions">
            {snapshot.cfg.thinking && (
              <button className="icon-btn icon-btn--danger" title="停止输出" type="button" onClick={stopGeneration}>
                <Icon name="stop" />
              </button>
            )}
            <button className="icon-btn" title="新对话" type="button" onClick={newChat}>
              <Icon name="plus" />
            </button>
            <button className="icon-btn" title="设置（启动器插件设置）" type="button" onClick={openPluginSettings}>
              <Icon name="settings" />
            </button>
          </div>
        </header>

        {snapshot.view === 'chat' ? (
          <>
            <div ref={msgsRef} className="chat-msgs">
              {snapshot.ui.map(renderMessage)}
            </div>
            <div className="chat-input-bar">
              {(snapshot.cfg.modalities.includes('image') || snapshot.cfg.modalities.includes('video')) && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={[
                      snapshot.cfg.modalities.includes('image') ? 'image/*' : '',
                      snapshot.cfg.modalities.includes('video') ? 'video/*' : '',
                    ].filter(Boolean).join(',')}
                    multiple
                    hidden
                    onChange={(e) => {
                      addAttachments(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  <button
                    className="icon-btn attach-btn"
                    type="button"
                    title="添加图片/视频"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="attach" size={15} />
                  </button>
                </>
              )}
              <textarea
                ref={inputElRef}
                className="chat-input"
                rows={1}
                value={input}
                onChange={(e) => {
                  inputRef.current = e.target.value
                  setInput(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    doSend()
                  }
                }}
                placeholder="输入消息，Enter 发送 · Shift+Enter 换行 · 可直接拖入或粘贴图片"
              />
              <button className="send-btn" type="button" onClick={doSend} disabled={!input.trim() && pending.length === 0}>
                发送
              </button>
            </div>
            {pending.length > 0 && (
              <div className="attach-strip">
                {pending.map((p, i) => (
                  <div key={i} className="attach-item">
                    {p.type === 'image_url' && p.image_url ? (
                      <img src={p.image_url.url} alt="" />
                    ) : (
                      <video src={p.video_url?.url} />
                    )}
                    <button
                      className="attach-remove"
                      type="button"
                      title="移除"
                      onClick={() => setPending((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={'chat-hint' + (hint ? ' chat-hint--alert' : '')}>
              {hint || 'Enter 发送 · Shift+Enter 换行 · 可直接拖入或粘贴图片 · /compact 压缩上下文'}
            </div>
          </>
        ) : snapshot.view === 'history' ? (
          <div className="chat-config">
            <div className="p-card">
              <div className="p-card-content">
                <button className="p-btn p-btn--outline" type="button" onClick={showChatView}>
                  返回对话
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="chat-config">
            <ConfigForm
              initial={{
                baseUrl: snapshot.cfg.baseUrl,
                apiKey: snapshot.cfg.apiKey,
                model: snapshot.cfg.model,
                maxCtx: snapshot.cfg.maxCtx,
                showToolProcess: snapshot.cfg.showToolProcess,
                reasoningEffort: snapshot.cfg.reasoningEffort,
                modalities: snapshot.cfg.modalities,
                filePermission: snapshot.cfg.filePermission,
                maxTokens: snapshot.cfg.maxTokens,
                uiControl: snapshot.cfg.uiControl,
              }}
              onSaved={showChatView}
              onBack={snapshot.cfg.configured ? showChatView : undefined}
              submitLabel="保存并开始"
            />
            <div className="config-hint">
              <button className="p-btn p-btn--ghost" type="button" onClick={openPluginSettings}>
                打开启动器插件设置（含 MarkItDown 配置）
              </button>
            </div>
          </div>
        )}
      </div>

      {variant === 'overlay' && historyOpen && (
        <>
          <div className="history-scrim" onClick={closeHistory} />
          {historyPanel}
        </>
      )}
    </div>
  )
}

function formatWhen(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const y = new Date(now.getTime() - 86400000)
  const isYesterday = d.toDateString() === y.toDateString()
  const pad = (n: number) => (n < 10 ? '0' + n : String(n))
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (isYesterday) return '昨天'
  return d.getMonth() + 1 + '/' + d.getDate()
}
