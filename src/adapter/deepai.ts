/**
 * DeepAI Code 的 DSH LlmAdapter。
 *
 * 契约（dsh-llm）按结构化类型实现，**不 import 宿主的 `@deepseek-ai/*` 包**
 * ——这样插件不会被内核版本绑死，也让沙箱里可以脱离宿主单测。
 *
 * 反代实现照 `2951461586/DeepAICode2API`：自己拼请求体（`body.ts`）、
 * 自己读 SSE（`sse.ts`）、错误按它的分类处理（`client.ts`），
 * **不借任何 OpenAI SDK 或 pi-ai**。
 *
 * 调用链：
 *   DSH → prepareCall → stream
 *            ↓
 *        ensureCheckIn（/theos 拉 nonce 再回传）
 *            ↓
 *        buildChatBody（桌面端字段形状）
 *            ↓
 *        POST api.deepai.org/deepai_code/chat/completions
 *            ↓
 *        toStreamChunks（SSE 增量 → DSH chunk）
 *
 * @module src/adapter/deepai.ts
 */

import type { AccountStore } from './auth.ts'
import { buildChatBody } from './body.ts'
import { ModelCatalog, acceptsImage, contextWindowOf, endpointFor, isFree, maxTokensOf } from './catalog.ts'
import { DeepAIClient, UpstreamError } from './client.ts'
import type { GenerateOptions } from './body.ts'
import { toStreamChunks, type StreamChunk } from './stream.ts'

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

/**
 * 思考档位。
 *
 * 上游对推理模型每个请求都带 `reasoning_effort`：关思考时发 `"none"`，
 * 不是省略 —— 省略会被静默降级成上游默认档。
 */
const REASONING_EFFORTS = [
  { id: 'none', name: '关闭' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
] as const

/**
 * 模型在选择器里显示的文案。
 *
 * DSH 的模型选择器只渲染 `name`，没有徽章插槽，所以把「免费」直接拼进名字。
 * 上游用 `theosPerRequest === "0"` 表示免费，判定见 `catalog.isFree`。
 */
export function displayNameOf(model: { name?: string; id: string; theosPerRequest?: string; premier?: boolean } | undefined): string {
  if (model === undefined) return ''
  const base = model.name !== undefined && model.name !== '' ? model.name : model.id
  return isFree(model) ? `${base} · 免费` : base
}

export class DeepAIAdapter {
  readonly #providerId: string
  readonly #displayName: string
  readonly #client: DeepAIClient
  readonly #store: AccountStore
  readonly #catalog: ModelCatalog

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

  /** DSH 读取 provider 显示信息。 */
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.#displayName }
  }

  /**
   * provider 级重试策略。
   *
   * DSH 在注册时无条件调这个方法。上游的容量拒绝（409 `session_busy`）
   * 带 `Retry-After`，把静默吸收窗口拉长比让用户直接看到报错好。
   * 确定性失败（鉴权、策略拦截、车道错误）不在这里，由错误分类挡掉。
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

  /**
   * 模型列表（DSH 的模型选择器读这个）。
   *
   * `name` 是选择器里唯一能控制的显示文案，所以把免费标记拼在这里。
   * DSH 的选择器只渲染 `name`，没有额外的徽章插槽。
   */
  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    return this.#catalog.list().map(model => ({
      provider,
      id: model.id,
      name: displayNameOf(model),
      inputModalities: acceptsImage(model) ? ['text', 'image'] : ['text'],
    }))
  }

  /** 解析模型能力。 */
  resolveModel(provider: string, model: string): ResolvedModel {
    const entry = this.#catalog.find(model)
    const resolved: ResolvedModel = {
      provider,
      id: model,
      name: displayNameOf(entry),
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
  ): Promise<{ model: ResolvedModel; stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk> }> {
    if (!this.#catalog.live) await this.#catalog.refresh()

    // 必须在这里补一次 load：插件启动时可能还没登录，账号是之后在设置页
    // 登录写进去的。只在启动时读一次盘会导致「登录成功但仍报未登录」。
    await this.#store.load()
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

  /** 发起一次流式请求。 */
  async *#stream(model: string, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const entry = this.#catalog.find(model)
    if (entry === undefined) {
      throw new Error(`deepai: 未知模型 "${model}"（可用：${this.#catalog.list().map(m => m.id).join(', ')}）`)
    }

    const account = this.#store.get()
    if (account === undefined) throw new Error('deepai: 还没登录')
    this.#client.setApiKey(account.apiKey)
    // 推理前确保签到：上游拿这个判定是不是真客户端。
    // 失败不阻塞 —— 只影响落到真分支还是替身分支。
    await this.#client.ensureCheckIn(options.signal)

    const body = buildChatBody(options, entry.id)

    let result
    try {
      result = await this.#client.openChat(options, entry.id, body, options.signal)
    } catch (error) {
      throw this.#describe(error)
    }

    for await (const chunk of toStreamChunks(result.body, model, options.signal)) {
      yield chunk
    }
  }

  /**
   * 把上游错误转成用户能看懂的说法。
   *
   * 策略类错误（`social_login_required`）不是「重试一下就好」，
   * 直接说清账号要求，否则用户会以为是网络问题反复试。
   */
  #describe(error: unknown): Error {
    if (!(error instanceof UpstreamError)) {
      return error instanceof Error ? error : new Error(String(error))
    }

    if (error.socialLoginRequired) {
      return new Error(
        'deepai: 上游要求该账号改用 Google 或 Apple 登录。邮箱密码注册的账号已被禁止推理，' +
          '换号或重试都无效，请在「设置 → DeepAI Code」用 Google/Apple 重新授权。',
      )
    }
    if (error.emailUnverified) {
      return new Error('deepai: 账号邮箱未验证，上游拒绝了这次请求。请到上游验证邮箱后重新授权。')
    }
    if (error.authFailed) {
      return new Error('deepai: 登录状态已失效，请到「设置 → DeepAI Code」重新授权。')
    }
    if (error.machineRequired) {
      return new Error(
        'deepai: 上游要求机器指纹，但本地没读到。可设置环境变量 DEEPAI_MACHINE_ID=<原始机器 UUID> 后重启 DSH。',
      )
    }
    if (error.networkBound) {
      return new Error(
        `deepai: 该网络的今日免费额度已领完（${error.message}）。同一出口 IP 共享额度，换号通常无效，等上游给的刷新时间。`,
      )
    }
    if (error.capacityWaiting) {
      return new Error(`deepai: 上游会话繁忙，稍后重试（${error.message}）`)
    }
    if (error.laneUnsupported) {
      return new Error('deepai: 上游不再接受当前车道版本，插件需要更新。')
    }
    if (error.checkInRefused) {
      return new Error('deepai: 今日签到次数已用尽（推理仍可用，但可能落到替身后端）。')
    }
    if (error.bodyRejected) {
      return new Error(`deepai: 请求体形状未被上游接受：${error.message}`)
    }
    return new Error(`deepai: ${error.message}`)
  }

  /** 强制重拉上游模型目录。 */
  async refreshModels(force = false): Promise<void> {
    await this.#catalog.refresh(force)
  }
}
