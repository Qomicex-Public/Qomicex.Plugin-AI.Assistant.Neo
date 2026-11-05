---
name: mc-knowledge-research
description: Minecraft 知识问答的证据工作流：版本/模组区分、Wiki/MC百科/网页交叉验证与规范输出
whenToUse: 用户问合成表、方块/生物数据、模组教程、机制细节、版本差异等事实性问题时
version: 1
---

# Minecraft 知识研究

目标：**先确认版本与是否模组**，再用来源交叉验证，最后按规范格式输出。不要凭记忆报配方/数值，也不要把搜索摘要当结论。

## 1. 先锁定前提（不确认就别答）

1. **Java 版还是基岩版**？（配方/机制/ID 都可能不同）
2. **具体版本**？（1.12.2 / 1.16.5 / 1.20.1 / 1.21.x）
3. **原版还是模组**？哪个加载器/模组？
4. 用户要的是「怎么做」还是「为什么/数据」？

缺版本时先问一句；如果只是通用概念，可以说明「以下以 Java 1.20.1 为例」。

## 2. 选来源（按问题类型）

| 问题 | 首选 | 备用 |
| --- | --- | --- |
| 原版方块/生物/机制 | `searchWiki` + `getWikiContent` | `fetchWeb` 官方 wiki |
| 合成/熔炼/锻造配方 | `getWikiContent` | `searchMcMod` + `getMcmodContent` |
| 模组内容/教程/已知问题 | `searchMcMod` + `getMcmodContent` | `bingSearch` → `fetchWeb` |
| 最新版本/更新日志 | `bingSearch` → `fetchWeb` | 官方站点/Modrinth |
| 整合包/模组下载 | `searchResources` 系列 | 模组官方页面 |

### 使用要点

- `searchWiki` 只返回标题/摘要；**必须** `getWikiContent` 读正文。
- `getWikiContent` 返回 wikitext：必须解析模板，绝不把 `{{...}}` 原样给用户。
- `searchMcMod` 有 3 秒节流、结果可能被限流；失败时换关键词或改用 `bingSearch`。
- `bingSearch` 的 snippet 只是摘要；回答前用 `fetchWeb` 抓最相关的 1–2 个页面核实。
- 视频站（YouTube/Bilibili 视频）`fetchWeb` 只返回标题/简介，不能当正文证据。
- 中文名搜不到时换英文名/注册名/模组 slug。

## 3. 交叉验证

- 至少两个来源，或一个权威来源 + 游戏内行为描述。
- 注意页面标注的版本；旧版本 wiki 的配方可能已改。
- 模组页面优先看 **对应 MC 版本 + 加载器** 的分支。
- 不确定时明确写「该版本未验证」，不要编造数值。

## 4. 输出规范（本插件 Markdown 约定）

- 合成表用 ` ```crafting `：每行一个网格行，空位留空，`Output=产物`，`Count=数量`。
- 其他配方用 ` ```recipe `：`type=smelting/smithing/anvil/stonecutting`、`input=`、`base=`、`addition=`、`output=` 等。
- 生物/方块/物品/结构用 ` ```info `：`name=`、`category=`。
- 回答末尾用 ` ```suggest ` 给 2–3 条联想提问。
- 正文简洁：结论 → 关键步骤/数据 → 版本/来源说明。
- 引用来源时写站点名 + 页面标题，不要把整段原文复制给用户。

## 5. 常见坑

- 把 Java 版配方套到基岩版。
- 把模组物品当成原版物品。
- 用旧版本的合成表回答新版本（例如 1.20.5 之后的配方/组件变化）。
- 把「搜索结果标题」当成已核实事实。
- 把 wikitext 模板、`File:` 链接、编辑标记直接展示给用户。

## 输出模板

```md
**结论**：一句话回答
**版本**：Java 1.20.1（原版 / 模组 xxx）
**步骤/数据**：...
**来源**：中文 Minecraft Wiki「...」；MC百科「...」
**不确定项**：...
```
