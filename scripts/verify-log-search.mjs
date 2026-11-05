/**
 * Sanity-check the session-log search: does the log contain anything at all that we know
 * happened?
 *
 * A search that returns zero hits is worthless unless the same search can find something
 * known. This looks for strings that must be present in a real main session — the system
 * reminder block this plugin injects, the project path, a tool name — and reports which
 * files contain them. If none of those are found either, the conclusion is "the logs do
 * not record this", not "the router was never called".
 *
 * Usage: node scripts/verify-log-search.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const SESSIONS = join(HOME, 'sessions')

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

const files = []
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
    if (entry.isDirectory()) walk(path, depth + 1)
    else if (entry.name.includes('jsonl')) files.push(path)
  }
}
walk(SESSIONS, 0)

// Strings that must exist somewhere in a real session if logs carry message content.
const probes = [
  ['project-memory (plugin source kind)', 'project-memory'],
  ['dsh-memory path', 'dsh-memory'],
  ['a tool name', 'memory_status'],
  ['a state tool', 'state_update'],
  ['compaction event', 'compaction'],
  ['this user prompt', 'UI/UX'],
  ['agent pre-step', 'pre-step'],
  ['a message role', '"role"'],
  ['router digest wording', 'memory router'],
  ['hot/cold protocol', 'hot_memory_ids'],
]

const totals = new Map()
const samples = new Map()
for (const path of files) {
  const size = (() => { try { return statSync(path).size } catch { return 0 } })()
  if (size === 0) continue
  const body = text(path)
  if (body === '') continue
  for (const [label] of probes) {
    if (!body.includes(label === 'project-memory (plugin source kind)' ? 'project-memory' : '')) {
      // handled below via value; this branch is unreachable but keeps the loop simple
    }
  }
  for (const [label, needle] of probes) {
    if (!body.includes(needle)) continue
    totals.set(label, (totals.get(label) ?? 0) + 1)
    if (!samples.has(label)) {
      const at = body.indexOf(needle)
      samples.set(label, body.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, ' '))
    }
  }
}

console.log(`scanned ${files.length} session file(s)\n`)
for (const [label] of probes) {
  const count = totals.get(label) ?? 0
  console.log(`${count.toString().padStart(3)} file(s) contain: ${label}`)
  if (count > 0) console.log(`      e.g. …${samples.get(label)}…`)
}
const anyFound = [...totals.values()].reduce((sum, value) => sum + value, 0)
console.log(`\n${anyFound === 0 ? 'NOTHING found — the logs do not record message content, so a zero hit proves nothing' : 'the search works; zero hits on a needle then means absence'}`)
