/**
 * 构建脚本：无操作，只做一次语法自检。
 *
 * 本插件**不做转译**：`main` 直接指向 `src/index.ts`，由 Node 自己的
 * type stripping 处理（Node 22.18+ / 24 默认开启）。这样做的好处是
 * 产物与源码逐字节一致——宿主里跑的就是仓库里那份，排障不用对照编译结果。
 *
 * 之前用正则做「类型擦除」的后备路径是错的：正则去不掉 `import type`，
 * 还会误删解构与 case 分支。宁可要求 Node 新版，也不留一个会静默产出
 * 坏代码的构建。
 *
 * @module build.mjs
 */

import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = join(root, 'src')

/** 递归列出所有 .ts 文件（排除 .d.ts）。 */
async function listTs(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listTs(full)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const [major] = process.versions.node.split('.').map(Number)
if (major < 22) {
  console.error(`dsh-deepai-connector: 需要 Node >= 22.18（当前 ${process.versions.node}）`)
  process.exit(1)
}

const files = await listTs(srcDir)
let failed = 0
for (const file of files) {
  // --experimental-strip-types 在 22.18+ / 24 是默认行为，这里只做语法检查
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    console.error(`${relative(root, file)}: ${(result.stderr ?? '').trim().split('\n')[0]}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed to parse`)
  process.exit(1)
}

console.log(`checked ${files.length} file(s) — no build step needed (.ts runs natively)`)
