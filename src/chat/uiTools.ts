import type { ToolDef } from './types.ts'

/**
 * 「启动器操作」工具组。
 *
 * 存在的意义：插件页面跑在 `sandbox="allow-scripts"` 的 iframe 里 —— 既拿不到
 * 启动器 DOM（没有 allow-same-origin），启动器也没有提供任何 UI 自动化 API。
 * 所以在「没有对应专用插件 API」的场景下（比如某个新页面、某个只有界面没有接口
 * 的功能），只能把启动器窗口当成普通桌面程序来操作。
 *
 * 实现走 OS 级自动化（UIAutomation 读界面 + 真实鼠标键盘输入），由工作区里编译
 * 出来的 C# 驱动完成。操作时会**移动真实鼠标**，用户能直接看到 AI 的点击过程。
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
        '默认用真实鼠标点击元素中心（会先把鼠标移动过去，用户能看到过程）；' +
        'mode="invoke" 时改用 UIAutomation 的 Invoke 模式（不移动鼠标，适合后台静默操作）。' +
        '结果里带 foreground 与元素集合的 diff（appeared/disappeared），可用来判断这一步有没有生效。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '目标元素 ref（来自 UiSnapshot；界面变了会失效，失效请重新快照）' },
          x: { type: 'integer', description: '屏幕绝对 X 坐标（不用 ref 时必填）' },
          y: { type: 'integer', description: '屏幕绝对 Y 坐标（不用 ref 时必填）' },
          mode: { type: 'string', enum: ['mouse', 'invoke'], description: 'mouse=真实鼠标点击（默认，可见）；invoke=UIAutomation 调用（不可见，可能对某些控件无效）' },
          moveMs: { type: 'integer', description: '鼠标移动动画时长毫秒（默认 420，设 0 为瞬移）' },
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
        '向启动器界面的输入框输入文本（支持中文等任意字符）。传 ref 会先点一下该输入框使其获得焦点。' +
        '默认先清空原有内容（clear=true）。实现是剪贴板 + Ctrl+V，因此会短暂占用剪贴板，' +
        '但用完会恢复原内容。若目标不是输入框，请改用 UiKeys 发快捷键。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本（支持中文/emoji）' },
          ref: { type: 'string', description: '目标输入框 ref（来自 UiSnapshot；不填则向当前焦点控件输入）' },
          clear: { type: 'boolean', description: '输入前是否先全选并删除原内容（默认 true）' },
          moveMs: { type: 'integer', description: '鼠标移动到输入框的动画时长毫秒（默认 360）' },
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
        '向启动器发送按键或快捷键（SendKeys 语法），如 "{ENTER}"、"{ESC}"、"{TAB}"、"{DOWN}"、' +
        '"^s"（Ctrl+S）、"%{F4}"（Alt+F4）。' +
        '可传 ref 先点击某个元素（例如点开输入框或让列表获得焦点）再发送。' +
        '注意：不能输入中文字符，输入文本请用 UiType。',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'SendKeys 表达式，如 "{ENTER}"、"^a"、"{TAB}{TAB}"' },
          ref: { type: 'string', description: '发送前先点击的元素 ref（可选）' },
          moveMs: { type: 'integer', description: '先点击元素时的鼠标动画时长毫秒（默认 320）' },
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
        '任何点击/输入前都应确保窗口在前台；操作失败（元素点不动、按键没反应）时可先调用它再重试。',
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
