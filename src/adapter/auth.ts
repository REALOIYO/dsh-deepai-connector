/**
 * 浏览器 OAuth 授权与凭据落盘。
 *
 * 这是本插件不需要 DeepAI Code 桌面端的全部原因：取 Key 走的是标准
 * RFC 8252 本机回调流程，与桌面端同款，但完全由本插件自己完成。
 *
 *   1. 起一个临时回环 HTTP 服务监听 `/auth-callback`；
 *   2. 打开 `https://api.deepai.org/deepai_code/desktop_auth/?state=…&port=…`；
 *   3. 浏览器登录后回调 `http://127.0.0.1:<port>/auth-callback?code=…&state=…`；
 *   4. `POST /deepai_code/desktop_auth/exchange/` 换回 `{api_key, username, is_pro}`。
 *
 * 凭据落在 `~/.dsh-deepai-connect/account.json`，权限 0600，与 DSH profile 分开
 * ——不被 profile 的清理或迁移波及。
 *
 * @module src/adapter/auth.ts
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { ORIGIN, PATH_EXCHANGE, PATH_SIGN_IN, modelUrl } from './protocol.ts'

/** 授权会话有效期。超时后回环服务自动关闭。 */
const LOGIN_TTL_MS = 10 * 60 * 1000

/** 落盘的凭据。 */
export interface StoredAccount {
  /** 上游 `Api-Key`。 */
  apiKey: string
  /** 上游用户名（仅用于显示与去重）。 */
  username: string
  /** 是否 Pro 订阅。 */
  isPro: boolean
  /** 取 Key 的时间（ISO）。 */
  obtainedAt: string
}

/** 一次授权会话。 */
export interface SignInSession {
  /**
   * 等回环端口就绪后给出让用户打开的地址。
   *
   * 做成 Promise 而不是同步字段：端口是 `listen` 之后才知道的，
   * 同步字段只能是空串，调用方一定会踩到空 URL。
   */
  ready(): Promise<string>
  /** 等待授权结果；完成后是已落盘的账号。 */
  wait(): Promise<StoredAccount>
  /** 主动放弃（关闭回环服务）。 */
  cancel(): void
}

/** 凭据存储。 */
export class AccountStore {
  readonly #path: string
  #account: StoredAccount | undefined
  #loaded = false

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'account.json')
  }

  get path(): string {
    return this.#path
  }

  /** 读盘。首次运行没有文件是正常情况。 */
  async load(): Promise<void> {
    if (this.#loaded) return
    try {
      const raw = await readFile(this.#path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredAccount>
      if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim() !== '') {
        this.#account = {
          apiKey: parsed.apiKey.trim(),
          username: typeof parsed.username === 'string' ? parsed.username : '',
          isPro: parsed.isPro === true,
          obtainedAt: typeof parsed.obtainedAt === 'string' ? parsed.obtainedAt : '',
        }
      }
    } catch {
      // 没有文件或内容坏了都按「未登录」处理
    }
    this.#loaded = true
  }

  /** 同步取当前账号；调用方须先 `load()`。 */
  get(): StoredAccount | undefined {
    return this.#account
  }

  /** 写入并落盘。 */
  async save(account: StoredAccount): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(account, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.#path)
    // Windows 上 mode 不设 ACL，这里尽力而为；文件本身落在用户私有目录。
    await chmod(this.#path, 0o600).catch(() => {})
    this.#account = account
    this.#loaded = true
  }

  /** 登出：删掉内存与磁盘上的凭据。 */
  async clear(): Promise<void> {
    this.#account = undefined
    this.#loaded = true
    const { rm } = await import('node:fs/promises')
    await rm(this.#path, { force: true }).catch(() => {})
  }
}

/** 上游 exchange 的响应（只声明用到的字段）。 */
interface ExchangeResponse {
  api_key?: unknown
  username?: unknown
  is_pro?: unknown
  key?: unknown
}

/**
 * 用授权码换 API Key。
 *
 * 上游字段名可能是 `api_key` 或 `key`（不同版本有出入），两个都认。
 */
export async function exchangeCode(code: string, signal?: AbortSignal): Promise<StoredAccount> {
  const response = await fetch(modelUrl(PATH_EXCHANGE), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'node',
      Accept: '*/*',
      'Accept-Language': '*',
      'Sec-Fetch-Mode': 'cors',
    },
    body: JSON.stringify({ code }),
    ...(signal !== undefined ? { signal } : {}),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`换取授权失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }

  let payload: ExchangeResponse
  try {
    payload = JSON.parse(text) as ExchangeResponse
  } catch {
    throw new Error(`换取授权的响应不是 JSON：${text.slice(0, 200)}`)
  }

  const apiKey = typeof payload.api_key === 'string' ? payload.api_key : typeof payload.key === 'string' ? payload.key : ''
  if (apiKey.trim() === '') throw new Error('换取授权成功但响应里没有 API Key')

  return {
    apiKey: apiKey.trim(),
    username: typeof payload.username === 'string' ? payload.username : '',
    isPro: payload.is_pro === true,
    obtainedAt: new Date().toISOString(),
  }
}

/** 用恒定时间比较两个 state，避免时序侧信道。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 关闭回环服务，忽略「已经在关」的错误。 */
function shutdown(server: Server | undefined): void {
  if (server === undefined) return
  try {
    server.close()
  } catch {
    // 已经关了
  }
}

/**
 * 发起一次浏览器授权。
 *
 * 返回的 `url` 交给用户打开；`wait()` 一直等到回调完成或超时。
 */
export function startSignIn(env = process.env): SignInSession {
  const state = randomBytes(32).toString('hex')
  let server: Server | undefined
  let settle: (account: StoredAccount) => void = () => {}
  let fail: (error: Error) => void = () => {}
  let finished = false
  let timer: NodeJS.Timeout | undefined

  const done = new Promise<StoredAccount>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const finish = (fn: () => void): void => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    shutdown(server)
    fn()
  }

  const origin = (env.DEEPAI_API_ORIGIN ?? ORIGIN).replace(/\/+$/, '')
  const pending = new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/auth-callback') {
        res.writeHead(404).end('Not found')
        return
      }

      const code = url.searchParams.get('code') ?? ''
      const gotState = url.searchParams.get('state') ?? ''
      if (req.method !== 'GET' || code === '' || code.length > 4096 || !safeEqual(gotState, state)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid sign-in callback.')
        return
      }

      void exchangeCode(code)
        .then(account => {
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            .end('<h2>已授权 DeepAI Code</h2><p>可以关闭此页面，回到 DSH 设置页。</p>')
          finish(() => settle(account))
        })
        .catch((error: unknown) => {
          res
            .writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            .end('Sign-in failed. Return to the console and try again.')
          finish(() => fail(error instanceof Error ? error : new Error(String(error))))
        })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (typeof address === 'object' && address !== null) resolve(address.port)
      else reject(new Error('无法取得回调端口'))
    })
  })

  timer = setTimeout(() => {
    finish(() => fail(new Error('授权超时（10 分钟），请重新发起')))
  }, LOGIN_TTL_MS)
  timer.unref?.()

  return {
    ready: () =>
      pending.then(port => {
        const target = new URL(`${origin}${PATH_SIGN_IN}`)
        target.searchParams.set('state', state)
        target.searchParams.set('port', String(port))
        return target.toString()
      }),
    wait: () => done,
    cancel: () => finish(() => fail(new Error('授权已取消'))),
  }
}

/** 默认数据目录：与 DSH profile 分开，避免被 profile 清理波及。 */
export function defaultDataDir(): string {
  return join(homedir(), '.dsh-deepai-connect')
}
