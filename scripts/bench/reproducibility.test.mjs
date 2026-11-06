import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.LLM_BASE_URL = 'http://bench.invalid/v1'
const { answer, chat, judge } = await import('./lib.mjs')
const { intentForQuestion, recallFor, seedStore } = await import('./memory-arm.mjs')
const { ARMS, recallOptionsFor } = await import('./phase3.mjs')

const SECRET = 'bench-secret-never-print-this'
const fixedNow = Date.parse('2026-01-01T00:00:00.000Z')

function response(body) {
  return { ok: true, status: 200, text: async () => body }
}

async function mockChat(reply, options = {}) {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.LLM_BASE_URL
  const originalSeed = process.env.LLM_SEED
  const requests = []
  process.env.LLM_BASE_URL = 'http://bench.invalid/v1'
  if (options.seed === undefined) delete process.env.LLM_SEED
  else process.env.LLM_SEED = options.seed
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) })
    return response(typeof reply === 'function' ? reply(requests.at(-1)) : reply)
  }
  try {
    const value = await options.call(requests)
    return { requests, value }
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.LLM_BASE_URL
    else process.env.LLM_BASE_URL = originalUrl
    if (originalSeed === undefined) delete process.env.LLM_SEED
    else process.env.LLM_SEED = originalSeed
  }
}

function completion(content, extra = {}) {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { input_tokens: 3, output_tokens: 2 },
    model: 'served-model',
    system_fingerprint: 'served-system',
    ...extra,
  })
}

test('chat hashes the request body, records served fingerprints, and keeps credentials out', async () => {
  const { requests, value } = await mockChat(completion('complete answer'), {
    call: () => chat(SECRET, [{ role: 'user', content: 'question' }]),
  })
  const request = requests[0]
  assert.equal(request.init.headers.authorization, `Bearer ${SECRET}`)
  assert.equal(Object.hasOwn(request.body, 'seed'), false, 'seed is opt-in')
  assert.match(value.requestFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(value.requestFingerprint, (await mockChat(completion('complete answer'), {
    call: () => chat('a-different-key', [{ role: 'user', content: 'question' }]),
  })).value.requestFingerprint, 'the credential does not affect the request fingerprint')
  assert.equal(value.responseModel, 'served-model')
  assert.equal(value.systemFingerprint, 'served-system')
  assert.equal(value.rawText, completion('complete answer'))
  assert.deepEqual(value.rawJson, JSON.parse(completion('complete answer')))
  assert.equal(JSON.stringify(value).includes(SECRET), false)
})

test('LLM_SEED is sent only when explicitly set and affects the fingerprint', async () => {
  const { requests, value } = await mockChat(completion('seeded'), {
    seed: '17',
    call: () => chat(SECRET, [{ role: 'user', content: 'question' }]),
  })
  assert.equal(requests[0].body.seed, 17)
  assert.notEqual(value.requestFingerprint, (await mockChat(completion('seeded'), {
    call: () => chat(SECRET, [{ role: 'user', content: 'question' }]),
  })).value.requestFingerprint)
})

test('answer and judge retain both request fingerprints and full raw diagnostics', async () => {
  const answered = await mockChat(completion('the answer'), {
    call: () => answer(SECRET, 'context', 'question'),
  })
  assert.match(answered.value.requestFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(answered.value.responseModel, 'served-model')
  assert.equal(answered.value.systemFingerprint, 'served-system')
  assert.equal(answered.value.rawText, completion('the answer'))
  assert.deepEqual(answered.value.rawJson, JSON.parse(completion('the answer')))

  const graded = await mockChat(completion('{"verdict":"PARTIAL","reason":"missing detail"}'), {
    call: () => judge(SECRET, 'question', 'reference', 'hypothesis'),
  })
  assert.equal(graded.value.verdict, 'PARTIAL')
  assert.equal(graded.value.reason, 'missing detail')
  assert.match(graded.value.requestFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(graded.value.responseModel, 'served-model')
  assert.equal(graded.value.systemFingerprint, 'served-system')
  assert.deepEqual(graded.value.rawJson, JSON.parse(completion('{"verdict":"PARTIAL","reason":"missing detail"}')))
  assert.equal(JSON.stringify([answered.value, graded.value]).includes(SECRET), false)
})

test('only the documented judge verdicts are accepted', async () => {
  for (const verdict of ['CORRECT', 'PARTIAL', 'WRONG']) {
    const { value } = await mockChat(completion(`{"verdict":"${verdict}","reason":"ok"}`), {
      call: () => judge(SECRET, 'question', 'reference', 'hypothesis'),
    })
    assert.equal(value.verdict, verdict)
  }
  for (const reply of [
    completion('{"verdict":"INVALID","reason":"not allowed"}'),
    completion('{"verdict":1,"reason":"wrong type"}'),
    completion('not JSON'),
    completion('{"verdict":"CORRECT"'),
    JSON.stringify({ model: 'served-model', choices: [] }),
  ]) {
    const { value } = await mockChat(reply, {
      call: () => judge(SECRET, 'question', 'reference', 'hypothesis'),
    })
    assert.equal(value.verdict, 'UNRESOLVED', reply)
    assert.notEqual(value.reason, '')
    assert.equal(typeof value.rawText, 'string')
    assert.ok(Object.hasOwn(value, 'rawJson'))
  }
})

test('phase3 arms differ by candidate routing and D passes the actual standingShare', () => {
  const question = 'What decision governs the release router?'
  assert.equal(ARMS.length, 4)
  for (const id of ['A', 'B', 'C', 'D']) {
    const arm = ARMS.find((entry) => entry.id === id)
    const options = recallOptionsFor(arm, question)
    assert.equal(options.semanticRouting ?? false, id === 'C' || id === 'D')
    assert.equal(options.taskIntentEnabled ?? false, id === 'C' || id === 'D')
    assert.equal(options.standingBudgetShare, undefined)
    assert.equal(options.standingShare ?? (id === 'D' ? null : undefined), id === 'D' ? 0.25 : undefined)
    assert.equal(options.now, fixedNow)
    assert.equal(Object.hasOwn(options, 'categories'), false)
    if (id === 'C' || id === 'D') {
      assert.equal(options.intent.taskSummary, question)
      assert.ok(Array.isArray(options.intent.categories))
      assert.equal(options.intent.createdAt, '2026-01-01T00:00:00.000Z')
    } else {
      assert.equal(options.intent, undefined)
    }
  }
  assert.equal(intentForQuestion(question).operation, 'explain')
})

test('semantic recall uses real switches, normalized intent, standing share, and fixed time', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-bench-routing-'))
  try {
    await seedStore(root, [
      { kind: 'fact', text: 'The answer-holder concerns release routing and recall.', tags: ['dom:memory-routing'] },
      { kind: 'constraint', text: 'The router must never write to the store.' },
      { kind: 'constraint', text: 'A second standing rule is required for audit.' },
      { kind: 'constraint', text: 'A third standing rule is required for review.' },
      { kind: 'fact', text: 'An unrelated fact is included for coverage.' },
    ])
    const off = await recallFor(root, 'Which recall route applies?', { recallLimit: 2, now: fixedNow })
    assert.equal(off.settings.semanticRouting, false)
    assert.equal(off.settings.taskIntentEnabled, false)
    assert.equal(off.recall.semantic, undefined)

    const on = await recallFor(root, 'Which recall route applies?', {
      recallLimit: 2,
      semanticRouting: true,
      taskIntentEnabled: true,
      intent: {
        task_summary: 'Which recall route applies?',
        operation: 'explain',
        memory_needs: ['architecture_decisions'],
      },
      now: fixedNow,
    })
    assert.equal(on.settings.semanticRouting, true)
    assert.equal(on.settings.taskIntentEnabled, true)
    assert.equal(on.recall.semantic.enabled, true)
    const defaultStanding = await recallFor(root, 'unrelated terms only', {
      recallLimit: 8,
      maxExperts: 1,
      now: fixedNow,
    })
    const limitedStanding = await recallFor(root, 'unrelated terms only', {
      recallLimit: 8,
      standingShare: 0,
      maxExperts: 1,
      now: fixedNow,
    })
    assert.equal(defaultStanding.recall.gating.standing, 3)
    assert.equal(limitedStanding.recall.gating.standing, 0, 'the explicit cap must reach the real gate')

    const again = await recallFor(root, 'Which recall route applies?', {
      recallLimit: 2,
      semanticRouting: true,
      taskIntentEnabled: true,
      intent: {
        task_summary: 'Which recall route applies?',
        operation: 'explain',
        memory_needs: ['architecture_decisions'],
      },
      now: fixedNow,
    })
    assert.deepEqual(again.recall.ids, on.recall.ids)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
