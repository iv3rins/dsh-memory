/**
 * Audit real session traces for evidence that the router subagent was actually invoked.
 *
 * The user asked whether this project uses a sub-model at all, and specifically whether the
 * main model's wake-up sends a request to it. That question cannot be answered from the
 * plugin's intent — only from what the harness recorded. So this reads the newest session
 * logs and counts:
 *
 *   - `agent/pre-step` recalls produced by this plugin (`project-memory:recall`),
 *   - subagent tool calls / activations,
 *   - router failures and their reasons.
 *
 * It reports what is present and what is absent, and never infers a call from a config
 * value: "tier is always" is not evidence that a model was invoked.
 *
 * Usage: node scripts/audit-subagent.mjs [sessionLimit]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const sessionsRoot = process.env.DSH_HOME === undefined
  ? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
  : join(process.env.DSH_HOME, 'sessions')

const limit = Number(process.argv[2] ?? 6)

/** Newest session files first. */
function newestSessions(root, count) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.includes('.jsonl')) continue
      try {
        found.push({ path, mtime: statSync(path).mtimeMs })
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  walk(root)
  found.sort((left, right) => right.mtime - left.mtime)
  return found.slice(0, count)
}

/** Read a session log, transparently decompressing zstd. */
function readSession(path) {
  const raw = readFileSync(path)
  // zstd frames begin with the magic 0x28 B5 2F FD.
  if (raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch (error) {
      return { error: `zstd: ${error.message}` }
    }
  }
  return raw.toString('utf8')
}

const report = []
for (const session of newestSessions(sessionsRoot, limit)) {
  const text = readSession(session.path)
  if (typeof text !== 'string') {
    report.push({ session: session.path, error: text.error })
    continue
  }
  const lines = text.split('\n').filter((row) => row.trim() !== '')
  const counts = {
    lines: lines.length,
    recallInjected: 0,
    baselineInjected: 0,
    routerCallOk: 0,
    routerCallFailed: 0,
    routerFailures: [],
    subagentEvents: 0,
    subagentNames: new Set(),
    compactionStarts: 0,
  }
  for (const line of lines) {
    if (line.includes('project-memory:recall')) counts.recallInjected += 1
    if (line.includes('"kind":"project-memory"') || line.includes('"kind": "project-memory"')) counts.baselineInjected += 1
    if (line.includes('compaction/start')) counts.compactionStarts += 1
    // The plugin logs its own router outcomes; a successful selection names atom counts.
    if (/recall .*router ids/.test(line)) counts.routerCallOk += 1
    if (/router failed|router subagent timed out|not mounted|memory-router/.test(line)) {
      if (/router failed|timed out|not mounted/.test(line)) {
        counts.routerCallFailed += 1
        if (counts.routerFailures.length < 3) counts.routerFailures.push(line.slice(0, 200))
      }
    }
    // Any subagent activation recorded by the host.
    if (/subagent/i.test(line)) {
      counts.subagentEvents += 1
      const nameMatch = /"(?:label|agentName|subagentName|name)"\s*:\s*"([^"]{1,60})"/.exec(line)
      if (nameMatch !== null) counts.subagentNames.add(nameMatch[1])
    }
  }
  report.push({
    session: session.path.split(/[\\/]/).slice(-3).join('/'),
    sizeKB: Math.round(statSync(session.path).size / 1024),
    ...counts,
    subagentNames: [...counts.subagentNames].slice(0, 6),
  })
}

console.log(JSON.stringify(report, null, 2))
