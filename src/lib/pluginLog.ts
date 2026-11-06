import { getApi } from '../api.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志里的对象要能一眼看懂，且不能把 base64 截图之类的巨物写进磁盘。 */
function stringifyDetail(extra: unknown): string {
  if (extra === undefined || extra === null) return ''
  try {
    const s = typeof extra === 'string' ? extra : JSON.stringify(extra)
    return s ? ' ' + s.slice(0, 1500) : ''
  } catch {
    return ' ' + String(extra)
  }
}

/**
 * 插件日志：同时写 console 与启动器 trace。
 *
 * 沙箱里的 console 只在 DevTools 可见，用户报障时拿不到；`log` 桥方法走后端
 * `POST /api/plugins/log`，落盘到 `{数据目录}/logs/qomicex-backend.log`，
 * 格式 `[plugin:top.qomicex.assistant:error] ...`，事后可查。
 * 需要 manifest 声明 `plugin:log`；未声明时桥会拒绝，这里静默吞掉——
 * 日志永远不能影响主流程。
 */
export function pluginLog(level: LogLevel, message: string, extra?: unknown): void {
  // 整段兜底：getApi() 在无 window 的环境（如单测/浏览器直开）会抛，日志不能反过来炸主流程
  try {
    const text = message + stringifyDetail(extra)
    if (level === 'error') console.error('[assistant]', text)
    else if (level === 'warn') console.warn('[assistant]', text)
    else console.log('[assistant]', text)
    const api = getApi()
    if (api && api.call) api.call('log', text, level).catch(() => {})
  } catch {
    /* 日志失败一律忽略 */
  }
}
