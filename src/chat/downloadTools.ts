import { getApi } from '../api.ts'
import { permissionAllows, TOOL_REQUIRED_PERMISSION } from './permissions.ts'
import { getToolPermission } from './fileTools.ts'

/**
 * 通用文件下载工具（DownloadFile）。
 *
 * 现有 `startDownload` 只覆盖「实例 + category」场景；汉化包/资源包往往需要：
 *   - 先下到临时工作区检查压缩包内容，再决定装不装；
 *   - 下载到 `resourcepacks` / `shaderpacks` 等实例目录；
 *   - 带 Authorization / Referer / Cookie 等请求头；
 *   - 下载 .zip 后直接解压。
 *
 * 启动器的 `download.addTask` 原生支持 targetPath / headers / extract，
 * 底层与安装管线共用 DownloadManager，进度用 `download.progress(taskId)` 轮询。
 */

const NAME_MAX = 200
const HEADER_MAX = 20
const HEADER_VALUE_MAX = 2048

function api() {
  const a = getApi()
  if (!a) throw new Error('插件 API 桥接不可用')
  return a
}

function gate(): { error: string } | null {
  const need = TOOL_REQUIRED_PERMISSION['DownloadFile']
  if (!need) return null
  const cur = getToolPermission()
  if (permissionAllows(cur, need)) return null
  const modeText = cur === 'readonly' ? '只读' : cur === 'write' ? '可写' : '完全访问'
  return {
    error:
      `当前文件权限为「${modeText}」，不允许下载文件。` +
      '请让用户在聊天顶部的权限下拉框切换为「可写」或「完全访问」后重试。',
  }
}

function hasControlChars(s: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(s)
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => seg === '..')
}

function validFileName(v: unknown): string | null {
  const name = String(v ?? '').trim()
  if (!name) return null
  if (name.length > NAME_MAX) return null
  if (/[\\/]/.test(name) || name === '.' || name === '..' || hasControlChars(name)) return null
  return name
}

function validCategory(v: unknown): string | null {
  const c = String(v ?? '').trim()
  if (!c) return null
  if (c.length > 64 || !/^[A-Za-z0-9._-]+$/.test(c) || c === '.' || c === '..') return null
  return c
}

function sanitizeHeaders(input: unknown): { ok: true; headers?: Record<string, string> } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'headers 必须是对象' }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > HEADER_MAX) return { ok: false, error: `headers 最多 ${HEADER_MAX} 项` }
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    const key = String(k || '').trim()
    if (!key || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) return { ok: false, error: `header 名称非法：${key}` }
    if (/^host$/i.test(key) || /^content-length$/i.test(key)) return { ok: false, error: `不允许设置 ${key}（由下载器决定）` }
    const value = String(v ?? '')
    if (value.length > HEADER_VALUE_MAX) return { ok: false, error: `header ${key} 的值超过 ${HEADER_VALUE_MAX} 字符` }
    if (hasControlChars(value)) return { ok: false, error: `header ${key} 的值包含控制字符` }
    out[key] = value
  }
  return { ok: true, headers: Object.keys(out).length ? out : undefined }
}

export async function toolDownloadFile(a: {
  url?: string
  targetPath?: string
  instanceId?: string
  category?: string
  fileName?: string
  headers?: Record<string, string>
  extract?: boolean
}): Promise<unknown> {
  const deny = gate()
  if (deny) return deny

  const url = String(a.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { error: 'url 必须是 http(s) 地址' }
  if (url.length > 4096) return { error: 'url 过长' }

  const targetPathRaw = String(a.targetPath || '').trim()
  const instanceId = String(a.instanceId || '').trim()
  if (!targetPathRaw && !instanceId) {
    return { error: '必须提供 targetPath（绝对文件路径），或 instanceId + category（实例目录）' }
  }

  let targetPath = ''
  if (targetPathRaw) {
    if (!isAbsolutePath(targetPathRaw)) return { error: 'targetPath 必须是绝对路径' }
    if (hasControlChars(targetPathRaw)) return { error: 'targetPath 包含控制字符' }
    if (hasParentSegment(targetPathRaw)) return { error: 'targetPath 不能包含 .. 路径段' }
    if (/[\\/]$/.test(targetPathRaw)) return { error: 'targetPath 必须包含文件名，不能以路径分隔符结尾' }
    targetPath = targetPathRaw
  }

  let category = ''
  if (instanceId) {
    category = validCategory(a.category || 'mods') || ''
    if (!category) return { error: 'category 非法（只允许字母/数字/._-，例如 resourcepacks、mods、shaderpacks）' }
  }

  let fileName: string | undefined
  if (a.fileName !== undefined && a.fileName !== null && String(a.fileName).trim()) {
    const parsed = validFileName(a.fileName)
    if (!parsed) return { error: 'fileName 非法（不能包含路径分隔符、.. 或控制字符）' }
    fileName = parsed
  }
  if (targetPath && fileName) {
    const base = targetPath.split(/[\\/]/).pop() || ''
    if (base.toLowerCase() !== fileName.toLowerCase()) {
      return { error: `fileName 与 targetPath 的文件名不一致：targetPath 是「${base}」，fileName 是「${fileName}」` }
    }
  }

  const h = sanitizeHeaders(a.headers)
  if (!h.ok) return { error: h.error }

  const extract = a.extract === true
  const payload: Record<string, unknown> = { url }
  if (targetPath) payload.targetPath = targetPath
  if (instanceId) {
    payload.instanceId = instanceId
    payload.category = category
  }
  if (fileName) payload.fileName = fileName
  if (h.headers) payload.headers = h.headers
  if (extract) payload.extract = true

  try {
    const r: any = await api().call('download.addTask', payload)
    const taskId = String(r?.taskId || '')
    const resolvedTarget = String(r?.targetPath || targetPath || '')
    const status = String(r?.status || 'queued')
    const where = resolvedTarget || (instanceId ? `实例 ${instanceId} / ${category}` : '未知目标')
    return {
      ok: true,
      taskId,
      status,
      targetPath: resolvedTarget,
      __ui_summary: `下载任务 ${taskId || '已创建'}（${status}）`,
      __raw_text:
        `已创建下载任务${taskId ? `（taskId=${taskId}）` : ''}，当前状态 ${status}。\n` +
        `目标：${where}\n` +
        '用 getDownloadProgress(taskId) 轮询；首次建议先 sleep 3000~5000 毫秒再查，之后按 15 秒间隔查询。\n' +
        (extract ? '下载完成后会自动解压 .zip 到目标目录并删除原 zip。' : '下载完成后文件保留在目标路径。'),
    }
  } catch (e: any) {
    return { error: '下载失败：' + String((e && e.message) || e || '未知错误') }
  }
}
