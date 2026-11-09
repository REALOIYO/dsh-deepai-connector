/**
 * DSH 消息 → pi Context 的转换。
 *
 * 这里最容易出的是「静默丢内容」：DSH 的工具调用不是 OpenAI 那套形状，
 * 认错了不会有报错，只会表现为「模型记不住自己调过什么」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toPiContext, type GenerateOptions } from '../src/adapter/context.ts'

/** 构造一个最小请求。 */
function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'deepai',
    model: 'glm-5.3-flash',
    messages: [],
    ...overrides,
  }
}

test('普通对话：user 与 assistant 轮次按序保留', () => {
  const context = toPiContext(
    options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮' }] },
        { role: 'user', content: [{ type: 'text', text: '讲个笑话' }] },
      ],
    }),
  )

  assert.equal(context.messages.length, 3)
  assert.deepEqual(context.messages[0], { role: 'user', content: '你好', timestamp: 0 })
  const assistant = context.messages[1] as { role: string; content: Array<{ type: string; text: string }> }
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content, [{ type: 'text', text: '你好，有什么可以帮' }])
})

test('system 消息被搬进 systemPrompt 而不是当成 user 轮', () => {
  const context = toPiContext(
    options({
      messages: [
        { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
      system: '外层系统提示',
    }),
  )

  // 消息里的 system 仍转成 user（上游要求会话以 user 开头），
  // 真正的 systemPrompt 用 options.system
  assert.equal(context.systemPrompt, '外层系统提示')
  assert.equal(context.messages.length, 2)
})

test('工具调用是 content 里的 tool-call 块，不是 tool_calls 数组', () => {
  const context = toPiContext(
    options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '查一下天气' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来查' },
            { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
          ],
        },
        { role: 'tool', content: [{ type: 'text', text: '晴，25 度' }], toolCallId: 'call_1' },
      ],
    }),
  )

  assert.equal(context.messages.length, 3)

  const assistant = context.messages[1] as { content: Array<Record<string, unknown>> }
  const toolCall = assistant.content.find(block => block.type === 'toolCall')
  assert.deepEqual(toolCall, {
    type: 'toolCall',
    id: 'call_1',
    name: 'get_weather',
    arguments: { city: '北京' },
  })

  // 工具结果必须是独立的一条 toolResult，不能并进 user 轮
  const result = context.messages[2] as Record<string, unknown>
  assert.equal(result.role, 'toolResult')
  assert.equal(result.toolCallId, 'call_1')
  assert.equal(result.toolName, 'get_weather')
  assert.deepEqual(result.content, [{ type: 'text', text: '晴，25 度' }])
})

test('工具结果的 toolName 从历史里补齐', () => {
  const context = toPiContext(
    options({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c9', name: 'grep', arguments: '{}' }],
        },
        { role: 'tool', content: [{ type: 'text', text: '匹配 3 处' }], toolCallId: 'c9' },
      ],
    }),
  )

  const result = context.messages[1] as { toolName: string }
  assert.equal(result.toolName, 'grep', '工具名没补上，上游会拒整轮')
})

test('source.callId 也能识别工具结果（DSH 0.2 的镜像字段）', () => {
  const context = toPiContext(
    options({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }] },
        { role: 'tool', content: [{ type: 'text', text: '文件内容' }], source: { kind: 'tool', callId: 'c2' } },
      ],
    }),
  )

  assert.equal((context.messages[1] as { role: string }).role, 'toolResult')
})

test('工具空输出要补占位，不能留空 content', () => {
  const context = toPiContext(
    options({
      messages: [
        { role: 'tool', content: [], toolCallId: 'c3' },
      ],
    }),
  )

  const result = context.messages[0] as { content: Array<{ type: string; text: string }> }
  assert.deepEqual(result.content, [{ type: 'text', text: '(no output)' }])
})

test('OpenAI 风格的 tool_calls 数组仍然接住', () => {
  const context = toPiContext(
    options({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '调用' }],
          tool_calls: [{ id: 'c4', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
        },
      ],
    }),
  )

  const assistant = context.messages[0] as { content: Array<Record<string, unknown>> }
  const toolCall = assistant.content.find(block => block.type === 'toolCall')
  assert.deepEqual(toolCall, { type: 'toolCall', id: 'c4', name: 'bash', arguments: { cmd: 'ls' } })
})

test('reasoning 块转成 thinking', () => {
  const context = toPiContext(
    options({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先想想' },
            { type: 'text', text: '答案' },
          ],
        },
      ],
    }),
  )

  const assistant = context.messages[0] as { content: Array<Record<string, unknown>> }
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: '先想想' })
})

test('工具定义透传，parameters 缺失时给空 object', () => {
  const context = toPiContext(
    options({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      tools: [
        { name: 'bash', description: '跑命令', parameters: { type: 'object', properties: {} } },
        { name: 'noargs' },
      ],
    }),
  )

  assert.equal(context.tools?.length, 2)
  assert.deepEqual(context.tools?.[1], {
    name: 'noargs',
    description: '',
    parameters: { type: 'object', properties: {} },
  })
})

test('坏 JSON 的 arguments 不炸整轮', () => {
  const context = toPiContext(
    options({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c5', name: 'f', arguments: '{不是JSON' }] },
      ],
    }),
  )

  const assistant = context.messages[0] as { content: Array<Record<string, unknown>> }
  assert.deepEqual(assistant.content[0], { type: 'toolCall', id: 'c5', name: 'f', arguments: {} })
})

test('没有工具的请求不带 tools 字段', () => {
  const context = toPiContext(options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal('tools' in context, false)
})
