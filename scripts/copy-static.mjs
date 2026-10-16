// 把仓库根的 theme.css 拷进 dist/（manifest entry.theme 指向 dist/theme.css）。
// 正式发布时 `qomicex pack` 也会做这件事；此处保证本地 build 产物自洽、可手工部署调试。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'theme.css')
const distDir = resolve(root, 'dist')
const dst = resolve(distDir, 'theme.css')

if (!existsSync(src)) {
  console.warn('[copy-static] 未找到 theme.css，跳过')
  process.exit(0)
}
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
copyFileSync(src, dst)
console.log('[copy-static] theme.css → dist/theme.css')
