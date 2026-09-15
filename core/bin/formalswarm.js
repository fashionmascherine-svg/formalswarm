#!/usr/bin/env node
'use strict'
/*
 * formalswarm — the single entry point of the plugin, identical on DeepSeek
 * Harness, Claude Code and ZCode.
 *
 *   formalswarm init      [--repo PATH] [--gitignore] [--json]
 *   formalswarm status    [--repo PATH] [--json]
 *   formalswarm brief     --objective S --verdict-question S --context a,b,c
 *                         --seal "cmd" [--seal "cmd" | --seal-file F]
 *                         [--repo P] [--scratch D] [--thesis N] [--critics N]
 *                         [--seals N] [--rounds N] [--set key=value]...
 *                         [--out FILE] [--no-write]
 *   formalswarm body                       # the workflow body, header stripped
 *   formalswarm meta                       # the workflow META parameter
 *   formalswarm prompt    --role ROLE      # one role prompt, placeholders filled
 *   formalswarm run       <brief.json> [--dir D]
 *   formalswarm save      --label L --phase P --raw FILE --dir D
 *   formalswarm fall      --label L --phase P [--reason R] --dir D
 *   formalswarm validate  [--only body|driver|profile|generic]
 *
 * stdout carries data only (JSON, body, prompt, path); every human-facing line
 * goes to stderr, so `formalswarm brief ... > args.json` is always safe.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const profiles = require('../profile.js')
const brief = require('../brief.js')
const driver = require('../driver.js')

/* ── argument parsing ────────────────────────────────────────────────────── */

/** Flags that take a value. */
const VALUE_FLAGS = ['objective', 'verdict-question', 'context', 'seal', 'seal-file', 'repo', 'scratch',
  'thesis', 'critics', 'seals', 'rounds', 'max-calls', 'out', 'set', 'role', 'label', 'phase', 'raw', 'dir', 'reason', 'only']
/** Flags that do not. */
const BOOLEAN_FLAGS = ['json', 'gitignore', 'no-write', 'help', 'h']
const KNOWN_FLAGS = VALUE_FLAGS.concat(BOOLEAN_FLAGS)
const isKnownFlag = (token) => token.indexOf('--') === 0 && KNOWN_FLAGS.indexOf(token.slice(2).split('=')[0]) >= 0

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.indexOf('--') === 0) {
      const eq = token.indexOf('=')
      let name
      let value
      if (eq >= 0) { name = token.slice(2, eq); value = token.slice(eq + 1) }
      else {
        name = token.slice(2)
        const next = argv[i + 1]
        // A seal check is a whole command line and may legitimately begin with a dash
        // (`--strict`, `-q`), so a value-taking flag consumes the next token verbatim
        // unless that token is the name of a flag we know. Silently dropping such a
        // value would run the debate with one check fewer than the user asked for.
        if (VALUE_FLAGS.indexOf(name) >= 0 && next !== undefined && !isKnownFlag(next)) { value = next; i++ }
        else if (next !== undefined && next.indexOf('--') !== 0) { value = next; i++ }
        else value = true
      }
      ;(flags[name] = flags[name] || []).push(value)
    } else positional.push(token)
  }
  return { flags: flags, positional: positional }
}
const flagOne = (flags, name, preset) => {
  const v = flags[name]
  return v === undefined ? preset : v[v.length - 1]
}
const flagMany = (flags, name) => flags[name] || []
const flagOn = (flags, name) => flags[name] !== undefined && flags[name].some((v) => v !== 'false' && v !== 'no')

const isText = (v) => typeof v === 'string' && v.trim().length > 0
const say = (message) => process.stderr.write(message + '\n')
const die = (message, code) => { say('formalswarm: ' + message); process.exit(code === undefined ? 1 : code) }

/** Write a file through a rename, so a reader never sees a half-written artefact. */
const writeAtomic = (file, text) => {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** Parse `--set key=value`: JSON values when they look like JSON, strings otherwise. */
function parseOverride(text) {
  const eq = String(text).indexOf('=')
  if (eq <= 0) throw new Error('--set expects key=value, received: ' + text)
  const key = text.slice(0, eq).trim()
  const raw = text.slice(eq + 1)
  let value
  if (/^[[{"0-9tfn-]/.test(raw)) {
    try { value = JSON.parse(raw) } catch (e) { value = raw }
  } else value = raw
  return { key: key, value: value }
}

/* ── commands ────────────────────────────────────────────────────────────── */

function cmdInit(flags) {
  const repo = flagOne(flags, 'repo', process.cwd())
  const root = profiles.detectRoot(repo)
  const result = profiles.initProfile(root, { gitignore: flagOn(flags, 'gitignore') })
  if (flagOn(flags, 'json')) {
    process.stdout.write(JSON.stringify({ path: result.path, profile: result.profile, gitignore: result.gitignore }, null, 2) + '\n')
    return 0
  }
  say(brief.describeProfile(result.profile, 'fresh detection'))
  say('')
  say('profile written: ' + result.path)
  if (result.gitignore) say('gitignore updated: ' + result.gitignore)
  return 0
}

function cmdStatus(flags) {
  const repo = flagOne(flags, 'repo', process.cwd())
  const root = profiles.detectRoot(repo)
  const resolved = profiles.resolveProfile(root, {})
  if (flagOn(flags, 'json')) {
    process.stdout.write(JSON.stringify({ profile: resolved.profile, source: resolved.source, path: resolved.path }, null, 2) + '\n')
    return 0
  }
  say(brief.describeProfile(resolved.profile, resolved.source === 'file' ? resolved.path : 'live detection'))
  const problems = profiles.validateProfile(resolved.profile)
  if (problems.length > 0) { problems.forEach((p) => say('problem      : ' + p)); return 1 }
  return 0
}

function cmdBrief(flags) {
  const setFlags = flagMany(flags, 'set')
  const overrides = {}
  setFlags.forEach((entry) => { const kv = parseOverride(entry); overrides[kv.key] = kv.value })

  const context = []
  flagMany(flags, 'context').forEach((entry) => {
    String(entry).split(',').forEach((part) => { if (isText(part)) context.push(part.trim()) })
  })
  const sealPlan = flagMany(flags, 'seal').filter(isText).map((s) => s.trim())
  flagMany(flags, 'seal-file').forEach((file) => {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const clean = line.trim()
      if (clean && clean.indexOf('#') !== 0) sealPlan.push(clean)
    })
  })

  const built = brief.buildArgs({
    repoRoot: flagOne(flags, 'repo', process.cwd()),
    objective: flagOne(flags, 'objective'),
    verdictQuestion: flagOne(flags, 'verdict-question'),
    context: context,
    sealPlan: sealPlan,
    scratch: flagOne(flags, 'scratch'),
    thesis: flagOne(flags, 'thesis'),
    critics: flagOne(flags, 'critics'),
    seals: flagOne(flags, 'seals'),
    rounds: flagOne(flags, 'rounds'),
    maxCalls: flagOne(flags, 'max-calls'),
    overrides: overrides,
  })

  const out = flagOne(flags, 'out', path.join(built.scratch_abs, 'brief.json'))
  if (!flagOn(flags, 'no-write')) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(built.args, null, 2) + '\n', 'utf8')
  }
  say(brief.describeProfile(built.args.profile, built.profile_source === 'file' ? built.profile_path : 'live detection'))
  say('')
  say('objective    : ' + built.args.objective)
  say('scale        : ' + built.args.n_thesis + '+' + built.args.n_critics + '+' + built.args.n_seals + ' rounds=' + built.args.rounds + '  (worst case ' + built.planned + ' agent calls, budget ' + built.max_calls + ')')
  say('checks       : ' + built.args.seal_plan.length)
  say('brief        : ' + (!flagOn(flags, 'no-write') ? out : '(not written)'))
  built.advisories.forEach((a) => say('advice       : ' + a))
  process.stdout.write(JSON.stringify(built.args, null, 2) + '\n')
  return 0
}

function cmdPrompt(flags) {
  const role = flagOne(flags, 'role')
  if (!isText(role)) die('prompt requires --role ' + brief.ROLES.join('|'))
  if (brief.ROLES.indexOf(role) < 0) die('unknown role "' + role + '" — known: ' + brief.ROLES.join(', '))
  const repo = flagOne(flags, 'repo', process.cwd())
  const root = profiles.detectRoot(repo)
  const resolved = profiles.resolveProfile(root, {})
  const scratch = flagOne(flags, 'scratch', path.join(profiles.scratchAbs(resolved.profile), 'debate'))
  process.stdout.write(brief.fill(brief.readPrompt(role), resolved.profile, scratch))
  return 0
}

function cmdRun(positional, flags) {
  const briefPath = positional[0]
  if (!isText(briefPath)) die('run requires the path of a brief.json (produced by `formalswarm brief`)')
  let args
  try { args = JSON.parse(fs.readFileSync(briefPath, 'utf8')) } catch (e) {
    die('brief unreadable or not JSON: ' + e.message)
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    die('brief is not a JSON object: rebuild it with `formalswarm brief`')
  }
  if (!args.profile || typeof args.profile !== 'object' || !isText(args.profile.repo_root)) {
    die('brief has no args.profile.repo_root: rebuild it with `formalswarm brief`')
  }
  // scratchAbs resolves a relative scratch against the repository root and leaves an
  // absolute one alone: joining the two by hand wrote artefacts INSIDE the target
  // repository whenever the profile carried an absolute scratch path.
  const scratch = isText(args.scratch) ? args.scratch : profiles.scratchAbs(args.profile)
  const dir = flagOne(flags, 'dir', path.join(scratch, 'driver'))
  fs.mkdirSync(dir, { recursive: true })

  // Folder-to-brief binding: results of one brief can never be consumed by another.
  // The guard FAILS CLOSED — a signature that cannot be read is not a signature that
  // matches, so an unreadable or truncated run_id.json stops the run instead of
  // silently letting one debate eat another's stored answers.
  const id = driver.runId(args)
  const idFile = path.join(dir, 'run_id.json')
  if (fs.existsSync(idFile)) {
    let previous = null
    try { previous = JSON.parse(fs.readFileSync(idFile, 'utf8')) } catch (e) { previous = null }
    if (!previous || typeof previous !== 'object' || typeof previous.run_id !== 'string') {
      die('REFUSED: ' + idFile + ' exists but holds no valid signature, so what produced the results in this folder cannot be verified. ' +
        'Use a new --dir, or delete that file if you are certain the folder is yours.')
    }
    if (previous.run_id !== id) {
      die('REFUSED: folder ' + dir + ' is signed by a different debate (run_id ' + previous.run_id +
        ', current ' + id + ', previous objective: "' + String(previous.objective).slice(0, 80) + '…"). Use a new --dir for the new brief.')
    }
  } else {
    writeAtomic(idFile, JSON.stringify({ run_id: id, objective: args.objective }, null, 2) + '\n')
  }

  return driver.run(args, driver.createResolver(dir), (m) => say(m)).then((result) => {
    const outcome = result.outcome
    say('[formalswarm] budget: planned ' + outcome.budget.planned + ', executed ' + outcome.budget.executed + ', ceiling ' + outcome.budget.max_calls)
    if (result.pending.length > 0) {
      const pendingFile = path.join(dir, 'pending.json')
      writeAtomic(pendingFile, JSON.stringify(result.pending, null, 2) + '\n')
      say('[formalswarm] INTERMEDIATE ROUND — run these agents with the subagent tool of this runtime (prompts in <dir>/<label>@<PHASE>.prompt.txt):')
      result.pending.forEach((x) => say('  - ' + x.label + ' [' + x.phase + '] ' + (x.prompt_final ? 'FINAL PROMPT — execute' : 'built on placeholders — DO NOT execute, wait for the next round')))
      say('[formalswarm] pending list: ' + pendingFile)
      say('[formalswarm] store each answer with: formalswarm save --label L --phase P --raw answer.txt --dir ' + dir)
      process.exitCode = 2
      return 2
    }
    const outcomeFile = path.join(dir, 'outcome.json')
    writeAtomic(outcomeFile, JSON.stringify(outcome, null, 2) + '\n')
    // The protocol asks for the outcome next to the debate's scratch as well.
    try {
      fs.mkdirSync(scratch, { recursive: true })
      writeAtomic(path.join(scratch, 'outcome.json'), JSON.stringify(outcome, null, 2) + '\n')
    } catch (e) { say('[formalswarm] note: could not mirror the outcome into ' + scratch + ': ' + e.message) }
    say('[formalswarm] DEBATE COMPLETE — outcome: ' + outcomeFile)
    say('[formalswarm] global_verdict: ' + outcome.global_verdict.outcome + ' — ' + outcome.global_verdict.reason)
    if (outcome.global_verdict.warnings.length > 0) say('[formalswarm] warnings: ' + outcome.global_verdict.warnings.join(' | '))
    return 0
  }).catch((e) => {
    say('[formalswarm] body failed: ' + (e && e.message))
    return 1
  })
}

function cmdSave(positional, flags) {
  const label = flagOne(flags, 'label')
  const phase = flagOne(flags, 'phase')
  const dir = flagOne(flags, 'dir')
  const raw = flagOne(flags, 'raw')
  if (!isText(label) || !isText(phase) || !isText(dir) || !isText(raw)) {
    die('save requires --label L --phase P --raw FILE --dir D')
  }
  if (!fs.existsSync(raw)) die('raw file not found: ' + raw)
  // A mistyped label or phase would store an answer the driver never asks for, and
  // the round loop would then wait forever on a call that looks answered. Refuse
  // instead: the driver writes a prompt file for every call it makes.
  let key
  try { key = driver.key(label, phase) } catch (e) { die('REFUSED: ' + e.message) }
  const promptFile = path.join(dir, key + '.prompt.txt')
  const resultFile = path.join(dir, key + '.json')
  if (!fs.existsSync(promptFile) && !fs.existsSync(resultFile)) {
    let hint = ''
    const pendingFile = path.join(dir, 'pending.json')
    if (fs.existsSync(pendingFile)) {
      try {
        const waiting = JSON.parse(fs.readFileSync(pendingFile, 'utf8')).map((x) => x.label + ' --phase ' + x.phase)
        if (waiting.length > 0) hint = ' This round is waiting for: ' + waiting.join(', ') + '.'
      } catch (e) { /* a corrupt pending list is not worth failing the message over */ }
    }
    die('REFUSED: no prompt was ever written for "' + key + '" in ' + dir + ' — the label or the phase does not match any call the driver made.' + hint)
  }
  const result = driver.save(label, fs.readFileSync(raw, 'utf8'), dir, phase)
  if (!result.ok) die('REFUSED: ' + result.reason, 1)
  say('[formalswarm] stored ' + result.path)
  return 0
}

function cmdFall(flags) {
  const label = flagOne(flags, 'label')
  const phase = flagOne(flags, 'phase')
  const dir = flagOne(flags, 'dir')
  if (!isText(label) || !isText(phase) || !isText(dir)) die('fall requires --label L --phase P --dir D')
  const reason = isText(flagOne(flags, 'reason')) ? flagOne(flags, 'reason') : undefined
  const result = driver.saveFallen(label, reason, dir, phase)
  if (!result.ok) die('REFUSED: ' + result.reason)
  say('[formalswarm] fallen agent recorded: ' + result.path)
  return 0
}

function cmdValidate(flags) {
  const only = flagOne(flags, 'only')
  const script = path.join(__dirname, '..', 'validate-all.js')
  const argv = [script]
  if (isText(only)) argv.push('--only', only)
  const result = spawnSync(process.execPath, argv, { stdio: 'inherit' })
  return result.status === null ? 1 : result.status
}

const HELP = [
  'formalswarm — repo-agnostic multi-agent validation (thesis / antithesis / seal)',
  '',
  '  formalswarm init      [--repo PATH] [--gitignore] [--json]',
  '  formalswarm status    [--repo PATH] [--json]',
  '  formalswarm brief     --objective S --verdict-question S --context a,b,c --seal "cmd" [--seal "cmd"]',
  '                        [--repo PATH] [--scratch DIR] [--thesis N] [--critics N] [--seals N] [--rounds N]',
  '                        [--max-calls N] [--set key=value]... [--out FILE] [--no-write]',
  '                        N is any group size from 1 to ' + brief.MAX_GROUP + '; --max-calls defaults to ' + brief.DEFAULT_MAX_CALLS + ' and is raised freely',
  '  formalswarm body',
  '  formalswarm meta',
  '  formalswarm prompt    --role orchestrator|thesis|antithesis|seal [--repo PATH]',
  '  formalswarm run       <brief.json> [--dir DIR]',
  '  formalswarm save      --label L --phase P --raw FILE --dir DIR',
  '  formalswarm fall      --label L --phase P [--reason R] --dir DIR',
  '  formalswarm validate  [--only body|driver|profile|generic]',
  '',
  'Typical flow: init once per repository, then brief -> (workflow tool | run/save loop) -> read outcome.json.',
].join('\n')

/* ── entry point ─────────────────────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const parsed = parseArgs(argv.slice(1))
  const flags = parsed.flags
  switch (command) {
    case 'init': return cmdInit(flags)
    case 'status': return cmdStatus(flags)
    case 'brief': return cmdBrief(flags)
    case 'prompt': return cmdPrompt(flags)
    case 'body': process.stdout.write(brief.readBodySource()); return 0
    case 'meta': process.stdout.write(JSON.stringify(brief.readMeta(), null, 2) + '\n'); return 0
    case 'run': return cmdRun(parsed.positional, flags)
    case 'save': return cmdSave(parsed.positional, flags)
    case 'fall': return cmdFall(flags)
    case 'validate': return cmdValidate(flags)
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP + '\n')
      return 0
    default:
      die('unknown command "' + command + '" — run `formalswarm help`')
  }
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main())
    .then((code) => { process.exitCode = typeof code === 'number' ? code : 0 })
    // Validation failures (a bad flag, an over-budget plan, an unknown override) are
    // the user's to fix, so they must read as one line, not as a stack trace. The
    // stack is still one environment variable away for anything unexpected.
    .catch((e) => {
      const message = (e && e.message) ? e.message : String(e)
      say('formalswarm: ' + message)
      if (e && e.stack && process.env.FORMALSWARM_DEBUG) say(e.stack)
      else say('formalswarm: run again with FORMALSWARM_DEBUG=1 for the stack')
      process.exitCode = 1
    })
}

module.exports = { parseArgs: parseArgs, parseOverride: parseOverride, main: main }
