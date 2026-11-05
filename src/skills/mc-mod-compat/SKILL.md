---
name: mc-mod-compat
description: 模组版本/加载器/前置依赖匹配与冲突排查：查询、安装、去重、验证的固定流程
whenToUse: 用户要装某个模组、问「这个模组和 XX 兼容吗」「装了模组进不去」时
version: 1
---

# 模组兼容与依赖处理

目标：装之前先把 **MC 版本 + 加载器 + 前置依赖 + 重复项**对齐；装之后用日志/模组列表验证，而不是假定成功。

## 0. 先确认目标环境

- `getInstance(instanceId)` → `gameVersion`、`loader`（Forge/Fabric/NeoForge/Quilt）。
- `listMods(instanceId)` → 已装模组与文件名。
- `getModMetadata(instanceId)` → 模组 ID/版本/依赖（能拿到多少用多少）。

**没有实例版本和加载器，不要开始搜模组。**

## 1. 查询模组（固定顺序）

1. `searchResources({ keyword, source, category: "mod", gameVersion, loader, pageSize: 5 })`
   - `source` 优先 `modrinth`，找不到再 `curseforge`。
   - 中文名搜不到时换英文名/作者/slug，例如「钠」→ `sodium`。
2. `getResourceDetail({ id, source })` — 确认模组本体、支持的加载器/版本。
3. `getResourceVersions({ id, source, gameVersion, loader })` — 只选同时匹配版本与加载器的文件。
4. `getVersionDownloads({ id, versionId, source })` — 拿到真实下载文件。
5. `getResourceDependencies({ id, source, versionId, gameVersion, loader })` — 检查前置。

## 2. 依赖判定（知识要点）

- **required**：必须装，否则启动直接崩（`Missing or unsupported mandatory dependencies`）。
- **optional**：可装可不装；装之前问用户是否需要对应功能。
- **incompatible**：明确冲突，装了会崩或行为异常，不要装。
- **embedded**：已被打包进模组，不需要单独装。
- 依赖也要匹配 **同一个 MC 版本 + 加载器**，不能只看名字。
- Fabric 的依赖常写 `fabric-api` / `fabric-loader` 版本范围；Forge/NeoForge 常写 `modid` + 版本范围。

## 3. 安装

- 简单场景：`installMod({ instanceId, keyword, source, gameVersion, loader })`
  - 它会自动取搜索第一个结果与最新兼容版本；**结果里要核对模组名和版本**，不匹配就改用显式下载。
- 精确场景：
  1. `getVersionDownloads` 拿 `url`/`fileName`。
  2. `startDownload({ instanceId, url, fileName, category: "mods" })`。
  3. `getDownloadProgress(taskId)`，间隔 ≥ 15 秒。
- 依赖按同样方式装到 `mods`，不要只装主模组。

## 4. 去重与启停

- `listMods` 里同一模组出现多个 jar（不同版本/`.disabled`）时：
  - 保留一个与当前 MC/加载器匹配的版本；
  - 其余用 `enableDisableMod({ instanceId, name, enable: false })` 禁用，不要直接删除用户文件。
- 客户端模组（小地图、HUD、光影、按键）不要装到专用服务器。
- 服务端模组（权限、区块加载、经济）客户端可不装，但要看模组说明。

## 5. 常见冲突模式

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| `Duplicate mods` | 同模组两个版本 | 禁用一个 |
| `Missing or unsupported mandatory dependencies` | 缺前置/版本不符 | 装匹配版本前置 |
| `NoSuchMethodError` / `NoClassDefFoundError` | 模组 API 不兼容 | 升级/降级其中一个 |
| `Mixin apply failed` | Mixin 冲突/加载器过旧 | 升级加载器或冲突模组 |
| `UnsupportedClassVersionError` | Java 版本不对 | 按实例版本换 Java |
| 进游戏后特定方块/实体消失 | 客户端/服务端模组不一致 | 两边对齐 |
| 性能模组互相覆盖 | OptiFine 与 Sodium/Embeddium 同装 | 二选一 |

## 6. 验证

1. 启动实例。
2. 读 `logs/latest.log`，搜 `ERROR`、`Missing`、`Duplicate`、`Mixin`、`Exception`。
3. 确认目标模组出现在 `listMods` 且 `enabled=true`。
4. 只有启动到主菜单/进入世界才算真正成功；不要在只下载完时就宣布兼容。

## 输出格式

```md
**环境**：1.20.1 / Forge 47.x / Java 17
**模组**：xxx 版本 yyy（Modrinth）
**前置**：已装 aaa、bbb；未装 ccc（optional，需要吗？）
**冲突检查**：无重复 / 已禁用旧版本 zzz
**验证**：启动到主菜单，latest.log 无 ERROR
```

## 安全边界

- 不删除用户模组文件；禁用优先。
- 不把「最新版」当成「兼容版」。
- 不确定兼容性时明确说「需要实测」，并给出最小验证步骤。
