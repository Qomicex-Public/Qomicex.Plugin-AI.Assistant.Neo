import { getApi } from '../api.ts'
import { isWindowsPlatform, permissionAllows, TOOL_REQUIRED_PERMISSION } from './permissions.ts'
import { getToolPermission } from './fileTools.ts'

/**
 * 后台长任务工具组（RunProcess / GetProcessLogs / StopProcess）。
 *
 * 为什么需要它：`execCommand`（Bash）是同步阻塞调用，启动器把超时硬限制在
 * 120 秒，且超时后 `taskkill /T /F` 并**丢弃全部 stdout/stderr**。跑测试、构建、
 * 安装依赖这类几分钟的任务既等不到结果，也看不到中间输出。
 *
 * 启动器的常驻进程 API（process:manage）正好补上这块：
 *   - spawn 立即返回 pid，进程在后台继续跑
 *   - logs(pid, afterSeq) 用游标增量拉取（环形缓冲 2000 行，退出后保留 10 分钟）
 *   - kill(pid) 终止整棵进程树
 *
 * 参数校验拒绝控制字符（\n/\r/NUL），所以脚本必须用 `-EncodedCommand`
 * （UTF-16LE + base64）传递，顺便解决引号、换行与中文路径被拆坏的问题。
 */

const LOG_TAIL_LIMIT = 12000

function api() {
  const a = getApi()
  if (!a) throw new Error('插件 API 桥接不可用')
  return a
}

/** 统一的权限门禁：返回错误对象或 null。 */
function gate(tool: string): { error: string } | null {
  const need = TOOL_REQUIRED_PERMISSION[tool]
  if (!need) return null
  const cur = getToolPermission()
  if (permissionAllows(cur, need)) return null
  const modeText = cur === 'readonly' ? '只读' : cur === 'write' ? '可写' : '完全访问'
  return {
    error:
      `当前文件权限为「${modeText}」，不允许使用 ${tool}。` +
      '请让用户在聊天顶部的权限下拉框切换为「可写」或「完全访问」后重试。',
  }
}

/** UTF-16LE → base64。PowerShell 的 -EncodedCommand 要求这种编码。 */
function b64utf16le(text: string): string {
  let bin = ''
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    bin += String.fromCharCode(c & 0xff, (c >> 8) & 0xff)
  }
  return btoa(bin)
}

function clampPid(v: unknown): number | null {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : null
}

function errText(e: unknown): string {
  const msg = String((e && (e as any).message) || e || '')
  return msg || '未知错误'
}

function pidOf(result: any): number | null {
  const n = Number(result && (result.pid ?? result.Pid))
  return Number.isFinite(n) && n > 0 ? n : null
}

// ============================ RunProcess ============================
export async function toolRunProcess(a: { command?: string; cwd?: string }): Promise<unknown> {
  const deny = gate('RunProcess')
  if (deny) return deny
  const command = String(a.command || '').trim()
  if (!command) return { error: 'command 必填' }
  if (command.length > 60000) return { error: 'command 过长（上限 60000 字符）' }

  const cwd = String(a.cwd || '').trim()
  const base = cwd ? { cwd } : {}

  if (!isWindowsPlatform()) {
    // 非 Windows 没有 PowerShell：直接用 sh -c，参数里允许换行（Unix 侧不校验控制字符）
    try {
      const r: any = await api().call('process.spawn', { command: 'sh', args: ['-c', command], ...base })
      const pid = pidOf(r)
      if (!pid) return { error: '进程已启动但未返回 pid' }
      return {
        pid,
        startedAtMs: r && r.startedAtMs,
        __ui_summary: `后台启动 pid ${pid}`,
        __raw_text:
          `已在后台启动（pid=${pid}）。` +
          '用 GetProcessLogs(pid, afterSeq=0) 查看输出，用 StopProcess(pid) 停止。',
      }
    } catch (e) {
      return { error: '后台启动失败：' + errText(e) }
    }
  }

  // 优先 pwsh 7；失败再退回 Windows PowerShell 5.1（并强制 UTF-8 输出，避免中文乱码）
  try {
    const r: any = await api().call('process.spawn', {
      command: 'pwsh',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64utf16le(command)],
      ...base,
    })
    const pid = pidOf(r)
    if (!pid) return { error: '进程已启动但未返回 pid' }
    return {
      pid,
      startedAtMs: r && r.startedAtMs,
      __ui_summary: `后台启动 pid ${pid}`,
      __raw_text:
        `已在后台启动（pid=${pid}，pwsh）。` +
        '命令会继续运行；立即告知用户，然后用 GetProcessLogs(pid, afterSeq=0) 轮询输出，' +
        '需要中断时用 StopProcess(pid)。',
    }
  } catch (e) {
    const msg = errText(e)
    // 配额/权限类错误换 shell 也没用，直接如实返回
    if (/上限|最多|Permission denied|权限|PROCESS_COMMAND|控制字符/.test(msg)) {
      return { error: '后台启动失败：' + msg }
    }
    try {
      const script = '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + command
      const r: any = await api().call('process.spawn', {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64utf16le(script)],
        ...base,
      })
      const pid = pidOf(r)
      if (!pid) return { error: '进程已启动但未返回 pid' }
      return {
        pid,
        startedAtMs: r && r.startedAtMs,
        __ui_summary: `后台启动 pid ${pid}`,
        __raw_text:
          `已在后台启动（pid=${pid}，Windows PowerShell）。` +
          '用 GetProcessLogs(pid, afterSeq=0) 查看输出，用 StopProcess(pid) 停止。',
      }
    } catch (e2) {
      return { error: '后台启动失败（pwsh 与 powershell.exe 均不可用）：' + errText(e2) }
    }
  }
}

// ============================ GetProcessLogs ============================
export async function toolGetProcessLogs(a: { pid?: number; afterSeq?: number }): Promise<unknown> {
  const deny = gate('GetProcessLogs')
  if (deny) return deny
  const pid = clampPid(a.pid)
  if (!pid) return { error: 'pid 必填且必须是正整数（来自 RunProcess）' }
  const afterSeq = Number.isFinite(Number(a.afterSeq)) && Number(a.afterSeq) > 0 ? Math.floor(Number(a.afterSeq)) : 0

  try {
    const r: any = await api().call('process.logs', pid, afterSeq)
    const lines: any[] = Array.isArray(r && r.lines) ? r.lines : []
    const alive = r ? r.alive === true : false
    const exitCode = r && r.exitCode !== undefined ? r.exitCode : null
    const nextSeq = r && Number.isFinite(Number(r.nextSeq)) ? Number(r.nextSeq) : afterSeq
    const oldestSeq = r && Number.isFinite(Number(r.oldestSeq)) ? Number(r.oldestSeq) : 0

    let output = lines
      .map((l) => (l && l.stream === 'err' ? '[err] ' : '') + String((l && l.text) || ''))
      .join('\n')
    let truncated = false
    if (output.length > LOG_TAIL_LIMIT) {
      output = output.slice(-LOG_TAIL_LIMIT)
      truncated = true
    }
    if (!output) output = lines.length ? '（本次没有可读文本）' : '(暂无新输出)'

    const head =
      `pid=${pid} alive=${alive ? 'true' : 'false'} exitCode=${exitCode === null || exitCode === undefined ? 'null' : exitCode}` +
      ` nextSeq=${nextSeq} oldestSeq=${oldestSeq}`
    const dropped =
      afterSeq > 0 && oldestSeq > afterSeq + 1
        ? `\n（注意：日志环形缓冲已丢弃 afterSeq=${afterSeq} 之前的部分内容，oldestSeq=${oldestSeq}）`
        : ''
    const tail = truncated ? `\n（输出超过 ${LOG_TAIL_LIMIT} 字符，仅保留末尾；可传更小的 afterSeq 重新分段读取）` : ''
    const statusText = alive
      ? '进程仍在运行；稍后可用更大的 afterSeq 继续轮询。'
      : `进程已退出（exitCode=${exitCode === null || exitCode === undefined ? 'unknown' : exitCode}）。`

    return {
      pid,
      alive,
      exitCode,
      nextSeq,
      oldestSeq,
      truncated,
      __ui_summary: alive ? `pid ${pid} 运行中，新增 ${lines.length} 行` : `pid ${pid} 已退出（${exitCode ?? '?'}）`,
      __raw_text: `${head}\n${statusText}${dropped}\n--- output ---\n${output}${tail}`,
    }
  } catch (e) {
    return { error: '读取进程日志失败：' + errText(e) }
  }
}

// ============================ StopProcess ============================
export async function toolStopProcess(a: { pid?: number }): Promise<unknown> {
  const deny = gate('StopProcess')
  if (deny) return deny
  const pid = clampPid(a.pid)
  if (!pid) return { error: 'pid 必填且必须是正整数（来自 RunProcess）' }
  try {
    const r: any = await api().call('process.kill', pid)
    return {
      ok: true,
      pid,
      message: (r && r.message) || `进程 ${pid} 已终止`,
      __ui_summary: `已停止 pid ${pid}`,
      __raw_text: `已终止进程树 pid=${pid}。${(r && r.message) || ''}`,
    }
  } catch (e) {
    return { error: '停止进程失败：' + errText(e) }
  }
}
