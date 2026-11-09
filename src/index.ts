/**
 * dsh-deepai-connector — 插件入口。
 *
 * 把 DeepAI Code 的上游模型注册为 DSH 的 LlmAdapter。**不需要安装 DeepAI Code
 * 桌面端，也不需要额外的网关进程**：取 Key 走浏览器 OAuth，推理直连上游。
 *
 * 设计取向：**不依赖任何宿主 `@deepseek-ai/*` 包**，只用结构化类型对接
 * `ctx.llm.registerAdapter`。这样插件不会被内核版本绑死，也让沙箱里
 * 可以脱离宿主单测。
 *
 * @module src/index.ts
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

import { AccountStore, defaultDataDir, startSignIn, type SignInSession, type StoredAccount } from './adapter/auth.ts'
import { DeepAIClient } from './adapter/client.ts'
import { DeepAIAdapter, PROVIDER_ID } from './adapter/deepai.ts'
import { detectMachineFingerprint } from './adapter/machine.ts'

/** 插件名，同时是 cordis 里的 id。 */
export const name = 'dsh-deepai-connector'

/** 唯一硬依赖：模型服务。没有它插件无法工作。 */
export const inject = ['llm'] as const

/** 结构化的宿主 ctx，避免 import 内核包。 */
export interface PluginContext {
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  /** 发布拓扑变更通知，让浏览器重读模型列表。 */
  emit?(event: string, ...args: unknown[]): unknown
  /** cordis 的依赖注入：等服务就绪后执行。 */
  inject?(deps: string[], fn: (ctx: Record<string, unknown>) => unknown): unknown
  effect?(fn: () => () => void): unknown
  get?(key: string): unknown
}

/** 插件配置。 */
export interface PluginConfig {
  /** 注册到 DSH 的 provider id。改名会让已有会话指向失效。 */
  providerId?: string
  /** 模型选择器里的分组名。 */
  displayName?: string
  /** 状态目录（账号、偏好）。 */
  dataDir?: string
}

/** 设置页用的 REST 路由前缀。 */
const API_PREFIX = '/api/deepai'

/** 解析后的配置。 */
interface Resolved {
  providerId: string
  displayName: string
  dataDir: string
}

/**
 * 解析配置。数据目录默认 `~/.dsh-deepai-connect`，**与 DSH 主体分开**：
 * 凭据不写进 profile，避免被 profile 的清理或迁移波及。
 */
export function resolveConfig(config: PluginConfig = {}): Resolved {
  const explicit = config.dataDir?.trim()
  const dataDir = explicit !== undefined && explicit !== '' ? explicit : defaultDataDir()
  return {
    providerId: config.providerId?.trim() || PROVIDER_ID,
    displayName: config.displayName?.trim() || 'DeepAI Code',
    dataDir,
  }
}

/** 插件返回给宿主的句柄。 */
export interface PluginHandle {
  ready: Promise<{ version: string }>
}

/**
 * 插件加载入口。
 *
 * 启动顺序：先注册适配器（模型选择器要马上能看到 provider，哪怕还没登录），
 * 再后台探机器指纹与模型目录，最后挂设置路由。
 */
export function apply(ctx: PluginContext, config: PluginConfig = {}): PluginHandle {
  const logger = ctx.logger
  const ready = Promise.resolve({ version: 'adapter' })

  // 整段包起来：任何意外异常都只让本插件 FAILED（宿主会记一条
  // "1 entry did not activate" 警告并继续启动），绝不把异常抛回 Loader。
  try {
    return start(ctx, config, logger, ready)
  } catch (error) {
    logger.error(
      `dsh-deepai-connector: 启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    )
    return { ready }
  }
}

/** 真正的启动逻辑，由 {@link apply} 兜住异常。 */
function start(
  ctx: PluginContext,
  config: PluginConfig,
  logger: PluginContext['logger'],
  ready: Promise<{ version: string }>,
): PluginHandle {
  const cfg = resolveConfig(config)

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('dsh-deepai-connector: llm 服务不可用，适配器无法注册')
    return { ready }
  }

  const store = new AccountStore(cfg.dataDir)
  const client = new DeepAIClient()

  // 机器指纹要异步探（Windows 上要起 PowerShell），先给空值，探到再补。
  const machineReady = detectMachineFingerprint()
    .then(fingerprint => {
      if (fingerprint === '') {
        logger.warn(
          'dsh-deepai-connector: 未读取到机器指纹，上游可能拒绝推理（machine_required）。' +
            '可设置 DEEPAI_MACHINE_ID=<原始机器 UUID> 显式覆盖',
        )
      } else {
        logger.info(`dsh-deepai-connector: 机器指纹 ${fingerprint.slice(0, 12)}…`)
      }
      return fingerprint
    })
    .catch(() => '')

  const adapter = new DeepAIAdapter({
    providerId: cfg.providerId,
    displayName: cfg.displayName,
    client,
    store,
  })

  // 1. 先注册，选择器立刻可用。
  //    provider id 若与其他插件撞车，registerAdapter 会抛错。
  //    宁可自己 FAILED，也不要把宿主启动拖下水。
  try {
    ctx.llm.registerAdapter([cfg.providerId], adapter)
    logger.info(`dsh-deepai-connector: 已注册 provider "${cfg.providerId}"`)
  } catch (error) {
    logger.error(
      `dsh-deepai-connector: provider "${cfg.providerId}" 注册失败（可能与已装插件同名）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return { ready }
  }

  // 2. 后台初始化：指纹与账号解耦
  //
  // 指纹**与登录无关**：它读的是本机硬件，必须在启动时就落到 client 上。
  // 早先把 setMachine 放在 `if (account === undefined) return` 之后，
  // 结果是「启动时没登录 → 指纹永远补不上」，设置页一直显示未读取。
  void (async () => {
    const fingerprint = await machineReady
    client.setMachine(fingerprint)

    await store.load()
    const account = store.get()
    if (account === undefined) {
      logger.info('dsh-deepai-connector: 还没有登录，请在「设置 → DeepAI Code」完成授权')
      return
    }

    logger.info(`dsh-deepai-connector: 已加载账号 ${account.username !== '' ? account.username : '(无用户名)'}`)
    client.setApiKey(account.apiKey)

    await probeAndLoad(adapter, client, logger)
  })().catch((error: unknown) => {
    logger.error(`dsh-deepai-connector: 初始化失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 3. 设置页路由（可选：没有 connection 服务就跳过，不影响聊天）
  installRoutes(ctx, cfg, store, client, adapter, logger, (account) => {
    // 登录成功后补车道探测与目录刷新：启动时没登录，这两步都被跳过了。
    client.setApiKey(account.apiKey)
    void probeAndLoad(adapter, client, logger).catch((error: unknown) => {
      logger.warn(
        `dsh-deepai-connector: 登录后初始化失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  })

  return { ready }
}

/**
 * 探车道 + 拉模型目录。
 *
 * 启动时（已登录）与登录成功后各调一次。车道探测失败不阻塞：沿用默认车道，
 * 请求仍能发出去，只是上游抬档时会吃 426。
 */
async function probeAndLoad(
  adapter: DeepAIAdapter,
  client: DeepAIClient,
  logger: PluginContext['logger'],
): Promise<void> {
  try {
    const lane = await client.probeLane()
    logger.info(`dsh-deepai-connector: 车道版本 ${lane}`)
  } catch {
    logger.warn('dsh-deepai-connector: 车道探测失败，沿用默认值')
  }

  await adapter.refreshModels(true).catch(() => {})
  logger.info(`dsh-deepai-connector: 模型目录 ${adapter.catalog.list().length} 项`)
}

/**
 * 挂设置页用的 REST 路由。
 *
 * 用 `ctx.inject(['connection'])` 等连接注册表就绪。这套路由做四件事：
 * 发起授权、查状态、登出、刷新目录。**不需要重启就能生效**。
 *
 * `onSignedIn` 在授权成功、凭据落盘后被调一次：登录前跑不了的初始化
 * （车道探测、模型目录）补在这里，否则用户登录完仍看不到模型。
 */
function installRoutes(
  ctx: PluginContext,
  cfg: Resolved,
  store: AccountStore,
  client: DeepAIClient,
  adapter: DeepAIAdapter,
  logger: PluginContext['logger'],
  onSignedIn: (account: StoredAccount) => void,
): void {
  if (typeof ctx.inject !== 'function') return

  /** 进行中的授权会话（一次只允许一个）。 */
  let pending: SignInSession | undefined

  try {
    ctx.inject(['connection'], (cctx: Record<string, unknown>) => {
      const connection = cctx.connection as
        | { fetch?: { register?: (route: unknown) => () => void } }
        | undefined
      const register = connection?.fetch?.register
      if (typeof register !== 'function') {
        logger.warn('dsh-deepai-connector: connection fetch 注册表不可用，设置页 API 已禁用')
        return
      }

      const json = (status: number, payload: unknown): Response =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })

      const disposers: Array<() => void> = []

      const registerRoute = (
        path: string,
        methods: string[],
        handler: (request: Request) => Promise<Response>,
      ): void => {
        try {
          disposers.push(
            register({
              path,
              methods,
              requestBody: 'buffered',
              fetch: handler,
            }),
          )
        } catch (error) {
          logger.warn(
            `dsh-deepai-connector: ${path} 注册失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      // GET /api/deepai/status — 登录状态与模型清单
      registerRoute(`${API_PREFIX}/status`, ['GET'], async () => {
        await store.load()
        const account = store.get()
        const models = adapter.catalog.list()
        return json(200, {
          ok: true,
          providerId: cfg.providerId,
          displayName: cfg.displayName,
          signedIn: account !== undefined,
          account:
            account !== undefined
              ? {
                  username: account.username,
                  isPro: account.isPro,
                  obtainedAt: account.obtainedAt,
                }
              : null,
          lane: client.lane,
          machineReady: client.machine !== '',
          catalogLive: adapter.catalog.live,
          models: models.map(m => ({
            id: m.id,
            name: m.name ?? m.id,
            free: m.theosPerRequest === '0' || m.premier !== true,
            vision: (m.input ?? []).includes('image'),
            reasoning: m.reasoning === true,
            contextWindow: m.contextWindow ?? null,
            maxTokens: m.maxTokens ?? null,
          })),
        })
      })

      // POST /api/deepai/login — 发起浏览器授权，返回待打开地址
      registerRoute(`${API_PREFIX}/login`, ['POST'], async () => {
        try {
          // 上一次没走完的会话先放弃，避免回环端口泄漏
          pending?.cancel()
          const session = startSignIn()
          pending = session
          const url = await session.ready()

          // 不阻塞响应：后台等授权结果
          void session
            .wait()
            .then(async account => {
              await store.save(account)
              client.setApiKey(account.apiKey)
              logger.info(`dsh-deepai-connector: 授权成功 ${account.username !== '' ? account.username : ''}`)
              // 登录前跑不了的那些初始化在这里补齐（车道、目录）
              onSignedIn(account)
            })
            .catch((error: unknown) => {
              logger.warn(
                `dsh-deepai-connector: 授权未完成：${error instanceof Error ? error.message : String(error)}`,
              )
            })
            .finally(() => {
              if (pending === session) pending = undefined
            })

          return json(200, { ok: true, url, instructions: '在浏览器中完成登录，然后回到此处刷新' })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      // POST /api/deepai/logout — 删除凭据
      registerRoute(`${API_PREFIX}/logout`, ['POST'], async () => {
        try {
          pending?.cancel()
          pending = undefined
          await store.clear()
          client.setApiKey('')
          logger.info('dsh-deepai-connector: 已登出')
          return json(200, { ok: true })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      // POST /api/deepai/models/refresh — 强制重拉上游目录
      registerRoute(`${API_PREFIX}/models/refresh`, ['POST'], async () => {
        try {
          await adapter.refreshModels(true)
          return json(200, {
            ok: true,
            live: adapter.catalog.live,
            models: adapter.catalog.list().map(m => ({ id: m.id, name: m.name ?? m.id })),
          })
        } catch (error) {
          return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      logger.info(`dsh-deepai-connector: 设置页 API 已挂载在 ${API_PREFIX}`)

      // 卸载时摘掉路由
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          pending?.cancel()
          pending = undefined
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              // 尽力而为
            }
          }
        })
      }
      return undefined
    })
  } catch (error) {
    logger.warn(
      `dsh-deepai-connector: 设置页 API 不可用：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export { DeepAIAdapter, PROVIDER_ID } from './adapter/deepai.ts'
export { DeepAIClient } from './adapter/client.ts'
export { AccountStore, startSignIn } from './adapter/auth.ts'
export { detectMachineFingerprint, machineFingerprint } from './adapter/machine.ts'

export { toStreamChunks } from './adapter/stream.ts'
