/**
 * Deterministic architecture checks.
 *
 * The rule that makes this useful is that it does **not** ask a model whether the
 * architecture is respected. It reads imports and compares them to declared
 * rules, producing a machine verdict with file and line evidence. A model may
 * then advise on what the violation means, but it cannot turn a violation into a
 * pass.
 *
 * Supported rule shape (stored in `.dsh-memory/arch.json`):
 *
 * ```jsonc
 * {
 *   "rules": [
 *     { "id": "no-ui-in-domain",
 *       "kind": "forbid-import",
 *       "from": ["src/domain/"],
 *       "to":   ["src/ui/", "pixi"],
 *       "reason": "domain must not depend on presentation" }
 *   ]
 * }
 * ```
 *
 * Pure Node; no DSH import.
 */

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { toPosix } from './paths.js'
import { readText } from './store.js'

/** Extensions scanned for imports. */
export const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs', '.java'])

/** Directories never descended into. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.dsh-memory', 'dist', 'build', 'Library', 'Temp', 'obj', '.idea', '.vscode', 'target', 'bin'])

/** Config file, project-relative. */
export const ARCH_FILE = '.dsh-memory/arch.json'

/**
 * Extract module specifiers from source text with line numbers.
 *
 * A regex scanner is used instead of a language parser on purpose: the check must
 * work for JavaScript, TypeScript, C#, and Java with one implementation, and a
 * syntax error in one file must not stop the whole scan. Comments are stripped
 * first so a commented-out import is not reported.
 *
 * @param {string} text - source text.
 * @returns {{ specifier: string, line: number }[]} found specifiers.
 */
export function extractImports(text) {
  const withoutComments = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length))
  const results = []
  // `^[ \t]*` rather than `^\s*`: `\s` matches newlines, so with the `m` flag a
  // match could begin on an earlier blank line and consume the separator, which
  // moves the reported line to the top of the file for every import that is not on
  // the first line. Horizontal whitespace is all a leading indent ever contains.
  const patterns = [
    /^[ \t]*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s+['"]([^'"]+)['"]/gm,
    /^[ \t]*export\s[^'"]*?from\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^[ \t]*using\s+([\w.]+)\s*;/gm,
    /^[ \t]*import\s+(?:static\s+)?([\w.]+)\s*;/gm,
  ]
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      const index = match.index ?? 0
      // Count the newlines before the match start. Slicing to `index` and splitting
      // looks equivalent but is off by one whenever the import does not start on
      // line 1, because `^` with the `m` flag places the match *after* the newline
      // and `index` then points at the first character of the line rather than past
      // a separator. A wrong line number sends a reviewer to the wrong line, which
      // is worse than no line number.
      let line = 1
      for (let cursor = withoutComments.indexOf('\n'); cursor !== -1 && cursor < index; cursor = withoutComments.indexOf('\n', cursor + 1)) {
        line += 1
      }
      results.push({ specifier: match[1], line })
    }
  }
  results.sort((left, right) => left.line - right.line)
  return results
}

/**
 * Collect source files under a root.
 * @param {{ root: string, directories?: string[], extensions?: readonly string[], maxFiles?: number }} input - scan inputs.
 * @returns {{ relative: string, absolute: string }[]} the files.
 */
export function collectSourceFiles(input) {
  const extensions = input.extensions ?? SOURCE_EXTENSIONS
  const maxFiles = input.maxFiles ?? 20000
  const roots = (input.directories ?? ['src']).map((directory) => toPosix(directory).replace(/\/$/, ''))
  const files = []
  const queue = roots.map((relative) => ({ absolute: path.join(input.root, relative), depth: 0 }))
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      const absolute = path.join(current.absolute, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (current.depth < 16) queue.push({ absolute, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (!extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) continue
      files.push({ relative: toPosix(path.relative(input.root, absolute)), absolute })
      if (files.length >= maxFiles) break
    }
  }
  return files
}

/**
 * Test a project-relative path against one prefix list.
 * @param {string} relative - forward-slashed path.
 * @param {string[]} prefixes - configured prefixes.
 * @returns {string | null} the matched prefix, or null.
 */
function matchPrefix(relative, prefixes) {
  const lowered = relative.toLowerCase()
  for (const prefix of prefixes) {
    const candidate = String(prefix).toLowerCase().replace(/^\.\//, '')
    if (candidate === '') continue
    if (candidate.endsWith('/')) {
      if (lowered.startsWith(candidate) || lowered.includes(`/${candidate}`)) return prefix
    } else if (lowered.startsWith(candidate) || lowered.includes(`/${candidate}`) || lowered.startsWith(`${candidate}.`)) {
      return prefix
    }
  }
  return null
}

/**
 * Resolve one import specifier to a project-relative path when possible.
 *
 * A relative specifier means nothing until it is resolved against the importing
 * file's directory: `src/domain/battle.js` importing `'../ui/button.js'` refers to
 * `src/ui/button.js`, which is what a `to: ['src/ui/']` rule is about. Matching the
 * raw text instead would silently pass every relative import — the exact failure
 * that makes an architecture rule look enforced while enforcing nothing.
 *
 * A bare specifier (`pixi`, `@scope/pkg`) has no project path, so it is returned
 * unchanged and rules match it as a package name.
 *
 * @param {string} specifier - the raw import specifier.
 * @param {string} importer - project-relative path of the importing file.
 * @returns {string} the resolved project-relative path, or the original specifier.
 */
export function resolveSpecifier(specifier, importer) {
  const raw = String(specifier).trim()
  if (!raw.startsWith('.')) return raw
  const directory = path.posix.dirname(toPosix(importer))
  const joined = path.posix.normalize(path.posix.join(directory, raw))
  return joined.startsWith('../') ? raw : joined
}

/**
 * Validate a rule document, reporting every problem instead of the first.
 * @param {unknown} value - candidate rule document.
 * @returns {{ rules: any[], problems: string[] }} valid rules and problems.
 */
export function validateRules(value) {
  /** @type {any[]} */
  const rules = []
  const problems = []
  const list = value !== null && typeof value === 'object' && Array.isArray(value.rules) ? value.rules : null
  if (list === null) {
    problems.push('arch.json must contain a "rules" array')
    return { rules, problems }
  }
  list.forEach((rule, index) => {
    const where = `rules[${index}]`
    if (rule === null || typeof rule !== 'object') {
      problems.push(`${where}: not an object`)
      return
    }
    if (typeof rule.id !== 'string' || rule.id.trim() === '') problems.push(`${where}: missing "id"`)
    if (rule.kind !== 'forbid-import') {
      problems.push(`${where}: unsupported kind ${JSON.stringify(rule.kind)} (only "forbid-import" is implemented)`)
      return
    }
    if (!Array.isArray(rule.from) || rule.from.length === 0) problems.push(`${where}: "from" must be a non-empty array`)
    if (!Array.isArray(rule.to) || rule.to.length === 0) problems.push(`${where}: "to" must be a non-empty array`)
    if (problems.some((problem) => problem.startsWith(where))) return
    rules.push({
      id: rule.id.trim(),
      kind: 'forbid-import',
      from: rule.from.map(String),
      to: rule.to.map(String),
      reason: typeof rule.reason === 'string' ? rule.reason : '',
    })
  })
  return { rules, problems }
}

/**
 * Run the architecture rules against a project.
 *
 * @param {{ root: string, document: any, directories?: string[], extensions?: readonly string[], maxFiles?: number }} input - check inputs.
 * @returns {{ ok: true, status: 'pass' | 'violations' | 'no-rules', violations: object[], scanned: number, problems: string[], rules: number } | { ok: false, reason: string }} the verdict.
 */
export function checkArchitecture(input) {
  const validated = validateRules(input.document)
  if (validated.rules.length === 0) {
    return {
      ok: true,
      status: 'no-rules',
      violations: [],
      scanned: 0,
      problems: validated.problems,
      rules: 0,
    }
  }
  const files = collectSourceFiles({
    root: input.root,
    directories: input.directories,
    extensions: input.extensions,
    maxFiles: input.maxFiles,
  })
  const violations = []
  for (const file of files) {
    const applicable = validated.rules.filter((rule) => matchPrefix(file.relative, rule.from) !== null)
    if (applicable.length === 0) continue
    const read = readText(file.absolute)
    if (!read.ok) continue
    for (const found of extractImports(read.text)) {
      const resolved = resolveSpecifier(found.specifier, file.relative)
      for (const rule of applicable) {
        const hit = matchPrefix(resolved, rule.to)
        if (hit === null) continue
        violations.push({
          rule: rule.id,
          reason: rule.reason,
          file: file.relative,
          line: found.line,
          specifier: found.specifier,
          resolved,
          matched: hit,
        })
      }
    }
  }
  violations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  return {
    ok: true,
    status: violations.length === 0 ? 'pass' : 'violations',
    violations,
    scanned: files.length,
    problems: validated.problems,
    rules: validated.rules.length,
  }
}

/**
 * Render a stable, diffable architecture report.
 * @param {object} result - a `checkArchitecture` result.
 * @param {{ root: string }} input - for relative paths in the header.
 * @returns {string} Markdown.
 */
export function renderArchReport(result, input) {
  const lines = ['# Architecture check', '', `Generated by dsh-project-memory for \`${input.root}\`.`, '']
  if (!result.ok) {
    lines.push(`Result: **failed to run** — ${result.reason}`)
    return lines.join('\n')
  }
  lines.push(`- Verdict: **${result.status}**`)
  lines.push(`- Rules evaluated: ${result.rules}`)
  lines.push(`- Source files scanned: ${result.scanned}`)
  lines.push(`- Violations: ${result.violations.length}`)
  if (result.problems.length > 0) {
    lines.push('', '## Rule problems', '')
    for (const problem of result.problems) lines.push(`- ${problem}`)
  }
  if (result.violations.length > 0) {
    lines.push('', '## Violations', '')
    for (const violation of result.violations) {
      lines.push(`- \`${violation.file}:${violation.line}\` imports \`${violation.specifier}\` (rule \`${violation.rule}\`${violation.reason === '' ? '' : `: ${violation.reason}`})`)
    }
  }
  lines.push('', 'This verdict is computed from source text and declared rules only; no model judgement is involved.')
  return lines.join('\n')
}
