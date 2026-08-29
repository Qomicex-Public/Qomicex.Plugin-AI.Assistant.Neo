import type { ToolDef } from './types.ts'

export const toolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'listInstances',
      description: '列出所有 Minecraft 游戏实例',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getInstance',
      description: '获取指定游戏实例的详细信息',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getInstanceLaunchProgress',
      description: '查询实例的启动进度',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createInstance',
      description: '创建新的 Minecraft 游戏实例。创建后必须再调用 installInstance 安装版本和加载器（两步不可合并）',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '实例名称' },
          gameVersion: { type: 'string', description: 'Minecraft 版本号，如 1.20.1' },
          loader: { type: 'string', description: '加载器类型，可选 fabric/forge/neoforge/quilt' },
          loaderVersion: { type: 'string', description: '加载器版本号' },
          javaPath: { type: 'string', description: 'Java 路径（可选，不填自动选择）' },
          maxMemory: { type: 'integer', description: '最大内存 MB（可选，默认 4096）' },
          gameDir: { type: 'string', description: '游戏目录（可选，默认 .minecraft）' },
        },
        required: ['name', 'gameVersion', 'loader', 'loaderVersion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launchInstance',
      description: '启动指定游戏实例，自动跟踪启动进度。不填 accountUuid 则使用默认账号',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 ID' },
          accountUuid: { type: 'string', description: '指定账号 UUID（可选）' },
          joinServer: { type: 'string', description: '快捷加入服务器地址（可选）' },
          joinWorld: { type: 'string', description: '快捷加入世界名（可选）' },
        },
        required: ['instanceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'installInstance',
      description: '触发实例安装（下载 MC 版本/加载器/附加组件）。先 createInstance 创建，再用本工具触发',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 ID' },
          loader: { type: 'string', description: '加载器类型：fabric/forge/neoforge/quilt' },
          loaderVersion: { type: 'string', description: '加载器版本号' },
          addons: { type: 'array', items: { type: 'string' }, description: '附加组件列表，如 ["fabric-api"]（可选）' },
          optifineVersion: { type: 'string', description: 'OptiFine 版本（可选）' },
          versionIsolation: { type: 'boolean', description: '是否版本隔离（可选，默认 true）' },
          downloadThreads: { type: 'integer', description: '下载线程数（可选，默认 64）' },
        },
        required: ['instanceId', 'loader', 'loaderVersion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchResources',
      description: '跨平台搜索 Minecraft 资源（模组、资源包、光影包等），支持 Modrinth/CurseForge',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          source: { type: 'string', description: '数据源，可选 modrinth（默认）/curseforge/ftb' },
          page: { type: 'integer', description: '页码，从 1 开始（可选）' },
          pageSize: { type: 'integer', description: '每页条数（可选）' },
          gameVersion: { type: 'string', description: '筛选 MC 版本（可选）' },
          loader: { type: 'string', description: '筛选加载器（可选）' },
          category: { type: 'string', description: '类别：mod/modpack/resourcepack/shader/datapack' },
          sort: { type: 'string', description: '排序：relevance/downloads/updated/newest' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getResourceDetail',
      description: '获取某个资源的详细信息',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '资源 ID' }, source: { type: 'string', description: '数据源，可选 modrinth（默认）/curseforge' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getResourceVersions',
      description: '获取指定资源的可用版本列表',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '资源 ID' },
          source: { type: 'string', description: '数据源，可选 modrinth（默认）/curseforge' },
          gameVersion: { type: 'string', description: '筛选 MC 版本（可选）' },
          loader: { type: 'string', description: '筛选加载器（可选）' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getVersionDownloads',
      description: '获取指定资源版本的下载链接列表（确定版本后调用）',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '资源 ID' },
          versionId: { type: 'string', description: '版本 ID（从 getResourceVersions 获取）' },
          source: { type: 'string', description: '数据源，可选 modrinth（默认）/curseforge' },
        },
        required: ['id', 'versionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getResourceDependencies',
      description: '获取指定资源版本的依赖树（递归解析），安装前建议先检查依赖',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '资源 ID' },
          source: { type: 'string', description: '数据源，可选 modrinth（默认）/curseforge' },
          versionId: { type: 'string', description: '版本 ID（可选）' },
          gameVersion: { type: 'string', description: 'MC 版本（可选）' },
          loader: { type: 'string', description: '加载器（可选）' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'startDownload',
      description: '下载资源到指定实例。先用 searchResources→getResourceVersions→getVersionDownloads 拿下载链接，再用本工具下载；getDownloadProgress 可查进度',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '目标实例 ID' },
          url: { type: 'string', description: '下载 URL' },
          fileName: { type: 'string', description: '保存的文件名' },
          category: { type: 'string', description: '类别：mods/resourcepacks/shaderpacks/datapacks/saves' },
        },
        required: ['instanceId', 'url', 'fileName', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDownloadProgress',
      description: '查询资源下载进度',
      parameters: { type: 'object', properties: { taskId: { type: 'string', description: '下载任务 ID' } }, required: ['taskId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'installMod',
      description: '自动搜索并安装模组到指定实例（搜索→匹配版本→查依赖→下载）。找到多个模组时询问用户选择；先用 listInstances 确认目标实例',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '模组名称关键词' },
          instanceId: { type: 'string', description: '目标实例 ID' },
          gameVersion: { type: 'string', description: 'MC 版本（可选，不填从实例信息自动获取）' },
          loader: { type: 'string', description: '加载器（可选，不填从实例信息自动获取）' },
          source: { type: 'string', description: '数据源：modrinth（默认）/curseforge' },
        },
        required: ['keyword', 'instanceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listMods',
      description: '列出指定实例的模组文件列表',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getModMetadata',
      description: '获取指定实例的模组元数据（名称、版本、描述、图标等）',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enableDisableMod',
      description: '启用或禁用指定实例中的某个模组',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 ID' },
          name: { type: 'string', description: '模组文件名（如 sodium.jar）' },
          enable: { type: 'boolean', description: 'true=启用，false=禁用' },
        },
        required: ['instanceId', 'name', 'enable'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listInstanceFiles',
      description: '列出指定实例某类文件（resourcepacks/shaderpacks/datapacks/screenshots/saves/lan-games）',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'string', description: '实例 ID' },
          category: { type: 'string', enum: ['resourcepacks', 'shaderpacks', 'datapacks', 'screenshots', 'saves', 'lan-games'], description: '文件类别' },
        },
        required: ['instanceId', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listServers',
      description: '列出指定实例的服务器列表',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' } }, required: ['instanceId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copySave',
      description: '复制指定实例的存档',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, name: { type: 'string', description: '原存档名' }, newName: { type: 'string', description: '新存档名' } }, required: ['instanceId', 'name', 'newName'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'renameSave',
      description: '重命名指定实例的存档',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, oldName: { type: 'string', description: '原存档名' }, newName: { type: 'string', description: '新存档名' } }, required: ['instanceId', 'oldName', 'newName'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'backupSave',
      description: '备份指定实例的存档',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, name: { type: 'string', description: '要备份的存档名' } }, required: ['instanceId', 'name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'addServer',
      description: '向指定实例添加服务器',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, name: { type: 'string', description: '服务器名称' }, ip: { type: 'string', description: '服务器地址（IP或域名）' } }, required: ['instanceId', 'name', 'ip'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deleteServer',
      description: '删除指定实例的服务器',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, ip: { type: 'string', description: '要删除的服务器地址' } }, required: ['instanceId', 'ip'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pingServer',
      description: 'Ping 测试指定服务器地址的延迟和在线状态',
      parameters: { type: 'object', properties: { instanceId: { type: 'string', description: '实例 ID' }, address: { type: 'string', description: '服务器地址' } }, required: ['instanceId', 'address'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSystemInfo',
      description: '获取系统和启动器信息（OS、内存、版本等）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getLauncherSettings',
      description: '获取启动器当前设置',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getConnectorStatus',
      description: '获取联机（局域网/公网联机）的当前状态',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hostRoom',
      description: '开房联机。可用指定端口开房，或基于实例开房。成功后返回房间码供他人加入',
      parameters: { type: 'object', properties: { port: { type: 'integer', description: '指定端口（可选，填则用端口开房）' }, instanceId: { type: 'string', description: '实例 ID（可选，填则基于实例开房）' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'joinRoom',
      description: '输入房间码加入他人开的房间',
      parameters: { type: 'object', properties: { code: { type: 'string', description: '房间码' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getNatType',
      description: '检测当前网络的 NAT 类型（联机前建议先检测）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkHealth',
      description: '检查后端服务是否正常运行',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listPlugins',
      description: '列出所有已安装的启动器插件',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listLogs',
      description: '列出启动器的日志文件',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parseModpack',
      description: '解析整合包文件（需要提供服务器上的文件路径或上传）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'installModpack',
      description: '安装 Minecraft 整合包。本地来源传 path（.zip/.mrpack）；在线来源传 type(mr/cf/ftb)+projectId+fileId。自动创建实例并下载，gameDir 必填',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '实例名称，如 MyPack' },
          type: { type: 'string', enum: ['mr', 'cf', 'ftb', 'modrinth', 'curseforge'], description: '整合包来源类型（在线安装时必填）' },
          projectId: { type: 'string', description: '整合包项目 ID（在线安装时必填）' },
          fileId: { type: 'string', description: '整合包文件/版本 ID（在线安装时必填）' },
          path: { type: 'string', description: '本地整合包文件路径（本地安装时必填），如 C:/packs/pack.zip' },
          gameDir: { type: 'string', description: '实例游戏目录，如 C:/games/mc' },
          versionIsolation: { type: 'boolean', description: '是否版本隔离（可选，默认 true）' },
          maxMemory: { type: 'integer', description: '最大内存 MB（可选，默认 4096）' },
        },
        required: ['id', 'gameDir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'addCustomJava',
      description: '添加自定义 Java 运行时路径到启动器',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Java 可执行文件完整路径，如 C:\\Program Files\\Java\\jdk-17\\bin\\javaw.exe' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listLoaderVersions',
      description: '获取指定 MC 版本和加载器的可用版本列表',
      parameters: { type: 'object', properties: { gameVersion: { type: 'string', description: 'MC 版本，如 1.20.1' }, loader: { type: 'string', description: '加载器类型：fabric/forge/neoforge/quilt，默认 All' } }, required: ['gameVersion'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getVersionMetadata',
      description: '获取指定 Minecraft 版本的元数据（完整 version JSON）',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '版本名称' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkUpdate',
      description: '检查启动器是否有可用更新',
      parameters: { type: 'object', properties: { current: { type: 'string', description: '当前版本号（可选）' }, channel: { type: 'string', description: '更新频道（可选）' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchWiki',
      description: '在 Minecraft Wiki（中文）搜索关键词，返回页面标题列表（游戏机制/物品/生物/指令等知识）',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词，如：红石、附魔、末地传送门' }, limit: { type: 'integer', description: '返回条数（可选，默认 5，最大 10）' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getWikiContent',
      description: '获取 Minecraft Wiki（中文）指定页面内容。先 searchWiki 确认标题再传入',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 'Wiki 页面标题（从 searchWiki 获取）' }, section: { type: 'string', description: '指定段落标题（可选，只获取该段落）' } }, required: ['title'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchMcMod',
      description: '在 MC百科（mcmod.cn）搜索模组资料。仅模组配方/教程/已知问题/介绍时用；搜索下载模组优先 searchResources。MC百科有限流注意间隔',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMcmodContent',
      description: '获取 MC百科页面/模组详细内容（简介/教程/说明）。仅模组具体问题时用，先 searchMcMod 拿链接再传入。有限流注意间隔',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'mcmod.cn 页面链接，如 https://www.mcmod.cn/class/123.html' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sendNotification',
      description: '在启动器界面显示通知消息',
      parameters: { type: 'object', properties: { message: { type: 'string', description: '通知内容' }, type: { type: 'string', enum: ['info', 'success', 'error'], description: '通知类型（可选，默认 info）' } }, required: ['message'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigateTo',
      description: '导航到启动器的指定页面',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '页面路径，如 /plugins/p/xxx 或 /instances' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'callBackendApi',
      description: '通用调用后端 API（当没有专门工具时使用）',
      parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP 方法' }, endpoint: { type: 'string', description: 'API 端点路径，如 /instance' }, data: { type: 'string', description: '请求体 JSON 字符串（POST 时使用）' } }, required: ['method', 'endpoint'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bingSearch',
      description: 'Bing 网页搜索，返回结果列表（标题/摘要/链接）。用于通用知识、最新资讯，或 wiki/mcmod 查不到的问题',
      parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词' }, limit: { type: 'integer', description: '返回条数（可选，默认 5，最大 10）' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetchWeb',
      description: '抓取网页内容。普通网页返回正文；视频站（YouTube/Bilibili/Twitch 等）仅返回标题与简介；Bilibili 图文专栏返回正文。部分网站可能拒绝访问',
      parameters: { type: 'object', properties: { url: { type: 'string', description: '要抓取的完整 URL（http/https）' }, maxLength: { type: 'integer', description: '返回最大字符数（可选，默认 8000）' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readFile',
      description: '读取电脑文件。高风险：仅用户明确要求时用，执行前说明路径；未授权路径会要求授权',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径，如 C:\\Users\\xxx\\test.txt' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convertDocument',
      description: '把二进制文档（PDF/Word/Excel/PPT/图片/音频等）转 Markdown 后读取内容。依赖 MarkItDown 插件。高风险：仅用户明确要求时用，执行前说明路径',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径，如 C:\\Users\\xxx\\report.pdf' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description: '写入内容到电脑文件（覆盖已有内容）。高风险：仅用户明确要求时用，先说明路径与内容概要并获确认',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径，如 C:\\Users\\xxx\\test.txt' }, content: { type: 'string', description: '要写入的文本内容' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deleteFile',
      description: '删除电脑文件。极高风险（不可恢复）：仅用户明确要求时用，先复述路径并获确认',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '要删除的文件绝对路径，如 C:\\Users\\xxx\\test.txt' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execCommand',
      description: '执行一条 shell 命令（Windows 用 PowerShell）。极高风险：仅用户明确要求时用，先复述命令并获确认，不得用于未经要求的操作',
      parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' }, timeoutMs: { type: 'integer', description: '超时毫秒数（可选，默认 15000，范围 1000-120000）' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sleep',
      description: '等待指定时长后再继续（用于控制操作节奏、等待后台任务如下载/启动完成）。耗时操作轮询前建议先 sleep 再查询',
      parameters: { type: 'object', properties: { durationMs: { type: 'integer', description: '等待毫秒数，范围 100~600000（0.1 秒~10 分钟）' } }, required: ['durationMs'] },
    },
  },
]