/**
 * The single place where dsh-project-memory imports the DeepSeek Harness.
 *
 * Everything else in the plugin (core/**) is plain Node so it can be tested with
 * `node --test`. Only this module and the files that use it depend on the host.
 *
 * These are **static** imports on purpose, matching every working external plugin
 * in this environment (`@dsh-external/dsh-blender-plugin` imports
 * `@deepseek-ai/dsh-tools` the same way): the harness resolves a plugin's
 * `peerDependencies` from the running application, so a plain import binds to the
 * host's own copy. A runtime-resolution dance was tried first and abandoned — it
 * could not see the host modules from a `link:`ed plugin directory, which turned a
 * load-time contract into a silent feature loss.
 *
 * `schemastery`, `cordis`, and `@deepseek-ai/cordis` exist under both scoped and
 * unscoped names across DSH versions; both are declared as optional peer
 * dependencies, and this plugin only needs the standard-schema shape for `Config`,
 * which it builds itself, so neither spelling is imported here.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Build a config validator without depending on schemastery.
 *
 * Cordis calls `Config['~standard'].validate(raw)` and rejects the plugin when
 * issues are reported. A plain normalizer is enough: `normalizeConfig` never
 * fails, so a malformed config degrades features instead of preventing a memory
 * plugin from loading onto a long-lived project.
 *
 * @param {(raw: unknown) => any} normalize - the normalizer.
 * @returns {{ '~standard': { version: 1, vendor: string, validate: (raw: unknown) => { value: any } } }} the validator.
 */
export function createConfigValidator(normalize) {
  return {
    '~standard': {
      version: /** @type {const} */ (1),
      vendor: 'dsh-project-memory',
      validate(raw) {
        return { value: normalize(raw) }
      },
    },
  }
}

/**
 * The message factory, re-exported so callers do not import the harness directly.
 * @type {(input: any) => any}
 */
export const createUserMessageExport = createUserMessage

/**
 * Check that this module actually bound to a usable harness.
 *
 * Called at mount time so a broken install produces one readable error instead of a
 * plugin that registers nothing.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }} the verdict.
 */
export function verifyHarness() {
  if (typeof createUserMessage !== 'function') {
    return { ok: false, reason: '@deepseek-ai/dsh-llm did not export createUserMessage' }
  }
  return { ok: true }
}
