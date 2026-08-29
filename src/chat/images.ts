import { getApi } from '../api.ts'

const itemNamesEN: Record<string, string> = {
  木镐: 'Wooden_Pickaxe', 石镐: 'Stone_Pickaxe', 铁镐: 'Iron_Pickaxe', 金镐: 'Golden_Pickaxe', 钻石镐: 'Diamond_Pickaxe', 下界合金镐: 'Netherite_Pickaxe',
  木斧: 'Wooden_Axe', 石斧: 'Stone_Axe', 铁斧: 'Iron_Axe', 金斧: 'Golden_Axe', 钻石斧: 'Diamond_Axe', 下界合金斧: 'Netherite_Axe',
  木剑: 'Wooden_Sword', 石剑: 'Stone_Sword', 铁剑: 'Iron_Sword', 金剑: 'Golden_Sword', 钻石剑: 'Diamond_Sword', 下界合金剑: 'Netherite_Sword',
  木锹: 'Wooden_Shovel', 石锹: 'Stone_Shovel', 铁锹: 'Iron_Shovel', 金锹: 'Golden_Shovel', 钻石锹: 'Diamond_Shovel', 下界合金锹: 'Netherite_Shovel',
  木锄: 'Wooden_Hoe', 石锄: 'Stone_Hoe', 铁锄: 'Iron_Hoe', 金锄: 'Golden_Hoe', 钻石锄: 'Diamond_Hoe', 下界合金锄: 'Netherite_Hoe',
  弓: 'Bow', 弩: 'Crossbow', 盾牌: 'Shield',
  木棍: 'Stick', 铁锭: 'Iron_Ingot', 金锭: 'Gold_Ingot', 钻石: 'Diamond', 绿宝石: 'Emerald', 下界合金锭: 'Netherite_Ingot',
  工作台: 'Crafting_Table', 熔炉: 'Furnace', 高炉: 'Blast_Furnace', 烟熏炉: 'Smoker', 营火: 'Campfire',
  锻造台: 'Smithing_Table', 铁砧: 'Anvil', 切石机: 'Stonecutter',
}

function wikiAPI(url: string): Promise<any> {
  const sep = url.indexOf('?') >= 0 ? '&' : '?'
  const apiUrl = url + sep + 'format=json'
  function parse(res: any) {
    if (!res || res.status !== 200) throw new Error('wiki status ' + (res && res.status))
    return JSON.parse(res.body)
  }
  const api = getApi()
  if (api && api.call) {
    return api.call('proxyFetch', { url: apiUrl, method: 'GET', timeoutMs: 15000 }).then(parse)
  }
  return Promise.reject(new Error('API 桥接不可用'))
}

function extractThumb(d: any): string | null {
  const pages = d && d.query && d.query.pages
  if (!pages) return null
  const page = pages[Object.keys(pages)[0]]
  return (page && page.thumbnail && page.thumbnail.source) || null
}

function titleMatches(title: string, name: string): boolean {
  const t = String(title || '').toLowerCase()
  const n = String(name || '').toLowerCase()
  if (t === n) return true
  if (t.indexOf(n) >= 0) return true
  if (n.indexOf(t) >= 0 && n.length - t.length <= 2) return true
  return false
}

function enNameThumb(name: string, size: number): Promise<string | null> {
  const en = itemNamesEN[name]
  if (!en) return Promise.resolve(null)
  return wikiAPI('https://zh.minecraft.wiki/api.php?action=query&list=allimages&aiprefix=' + encodeURIComponent(en) + '&ailimit=5')
    .then((d2) => {
      const files = (d2.query && d2.query.allimages) || []
      if (files.length === 0) return null
      return wikiAPI('https://zh.minecraft.wiki/api.php?action=query&titles=' + encodeURIComponent('File:' + files[0].name) + '&prop=imageinfo&iiprop=url&iiurlwidth=' + size).then(
        (d3) => {
          const pages3 = d3.query && d3.query.pages
          const page3 = pages3 && pages3[Object.keys(pages3)[0]]
          const ii = page3 && page3.imageinfo && page3.imageinfo[0]
          return (ii && ii.thumburl) || (ii && ii.url) || null
        }
      )
    })
    .catch(() => null)
}

export function getItemThumb(name: string, size?: number): Promise<string | null> {
  size = size || 42
  return wikiAPI('https://zh.minecraft.wiki/api.php?action=query&prop=pageimages&titles=' + encodeURIComponent(name) + '&piprop=thumbnail&pithumbsize=' + size)
    .then((d) => {
      const t = extractThumb(d)
      if (t) return t
      return enNameThumb(name, size)
    })
    .then((t) => {
      if (t) return t
      return wikiAPI('https://zh.minecraft.wiki/api.php?action=query&list=search&srsearch=' + encodeURIComponent(name) + '&srnamespace=0&srlimit=5').then((d2) => {
        const results = (d2.query && d2.query.search) || []
        const matched = results.filter((r: any) => titleMatches(r.title, name))
        if (matched.length === 0) return null
        const titles = matched.slice(0, 3).map((r: any) => r.title).join('|')
        return wikiAPI('https://zh.minecraft.wiki/api.php?action=query&prop=pageimages&titles=' + encodeURIComponent(titles) + '&piprop=thumbnail&pithumbsize=' + size).then(
          (d3) => {
            const pages3 = d3.query && d3.query.pages
            for (const k in pages3) {
              const p = pages3[k]
              if (titleMatches(p.title, name) && p.thumbnail) return p.thumbnail.source
            }
            return null
          }
        )
      })
    })
    .catch(() => null)
}

function fetchImageDataUrl(url: string): Promise<string | null> {
  const api = getApi()
  if (api && api.call) {
    return api
      .call('proxyFetch', { url: url, method: 'GET', timeoutMs: 20000 })
      .then((res: any) => {
        if (res && res.bodyBase64) {
          let mime = 'image/png'
          if (res.headers) {
            const ct = res.headers['content-type'] || res.headers['Content-Type'] || ''
            if (typeof ct === 'string' && ct.indexOf('/') > 0) mime = ct.split(';')[0].trim()
          }
          return 'data:' + mime + ';base64,' + res.bodyBase64
        }
        return null
      })
      .catch(() => null)
  }
  return Promise.resolve(null)
}

const itemImgCache: Record<string, string> = {}

export function loadItemImages(names: string[], cell: HTMLElement) {
  if (!names || names.length === 0) return
  const imgs: (string | null)[] = []
  let pending = names.length
  let doneCalled = false
  function done() {
    pending--
    if (pending === 0 && !doneCalled) {
      doneCalled = true
      show()
    }
  }
  function show() {
    const valid = imgs.filter(Boolean) as string[]
    if (valid.length === 0) return
    let idx = 0
    cell.innerHTML = '<img src="' + valid[0] + '" style="width:32px;height:32px;object-fit:contain;pointer-events:none">'
    if (valid.length > 1) {
      cell.innerHTML += '<span style="font-size:8px;color:hsl(var(--muted-foreground));position:absolute;bottom:1px;right:2px">' + valid.length + '选1</span>'
      setInterval(() => {
        idx = (idx + 1) % valid.length
        const im = cell.querySelector('img')
        if (im) im.setAttribute('src', valid[idx])
      }, 1500)
    }
  }
  names.forEach((name, i) => {
    if (itemImgCache[name]) {
      imgs[i] = itemImgCache[name]
      done()
    } else {
      getItemThumb(name)
        .then((thumb) => {
          if (thumb) return fetchImageDataUrl(thumb).then((dataUrl) => dataUrl || thumb)
          return null
        })
        .then((src) => {
          if (src) {
            itemImgCache[name] = src
            imgs[i] = src
          }
          done()
        })
        .catch(() => done())
    }
  })
}

export function loadGridImages(container: Element) {
  const cells = container.querySelectorAll('[data-items]')
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as HTMLElement
    try {
      const names = JSON.parse(cell.getAttribute('data-items') || '[]')
      loadItemImages(names, cell)
    } catch (e) {}
  }
}

export function loadInfoImages(container: Element) {
  const cards = container.querySelectorAll('.info-card[data-info-name]')
  for (let i = 0; i < cards.length; i++) {
    ;(function (card) {
      const name = card.getAttribute('data-info-name')
      if (!name) return
      getItemThumb(name, 120)
        .then((thumb) => {
          if (thumb) return fetchImageDataUrl(thumb)
          return null
        })
        .then((dataUrl) => {
          if (dataUrl) {
            const slot = card.querySelector('div[style*="56px"]')
            if (slot) slot.innerHTML = '<img src="' + dataUrl + '" style="width:56px;height:56px;object-fit:contain">'
          }
        })
        .catch(() => {})
    })(cards[i] as HTMLElement)
  }
}