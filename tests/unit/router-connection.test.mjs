import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { discoverRouterModels } from '../../lib/router-connection.js'

async function modelServer(t, status = 200) {
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push({ headers: request.headers, method: request.method, url: request.url })
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-b' }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close(); server.closeAllConnections() })
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1` }
}

for (const protocol of ['openai-chat-completions', 'openai-responses', 'anthropic-messages']) {
  test(`model discovery uses ${protocol} authentication`, async (t) => {
    const fixture = await modelServer(t)
    const result = await discoverRouterModels({ baseUrl: fixture.url, apiKey: 'fixture-key', protocol })
    assert.deepEqual(result, { models: ['model-a', 'model-b'] })
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.requests[0].method, 'GET')
    assert.equal(fixture.requests[0].url, '/v1/models')
    if (protocol === 'anthropic-messages') {
      assert.equal(fixture.requests[0].headers['x-api-key'], 'fixture-key')
      assert.equal(fixture.requests[0].headers['anthropic-version'], '2023-06-01')
      assert.equal(fixture.requests[0].headers.authorization, undefined)
    } else {
      assert.equal(fixture.requests[0].headers.authorization, 'Bearer fixture-key')
      assert.equal(fixture.requests[0].headers['x-api-key'], undefined)
    }
  })
}

test('model discovery preserves stable failures and rejects non-loopback HTTP', async (t) => {
  assert.deepEqual(await discoverRouterModels({ baseUrl: 'http://example.test/v1' }), { error: 'invalid-url' })
  const fixture = await modelServer(t, 503)
  assert.deepEqual(await discoverRouterModels({ baseUrl: fixture.url }), { error: 'discovery-failed' })
})
