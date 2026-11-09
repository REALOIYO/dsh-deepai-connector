/**
 * 请求体构造与形状兜底。
 *
 * 反代实现照 `2951461586/DeepAICode2API`（`internal/deepai/chatbody.go`、
 * `internal/server/chat.go`）的做法：**自己拼 body，不用任何 SDK**。
 *
 * 上游会以 `400 This request is not one DeepAI Code sends.` 拒绝「不是桌面端
 * 会发」的请求体。绕过条件有两条：本进程已回传过签到（Check-In），或者补一条
 * system 消息。桌面端（0.3.20，pi 1.3.0 的 openai-completions）每个 chat 请求发的是：
 *
 *   model / messages / stream / stream_options / store=false /
 *   max_completion_tokens / temperature / tools / tool_choice /
 *   reasoning_effort（reasoning 模型关思考时发 "none"）
 *
 * `store` 必须在白名单里 —— 早期漏了它，重排后反而比桌面端少一个字段，
 * 照样被拒。
 *
 * @module src/adapter/body.ts
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

/**
 * 补齐 system 消息时用的兜底提示词。
 *
 * 上游 0.3.19+ 只认「Desktop Code 会发的形状」，桌面端每个请求都带 system
 * 与 tools；纯 user-only 的请求偶尔被 400 拒绝。这里只补 system 消息，
 * 不改写用户内容；请求里已有 system / developer 时原样保留。
 */
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant. Answer the user's request directly."

/**
 * 兜底重排时的字段白名单。
 *
 * 前 12 个是桌面端确实会发的；`seed` / `service_tier` / `top_p` / `stop` /
 * `prompt_cache_key` 桌面端不发，但它们是调用方显式给的采样/用量旋钮，
 * 丢掉会静默改掉请求语义，所以保留。
 */
export const DESKTOP_CHAT_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'stream',
  'stream_options',
  'store',
  'seed',
  'service_tier',
  'reasoning_effort',
  'prompt_cache_key',
])

/** 一个内容块（宽松形状）。 */
type Block = { type?: string; [key: string]: unknown }

/** 取消息上的内容块数组。 */
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
      // 不是 JSON，给空对象，别把整轮回掉
    }
  }
  return {}
}

/**
 * 消息级工具结果 ID。
 *
 * DSH >= 0.2 用 `role: 'tool'` + 消息上的 `toolCallId`；`source.callId` 是镜像。
 * 只在 source 是工具时才看它。
 */
function messageToolCallId(message: HarnessMessage): string | undefined {
  if (typeof message.toolCallId === 'string' && message.toolCallId !== '') return message.toolCallId
  if (typeof message.tool_call_id === 'string' && message.tool_call_id !== '') return message.tool_call_id
  const source = message.source
  if (source?.kind === 'tool' && typeof source.callId === 'string' && source.callId !== '') return source.callId
  return undefined
}

/** OpenAI 风格的消息形状。 */
type OpenAIMessage = Record<string, unknown>

/**
 * 把 DSH 的消息转成 OpenAI chat 消息数组。
 *
 * DSH 的形状**不是** OpenAI 那套，认错不会有报错，只会表现为「模型记不住
 * 自己调过什么」：
 *   - 工具调用是 assistant `content` 里的 `{type:'tool-call'}` 块，
 *     不是 `message.tool_calls` 数组（转成 OpenAI 时要反过来展开成数组）；
 *   - 工具结果的 ID 是驼峰 `toolCallId`；
 *   - 思考块是 `{type:'reasoning'}`，OpenAI 侧叫 `reasoning_content`。
 */
export function toOpenAIMessages(messages: HarnessMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  const toolNames = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []
      let reasoning = ''

      for (const block of blocksOf(message.content)) {
        switch (block.type) {
          case 'text':
            if (typeof block.text === 'string') content.push(block.text)
            break
          case 'reasoning':
            if (typeof block.text === 'string') reasoning += block.text
            break
          case 'tool-call': {
            const id = typeof block.id === 'string' ? block.id : ''
            const name = typeof block.name === 'string' ? block.name : ''
            if (id === '' || name === '') break
            toolNames.set(id, name)
            toolCalls.push({
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(parseArguments(block.arguments)) },
            })
            break
          }
          default:
            break
        }
      }

      // OpenAI 风格的 tool_calls 也接住
      for (const call of message.tool_calls ?? []) {
        const id = typeof call.id === 'string' ? call.id : ''
        const name = typeof call.function?.name === 'string' ? call.function.name : ''
        if (id === '' || name === '') continue
        toolNames.set(id, name)
        toolCalls.push({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(parseArguments(call.function?.arguments)) },
        })
      }

      const assistant: OpenAIMessage = { role: 'assistant' }
      const text = content.join('')
      // content 为空且只有工具调用时，OpenAI 侧要求 content 为 null
      assistant.content = text !== '' ? text : toolCalls.length > 0 ? null : ''
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      if (reasoning !== '') assistant.reasoning_content = reasoning
      out.push(assistant)
      continue
    }

    // 工具结果
    const toolCallId = messageToolCallId(message)
    if (toolCallId !== undefined) {
      const text = flattenText(message)
      out.push({
        role: 'tool',
        tool_call_id: toolCallId,
        // 空输出要补占位：上游不要空 content
        content: text !== '' ? text : '(no output)',
        ...(message.isError === true ? { is_error: true } : {}),
      })
      continue
    }

    // content 里的 tool-result 块也要展开成独立消息
    const inlineResults = blocksOf(message.content).filter(b => b.type === 'tool-result')
    if (inlineResults.length > 0) {
      for (const result of inlineResults) {
        const id = typeof result.toolCallId === 'string' ? result.toolCallId : ''
        if (id === '') continue
        const text = blocksOf(result.content)
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => String(b.text))
          .join('')
        out.push({
          role: 'tool',
          tool_call_id: id,
          content: text !== '' ? text : '(no output)',
          ...(result.isError === true ? { is_error: true } : {}),
        })
      }
      continue
    }

    // 普通 user / system 消息：图片块转成 OpenAI 的 image_url 形状
    const parts: unknown[] = []
    for (const block of blocksOf(message.content)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        parts.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
      }
    }

    const role = message.role === 'system' ? 'system' : message.role === 'developer' ? 'developer' : 'user'
    if (parts.length === 0) {
      out.push({ role, content: '' })
    } else if (parts.length === 1 && (parts[0] as { type: string }).type === 'text') {
      // 单段纯文本压成字符串，形状更接近桌面端
      out.push({ role, content: (parts[0] as { text: string }).text })
    } else {
      out.push({ role, content: parts })
    }
  }

  return out
}

/** 是否已经有 system / developer 消息。 */
export function hasSystemMessage(messages: OpenAIMessage[]): boolean {
  return messages.some(message => message.role === 'system' || message.role === 'developer')
}

/**
 * 构造 chat/completions 请求体。
 *
 * 字段顺序与桌面端一致；`store: false`、`stream: true` 都要显式带上
 * （上游缺省 `stream` 时默认按 SSE 返回，但显式声明更稳）。
 */
export function buildChatBody(options: GenerateOptions, model: string, systemPrompt?: string): Record<string, unknown> {
  const messages = toOpenAIMessages(options.messages)

  // 缺少 system 时补一条：上游的形状校验会因此宽松
  const prompt = systemPrompt !== undefined && systemPrompt !== '' ? systemPrompt : options.system
  if (!hasSystemMessage(messages)) {
    messages.unshift({
      role: 'system',
      content: prompt !== undefined && prompt !== '' ? prompt : DEFAULT_SYSTEM_PROMPT,
    })
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // 桌面端每个 chat 请求都带这个（supportsStore=true）
    store: false,
  }

  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
    body.parallel_tool_calls = true
  }

  if (options.maxTokens !== undefined) body.max_completion_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature

  // 推理模型必须发 reasoning_effort：关思考时是 "none"，不是省略。
  // 省略会被上游静默降级成默认档。
  const effort = options.reasoningEffort ?? options.reasoning
  if (effort !== undefined && effort !== '') {
    body.reasoning_effort = effort === 'off' ? 'none' : effort
  } else if (options.reasoningEffort === 'none') {
    body.reasoning_effort = 'none'
  }

  return body
}

/**
 * 把请求体收敛成桌面端形状，供 400 拒绝后的重试使用。
 *
 * 规则（照 `ChatBodyFallback`）：
 *   - 只保留白名单字段；
 *   - 确保第一条消息是 system（缺失时插入默认提示词）。
 *
 * 返回 `undefined` 表示请求体无法修正，不值得重试。
 */
export function chatBodyFallback(body: Record<string, unknown>, systemPrompt?: string): Record<string, unknown> | undefined {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined

  const strict: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (DESKTOP_CHAT_KEYS.has(key)) strict[key] = value
  }

  const typed = messages.filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
  if (!hasSystemMessage(typed)) {
    strict.messages = [
      { role: 'system', content: systemPrompt !== undefined && systemPrompt !== '' ? systemPrompt : DEFAULT_SYSTEM_PROMPT },
      ...messages,
    ]
  }

  return strict
}
