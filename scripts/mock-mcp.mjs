#!/usr/bin/env node
/**
 * 本地 mock MCP 服务器（无依赖），用于验收 Skill / MCP 客户端。
 *
 *   node scripts/mock-mcp.mjs
 *   # 默认 http://127.0.0.1:18765/mcp
 *
 * 环境变量：
 *   MOCK_PORT=18765        监听端口
 *   MOCK_TOOL_COUNT=2      生成的工具数量（>25 可测「折叠为 McpListTools」）
 *   MOCK_SSE=1             用 text/event-stream 回复（测试 SSE 解析）
 *   MOCK_STATUS=401        强制返回指定 HTTP 状态（测试错误兜底）
 *
 * 注意：启动器的 CORS 代理会拒绝内网/回环地址（PROXY_PRIVATE_ADDRESS），
 * 所以在真实启动器里不能直连 127.0.0.1。这个脚本用于：
 *   1) 插件在 `pnpm dev` 浏览器直开模式（没有 __PLUGIN_API__ 时走原生 fetch）验收；
 *   2) 单独调协议逻辑 / 调试客户端。
 * 真实环境请把 MCP 部署到可公网访问的 HTTPS 地址。
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 18765)
const TOOL_COUNT = Math.max(0, Number(process.env.MOCK_TOOL_COUNT || 2))
const FORCE_STATUS = Number(process.env.MOCK_STATUS || 0)
const USE_SSE = process.env.MOCK_SSE === '1'
const SESSION_ID = 'mock-session-' + Math.random().toString(36).slice(2, 10)

function tools() {
  const list = [
    {
      name: 'echo',
      description: '原样返回输入文本（测试连通性）',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '两个整数相加',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  ]
  while (list.length < TOOL_COUNT) {
    const n = list.length + 1
    list.push({
      name: 'tool_' + n,
      description: '自动生成的测试工具 #' + n,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    })
  }
  return list.slice(0, Math.max(TOOL_COUNT, 0) || 2)
}

const ALL_TOOLS = tools()

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function makeResponse(body) {
  if (!USE_SSE) {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  }
  // 先发一个 ping，再发真正的响应：客户端必须忽略 event: ping
  const payload =
    'event: ping\ndata: {"jsonrpc":"2.0","method":"ping"}\n\n' +
    'event: message\ndata: ' +
    JSON.stringify(body) +
    '\n\n'
  return { headers: { 'Content-Type': 'text/event-stream' }, body: payload }
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    return
  }

  let raw = ''
  req.on('data', (c) => {
    raw += c
  })
  req.on('end', () => {
    let msg
    try {
      msg = JSON.parse(raw || '{}')
    } catch {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }

    if (FORCE_STATUS) {
      res.writeHead(FORCE_STATUS, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock forced status ' + FORCE_STATUS } }))
      return
    }

    // 通知没有 id：按 MCP 规范回 202/204
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202, cors)
      res.end()
      return
    }

    let body
    switch (msg.method) {
      case 'initialize':
        body = rpcResult(msg.id, {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '0.0.1' },
        })
        break
      case 'tools/list':
        body = rpcResult(msg.id, { tools: ALL_TOOLS })
        break
      case 'tools/call': {
        const name = msg.params?.name
        const args = msg.params?.arguments || {}
        if (name === 'echo') {
          body = rpcResult(msg.id, { content: [{ type: 'text', text: 'echo: ' + String(args.text ?? '') }] })
        } else if (name === 'add') {
          const sum = Number(args.a || 0) + Number(args.b || 0)
          body = rpcResult(msg.id, { content: [{ type: 'text', text: String(sum) }] })
        } else if (ALL_TOOLS.some((t) => t.name === name)) {
          body = rpcResult(msg.id, { content: [{ type: 'text', text: `mock tool ${name} ok: ${JSON.stringify(args)}` }] })
        } else {
          body = rpcResult(msg.id, { content: [{ type: 'text', text: 'unknown tool: ' + String(name) }], isError: true })
        }
        break
      }
      default:
        body = rpcError(msg.id, -32601, 'Method not found: ' + msg.method)
    }

    const out = makeResponse(body)
    res.writeHead(200, { ...cors, ...out.headers, 'Mcp-Session-Id': SESSION_ID })
    res.end(out.body)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-mcp] listening on http://127.0.0.1:${PORT}/mcp`)
  console.log(`[mock-mcp] tools=${ALL_TOOLS.length} sse=${USE_SSE ? 'on' : 'off'} session=${SESSION_ID}`)
})
