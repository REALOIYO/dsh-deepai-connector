/**
 * 请求体构造。
 *
 * 上游会以 `400 This request is not one DeepAI Code sends.` 拒绝「不是桌面端
 * 会发」的请求体。这里逐字段钉死形状，因为错了不会报「字段不对」，
 * 只会整轮被拒或者被静默降级。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SYSTEM_PROMPT,
  buildChatBody,
  chatBodyFallback,
  hasSystemMessage,
  toOpenAIMessages,
  type GenerateOptions,
  type HarnessMessage,
} from '../src/adapter/body.ts'

/** 构造一个最小请求。 */
function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'deepai', model: 'glm-5.3-flash', messages: [], ...overrides }
}

/** 取 messages 数组的宽松视图。 */
function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>
}

test('普通对话保留轮次并压成字符串 content', () => {
  const messages = toOpenAIMessages([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮' }] },
    { role: 'user', content: [{ type: 'text', text: '讲个笑话' }] },
  ])

  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { role: 'user', content: '你好' })
  assert.deepEqual(messages[1], { role: 'assistant', content: '你好，有什么可以帮' })
})

test('工具调用展开成 OpenAI 的 tool_calls 数组', () => {
  const messages = toOpenAIMessages([
    { role: 'user', content: [{ type: 'text', text: '查天气' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来查' },
        { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      ],
    },
  ])

  const assistant = messages[1] as Record<string, unknown>
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content, '我来查')
  assert.deepEqual(assistant.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
  ])
})

test('只有工具调用没有正文时 content 为 null', () => {
  const messages = toOpenAIMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }] },
  ])

  assert.equal((messages[0] as Record<string, unknown>).content, null)
})

test('工具结果转成独立的 tool 消息，ID 用驼峰 toolCallId', () => {
  const messages = toOpenAIMessages([
    { role: 'tool', content: [{ type: 'text', text: '晴，25 度' }], toolCallId: 'call_1' },
  ])

  assert.deepEqual(messages[0], { role: 'tool', tool_call_id: 'call_1', content: '晴，25 度' })
})

test('source.callId 也能识别工具结果', () => {
  const messages = toOpenAIMessages([
    { role: 'tool', content: [{ type: 'text', text: '结果' }], source: { kind: 'tool', callId: 'c2' } },
  ])

  assert.equal((messages[0] as Record<string, unknown>).role, 'tool')
  assert.equal((messages[0] as Record<string, unknown>).tool_call_id, 'c2')
})

test('工具空输出补占位而不是空字符串', () => {
  const messages = toOpenAIMessages([{ role: 'tool', content: [], toolCallId: 'c3' }])
  assert.equal((messages[0] as Record<string, unknown>).content, '(no output)')
})

test('OpenAI 风格的 tool_calls 数组仍然接住', () => {
  const messages = toOpenAIMessages([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '调用' }],
      tool_calls: [{ id: 'c4', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
    },
  ])

  const assistant = messages[0] as Record<string, unknown>
  assert.deepEqual(assistant.tool_calls, [
    { id: 'c4', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
  ])
})

test('思考块转成 reasoning_content', () => {
  const messages = toOpenAIMessages([
    { role: 'assistant', content: [{ type: 'reasoning', text: '先想想' }, { type: 'text', text: '答案' }] },
  ])

  const assistant = messages[0] as Record<string, unknown>
  assert.equal(assistant.reasoning_content, '先想想')
  assert.equal(assistant.content, '答案')
})

test('图片块转成 image_url', () => {
  const messages = toOpenAIMessages([
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
  ])

  const user = messages[0] as { content: Array<Record<string, unknown>> }
  assert.equal(user.content.length, 2)
  assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
})

test('请求体必须带 store:false、stream:true、stream_options', () => {
  const body = buildChatBody(options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }), 'glm-5.3-flash')

  assert.equal(body.store, false, 'store 是桌面端必发字段，漏了会被拒')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.model, 'glm-5.3-flash')
})

test('缺 system 时自动补一条，已有则不动', () => {
  const without = buildChatBody(options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }), 'm')
  const first = messagesOf(without)[0]
  assert.equal(first?.role, 'system')
  assert.equal(first?.content, DEFAULT_SYSTEM_PROMPT)

  const withSystem = buildChatBody(
    options({
      messages: [
        { role: 'system', content: [{ type: 'text', text: '自定义' }] },
        { role: 'user', content: [{ type: 'text', text: 'x' }] },
      ],
    }),
    'm',
  )
  assert.equal(messagesOf(withSystem)[0]?.content, '自定义')
})

test('options.system 优先于默认提示词', () => {
  const body = buildChatBody(
    options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], system: '外层系统提示' }),
    'm',
  )
  assert.equal(messagesOf(body)[0]?.content, '外层系统提示')
})

test('工具定义包成 function 形状并带 parallel_tool_calls', () => {
  const body = buildChatBody(
    options({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [{ name: 'bash', description: '跑命令', parameters: { type: 'object', properties: {} } }],
    }),
    'm',
  )

  assert.deepEqual(body.tools, [
    { type: 'function', function: { name: 'bash', description: '跑命令', parameters: { type: 'object', properties: {} } } },
  ])
  assert.equal(body.parallel_tool_calls, true)
})

test('reasoning_effort：关思考发 none 而不是省略', () => {
  const off = buildChatBody(
    options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], reasoningEffort: 'none' }),
    'm',
  )
  assert.equal(off.reasoning_effort, 'none', '省略会被上游静默降级成默认档')

  const offAlt = buildChatBody(
    options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], reasoningEffort: 'off' }),
    'm',
  )
  assert.equal(offAlt.reasoning_effort, 'none', 'off 要归一成上游认的 none')

  const high = buildChatBody(
    options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], reasoningEffort: 'high' }),
    'm',
  )
  assert.equal(high.reasoning_effort, 'high')
})

test('思考字段严格按条件声明', () => {
  const body = buildChatBody(options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }), 'm')
  assert.equal('reasoning_effort' in body, false, '没指定档位时不该发该字段')
})

test('形状兜底：只保留白名单字段并补 system', () => {
  const fallback = chatBodyFallback(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      store: false,
      // 白名单外，应被丢弃
      user: 'abc',
      n: 2,
      presence_penalty: 0.5,
    },
    undefined,
  )

  assert.ok(fallback)
  assert.equal('user' in fallback, false)
  assert.equal('n' in fallback, false)
  assert.equal('presence_penalty' in fallback, false)
  assert.equal(fallback.store, false, 'store 必须在白名单里')
  assert.equal(fallback.stream, true)
  // 补了 system
  assert.equal((fallback.messages as Array<Record<string, unknown>>)[0]?.role, 'system')
})

test('形状兜底：已有序 system 时不重复插入', () => {
  const fallback = chatBodyFallback({
    model: 'm',
    messages: [
      { role: 'system', content: '已有' },
      { role: 'user', content: 'x' },
    ],
  })

  assert.ok(fallback)
  assert.equal((fallback.messages as Array<Record<string, unknown>>).length, 2)
  assert.equal((fallback.messages as Array<Record<string, unknown>>)[0]?.content, '已有')
})

test('形状兜底：没有 messages 时返回 undefined', () => {
  assert.equal(chatBodyFallback({ model: 'm' }), undefined)
  assert.equal(chatBodyFallback({ model: 'm', messages: [] }), undefined)
})

test('hasSystemMessage 认 developer', () => {
  assert.equal(hasSystemMessage([{ role: 'system' }]), true)
  assert.equal(hasSystemMessage([{ role: 'developer' }]), true)
  assert.equal(hasSystemMessage([{ role: 'user' }]), false)
})

test('坏 JSON 的 arguments 不炸整轮', () => {
  const messages = toOpenAIMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c5', name: 'f', arguments: '{不是JSON' }] },
  ])

  const call = (messages[0] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0]
  assert.equal(call?.function.arguments, '{}')
})

test('HarnessMessage 类型接受最小形状', () => {
  const message: HarnessMessage = { role: 'user', content: 'plain' }
  assert.equal(message.role, 'user')
})
