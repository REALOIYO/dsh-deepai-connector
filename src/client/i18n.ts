/**
 * 插件的文案表。
 *
 * 只做中英两套，key 用扁平命名。DSH 的 locale 服务按 namespace 注册，
 * 页面里通过 `text()` 读。
 *
 * @module src/client/i18n.ts
 */

import { useSyncExternalStore } from 'react'

/** locale namespace，和插件 id 区分开（避免与其他插件撞）。 */
export const NS = 'dsh-deepai-connector'

type Dict = Record<string, string>

export const ZH: Dict = {
  nav: 'DeepAI Code',
  title: 'DeepAI Code',
  intro:
    '用你的 DeepAI Code 账号，在 DSH 里直接调用它的模型。浏览器登录一次即可，不需要安装 DeepAI Code 桌面客户端，也不需要额外的网关程序。',

  accountSection: '账号',
  login: '登录',
  loggingIn: '等待授权…',
  loginPending: '授权链接已生成，请在浏览器里完成登录并授权。',
  openLink: '打开授权页面',
  copyLink: '复制链接',
  copied: '已复制',
  loginWaiting: '正在等待浏览器授权（最多 10 分钟）…',
  loginSuccess: '登录成功',
  loginFailed: '登录失败',
  noAccount: '还没有登录账号。',
  noAccountHint: '点「登录」会生成一个授权链接，在浏览器里打开并授权即可。请用 Google 或 Apple 账号登录。',
  logout: '移除',
  logoutConfirm: '确定要移除这个账号吗？',
  refresh: '刷新',
  signedInAs: '已登录',
  proPlan: 'Pro',
  obtainedAt: '授权于',

  statusSection: '连接状态',
  lane: '车道版本',
  machineReady: '机器指纹',
  machineMissing: '未读取',
  known: '已就绪',
  yes: '是',
  no: '否',

  modelSection: '可用模型',
  modelHint:
    '这些是上游当前提供的模型，登录后即可在模型选择器里选到。每个请求消耗的 Theos 为 0 即免费。',
  free: '免费',
  paid: '付费',
  vision: '可看图',
  thinking: '会思考',
  contextWindow: '上下文',
  maxTokens: '最大输出',
  catalogLive: '目录来源',
  fromUpstream: '上游实测',
  fromFallback: '内置快照',

  cancel: '取消',
  error: '出错了',
  retry: '重试',
  loading: '加载中…',
}

export const EN: Dict = {
  nav: 'DeepAI Code',
  title: 'DeepAI Code',
  intro:
    'Use your DeepAI Code account to call its models from DSH. Sign in once in the browser — no DeepAI Code desktop app and no gateway process needed.',

  accountSection: 'Account',
  login: 'Sign in',
  loggingIn: 'Waiting for authorization…',
  loginPending: 'Authorization link created. Finish signing in in your browser.',
  openLink: 'Open authorization page',
  copyLink: 'Copy link',
  copied: 'Copied',
  loginWaiting: 'Waiting for browser authorization (up to 10 minutes)…',
  loginSuccess: 'Signed in',
  loginFailed: 'Sign-in failed',
  noAccount: 'No account signed in yet.',
  noAccountHint: 'Press "Sign in" to get an authorization link, then open it in your browser. Use a Google or Apple account.',
  logout: 'Remove',
  logoutConfirm: 'Remove this account?',
  refresh: 'Refresh',
  signedInAs: 'Signed in as',
  proPlan: 'Pro',
  obtainedAt: 'Authorized',

  statusSection: 'Connection',
  lane: 'Lane version',
  machineReady: 'Machine fingerprint',
  machineMissing: 'not detected',
  known: 'ready',
  yes: 'yes',
  no: 'no',

  modelSection: 'Available models',
  modelHint:
    'Models the upstream offers right now. A Theos cost of 0 per request means free.',
  free: 'free',
  paid: 'paid',
  vision: 'vision',
  thinking: 'thinking',
  contextWindow: 'Context',
  maxTokens: 'Max output',
  catalogLive: 'Catalog source',
  fromUpstream: 'live',
  fromFallback: 'built-in snapshot',

  cancel: 'Cancel',
  error: 'Error',
  retry: 'Retry',
  loading: 'Loading…',
}

/** locale 服务的最小面（不 import 宿主包）。 */
export interface LocaleRuntime {
  register(ns: string, dicts: { zh: Dict; en: Dict }): unknown
  subscribe?(listener: () => void): () => void
  getSnapshot?(): { active?: string; revision?: number }
}

let runtime: LocaleRuntime | undefined

/** 记下 locale 服务，供 `text()` 判当前语言。 */
export function setLocaleRuntime(next: LocaleRuntime | undefined): void {
  runtime = next
}

/** 当前是否中文。判不出来就按中文（本插件主要面向中文用户）。 */
function isZh(): boolean {
  try {
    const active = runtime?.getSnapshot?.()?.active ?? ''
    if (active === '') return true
    return /^zh/i.test(active)
  } catch {
    return true
  }
}

/**
 * 取一条文案。
 * @param key 文案 key
 * @param params 替换 `{name}` 形式的占位
 */
export function text(key: string, params?: Record<string, string | number>): string {
  const dict = isZh() ? ZH : EN
  let value = dict[key] ?? ZH[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v))
  }
  return value
}

/** 语言变化时触发重渲染，避免切语言后页面还显示旧文案。 */
export function useLocaleRevision(): number {
  return useSyncExternalStore<number>(
    (listener: () => void) => {
      try {
        return runtime?.subscribe?.(listener) ?? (() => {})
      } catch {
        return () => {}
      }
    },
    () => {
      try {
        return runtime?.getSnapshot?.()?.revision ?? 0
      } catch {
        return 0
      }
    },
    () => 0,
  )
}
