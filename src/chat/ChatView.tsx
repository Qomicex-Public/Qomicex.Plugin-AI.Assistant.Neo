import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { UiMessage } from './types.ts'
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

type IconName = 'stop' | 'refresh' | 'settings' | 'chevron' | 'copy' | 'check' | 'history' | 'close' | 'trash' | 'send'
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
    case 'settings':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
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
  const bootstrapped = useRef(false)

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

  useEffect(() => {
    function onDragOver(e: DragEvent) {
      e.preventDefault()
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (!files || !files.length) return
      const paths: string[] = []
      for (const f of Array.from(files)) {
        const fp = (f as any).path !== undefined && (f as any).path !== null && (f as any).path !== '' ? (f as any).path : f.name
        paths.push('"' + fp + '"')
      }
      inputRef.current = (inputRef.current ? inputRef.current + ' ' : '') + paths.join(' ')
      setInput(inputRef.current)
      inputElRef.current?.focus()
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
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
    if (!text) return
    inputRef.current = ''
    setInput('')
    if (text === '/compact') {
      manualCompressCtx()
      return
    }
    void sendMessage(text)
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
            <div className="msg-bubble msg-user">{m.content}</div>
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
            <Icon name="refresh" size={13} />
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
          </div>
          <div className="chat-head-actions">
            {snapshot.cfg.thinking && (
              <button className="icon-btn icon-btn--danger" title="停止输出" type="button" onClick={stopGeneration}>
                <Icon name="stop" />
              </button>
            )}
            <button className="icon-btn" title="新对话" type="button" onClick={newChat}>
              <Icon name="refresh" />
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
                placeholder="输入消息，Enter 发送 · Shift+Enter 换行"
              />
              <button className="send-btn" type="button" onClick={doSend} disabled={!input.trim()}>
                发送
              </button>
            </div>
            <div className="chat-hint">Enter 发送 · Shift+Enter 换行 · /compact 压缩上下文</div>
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
