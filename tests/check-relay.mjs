/**
 * 本地 OpenAI 兼容接口（api-server.ts）回归。
 *
 * 为什么值得单独守：它是**给外部软件用的门面**，两边都容易被改坏 ——
 *  · 请求翻译（OpenAI messages → DSH blocks）：错了模型收到的历史就是错的，
 *    而且不会报错，只会"答得莫名其妙"；
 *  · 响应翻译（事件流 → chunk / JSON）：错了客户端会显示空回复或永远转圈；
 *  · 失败路径：未登录 / 限流必须用 **HTTP 状态码**说清楚，否则客户端只会显示"服务异常"。
 *
 * 反向验证（把实现改坏再跑，必须变红；2026-09-28 逐条实跑过）：
 *  1. `toDsMessages` 里把 tool 消息的 role 写成 'assistant'
 *     ⇒「消息翻译」红（角色顺序那条断言），1 项失败；
 *  2. `handleChat` 里去掉首事件预取（吞掉首个失败）
 *     ⇒「未登录回 503」+「限流 429」红（会变成 200 + 空流），2 项失败；
 *  3. 流式 delta 里把 arguments 错填成 `event.name` ⇒「流式：SSE 分帧」红；
 *  4. 抽掉 `deletesWebSession` 的两个覆盖分支 ⇒「删 / 不删」红；
 *  5. 去掉 `foldStream` 的 try/catch（让流中途的抛错直接放出去）⇒「流中途抛错」红；
 *  6. `readRelayConfig` 不剥 BOM ⇒「带 BOM 也要认」红（失败形态是静默回落成默认值）。
 *
 * 用法: node tests/check-relay.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-relay-'))
process.env.DSH_HOME = HOME

const {
  createRelayServer,
  toRelayCall,
  resolveRelayModel,
  normalizeRelayConfig,
  readRelayConfig,
  writeRelayConfig,
  relaySettingsPath,
  DEFAULT_RELAY_CONFIG,
} = await import('../src/api-server.ts')
const { responsesToChatBody, responsesResult } = await import('../src/responses.ts')
const { readJsonBody } = await import('../src/index.ts')

const MODELS = [
  { id: 'deepseek-chat', name: '快速模式（不思考）', description: 'thinking 关闭' },
  { id: 'deepseek-reasoner', name: '快速模式（深度思考）', description: 'thinking 开启' },
]

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}

/** 脚本化的事件流：数组里放事件对象，放 Error 就直接抛（模拟适配器的失败）。 */
function scriptedStream(script, seen) {
  return (options) => {
    seen.push(options)
    return (async function* () {
      for (const step of script) {
        if (step instanceof Error) throw step
        yield step
      }
    })()
  }
}

/**
 * 起一个用假流的接口（默认端口 0 = 随机），返回 { base, seen, server }。
 *
 * ⚠️ 默认端口必须随机：同一个固定端口上"停一个再起一个"时，客户端连接池里那条
 * keep-alive 连接会指向已经死掉的 socket，下一次请求拿到 ECONNRESET（实测踩过）。
 * 那是压测装置的假象，不是接口的问题 —— 每条用例各用一个端口就没这回事。
 * ⚠️ 代码默认是**关**的（见 api-server.ts 的说明），用例一律显式开。
 */
async function startRelay({ script = [], config = {}, admin, consoleHtml } = {}) {
  const seen = []
  const server = createRelayServer({
    stream: scriptedStream(script, seen),
    readBody: (req, limit) => readJsonBody(req, limit),
    config: normalizeRelayConfig({ enabled: true, port: 0, ...config }),
    models: MODELS,
    ...(admin ? { admin } : {}),
    ...(consoleHtml ? { consoleHtml } : {}),
  })
  const port = await server.start()
  return { base: `http://127.0.0.1:${port}`, seen, server }
}

async function postJson(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const CHAT = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '你好' }],
}

// ── 请求翻译（纯函数）──────────────────────────────────────────────

await test('模型名归一：认语义分流，认不出落到不思考档（不报错）', () => {
  assert.equal(resolveRelayModel('deepseek-reasoner'), 'deepseek-reasoner')
  assert.equal(resolveRelayModel('deepseek-chat'), 'deepseek-chat')
  assert.equal(resolveRelayModel('my-thinking-model'), 'deepseek-reasoner')
  assert.equal(resolveRelayModel('gpt-4o'), 'deepseek-chat')
  assert.equal(resolveRelayModel(undefined), 'deepseek-chat')
})

await test('消息翻译：system / assistant 工具调用 / tool 结果都进对位', () => {
  const { options } = toRelayCall({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是测试' },
      { role: 'user', content: [{ type: 'text', text: '读一下 a.txt' }] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
    ],
  })
  assert.deepEqual(options.messages[0], { role: 'system', content: [{ type: 'text', text: '你是测试' }] })
  assert.deepEqual(options.messages[1], { role: 'user', content: [{ type: 'text', text: '读一下 a.txt' }] })
  // 角色顺序单独钉一次：tool 结果必须落在 **user** 槽里（protocol.ts 只在 user 消息里找
  // tool-result 块；写进 assistant 会被整条丢掉，而且不报错）
  assert.deepEqual(
    options.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'user'],
  )
  assert.deepEqual(options.messages[2].content[0], {
    type: 'tool-call',
    id: 'call_1',
    name: 'read',
    arguments: '{"path":"a.txt"}',
  })
  assert.deepEqual(options.messages[3].content[0], {
    type: 'tool-result',
    toolCallId: 'call_1',
    isError: false,
    content: [{ type: 'text', text: 'hello' }],
  })
  assert.equal(options.purpose, 'chat', '自动续写只对 chat 用途生效')
})

await test('工具定义：OpenAI 的 function 包装拆平，parameters 原样透传', () => {
  const { options } = toRelayCall({
    ...CHAT,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read',
          description: '读文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ],
  })
  assert.equal(options.tools.length, 1)
  assert.deepEqual(options.tools[0], {
    name: 'read',
    description: '读文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  })
})

await test('reasoning_effort：映射到适配器认的档位；认不出的不传（别触发 UNSUPPORTED）', () => {
  assert.equal(toRelayCall({ ...CHAT, reasoning_effort: 'none' }).options.reasoningEffort, 'off')
  assert.equal(toRelayCall({ ...CHAT, reasoning_effort: 'high' }).options.reasoningEffort, 'high')
  assert.equal(toRelayCall({ ...CHAT, reasoning_effort: 'weird' }).options.reasoningEffort, undefined)
})

await test('keep_conversation：true/false 各自映射到单次请求的删 / 不删开关', () => {
  assert.equal(toRelayCall({ ...CHAT, keep_conversation: true }).options.__keepSession, true)
  assert.equal(toRelayCall({ ...CHAT, keep_conversation: false }).options.__deleteSession, true)
  const untouched = toRelayCall(CHAT).options
  assert.equal(untouched.__keepSession, undefined)
  assert.equal(untouched.__deleteSession, undefined)
  assert.throws(() => toRelayCall({ ...CHAT, keep_conversation: 'yes' }), /keep_conversation/)
})

await test('非法请求体：messages 缺失 / 空数组都抛（回 400 而不是 500）', () => {
  assert.throws(() => toRelayCall({ model: 'deepseek-chat' }), /messages/)
  assert.throws(() => toRelayCall({ model: 'deepseek-chat', messages: [] }), /messages/)
})

await test('图片段：不静默丢历史，写一句「这儿有图但没给你」', () => {
  const { options } = toRelayCall({
    ...CHAT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  })
  const text = options.messages[0].content[0].text
  assert.match(text, /看图/)
  assert.match(text, /image omitted/)
})

// ── 设置文件 ──────────────────────────────────────────────────────

await test('设置落盘：api-server.json 读写往返 + 越界端口被收敛', () => {
  writeRelayConfig({ enabled: false, port: 8788, key: 'abc' })
  assert.deepEqual(readRelayConfig(), { enabled: false, port: 8788, key: 'abc' })
  assert.match(readFileSync(relaySettingsPath(), 'utf8'), /"port": 8788/)
  assert.equal(normalizeRelayConfig({ port: 80 }).port, DEFAULT_RELAY_CONFIG.port === 80 ? 80 : 1024)
  assert.equal(normalizeRelayConfig({ port: 999999 }).port, 65535)
  assert.equal(normalizeRelayConfig({ port: 0 }).port, 0, '0 = 随机端口（单测/临时用）')
  assert.equal(normalizeRelayConfig({ key: '  secret  ' }).key, 'secret')
})

await test('手改的文件带 BOM 也要认（记事本 / PowerShell 5.1 写出来的都带）', () => {
  // ⚠️ 反向验证：把 readRelayConfig 里的 replace(/^\uFEFF/) 去掉 → 这条红，
  //    而且失败方式是**静默回落成默认值**（README 让人手改这个文件，最容易踩）。
  writeFileSync(relaySettingsPath(), '\uFEFF' + JSON.stringify({ enabled: true, port: 9999, key: 'bom' }))
  assert.deepEqual(readRelayConfig(), { enabled: true, port: 9999, key: 'bom' })
})

// ── HTTP：正常路径 ────────────────────────────────────────────────

await test('GET /v1/models：两条档位齐全', async () => {
  const { base, server } = await startRelay()
  try {
    const res = await fetch(`${base}/v1/models`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'list')
    assert.deepEqual(body.data.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner'])
  } finally {
    await server.stop()
  }
})

await test('非流式：正文 + usage 拼成 OpenAI 的 chat.completion', async () => {
  const { base, seen, server } = await startRelay({
    script: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, serverTotal: true } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  try {
    const res = await postJson(base, '/v1/chat/completions', CHAT)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.model, 'deepseek-chat')
    assert.equal(body.choices[0].message.role, 'assistant')
    assert.equal(body.choices[0].message.content, '你好')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
    // 翻译真的落到适配器入口（不是只回了句漂亮话）
    assert.equal(seen.length, 1)
    assert.equal(seen[0].messages[0].content[0].text, '你好')
    assert.equal(seen[0].model, 'deepseek-chat')
  } finally {
    await server.stop()
  }
})

await test('非流式：思考档把推理流单独放在 reasoning_content', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '先算 1+1' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先算 1+1' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '2' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  try {
    const body = await (await postJson(base, '/v1/chat/completions', { ...CHAT, model: 'deepseek-reasoner' })).json()
    assert.equal(body.choices[0].message.reasoning_content, '先算 1+1')
    assert.equal(body.choices[0].message.content, '2')
  } finally {
    await server.stop()
  }
})

await test('工具调用：合成 tool_calls + finish_reason=tool_calls（arguments 原样字符串）', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'read', argumentsDelta: '{"path":"a.txt"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_9', name: 'read', arguments: '{"path":"a.txt"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  })
  try {
    const body = await (
      await postJson(base, '/v1/chat/completions', {
        ...CHAT,
        tools: [{ type: 'function', function: { name: 'read', parameters: { path: { type: 'string' } } } }],
      })
    ).json()
    assert.equal(body.choices[0].finish_reason, 'tool_calls')
    assert.equal(body.choices[0].message.content, null)
    assert.deepEqual(body.choices[0].message.tool_calls, [
      { id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
    ])
  } finally {
    await server.stop()
  }
})

await test('流式：SSE 分帧 + tool_calls 的 index/name/arguments + [DONE]', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'ls', argumentsDelta: '{}' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  })
  try {
    const res = await postJson(base, '/v1/chat/completions', { ...CHAT, stream: true })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const frames = (await res.text())
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => block.slice(6))
    assert.equal(frames.at(-1), '[DONE]')
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame))
    assert.equal(chunks[0].object, 'chat.completion.chunk')
    assert.equal(chunks[0].choices[0].delta.role, 'assistant')
    assert.ok(
      chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === 'hi'),
      '正文要有一个 content 分片',
    )
    const callChunk = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls)
    assert.deepEqual(callChunk.choices[0].delta.tool_calls[0], {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'ls', arguments: '{}' },
    })
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
    assert.ok(!chunks.some((chunk) => chunk.usage), '没要 usage 就不该发 usage 帧')
  } finally {
    await server.stop()
  }
})

await test('流式：要了 stream_options.include_usage 才补 usage 帧', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  try {
    const text = await (
      await postJson(base, '/v1/chat/completions', { ...CHAT, stream: true, stream_options: { include_usage: true } })
    ).text()
    const chunks = text
      .split('\n\n')
      .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
      .map((block) => JSON.parse(block.slice(6)))
    const usageChunk = chunks.find((chunk) => chunk.usage)
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 })
    assert.deepEqual(usageChunk.choices, [])
  } finally {
    await server.stop()
  }
})

// ── HTTP：失败路径 ────────────────────────────────────────────────

// ── Responses API（Codex CLI 那条）───────────────────────────────

await test('Responses 翻译：instructions→system、input 的 function_call/output→工具消息、tools 拍平也认', () => {
  const body = responsesToChatBody({
    model: 'deepseek-chat',
    instructions: '你是 Codex',
    reasoning: { effort: 'max' },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读一下 a.txt' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'hello' },
    ],
    tools: [{ type: 'function', name: 'read', description: '读文件', parameters: { path: { type: 'string' } } }],
  })
  const { options } = toRelayCall(body)
  assert.equal(options.messages[0].content[0].text, '你是 Codex', 'instructions 要变成 system')
  assert.deepEqual(options.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.deepEqual(options.messages[2].content[0].toolCallId ?? options.messages[2].content[0], {
    type: 'tool-call',
    id: 'call_1',
    name: 'read',
    arguments: '{"path":"a.txt"}',
  })
  assert.deepEqual(options.messages[3].content[0], {
    type: 'tool-result',
    toolCallId: 'call_1',
    isError: false,
    content: [{ type: 'text', text: 'hello' }],
  })
  assert.deepEqual(options.tools, [
    { name: 'read', description: '读文件', parameters: { path: { type: 'string' } } },
  ])
  assert.equal(options.reasoningEffort, 'max', 'reasoning.effort → 适配器档位')
})

await test('Responses 非流式：输出 output[] 形状 + usage（status=completed）', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'text-delta', index: 0, text: '可以' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  try {
    const res = await postJson(base, '/v1/responses', {
      model: 'deepseek-chat',
      instructions: 'sys',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.object, 'response')
    assert.equal(body.status, 'completed')
    assert.equal(body.output[0].type, 'message')
    assert.deepEqual(body.output[0].content, [{ type: 'output_text', text: '可以', annotations: [] }])
    assert.deepEqual(body.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  } finally {
    await server.stop()
  }
})

await test('Responses 流式：事件顺序与名字（Codex 就是按这套解析的）', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  try {
    const text = await (
      await postJson(base, '/v1/responses', {
        model: 'deepseek-chat',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
        stream: true,
      })
    ).text()
    const events = text
      .split('\n\n')
      .filter((block) => block.includes('event: '))
      .map((block) => /event: (\S+)/.exec(block)[1])
    assert.deepEqual(events, [
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    const completed = JSON.parse(text.split('\n\n').find((b) => b.includes('response.completed')).split('data: ')[1])
    assert.deepEqual(completed.response.output[0].content[0].text, '你好')
  } finally {
    await server.stop()
  }
})

await test('Responses 工具调用：function_call 事件 + arguments 原样', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'exec_command', argumentsDelta: '{"command":"ls"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  })
  try {
    const text = await (
      await postJson(base, '/v1/responses', {
        model: 'deepseek-chat',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }] }],
        tools: [{ type: 'function', name: 'exec_command', parameters: {} }],
        stream: true,
      })
    ).text()
    assert.match(text, /response\.function_call_arguments\.delta/)
    const done = JSON.parse(text.split('\n\n').find((b) => b.includes('response.output_item.done')).split('data: ')[1])
    assert.deepEqual(done.item, {
      id: done.item.id,
      type: 'function_call',
      status: 'completed',
      call_id: 'call_9',
      name: 'exec_command',
      arguments: '{"command":"ls"}',
    })
    const completed = JSON.parse(text.split('\n\n').find((b) => b.includes('response.completed')).split('data: ')[1])
    assert.equal(completed.response.output[0].type, 'function_call')
  } finally {
    await server.stop()
  }
})

await test('未登录：首个事件前抛错 ⇒ HTTP 503（不是 200 里塞错误）', async () => {
  const error = Object.assign(new Error('尚未登录 DeepSeek 网页版：请先登录'), { code: 'MISSING_CREDENTIAL' })
  const { base, server } = await startRelay({ script: [error] })
  try {
    const res = await postJson(base, '/v1/chat/completions', { ...CHAT, stream: true })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.match(body.error.message, /尚未登录/)
    assert.equal(body.error.code, 'MISSING_CREDENTIAL')
  } finally {
    await server.stop()
  }
})

await test('限流：429 + Retry-After（客户端据此退避重试）', async () => {
  const error = Object.assign(new Error('网页版限流：发得太频繁'), {
    code: 'RATE_LIMIT',
    providerRetryAfterMs: 42_000,
  })
  const { base, server } = await startRelay({ script: [error] })
  try {
    const res = await postJson(base, '/v1/chat/completions', CHAT)
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), '42')
  } finally {
    await server.stop()
  }
})

await test('适配器用 finish/error 上报的失败：同样给非 200（非流式）', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'finish', reason: { kind: 'error', failure: { message: '网页端返回了空响应', code: 'EMPTY_RESPONSE' } } },
    ],
  })
  try {
    const res = await postJson(base, '/v1/chat/completions', CHAT)
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /空响应/)
  } finally {
    await server.stop()
  }
})

await test('流式已开始后失败：发一条 error 帧收尾（不让客户端一直转圈）', async () => {
  const { base, server } = await startRelay({
    script: [
      { type: 'text-delta', index: 0, text: '半句' },
      { type: 'finish', reason: { kind: 'error', failure: { message: '断了', code: 'PROVIDER_ERROR' } } },
    ],
  })
  try {
    const text = await (await postJson(base, '/v1/chat/completions', { ...CHAT, stream: true })).text()
    assert.match(text, /"error"/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    await server.stop()
  }
})

await test('流中途**抛错**（不是 finish/error）：同样有 error 帧 + [DONE]，非流式给状态码', async () => {
  // 适配器在限流 / 账号被限制 / 连接断掉时就是直接抛，不是发 finish/error 事件。
  const boom = Object.assign(new Error('网页版限流：发得太频繁'), { code: 'RATE_LIMIT', providerRetryAfterMs: 30_000 })
  const script = [{ type: 'text-delta', index: 0, text: '半句' }, boom]
  const streamed = await startRelay({ script })
  try {
    const text = await (await postJson(streamed.base, '/v1/chat/completions', { ...CHAT, stream: true })).text()
    assert.match(text, /"error"/)
    assert.match(text, /限流/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    await streamed.server.stop()
  }
  const plain = await startRelay({ script })
  try {
    const res = await postJson(plain.base, '/v1/chat/completions', CHAT)
    assert.equal(res.status, 429, '非流式能拿状态码就别让它变成 200 + 空回复')
  } finally {
    await plain.server.stop()
  }
})

await test('key：设了就必须要（Bearer / x-api-key 两种都认）', async () => {
  const { base, server } = await startRelay({
    config: { key: 'secret' },
    script: [{ type: 'finish', reason: { kind: 'stop' } }],
  })
  try {
    assert.equal((await postJson(base, '/v1/chat/completions', CHAT)).status, 401)
    assert.equal((await postJson(base, '/v1/chat/completions', CHAT, { authorization: 'Bearer secret' })).status, 200)
    assert.equal((await postJson(base, '/v1/chat/completions', CHAT, { 'x-api-key': 'secret' })).status, 200)
  } finally {
    await server.stop()
  }
})

await test('只收 application/json：text/plain 的跨站 simple request 被 415 挡掉', async () => {
  const { base, server } = await startRelay()
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(CHAT),
    })
    assert.equal(res.status, 415)
  } finally {
    await server.stop()
  }
})

await test('OPTIONS 不带 CORS 头（浏览器跨站拿不到通行证）', async () => {
  const { base, server } = await startRelay()
  try {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  } finally {
    await server.stop()
  }
})

await test('控制台：GET / 回页面；管理接口挂在同一端口上（且 POST 只收 JSON）', async () => {
  const seen = []
  const admin = (req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessionCleanup: 'keep' }))
  }
  const { base, server } = await startRelay({ admin, consoleHtml: '<!doctype html><title>本地控制台</title>' })
  try {
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await page.text(), /本地控制台/)

    // 管理接口：原样转发给 DSH 面板那套 handler（这里用替身，只验"路接通了"）
    const gate = await fetch(`${base}/deepseek-web-login/api/gate`)
    assert.equal(gate.status, 200)
    assert.deepEqual(await gate.json(), { ok: true, sessionCleanup: 'keep' })
    assert.deepEqual(seen, ['/deepseek-web-login/api/gate'])

    // 跨站 simple request（text/plain）不能借管理接口改设置
    const crossSite = await fetch(`${base}/deepseek-web-login/api/gate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"sessionCleanup":"keep"}',
    })
    assert.equal(crossSite.status, 415)
    assert.deepEqual(seen, ['/deepseek-web-login/api/gate'], '被挡掉的请求不该落到管理接口里')
  } finally {
    await server.stop()
  }
})

await test('/healthz 不校验 key（启动器靠它判断"已在跑"，带 key 也要能探），控制台页面认 ?key=', async () => {
  const { base, server } = await startRelay({
    config: { key: 'secret' },
    admin: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    },
    consoleHtml: '<!doctype html><title>控制台</title>',
  })
  try {
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 200, '探活不能因为设了 key 就 401，否则启动器会以为没在跑')
    assert.equal(await fetch(`${base}/`).then((r) => r.status), 401, '没带 key 时页面要挡住')
    assert.equal(await fetch(`${base}/?key=secret`).then((r) => r.status), 200, '页面支持 ?key=（浏览器导航改不了请求头）')
    assert.equal(await fetch(`${base}/deepseek-web-login/api/gate`).then((r) => r.status), 401, 'API 只认请求头')
    assert.equal(
      await fetch(`${base}/deepseek-web-login/api/gate`, { headers: { authorization: 'Bearer secret' } }).then((r) => r.status),
      200,
    )
  } finally {
    await server.stop()
  }
})

await test('host 路由：GET/POST /api-server 读写开关并即时重绑', async () => {
  // 宿主路由装置照 check-context-window.mjs 的配方（probeIntervalMs=0 → 零定时器）
  const { apply } = await import('../src/index.ts')
  // 设置文件优先于 cordis config ⇒ 先写成"开 + 随机端口"，否则这里读到的是上面那条用例写的 enabled:false
  writeRelayConfig({ enabled: true, port: 0, key: '' })
  let handler
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 HTTP handler')

  // ⚠️ readJsonBody 会调 req.off(...)，假 req 必须是真 EventEmitter（否则 promise 永不结算）
  const API = '/deepseek-web-login/api'
  const fakeReq = (method, url, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    return req
  }
  const call = async (method, route, body) => {
    const res = {
      statusCode: 0,
      body: '',
      writeHead(status) {
        res.statusCode = status
      },
      end(text) {
        res.body = text ?? ''
      },
    }
    await handler(fakeReq(method, `${API}${route}`, body), res)
    return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
  }

  try {
    // 监听是异步的（apply() 不等它）—— 这里轮询到真的起来为止，别写成"睡 100ms 赌它快"
    let status = await call('GET', '/api-server')
    for (let i = 0; i < 50 && status.data?.running !== true; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      status = await call('GET', '/api-server')
    }
    assert.equal(status.status, 200)
    assert.equal(status.data.running, true)
    assert.ok(status.data.effectivePort > 0, '端口 0 = 随机，接口要如实回报实际端口')
    assert.equal(status.data.sessionCleanup, 'deferred', '「对话留不留」跟随时会清理策略')

    const off = await call('POST', '/api-server', { enabled: false })
    assert.equal(off.data.ok, true)
    assert.equal(off.data.running, false)
    assert.equal(readRelayConfig().enabled, false, '保存要落盘（重启后仍然生效）')
  } finally {
    // 断言失败也要把监听关掉，否则这条用例会把整个测试进程挂住（有前科：进程不退出）
    await call('POST', '/api-server', { enabled: false }).catch(() => {})
  }
})

// ── 生命周期 ──────────────────────────────────────────────────────

await test('删 / 不删：开关真的落到适配器（全局策略与单次覆盖谁说话）', async () => {
  // ⚠️ 反向验证：把 adapter.ts 的 deletesWebSession 里 `__keepSession` / `__deleteSession`
  //    两个分支删掉 → 这条红（开关只翻译成字段、没人读，是这类功能最典型的假接通）。
  const { createAdapter } = await import('../src/adapter.ts')
  const auth = { token: 't'.repeat(64), cookie: '', hifDliq: '', hifLeim: '', wasmUrl: '', userAgent: 'ua' }
  /** 跑一次适配器流，返回「这轮到底挂没挂删除回调」。 */
  const run = async (config, extra) => {
    let deletes = null
    const adapter = createAdapter({
      getAuth: () => auth,
      config: { logger: {}, sessionReuseTurns: 0, ...config },
      streamCompletion: (_auth, params) => {
        deletes = typeof params.onDeleteSession === 'function'
        return (async function* () {
          yield { kind: 'text', text: 'hi' }
          yield { kind: 'finish', reason: 'FINISHED' }
        })()
      },
    })
    // 每个适配器自带全新闸门 ⇒ 第一次调用不等待间隔
    for await (const event of adapter.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      ...extra,
    })) {
      void event
    }
    return deletes
  }
  assert.equal(await run({ deleteWebSessions: false }, {}), false, '全局「不删」⇒ 不挂回调')
  assert.equal(
    await run({ deleteWebSessions: false }, { __deleteSession: true }),
    true,
    '单次要删 ⇒ 覆盖全局的「不删」',
  )
  assert.equal(await run({}, { __keepSession: true }), false, '单次不删 ⇒ 覆盖全局的「删」')
  assert.equal(await run({}, {}), true, '都没有 ⇒ 跟全局默认（删）')
})

await test('端口被占：自动顺延到下一个可用端口', async () => {
  const blocker = createServer(() => {})
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busy = blocker.address().port
  const { server } = await startRelay({ config: { port: busy, enabled: true } })
  try {
    assert.notEqual(server.port, busy)
    assert.ok(server.port > busy, `应按顺序顺延，实际 ${server.port}`)
  } finally {
    await server.stop()
    await new Promise((resolve) => blocker.close(resolve))
  }
})

await test('reconfigure：关掉再打开，端口跟着变（面板保存立即生效）', async () => {
  const { server } = await startRelay({ config: { port: 0 } })
  assert.ok(server.port > 0)
  assert.equal(await server.reconfigure({ enabled: false }), 0)
  assert.equal(server.port, 0)
  assert.ok((await server.reconfigure({ enabled: true, port: 0 })) > 0)
  assert.equal(server.config().enabled, true)
  await server.stop()
  assert.equal(server.port, 0, '停掉之后端口必须归零（面板据此显示"未运行"）')
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
