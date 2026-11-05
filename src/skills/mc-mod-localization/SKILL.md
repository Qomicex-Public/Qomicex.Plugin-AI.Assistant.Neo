---
name: mc-mod-localization
description: 单个/多个模组汉化：优先用现成中文资源包或 i18n 模组，否则提取 lang 键并生成可覆盖的资源包
whenToUse: 用户要「汉化某个模组 / 模组里还是英文 / 做个汉化资源包 / 翻译 lang 文件」时
version: 1
---

# 模组汉化（Mod Localization）

目标：**优先用现成中文资源**，没有再自己翻译；输出优先做成**资源包覆盖**，不改模组 jar。所有翻译必须保留 key、格式符和颜色码。

## 0. 先确认

- 模组名 + 版本 + 文件（`mods/xxx.jar`）。
- MC 版本与加载器：1.12.2 用 `.lang`，1.13+ 用 `.json`。
- 目标是「自己看懂」还是「发布给别人」：发布必须确认模组许可证/作者授权。
- 是否已经装过汉化资源包/i18n 模组（避免重复覆盖）。

## 1. 优先找现成汉化（按顺序）

1. **模组自带**：jar 里可能已有 `zh_cn.json` / `zh_CN.lang`，先检查。
2. **CFPA 模组翻译包**：`CFPAOrg/Minecraft-Mod-Language-Package` 的 release/资源包，按 MC 版本下载；覆盖大量模组。
3. **VM 汉化组模组包**：Modrinth/CurseForge 的 `VM Chinese Mods Translation`（快捷 ID `#vmct`），按 MC 版本提供模组汉化资源包。
4. **I18nUpdateMod / VMTU**：兼容当前版本/加载器时，装上可自动拉取翻译；注意会联网，且不覆盖任务/书。
5. **Modrinth / CurseForge**：搜 `模组名 Chinese` / `模组名 汉化` / `translation`，筛选 Resource Pack。
6. **BBSMC / MC百科 / 中文 Wiki**：BBSMC 有整合包汉化专区；模组页与评论区常有汉化链接。
7. 以上都没有，才进入自译流程。

> 下载的汉化包要核对：MC 版本、加载器、模组版本、覆盖范围、来源可信度。不要运行不明 `.exe/.bat`。

### 1.1 下载候选包（DownloadFile）

`DownloadFile` 是通用下载工具（底层 `download.addTask`），不要把网页当文件直接 `fetchWeb`：

1. 先拿**直链**：
   - Modrinth/CurseForge：`getVersionDownloads` 的 `url`；
   - GitHub Releases：`browser_download_url`（不是仓库页面）；
   - 网盘/论坛：用 `fetchWeb` 找实际文件地址，必要时从页面/接口解析。
2. 先下到临时工作区检查：

```text
DownloadFile({
  url: "<直链>",
  targetPath: "<临时工作区>\\downloads\\xxx-zh_cn.zip"
})
```

3. `getDownloadProgress(taskId)` 轮询到 `completed`；再 `tar -tf`（zip）或 `Decompress` 检查目录结构。
4. 确认是资源包/语言文件后再安装：`DownloadFile({ url, instanceId, category: "resourcepacks", fileName })`，或把检查过的文件夹复制到 `resourcepacks/`。
5. 需要鉴权/防盗链时传 `headers`（Authorization / Referer / Cookie）；`.zip` 想直接解压可传 `extract: true`（会删除原 zip）。

> 注意：`DownloadFile` 需要「可写」及以上权限；下载大文件用 `getDownloadProgress` 按 15 秒间隔轮询。

## 2. 提取源 lang

### 2.1 先看 jar 里有什么

```powershell
# Windows 自带 tar 能直接读 jar（jar 就是 zip）
tar -tf "D:\path\mods\xxx.jar" | Select-String "lang/"
```

### 2.2 解压 lang（只取需要的条目）

```powershell
$jar = "D:\path\mods\xxx.jar"
$out = "$env:TEMP\modlang\xxx"
New-Item -ItemType Directory -Force $out | Out-Null
tar -xf $jar -C $out "assets"
Get-ChildItem $out -Recurse -Filter en_us.json | Select-Object FullName
Get-ChildItem $out -Recurse -Filter en_US.lang | Select-Object FullName
```

- 一个 jar 可能有多个 namespace（`assets/<modid>/lang/...`），全部都要处理。
- 大整合包/大量模组用 `RunProcess` 跑脚本，避免 `Bash` 120 秒限制。

## 3. 语言文件格式（必须记住）

| 版本 | 路径 | 格式 |
| --- | --- | --- |
| 1.13+ | `assets/<namespace>/lang/en_us.json` → `zh_cn.json` | JSON：`"key": "文本"` |
| 1.12.2- | `assets/<namespace>/lang/en_US.lang` → `zh_CN.lang` | Properties：`key=文本` |

- **key 一律不翻译、不改名**。
- 保留格式符：`%s`、`%d`、`%1$s`、`%2$d`、`%%`。
- 保留颜色/样式码：`§a`、`§l`、`§r`；JSON 里可写 `\u00a7`。
- 保留换行 `\n`、制表 `\t`、以及 `{0}` / `${...}` 之类的占位符。
- JSON 用 UTF-8 无 BOM；`.lang` 用 UTF-8，若游戏内乱码再改 `\uXXXX` 转义。
- 已有 `zh_cn.json` 时以它为底稿，只补缺失 key，不要整份覆盖掉作者已有的翻译。

## 4. 生成汉化资源包（推荐方式）

资源包优先级高于模组自带资源，可以覆盖 lang 而不动 jar：

```
<instance>/resourcepacks/MyPack-zh_cn/
├─ pack.mcmeta
└─ assets/
   └─ <namespace>/
      └─ lang/
         └─ zh_cn.json        # 1.13+
         # 或 zh_CN.lang      # 1.12.2-
```

`pack.mcmeta`：

```json
{
  "pack": {
    "pack_format": 15,
    "description": "xxx 模组汉化"
  }
}
```

> `pack_format` **必须与目标 MC 版本一致**，不同版本会变（上面的 15 只是 1.20–1.20.1 的示例）。不要凭记忆填：查 Minecraft Wiki 的 Pack format，或复制一个同版本可用资源包的 `pack.mcmeta`。

安装：

1. 关闭游戏（改 `options.txt` 时）。
2. 把文件夹或 zip 放进 `resourcepacks/`。
3. 游戏内「选项 → 资源包」把它移到**最上面**（最高优先级）。
4. `F3 + T` 重载资源，检查物品提示/界面。

> 不要直接改 `mods/xxx.jar`：会破坏签名/更新，整合包更新后也会丢。只有用户明确要求且接受风险时才做，并先备份。

## 5. 批量翻译的节奏

- 先统计 key 总数，再**按 namespace/文件分批**，每批 100–200 个 key；不要一次把整个整合包塞进上下文。
- 同一批内维护术语表（物品名、模组名、UI 词），避免前后不一致。
- 每批写完立即做 JSON 校验 + key 对比，再进入下一批。
- 用 `Write` 生成新文件、`Edit` 补缺失 key；不要用一次超长输出覆盖已有翻译。
- 收尾检查「值仍与英文完全相同」的 key（可能是漏翻，也可能是有意保留的专名）：

```powershell
$en.PSObject.Properties | Where-Object { $zh.$($_.Name) -eq $_.Value } | Select-Object Name
```

## 6. 翻译质量

- 术语统一：参考 Minecraft Wiki 中文名与 CFPA 术语表（如 Nether = 下界，不要同一文件里混用「地狱」）。
- 物品/方块名短、tooltip 可稍长；不要为了「文雅」改变机制描述。
- 保留模组专有名词/品牌名，必要时音译并在括号里给英文。
- 不翻译调试信息、日志、命令 ID、注册名。
- 不臆造原文没有的功能说明。

## 7. 验证（必须做）

1. JSON 可解析：

```powershell
Get-ChildItem -Recurse -Filter zh_cn.json | ForEach-Object {
  try { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json | Out-Null; "OK $($_.FullName)" }
  catch { "BAD $($_.FullName): $_" }
}
```

2. key 对齐（缺 key/多 key）：

```powershell
$en = Get-Content -Raw en_us.json | ConvertFrom-Json
$zh = Get-Content -Raw zh_cn.json | ConvertFrom-Json
Compare-Object ($en.PSObject.Properties.Name) ($zh.PSObject.Properties.Name)
```

3. 游戏内切到「简体中文」，检查：
   - 物品名/tooltip、配置界面、聊天提示；
   - 是否有 `%s` 原样显示、颜色码错位、空字符串；
   - 资源包是否真的在模组资源之上（把包移到顶部再试）。

## 8. 输出格式

```md
**模组**：xxx 1.2.3（1.20.1 / Forge）
**现成汉化**：CFPA 包 / 无（说明来源与版本匹配）
**本次产物**：resourcepacks/xxx-zh_cn（N 个 namespace，M 个 key）
**验证**：JSON OK、key 对齐、游戏内已生效/待用户确认
**发布**：仅自用 / 已确认许可证允许
```

## 安全与许可

- 默认只做**个人使用**；公开发布/整合进整合包前确认模组许可证与作者授权。
- 不搬运付费内容、不绕过下载验证。
- 不运行来源不明的汉化安装器；优先手动放资源包。
- 修改 `options.txt`/config 前备份，游戏关闭时操作。
