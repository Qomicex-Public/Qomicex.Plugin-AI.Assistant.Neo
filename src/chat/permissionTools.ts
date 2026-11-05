import type { FilePermission } from './types.ts'

/**
 * 权限提权工具（RequestWritePermission）。
 *
 * handler 层不能直接依赖 engine（engine → handlers 是单向的），所以这里只保留一个
 * requester 引用：engine.init() 把真正的「弹窗 + 等用户确认」实现注入进来。
 * 工具本身的语义：只读时请求提升到「可写」，由用户在聊天里的确认窗决定。
 */

export interface WritePermissionResult {
  ok: boolean
  permission: FilePermission
  /** 当前已经是可写/完全访问，没有弹窗 */
  already?: boolean
  canceled?: boolean
  timedOut?: boolean
  error?: string
}

export type WritePermissionRequester = (reason: string) => Promise<WritePermissionResult>

let requester: WritePermissionRequester | null = null

export function setPermissionRequester(fn: WritePermissionRequester | null): void {
  requester = fn
}

export async function toolRequestWritePermission(a: { reason?: string }): Promise<unknown> {
  if (!requester) return { error: '权限申请不可用（引擎尚未初始化）' }
  const reason = String(a.reason ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200)
  const r = await requester(reason)
  if (!r.ok) {
    return {
      ok: false,
      permission: r.permission,
      canceled: r.canceled === true,
      timedOut: r.timedOut === true,
      error: r.error || '用户未同意提权',
    }
  }
  const label = r.permission === 'full' ? '完全访问' : '可写'
  return {
    ok: true,
    permission: r.permission,
    already: r.already === true,
    __ui_summary: r.already ? `已有${label}权限` : `已切换到${label}权限`,
    __raw_text: r.already
      ? `当前已经是${label}权限，无需重复申请。请继续操作。`
      : `用户已确认，当前会话已切换到${label}权限。请继续刚才需要写入/执行的操作；` +
        '若仍然被拒绝，检查具体路径是否需要在启动器授权窗里允许。',
  }
}
