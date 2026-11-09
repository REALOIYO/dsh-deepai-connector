/**
 * DSH 请求 → pi-ai `Context` 的转换。
 *
 * DSH 的消息形状**不是** OpenAI 那套，照抄不对就会静默丢内容：
 *
 *   - 工具调用是 assistant `content` 里的 `{ type:'tool-call', id, name, arguments }`
 *     块，**不是** `message.tool_calls` 数组；
 *   - 工具结果的 ID 在消息上是驼峰 `toolCallId`，**不是** `tool_call_id`；
 *   - 思考块是 `{ type:'reasoning', text }`，pi-ai 那边叫 `thinking`。
 *
 * 早期只认 OpenAI 形状的实现会有两个后果：assistant 的工具轮被整轮丢弃
 * （tool-call 块没有 text），工具结果被并回 user 轮当纯文本 ——
 * 模型永远看不到自己调过什么、拿到了什么。
 *
 * @module src/adapter/context.ts
 */

/** DSH 传来的消息（只声明用到的字段）。 */
export interface HarnessMessage {
  role: string
  content: unknown
  /** 工具结果消息上的工具调用 ID（驼峰，DSH 用这个）。 */
  toolCallId?: string
  /** 老式下划线写法，仍然接受。 */
  tool_call_id?: string
  isError?: boolean
  /** OpenAI 风格的 assistant 工具调用数组，仍然接受。 */
  tool_calls?: Array<{
    id?: string
    type?: string
    function?: { name?: string; arguments?: unknown }
  }>
  /** 消息来源，工具结果会有 `kind: 'tool'`。 */
  source?: { kind?: string; callId?: string; model?: string }
}

/** DSH 传给 stream 的参数（只声明用到的）。 */
export interface GenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  reasoning?: string
  signal?: AbortSignal
  sessionId?: string
}

/** 一个内容块（宽松形状，按 type 分支取字段）。 */
type Block = { type?: string; [key: string]: unknown }

/** 取消息上所有指定类型的内容块。 */
function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? content.filter((b): b is Block => b !== null && typeof b === 'object') : []
}

/** 把一条消息的纯文本拼起来。 */
function flattenText(message: HarnessMessage): string {
  return blocksOf(message.content)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => String(b.text))
    .join('')
}

/** 解析工具调用的 arguments：字符串要 JSON.parse，对象原样用。 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // 不是 JSON，给个空对象，别把整轮回掉
    }
  }
  return {}
}

/**
 * 消息级工具结果 ID。
 *
 * DSH >= 0.2 用 `role: 'tool'` + 消息上的 `toolCallId`；`source.callId` 是镜像。
 * 只在 source 是工具时才看它，避免把模型/用户的来源误认成工具结果。
 */
function messageToolCallId(message: HarnessMessage): string | undefined {
  if (typeof message.toolCallId === 'string' && message.toolCallId !== '') return message.toolCallId
  if (typeof message.tool_call_id === 'string' && message.tool_call_id !== '') return message.tool_call_id
  const source = message.source
  if (source?.kind === 'tool' && typeof source.callId === 'string' && source.callId !== '') return source.callId
  return undefined
}

/** pi-ai 的 assistant 内容块形状。 */
type PiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

/** 把一条 assistant 消息转成 pi-ai 的形状，并顺手收集工具名。 */
function toPiAssistant(message: HarnessMessage, provider: string, toolNames: Map<string, string>): Record<string, unknown> {
  const content: PiAssistantBlock[] = []

  for (const block of blocksOf(message.content)) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        if (typeof block.text === 'string' && block.text !== '') content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        const id = typeof block.id === 'string' ? block.id : ''
        const name = typeof block.name === 'string' ? block.name : ''
        if (id === '' || name === '') break
        toolNames.set(id, name)
        content.push({ type: 'toolCall', id, name, arguments: parseArguments(block.arguments) })
        break
      }
      default:
        // image 等块在 assistant 历史里没有意义，跳过
        break
    }
  }

  // OpenAI 风格的 tool_calls 数组也接住
  for (const call of message.tool_calls ?? []) {
    const id = typeof call.id === 'string' ? call.id : ''
    const name = typeof call.function?.name === 'string' ? call.function.name : ''
    if (id === '' || name === '') continue
    toolNames.set(id, name)
    content.push({ type: 'toolCall', id, name, arguments: parseArguments(call.function?.arguments) })
  }

  const source = message.source
  const model = source?.kind === 'model' && typeof source.model === 'string' ? source.model : provider

  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider,
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'stop',
    timestamp: 0,
  }
}

/** 把工具结果消息压成 pi-ai 的 `toolResult`。 */
function pushToolResult(
  messages: unknown[],
  toolNames: Map<string, string>,
  toolCallId: string,
  content: unknown,
  isError: boolean,
): void {
  const parts = blocksOf(content)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => ({ type: 'text', text: String(b.text) }))

  // 空输出要补占位：pi-ai 与上游都不要空 content
  const normalized = parts.length === 0 ? [{ type: 'text', text: '(no output)' }] : parts

  messages.push({
    role: 'toolResult',
    toolCallId,
    toolName: toolNames.get(toolCallId) ?? 'unknown',
    content: normalized,
    isError,
  })
}

/**
 * 把 DSH 的请求转成 pi-ai 的 `Context`。
 *
 * 返回值刻意写成宽类型：pi-ai 的 `Context` 定义在宿主包内，
 * 本插件不 import 它的类型（避免被内核版本绑死）。
 */
export function toPiContext(options: GenerateOptions): {
  messages: unknown[]
  systemPrompt?: string
  tools?: Array<{ name: string; description: string; parameters: unknown }>
} {
  const provider = options.provider
  const toolNames = new Map<string, string>()
  const messages: unknown[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message)
      if (text !== '') messages.push({ role: 'user', content: text, timestamp: 0 })
      continue
    }

    if (message.role === 'assistant') {
      messages.push(toPiAssistant(message, provider, toolNames))
      continue
    }

    // 工具结果：先在消息级判定，再退回 content 里的 tool-result 块
    const results = blocksOf(message.content).filter(b => b.type === 'tool-result')
    if (results.length === 0) {
      const toolCallId = messageToolCallId(message)
      if (toolCallId !== undefined) {
        pushToolResult(messages, toolNames, toolCallId, message.content, message.isError === true)
        continue
      }
    }

    const text = flattenText(message)
    if (text !== '' || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: 0 })
    }
    for (const result of results) {
      const id = typeof result.toolCallId === 'string' ? result.toolCallId : ''
      if (id === '') continue
      pushToolResult(messages, toolNames, id, result.content, result.isError === true)
    }
  }

  const context: {
    messages: unknown[]
    systemPrompt?: string
    tools?: Array<{ name: string; description: string; parameters: unknown }>
  } = { messages }

  if (typeof options.system === 'string' && options.system !== '') context.systemPrompt = options.system

  const tools = (options.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
  if (tools.length > 0) context.tools = tools

  return context
}
