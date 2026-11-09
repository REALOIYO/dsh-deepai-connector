/**
 * 上游 SSE 逐帧解析。
 *
 * 反代实现照 `2951461586/DeepAICode2API`（`internal/server/stream.go`）：
 * **自己读帧，不用任何 SDK**。刻意不复用「按 SSE 规范合并多行 data」的通用
 * 解析器 —— 那会丢掉注释帧与 `event:` 行的原始形态，而透传路径需要它们。
 *
 * @module src/adapter/sse.ts
 */

/** 一条上游 SSE 帧里与业务相关的内容。 */
export interface SseFrame {
  /** 非空表示注释 / 心跳帧（以 `:` 开头），透传时用于维持客户端连接。 */
  comment?: string
  /** `event:` 字段的值。 */
  event?: string
  /** `data:` 之后的原始内容（已去首尾空白）。 */
  data?: string
  /** `data` 的 JSON 解析结果；解析失败或非对象时为 undefined。 */
  object?: Record<string, unknown>
}

/** SSE 流的显式结束标记。 */
export const SSE_DONE = '[DONE]'

/**
 * 逐帧解析上游 SSE。
 *
 * 回调返回 `false` 时停止；读到 EOF 算正常结束。
 *
 * `signal` 中断时：取消底层 reader 并抛错。**必须显式取消** —— 光检查
 * `signal.aborted` 不够，卡在 `reader.read()` 上时是等不到下一次循环的，
 * 表现为中止请求后流永远挂着。
 */
export async function forEachSseFrame(
  body: ReadableStream<Uint8Array>,
  fn: (frame: SseFrame) => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  /** 中止时把 reader 掐掉，让挂起的 read() 立刻返回。 */
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }

  if (signal !== undefined) {
    if (signal.aborted) {
      onAbort()
      throw new Error('请求已中断')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    for (;;) {
      if (signal?.aborted === true) throw new Error('请求已中断')
      const { done, value } = await reader.read()
      // cancel() 之后 read() 会返回 done，这里兜住「取消后又想继续」的情况
      if (signal?.aborted === true) throw new Error('请求已中断')
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!(await dispatchLine(line, fn))) return
      }
    }

    // 收尾：最后一行没有换行符的情况
    if (buffer !== '') await dispatchLine(buffer, fn)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      await reader.cancel()
    } catch {
      // 已经关掉了
    }
  }
}

/** 解析并分发一行；返回 false 表示停止。 */
async function dispatchLine(line: string, fn: (frame: SseFrame) => boolean | Promise<boolean>): Promise<boolean> {
  const trimmed = line.trim()
  if (trimmed === '') return true

  // 注释 / 心跳帧
  if (trimmed.startsWith(':')) return fn({ comment: trimmed })

  if (trimmed.startsWith('event:')) {
    return fn({ event: trimmed.slice('event:'.length).trim() })
  }

  if (!trimmed.startsWith('data:')) return true

  const data = trimmed.slice('data:'.length).trim()
  if (data === '') return true

  if (data === SSE_DONE) {
    await fn({ data: SSE_DONE })
    return false
  }

  let object: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      object = parsed as Record<string, unknown>
    }
  } catch {
    // 解析失败时 object 保持 undefined，原文仍在 data 里
  }

  return fn({ data, ...(object !== undefined ? { object } : {}) })
}

/** 一次工具调用的增量片段。 */
export interface ChatToolDelta {
  index: number
  id: string
  name: string
  args: string
}

/** 一次 chat completion chunk 中与协议适配相关的增量。 */
export interface ChatDelta {
  reasoning: string
  content: string
  toolCalls: ChatToolDelta[]
}

/** 宽松取数字。 */
function intOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 宽松取字符串。 */
function strOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 取出 chunk 首个 choice 的增量内容与 finish_reason。
 *
 * `finish` 为空表示本帧没有结束原因；`delta` 字段可能全为空
 * （例如仅带 usage 的尾帧）。
 */
export function chatChunkDelta(chunk: Record<string, unknown>): { delta: ChatDelta; finish: string } {
  const empty: ChatDelta = { reasoning: '', content: '', toolCalls: [] }
  const choices = chunk.choices
  if (!Array.isArray(choices) || choices.length === 0) return { delta: empty, finish: '' }

  const choice = choices[0]
  if (choice === null || typeof choice !== 'object') return { delta: empty, finish: '' }
  const cm = choice as Record<string, unknown>
  const finish = strOf(cm.finish_reason)

  const rawDelta = cm.delta
  if (rawDelta === null || typeof rawDelta !== 'object') return { delta: empty, finish }
  const delta = rawDelta as Record<string, unknown>

  const out: ChatDelta = {
    reasoning: strOf(delta.reasoning) || strOf(delta.reasoning_content),
    content: strOf(delta.content),
    toolCalls: [],
  }

  const toolCalls = delta.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      if (item === null || typeof item !== 'object') continue
      const tc = item as Record<string, unknown>
      const fn = tc.function
      const fnObj = fn !== null && typeof fn === 'object' ? (fn as Record<string, unknown>) : undefined
      out.toolCalls.push({
        index: intOf(tc.index),
        id: strOf(tc.id),
        name: strOf(fnObj?.name),
        args: strOf(fnObj?.arguments),
      })
    }
  }

  return { delta: out, finish }
}

/** 一次 chat 的用量。 */
export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 思维链占的 token，上游放在 `completion_tokens_details.reasoning_tokens`。 */
  reasoningTokens?: number
  /** 上游成本，`cost` 或 `cost_details.upstream_inference_cost`。 */
  cost?: number
}

/** 宽松取浮点。 */
function floatOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * 从 chunk 里取 usage。
 *
 * 判据照 `DeepAICode2API` 的 `parseUsage`：`prompt_tokens`/`completion_tokens`
 * 缺失时回落到 `input_tokens`/`output_tokens`（Responses 端点是后者），
 * 思维链 token 从 `completion_tokens_details` 或 `output_tokens_details` 取，
 * 成本优先 `cost`、其次 `cost_details.upstream_inference_cost`。
 */
export function chatChunkUsage(chunk: Record<string, unknown>): ChatUsage | undefined {
  const usage = chunk.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>

  let input = intOf(u.prompt_tokens)
  let output = intOf(u.completion_tokens)
  if (input === 0) input = intOf(u.input_tokens)
  if (output === 0) output = intOf(u.output_tokens)

  const total = intOf(u.total_tokens) || input + output
  if (input === 0 && output === 0 && total === 0) return undefined

  const result: ChatUsage = { inputTokens: input, outputTokens: output }
  if (total > 0) result.totalTokens = total

  // 缓存命中量：上游有两条路放这个数
  const promptDetails = u.prompt_tokens_details
  if (promptDetails !== null && typeof promptDetails === 'object') {
    const cached = intOf((promptDetails as Record<string, unknown>).cached_tokens)
    if (cached > 0) result.cacheReadTokens = cached
  }

  // 思维链 token
  const completionDetails = u.completion_tokens_details
  if (completionDetails !== null && typeof completionDetails === 'object') {
    const reasoning = intOf((completionDetails as Record<string, unknown>).reasoning_tokens)
    if (reasoning > 0) result.reasoningTokens = reasoning
  }
  if (result.reasoningTokens === undefined) {
    const outputDetails = u.output_tokens_details
    if (outputDetails !== null && typeof outputDetails === 'object') {
      const reasoning = intOf((outputDetails as Record<string, unknown>).reasoning_tokens)
      if (reasoning > 0) result.reasoningTokens = reasoning
    }
  }

  // 成本：顶层 cost 优先
  let cost = floatOf(u.cost)
  if (cost === 0) {
    const costDetails = u.cost_details
    if (costDetails !== null && typeof costDetails === 'object') {
      cost = floatOf((costDetails as Record<string, unknown>).upstream_inference_cost)
    }
  }
  if (cost > 0) result.cost = cost

  return result
}
