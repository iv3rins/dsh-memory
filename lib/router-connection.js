import { createHash } from 'node:crypto'
import { ROUTER_PROTOCOLS } from '../core/config.js'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_MODELS = 2000

export function canonicalRouterBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2048) return null
  const input = value.trim()
  if (/[?#\\\s]/.test(input)) return null
  try {
    const url = new URL(input)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.protocol === 'http:' && !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) return null
    if (url.hostname === 'localhost' || !url.hostname) return null
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

export function routerCredentialKey(baseUrl) {
  return `project-memory/${createHash('sha256').update(baseUrl).digest('hex')}`
}

export async function readRouterKey(credentials, baseUrl) {
  const record = await credentials?.readRecord(routerCredentialKey(baseUrl))
  return typeof record?.key === 'string' && record.key !== '' ? record.key : undefined
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('empty response')
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_RESPONSE_BYTES) throw new Error('response too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function discoverRouterModels({ baseUrl, apiKey, protocol = 'openai-chat-completions', timeoutMs = 20000, signal }) {
  const base = canonicalRouterBaseUrl(baseUrl)
  if (base === null) return { error: 'invalid-url' }
  const selectedProtocol = ROUTER_PROTOCOLS.includes(protocol) ? protocol : 'openai-chat-completions'
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const headers = selectedProtocol === 'anthropic-messages'
      ? { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {}
    const response = await fetch(`${base}/models`, { headers, redirect: 'error', signal: combined })
    if (!response.ok) {
      await response.body?.cancel()
      return { error: 'discovery-failed' }
    }
    const body = await readBoundedJson(response)
    if (!Array.isArray(body?.data) || body.data.length > MAX_MODELS) return { error: 'discovery-failed' }
    const models = body.data.map((entry) => entry?.id)
    if (models.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) return { error: 'discovery-failed' }
    return { models: [...new Set(models)] }
  } catch {
    return { error: 'discovery-failed' }
  }
}

export function newPostAllowed(req) {
  try {
    const host = new URL(`http://${req.headers.host}`)
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(host.hostname)) return false
    const origin = new URL(req.headers.origin)
    return origin.protocol === 'http:' && origin.host === req.headers.host && origin.username === '' && origin.password === ''
  } catch {
    return false
  }
}
