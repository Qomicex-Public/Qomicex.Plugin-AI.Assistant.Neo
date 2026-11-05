---
name: mc-performance-tuning
description: Minecraft 卡顿/低帧/加载慢的诊断与优化：定位 CPU/GPU/内存瓶颈，按最小改动逐步验证
whenToUse: 用户说「帧数低 / 一卡一卡 / 加载慢 / 内存占用高 / 想优化整合包」时
version: 1
---

# Minecraft 性能诊断与优化

目标：先定位瓶颈，再**一次只改一项**并复测。不要一次性塞十个「优化模组」然后声称变快。

## 1. 建立基线

问清并记录：

- 当前 FPS（平均/最低）、卡顿是持续还是周期性。
- 场景：主菜单 / 出生点 / 跑图 / 大量实体 / 开光影。
- 分辨率、渲染距离、模拟距离、光影/材质包。
- `getSystemInfo()`：CPU、内存、GPU、Java 版本。
- `getInstance(instanceId)`：MC 版本、加载器、`maxMemory`。
- `listMods(instanceId)`：是否已有性能模组/光影模组。
- 日志：`logs/latest.log` 搜 `OutOfMemory`、`GC`、`OpenGL`、`Exception`。

## 2. 判断瓶颈

| 症状 | 更可能的原因 | 先做什么 |
| --- | --- | --- |
| FPS 低但 GPU 占用低 | CPU 单线程（实体/方块更新/模组逻辑） | 降模拟距离、查实体农场、装 Lithium 类优化 |
| GPU 占用接近 100% | 分辨率/光影/材质 | 降分辨率、关光影、降 render distance |
| 周期性卡顿、内存持续上涨 | GC/内存不足/泄漏 | 调整 -Xmx、查泄漏模组、看 GC 日志 |
| 跑图时卡、区块加载慢 | 磁盘/CPU/区块加载 | 降模拟距离、SSD、减少预生成 |
| 启动慢 | 模组多/硬盘/杀软扫描 | 减少模组、排除杀软扫描目录 |
| 只有开背包/界面卡 | GUI 渲染/模组 HUD | 查 HUD/REI/JEI 类模组 |

## 3. 优化手段（按风险从低到高）

### 3.1 零风险

- 降低渲染距离（render distance）与模拟距离（simulation distance）。
- 关闭 VSync / 限制帧率到显示器刷新率，减少发热。
- 降低阴影、粒子、云、树叶透明等设置。
- 笔记本插电、选独显、系统电源计划改为高性能。

### 3.2 低风险（模组）

按版本/加载器确认兼容后再装，装完必须启动验证：

- **Fabric**：Sodium（渲染）、Lithium（服务端逻辑）、FerriteCore（内存）、ImmediatelyFast（GUI/实体渲染）。
- **Forge/NeoForge**：Embeddium（Sodium 移植）、FerriteCore、ModernFix、EntityCulling。
- **光影**：Fabric 用 Iris，Forge 用 Oculus；光影包要匹配两者。
- **不要**同时装 OptiFine 与 Sodium/Embeddium；不要混用不同分支的渲染优化。
- 版本越新，可用的优化模组越少；先查 Modrinth 的 `gameVersion + loader`。

### 3.3 中风险（JVM 参数）

- Java 17/21 默认 G1GC 已经不错；先只调 `-Xms`/`-Xmx`。
- 常见起点：`-XX:+UseG1GC -XX:MaxGCPauseMillis=200`。
- 不要照抄 1.12.2 时代的 CMS/`-XX:+UseConcMarkSweepGC`，Java 14+ 已移除。
- 不要设置 `-Xmx` 超过物理内存 50%–60%；过大反而增加 GC 停顿。
- Aikar flags 可用于大型整合，但**一次加一组**并对比，不要与未知参数混用。

### 3.4 高风险

- 替换整合包核心模组、删改 config、批量禁用模组。
- 先备份实例/存档，再逐项验证；任何一步导致崩溃就回滚。

## 4. 测量方法

1. 固定场景（同一存档、同一坐标、同一视角）。
2. 记录 60 秒平均 FPS、最低 FPS、内存峰值。
3. 只改一项 → 重启 → 同场景复测。
4. 变差就回滚，不要保留「可能有用」的改动。

## 5. 输出格式

```md
**基线**：1.20.1 Forge，1080p，render 12，无光影，平均 45 FPS / 最低 18
**瓶颈**：GPU 98%，CPU 单核 40% → 更像渲染瓶颈
**本次改动**：只把 render distance 12 → 8
**复测**：平均 62 FPS / 最低 35；无崩溃
**下一步**：需要的话再试 Embeddium（先确认版本）
```

## 安全边界

- 不删除存档/实例；改 config 前备份。
- 不推荐来源不明的「优化 jar」或破解启动器。
- 优化模组也要遵守 `mc-mod-compat` 的依赖/版本检查。
- 没有复测数据时，不要声称「已优化」。
