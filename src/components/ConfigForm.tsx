import { useEffect, useState } from 'react'
import { fetchModels as engineFetchModels, testConnection, testModel, saveConfig } from '../chat/engine.ts'
import type { ReasoningEffort, Modality, FilePermission } from '../chat/types.ts'

export interface ConfigValues {
  baseUrl: string
  apiKey: string
  model: string
  maxCtx: number
  showToolProcess: boolean
  reasoningEffort: ReasoningEffort
  modalities: Modality[]
  filePermission: FilePermission
  /** 单次回复输出上限（思考与正文共享） */
  maxTokens: number
  /** 「启动器操作」（UI 自动化）总开关，与文件权限独立 */
  uiControl: boolean
}

interface ConfigFormProps {
  initial: ConfigValues
  onSaved?: () => void
  onBack?: () => void
  submitLabel?: string
  /**
   * 以「设置页」形态展示：只读写全局默认值，不触发聊天引擎的保存/跳转。
   * 聊天内的设置视图用默认值（false）。
   */
  settingsMode?: boolean
}

const EFFORTS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '不发送 reasoning_effort（兼容不支持思考的模型）' },
  { value: 'minimal', label: '最低', hint: 'reasoning_effort=minimal' },
  { value: 'low', label: '低', hint: 'reasoning_effort=low' },
  { value: 'medium', label: '中', hint: 'reasoning_effort=medium' },
  { value: 'high', label: '高', hint: 'reasoning_effort=high' },
  { value: 'max', label: '最高', hint: 'reasoning_effort=max（部分提供商支持）' },
]

const MODALITIES: { value: Modality; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
]

const FILE_PERMS: { value: FilePermission; label: string; hint: string }[] = [
  {
    value: 'readonly',
    label: '只读',
    hint: '只能 Read / Grep 查看，不能写入、执行命令或解压。查 wiki / 搜索模组等非文件操作不受影响。',
  },
  {
    value: 'write',
    label: '可写',
    hint: 'Read / Write / Edit / Grep / Bash / Compress / Decompress 全部可用；首次访问某个目录时启动器会弹窗向你授权。',
  },
  {
    value: 'full',
    label: '完全访问',
    hint: '与「可写」相同但不再弹授权窗，自动同意。请仅在信任当前任务时使用。',
  },
]

export default function ConfigForm({
  initial,
  onSaved,
  onBack,
  submitLabel = '保存并开始',
  settingsMode = false,
}: ConfigFormProps) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl || 'https://api.deepseek.com/v1')
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [model, setModel] = useState(initial.model || 'deepseek-chat')
  const [modelList, setModelList] = useState<string[]>([])
  const [maxCtx, setMaxCtx] = useState(initial.maxCtx || 200)
  const [showToolProcess, setShowToolProcess] = useState(initial.showToolProcess !== false)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(initial.reasoningEffort || 'off')
  const [modalities, setModalities] = useState<Modality[]>(initial.modalities?.length ? initial.modalities : ['text'])
  const [filePermission, setFilePermission] = useState<FilePermission>(initial.filePermission || 'readonly')
  const [maxTokens, setMaxTokens] = useState<number>(initial.maxTokens || 8192)
  const [uiControl, setUiControl] = useState<boolean>(initial.uiControl === true)
  const [status, setStatus] = useState<{ text: string; color?: string }>({ text: '' })
  const [busy, setBusy] = useState(false)

  /**
   * 关键：initial 往往是异步拿到的（先渲染默认值，再 getSettings 回填）。
   * useState 的初值只读一次，若不显式同步，表单会永远停在默认值上
   * —— 这就是「设置里看不到已保存配置」的原因。
   */
  useEffect(() => {
    if (!initial) return
    setBaseUrl(initial.baseUrl || 'https://api.deepseek.com/v1')
    setApiKey(initial.apiKey || '')
    setModel(initial.model || 'deepseek-chat')
    setMaxCtx(initial.maxCtx || 200)
    setShowToolProcess(initial.showToolProcess !== false)
    setReasoningEffort(initial.reasoningEffort || 'off')
    setModalities(initial.modalities?.length ? initial.modalities : ['text'])
    setFilePermission(initial.filePermission || 'readonly')
    setMaxTokens(initial.maxTokens || 8192)
    setUiControl(initial.uiControl === true)
    // 只在外部 initial 真正变化时同步（对象由父级按值重建）
  }, [
    initial.baseUrl,
    initial.apiKey,
    initial.model,
    initial.maxCtx,
    initial.showToolProcess,
    initial.reasoningEffort,
    initial.filePermission,
    initial.maxTokens,
    initial.uiControl,
    /* 数组按内容比较，避免父级每次渲染都重置 */
    initial.modalities?.join(','),
  ])

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
    const modes = modalities.includes('text') ? modalities : [...modalities, 'text' as Modality]
    setBusy(true)
    const r = await saveConfig(
      {
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        maxCtx,
        showToolProcess,
        reasoningEffort,
        modalities: modes,
        filePermission,
        maxTokens,
        uiControl,
      },
      { settingsMode }
    )
    setBusy(false)
    if (r.ok) {
      show(settingsMode ? '已保存' : '')
      if (settingsMode) {
        setTimeout(() => show(''), 2000)
      } else {
        onSaved?.()
      }
    } else {
      show('保存失败: ' + (r.error || ''), 'hsl(var(--destructive))')
    }
  }

  function toggleModality(m: Modality) {
    setModalities((prev) => {
      if (prev.includes(m)) {
        // 文本始终保留：任何对话都需要文本
        if (m === 'text') return prev
        return prev.filter((x) => x !== m)
      }
      return [...prev, m]
    })
  }

  return (
    <div className="p-card">
      <div className="p-card-content" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!settingsMode && (
          <p style={{ margin: 0, color: 'hsl(var(--muted-foreground))', textAlign: 'center', fontSize: 13 }}>请配置 AI API</p>
        )}
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
          <label className="p-label">思考强度</label>
          <div className="field-row">
            <select className="p-input" value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}>
              {EFFORTS.map((e) => (
                <option key={e.value} value={e.value} title={e.hint}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-hint">{EFFORTS.find((e) => e.value === reasoningEffort)?.hint}</div>
        </div>

        <div>
          <label className="p-label">单次回复上限</label>
          <div className="field-row">
            <select className="p-input" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value) || 8192)}>
              <option value={2048}>2048（省额度，长思考易截断）</option>
              <option value={4096}>4096</option>
              <option value={8192}>8192（推荐）</option>
              <option value={16384}>16384</option>
              <option value={32768}>32768（长文/深度思考）</option>
            </select>
          </div>
          <div className="field-hint">
            思考过程与正文**共享**这一上限。开启较高思考强度时，若上限太小，模型可能把预算全花在思考上导致正文为空。
          </div>
        </div>

        <div>
          <label className="p-label">文件操作权限</label>
          <div className="field-row">
            <select className="p-input" value={filePermission} onChange={(e) => setFilePermission(e.target.value as FilePermission)}>
              {FILE_PERMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-hint">{FILE_PERMS.find((p) => p.value === filePermission)?.hint}</div>
        </div>

        <div>
          <label className="p-label">模型支持的模态</label>
          <div className="modality-row">
            {MODALITIES.map((m) => (
              <label key={m.value} className={'modality-chip' + (modalities.includes(m.value) ? ' modality-chip--on' : '')}>
                <input
                  type="checkbox"
                  checked={modalities.includes(m.value)}
                  disabled={m.value === 'text'}
                  onChange={() => toggleModality(m.value)}
                />
                {m.label}
              </label>
            ))}
          </div>
          <div className="field-hint">
            决定聊天框可发送的内容类型。勾选图片/视频后，可在聊天框中附加对应文件；模型需实际支持，否则请求会报错。
          </div>
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

        <div>
          <label className="p-check-field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={uiControl} onChange={(e) => setUiControl(e.target.checked)} />
            <span>允许操作启动器界面</span>
          </label>
          <div className="field-hint">
            开启后 AI 可以读取启动器界面元素，并点击、输入界面（界面上显示的是 AI 自己的<b>虚拟光标</b>，
            不会移动你的鼠标、也不会抢焦点，你可以继续用电脑）。带 Ctrl/Alt 的快捷键或个别控件需要抢前台时才动真实键盘，
            且会先尝试不动鼠标的做法。
            用途：某些功能只有界面没有插件 API 时，AI 仍能帮你完成。
            风险更高：AI 会真的点击界面，删除/卸载这类不可逆动作需你当场确认（提示词约束，不是弹窗拦截）。
            只影响界面操作，与上面的文件权限相互独立。仅 Windows 可用。
            {!modalities.includes('image') && '（未勾选图片模态时不会提供截图工具）'}
          </div>
        </div>

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
