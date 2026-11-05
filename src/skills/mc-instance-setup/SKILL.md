---
name: mc-instance-setup
description: 从零创建并安装 Minecraft 实例：版本/加载器/Java/内存选择、安装与启动验证的固定流程
whenToUse: 用户要「新建实例 / 装个 1.20.1 Forge / 开个原版生存 / 实例启动不了」时
version: 1
---

# 新建与安装 Minecraft 实例

目标：一次把版本、加载器、Java、内存选对，安装后**实际启动验证**，而不是只报告「安装完成」。

## 0. 先问清 4 件事（缺一不可）

1. **游戏版本**：1.12.2 / 1.16.5 / 1.20.1 / 1.21.x……
2. **加载器**：原版 / Fabric / Forge / NeoForge / Quilt。
3. **用途**：原版生存、模组整合、服务器客户端、红石/建筑、光影。
4. **内存与 Java**：机器总内存多少、是否已有 Java。

如果用户只说「装个 Forge」，先按「最新稳定版 + 对应 Java」给一个默认方案，再让用户确认。

## 1. 先看现状（不要重复建实例）

- `listInstances()` — 已有实例、版本、加载器。
- `getSystemInfo()` — 系统内存、Java、平台。
- `getLauncherSettings()` — 启动器默认 Java / 内存。
- `listLoaderVersions(gameVersion, loader)` — 可用的加载器版本。

## 2. 选择矩阵（知识要点）

### Java 版本

| MC 版本 | 推荐 Java |
| --- | --- |
| ≤ 1.16.5 | Java 8 |
| 1.17.x | Java 16 |
| 1.18 – 1.20.4 | Java 17 |
| 1.20.5 – 1.21.x | Java 21 |

- 1.12.2 整合包几乎都要求 Java 8，不要用 Java 17 硬跑。
- 高版本 Forge/NeoForge 对 Java 小版本也敏感；优先用对应 LTS（8/17/21）。
- 找不到合适 Java 时用 `addCustomJava(path)` 或在启动器设置里指定。

### 加载器

- **Fabric**：轻量、更新快，适合新版本与性能模组。
- **Quilt**：多数 Fabric 模组可用，但并非 100% 兼容；非必要不选。
- **Forge**：老版本模组生态最全（1.12.2 / 1.16.5 / 1.20.1）。
- **NeoForge**：1.20.1+ 的 Forge 分支，新版本模组优先看 NeoForge。
- 加载器版本选**最新稳定版**，不要随手选 beta；整合包要求特定版本时以整合包为准。

### 内存

| 场景 | 建议 -Xmx |
| --- | --- |
| 原版 | 2–4 GB |
| 轻量模组（< 50） | 4–6 GB |
| 中型整合（100–200） | 6–8 GB |
| 大型整合（200+ / 光影） | 8–12 GB |

- 不要超过物理内存的 **50%–60%**，给系统和显存留余量；32GB 机器给 12GB 通常比 24GB 稳。
- 内存不是越大越好：过大反而拉长 GC 停顿。

## 3. 创建与安装（固定顺序）

1. `createInstance({ name, gameVersion, loader, loaderVersion, javaPath, maxMemory, gameDir })`
   - 名称带上用途，如 `1.20.1-Forge-生存`。
   - `gameDir` 默认 `.minecraft` 即可，除非用户明确要独立目录。
2. `installInstance({ instanceId, loader, loaderVersion, downloadThreads: 64 })`
   - 需要下载游戏本体/库/加载器，耗时较长。
3. 轮询进度：`sleep(5000~15000)` → `getInstanceLaunchProgress(instanceId)`。
   - 每 10 秒左右查一次，不要高频轮询。
   - `stage=failed/crashed` 时读 `error`，不要盲目重装。
4. 安装完成后 `getInstance(instanceId)` 确认版本/加载器/Java/内存。
5. `launchInstance({ instanceId })` 并继续看 `getInstanceLaunchProgress` 到 `running` 或失败。
6. 失败时按 `mc-crash-debug` 技能排查日志。

## 4. 常见失败（先看这些再动手）

- `UnsupportedClassVersionError` → Java 版本不对（见上表）。
- `Could not find or load main class` / 库缺失 → 安装不完整，重跑 `installInstance`。
- 启动器报 Java 路径不存在 → `getSystemInfo` 确认，`addCustomJava` 添加。
- 内存不足 / 系统卡死 → 降低 `maxMemory`，关闭其他程序。
- 版本隔离关闭导致存档/模组串味 → 新实例建议开启隔离。
- 安装卡在下载 → 检查网络、切换下载源、稍后重试；不要连续点安装。

## 5. 输出格式

```md
**方案**：MC 1.20.1 + Forge 47.x + Java 17 + 8GB
**已完成**：创建实例、安装、启动验证
**验证结果**：launch/progress = running（或失败原因）
**下一步**：装模组 / 分配更多内存 / 排查崩溃
```

## 安全边界

- 不要删除或覆盖用户已有实例；需要重建时先说明并得到确认。
- 修改全局 Java/内存设置前先告知影响范围。
- 安装失败时保留日志与错误原文，不要用「重装试试」掩盖根因。
