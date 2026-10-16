import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 关键：构建产物用相对路径 base，避免打包后 /assets/... 被解析成站点根路径
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
        overlay: 'overlay.html',
        agent: 'agent.html',
        slots: 'slots.html',
      },
      output: {
        // 入口文件名保持稳定（不带 hash）：胶囊需要按确定路径写死悬浮窗脚本地址
        // （动态悬浮窗内容由插件字符串提供，无法在构建期引用产物 hash）。
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
