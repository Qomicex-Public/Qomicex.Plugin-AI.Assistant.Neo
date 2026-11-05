---
name: mc-crash-debug
description: 排查 Minecraft 整合包启动崩溃，从 crash-report / latest.log 定位模组冲突、Java 或内存问题
whenToUse: 用户贴出 crash-report、提到「启动崩溃 / 一启动就闪退 / 进不去世界」
version: 1
---

# Minecraft 启动崩溃排查

目标：先给出**可验证的根因假设**，再给最小修复动作。不要一上来就让用户删模组或重装。

## 1. 先拿证据

按可靠性排序，能拿到几个算几个：

1. `getInstance(instanceId)` — 确认 MC 版本、加载器（Forge/Fabric/NeoForge/Quilt）、Java 路径、内存上限。
2. `listLogs()` + `Read(path)` — 读 `crash-reports/` 下最新的文件。
3. 没有 crash-report 时读 `logs/latest.log`（找 `---- Minecraft Crash Report ----`、`Caused by:`、`Exception in thread`）。
4. `getSystemInfo()` — 确认 Java 版本与系统内存是否够。

只读前 200~400 行通常就够定位；需要时用 `Read` 的 `offset` 继续。

## 2. 常见模式对照

| 日志特征 | 大概率原因 | 先做什么 |
| --- | --- | --- |
| `java.lang.UnsupportedClassVersionError` / `class file version 6x` | Java 版本不匹配 | 对照 MC 版本要求：1.16- 用 Java 8，1.17-1.20.4 用 17，1.20.5+ 用 21 |
| `java.lang.OutOfMemoryError` / `GC overhead limit` | 内存不足或泄漏 | 提高 `maxMemory`；检查光影/区块加载模组 |
| `Missing or unsupported mandatory dependencies` + 模组 id | 缺少前置 / 版本不匹配 | 用 `searchResources` + `getResourceDependencies` 找对应版本 |
| `Duplicate mods` / 同一模组两个 jar | 重复安装 | `listMods` 找同名不同版本，保留一个 |
| `NoSuchMethodError` / `NoClassDefFoundError` | 模组之间 API 不兼容 | 记录两个模组的版本，检查是否有已知冲突 |
| `Mixin apply failed` + mixin 名 | Mixin 冲突/加载器版本过旧 | 升级加载器或冲突模组 |
| `Failed to download` / `FileNotFoundException` 资源 | 资源不完整 | 重新安装实例（`installInstance`） |
| `Pixel format not accelerated` / OpenGL | 显卡驱动/渲染 | 关闭光影，更新驱动 |
| 最后一行 `Exit code -1073741819` (0xC0000005) | 原生崩溃（驱动/模组本地库） | 二分模组，优先怀疑优化/渲染类 |

## 3. 二分定位（模组冲突）

1. `listMods(instanceId)` 拿到模组清单。
2. 让用户备份 `mods/` 后，按一半禁用（`enableDisableMod`）。
3. 每次启动后读日志，确认崩溃是否复现，逐步缩小到单个模组。
4. 找到后给出：模组名 + 版本 + 冲突对象 + 建议（升级/降级/移除）。

**不要一次性禁用全部模组后声称「修好了」** —— 必须能解释是哪一步消除了崩溃。

## 4. 输出格式

```md
**结论**：<一句话根因>
**证据**：<日志里的关键行，最多 3 行>
**修复**：<按顺序的最小步骤>
**验证**：<启动后应该看到什么>
```

如果证据不足，明确说「目前只能确认 X，还需要 Y 日志」，并给出获取方式。
