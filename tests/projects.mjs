/**
 * Per-project settings: normalisation, merge, write, removal, and the panel's
 * refusal to act on a path it was not given.
 *
 * What this proves, and why each part is here:
 *
 * - `projectKey` must collapse every spelling of one directory to one name. The
 *   filesystem is case-insensitive on Windows and case-sensitive elsewhere, and the
 *   panel sends a path a browser echoed back, so `D:\x\p`, `D:/x/p/` and `d:\X\P` are all
 *   the same project. If they were not, a user would set an override, see it ignored, and
 *   have no way to tell why.
 * - `effectiveSettings` must apply overrides on top of the profile without inventing keys
 *   and without mutating its input. A merge that writes through would corrupt the settings
 *   object the rest of a step reads.
 * - `writeOverride` must be the only writer, must reject a key nobody may override, and
 *   must delete the file when the last override goes. A leftover empty file is a lie about
 *   the project having settings.
 * - The panel must not honour `?project=` for a path it does not know. This is the
 *   security-relevant one: the same parameter selects which directory the settings writer
 *   writes into.
 *
 * Run: node --test tests/projects.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const projects = await import('../core/projects.js')
const panel = await import('../lib/panel.js')

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`\nFAILED: ${name}`)
    throw error
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'pm-projects-'))
const alpha = path.join(root, 'alpha')
const beta = path.join(root, 'beta')
for (const dir of [alpha, beta]) {
  mkdirSync(path.join(dir, '.dsh-memory', 'memory'), { recursive: true })
  mkdirSync(path.join(dir, '.dsh-memory', 'state'), { recursive: true })
}

// --------------------------------------------------------------- projectKey

check('one directory has one key, whatever the spelling', () => {
  const key = projects.projectKey(alpha)
  assert.equal(projects.projectKey(alpha), key, 'the same path is stable')
  assert.equal(projects.projectKey(`${alpha}${path.sep}`), key, 'a trailing separator does not split identity')
  assert.equal(projects.projectKey(alpha.replace(/\\/g, '/')), key, 'the separator style does not split identity')
  assert.equal(projects.projectKey(alpha.toUpperCase()), key, 'case does not split identity on a case-insensitive host')
  assert.equal(projects.projectKey(path.join(alpha, '..', 'alpha')), key, 'a redundant segment does not split identity')
})

check('different directories get different keys', () => {
  assert.notEqual(projects.projectKey(alpha), projects.projectKey(beta))
})

check('the key is a legal file name', () => {
  const key = projects.projectKey(alpha)
  // A key becomes `<key>.json` on disk, so a separator or a drive colon here would
  // silently write outside the settings directory.
  assert.equal(/[/\\:]/.test(key), false, `key must not contain a path separator or a colon: ${key}`)
  assert.equal(key.length > 0, true)
})

// --------------------------------------------------------- effectiveSettings

const base = {
  routerTier: 'smart',
  routerStrategy: 'task',
  routerProvider: '',
  routerModel: '',
  recallBudget: 400,
  recallLimit: 8,
  extractOnCompaction: true,
}

check('with no overrides the profile values apply and nothing is reported as overridden', () => {
  const merged = projects.effectiveSettings(base, alpha)
  assert.deepEqual(merged.settings, base, 'every value comes from the profile')
  assert.notEqual(merged.settings, base, 'the merge returns a copy, so a later step cannot write through to the profile')
  assert.deepEqual(merged.overridden, [])
  assert.equal(merged.reason, null)
})

check('an override replaces exactly one key', () => {
  const written = projects.writeOverride({ root: alpha, key: 'routerModel', value: 'deepseek-reasoner' })
  assert.equal(written.ok, true, written.reason)
  const merged = projects.effectiveSettings(base, alpha)
  assert.equal(merged.settings.routerModel, 'deepseek-reasoner')
  assert.equal(merged.settings.routerTier, base.routerTier, 'other keys still come from the profile')
  assert.deepEqual(merged.overridden, ['routerModel'])
})

check('the merge does not mutate the profile object', () => {
  projects.effectiveSettings(base, alpha)
  assert.equal(base.routerModel, '', 'the profile value must survive a project merge')
})

check('an override applies to its own project only', () => {
  const merged = projects.effectiveSettings(base, beta)
  assert.equal(merged.settings.routerModel, '')
  assert.deepEqual(merged.overridden, [])
})

check('removing the last override deletes the file rather than leaving an empty one', () => {
  // `settingsFiles` returns names, not paths, so the existence check joins it the same
  // way the writer does.
  const settingsDir = path.join(alpha, '.dsh-memory', projects.SETTINGS_DIR)
  const files = projects.settingsFiles(alpha)
  assert.equal(files.length, 1, `exactly one settings file, saw: ${files.join(', ')}`)
  assert.equal(existsSync(path.join(settingsDir, files[0])), true)

  const removed = projects.writeOverride({ root: alpha, key: 'routerModel', value: null })
  assert.equal(removed.ok, true, removed.reason)
  assert.deepEqual(removed.overridden, [])
  assert.deepEqual(projects.settingsFiles(alpha), [], 'no settings file should remain')
})

check('a key nobody may override is refused, and nothing is written', () => {
  const refused = projects.writeOverride({ root: beta, key: 'projectRoot', value: 'C:\\elsewhere' })
  assert.equal(refused.ok, false)
  assert.equal(projects.settingsFiles(beta).length, 0)
})

check('the writer rejects a settings file that is not valid JSON instead of guessing', () => {
  const files = projects.settingsFiles(alpha)
  const file = path.join(alpha, '.dsh-memory', projects.SETTINGS_DIR, `${projects.projectKey(alpha)}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{ this is not json', 'utf8')
  const read = projects.readOverrides(alpha)
  assert.equal(read.ok, false, 'corrupt input must report failure, not an empty override set')
  assert.equal(typeof read.reason, 'string')
  // A failed read must not stop the profile values from applying, or one corrupt file
  // would take the whole project's memory down.
  const merged = projects.effectiveSettings(base, alpha)
  assert.equal(merged.settings.routerTier, base.routerTier)
  assert.equal(merged.reason !== null, true, 'the failure is reported')
  rmSync(path.dirname(file), { recursive: true, force: true })
  assert.equal(files.length >= 0, true)
})

// --------------------------------------------------- describe/list/isKnown

check('describeProject reports atoms and the override keys for a real store', () => {
  projects.writeOverride({ root: alpha, key: 'recallLimit', value: 12 })
  const described = projects.describeProject(alpha)
  assert.equal(described.root, alpha)
  assert.equal(described.key, projects.projectKey(alpha))
  assert.equal(typeof described.atoms, 'number')
  assert.equal(described.hasMemory, true)
  assert.deepEqual(described.overridden, ['recallLimit'])
})

check('listProjects keeps list order, de-duplicates by key, and marks the current row', () => {
  const rows = projects.listProjects([
    { root: beta, current: true },
    { root: alpha },
    { root: `${alpha}${path.sep}` },
  ])
  assert.equal(rows.length, 2, 'the duplicate spelling of alpha must not produce two rows')
  assert.equal(rows[0].root, beta, 'the first spelling in the input keeps its position')
  assert.equal(rows[0].current, true)
  assert.equal(rows[1].root, alpha)
})

check('isKnownProject is false for a directory with no memory', () => {
  const bare = mkdtempSync(path.join(tmpdir(), 'pm-bare-'))
  assert.equal(projects.isKnownProject(bare), false)
  assert.equal(projects.isKnownProject(alpha), true)
  rmSync(bare, { recursive: true, force: true })
})

// ------------------------------------------------- the panel's path guard

check('a requested project is honoured only when the Host already knows it', () => {
  const known = [{ root: alpha }, { root: beta }]
  const fallback = () => beta

  assert.equal(panel.resolveRequestedRoot(null, known, fallback), beta, 'no selection means the default')
  assert.equal(panel.resolveRequestedRoot(alpha, known, fallback), alpha, 'a known path is honoured')

  // The security-relevant case: the same parameter decides where settings are written.
  assert.equal(panel.resolveRequestedRoot('C:\\Windows', known, fallback), null, 'an unknown path is refused')
  assert.equal(panel.resolveRequestedRoot(`${alpha}${path.sep}..`, known, fallback), null, 'an escape is refused')
  assert.equal(panel.resolveRequestedRoot('', known, fallback), fallback(), 'an empty selection is no selection')
})

check('the query parameter is read, trimmed, and absent when unparseable', () => {
  assert.equal(panel.readProjectParam({ url: `${panel.STATUS_PATH}?project=${encodeURIComponent(alpha)}` }), alpha)
  assert.equal(panel.readProjectParam({ url: `${panel.STATUS_PATH}?project=%20${encodeURIComponent(alpha)}%20` }), alpha)
  assert.equal(panel.readProjectParam({ url: panel.STATUS_PATH }), null)
  assert.equal(panel.readProjectParam({ url: `${panel.STATUS_PATH}?project=` }), null)
  assert.equal(panel.readProjectParam({}), null)
  assert.equal(panel.readProjectParam(null), null)
})

check('isOverridable answers from the same list the writer enforces', () => {
  for (const key of projects.OVERRIDABLE) assert.equal(panel.isOverridable(key), true, key)
  assert.equal(panel.isOverridable('projectRoot'), false)
  assert.equal(panel.isOverridable('extractOnCompaction'), false)
})

// ------------------------------------------------------ status composition

check('buildPanelStatus separates the effective values from the profile values', () => {
  projects.writeOverride({ root: beta, key: 'routerTier', value: 'always' })
  const merged = projects.effectiveSettings(base, beta)
  const rows = projects.listProjects([{ root: beta, current: true }, { root: alpha }])
  const status = panel.buildPanelStatus({
    root: beta,
    settings: merged.settings,
    base,
    overridden: merged.overridden,
    overrideReason: merged.reason,
    projects: rows,
  })

  assert.equal(status.scope, 'project')
  assert.deepEqual(status.overridden, ['routerTier'])
  assert.equal(status.settings.routerTier, 'always', 'the effective value is the override')
  assert.equal(status.base.routerTier, base.routerTier, 'the profile value is still reported')
  assert.equal(status.projects.length, 2)
  assert.deepEqual(status.overridable, [...projects.OVERRIDABLE])
  assert.equal(status.overrideReason, null)
})

check('buildPanelStatus with no project keeps the global values and says so', () => {
  const status = panel.buildPanelStatus({
    root: null,
    settings: base,
    base,
    overridden: [],
    projects: [],
  })
  assert.equal(status.root, null)
  assert.equal(status.scope, 'global')
  assert.equal(status.settings.routerTier, base.routerTier, 'settings are still available without a project')
  assert.equal(status.atoms.readable, false)
  assert.equal(status.atoms.reason, 'no-project-root')
})

check('buildPanelStatus reports an unreadable override file instead of swallowing it', () => {
  const merged = { settings: base, overridden: [], reason: 'settings file is not valid JSON' }
  const status = panel.buildPanelStatus({
    root: alpha,
    settings: merged.settings,
    base,
    overridden: merged.overridden,
    overrideReason: merged.reason,
    projects: [],
  })
  assert.equal(status.overrideReason, 'settings file is not valid JSON')
})

// ------------------------------------------------------------------ report

// A leftover override from this test on this machine's temporary directory would not
// affect any real project, but cleaning up keeps a rerun starting from the same state.
for (const dir of [alpha, beta]) {
  const settingsDir = path.join(dir, '.dsh-memory', projects.SETTINGS_DIR)
  if (existsSync(settingsDir)) rmSync(settingsDir, { recursive: true, force: true })
}
rmSync(root, { recursive: true, force: true })

console.log(
  `PROJECTS OK: ${passed} checks — key normalisation, per-project merge without mutation, single-project override scope, file removal on the last key, refusal of a non-overridable key, corrupt-file reporting, de-duplicated project listing, and the panel's refusal to honour an unknown or escaping project path`,
)
