// Guard the bench scripts against machine-specific values before they are published.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dir = import.meta.dirname
const checks = [
  ['username', /iveri/i],
  ['literal-api-key', /API_KEY\s*[:=]\s*['"][A-Za-z0-9_-]{10,}/],
  ['sk-key', /sk-[A-Za-z0-9]{16,}/],
  ['absolute-user-path', /[A-Za-z]:\\\\?Users\\\\?/i],
  ['private-host', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/],
  ['bearer-literal', /Bearer\s+[A-Za-z0-9._-]{20,}/],
]

let problems = 0
for (const name of readdirSync(dir).sort()) {
  if (!name.endsWith('.mjs')) continue
  // Skip this file: it necessarily contains the patterns it searches for, so scanning
  // itself reports a false positive on its own regex literals.
  if (name === 'scan-secrets.mjs') continue
  const text = readFileSync(path.join(dir, name), 'utf8')
  const hits = checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
  if (hits.length > 0) problems += hits.length
  console.log(name.padEnd(26), hits.length === 0 ? 'clean' : hits.join(', '))
}
console.log(problems === 0 ? '\nCLEAN: no secrets or machine-specific paths under scripts/bench' : `\nproblems: ${problems}`)
process.exitCode = problems === 0 ? 0 : 1
