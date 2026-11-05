/**
 * Find the router subagent's own session files.
 *
 * The harness records every agent as a session, and a subagent's session declares
 * `origin: 'subagent'`, its `parentSession`, and a `delegationDepth`. That makes the
 * question "was the sub-model actually invoked?" answerable from recorded files instead of
 * from configuration intent.
 *
 * A router call is invisible by design (`delivery: 'caller'` emits no completion notice),
 * so the *only* honest evidence is a subagent session whose prompt carried this plugin's
 * digest. This script looks for exactly that.
 *
 * Usage: node scripts/find-router-runs.mjs
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const SESSIONS = join(HOME, 'sessions')

/** Decompress a session file, or return its text. */
function readSession(path) {
  const raw = readFileSync(path)
  if (raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch {
      return ''
    }
  }
  return raw.toString('utf8')
}

const rows = []
let scanned = 0
const walk = (dir, depth) => {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, depth + 1)
      continue
    }
    if (!entry.name.includes('jsonl')) continue
    scanned += 1
    const text = readSession(path)
    if (text === '') continue
    const firstLine = text.split('\n')[0] ?? ''
    let header = null
    try {
      header = JSON.parse(firstLine)
    } catch {
      continue
    }
    // Only subagent sessions matter here.
    if (header.origin !== 'subagent') continue
    const mtime = statSync(path).mtimeMs
    // A router run is the subagent whose prompt carried the memory digest.
    const isRouter = /MEMORY ATOMS|cold_memory_ids|hot_memory_ids/.test(text)
    const titleMatch = /"title"\s*:\s*"([^"]{0,80})"/.exec(text)
    rows.push({
      path: path.replace(SESSIONS, '').replace(/\\/g, '/'),
      parent: header.parentSession ?? null,
      depth: header.delegationDepth ?? null,
      preset: header.agentPreset ?? null,
      createdAt: header.createdAt ?? null,
      at: new Date(header.createdAt ?? mtime).toISOString(),
      bytes: statSync(path).size,
      isRouter,
      title: titleMatch === null ? null : titleMatch[1],
    })
  }
}

walk(SESSIONS, 0)
rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))

console.log(JSON.stringify({
  scannedFiles: scanned,
  subagentSessions: rows.length,
  routerSessions: rows.filter((row) => row.isRouter).length,
  recent: rows.slice(0, 12),
}, null, 2))
