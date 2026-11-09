/**
 * 端到端联调用例：验证 `lib/` 产物从加载到出流的完整路径。
 *
 * 与单测的区别：这里不吃 `src/`，走的是构建产物；也不打桩适配器，
 * 而是像宿主那样调 `apply()` → `registerAdapter` → `prepareCall` → `stream`。
 *
 * 假上游复刻上游的真实形状（含签到挑战、SSE 帧、usage 尾帧），
 * 用来确认「整条链路能出字」而不是只确认「函数能返回」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一条被记下来的请求。 */
interface Recorded {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** 假上游：签到返回挑战，chat 返回一段 SSE。 */
async function fakeUpstream(): Promise<{ base: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res: ServerResponse) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const url = req.url ?? ''

      if (url.includes('/theos')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ balance: 200, granted: 200, check_in: { nonce: 'n-1', seconds: 600 } }))
        return
      }

      if (url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 131072, theosPerRequest: '0' },
              { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 64000, theosPerRequest: '15' },
            ],
          }),
        )
        return
      }

      if (url.includes('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const frames = [
          { choices: [{ index: 0, delta: { reasoning: '想一下' } }] },
          { choices: [{ index: 0, delta: { content: '你好' } }] },
          { choices: [{ index: 0, delta: { content: '，世界' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } },
        ]
        res.end(`${frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`)
        return
      }

      res.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('端到端：从产物加载到出流', async () => {
  const upstream = await fakeUpstream()
  const dataDir = await mkdtemp(join(tmpdir(), 'deepai-e2e-'))
  const previous = process.env.DEEPAI_API_ORIGIN
  process.env.DEEPAI_API_ORIGIN = upstream.base

  try {
    // 预置一份凭据，跳过浏览器授权（那条路径的单测在 client 里）
    await writeFile(
      join(dataDir, 'account.json'),
      JSON.stringify({ apiKey: 'sk-e2e', username: 'e2e-user', isPro: false, obtainedAt: '2026-11-09T00:00:00.000Z' }),
      { mode: 0o600 },
    )

    // 从构建产物加载，和宿主走同一条路
    const mod = await import('../lib/index.js')
    const registered: Array<{ ids: string[]; adapter: unknown }> = []
    const logs: string[] = []

    const ctx = {
      logger: {
        info: (...a: unknown[]) => logs.push(String(a[0])),
        warn: (...a: unknown[]) => logs.push(`W ${String(a[0])}`),
        error: (...a: unknown[]) => logs.push(`E ${String(a[0])}`),
      },
      llm: {
        registerAdapter: (ids: string[], adapter: unknown) => {
          registered.push({ ids, adapter })
          return () => {}
        },
      },
    }

    ;(mod as { apply(ctx: unknown, config: unknown): unknown }).apply(ctx, { dataDir })

    assert.equal(registered.length, 1, '应当注册了一个 provider')
    const adapter = registered[0]?.adapter as {
      listModels(p: string): Array<{ id: string }>
      resolveModel(p: string, m: string): { context: { contextWindow: number } }
      prepareCall(p: string, m: string): Promise<{ model: unknown; stream(o: unknown): AsyncGenerator<unknown> }>
      refreshModels(force?: boolean): Promise<void>
    }

    // 目录拉一次（走假上游，验证真解析）
    await adapter.refreshModels(true)
    const models = adapter.listModels('deepai')
    assert.deepEqual(
      models.map(m => m.id),
      ['glm-5.3-flash', 'claude-opus-5-5'],
      '目录应来自上游实测',
    )
    assert.equal(adapter.resolveModel('deepai', 'claude-opus-5-5').context.contextWindow, 1_000_000)

    // 一次完整推理
    const prepared = await adapter.prepareCall('deepai', 'glm-5.3-flash')
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of prepared.stream({
      provider: 'deepai',
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: '打个招呼' }] }],
    })) {
      chunks.push(chunk as Record<string, unknown>)
    }

    // 正文与思考都出来了
    const text = chunks
      .filter(c => c.type === 'text-delta')
      .map(c => String(c.text))
      .join('')
    assert.equal(text, '你好，世界')

    const reasoningEnd = chunks.find(c => c.type === 'block-end' && (c.block as { type: string }).type === 'reasoning')
    assert.equal((reasoningEnd?.block as { text: string }).text, '想一下')

    const usage = chunks.find(c => c.type === 'usage')
    assert.deepEqual(usage, { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } })

    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })

    // 块必须成对
    const opened = new Set<number>()
    for (const chunk of chunks) {
      if (chunk.type === 'block-start') opened.add(Number(chunk.index))
      if (chunk.type === 'block-end') opened.delete(Number(chunk.index))
    }
    assert.deepEqual([...opened], [], '有块没有收口')

    // 上游侧：签到 + 目录 + chat 都打到了，且 chat 带对了头
    const chatCall = upstream.requests.find(r => r.url.includes('/chat/completions'))
    assert.ok(chatCall, '应当发出过 chat 请求')
    assert.equal(chatCall.headers['api-key'], 'sk-e2e')
    assert.equal(chatCall.headers['user-agent'], 'node')
    const payload = JSON.parse(chatCall.body) as Record<string, unknown>
    assert.equal(payload.store, false)
    assert.equal(payload.stream, true)
    assert.equal(payload.model, 'glm-5.3-flash')
  } finally {
    if (previous === undefined) delete process.env.DEEPAI_API_ORIGIN
    else process.env.DEEPAI_API_ORIGIN = previous
    await upstream.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
