import { useEffect, useState } from 'react'
import { getApi } from './api.ts'
import ConfigForm, { type ConfigValues } from './components/ConfigForm.tsx'
import type { ReasoningEffort, Modality, FilePermission } from './chat/types.ts'

const DEFAULTS: ConfigValues = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  maxCtx: 200,
  showToolProcess: true,
  reasoningEffort: 'off',
  modalities: ['text'],
  filePermission: 'readonly',
  maxTokens: 8192,
  uiControl: false,
}

export default function SettingsApp() {
  // null = 尚未读到配置，用于避免「先渲染默认值再回填」造成的一闪与误判
  const [initial, setInitial] = useState<ConfigValues | null>(null)
  const [md, setMd] = useState({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '', visionModel: 'gpt-4o-mini', audioModel: 'gpt-4o-audio-preview' })
  const [mdStatus, setMdStatus] = useState<{ text: string; color?: string }>({ text: '' })
  const [mdReady, setMdReady] = useState<boolean | null>(null)

  useEffect(() => {
    const api = getApi()
    if (!api || !api.call) {
      setInitial(DEFAULTS)
      return
    }
    api
      .call('getSettings')
      .then((s: any) => {
        const settings = s || {}
        setInitial({
          baseUrl: settings.baseUrl || DEFAULTS.baseUrl,
          apiKey: settings.deepseekApiKey || '',
          model: settings.deepseekModel || DEFAULTS.model,
          maxCtx: typeof settings.maxCtx === 'number' ? settings.maxCtx : DEFAULTS.maxCtx,
          showToolProcess: settings.showToolProcess !== false,
          reasoningEffort: (settings.reasoningEffort as ReasoningEffort) || 'off',
          modalities: Array.isArray(settings.modalities) && settings.modalities.length
            ? (settings.modalities as Modality[])
            : ['text'],
          filePermission: (settings.filePermission as FilePermission) || 'readonly',
          maxTokens: typeof settings.maxTokens === 'number' && settings.maxTokens > 0 ? settings.maxTokens : 8192,
          uiControl: settings.uiControl === true,
        })
      })
      .catch(() => setInitial(DEFAULTS))

    api
      .call('callPlugin', 'top.qomicex.markitdown', 'getConfig')
      .then((c: any) => {
        setMdReady(true)
        c = c || {}
        setMd({
          baseUrl: c.baseUrl || 'https://api.deepseek.com/v1',
          apiKey: c.apiKey || '',
          visionModel: c.visionModel || 'gpt-4o-mini',
          audioModel: c.audioModel || 'gpt-4o-audio-preview',
        })
      })
      .catch(() => setMdReady(false))
  }, [])

  function setMdStatusText(msg: string, color?: string) {
    setMdStatus({ text: msg, color })
  }

  async function doSaveMd() {
    const api = getApi()
    if (!api || !api.call) {
      setMdStatusText('API 桥接不可用', 'hsl(var(--destructive))')
      return
    }
    if (!md.apiKey.trim()) {
      setMdStatusText('请输入 MarkItDown API Key', 'hsl(var(--destructive))')
      return
    }
    try {
      const r: any = await api.call('callPlugin', 'top.qomicex.markitdown', 'setConfig', {
        baseUrl: md.baseUrl.trim() || 'https://api.deepseek.com/v1',
        apiKey: md.apiKey.trim(),
        visionModel: md.visionModel.trim() || 'gpt-4o-mini',
        audioModel: md.audioModel.trim() || 'gpt-4o-audio-preview',
      })
      if (r && r.error) throw new Error(r.error)
      setMdStatusText('MarkItDown 配置已保存', 'hsl(var(--primary))')
      setTimeout(() => setMdStatusText(''), 2500)
    } catch (e: any) {
      setMdStatusText('保存失败（MarkItDown 插件未安装或未激活）: ' + (e.message || e), 'hsl(var(--destructive))')
    }
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Microsoft YaHei", "PingFang SC", sans-serif', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
      <div style={{ padding: 24, maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>AI 助手</h1>
        <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', margin: '0 0 20px' }}>配置 AI API，开启智能助手功能</p>

        {initial ? (
          <ConfigForm initial={initial} submitLabel="保存配置" settingsMode />
        ) : (
          <div className="p-card">
            <div className="p-card-content" style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>正在读取已保存配置…</div>
          </div>
        )}

        <div className="p-card" style={{ marginTop: 14 }}>
          <div className="p-card-content" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}>MarkItDown 文档转换（图片 OCR / 音频转写）</div>
              {mdReady === false && (
                <span style={{ flexShrink: 0, fontSize: 11, color: 'hsl(var(--destructive))' }}>未启用</span>
              )}
              {mdReady === true && <span style={{ flexShrink: 0, fontSize: 11, color: 'hsl(var(--primary))' }}>已连接</span>}
            </div>
            {mdReady === false && (
              <div style={{ fontSize: 12, color: 'hsl(var(--destructive))', lineHeight: 1.6 }}>
                未能调用 MarkItDown 插件（top.qomicex.markitdown）。请确认它已在「插件管理」中安装并启用；若已启用仍提示此项，属于启动器未加载纯功能库插件的问题，文档转换将不可用。
              </div>
            )}
            <div>
              <label className="p-label">视觉 / 音频 API 地址</label>
              <input type="url" className="p-input" value={md.baseUrl} onChange={(e) => setMd({ ...md, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div>
              <label className="p-label">API Key</label>
              <input type="password" className="p-input" value={md.apiKey} onChange={(e) => setMd({ ...md, apiKey: e.target.value })} placeholder="sk-..." />
            </div>
            <div>
              <label className="p-label">视觉模型（图片 OCR）</label>
              <input type="text" className="p-input" value={md.visionModel} onChange={(e) => setMd({ ...md, visionModel: e.target.value })} placeholder="gpt-4o-mini / qwen-vl-max" />
            </div>
            <div>
              <label className="p-label">音频模型（转写）</label>
              <input type="text" className="p-input" value={md.audioModel} onChange={(e) => setMd({ ...md, audioModel: e.target.value })} placeholder="gpt-4o-audio-preview / qwen-audio" />
            </div>
            <button className="p-btn p-btn--outline" style={{ width: '100%' }} onClick={doSaveMd}>
              保存 MarkItDown 配置
            </button>
            <div style={{ fontSize: 12, color: mdStatus.color || 'hsl(var(--muted-foreground))', textAlign: 'center', minHeight: 16 }}>{mdStatus.text}</div>
          </div>
        </div>

        <div className="p-card" style={{ marginTop: 14 }}>
          <div className="p-card-content" style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 600, color: 'hsl(var(--foreground))', marginBottom: 6 }}>使用说明</div>
            <div>1. 填写 API 地址（默认 Deepseek）和 API Key</div>
            <div>2. 点击「获取模型」拉取可用模型列表（失败时可手动输入模型名）</div>
            <div>3. 选择模型、思考强度与支持的模态后保存</div>
            <div>4. 点击侧边栏 AI 助手图标打开 agent 页面</div>
            <div style={{ marginTop: 6, fontSize: 11 }}>兼容 OpenAI 协议的 API 均可使用（Deepseek / OpenAI / 通义千问 / Groq / 硅基流动等）</div>
          </div>
        </div>
      </div>
    </div>
  )
}
