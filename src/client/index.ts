/**
 * 插件的前端半边：注册设置侧边栏入口。
 *
 * DSH 的设置面板通过 `slots.inject('settings.section', ...)` 收各插件的分节。
 * 注册后侧边栏会多一行，点开就是 {@link DeepAISettings}。
 *
 * `settings.section` 只投影 `id` / `order` / `label`，**不提供 icon 字段**，
 * 所以图标会落到宿主的兜底齿轮。这里不折腾 DOM 补丁 —— 等宿主这个 slot
 * 长出 icon 字段再补，比维护一段 MutationObserver 划算。
 *
 * @module src/client/index.ts
 */

import { NS, EN, ZH, setLocaleRuntime, text, type LocaleRuntime } from './i18n.ts'
import { DeepAISettings } from './page.tsx'

/** slot 服务的最小面。 */
interface Slots {
  inject(name: string, fn: () => unknown): unknown
  register(
    entry: { name: string; id: string; order: number; locale?: string; label?: () => string },
    component: unknown,
  ): unknown
}

/**
 * locale 服务：既支持一次性注册中英两套，也支持按语言注册（老宿主）。
 *
 * 用交叉类型而不是 extends —— 两边的 `register` 重载不兼容，
 * 继承会被 TS 判为冲突，但运行时确实是同一个对象支持两种调用。
 */
type ClientLocale = LocaleRuntime & {
  register(ns: string, lang: string, dict: Record<string, string>): () => void
}

/** 前端上下文（不 import 宿主包）。 */
export interface ClientContext {
  locale: ClientLocale
  slots: Slots
  effect?(fn: () => () => void, label?: string): unknown
}

/** 注册文案字典，兼容新老宿主签名。 */
function registerDictionaries(ctx: ClientContext): void {
  try {
    ctx.locale.register(NS, { zh: ZH, en: EN })
    return
  } catch {
    // 老宿主只认按语言的注册
  }
  try {
    ctx.locale.register(NS, 'zh', ZH)
    ctx.locale.register(NS, 'en', EN)
  } catch {
    // locale 是尽力而为：页面有内置兜底文案
  }
}

/** 前端入口。 */
export function apply(ctx: ClientContext): void {
  setLocaleRuntime(ctx.locale)

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(
        () => {
          registerDictionaries(ctx)
          return () => {
            setLocaleRuntime(undefined)
          }
        },
        'dsh-deepai-connector: locale dictionaries',
      )
    } catch {
      registerDictionaries(ctx)
    }
  } else {
    registerDictionaries(ctx)
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-deepai-connector',
        order: 14,
        locale: NS,
        label: () => text('nav'),
      },
      DeepAISettings,
    ),
  )
}

/** 必须有这两个服务才能工作。 */
export const inject = ['slots', 'locale']

export { NS }
