/**
 * 授权 URL 的构造。
 *
 * 这一条曾经错得很隐蔽：`PATH_SIGN_IN` 是**相对 `/deepai_code`** 的路径，
 * 直接用 `${origin}${PATH_SIGN_IN}` 拼会得到 `api.deepai.org/desktop_auth/`，
 * 上游回 404，而用户看到的就是"打开登录链接是 404"。
 *
 * 顺带钉住 state 的格式：上游对短 state 直接回
 * `400 Invalid desktop sign-in request.`（实测 8 位被拒、64 位通过）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startSignIn } from '../src/adapter/auth.ts'
import { MODEL_BASE, ORIGIN, PATH_SIGN_IN, modelUrl } from '../src/adapter/protocol.ts'

test('授权路径是相对 /deepai_code 的，不能直接拼 origin', () => {
  // 真实上游只认带前缀的路径
  assert.equal(`${ORIGIN}${MODEL_BASE}${PATH_SIGN_IN}`, 'https://api.deepai.org/deepai_code/desktop_auth/')
  // 少了前缀就是那个 404 的地址，单独断言一下，防止有人"简化"回 `${origin}${PATH_SIGN_IN}`
  assert.notEqual(`${ORIGIN}${PATH_SIGN_IN}`, `${ORIGIN}${MODEL_BASE}${PATH_SIGN_IN}`)
  assert.equal(modelUrl(PATH_SIGN_IN), `${ORIGIN}${MODEL_BASE}${PATH_SIGN_IN}`)
})

test('startSignIn 生成的 URL 带 /deepai_code 前缀', async () => {
  const session = startSignIn()
  try {
    const url = await session.ready()
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://api.deepai.org')
    assert.equal(parsed.pathname, '/deepai_code/desktop_auth/', '缺了 /deepai_code 前缀上游会 404')
  } finally {
    session.cancel()
  }
})

test('state 是 64 位十六进制（短值会被上游回 400）', async () => {
  const session = startSignIn()
  try {
    const parsed = new URL(await session.ready())
    const state = parsed.searchParams.get('state') ?? ''
    assert.equal(state.length, 64, 'state 必须是 64 位，否则上游回 Invalid desktop sign-in request')
    assert.match(state, /^[0-9a-f]{64}$/)
  } finally {
    session.cancel()
  }
})

test('port 是真实的回环监听端口', async () => {
  const session = startSignIn()
  try {
    const parsed = new URL(await session.ready())
    const port = Number(parsed.searchParams.get('port'))
    assert.equal(Number.isInteger(port), true)
    assert.equal(port > 0 && port < 65536, true)

    // 端口真的在监听：打一下回调端点，应为 400（state 不匹配）
    const response = await fetch(`http://127.0.0.1:${port}/auth-callback?code=x&state=wrong`)
    assert.equal(response.status, 400)
  } finally {
    session.cancel()
  }
})

test('cancel 不产生未处理的 Promise rejection', async () => {
  const session = startSignIn()
  await session.ready()
  session.cancel()
  // 没人 await wait()，若 rejection 没被吞掉，node --test 会把它记成失败
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(true)
})

test('DEEPAI_API_ORIGIN 覆盖同样带前缀', async () => {
  const session = startSignIn({ DEEPAI_API_ORIGIN: 'http://127.0.0.1:9/' })
  try {
    const parsed = new URL(await session.ready())
    assert.equal(parsed.origin, 'http://127.0.0.1:9')
    assert.equal(parsed.pathname, '/deepai_code/desktop_auth/')
  } finally {
    session.cancel()
  }
})
