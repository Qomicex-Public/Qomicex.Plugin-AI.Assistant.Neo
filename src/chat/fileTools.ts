import { getApi } from '../api.ts'
import type { FilePermission } from './permissions.ts'
import { permissionAllows, TOOL_REQUIRED_PERMISSION, resolveWorkspace } from './permissions.ts'

/**
 * 文件 / 命令类工具实现（对标 opencode 的 Read/Write/Edit/Grep/Bash + 压缩解压）。
 *
 * 平台约束（来自启动器能力，已核实）：
 *   - 文件读写走 readText/readBytes/writeText/deleteFile，**授权制**：
 *     首次访问未授权路径 → 403 FS_AUTHORIZATION_REQUIRED，启动器自动弹窗，
 *     用户同意后按路径前缀持久化，同插件同路径不再询问。
 *   - execCommand 的 shell 由启动器固定（Windows: powershell -NoProfile -Command；
 *     Unix: /bin/sh -c），**不可选择 pwsh**，且不设 cwd —— 因此所有命令都要
 *     自己 cd 到目标目录，或用绝对路径。
 *   - execCommand 超时上限 120s，无法跑长时间驻留进程。
 *   - 插件没有 listDirectory API，列目录/搜索只能靠 shell（Grep 实现即基于此）。
 */

interface ToolCtx {
  permission: FilePermission
}

let ctx: ToolCtx = { permission: 'readonly' }

export function setToolPermission(p: FilePermission) {
  ctx = { permission: p }
}

export function getToolPermission(): FilePermission {
  return ctx.permission
}

/** 统一的权限门禁：返回错误对象或 null。 */
function gate(tool: string): { error: string } | null {
  const need = TOOL_REQUIRED_PERMISSION[tool]
  if (!need) return null
  if (permissionAllows(ctx.permission, need)) return null
  const modeText = ctx.permission === 'readonly' ? '只读' : ctx.permission === 'write' ? '可写' : '完全访问'
  return {
    error:
      `当前文件权限为「${modeText}」，不允许使用 ${tool}。` +
      '请让用户在聊天顶部的权限下拉框切换为「可写」或「完全访问」后重试。',
  }
}

function isWindows(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /Windows|Win32|Win64/i.test(nav)
}

function api() {
  const a = getApi()
  if (!a) throw new Error('插件 API 桥接不可用')
  return a
}

function normError(e: any, what: string): { error: string } {
  const msg = String((e && e.message) || e || '')
  if (msg.includes('FS_AUTHORIZATION_REQUIRED')) {
    return { error: `${what}需要授权：启动器已弹出授权窗口，请用户允许后重试同一路径。` }
  }
  if (msg.includes('FS_FILE_NOT_FOUND')) return { error: `${what}失败：文件不存在。` }
  return { error: `${what}失败：${msg}` }
}

/** 统计行号，供 Read 输出使用（与 opencode 一致的 `行号|内容` 形态）。 */
function withLineNumbers(text: string, startLine: number): string {
  const lines = text.split('\n')
  const width = String(startLine + lines.length - 1).length
  return lines.map((l, i) => String(startLine + i).padStart(width, ' ') + '| ' + l).join('\n')
}

const DEFAULT_READ_LIMIT = 2000

// ============================ Read ============================
export async function toolRead(a: {
  path?: string
  offset?: number
  limit?: number
}): Promise<unknown> {
  const deny = gate('Read')
  if (deny) return deny
  const path = String(a.path || '').trim()
  if (!path) return { error: 'path 必填' }

  const offset = Number.isFinite(a.offset as number) && (a.offset as number) > 0 ? Math.floor(a.offset as number) : 1
  const limit = Number.isFinite(a.limit as number) && (a.limit as number) > 0 ? Math.floor(a.limit as number) : DEFAULT_READ_LIMIT

  // 二进制/文档类文件走 MarkItDown（若可用），否则提示用户改用 Decompress 或外部工具
  const ext = (path.split('.').pop() || '').toLowerCase()
  const docExts = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'mp4'])

  try {
    if (docExts.has(ext)) {
      // 复用已有的 markitdown 能力（可能因宿主缺陷不可用，需要明确告知）
      try {
        const bytes: any = await api().call('readBytes', path)
        if (!bytes || !bytes.contentBase64) throw new Error('读取为空')
        const r: any = await api().call('callPlugin', 'top.qomicex.markitdown', 'convertFile', {
          base64: bytes.contentBase64,
          fileName: path.split(/[\\/]/).pop() || 'file',
        })
        if (r && r.error) throw new Error(r.error)
        return { path, format: r?.format, markdown: r?.markdown ?? '' }
      } catch (e: any) {
        const msg = String((e && e.message) || e)
        if (/未提供方法|not initialized|未安装|未激活/.test(msg)) {
          return {
            error:
              `该文件是二进制/文档类型（.${ext}），需要 MarkItDown 转换，但当前不可用（${msg}）。` +
              '可改用 Decompress（若是压缩包）或让用户提供文本内容。',
          }
        }
        return normError(e, '读取文档')
      }
    }

    const file: any = await api().call('readText', path)
    const content = String(file?.content ?? '')
    const allLines = content.split('\n')
    const total = allLines.length
    const slice = allLines.slice(offset - 1, offset - 1 + limit)
    const truncated = offset - 1 + slice.length < total
    return {
      path,
      totalLines: total,
      offset,
      limit,
      truncated,
      content: withLineNumbers(slice.join('\n'), offset),
      ...(truncated ? { hint: `内容被截断，可用 offset=${offset + slice.length} 继续读取` } : {}),
    }
  } catch (e) {
    return normError(e, '读取文件')
  }
}

// ============================ Write ============================
export async function toolWrite(a: { path?: string; content?: string }): Promise<unknown> {
  const deny = gate('Write')
  if (deny) return deny
  const path = String(a.path || '').trim()
  if (!path) return { error: 'path 必填' }
  const content = a.content === undefined || a.content === null ? '' : String(a.content)
  try {
    await api().call('writeText', path, content)
    return { path, bytes: content.length, ok: true }
  } catch (e) {
    return normError(e, '写入文件')
  }
}

// ============================ Edit ============================
/**
 * 精确字符串替换（对标 opencode 的 edit）：
 *   - oldString 不存在 → 报错并说明原因（不做模糊匹配，避免误改）
 *   - oldString 出现多次且未设 replaceAll → 报错要求提供更多上下文
 */
export async function toolEdit(a: {
  path?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
}): Promise<unknown> {
  const deny = gate('Edit')
  if (deny) return deny
  const path = String(a.path || '').trim()
  if (!path) return { error: 'path 必填' }
  const oldString = a.oldString === undefined || a.oldString === null ? '' : String(a.oldString)
  const newString = a.newString === undefined || a.newString === null ? '' : String(a.newString)
  if (!oldString) return { error: 'oldString 必填（且不能为空字符串）' }
  if (oldString === newString) return { error: 'oldString 与 newString 相同，无需修改' }

  try {
    const file: any = await api().call('readText', path)
    const content = String(file?.content ?? '')

    let count = 0
    let idx = 0
    for (;;) {
      const p = content.indexOf(oldString, idx)
      if (p < 0) break
      count++
      idx = p + oldString.length
      if (count > 1 && !a.replaceAll) break
    }

    if (count === 0) {
      return {
        error:
          'oldString 在文件中未找到。请先用 Read 确认原文（注意缩进、空行与中文标点必须完全一致）。',
      }
    }
    if (count > 1 && !a.replaceAll) {
      return {
        error: `oldString 在文件中出现 ${count} 处，存在歧义。请提供更多上下文使匹配唯一，或设置 replaceAll=true。`,
      }
    }

    const next = a.replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    await api().call('writeText', path, next)
    return { path, replaced: a.replaceAll ? count : 1, ok: true }
  } catch (e) {
    return normError(e, '编辑文件')
  }
}

// ============================ Bash ============================
/**
 * 执行命令。注意启动器固定 shell，无法选 pwsh：
 *   Windows: powershell -NoProfile -Command <command>
 *   Unix:    /bin/sh -c <command>
 * 且不设 cwd，所以命令里要自行 cd 或使用绝对路径。
 */
export async function toolBash(a: {
  command?: string
  workdir?: string
  timeoutMs?: number
}): Promise<unknown> {
  const deny = gate('Bash')
  if (deny) return deny
  let command = String(a.command || '').trim()
  if (!command) return { error: 'command 必填' }

  const win = isWindows()
  const workdir = String(a.workdir || '').trim()
  // execCommand 不设 cwd，需要显式切换目录
  if (workdir) {
    command = win
      ? `Set-Location -LiteralPath '${workdir.replace(/'/g, "''")}'; ${command}`
      : `cd '${workdir.replace(/'/g, `'\\''`)}' && ${command}`
  }

  const timeout = Math.min(Math.max(Number(a.timeoutMs) || 120000, 1000), 120000)
  try {
    const r: any = await api().call('execCommand', command, timeout)
    const out = {
      exitCode: r?.exitCode ?? -1,
      stdout: String(r?.stdout ?? ''),
      stderr: String(r?.stderr ?? ''),
      shell: win ? 'powershell' : '/bin/sh',
    }
    return out
  } catch (e: any) {
    const msg = String((e && e.message) || e)
    if (msg.includes('SHELL_TIMEOUT')) return { error: `命令超时（上限 120s）：${command.slice(0, 120)}` }
    return { error: `命令执行失败：${msg}` }
  }
}

// ============================ Grep ============================
/**
 * 基于 shell 的搜索（插件没有 listDirectory / 文件遍历 API）。
 * 优先 ripgrep（若 PATH 里有 rg），否则用平台原生工具。
 */
export async function toolGrep(a: {
  pattern?: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  maxResults?: number
}): Promise<unknown> {
  const deny = gate('Grep')
  if (deny) return deny
  const pattern = String(a.pattern || '')
  if (!pattern) return { error: 'pattern 必填' }
  const searchPath = String(a.path || '.').trim() || '.'
  const max = Math.min(Math.max(Number(a.maxResults) || 200, 1), 1000)
  const win = isWindows()
  const glob = String(a.glob || '').trim()
  const ci = a.caseInsensitive !== false

  // 转义单引号，避免注入；pattern 走 PowerShell/shell 单引号字面量
  const q = (s: string) => (win ? s.replace(/'/g, "''") : s.replace(/'/g, `'\\''`))

  let command: string
  if (win) {
    const rgPattern = ci ? `-i` : ''
    const rgGlob = glob ? `-g '${q(glob)}'` : ''
    // 优先 rg；没有 rg 则用 Select-String
    command =
      `$rg = Get-Command rg -ErrorAction SilentlyContinue; ` +
      `if ($rg) { & rg --line-number --no-heading ${rgPattern} ${rgGlob} -- '${q(pattern)}' '${q(searchPath)}' 2>$null | Select-Object -First ${max} } ` +
      `else { Get-ChildItem -LiteralPath '${q(searchPath)}' -Recurse -File -ErrorAction SilentlyContinue ` +
      `${glob ? `-Filter '${q(glob)}' ` : ''}` +
      `| Select-String -Pattern '${q(pattern)}' ${ci ? '' : '-CaseSensitive'} -ErrorAction SilentlyContinue ` +
      `| Select-Object -First ${max} ` +
      `| ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line.Trim())" } }`
  } else {
    const rgPattern = ci ? '-i' : ''
    const rgGlob = glob ? `-g '${q(glob)}'` : ''
    command =
      `if command -v rg >/dev/null 2>&1; then ` +
      `rg --line-number --no-heading ${rgPattern} ${rgGlob} -- '${q(pattern)}' '${q(searchPath)}' 2>/dev/null | head -n ${max}; ` +
      `else grep -rn ${ci ? '-i' : ''} -- '${q(pattern)}' '${q(searchPath)}' 2>/dev/null | head -n ${max}; fi`
  }

  try {
    const r: any = await api().call('execCommand', command, 60000)
    const stdout = String(r?.stdout ?? '')
    const lines = stdout.split('\n').map((s) => s.trimEnd()).filter(Boolean)
    return {
      pattern,
      path: searchPath,
      glob: glob || null,
      count: lines.length,
      truncated: lines.length >= max,
      matches: lines,
      ...(lines.length === 0 ? { hint: '未找到匹配。可检查 path 是否正确、pattern 是否需要转义。' } : {}),
    }
  } catch (e: any) {
    const msg = String((e && e.message) || e)
    if (msg.includes('SHELL_TIMEOUT')) return { error: '搜索超时：请缩小 path 范围或加 glob 过滤' }
    return { error: `搜索失败：${msg}` }
  }
}

// ============================ Compress / Decompress ============================
/** 默认输出目录：临时工作区下按名字建子目录，避免污染用户目录。 */
async function defaultOutDir(baseName: string): Promise<string> {
  const w = await resolveWorkspace()
  const sep = isWindows() ? '\\' : '/'
  const safe = String(baseName || 'out').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'out'
  return `${w.temp}${sep}${safe}-${Date.now().toString(36)}`
}

function baseNameNoExt(p: string): string {
  const name = p.split(/[\\/]/).pop() || 'out'
  return name.replace(/\.[^.]+$/, '')
}

/**
 * Decompress：解压归档。
 * 支持 .zip / .tar / .tar.gz / .tgz / .7z / .rar（后两者依赖 7z，存在才用）。
 */
export async function toolDecompress(a: {
  path?: string
  outDir?: string
}): Promise<unknown> {
  const deny = gate('Decompress')
  if (deny) return deny
  const src = String(a.path || '').trim()
  if (!src) return { error: 'path 必填' }
  const outDir = String(a.outDir || '').trim() || (await defaultOutDir(baseNameNoExt(src)))
  const win = isWindows()
  const q = (s: string) => (win ? s.replace(/'/g, "''") : s.replace(/'/g, `'\\''`))

  const lower = src.toLowerCase()
  let command: string
  if (win) {
    const mk = `New-Item -ItemType Directory -Force -Path '${q(outDir)}' | Out-Null; `
    if (lower.endsWith('.7z') || lower.endsWith('.rar')) {
      command =
        mk +
        `$sz = Get-Command 7z -ErrorAction SilentlyContinue; ` +
        `if (-not $sz) { throw '未找到 7z，无法解压该格式（可改用 zip/tar）' }; ` +
        `& 7z x -y -o'${q(outDir)}' '${q(src)}' | Out-Null`
    } else if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      command = mk + `tar -xf '${q(src)}' -C '${q(outDir)}'`
    } else {
      // .zip 统一走 Windows 自带 bsdtar：
      // 实测 powershell 5.1 上 Expand-Archive 会「静默失败」（无异常、无 stderr、exitCode=1，
      // 且 Get-Command Expand-Archive 为空说明模块没加载），而 tar 对 zip 同样支持且可靠。
      command =
        mk +
        `tar -xf '${q(src)}' -C '${q(outDir)}'; ` +
        `if ($LASTEXITCODE -ne 0) { Write-Error 'unzip failed'; exit $LASTEXITCODE }`
    }
  } else {
    const mk = `mkdir -p '${q(outDir)}'; `
    if (lower.endsWith('.zip')) command = mk + `unzip -o '${q(src)}' -d '${q(outDir)}'`
    else if (lower.endsWith('.7z') || lower.endsWith('.rar')) command = mk + `7z x -y -o'${q(outDir)}' '${q(src)}'`
    else command = mk + `tar -xf '${q(src)}' -C '${q(outDir)}'`
  }

  try {
    const r: any = await api().call('execCommand', command, 120000)
    const code = r?.exitCode ?? -1
    if (code !== 0) {
      return { error: `解压失败（exit ${code}）`, stderr: String(r?.stderr ?? '').slice(0, 800) }
    }
    // 列出解压结果顶层条目，便于 AI 继续操作
    const listCmd = win
      ? `Get-ChildItem -LiteralPath '${q(outDir)}' -Force -ErrorAction SilentlyContinue | Select-Object -First 50 | ForEach-Object { $_.Name }`
      : `ls -1A '${q(outDir)}' 2>/dev/null | head -n 50`
    const ls: any = await api().call('execCommand', listCmd, 30000)
    const entries = String(ls?.stdout ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)

    // 关键：exitCode=0 但目录为空，说明解压实际没成功（如 Expand-Archive 静默失败）。
    // 不能把这种「成功但没东西」当成正常结果返回给模型。
    if (entries.length === 0) {
      return {
        error:
          `解压命令返回成功，但目标目录为空：${outDir}。` +
          '可能是归档损坏、格式不受支持，或解压工具静默失败。' +
          (win ? '（Windows 上已改用内置 tar 解压 zip）' : ''),
        path: src,
        outDir,
        stderr: String(r?.stderr ?? '').slice(0, 400),
      }
    }

    return {
      ok: true,
      path: src,
      outDir,
      entries,
      hint: '解压完成，请用 Read/Grep 在 outDir 内继续处理',
    }
  } catch (e: any) {
    return normError(e, '解压')
  }
}

/**
 * Compress：打包为 zip（默认）或 tar.gz。
 * 输出默认落在临时工作区。
 */
export async function toolCompress(a: {
  path?: string
  sources?: string[]
  out?: string
  format?: string
}): Promise<unknown> {
  const deny = gate('Compress')
  if (deny) return deny
  const sources = Array.isArray(a.sources) && a.sources.length ? a.sources.map(String) : a.path ? [String(a.path)] : []
  if (sources.length === 0) return { error: 'sources 必填（要压缩的文件/目录绝对路径数组）' }
  const format = String(a.format || '').toLowerCase() === 'tar.gz' ? 'tar.gz' : 'zip'
  const win = isWindows()
  const q = (s: string) => (win ? s.replace(/'/g, "''") : s.replace(/'/g, `'\\''`))

  const out =
    String(a.out || '').trim() ||
    `${await defaultOutDir('archive')}.${format === 'zip' ? 'zip' : 'tar.gz'}`

  let command: string
  if (win) {
    if (format === 'zip') {
      // Compress-Archive 需要父目录存在
      const parent = out.replace(/\\[^\\]+$/, '')
      command =
        `New-Item -ItemType Directory -Force -Path '${q(parent)}' | Out-Null; ` +
        `Compress-Archive -Path ${sources.map((s) => `'${q(s)}'`).join(',')} -DestinationPath '${q(out)}' -Force`
    } else {
      const parent = out.replace(/\\[^\\]+$/, '')
      command =
        `New-Item -ItemType Directory -Force -Path '${q(parent)}' | Out-Null; ` +
        `tar -czf '${q(out)}' ${sources.map((s) => `'${q(s)}'`).join(' ')}`
    }
  } else {
    const parent = out.replace(/\/[^/]+$/, '')
    if (format === 'zip') {
      command = `mkdir -p '${q(parent)}'; cd '${q(parent)}' && zip -r -q '${q(out)}' ${sources.map((s) => `'${q(s)}'`).join(' ')}`
    } else {
      command = `mkdir -p '${q(parent)}'; tar -czf '${q(out)}' ${sources.map((s) => `'${q(s)}'`).join(' ')}`
    }
  }

  try {
    const r: any = await api().call('execCommand', command, 120000)
    const code = r?.exitCode ?? -1
    if (code !== 0) {
      return { error: `压缩失败（exit ${code}）`, stderr: String(r?.stderr ?? '').slice(0, 800) }
    }
    return { ok: true, out, format, sources }
  } catch (e: any) {
    return normError(e, '压缩')
  }
}
