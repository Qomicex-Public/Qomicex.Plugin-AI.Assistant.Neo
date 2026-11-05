---
name: mc-crash-debug
description: 排查 Minecraft 启动崩溃：从 crash-report / latest.log 定位模组冲突、Java、内存与原生崩溃
whenToUse: 用户贴出 crash-report、提到「启动崩溃 / 一启动就闪退 / 进不去世界 / 退出码 -1073741819」时
version: 2
---

# Minecraft 启动崩溃排查

目标：先给出**可验证的根因假设**，再给最小修复动作。不要一上来就让用户删模组或重装。

## 0. 先确认前提

- MC 版本与加载器（Forge/Fabric/NeoForge/Quilt/原版）。
- Java 版本与位数（32/64 位）。
- 崩溃发生在：启动器阶段 / 游戏窗口出现前 / 主菜单 / 进入世界 / 玩一段时间。
- 最近是否新增/更新模组、光影、Java、启动器或系统更新。

## 1. 拿证据（按可靠性排序）

1. `getInstance(instanceId)` — 版本、加载器、Java 路径、内存上限、`gameDir`。
2. `listLogs()` — 启动器日志（`path/name/lastModified/isCurrentSession`），`Read` 最新一条。
3. 实例目录下：
   - `crash-reports/crash-*.txt`（最完整）
   - `logs/latest.log`（本次启动）
   - `logs/debug.log`（更详细）
   - `hs_err_pid*.log`（JVM 原生崩溃）
4. 没有路径信息时：`Bash` 列目录（需可写权限）或让用户直接贴 crash-report。

读日志时优先搜：`---- Minecraft Crash Report ----`、`Description:`、`Caused by:`、`Exception in thread`、`UnsupportedClassVersionError`、`OutOfMemoryError`、`Mixin`、`Missing`、`Duplicate`。

## 2. Java 版本对照

| MC 版本 | 需要 Java |
| --- | --- |
| ≤ 1.16.5 | 8 |
| 1.17.x | 16 |
| 1.18 – 1.20.4 | 17 |
| 1.20.5 – 1.21.x | 21 |

- `UnsupportedClassVersionError` / `class file version 6x` = Java 太旧（或模组要求更高版本）。
- 32 位 Java 无法分配大内存；整合包必须 64 位。
- 换 Java 后要确认启动器实例里选中的是**同一个** Java。

## 3. 常见模式

| 日志特征 | 大概率原因 | 先做什么 |
| --- | --- | --- |
| `UnsupportedClassVersionError` / `class file version 6x` | Java 版本不匹配 | 按上表换 Java |
| `java.lang.OutOfMemoryError: Java heap space` | 内存不足/泄漏 | 提高 `maxMemory`（但别超过物理内存 50%–60%） |
| `GC overhead limit exceeded` | 内存过小或泄漏 | 同上，并查大模组/区块加载 |
| `Missing or unsupported mandatory dependencies` + modid | 缺前置/版本不符 | 装匹配版本前置 |
| `Duplicate mods` / 同模组两个 jar | 重复安装 | 禁用一个 |
| `NoSuchMethodError` / `NoClassDefFoundError` | 模组 API 不兼容 | 记录两个模组版本，升级/降级 |
| `Mixin apply failed` / `Mixin transformation` | Mixin 冲突/加载器过旧 | 升级加载器或冲突模组 |
| `java.lang.VerifyError` | 模组损坏/字节码不兼容 | 重下该模组，换版本 |
| `ExceptionInInitializerError` | 模组静态初始化失败 | 看 `Caused by` 指向的模组 |
| `GLFW error 65542` / `Failed to create display` | 显卡/OpenGL/驱动 | 更新驱动、关闭光影、切独显 |
| `Pixel format not accelerated` | 显卡驱动/远程桌面 | 更新驱动，避免远程桌面跑游戏 |
| `java.io.IOException: ...` / 权限拒绝 | 路径权限/杀软 | 换到可写目录，检查杀软隔离 |
| 最后一行 `Exit code -1073741819` | 原生访问冲突（驱动/本地库） | 二分模组，优先怀疑渲染/优化类 |
| 服务端 `Incompatible mod set` | 两端模组不一致 | 对齐 mods |

## 4. 退出码参考

| 退出码 | 含义 | 方向 |
| --- | --- | --- |
| `0` | 正常退出 | 不是崩溃 |
| `1` | Java 未捕获异常 | 看 crash-report / latest.log |
| `-1073741819`（0xC0000005） | 访问冲突 | 驱动、原生库、渲染模组 |
| `-1073740940`（0xC0000374） | 堆损坏 | 原生库/内存问题 |
| `-1073741571`（0xC00000FD） | 栈溢出 | 递归/模组 bug |
| `-1073740791`（0xC0000409） | 栈缓冲溢出/安全终止 | 原生崩溃 |
| `134` / `137`（Linux） | SIGABRT / SIGKILL（可能 OOM） | 看系统 OOM/原生库 |

> 退出码只能缩小范围，不能单独定案；必须结合日志/模组变更。

## 5. 定位方法

### 5.1 最近变更法

- 最近装的模组/光影/Java/启动器 → 先回退这一项。
- 整合包更新后崩 → 对比更新前后模组列表。

### 5.2 二分法（模组冲突）

1. `listMods(instanceId)` 拿清单。
2. 让用户备份 `mods/`。
3. 按一半禁用（`enableDisableMod`），启动看是否复现。
4. 缩小到单个模组，再确认冲突对象。
5. 给出：模组名 + 版本 + 冲突对象 + 建议（升级/降级/移除/换替代）。

**不要一次性禁用全部模组后声称「修好了」** —— 必须能解释哪一步消除了崩溃。

### 5.3 原生崩溃

- 有 `hs_err_pid*.log` 时看 `Problematic frame`、`Native frames`。
- 常见嫌疑：显卡驱动、OptiFine/Sodium 混装、过时的本地库、超频/内存不稳。
- 可建议：更新驱动、关 XMP/超频、换 Java、用原版启动测试。

## 6. 输出格式

```md
**结论**：<一句话根因>
**证据**：<日志关键行，最多 3 行>
**修复**：<按顺序的最小步骤>
**验证**：<启动后应该看到什么>
```

证据不足时明确说「目前只能确认 X，还需要 Y 日志」，并给出获取方式。

## 安全边界

- 不删除用户存档/模组；禁用优先，删除前必须确认。
- 不把「重装系统/重装启动器」作为第一步。
- 不建议关闭杀毒/防火墙；只给精确放行建议。
- 不编造未出现的日志行或错误码。
