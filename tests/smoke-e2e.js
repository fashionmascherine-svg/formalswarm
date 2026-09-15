#!/usr/bin/env node
'use strict'
/*
 * smoke-e2e.js — the integration test: a real temporary repository, a real
 * toolchain, real exit codes, and the whole pipeline from `init` to `outcome.json`
 * through the round driver.
 *
 * The agent groups are simulated by this script (spending model calls here would
 * test the model, not the plugin), but the SEAL is executed for real: the command
 * is spawned, its true exit status and its true case count are captured, and only
 * those numbers reach the rollup. The two scenarios assert the two verdicts that
 * matter:
 *
 *   green repository  -> CONFIRM
 *   broken repository -> REVISE (a failing check, quoted with its exit code)
 *
 * Unlike core/validate-all.js this one needs a working Python on PATH (`python3` on
 * POSIX, `python` on Windows); it is
 * therefore run separately (`npm run test:e2e`) and not part of the offline gate.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')

const BIN = path.join(__dirname, '..', 'core', 'bin', 'formalswarm.js')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'formalswarm-e2e-'))

const cli = (argv) => spawnSync(process.execPath, [BIN].concat(argv), { encoding: 'utf8' })
/** The interpreter the profiler emits here: Windows ships `python`, not `python3`. */
const PY = process.platform === 'win32' ? 'python' : 'python3'
const onlyOk = (result, what) => {
  if (result.status !== 0) throw new Error(what + ' failed (exit ' + result.status + '):\n' + result.stdout + result.stderr)
  return result
}

/** A tiny but real Python project; `broken` makes one assertion fail. */
function makeRepo(dir, broken) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'math.py'),
    'def compute_total(items):\n    total = 0\n    for it in items:\n        total += it["price"] * it["qty"]\n    return total\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'src', 'report.py'),
    'from math import compute_total\n\n\ndef summary(items):\n    if not items:\n        raise ValueError("no items")\n    return {"total": compute_total(items), "count": len(items)}\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'tests', 'test_math.py'),
    'import unittest\nfrom src.math import compute_total\n\n\n' +
    'class TotalTests(unittest.TestCase):\n' +
    '    def test_empty(self):\n        self.assertEqual(compute_total([]), 0)\n\n' +
    '    def test_single(self):\n        self.assertEqual(compute_total([{"price": 2, "qty": 3}]), 6)\n\n' +
    '    def test_rounding(self):\n        self.assertEqual(compute_total([{"price": 0.1, "qty": 3}]), ' + (broken ? '0.3' : '0.30000000000000004') + ')\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture project\n', 'utf8')
}

/** Run a seal check for real and read the true facts out of it. */
function executeCheck(command, cwd) {
  const result = spawnSync(command, { shell: true, cwd: cwd, encoding: 'utf8' })
  const output = (result.stdout || '') + (result.stderr || '')
  const ran = output.match(/Ran (\d+) tests?/)
  const cases = ran ? Number(ran[1]) : (output.match(/\.\.\. ok/g) || []).length
  return {
    command: command,
    outcome: result.status === 0 ? 'ok' : 'failed',
    detail: output.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 400),
    exit_code: result.status === null ? -1 : result.status,
    cases: cases,
  }
}

function saveAnswer(dir, label, phase, value) {
  const raw = path.join(ROOT, label + '.' + phase + '.raw')
  fs.writeFileSync(raw, 'answer:\n```json\n' + JSON.stringify(value) + '\n```\n', 'utf8')
  onlyOk(cli(['save', '--label', label, '--phase', phase, '--raw', raw, '--dir', dir]), 'save ' + label)
}

/**
 * Drive the round loop to completion exactly as an orchestrator does: run, execute the
 * entries whose prompt is final, store the answers, repeat. Bounded, so a loop that
 * would never converge fails loudly instead of hanging.
 */
function drive(briefPath, driverDir, answerFor) {
  for (let round = 0; round < 30; round++) {
    const result = cli(['run', briefPath, '--dir', driverDir])
    if (result.status === 0) return JSON.parse(fs.readFileSync(path.join(driverDir, 'outcome.json'), 'utf8'))
    if (result.status !== 2) throw new Error('driver failed (exit ' + result.status + '):\n' + result.stdout + result.stderr)
    const pending = JSON.parse(fs.readFileSync(path.join(driverDir, 'pending.json'), 'utf8')).filter((x) => x.prompt_final)
    assert.ok(pending.length > 0, 'an intermediate round with nothing to execute would never converge')
    pending.forEach((call) => {
      const prompt = fs.readFileSync(path.join(driverDir, call.label + '@' + call.phase + '.prompt.txt'), 'utf8')
      saveAnswer(driverDir, call.label, call.phase, answerFor(call, prompt))
    })
  }
  throw new Error('the round loop did not converge in 30 rounds')
}

/** The checks the body assigned to one verifier, read back from its own prompt. */
function checksInPrompt(prompt) {
  const at = prompt.indexOf('ASSIGNED CHECKS')
  const start = prompt.indexOf('[', at)
  let depth = 0
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === '[') depth++
    else if (prompt[i] === ']') { depth--; if (depth === 0) return JSON.parse(prompt.slice(start, i + 1)) }
  }
  throw new Error('no assigned checks in the seal prompt')
}

/**
 * A wide debate driven entirely through the CLI: many writers, many critics, several
 * verifiers, every seal command executed for real. This is the plumbing test for the
 * scale the README advertises.
 */
function runWideDebate() {
  const repo = path.join(ROOT, 'wide')
  fs.mkdirSync(repo, { recursive: true })
  makeRepo(repo, false)
  const scratch = path.join(ROOT, 'wide-scratch')
  const driverDir = path.join(scratch, 'driver')
  const briefPath = path.join(ROOT, 'wide-brief.json')
  const sealPlan = [
    PY + ' -m unittest discover -s tests -v -k test_empty',
    PY + ' -m unittest discover -s tests -v -k test_single',
    PY + ' -m unittest discover -s tests -v -k test_rounding',
    PY + ' -m unittest discover -s tests -v',
  ]
  const argv = [
    'brief', '--repo', repo,
    '--objective', 'Wide debate: memoise the total without changing observable behaviour',
    '--verdict-question', 'Does every assigned check pass, with cases counted?',
    '--context', 'src/math.py,src/report.py,tests/test_math.py',
    '--thesis', '12', '--critics', '8', '--seals', '4', '--rounds', '1',
    '--max-calls', '24', '--scratch', scratch, '--out', briefPath,
  ]
  sealPlan.forEach((c) => argv.push('--seal', c))
  const built = onlyOk(cli(argv), 'brief (wide)')
  const args = JSON.parse(built.stdout)
  assert.strictEqual(args.n_thesis, 12)
  assert.strictEqual(args.max_calls, 24)
  assert.ok(built.stderr.indexOf('worst case 24 agent calls') >= 0, 'the CLI must state the scale it is about to spend')

  const outcome = drive(briefPath, driverDir, (call, prompt) => {
    if (call.label.indexOf('thesis-') === 0) {
      return {
        id: call.label,
        thesis: 'Memoising on the tuple of (price, qty) pairs is behaviour preserving for the input family this repository actually uses.',
        findings: [{ claim: 'the function is pure: it reads only its argument', evidence: 'src/math.py:1' }],
        risks: ['a key built from floats is exact here, and would not be for computed prices'],
        proof_measure: 'run the suite and require exit code 0 with cases > 0',
      }
    }
    if (call.label.indexOf('critic-') === 0) return { objections: [] }
    if (call.label.indexOf('seal-') === 0) {
      const checks = checksInPrompt(prompt).map((command) => executeCheck(command, repo))
      const failed = checks.filter((c) => c.exit_code !== 0)
      return {
        checks: checks,
        verdict: failed.length === 0 ? 'CONFIRM' : 'REVISE',
        measurement_limit: 'the suite saw ' + checks.reduce((n, c) => n + Math.max(0, c.cases), 0) + ' cases in total',
        rationale: 'commands executed for real; exit codes reported unchanged',
        empty: checks.every((c) => c.cases > 0) ? 'no' : 'yes',
      }
    }
    throw new Error('unexpected call in the wide debate: ' + call.label)
  })

  assert.strictEqual(outcome.budget.planned, 24)
  assert.strictEqual(outcome.budget.executed, 24, 'every planned group must actually have run')
  assert.strictEqual(outcome.theses.length, 12)
  assert.strictEqual(outcome.verdict_review.length, 4)
  assert.strictEqual(outcome.verdict_review.every((v) => v.coherence === 'ok'), true)
  assert.strictEqual(outcome.seal_verdicts.every((v) => v.checks.every((c) => c.exit_code === 0 && c.cases > 0)), true,
    'every seal check must have really run and really counted cases')
  assert.strictEqual(outcome.global_verdict.outcome, 'CONFIRM')
  assert.ok(outcome.global_verdict.warnings.join(' ').indexOf('large run') >= 0, 'a run this wide must say so in its own record')
  return outcome
}

function runDebate(name, broken) {
  const repo = path.join(ROOT, name)
  fs.mkdirSync(repo, { recursive: true })
  makeRepo(repo, broken)
  const scratch = path.join(ROOT, name + '-scratch')
  const driverDir = path.join(scratch, 'driver')
  const briefPath = path.join(ROOT, name + '-brief.json')
  const objective = broken
    ? 'Memoise compute_total without changing its observable behaviour (broken variant)'
    : 'Memoise compute_total without changing its observable behaviour'
  const question = 'Does the current test suite prove that compute_total keeps its observable behaviour?'
  const sealCommand = PY + ' -m unittest discover -s tests -v'

  // 1. profile the repository
  const init = JSON.parse(onlyOk(cli(['init', '--repo', repo, '--json']), 'init').stdout)
  assert.strictEqual(init.profile.stack, 'python', 'the profiler must recognise the Python project')
  assert.strictEqual(init.profile.test_command, sealCommand, 'the profiler must find the real test command')
  assert.ok(init.profile.frozen_paths.indexOf('tests') >= 0, 'the test directory must be frozen')

  // 2. build the brief
  const briefRun = onlyOk(cli([
    'brief', '--repo', repo,
    '--objective', objective,
    '--verdict-question', question,
    '--context', 'src/math.py,src/report.py,tests/test_math.py',
    '--seal', sealCommand,
    '--thesis', '1', '--critics', '1', '--seals', '1',
    '--scratch', scratch, '--out', briefPath,
  ]), 'brief')
  const args = JSON.parse(briefRun.stdout)
  assert.strictEqual(args.seal_plan.length, 1)
  assert.strictEqual(args.profile.test_command, sealCommand)
  assert.ok(fs.existsSync(briefPath), 'the brief must be written for the driver')

  // 3. round 1: the driver asks for the thesis writer. The other groups are listed
  // too, but they were built on placeholders — prompt_final is what may be executed.
  const round1 = cli(['run', briefPath, '--dir', driverDir])
  assert.strictEqual(round1.status, 2, 'round 1 must be intermediate:\n' + round1.stdout + round1.stderr)
  const pending1 = JSON.parse(fs.readFileSync(path.join(driverDir, 'pending.json'), 'utf8'))
  assert.deepStrictEqual(pending1.filter((x) => x.prompt_final).map((x) => x.label), ['thesis-1'])
  assert.deepStrictEqual(pending1.filter((x) => !x.prompt_final).map((x) => x.label), ['critic-1', 'seal-1'])

  saveAnswer(driverDir, 'thesis-1', 'THESIS', {
    id: 'thesis-1',
    thesis: 'Memoising compute_total on the tuple of (price, qty) pairs keeps every current assertion green, because the function is pure and reads no global state.',
    findings: [
      { claim: 'compute_total is pure: it only reads its argument', evidence: 'src/math.py:1' },
      { claim: 'the test suite pins the float artefact of the current implementation', evidence: 'tests/test_math.py:16' },
    ],
    risks: ['a cache keyed on floats is exact here but would not be for computed prices'],
    proof_measure: 'Run ' + sealCommand + ' and require exit code 0 with at least 3 cases seen.',
  })

  // 4. the critic attacks the thesis; the seal check is the same command
  const round2 = cli(['run', briefPath, '--dir', driverDir])
  assert.strictEqual(round2.status, 2)
  const pending2 = JSON.parse(fs.readFileSync(path.join(driverDir, 'pending.json'), 'utf8'))
  assert.deepStrictEqual(pending2.filter((x) => x.prompt_final).map((x) => x.label), ['critic-1'])
  saveAnswer(driverDir, 'critic-1', 'ANTITHESIS', { objections: [] })

  // 5. the seal is executed FOR REAL
  const round3 = cli(['run', briefPath, '--dir', driverDir])
  assert.strictEqual(round3.status, 2)
  const pending3 = JSON.parse(fs.readFileSync(path.join(driverDir, 'pending.json'), 'utf8'))
  assert.deepStrictEqual(pending3.filter((x) => x.prompt_final).map((x) => x.label), ['seal-1'])

  const check = executeCheck(sealCommand, repo)
  assert.ok(check.cases > 0, 'the seal must count real cases, saw: ' + check.cases)
  saveAnswer(driverDir, 'seal-1', 'SEAL', {
    checks: [check],
    verdict: check.exit_code === 0 ? 'CONFIRM' : 'REVISE',
    measurement_limit: 'the suite sees ' + check.cases + ' cases; it cannot detect a regression on inputs it never exercises',
    rationale: 'command executed for real, exit code ' + check.exit_code,
    empty: check.cases > 0 ? 'no' : 'yes',
  })

  // 6. rollup
  const final = cli(['run', briefPath, '--dir', driverDir])
  assert.strictEqual(final.status, 0, 'the debate must complete:\n' + final.stdout + final.stderr)
  const outcome = JSON.parse(fs.readFileSync(path.join(driverDir, 'outcome.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(scratch, 'outcome.json')), 'the outcome is mirrored beside the debate scratch')
  assert.strictEqual(outcome.repository.root, repo)
  assert.strictEqual(outcome.budget.executed, 3)
  return { outcome: outcome, check: check, repo: repo }
}

function main() {
  const green = runDebate('green', false)
  assert.strictEqual(green.check.exit_code, 0, 'the green repository must pass its own suite')
  assert.strictEqual(green.outcome.global_verdict.outcome, 'CONFIRM',
    'a green repository with a real, counted check must CONFIRM, got: ' + JSON.stringify(green.outcome.global_verdict))
  assert.strictEqual(green.outcome.verdict_review[0].coherence, 'ok')
  assert.strictEqual(green.outcome.verdict_review[0].effective, 'CONFIRM')

  const broken = runDebate('broken', true)
  assert.notStrictEqual(broken.check.exit_code, 0, 'the broken repository must fail its own suite')
  assert.strictEqual(broken.outcome.global_verdict.outcome, 'REVISE',
    'a failing real check must REVISE, got: ' + JSON.stringify(broken.outcome.global_verdict))
  assert.strictEqual(broken.outcome.seal_verdicts[0].checks[0].exit_code, broken.check.exit_code,
    'the rollup must quote the REAL exit code')

  const wide = runWideDebate()

  console.log('e2e smoke: ALL GREEN')
  console.log('  green repository  -> CONFIRM (exit ' + green.check.exit_code + ', ' + green.check.cases + ' cases)')
  console.log('  broken repository -> REVISE  (exit ' + broken.check.exit_code + ', ' + broken.check.cases + ' cases)')
  console.log('  wide debate       -> ' + wide.global_verdict.outcome + ' (' + wide.budget.executed + ' agent calls, ' +
    wide.seal_verdicts.length + ' verifiers, ' + wide.theses.length + ' theses)')
}

try {
  main()
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true })
}
