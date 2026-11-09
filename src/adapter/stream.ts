/**
 * 上游 SSE → DSH chunk。
 *
 * 反代实现照 `2951461586/DeepAICode2API` 的读帧逻辑：**自己逐帧解析**。
 * 上游本身就是 OpenAI 兼容的 SSE，所以这里只做「增量 → chunk」的翻译，
 * 不重写响应形状。
 *
 * ## 流式是硬要求
 *
 * 用推送式队列把 `forEachSseFrame` 的回调（非生成器作用域）接到生成器上：
 * 帧一到就产出，首字延迟等于上游首帧延迟。曾经试过「先整轮读完再翻译」，
 * 那样首字延迟 = 整轮时长，交互上不可接受。
 *
 * ## 索引必须全局递增
 *
 * DSH 的 BlockAssembler 按 index 认块身份（一个 index 只对应一个块），
 * 且「已 block-end 关闭的 index 再收到 delta 会被忽略」。早先 text 与
 * reasoning 各自从 -1 递增，模型「先想再答」时两者都拿到 index=0，
 * 正文 delta 被灌进已关闭的 reasoning 块、整段丢弃 ——
 * 表现就是「只有思维链、没有正文」。
 *
 * 同理，工具调用开始时**不要**顺手收口还开着的 text 块：模型常在正文中间
 * 发起工具调用，收口会把一段连续正文切成多个块（实测 1 块变 3 块）。
 * 唯一的硬约束是 block-start 必须配到 block-end。
 *
 * @module src/adapter/stream.ts
 */

import { chatChunkDelta, chatChunkUsage, forEachSseFrame } from './sse.ts'

/** DSH 的 chunk 契约。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
      type: 'block-end'
      index: number
      block:
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; id: string; name: string; arguments: string }
    }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | {
      type: 'usage'
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
    }
  | { type: 'finish'; reason: FinishReason }

/** 结束原因。 */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } }

/** 把上游 `finish_reason` 翻成 DSH 的结束原因。 */
function finishReasonOf(finish: string, sawToolCall: boolean): FinishReason {
  if (sawToolCall && (finish === '' || finish === 'tool_calls' || finish === 'stop')) {
    return { kind: 'tool-calls' }
  }
  switch (finish) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'content_filter':
      return { kind: 'error', failure: { message: '内容被上游过滤', code: 'CONTENT_FILTERED' } }
    default:
      return { kind: 'stop' }
  }
}

/**
 * 把上游 SSE 流转成 DSH chunk。
 *
 * @param body  上游响应体
 * @param model 模型显示名，只用于错误信息
 * @param signal 中止信号
 */
export async function* toStreamChunks(
  body: ReadableStream<Uint8Array>,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // 所有块共用一个计数器 —— 见文件头注释，别改回分开计数。
  let nextIndex = 0
  let textIndex = -1
  let reasoningIndex = -1
  let textOpen = false
  let reasoningOpen = false
  const textBuffer = new Map<number, string>()
  const reasoningBuffer = new Map<number, string>()

  /** 工具调用累积：上游 index → {id, name, args}。 */
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  /** 上游 index → DSH 的块索引。 */
  const toolIndexes = new Map<number, number>()
  let sawToolCall = false
  let finish = ''
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined
  let upstreamError: { message: string; code: string } | undefined

  // ── 推送式队列：帧处理是同步回调，生成器在主循环里消费 ──
  const buffer: StreamChunk[] = []
  let notify: (() => void) | undefined
  let producerDone = false
  let producerError: unknown

  const wake = (): void => {
    const fn = notify
    notify = undefined
    fn?.()
  }

  const push = (chunk: StreamChunk): void => {
    buffer.push(chunk)
    wake()
  }

  /** 处理一帧；返回 false 表示停止读取。 */
  const onFrame = (frame: { object?: Record<string, unknown> }): boolean => {
    const object = frame.object
    if (object === undefined) return true

    // 帧内报错：上游有时在 200 里夹一个 error 对象
    const errObj = object.error
    if (errObj !== null && typeof errObj === 'object') {
      const e = errObj as Record<string, unknown>
      upstreamError = {
        message: typeof e.message === 'string' ? e.message : `${model}: 上游在流中报错`,
        code: typeof e.code === 'string' ? e.code : 'UPSTREAM',
      }
      return false
    }

    const { delta, finish: f } = chatChunkDelta(object)
    if (f !== '') finish = f

    const u = chatChunkUsage(object)
    if (u !== undefined) {
      const normalized: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      }
      if (u.cacheReadTokens !== undefined) normalized.cacheReadTokens = u.cacheReadTokens
      usage = normalized
    }

    if (delta.reasoning !== '') {
      if (!reasoningOpen) {
        reasoningIndex = nextIndex
        nextIndex += 1
        reasoningOpen = true
        push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
      }
      reasoningBuffer.set(reasoningIndex, (reasoningBuffer.get(reasoningIndex) ?? '') + delta.reasoning)
      push({ type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning })
    }

    if (delta.content !== '') {
      // 正文开始时把还开着的思考块收口
      if (reasoningOpen) {
        reasoningOpen = false
        push({
          type: 'block-end',
          index: reasoningIndex,
          block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' },
        })
      }
      if (!textOpen) {
        textIndex = nextIndex
        nextIndex += 1
        textOpen = true
        push({ type: 'block-start', index: textIndex, blockType: 'text' })
      }
      textBuffer.set(textIndex, (textBuffer.get(textIndex) ?? '') + delta.content)
      push({ type: 'text-delta', index: textIndex, text: delta.content })
    }

    for (const tc of delta.toolCalls) {
      let slot = toolCalls.get(tc.index)
      if (slot === undefined) {
        // 这里**不收口** text/reasoning 块，理由见文件头
        slot = { id: '', name: '', args: '' }
        toolCalls.set(tc.index, slot)
        toolIndexes.set(tc.index, nextIndex)
        nextIndex += 1
        sawToolCall = true
        push({ type: 'block-start', index: toolIndexes.get(tc.index) ?? 0, blockType: 'tool-call' })
      }
      if (tc.id !== '') slot.id = tc.id
      if (tc.name !== '') slot.name = tc.name
      slot.args += tc.args
      push({
        type: 'tool-call-delta',
        index: toolIndexes.get(tc.index) ?? 0,
        id: slot.id,
        ...(slot.name !== '' ? { name: slot.name } : {}),
        argumentsDelta: tc.args,
      })
    }

    return true
  }

  // 读流在后台跑，主循环边等边产出
  void forEachSseFrame(body, onFrame, signal)
    .then(() => {
      producerDone = true
      wake()
    })
    .catch((error: unknown) => {
      producerError = error
      producerDone = true
      wake()
    })

  for (;;) {
    while (buffer.length > 0) {
      const chunk = buffer.shift()
      if (chunk !== undefined) yield chunk
    }
    if (producerDone) break
    await new Promise<void>(resolve => {
      notify = resolve
    })
  }

  if (producerError !== undefined) {
    const message = producerError instanceof Error ? producerError.message : String(producerError)
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
    return
  }

  // ── 收口 ──
  if (reasoningOpen) {
    yield {
      type: 'block-end',
      index: reasoningIndex,
      block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' },
    }
    reasoningOpen = false
  }
  if (textOpen) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer.get(textIndex) ?? '' } }
    textOpen = false
  }

  // 无名工具调用要拦掉：模型发起了调用却始终没给 name，客户端会把一个没有
  // 名字的工具存进历史，别的 provider 拿到直接拒整轮。
  //
  // 注意 block-start 在收到首个 delta 时就已经发出去了，所以这里**不能悄悄删块**
  // ——start 配不到 end，DSH 的 assembler 会一直等这个块收口。
  // 做法是照常补发 block-end（让块成对），但把整轮判成错误。
  const unnamed = [...toolCalls.values()].filter(slot => slot.name.trim() === '').length
  const said = [...textBuffer.values()].join('') + [...reasoningBuffer.values()].join('')

  for (const [index, slot] of toolCalls) {
    yield {
      type: 'block-end',
      index: toolIndexes.get(index) ?? 0,
      block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
    }
  }

  if (usage !== undefined) yield { type: 'usage', usage }

  if (upstreamError !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure: upstreamError } }
    return
  }

  if (unnamed > 0) {
    const detail = `${model}: 上游返回了 ${unnamed} 个没有名字的工具调用，已丢弃`
    yield { type: 'finish', reason: { kind: 'error', failure: { message: detail, code: 'UNNAMED_TOOL_CALL' } } }
    return
  }

  // 一个字都没出的 stop 视为异常，避免静默的空回答
  if (said.trim() === '' && !sawToolCall && finish !== 'length') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `${model}: 上游返回了空回答`, code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  yield { type: 'finish', reason: finishReasonOf(finish, sawToolCall) }
}
