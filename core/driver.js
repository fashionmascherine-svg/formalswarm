'use strict'
/*
 * driver.js — run the ONE FormalSwarm body on a runtime that has no `workflow`
 * tool (Claude Code, ZCode, a plain shell), without touching the body.
 *
 * The body in `debate.workflow.js` is written against the primitives of the
 * DeepSeek Harness `workflow` tool (agent / parallel / pipeline / phase / log).
 * This driver supplies those primitives and executes the SAME body, byte for
 * byte (read + strip of the header comment, exactly like the validators). The
 * only difference between the runtimes is WHO executes the agent calls:
 *
 *   - DeepSeek Harness: the `workflow` tool spawns the subagents inside the run;
 *   - Claude Code / ZCode: the body runs to the end (missing callers receive a
 *     placeholder), the driver writes the pending prompts to
 *     <dir>/<label>@<PHASE>.prompt.txt, the orchestrator executes them with the
 *     runtime's subagent tool, stores each answer with `save`, and re-runs the
 *     driver. On the following rounds the body receives the real results in
 *     place of the placeholders; the complete round writes
 *     <dir>/outcome.json holding the deterministic rollup of the single body —
 *     so all three runtimes compute the same verdict from the same logic.
 *
 * Semantics of agent() are identical to DeepSeek Harness: an object conformant to
 * the schema, or null = the agent fell. Conformance is judged by the SCHEMA OF
 * THE BODY, extracted at runtime from the body text itself (the same file that
 * runs on DeepSeek Harness): drift between the driver boundary and the body
 * schemas is impossible by construction. A missing result file = a pending call
 * (placeholder + prompt written); a file that exists but is not conformant,
 * malformed, or a <label>@<PHASE>.FALLEN.json marker = a fallen agent (null + a
 * warning). Fail-closed: a placeholder never reaches the final outcome.
 *
 * Nothing here is repository-specific: the body receives the target repository
 * through `args.profile`, so unlike a per-platform adapter there is no path
 * rewriting and no hard-coded root.
 *
 * Folder-to-brief binding: the CLI writes run_id.json (= hash of args + body) and
 * REFUSES to run on a folder signed by a different debate (exit 1): the results
 * of one brief can never be consumed by another. Result files are keyed
 * <label>@<PHASE>, so the same label in SYNTHESIS and SYNTHESIS-2 (rounds=3)
 * cannot collide on disk.
 *
 * Exit codes of the CLI (`formalswarm run`):
 *   0 = debate complete: outcome in <dir>/outcome.json
 *   2 = intermediate round: execute the entries with prompt_final=true in
 *       <dir>/pending.json (prompts of upstream callers are marked
 *       prompt_final=false: they were built on placeholders, do NOT run them)
 *   1 = error (invalid args, failed body, missing file, folder of another brief)
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const BODY_PATH = path.join(__dirname, 'debate.workflow.js')
const BODY_TEXT = fs.readFileSync(BODY_PATH, 'utf8')
const body = BODY_TEXT.replace(/^\/\*[\s\S]*?\*\//, '')

/* ── schemas extracted from the BODY (not duplicated: one source of truth) ── */
const extractSchemas = (text) => {
  const schemas = {}
  const re = /const (schema[A-Za-z0-9_]+) =/g
  let match
  while ((match = re.exec(text)) !== null) {
    const start = text.indexOf('{', match.index + match[0].length)
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) throw new Error('schema ' + match[1] + ' in the body is not balanced')
    schemas[match[1]] = new Function('return (' + text.slice(start, end + 1) + ')')()
  }
  return schemas
}
const SCHEMAS = extractSchemas(BODY_TEXT)
/** label prefix -> schema name. Order matters: the longest prefixes come first. */
const ROLE_SCHEMAS = [
  ['critic2-', 'schemaObjections'],
  ['critic-', 'schemaObjections'],
  ['synthesis-', 'schemaSynthesis'],
  ['thesis-', 'schemaThesis'],
  ['seal-', 'schemaVerdict'],
]
const schemaFor = (label) => {
  const entry = ROLE_SCHEMAS.filter((p) => label.indexOf(p[0]) === 0)[0]
  if (!entry) throw new Error('label without a known role: ' + label)
  const schema = SCHEMAS[entry[1]]
  if (!schema) throw new Error('schema ' + entry[1] + ' not found in the body')
  return schema
}

/* Mini-validator over the subset the body schemas use (type/enum/required/
 * properties/items/additionalProperties) — the boundary the tool applies on
 * DeepSeek Harness. */
const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number',
}
const validate = (schema, value) => {
  if (schema.enum) return schema.enum.indexOf(value) >= 0 ? [] : ['value outside enum (' + JSON.stringify(value) + ' in ' + JSON.stringify(schema.enum) + ')']
  const type = schema.type
  if (type && TYPES[type] && !TYPES[type](value)) return ['expected type ' + type + ', received ' + (value === null ? 'null' : typeof value)]
  const defects = []
  if (type === 'object' && TYPES.object(value)) {
    ;(schema.required || []).forEach((k) => { if (value[k] === undefined) defects.push('missing required field: ' + k) })
    if (schema.additionalProperties === false && schema.properties) {
      // hasOwnProperty, not truthiness: a field named after an Object.prototype
      // member (constructor, toString, valueOf, …) would otherwise slip through here
      // while the real JSON-schema validator rejects it — and the two runtimes would
      // then disagree on the same payload.
      Object.keys(value).forEach((k) => {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) defects.push('field not allowed by the schema: ' + k)
      })
    }
    Object.keys(schema.properties || {}).forEach((k) => {
      if (value[k] !== undefined) defects.push.apply(defects, validate(schema.properties[k], value[k]).map((d) => k + ': ' + d))
    })
  }
  if (type === 'array' && TYPES.array(value) && schema.items) {
    value.forEach((v, i) => { defects.push.apply(defects, validate(schema.items, v).map((d) => '[' + i + ']: ' + d)) })
  }
  return defects
}
const conformant = (label, object) => validate(schemaFor(label), object)

const extractJson = (text) => {
  const start = String(text).indexOf('{')
  const end = String(text).lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(String(text).slice(start, end + 1)) } catch (e) { return null }
}

/** Placeholder answers: schema-shaped so the body can run to the end of the round. */
const placeholder = (label) => {
  if (label.indexOf('thesis-') === 0) return { id: label, thesis: 'PLACEHOLDER (intermediate driver round)', findings: [], risks: [], proof_measure: 'PLACEHOLDER' }
  if (label.indexOf('critic-') === 0 || label.indexOf('critic2-') === 0) return { objections: [] }
  if (label.indexOf('synthesis-') === 0) return { revised_thesis: 'PLACEHOLDER', responses: [] }
  if (label.indexOf('seal-') === 0) return { checks: [], verdict: 'INCONCLUSIVE', measurement_limit: 'PLACEHOLDER', rationale: 'PLACEHOLDER (intermediate round)', empty: 'yes' }
  throw new Error('label without a placeholder: ' + label)
}

/**
 * On-disk key: <label>@<PHASE> — the same label in two phases never collides.
 *
 * Labels and phases become file names, so they are held to a safe alphabet: a
 * mistyped or hostile label must never be able to walk out of the result folder.
 * `..` is rejected outright, and the containment check in `fileIn` is the second
 * line of defence.
 */
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const keyPart = (value, what) => {
  const text = String(value)
  if (!SAFE_PART.test(text) || text.indexOf('..') >= 0) {
    throw new Error('unsafe ' + what + ' ' + JSON.stringify(text) + ': only letters, digits, dot, dash and underscore are allowed')
  }
  return text
}
const key = (label, phase) => keyPart(label, 'label') + ((phase && phase !== '?') ? '@' + keyPart(phase, 'phase') : '')

/** One artefact path, refused if it would resolve outside the result folder. */
const fileIn = (dir, label, phase, suffix) => {
  const base = path.resolve(dir)
  const target = path.resolve(base, key(label, phase) + suffix)
  if (target !== base && target.indexOf(base + path.sep) !== 0) {
    throw new Error('refusing to touch ' + target + ': it resolves outside the result folder ' + base)
  }
  return target
}

/**
 * Resolver over a folder: <key>.FALLEN.json present -> fallen agent (null, the
 * same semantics DeepSeek Harness has for a failing subagent: the body records it
 * among the fallen and dead phases are INCONCLUSIVE); <key>.json present and
 * conformant to the body schema -> ok; absent -> pending (the prompt is written or
 * overwritten into <key>.prompt.txt: the last written version is always the one
 * built on real upstream results); present but non-conformant -> fallen (the fall
 * is declared by the artefact itself; the orchestrator can repair it by
 * overwriting the file with a good result, or by writing the FALLEN marker).
 */
const createResolver = (dir, warn) => {
  const note = warn || ((m) => console.error('[formalswarm] ' + m))
  return (label, prompt, opts) => {
    const o = opts || {}
    const k = key(label, o.phase)
    const file = fileIn(dir, label, o.phase, '.json')
    const fileFallen = fileIn(dir, label, o.phase, '.FALLEN.json')
    if (fs.existsSync(fileFallen)) return { status: 'fallen' }
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(fileIn(dir, label, o.phase, '.prompt.txt'), String(prompt), 'utf8')
      return { status: 'pending' }
    }
    let value
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
      note(label + ' [' + (o.phase || '?') + ']: result file is not valid JSON (' + e.message + '): agent fallen')
      return { status: 'fallen' }
    }
    const defects = conformant(label, value)
    if (defects.length > 0) {
      note(label + ' [' + (o.phase || '?') + ']: result does not conform to the body schema (' + defects.slice(0, 3).join('; ') + (defects.length > 3 ? '; …' : '') + '): agent fallen')
      return { status: 'fallen' }
    }
    return { status: 'ok', value: value }
  }
}

/** Execute the body with the given resolver. Returns { outcome, pending }. */
function run(args, resolve, logFn) {
  const pending = []
  let placeholderUsed = false // a placeholder has already been served in this run
  const placeholderBeforePhase = {} // per phase: a prompt is final only if everything upstream is real
  const log = logFn || (() => {})
  const hooks = {
    args: args,
    agent: (prompt, opts) => {
      const o = opts || {}
      if (!o.label) throw new Error('agent call without a label: the driver matches results by label ONLY')
      return Promise.resolve(resolve(o.label, prompt, o)).then((result) => {
        if (result && result.status === 'ok') return result.value
        if (result && result.status === 'fallen') return null // DeepSeek Harness parity: a fallen agent -> the body records it
        const isFinal = !placeholderBeforePhase[o.phase || '?'] // per-item no: a whole PHASE starts from the same state
        pending.push({ label: o.label, phase: o.phase || '?', reason: 'waiting to be executed', prompt_final: isFinal })
        placeholderUsed = true
        return placeholder(o.label)
      })
    },
    // Faithful to the real runtime (the same semantics the validators exercise): a
    // thunk that throws resolves to null per item, and the run continues.
    parallel: (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: (items, ...stages) => stages.reduce((p, s) => p.then((out) => Promise.all(out.map((it, i) => s(it, it, i)))), Promise.resolve(items)),
    phase: (t) => {
      placeholderBeforePhase[t] = placeholderUsed
      log('=== PHASE ' + t + ' ===')
    },
    log: (m) => log('[formalswarm] ' + m),
  }
  const fn = new Function(...Object.keys(hooks), 'return (async () => {' + body + '})()')
  return fn.apply(null, Object.values(hooks)).then((outcome) => ({ outcome: outcome, pending: pending }))
}

/** Store one subagent answer after validating it against the body schema. */
const save = (label, rawText, dir, phase) => {
  const value = extractJson(rawText)
  if (!value) return { ok: false, reason: 'no JSON object found in the subagent output' }
  let defects = []
  try { defects = conformant(label, value) } catch (e) { return { ok: false, reason: e.message } }
  if (defects.length > 0) return { ok: false, reason: 'does not conform to the body schema: ' + defects.slice(0, 3).join('; ') }
  let file
  try { file = fileIn(dir, label, phase, '.json') } catch (e) { return { ok: false, reason: e.message } }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return { ok: true, path: file }
}

/** Declare a subagent fallen (crash, unrecoverable output): the body sees null. */
const saveFallen = (label, reason, dir, phase) => {
  let file
  try { file = fileIn(dir, label, phase, '.FALLEN.json') } catch (e) { return { ok: false, reason: e.message } }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ fallen: true, reason: reason || 'subagent fallen' }, null, 2), 'utf8')
  return { ok: true, path: file }
}

/** Stable signature of one brief: args + body. Binds a folder to one debate. */
const runId = (args) => crypto.createHash('sha256').update(JSON.stringify(args)).update(body).digest('hex').slice(0, 16)

module.exports = {
  BODY_PATH: BODY_PATH,
  BODY_TEXT: BODY_TEXT,
  body: body,
  SCHEMAS: SCHEMAS,
  ROLE_SCHEMAS: ROLE_SCHEMAS,
  schemaFor: schemaFor,
  validate: validate,
  conformant: conformant,
  extractJson: extractJson,
  placeholder: placeholder,
  key: key,
  fileIn: fileIn,
  createResolver: createResolver,
  run: run,
  save: save,
  saveFallen: saveFallen,
  runId: runId,
}
