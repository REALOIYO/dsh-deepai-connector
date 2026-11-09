/**
 * 上游客户端的行为用例。
 *
 * 用本地假上游验证「发出去的请求长什么样」，不碰真实网络。
 *
 * 重点是请求头：一旦形状错了，上游会静默把请求转到替身后端，
 * 状态码仍是 200，从响应上永远看不出来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { DeepAIClient, retryAfterSeconds } from '../src/adapter/client.ts'
import { modelUrl } from '../src/adapter/protocol.ts'

/** 一条被记下来的请求。 */
interface Recorded {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** 起一个假上游。 */
async function fakeUpstream(
  handler: (req: Recorded, res: ServerResponse) => void,
): Promise<{ base: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      const record: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
      requests.push(record)
      handler(record, res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** 在环境变量指向假上游的前提下跑一段逻辑。 */
async function withUpstream<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DEEPAI_API_ORIGIN
  process.env.DEEPAI_API_ORIGIN = base
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DEEPAI_API_ORIGIN
    else process.env.DEEPAI_API_ORIGIN = previous
  }
}

test('DEEPAI_API_ORIGIN 可覆盖上游地址，非法值退回生产', () => {
  assert.equal(modelUrl('/models', { DEEPAI_API_ORIGIN: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9/deepai_code/models')
  assert.equal(modelUrl('/models', {}), 'https://api.deepai.org/deepai_code/models')
  assert.equal(modelUrl('/models', { DEEPAI_API_ORIGIN: 'ftp://x' }), 'https://api.deepai.org/deepai_code/models')
  assert.equal(modelUrl('/models', { DEEPAI_API_ORIGIN: 'not a url' }), 'https://api.deepai.org/deepai_code/models')
})

test('模型目录：解析 data 数组并保留能力字段', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072, theosPerRequest: '0' },
          { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 64000, theosPerRequest: '15', premier: true },
          { id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'openai-responses', contextWindow: 1048576, maxTokens: 128000, theosPerRequest: '50' },
        ],
      }),
    )
  })

  try {
    const models = await withUpstream(upstream.base, () => {
      const client = new DeepAIClient()
      client.setApiKey('sk-test')
      return client.listModels()
    })

    assert.equal(models.length, 3)
    assert.equal(models[0]?.id, 'glm-5.3-flash')
    assert.deepEqual(models[0]?.input, ['text', 'image'])
    assert.equal(models[0]?.theosPerRequest, '0')
    assert.equal(models[2]?.api, 'openai-responses')
  } finally {
    await upstream.close()
  }
})

test('推理请求的头形状：Api-Key / 车道 / 实例 / 指纹 / node UA', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })

  try {
    const client = new DeepAIClient({ machine: 'f'.repeat(64) })
    client.setApiKey('sk-abc')
    await withUpstream(upstream.base, () => client.listModels())

    const sent = upstream.requests[0]
    assert.ok(sent, '没有发出请求')
    assert.equal(sent.headers['api-key'], 'sk-abc', '鉴权头必须是 Api-Key 而不是 Authorization')
    assert.equal(sent.headers['authorization'], undefined, '不该出现 Authorization 头')
    assert.equal(sent.headers['x-deepai-code-theos'], '4')
    assert.equal(sent.headers['x-deepai-code-instance'], client.instanceId)
    assert.equal(sent.headers['x-deepai-code-machine'], 'f'.repeat(64))
    assert.equal(sent.headers['user-agent'], 'node', 'UA 必须是 node，否则会被换到替身后端')
    assert.equal(sent.headers['content-type'], 'application/json')
    // 不能混进浏览器指纹
    for (const forbidden of ['sec-ch-ua', 'sec-ch-ua-platform', 'referer', 'origin']) {
      assert.equal(sent.headers[forbidden], undefined, `混进了浏览器指纹 ${forbidden}`)
    }
  } finally {
    await upstream.close()
  }
})

test('没有指纹时不发 Machine 头，而不是发空值', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })

  try {
    const client = new DeepAIClient()
    client.setApiKey('sk-abc')
    await withUpstream(upstream.base, () => client.listModels())

    const sent = upstream.requests[0]
    assert.equal(sent?.headers['x-deepai-code-machine'], undefined, '空指纹不该发出该头，空值会被判 machine_required')
  } finally {
    await upstream.close()
  }
})

test('theos：先拉 nonce，下一次才回传 Check-In', async () => {
  const upstream = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    // 每次都给一个新挑战
    const seq = upstream.requests.filter(r => r.url.includes('/theos')).length
    res.end(JSON.stringify({ balance: 200, granted: 200, check_in: { nonce: `nonce-${seq}`, seconds: 600 } }))
    void req
  })

  try {
    const client = new DeepAIClient({ machine: 'a'.repeat(64) })
    client.setApiKey('sk-abc')

    await withUpstream(upstream.base, async () => {
      // 第一次：还没有挑战，不带 Check-In
      await client.theos()
      // 第二次：应回传上一次拿到的 nonce
      await client.theos()
    })

    const calls = upstream.requests.filter(r => r.url.includes('/theos'))
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.headers['x-deepai-code-check-in'], undefined, '首次不该带 Check-In')
    assert.equal(calls[1]?.headers['x-deepai-code-check-in'], 'nonce-1', '第二次必须回传上一次的 nonce')
    // 心跳形态
    assert.match(String(calls[0]?.headers['x-deepai-code-beacon']), /^v=0\.3\.20;up=\d+;pi=[01]$/)
  } finally {
    await upstream.close()
  }
})

test('check_in_refused 后进入静默锁，不再反复打 theos', async () => {
  let theosCount = 0
  const upstream = await fakeUpstream((_req, res) => {
    theosCount += 1
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'check_in_refused', message: 'try again tomorrow' }, check_in: { nonce: 'n', seconds: 600 } }))
  })

  try {
    const client = new DeepAIClient({ machine: 'a'.repeat(64) })
    client.setApiKey('sk-abc')

    await withUpstream(upstream.base, async () => {
      await client.ensureCheckIn() // 第一次会撞，拿到 403
      const afterFirst = theosCount
      // 后面多次调用都应被静默锁挡住
      await client.ensureCheckIn()
      await client.ensureCheckIn()
      await client.ensureCheckIn()
      assert.equal(theosCount, afterFirst, 'check_in_refused 之后不该继续打 /theos')
    })
  } finally {
    await upstream.close()
  }
})

test('ensureCheckIn 在签到失败时不阻塞推理', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(500).end()
  })

  try {
    const client = new DeepAIClient()
    client.setApiKey('sk-abc')
    // 不应抛错
    await withUpstream(upstream.base, () => client.ensureCheckIn())
  } finally {
    await upstream.close()
  }
})

test('车道探测：426 时往下试，命中即返回', async () => {
  const upstream = await fakeUpstream((req, res) => {
    const lane = String(req.headers['x-deepai-code-theos'] ?? '')
    // 只有 5 能过
    if (lane === '5') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    res.writeHead(426, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'lane_version_unsupported' } }))
  })

  try {
    const client = new DeepAIClient()
    const lane = await withUpstream(upstream.base, () => client.probeLane())
    assert.equal(lane, '5')
    assert.equal(client.lane, '5')
  } finally {
    await upstream.close()
  }
})

test('Retry-After 夹到 [1, 30]', async () => {
  assert.equal(retryAfterSeconds('5'), 5)
  assert.equal(retryAfterSeconds('0'), 1)
  assert.equal(retryAfterSeconds('999'), 30)
  assert.equal(retryAfterSeconds(null, 3), 3)
})

test('上游错误被翻译成带 code 的 UpstreamError', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'social_login_required', message: 'use Google or Apple' } }))
  })

  try {
    const client = new DeepAIClient()
    client.setApiKey('sk-abc')
    const error = await withUpstream(upstream.base, () =>
      client.listModels().then(
        () => null,
        (e: unknown) => e as Error & { code?: string; socialLoginRequired?: boolean },
      ),
    )
    assert.ok(error, '应当抛错')
    assert.equal(error.code, 'social_login_required')
    assert.equal(error.socialLoginRequired, true)
    assert.match(error.message, /use Google or Apple/)
  } finally {
    await upstream.close()
  }
})

/** 构造一个最小请求选项。 */
function chatOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'deepai',
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    ...overrides,
  }
}

test('openChat：发出的 body 带 store:false 与 stream:true', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })

  try {
    const client = new DeepAIClient({ machine: 'a'.repeat(64) })
    client.setApiKey('sk-abc')
    await withUpstream(upstream.base, async () => {
      const { buildChatBody } = await import('../src/adapter/body.ts')
      const options = chatOptions() as Parameters<typeof buildChatBody>[0]
      const body = buildChatBody(options, 'glm-5.3-flash')
      const result = await client.openChat(options, 'glm-5.3-flash', body)
      await result.body.cancel()
    })

    const sent = upstream.requests[0]
    assert.ok(sent)
    const payload = JSON.parse(sent.body) as Record<string, unknown>
    assert.equal(payload.store, false, 'store 必须发，漏了会被上游拒')
    assert.equal(payload.stream, true)
    assert.equal(payload.model, 'glm-5.3-flash')
    assert.equal(sent.headers['api-key'], 'sk-abc')
    assert.equal(sent.headers['user-agent'], 'node')
  } finally {
    await upstream.close()
  }
})

test('openChat：命中 400 形状拒绝后自动重排重试一次', async () => {
  let attempts = 0
  const bodies: string[] = []
  const upstream = await fakeUpstream((_req, res) => {
    attempts += 1
    bodies.push(_req.body)
    if (attempts === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'invalid_request_error', message: 'This request is not one DeepAI Code sends.' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })

  try {
    const client = new DeepAIClient()
    client.setApiKey('sk-abc')
    await withUpstream(upstream.base, async () => {
      const { buildChatBody } = await import('../src/adapter/body.ts')
      const options = chatOptions() as Parameters<typeof buildChatBody>[0]
      // 故意塞一个白名单外字段，模拟「形状不对」
      const body = { ...buildChatBody(options, 'glm-5.3-flash'), user: 'bad-field' }
      const result = await client.openChat(options, 'glm-5.3-flash', body)
      await result.body.cancel()
    })

    assert.equal(attempts, 2, '应当重试一次')
    const retried = JSON.parse(bodies[1] ?? '{}') as Record<string, unknown>
    assert.equal('user' in retried, false, '重排后应丢掉白名单外字段')
    assert.equal(retried.store, false, 're 排后仍要有 store')
  } finally {
    await upstream.close()
  }
})

test('openChat：非形状类 400 不重试', async () => {
  let attempts = 0
  const upstream = await fakeUpstream((_req, res) => {
    attempts += 1
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'invalid_request_error', message: 'bad model' } }))
  })

  try {
    const client = new DeepAIClient()
    client.setApiKey('sk-abc')
    const error = await withUpstream(upstream.base, async () => {
      const { buildChatBody } = await import('../src/adapter/body.ts')
      const options = chatOptions() as Parameters<typeof buildChatBody>[0]
      const body = buildChatBody(options, 'm')
      return client.openChat(options, 'm', body).then(
        () => null,
        (e: unknown) => e as Error,
      )
    })

    assert.ok(error)
    assert.equal(attempts, 1, '非形状类 400 不该重试')
  } finally {
    await upstream.close()
  }
})

test('completeChat：把 SSE 拼成完整消息', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning: '想一下' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '你好' } }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '世界' }, finish_reason: 'stop' }] })}`,
        '',
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'),
    )
  })

  try {
    const client = new DeepAIClient()
    client.setApiKey('sk-abc')
    const result = await withUpstream(upstream.base, async () => {
      const { buildChatBody } = await import('../src/adapter/body.ts')
      const options = chatOptions() as Parameters<typeof buildChatBody>[0]
      return client.completeChat(options, 'm', buildChatBody(options, 'm'))
    })

    assert.equal(result.text, '你好世界')
    assert.equal(result.reasoning, '想一下')
    assert.equal(result.finish, 'stop')
    assert.equal(result.usage?.inputTokens, 10)
  } finally {
    await upstream.close()
  }
})
