'use strict'
/*
 * validate-driver.js — validate OFFLINE the round driver (core/driver.js) against
 * the same body core/debate.workflow.js uses, with no agent call and no cost.
 * The scenarios are the SAME as validate-body.js (which exercises the body
 * directly): here the body travels through the driver and the verdicts must
 * coincide — that is the proof that DeepSeek Harness and the driver runtimes
 * execute the same logic. Plus the mechanics only the driver has: schema
 * conformance at the boundary (enum, required, type), folder-to-brief binding,
 * the <label>@<PHASE> key, the prompt_final marker, and the CLI exit codes.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')

const driver = require('./driver.js')
const brief = require('./brief.js')

const BIN = path.join(__dirname, 'bin', 'formalswarm.js')
const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'python-pytest')
/** The CLI is exercised as a real child process; a bounded timeout turns a hang into a failure. */
const runCli = (argv) => spawnSync(process.execPath, [BIN].concat(argv), { encoding: 'utf8', timeout: 120000 })

const argsBase = {
  objective: 'offline driver test',
  verdict_question: 'does it hold?',
  context: ['src/engine.py', 'src/config.py', 'tests/test_engine.py'],
  seal_plan: ['check A', 'check B'],
  profile: {
    repo_root: FIXTURE,
    repo_name: 'python-pytest',
    stack: 'python',
    test_command: 'python3 -m pytest -q',
    frozen_paths: ['src', 'tests'],
    scratch: '/tmp/formalswarm-driver/.formalswarm/scratch',
    evidence_style: 'path:line',
    notes: [],
  },
  prompts: { thesis: 'P-THESIS {{SCRATCH}}', antithesis: 'P-ANTITHESIS', seal: 'P-SEAL' },
}

const checkOk = { command: 'true', outcome: 'ok', detail: 'output', exit_code: 0, cases: 3 }
const verdictOk = { checks: [checkOk], verdict: 'CONFIRM', measurement_limit: 'n/a', rationale: 'ok', empty: 'no' }
/** A verdict that answers one ASSIGNED check: coverage is matched by command identity. */
const verdictFor = (command, options) => {
  const o = options || {}
  return {
    checks: [Object.assign({ command: command, outcome: 'ok', detail: 'output', exit_code: 0, cases: 3 }, o.patch || {})],
    verdict: o.verdict || 'CONFIRM',
    measurement_limit: 'n/a',
    rationale: 'ok',
    empty: o.empty || 'no',
  }
}
const thesisMock = (n) => ({ id: 'x', thesis: 'T' + n, findings: [], risks: [], proof_measure: 'm' })
const objection = (id, severity, evidence) => ({ thesis_id: id, type: 'logic_bug', severity: severity, evidence: evidence || 'a.py:1: something', fix: 'change the line' })

let dirCounter = 0
const scratchRoot = path.join(os.tmpdir(), 'formalswarm-driver-tests')
const freshDir = (name) => {
  const dir = path.join(scratchRoot, name + '-' + (++dirCounter))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** In-memory resolver: a label maps to a value, to 'FALLEN', or is absent (pending). */
const memoryResolver = (map, seen) => (label, prompt, opts) => {
  if (seen) seen[label + '@' + ((opts && opts.phase) || '?')] = prompt
  if (!Object.prototype.hasOwnProperty.call(map, label)) return { status: 'pending' }
  return map[label] === 'FALLEN' ? { status: 'fallen' } : { status: 'ok', value: map[label] }
}

const runPilot = (override, map, seen) => driver.run(Object.assign({}, argsBase, override || {}), memoryResolver(map || {}, seen), () => {})

const tests = []
const prova = (name, fn) => tests.push({ name: name, fn: fn })

/* ── the same scenarios as the body suite, through the driver ────────────── */

prova('driver≈body: {ok, exit 1} -> REVISE with coherence corrected_by_the_body', async () => {
  const map = { 'seal-1': verdictFor('check A', { patch: { exit_code: 1 } }), 'seal-2': verdictFor('check B') }
  const { outcome } = await runPilot({ rounds: 1 }, map)
  assert.strictEqual(outcome.global_verdict.outcome, 'REVISE')
  assert.strictEqual(outcome.verdict_review[0].coherence, 'corrected_by_the_body')
})

prova('driver≈body: both critics fallen -> INCONCLUSIVE + phase warning ANTITHESIS: 2', async () => {
  const map = { 'critic-1': 'FALLEN', 'critic-2': 'FALLEN', 'seal-1': verdictFor('check A'), 'seal-2': verdictFor('check B') }
  const { outcome } = await runPilot({ n_thesis: 2, n_critics: 2, n_seals: 2, rounds: 1 }, map)
  assert.strictEqual(outcome.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(outcome.global_verdict.reason.indexOf('phase died') >= 0)
  assert.ok(outcome.global_verdict.warnings.join(' ').indexOf('phase ANTITHESIS: 2') >= 0)
})

prova('driver≈body: seal-1 fallen -> label "seal-2", incomplete seal', async () => {
  const map = { 'seal-1': 'FALLEN', 'seal-2': verdictFor('check B') }
  const { outcome } = await runPilot({ n_seals: 2, rounds: 1 }, map)
  assert.strictEqual(outcome.global_verdict.outcome, 'INCONCLUSIVE')
  assert.strictEqual(outcome.verdict_review.length, 1)
  assert.strictEqual(outcome.verdict_review[0].verifier, 'seal-2')
})

prova('driver≈body: a clean pilot 2+2+2 rounds=1 -> CONFIRM, budget 6/6', async () => {
  const map = { 'seal-1': verdictFor('check A'), 'seal-2': verdictFor('check B') }
  const { outcome } = await runPilot({ n_thesis: 2, n_critics: 2, n_seals: 2, rounds: 1 }, map)
  assert.strictEqual(outcome.global_verdict.outcome, 'CONFIRM')
  assert.strictEqual(outcome.budget.planned, 6)
  assert.strictEqual(outcome.budget.executed, 6)
})

prova('driver: the critic partition appears in the prompts (critic-1 sees only thesis-01/03)', async () => {
  const seen = {}
  await runPilot({ n_thesis: 4, n_critics: 2, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, { 'seal-1': verdictFor('check A') }, seen)
  assert.ok(seen['critic-1@ANTITHESIS'].indexOf('thesis-01') >= 0 && seen['critic-1@ANTITHESIS'].indexOf('thesis-03') >= 0)
  assert.ok(seen['critic-1@ANTITHESIS'].indexOf('thesis-02') < 0)
  assert.ok(seen['critic-2@ANTITHESIS'].indexOf('thesis-04') >= 0 && seen['critic-2@ANTITHESIS'].indexOf('thesis-01') < 0)
})

prova('driver: the prompt carries the repository root from args verbatim (no rewriting)', async () => {
  const seen = {}
  await runPilot({ n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1, scratch: '/tmp/formalswarm-driver/SCRATCH-PROOF' }, { 'seal-1': verdictFor('check A') }, seen)
  assert.ok(seen['thesis-1@THESIS'].indexOf('SCRATCH-PROOF') >= 0)
  assert.ok(seen['thesis-1@THESIS'].indexOf('{{SCRATCH}}') < 0)
  assert.ok(seen['thesis-1@THESIS'].indexOf(FIXTURE) >= 0, 'the repository root must survive untouched')
})

/* ── the body schema as the boundary ─────────────────────────────────────── */

prova('schemas extracted from the body: the four schemas exist and the verdict enums come back', () => {
  for (const name of ['schemaThesis', 'schemaObjections', 'schemaSynthesis', 'schemaVerdict']) {
    assert.ok(driver.SCHEMAS[name], 'missing ' + name + ' in the extraction from the body')
  }
  assert.deepStrictEqual(driver.SCHEMAS.schemaVerdict.properties.verdict.enum, ['CONFIRM', 'REVISE', 'INCONCLUSIVE'])
  assert.deepStrictEqual(driver.SCHEMAS.schemaVerdict.properties.empty.enum, ['yes', 'no'])
  assert.deepStrictEqual(driver.SCHEMAS.schemaVerdict.properties.checks.items.properties.outcome.enum, ['ok', 'failed', 'not_run'])
  assert.ok(driver.SCHEMAS.schemaObjections.properties.objections.items.properties.severity.enum.indexOf('blocking') >= 0)
  assert.deepStrictEqual(driver.SCHEMAS.schemaObjections.properties.objections.items.properties.type.enum,
    ['hallucination', 'dead_control', 'dead_guard', 'logic_bug', 'bad_measurement', 'empty_green', 'safety', 'other'])
})

prova('boundary: a verdict outside the enum is a fallen agent, NOT a CONFIRM', async () => {
  const dir = freshDir('enum')
  fs.writeFileSync(path.join(dir, 'seal-1@SEAL.json'), JSON.stringify(Object.assign({}, verdictOk, { verdict: 'PLUTO' })), 'utf8')
  const g = await driver.run(Object.assign({}, argsBase, { rounds: 1 }), driver.createResolver(dir, () => {}), () => {})
  assert.strictEqual(g.outcome.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(g.outcome.fallen_agents.some((c) => c.agent === 'seal-1'))
})

prova('boundary: a check missing the required field is a fallen agent, NOT a CONFIRM', async () => {
  const dir = freshDir('required')
  fs.writeFileSync(path.join(dir, 'seal-1@SEAL.json'), JSON.stringify({ checks: [{ command: 'x', detail: 'd', exit_code: 0, cases: 3 }], verdict: 'CONFIRM', measurement_limit: 'n/a', rationale: 'ok', empty: 'no' }), 'utf8')
  const g = await driver.run(Object.assign({}, argsBase, { rounds: 1 }), driver.createResolver(dir, () => {}), () => {})
  assert.strictEqual(g.outcome.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(g.outcome.fallen_agents.some((c) => c.agent === 'seal-1'))
})

prova('boundary: a wrong field type is a fallen agent with an outcome, not a crash', async () => {
  const dir = freshDir('type')
  fs.writeFileSync(path.join(dir, 'seal-1@SEAL.json'), JSON.stringify(Object.assign({}, verdictOk, { checks: 'ok' })), 'utf8')
  fs.writeFileSync(path.join(dir, 'seal-2@SEAL.json'), JSON.stringify(verdictOk), 'utf8')
  const g = await driver.run(Object.assign({}, argsBase, { n_seals: 2, rounds: 1 }), driver.createResolver(dir, () => {}), () => {})
  assert.strictEqual(g.outcome.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(g.outcome.fallen_agents.some((c) => c.agent === 'seal-1'))
  assert.strictEqual(g.outcome.verdict_review.length, 1)
  assert.strictEqual(g.outcome.verdict_review[0].verifier, 'seal-2')
})

prova('save() refuses out-of-schema payloads (enum, required, type) and accepts a good one in prose', () => {
  const dir = freshDir('save')
  assert.strictEqual(driver.save('seal-1', JSON.stringify(Object.assign({}, verdictOk, { verdict: 'PLUTO' })), dir, 'SEAL').ok, false)
  assert.strictEqual(driver.save('seal-1', JSON.stringify({ checks: [], verdict: 'CONFIRM', rationale: 'y', empty: 'no' }), dir, 'SEAL').ok, false) // measurement_limit missing
  assert.strictEqual(driver.save('critic-1', JSON.stringify({ objections: [{ thesis_id: 'thesis-01', type: 'ghost', severity: 'minor', evidence: 'e', fix: 'f' }] }), dir, 'ANTITHESIS').ok, false)
  const ok = driver.save('critic-1', 'prose ```json\n' + JSON.stringify({ objections: [] }) + '\n``` end', dir, 'ANTITHESIS')
  assert.strictEqual(ok.ok, true)
  assert.strictEqual(driver.conformant('critic-1', JSON.parse(fs.readFileSync(path.join(dir, 'critic-1@ANTITHESIS.json'), 'utf8'))).length, 0)
})

/* ── the round cycle on files ────────────────────────────────────────────── */

prova('files: intermediate placeholder rounds -> a final outcome identical to the in-memory run', async () => {
  const dir = freshDir('rounds')
  const args = Object.assign({}, argsBase, { n_thesis: 2, n_critics: 2, n_seals: 2, rounds: 1 })
  const inMemory = (await runPilot({ n_thesis: 2, n_critics: 2, n_seals: 2, rounds: 1 }, {
    'critic-1': { objections: [objection('thesis-01', 'minor', 'ev-1')] },
    'critic-2': { objections: [] },
    'seal-1': verdictFor('check A'),
    'seal-2': verdictFor('check B'),
  })).outcome

  let g1 = await driver.run(args, driver.createResolver(dir, () => {}), () => {})
  assert.strictEqual(g1.pending.length, 6)
  // prompt_final tells the orchestrator which prompts are safe to execute now.
  assert.deepStrictEqual(g1.pending.filter((x) => x.prompt_final).map((x) => x.label), ['thesis-1', 'thesis-2'])
  assert.deepStrictEqual(g1.pending.filter((x) => !x.prompt_final).map((x) => x.label), ['critic-1', 'critic-2', 'seal-1', 'seal-2'])

  fs.writeFileSync(path.join(dir, 'thesis-1@THESIS.json'), JSON.stringify(thesisMock('01')), 'utf8')
  fs.writeFileSync(path.join(dir, 'thesis-2@THESIS.json'), JSON.stringify(thesisMock('02')), 'utf8')
  const g2 = await driver.run(args, driver.createResolver(dir, () => {}), () => {})
  assert.deepStrictEqual(g2.pending.filter((x) => x.prompt_final).map((x) => x.label), ['critic-1', 'critic-2'])
  const criticPrompt = fs.readFileSync(path.join(dir, 'critic-1@ANTITHESIS.prompt.txt'), 'utf8')
  assert.ok(criticPrompt.indexOf('T01') >= 0, 'the recorded prompt must contain the real thesis')
  assert.ok(criticPrompt.indexOf('PLACEHOLDER (intermediate driver round)') < 0)

  fs.writeFileSync(path.join(dir, 'critic-1@ANTITHESIS.json'), JSON.stringify({ objections: [objection('thesis-01', 'minor', 'ev-1')] }), 'utf8')
  fs.writeFileSync(path.join(dir, 'critic-2@ANTITHESIS.json'), JSON.stringify({ objections: [] }), 'utf8')
  const g3 = await driver.run(args, driver.createResolver(dir, () => {}), () => {})
  assert.deepStrictEqual(g3.pending.filter((x) => x.prompt_final).map((x) => x.label), ['seal-1', 'seal-2'])

  fs.writeFileSync(path.join(dir, 'seal-1@SEAL.json'), JSON.stringify(verdictFor('check A')), 'utf8')
  fs.writeFileSync(path.join(dir, 'seal-2@SEAL.json'), JSON.stringify(verdictFor('check B')), 'utf8')
  const g4 = await driver.run(args, driver.createResolver(dir, () => {}), () => {})
  assert.strictEqual(g4.pending.length, 0)
  assert.strictEqual(g4.outcome.global_verdict.outcome, inMemory.global_verdict.outcome)
  assert.strictEqual(g4.outcome.budget.executed, inMemory.budget.executed)
  assert.strictEqual(g4.outcome.objection_count.minor, inMemory.objection_count.minor)
})

prova('key @PHASE: a synthesis label reused in SYNTHESIS and SYNTHESIS-2 does not collide', async () => {
  const dir = freshDir('phasekey')
  const args = Object.assign({}, argsBase, { n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 3 })
  fs.writeFileSync(path.join(dir, 'thesis-1@THESIS.json'), JSON.stringify(thesisMock('01')), 'utf8')
  fs.writeFileSync(path.join(dir, 'critic-1@ANTITHESIS.json'), JSON.stringify({ objections: [objection('thesis-01', 'minor', 'EV-R1')] }), 'utf8')
  fs.writeFileSync(path.join(dir, 'critic2-1@ANTITHESIS-2.json'), JSON.stringify({ objections: [objection('thesis-01', 'minor', 'EV-R2')] }), 'utf8')
  // The round-1 synthesis on disk must NOT satisfy the SYNTHESIS-2 call.
  fs.writeFileSync(path.join(dir, 'synthesis-thesis-01@SYNTHESIS.json'), JSON.stringify({ revised_thesis: 'REV-R1', responses: [{ objection: 'EV-R1', outcome: 'accepted', reason: 'm' }] }), 'utf8')
  let g = await driver.run(args, driver.createResolver(dir, () => {}), () => {})
  assert.ok(g.pending.some((x) => x.label === 'synthesis-thesis-01' && x.phase === 'SYNTHESIS-2'), 'SYNTHESIS-2 must stay pending: the SYNTHESIS file cannot answer it')
  assert.ok(fs.existsSync(path.join(dir, 'synthesis-thesis-01@SYNTHESIS-2.prompt.txt')))
  fs.writeFileSync(path.join(dir, 'synthesis-thesis-01@SYNTHESIS-2.json'), JSON.stringify({ revised_thesis: 'REV-R2', responses: [{ objection: 'EV-R2', outcome: 'rejected', reason: 'm' }] }), 'utf8')
  fs.writeFileSync(path.join(dir, 'seal-1@SEAL.json'), JSON.stringify(verdictFor('check A')), 'utf8')
  g = await driver.run(args, driver.createResolver(dir, () => {}), () => {})
  assert.strictEqual(g.pending.length, 0)
  const phases = g.outcome.synthesis.map((s) => s.phase)
  assert.ok(phases.indexOf('SYNTHESIS') >= 0 && phases.indexOf('SYNTHESIS-2') >= 0)
  const round2 = g.outcome.synthesis.filter((s) => s.phase === 'SYNTHESIS-2')[0]
  assert.strictEqual(round2.synthesis.revised_thesis, 'REV-R2')
})

prova('files: a FALLEN marker means null in the body, and a dead phase is INCONCLUSIVE', async () => {
  const dir = freshDir('fallen')
  driver.saveFallen('critic-1', 'subagent exploded', dir, 'ANTITHESIS')
  fs.writeFileSync(path.join(dir, 'thesis-1@THESIS.json'), JSON.stringify(thesisMock('01')), 'utf8')
  fs.writeFileSync(path.join(dir, 'seal-1@SEAL.json'), JSON.stringify(verdictFor('check A')), 'utf8')
  const g = await driver.run(Object.assign({}, argsBase, { n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }), driver.createResolver(dir, () => {}), () => {})
  assert.ok(g.outcome.fallen_agents.some((c) => c.agent === 'critic-1'))
  assert.ok(g.outcome.global_verdict.warnings.join(' ').indexOf('phase ANTITHESIS: 1') >= 0)
  assert.strictEqual(g.outcome.global_verdict.outcome, 'INCONCLUSIVE')
})

prova('files: malformed results are fallen agents (fail-closed), never silence', async () => {
  const dir = freshDir('malformed')
  fs.writeFileSync(path.join(dir, 'thesis-1@THESIS.json'), 'this is not json', 'utf8')
  fs.writeFileSync(path.join(dir, 'thesis-2@THESIS.json'), JSON.stringify({ thesis: 'the rest is missing' }), 'utf8')
  const warnings = []
  await assert.rejects(
    () => driver.run(Object.assign({}, argsBase, { n_thesis: 2, rounds: 1 }), driver.createResolver(dir, (m) => warnings.push(m)), () => {}),
    /no thesis was produced/
  )
  assert.strictEqual(warnings.length, 2, 'both non-conformant files must raise a warning')
})

prova('files: a resolver that throws is a fallen agent per item, the run continues', async () => {
  const g = await driver.run(Object.assign({}, argsBase, { n_thesis: 2, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }), (label) => {
    if (label === 'thesis-2') throw new Error('child exploded')
    return { status: 'pending' }
  }, () => {})
  assert.strictEqual(g.outcome.fallen_agents.some((c) => c.agent === 'thesis-2'), true)
  assert.ok(g.outcome.global_verdict.warnings.join(' ').indexOf('phase THESIS: 1') >= 0)
})

prova('runId: stable for the same brief, different for a different objective', () => {
  const a = Object.assign({}, argsBase, { rounds: 1 })
  const b = Object.assign({}, argsBase, { rounds: 1 })
  const c = Object.assign({}, argsBase, { rounds: 1, objective: 'another objective' })
  assert.strictEqual(driver.runId(a), driver.runId(b))
  assert.notStrictEqual(driver.runId(a), driver.runId(c))
})

/* ── the CLI cycle through the real binary ───────────────────────────────── */

prova('CLI: intermediate round exit 2, another brief refused, --save, final exit 0 with the mirrored outcome', () => {
  const dir = freshDir('cli')
  const repoScratch = freshDir('cli-scratch')
  const built = brief.buildArgs({
    repoRoot: FIXTURE,
    objective: 'cli cycle test',
    verdictQuestion: 'does the delegated cycle hold?',
    context: ['src/engine.py', 'src/config.py', 'tests/test_engine.py'],
    sealPlan: ['check A', 'check B'],
    thesis: 1, critics: 1, seals: 1, rounds: 1,
    scratch: repoScratch,
  })
  const argsPath = path.join(dir, 'brief.json')
  fs.writeFileSync(argsPath, JSON.stringify(built.args, null, 2), 'utf8')
  const driverDir = path.join(dir, 'driver')

  const round1 = runCli(['run', argsPath, '--dir', driverDir])
  assert.strictEqual(round1.status, 2, 'a round with no results must exit 2, got ' + round1.status + '\n' + round1.stdout)
  assert.ok(fs.existsSync(path.join(driverDir, 'pending.json')))
  assert.ok(fs.existsSync(path.join(driverDir, 'run_id.json')), 'the folder is signed with the run id')

  // A mistyped label would store an answer the driver never asks for, and the round
  // loop would then wait forever on a call that looks answered: refuse it.
  const strayRaw = path.join(dir, 'stray.raw')
  fs.writeFileSync(strayRaw, JSON.stringify(thesisMock('01')), 'utf8')
  const stray = runCli(['save', '--label', 'thesis-9', '--phase', 'THESIS', '--raw', strayRaw, '--dir', driverDir])
  assert.strictEqual(stray.status, 1, 'a label the driver never asked for must be refused')
  assert.ok(stray.stderr.indexOf('REFUSED') >= 0)
  assert.ok(stray.stderr.indexOf('waiting for') >= 0, 'the refusal must say what the round is waiting for: ' + stray.stderr)

  // A DIFFERENT brief on the same folder is refused (exit 1), never consumed.
  const otherPath = path.join(dir, 'other.json')
  fs.writeFileSync(otherPath, JSON.stringify(Object.assign({}, built.args, { objective: 'ANOTHER BRIEF' }), null, 2), 'utf8')
  const refusal = runCli(['run', otherPath, '--dir', driverDir])
  assert.strictEqual(refusal.status, 1, 'a different brief on the same --dir must exit 1')
  assert.ok(refusal.stderr.indexOf('REFUSED') >= 0)

  // The original debate proceeds: store the thesis through --save, with prose around the JSON.
  const thesisRaw = path.join(dir, 'thesis.raw')
  fs.writeFileSync(thesisRaw, 'Here is my answer:\n```json\n' + JSON.stringify(thesisMock('01')) + '\n```\n', 'utf8')
  const saved = runCli(['save', '--label', 'thesis-1', '--phase', 'THESIS', '--raw', thesisRaw, '--dir', driverDir])
  assert.strictEqual(saved.status, 0, 'a conformant answer must be stored\n' + saved.stderr)
  fs.writeFileSync(path.join(driverDir, 'critic-1@ANTITHESIS.json'), JSON.stringify({ objections: [] }), 'utf8')

  const round2 = runCli(['run', argsPath, '--dir', driverDir])
  assert.strictEqual(round2.status, 2)
  const pending2 = JSON.parse(fs.readFileSync(path.join(driverDir, 'pending.json'), 'utf8'))
  assert.deepStrictEqual(pending2.map((x) => x.label), ['seal-1'])
  assert.strictEqual(pending2[0].prompt_final, true, 'now the seal prompt is built on real results')

  // A verdict that does NOT cover both assigned checks must be refused by save().
  const badRaw = path.join(dir, 'seal-bad.raw')
  fs.writeFileSync(badRaw, JSON.stringify(verdictOk), 'utf8')
  const badSave = runCli(['save', '--label', 'seal-1', '--phase', 'SEAL', '--raw', badRaw, '--dir', driverDir])
  assert.strictEqual(badSave.status, 0, 'the save layer checks the schema, not the coverage: coverage is the rollup job')

  // The real verdict covers both checks: rewrite it and finish.
  const sealRaw = path.join(dir, 'seal.raw')
  fs.writeFileSync(sealRaw, JSON.stringify({ checks: [Object.assign({}, checkOk, { command: 'check A' }), Object.assign({}, checkOk, { command: 'check B' })], verdict: 'CONFIRM', measurement_limit: 'n/a', rationale: 'both green', empty: 'no' }), 'utf8')
  const sealSave = runCli(['save', '--label', 'seal-1', '--phase', 'SEAL', '--raw', sealRaw, '--dir', driverDir])
  assert.strictEqual(sealSave.status, 0, sealSave.stderr)

  const final = runCli(['run', argsPath, '--dir', driverDir])
  assert.strictEqual(final.status, 0, 'a complete round must exit 0, got ' + final.status + '\n' + final.stdout + final.stderr)
  const outcome = JSON.parse(fs.readFileSync(path.join(driverDir, 'outcome.json'), 'utf8'))
  assert.strictEqual(outcome.global_verdict.outcome, 'CONFIRM')
  assert.strictEqual(outcome.budget.executed, 3)
  assert.ok(fs.existsSync(path.join(repoScratch, 'outcome.json')), 'the outcome is mirrored next to the debate scratch')

  // Genericity: the prompt carries the repository root straight from the brief.
  // (The profile root is the VCS root, so it is compared against what the brief
  // actually recorded rather than against the fixture path it was built from.)
  const promptOnDisk = fs.readFileSync(path.join(driverDir, 'thesis-1@THESIS.prompt.txt'), 'utf8')
  assert.ok(promptOnDisk.indexOf(built.args.profile.repo_root) >= 0, 'the prompt must contain the repository root from the brief')
  assert.strictEqual(/\{\{[A-Z_]+\}\}/.test(promptOnDisk), false, 'no placeholder may survive in a prompt on disk')
})

/* ── regressioni dalla revisione avversaria ──────────────────────────────── */

prova('security: a label or a phase that tries to escape the folder is refused', () => {
  const dir = freshDir('traverse')
  const escaped = path.join(os.tmpdir(), 'formalswarm-escape-probe')
  fs.rmSync(escaped + '@SEAL.FALLEN.json', { force: true })
  const fall = runCli(['fall', '--label', '../../formalswarm-escape-probe', '--phase', 'SEAL', '--dir', dir])
  assert.strictEqual(fall.status, 1, 'a traversing label must be refused')
  assert.ok(fall.stderr.indexOf('unsafe label') >= 0, fall.stderr)
  assert.strictEqual(fs.existsSync(escaped + '@SEAL.FALLEN.json'), false, 'nothing may be written outside the folder')

  // The library is strict too, not only the CLI: run() takes any resolver.
  assert.strictEqual(driver.saveFallen('a/b', 'x', dir, 'SEAL').ok, false)
  assert.strictEqual(driver.saveFallen('..', 'x', dir, 'SEAL').ok, false)
  assert.strictEqual(driver.save('thesis-1', JSON.stringify(thesisMock('01')), dir, '../EVIL').ok, false)
  assert.throws(() => driver.key('..', 'SEAL'), /unsafe label/)
  // ...and every legitimate label still works.
  assert.strictEqual(driver.saveFallen('thesis-1', 'reason', dir, 'THESIS').ok, true)
  assert.ok(driver.fileIn(dir, 'synthesis-thesis-01', 'SYNTHESIS-2', '.json').indexOf('synthesis-thesis-01@SYNTHESIS-2.json') >= 0)
})

prova('boundary: a field named after an Object.prototype member is rejected, as the harness would', () => {
  assert.ok(driver.conformant('seal-1', Object.assign({}, verdictOk, { constructor: 'x' })).length > 0)
  assert.ok(driver.conformant('seal-1', Object.assign({}, verdictOk, { toString: 'x' })).length > 0)
  assert.ok(driver.conformant('critic-1', { objections: [], valueOf: 1 }).length > 0)
  assert.ok(driver.conformant('critic-1', { objections: [], hasOwnProperty: 1 }).length > 0)
  assert.strictEqual(driver.conformant('critic-1', { objections: [] }).length, 0)
})

prova('CLI: an unreadable signature fails CLOSED instead of letting a debate eat another one', () => {
  const dir = freshDir('binding')
  const built = brief.buildArgs({
    repoRoot: FIXTURE, objective: 'binding test', verdictQuestion: 'q?',
    context: ['a', 'b', 'c'], sealPlan: ['check A'], thesis: 1, critics: 1, seals: 1, rounds: 1,
    scratch: freshDir('binding-scratch'),
  })
  const briefPath = path.join(dir, 'brief.json')
  fs.writeFileSync(briefPath, JSON.stringify(built.args), 'utf8')
  const driverDir = path.join(dir, 'driver')
  fs.mkdirSync(driverDir, { recursive: true })

  for (const bad of ['null', 'not json at all', '{}', '{"run_id": 42}']) {
    fs.writeFileSync(path.join(driverDir, 'run_id.json'), bad, 'utf8')
    const refused = runCli(['run', briefPath, '--dir', driverDir])
    assert.strictEqual(refused.status, 1, 'a signature that cannot be read must stop the run: ' + bad)
    assert.ok(refused.stderr.indexOf('no valid signature') >= 0, refused.stderr)
  }

  // A valid signature for a DIFFERENT brief is still refused, as before.
  fs.writeFileSync(path.join(driverDir, 'run_id.json'), JSON.stringify({ run_id: 'deadbeef', objective: 'another debate' }), 'utf8')
  const other = runCli(['run', briefPath, '--dir', driverDir])
  assert.strictEqual(other.status, 1)
  assert.ok(other.stderr.indexOf('signed by a different debate') >= 0)

  // With no signature at all the folder is claimed and the round proceeds.
  fs.rmSync(path.join(driverDir, 'run_id.json'))
  const fresh = runCli(['run', briefPath, '--dir', driverDir])
  assert.strictEqual(fresh.status, 2, fresh.stderr)
  const signature = JSON.parse(fs.readFileSync(path.join(driverDir, 'run_id.json'), 'utf8'))
  assert.strictEqual(typeof signature.run_id, 'string')
})

prova('CLI: a brief that is not an object is diagnosed, not crashed on', () => {
  const dir = freshDir('nullbrief')
  const nullBrief = path.join(dir, 'null.json')
  fs.writeFileSync(nullBrief, 'null', 'utf8')
  const result = runCli(['run', nullBrief, '--dir', path.join(dir, 'driver')])
  assert.strictEqual(result.status, 1)
  assert.ok(result.stderr.indexOf('not a JSON object') >= 0, result.stderr)
  assert.strictEqual(/Cannot read propert/.test(result.stderr), false, 'no raw TypeError may escape')
})

prova('CLI: an absolute profile.scratch is honoured, never joined onto the repository root', () => {
  const dir = freshDir('absscratch')
  const scratch = freshDir('absscratch-target')
  const built = brief.buildArgs({
    repoRoot: FIXTURE, objective: 'absolute scratch', verdictQuestion: 'q?',
    context: ['a', 'b', 'c'], sealPlan: ['check A'], thesis: 1, critics: 1, seals: 1, rounds: 1,
  })
  const args = built.args
  args.profile.scratch = scratch // absolute, and args.scratch removed entirely
  delete args.scratch
  const briefPath = path.join(dir, 'brief.json')
  fs.writeFileSync(briefPath, JSON.stringify(args), 'utf8')

  const result = runCli(['run', briefPath]) // no --dir: the default comes from the profile
  assert.strictEqual(result.status, 2, result.stderr)
  assert.ok(fs.existsSync(path.join(scratch, 'driver', 'run_id.json')), 'the driver folder belongs under the absolute scratch')
  assert.strictEqual(fs.existsSync(path.join(args.profile.repo_root, scratch)), false, 'nothing may be written inside the target repository')
})

prova('CLI: a seal check beginning with a dash survives, and a missing value is an error', () => {
  const dashed = runCli(['brief', '--repo', FIXTURE, '--objective', 'dash', '--verdict-question', 'q?',
    '--context', 'a,b,c', '--seal', 'npm test', '--seal', '--strict', '--no-write'])
  assert.strictEqual(dashed.status, 0, dashed.stderr)
  assert.deepStrictEqual(JSON.parse(dashed.stdout).seal_plan, ['npm test', '--strict'])

  const missing = runCli(['brief', '--repo', FIXTURE, '--objective', 'x', '--verdict-question', 'y',
    '--context', 'a,b,c', '--seal', 'z', '--thesis', '--no-write'])
  assert.strictEqual(missing.status, 1, 'a flag with no value must not silently become 1')
  assert.ok(missing.stderr.indexOf('needs a value') >= 0, missing.stderr)
})

async function runAll() {
  let failed = 0
  for (const t of tests) {
    try { await t.fn() } catch (e) { failed++; console.error('FAILED  ' + t.name + ' :: ' + (e && e.message)) }
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true })
  return { suite: 'driver', total: tests.length, failed: failed }
}

module.exports = { runAll: runAll, tests: tests }

if (require.main === module) {
  runAll().then((r) => {
    console.log((r.failed === 0 ? 'driver suite: all green (' : 'driver suite: ' + r.failed + ' failed of ') + r.total + ')')
    process.exit(r.failed === 0 ? 0 : 1)
  }).catch((e) => { console.error(e); process.exit(1) })
}
