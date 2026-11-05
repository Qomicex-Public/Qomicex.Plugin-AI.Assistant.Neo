# AI 助手 (Assistant Neo)

Qomicex 启动器的 AI 助手插件，支持多模型对话、流式输出、工具调用、Markdown 渲染、技能（Skill）、MCP 与后台长任务。

## 功能

- 多模型支持（OpenAI / Ollama / 自定义兼容接口）
- 流式响应输出、思考过程展示
- 内置工具（实例 / 资源 / 文件 / 网络 / Wiki / UI 自动化等）
- **技能（Skill）**：目录 + 渐进式加载，启动只注入名称与描述
- **MCP（HTTP / SSE）**：工具发现与调用，支持第三方插件运行期注册
- **后台长任务**：`RunProcess` / `GetProcessLogs` / `StopProcess`，绕过 120 秒命令上限
- **开放注册接口**：其它插件可注册 Skill / MCP（`ai.*` 方法）
- Markdown / 代码高亮渲染、对话历史、配置持久化、悬浮窗模式

## 技术栈

- React 19 + TypeScript
- Vite
- Tailwind CSS
- `@qomicex/plugin-ui`

## 开发

```bash
pnpm install
pnpm run dev
```

## 构建

```bash
pnpm run build          # tsc + vite build + 生成 overlay-inline + 复制静态资源
qomicex verify          # manifest 校验
qomicex pack            # 打包 .qplugin
qomicex publish         # 签名并上传到商店
```

> `src/chat/overlay-inline.ts` 由 `scripts/gen-overlay-inline.mjs` 生成，不要手改。
>
> `manifest.json` 使用了 `process:manage`（长任务进程管理）。`@qomicex/cli` 需 ≥ 0.2.2；更旧的版本会提示「未知权限 / 声明但未使用」。

## 技能（Skill）

### 目录格式

```
<skillsRoot>/<技能目录>/SKILL.md
<skillsRoot>/<技能目录>/references/...
<skillsRoot>/<技能目录>/scripts/...
```

`SKILL.md` 的 frontmatter 只支持单行 `key: value`（不引 YAML 依赖）：

```markdown
---
name: mc-modpack-debug
description: 排查 Minecraft 整合包启动崩溃，定位日志中的模组冲突
whenToUse: 用户贴出 crash-report 或提到「启动崩溃」
version: 1
---
正文（Markdown）。用户目录技能可以引用同目录的 references/、scripts/ 文件（用 Read 读取）；内置技能没有磁盘目录，知识要点需写在正文里。
```

- 缺 `name` 时用目录名。
- 缺 `description` 时**不加载**，并在设置页标警告。
- 正文超过 24KB 时 `Skill` 工具只返回前 24KB，并提示用 `Read` 读原文。

### 三个来源

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 内置 | `src/skills/<dir>/SKILL.md` | 构建时通过 `import.meta.glob` 打进包，只读 |
| 用户目录 | 设置项 `skillsDir` | 递归扫描 `SKILL.md`（最多 400 条目），首次访问需启动器授权 |
| 第三方插件 | `ai.registerSkill` | 运行期注册，持久化到 cache，见下文 |

同名技能按「内置 → 用户 → 插件」优先，重复的自动加 `#2` 后缀。

### 内置技能

构建时随插件打包，运行时只读。当前内置：

| 技能 | 用途 |
| --- | --- |
| `mc-crash-debug` | 启动崩溃/闪退：日志定位、Java 对照、退出码、模组二分 |
| `mc-instance-setup` | 新建实例：版本/加载器/Java/内存选择，安装与启动验证 |
| `mc-mod-compat` | 模组版本/加载器/前置依赖匹配，去重与冲突排查 |
| `mc-mod-localization` | 模组汉化：现成资源包优先，提取 lang、生成覆盖资源包、校验 |
| `mc-modpack-install` | 本地/在线整合包安装、迁移与失败排查 |
| `mc-modpack-localization` | 整合包汉化：先找 VM/BBSMC/CFPA 现成包，再处理任务书/指南书 |
| `mc-server-connect` | 联机开房/加入服务器：NAT、端口、版本与模组对齐 |
| `mc-performance-tuning` | 低帧/卡顿诊断：CPU/GPU/内存瓶颈与最小改动优化 |
| `qomicex-diagnostics` | 启动器/插件问题：manifest、权限、代理、文件授权、进程 |
| `mc-knowledge-research` | Wiki/MC百科/网页交叉验证与规范输出 |

内置技能没有真实磁盘路径，`Skill` 工具会把正文完整内联；因此知识要点写在 `SKILL.md` 正文里，而不是 `references/`。

### 渐进式加载

- 系统提示词只列名称 + 描述（每条最多 200 字，最多 30 条）。
- 模型调用 `Skill(name)` 时才读取正文。
- 设置页可逐个禁用（存 `disabledSkills: string[]`），禁用后既不进目录也不能加载。

## 后台长任务

`Bash` 是同步调用，启动器硬限制 120 秒且超时丢弃全部输出。长命令请用：

- `RunProcess(command, cwd?)`：后台启动并立即返回 `pid`。Windows 用 `pwsh`，失败回退 `powershell.exe`；脚本经 UTF-16LE + base64 的 `-EncodedCommand` 传递，引号/换行/中文路径不会被拆坏。
- `GetProcessLogs(pid, afterSeq?)`：按 seq 游标增量读取；返回 `alive` / `exitCode` / `nextSeq` / `oldestSeq`。
- `StopProcess(pid)`：终止整棵进程树（幂等）。

需要 `process:manage` 权限（安装/更新时会提示）。

## MCP（HTTP / SSE）

设置项：

```jsonc
// settings.mcpEnabled: boolean
// settings.mcpServers: McpServerConfig[]
{
  "id": "my-server",
  "name": "My MCP",
  "url": "https://example.com/mcp",
  "headers": { "Authorization": "Bearer ..." },
  "enabled": true
}
```

行为：

- 仅支持 Streamable HTTP / SSE，**不支持 stdio**。
- `initialize` → `notifications/initialized` → `tools/list`（处理 `nextCursor`，上限 200 个工具）→ `tools/call`。
- 协议版本优先 `2025-06-18`，失败回退 `2025-03-26`；会话 id 从响应头 `Mcp-Session-Id` 取。
- 工具名 `mcp__<serverId>__<toolName>`（只保留 `[A-Za-z0-9_-]`，总长 ≤ 64，冲突加 `_2`）。
- 工具总数 > 40 或单服务器 > 25 时折叠为元工具 `McpListTools`：
  - 不传参：按服务器列出工具与参数结构；
  - 传 `serverId`：只看该服务器；
  - 传 `serverId + tool + arguments`：直接调用。
- 发现结果缓存 5 分钟，工具定义 30 秒；某台服务器失败只跳过该服务器，错误以工具结果/进度提示出现，不中断对话。
- 超时：`tools/list` 30s、`tools/call` 60s（启动器代理本身把 `timeoutMs` 夹在 60s 以内）。

### 本地 mock

```bash
node scripts/mock-mcp.mjs              # http://127.0.0.1:18765/mcp
MOCK_TOOL_COUNT=30 node scripts/mock-mcp.mjs   # 测试折叠模式
MOCK_SSE=1 node scripts/mock-mcp.mjs           # 测试 SSE 解析
MOCK_STATUS=401 node scripts/mock-mcp.mjs      # 测试错误兜底
```

启动器的 CORS 代理**禁止内网/回环地址**（`PROXY_PRIVATE_ADDRESS`），所以真实启动器里不能直连 127.0.0.1。mock 主要用于：

1. `pnpm dev` 浏览器直开模式（没有 `__PLUGIN_API__` 时 MCP 客户端退回原生 `fetch`）；
2. 单独验证协议逻辑。

真实环境请部署到可公网访问的 HTTPS 地址。

## 第三方注册接口

AI 助手以**被调方**身份注册以下方法（运行期 `registerMethod`，不改 manifest、不改启动器）：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `ai.capabilities` | 无 | `{ version: 1, accepts: ['skill','mcp'], maxSkillBytes, maxServers }` |
| `ai.registerSkill` | skill payload | `{ ok: true, id }` / `{ ok: false, error }` |
| `ai.registerMcp` | mcp payload | `{ ok: true, id }` / `{ ok: false, error }` |
| `ai.unregister` | `{ providerId, type, id }` | `{ ok: true, removed }` |
| `ai.list` | 无 | `{ skills: SkillMeta[], mcp: McpMeta[] }` |

### 最小示例

```ts
const api = window.__PLUGIN_API__
api.registerMethod('myPlugin.ping', () => 'pong')

// 建议先探测 AI 助手是否已加载 / 支持哪些能力
const caps = await api.callPlugin('top.qomicex.assistant', 'ai.capabilities')

await api.callPlugin('top.qomicex.assistant', 'ai.registerSkill', {
  providerId: 'top.qomicex.myplugin',
  id: 'usage',
  name: 'MyPlugin 使用指南',
  description: '介绍 MyPlugin 的配置项与常见报错',
  content: '# MyPlugin\n...',
  // files: [{ path: 'references/errors.md', content: '...' }],  // 可选
})
```

### payload 与限额

```ts
// skill
{
  providerId: string      // /^[a-z0-9._-]+$/
  id: string              // /^[a-z0-9._-]+$/
  name: string            // ≤ 64
  description: string     // ≤ 500（必填）
  content: string         // ≤ 64KB，可含 frontmatter（服务端会剥离）
  files?: { path: string; content: string }[]  // ≤ 10 个，单文件 ≤ 32KB
  enabled?: boolean
}

// mcp
{
  providerId: string
  id: string
  name: string
  url: string             // 只允许 http(s)
  headers?: Record<string, string>  // 单值 ≤ 2KB；禁止 Host / Content-Length
  enabled?: boolean
}
```

- 每个 provider 最多 20 个 skill / 10 个 MCP；全局最多 100 / 30。
- 全名：`plugin:<providerId>/<id>`，天然隔离同名。
- 注册内容按**纯文本**处理，技能里的脚本永远不会被执行。
- 注册表持久化在 `cache['ai.registry.v1']`，插件重载后仍在；AI 助手重启也会重新载入。
- `ai.unregister` 只能按 `providerId + id` 删除，不提供清空全部。
- 设置页会显示「提供者 / 最近注册时间 / 是否已验证」，可单独禁用或删除。

> ⚠️ 安全性：启动器的 `callPlugin` 只传 `method/args`，**不传调用者 pluginId**。因此 `providerId` 无法在插件侧验证，`verified` 仅表示「启动器里确实安装了该插件」，不能当作安全边界。第三方注册内容请自行判断可信度。

## 未来改进（需要启动器配合）

- `callPlugin` 传递 caller pluginId（可真正校验 providerId 归属）。
- manifest 支持自定义字段（可把技能/MCP 声明写进包清单，而不是运行期注册）。
- CORS 代理允许回环地址白名单（便于本地 MCP / mock 在真实启动器中验收）。
- CORS 代理放宽 60 秒超时上限（长时间 MCP 工具）。
- 原生 MCP 支持（含 stdio 传输与服务器生命周期管理）。

## 许可证

[MIT](LICENSE)
