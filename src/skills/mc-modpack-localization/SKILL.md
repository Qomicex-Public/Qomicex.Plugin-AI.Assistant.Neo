---
name: mc-modpack-localization
description: 整合包汉化：先找 VM/CFPA 等现成汉化包，再处理任务书/指南书/config 的固定流程与验证
whenToUse: 用户要「汉化某个整合包 / 任务书还是英文 / 整合包汉化包怎么装」时
version: 1
---

# 整合包汉化（Modpack Localization）

**硬规则：先找网上现成的汉化包。** 只有找不到、版本不匹配或覆盖不全时，才自己做。不要一上来就逐个模组翻译。

## 0. 先锁定目标

- 整合包名称 + 版本号（如 `1.20.1-2.3.1`）。
- MC 版本、加载器（Forge/Fabric/NeoForge/Quilt）。
- 汉化范围：模组物品/界面？任务书？指南书？config 说明？
- 用途：自己玩 / 服务器 / 二次发布（发布必须看许可证）。

## 1. 找现成汉化（按优先级）

### 1.1 搜索词（中文/英文都试）

```
<整合包名> 汉化
<整合包名> 汉化包
<整合包名> Chinese translation
<整合包名> zh_cn
<整合包名> 本地化
site:vmct-cn.top <整合包名>
site:bbsmc.net <整合包名> 汉化
<整合包名> CFPA
site:mcmod.cn <整合包名> 汉化
```

用 `bingSearch` 搜，拿到候选后必须 `fetchWeb` 打开页面核实，不要只看摘要。

### 1.2 已知来源

| 来源 | 说明 |
| --- | --- |
| **VM汉化组**（vmct-cn.top / GitHub `VM-Chinese-translate-group`） | 大量整合包汉化，常见形式是资源包/补丁或 `VMTranslationUpdateMod`（VMTU）；先找对应整合包的仓库/页面 |
| **BBSMC**（bbsmc.net） | 有「整合包汉化包」专区，覆盖 ATM10、Better MC、FTB OceanBlock 等热门包 |
| **CFPAOrg**（GitHub: `CFPAOrg/Minecraft-Mod-Language-Package`） | 模组级翻译包，按 MC 版本发布；配合 I18nUpdateMod 使用 |
| **I18nUpdateMod / VMTU** | 自动拉取模组翻译；VMTU 还能检测汉化更新、自动下载/激活资源包（需 Cloth Config） |
| **MC百科** | 整合包页面/评论区常有汉化链接 |
| **Modrinth / CurseForge** | 搜 `Chinese` / `汉化` / `translation`，筛选 Resource Pack；VM 模组包快捷 ID `#vmct` |
| **GitHub** | 搜 `<pack> zh_cn`、`<pack> localization`，VM 的包通常是独立仓库 |
| 安逸菌 / Bilibili / 贴吧 | 只作为线索；下载文件必须核对来源、版本与转载授权 |

### 1.3 候选包验收清单

- [ ] 对应**同一个整合包版本**（差一两个小版本也可能不兼容）。
- [ ] MC 版本、加载器一致。
- [ ] 覆盖范围写清楚：仅模组 / 含任务书 / 含指南书 / 含 config。
- [ ] 安装方式明确：资源包 / 模组 / 补丁文件 / 安装器。
- [ ] 来源可信：作者/汉化组主页、README、校验值；不是网盘二次倒卖。
- [ ] 许可证允许你使用；公开发布需作者授权。
- [ ] 压缩包内没有可疑 `.exe/.bat/.ps1`；有的话先解压看内容，不直接运行。

### 1.4 安装方式

- **资源包**：放进 `<instance>/resourcepacks/`，游戏内移到最上方，`F3 + T` 重载。
- **模组**（如 I18nUpdateMod）：放进 `mods/`，注意版本/加载器；首次启动会联网下载翻译。
- **补丁包**（config/quests 覆盖）：先备份 `<instance>/config`，按 README 覆盖对应目录。
- **安装器**：默认不运行；必须让用户明确同意，并先确认来源与行为。

> 版本接近但不完全匹配时：只提取其中的 `assets/**/lang` 与 `config/**/lang` 做覆盖，**不要跑安装器**，然后按第 3 节验证。

## 2. 没有现成包：确定翻译范围

### 2.1 模组文本

先按 `mc-mod-localization` 技能做资源包（`assets/<namespace>/lang/zh_cn.json`）。这一步能覆盖绝大多数物品/界面文本。

### 2.2 FTB Quests 任务书

目标文件通常在：

```
<instance>/config/ftbquests/quests/lang/en_us.snbt
<instance>/config/ftbquests/quests/lang/zh_cn.snbt   # 新增
```

流程：

1. 先看整合包是否已带 `lang/en_us.snbt`；有就复制为 `zh_cn.snbt`，**只改 value，不改 key**。
2. 没有时，用当前 FTB Quests 版本的语言导出功能生成 `en_us.snbt`（不同版本入口不同，常见在任务书设置/编辑模式；找不到就查该版本文档）。
3. 大包可用专用工具生成/合并 key：
   - `Re-FTBQLocalizationKeys`：游戏内 `/ftbqkey zh_cn` 生成任务/KubeJS 语言文件；
   - `Quests Lang Splitter`：把 lang 拆成按语言/章节的文件，方便多人协作。
4. 改完用 `/ftbquests reload` 或重启游戏；`/reload` 重载的是数据包，不是任务书。
5. 不要直接改 `quests/*.snbt` 里的任务数据来翻译，除非确认该版本没有 lang 机制；直接改会与更新/同步冲突。
6. 保留 SNBT 结构、引号、转义与 key；只翻译 `title` / `desc` / `subtitle` 等展示字段。
7. 任务书文本可能由服务端下发；多人游戏里客户端 lang 不一定生效，需要服务端也装同一份翻译。

> **已知坑**：部分 FTB Quests 的 Forge 1.20.1 版本不读取 `config/ftbquests/quests/lang/*.snbt`（同版本 NeoForge 正常），表现为任务书显示 key/英文。此时用 `Re-FTBQLocalizationKeys` 或备份后直接改章节 SNBT，并在目标加载器上实测。

### 2.3 Patchouli 指南书

```
assets/<modid>/patchouli_books/<book>/en_us/...
assets/<modid>/patchouli_books/<book>/zh_cn/...   # 资源包覆盖
```

- 复制整个 `en_us` 目录为 `zh_cn`，再翻译 JSON 里的 `text`/`title` 字段。
- 保持目录结构、文件名、JSON 结构不变；图片/配方引用不要动。
- 放进资源包 `assets/...` 对应路径即可覆盖。

### 2.4 KubeJS / 其它

- KubeJS 文本：`kubejs/assets/<namespace>/lang/zh_cn.json`（与普通资源包一致）。
- Better Questing：文本嵌在 `config/betterquesting/...` JSON 里，改前完整备份；部分版本支持 lang，优先用 lang。
- 硬编码在脚本/config 里的说明文字：资源包覆盖不到，只能改文件；先确认是否值得，并备份。
- 不要翻译注册名、命令、ID、日志。

## 3. 打包与安装

推荐拆成两部分：

```
汉化包/
├─ resourcepacks/<PackName>-zh_cn/     # 模组/指南书文本
│  ├─ pack.mcmeta
│  └─ assets/...
└─ config/                              # 任务书/config 覆盖（如需要）
   └─ ftbquests/quests/lang/zh_cn.snbt
```

- `pack.mcmeta` 的 `pack_format` 必须匹配 MC 版本（查 Wiki 或复制同版本资源包）。
- 覆盖 config 前备份原目录；只覆盖 `zh_cn` 新文件，不覆盖 `en_us`。
- 资源包在游戏内移到最上方；`F3 + T` 重载。
- 多人服务器：客户端资源包只影响客户端显示；任务书/服务端文本需要服务端同步。

## 4. 验证

1. 文件结构正确：`assets/<ns>/lang/zh_cn.json`、`config/ftbquests/quests/lang/zh_cn.snbt`。
2. JSON 可解析（`ConvertFrom-Json`）；SNBT 用对应工具/加载一次确认无语法错误。
3. key 对齐：与 `en_us` 对比，缺 key/多 key 列表。
4. 游戏内：
   - 切「简体中文」，看物品/tooltip/任务书/指南书；
   - 检查 `%s`、`§` 颜色码、换行是否正常；
   - 任务书翻页、搜索、完成状态是否正常。
5. 记录覆盖率：翻译了多少 key / 总 key，未翻译部分明确告知用户。

## 5. 常见坑

- 资源包放在模组资源下面 → 看起来没生效；移到最上方。
- `pack_format` 填错 → 资源包显示不兼容。
- 直接改 jar → 整合包更新后丢失，且可能破坏签名。
- 翻译任务书时改了 key/ID → 任务丢失或进度错乱。
- 只翻模组不翻任务书 → 用户仍觉得「没汉化」。
- 服务端/客户端任务书不一致 → 联机时文本不同步。
- 用机器翻译硬套专有名词 → 术语前后不一致。

## 输出格式

```md
**整合包**：XXX 1.20.1-2.3.1（Forge）
**现成汉化**：找到/未找到（来源、版本匹配、覆盖范围）
**本次处理**：模组 lang N 个 / 任务书 M 条 / 指南书 K 页
**安装**：resourcepacks + config 覆盖（已备份）
**验证**：JSON/SNBT OK、key 对齐、游戏内生效
**未覆盖**：...
```

## 安全与许可

- 优先使用作者/汉化组发布的原包，不二次倒卖、不改作者署名。
- 公开发布整合包汉化前确认整合包与各模组的许可证/授权。
- 不运行来源不明的安装器；不关闭杀软来「解决」问题。
- 修改实例前备份 `config/`、`resourcepacks/` 与任务书文件。
