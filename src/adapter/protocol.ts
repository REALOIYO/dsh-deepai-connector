/**
 * DeepAI Code 上游协议常量与请求头。
 *
 * 逆向自 DeepAI Code 桌面端 0.3.20（Electron + 本地 t3code server）。
 * 上游本身是 OpenAI 兼容接口，因此本插件不复刻协议体，只复刻「请求头形状」
 * ——那才是上游用来判定「是不是桌面端」的依据。
 *
 * 关键事实：
 *   - 鉴权头是 `Api-Key: <key>`，不是 `Authorization`；
 *   - 车道版本恒为 `4`（`X-DeepAI-Code-Theos`），其它值一律 426；
 *   - 推理请求的 UA 必须是 `node`（Node fetch / undici 的默认值）——
 *     实测换成 Chrome UA 会被换到另一条后端，响应里 `provider` 变成 `"DeepAI"`；
 *   - 机器指纹是 `sha256(原始机器 UUID 小写)`，用于上游按天发放免费额度。
 *
 * @module src/adapter/protocol.ts
 */

/** 上游生产环境地址。 */
export const ORIGIN = 'https://api.deepai.org'

/**
 * 实际使用的上游地址。
 *
 * 允许 `DEEPAI_API_ORIGIN` 覆盖（自建反代 / 测试用），但只接受 http/https。
 */
export function origin(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.DEEPAI_API_ORIGIN ?? '').trim().replace(/\/+$/, '')
  if (override !== '') {
    try {
      const parsed = new URL(override)
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host !== '') return override
    } catch {
      // 非法就退回生产地址
    }
  }
  return ORIGIN
}

/** `/deepai_code` 前缀下的模型端点。 */
export const MODEL_BASE = '/deepai_code'

/** 车道版本。上游每抬一次就把旧值一律回 426。 */
export const LANE_VERSION = '4'

/** 应用版本号，只出现在 `/theos` 的心跳 `v=` 字段里。 */
export const APP_VERSION = '0.3.20'

/** 鉴权头。上游统一使用 `Api-Key`（大小写不敏感）。 */
export const HEADER_KEY = 'Api-Key'
/** 车道版本。 */
export const HEADER_LANE = 'X-DeepAI-Code-Theos'
/** 机器指纹。 */
export const HEADER_MACHINE = 'X-DeepAI-Code-Machine'
/** 进程级实例号（16 字节随机 hex），随所有 JSON 请求发出。 */
export const HEADER_INSTANCE = 'X-DeepAI-Code-Instance'
/** 签到 nonce，仅 `/theos` 请求回传。 */
export const HEADER_CHECK_IN = 'X-DeepAI-Code-Check-In'
/** 客户端心跳：`v=<版本>;up=<秒>;pi=<0|1>`。 */
export const HEADER_BEACON = 'X-DeepAI-Code-Beacon'
/** 会话粘性。 */
export const HEADER_AFFINITY = 'X-Session-Affinity'

/** 路径（相对 {@link MODEL_BASE}）。 */
export const PATH_MODELS = '/models'
export const PATH_CHAT = '/chat/completions'
export const PATH_RESPONSES = '/responses'
export const PATH_THEOS = '/theos'
/** 桌面端同款浏览器登录入口。 */
export const PATH_SIGN_IN = '/desktop_auth/'
/** 用授权码换 Key。 */
export const PATH_EXCHANGE = '/desktop_auth/exchange/'

/** 上游错误码。 */
export const CODE_SESSION_BUSY = 'session_busy'
export const CODE_LANE_UNSUPPORTED = 'lane_version_unsupported'
export const CODE_SOCIAL_LOGIN = 'social_login_required'
export const CODE_MACHINE_REQUIRED = 'machine_required'
export const CODE_EMAIL_UNVERIFIED = 'email_unverified'
export const CODE_AUTH_REQUIRED = 'auth_required'
export const CODE_INVALID_API_KEY = 'invalid_api_key'
export const CODE_INVALID_REQUEST = 'invalid_request_error'
export const CODE_CHECK_IN_REFUSED = 'check_in_refused'
export const CODE_NETWORK_BOUND = 'network_bound'

/**
 * 推理请求必须发的头，逐字对齐桌面端的 Node fetch（undici）。
 *
 * 这几行是上游区分真假客户端的主要判据，不要「顺手加上更完整的头」：
 * 带 `sec-ch-ua`、Chrome UA 反而会被识别成非客户端。
 */
export const DESKTOP_INFERENCE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'node',
  Accept: '*/*',
  'Accept-Language': '*',
  'Sec-Fetch-Mode': 'cors',
})

/** 构造 `/deepai_code/<path>` 的完整地址。 */
export function modelUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${origin(env)}${MODEL_BASE}${path}`
}

/** 构造根路径地址（如 `/get_usage_summary`）。 */
export function rootUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${origin(env)}${path}`
}

/** 判定一个模型是否只能走 `/responses` 端点。 */
export function isResponsesApi(api: string | undefined): boolean {
  return api === 'openai-responses'
}
