/**
 * 协议头与机器指纹。
 *
 * 请求头形状是上游判定「是不是桌面端」的主要判据，错一个就会被换到
 * 替身后端（响应里 `provider` 变成 `"DeepAI"`），而响应状态码仍是 200，
 * 光看状态码永远发现不了。所以这里逐字段钉死。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DESKTOP_INFERENCE_HEADERS,
  LANE_VERSION,
  PATH_CHAT,
  modelUrl,
} from '../src/adapter/protocol.ts'
import {
  detectMachineFingerprint,
  isPlaceholderUuid,
  machineFingerprint,
} from '../src/adapter/machine.ts'
import { DeepAIClient, retryAfterSeconds, UpstreamError } from '../src/adapter/client.ts'

test('推理头逐字段对齐 Node fetch', () => {
  assert.deepEqual(DESKTOP_INFERENCE_HEADERS, {
    'User-Agent': 'node',
    Accept: '*/*',
    'Accept-Language': '*',
    'Sec-Fetch-Mode': 'cors',
  })
})

test('推理头里不能出现浏览器指纹', () => {
  const keys = Object.keys(DESKTOP_INFERENCE_HEADERS).map(k => k.toLowerCase())
  for (const forbidden of ['sec-ch-ua', 'sec-ch-ua-platform', 'referer', 'origin']) {
    assert.equal(keys.includes(forbidden), false, `推理头混进了浏览器指纹 ${forbidden}`)
  }
  // UA 必须是 node，不能是 Chrome 或 DeepAI-Code
  assert.equal(DESKTOP_INFERENCE_HEADERS['User-Agent'], 'node')
})

test('端点地址拼接', () => {
  assert.equal(modelUrl(PATH_CHAT), 'https://api.deepai.org/deepai_code/chat/completions')
})

test('车道版本是 4', () => {
  assert.equal(LANE_VERSION, '4')
})

test('机器指纹是 sha256 小写十六进制', () => {
  const fingerprint = machineFingerprint('ABC-123')
  assert.equal(fingerprint.length, 64)
  assert.match(fingerprint, /^[0-9a-f]{64}$/)
  // 大小写与首尾空白不影响结果
  assert.equal(machineFingerprint('  abc-123  '), fingerprint)
})

test('空指纹返回空串而不是空值的哈希', () => {
  assert.equal(machineFingerprint(''), '')
  assert.equal(machineFingerprint('   '), '')
})

test('固件占位 UUID 被识别', () => {
  assert.equal(isPlaceholderUuid('00000000-0000-0000-0000-000000000000'), true)
  assert.equal(isPlaceholderUuid('03000200-0400-0500-0006-000700080009'), true)
  assert.equal(isPlaceholderUuid('4c4c4544-0044-3410-8051-b4c04f4d3332'), false)
})

test('DEEPAI_MACHINE_ID 覆盖走同一个哈希', async () => {
  const overridden = await detectMachineFingerprint({ DEEPAI_MACHINE_ID: 'test-uuid-1234' })
  assert.equal(overridden, machineFingerprint('test-uuid-1234'))
})

test('Retry-After 夹到 [1, 30]', () => {
  assert.equal(retryAfterSeconds('5'), 5)
  assert.equal(retryAfterSeconds('0'), 1)
  assert.equal(retryAfterSeconds('-5'), 1)
  assert.equal(retryAfterSeconds('999'), 30)
  assert.equal(retryAfterSeconds(null, 3), 3)
  assert.equal(retryAfterSeconds('abc', 7), 7)
})

test('客户端初始不带 Key，实例号是 32 位 hex', () => {
  const client = new DeepAIClient({ machine: 'deadbeef' })
  assert.equal(client.hasKey, false)
  assert.match(client.instanceId, /^[0-9a-f]{32}$/)
  assert.equal(client.machine, 'deadbeef')
  assert.equal(client.lane, LANE_VERSION)
})

test('setApiKey 去空白', () => {
  const client = new DeepAIClient()
  client.setApiKey('  sk-abc  ')
  assert.equal(client.hasKey, true)
})

test('setMachine 可后置补设', () => {
  const client = new DeepAIClient()
  assert.equal(client.machine, '')
  client.setMachine('  abc123  ')
  assert.equal(client.machine, 'abc123')
})

test('错误码语义判定', () => {
  assert.equal(new UpstreamError(403, 'social_login_required', 'x').socialLoginRequired, true)
  assert.equal(new UpstreamError(400, 'machine_required', 'x').machineRequired, true)
  assert.equal(new UpstreamError(426, 'lane_version_unsupported', 'x').laneUnsupported, true)
  assert.equal(new UpstreamError(409, 'session_busy', 'x').capacityWaiting, true)
  assert.equal(new UpstreamError(403, 'check_in_refused', 'x').checkInRefused, true)
  assert.equal(new UpstreamError(403, 'network_bound', 'x').networkBound, true)
  // 普通 403 不是策略拦截
  assert.equal(new UpstreamError(403, 'forbidden', 'x').socialLoginRequired, false)
})
