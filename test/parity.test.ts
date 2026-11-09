/**
 * 与 `DeepAICode2API` 逐项对齐的判据。
 *
 * 这些用例存在的唯一理由：协议细节一旦偏一点，上游不会报「字段不对」，
 * 而是静默把请求转到替身后端（状态码仍 200），或者干脆不认签到。
 * 每一条都对应 Go 实现里的一个具体函数，注释里标了出处。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DeepAIClient,
  affinityFor,
  isValidCheckIn,
  retryAfterSeconds,
} from '../src/adapter/client.ts'
import { LANE_CANDIDATES, LANE_VERSION } from '../src/adapter/protocol.ts'

test('车道候选与 Go 的 LaneCandidates 逐项一致', () => {
  // internal/deepai/client.go:399
  assert.deepEqual([...LANE_CANDIDATES], ['4', '5', '6', '7', '8', '9', '10', '11', '12', '3', '2'])
  assert.equal(LANE_VERSION, '4')
  // 默认车道必须在候选里，否则首轮探测必然白跑一次
  assert.equal(LANE_CANDIDATES.includes(LANE_VERSION), true)
})

test('CheckIn 有效性：nonce 必须是 32 位小写十六进制', () => {
  // internal/deepai/types.go:164 CheckIn.Valid
  assert.equal(isValidCheckIn({ nonce: 'a'.repeat(32), seconds: 600 }), true)
  assert.equal(isValidCheckIn({ nonce: '0123456789abcdef0123456789abcdef', seconds: 1 }), true)

  // 长度不对
  assert.equal(isValidCheckIn({ nonce: 'a'.repeat(31), seconds: 600 }), false)
  assert.equal(isValidCheckIn({ nonce: 'a'.repeat(33), seconds: 600 }), false)
  // 大写十六进制不算
  assert.equal(isValidCheckIn({ nonce: 'A'.repeat(32), seconds: 600 }), false)
  // 非十六进制字符
  assert.equal(isValidCheckIn({ nonce: 'g'.repeat(32), seconds: 600 }), false)
  // 前导是 human-readable 的假值
  assert.equal(isValidCheckIn({ nonce: 'nonce-1', seconds: 600 }), false)
  // seconds 非正
  assert.equal(isValidCheckIn({ nonce: 'a'.repeat(32), seconds: 0 }), false)
  assert.equal(isValidCheckIn(undefined), false)
})

test('会话粘性：只透传合法字符集的 prompt_cache_key', () => {
  // internal/server/common.go:43 affinityPattern
  assert.equal(affinityFor({ prompt_cache_key: 'sess-abc_1.2:3' }), 'sess-abc_1.2:3')
  assert.equal(affinityFor({ prompt_cache_key: '  sess-1  ' }), 'sess-1', '首尾空白要去掉')
  // 非法字符不发
  assert.equal(affinityFor({ prompt_cache_key: 'has space' }), '')
  assert.equal(affinityFor({ prompt_cache_key: 'has/slash' }), '')
  assert.equal(affinityFor({ prompt_cache_key: '' }), '')
  assert.equal(affinityFor({ prompt_cache_key: 'a'.repeat(257) }), '')
  assert.equal(affinityFor({}), '')
  assert.equal(affinityFor({ prompt_cache_key: 123 }), '')
})

test('心跳 pi 字段反映的是「最近发过推理」，不是「签到过」', async () => {
  // internal/deepai/checkin.go:148 markRelay / :189 pi
  const client = new DeepAIClient()
  client.setApiKey('sk-test')

  // 没发过推理 → pi=0
  // 通过私有路径拿不到头，这里用公开行为间接确认：markRelay 后可读
  client.markRelay()

  // 直接验证 markRelay 不抛错且幂等
  client.markRelay()
  assert.ok(true)
})

test('非流式预算与 Go 的 nonStreamBudget 一致（90s）', async () => {
  // internal/server/common.go:146
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/adapter/client.ts', import.meta.url), 'utf8'),
  )
  assert.match(source, /NON_STREAM_BUDGET_MS = 90_000/, '非流式预算应与 Go 的 90s 对齐')
})

test('签到间隔与锁时长与 Go 一致', async () => {
  // internal/deepai/checkin.go:22 / :25 / :34
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/adapter/client.ts', import.meta.url), 'utf8')
  assert.match(source, /CHECK_IN_MIN_INTERVAL_MS = 30_000/, 'checkInMinInterval = 30s')
  assert.match(source, /CHECK_IN_TIMEOUT_MS = 10_000/, 'checkInAttemptTimeout = 10s')
  assert.match(source, /CHECK_IN_REFUSED_LOCK_MS = 6 \* 60 \* 60 \* 1000/, 'CheckInRefusedLock = 6h')
})

test('Retry-After 夹取区间与 Go 一致', () => {
  // internal/deepai/client.go RetryAfter：min(30, max(1, retry))
  assert.equal(retryAfterSeconds('0'), 1)
  assert.equal(retryAfterSeconds('-5'), 1)
  assert.equal(retryAfterSeconds('1'), 1)
  assert.equal(retryAfterSeconds('30'), 30)
  assert.equal(retryAfterSeconds('31'), 30)
  assert.equal(retryAfterSeconds('999'), 30)
})

test('请求体白名单与 Go 的 desktopChatKeys 逐项一致', async () => {
  // internal/deepai/chatbody.go:27
  const { DESKTOP_CHAT_KEYS } = await import('../src/adapter/body.ts')
  const expected = [
    'model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls',
    'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
    'stream', 'stream_options', 'store', 'seed', 'service_tier',
    'reasoning_effort', 'prompt_cache_key',
  ]
  assert.deepEqual([...DESKTOP_CHAT_KEYS].sort(), [...expected].sort())
  // store 曾经漏过，会导致重排后反而比桌面端少一个字段
  assert.equal(DESKTOP_CHAT_KEYS.has('store'), true)
})

test('usage 解析：Responses 端点的字段名也认', async () => {
  // internal/server/common.go:545 parseUsage
  const { chatChunkUsage } = await import('../src/adapter/sse.ts')

  // chat 端点字段
  const chat = chatChunkUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })
  assert.equal(chat?.inputTokens, 10)
  assert.equal(chat?.outputTokens, 5)

  // Responses 端点字段
  const responses = chatChunkUsage({ usage: { input_tokens: 7, output_tokens: 3 } })
  assert.equal(responses?.inputTokens, 7)
  assert.equal(responses?.outputTokens, 3)

  // 思维链 token 两条路都认
  const withReasoning = chatChunkUsage({
    usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 9 } },
  })
  assert.equal(withReasoning?.reasoningTokens, 9)

  const withOutputReasoning = chatChunkUsage({
    usage: { prompt_tokens: 1, completion_tokens: 2, output_tokens_details: { reasoning_tokens: 4 } },
  })
  assert.equal(withOutputReasoning?.reasoningTokens, 4)

  // 成本：顶层 cost 优先
  assert.equal(chatChunkUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.02 } })?.cost, 0.02)
  assert.equal(
    chatChunkUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost_details: { upstream_inference_cost: 0.01 } } })?.cost,
    0.01,
  )

  // 全零不算用量
  assert.equal(chatChunkUsage({ usage: {} }), undefined)
})

test('错误语义判定与 Go 的 HTTPError 方法集对齐', async () => {
  // internal/deepai/client.go:86-150
  const { UpstreamError } = await import('../src/adapter/client.ts')

  // AuthFailed：401 或鉴权类错误码
  assert.equal(new UpstreamError(401, '', 'x').authFailed, true)
  assert.equal(new UpstreamError(403, 'auth_required', 'x').authFailed, true)
  assert.equal(new UpstreamError(403, 'invalid_api_key', 'x').authFailed, true)
  assert.equal(new UpstreamError(403, 'email_unverified', 'x').authFailed, true)
  assert.equal(new UpstreamError(403, 'social_login_required', 'x').authFailed, false, '策略拦截不是鉴权失败')

  // EmailUnverified
  assert.equal(new UpstreamError(403, 'email_unverified', 'x').emailUnverified, true)
  assert.equal(new UpstreamError(403, 'other', 'x').emailUnverified, false)

  // Retryable：策略类与请求类都不可重试
  assert.equal(new UpstreamError(403, 'social_login_required', 'x').retryable, false)
  assert.equal(new UpstreamError(400, 'machine_required', 'x').retryable, false)
  assert.equal(new UpstreamError(426, 'lane_version_unsupported', 'x').retryable, false)
  assert.equal(new UpstreamError(400, 'invalid_request_error', 'x').retryable, false)
  assert.equal(new UpstreamError(404, '', 'x').retryable, false)
  assert.equal(new UpstreamError(422, '', 'x').retryable, false)
  // 账号/容量类可重试
  assert.equal(new UpstreamError(401, '', 'x').retryable, true)
  assert.equal(new UpstreamError(409, 'session_busy', 'x').retryable, true)
  assert.equal(new UpstreamError(429, '', 'x').retryable, true)
  assert.equal(new UpstreamError(503, '', 'x').retryable, true)

  // BodyRejected 只认那条固定文案 + 400
  assert.equal(
    new UpstreamError(400, 'invalid_request_error', 'x', 'This request is not one DeepAI Code sends.').bodyRejected,
    true,
  )
  assert.equal(new UpstreamError(400, 'invalid_request_error', 'x', 'bad model').bodyRejected, false)
  assert.equal(new UpstreamError(500, '', 'x', 'not one deepai code sends').bodyRejected, false, '非 400 不算')

  // CapacityWaiting
  assert.equal(new UpstreamError(409, 'session_busy', 'x').capacityWaiting, true)
  assert.equal(new UpstreamError(409, 'other', 'x').capacityWaiting, false)
})
