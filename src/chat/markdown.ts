import { getApi } from '../api.ts'

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function isEmpty(s: string | null | undefined): boolean {
  return !s || /^(空|无|none|null|空白)$/i.test(String(s).trim())
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
    '" style="display:flex;align-items:center;gap:12px;background:hsl(var(--background));border-radius:8px;padding:10px;margin:4px 0;max-width:100%">' +
    '<div style="width:56px;height:56px;flex-shrink:0;border-radius:6px;background:hsl(var(--muted));display:flex;align-items:center;justify-content:center;font-size:11px;color:hsl(var(--muted-foreground));overflow:hidden">' +
    escapeHtml(name[0] || '') +
    '</div>' +
    '<div style="min-width:0"><div style="font-size:13px;font-weight:600;color:hsl(var(--foreground))">' +
    escapeHtml(name) +
    '</div>' +
    (cat ? '<div style="font-size:11px;color:hsl(var(--muted-foreground));margin-top:2px">' + escapeHtml(cat) + '</div>' : '') +
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
  let html =
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid hsl(var(--border))">'
  items.forEach((item) => {
    html +=
      '<button class="suggest-chip" data-suggest="' +
      escapeHtml(item) +
      '" style="padding:4px 10px;border-radius:12px;border:1px solid hsl(var(--border));background:hsl(var(--muted));color:hsl(var(--muted-foreground));font-size:11px;cursor:pointer;line-height:1.2;text-align:left;transition:all .15s">' +
      escapeHtml(item) +
      '</button>'
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
  const base =
    'border:1px solid hsl(var(--border));border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;text-align:center;overflow:hidden;padding:2px;box-sizing:border-box;background:hsl(var(--muted));position:relative'
  function cellHtml(item: string, isOutput: boolean): string {
    const names = String(item)
      .split(/[;,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !isEmpty(s))
    const w = isOutput ? 52 : 42
    let style = base + ';width:' + w + 'px;height:' + w + 'px'
    if (isOutput) style += ';border-color:hsl(var(--primary))'
    const attr = names.length ? ' data-items="' + escapeHtml(JSON.stringify(names)) + '"' : ''
    const text = names.length ? escapeHtml(names[0]) : ''
    return (
      '<div' +
      attr +
      ' style="' +
      style +
      '">' +
      text +
      (isOutput && count > 1 ? '<span style="font-size:9px;color:hsl(var(--muted-foreground))">x' + count + '</span>' : '') +
      '</div>'
    )
  }
  let html = '<div style="display:inline-flex;align-items:center;gap:10px;background:hsl(var(--background));border-radius:8px;padding:10px;margin:4px 0">'
  html += '<div style="display:grid;grid-template-columns:repeat(3,42px);gap:4px">'
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      html += cellHtml(cell(r, c), false)
    }
  }
  html += '</div>'
  html += '<div style="color:hsl(var(--muted-foreground));font-size:16px">&#8594;</div>'
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
  const ws =
    kv.workstation || (type === 'smithing' ? '锻造台' : type === 'anvil' ? '铁砧' : type === 'stonecutting' ? '切石机' : '熔炉')
  const itemStyle =
    'width:46px;height:46px;border:1px solid hsl(var(--border));border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;text-align:center;overflow:hidden;padding:2px;box-sizing:border-box;background:hsl(var(--muted));position:relative'
  function itemHtml(name: string): string {
    if (isEmpty(name)) return '<div style="' + itemStyle + '"></div>'
    const names = String(name)
      .split(/[;,、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !isEmpty(s))
    return '<div data-items="' + escapeHtml(JSON.stringify(names)) + '" style="' + itemStyle + '">' + escapeHtml(names[0]) + '</div>'
  }
  function slotRow(itemsHtml: string[], sep: string): string {
    return '<div style="display:flex;align-items:center;gap:8px">' + itemsHtml.join('<span style="color:hsl(var(--muted-foreground));font-size:12px">' + sep + '</span>') + '</div>'
  }
  let bodyHtml = ''
  if (type === 'smithing' || type === 'anvil') {
    bodyHtml = slotRow([itemHtml(kv.base || kv.input), itemHtml(kv.addition || kv.material)], '+')
  } else {
    bodyHtml = slotRow([itemHtml(kv.input || kv.material)], '')
  }
  let html = '<div style="display:flex;flex-direction:column;gap:8px;background:hsl(var(--background));border-radius:8px;padding:10px;margin:4px 0;align-items:center">'
  html += '<div style="display:flex;flex-direction:column;align-items:center;gap:2px">' + itemHtml(ws) + '<span style="font-size:10px;color:hsl(var(--muted-foreground))">' + escapeHtml(ws) + '</span></div>'
  html += '<div style="display:flex;align-items:center;gap:10px">' + bodyHtml + '<span style="color:hsl(var(--primary));font-size:14px">&#8594;</span>' + itemHtml(kv.output) + '</div>'
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

export function renderMd(text: string): Promise<string> {
  const extracted = extractSpecialBlocks(text)
  function applyBlocks(html: string): string {
    extracted.blocks.forEach((g, i) => {
      if (html.indexOf('<p>@@CRAFTING' + i + '@@</p>') >= 0) html = html.replace('<p>@@CRAFTING' + i + '@@</p>', g)
      html = html.split('@@CRAFTING' + i + '@@').join(g)
    })
    return html
  }
  function fallback(): string {
    return applyBlocks('<p>' + escapeHtml(extracted.text).replace(/\n/g, '<br>') + '</p>')
  }
  const api = getApi()
  if (!api || !api.callPlugin) return Promise.resolve(fallback())
  return api
    .callPlugin('top.qomicex.markdown', 'renderMarkdown', extracted.text)
    .then((html) => applyBlocks(String(html)))
    .catch(() => fallback())
}