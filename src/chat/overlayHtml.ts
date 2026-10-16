import { getApi, getPluginId } from '../api.ts'

/**
 * 构建动态悬浮窗（overlay.create）所需的内容 HTML。
 *
 * 悬浮窗由主窗口以 `blob:` 加载，相对 URL 会相对主窗口解析；且启动器 `overlayHtml()`
 * 会把 `<link rel=stylesheet>` 抽到外层 `<head>`（那里只有主窗口的 `<base>`，相对 CSS 会失效）。
 * 因此这里产出：
 *   - 单一 `<script type="module" src="...">`，src 为**绝对** URL
 *   - CSS 以 `<style>` 内联（`<style>` 会被启动器原样保留在外层 head）
 *
 * 取值顺序：
 *   1. 构建期生成的 `overlay-inline.ts`（内联 CSS + 固定脚本路径，最稳；由 prebuild 脚本产出）
 *   2. 运行时拉取插件文件服务里的 overlay.html（兜底）
 *
 * 用 `import.meta.glob` 而非静态 import：该文件可能不存在，glob 匹配 0 个文件也不会让构建失败。
 */
const inlineModules = import.meta.glob('./overlay-inline.ts', { eager: true }) as Record<string, any>

function pluginFileBase(): string {
  const w = window as any
  if (w.__PLUGIN_API_BASE__) return String(w.__PLUGIN_API_BASE__)
  return `http://localhost:5000/api/plugins/${encodeURIComponent(getPluginId())}/files`
}

function absolutize(src: string, base: string): string {
  if (/^https?:/i.test(src)) return src
  return `${base}/${src.replace(/^\.\//, '')}`
}

/** 从 overlay.html 原文提取 body 内脚本（转为绝对地址）与内联样式。 */
function fromHtml(html: string, base: string): { body: string; scriptAbs: string } | null {
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)
  if (!bodyMatch) return null
  let inner = bodyMatch[1]

  const cssParts: string[] = []
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)
  const head = headMatch ? headMatch[1] : ''
  for (const m of head.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) cssParts.push(m[1])
  for (const m of inner.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) cssParts.push(m[1])
  inner = inner.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

  const scriptRe = /<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/i
  const sm = scriptRe.exec(inner)
  if (!sm) return null
  const scriptAbs = absolutize(sm[3], base)
  inner = inner.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])[^"']+\1[^>]*>\s*<\/script>/gi, '')

  const attrs = `${sm[1]} ${sm[4]}`.replace(/\s+/g, ' ').trim()
  const body = `${cssParts.map((c) => `<style>${c}</style>`).join('')}${inner}<script ${attrs} src="${scriptAbs}"></script>`
  return { body, scriptAbs }
}

export interface OverlayPayload {
  html: string
  scriptAbs: string
}

/** 生成动态悬浮窗内容 HTML。失败返回 null（调用方应给用户可见提示）。 */
export async function buildOverlayPayload(): Promise<OverlayPayload | null> {
  const base = pluginFileBase()

  // 1) 构建期内联产物
  const mod = inlineModules['./overlay-inline.ts']
  if (mod && typeof mod.buildOverlayPayload === 'function') {
    try {
      const p = mod.buildOverlayPayload(base)
      if (p && p.html && p.scriptAbs) return { html: p.html, scriptAbs: p.scriptAbs }
    } catch {
      /* 落到运行时兜底 */
    }
  }

  // 2) 运行时拉取 overlay.html
  const api = getApi()
  if (!api) return null
  try {
    const res: any = await api.call('proxyFetch', { url: `${base}/dist/overlay.html`, method: 'GET', timeoutMs: 10000 })
    const text: string = res && res.status === 200 ? String(res.body || '') : ''
    if (!text) return null
    const parsed = fromHtml(text, base)
    if (!parsed) return null
    return { html: parsed.body, scriptAbs: parsed.scriptAbs }
  } catch {
    return null
  }
}
