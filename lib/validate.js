/**
 * Argument validation for tools registered through `ctx.tools.register`.
 *
 * The harness has two registration paths with different guarantees:
 *
 * - `defineTool()` compiles an author-facing schema and wraps `execute` so every
 *   call is validated before the body runs.
 * - `ctx.tools.register()` — the path this plugin uses, because the author DSL is
 *   not available to a plain-JavaScript plugin — asserts that the *schema* is in the
 *   enforced subset, but it does **not** validate the arguments it receives.
 *
 * So a tool that declares `query: { type: 'string' }` and is called with
 * `{ query: 12345 }` reaches the body with a number. Without a check here, the
 * declaration would be a comment: `String(12345)` silently becomes a search term
 * and the caller gets "no documents match 12345" instead of "query must be a
 * string". This module makes the declaration binding.
 *
 * The supported keywords are exactly the ones the harness's enforced subset
 * permits and this plugin uses — `type`, `required`, `additionalProperties`,
 * `properties`, `items`, `enum`, `const` — so there is no third validation dialect
 * to keep in sync.
 *
 * Pure Node; no DSH import.
 */

/** Scalar types this validator understands. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/**
 * Describe a value's JSON type for an error message.
 * @param {unknown} value - the value.
 * @returns {string} a short type name.
 */
function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * Validate a value against one schema node.
 *
 * @param {any} schema - raw JSON Schema node in the enforced subset.
 * @param {unknown} value - the candidate value.
 * @param {string} where - path used in messages.
 * @param {string[]} problems - collected problems.
 * @returns {void}
 */
function checkNode(schema, value, where, problems) {
  if (schema === null || typeof schema !== 'object') return
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => {
      const collected = []
      checkNode(branch, value, where, collected)
      return collected
    })
    if (!branches.some((collected) => collected.length === 0)) {
      problems.push(`${where} must match exactly one allowed shape`)
    }
    return
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    problems.push(`${where} must be ${JSON.stringify(schema.const)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${where} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
    return
  }
  const type = schema.type
  if (typeof type !== 'string') return

  if (SCALAR_TYPES.has(type)) {
    const actual = typeName(value)
    const ok = type === 'integer'
      ? actual === 'integer'
      : type === 'number'
        ? actual === 'number' || actual === 'integer'
        : actual === type
    if (!ok) {
      problems.push(`${where} must be a ${type}, received ${actual}`)
      return
    }
    return
  }

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${where} must be an object, received ${typeName(value)}`)
      return
    }
    const properties = schema.properties ?? {}
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) problems.push(`${where}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) problems.push(`${where}.${key} is not an accepted argument`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) checkNode(child, value[key], `${where}.${key}`, problems)
    }
    return
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      problems.push(`${where} must be an array, received ${typeName(value)}`)
      return
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => checkNode(schema.items, item, `${where}[${index}]`, problems))
    }
  }
}

/**
 * Validate tool arguments against a declared parameter schema.
 *
 * Absent optional arguments are left alone: a model that simply omits `limit`
 * is behaving correctly, and only a present-but-wrong value is an error.
 *
 * @param {any} schema - the tool's `parameters` schema.
 * @param {unknown} args - the arguments the model supplied.
 * @returns {string[]} problems; empty means the arguments are acceptable.
 */
export function validateArguments(schema, args) {
  const problems = []
  const root = args === undefined ? {} : args
  checkNode(schema, root, 'arguments', problems)
  return problems
}

/**
 * Wrap a tool body so declared arguments are enforced before the body runs.
 *
 * A rejection is thrown as a normal `Error` whose message lists every problem, so
 * the model sees what to fix instead of a generic failure: the harness turns a
 * thrown error into an error result with the message attached.
 *
 * @param {any} schema - the tool's `parameters` schema.
 * @param {(args: any, exec: any) => Promise<any>} body - the operation.
 * @returns {(args: any, exec: any) => Promise<any>} a validated operation.
 */
export function withArgumentValidation(schema, body) {
  return async (args, exec) => {
    const problems = validateArguments(schema, args)
    if (problems.length > 0) {
      throw new Error(`invalid arguments: ${problems.join('; ')}`)
    }
    return body(args === undefined ? {} : args, exec)
  }
}
