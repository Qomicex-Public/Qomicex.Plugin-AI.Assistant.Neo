import { useEffect, useState, type CSSProperties } from 'react'
import { configureSkills, getSkillCatalog, refreshSkills, type SkillEntry } from '../chat/skills.ts'
import { testMcpServer, type McpServerConfig } from '../chat/mcp.ts'
import {
  ensureRegistryLoaded,
  listRegistered,
  removeRegistered,
  setRegisteredEnabled,
  type RegisteredMcpMeta,
  type RegisteredSkillMeta,
} from '../chat/registry.ts'

interface Props {
  skillsEnabled: boolean
  setSkillsEnabled: (v: boolean) => void
  skillsDir: string
  setSkillsDir: (v: string) => void
  disabledSkills: string[]
  setDisabledSkills: (v: string[]) => void
  mcpEnabled: boolean
  setMcpEnabled: (v: boolean) => void
  mcpServers: McpServerConfig[]
  setMcpServers: (v: McpServerConfig[]) => void
}

function formatHeaders(h?: Record<string, string>): string {
  if (!h) return ''
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function parseHeaders(text: string): { headers?: Record<string, string>; error?: string } {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) return { error: `无法解析这一行（需要 Key: Value）：${line}` }
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (/^host$/i.test(key) || /^content-length$/i.test(key)) return { error: `${key} 不允许自定义（由代理决定）` }
    out[key] = value
  }
  return { headers: Object.keys(out).length ? out : undefined }
}

function sourceLabel(source: string): string {
  if (source === 'builtin') return '内置'
  if (source === 'user') return '用户目录'
  return '插件 ' + source.replace(/^plugin:/, '')
}

export default function CapabilitySettings({
  skillsEnabled,
  setSkillsEnabled,
  skillsDir,
  setSkillsDir,
  disabledSkills,
  setDisabledSkills,
  mcpEnabled,
  setMcpEnabled,
  mcpServers,
  setMcpServers,
}: Props) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [skillErrors, setSkillErrors] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [testing, setTesting] = useState<Record<string, { busy?: boolean; text?: string; color?: string }>>({})
  const [registeredSkills, setRegisteredSkills] = useState<RegisteredSkillMeta[]>([])
  const [registeredMcp, setRegisteredMcp] = useState<RegisteredMcpMeta[]>([])

  async function loadSkills(force = false) {
    try {
      const c = force ? await refreshSkills() : await getSkillCatalog()
      setSkills(c.skills)
      setSkillErrors(c.errors)
    } catch (e: any) {
      setSkillErrors([String((e && e.message) || e || '读取技能失败')])
    }
  }

  async function loadRegistry() {
    try {
      const r = await listRegistered()
      setRegisteredSkills(r.skills)
      setRegisteredMcp(r.mcp)
    } catch {
      setRegisteredSkills([])
      setRegisteredMcp([])
    }
  }

  useEffect(() => {
    // 设置页是独立 iframe，技能模块默认 dir 为空；先用当前表单值初始化，
    // 否则首次渲染只能看到内置/插件技能，看不到用户目录里的。
    configureSkills({ dir: skillsDir, disabled: disabledSkills })
    void ensureRegistryLoaded()
    void loadSkills()
    void loadRegistry()
  }, [])

  async function doRescan() {
    setScanning(true)
    try {
      // 「重新扫描」按输入框里的目录扫描（尚未保存也要能预览）
      configureSkills({ dir: skillsDir, disabled: disabledSkills })
      await loadSkills(true)
      await loadRegistry()
    } finally {
      setScanning(false)
    }
  }

  function toggleSkill(id: string, on: boolean) {
    if (on) setDisabledSkills(disabledSkills.filter((x) => x !== id))
    else if (!disabledSkills.includes(id)) setDisabledSkills([...disabledSkills, id])
  }

  function updateServer(index: number, next: McpServerConfig) {
    setMcpServers(mcpServers.map((s, i) => (i === index ? next : s)))
  }

  function removeServer(index: number) {
    setMcpServers(mcpServers.filter((_, i) => i !== index))
  }

  function addServer() {
    setMcpServers([
      ...mcpServers,
      { id: 'srv_' + Date.now().toString(36), name: '新 MCP 服务器', url: '', enabled: true, source: 'config' },
    ])
  }

  async function doTest(server: McpServerConfig) {
    setTesting((t) => ({ ...t, [server.id]: { busy: true, text: '正在连接…' } }))
    const r = await testMcpServer(server)
    setTesting((t) => ({
      ...t,
      [server.id]: r.ok
        ? {
            text: `连接成功 ✓ ${r.toolCount} 个工具${r.protocolVersion ? `（${r.protocolVersion}）` : ''}`,
            color: 'hsl(var(--primary))',
          }
        : { text: '连接失败: ' + (r.error || '未知错误'), color: 'hsl(var(--destructive))' },
    }))
  }

  async function toggleRegistered(type: 'skill' | 'mcp', providerId: string, id: string, enabled: boolean) {
    const r = await setRegisteredEnabled(type, providerId, id, enabled)
    if (!r.ok) return
    await loadRegistry()
    await loadSkills()
  }

  async function deleteRegistered(type: 'skill' | 'mcp', providerId: string, id: string, name: string) {
    if (!window.confirm(`删除第三方注册的${type === 'skill' ? '技能' : ' MCP 服务器'}「${name}」？`)) return
    await removeRegistered(type, providerId, id)
    await loadRegistry()
    await loadSkills()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ---------------- 技能 ---------------- */}
      <div className="p-card">
        <div className="p-card-content" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600 }}>技能（Skills）</div>
          <label className="p-check-field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={skillsEnabled} onChange={(e) => setSkillsEnabled(e.target.checked)} />
            <span>启用技能</span>
          </label>
          <div className="field-hint">
            启动时只把名称与描述放进系统提示词；模型需要时用 Skill 工具加载全文，不会一次性吃掉上下文。
            技能目录结构：<code>&lt;目录&gt;/&lt;技能名&gt;/SKILL.md</code>。
          </div>
          <div>
            <label className="p-label">用户技能目录（留空 = 不扫描）</label>
            <div className="field-row">
              <input
                className="p-input"
                value={skillsDir}
                onChange={(e) => setSkillsDir(e.target.value)}
                placeholder="例如 D:\\AI\\skills"
              />
              <button className="p-btn p-btn--outline" type="button" onClick={doRescan} disabled={scanning}>
                {scanning ? '扫描中…' : '重新扫描'}
              </button>
            </div>
            <div className="field-hint">首次读取未授权目录时启动器会弹窗，允许后再点「重新扫描」。</div>
          </div>

          {skillErrors.length > 0 && (
            <div style={{ fontSize: 12, color: 'hsl(var(--destructive))', lineHeight: 1.6 }}>
              {skillErrors.map((e, i) => (
                <div key={i}>⚠️ {e}</div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {skills.length === 0 && <div className="field-hint">尚未发现技能。</div>}
            {skills.map((s) => {
              const disabled = disabledSkills.includes(s.id)
              const warning = s.warning === '已在设置中禁用' && !disabled ? undefined : s.warning
              const usable = !disabled && !(warning && warning.includes('缺少 description'))
              return (
                <label
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '6px 8px',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 6,
                    cursor: 'pointer',
                    opacity: usable ? 1 : 0.65,
                  }}
                >
                  <input type="checkbox" checked={usable} onChange={(e) => toggleSkill(s.id, e.target.checked)} style={{ marginTop: 3 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{s.name}</span>
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>
                      {sourceLabel(s.source)}
                      {s.verified === false ? ' · 未验证提供者' : ''}
                    </span>
                    <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }}>{s.description || '（无描述）'}</div>
                    {warning && <div style={{ fontSize: 11, color: 'hsl(var(--destructive))' }}>⚠️ {warning}</div>}
                  </span>
                </label>
              )
            })}
          </div>
          <div className="field-hint">内置技能只读；用户目录里的技能可直接编辑 SKILL.md 后点「重新扫描」。</div>
        </div>
      </div>

      {/* ---------------- MCP ---------------- */}
      <div className="p-card">
        <div className="p-card-content" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600 }}>MCP 服务器（HTTP / SSE）</div>
          <label className="p-check-field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={mcpEnabled} onChange={(e) => setMcpEnabled(e.target.checked)} />
            <span>启用 MCP</span>
          </label>
          <div className="field-hint">
            只支持 Streamable HTTP / SSE（不支持 stdio）。工具名会变成 mcp__&lt;服务器&gt;__&lt;工具&gt;；
            工具较多时自动折叠为 McpListTools。连接失败只影响该服务器，不会中断对话。
          </div>

          {mcpServers.map((s, i) => (
            <McpRow
              key={s.id}
              server={s}
              testState={testing[s.id]}
              onChange={(next) => updateServer(i, next)}
              onRemove={() => removeServer(i)}
              onTest={() => doTest(s)}
            />
          ))}

          <button className="p-btn p-btn--outline" type="button" onClick={addServer}>
            添加 MCP 服务器
          </button>
        </div>
      </div>

      {/* ---------------- 第三方注册 ---------------- */}
      <div className="p-card">
        <div className="p-card-content" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600 }}>第三方提供者注册</div>
          <div className="field-hint">
            其它插件通过 <code>ai.registerSkill</code> / <code>ai.registerMcp</code> 注册的内容。
            providerId 无法在插件侧验证调用者身份，因此「已验证」只表示启动器里确实装了该插件。
          </div>
          {registeredSkills.length === 0 && registeredMcp.length === 0 && (
            <div className="field-hint">暂无第三方注册。第三方插件加载后注册的内容会自动出现在这里。</div>
          )}
          {registeredSkills.map((s) => (
            <div key={'s:' + s.providerId + '/' + s.id} style={rowStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 0 }}>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => void toggleRegistered('skill', s.providerId, s.id, e.target.checked)}
                />
                <span style={{ minWidth: 0 }}>
                  <b>{s.name}</b>
                  <span style={metaStyle}>技能 · {s.providerId}</span>
                  <div style={descStyle}>{s.description || '（无描述）'}</div>
                  <div style={subStyle}>
                    {s.verified ? '提供者已安装' : '提供者未验证'} · {new Date(s.registeredAt).toLocaleString()}
                  </div>
                </span>
              </label>
              <button className="p-btn p-btn--ghost" type="button" onClick={() => void deleteRegistered('skill', s.providerId, s.id, s.name)}>
                删除
              </button>
            </div>
          ))}
          {registeredMcp.map((m) => (
            <div key={'m:' + m.providerId + '/' + m.id} style={rowStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 0 }}>
                <input
                  type="checkbox"
                  checked={m.enabled}
                  onChange={(e) => void toggleRegistered('mcp', m.providerId, m.id, e.target.checked)}
                />
                <span style={{ minWidth: 0 }}>
                  <b>{m.name}</b>
                  <span style={metaStyle}>MCP · {m.providerId}</span>
                  <div style={descStyle}>{m.url}</div>
                  <div style={subStyle}>
                    {m.verified ? '提供者已安装' : '提供者未验证'} · {new Date(m.registeredAt).toLocaleString()}
                  </div>
                </span>
              </label>
              <button className="p-btn p-btn--ghost" type="button" onClick={() => void deleteRegistered('mcp', m.providerId, m.id, m.name)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function McpRow({
  server,
  testState,
  onChange,
  onRemove,
  onTest,
}: {
  server: McpServerConfig
  testState?: { busy?: boolean; text?: string; color?: string }
  onChange: (next: McpServerConfig) => void
  onRemove: () => void
  onTest: () => void
}) {
  const [headersText, setHeadersText] = useState(formatHeaders(server.headers))
  const [headerError, setHeaderError] = useState('')
  const headersKey = JSON.stringify(server.headers || {})
  useEffect(() => {
    setHeadersText(formatHeaders(server.headers))
  }, [headersKey])

  function commitHeaders() {
    const r = parseHeaders(headersText)
    if (r.error) {
      setHeaderError(r.error)
      return
    }
    setHeaderError('')
    onChange({ ...server, headers: r.headers })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid hsl(var(--border))', borderRadius: 6 }}>
      <div className="field-row">
        <input
          className="p-input"
          value={server.name}
          onChange={(e) => onChange({ ...server, name: e.target.value })}
          placeholder="服务器名称"
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={server.enabled} onChange={(e) => onChange({ ...server, enabled: e.target.checked })} />
          启用
        </label>
      </div>
      <input
        className="p-input"
        value={server.url}
        onChange={(e) => onChange({ ...server, url: e.target.value })}
        placeholder="https://example.com/mcp"
      />
      <div>
        <label className="p-label">Headers（每行一个 Key: Value，可空）</label>
        <textarea
          className="p-input"
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          onBlur={commitHeaders}
          rows={2}
          placeholder={'Authorization: Bearer ...'}
          style={{ fontFamily: 'monospace', resize: 'vertical' }}
        />
        {headerError && <div style={{ fontSize: 11, color: 'hsl(var(--destructive))' }}>{headerError}</div>}
      </div>
      <div className="field-row" style={{ alignItems: 'center' }}>
        <button
          className="p-btn p-btn--outline"
          type="button"
          onClick={onTest}
          disabled={testState?.busy || !/^https?:\/\//i.test(server.url)}
        >
          {testState?.busy ? '测试中…' : '测试连接'}
        </button>
        <button className="p-btn p-btn--ghost" type="button" onClick={onRemove}>
          删除
        </button>
      </div>
      {testState?.text && (
        <div style={{ fontSize: 12, color: testState.color || 'hsl(var(--muted-foreground))', lineHeight: 1.6 }}>{testState.text}</div>
      )}
      <div className="field-hint">
        id: {server.id}
        {server.source === 'plugin' ? '（第三方注册）' : ''}
      </div>
    </div>
  )
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 8px',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
}
const metaStyle: CSSProperties = { marginLeft: 6, fontSize: 11, color: 'hsl(var(--muted-foreground))' }
const descStyle: CSSProperties = { fontSize: 12, color: 'hsl(var(--muted-foreground))', lineHeight: 1.5 }
const subStyle: CSSProperties = { fontSize: 11, color: 'hsl(var(--muted-foreground))' }
