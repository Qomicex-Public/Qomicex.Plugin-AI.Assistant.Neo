import type { PluginApi } from '../api.ts'

let api: PluginApi | null = null

export function setApiRef(a: PluginApi | null) {
  api = a
}

export type ToolArgs = Record<string, any>

// ---------- 缓存 ----------
const mcmodCache: Record<string, { time: number; data: unknown }> = {}
const MC_CACHE_TTL = 10 * 60 * 1000

function cacheGet(key: string): Promise<unknown> {
  const mem = mcmodCache[key]
  if (mem && Date.now() - mem.time < MC_CACHE_TTL) return Promise.resolve(mem.data)
  if (api && api.call) {
    return api
      .call('getCache', key)
      .then((v) => {
        if (v !== null && v !== undefined) {
          mcmodCache[key] = { time: Date.now(), data: v }
          return v
        }
        return mem ? mem.data : null
      })
      .catch(() => (mem ? mem.data : null))
  }
  return Promise.resolve(mem ? mem.data : null)
}

function cacheSet(key: string, value: unknown, ttlSeconds?: number) {
  mcmodCache[key] = { time: Date.now(), data: value }
  if (api && api.call) {
    return api
      .call('setCache', key, value, ttlSeconds === undefined ? null : ttlSeconds)
      .catch(() => {})
  }
  return Promise.resolve()
}

// ---------- Wiki ----------
function wikiAPI(url: string): Promise<any> {
  const sep = url.indexOf('?') >= 0 ? '&' : '?'
  const apiUrl = url + sep + 'format=json'
  function parse(res: any) {
    if (!res || res.status !== 200) throw new Error('wiki status ' + (res && res.status))
    return JSON.parse(res.body)
  }
  if (api && api.call) {
    return api.call('proxyFetch', { url: apiUrl, method: 'GET', timeoutMs: 15000 }).then(parse)
  }
  return Promise.reject(new Error('API 桥接不可用'))
}

// ---------- MC百科 ----------
let mcmodLastReq = 0

// ---------- 下载进度限流（每 15s 最多一次，防止 AI 高频轮询） ----------
let lastDownloadProgressAt = 0
const DOWNLOAD_PROGRESS_INTERVAL = 15000

function mcmodThrottle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, mcmodLastReq + 3000 - now)
  mcmodLastReq = now + wait
  return wait === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, wait))
}

function parseMcmod(html: string) {
  const results: { name: string; type: string; url: string }[] = []
  const seen: Record<string, boolean> = {}
  const re = /<a[^>]*href="([^"]*mcmod\.cn\/(?:class|item|block|entity|structure|modpack|find)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && results.length < 10) {
    const url = m[1]
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 50)
    if (!text || seen[url]) continue
    const parts = url.split('/')
    const type = parts[parts.length - 2] || ''
    seen[url] = true
    results.push({ name: text, type: type, url: url })
  }
  if (results.length === 0) {
    const re2 = /href="([^"]*mcmod\.cn\/(?:class|item)\/(\d+)\.html)"[^>]*>/gi
    while ((m = re2.exec(html)) !== null && results.length < 10) {
      if (seen[m[1]]) continue
      seen[m[1]] = true
      results.push({ name: 'MC百科资料 #' + m[2], type: m[1].indexOf('/class/') >= 0 ? 'mod' : 'item', url: m[1] })
    }
  }
  return results
}

function stripHtmlTags(html: string) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractMcmodContent(html: string) {
  const title = ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
    (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] ||
    '')
  const titleText = stripHtmlTags(title).slice(0, 80)
  let desc = ''
  const containers = [
    /<div[^>]*class="[^"]*(?:intro|introduction|summary|desc|describe)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*(?:intro|introduction|summary|desc)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]*class="[^"]*(?:intro|introduction|summary)[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
  ]
  for (let i = 0; i < containers.length; i++) {
    const m = html.match(containers[i])
    if (m && stripHtmlTags(m[1]).length > 20) {
      desc = m[1]
      break
    }
  }
  if (!desc) {
    const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || html
    desc = body
  }
  const text = stripHtmlTags(desc).replace(/\s{2,}/g, ' ')
  return { title: titleText, url: '', content: text.slice(0, 6000) }
}

function mcmodSearch(key: string) {
  const ck = 'mcmod:search:' + key
  return cacheGet(ck).then((cached) => {
    if (cached) return { keyword: key, results: cached }
    return mcmodThrottle().then(() => {
      if (!api || !api.call) throw new Error('API 桥接不可用')
      return api.call('proxyFetch', { url: 'https://search.mcmod.cn/s?key=' + encodeURIComponent(key), method: 'GET', timeoutMs: 20000 })
    }).then((res: any) => {
      if (!res || res.status !== 200) throw new Error('mcmod 返回 ' + (res && res.status))
      const html = res.body || ''
      const results = parseMcmod(html)
      if (results.length === 0) return { keyword: key, results: [], message: '未找到相关结果' }
      cacheSet(ck, results, 86400)
      return { keyword: key, results: results }
    })
  }).catch((e) => {
    return { keyword: key, error: 'MC百科请求失败（可能被限流）: ' + e.message }
  })
}

// ---------- Bing / Web ----------
function parseBingRss(html: string) {
  const items: { title: string; url: string; snippet: string }[] = []
  const seen: Record<string, boolean> = {}
  const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?(?:<description>([\s\S]*?)<\/description>)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null && items.length < 10) {
    const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const url = m[2].trim()
    const snippet = (m[3] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    if (!title || !url || seen[url]) continue
    seen[url] = true
    items.push({ title: title, url: url, snippet: snippet })
  }
  return items
}

function extractTitle(html: string) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

function extractMeta(html: string) {
  const get = (name: string) => {
    let re = new RegExp('<meta[^>]+(?:property|name)="' + name + '"[^>]+content="([^"]*)"', 'i')
    let m = html.match(re)
    if (m) return m[1]
    re = new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + name + '"', 'i')
    m = html.match(re)
    return m ? m[1] : ''
  }
  return {
    title: get('og:title') || get('twitter:title') || extractTitle(html),
    description: get('og:description') || get('twitter:description') || '',
  }
}

function isVideoSite(url: string) {
  return /youtube\.com|youtu\.be|bilibili\.com|b23\.tv|twitch\.tv|nicovideo\.jp|vimeo\.com|dailymotion\.com/i.test(url)
}

function isBilibiliArticle(url: string) {
  return /bilibili\.com\/read\/|bilibili\.com\/opus\/|b23\.tv\/read\//i.test(url)
}

function htmlToText(html: string) {
  let s = String(html || '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article|pre)>/gi, '\n')
  s = s.replace(/<(li|h[1-6]|p)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ')
  s = s.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  return s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- 工具处理器 ----------
const handlers: Record<string, (a: ToolArgs) => unknown> = {
  listInstances: () => api!.call('callBackend', '/instance'),
  getInstance: (a) => api!.call('callBackend', '/instance/' + a.instanceId),
  getInstanceLaunchProgress: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/launch/progress'),
  createInstance: (a) =>
    api!.call('callBackend', '/instance', {
      name: a.name,
      gameVersion: a.gameVersion,
      loader: a.loader,
      loaderVersion: a.loaderVersion,
      javaPath: a.javaPath || null,
      maxMemory: a.maxMemory || 4096,
      gameDir: a.gameDir || '.minecraft',
    }),
  installInstance: async (a) => {
    let inst: any = null
    try {
      inst = await api!.call('callBackend', '/instance/' + a.instanceId)
    } catch (e) {}
    try {
      api!.call('download.registerInstall', {
        instanceId: a.instanceId,
        name: (inst && (inst.name || inst.Name)) || '实例 ' + a.instanceId,
        gameVersion: (inst && (inst.gameVersion || inst.GameVersion)) || 'unknown',
        loader: a.loader,
        loaderVersion: a.loaderVersion,
      })
    } catch (e) {}
    return api!.call('callBackend', '/instance/' + a.instanceId + '/install', {
      loader: a.loader,
      loaderVersion: a.loaderVersion,
      addons: a.addons || undefined,
      optifineVersion: a.optifineVersion || undefined,
      versionIsolation: a.versionIsolation !== undefined ? a.versionIsolation : true,
      downloadThreads: a.downloadThreads || 64,
      downloadSourceId: 0,
      downloadTimeout: 15,
    })
  },
  launchInstance: (a) => {
    const body: Record<string, unknown> = {}
    if (a.accountUuid) body.accountUuid = a.accountUuid
    if (a.joinServer) body.joinServer = a.joinServer
    if (a.joinWorld) body.joinWorld = a.joinWorld
    return api!.call('callBackend', '/instance/' + a.instanceId + '/launch', body).then((r: any) => {
      const result: Record<string, any> = { launched: true, stage: r.stage || 'starting', message: r.message || '启动中' }
      return new Promise((resolve) => {
        let polls = 0
        function poll() {
          api!.call('callBackend', '/instance/' + a.instanceId + '/launch/progress')
            .then((p: any) => {
              result.stage = p.stage
              result.message = p.message
              result.progress = p.progress
              result.processId = p.processId
              if (p.isRunning || p.stage === 'running') {
                result.status = 'running'
                resolve(result)
                return
              }
              if (p.stage === 'failed' || p.stage === 'crashed') {
                result.status = p.stage
                result.error = p.error || p.crashReport
                resolve(result)
                return
              }
              if (p.stage === 'completed') {
                result.status = 'completed'
                resolve(result)
                return
              }
              polls++
              if (polls < 20) setTimeout(poll, 1000)
              else {
                result.status = '启动中（后台）'
                resolve(result)
              }
            })
            .catch(() => resolve(result))
        }
        setTimeout(poll, 500)
      })
    })
  },
  searchResources: (a) => {
    let p = 'keyword=' + encodeURIComponent(a.keyword)
    if (a.source) p += '&source=' + a.source
    if (a.page) p += '&page=' + a.page
    if (a.pageSize) p += '&pageSize=' + a.pageSize
    if (a.gameVersion) p += '&gameVersion=' + a.gameVersion
    if (a.loader) p += '&loader=' + a.loader
    if (a.category) p += '&category=' + a.category
    if (a.sort) p += '&sort=' + a.sort
    return api!.call('callBackend', '/resources/search?' + p)
  },
  getResourceDetail: (a) => api!.call('callBackend', '/resources/' + a.id + '?source=' + (a.source || 'modrinth')),
  getResourceVersions: (a) => {
    let p = 'source=' + (a.source || 'modrinth')
    if (a.gameVersion) p += '&gameVersion=' + a.gameVersion
    if (a.loader) p += '&loader=' + a.loader
    return api!.call('callBackend', '/resources/' + a.id + '/versions?' + p)
  },
  getVersionDownloads: (a) =>
    api!.call('callBackend', '/resources/' + a.id + '/versions/' + a.versionId + '/downloads?source=' + (a.source || 'modrinth')),
  getResourceDependencies: (a) => {
    let p = 'source=' + (a.source || 'modrinth')
    if (a.versionId) p += '&versionId=' + a.versionId
    if (a.gameVersion) p += '&gameVersion=' + a.gameVersion
    if (a.loader) p += '&loader=' + a.loader
    return api!.call('callBackend', '/resources/' + a.id + '/dependencies?' + p)
  },
  startDownload: (a) =>
    api!.call('download.addTask', {
      instanceId: a.instanceId,
      url: a.url,
      fileName: a.fileName,
      category: a.category,
    }),
  getDownloadProgress: (a) => {
    const now = Date.now()
    const elapsed = now - lastDownloadProgressAt
    if (elapsed < DOWNLOAD_PROGRESS_INTERVAL) {
      const waitSec = Math.ceil((DOWNLOAD_PROGRESS_INTERVAL - elapsed) / 1000)
      return { error: '查询过于频繁（每 15 秒最多一次）。请先用 sleep 工具等待 ' + waitSec + ' 秒后再查询' }
    }
    lastDownloadProgressAt = now
    return api!.call('download.progress', a.taskId)
  },
  installMod: async (a) => {
    const inst: any = await api!.call('callBackend', '/instance/' + a.instanceId)
    const gv = a.gameVersion || inst.gameVersion
    const ld = a.loader || inst.loader || ''
    const src = a.source || 'modrinth'
    const searchRes: any = await api!.call(
      'callBackend',
      '/resources/search?source=' + src + '&keyword=' + encodeURIComponent(a.keyword) + '&category=mod&pageSize=5'
    )
    const items = searchRes.items || searchRes.data || []
    if (items.length === 0) return { error: '未找到匹配的模组' }
    const mod = items[0]
    const id = mod.id || mod.projectId
    await api!.call('callBackend', '/resources/' + id + '?source=' + src)
    const versions: any = await api!.call(
      'callBackend',
      '/resources/' + id + '/versions?source=' + src + '&gameVersion=' + encodeURIComponent(gv) + '&loader=' + encodeURIComponent(ld)
    )
    if (!versions || versions.length === 0)
      return { error: '没有兼容 ' + gv + ' ' + ld + ' 的版本', modName: mod.title || mod.name, matchedCount: items.length }
    const ver: any = versions[0]
    const verId = ver.id || ver.versionId
    const downloads: any = await api!.call('callBackend', '/resources/' + id + '/versions/' + verId + '/downloads?source=' + src)
    const files: any[] = downloads || []
    if (files.length === 0) return { error: '没有可下载的文件', version: verId }
    const deps = (await api!
      .call(
        'callBackend',
        '/resources/' + id + '/dependencies?source=' + src + '&versionId=' + verId + '&gameVersion=' + encodeURIComponent(gv) + '&loader=' + encodeURIComponent(ld)
      )
      .catch(() => [])) as any[]
    const results: any[] = []
    for (let i = 0; i < files.length; i++) {
      const f: any = files[i]
      const fn = f.fileName || f.filename || (mod.title || mod.name) + '.jar'
      const dl: any = await api!
        .call('download.addTask', { instanceId: a.instanceId, url: f.url, fileName: fn, category: 'mods' })
        .catch((e) => ({ error: e.message }))
      results.push({ file: fn, taskId: dl.taskId || null, error: dl.error || null })
    }
    if (deps && deps.length > 0) {
      for (let d = 0; d < Math.min(deps.length, 5); d++) {
        const dep: any = deps[d]
        const depUrl = dep.downloadUrl || dep.url
        const depFn = dep.fileName || dep.name || 'dependency-' + d + '.jar'
        if (depUrl) {
          const dl2: any = await api!
            .call('download.addTask', { instanceId: a.instanceId, url: depUrl, fileName: depFn, category: 'mods' })
            .catch(() => ({}))
          results.push({ file: depFn + ' (依赖)', taskId: dl2.taskId || null })
        }
      }
    }
    return { modName: mod.title || mod.name, version: ver.name || verId, matchedCount: items.length, downloads: results, dependencies: (deps || []).length }
  },
  listMods: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/mods'),
  getModMetadata: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/mods/metadata'),
  enableDisableMod: (a) => {
    const action = a.enable ? 'enable' : 'disable'
    return api!.call('callBackend', '/instance/' + a.instanceId + '/files/mods/' + action + '?name=' + encodeURIComponent(a.name), {})
  },
  listInstanceFiles: (a) => {
    const cat = (a.category || '').trim()
    const valid = ['resourcepacks', 'shaderpacks', 'datapacks', 'screenshots', 'saves', 'lan-games']
    if (valid.indexOf(cat) < 0) return { error: '无效的文件类别，可选: resourcepacks/shaderpacks/datapacks/screenshots/saves/lan-games' }
    return api!.call('callBackend', '/instance/' + a.instanceId + '/files/' + cat).catch((e: any) => {
      return { error: '获取失败: ' + (e && e.message || String(e)) }
    })
  },
  listServers: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/servers'),
  copySave: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/saves/copy', { name: a.name, newName: a.newName }),
  renameSave: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/saves/rename', { oldName: a.oldName, newName: a.newName }),
  backupSave: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/saves/backup?name=' + encodeURIComponent(a.name), {}),
  addServer: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/servers', { name: a.name, ip: a.ip }),
  deleteServer: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/servers?ip=' + encodeURIComponent(a.ip), {}),
  pingServer: (a) => api!.call('callBackend', '/instance/' + a.instanceId + '/files/server-ping?address=' + encodeURIComponent(a.address)),
  getSystemInfo: () => api!.call('callBackend', '/system/info'),
  getLauncherSettings: () => api!.call('callBackend', '/settings'),
  getConnectorStatus: () => api!.call('callBackend', '/connector/status'),
  hostRoom: (a) => {
    if (a.port) return api!.call('callBackend', '/connector/host/port', { port: a.port })
    return api!.call('callBackend', '/connector/host/instance', { instanceId: a.instanceId })
  },
  joinRoom: (a) => api!.call('callBackend', '/connector/join', { code: a.code }),
  getNatType: () => api!.call('callBackend', '/connector/nat-type'),
  checkHealth: () => api!.call('callBackend', '/health'),
  listPlugins: () => api!.call('callBackend', '/plugins'),
  listLogs: () => api!.call('callBackend', '/logs'),
  installModpack: (a) => {
    if (!a.id || !a.gameDir) return { error: 'id 和 gameDir 必填' }
    const local = !!(a.path && a.path.trim())
    const online = !!(a.type && a.projectId && a.fileId)
    if (!local && !online) return { error: '必须提供本地整合包 path，或在线整合包的 type/projectId/fileId' }
    const opts: Record<string, unknown> = {
      id: a.id,
      gameDir: a.gameDir,
      versionIsolation: a.versionIsolation !== undefined ? a.versionIsolation : true,
      maxMemory: a.maxMemory || 4096,
    }
    if (local) opts.path = a.path
    else {
      opts.type = a.type
      opts.projectId = a.projectId
      opts.fileId = a.fileId
    }
    return api!.call('modpack.install', opts).catch((e: any) => {
      return { error: '整合包安装启动失败: ' + e.message }
    })
  },
  addCustomJava: (a) => api!.call('callBackend', '/java/custom', { path: a.path }),
  listLoaderVersions: (a) => {
    let p = 'gameVersion=' + encodeURIComponent(a.gameVersion)
    if (a.loader) p += '&loader=' + a.loader
    return api!.call('callBackend', '/loaders/versions?' + p)
  },
  getVersionMetadata: (a) => api!.call('callBackend', '/versions/' + a.name),
  checkUpdate: (a) => {
    let p = ''
    if (a.current) p += 'current=' + encodeURIComponent(a.current)
    if (a.channel) p += (p ? '&' : '') + 'channel=' + encodeURIComponent(a.channel)
    return api!.call('callBackend', '/update/check' + (p ? '?' + p : ''))
  },
  searchWiki: (a) => {
    const limit = Math.min(a.limit || 5, 10)
    return wikiAPI('https://zh.minecraft.wiki/api.php?action=query&list=search&srsearch=' + encodeURIComponent(a.keyword) + '&srlimit=' + limit).then(
      (d) => {
        const items = (d.query && d.query.search) || []
        return items.map((i: any) => ({ title: i.title, snippet: i.snippet.replace(/<[^>]+>/g, '') }))
      }
    )
  },
  getWikiContent: (a) => {
    let url = 'https://zh.minecraft.wiki/api.php?action=parse&page=' + encodeURIComponent(a.title) + '&prop=wikitext'
    if (a.section) url += '&section=' + encodeURIComponent(a.section)
    return wikiAPI(url).then((d) => {
      const t = d.parse && d.parse.wikitext && d.parse.wikitext['*']
      if (!t) return { error: '未找到页面 ' + a.title }
      return { title: d.parse.title, content: t.slice(0, 6000) }
    })
  },
  searchMcMod: (a) => {
    const key = (a.keyword || '').trim()
    if (!key) return { error: '请输入搜索关键词' }
    return mcmodSearch(key)
  },
  getMcmodContent: (a) => {
    const url = (a.url || '').trim()
    if (!/^https?:\/\/(www\.)?mcmod\.cn\//.test(url)) return { error: '请输入有效的 mcmod.cn 链接' }
    const ck = 'mcmod:content:' + url
    return cacheGet(ck)
      .then((cached) => {
        if (cached) {
          const c: any = cached
          c.url = url
          return c
        }
        return mcmodThrottle().then(() => api!.call('proxyFetch', { url: url, method: 'GET', timeoutMs: 20000 })).then((res: any) => {
          if (!res || res.status !== 200) throw new Error('mcmod 返回 ' + (res && res.status))
          const data = extractMcmodContent(res.body || '')
          data.url = url
          cacheSet(ck, data, 86400)
          return data
        })
      })
      .catch((e) => {
        return { error: 'MC百科请求失败（可能被限流）: ' + e.message }
      })
  },
  sendNotification: (a) => {
    api!.call('showToast', a.message, a.type || 'info')
    return { success: true }
  },
  navigateTo: (a) => {
    api!.call('navigate', a.path)
    return { success: true, path: a.path }
  },
  callBackendApi: (a) => {
    if (a.method === 'GET') return api!.call('callBackend', a.endpoint)
    return api!.call('callBackend', a.endpoint, a.data ? JSON.parse(a.data) : undefined)
  },
  bingSearch: (a) => {
    const key = (a.keyword || '').trim()
    if (!key) return { error: '请输入搜索关键词' }
    const limit = Math.min(a.limit || 5, 10)
    const ck = 'bing:' + key + ':' + limit
    return cacheGet(ck)
      .then((cached) => {
        if (cached) return cached
        return api!
          .call('proxyFetch', {
            url: 'https://cn.bing.com/search?q=' + encodeURIComponent(key) + '&format=rss&count=' + limit,
            method: 'GET',
            headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
            timeoutMs: 20000,
          })
          .then((res: any) => {
            if (!res || res.status !== 200) throw new Error('bing 返回 ' + (res && res.status))
            const results = parseBingRss(res.body || '')
            const out = {
              keyword: key,
              results: results,
              _hint: '以下是搜索候选项，snippet 仅为摘要。请用 fetchWeb 抓取最相关的 1-2 个结果核实内容后再回答，不要仅凭摘要下结论。',
            }
            if (results.length) cacheSet(ck, out, 86400)
            return out
          })
      })
      .catch((e) => {
        return { keyword: key, error: '搜索失败: ' + e.message }
      })
  },
  fetchWeb: (a) => {
    const url = (a.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return { error: '请输入有效的 http/https URL' }
    const maxLen = Math.min(a.maxLength || 8000, 30000)
    const ck = 'web:' + url
    return cacheGet(ck)
      .then((cached) => {
        if (cached) return cached
        return api!.call('proxyFetch', { url: url, method: 'GET', timeoutMs: 20000 }).then((res: any) => {
          if (!res || res.status !== 200) throw new Error('HTTP ' + (res && res.status))
          const body = res.body || ''
          if (isBilibiliArticle(url)) {
            const art = htmlToText(body)
            const out = { url: url, title: extractTitle(body), isArticle: true, content: art.slice(0, maxLen), truncated: art.length > maxLen }
            cacheSet(ck, out, 3600)
            return out
          }
          if (isVideoSite(url)) {
            const meta = extractMeta(body)
            const out = { url: url, isVideo: true, videoTitle: meta.title, videoDescription: meta.description.slice(0, 500), content: '' }
            cacheSet(ck, out, 3600)
            return out
          }
          const text = htmlToText(body)
          const out = { url: url, title: extractTitle(body), content: text.slice(0, maxLen), truncated: text.length > maxLen }
          cacheSet(ck, out, 3600)
          return out
        })
      })
      .catch((e) => {
        return { url: url, error: '抓取失败（可能被拒绝访问或需要 JS 渲染）: ' + e.message }
      })
  },
  readFile: (a) => {
    const path = (a.path || '').trim()
    if (!path) return { error: '请输入文件路径' }
    return api!
      .call('readText', path)
      .then((file: any) => {
        return file ? file.content : ''
      })
      .catch((e: any) => {
        return { error: '读取失败: ' + (e && e.message || String(e)) }
      })
  },
  convertDocument: (a) => {
    const path = (a.path || '').trim()
    if (!path) return { error: '请输入文件路径' }
    const fileName = path.split(/[\\/]/).pop() || 'file'
    return api!
      .call('readBytes', path)
      .then((file: any) => {
        if (!file || file.contentBase64 == null || file.contentBase64 === '') throw new Error('文件为空或读取失败')
        return api!.call('callPlugin', 'top.qomicex.markitdown', 'convertFile', {
          base64: file.contentBase64,
          fileName: fileName,
        })
      })
      .then((r: any) => {
        if (!r) throw new Error('MarkItDown 返回空结果')
        if (r.error) throw new Error(r.error)
        return { path: path, format: r.format, title: r.title, markdown: r.markdown }
      })
      .catch((e: any) => {
        const msg = e && e.message || String(e)
        if (msg.indexOf('FS_AUTHORIZATION_REQUIRED') >= 0) {
          return { error: '需要授权访问该路径（启动器已弹出授权窗口，允许后重试）: ' + path }
        }
        if (/未提供方法|not initialized|未安装/.test(msg)) {
          return {
            error:
              'MarkItDown 插件不可用（' +
              msg +
              '）。请在「设置 → 插件」确认 top.qomicex.markitdown 已安装并启用；若已启用仍失败，说明启动器未加载该库插件，请改用 readFile 或反馈该问题。',
          }
        }
        return { error: 'MarkItDown 转换失败: ' + msg }
      })
  },
  writeFile: (a) => {
    const path = (a.path || '').trim()
    if (!path) return { error: '请输入文件路径' }
    return api!.call('writeText', path, a.content === undefined ? '' : String(a.content)).catch((e: any) => {
      return { error: '写入失败: ' + (e && e.message || String(e)) }
    })
  },
  deleteFile: (a) => {
    const path = (a.path || '').trim()
    if (!path) return { error: '请输入文件路径' }
    return api!.call('deleteFile', path).catch((e: any) => {
      return { error: '删除失败: ' + e.message }
    })
  },
  execCommand: (a) => {
    const cmd = (a.command || '').trim()
    if (!cmd) return { error: '请输入要执行的命令' }
    return api!.call('execCommand', cmd, a.timeoutMs).catch((e: any) => {
      return { error: '执行失败: ' + e.message }
    })
  },
  sleep: (a) => {
    const ms = Math.max(100, Math.min(parseInt(a.durationMs) || 1000, 600000))
    return new Promise((resolve) => {
      setTimeout(() => resolve({ sleptMs: ms }), ms)
    })
  },
}

export { handlers }

export const toolNamesCN: Record<string, string> = {
  listInstances: '列出实例', getInstance: '实例详情', getInstanceLaunchProgress: '启动进度',
  createInstance: '创建实例', launchInstance: '启动实例', installInstance: '安装实例',
  searchResources: '搜索资源', getResourceDetail: '资源详情', getResourceVersions: '资源版本',
  getVersionDownloads: '版本下载', getResourceDependencies: '资源依赖', startDownload: '开始下载',
  getDownloadProgress: '下载进度', installMod: '安装模组',
  listMods: '列出模组', getModMetadata: '模组元数据', enableDisableMod: '启停模组',
  listInstanceFiles: '列出实例文件', listServers: '服务器列表',
  copySave: '复制存档', renameSave: '重命名存档', backupSave: '备份存档',
  addServer: '添加服务器', deleteServer: '删除服务器', pingServer: 'Ping 服务器',
  getSystemInfo: '系统信息', getLauncherSettings: '启动器设置', getConnectorStatus: '联机状态',
  hostRoom: '开房', joinRoom: '加入房间', getNatType: 'NAT 检测',
  checkHealth: '健康检查', listPlugins: '插件列表', listLogs: '日志列表',
  installModpack: '安装整合包', addCustomJava: '添加 Java', listLoaderVersions: '加载器版本',
  getVersionMetadata: '版本元数据', checkUpdate: '检查更新',
  searchWiki: 'Wiki 搜索', getWikiContent: 'Wiki 内容',
  searchMcMod: 'MC百科搜索', getMcmodContent: 'MC百科内容',
  sendNotification: '发送通知', navigateTo: '导航', callBackendApi: '调用后端',
  bingSearch: '网页搜索', fetchWeb: '抓取网页', readFile: '读取文件', convertDocument: '文档转换',
  writeFile: '写入文件', deleteFile: '删除文件', execCommand: '执行命令', sleep: '延迟等待',
}