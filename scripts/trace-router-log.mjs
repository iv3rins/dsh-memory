/**
 * Search the newest *main* session log for this plugin's own log lines and for any
 * evidence that the router subagent was invoked.
 *
 * The plugin logs `recall …` and `recall produced nothing: …` through the host logger, and
 * those lines are the only direct record of a router call. This prints them verbatim so
 * the answer to "is the sub-model being called?" comes from the log rather than from the
 * configuration.
 *
 * Usage: node scripts/trace-router-log.mjs [lines]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const SESSIONS = join(HOME, 'sessions')
const LIMIT = Number(process.argv[2] ?? 120)

/** All session files, newest first. */
function allSessionFiles() {
  const found = []
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
      try {
        found.push({ path, mtime: statSync(path).mtimeMs, size: statSync(path).size })
      } catch {
        /* skip */
      }
    }
  }
  walk(SESSIONS, 0)
  found.sort((left, right) => right.mtime - left.mtime)
  return found
}

/** Decompress if needed. */
function text(path) {
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

// The router's prompt always contains one of these; a session carrying it is a router run.
const ROUTER_MARKERS = ['You are a memory router', 'hot_memory_ids', 'MEMORY ATOMS (', 'memory-router']
const LOG_MARKERS = ['recall route', 'recall produced nothing', 'recall ', 'router subagent', 'memory router']

const hits = []
let scanned = 0
for (const file of allSessionFiles()) {
  if (file.size === 0) continue
  const body = text(file.path)
  if (body === '') continue
  scanned += 1
  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length < 4) continue
    const isRouter = ROUTER_MARKERS.some((marker) => line.includes(marker))
    const isLog = LOG_MARKERS.some((marker) => line.includes(marker))
    if (!isRouter && !isLog) continue
    hits.push({
      file: file.path.replace(SESSIONS, '').replace(/\\/g, '/'),
      line: index + 1,
      kind: isRouter ? 'ROUTER-PROMPT' : 'LOG',
      text: line.trim().slice(0, 300),
    })
    if (hits.length >= LIMIT) break
  }
  if (hits.length >= LIMIT) break
}

console.log(`scanned ${scanned} session file(s); ${hits.length} hit(s)`)
const routerPrompt = hits.filter((hit) => hit.kind === 'ROUTER-PROMPT')
console.log(`router prompts recorded: ${routerPrompt.length}`)
for (const hit of hits.slice(0, 40)) {
  console.log(`[${hit.kind}] ${hit.file}:${hit.line}`)
  console.log(`   ${hit.text}`)
}
