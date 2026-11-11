/**
 * DeepAI Code 设置页。
 *
 * 侧边栏入口由 `settings.section` 注册，这个组件就是那个入口打开的内容。
 * 三件事：登录（浏览器授权）、看连接状态、看可用模型。
 *
 * 不 import 宿主的 `@deepseek-ai/*` 组件库 —— 只用受控的 button/div 组合，
 * 样式走 DSH 的 CSS 变量（`--dsw-alias-*`），这样不会因为宿主版本升级而崩。
 *
 * @module src/client/page.tsx
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { text, useLocaleRevision } from './i18n.ts'

/** 后端给的状态。 */
interface StatusPayload {
  ok: boolean
  providerId: string
  displayName: string
  signedIn: boolean
  account: { username: string; isPro: boolean; obtainedAt: string } | null
  lane: string
  machineReady: boolean
  catalogLive: boolean
  models: Array<{
    id: string
    name: string
    free?: boolean
    vision?: boolean
    reasoning?: boolean
    contextWindow?: number | null
    maxTokens?: number | null
  }>
}

/** 登录响应。 */
interface LoginPayload {
  ok: boolean
  url?: string
  instructions?: string
  error?: string
}

/** 刷新模型目录的响应。 */
interface RefreshPayload {
  ok: boolean
  /** 目录现在是否来自上游实测（false = 还在用内置快照）。 */
  live?: boolean
  /** 这次刷新是否真的改变了目录内容。 */
  changed?: boolean
  /** 刷新后的模型数。 */
  count?: number
  error?: string
}

/** 单个请求的超时。授权页要在浏览器里点，这里的请求都是短请求。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 轮询登录结果的间隔。 */
const POLL_INTERVAL_MS = 1500

/** 等登录的最长时间：与后端授权会话的 10 分钟对齐，留一点余量。 */
const LOGIN_WAIT_MS = 11 * 60 * 1000

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 20 } as const,
  section: { display: 'flex', flexDirection: 'column', gap: 10 } as const,
  h2: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 } as const,
  muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 } as const,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const,
  card: {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } as const,
  code: {
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-all',
  } as const,
  link: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
    textDecoration: 'underline',
    wordBreak: 'break-all',
  } as const,
  list: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' } as const,
  item: {
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  } as const,
  itemHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } as const,
  name: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } as const,
  tag: {
    padding: '1px 7px',
    borderRadius: 999,
    fontSize: 11,
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
  } as const,
  tagFree: {
    padding: '1px 7px',
    borderRadius: 999,
    fontSize: 11,
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-primary)',
  } as const,
  err: { fontSize: 12, color: 'var(--dsw-alias-label-warning, #d9534f)', margin: 0 } as const,
} as const

/** 带超时的 JSON 请求。 */
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    })
    const raw = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(raw?.error ?? `HTTP ${res.status}`)
    return raw
  } finally {
    clearTimeout(timer)
  }
}

/** 一个简单的按钮（不依赖宿主组件库）。 */
function Btn(props: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  primary?: boolean
}): React.ReactElement {
  const { children, onClick, disabled, primary } = props
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 14px',
        borderRadius: 8,
        fontSize: 13,
        cursor: disabled === true ? 'not-allowed' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
        border: primary === true ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        background: primary === true ? 'var(--dsw-alias-label-primary)' : 'transparent',
        color: primary === true ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-primary)',
      }}
    >
      {children}
    </button>
  )
}

/** 把 token 数压成 K/M 的可读形式。 */
function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || tokens <= 0) return '—'
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}K`
  return String(tokens)
}

/** 设置页主体。 */
export function DeepAISettings(): React.ReactElement {
  useLocaleRevision()

  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loginUrl, setLoginUrl] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [copied, setCopied] = useState(false)
  /** 上次刷新模型的结果，给用户一个明确反馈（成功/无变化/失败）。 */
  const [refreshNote, setRefreshNote] = useState('')
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const loginDeadline = useRef(0)

  const load = useCallback(async () => {
    try {
      const data = await request<StatusPayload>('/api/deepai/status')
      setStatus(data)
      setError('')
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 停掉轮询。 */
  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    setWaiting(false)
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /** 开始登录：拿授权地址，然后轮询状态是否变成已登录。 */
  const startLogin = useCallback(async () => {
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      const data = await request<LoginPayload>('/api/deepai/login', 'POST')
      if (data.ok !== true || data.url === undefined || data.url === '') {
        throw new Error(data.error ?? text('loginFailed'))
      }
      setLoginUrl(data.url)
      setWaiting(true)
      loginDeadline.current = Date.now() + LOGIN_WAIT_MS

      if (pollTimer.current !== null) clearInterval(pollTimer.current)
      pollTimer.current = setInterval(async () => {
        if (Date.now() > loginDeadline.current) {
          stopPolling()
          setError(text('loginFailed'))
          return
        }
        const next = await load()
        if (next?.signedIn === true) {
          stopPolling()
          setLoginUrl('')
          setBusy(false)
        }
      }, POLL_INTERVAL_MS)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }, [load, stopPolling])

  /** 复制授权链接。 */
  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(loginUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [loginUrl])

  /** 登出。 */
  const logout = useCallback(async () => {
    if (!window.confirm(text('logoutConfirm'))) return
    setBusy(true)
    try {
      await request('/api/deepai/logout', 'POST')
      setLoginUrl('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [load])

  /**
   * 强制刷新模型目录。
   *
   * 要给出明确结果：刷新本身看不见摸不着，光重新 load() 一遍，
   * 用户分不清「刷成功了」「上游没变化」「根本没拉到上游」三种情况。
   */
  const refreshModels = useCallback(async () => {
    setBusy(true)
    setRefreshNote('')
    try {
      const data = await request<RefreshPayload>('/api/deepai/models/refresh', 'POST')
      await load()
      if (data.live !== true) {
        // live=false 说明这次没拿到上游目录，仍在用内置快照
        setError(text('refreshFailedFallback'))
      } else {
        setRefreshNote(
          data.changed === true
            ? text('refreshChanged', { count: data.count ?? 0 })
            : text('refreshUnchanged', { count: data.count ?? 0 }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [load])

  const account = status?.account ?? null

  return (
    <div style={styles.wrap}>
      <div style={styles.section}>
        <h2 style={styles.h2}>{text('title')}</h2>
        <p style={styles.muted}>{text('intro')}</p>
      </div>

      {error !== '' && <p style={styles.err}>{`${text('error')}: ${error}`}</p>}

      {/* 账号 */}
      <div style={styles.section}>
        <h2 style={styles.h2}>{text('accountSection')}</h2>

        {account === null ? (
          <>
            <p style={styles.muted}>{text('noAccount')}</p>
            <p style={styles.muted}>{text('noAccountHint')}</p>
          </>
        ) : (
          <div style={styles.card}>
            <div style={styles.itemHead}>
              <span style={styles.name}>{`${text('signedInAs')} ${account.username !== '' ? account.username : '—'}`}</span>
              {account.isPro && <span style={styles.tagFree}>{text('proPlan')}</span>}
            </div>
            {account.obtainedAt !== '' && (
              <span style={styles.code}>{`${text('obtainedAt')} ${account.obtainedAt}`}</span>
            )}
          </div>
        )}

        <div style={styles.row}>
          {account === null && (
            <Btn primary disabled={busy} onClick={() => void startLogin()}>
              {waiting ? text('loggingIn') : text('login')}
            </Btn>
          )}
          {account !== null && (
            <>
              <Btn disabled={busy} onClick={() => void refreshModels()}>
                {text('refresh')}
              </Btn>
              {refreshNote !== '' && <span style={styles.muted}>{refreshNote}</span>}
              <Btn disabled={busy} onClick={() => void logout()}>
                {text('logout')}
              </Btn>
            </>
          )}
        </div>

        {loginUrl !== '' && (
          <div style={styles.card}>
            <p style={styles.muted}>{text('loginPending')}</p>
            <a href={loginUrl} target="_blank" rel="noreferrer" style={styles.link}>
              {text('openLink')}
            </a>
            <div style={styles.row}>
              <Btn onClick={() => void copyUrl()}>{copied ? text('copied') : text('copyLink')}</Btn>
              {waiting && <span style={styles.muted}>{text('loginWaiting')}</span>}
            </div>
          </div>
        )}
      </div>

      {/* 连接状态 */}
      {status !== null && (
        <div style={styles.section}>
          <h2 style={styles.h2}>{text('statusSection')}</h2>
          <div style={styles.row}>
            <span style={styles.tag}>{`${text('lane')}: ${status.lane}`}</span>
            <span style={styles.tag}>
              {`${text('machineReady')}: ${status.machineReady ? text('known') : text('machineMissing')}`}
            </span>
            <span style={styles.tag}>
              {`${text('catalogLive')}: ${status.catalogLive ? text('fromUpstream') : text('fromFallback')}`}
            </span>
          </div>
        </div>
      )}

      {/* 模型 */}
      <div style={styles.section}>
        <h2 style={styles.h2}>{text('modelSection')}</h2>
        <p style={styles.muted}>{text('modelHint')}</p>
        <ul style={styles.list}>
          {(status?.models ?? []).map(model => (
            <li key={model.id} style={styles.item}>
              <div style={styles.itemHead}>
                <span style={styles.name}>{model.name}</span>
                <span style={model.free === true ? styles.tagFree : styles.tag}>
                  {model.free === true ? text('free') : text('paid')}
                </span>
                {model.vision === true && <span style={styles.tag}>{text('vision')}</span>}
                {model.reasoning === true && <span style={styles.tag}>{text('thinking')}</span>}
              </div>
              <span style={styles.code}>
                {`${model.id} · ${text('contextWindow')} ${formatTokens(model.contextWindow)} · ${text('maxTokens')} ${formatTokens(model.maxTokens)}`}
              </span>
            </li>
          ))}
          {status !== null && (status.models ?? []).length === 0 && <p style={styles.muted}>{text('loading')}</p>}
        </ul>
      </div>
    </div>
  )
}
