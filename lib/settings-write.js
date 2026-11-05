/**
 * Persisting one settings change from the panel.
 *
 * The only supported path is the Host's `configEditor`, which applies a change
 * through the normal Loader path. Editing `cordis.yml` directly was considered and
 * rejected: it produces a file that looks right, is not picked up until a restart,
 * and silently disagrees with the in-memory config in the meantime. A panel that
 * saves and does not take effect is worse than no panel.
 *
 * This module exists separately from `panel.js` so the write path can be tested
 * without starting an HTTP server, and so the "who may change what" decision lives
 * next to the code that performs the change.
 *
 * @module @dsh-external/dsh-project-memory/settings-write
 */

/**
 * Locate this plugin's own Loader entry.
 *
 * Matching by package name as well as id means a profile that renamed the row still
 * finds it; matching by id alone would break on a rename the user is entitled to.
 *
 * @param {any[]} entries - `configEditor.entries()`.
 * @param {string} entryId - the id from `cordis.patch.yml`.
 * @param {string} packageName - this package's name.
 * @returns {any | undefined} the matching entry.
 */
export function findEntry(entries, entryId, packageName) {
  if (!Array.isArray(entries)) return undefined
  return (
    entries.find((entry) => entry?.id === entryId) ?? entries.find((entry) => entry?.name === packageName)
  )
}

/**
 * Write one setting through the Host's config editor.
 *
 * The change is applied as a minimal delta rather than a rewrite of the whole
 * config block: replacing the block wholesale would silently drop keys this version
 * of the plugin does not know about, which is how a settings panel corrupts a
 * config written by a newer version.
 *
 * @param {{
 *   ctx: any,
 *   entryId: string,
 *   key: string,
 *   value: string,
 *   logger: { warn: (line: string) => void },
 *   settings?: any,
 *   packageName?: string,
 * }} input - what to write and where.
 * @returns {Promise<void>} resolves once the Loader has applied the change.
 */
export async function writeSetting(input) {
  const editor = input.ctx?.configEditor
  if (editor === undefined || editor === null) {
    // A profile without `configEditor` cannot persist a change. Saying so is the
    // whole point: reporting success here would leave the user with a saved-looking
    // panel and unchanged behaviour.
    throw new Error('this profile does not expose configEditor, so the panel cannot save settings')
  }
  const packageName = input.packageName ?? '@dsh-external/dsh-project-memory'
  const entry = findEntry(editor.entries(), input.entryId, packageName)
  if (entry === undefined) {
    throw new Error(`cannot find this plugin's configuration entry (id "${input.entryId}", name "${packageName}")`)
  }
  await editor.edit(entry, (current) => ({ ...current, [input.key]: input.value }))
  input.logger.info(`panel saved ${input.key}`)
}
