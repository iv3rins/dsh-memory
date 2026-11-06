/**
 * Read the host's client bundle out of app.asar and search it.
 *
 * The asar format is a small header: a UInt32 pickle header, then a JSON directory.
 * Previously this was reported as unreadable, so the panel's slot contract had to be
 * inferred. Being able to read it means the "how do I leave a main panel" question can be
 * answered from the host's own code instead of guessed.
 *
 * Usage: node scripts/asar-find.mjs <regex>
 */

import { openSync, readSync, closeSync } from 'node:fs'
import { requireAsar } from './asar-locate.mjs'

const ASAR = requireAsar()

/**
 * Read the asar directory index.
 * @returns {Map<string, { offset: number, size: number }>} path → payload location.
 */
function readIndex() {
  const fd = openSync(ASAR, 'r')
  try {
    // 16-byte pickle header: 4 unused, 4 header-size, 4 payload-size, 4 json-size.
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    const tree = JSON.parse(json.toString('utf8'))
    // File payloads start after the header plus the aligned JSON block.
    const base = 16 + head.readUInt32LE(8)
    const files = new Map()
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const path = prefix === '' ? name : `${prefix}/${name}`
        if (value.files !== undefined) walk(value, path)
        else files.set(path, { offset: Number(value.offset), size: value.size })
      }
    }
    walk(tree, '')
    return { files, base }
  } finally {
    closeSync(fd)
  }
}

/**
 * Read one file out of the archive.
 * @param {number} base - payload base offset.
 * @param {{ offset: number, size: number }} entry - the file entry.
 * @returns {string} its contents.
 */
function readFile(base, entry) {
  const fd = openSync(ASAR, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    readSync(fd, buffer, 0, entry.size, base + entry.offset)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const pattern = process.argv[2]
if (pattern === undefined) {
  const { files } = readIndex()
  console.log(`${files.size} files in the archive`)
  const names = [...files.keys()].filter((path) => /client|web|render/i.test(path)).slice(0, 40)
  for (const name of names) console.log(`  ${name}`)
  process.exit(0)
}

const { files, base } = readIndex()
const regex = new RegExp(pattern, 'i')
let total = 0
for (const [path, entry] of files) {
  if (!/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(path)) continue
  if (entry.size > 4_000_000) continue
  let text
  try {
    text = readFile(base, entry)
  } catch {
    continue
  }
  const lines = text.split('\n')
  const hits = []
  for (let index = 0; index < lines.length; index += 1) {
    if (regex.test(lines[index])) hits.push(`${index + 1}: ${lines[index].trim().slice(0, 220)}`)
  }
  if (hits.length === 0) continue
  total += hits.length
  console.log(`\n=== ${path} (${hits.length} hit(s)) ===`)
  for (const hit of hits.slice(0, 12)) console.log(`  ${hit}`)
}
console.log(`\n${total} matching line(s)`)
