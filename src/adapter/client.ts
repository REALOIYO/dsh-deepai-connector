/**
 * DeepAI 上游客户端：请求头组装、签到状态机、chat 请求、错误语义。
 *
 * 反代实现照 `2951461586/DeepAICode2API`（`internal/deepai/client.go`、
 * `internal/deepai/checkin.go`、`internal/server/common.go`）：
 * **自己拼请求、自己读 SSE、自己分类错误**，不借任何 SDK。
 *
 * 上游本身是 OpenAI 兼容接口，因此这里做的是「带签到与形状兜底的透明转发」：
 * 改写模型名、注入 DeepAI 鉴权头、归一化思维链字段。
 *
 * @module src/adapter/client.ts
 */

import { randomBytes } from 'node:crypto'

import { chatBodyFallback, type GenerateOptions } from './body.ts'
import {
  APP_VERSION,
  CODE_AUTH_REQUIRED,
  CODE_CHECK_IN_REFUSED,
  CODE_EMAIL_UNVERIFIED,
  CODE_INVALID_API_KEY,
  CODE_LANE_UNSUPPORTED,
  CODE_MACHINE_REQUIRED,
  CODE_NETWORK_BOUND,
  CODE_SESSION_BUSY,
  CODE_SOCIAL_LOGIN,
  DESKTOP_INFERENCE_HEADERS,
  HEADER_AFFINITY,
  HEADER_BEACON,
  HEADER_CHECK_IN,
  HEADER_INSTANCE,
  HEADER_KEY,
  HEADER_LANE,
  HEADER_MACHINE,
  LANE_CANDIDATES,
  LANE_VERSION,
  PATH_CHAT,
  PATH_MODELS,
  PATH_RESPONSES,
  PATH_THEOS,
  modelUrl,
} from './protocol.ts'

/**
 * 两次签到尝试之间的最小间隔。
 *
 * 桌面端拿到 `check_in` 之前不主动签到（它靠账号状态刷新触发）；
 * 本插件没有独立的状态轮询，给个下限避免每次热路径请求都撞一次 403。
 */
const CHECK_IN_MIN_INTERVAL_MS = 30_000

/** 单次签到的时间预算：签到只是上下文，失败不该阻塞推理。 */
const CHECK_IN_TIMEOUT_MS = 10_000

/**
 * 命中 `check_in_refused` 后的静默锁时长。
 *
 * 上游当天「重启签到」次数用尽后 403 里**仍然会下发新 nonce**，不停手就成了
 * 自己制造的签到风暴。锁 6h 与客户端日额度节奏一致，到期允许再试一次。
 */
const CHECK_IN_REFUSED_LOCK_MS = 6 * 60 * 60 * 1000

/** 非流式请求的整体预算。MaxRetries × Retry-After 理论上可挂 90s 以上。 */
const NON_STREAM_BUDGET_MS = 90_000

/** 上游模型目录里的一条。 */
export interface UpstreamModel {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  premier?: boolean
  api?: string
  theosPerRequest?: string
}

/** 签到挑战。 */
export interface CheckIn {
  nonce: string
  seconds: number
}

/**
 * 判定签到挑战是否有效。
 *
 * 与 `DeepAICode2API` 的 `CheckIn.Valid()` 同判据：`seconds > 0` 且 nonce 必须是
 * **32 位小写十六进制**。只判「非空」会把上游下发的非法值也当成挑战，
 * 于是回传一个注定不被认的 nonce，签到永远不生效。
 */
export function isValidCheckIn(value: { nonce: string; seconds: number } | undefined): boolean {
  if (value === undefined) return false
  if (!Number.isFinite(value.seconds) || value.seconds <= 0) return false
  if (!/^[0-9a-f]{32}$/.test(value.nonce)) return false
  return true
}

/** 上游 `/theos` 响应里用到的字段。 */
export interface Allowance {
  balance?: number
  granted?: number
  refreshAt?: string
  checkIn?: CheckIn
}

/** 进程级状态：实例号、机器指纹、按 key 隔离的签到状态。 */
interface CheckInState {
  challenge: CheckIn | undefined
  notedAt: number
  attemptedAt: number
  /** 已回传给上游的 nonce。「拿到」与「回传」是两件事，只有后者算签到完成。 */
  ackedNonce: string
  refusedUntil: number
  /**
   * 最近一次推理转发的时间。
   *
   * 心跳里的 `pi` 字段由此得来：`pi=1` 表示最近一个 TTL 内发过推理请求。
   * 桌面端在转发推理前记一次（`markRelay`），不是「签到过」的意思。
   */
  lastRelay: number
}

/**
 * 上游返回的非 2xx 响应。
 *
 * `code` 是上游的 `error.code`，本插件靠它做语义判定。
 */
export class UpstreamError extends Error {
  readonly status: number
  readonly code: string
  readonly body: string
  /** 上游 `Retry-After`，秒。 */
  readonly retryAfter?: number

  constructor(status: number, code: string, message: string, body = '', retryAfter?: number) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.code = code
    this.body = body
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }

  /** 账号级策略拦截：换号、重试都无解。 */
  get socialLoginRequired(): boolean {
    return this.code === CODE_SOCIAL_LOGIN
  }

  /** 缺机器指纹。 */
  get machineRequired(): boolean {
    return this.code === CODE_MACHINE_REQUIRED
  }

  /**
   * 账号鉴权失败（401，或 401 语义的错误码）。
   *
   * 与普通 403 不同：登录态本身无效，换不换号都一样，应提示重新授权。
   */
  get authFailed(): boolean {
    if (this.status === 401) return true
    return this.code === CODE_AUTH_REQUIRED || this.code === CODE_INVALID_API_KEY || this.code === CODE_EMAIL_UNVERIFIED
  }

  /**
   * 邮箱未验证。
   *
   * 上游因邮箱未验证拒绝时，登录态无效；标记后应跳过，而不是当可重试失败
   * 反复打。
   */
  get emailUnverified(): boolean {
    return this.code === CODE_EMAIL_UNVERIFIED
  }

  /** 车道版本不被接受。 */
  get laneUnsupported(): boolean {
    return this.status === 426 || this.code === CODE_LANE_UNSUPPORTED
  }

  /** 会话忙：等 `Retry-After` 再试。 */
  get capacityWaiting(): boolean {
    return this.status === 409 && this.code === CODE_SESSION_BUSY
  }

  /** 当天签到次数用尽。 */
  get checkInRefused(): boolean {
    return this.code === CODE_CHECK_IN_REFUSED
  }

  /** 网络级免费额度领完。 */
  get networkBound(): boolean {
    return this.code === CODE_NETWORK_BOUND
  }

  /**
   * 请求体形状被拒。
   *
   * 上游对新车道加了请求体校验，典型响应是 400 + `invalid_request_error`，
   * message 固定为 `This request is not one DeepAI Code sends.`。
   * 命中后按桌面端字段白名单重排一次，这是唯一值得纠正的 400。
   */
  get bodyRejected(): boolean {
    if (this.status !== 400) return false
    return this.body.toLowerCase().includes('not one deepai code sends')
  }

  /** 该不该重试。策略类错误码是终态，换谁问都一样。 */
  get retryable(): boolean {
    if (this.socialLoginRequired || this.machineRequired || this.laneUnsupported) return false
    if (this.status === 400 || this.status === 404 || this.status === 422) return false
    return [401, 403, 409, 429, 500, 502, 503, 504].includes(this.status) || this.status >= 500
  }
}

/** 从响应体里取 `error.code`。 */
function errorCodeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown }
    const code = parsed.error?.code ?? parsed.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

/** 从响应体里取 `error.message`。 */
function errorMessageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string' && message !== '') return message
  } catch {
    // 不是 JSON
  }
  return body.trim().slice(0, 200)
}

/** 解析 `Retry-After`，夹到 [1, 30] 秒。 */
export function retryAfterSeconds(header: string | null, fallback = 3): number {
  if (header === null || header.trim() === '') return fallback
  const parsed = Number.parseInt(header.trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(30, Math.max(1, parsed))
}

/** 会话标识的合法字符集，与桌面端一致：只透传安全字符集。 */
const AFFINITY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/

/**
 * 解析会话粘性标识。
 *
 * 上游用 `X-Session-Affinity` 做调度粘性（同一会话尽量落到同一后端）。
 * 来源是请求体里的 `prompt_cache_key`；格式不合法的值**不发**该头，
 * 发一个畸形值比不发更糟。
 */
export function affinityFor(body: Record<string, unknown>): string {
  const raw = body.prompt_cache_key
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  return AFFINITY_PATTERN.test(value) ? value : ''
}

/** 一次 chat 请求的结果。 */
export interface ChatResult {
  /** 上游的 SSE 流。 */
  body: ReadableStream<Uint8Array>
  /** 上游状态码。 */
  status: number
  /** 中止句柄。 */
  abort: () => void
}

/**
 * 上游客户端。
 *
 * 一个实例服务一个已授权账号；实例号进程级一次，签到状态按 API Key 隔离。
 */
export class DeepAIClient {
  readonly #instance: string
  readonly #startedAt = Date.now()
  #machine: string
  #apiKey = ''
  #lane: string
  readonly #checkIns = new Map<string, CheckInState>()

  constructor(options: { machine?: string; lane?: string } = {}) {
    this.#instance = randomBytes(16).toString('hex')
    this.#machine = options.machine ?? ''
    this.#lane = options.lane ?? LANE_VERSION
  }

  /** 当前车道版本。 */
  get lane(): string {
    return this.#lane
  }

  /** 进程级实例号。桌面端每进程生成一次，随所有 JSON 请求发出。 */
  get instanceId(): string {
    return this.#instance
  }

  /** 当前机器指纹（空串表示没探到）。 */
  get machine(): string {
    return this.#machine
  }

  /** 补设机器指纹（异步探到后调用）。 */
  setMachine(fingerprint: string): void {
    this.#machine = fingerprint.trim()
  }

  /** 设置当前账号的 API Key。 */
  setApiKey(key: string): void {
    this.#apiKey = key.trim()
  }

  /** 是否已有 Key。 */
  get hasKey(): boolean {
    return this.#apiKey !== ''
  }

  /** 取（必要时创建）某个 Key 的签到状态。 */
  #state(key: string): CheckInState {
    let state = this.#checkIns.get(key)
    if (state === undefined) {
      state = { challenge: undefined, notedAt: 0, attemptedAt: 0, ackedNonce: '', refusedUntil: 0, lastRelay: 0 }
      this.#checkIns.set(key, state)
    }
    return state
  }

  /**
   * 组装公共请求头。
   *
   * `DESKTOP_INFERENCE_HEADERS` 必须原样发出：这几行是上游区分真假客户端的
   * 主要判据。不要「顺手加上更完整的头」——带 `sec-ch-ua` 或 Chrome UA
   * 反而会被识别成非客户端。
   */
  #commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...DESKTOP_INFERENCE_HEADERS,
      'Content-Type': 'application/json',
      [HEADER_LANE]: this.#lane,
      [HEADER_INSTANCE]: this.#instance,
    }
    if (this.#machine !== '') headers[HEADER_MACHINE] = this.#machine
    if (this.#apiKey !== '') headers[HEADER_KEY] = this.#apiKey
    return headers
  }

  /** 把非 2xx 响应转成 {@link UpstreamError}。 */
  async #toError(response: Response, op: string): Promise<UpstreamError> {
    const body = await response.text().catch(() => '')
    const code = errorCodeOf(body)
    const message = errorMessageOf(body)
    return new UpstreamError(
      response.status,
      code,
      `${op}失败（HTTP ${response.status}）${message !== '' ? `：${message}` : ''}`,
      body,
      retryAfterSeconds(response.headers.get('retry-after')),
    )
  }

  /**
   * 拉模型目录。
   *
   * `/models` 免鉴权，因此也是探测车道最便宜的方式。
   */
  async listModels(signal?: AbortSignal): Promise<UpstreamModel[]> {
    const response = await fetch(modelUrl(PATH_MODELS), {
      method: 'GET',
      headers: this.#commonHeaders(),
      ...(signal !== undefined ? { signal } : {}),
      // 无效 Key 会 302 到登录页，跟随只会把鉴权失败伪装成 200。
      redirect: 'manual',
    })
    if (!response.ok) throw await this.#toError(response, '拉取模型目录')

    const payload = (await response.json()) as { data?: unknown; models?: unknown }
    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
    const out: UpstreamModel[] = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      const id = typeof raw.id === 'string' ? raw.id.trim() : ''
      if (id === '') continue
      out.push({
        id,
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
        ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
        ...(Array.isArray(raw.input) ? { input: raw.input.filter((v): v is string => typeof v === 'string') } : {}),
        ...(typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {}),
        ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
        ...(typeof raw.premier === 'boolean' ? { premier: raw.premier } : {}),
        ...(typeof raw.api === 'string' ? { api: raw.api } : {}),
        ...(typeof raw.theosPerRequest === 'string' ? { theosPerRequest: raw.theosPerRequest } : {}),
      })
    }
    return out
  }

  /**
   * 探测可用车道版本。
   *
   * 上游每抬一次车道就把旧值一律回 426。按「新版优先、旧版兜底」试，
   * 命中即落盘，这样上游升级车道时插件不需要改代码。
   */
  async probeLane(signal?: AbortSignal): Promise<string> {
    const candidates = LANE_CANDIDATES
    const previous = this.#lane
    for (const lane of candidates) {
      this.#lane = lane
      try {
        const response = await fetch(modelUrl(PATH_MODELS), {
          method: 'GET',
          headers: this.#commonHeaders(),
          ...(signal !== undefined ? { signal } : {}),
          redirect: 'manual',
        })
        if (response.ok) return lane
        // 426 说明这个车道不对，继续试下一个；其它错误说明问题不在车道。
        if (response.status !== 426) {
          this.#lane = previous
          return previous
        }
      } catch {
        this.#lane = previous
        return previous
      }
    }
    this.#lane = LANE_VERSION
    return LANE_VERSION
  }

  /** 给 `/theos` 加签到头与心跳。 */
  #checkInHeaders(state: CheckInState): Record<string, string> {
    const headers: Record<string, string> = {}
    const challenge = state.challenge

    // TTL 取挑战的 seconds，缺省 600（与 Go 实现一致）
    const ttl = challenge !== undefined && challenge.seconds > 0 ? challenge.seconds : 600

    if (challenge !== undefined && challenge.nonce !== '') {
      headers[HEADER_CHECK_IN] = challenge.nonce
    }

    // `pi` 的语义是「最近一个 TTL 内发过推理请求」，由 markRelay 维护。
    // 不是「签到过没有」—— 那会让心跳与桌面端不一致。
    const relayed = state.lastRelay > 0 && Date.now() - state.lastRelay < ttl * 1000
    const up = Math.max(0, Math.floor((Date.now() - this.#startedAt) / 1000))
    // 形态 `v=<版本>;up=<秒>;pi=<0|1>`。`focus` 只在焦点状态已知时才加，
    // 插件没有窗口焦点，因此省略（与桌面端未知焦点时的行为一致）。
    headers[HEADER_BEACON] = `v=${APP_VERSION};up=${up};pi=${relayed ? 1 : 0}`
    return headers
  }

  /** 记一次推理转发时间，供心跳的 `pi` 字段使用。 */
  markRelay(): void {
    if (this.#apiKey === '') return
    this.#state(this.#apiKey).lastRelay = Date.now()
  }

  /** 从响应体里取签到挑战。成功与 403 拒绝都会带。 */
  #captureChallenge(key: string, body: string): void {
    let parsed: { check_in?: unknown }
    try {
      parsed = JSON.parse(body) as { check_in?: unknown }
    } catch {
      return
    }
    const raw = parsed.check_in
    if (raw === null || typeof raw !== 'object') return
    const candidate = raw as { nonce?: unknown; seconds?: unknown }
    const nonce = typeof candidate.nonce === 'string' ? candidate.nonce.trim() : ''
    const seconds = typeof candidate.seconds === 'number' ? candidate.seconds : 0

    // 用与上游一致的判据：nonce 必须是 32 位小写十六进制。
    if (!isValidCheckIn({ nonce, seconds })) return

    const state = this.#state(key)
    state.challenge = { nonce, seconds }
    state.notedAt = Date.now()
  }

  /** 查一次 `/theos`，同时完成签到回传。 */
  async theos(signal?: AbortSignal): Promise<Allowance> {
    const key = this.#apiKey
    const state = this.#state(key)
    const headers = { ...this.#commonHeaders(), ...this.#checkInHeaders(state) }
    const sentNonce = headers[HEADER_CHECK_IN] ?? ''

    const response = await fetch(modelUrl(PATH_THEOS), {
      method: 'GET',
      headers,
      ...(signal !== undefined ? { signal } : {}),
      redirect: 'manual',
    })
    const body = await response.text().catch(() => '')

    // 请求带了 nonce 就说明这一次是「回传」：签到完成（403 拒绝也算，
    // 桌面端对拒绝同样记一次）。
    if (sentNonce !== '') state.ackedNonce = sentNonce
    state.attemptedAt = Date.now()
    this.#captureChallenge(key, body)

    if (!response.ok) {
      const error = new UpstreamError(
        response.status,
        errorCodeOf(body),
        `查询 Theos 失败（HTTP ${response.status}）：${errorMessageOf(body)}`,
        body,
        retryAfterSeconds(response.headers.get('retry-after')),
      )
      if (error.checkInRefused) state.refusedUntil = Date.now() + CHECK_IN_REFUSED_LOCK_MS
      throw error
    }

    let payload: { balance?: number; granted?: number; refresh_at?: string; refreshAt?: string }
    try {
      payload = JSON.parse(body) as typeof payload
    } catch {
      throw new Error('Theos 响应不是 JSON')
    }
    const allowance: Allowance = {
      ...(typeof payload.balance === 'number' ? { balance: payload.balance } : {}),
      ...(typeof payload.granted === 'number' ? { granted: payload.granted } : {}),
      ...(typeof (payload.refresh_at ?? payload.refreshAt) === 'string'
        ? { refreshAt: String(payload.refresh_at ?? payload.refreshAt) }
        : {}),
    }
    if (state.challenge !== undefined) allowance.checkIn = state.challenge
    return allowance
  }

  /**
   * 推理前确保签到完成。
   *
   * 这是「请求被不被接受」的关键：实测只拉 nonce 不回传 = 0/14 对齐，
   * 完整签到 = 14/14。失败一律不阻塞推理 —— 签到只影响落到真分支还是替身。
   */
  async ensureCheckIn(signal?: AbortSignal): Promise<void> {
    if (this.#apiKey === '') return
    const state = this.#state(this.#apiKey)
    const now = Date.now()

    // 被 check_in_refused 锁住：推理仍可走替身分支，继续打只会加深风控。
    if (state.refusedUntil > 0 && now < state.refusedUntil) return

    const challenge = state.challenge
    // 只有**有效**挑战才算「有挑战」：非法 nonce 不该挡住补签到
    const hasChallenge = isValidCheckIn(challenge)
    const needAck = hasChallenge && challenge.nonce !== state.ackedNonce

    // 有挑战且已回传，且还在半衰期内 → 什么都不用做
    if (hasChallenge && !needAck && now - state.notedAt < (challenge.seconds * 1000) / 2) return
    // 两次尝试之间留间隔
    if (state.attemptedAt > 0 && now - state.attemptedAt < CHECK_IN_MIN_INTERVAL_MS) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS)
    try {
      await this.theos(signal ?? controller.signal)
    } catch {
      // 签到失败不影响推理
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 发一次 chat 请求，返回上游 SSE 流。
   *
   * 形状兜底照 `openModel`：仍先按正常字段发；只有命中
   * `400 This request is not one DeepAI Code sends.` 时，才按桌面端字段白名单
   * 重排一次并补齐 system 消息。
   *
   * `affinity` 是会话粘性标识（上游据此做调度粘性），取自 `prompt_cache_key`；
   * 格式必须落在 `^[A-Za-z0-9._:-]{1,256}$` 内，非法值不发该请求头。
   */
  async openChat(
    options: GenerateOptions,
    model: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const affinity = affinityFor(body)
    const first = await this.#postChat(body, signal, affinity)
    if (first.ok) {
      return this.#toChatResult(first, signal)
    }

    const error = await this.#toError(first, '请求 chat')

    // 唯一的可纠正 400：请求体不是桌面端形状
    if (error.bodyRejected) {
      const fallback = chatBodyFallback(body, options.system)
      if (fallback !== undefined) {
        const retry = await this.#postChat(fallback, signal, affinity)
        if (retry.ok) return this.#toChatResult(retry, signal)
        throw await this.#toError(retry, '形状回退后请求 chat')
      }
    }

    throw error
  }

  /** 发一次 POST，不解析响应体。 */
  async #postChat(body: Record<string, unknown>, signal?: AbortSignal, affinity?: string): Promise<Response> {
    const headers = this.#commonHeaders()
    if (affinity !== undefined && affinity !== '') headers[HEADER_AFFINITY] = affinity
    // 桌面端在转发推理前记一次 lastRelayAt，心跳里的 pi 字段由此得来。
    this.markRelay()
    return fetch(modelUrl(PATH_CHAT), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
      // 上游会 302 到登录页，跟随会把鉴权失败伪装成 200
      redirect: 'manual',
    })
  }

  /** 把成功的响应转成 {@link ChatResult}。 */
  #toChatResult(response: Response, signal?: AbortSignal): ChatResult {
    if (response.body === null) throw new Error('上游没有返回响应体')
    return {
      body: response.body,
      status: response.status,
      abort: () => {
        try {
          void response.body?.cancel()
        } catch {
          // 已经关了
        }
        void signal
      },
    }
  }

  /**
   * 非流式 chat 请求。
   *
   * 有些客户端（以及 DSH 的部分内部调用）要完整消息而不是流。
   * 这里也走 SSE 端点，把帧拼起来，因为上游在缺省 `stream` 时本来就返回 SSE。
   */
  async completeChat(
    options: GenerateOptions,
    model: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; reasoning: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage?: Record<string, number>; finish: string }> {
    const { forEachSseFrame, chatChunkDelta, chatChunkUsage } = await import('./sse.ts')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NON_STREAM_BUDGET_MS)
    const merged = signal ?? controller.signal

    try {
      const result = await this.openChat(options, model, { ...body, stream: true }, merged)
      let text = ''
      let reasoning = ''
      let finish = ''
      let usage: Record<string, number> | undefined
      const toolCalls = new Map<number, { id: string; name: string; args: string }>()

      await forEachSseFrame(result.body, frame => {
        if (frame.object === undefined) return true
        const { delta, finish: f } = chatChunkDelta(frame.object)
        if (f !== '') finish = f
        text += delta.content
        reasoning += delta.reasoning
        for (const tc of delta.toolCalls) {
          let slot = toolCalls.get(tc.index)
          if (slot === undefined) {
            slot = { id: '', name: '', args: '' }
            toolCalls.set(tc.index, slot)
          }
          if (tc.id !== '') slot.id = tc.id
          if (tc.name !== '') slot.name = tc.name
          slot.args += tc.args
        }
        const u = chatChunkUsage(frame.object)
        if (u !== undefined) usage = u as Record<string, number>
        return true
      }, merged)

      return {
        text,
        reasoning,
        toolCalls: [...toolCalls.values()].map(tc => ({ id: tc.id, name: tc.name, arguments: tc.args })),
        ...(usage !== undefined ? { usage } : {}),
        finish,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
