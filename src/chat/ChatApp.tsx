import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { UiMessage } from './types.ts'
import {
  getSnapshot,
  subscribe,
  init,
  registerFileDropHandler,
  bindInput,
  sendMessage,
  stopGeneration,
  newChat,
  showConfigView,
  showChatView,
  manualCompressCtx,
  toggleToolEntry,
} from './engine.ts'
import { loadGridImages, loadInfoImages } from './images.ts'
import ConfigForm from '../components/ConfigForm.tsx'
import { copyText, openExternal } from '../lib/clipboard.ts'

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

type IconName = 'stop' | 'refresh' | 'settings' | 'chevron' | 'copy' | 'check'
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

/** 给每个代码块加语言标记与「复制」按钮（幂等：靠 data-enhanced 去重）。 */
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

export default function ChatApp() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const inputElRef = useRef<HTMLTextAreaElement>(null)
  const msgsRef = useRef<HTMLDivElement>(null)
  const processedRef = useRef<Set<number>>(new Set())
  const [copiedId, setCopiedId] = useState<number | null>(null)

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  }, [snapshot.ui])

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
            <div className="msg-avatar ai-avatar">AI</div>
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
                <button
                  className="msg-copy"
                  type="button"
                  title="复制回答"
                  onClick={() => doCopyAi(m)}
                >
                  <Icon name={copiedId === m.id ? 'check' : 'copy'} size={13} />
                  {copiedId === m.id ? '已复制' : '复制'}
                </button>
              ) : null}
            </div>
          </div>
        )
      case 'thinking':
        return (
          <div key={m.id} className="msg-row msg-row--ai">
            <div className="msg-avatar ai-avatar">AI</div>
            <button className="thinking-chip" title="点击手动压缩上下文" onClick={manualCompressCtx}>
              {m.done ? m.content : <FlowingText text="正在思考" />}
            </button>
          </div>
        )
      case 'tool':
        return (
          <div key={m.id} className="msg-row msg-row--ai">
            <div className="tool-spacer" />
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

  const ctxPct = snapshot.ctxUsage.text || ''

  return (
    <div className="chat-root">
      <header className="chat-head">
        <div className="chat-head-left">
          <span className="chat-title">AI 助手</span>
          {snapshot.cfg.configured && (
            <button
              className={'ctx-badge' + (snapshot.ctxUsage.warn ? ' ctx-badge--warn' : '')}
              title="上下文用量，点击手动压缩"
              type="button"
              onClick={manualCompressCtx}
            >
              {ctxPct}
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
          <button className="icon-btn" title="设置" type="button" onClick={showConfigView}>
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
        </div>
      )}
    </div>
  )
}
