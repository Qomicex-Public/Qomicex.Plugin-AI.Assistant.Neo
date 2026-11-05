/**
 * SKILL.md 的极小 frontmatter 解析（内置技能与第三方注册共用）。
 *
 * 只支持 `key: value` 单行；故意不引 YAML 依赖 —— frontmatter 是给模型看的
 * 元数据，不是配置系统。兼容 BOM 与 CRLF。
 */
export const SKILL_FILE_MAX = 64 * 1024

export interface ParsedSkill {
  meta: Record<string, string>
  body: string
}

function unquote(v: string): string {
  const s = String(v || '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

export function parseSkillMarkdown(raw: string): ParsedSkill {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const meta: Record<string, string> = {}
  let body = text
  if (lines.length > 1 && lines[0].trim() === '---') {
    let close = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        close = i
        break
      }
    }
    if (close > 0) {
      for (let i = 1; i < close; i++) {
        const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(lines[i])
        if (m) meta[m[1].toLowerCase()] = unquote(m[2])
      }
      body = lines.slice(close + 1).join('\n')
    }
  }
  return { meta, body }
}

export function stripSkillFrontmatter(raw: string): string {
  return parseSkillMarkdown(raw).body
}
