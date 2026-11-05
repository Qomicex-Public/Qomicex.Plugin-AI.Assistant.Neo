---
name: mc-modpack-install
description: 安装与迁移 Minecraft 整合包：本地/在线来源、内存与 Java、进度跟踪、失败排查的固定流程
whenToUse: 用户要装 .mrpack/CurseForge/FTB 整合包，或问「整合包怎么装/装了打不开」时
version: 1
---

# 整合包安装与迁移

目标：选对来源与版本，装完能启动；不把「下载完成」当成「安装成功」。

## 1. 识别来源

| 来源 | 传参 |
| --- | --- |
| Modrinth `.mrpack`（本地） | `path` 指向文件 |
| CurseForge 整合包 zip（本地） | `path` |
| Modrinth 在线 | `type: "mr"`, `projectId`, `fileId` |
| CurseForge 在线 | `type: "cf"`, `projectId`, `fileId` |
| FTB 在线 | `type: "ftb"`, `projectId`, `fileId` |

- 在线安装必须同时有 `projectId` 与 `fileId`；只给项目页链接时先查清 fileId。
- 本地文件先确认存在、大小合理（`Read` 不行就 `Bash` 看文件信息，需可写权限）。
- 用户只说整合包名字时，先用 `searchResources`（`category: "modpack"`）定位，再让用户确认。

## 2. 安装前检查

- `getSystemInfo()`：物理内存、Java、磁盘空间。
- 需要的 Java 版本：整合包页面通常写明（1.20.1 多为 Java 17，1.20.5+ 为 21，1.12.2 为 8）。
- 目标 `gameDir`：不要覆盖用户已有实例；新整合包用新目录/新实例。
- 内存建议：中型整合 6–8GB，大型 8–12GB，不超过物理内存 50%–60%。

## 3. 安装（固定顺序）

1. `installModpack({ id, gameDir, path? / type+projectId+fileId, versionIsolation, maxMemory })`
   - `id` 用实例 id/名称，保持唯一。
   - `versionIsolation: true` 默认开启，避免不同版本串存档/模组。
2. 记录返回的 `instanceId`。
3. 等待安装：`sleep(10000~20000)` → `getInstanceLaunchProgress(instanceId)`。
   - 安装阶段可能在下载数百个文件，不要高频轮询。
4. 完成后 `getInstance(instanceId)` 确认版本、加载器、Java、内存。
5. `launchInstance(instanceId)`，再跟踪进度到 `running` 或失败。
6. 失败时用 `mc-crash-debug` 技能读 `crash-reports` / `logs/latest.log`。

## 4. 迁移已有整合包

- 用户已有 `.minecraft` 目录时：优先让启动器「导入/安装」而不是手工复制。
- 手工迁移只复制必要目录：`mods`、`config`、`defaultconfigs`、`scripts`、`kubejs`、`resourcepacks`、`shaderpacks`、`saves`、`options.txt`。
- 不要复制 `logs`、`crash-reports`、`cache`、`.mixin.out` 等运行期目录。
- 迁移后核对 `mods` 数量与整合包版本，避免漏文件。

## 5. 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 卡在下载/进度不动 | 网络、CF 限流、磁盘满 | 换源/等待/清空间，不要重复点安装 |
| `UnsupportedClassVersionError` | Java 版本不对 | 换 Java 8/17/21 |
| 启动即崩、缺模组 | 下载不完整/杀软拦截 | 重跑安装，检查隔离区 |
| 进入世界崩溃 | 整合包配置/内存不足 | 提高内存，读 crash-report |
| 多人服务器连不上 | 客户端整合包与服务端不一致 | 服务端用同版本整合包 |
| 存档打不开 | 版本隔离/存档版本不符 | 确认实例与存档版本 |

## 6. 输出格式

```md
**整合包**：XXX（Modrinth / 1.20.1 / Forge）
**实例**：id=...，gameDir=...
**安装**：完成/失败（阶段、错误）
**启动**：running / 崩溃（关键日志）
**建议**：内存、Java、下一步
```

## 安全边界

- 不覆盖或删除用户已有实例/存档；需要清理时先说明并确认。
- 不执行整合包内自带的 `.jar` 安装器/脚本，除非用户明确要求且来源可信。
- 失败时保留原始错误，不要用「重装」代替定位。
