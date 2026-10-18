import { getApi } from '../api.ts'

/**
 * 文件操作权限模型。
 *
 * - readonly  只允许 Read / Grep
 * - write     5 个文件/命令工具都能用；新目录首次访问由启动器自带授权弹窗把关
 * - full      完全放开，不再拦截
 *
 * 注意：这里的判断是插件侧的额外门禁，启动器的文件 API 本身另有授权制
 * （FS_AUTHORIZATION_REQUIRED，按路径前缀持久化）。两层叠加：
 * 插件层决定「这个模式下允不允许调用」，启动器层决定「这个路径用户授过权没有」。
 */
export type FilePermission = 'readonly' | 'write' | 'full'

export const FILE_PERMISSION_LABEL: Record<FilePermission, string> = {
  readonly: '只读',
  write: '可写',
  full: '完全访问',
}

/** 每个文件/命令工具所需的最低权限。 */
export const TOOL_REQUIRED_PERMISSION: Record<string, FilePermission> = {
  Read: 'readonly',
  Grep: 'readonly',
  Write: 'write',
  Edit: 'write',
  Bash: 'write',
  Compress: 'write',
  Decompress: 'write',
}

const RANK: Record<FilePermission, number> = { readonly: 0, write: 1, full: 2 }

export function permissionAllows(current: FilePermission, required: FilePermission): boolean {
  return RANK[current] >= RANK[required]
}

// ---------- 工作区 ----------

const WORKSPACE_KEY = 'assistant:workspace'

export interface WorkspacePaths {
  /** 系统临时目录下的专用工作区：解压、临时脚本、一次性产物 */
  temp: string
  /** 插件数据目录下的长期工作区：需要跨会话保留的文件 */
  data: string
}

function isWindows(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /Windows|Win32|Win64/i.test(nav)
}

/** 去掉路径尾部分隔符。 */
function trimSep(p: string): string {
  return String(p || '').replace(/[\\/]+$/, '')
}

/**
 * 读取启动器真实数据目录（GET /settings/data-dir）。
 * 这是唯一可靠的来源——不要靠猜，否则写进提示词的路径是错的。
 */
export async function fetchLauncherDataDir(): Promise<string | null> {
  const api = getApi()
  if (!api || !api.call) return null
  try {
    const r: any = await api.call('callBackend', '/settings/data-dir')
    // 后端可能返回 {dataDir} / {data_dir} / {path} 或纯字符串
    if (typeof r === 'string') return trimSep(r)
    const v = r && (r.dataDir ?? r.data_dir ?? r.path ?? r.dir)
    return typeof v === 'string' && v ? trimSep(v) : null
  } catch {
    return null
  }
}

/**
 * 读取用户真实临时目录。
 *
 * 插件跑在沙箱里读不到环境变量，且 `GetTempPath()` 要 shell（每次推导工作区都开一个
 * powershell 太慢）。这里用一次 shell 探测并缓存；失败再退回平台标准值。
 */
async function fetchUserTempDir(): Promise<string | null> {
  const api = getApi()
  if (!api || !api.call) return null
  const win = isWindows()
  try {
    const cmd = win
      ? '[System.IO.Path]::GetTempPath().TrimEnd(\'\\\')'
      : 'printf %s "${TMPDIR:-/tmp}"'
    const r: any = await api.call('execCommand', cmd, 15000)
    if ((r?.exitCode ?? 1) !== 0) return null
    const out = String(r?.stdout ?? '').trim()
    return out && /^([A-Za-z]:[\\/]|\/)/.test(out) ? trimSep(out) : null
  } catch {
    return null
  }
}

/**
 * 解析工作区路径并缓存。
 *
 * - temp（用户临时目录下）：解压/临时脚本，避免污染用户目录
 * - data（启动器数据目录/plugins/<本插件>/workspace）：需要长期保留的产物
 *
 * 取不到真实值时会标记 degraded，并在提示词里如实告知，不编造路径。
 */
export async function resolveWorkspace(): Promise<WorkspacePaths & { degraded: boolean }> {
  const api = getApi()
  if (api) {
    try {
      const cached: any = await api.call('getCache', WORKSPACE_KEY)
      if (cached && typeof cached === 'object' && cached.temp && cached.data) {
        return { temp: String(cached.temp), data: String(cached.data), degraded: !!cached.degraded }
      }
    } catch {
      /* ignore */
    }
  }

  const win = isWindows()
  const sepChar = win ? '\\' : '/'
  const dataDir = await fetchLauncherDataDir()
  const userTemp = await fetchUserTempDir()

  // 优先用用户真实临时目录；探测失败才退回平台标准值（并标记降级）
  const tempBase = userTemp || (win ? 'C:\\Users\\Public\\AppData\\Local\\Temp' : '/tmp')
  const temp = `${tempBase}${sepChar}qomicex-assistant`

  const data = dataDir
    ? `${dataDir}${sepChar}plugins${sepChar}top.qomicex.assistant${sepChar}workspace`
    : `${temp}${sepChar}plugin-data${sepChar}workspace`

  const result = { temp, data, degraded: !dataDir || !userTemp }
  if (api) {
    try {
      await api.call('setCache', WORKSPACE_KEY, result)
    } catch {
      /* ignore */
    }
  }
  return result
}

/** 供 systemPrompt 使用：把真实工作区路径写进提示词。 */
export async function workspacePromptSection(): Promise<string> {
  const w = await resolveWorkspace()
  const lines = [
    '',
    '## 工作区（必须遵守）',
    '你有两个固定工作目录。**所有产出都放这里**，不要往用户主目录、桌面、项目根目录或系统目录里乱写：',
    `- 临时工作区：${w.temp}`,
    '  解压、临时脚本、一次性中间产物、下载的临时文件。可随意创建/覆盖/删除。',
    `- 长期工作区：${w.data}`,
    '  需要跨会话保留的文件（用户明确要求保存的结果、整理好的成品）。',
    '',
    '规则：',
    `1. 解压/压缩默认输出到临时工作区下的子目录，例如 ${w.temp}${isWindows() ? '\\' : '/'}unzip-<名字>。`,
    '2. 写脚本（.ps1/.sh/.py）放临时工作区，用完可留可删，不要留在项目目录。',
    '3. 读写用户指定路径时直接用绝对路径；但不要把临时产物顺手写进用户目录。',
    '4. 汇报结果时给出实际使用的绝对路径。',
  ]
  if (w.degraded) {
    lines.push('5. 注意：未能取得启动器数据目录，长期工作区已降级为临时目录下的 plugin-data；若用户要求长期保存，请提示其确认路径。')
  }
  return lines.join('\n')
}
