/**
 * Report translation keys the panel uses but a dictionary is missing.
 *
 * `tests/client.mjs` asserts this too, but it fails on the first missing key, which makes
 * fixing a batch of them a slow loop. This prints the whole set at once.
 *
 * Usage: node scripts/i18n-audit.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Every key passed to the bound translator. */
const used = new Set()
for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1])
// Template-literal calls such as `t(\`tier.${tier}\`)` are resolved at run time. Their
// placeholder text is not a key, so it is excluded; the concrete keys they can produce are
// enumerated below instead.
for (const match of source.matchAll(/\bt\(`([^`]+)`\)/g)) {
  if (!match[1].includes('${')) used.add(match[1])
}
// The concrete keys a placeholder call can produce.
for (const tier of ['always', 'smart', 'off']) {
  used.add(`tier.${tier}`)
  used.add(`tier.${tier}.desc`)
}
for (const strategy of ['task', 'compliance', 'orient']) {
  used.add(`strategy.${strategy}`)
  used.add(`strategy.${strategy}.desc`)
}

/** Keys defined inside one `const <name> = { … }` block. */
function keysOf(blockName) {
  const start = source.indexOf(`const ${blockName} = {`)
  if (start === -1) return new Set()
  // Find the matching closing brace at the same indentation.
  const end = source.indexOf('\n    }', start)
  const block = source.slice(start, end === -1 ? source.length : end)
  return new Set([...block.matchAll(/^\s{6}'([^']+)':/gm)].map((match) => match[1]))
}

const zh = keysOf('zh')
const en = keysOf('en')

const missing = (keys) => [...used].filter((key) => !keys.has(key)).sort()
const unused = (keys) => [...keys].filter((key) => !used.has(key)).sort()

const report = {
  used: used.size,
  zh: zh.size,
  en: en.size,
  missingZh: missing(zh),
  missingEn: missing(en),
  onlyInZh: [...zh].filter((key) => !en.has(key)).sort(),
  onlyInEn: [...en].filter((key) => !zh.has(key)).sort(),
  unusedZh: unused(zh),
}

console.log(JSON.stringify(report, null, 2))
const failed = report.missingZh.length + report.missingEn.length + report.onlyInZh.length + report.onlyInEn.length
process.exitCode = failed === 0 ? 0 : 1
