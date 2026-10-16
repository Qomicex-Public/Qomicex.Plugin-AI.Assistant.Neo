import { getApi } from '../api.ts'

/** 复制文本到剪贴板：优先用插件桥的 callBackend('/system/...') 不可用时回退 navigator。 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 沙箱内 clipboard 可能被拒，继续尝试 execCommand */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** 通过启动器打开外部链接（沙箱内 window.open 会被拦截）。 */
export function openExternal(url: string) {
  if (!url || !/^https?:\/\//i.test(url)) return
  const api = getApi()
  if (api && api.call) api.call('callBackend', '/system/open-url', { url }).catch(() => {})
}
