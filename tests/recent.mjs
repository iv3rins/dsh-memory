/**
 * The persisted "which project was I just in" record.
 *
 * Why this test exists: the panel's root resolver used to depend entirely on process
 * memory. After a host restart it answered `no-project-root` while the project it should
 * have been reading was sitting on disk with a full atom store — the one failure mode
 * that makes working memory look lost. This test pins the three properties that fix it:
 * the record survives a fresh read, it is ordered most-recent-first, and a broken file
 * degrades to "no record" rather than to an exception.
 *
 * Everything writes into a temporary directory, never into the user's real `~/.dsh`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const {
  MAX_RECENT,
  RECENT_SCHEMA,
  noteRecentProject,
  readRecentProjects,
  recentProjectsFile,
  resolveHome,
} = await import('../lib/recent-projects.js')

const sandbox = mkdtempSync(path.join(tmpdir(), 'pm-recent-'))
const file = path.join(sandbox, 'recent-projects.json')

try {
  // --- 1. Home resolution follows the harness, not a guess. ---
  {
    assert.equal(resolveHome({ DSH_HOME: 'D:\\custom\\home' }, () => 'C:\\Users\\x'), path.resolve('D:\\custom\\home'), 'an explicit $DSH_HOME wins')
    assert.equal(resolveHome({ DSH_HOME: '   ' }, () => path.join('C:', 'Users', 'x')), path.resolve(path.join('C:', 'Users', 'x', '.dsh')), 'a whitespace-only override is treated as unset, never as the cwd')
    assert.equal(resolveHome({}, () => path.join('C:', 'Users', 'x')), path.resolve(path.join('C:', 'Users', 'x', '.dsh')), 'the default is ~/.dsh')
    assert.equal(
      path.basename(recentProjectsFile({ env: { DSH_HOME: sandbox } })),
      'recent-projects.json',
      'the record lives under the harness home',
    )
    assert.equal(
      path.dirname(recentProjectsFile({ env: { DSH_HOME: sandbox } })).startsWith(sandbox),
      true,
      'and never inside a project directory',
    )
  }

  // --- 2. A missing file is an empty list, not an error. ---
  assert.deepEqual(readRecentProjects({ file }), [], 'an absent record reads as no history')

  // --- 3. Recording is ordered, de-duplicated, and capped. ---
  {
    const first = noteRecentProject(path.join(sandbox, 'alpha'), { file })
    assert.equal(first.wrote, true, 'the first root is written')
    assert.deepEqual(readRecentProjects({ file }), [path.resolve(path.join(sandbox, 'alpha'))], 'and reads back')

    noteRecentProject(path.join(sandbox, 'beta'), { file })
    assert.deepEqual(
      readRecentProjects({ file }).map((root) => path.basename(root)),
      ['beta', 'alpha'],
      'the newest root comes first',
    )

    // Re-noting an existing root moves it up instead of duplicating it: a list with the
    // same project twice would spend a slot that another project needs.
    const again = noteRecentProject(path.join(sandbox, 'alpha'), { file })
    assert.equal(again.wrote, true, 'moving an existing root to the front is a write')
    assert.deepEqual(
      readRecentProjects({ file }).map((root) => path.basename(root)),
      ['alpha', 'beta'],
      'and it is not duplicated',
    )

    // Noting the root that is already first is the steady state on every step, so it must
    // not touch the disk — otherwise every step rewrites a file in the user's home.
    const noop = noteRecentProject(path.join(sandbox, 'alpha'), { file })
    assert.equal(noop.wrote, false, 'noting the current root performs no write')

    for (let index = 0; index < MAX_RECENT + 5; index += 1) {
      noteRecentProject(path.join(sandbox, `project-${index}`), { file })
    }
    assert.equal(readRecentProjects({ file }).length, MAX_RECENT, 'the list is capped')

    const empty = noteRecentProject('', { file })
    assert.equal(empty.ok, false, 'an empty root is refused')
    assert.equal(empty.reason, 'empty-root', 'and says why')

    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'))
    assert.equal(raw.schema, RECENT_SCHEMA, 'the file carries a schema version for future migration')
  }

  // --- 4. A corrupt record degrades to "no history", and is quarantined, not reused. ---
  {
    writeFileSync(file, '{ this is not json', 'utf8')
    assert.deepEqual(readRecentProjects({ file }), [], 'a corrupt record reads as no history')
    // `readJson` renames the damaged file aside; the caller must still be able to write a
    // fresh one, or a single bad byte would disable the fallback permanently.
    const recovered = noteRecentProject(path.join(sandbox, 'gamma'), { file })
    assert.equal(recovered.ok, true, 'a fresh record can be written over a corrupt one')
    assert.deepEqual(
      readRecentProjects({ file }).map((root) => path.basename(root)),
      ['gamma'],
      'and reads back cleanly',
    )
  }

  // --- 5. A wrong-shaped document is rejected without inventing entries. ---
  {
    writeFileSync(file, JSON.stringify({ schema: 1, roots: 'not-an-array' }), 'utf8')
    assert.deepEqual(readRecentProjects({ file }), [], 'a non-array `roots` is no history')
    writeFileSync(file, JSON.stringify({ schema: 1, roots: ['', 42, null, path.join(sandbox, 'delta')] }), 'utf8')
    assert.deepEqual(
      readRecentProjects({ file }).map((root) => path.basename(root)),
      ['delta'],
      'non-string and empty entries are dropped rather than rendered',
    )
  }

  // --- 6. An unwritable location is reported, not thrown. ---
  {
    const missingParent = path.join(sandbox, 'nope', 'deep', 'recent.json')
    mkdirSync(path.join(sandbox, 'nope'), { recursive: true })
    // Point the path at an existing *file* used as a directory: the write must fail and
    // report, because a read-only home must never be able to break a session.
    const blocker = path.join(sandbox, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const failed = noteRecentProject(path.join(sandbox, 'epsilon'), { file: path.join(blocker, 'recent.json') })
    assert.equal(failed.ok, false, 'an unwritable path reports failure')
    assert.equal(Array.isArray(failed.roots), true, 'and still returns the in-memory list')
    assert.deepEqual(readRecentProjects({ file: missingParent }), [], 'reading an impossible path is no history')
  }

  console.log('RECENT OK: the recency record survives a restart, stays ordered, de-duplicated and capped, and a corrupt or unwritable file degrades to no history instead of throwing')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
