import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getApi } from '../api.ts'
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

function FlowingText({ text }: { text: string }) {
  return (
    <span>
      {text.split('').map((c, i) => (
        <span key={i} className="flow-char" style={{ animationDelay: i * 0.12 + 's' }}>
          {c}
        </span>
      ))}
    </span>
  )
}

function openExternal(url: string) {
  if (!url || !/^https?:\/\//i.test(url)) return
  const api = getApi()
  if (api && api.call) api.call('callBackend', '/system/open-url', { url }).catch(() => {})
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

const lineStyle: CSSProperties = {
  color: 'hsl(var(--muted-foreground))',
  opacity: 0.8,
  padding: '1px 0 1px 24px',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

export default function ChatApp() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const inputElRef = useRef<HTMLInputElement>(null)
  const msgsRef = useRef<HTMLDivElement>(null)
  const processedRef = useRef<Set<number>>(new Set())

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
        sendMessage(text)
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
    sendMessage(text)
  }

  function renderMessage(m: UiMessage) {
    switch (m.kind) {
      case 'user':
        return (
          <div key={m.id} className="msg-bubble msg-user">
            {m.content}
          </div>
        )
      case 'ai':
        return (
          <div key={m.id} className="msg-bubble msg-ai" data-msg-id={m.id}>
            {m.html ? (
              <div dangerouslySetInnerHTML={{ __html: m.html }} />
            ) : m.streaming ? (
              <span className="stream-cursor">&#9621;</span>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
            )}
          </div>
        )
      case 'thinking':
        return (
          <div
            key={m.id}
            className="msg-bubble msg-ai thinking-line"
            style={{ alignSelf: 'flex-start', fontSize: 12, color: 'hsl(var(--muted-foreground))', cursor: 'pointer', userSelect: 'none' }}
            title="点击手动压缩上下文"
            onClick={manualCompressCtx}
          >
            {m.done ? m.content : <FlowingText text="正在思考" />}
          </div>
        )
      case 'tool':
        return (
          <div key={m.id} className="progress-line tool-entry">
            <div
              className="tool-entry-head"
              style={{ cursor: 'pointer', userSelect: 'none', color: 'hsl(var(--muted-foreground))', fontSize: 11, padding: '1px 0 1px 16px', lineHeight: 1.4 }}
              onClick={() => toggleToolEntry(m.id)}
            >
              {m.content}
            </div>
            {!m.collapsed && (
              <div>
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
        )
      case 'progress':
        return (
          <div key={m.id} className="progress-line" style={{ alignSelf: 'flex-start', color: 'hsl(var(--muted-foreground))', padding: '1px 12px 1px 16px', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.4 }}>
            {m.content}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13, position: 'relative', overflow: 'hidden', minWidth: 320 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid hsl(var(--border))', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>AI 助手</span>
          {snapshot.cfg.configured && (
            <span
              className={snapshot.ctxUsage.warn ? 'p-badge p-badge--red' : 'p-badge p-badge--default'}
              style={{ cursor: 'pointer' }}
              title="点击手动压缩上下文"
              onClick={manualCompressCtx}
            >
              {snapshot.ctxUsage.text}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {snapshot.cfg.thinking && (
            <button className="p-btn p-btn--ghost p-btn--sm" title="停止输出" style={{ color: 'hsl(var(--destructive))' }} onClick={stopGeneration}>
              ■
            </button>
          )}
          <button className="p-btn p-btn--ghost p-btn--sm" title="新对话" onClick={newChat}>
            ↻
          </button>
          <button className="p-btn p-btn--ghost p-btn--sm" title="设置" onClick={showConfigView}>
            ⚙
          </button>
        </div>
      </div>

      {snapshot.view === 'chat' ? (
        <>
          <div ref={msgsRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            {snapshot.ui.map(renderMessage)}
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid hsl(var(--border))' }}>
            <input
              ref={inputElRef}
              className="p-input"
              style={{ flex: 1 }}
              value={input}
              onChange={(e) => {
                inputRef.current = e.target.value
                setInput(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doSend()
              }}
              placeholder="输入消息..."
            />
            <button className="p-btn p-btn--primary" style={{ flexShrink: 0 }} onClick={doSend}>
              发送
            </button>
          </div>
        </>
      ) : (
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', minHeight: 0 }}>
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