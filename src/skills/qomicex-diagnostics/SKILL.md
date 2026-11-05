---
name: qomicex-diagnostics
description: 排查 Qomicex 启动器与插件问题：日志、权限、manifest、插件加载、代理/文件/进程错误的固定流程
whenToUse: 用户说「插件不生效 / 启动器报错 / 某个功能没反应 / AI 助手工具用不了」时
version: 1
---

# Qomicex 启动器 / 插件诊断

目标：先拿证据（日志、状态、manifest），再定位到**具体一层**（启动器 / 插件加载 / 权限 / 网络代理 / 文件授权 / 进程），不要凭感觉让用户重装。

## 1. 先收集（只读优先）

- `checkHealth()` — 后端健康状态。
- `getSystemInfo()` — 平台、版本、Java、内存。
- `getLauncherSettings()` — 数据目录、下载源、代理等。
- `listPlugins()` — 已安装插件摘要（id/name/version/status）。
- `callBackend('/plugins')` — 完整列表，含 `manifest` 与 `dir`（只读，不需要额外权限，只需 `network:fetch`）。
- `listLogs()` — 启动器日志列表（`path` / `name` / `lastModified` / `isCurrentSession`）。
- `Read(最新日志 path)` — 读最后 200~400 行，或 `Grep` 搜 `ERROR` / `WARN` / 插件 id。

> `listPlugins()` 桥接只返回 `{id,name,version,status}`；要看 manifest/目录必须用 `callBackend('/plugins')`。

## 2. 分层定位

### 2.1 启动器层

- `checkHealth` 失败：后端未启动/端口占用/版本不匹配。
- 启动即崩：看 `listLogs` 最新会话日志，搜 `panic`、`ERROR`、`Failed to`。
- 更新后异常：确认 `minLauncherVersion`，回滚插件或启动器。

### 2.2 插件加载层

逐项核对 `manifest`：

1. `id` 合法且唯一（反向域名，如 `top.qomicex.assistant`）。
2. `version` 是 semver，且 ≥ 依赖方要求。
3. `minLauncherVersion` 不高于当前启动器。
4. `permissions` 覆盖实际调用的桥方法（缺权限会在运行时被拒）。
5. `entry.frontend` 指向真实存在的 `.html`（打包后在 `dist/`）。
6. `dependencies` 已安装且版本满足。
7. 签名/安装状态正常（`status` 不是 disabled/error）。
8. 插件目录里 `dist/` 文件齐全，没有被杀软隔离。

常见错误：

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `Permission denied: requires xxx` | manifest 缺权限 | 补权限并重新安装/更新 |
| `插件 X 未提供方法 Y` | 目标插件未加载或没 registerMethod | 先确认目标插件启用；注册是内存态，iframe 卸载即失效 |
| `Plugin registry not initialized` | 调用发生在桥就绪前 | 等 DOM/插件初始化后再调 |
| `Unsupported API method` | 方法名不在桥白名单 | 查文档/版本，别猜 |
| `Backend error: 404` | 路由/版本不匹配 | 对齐启动器与插件版本 |

### 2.3 权限 / 文件层

- `FS_AUTHORIZATION_REQUIRED`：首次访问未授权路径，启动器会弹窗；用户拒绝后要重新触发并允许。
- 文件 API 只能访问授权过的路径/子树；缓存按路径持久化。
- `filesystem:read` / `filesystem:write` / `shell:execute` / `process:manage` 是不同权限，别混。
- `shell:execute` 的命令超时上限 120 秒，超时会杀进程并丢输出；长任务用 `process:manage`。

### 2.4 网络 / 代理层

- `network:fetch`：`callBackend` 调启动器后端。
- `network:cors_proxy`：`proxyFetch` / `proxyFetchStream` 跨域请求。
- `PROXY_PRIVATE_ADDRESS`：代理拒绝内网/回环地址（127.0.0.1、192.168.x、10.x）。
- `PROXY_UPSTREAM_FAILED`：上游不可达/超时/证书错误。
- 代理 `timeoutMs` 实际被夹在 1–60 秒；不要指望 120 秒。
- 401/403 是目标服务器拒绝，不是启动器故障；检查 headers/token。

### 2.5 进程层（process:manage）

- `PROCESS_COMMAND_REQUIRED` / 控制字符：`command/args` 不允许 `\n`/`\r`/NUL；脚本用 `-EncodedCommand`。
- 每插件最多 32 个进程；日志环形 2000 行，退出后句柄保留 10 分钟。
- `process.logs(pid, afterSeq)` 是游标增量；`alive/exitCode` 以返回值为准。
- 停止用 `process.kill`（杀进程树，幂等）。

### 2.6 AI 助手自身

- 模型配置：`baseUrl` / `model` / `apiKey`；`/models` 拉不到时可手填。
- 多模态：模型不支持 image 时不要勾选图片，否则请求报错；截图工具也会隐藏。
- 输出上限：思考与正文共享 `maxTokens`，太小会 `finish_reason=length` 且正文为空。
- 文件权限：只读 / 可写 / 完全访问；工具被拒先看当前权限。
- 启动器操作：`uiControl` 关闭时 UI 工具根本不注入。
- Skill：`skillsDir` 未授权时目录为空；看设置页错误。
- MCP：确认 `mcpEnabled`、URL 是 http(s)、代理允许该地址（内网会被拒）；看「测试连接」。

## 3. 输出格式

```md
**结论**：问题在「插件加载 / 权限 / 代理 / 文件授权 / 配置」哪一层
**证据**：日志关键行 + manifest/状态字段（最多 3 条）
**修复**：按顺序的最小步骤
**验证**：重载/重试后应该看到什么
```

## 安全边界

- 不修改启动器安装目录与用户存档；需要改配置时先备份并说明。
- 不把日志里的 token、路径中的用户名等敏感信息原样贴给第三方。
- 不建议关闭杀软/防火墙来「解决」问题；只给精确放行建议。
- 证据不足时明确说「还需要 X 日志」，不要编造错误码。
