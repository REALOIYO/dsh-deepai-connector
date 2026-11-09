/**
 * 流翻译的回归用例。
 *
 * 重点盯两处历史教训：
 *   1. 索引必须全局递增 —— 分开计数会让「先想再答」的正文被灌进已关闭的
 *      reasoning 块，表现是「只有思维链没有正文」；
 *   2. block-start 必须配到 block-end，删块会让宿主的 assembler 一直等。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toStreamChunks, type StreamChunk } from '../src/adapter/stream.ts'

/** 把事件数组喂进去，收集全部 chunk。 */
async function collect(events: Array<Record<string, unknown>>, model = 'test-model'): Promise<StreamChunk[]> {
  async function* source(): AsyncGenerator<Record<string, unknown>> {
    for (const event of events) yield event
  }
  const out: StreamChunk[] = []
  for await (const chunk of toStreamChunks(source(), model)) out.push(chunk)
  return out
}

/** 校验每个 block-start 都有配对的 block-end。 */
function assertBalanced(chunks: StreamChunk[]): void {
  const opened = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      assert.equal(opened.has(chunk.index), false, `块 ${chunk.index} 重复打开`)
      opened.add(chunk.index)
    }
    if (chunk.type === 'block-end') {
      assert.equal(opened.has(chunk.index), true, `块 ${chunk.index} 在未打开时就关闭`)
      opened.delete(chunk.index)
    }
  }
  assert.deepEqual([...opened], [], '有块没有收口')
}

test('纯正文：一个 text 块，索引为 0', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: '你好' },
    { type: 'text_delta', contentIndex: 0, delta: '世界' },
    { type: 'done', message: { stopReason: 'stop' } },
  ])

  assertBalanced(chunks)
  assert.deepEqual(
    chunks.filter(c => c.type === 'block-start'),
    [{ type: 'block-start', index: 0, blockType: 'text' }],
  )
  assert.deepEqual(
    chunks.filter(c => c.type === 'text-delta'),
    [
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'text-delta', index: 0, text: '世界' },
    ],
  )
  // 收口的块要带完整文本
  const end = chunks.find(c => c.type === 'block-end')
  assert.deepEqual(end, { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } })
})

test('先想再答：两个块索引不同，正文不被吞掉', async () => {
  const chunks = await collect([
    { type: 'thinking_delta', contentIndex: 0, delta: '思考中' },
    { type: 'text_delta', contentIndex: 1, delta: '答案' },
    { type: 'done', message: { stopReason: 'stop' } },
  ])

  assertBalanced(chunks)
  const starts = chunks.filter(c => c.type === 'block-start')
  assert.equal(starts.length, 2)

  // 关键断言：索引必须不同
  const reasoningStart = starts.find(c => c.type === 'block-start' && c.blockType === 'reasoning')
  const textStart = starts.find(c => c.type === 'block-start' && c.blockType === 'text')
  assert.notEqual(reasoningStart?.index, textStart?.index, '思考与正文拿到了同一个索引')

  // 正文不能被灌进 reasoning 块
  const textDeltas = chunks.filter(c => c.type === 'text-delta')
  assert.equal(textDeltas.length, 1)
  assert.equal((textDeltas[0] as { index: number }).index, textStart?.index)

  const reasoningEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal((reasoningEnd as { block: { text: string } }).block.text, '思考中')
})

test('工具调用：在正文中间发起也能正确成对', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: '我来查一下' },
    { type: 'toolcall_start', contentIndex: 1 },
    { type: 'toolcall_delta', contentIndex: 1, delta: '{"q":', id: 'call_1', name: 'search' },
    { type: 'toolcall_delta', contentIndex: 1, delta: '"x"}' },
    { type: 'done', message: { stopReason: 'toolUse' } },
  ])

  assertBalanced(chunks)

  const toolEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.deepEqual(toolEnd, {
    type: 'block-end',
    index: (chunks.find(c => c.type === 'block-start' && c.blockType === 'tool-call') as { index: number }).index,
    block: { type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
  })

  const finish = chunks.at(-1)
  assert.deepEqual(finish, { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('工具调用开始时正文块不被提前收口', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: '前半' },
    { type: 'toolcall_start', contentIndex: 1 },
    { type: 'toolcall_delta', contentIndex: 1, delta: '{}', id: 'c1', name: 'f' },
    { type: 'text_delta', contentIndex: 0, delta: '后半' },
    { type: 'done', message: { stopReason: 'toolUse' } },
  ])

  assertBalanced(chunks)
  // 正文只应该有一个块（没被切成两截）
  const textStarts = chunks.filter(c => c.type === 'block-start' && c.blockType === 'text')
  assert.equal(textStarts.length, 1, '正文被工具调用切成了多个块')

  const textEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'text')
  assert.equal((textEnd as { block: { text: string } }).block.text, '前半后半')
})

test('无名工具调用：块照常成对，但整轮判错', async () => {
  const chunks = await collect([
    { type: 'toolcall_start', contentIndex: 0 },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{}', id: 'c1' },
    { type: 'done', message: { stopReason: 'toolUse' } },
  ])

  // start 配到了 end，宿主不会卡住
  assertBalanced(chunks)

  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.equal((finish as { reason: { kind: string } }).reason.kind, 'error')
  assert.equal((finish as { reason: { failure: { code: string } } }).reason.failure.code, 'UNNAMED_TOOL_CALL')
})

test('usage 归一化：只保留正数的缓存字段', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: 'x' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 } },
    { type: 'done', message: { stopReason: 'stop' } },
  ])

  const usage = chunks.find(c => c.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } })
})

test('空回答判错而不是静默 stop', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: '   ' },
    { type: 'done', message: { stopReason: 'stop' } },
  ])

  const finish = chunks.at(-1)
  assert.equal((finish as { reason: { failure: { code: string } } }).reason.failure.code, 'EMPTY_RESPONSE')
})

test('max tokens 结束原因透传', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: '被截断' },
    { type: 'done', message: { stopReason: 'length' } },
  ])

  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('上游 error 事件带出原始消息', async () => {
  const chunks = await collect([
    { type: 'text_delta', contentIndex: 0, delta: '部分内容' },
    { type: 'error', message: 'session_busy' },
  ])

  const finish = chunks.at(-1) as { reason: { kind: string; failure: { message: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.message, 'session_busy')
})
