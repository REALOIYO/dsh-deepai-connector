/**
 * pi-ai 事件流 → DSH chunk。
 *
 * 这里有一处必须照抄的教训：**所有块共用一个递增索引计数器**。
 *
 * DSH 的 BlockAssembler 按 index 认块身份（一个 index 只对应一个块），
 * 且「已 block-end 关闭的 index 再收到 delta 会被忽略」。早先 text 与
 * reasoning 各自从 -1 递增，模型「先想再答」时两者都拿到 index=0，
 * 于是正文 delta 被灌进已经关闭的 reasoning 块、整段丢弃 ——
 * 表现就是「只有思维链、没有正文」。
 *
 * 同理，工具调用开始时**不要**顺手收口还开着的 text 块：
 * 模型常在正文中间发起工具调用，收口会把一段连续正文切成多个块。
 * 唯一的硬约束是 block-start 必须配到 block-end，见函数末尾。
 *
 * @module src/adapter/stream.ts
 */

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

/** pi-ai 事件流里用到的字段（宽松形状）。 */
type PiEvent = { type?: string; [key: string]: unknown }

/** pi-ai 的 usage 形状。 */
interface PiUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** pi-ai 的 stopReason 到 DSH 的结束原因。 */
function finishReasonOf(stopReason: string | undefined, sawToolCall: boolean): FinishReason {
  if (sawToolCall) return { kind: 'tool-calls' }
  switch (stopReason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'error', failure: { message: '请求已中断', code: 'ABORTED' } }
    case 'error':
      return { kind: 'error', failure: { message: '上游返回错误', code: 'UPSTREAM' } }
    default:
      return { kind: 'stop' }
  }
}

/**
 * 把 pi-ai 的事件流转成 DSH chunk。
 *
 * @param events pi-ai 的 AssistantMessageEventStream
 * @param model  模型显示名，只用于错误信息
 */
export async function* toStreamChunks(events: AsyncIterable<PiEvent>, model: string): AsyncGenerator<StreamChunk> {
  // 所有块共用一个计数器 —— 见文件头注释，别改回分开计数。
  let nextIndex = 0
  let textIndex = -1
  let reasoningIndex = -1
  let textOpen = false
  let reasoningOpen = false
  const textBuffer = new Map<number, string>()
  const reasoningBuffer = new Map<number, string>()

  /** 工具调用累积：内容块索引 → {id, name, args}。 */
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  /** pi-ai 的 contentIndex → DSH 的块索引。 */
  const toolIndexes = new Map<number, number>()
  let sawToolCall = false
  let usage: PiUsage | undefined
  let stopReason: string | undefined
  let failure: { message: string; code: string } | undefined

  for await (const event of events) {
    switch (event.type) {
      case 'text_delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta === '') break
        // 正文开始时把还开着的思考块收口
        if (reasoningOpen) {
          reasoningOpen = false
          yield {
            type: 'block-end',
            index: reasoningIndex,
            block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' },
          }
        }
        if (!textOpen) {
          textIndex = nextIndex
          nextIndex += 1
          textOpen = true
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textBuffer.set(textIndex, (textBuffer.get(textIndex) ?? '') + delta)
        yield { type: 'text-delta', index: textIndex, text: delta }
        break
      }

      case 'thinking_delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta === '') break
        if (!reasoningOpen) {
          reasoningIndex = nextIndex
          nextIndex += 1
          reasoningOpen = true
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoningBuffer.set(reasoningIndex, (reasoningBuffer.get(reasoningIndex) ?? '') + delta)
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta }
        break
      }

      case 'toolcall_start':
      case 'tool_call_start': {
        const contentIndex = typeof event.contentIndex === 'number' ? event.contentIndex : toolCalls.size
        if (toolCalls.has(contentIndex)) break
        // 这里**不收口** text/reasoning 块，理由见文件头
        toolCalls.set(contentIndex, { id: '', name: '', args: '' })
        toolIndexes.set(contentIndex, nextIndex)
        nextIndex += 1
        sawToolCall = true
        yield { type: 'block-start', index: toolIndexes.get(contentIndex) ?? 0, blockType: 'tool-call' }
        break
      }

      case 'toolcall_delta':
      case 'tool_call_delta': {
        const contentIndex = typeof event.contentIndex === 'number' ? event.contentIndex : 0
        const slot = toolCalls.get(contentIndex)
        if (slot === undefined) break
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta !== '') slot.args += delta
        if (typeof event.id === 'string' && event.id !== '') slot.id = event.id
        if (typeof event.name === 'string' && event.name !== '') slot.name = event.name
        yield {
          type: 'tool-call-delta',
          index: toolIndexes.get(contentIndex) ?? 0,
          id: slot.id,
          ...(slot.name !== '' ? { name: slot.name } : {}),
          argumentsDelta: delta,
        }
        break
      }

      case 'usage': {
        const raw = event.usage
        if (raw !== null && typeof raw === 'object') usage = raw as PiUsage
        break
      }

      case 'error': {
        const message = typeof event.message === 'string' ? event.message : `${model}: 上游返回错误`
        failure = { message, code: typeof event.code === 'string' ? event.code : 'UPSTREAM' }
        break
      }

      case 'done': {
        const message = event.message
        if (message !== null && typeof message === 'object') {
          const m = message as { stopReason?: unknown; usage?: unknown; errorMessage?: unknown }
          if (typeof m.stopReason === 'string') stopReason = m.stopReason
          if (m.usage !== null && typeof m.usage === 'object') usage = m.usage as PiUsage
          if (typeof m.errorMessage === 'string' && m.errorMessage !== '') {
            failure = { message: m.errorMessage, code: 'UPSTREAM' }
          }
        }
        break
      }

      default:
        // start / text_start / text_end / thinking_start / thinking_end 等
        // 只是边界标记，chunk 流不需要它们。
        break
    }
  }

  // 收口所有还开着的块
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

  // 无名工具调用要拦掉：模型发起了调用却始终没给 name，
  // 客户端会把一个没有名字的工具存进历史，别的 provider 拿到直接拒整轮。
  //
  // 注意 block-start 在收到首个 delta 时就已经发出去了，所以这里**不能悄悄删块**
  // ——start 配不到 end，DSH 的 assembler 会一直等这个块收口。
  // 做法是照常补发 block-end（让块成对），但把整轮判成错误。
  const unnamed = [...toolCalls.values()].filter(slot => slot.name.trim() === '')
  const said = [...textBuffer.values()].join('') + [...reasoningBuffer.values()].join('')

  for (const [contentIndex, slot] of toolCalls) {
    yield {
      type: 'block-end',
      index: toolIndexes.get(contentIndex) ?? 0,
      block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
    }
  }

  if (usage !== undefined) {
    const normalized: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } = {
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
    }
    if (typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) {
      normalized.cacheReadTokens = usage.cacheReadTokens
    }
    if (typeof usage.cacheWriteTokens === 'number' && usage.cacheWriteTokens > 0) {
      normalized.cacheWriteTokens = usage.cacheWriteTokens
    }
    yield { type: 'usage', usage: normalized }
  }

  if (unnamed.length > 0) {
    const detail = `${model}: 上游返回了没有名字的工具调用，已丢弃`
    if (said.trim() === '') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: detail, code: 'UNNAMED_TOOL_CALL' } } }
      return
    }
    // 有正文：内容照常交给用户，但明确告知这轮的工具调用是坏的
    yield { type: 'finish', reason: { kind: 'error', failure: { message: detail, code: 'UNNAMED_TOOL_CALL' } } }
    return
  }

  if (failure !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure } }
    return
  }

  // 一个字都没出的 stop 视为异常，避免静默的空回答
  if (said.trim() === '' && !sawToolCall && stopReason !== 'length') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `${model}: 上游返回了空回答`, code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  yield { type: 'finish', reason: finishReasonOf(stopReason, sawToolCall) }
}
