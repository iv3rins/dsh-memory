/**
 * Long-horizon memory experiment: does dsh-project-memory recover facts that plain
 * context compaction loses?
 *
 * The question the user asked is specific — "how much does compaction lose" — so the
 * arms are built around that:
 *
 * | arm | history the model receives | isolates |
 * |-----|------------------------------|----------|
 * | A   | a compacted summary only       | what native compaction preserves |
 * | B   | raw transcript tail only       | no memory at all |
 * | C   | compacted summary + plugin recall | what the memory system adds |
 *
 * Every arm sees the same question and the same evidence-free prompt budget. The only
 * difference is where history came from, which is what makes the comparison readable.
 *
 * Ground truth is the dataset's own `answer_short`/`answer`, scored by an LLM judge
 * against the expected answer — not by string matching, because a correct answer is
 * rarely spelled identically.
 *
 * Run: node scripts/bench/codememo.mjs [--questions 40] [--projects p02] [--arms ABC]
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..', '..')
const BENCH = path.join(ROOT, '_bench', 'codememo')
const OUT = path.join(BENCH, 'results')
const PLUGIN_ROOT = path.join(BENCH, 'plugin-root')

/**
 * The OpenAI-compatible endpoint to use.
 *
 * Read from `LLM_BASE_URL`, with the harness's own provider default as the fallback only
 * when the caller has configured nothing. A private host baked into a public repository
 * is both useless to a reader and a leak of the author's infrastructure, so it is never
 * a literal default here — the value must come from the environment.
 */
const BASE_URL = process.env.LLM_BASE_URL ?? ''

/** Where the harness keeps its credentials. */
function credentialsFile() {
  const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return path.join(home, '.credentials.yaml')
}

/** Read the API key from the harness credential store without printing it. */
function apiKey() {
  const file = credentialsFile()
  const raw = readFileSync(file, 'utf8')
  const match = /AIRELAY_API_KEY\s*:\s*['"]?([^\s'",}]+)/.exec(raw.slice(raw.indexOf('refs:')))
  if (match === null) throw new Error(`AIRELAY_API_KEY not found under refs in ${file}`)
  return match[1]
}

const MODEL = process.env.LLM_MODEL ?? 'deepseek-v4.1-flash'
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? MODEL

/** Conservative token estimate, matching the plugin's own assumption. */
const estimateTokens = (text) => Math.ceil(String(text).length / 4)

/** One chat completion. Returns text and token usage. */
async function chat(key, messages, options = {}) {
  if (BASE_URL === '') {
    throw new Error('LLM_BASE_URL is not set; point it at an OpenAI-compatible /v1 endpoint (see docs/design/benchmark-compaction-loss.md)')
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: options.model ?? MODEL,
      messages,
      max_tokens: options.maxTokens ?? 400,
      temperature: 0,
    }),
  })
  const text = await res.text()
  if (res.ok !== true) throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`)
  const json = JSON.parse(text)
  return {
    content: json.choices?.[0]?.message?.content ?? '',
    usage: json.usage ?? {},
  }
}

/**
 * Load one project's sessions in chronological order as {sessionId, turns[]}.
 *
 * These files are raw agent session logs, not a clean conversation export: a single
 * session carries `progress`, `file-history-snapshot` and `queue-operation` records
 * alongside the `user` / `assistant` messages, and only the last two carry a
 * `message.content` array. Filtering by record type is what makes the transcript the
 * conversation rather than 80% bookkeeping — an earlier version read only
 * `message.content` and silently dropped most of the history.
 */
function loadSessions(projectId) {
  const dir = path.join(BENCH, projectId)
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
  const sessions = []
  for (const name of names) {
    const lines = readFileSync(path.join(dir, name), 'utf8').trim().split('\n')
    const turns = []
    for (const line of lines) {
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const role = parsed?.type
      if (role !== 'user' && role !== 'assistant') continue
      const blocks = parsed?.message?.content
      // `content` is usually an array of blocks, but a continuation record carries a
      // plain string — and that string is the previous context's compaction summary.
      // Dropping it would remove exactly the artefact this experiment is about.
      let text
      if (typeof blocks === 'string') {
        text = blocks
      } else if (Array.isArray(blocks)) {
        text = blocks
          .map((block) => {
            if (block?.type === 'text') return block.text ?? ''
            if (block?.type === 'tool_use') return `[tool ${block.name ?? ''}] ${JSON.stringify(block.input ?? {}).slice(0, 400)}`
            return ''
          })
          .join('\n')
      } else {
        continue
      }
      text = text.trim()
      if (text === '') continue
      turns.push({ role, text, compactSummary: parsed?.isCompactSummary === true })
    }
    sessions.push({ id: name.replace('.jsonl', ''), turns })
  }
  return sessions
}

/** Flatten sessions into one transcript, oldest first. */
function flatten(sessions, untilSessionIndex) {
  const parts = []
  const limit = untilSessionIndex ?? sessions.length
  for (let index = 0; index < limit; index += 1) {
    parts.push(`=== session ${sessions[index].id} ===`)
    for (const turn of sessions[index].turns) parts.push(`${turn.role}: ${turn.text}`)
  }
  return parts.join('\n')
}

/** Keep the tail of the transcript within a token budget, as a context window would. */
function tailWithin(text, budgetTokens) {
  const maxChars = budgetTokens * 4
  if (text.length <= maxChars) return text
  const cut = text.slice(text.length - maxChars)
  // Start at a line boundary so the model does not read a half sentence.
  const firstBreak = cut.indexOf('\n')
  return firstBreak === -1 ? cut : cut.slice(firstBreak + 1)
}

/**
 * Summarise a transcript the way a compaction would.
 *
 * Map-reduce over chunks, not one call over the tail. An earlier version sent only the
 * last `targetTokens * 12` characters, which for a 588k-token history meant the
 * summariser saw 0.4% of it and returned 72 tokens of tool-call debris. The arm that
 * is *supposed* to represent "what compaction preserves" was therefore measuring a
 * broken summariser, and every arm A answer was wrong for that reason rather than
 * because compaction is lossy.
 *
 * Each chunk is summarised to a share of the budget, then the partial summaries are
 * reduced to the final size. The budget is split, not multiplied, so the result still
 * fits the stated target.
 */
async function compact(key, transcript, targetTokens) {
  const CHUNK_TOKENS = 20000
  const chunkChars = CHUNK_TOKENS * 4

  // Split on line boundaries so a chunk never starts mid-sentence.
  const chunks = []
  let cursor = 0
  while (cursor < transcript.length) {
    let end = Math.min(cursor + chunkChars, transcript.length)
    if (end < transcript.length) {
      const breakAt = transcript.lastIndexOf('\n', end)
      if (breakAt > cursor) end = breakAt
    }
    chunks.push(transcript.slice(cursor, end))
    cursor = end
  }

  const system = 'You compress a software project conversation history. Preserve decisions, conventions, file paths, library versions, bug causes and their fixes, and anything that changed from one value to another. Drop pleasantries, narration and duplicated tool output. Write dense notes.'
  const perChunk = Math.max(150, Math.floor((targetTokens * 1.4) / Math.max(1, chunks.length)))

  const partials = []
  for (const [index, chunk] of chunks.entries()) {
    const { content } = await chat(key, [
      { role: 'system', content: system },
      { role: 'user', content: `Summarise part ${index + 1} of ${chunks.length} in at most ${perChunk} tokens:\n\n${chunk}` },
    ], { maxTokens: Math.min(3000, Math.ceil(perChunk * 2)) })
    if (content.trim() !== '') partials.push(content.trim())
    process.stdout.write(`\r  compact ${index + 1}/${chunks.length} parts   `)
  }
  console.log('')

  if (partials.length === 0) return { summary: '', usage: {}, chunks: chunks.length }

  const merged = partials.join('\n\n')
  if (estimateTokens(merged) <= targetTokens) {
    return { summary: merged, usage: {}, chunks: chunks.length }
  }

  // Reduce: one more pass when the partials still exceed the target.
  const { content } = await chat(key, [
    { role: 'system', content: system },
    { role: 'user', content: `Merge these partial notes into one set of notes of at most ${targetTokens} tokens. Keep concrete values (versions, paths, names, numbers) and drop repetition:\n\n${tailWithin(merged, targetTokens * 10)}` },
  ], { maxTokens: Math.ceil(targetTokens * 1.8) })
  return { summary: content.trim(), usage: {}, chunks: chunks.length }
}

/** Ask one arm a question. */
async function answer(key, context, question) {
  const { content, usage } = await chat(key, [
    {
      role: 'system',
      content: 'You answer questions about a software project using only the provided context. If the context does not contain the answer, say "I don\'t know". Be concise.',
    },
    { role: 'user', content: `${context}\n\n=== QUESTION ===\n${question}` },
  ], { maxTokens: 300 })
  return { answer: content.trim(), usage }
}

/** Judge one answer against the reference. */
async function judge(key, question, reference, hypothesis) {
  const { content, usage } = await chat(key, [
    {
      role: 'system',
      content: 'You grade an answer against a reference answer. Reply with JSON only: {"verdict":"CORRECT"|"PARTIAL"|"WRONG","reason":"<short>"}. CORRECT means the key facts match. PARTIAL means some key facts are right but important detail is missing. WRONG means the key facts are absent or contradicted.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${question}\n\nREFERENCE:\n${reference}\n\nANSWER BEING GRADED:\n${hypothesis}`,
    },
  ], { model: JUDGE_MODEL, maxTokens: 120 })
  const match = /\{[\s\S]*\}/.exec(content)
  let verdict = 'WRONG'
  let reason = ''
  if (match !== null) {
    try {
      const parsed = JSON.parse(match[0])
      verdict = String(parsed.verdict ?? 'WRONG').toUpperCase()
      reason = String(parsed.reason ?? '')
    } catch {
      reason = 'unparsable judge reply'
    }
  }
  return { verdict, reason, usage }
}

/** Deterministic sample so a rerun scores the same questions. */
function sample(items, count, seed) {
  const scored = items.map((item) => ({
    item,
    key: createHash('sha256').update(`${seed}:${item.id}`).digest('hex'),
  }))
  scored.sort((left, right) => (left.key < right.key ? -1 : 1))
  return scored.slice(0, count).map((entry) => entry.item)
}

export {
  BENCH,
  OUT,
  PLUGIN_ROOT,
  MODEL,
  JUDGE_MODEL,
  apiKey,
  answer,
  chat,
  compact,
  flatten,
  judge,
  loadSessions,
  sample,
  tailWithin,
  estimateTokens,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  path,
}
