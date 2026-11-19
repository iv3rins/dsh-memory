import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { deriveCategories, resolveCategories } from '../../core/category.js'
import { normalizeConfig } from '../../core/config.js'
import { estimateTokens } from '../../core/context.js'
import { ATOMS_FILE, normalizeAtom } from '../../core/memory.js'
import { writeLifecycle } from '../../core/lifecycle.js'
import { localRouterReadiness } from '../../lib/local-router.js'
import { buildTools } from '../../lib/tools.js'

const makeAtom = (kind, text, category_id) => normalizeAtom({ kind, text, category_id, weight: 5, confidence: 1 })
const wrong = makeAtom('fact', 'The gateway ticket uses an orange template for the gateway request.', ['dom:ui'])
const right = makeAtom('decision', 'Rotate the signing credential after a certificate rollover.', ['dom:security'])
const rule = makeAtom('constraint', 'Never persist plaintext credentials.', ['dom:constraint'])
const args = { task_summary: 'gateway ticket gateway request', categories: ['dom:ui'], max_memory_tokens: 200 }
const feedback = 'Project files are using a certificate rollover signing credential.'
const accept = (...ids) => ({ action: 'accept', hot_memory_ids: ids })
const ids = (result) => result.data.selected.map((entry) => entry.id)
const offered = (result) => result.data.offered.map((entry) => entry.id)

function project(t, overrides = {}, atoms = [wrong, right, rule], { expectLegacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pm-local-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, ATOMS_FILE)
  const raw = atoms.map((atom) => JSON.stringify(atom)).join('\n') + '\n'
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, raw)
  const settings = normalizeConfig({ routerTier: 'always', recallLimit: 2, metricsEnabled: false, ...overrides })
  let legacyCalls = 0
  const tool = buildTools({
    settings,
    readApiKey: async () => 'fixture-key',
    resolveContext: async () => ({ ok: true, root, project: { projectId: 'test' } }),
    createDelegate: () => {
      legacyCalls += 1
      return expectLegacy ? async () => JSON.stringify({ hot_memory_ids: [wrong.id] }) : null
    },
  }).find((entry) => entry.name === 'memory_intent')
  const agent = {}
  return {
    root,
    call: (options = {}, exec = {}) => tool.execute(
      options.proposal_id === undefined ? { ...args, ...options } : options,
      { agent, ...exec },
    ),
    legacyCalls: () => legacyCalls,
    assertUnchanged: () => assert.equal(readFileSync(file, 'utf8'), raw),
  }
}

async function localServer(t, respond, { wrap = (reply) => {
  const content = typeof reply === 'string' ? reply : JSON.stringify(reply)
  return { choices: [{ message: { content } }] }
} } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      requests.push({ path: request.url, method: request.method, headers: request.headers, ...JSON.parse(raw) })
      const reply = await respond(requests.length, response, request)
      if (reply === undefined || response.destroyed) return
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(wrap(reply)))
    } catch (err) {
      response.destroy(err)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  return { requests, baseUrl, config: { localRouterEndpoint: `${baseUrl}/chat/completions`, localRouterModel: 'fixture-local' } }
}

const prompt = (entry) => entry.messages.map((message) => message.content).join('\n')
const hasRow = (text, atom) => text.includes(`${atom.id} [${atom.kind}]`)

for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
  test(`routing model configured in the profile speaks ${protocol}`, async (t) => {
    let wrap
    if (protocol === 'openai-responses') {
      wrap = (reply) => {
        const text = JSON.stringify(reply)
        return { output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: text.slice(0, 12) }] },
          { type: 'message', content: [{ type: 'output_text', text: text.slice(12) }] },
        ] }
      }
    } else if (protocol === 'anthropic-messages') {
      wrap = (reply) => {
        const text = JSON.stringify(reply)
        return { content: [
          { type: 'thinking', text: 'not a reply' },
          { type: 'text', text: text.slice(0, 12) },
          { type: 'text', text: text.slice(12) },
        ] }
      }
    }
    const local = await localServer(t, () => accept(wrong.id), { ...(wrap ? { wrap } : {}) })
    const fixture = project(t, {
      routerBaseUrl: local.baseUrl,
      localRouterModel: 'fixture-local',
      routerProtocol: protocol,
    })
    const result = await fixture.call()
    assert.equal(result.data.status, 'proposal')
    assert.equal(result.data.route, 'local')
    assert.deepEqual(offered(result), [wrong.id])
    assert.deepEqual(ids(result), [])
    assert.ok(!result.summary.includes(wrong.text))
    const approved = await fixture.call({ proposal_id: result.data.proposal_id, accept_memory_ids: [wrong.id] })
    assert.equal(approved.data.status, 'delivered')
    assert.deepEqual(ids(approved), [wrong.id])
    assert.ok(approved.summary.includes(wrong.text))
    assert.equal(local.requests.length, 1)
    const request = local.requests[0]
    const endpoint = protocol === 'openai-chat-completions'
      ? '/v1/chat/completions'
      : protocol === 'openai-responses' ? '/v1/responses' : '/v1/messages'
    assert.equal(request.path, endpoint)
    assert.equal(request.method, 'POST')
    assert.equal(request.model, 'fixture-local')
    if (protocol === 'openai-chat-completions') {
      assert.equal(request.headers.authorization, 'Bearer fixture-key')
      assert.deepEqual(request.messages, [{ role: 'user', content: request.messages[0].content }])
      assert.equal(request.stream, false)
    } else if (protocol === 'openai-responses') {
      assert.equal(request.headers.authorization, 'Bearer fixture-key')
      assert.equal(typeof request.input, 'string')
      assert.equal(request.stream, false)
      assert.equal('messages' in request, false)
    } else {
      assert.equal(request.headers['x-api-key'], 'fixture-key')
      assert.equal(request.headers['anthropic-version'], '2023-06-01')
      assert.equal(request.max_tokens, 4096)
      assert.deepEqual(request.messages, [{ role: 'user', content: request.messages[0].content }])
      assert.equal('stream' in request, false)
    }
  })
}

test('without a model configuration, explicit intent still retrieves deterministically', async (t) => {
  const fixture = project(t)
  const result = await fixture.call()
  assert.equal(result.data.status, 'delivered')
  assert.equal(result.data.route, 'deterministic')
  assert.ok(ids(result).includes(wrong.id))
})

test('execution feedback re-queries clusters and requires approval of the new proposal', async (t) => {
  const local = await localServer(t, (round) => round === 1 ? accept(wrong.id) : accept(right.id))
  const fixture = project(t, { ...local.config, crossCategorySupplement: false }, [wrong, ...Array.from({ length: 9 }, (_, i) =>
    makeAtom('fact', `Gateway ticket gateway request template variant ${i}.`, ['dom:ui'])), right, rule])
  const first = await fixture.call()
  assert.deepEqual(offered(first), [wrong.id])
  const next = await fixture.call({ proposal_id: first.data.proposal_id, feedback })
  assert.equal(next.data.status, 'proposal')
  assert.deepEqual(offered(next), [right.id])
  assert.ok(!next.summary.includes(wrong.text))
  assert.ok(!next.summary.includes(right.text))
  const accepted = await fixture.call({ proposal_id: next.data.proposal_id, accept_memory_ids: [right.id] })
  assert.equal(accepted.data.status, 'delivered')
  assert.deepEqual(ids(accepted), [right.id])
  assert.ok(accepted.summary.includes(right.text))
  assert.ok(!accepted.summary.includes(wrong.text))
  assert.equal(fixture.legacyCalls(), 0)
  assert.equal(local.requests.length, 2)
  assert.equal(local.requests[0].path, '/v1/chat/completions')
  assert.equal(local.requests[0].method, 'POST')
  assert.equal(local.requests[0].model, 'fixture-local')
  assert.ok(hasRow(prompt(local.requests[0]), wrong))
  assert.ok(!hasRow(prompt(local.requests[0]), right))
  assert.ok(hasRow(prompt(local.requests[1]), right))
  assert.ok(!hasRow(prompt(local.requests[1]), wrong))
  assert.ok(prompt(local.requests[1]).includes(args.task_summary))
  assert.ok(prompt(local.requests[1]).includes(feedback))
  fixture.assertUnchanged()
})

test('a long original task leaves room for candidates at the minimum digest budget', async (t) => {
  const local = await localServer(t, () => accept(wrong.id))
  const fixture = project(t, { ...local.config, routerDigestBudget: 200 })
  const result = await fixture.call({ task_summary: `${args.task_summary} ${'additional context '.repeat(30)}` })
  assert.deepEqual(offered(result), [wrong.id])
  assert.equal(local.requests.length, 1)
  const text = prompt(local.requests[0])
  assert.ok(hasRow(text, wrong))
  assert.ok(text.includes(args.task_summary))
  assert.ok(estimateTokens(text) <= 200)
})

test('failed refinement exposes no memory and a fresh lookup may reconsider a declined atom', async (t) => {
  const local = await localServer(t, (round) => round === 2 ? 'not JSON' : accept(wrong.id))
  const fixture = project(t, { ...local.config, routerProvider: 'legacy', routerModel: 'legacy' }, undefined, { expectLegacy: true })
  const first = await fixture.call()
  const failed = await fixture.call({ proposal_id: first.data.proposal_id, feedback })
  assert.equal(failed.data.status, 'none')
  assert.deepEqual(ids(failed), [])
  assert.equal(failed.data.router.ok, false)
  assert.equal(local.requests.length, 2)
  assert.ok(!failed.summary.includes(right.text))
  assert.ok(!failed.summary.includes(wrong.text))
  assert.ok(!failed.summary.includes(rule.text))
  const stale = await fixture.call({ proposal_id: first.data.proposal_id, accept_memory_ids: [wrong.id] })
  assert.equal(stale.ok, false, 'the old proposal was consumed')
  assert.deepEqual(offered(await fixture.call()), [wrong.id])
  assert.equal(fixture.legacyCalls(), 0)
  fixture.assertUnchanged()
})

test('routing model can return none and only the execution model may request another search', async (t) => {
  const local = await localServer(t, (round) => round === 1
    ? { action: 'none' }
    : { action: 'retry', reject_memory_ids: [wrong.id], search: { query: feedback } })
  const fixture = project(t, local.config)
  const none = await fixture.call()
  assert.equal(none.data.status, 'none')
  assert.equal(none.data.router.ok, true)
  assert.deepEqual(ids(none), [])
  assert.equal(local.requests.length, 1)
  const retry = await fixture.call()
  assert.equal(retry.data.status, 'none')
  assert.equal(retry.data.router.ok, false)
  assert.deepEqual(ids(retry), [])
  assert.equal(local.requests.length, 2)
})

test('local mode rejects incomplete or non-loopback configuration and never falls through to DSH', async (t) => {
  for (const url of ['http://localhost:8080/v1/chat/completions', 'http://127.1/v1/chat/completions',
    'http://user@127.0.0.1/v1/chat/completions', 'http://127.0.0.1/v1/chat/completions?', 'https://example.test/v1/chat/completions']) {
    assert.equal(localRouterReadiness({ localRouterEndpoint: url, localRouterModel: 'fixture' }).ok, false)
  }
  assert.equal(localRouterReadiness({ localRouterEndpoint: 'http://[::1]:8080/v1/chat/completions', localRouterModel: 'fixture' }).ok, true)
  const fixture = project(t, { localRouterModel: 'fixture', routerProvider: 'legacy', routerModel: 'legacy' }, undefined, { expectLegacy: true })
  const failed = await fixture.call()
  assert.equal(failed.data.route, 'local')
  assert.equal(failed.data.status, 'none')
  assert.equal(failed.data.router.ok, false)
  assert.equal(fixture.legacyCalls(), 0)
})

test('redirects and oversized bodies are rejected before any approval', async (t) => {
  const target = await localServer(t, () => accept(wrong.id))
  const local = await localServer(t, (round, res) => {
    if (round === 1) {
      res.writeHead(307, { location: target.config.localRouterEndpoint }).end()
    } else {
      res.write(' '.repeat(65536))
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(accept(wrong.id)) } }] }))
    }
  })
  const fixture = project(t, local.config)
  for (const expected of [1, 2]) {
    const failed = await fixture.call()
    assert.equal(failed.data.route, 'local')
    assert.equal(failed.data.status, 'none')
    assert.equal(failed.data.router.ok, false)
    assert.equal(local.requests.length, expected)
  }
  assert.equal(target.requests.length, 0)
})

test('unoffered IDs and unauthorized fields produce no proposal', async (t) => {
  const local = await localServer(t, (round) => [accept(wrong.id), accept(wrong.id),
    { ...accept(wrong.id), max_memory_tokens: 9999 }][round - 1])
  const fixture = project(t, local.config)
  const first = await fixture.call()
  const refined = await fixture.call({ proposal_id: first.data.proposal_id, feedback })
  assert.equal(refined.data.status, 'none')
  assert.deepEqual(ids(refined), [])
  assert.equal(refined.data.router.ok, false)
  assert.ok(!hasRow(prompt(local.requests[1]), wrong))
  const invalid = await fixture.call()
  assert.equal(invalid.data.status, 'none')
  assert.equal(invalid.data.router.ok, false)
  assert.deepEqual(ids(invalid), [])
  fixture.assertUnchanged()
})

test('only eligible live atoms are offered, even with lifecycle cooling disabled', async (t) => {
  const cold = makeAtom('fact', 'The gateway ticket has a spare cold template.', ['dom:ui'])
  const local = await localServer(t, () => accept())
  for (const lifecycleEnabled of [false, true]) {
    const fixture = project(t, { ...local.config, recallLimit: 6, lifecycleEnabled }, [wrong, right, rule, cold])
    assert.equal(writeLifecycle(fixture.root, { atoms: {
      [wrong.id]: { status: 'superseded' }, [cold.id]: { status: 'active', tier: 'COLD' },
    } }).ok, true)
    const result = await fixture.call()
    const text = prompt(local.requests.at(-1))
    assert.ok(!hasRow(text, wrong))
    assert.equal(hasRow(text, cold), !lifecycleEnabled)
    assert.equal(result.data.status, 'none')
    assert.deepEqual(ids(result), [])
  }
})

test('timed out or cancelled HTTP requests expose no memory', async (t) => {
  const local = await localServer(t, () => undefined)
  const fixture = project(t, { ...local.config, routerTimeoutMs: 1000 })
  const timedOut = await fixture.call()
  assert.equal(timedOut.data.status, 'none')
  assert.deepEqual(ids(timedOut), [])
  assert.equal(timedOut.data.router.rounds, 1)
  assert.match(timedOut.data.router.reason, /timed out/)
  const controller = new AbortController()
  const stopping = await localServer(t, () => { controller.abort() })
  const interrupted = await project(t, stopping.config).call({}, { signal: controller.signal })
  assert.deepEqual(ids(interrupted), [])
  assert.match(interrupted.summary, /cancelled/)
  assert.equal(stopping.requests.length, 1)
})

test('off skips the routing model and smart explicit recall requires cluster evidence', async (t) => {
  const local = await localServer(t, () => accept(right.id))
  assert.equal((await project(t, { ...local.config, routerTier: 'off' }).call()).data.route, 'off')
  assert.equal(local.requests.length, 0)
  const smart = project(t, { ...local.config, routerTier: 'smart' }, [right])
  const unmatched = await smart.call({ task_summary: 'water the garden', categories: [] })
  assert.equal(unmatched.data.status, 'none')
  assert.equal(local.requests.length, 0)
  const matched = await smart.call({ task_summary: 'rotate a signing credential', categories: [] })
  assert.deepEqual(offered(matched), [right.id])
  assert.equal(local.requests.length, 1)
})

test('new domains recognize English and Chinese cues without replacing persisted categories', () => {
  for (const [text, category] of [
    ['Authentication and permission policy', 'dom:security'], ['性能回归和延迟', 'dom:performance'],
    ['Environment variables and configuration', 'dom:config'], ['容器部署和回滚', 'dom:deployment'],
    ['Backward compatibility for legacy clients', 'dom:compatibility'],
  ]) {
    assert.ok(deriveCategories({ kind: 'fact', text }).includes(category), `${category} should match ${text}`)
  }
  assert.deepEqual(resolveCategories({ kind: 'fact', text: 'authentication', category_id: ['dom:general'] }), ['dom:general'])
})
