/**
 * Build the atom store this experiment measures, with provenance.
 *
 * Facts are extracted **per session** and tagged with the session id they came from.
 * That tag is what makes a retrieval hit measurable without a model in the loop: a
 * question whose evidence lives in `session_005` is recoverable only if recall returns
 * an atom stamped `session_005`.
 *
 * Extraction runs once and is cached on disk, because it is the expensive step and
 * every later measurement must see the same store.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, chat, estimateTokens, tailWithin } from './lib.mjs'

const CACHE = path.join(BENCH, 'atoms')

/** Parse a JSON array of facts from a model reply, tolerating prose around it. */
function parseFacts(reply) {
  const match = /\[[\s\S]*\]/.exec(reply)
  if (match === null) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        kind: ['constraint', 'decision', 'fact', 'pitfall', 'preference'].includes(entry.kind) ? entry.kind : 'fact',
        text: String(entry.text ?? '').trim(),
      }))
      .filter((entry) => entry.text !== '')
  } catch {
    return []
  }
}

/** Split one session's turns into windows small enough for one extraction call. */
function windows(turns, maxTokens) {
  const out = []
  let current = []
  let used = 0
  for (const turn of turns) {
    const cost = estimateTokens(turn.text)
    if (used + cost > maxTokens && current.length > 0) {
      out.push(current)
      current = []
      used = 0
    }
    current.push(turn)
    used += cost
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Extract facts for one project, cached by project id.
 *
 * Two passes, because one is not enough:
 *
 * 1. **Per window** — the bulk of the facts, each stamped with its source session.
 * 2. **Per session, comparison-aware** — asks what *changed* during the session
 *    (versions, renames, reverted choices). Measured effect: without this pass, a
 *    question like "what was the initial version and what did it become" is
 *    unanswerable from the store even though both endpoints were in the transcript,
 *    because each window only ever sees one side of the change.
 *
 * Returns atoms shaped for the plugin's own normalizer, each carrying the session it
 * came from in `tags` so provenance survives the store round trip.
 */
export async function buildAtoms(projectId, sessions, key, options = {}) {
  const cacheFile = path.join(CACHE, `${projectId}.json`)
  if (existsSync(cacheFile) && options.refresh !== true) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
    console.log(`atoms: cached ${cached.atoms.length} for ${projectId}`)
    return cached.atoms
  }
  mkdirSync(CACHE, { recursive: true })

  const raw = []

  // --- Pass 1: facts inside one window of one session.
  let calls = 0
  for (const session of sessions) {
    for (const window of windows(session.turns, 12000)) {
      const body = window.map((turn) => `${turn.role}: ${turn.text}`).join('\n')
      const { content } = await chat(key, [
        {
          role: 'system',
          content: 'You read a slice of a software development transcript and emit durable project facts. Reply with a JSON array only. Each item: {"kind":"constraint"|"decision"|"fact"|"pitfall"|"preference","text":"<one self-contained sentence under 200 chars>"}. Include only statements that remain true after the session ends: pinned versions, file paths, schema and API choices, conventions, bug causes and fixes, architectural decisions. Exclude narration, plans, greetings, and anything speculative. Prefer precise values (version numbers, names, hashes) over vague summaries.',
        },
        { role: 'user', content: `Emit at most 10 facts from this history:\n\n${tailWithin(body, 12000)}` },
      ], { maxTokens: 1400 })
      calls += 1
      for (const fact of parseFacts(content)) {
        raw.push({ ...fact, sessionId: session.id, tags: [`bench:${session.id}`] })
      }
      process.stdout.write(`\r  ${session.id} window ${calls} facts ${raw.length}   `)
    }
  }
  console.log('')

  // --- Pass 2: what changed across this session.
  for (const session of sessions) {
    const body = session.turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n')
    if (body.trim() === '') continue
    const { content } = await chat(key, [
      {
        role: 'system',
        content: 'You read one development session and report what CHANGED. Reply with a JSON array only. Each item: {"kind":"decision"|"fact","text":"<one self-contained sentence under 220 chars>"}. Focus on transitions: a version bumped from A to B, a thing renamed from X to Y, a choice reverted, a threshold revised, a file moved. State both the before and after value in the sentence. Include at most 4 items. If nothing changed value, reply with [].',
      },
      { role: 'user', content: `What changed in this session?\n\n${tailWithin(body, 14000)}` },
    ], { maxTokens: 900 })
    calls += 1
    for (const fact of parseFacts(content)) {
      raw.push({ ...fact, sessionId: session.id, tags: [`bench:${session.id}`] })
    }
    process.stdout.write(`\r  ${session.id} change-pass facts ${raw.length}   `)
  }
  console.log('')

  // Content-addressed dedupe, the same idea the plugin uses.
  const seen = new Set()
  const unique = []
  for (const atom of raw) {
    const hash = createHash('sha256').update(atom.text.toLowerCase().slice(0, 160)).digest('hex')
    if (seen.has(hash)) continue
    seen.add(hash)
    unique.push(atom)
  }

  writeFileSync(cacheFile, JSON.stringify({ projectId, atoms: unique }, null, 1), 'utf8')
  console.log(`atoms: extracted ${unique.length} unique from ${calls} calls for ${projectId}`)
  return unique
}

export { CACHE }
