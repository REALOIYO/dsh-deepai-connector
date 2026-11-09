/**
 * DeepAI 上游客户端：请求头组装、签到状态机、错误语义。
 *
 * 这里做的事只有三件，别的都交给 pi-ai：
 *   1. 把请求头的形状做对（UA 必须是 `node`，带车道号、实例号、机器指纹）；
 *   2. 推理前确保签到完成 —— 上游拿这个判定「是不是真客户端」；
 *   3. 把上游的错误码翻译成可判定的语义，交给适配器决定要不要重试。
 *
 * @module src/adapter/client.ts
 */

import { randomBytes } from 'node:crypto'

import {
  APP_VERSION,
  CODE_CHECK_IN_REFUSED,
  CODE_LANE_UNSUPPORTED,
  CODE_MACHINE_REQUIRED,
  CODE_NETWORK_BOUND,
  CODE_SESSION_BUSY,
  CODE_SOCIAL_LOGIN,
  DESKTOP_INFERENCE_HEADERS,
  HEADER_BEACON,
  HEADER_CHECK_IN,
  HEADER_INSTANCE,
  HEADER_KEY,
  HEADER_LANE,
  HEADER_MACHINE,
  LANE_VERSION,
  PATH_MODELS,
  PATH_THEOS,
  modelUrl,
} from './protocol.ts'

/**
 * 两次签到尝试之间的最小间隔。
 *
 * 桌面端在拿到 `check_in` 之前不主动签到（它靠账号状态刷新触发）；
 * 本插件没有独立的状态轮询，给个下限避免每次热路径请求都撞一次 403。
 */
const CHECK_IN_MIN_INTERVAL_MS = 30_000

/** 单次签到的时间预算：签到只是上下文，失败不该阻塞推理。 */
const CHECK_IN_TIMEOUT_MS = 10_000

/**
 * 命中 `check_in_refused` 后的静默锁时长。
 *
 * 上游当天「重启签到」次数用尽后 403 里**仍然会下发新的 nonce**，
 * 不停手就会变成一个自己制造的签到风暴。锁 6h 与客户端的日额度节奏一致，
 * 到期允许再试一次。
 */
const CHECK_IN_REFUSED_LOCK_MS = 6 * 60 * 60 * 1000

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

/** 上游 `/theos` 响应里用到的字段。 */
export interface Allowance {
  balance?: number
  granted?: number
  refreshAt?: string
  checkIn?: CheckIn
}

/** 签到挑战。 */
export interface CheckIn {
  nonce: string
  seconds: number
}

/** 上游进程级状态：实例号、机器指纹、按 key 隔离的签到状态。 */
interface CheckInState {
  challenge: CheckIn | undefined
  notedAt: number
  attemptedAt: number
  /** 已回传给上游的 nonce。「拿到」与「回传」是两件事，只有后者算签到完成。 */
  ackedNonce: string
  refusedUntil: number
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

  constructor(status: number, code: string, message: string, body = '') {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.code = code
    this.body = body
  }

  /** 账号级策略拦截：换号、重试都无解，只能换登录方式。 */
  get socialLoginRequired(): boolean {
    return this.code === CODE_SOCIAL_LOGIN
  }

  /** 缺机器指纹。 */
  get machineRequired(): boolean {
    return this.code === CODE_MACHINE_REQUIRED
  }

  /** 车道版本不被接受，需要换车道号。 */
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

  /** 网络级免费额度领完（同一出口 IP 共享当日池子）。 */
  get networkBound(): boolean {
    return this.code === CODE_NETWORK_BOUND
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

/**
 * 上游客户端。
 *
 * 一个实例服务一个已授权账号；实例号进程级一次，签到状态按 API Key 隔离
 * （这里只有一个账号，但保留按 key 分桶的形状以便将来支持多号）。
 */
export class DeepAIClient {
  readonly #instance: string
  readonly #startedAt = Date.now()
  #machine: string
  #apiKey = ''
  #lane: string
  #checkIns = new Map<string, CheckInState>()

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

  /**
   * 补设机器指纹。
   *
   * 指纹是异步探到的（Windows 上要起 PowerShell），客户端构造时通常还空着；
   * 探到后立刻补上，否则上游会以 `machine_required` 拒绝推理。
   */
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
      state = { challenge: undefined, notedAt: 0, attemptedAt: 0, ackedNonce: '', refusedUntil: 0 }
      this.#checkIns.set(key, state)
    }
    return state
  }

  /**
   * 组装公共请求头。
   *
   * `desktopInferenceHeaders` 必须原样发出：这几行是上游区分真假客户端的
   * 主要判据。不要「顺手加上更完整的头」。
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

  /** 发一次请求，非 2xx 抛 {@link UpstreamError}。 */
  async #request(path: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = this.#commonHeaders()
    // 签到头只在 /theos 上带
    const response = await fetch(modelUrl(path), {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
      // 上游会把无效 Key 302 到登录页，跟随只会把鉴权失败伪装成 200。
      redirect: 'manual',
    })
    return response
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
    )
  }

  /**
   * 拉模型目录。
   *
   * `/models` 是免鉴权的，因此也是探测车道版本最便宜的方式。
   */
  async listModels(signal?: AbortSignal): Promise<UpstreamModel[]> {
    const response = await this.#request(PATH_MODELS, { ...(signal !== undefined ? { signal } : {}) })
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
    const candidates = ['4', '5', '6', '7', '3', '2']
    for (const lane of candidates) {
      const previous = this.#lane
      this.#lane = lane
      try {
        const response = await this.#request(PATH_MODELS, { ...(signal !== undefined ? { signal } : {}) })
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
    if (state.challenge !== undefined && state.challenge.nonce !== state.ackedNonce) {
      headers[HEADER_CHECK_IN] = state.challenge.nonce
    }
    const up = Math.max(0, Math.floor((Date.now() - this.#startedAt) / 1000))
    // 形态 `v=<版本>;up=<秒>;pi=<0|1>`。`focus` 只在焦点状态已知时才加，
    // 插件没有窗口焦点，因此省略（与桌面端未知焦点时的行为一致）。
    headers[HEADER_BEACON] = `v=${APP_VERSION};up=${up};pi=${state.attemptedAt > 0 ? 1 : 0}`
    return headers
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
    if (nonce === '' || seconds <= 0) return

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
      )
      if (error.checkInRefused) state.refusedUntil = Date.now() + CHECK_IN_REFUSED_LOCK_MS
      throw error
    }

    let payload: { balance?: number; granted?: number; refresh_at?: string; refreshAt?: string; check_in?: unknown }
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
   * 完整签到 = 14/14。判定按 (账号, 机器指纹) 记忆，换指纹等于冷启动。
   *
   * 失败一律不阻塞推理 —— 签到只影响落到真分支还是替身分支。
   */
  async ensureCheckIn(signal?: AbortSignal): Promise<void> {
    if (this.#apiKey === '') return
    const state = this.#state(this.#apiKey)
    const now = Date.now()

    // 被 check_in_refused 锁住：推理仍可走替身分支，继续打只会加深风控。
    if (state.refusedUntil > 0 && now < state.refusedUntil) return

    const challenge = state.challenge
    const needAck = challenge !== undefined && challenge.nonce !== state.ackedNonce
    // 有挑战且已回传，且还在半衰期内 → 什么都不用做
    if (challenge !== undefined && !needAck && now - state.notedAt < (challenge.seconds * 1000) / 2) return
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
}
