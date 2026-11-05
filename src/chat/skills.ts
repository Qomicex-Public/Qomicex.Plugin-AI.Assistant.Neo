import { getApi } from '../api.ts'
import { getRegisteredSkills, subscribeRegistry } from './registry.ts'
import { parseSkillMarkdown, SKILL_FILE_MAX } from './skillFormat.ts'

/**
 * Skill：目录 + 渐进式加载。
 *
 * 关键设计（与产品决策一致）：
 *   - 启动时只把「名称 + 描述」注入系统提示词，正文永远不进提示词。
 *   - 模型需要时调用 `Skill` 工具按名字加载全文（单次最多 24KB）。
 *   - 三个来源合并：内置（打包进 JS）、用户目录（settings.skillsDir）、
 *     第三方插件运行期注册（registry.ts）。
 *   - 目录构建有模块级缓存：buildSystemPrompt 每轮都会跑，不能每轮扫盘。
 */

export const SKILL_CONTENT_LIMIT = 24 * 1024
const PROMPT_MAX_SKILLS = 30
const PROMPT_DESC_MAX = 200
const USER_SCAN_MAX_ENTRIES = 400
const USER_SKILL_MAX = 100

export type SkillSource = 'builtin' | 'user' | string

export interface SkillFile {
  /** 相对技能目录的路径 */
  path: string
  /** 插件注册时内联的文件内容；用户目录扫描时为空（让模型用 Read 读） */
  content?: string
}

export interface SkillEntry {
  /** 稳定 id：builtin:<name> / user:<SKILL.md 路径> / plugin:<provider>/<id> */
  id: string
  name: string
  description: string
  whenToUse?: string
  version?: number
  /** builtin / user / plugin:<providerId> */
  source: SkillSource
  /** 可访问的技能目录；内置或插件内联技能为空 */
  baseDir?: string
  content: string
  files: SkillFile[]
  /** 缺 description 等导致不可用的原因 */
  warning?: string
  available: boolean
  verified?: boolean
}

export interface SkillCatalog {
  skills: SkillEntry[]
  errors: string[]
}

// ---------- 设置快照 ----------
interface SkillSettings {
  enabled: boolean
  dir: string
  disabled: string[]
}

let settings: SkillSettings = { enabled: true, dir: '', disabled: [] }
let cache: SkillCatalog | null = null
let loading: Promise<SkillCatalog> | null = null

export function configureSkills(next: { enabled?: boolean; dir?: string; disabled?: string[] }): void {
  const merged: SkillSettings = {
    enabled: next.enabled !== undefined ? next.enabled === true : settings.enabled,
    dir: next.dir !== undefined ? String(next.dir || '').trim() : settings.dir,
    disabled: next.disabled !== undefined ? (Array.isArray(next.disabled) ? next.disabled.map(String) : []) : settings.disabled,
  }
  const changed =
    merged.enabled !== settings.enabled ||
    merged.dir !== settings.dir ||
    JSON.stringify(merged.disabled) !== JSON.stringify(settings.disabled)
  settings = merged
  if (changed) cache = null
}

export function getSkillSettings(): SkillSettings {
  return { ...settings, disabled: settings.disabled.slice() }
}

export function invalidateSkillsCache(): void {
  cache = null
}

// 第三方注册表变化时让目录失效（注册是内存态，外部无法感知）
subscribeRegistry(() => {
  cache = null
})

// ---------- frontmatter（实现见 skillFormat.ts，内置与注册共用） ----------
export { parseSkillMarkdown }

function toEntry(
  raw: string,
  opts: { id: string; source: SkillSource; fallbackName: string; baseDir?: string; files?: SkillFile[]; verified?: boolean },
): SkillEntry {
  const { meta, body } = parseSkillMarkdown(raw)
  const name = (meta.name || opts.fallbackName || '').trim().slice(0, 64)
  const description = (meta.description || '').trim()
  const version = Number(meta.version)
  const oversized = raw.length > SKILL_FILE_MAX
  const warning = !description
    ? '缺少 description，已跳过（请补上 frontmatter 的 description）'
    : oversized
      ? `SKILL.md 超过 ${Math.round(SKILL_FILE_MAX / 1024)}KB，已截断`
      : undefined
  const content = oversized ? body.slice(0, SKILL_FILE_MAX) : body
  return {
    id: opts.id,
    name: name || opts.fallbackName,
    description: description.slice(0, 500),
    whenToUse: meta.whentouse || meta['when-to-use'] || undefined,
    version: Number.isFinite(version) ? version : undefined,
    source: opts.source,
    baseDir: opts.baseDir,
    content,
    files: opts.files || [],
    warning,
    // 缺 description 属于致命问题；超长只截断，仍可用
    available: !!description,
    verified: opts.verified,
  }
}

// ---------- 内置技能（打包进 JS，只读） ----------
const builtinRaw = import.meta.glob('../skills/**/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function builtinSkills(): SkillEntry[] {
  const out: SkillEntry[] = []
  for (const [file, raw] of Object.entries(builtinRaw)) {
    // ../skills/<dir>/SKILL.md → <dir>
    const parts = file.split('/')
    const dir = parts.length >= 2 ? parts[parts.length - 2] : 'skill'
    out.push(
      toEntry(String(raw || ''), {
        id: 'builtin:' + dir,
        source: 'builtin',
        fallbackName: dir,
      }),
    )
  }
  return out
}

// ---------- 用户目录 ----------
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : ''
}

function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/'
}

interface UserScan {
  skills: SkillEntry[]
  errors: string[]
}

async function scanUserDir(dir: string): Promise<UserScan> {
  const errors: string[] = []
  const skills: SkillEntry[] = []
  if (!dir) return { skills, errors }
  const api = getApi()
  if (!api || !api.call) {
    return { skills, errors: ['插件 API 桥接不可用，无法读取用户技能目录'] }
  }
  let entries: any[] = []
  try {
    const r: any = await api.call('listDir', dir, { recursive: true, maxEntries: USER_SCAN_MAX_ENTRIES })
    entries = Array.isArray(r) ? r : Array.isArray(r && r.entries) ? r.entries : []
  } catch (e: any) {
    const msg = String((e && e.message) || e || '')
    errors.push(
      msg.includes('FS_AUTHORIZATION_REQUIRED')
        ? `技能目录需要授权：${dir}（启动器已弹窗，允许后点「重新扫描」）`
        : `扫描技能目录失败：${dir}（${msg || '未知错误'}）`,
    )
    return { skills, errors }
  }

  const skillFiles = entries.filter(
    (e) => e && !e.isDir && String(e.name || '').toLowerCase() === 'skill.md',
  )
  for (const entry of skillFiles.slice(0, USER_SKILL_MAX)) {
    const path = String(entry.path || '')
    if (!path) continue
    const baseDir = dirnameOf(path)
    const sep = sepOf(path)
    const files: SkillFile[] = entries
      .filter((e) => {
        if (!e || e.isDir) return false
        const p = String(e.path || '')
        return p !== path && p.startsWith(baseDir + sep)
      })
      .slice(0, 30)
      .map((e) => ({ path: String(e.path || '').slice(baseDir.length + 1) }))
    try {
      const file: any = await api.call('readText', path)
      const raw = String(file?.content ?? '')
      if (!raw.trim()) {
        errors.push(`技能文件为空：${path}`)
        continue
      }
      skills.push(
        toEntry(raw, {
          id: 'user:' + path,
          source: 'user',
          fallbackName: baseDir.split(/[\\/]/).pop() || 'skill',
          baseDir,
          files,
        }),
      )
    } catch (e: any) {
      const msg = String((e && e.message) || e || '')
      errors.push(
        msg.includes('FS_AUTHORIZATION_REQUIRED')
          ? `读取技能需要授权：${path}（启动器已弹窗，允许后点「重新扫描」）`
          : `读取技能失败：${path}（${msg || '未知错误'}）`,
      )
    }
  }
  return { skills, errors }
}

// ---------- 合并 ----------
function priorityOf(source: string): number {
  if (source === 'builtin') return 0
  if (source === 'user') return 1
  return 2
}

function dedupe(list: SkillEntry[]): SkillEntry[] {
  const sorted = list.slice().sort((a, b) => {
    const d = priorityOf(a.source) - priorityOf(b.source)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })
  const used = new Set<string>()
  for (const s of sorted) {
    let name = s.name
    if (used.has(name)) {
      let i = 2
      while (used.has(`${name}#${i}`)) i++
      name = `${name}#${i}`
      s.name = name.slice(0, 64)
    }
    used.add(s.name)
  }
  return sorted
}

function pluginSkills(): SkillEntry[] {
  return getRegisteredSkills().map((s) => ({
    id: `plugin:${s.providerId}/${s.id}`,
    name: s.name,
    description: s.description,
    source: 'plugin:' + s.providerId,
    whenToUse: undefined,
    content: s.content,
    files: (s.files || []).map((f) => ({ path: f.path, content: f.content })),
    warning: undefined,
    available: s.enabled !== false,
    verified: s.verified,
  }))
}

async function buildCatalog(): Promise<SkillCatalog> {
  const errors: string[] = []
  const list: SkillEntry[] = [...builtinSkills()]

  if (settings.dir) {
    const scan = await scanUserDir(settings.dir)
    list.push(...scan.skills)
    errors.push(...scan.errors)
  }
  list.push(...pluginSkills())

  const deduped = dedupe(list)
  // 禁用列表按 id 生效（禁用的技能既不进提示词目录，也不能被 Skill 工具加载）
  const disabled = new Set(settings.disabled)
  for (const s of deduped) {
    if (disabled.has(s.id)) {
      s.available = false
      s.warning = s.warning || '已在设置中禁用'
    }
  }
  return { skills: deduped, errors }
}

export function getSkillCatalog(force = false): Promise<SkillCatalog> {
  if (force) cache = null
  if (cache) return Promise.resolve(cache)
  if (loading) return loading
  loading = buildCatalog()
    .then((r) => {
      cache = r
      return r
    })
    .catch((e) => {
      const r: SkillCatalog = { skills: [], errors: ['技能扫描失败：' + String((e && e.message) || e || '未知错误')] }
      cache = r
      return r
    })
    .finally(() => {
      loading = null
    })
  return loading
}

export async function refreshSkills(): Promise<SkillCatalog> {
  return getSkillCatalog(true)
}

/** 系统提示词里的稳定章节。内容不随时间/随机值变化，利于前缀缓存。 */
export async function skillsPromptSection(): Promise<string> {
  if (!settings.enabled) return ''
  const catalog = await getSkillCatalog()
  const available = catalog.skills.filter((s) => s.available)
  if (!available.length) return ''
  const lines = [
    '',
    '## 可用技能',
    '需要时调用 Skill 工具加载全文；不要凭名称臆测内容。',
  ]
  for (const s of available.slice(0, PROMPT_MAX_SKILLS)) {
    const desc = s.description.length > PROMPT_DESC_MAX ? s.description.slice(0, PROMPT_DESC_MAX) + '…' : s.description
    const src = s.source === 'builtin' ? 'builtin' : s.source === 'user' ? 'user' : s.source
    lines.push(`- ${s.name}: ${desc}（来源: ${src}）`)
  }
  if (available.length > PROMPT_MAX_SKILLS) {
    lines.push(`（共 ${available.length} 个技能，提示词只列出前 ${PROMPT_MAX_SKILLS} 个；其余请让用户缩小技能目录或禁用部分技能）`)
  }
  return lines.join('\n')
}

/** Skill 工具是否值得挂给模型（同步读缓存；buildSystemPrompt 会先预热目录）。 */
export function isSkillToolAvailable(): boolean {
  if (!settings.enabled) return false
  if (!cache) return false
  return cache.skills.some((s) => s.available)
}

// ---------- Skill 工具 ----------
export async function toolSkill(a: { name?: string }): Promise<unknown> {
  const key = String(a.name || '').trim()
  if (!key) return { error: 'name 必填（系统提示词的「可用技能」里有名称）' }
  if (!settings.enabled) return { error: '技能功能已在设置中关闭' }
  const catalog = await getSkillCatalog()
  const found =
    catalog.skills.find((s) => s.id === key) ||
    catalog.skills.find((s) => s.name === key) ||
    catalog.skills.find((s) => s.name.toLowerCase() === key.toLowerCase())
  if (!found) {
    const names = catalog.skills.filter((s) => s.available).slice(0, 10).map((s) => s.name)
    return {
      error:
        `未找到技能「${key}」。` +
        (names.length ? '可用技能：' + names.join('、') : '当前没有可用技能。') +
        '请只用系统提示词里列出的名称，不要臆测。',
    }
  }
  if (!found.available) {
    return { error: `技能「${found.name}」不可用：${found.warning || '已被禁用'}` }
  }

  const truncated = found.content.length > SKILL_CONTENT_LIMIT
  let content = truncated ? found.content.slice(0, SKILL_CONTENT_LIMIT) : found.content
  if (truncated) {
    content +=
      `\n\n（正文超过 ${Math.round(SKILL_CONTENT_LIMIT / 1024)}KB，已截断。` +
      (found.baseDir ? `原文在 ${found.baseDir}\\SKILL.md，请用 Read 分段读取。` : '完整正文不可通过其他方式读取。') +
      '）'
  }
  const fileLines = found.files.length
    ? '\n\n附带文件：\n' + found.files.map((f) => '- ' + f.path).join('\n')
    : ''
  const dirLine = found.baseDir
    ? `技能目录：${found.baseDir}（可用 Read 读取 references/、scripts/ 下的文件）`
    : '没有可访问的磁盘目录，正文已完整内联。'
  return {
    name: found.name,
    source: found.source,
    baseDir: found.baseDir || '',
    truncated,
    content,
    files: found.files,
    __ui_summary: `加载技能 ${found.name}`,
    __raw_text: `技能：${found.name}（来源 ${found.source}）\n${dirLine}\n\n${content}${fileLines}`,
  }
}

// ---------- 设置页 ----------
export interface SkillConfigItem {
  id: string
  name: string
  description: string
  source: string
  enabled: boolean
  warning?: string
  verified?: boolean
}

export async function listSkillsForConfig(): Promise<{ skills: SkillConfigItem[]; errors: string[] }> {
  const catalog = await getSkillCatalog()
  return {
    errors: catalog.errors,
    skills: catalog.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      enabled: s.available,
      warning: s.warning,
      verified: s.verified,
    })),
  }
}

/** 「重新扫描」按钮：按当前输入框里的目录扫描，不改配置、不动缓存。 */
export async function previewSkills(dir: string): Promise<{ skills: SkillEntry[]; errors: string[] }> {
  const scan = await scanUserDir(String(dir || '').trim())
  return { skills: dedupe(scan.skills), errors: scan.errors }
}
