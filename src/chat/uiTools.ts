import type { ToolDef } from './types.ts'

/**
 * 「启动器操作」工具组。
 *
 * 存在的意义：插件页面跑在 `sandbox="allow-scripts"` 的 iframe 里 —— 既拿不到
 * 启动器 DOM（没有 allow-same-origin），启动器也没有提供任何 UI 自动化 API。
 * 所以在「没有对应专用插件 API」的场景下（比如某个新页面、某个只有界面没有接口
 * 的功能），只能把启动器窗口当成普通桌面程序来操作。
 *
 * 实现走 OS 级自动化（UIAutomation 读界面 + 把鼠标/键盘消息投递进 WebView2），由工作区里
 * 编译出来的 C# 驱动完成。操作期间**不移动用户的真实鼠标、也不抢焦点**：界面上显示的是助手
 * 自己的虚拟光标（启动器窗口上的一层点击穿透浮层），所以用户能继续用电脑，操作在后台也生效。
 *
 * 这组工具的行为约定（提示词里也会再说一遍）：
 *   - 先 UiSnapshot 拿到元素与 ref，再 UiClick/UiType，最后再 UiSnapshot 验证；
 *   - ref 是快照时的定位编码，界面一变就可能失效，失效要重新快照，不要猜；
 *   - 危险动作（删除、卸载、付款、发布等）动手前必须先征得用户同意。
 */
export const uiToolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'UiSnapshot',
      description:
        '读取启动器界面的可交互元素清单（按钮/输入框/链接/列表项等），返回元素类型、名称、' +
        '坐标矩形、可用 action 以及可复用的 ref。默认只返回可交互元素，按原文顺序给出。' +
        '元素较多时用 keyword 过滤、用 offset/max 翻页。' +
        '这是所有界面操作的第一步：拿到 ref 才能 UiClick / UiType。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '只保留名称/值/类型包含该关键词的元素（可选，强烈推荐大界面时使用）' },
          interactiveOnly: { type: 'boolean', description: '只看可交互元素（默认 true；设 false 会返回大量无语义节点，谨慎）' },
          max: { type: 'integer', description: '本次最多返回多少条（默认 60，上限 300）' },
          offset: { type: 'integer', description: '分页偏移（默认 0）。返回里若带 note 说明还有更多，用 note 里的 offset 继续取' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'UiClick',
      description:
        '点击启动器界面上的元素。优先用 ref（来自 UiSnapshot，最稳）；也支持直接给屏幕坐标 x/y。' +
        '默认 mode="auto"：把点击消息直接投递进网页 —— **不移动用户的真实鼠标、也不抢焦点**，' +
        '界面上只显示助手自己的虚拟光标与点击涟漪。投递被拒时才退回 UIAutomation 调用（那一步 Chromium 会把启动器带到前台，' +
        '助手会立刻把前台还给用户原来的窗口）。' +
        '只有 mode="mouse" 才会真的动系统指针（会打断用户，尽量避免）。' +
        '结果里带 method（post/invoke/mouse）、restoredForeground（是否把被抢的前台还原了）' +
        '和元素集合的 diff（appeared/disappeared），可判断这一步有没有生效。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '目标元素 ref（来自 UiSnapshot；界面变了会失效，失效请重新快照）' },
          x: { type: 'integer', description: '屏幕绝对 X 坐标（不用 ref 时必填）' },
          y: { type: 'integer', description: '屏幕绝对 Y 坐标（不用 ref 时必填）' },
          mode: { type: 'string', enum: ['auto', 'invoke', 'post', 'mouse'], description: 'auto=自动（默认：先投递点击，不动鼠标也不抢焦点；被拒时才退回 UIAutomation 调用）；invoke=只用 UIAutomation 调用（会把启动器带到前台，抢焦点）；post=只投递点击消息（不动鼠标、不抢焦点，对自绘控件有效）；mouse=真实鼠标点击（会动系统指针并抢前台，尽量避免）' },
          moveMs: { type: 'integer', description: '虚拟光标滑到目标的动画时长毫秒（默认 420，设 0 为瞬移）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'UiType',
      description:
        '向启动器界面的输入框写入文本（支持中文等任意字符）。优先直接把值写进控件' +
        '（不占剪贴板、中文安全）。默认先清空原有内容（clear=true）。' +
        '注意：实测 Chromium 在写值时会顺手把启动器窗口带到前台，助手会**立刻把前台还给用户原来的窗口**' +
        '（结果里的 restoredForeground=true 表示已还原），所以不会一直抢走焦点。' +
        '若该控件不支持直接写值，会返回 E_NEEDS_ACTIVATE：此时需要显式传 activate=true，' +
        '助手才会把启动器切到前台用真实键盘键入（会短暂打断用户，仅在必要时用）。' +
        '若目标不是输入框，请改用 UiKeys 发按键。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本（支持中文/emoji）。传空字符串 + clear=true 表示只清空输入框' },
          ref: { type: 'string', description: '目标输入框 ref（来自 UiSnapshot；建议必填 —— 不填则写向当前焦点控件，那需要 activate=true）' },
          clear: { type: 'boolean', description: '写入前是否先清空原有内容（默认 true；false 表示在原值后追加）' },
          activate: { type: 'boolean', description: '允许抢焦点（默认 false）。仅在控件不支持无焦点写值、且确实需要输入时才设 true' },
          moveMs: { type: 'integer', description: '虚拟光标滑到输入框的动画时长毫秒（默认 360）' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'UiKeys',
      description:
        '向启动器发送按键（SendKeys 语法），如 "{ENTER}"、"{ESC}"、"{TAB}"、"{DOWN}"、' +
        '"^s"（Ctrl+S）、"%{F4}"（Alt+F4）。' +
        '普通键（{ENTER}/{TAB}/{ESC}/方向键/F1-F12/单个 ASCII 字符）默认**不抢焦点**直接投递，用户不会被打断；' +
        '带 Ctrl/Alt/Shift 的组合必须 activate=true（WebView2 不认投递的修饰键，会把 Ctrl+A 当成普通 "a"），' +
        '那会把启动器切到前台、用真实键盘发送 —— 属于例外，仅在必要时用。' +
        '可传 ref 先把网页内某个元素点成焦点。注意：不能输入中文字符，输入文本请用 UiType。',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'SendKeys 表达式，如 "{ENTER}"、"^a"、"{TAB}{TAB}"' },
          ref: { type: 'string', description: '发送前先点击的元素 ref（可选，用来设置网页内焦点）' },
          activate: { type: 'boolean', description: '允许抢焦点（默认 false）。带修饰键的快捷键必须设为 true；只投递不了的特殊键也用它兜底' },
          moveMs: { type: 'integer', description: '先滑到元素时的虚拟光标动画时长毫秒（默认 320）' },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'UiFocus',
      description:
        '把启动器主窗口切到前台并返回是否成功（foreground）。' +
        '点击/输入默认不需要它（默认路径不抢焦点，窗口在后台也能操作）；' +
        '只有确实要让用户看到界面、或要用真实键盘/鼠标操作时才调用 —— 它会打断用户当前正在做的事。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'UiScreenshot',
      description:
        '截取启动器窗口当前画面，并**作为图片附加到对话中**供你直接查看（需要当前模型支持图片模态）。' +
        '用于确认界面状态、看清没有可访问性信息的自绘控件（图标、Canvas、图表）。' +
        '截图不含鼠标光标，也不干扰界面。文本内容优先用 UiSnapshot（更省 token 也更精确）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
]
