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
 * Read `configEditor` from a context that may not have declared it.
 *
 * In Cordis, reading a service the context has not declared in `inject` *throws*
 *
 *     cannot get property "configEditor" without inject
 *
 * rather than returning `undefined`. So `ctx?.configEditor` is not a null check: it is
 * the throw itself, and the careful message below it never ran. A user saw a stack trace
 * from the framework instead of the sentence written to help them, on the one path whose
 * whole purpose is to report why a save did not happen.
 *
 * @param {any} ctx - the context that may or may not carry configEditor.
 * @returns {any | undefined} the editor, or undefined when this context cannot reach it.
 */
export function editorOrUndefined(ctx) {
  try {
    return ctx?.configEditor
  } catch {
    return undefined
  }
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
  const editor = editorOrUndefined(input.ctx)
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
