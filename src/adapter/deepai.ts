/**
 * DeepAI Code 的 DSH LlmAdapter。
 *
 * 契约（dsh-llm）按结构化类型实现，**不 import 宿主的 `@deepseek-ai/*` 包**
 * ——这样插件不会被内核版本绑死，也让沙箱里可以脱离宿主单测。
 *
 * 为什么复用 pi-ai：DeepAI Code 桌面端本身就是 pi 驱动的，上游认的请求体形状
 * 就是 pi 的 `openai-completions` 产出的形状（`store:false`、`stream_options`、
 * `max_completion_tokens`、`reasoning_effort`…）。自己拼 body 要逐字段对齐，
 * 漏一个就吃 `400 This request is not one DeepAI Code sends.`；
 * 直接用 pi-ai 等于借了上游自己的实现。
 *
 * 调用链：
 *   DSH → prepareCall → stream
 *            ↓
 *        toPiContext（DSH 消息 → pi Context）
 *            ↓
 *        pi-ai openai-completions（body 形状 + SSE 解析）
 *            ↓
 *        provider.headers 注入 Api-Key / 车道号 / 实例号 / 机器指纹
 *            ↓
 *        https://api.deepai.org/deepai_code/chat/completions
 *            ↓
 *        toStreamChunks（pi 事件 → DSH chunk）
 *
 * @module src/adapter/deepai.ts
 */

import { createModels, createProvider } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

import type { AccountStore } from './auth.ts'
import { ModelCatalog, acceptsImage, contextWindowOf, endpointFor, maxTokensOf } from './catalog.ts'
import type { DeepAIClient } from './client.ts'
import { toPiContext, type GenerateOptions } from './context.ts'
import {
  HEADER_INSTANCE,
  HEADER_KEY,
  HEADER_LANE,
  HEADER_MACHINE,
  MODEL_BASE,
  ORIGIN,
} from './protocol.ts'
import { toStreamChunks } from './stream.ts'

/** 注册到 DSH 的 provider id。改名会让已有会话指向失效。 */
export const PROVIDER_ID = 'deepai'

/** 适配器构造参数。 */
export interface DeepAIAdapterOptions {
  providerId: string
  displayName: string
  client: DeepAIClient
  store: AccountStore
}

/** `resolveModel` 返回的形状。DSH 只读这些字段。 */
export interface ResolvedModel {
  provider: string
  id: string
  name: string
  inputModalities: string[]
  context: { contextWindow: number }
  defaultMaxTokens: number
  reasoning?: { efforts: Array<{ id: string; name: string }> }
}

/** 思考档位。上游的 `reasoning_effort` 认这些值。 */
const REASONING_EFFORTS = [
  { id: 'none', name: '关闭' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
] as const

/** 走 `/responses` 的模型用独立的 provider 实例（baseUrl 与 api 都不同）。 */
interface Transport {
  chat: ReturnType<typeof createModels>
  responses: ReturnType<typeof createModels>
}

/**
 * 构造 header 快照。
 *
 * pi-ai 的 `provider.headers` 在 createProvider 时固定，而 Key 是登录后才有的、
 * 车道号是探测后才定的，因此每次 Key/车道变化都要重建 transport。
 * 用快照签名判断是否需要重建。
 */
function headerSnapshot(client: DeepAIClient, apiKey: string): string {
  return `${apiKey}\u0000${client.lane}\u0000${client.machine}\u0000${client.instanceId}`
}

export class DeepAIAdapter {
  readonly #providerId: string
  readonly #displayName: string
  readonly #client: DeepAIClient
  readonly #store: AccountStore
  readonly #catalog: ModelCatalog
  #transport: Transport | undefined
  #transportKey = ''

  constructor(options: DeepAIAdapterOptions) {
    this.#providerId = options.providerId
    this.#displayName = options.displayName
    this.#client = options.client
    this.#store = options.store
    this.#catalog = new ModelCatalog(options.client)
  }

  /** 模型目录（给设置页读）。 */
  get catalog(): ModelCatalog {
    return this.#catalog
  }

  /**
   * 构造 pi-ai transport。
   *
   * 两个实例分别绑 `openai-completions` 与 `openai-responses`：
   * 上游 `api: openai-responses` 的模型必须走 `/responses`，用 chat 调会被拒。
   */
  #transportFor(apiKey: string): Transport {
    const snapshot = headerSnapshot(this.#client, apiKey)
    if (this.#transport !== undefined && this.#transportKey === snapshot) return this.#transport

    const baseUrl = `${ORIGIN}${MODEL_BASE}`
    const auth = { type: 'api_key' as const, key: apiKey }

    // 请求头在这一层注入：pi-ai 会把它与本次请求的头合并，我们的优先。
    // 注意不要在这里加 Chrome UA 或 sec-ch-ua —— 那会被上游识别成非客户端。
    const headers: Record<string, string> = {
      [HEADER_KEY]: apiKey,
      [HEADER_LANE]: this.#client.lane,
      [HEADER_INSTANCE]: this.#client.instanceId,
    }
    const machine = this.#client.machine
    if (machine !== '') headers[HEADER_MACHINE] = machine

    const chatProvider = createProvider({
      id: this.#providerId,
      name: this.#displayName,
      baseUrl,
      headers,
      auth,
      models: [],
      api: openaiCompletions,
    })

    const responsesProvider = createProvider({
      id: `${this.#providerId}-responses`,
      name: `${this.#displayName} (Responses)`,
      baseUrl,
      headers,
      auth,
      models: [],
      api: openaiResponses,
    })

    const chat = createModels()
    chat.setProvider(chatProvider)
    const responses = createModels()
    responses.setProvider(responsesProvider)

    this.#transport = { chat, responses }
    this.#transportKey = snapshot
    return this.#transport
  }

  /** DSH 读取 provider 显示信息。 */
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.#displayName }
  }

  /**
   * provider 级重试策略。
   *
   * DSH 在注册时无条件调这个方法。上游的容量拒绝（409 `session_busy`）
   * 带 `Retry-After`，把静默吸收窗口拉长比让用户直接看到报错好；
   * 确定性失败（鉴权、策略拦截、车道错误）不在这里，交给错误分类。
   */
  providerRetryPolicy(_provider: string): {
    maxRetries: number
    initialDelayMs: number
    maxDelayMs: number
    retryableCodes: string[]
  } {
    return {
      maxRetries: 4,
      initialDelayMs: 1000,
      maxDelayMs: 20_000,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'NETWORK', 'OVERLOADED'],
    }
  }

  /** 免费额度渠道不做图片计费。 */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** 模型列表（DSH 的模型选择器读这个）。 */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return this.#catalog.list().map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: acceptsImage(model) ? ['text', 'image'] : ['text'],
    }))
  }

  /** 解析模型能力。 */
  resolveModel(provider: string, model: string): ResolvedModel {
    const entry = this.#catalog.find(model)
    const resolved: ResolvedModel = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: acceptsImage(entry) ? ['text', 'image'] : ['text'],
      context: { contextWindow: contextWindowOf(entry) },
      defaultMaxTokens: maxTokensOf(entry),
    }
    // 只有支持推理的模型才露面思考档位；`/responses` 端点不认 `none`。
    if (entry?.reasoning === true) {
      const efforts = REASONING_EFFORTS.filter(effort =>
        endpointFor(entry) === 'responses' ? effort.id !== 'none' : true,
      ).map(effort => ({ id: effort.id, name: effort.name }))
      resolved.reasoning = { efforts }
    }
    return resolved
  }

  /** DSH 在每次调用前调这个，拿模型能力与 stream 句柄。 */
  async prepareCall(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<{ model: ResolvedModel; stream: (options: GenerateOptions) => AsyncGenerator<unknown> }> {
    if (!this.#catalog.live) await this.#catalog.refresh()

    const account = this.#store.get()
    if (account === undefined) {
      throw new Error('deepai: 还没登录，请在「设置 → DeepAI Code」完成一次授权')
    }
    this.#client.setApiKey(account.apiKey)

    return {
      model: this.resolveModel(provider, model),
      stream: (options: GenerateOptions) => this.#stream(model, options),
    }
  }

  /**
   * 发起一次流式请求。
   *
   * 重试与 body 形状交给 pi-ai；这里只负责签到与事件翻译。
   */
  async *#stream(model: string, options: GenerateOptions): AsyncGenerator<unknown> {
    const entry = this.#catalog.find(model)
    if (entry === undefined) {
      throw new Error(`deepai: 未知模型 "${model}"（可用：${this.#catalog.list().map(m => m.id).join(', ')}）`)
    }

    const account = this.#store.get()
    if (account === undefined) throw new Error('deepai: 还没登录')

    // 推理前确保签到：上游拿这个判定是不是真客户端。
    // 失败不阻塞 —— 只影响落到真分支还是替身分支。
    await this.#client.ensureCheckIn(options.signal)

    const transport = this.#transportFor(account.apiKey)
    const endpoint = endpointFor(entry)
    const models = endpoint === 'responses' ? transport.responses : transport.chat
    const providerId = endpoint === 'responses' ? `${this.#providerId}-responses` : this.#providerId

    // 模型要注册进 transport 的目录里，否则 getModel 取不到。
    // createProvider 的 models 是静态基线，这里用动态目录补。
    const upstreamModel = models.getModel(providerId, model) ?? this.#registerModel(models, providerId, model)
    if (upstreamModel === undefined) {
      throw new Error(`deepai: 内部错误，模型 "${model}" 无法注册到 transport`)
    }

    const context = toPiContext(options)
    const piOptions = {
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoning: options.reasoningEffort } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }

    const events = models.stream(upstreamModel, context, piOptions) as AsyncIterable<Record<string, unknown>>
    for await (const chunk of toStreamChunks(events, model)) {
      yield chunk
    }
  }

  /**
   * 把一条模型注册进 transport。
   *
   * pi-ai 的 `Models` 只从 `Provider.getModels()` 取模型，没有运行时插入接口，
   * 因此这里带上一份当前目录重建 provider。目录很小（十几条），代价可接受；
   * 只在「目录变了」或「Key/车道变了」时发生。
   */
  #registerModel(
    models: ReturnType<typeof createModels>,
    providerId: string,
    modelId: string,
  ): ReturnType<ReturnType<typeof createModels>['getModel']> {
    const existing = models.getModel(providerId, modelId)
    if (existing !== undefined) return existing

    const entry = this.#catalog.find(modelId)
    if (entry === undefined) return undefined

    const apiKey = this.#store.get()?.apiKey ?? ''
    if (apiKey === '') return undefined

    const api = providerId.endsWith('-responses') ? 'openai-responses' : 'openai-completions'
    this.#syncModels(apiKey, api === 'openai-responses' ? 'responses' : 'chat')
    return models.getModel(providerId, modelId)
  }

  /**
   * 用当前目录重建指定 transport 的 provider。
   *
   * 只重建被点名的那个，避免每次调用都把两个 provider 都换掉。
   */
  #syncModels(apiKey: string, endpoint: 'chat' | 'responses'): void {
    const transport = this.#transport
    if (transport === undefined) return

    const baseUrl = `${ORIGIN}${MODEL_BASE}`
    const headers: Record<string, string> = {
      [HEADER_KEY]: apiKey,
      [HEADER_LANE]: this.#client.lane,
      [HEADER_INSTANCE]: this.#client.instanceId,
    }
    const machine = this.#client.machine
    if (machine !== '') headers[HEADER_MACHINE] = machine

    const api = endpoint === 'responses' ? 'openai-responses' : 'openai-completions'
    const id = endpoint === 'responses' ? `${this.#providerId}-responses` : this.#providerId

    // 目录里所有模型都挂上：模型选择器切档时不用再重建。
    const listing = this.#catalog
      .list()
      .filter(entry => endpointFor(entry) === endpoint)
      .map(entry => ({
        id: entry.id,
        name: entry.name ?? entry.id,
        api,
        provider: id,
        baseUrl,
        reasoning: entry.reasoning === true,
        input: (acceptsImage(entry) ? ['text', 'image'] : ['text']) as Array<'text' | 'image'>,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindowOf(entry),
        maxTokens: maxTokensOf(entry),
      }))

    const provider = createProvider({
      id,
      name: endpoint === 'responses' ? `${this.#displayName} (Responses)` : this.#displayName,
      baseUrl,
      headers,
      auth: { type: 'api_key' as const, key: apiKey },
      models: listing,
      api: endpoint === 'responses' ? openaiResponses : openaiCompletions,
    })

    if (endpoint === 'responses') transport.responses.setProvider(provider)
    else transport.chat.setProvider(provider)

    // provider 换了，models 集合里的旧 provider 已被覆盖，签名同步更新
    this.#transportKey = headerSnapshot(this.#client, apiKey)
  }

  /** 强制重拉上游模型目录。 */
  async refreshModels(force = false): Promise<void> {
    await this.#catalog.refresh(force)
  }
}
