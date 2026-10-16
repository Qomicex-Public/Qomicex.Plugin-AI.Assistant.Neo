import { marked } from 'marked'
import { getApi } from '../api.ts'

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function isEmpty(s: string | null | undefined): boolean {
  return !s || /^(空|无|none|null|空白)$/i.test(String(s).trim())
}

// marked 实例：与 MarkdownLib 一致（GFM 默认开启，表格/删除线/任务列表可用）。
marked.setOptions({ gfm: true, breaks: false })

/**
 * 内置兜底渲染：优先调用 MarkdownLib（共享实现），失败时用打包进本插件的
 * marked 渲染，避免任何情况下退化成纯文本。
 *
 * 为什么需要兜底：宿主 `createSandbox` 对无 menuItems 的库插件不会把 iframe
 * 挂到 DOM，srcdoc iframe 不挂载即不执行脚本，导致 MarkdownLib 的方法从未注册、
 * callPlugin 必然 reject（已用 CDP 实测证明）。兜底让本插件对宿主缺陷免疫。
 */
function renderBuiltin(md: string): string {
  try {
    return marked.parse(md || '', { async: false }) as string
  } catch {
    return '<p>' + escapeHtml(md).replace(/\n/g, '<br>') + '</p>'
  }
}

// ---------- info 图鉴卡片 ----------
export function renderInfoBlock(body: string): string {
  const kv: Record<string, string> = {}
  body.split('\n').forEach((line) => {
    const eq = line.indexOf('=')
    if (eq > 0) kv[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  })
  const name = kv.name || ''
  const cat = kv.category || ''
  return (
    '<div class="info-card" data-info-name="' +
    escapeHtml(name) +
    '">' +
    '<div class="info-card-icon">' +
    escapeHtml(name[0] || '') +
    '</div>' +
    '<div class="info-card-body"><div class="info-card-name">' +
    escapeHtml(name) +
    '</div>' +
    (cat ? '<div class="info-card-cat">' + escapeHtml(cat) + '</div>' : '') +
    '</div></div>'
  )
}

// ---------- suggest 联想提问 ----------
export function renderSuggestBlock(body: string): string {
  const items = body
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (items.length === 0) return ''
  let html = '<div class="suggest-row">'
  items.forEach((item) => {
    html += '<button class="suggest-chip" data-suggest="' + escapeHtml(item) + '">' + escapeHtml(item) + '</button>'
  })
  html += '</div>'
  return html
}

// ---------- crafting 合成表 ----------
export function renderCraftingGrid(body: string): string {
  const grid: Record<string, string> = {}
  let output = ''
  let count = 1
  const rows: string[][] = []
  const hasKeys = /[A-C][1-3]\s*=/.test(body)
  body.split('\n').forEach((line) => {
    line = line.trim()
    if (!line) return
    if (hasKeys) {
      line.split('|').forEach((p) => {
        const eq = p.indexOf('=')
        if (eq < 0) return
        const k = p.slice(0, eq).trim()
        const v = p.slice(eq + 1).trim()
        if (k === 'Output') {
          output = v
          return
        }
        if (k === 'Count') {
          count = parseInt(v) || 1
          return
        }
        if (v && !isEmpty(v)) grid[k] = v
      })
    } else {
      if (/^Output\s*=/.test(line)) {
        const rest = line.slice(line.indexOf('=') + 1).trim()
        const cm = rest.match(/x(\d+)$/)
        if (cm) {
          output = rest.slice(0, -cm[0].length).trim()
          count = parseInt(cm[1]) || 1
        } else {
          const oParts = rest.split('|')
          output = oParts[0].trim()
          for (let oi = 1; oi < oParts.length; oi++) {
            const op = oParts[oi].trim()
            if (/^Count\s*=/.test(op)) count = parseInt(op.slice(op.indexOf('=') + 1)) || 1
          }
        }
        return
      }
      if (/^Count\s*=/.test(line)) {
        count = parseInt(line.slice(line.indexOf('=') + 1)) || 1
        return
      }
      rows.push(
        line
          .split(/[|,]/)
          .slice(0, 3)
          .map((s) => (isEmpty(s) ? '' : s.trim()))
      )
    }
  })
  function cell(r: number, c: number): string {
    if (hasKeys) return grid[['A', 'B', 'C'][r] + (c + 1)] || ''
    return (rows[r] && rows[r][c]) || ''
  }
  function cellHtml(item: string, isOutput: boolean): string {
    const names = String(item)
      .split(/[;,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !isEmpty(s))
    const attr = names.length ? ' data-items="' + escapeHtml(JSON.stringify(names)) + '"' : ''
    const text = names.length ? escapeHtml(names[0]) : ''
    return (
      '<div class="craft-cell' +
      (isOutput ? ' craft-cell--out' : '') +
      '"' +
      attr +
      '>' +
      text +
      (isOutput && count > 1 ? '<span class="craft-count">x' + count + '</span>' : '') +
      '</div>'
    )
  }
  let html = '<div class="craft-wrap">'
  html += '<div class="craft-grid">'
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      html += cellHtml(cell(r, c), false)
    }
  }
  html += '</div>'
  html += '<div class="craft-arrow">&#8594;</div>'
  html += cellHtml(output, true)
  html += '</div>'
  return html
}

// ---------- recipe 配方 ----------
export function renderRecipeBlock(body: string): string {
  const kv: Record<string, string> = {}
  body.split('\n').forEach((line) => {
    const eq = line.indexOf('=')
    if (eq > 0) kv[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  })
  const type = kv.type || 'smelting'
  const ws = kv.workstation || (type === 'smithing' ? '锻造台' : type === 'anvil' ? '铁砧' : type === 'stonecutting' ? '切石机' : '熔炉')
  function itemHtml(name: string): string {
    if (isEmpty(name)) return '<div class="craft-cell"></div>'
    const names = String(name)
      .split(/[;,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !isEmpty(s))
    return '<div class="craft-cell" data-items="' + escapeHtml(JSON.stringify(names)) + '">' + escapeHtml(names[0]) + '</div>'
  }
  function slotRow(itemsHtml: string[], sep: string): string {
    return '<div class="recipe-slot-row">' + itemsHtml.join('<span class="recipe-op">' + sep + '</span>') + '</div>'
  }
  let bodyHtml = ''
  if (type === 'smithing' || type === 'anvil') {
    bodyHtml = slotRow([itemHtml(kv.base || kv.input), itemHtml(kv.addition || kv.material)], '+')
  } else {
    bodyHtml = slotRow([itemHtml(kv.input || kv.material)], '')
  }
  let html = '<div class="recipe-wrap">'
  html += '<div class="recipe-station">' + itemHtml(ws) + '<span class="recipe-station-name">' + escapeHtml(ws) + '</span></div>'
  html += '<div class="recipe-flow">' + bodyHtml + '<span class="recipe-arrow">&#8594;</span>' + itemHtml(kv.output) + '</div>'
  html += '</div>'
  return html
}

// ---------- 特殊块提取 ----------
export function extractSpecialBlocks(text: string): { text: string; blocks: string[] } {
  const lines = text.split('\n')
  const out: string[] = []
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^\s*```(crafting|recipe|info|suggest)\s*$/)
    if (m) {
      const lang = m[1]
      const bodyLines: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        bodyLines.push(lines[i])
        i++
      }
      i++
      const body = bodyLines.join('\n').replace(/\n+$/, '')
      const idx = blocks.length
      blocks.push(
        lang === 'crafting'
          ? renderCraftingGrid(body)
          : lang === 'recipe'
            ? renderRecipeBlock(body)
            : lang === 'info'
              ? renderInfoBlock(body)
              : renderSuggestBlock(body)
      )
      out.push('@@CRAFTING' + idx + '@@')
    } else {
      out.push(lines[i])
      i++
    }
  }
  return { text: out.join('\n'), blocks: blocks }
}

/**
 * 渲染 Markdown：MarkdownLib 优先，失败回退到内置 marked。
 * 返回 HTML 字符串（含 `<p>` 包裹），供 dangerouslySetInnerHTML 使用。
 *
 * 注意：内置兜底为**同步**返回，因此即使 MarkdownLib 不可用，首帧也能拿到
 * 正确 HTML，不会出现「先纯文本、后跳变」的闪烁。
 */
export function renderMd(text: string): Promise<string> {
  const extracted = extractSpecialBlocks(text || '')
  function applyBlocks(html: string): string {
    extracted.blocks.forEach((g, i) => {
      if (html.indexOf('<p>@@CRAFTING' + i + '@@</p>') >= 0) html = html.replace('<p>@@CRAFTING' + i + '@@</p>', g)
      html = html.split('@@CRAFTING' + i + '@@').join(g)
    })
    return html
  }

  const api = getApi()
  if (!api || !api.callPlugin) return Promise.resolve(applyBlocks(renderBuiltin(extracted.text)))

  return Promise.resolve()
    .then(() => api.callPlugin('top.qomicex.markdown', 'renderMarkdown', extracted.text))
    .then((html) => {
      const s = String(html == null ? '' : html)
      // MarkdownLib 返回空串视为失败，走内置兜底（例如输入仅含被提取的特殊块）
      if (extracted.text.trim() && !s.trim()) return applyBlocks(renderBuiltin(extracted.text))
      return applyBlocks(s)
    })
    .catch(() => applyBlocks(renderBuiltin(extracted.text)))
}

/** 同步渲染：仅用于必须同步拿到 HTML 的场景（当前未使用，保留 API 对称）。 */
export function renderMdSync(text: string): string {
  const extracted = extractSpecialBlocks(text || '')
  const html = renderBuiltin(extracted.text)
  const blocks = extracted.blocks
  let out = html
  blocks.forEach((g, i) => {
    if (out.indexOf('<p>@@CRAFTING' + i + '@@</p>') >= 0) out = out.replace('<p>@@CRAFTING' + i + '@@</p>', g)
    out = out.split('@@CRAFTING' + i + '@@').join(g)
  })
  return out
}
