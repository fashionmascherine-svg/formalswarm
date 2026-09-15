'use strict'
/*
 * brief.js — build the `args` object a debate runs on, from the repository
 * profile plus the role prompts.
 *
 * This is the module that removes the biggest source of wasted agent calls in a
 * multi-agent protocol: hand-assembled briefs. `buildArgs()` produces exactly
 * the object the body expects — profile embedded, prompts embedded verbatim,
 * context and seal plan already validated — so the orchestrator pastes one
 * artefact instead of copying five files by hand.
 *
 * The META block is PARSED from the body's header comment rather than restated
 * here: one source of truth, so the workflow tool's metadata can never drift
 * from the body it describes.
 */

const fs = require('node:fs')
const path = require('node:path')
const profiles = require('./profile.js')

const ROOT = path.join(__dirname, '..')
const PROMPTS_DIR = path.join(ROOT, 'prompts')
const ROLES = ['orchestrator', 'thesis', 'antithesis', 'seal']

const isText = (v) => typeof v === 'string' && v.trim().length > 0

/** The body text, header comment included. */
const readBodyFile = () => fs.readFileSync(path.join(__dirname, 'debate.workflow.js'), 'utf8')

/** The body text with the header comment stripped: what the runtimes execute. */
const readBodySource = () => readBodyFile().replace(/^\/\*[\s\S]*?\*\//, '')

/**
 * Scaling limits are READ FROM THE BODY rather than restated here: the same numbers
 * the runtime enforces are the numbers the brief warns about, so they cannot drift.
 */
const BODY_TEXT = readBodyFile()
const bodyNumber = (name, fallback) => {
  const match = BODY_TEXT.match(new RegExp('const ' + name + ' = (\\d+)'))
  return match ? Number(match[1]) : fallback
}
const MAX_GROUP = bodyNumber('MAX_GROUP', 500)
const DEFAULT_MAX_CALLS = bodyNumber('DEFAULT_MAX_CALLS', 15)
const MAX_ROUNDS = 3

/** One role prompt, verbatim and unsubstituted. */
function readPrompt(role) {
  if (ROLES.indexOf(role) < 0) throw new Error('unknown role "' + role + '" (known: ' + ROLES.join(', ') + ')')
  return fs.readFileSync(path.join(PROMPTS_DIR, role + '.md'), 'utf8')
}

/** Every role prompt. */
const readPrompts = () => ROLES.reduce((acc, role) => { acc[role] = readPrompt(role); return acc }, {})

/**
 * Substitute the profile placeholders in a prompt. This is the ONLY substitution
 * point: the body does the same thing for the prompts it embeds, so a prompt read
 * directly from disk and a prompt read inside a run carry the same facts.
 */
function fill(text, profile, scratchOverride) {
  const scratch = isText(scratchOverride)
    ? scratchOverride
    : (isText(profile.scratch) ? profile.scratch : profiles.SCRATCH_DIR)
  const frozen = Array.isArray(profile.frozen_paths) && profile.frozen_paths.length > 0
    ? profile.frozen_paths.join(', ')
    : 'the repository source and test directories'
  return String(text)
    .split('{{SCRATCH}}').join(scratch)
    .split('{{REPO_ROOT}}').join(profile.repo_root)
    .split('{{REPO_NAME}}').join(isText(profile.repo_name) ? profile.repo_name : profile.repo_root)
    .split('{{STACK}}').join(isText(profile.stack) ? profile.stack : 'unknown')
    .split('{{TEST_COMMAND}}').join(isText(profile.test_command) ? profile.test_command : 'none detected')
    .split('{{FROZEN_PATHS}}').join(frozen)
    .split('{{EVIDENCE_STYLE}}').join(isText(profile.evidence_style) ? profile.evidence_style : profiles.EVIDENCE_STYLE)
}

/** The META block for the workflow tool, parsed from the body header comment. */
function readMeta() {
  const header = readBodyFile().split('*/')[0]
  const at = header.indexOf('META')
  if (at < 0) throw new Error('the body has no META block in its header comment')
  const start = header.indexOf('{', at)
  if (start < 0) throw new Error('the META block in the body header has no object')
  let depth = 0
  let end = -1
  for (let i = start; i < header.length; i++) {
    if (header[i] === '{') depth++
    else if (header[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error('the META block in the body header is not balanced')
  const json = header.slice(start, end + 1).split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join('\n')
  return JSON.parse(json)
}

/** A filesystem-safe slug for a scratch folder name. */
const slugify = (text) => String(text).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'debate'

/**
 * Build the complete `args` object for one debate.
 *
 * `overrides` are the per-launch profile overrides (`--set key=value`): they are
 * how a repository whose detection is wrong — or that has no detectable runner —
 * still gets an honest debate.
 */
function buildArgs(options) {
  const o = options || {}
  if (!isText(o.objective)) throw new Error('objective is required (one sentence, one objective)')
  if (!isText(o.verdictQuestion)) throw new Error('verdict_question is required: the question the seal must answer')
  if (!Array.isArray(o.context) || o.context.length < 3 || o.context.length > 6 || !o.context.every(isText)) {
    throw new Error('context requires 3 to 6 file paths (received: ' + (Array.isArray(o.context) ? o.context.length : 'not-a-list') + ')')
  }
  if (!Array.isArray(o.sealPlan) || o.sealPlan.length < 1 || !o.sealPlan.every(isText)) {
    throw new Error('seal_plan requires at least one runnable check')
  }
  const repoRoot = profiles.detectRoot(o.repoRoot || process.cwd())
  const resolved = profiles.resolveProfile(repoRoot, o.overrides)
  const scratchBase = isText(resolved.profile.scratch) ? resolved.profile.scratch : profiles.SCRATCH_DIR
  const wanted = isText(o.scratch)
    ? o.scratch
    : path.join(scratchBase, 'debate_' + slugify(o.objective))
  // The scratch directory is ALWAYS absolute in the brief: subagents of the three
  // runtimes do not necessarily share a working directory, and a relative path in
  // a prompt is a silent way to scatter artefacts across the machine.
  const scratch = path.isAbsolute(wanted) ? wanted : path.join(repoRoot, wanted)
  const prompts = readPrompts()

  // CLI flags arrive as strings, so the group sizes and the round count are
  // coerced HERE, once: the brief on disk must hold numbers, or every consumer
  // that sums them silently concatenates instead (the failure mode is a
  // plausible-looking "worst case 32330 agent calls").
  const positiveInt = (value, name, preset) => {
    if (value === undefined || value === null || value === '') return preset
    // `--thesis` with nothing after it parses as `true`, and Number(true) is 1: a
    // missing value must be an error, not a silent group of one.
    if (value === true) throw new Error(name + ' needs a value (e.g. --' + name + ' 5)')
    const n = Math.floor(Number(value))
    if (!isFinite(n) || n < 1) throw new Error(name + ' must be a positive integer (received: ' + JSON.stringify(value) + ')')
    return n
  }
  // No policy ceiling on the groups: how many agents you want is your call. Only a
  // sanity ceiling remains, to catch a typo before it spawns anything.
  const groupSize = (value, name, preset) => {
    const n = positiveInt(value, name, preset)
    if (n > MAX_GROUP) throw new Error(name + ' is ' + n + ', above the sanity ceiling of ' + MAX_GROUP + ' agents per group')
    return n
  }
  const nThesis = groupSize(o.thesis, 'thesis', 2)
  const nCritics = groupSize(o.critics, 'critics', 2)
  const nSeals = groupSize(o.seals, 'seals', 2)
  const nRounds = Math.max(1, Math.min(MAX_ROUNDS, positiveInt(o.rounds, 'rounds', 1)))
  const maxCalls = positiveInt(o.maxCalls, 'max-calls', DEFAULT_MAX_CALLS)
  // Same worst-case formula as the body: refuse the plan before a single call is
  // spent, instead of discovering it at launch.
  const planned = nThesis + nCritics + nSeals +
    (nRounds >= 2 ? nThesis : 0) +
    (nRounds >= 3 ? nCritics + nThesis : 0)
  if (planned > maxCalls) {
    throw new Error('budget exceeded: ' + planned + ' planned calls > max_calls=' + maxCalls +
      ' (plan is ' + nThesis + '+' + nCritics + '+' + nSeals + ' rounds=' + nRounds + '; pass --max-calls ' + planned + ' to allow it)')
  }

  // Scaling advice: a plan can be legal and still be badly shaped. These are
  // warnings, never errors — the user decides how many agents to spend.
  const advisories = []
  if (nCritics > 0 && nThesis / nCritics > 8) {
    advisories.push('each critic would receive about ' + Math.ceil(nThesis / nCritics) + ' theses: raise --critics so each partition stays reviewable')
  }
  if (o.sealPlan.length > 0 && nSeals > o.sealPlan.length) {
    advisories.push((nSeals - o.sealPlan.length) + ' of ' + nSeals + ' verifiers have no assigned check and will not be spawned')
  }
  if (nSeals > 0 && o.sealPlan.length / nSeals > 6) {
    advisories.push('each verifier would run about ' + Math.ceil(o.sealPlan.length / nSeals) + ' checks: raise --seals to keep each seal brief focused')
  }
  if (planned > 40) {
    advisories.push('large run: ' + planned + ' planned agent calls — the runtime concurrency cap is the final arbiter, and a spawn it refuses is recorded as a fallen agent')
  }
  if (nRounds === 3 && (nThesis + nCritics + nSeals) > 20) {
    advisories.push('rounds=3 multiplies the whole cycle: consider rounds=2 for a run this wide')
  }

  const args = {
    objective: o.objective.trim(),
    verdict_question: o.verdictQuestion.trim(),
    context: o.context.slice(),
    seal_plan: o.sealPlan.slice(),
    profile: resolved.profile,
    scratch: scratch,
    n_thesis: nThesis,
    n_critics: nCritics,
    n_seals: nSeals,
    max_calls: maxCalls,
    rounds: nRounds,
    prompts: { thesis: prompts.thesis, antithesis: prompts.antithesis, seal: prompts.seal },
  }
  return {
    args: args,
    planned: planned,
    max_calls: maxCalls,
    advisories: advisories,
    profile_source: resolved.source,
    profile_path: resolved.path,
    scratch_abs: scratch,
  }
}

/** Human-readable summary of a profile (stdout stays clean for machine output). */
function describeProfile(profile, source) {
  const lines = []
  lines.push('repository   : ' + profile.repo_root + (profile.vcs === 'git' ? ' (git)' : ''))
  lines.push('stack        : ' + profile.stack + (profile.stacks && profile.stacks.length > 1 ? ' [all: ' + profile.stacks.join(', ') + ']' : ''))
  lines.push('test command : ' + (isText(profile.test_command) ? profile.test_command : '(none detected — pass explicit seal checks)'))
  lines.push('lint/build   : ' + (isText(profile.lint_command) ? profile.lint_command : '-') + ' / ' + (isText(profile.build_command) ? profile.build_command : '-'))
  lines.push('frozen paths : ' + ((profile.frozen_paths || []).join(', ') || '(none)'))
  lines.push('scratch      : ' + profile.scratch + '  ->  ' + profiles.scratchAbs(profile))
  lines.push('evidence     : ' + profile.evidence_style)
  lines.push('profile from : ' + (source || 'live detection'))
  ;(profile.notes || []).forEach((n) => lines.push('note         : ' + n))
  return lines.join('\n')
}

module.exports = {
  ROOT: ROOT,
  PROMPTS_DIR: PROMPTS_DIR,
  ROLES: ROLES,
  MAX_GROUP: MAX_GROUP,
  DEFAULT_MAX_CALLS: DEFAULT_MAX_CALLS,
  MAX_ROUNDS: MAX_ROUNDS,
  readBodyFile: readBodyFile,
  readBodySource: readBodySource,
  readPrompt: readPrompt,
  readPrompts: readPrompts,
  fill: fill,
  readMeta: readMeta,
  slugify: slugify,
  buildArgs: buildArgs,
  describeProfile: describeProfile,
}
