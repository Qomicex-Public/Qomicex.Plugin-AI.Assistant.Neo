# AI 助手 (Assistant Neo)

Qomicex 启动器的 AI 助手插件，支持多模型对话、流式输出、工具调用、Markdown 渲染等功能。

## 功能

- 多模型支持（OpenAI / Ollama / 自定义兼容接口）
- 流式响应输出
- 工具调用（文件操作、网络请求、Shell 执行等）
- Markdown / 代码高亮渲染
- 对话历史管理
- 配置持久化
- 悬浮窗（Overlay）模式

## 技术栈

- React 19 + TypeScript
- Vite
- Tailwind CSS
- `@qomicex/plugin-ui`

## 开发

```bash
pnpm install
pnpm run dev
```

## 构建

```bash
pnpm run build          # tsc + vite build
qomicex verify          # manifest 校验
qomicex pack            # 打包 .qplugin
qomicex publish         # 签名并上传到商店
```

## 许可证

[MIT](LICENSE)
