import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeHttpError } from '../src/chat/stream.ts'
import { pluginLog } from '../src/lib/pluginLog.ts'

test('401 带服务端原因、端点、Key 状态与响应片段', () => {
  const msg = describeHttpError(
    { status: 401, body: JSON.stringify({ error: { message: 'invalid api key', type: 'auth' } }) },
    { baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: 'sk-1234' }
  )
  assert.match(msg, /HTTP 401/)
  assert.match(msg, /invalid api key/)
  assert.match(msg, /https:\/\/api\.deepseek\.com\/v1\/chat\/completions/)
  assert.match(msg, /deepseek-chat/)
  assert.match(msg, /API Key：已设置（7 位）/)
  assert.doesNotMatch(msg, /\*\*/) // 错误气泡是纯文本，不能留 Markdown 标记
})

test('空 body + 状态 0：说明是网络/代理层，不编造服务端原因', () => {
  const msg = describeHttpError({ status: 0, body: '' }, { baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' })
  assert.match(msg, /没有收到 HTTP 响应/)
  assert.match(msg, /网络不通/)
  assert.match(msg, /空（服务端未返回任何内容/)
})

test('首尾空格 Key 被指出（最常见的 401 来源）', () => {
  const msg = describeHttpError({ status: 401, body: '' }, { baseUrl: 'https://x.test/v1', apiKey: ' sk-1234\n' })
  assert.match(msg, /含首尾空格/)
})

test('响应片段回显 Key 时打码，不把密钥写进聊天气泡', () => {
  const key = 'sk-abcdef1234567890'
  const msg = describeHttpError({ status: 401, body: '{"error":{"message":"bad key sk-abcdef1234567890"}}' }, {
    baseUrl: 'https://x.test/v1',
    apiKey: key,
  })
  assert.doesNotMatch(msg, /sk-abcdef1234567890/)
  assert.match(msg, /sk-a\*\*\*/)
})

test('pluginLog 无桥接（浏览器直开/单测）时不抛异常', () => {
  assert.doesNotThrow(() => pluginLog('error', 'x', { a: 1 }))
})

test('pluginLog 把 message + 详情交给桥的 log 方法', () => {
  const calls: unknown[][] = []
  ;(globalThis as any).window = {
    __PLUGIN_API__: { call: (...args: unknown[]) => (calls.push(args), Promise.resolve()) },
  }
  try {
    pluginLog('warn', '工具调用异常', { tool: 'Bash' })
  } finally {
    delete (globalThis as any).window
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'log')
  assert.equal(calls[0][2], 'warn')
  assert.match(String(calls[0][1]), /^工具调用异常 \{"tool":"Bash"\}$/)
})
