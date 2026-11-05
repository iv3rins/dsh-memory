/**
 * Remove dictionary keys that nothing references.
 *
 * The client test asserts the dictionary cannot rot, which is the right rule: a stale key
 * is a promise nothing keeps. After a UI rewrite some old keys genuinely have no home any
 * more, and the honest fix is to delete them rather than to re-wire them into a page that
 * does not need them.
 *
 * Usage: node scripts/prune-i18n.mjs   (dry run)
 *        node scripts/prune-i18n.mjs --write
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'client.js')
const write = process.argv.includes('--write')
const source = readFileSync(file, 'utf8')

/** Keys the click handler actually asks for, including placeholder-produced ones. */
const used = new Set()
for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1])
for (const match of source.matchAll(/\bt\(`([^`]+)`\)/g)) {
  if (!match[1].includes('${')) used.add(match[1])
}
for (const tier of ['always', 'smart', 'off']) {
  used.add(`tier.${tier}`)
  used.add(`tier.${tier}.desc`)
}
for (const strategy of ['task', 'compliance', 'orient']) {
  used.add(`strategy.${strategy}`)
  used.add(`strategy.${strategy}.desc`)
}

/**
 * Delete unused entries from one `const <name> = { … }` dictionary.
 *
 * Bounded by the block's own closing brace, so a key with the same name in the other
 * dictionary is untouched.
 */
function pruneBlock(text, blockName) {
  const start = text.indexOf(`const ${blockName} = {`)
  if (start === -1) throw new Error(`${blockName}: dictionary not found`)
  const end = text.indexOf('\n    }', start)
  if (end === -1) throw new Error(`${blockName}: dictionary end not found`)
  const block = text.slice(start, end)
  const removed = []
  const kept = block
    .split('\n')
    .filter((line) => {
      const match = /^\s{6}'([^']+)':/.exec(line)
      if (match === null) return true
      if (used.has(match[1])) return true
      removed.push(match[1])
      return false
    })
    .join('\n')
  return { text: `${text.slice(0, start)}${kept}${text.slice(end)}`, removed }
}

const zh = pruneBlock(source, 'zh')
const en = pruneBlock(zh.text, 'en')
const removed = [...new Set([...zh.removed, ...en.removed])].sort()

console.log(`${removed.length} unused key(s)${write ? '' : ' (dry run)'}:`)
for (const key of removed) console.log(`  ${key}`)

if (write) {
  writeFileSync(file, en.text, 'utf8')
  console.log('written')
}
