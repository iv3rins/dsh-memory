/**
 * Print one file out of app.asar, optionally a line range.
 *
 * Usage: node scripts/asar-read.mjs <path-in-asar> [fromLine] [toLine]
 */

import { openSync, readSync, closeSync } from 'node:fs'
import { requireAsar } from './asar-locate.mjs'

const ASAR = requireAsar()

function index() {
  const fd = openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    const tree = JSON.parse(json.toString('utf8'))
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

const target = process.argv[2]
const from = Number(process.argv[3] ?? 1)
const to = Number(process.argv[4] ?? 0)

const { files, base } = index()
const entry = files.get(target)
if (entry === undefined) {
  console.log(`not found: ${target}`)
  const similar = [...files.keys()].filter((path) => path.includes(target.split('/').pop() ?? '')).slice(0, 15)
  for (const name of similar) console.log(`  did you mean: ${name}`)
  process.exit(1)
}

const fd = openSync(ASAR, 'r')
let text
try {
  const buffer = Buffer.alloc(entry.size)
  readSync(fd, buffer, 0, entry.size, base + entry.offset)
  text = buffer.toString('utf8')
} finally {
  closeSync(fd)
}

const lines = text.split('\n')
const end = to > 0 ? Math.min(to, lines.length) : lines.length
for (let index = from - 1; index < end; index += 1) {
  console.log(`${index + 1}: ${lines[index]}`)
}
