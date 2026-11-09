/**
 * SSE → DSH chunk 的翻译。
 *
 * 输入是真实的上游 SSE 字节流（照 `2951461586/DeepAICode2API` 的帧形状），
 * 不是任何 SDK 的事件对象。
 *
 * 重点盯三处：
 *   1. 索引必须全局递增 —— 分开计数会让「先想再答」的正文被灌进已关闭的
 *      reasoning 块，表现是「只有思维链没有正文」；
 *   2. block-start 必须配到 block-end，删块会让宿主的 assembler 一直等；
 *   3. 必须边读边发 —— 先整轮读完再翻译会让首字延迟等于整轮时长。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toStreamChunks, type StreamChunk } from '../src/adapter/stream.ts'

/** 把若干 chunk 对象编成 SSE 字节流。 */
function sse(...chunks: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
  const text = chunks
    .map(chunk => (typeof chunk === 'string' ? chunk : `data: ${JSON.stringify(chunk)}\n\n`))
    .join('')
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/** 构造一个 chat delta 帧。 */
function delta(payload: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { choices: [{ index: 0, delta: payload, finish_reason: finish }] }
}

/** 收集全部 chunk。 */
async function collect(body: ReadableStream<Uint8Array>, model = 'test-model'): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of toStreamChunks(body, model)) out.push(chunk)
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
  const chunks = await collect(
    sse(delta({ content: '你好' }), delta({ content: '世界' }), delta({}, 'stop'), 'data: [DONE]\n\n'),
  )

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
  const end = chunks.find(c => c.type === 'block-end')
  assert.deepEqual(end, { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } })
})

test('先想再答：两个块索引不同，正文不被吞掉', async () => {
  const chunks = await collect(
    sse(delta({ reasoning: '思考中' }), delta({ content: '答案' }), delta({}, 'stop'), 'data: [DONE]\n\n'),
  )

  assertBalanced(chunks)
  const starts = chunks.filter(c => c.type === 'block-start')
  assert.equal(starts.length, 2)

  const reasoningStart = starts.find(c => c.type === 'block-start' && c.blockType === 'reasoning')
  const textStart = starts.find(c => c.type === 'block-start' && c.blockType === 'text')
  assert.notEqual(reasoningStart?.index, textStart?.index, '思考与正文拿到了同一个索引')

  const textDeltas = chunks.filter(c => c.type === 'text-delta')
  assert.equal(textDeltas.length, 1)
  assert.equal((textDeltas[0] as { index: number }).index, textStart?.index)

  const reasoningEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal((reasoningEnd as { block: { text: string } }).block.text, '思考中')
})

test('reasoning_content 字段也认（OpenAI 生态写法）', async () => {
  const chunks = await collect(
    sse(delta({ reasoning_content: '内部思考' }), delta({ content: '答' }), delta({}, 'stop'), 'data: [DONE]\n\n'),
  )

  assertBalanced(chunks)
  const reasoningEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal((reasoningEnd as { block: { text: string } }).block.text, '内部思考')
})

test('工具调用：在正文中间发起也能正确成对', async () => {
  const chunks = await collect(
    sse(
      delta({ content: '我来查一下' }),
      delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      delta({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
  )

  assertBalanced(chunks)
  const toolEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.deepEqual(toolEnd?.block, { type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"x"}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('工具调用开始时正文块不被提前收口', async () => {
  const chunks = await collect(
    sse(
      delta({ content: '前半' }),
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }),
      delta({ content: '后半' }),
      delta({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
  )

  assertBalanced(chunks)
  const textStarts = chunks.filter(c => c.type === 'block-start' && c.blockType === 'text')
  assert.equal(textStarts.length, 1, '正文被工具调用切成了多个块')

  const textEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'text')
  assert.equal((textEnd as { block: { text: string } }).block.text, '前半后半')
})

test('多个并行工具调用各自成块', async () => {
  const chunks = await collect(
    sse(
      delta({
        tool_calls: [
          { index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } },
          { index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } },
        ],
      }),
      delta({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
  )

  assertBalanced(chunks)
  const ends = chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(ends.length, 2)
})

test('无名工具调用：块照常成对，但整轮判错', async () => {
  const chunks = await collect(
    sse(
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{}' } }] }),
      delta({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ),
  )

  assertBalanced(chunks)
  const finish = chunks.at(-1) as { reason: { kind: string; failure: { code: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'UNNAMED_TOOL_CALL')
})

test('usage 从尾帧取出，缓存量转成 cacheReadTokens', async () => {
  const chunks = await collect(
    sse(
      delta({ content: 'x' }),
      delta({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
      'data: [DONE]\n\n',
    ),
  )

  const usage = chunks.find(c => c.type === 'usage')
  assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } })
})

test('空回答判错而不是静默 stop', async () => {
  const chunks = await collect(sse(delta({ content: '   ' }), delta({}, 'stop'), 'data: [DONE]\n\n'))
  const finish = chunks.at(-1) as { reason: { failure: { code: string } } }
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('max tokens 结束原因透传', async () => {
  const chunks = await collect(sse(delta({ content: '被截断' }), delta({}, 'length'), 'data: [DONE]\n\n'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('content_filter 判成错误', async () => {
  const chunks = await collect(sse(delta({ content: 'x' }), delta({}, 'content_filter'), 'data: [DONE]\n\n'))
  const finish = chunks.at(-1) as { reason: { kind: string; failure: { code: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CONTENT_FILTERED')
})

test('流中夹的 error 对象被带出来', async () => {
  const chunks = await collect(
    sse(delta({ content: '部分' }), { error: { code: 'session_busy', message: 'busy' } }, 'data: [DONE]\n\n'),
  )

  const finish = chunks.at(-1) as { reason: { kind: string; failure: { message: string; code: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'session_busy')
  assert.equal(finish.reason.failure.message, 'busy')
})

test('心跳注释帧与 event 帧被跳过，不影响产出', async () => {
  const chunks = await collect(
    sse(': keep-alive\n\n', 'event: ping\n\n', delta({ content: '正文' }), delta({}, 'stop'), 'data: [DONE]\n\n'),
  )

  assertBalanced(chunks)
  assert.deepEqual(chunks.filter(c => c.type === 'text-delta'), [{ type: 'text-delta', index: 0, text: '正文' }])
})

test('[DONE] 之后不再处理', async () => {
  const chunks = await collect(sse(delta({ content: '一' }), 'data: [DONE]\n\n', delta({ content: '二' })))
  const text = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')
  assert.equal(text, '一')
})

test('非法 JSON 帧被跳过，流继续', async () => {
  const chunks = await collect(
    sse('data: {不是JSON\n\n', delta({ content: '正文' }), delta({}, 'stop'), 'data: [DONE]\n\n'),
  )
  assert.deepEqual(chunks.filter(c => c.type === 'text-delta'), [{ type: 'text-delta', index: 0, text: '正文' }])
})

test('边读边发：分多次到达的流也能流式产出', async () => {
  const encoder = new TextEncoder()
  let push1: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 先只喂第一帧，等外面消费掉再喂后面的
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta({ content: '首帧' }))}\n\n`))
      push1 = () => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta({ content: '次帧' }))}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })

  const seen: string[] = []
  for await (const chunk of toStreamChunks(body, 'm')) {
    if (chunk.type === 'text-delta') {
      seen.push(chunk.text)
      // 收到首帧时才放行后面的帧 —— 若实现是「读完才产出」，这里会死锁
      if (seen.length === 1) push1?.()
    }
  }

  assert.deepEqual(seen, ['首帧', '次帧'])
})

test('中止信号让流以 aborted 收尾', async () => {
  const controller = new AbortController()
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify(delta({ content: 'x' }))}\n\n`))
      // 不 close，模拟上游挂住
    },
  })

  const chunks: StreamChunk[] = []
  const iterate = (async () => {
    for await (const chunk of toStreamChunks(body, 'm', controller.signal)) chunks.push(chunk)
  })()

  setTimeout(() => controller.abort(), 20)
  await iterate

  const finish = chunks.at(-1) as { reason: { kind: string } }
  assert.equal(finish.reason.kind, 'aborted')
})
