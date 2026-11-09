/**
 * 构建：把 src/ 打成 lib/index.js（Host）与 lib/client.js（浏览器）。
 *
 * 两个半边的差别：
 *  - Host 用 ESM、platform node，`@deepseek-ai/*` 保持外部引用
 *  - Client 用 CJS、platform browser，react 与宿主组件库保持外部引用，
 *    并套上 `window.__ModuleLoader__.load` 外壳（宿主用这个装前端模块）
 *
 * 依赖 esbuild 由调用方提供，不写进 dependencies（保持插件运行时零依赖）。
 * 允许用 `DEEPAI_ESBUILD` 指定已安装的 esbuild 目录，供离线环境复用。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// esbuild 是构建期依赖，不写进 package.json。
// 查找顺序：环境变量 → 本地 node_modules → npx 缓存。
async function loadEsbuild() {
  const candidates = []
  const override = process.env.DEEPAI_ESBUILD
  if (override !== undefined && override !== '') {
    candidates.push(pathToFileURL(join(override, 'lib/main.js')).href)
  }
  candidates.push('esbuild')

  for (const specifier of candidates) {
    try {
      return await import(specifier)
    } catch {
      // 换下一个
    }
  }
  throw new Error(
    '找不到 esbuild。设 DEEPAI_ESBUILD=<已安装的 esbuild 目录>，或先装一次：npx esbuild --version',
  )
}

const { build } = await loadEsbuild()

mkdirSync(join(here, 'lib'), { recursive: true })

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

// ── Host 半边 ────────────────────────────────────────────────────────────
await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(here, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // 宿主提供的包保持外部引用：运行时由 DSH 的模块解析提供
  external: ['@deepseek-ai/*'],
  sourcemap: true,
  logLevel: 'info',
})

// ── Client 半边 ──────────────────────────────────────────────────────────
// 套壳是宿主的前端加载约定：window.__ModuleLoader__.load({id, factory})
await build({
  entryPoints: [join(here, 'src/client/index.ts')],
  outfile: join(here, 'lib/client.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome110',
  jsx: 'automatic',
  // react 与宿主 UI 库由浏览器提供
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  sourcemap: true,
  banner: {
    js: `window.__ModuleLoader__.load({
  id: "dsh-deepai-connector",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  },
  footer: {
    js: `
    return module.exports;
  }
});`,
  },
  logLevel: 'info',
})

// package.json 里的 version 是唯一真相，同步进 dsh.plugin.json
const manifestPath = join(here, 'dsh.plugin.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`dsh.plugin.json: version synced to ${pkg.version}`)
}
