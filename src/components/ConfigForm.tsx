import { useState } from 'react'
import { fetchModels as engineFetchModels, testConnection, testModel, saveConfig } from '../chat/engine.ts'

interface ConfigFormProps {
  initial: { baseUrl: string; apiKey: string; model: string; maxCtx: number; showToolProcess: boolean }
  onSaved?: () => void
  onBack?: () => void
  submitLabel?: string
}

export default function ConfigForm({ initial, onSaved, onBack, submitLabel = '保存并开始' }: ConfigFormProps) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl || 'https://api.deepseek.com/v1')
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [model, setModel] = useState(initial.model || 'deepseek-chat')
  const [modelList, setModelList] = useState<string[]>([])
  const [maxCtx, setMaxCtx] = useState(initial.maxCtx || 200)
  const [showToolProcess, setShowToolProcess] = useState(initial.showToolProcess !== false)
  const [status, setStatus] = useState<{ text: string; color?: string }>({ text: '' })
  const [busy, setBusy] = useState(false)

  function show(msg: string, color?: string) {
    setStatus({ text: msg, color })
  }

  async function doFetchModels() {
    if (!apiKey.trim()) {
      show('请输入 API Key', 'hsl(var(--destructive))')
      return
    }
    setBusy(true)
    show('正在获取模型列表...')
    const r = await engineFetchModels(apiKey.trim(), baseUrl.trim())
    setBusy(false)
    if (r.error) {
      show(r.error, 'hsl(var(--destructive))')
      setTimeout(() => show(''), 4000)
      return
    }
    setModelList(r.models.map((m) => m.id))
    show('已加载 ' + r.models.length + ' 个模型', 'hsl(var(--primary))')
    setTimeout(() => show(''), 3000)
  }

  async function doTestModel() {
    if (!apiKey.trim()) {
      show('请输入 API Key', 'hsl(var(--destructive))')
      return
    }
    if (!model.trim()) {
      show('请输入或选择模型', 'hsl(var(--destructive))')
      return
    }
    setBusy(true)
    show('测试中...')
    const r = await testModel(apiKey.trim(), baseUrl.trim(), model.trim())
    setBusy(false)
    if (r.ok) {
      show('模型可用 ✓', 'hsl(var(--primary))')
      setTimeout(() => show(''), 2500)
    } else {
      show('测试失败: ' + (r.error || ''), 'hsl(var(--destructive))')
      setTimeout(() => show(''), 4000)
    }
  }

  async function doTestConnection() {
    if (!apiKey.trim()) {
      show('请先输入 API Key', 'hsl(var(--destructive))')
      return
    }
    setBusy(true)
    show('正在测试...')
    const r = await testConnection(apiKey.trim(), baseUrl.trim(), model.trim() || 'deepseek-chat')
    setBusy(false)
    if (r.ok) {
      show('连接成功 ✓', 'hsl(var(--primary))')
    } else {
      show('连接失败: ' + (r.error || ''), 'hsl(var(--destructive))')
    }
    setTimeout(() => show(''), 3000)
  }

  async function doSave() {
    if (!apiKey.trim()) {
      show('请输入 API Key', 'hsl(var(--destructive))')
      return
    }
    if (!model.trim()) {
      show('请先获取模型列表并选择模型', 'hsl(var(--destructive))')
      return
    }
    setBusy(true)
    const r = await saveConfig({
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      maxCtx,
      showToolProcess,
    })
    setBusy(false)
    if (r.ok) {
      show('')
      onSaved?.()
    } else {
      show('保存失败: ' + (r.error || ''), 'hsl(var(--destructive))')
    }
  }

  return (
    <div className="p-card">
      <div className="p-card-content" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, color: 'hsl(var(--muted-foreground))', textAlign: 'center', fontSize: 13 }}>请配置 AI API</p>
        <div>
          <label className="p-label">API 地址</label>
          <input type="url" className="p-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
        </div>
        <div>
          <label className="p-label">API Key</label>
          <div className="field-row">
            <input type="password" className="p-input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
            <button className="p-btn p-btn--outline" onClick={doFetchModels} disabled={busy}>
              获取模型
            </button>
          </div>
        </div>
        <div>
          <label className="p-label">模型</label>
          <div className="field-row">
            <input list="cfgModelList" className="p-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="点击获取模型或手动输入" />
            <button className="p-btn p-btn--outline" onClick={doTestModel} disabled={busy}>
              测试
            </button>
          </div>
          <datalist id="cfgModelList">
            {modelList.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="p-label">
            最大上下文 <span style={{ color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>{maxCtx}k</span>
          </label>
          <input type="range" min={4} max={1000} value={maxCtx} onChange={(e) => setMaxCtx(parseInt(e.target.value) || 200)} style={{ width: '100%' }} />
        </div>
        <label className="p-check-field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={showToolProcess} onChange={(e) => setShowToolProcess(e.target.checked)} />
          <span>显示工具调用过程</span>
        </label>
        <button className="p-btn p-btn--primary" style={{ width: '100%' }} onClick={doSave} disabled={busy}>
          {submitLabel}
        </button>
        <button className="p-btn p-btn--outline" style={{ width: '100%' }} onClick={doTestConnection} disabled={busy}>
          测试连接
        </button>
        {onBack && (
          <button className="p-btn p-btn--ghost" style={{ width: '100%' }} onClick={onBack}>
            返回
          </button>
        )}
        <div style={{ fontSize: 12, color: status.color || 'hsl(var(--muted-foreground))', textAlign: 'center', minHeight: 16 }}>
          {status.text}
        </div>
      </div>
    </div>
  )
}