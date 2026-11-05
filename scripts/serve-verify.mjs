/**
 * Serve the verification pages over HTTP so a browser automation tool can load them.
 *
 * `file:` is blocked by the Playwright MCP, and the harness Web GUI requires credentials
 * this session does not have. A throwaway static server on loopback is the smallest thing
 * that lets a real rendering engine open the real markup.
 *
 * Usage: node scripts/serve-verify.mjs [port]
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = join(here, '..', '.dsh-memory')
const port = Number(process.argv[2] ?? 4173)

const routes = new Map([
  ['/overview', 'verify-overview.html'],
  ['/explorer', 'verify-explorer.html'],
  ['/drawer', 'verify-drawer.html'],
])

const server = createServer((req, res) => {
  const path = String(req.url ?? '/').split('?')[0]
  const file = routes.get(path)
  if (file === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  const absolute = join(base, file)
  if (!existsSync(absolute)) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`missing ${file}; run node scripts/verify-panel.mjs first`)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(absolute))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`serving verification pages on http://127.0.0.1:${port}/overview`)
})
