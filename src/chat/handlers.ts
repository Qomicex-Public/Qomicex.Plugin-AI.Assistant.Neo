import type { PluginApi } from '../api.ts'
import * as fileTools from './fileTools.ts'
import { isUiControlEnabled } from './uiControl.ts'
import { runAgent, readShotDataUrl, type AgentResult } from './uiAgent.ts'

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

// ---------- 启动器操作（UI 自动化）----------

/**
 * 工具结果里给模型看的正文预算（字符）。
 *
 * 引擎对工具结果统一有 4000 字符上限，界面快照这类结果必须自己排版并按预算裁剪，
 * 否则会被从中间截断 —— 截到一半的元素行连 ref 都不完整，模型只能瞎猜。
 * 留 400 字符余量给头尾说明。
 */
const UI_TEXT_BUDGET = 3600

function uiGate(): { error: string } | null {
  if (isUiControlEnabled()) return null
  return {
    error:
      '「启动器操作」开关未开启，不能操作启动器界面。' +
      '请让用户在插件设置里打开「允许操作启动器界面」（聊天里的设置视图或启动器的插件设置页均可）后重试。',
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function short(s: unknown, n: number): string {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 驱动失败 → 模型看得懂的错误（界面类结果一律带 __ui_text，引擎会原样转发）。 */
function uiFail(r: AgentResult): { error: string; __ui_text: string } {
  const code = r.code || 'E_UNKNOWN'
  const hint =
    code === 'E_STALE_REF'
      ? '（ref 已失效：界面变了。请重新 UiSnapshot 拿新 ref，不要复用旧 ref）'
      : code === 'E_NO_WINDOW'
        ? '（没找到启动器窗口，请确认启动器正在运行）'
        : code === 'E_NO_ROOT'
          ? '（无法定位启动器网页内容；可先 UiFocus 激活窗口再重试）'
          : ''
  const msg = `${r.error || '界面操作失败'}${hint}`
  return { error: msg, __ui_text: `ERROR[${code}] ${msg}` }
}

/** 快照的一行元素：ref 类型 "名称" @x,y wxh [可用动作] */
function fmtElement(el: any): string {
  const r = Array.isArray(el?.rect) ? el.rect : []
  const rect = r.length >= 4 ? `${r[0]},${r[1]} ${r[2]}x${r[3]}` : '?'
  const acts = Array.isArray(el?.actions) && el.actions.length ? ` [${el.actions.join(',')}]` : ''
  const val = el?.value ? ` value="${short(el.value, 28)}"` : ''
  const off = el?.enabled === false ? ' (已禁用)' : ''
  return `${el?.ref}\t${el?.type} "${short(el?.name, 44)}"${off}${val} @${rect}${acts}`
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
        /**
         * 用 www.bing.com：cn.bing.com/search?...&format=rss 会返回 301 跳转，
         * 而启动器 proxyFetch 不跟随重定向（拿到的是空 body 的 301）。
         * www.bing.com 直接 200 并返回 RSS。
         */
        const buildUrl = (host: string) =>
          'https://' + host + '/search?q=' + encodeURIComponent(key) + '&format=rss&count=' + limit

        const attempt = (host: string) =>
          api!
            .call('proxyFetch', {
              url: buildUrl(host),
              method: 'GET',
              headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
              timeoutMs: 20000,
            })
            .then((res: any) => {
              const status = res && res.status
              const body = String((res && res.body) || '')
              // 3xx：换 host 重试一次（代理不跟随重定向）
              if (status >= 300 && status < 400) return { redirect: true, status }
              if (status !== 200) throw new Error('bing 返回 ' + status)
              if (!body) throw new Error('bing 返回空响应')
              return { body }
            })

        return attempt('www.bing.com').then((r: any) => {
          if (r.redirect) return attempt('cn.bing.com')
          return r
        })
          .then((r: any) => {
            if (r.redirect) throw new Error('bing 返回 ' + r.status + '（重定向未跟随）')
            const results = parseBingRss(r.body)
            if (results.length === 0) {
              return { keyword: key, results: [], _hint: '未解析到结果，可能被反爬拦截；可改用 fetchWeb 直接抓取已知站点。' }
            }
            const out = {
              keyword: key,
              results: results.slice(0, limit),
              _hint: '以下是搜索候选项，snippet 仅为摘要。请用 fetchWeb 抓取最相关的 1-2 个结果核实内容后再回答，不要仅凭摘要下结论。',
            }
            cacheSet(ck, out, 86400)
            return out
          })
      })
      .catch((e) => {
        return { keyword: key, error: '搜索失败: ' + (e && e.message ? e.message : String(e)) }
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
  Read: (a) => fileTools.toolRead(a),
  Write: (a) => fileTools.toolWrite(a),
  Edit: (a) => fileTools.toolEdit(a),
  Grep: (a) => fileTools.toolGrep(a),
  Bash: (a) => fileTools.toolBash(a),
  Compress: (a) => fileTools.toolCompress(a),
  Decompress: (a) => fileTools.toolDecompress(a),
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
  sleep: (a) => {
    const ms = Math.max(100, Math.min(parseInt(a.durationMs) || 1000, 600000))
    return new Promise((resolve) => {
      setTimeout(() => resolve({ sleptMs: ms }), ms)
    })
  },

  // ---------- 启动器操作（6 个）----------
  // 结果里的 __ui_summary / __ui_text / __ui_image 是给引擎看的约定字段：
  //   __ui_summary → 工具卡片上的一行摘要
  //   __ui_text    → 发给模型的正文（本模块已按 UI_TEXT_BUDGET 排好版）
  //   __ui_image   → 截图 data URL，由引擎摘出来单独作为图片消息发送

  UiSnapshot: async (a) => {
    const deny = uiGate()
    if (deny) return deny
    const r = await runAgent('snapshot', {
      interactiveOnly: a.interactiveOnly !== false,
      max: clampInt(a.max, 60, 1, 200),
      offset: clampInt(a.offset, 0, 0, 1000000),
      keyword: typeof a.keyword === 'string' ? a.keyword : '',
    })
    if (r.ok === false) return uiFail(r)
    const els: any[] = Array.isArray(r.elements) ? r.elements : []
    const lines: string[] = []
    let used = 0
    for (const el of els) {
      const line = fmtElement(el)
      if (used + line.length + 1 > UI_TEXT_BUDGET) break
      lines.push(line)
      used += line.length + 1
    }
    const start = Number(r.offset) || 0
    const total = Number(r.total) || 0
    const nextOffset = start + lines.length
    const more = nextOffset < total
    const head =
      `启动器窗口「${r.window?.title ?? '?'}」共 ${total} 个可交互元素，本次给出第 ${start}~${nextOffset - 1} 个。\n` +
      '每行格式：ref  类型 "名称" @x,y 宽x高 [可用动作]\n'
    const tail = more
      ? `\n…还有 ${total - nextOffset} 个未给出；需要时再 UiSnapshot(offset=${nextOffset}${a.keyword ? `, keyword="${a.keyword}"` : ''})`
      : ''
    return {
      ok: true,
      total,
      offset: start,
      shown: lines.length,
      nextOffset: more ? nextOffset : null,
      __ui_summary: `界面快照：${total} 个元素，给出 ${lines.length} 条`,
      __ui_text: head + lines.join('\n') + tail,
    }
  },

  UiClick: async (a) => {
    const deny = uiGate()
    if (deny) return deny
    const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
    const hasXY = a.x !== undefined && a.y !== undefined && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))
    if (!ref && !hasXY) return { error: '需要 ref（来自 UiSnapshot）或 x/y 屏幕坐标' }
    const r = await runAgent('click', {
      ref: ref || undefined,
      x: hasXY ? Math.round(Number(a.x)) : undefined,
      y: hasXY ? Math.round(Number(a.y)) : undefined,
      mode: a.mode === 'invoke' ? 'invoke' : 'mouse',
      moveMs: clampInt(a.moveMs, 420, 0, 5000),
    })
    if (r.ok === false) return uiFail(r)
    const d = r.diff || {}
    const appeared =
      Array.isArray(d.appeared) && d.appeared.length
        ? `；新出现：${d.appeared.map((s: string) => short(s, 22)).join(' | ')}`
        : ''
    const t = r.target
    const what = t ? `${t.type} "${short(t.name, 40)}"` : `坐标 ${(r.point || []).join(',')}`
    return {
      ok: true,
      method: r.method,
      point: r.point,
      foreground: r.foreground,
      diff: r.diff,
      __ui_summary: `已点击 ${what}`,
      __ui_text:
        `已点击 ${what}（方式 ${r.method}${r.foreground === false ? '；注意：窗口未在前台，操作可能未生效' : ''}）。` +
        `界面变化：新增 ${d.addedCount ?? 0} / 消失 ${d.removedCount ?? 0}${appeared}`,
    }
  },

  UiType: async (a) => {
    const deny = uiGate()
    if (deny) return deny
    const text = a.text === undefined || a.text === null ? '' : String(a.text)
    if (!text) return { error: 'text 必填' }
    const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
    const r = await runAgent('type', {
      text,
      ref: ref || undefined,
      clear: a.clear !== false,
      moveMs: clampInt(a.moveMs, 360, 0, 5000),
    })
    if (r.ok === false) return uiFail(r)
    const target = r.target ? `${r.target.type} "${short(r.target.name, 40)}"` : '当前焦点控件'
    return {
      ok: true,
      method: r.method,
      valueAfter: r.valueAfter,
      __ui_summary: `已输入 ${r.typed ?? text.length} 个字符`,
      __ui_text:
        `已向 ${target} 输入 ${r.typed ?? text.length} 个字符（方式 ${r.method}）。` +
        (r.valueAfter !== undefined ? `输入后该控件值为 "${short(r.valueAfter, 60)}"。` : '') +
        (r.pasteError ? `注意：剪贴板粘贴失败（${short(r.pasteError, 80)}），已降级为直接赋值，部分控件可能不接受。` : ''),
    }
  },

  UiKeys: async (a) => {
    const deny = uiGate()
    if (deny) return deny
    const keys = a.keys === undefined || a.keys === null ? '' : String(a.keys)
    if (!keys) return { error: 'keys 必填，例如 "{ENTER}"、"{TAB}"、"^s"' }
    const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
    const r = await runAgent('keys', { keys, ref: ref || undefined, moveMs: clampInt(a.moveMs, 320, 0, 5000) })
    if (r.ok === false) return uiFail(r)
    return {
      ok: true,
      sent: r.sent,
      __ui_summary: `已发送按键 ${keys}`,
      __ui_text: `已向启动器发送按键 ${r.sent ?? keys}。如需确认效果，请再用 UiSnapshot 或 UiScreenshot 复查。`,
    }
  },

  UiFocus: async () => {
    const deny = uiGate()
    if (deny) return deny
    const r = await runAgent('focus', {})
    if (r.ok === false) return uiFail(r)
    return {
      ok: true,
      foreground: r.foreground,
      window: r.window,
      __ui_summary: r.foreground ? '启动器已切到前台' : '置前未成功',
      __ui_text: r.foreground
        ? '启动器窗口已切到前台，可以继续操作。'
        : '已尝试把启动器切到前台，但它当前不是前台窗口（可能有别的窗口抢焦点），点击可能无效。',
    }
  },

  UiScreenshot: async () => {
    const deny = uiGate()
    if (deny) return deny
    const r = await runAgent('screenshot', {})
    if (r.ok === false) return uiFail(r)
    const dataUrl = await readShotDataUrl()
    if (!dataUrl) {
      const msg = '截图已生成，但读取截图文件失败。'
      return { error: msg, __ui_text: `ERROR[E_SHOT_READ] ${msg}` }
    }
    const kb = Math.round((Number(r.bytes) || 0) / 1024)
    return {
      ok: true,
      width: r.width,
      height: r.height,
      captured: r.captured,
      __ui_summary: `已截图 ${r.width}x${r.height}`,
      __ui_text: `截图已作为图片附加在对话中（${r.width}x${r.height}，${kb}KB，方式 ${r.captured}），你可以直接查看。`,
      __ui_image: dataUrl,
    }
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
  bingSearch: '网页搜索', fetchWeb: '抓取网页', Read: '读取文件', Write: '写入文件', Edit: '编辑文件',
  Grep: '搜索内容', Bash: '执行命令', Compress: '压缩', Decompress: '解压', convertDocument: '文档转换',
  sleep: '延迟等待',
  UiSnapshot: '界面快照', UiClick: '点击界面', UiType: '界面输入',
  UiKeys: '界面按键', UiFocus: '激活窗口', UiScreenshot: '界面截图',
}