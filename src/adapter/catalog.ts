/**
 * 模型目录。
 *
 * 目录**完全由上游下发**：网关只做缓存，上游新增模型无需改代码。
 * 拿不到目录时用静态快照兜底，好过让模型选择器空着。
 *
 * @module src/adapter/catalog.ts
 */

import type { DeepAIClient, UpstreamModel } from './client.ts'
import { isResponsesApi } from './protocol.ts'

/** 目录缓存时长：上游加了模型或调了价，最多这么久能跟上。 */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/** 目录不可用时的兜底模型。上游说免费的那几个。 */
export const FALLBACK_MODELS: readonly UpstreamModel[] = Object.freeze([
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1_048_576, maxTokens: 131_072, theosPerRequest: '0' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1_048_576, maxTokens: 131_072, theosPerRequest: '0' },
  { id: 'mimo-2.6-flash', name: 'MiMo 2.6 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1_048_576, maxTokens: 131_072, theosPerRequest: '0' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: true, input: ['text', 'image'], contextWindow: 1_048_576, maxTokens: 128_000, theosPerRequest: '0' },
])

/** 拿不到模型条目时的默认上下文窗口。 */
export const DEFAULT_CONTEXT_WINDOW = 131_072
/** 拿不到时的默认最大输出。 */
export const DEFAULT_MAX_TOKENS = 32_768

/** 判定一条模型是否免费。上游用 `theosPerRequest === "0"` 表示免费。 */
export function isFree(model: UpstreamModel): boolean {
  if (model.theosPerRequest !== undefined) {
    const value = Number.parseFloat(model.theosPerRequest)
    if (Number.isFinite(value)) return value === 0
  }
  return model.premier !== true
}

/** 判定一条模型是否接受图片。 */
export function acceptsImage(model: UpstreamModel): boolean {
  return Array.isArray(model.input) && model.input.includes('image')
}

/** 目录：缓存 + 后台刷新。 */
export class ModelCatalog {
  readonly #client: DeepAIClient
  #models: UpstreamModel[] = [...FALLBACK_MODELS]
  #fetchedAt = 0
  #inflight: Promise<void> | undefined

  constructor(client: DeepAIClient) {
    this.#client = client
  }

  /** 当前模型列表（同步，给选择器用）。 */
  list(): UpstreamModel[] {
    return this.#models
  }

  /** 取一条模型；找不到返回 undefined。 */
  find(id: string): UpstreamModel | undefined {
    return this.#models.find(model => model.id === id)
  }

  /** 目录是否已经来自上游实测（而不是兜底快照）。 */
  get live(): boolean {
    return this.#fetchedAt > 0
  }

  /**
   * 拉一次上游目录。
   *
   * 失败不算致命：继续用当前目录，下次再试。并发调用共享同一次请求。
   */
  async refresh(force = false): Promise<void> {
    if (!force && this.#fetchedAt > 0 && Date.now() - this.#fetchedAt < CATALOG_TTL_MS) return
    if (this.#inflight !== undefined) return this.#inflight

    this.#inflight = (async () => {
      try {
        const models = await this.#client.listModels()
        if (models.length > 0) {
          this.#models = models
          this.#fetchedAt = Date.now()
        }
      } catch {
        // 保持当前目录（可能是兜底快照）
      } finally {
        this.#inflight = undefined
      }
    })()
    return this.#inflight
  }
}

/** 取模型的上下文窗口。 */
export function contextWindowOf(model: UpstreamModel | undefined): number {
  const value = model?.contextWindow
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW
}

/** 取模型的最大输出。 */
export function maxTokensOf(model: UpstreamModel | undefined): number {
  const value = model?.maxTokens
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOKENS
}

/** 模型该走哪个端点。 */
export function endpointFor(model: UpstreamModel | undefined): 'chat' | 'responses' {
  return isResponsesApi(model?.api) ? 'responses' : 'chat'
}
