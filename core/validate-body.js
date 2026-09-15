'use strict'
/*
 * validate-body.js — validate OFFLINE the logic of core/debate.workflow.js.
 * No agent call, no cost: the body is wrapped in a Function with fake hooks and
 * the suites check budget, partitions, synthesis skipping, orphan and duplicate
 * objections, the fail-closed rollup (exit codes, cases <= 0, coverage of the
 * assigned checks, dead phases, labels after a fall, per-round file names) and
 * the conformance of every schema to the subset the workflow tool accepts.
 *
 * Run directly (`node core/validate-body.js`) or through validate-all.js.
 */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')

const bodyPath = path.join(__dirname, 'debate.workflow.js')
const source = fs.readFileSync(bodyPath, 'utf8')
const body = source.replace(/^\/\*[\s\S]*?\*\//, '') // drop the header comment: the executable body only

const REPO_ROOT = '/tmp/formalswarm-fixture'

const argsBase = {
  objective: 'offline test',
  verdict_question: 'does it hold?',
  context: ['src/engine.py', 'src/config.py', 'tests/test_engine.py'],
  seal_plan: ['check A', 'check B'],
  profile: {
    repo_root: REPO_ROOT,
    repo_name: 'fixture',
    stack: 'python',
    test_command: 'python3 -m pytest -q',
    frozen_paths: ['src', 'tests'],
    scratch: REPO_ROOT + '/.formalswarm/scratch',
    evidence_style: 'path:line',
    notes: [],
  },
  prompts: {
    thesis: 'P-THESIS {{SCRATCH}} {{REPO_ROOT}}',
    antithesis: 'P-ANTITHESIS {{EVIDENCE_STYLE}} {{TEST_COMMAND}}',
    seal: 'P-SEAL {{FROZEN_PATHS}} {{STACK}}',
  },
}

const checkOk = { command: 'true', outcome: 'ok', detail: 'output', exit_code: 0, cases: 3 }
const verdictOk = { checks: [checkOk], verdict: 'CONFIRM', measurement_limit: 'n/a', rationale: 'ok', empty: 'no' }
const thesisMock = (n) => ({ id: 'x', thesis: 'T' + n, findings: [], risks: [], proof_measure: 'm' })
const objection = (id, severity, evidence) => ({ thesis_id: id, type: 'logic_bug', severity: severity, evidence: evidence || 'a.py:1: something', fix: 'change the line' })

/**
 * A verdict that answers the checks the body actually ASSIGNED — coverage is matched
 * by command identity, so a mock that reports arbitrary commands is a mock that
 * verified nothing (which is exactly what the coverage rule exists to catch).
 */
const sealedFrom = (prompt, options) => {
  const o = options || {}
  let checks = assignedChecks(prompt).map((command) => Object.assign(
    { command: command, outcome: 'ok', detail: 'output', exit_code: 0, cases: 3 }, o.patch || {}))
  if (o.take !== undefined) checks = checks.slice(0, o.take)
  if (o.checks) checks = o.checks
  return { checks: checks, verdict: o.verdict || 'CONFIRM', measurement_limit: 'n/a', rationale: 'ok', empty: o.empty || 'no' }
}

/* Guard: the schemas handed to agent() may use ONLY the keywords the workflow
 * tool accepts (the subset rejects pattern/format/minimum/maxItems/… and would
 * kill the run after the calls were already paid for). Recursive. */
const ALLOWED_SCHEMA_KEYS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf']
const schemaConformant = (s) => {
  if (Array.isArray(s)) return s.every(schemaConformant)
  if (s === null || typeof s !== 'object') return true
  return Object.keys(s).every((k) => {
    if (ALLOWED_SCHEMA_KEYS.indexOf(k) < 0) return false
    if (k === 'properties') return Object.keys(s[k]).every((name) => schemaConformant(s[k][name])) // property names are not keywords
    return schemaConformant(s[k])
  })
}

/* Execute the body with fake hooks. mapAgent(label, prompt, opts) -> object|null|throw.
 * `collected` (optional) gathers the schemas passed to agent(). */
function run(overrideArgs, mapAgent, collected) {
  const hooks = {
    args: Object.assign({}, argsBase, overrideArgs || {}),
    agent: (prompt, opts) => {
      const o = opts || {}
      if (collected && o.schema) collected.push(o.schema)
      return Promise.resolve(mapAgent(o.label || '?', prompt, o))
    },
    // Faithful to the real runtime: a thunk that throws resolves to null per item.
    parallel: (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: (items, ...stages) => stages.reduce((p, s) => p.then((out) => Promise.all(out.map((it, i) => s(it, it, i)))), Promise.resolve(items)),
    phase: () => {},
    log: () => {},
  }
  const fn = new Function(...Object.keys(hooks), 'return (async () => {' + body + '})()')
  return fn.apply(null, Object.values(hooks))
}

/* Default fake agents: a thesis per writer, no objections from the critics, a green seal. */
function agents(options) {
  const o = options || {}
  const calls = []
  const seen = {}
  return {
    calls: calls,
    seen: seen,
    map: (label, prompt, opts) => {
      calls.push(label)
      seen[label + '@' + ((opts && opts.phase) || '?')] = prompt
      if (label.indexOf('synthesis-') === 0) return o.synthesis ? o.synthesis(label, prompt) : { revised_thesis: 'REV(' + label + ')', responses: [] }
      if (label.indexOf('thesis-') === 0) return thesisMock(label)
      if (label.indexOf('critic2-') === 0) {
        const r2 = o.critic2 ? o.critic2(label, prompt) : []
        return r2 === null ? null : { objections: r2 } // null = the child fell, as on the real runtime
      }
      if (label.indexOf('critic-') === 0) {
        const r1 = o.critic ? o.critic(label, prompt) : []
        return r1 === null ? null : { objections: r1 }
      }
      if (label.indexOf('seal-') === 0) return o.seal ? o.seal(label, prompt) : sealedFrom(prompt)
      throw new Error('mock without a handler for label ' + label)
    },
  }
}

/** The checks assigned to a verifier, read back from the prompt the body built. */
function assignedChecks(prompt) {
  const at = prompt.indexOf('ASSIGNED CHECKS')
  const start = prompt.indexOf('[', at)
  let depth = 0
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === '[') depth++
    else if (prompt[i] === ']') { depth--; if (depth === 0) return JSON.parse(prompt.slice(start, i + 1)) }
  }
  throw new Error('no assigned checks found in the prompt')
}

const tests = []
const prova = (name, fn) => tests.push({ name: name, fn: fn })

/* ── budget, guards, brief assembly ──────────────────────────────────────── */

prova('budget: 5+5+5 with rounds=2 is refused by the default ceiling (20 > 15)', async () => {
  await assert.rejects(
    () => run({ n_thesis: 5, n_critics: 5, n_seals: 5, rounds: 2 }, () => { throw new Error('must not start') }),
    /budget exceeded/
  )
})

prova('budget: the same plan runs once max_calls is raised — the ceiling is a declaration, not a policy', async () => {
  const cycle = agents()
  const out = await run({ n_thesis: 5, n_critics: 5, n_seals: 5, rounds: 2, max_calls: 20, seal_plan: Array.from({ length: 5 }, (_, i) => 'check ' + i) }, cycle.map)
  assert.strictEqual(out.budget.planned, 20)
  assert.strictEqual(out.budget.max_calls, 20)
  // Worst case is 20; the real cost is 15 because the critics attacked nothing, so
  // SYNTHESIS is skipped (zero calls). Planned is a ceiling, executed is the truth.
  assert.strictEqual(out.budget.executed, 15)
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
})

prova('scale: 100 thesis writers + 100 critics + 100 verifiers run and roll up', async () => {
  const cycle = agents()
  const checks = Array.from({ length: 100 }, (_, i) => 'check ' + i)
  const out = await run({ n_thesis: 100, n_critics: 100, n_seals: 100, seal_plan: checks, rounds: 1, max_calls: 300 }, cycle.map)
  assert.strictEqual(out.budget.planned, 300)
  assert.strictEqual(out.budget.executed, 300)
  assert.strictEqual(out.theses.length, 100)
  assert.strictEqual(out.config.active_seals, 100)
  assert.strictEqual(out.verdict_review.length, 100)
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('large run') >= 0, 'a run this wide must say so')
  // every verifier still owns exactly one check: coverage is what makes CONFIRM honest
  assert.strictEqual(out.verdict_review.every((v) => v.coherence === 'ok'), true)
})

prova('scale: a 500-agent plan is refused by the default ceiling but the groups themselves have no policy cap', async () => {
  const cycle = agents()
  await assert.rejects(
    () => run({ n_thesis: 100, n_critics: 100, n_seals: 100, rounds: 1 }, cycle.map),
    /budget exceeded/
  )
  await assert.rejects(() => run({ n_thesis: 501 }, () => null), /sanity ceiling/)
  await assert.rejects(() => run({ n_thesis: 0 }, () => null), /must be at least 1/)
})

prova('scale: with many verifiers and few checks, only the verifiers with a check are spawned', async () => {
  const cycle = agents()
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 40, seal_plan: ['only check'], rounds: 1, max_calls: 42 }, cycle.map)
  assert.strictEqual(out.config.active_seals, 1)
  assert.strictEqual(cycle.calls.filter((l) => l.indexOf('seal-') === 0).length, 1)
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
})

prova('scale: long theses and a crowded ledger are bounded in the seal brief, and say so', async () => {
  const cycle = agents({
    critic: (l) => { const id = l === 'critic-1' ? 'thesis-01' : 'thesis-02'; return [0, 1, 2].map((k) => objection(id, k === 0 ? 'blocking' : 'minor', 'EV-' + l + '-' + k)) },
  })
  const longThesis = { id: 'x', thesis: 'T'.repeat(9000), findings: [], risks: [], proof_measure: 'm' }
  const mappa = (label, prompt, opts) => (label.indexOf('thesis-') === 0 ? longThesis : cycle.map(label, prompt, opts))
  const out = await run({ n_thesis: 2, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1, max_calls: 4 }, mappa)
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('truncated in the seal brief') >= 0)
  // The cap must bite ONLY when it is exceeded: a small ledger is passed through whole.
  assert.strictEqual(out.global_verdict.warnings.join(' ').indexOf('were left out'), -1, 'a small ledger must not be truncated')
})

prova('budget: rounds=3 at pilot scale plans 12 and executes 12, no fall', async () => {
  const cycle = agents({
    critic: (l) => [objection(l === 'critic-1' ? 'thesis-01' : 'thesis-02', 'blocking', 'R1 ' + l)],
    critic2: (l) => [objection(l === 'critic2-1' ? 'thesis-01' : 'thesis-02', 'major', 'R2 ' + l)],
  })
  const out = await run({ n_thesis: 2, n_critics: 2, n_seals: 2, rounds: 3 }, cycle.map)
  assert.strictEqual(out.budget.planned, 12)
  assert.strictEqual(out.budget.executed, 12)
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
  assert.strictEqual(out.current_theses.every((t) => t.state === 'revised'), true)
})

prova('guard: a context outside 3-6 files is refused; a non-numeric group size fails clearly', async () => {
  await assert.rejects(() => run({ context: ['a.py', 'b.py'] }, () => null), /3 to 6/)
  await assert.rejects(() => run({ n_thesis: 'abc' }, () => null), /must be a number/)
})

prova('guard: a missing profile is refused with a message naming the fix', async () => {
  await assert.rejects(() => run({ profile: null }, () => null), /args\.profile\.repo_root is required/)
  await assert.rejects(() => run({ profile: { repo_name: 'x' } }, () => null), /formalswarm init/)
})

prova('guard: incomplete prompts are refused', async () => {
  await assert.rejects(() => run({ prompts: { thesis: 'only one' } }, () => null), /args\.prompts requires/)
})

prova('brief: repository facts reach the agents and no placeholder survives', async () => {
  const cycle = agents()
  await run({ rounds: 1 }, cycle.map)
  const thesisPrompt = cycle.seen['thesis-1@THESIS']
  assert.ok(thesisPrompt.indexOf(REPO_ROOT) >= 0, 'the repository root must appear verbatim in the brief')
  assert.ok(thesisPrompt.indexOf('python3 -m pytest -q') >= 0, 'the detected test command must reach the agents')
  assert.ok(thesisPrompt.indexOf('src, tests') >= 0, 'the frozen paths must reach the agents')
  assert.ok(thesisPrompt.indexOf('path:line') >= 0, 'the evidence style must reach the agents')
  assert.strictEqual(/\{\{[A-Z_]+\}\}/.test(thesisPrompt), false, 'no placeholder may survive the substitution')
  assert.strictEqual(cycle.seen['critic-1@ANTITHESIS'].indexOf('{{') < 0, true)
})

prova('brief: a relative scratch becomes absolute against the repository root', async () => {
  const cycle = agents()
  const relative = Object.assign({}, argsBase.profile, { scratch: '.formalswarm/scratch' })
  await run({ profile: relative, scratch: undefined, rounds: 1 }, cycle.map)
  assert.ok(cycle.seen['thesis-1@THESIS'].indexOf(REPO_ROOT + '/.formalswarm/scratch') >= 0)
})

/* ── rollup, fail-closed ─────────────────────────────────────────────────── */

prova('rollup: CONFIRM with exit_code=1 is corrected to REVISE (fail-closed)', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { patch: { exit_code: 1 } }) })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'REVISE')
  assert.strictEqual(out.verdict_review[0].coherence, 'corrected_by_the_body')
})

prova('rollup: cases=0 with outcome ok is empty green -> INCONCLUSIVE', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { patch: { cases: 0 } }) })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('empty green') >= 0)
})

prova('rollup: cases=-1 with outcome ok never yields CONFIRM (sentinel blocked)', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { patch: { cases: -1 } }) })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.strictEqual(out.verdict_review[0].coherence, 'corrected_by_the_body')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('sentinel') >= 0)
})

prova('rollup: {ok, exit -1} is a check not run -> INCONCLUSIVE', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { patch: { exit_code: -1, cases: 5 } }) })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('not-run sentinel') >= 0)
})

prova('rollup priority: {ok, exit 1, cases 0} is REVISE, not INCONCLUSIVE', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { patch: { exit_code: 1, cases: 0 } }) })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'REVISE')
})

prova('rollup: an empty seal cannot CONFIRM', async () => {
  const cycle = agents({ seal: () => Object.assign({}, verdictOk, { checks: [] }) })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('coverage incomplete') >= 0)
})

prova('rollup: an omitted check (2 assigned, 1 reported) cannot CONFIRM', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { take: 1 }) })
  const out = await run({ n_seals: 1, seal_plan: ['check A', 'check B'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('coverage incomplete') >= 0)
})

prova('rollup: a mute seal (every verifier fallen) is INCONCLUSIVE, never CONFIRM by silence', async () => {
  const cycle = agents({ seal: () => null })
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.global_verdict.reason.indexOf('mute seal') >= 0)
  assert.strictEqual(out.fallen_agents.some((c) => c.phase === 'SEAL'), true)
})

prova('rollup: seal-1 fallen, seal-2 survives -> label "seal-2", incomplete seal', async () => {
  const cycle = agents({ seal: (l) => (l === 'seal-1' ? null : verdictOk) })
  const out = await run({ n_seals: 2, rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.strictEqual(out.verdict_review.length, 1)
  assert.strictEqual(out.verdict_review[0].verifier, 'seal-2')
})

prova('rollup: a dead antithesis phase is INCONCLUSIVE with a phase warning', async () => {
  const cycle = agents({ critic: () => null, critic2: () => null })
  const out = await run({ n_thesis: 2, n_critics: 2, n_seals: 2, rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.global_verdict.reason.indexOf('phase died') >= 0)
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('phase ANTITHESIS: 2') >= 0)
})

prova('rollup: parallel is faithful — a thunk that throws becomes null and the run continues', async () => {
  const cycle = agents()
  const map = (label, prompt, opts) => {
    if (label === 'thesis-2') throw new Error('child exploded') // the real runtime turns this into null
    return cycle.map(label, prompt, opts)
  }
  const out = await run({ n_thesis: 2, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, map)
  assert.strictEqual(out.fallen_agents.some((c) => c.agent === 'thesis-2'), true)
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('phase THESIS: 1') >= 0)
})

/* ── partition, objections, synthesis ────────────────────────────────────── */

prova('partition: each critic sees only its own theses in the prompt', async () => {
  const cycle = agents({ critic: () => [] })
  await run({ n_thesis: 4, n_critics: 2, n_seals: 1, rounds: 1 }, cycle.map)
  const c1 = cycle.seen['critic-1@ANTITHESIS']
  const c2 = cycle.seen['critic-2@ANTITHESIS']
  assert.ok(c1.indexOf('thesis-01') >= 0 && c1.indexOf('thesis-03') >= 0)
  assert.ok(c1.indexOf('thesis-02') < 0, 'critic-1 must not see critic-2 theses')
  assert.ok(c2.indexOf('thesis-04') >= 0 && c2.indexOf('thesis-01') < 0)
})

prova('partition: idle critics are spared — 1 thesis starts 1 critic, not 2', async () => {
  const cycle = agents()
  await run({ n_thesis: 1, n_critics: 2, n_seals: 2, rounds: 1 }, cycle.map)
  assert.strictEqual(cycle.calls.filter((l) => l.indexOf('critic-') === 0).length, 1)
})

prova('partition: the assigned checks cover the seal plan exactly once', async () => {
  const cycle = agents()
  await run({ n_thesis: 2, n_critics: 1, n_seals: 3, seal_plan: ['c1', 'c2', 'c3', 'c4', 'c5'], rounds: 1 }, cycle.map)
  const union = []
  for (let i = 1; i <= 3; i++) assignedChecks(cycle.seen['seal-' + i + '@SEAL']).forEach((c) => union.push(c))
  assert.deepStrictEqual(union.slice().sort(), ['c1', 'c2', 'c3', 'c4', 'c5'])
})

prova('objections: an orphan never reaches an unrelated writer', async () => {
  const cycle = agents({
    critic: () => [objection('thesis-01', 'blocking', 'good'), objection('ghost-99', 'blocking', 'orphan')],
  })
  const out = await run({ n_thesis: 2, n_critics: 1, n_seals: 1, rounds: 2 }, cycle.map)
  const synthesisLabels = cycle.calls.filter((l) => l.indexOf('synthesis-') === 0)
  assert.deepStrictEqual(synthesisLabels, ['synthesis-thesis-01']) // thesis-02 is not disturbed
  assert.strictEqual(out.objection_count.orphan, 1)
  assert.strictEqual(out.objections.filter((v) => v.state === 'orphan').length, 1)
})

prova('synthesis: accepted only when the evidence is reused EXACTLY; the revision reaches the seal', async () => {
  const cycle = agents({
    critic: () => [objection('thesis-01', 'blocking', 'EV-EXACT'), objection('thesis-01', 'minor', 'EV-NO-ANSWER')],
    synthesis: () => ({ revised_thesis: 'REVISED THESIS', responses: [{ objection: 'EV-EXACT', outcome: 'accepted', reason: 'right' }] }),
  })
  const out = await run({ n_critics: 1, rounds: 2 }, cycle.map)
  assert.strictEqual(out.objection_count.accepted, 1)
  assert.strictEqual(out.objection_count.unanswered, 1)
  const state = out.current_theses.filter((t) => t.id === 'thesis-01')[0]
  assert.strictEqual(state.state, 'revised')
  assert.strictEqual(state.thesis, 'REVISED THESIS')
})

prova('synthesis: duplicate evidence consumes ONE response each (no accepted by collision)', async () => {
  const cycle = agents({
    critic: () => [objection('thesis-01', 'blocking', 'E-DUP'), objection('thesis-01', 'major', 'E-DUP')],
    synthesis: () => ({ revised_thesis: 'REV', responses: [{ objection: 'E-DUP', outcome: 'rejected', reason: 'no' }, { objection: 'E-DUP', outcome: 'accepted', reason: 'yes' }] }),
  })
  const out = await run({ n_critics: 1, rounds: 2 }, cycle.map)
  assert.strictEqual(out.objection_count.rejected, 1)
  assert.strictEqual(out.objection_count.accepted, 1)
})

prova('synthesis files are per round (r1/r2): no collision', async () => {
  const cycle = agents({
    critic: () => [objection('thesis-01', 'minor', 'R1 x')],
    critic2: () => [objection('thesis-01', 'minor', 'R2 x')],
  })
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 1, rounds: 3 }, cycle.map)
  assert.ok(cycle.seen['synthesis-thesis-01@SYNTHESIS'].indexOf('synthesis_r1_') >= 0)
  assert.ok(cycle.seen['synthesis-thesis-01@SYNTHESIS-2'].indexOf('synthesis_r2_') >= 0)
  assert.strictEqual(out.budget.executed, 6) // 1 thesis + 1 critic + 1 synthesis + 1 critic2 + 1 synthesis2 + 1 seal
})

prova('synthesis: a dead synthesis phase is INCONCLUSIVE', async () => {
  const cycle = agents({ critic: () => [objection('thesis-01', 'major', 'E1')], synthesis: () => null })
  // The seal must be clean, otherwise the coverage branch decides first: the global
  // order is deliberate (a broken seal outranks a dead phase).
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 2 }, cycle.map)
  assert.ok(out.global_verdict.reason.indexOf('phase died') >= 0)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
})

prova('round 2: the board carries the state of every objection', async () => {
  const cycle = agents({
    critic: () => [objection('thesis-01', 'blocking', 'EV-ONE')],
    synthesis: () => ({ revised_thesis: 'REV', responses: [{ objection: 'EV-ONE', outcome: 'accepted', reason: 'ok' }] }),
    critic2: () => [],
  })
  await run({ n_thesis: 1, n_critics: 1, n_seals: 1, rounds: 3 }, cycle.map)
  const board = cycle.seen['critic2-1@ANTITHESIS-2']
  assert.ok(board.indexOf('FIRST-ROUND BOARD') >= 0)
  assert.ok(board.indexOf('[accepted]') >= 0, 'the board must carry the accepted state')
})

/* ── schemas and output ──────────────────────────────────────────────────── */

prova('schemas: only workflow-tool keywords; the checker rejects "minimum"', async () => {
  assert.strictEqual(schemaConformant({ type: 'integer', minimum: 0 }), false)
  assert.strictEqual(schemaConformant({ type: 'string', enum: ['a', 'b'] }), true)
  assert.strictEqual(schemaConformant({ type: 'object', required: ['x'], additionalProperties: false, properties: { x: { type: 'array', items: { type: 'string' } } } }), true)
  const collected = []
  const cycle = agents({ critic: () => [objection('thesis-01', 'minor', 'x')] })
  await run({ n_thesis: 1, n_critics: 1, n_seals: 1, rounds: 3 }, cycle.map, collected)
  assert.ok(collected.length >= 4, 'at least the four schemas are expected, saw: ' + collected.length)
  const distinct = {}
  collected.forEach((s) => { distinct[JSON.stringify(s)] = s })
  Object.keys(distinct).forEach((k) => assert.strictEqual(schemaConformant(distinct[k]), true, 'non-conformant schema: ' + k))
  assert.ok(Object.keys(distinct).length >= 4)
})

prova('partition: an objection filed OUTSIDE the critic assignment is kept, tagged and warned', async () => {
  // critic-1 is assigned thesis-01 only; filing against thesis-02 breaks the
  // isolation the protocol promises. The objection may still be right, so it is
  // routed to the correct writer — but never silently.
  const cycle = agents({
    critic: (l) => (l === 'critic-1' ? [objection('thesis-02', 'blocking', 'OUT-OF-PARTITION')] : []),
  })
  const out = await run({ n_thesis: 2, n_critics: 2, n_seals: 1, seal_plan: ['check A'], rounds: 2 }, cycle.map)
  const routed = cycle.calls.filter((l) => l.indexOf('synthesis-') === 0)
  assert.deepStrictEqual(routed, ['synthesis-thesis-02'], 'the objection must reach the writer it is about')
  const entry = out.objections.filter((v) => v.data.evidence === 'OUT-OF-PARTITION')[0]
  assert.ok(entry, 'the objection must be in the ledger')
  assert.strictEqual(entry.data.out_of_partition, true, 'the violation must be recorded on the objection')
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('outside its assigned partition') >= 0)
})

prova('partition: an objection inside the assignment is NOT tagged', async () => {
  const cycle = agents({ critic: (l) => (l === 'critic-1' ? [objection('thesis-01', 'major', 'IN-PARTITION')] : []) })
  const out = await run({ n_thesis: 2, n_critics: 2, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, cycle.map)
  const entry = out.objections.filter((v) => v.data.evidence === 'IN-PARTITION')[0]
  assert.strictEqual(entry.data.out_of_partition, undefined)
  assert.strictEqual(out.global_verdict.warnings.join(' ').indexOf('outside its assigned partition'), -1)
})

/* ── regressioni dalla revisione avversaria ──────────────────────────────── */

prova('coverage: the right NUMBER of checks under the wrong commands is not coverage', async () => {
  const cycle = agents({
    seal: (l, p) => sealedFrom(p, { checks: sealedFrom(p).checks.map((c, i) => Object.assign({}, c, { command: 'unrelated ' + i })) }),
  })
  const out = await run({ n_seals: 1, seal_plan: ['check A', 'check B'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('coverage incomplete') >= 0)
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('never reported: check A, check B') >= 0)
})

prova('coverage: reporting one command twice does not cover two assigned checks', async () => {
  const cycle = agents({
    seal: (l, p) => { const first = sealedFrom(p).checks[0]; return sealedFrom(p, { checks: [first, first] }) },
  })
  const out = await run({ n_seals: 1, seal_plan: ['check A', 'check B'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  const notes = out.verdict_review[0].notes.join(' ')
  assert.ok(notes.indexOf('never reported: check B') >= 0, notes)
  assert.ok(notes.indexOf('outside the assignment: check A') >= 0, notes)
})

prova('coverage: a check that names no command is not a measurement', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { checks: [Object.assign({}, checkOk, { command: '   ' })] }) })
  const out = await run({ n_seals: 1, seal_plan: ['check A'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('empty command') >= 0)
})

prova('content: a schema-valid answer with an empty thesis is a fallen writer, not a thesis', async () => {
  const cycle = agents()
  const mappa = (label, prompt, opts) => (label === 'thesis-1'
    ? { id: 'x', thesis: '   ', findings: [], risks: [], proof_measure: 'm' }
    : cycle.map(label, prompt, opts))
  const out = await run({ n_thesis: 2, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, mappa)
  assert.strictEqual(out.theses.length, 1, 'the empty one must not count as a thesis')
  assert.ok(out.fallen_agents.some((c) => c.agent === 'thesis-1' && /empty thesis text/.test(c.reason)))
})

prova('content: an empty revised thesis is a fallen synthesis and the previous state stands', async () => {
  const cycle = agents({
    critic: () => [objection('thesis-01', 'major', 'E1')],
    synthesis: () => ({ revised_thesis: '', responses: [] }),
  })
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 2 }, cycle.map)
  assert.ok(out.fallen_agents.some((c) => c.agent === 'synthesis-thesis-01' && /empty revised thesis/.test(c.reason)))
  assert.strictEqual(out.current_theses[0].state, 'original', 'an empty revision must not overwrite the thesis')
  assert.strictEqual(out.global_verdict.outcome, 'INCONCLUSIVE', 'a dead synthesis phase is not a vote')
})

prova('rollup: a declared REVISE is never softened into INCONCLUSIVE', async () => {
  const cycle = agents({ seal: (l, p) => sealedFrom(p, { patch: { cases: 0 }, verdict: 'REVISE' }) })
  const out = await run({ n_seals: 1, seal_plan: ['check A'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.verdict_review[0].effective, 'REVISE')
  assert.strictEqual(out.verdict_review[0].coherence, 'ok')
  assert.strictEqual(out.global_verdict.outcome, 'REVISE')
  assert.ok(out.verdict_review[0].notes.join(' ').indexOf('declared REVISE kept') >= 0)
})

prova('robustness: a non-object objection is dropped, recorded and cannot crash the run', async () => {
  const cycle = agents({ critic: () => [null, 'nonsense', objection('thesis-01', 'major', 'REAL')] })
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.objections.length, 1, 'only the real objection reaches the ledger')
  assert.ok(out.fallen_agents.some((c) => c.agent === 'critic-1' && /malformed objection/.test(c.reason)))
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
})

prova('evidence: an objection with no evidence is tagged and warned, never taken on its word', async () => {
  const cycle = agents({ critic: () => [objection('thesis-01', 'major', '   ')] })
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.objections[0].data.unsubstantiated, true)
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('carry no evidence') >= 0)
})

prova('output: the verdict enums and the counter are the documented ones', async () => {
  const cycle = agents()
  const out = await run({ rounds: 1 }, cycle.map)
  assert.strictEqual(out.schema_version, 2)
  assert.strictEqual(out.tool, 'formalswarm')
  assert.deepStrictEqual(Object.keys(out.objection_count).sort(), ['accepted', 'orphan', 'rejected', 'to_answer', 'total', 'unanswered'])
  assert.ok(['CONFIRM', 'REVISE', 'INCONCLUSIVE'].indexOf(out.global_verdict.outcome) >= 0)
  assert.strictEqual(out.repository.root, REPO_ROOT)
})

prova('output: a CONFIRM with open blocking objections raises a warning', async () => {
  const cycle = agents({ critic: () => [objection('thesis-01', 'blocking', 'E-OPEN')] })
  const out = await run({ n_thesis: 1, n_critics: 1, n_seals: 1, seal_plan: ['check A'], rounds: 1 }, cycle.map)
  assert.strictEqual(out.global_verdict.outcome, 'CONFIRM')
  assert.ok(out.global_verdict.warnings.join(' ').indexOf('blocking objection') >= 0)
})

async function runAll() {
  let failed = 0
  for (const t of tests) {
    try { await t.fn() } catch (e) { failed++; console.error('FAILED  ' + t.name + ' :: ' + (e && e.message)) }
  }
  return { suite: 'body', total: tests.length, failed: failed }
}

module.exports = { runAll: runAll, tests: tests, run: run, argsBase: argsBase, agents: agents, verdictOk: verdictOk, checkOk: checkOk, thesisMock: thesisMock, objection: objection }

if (require.main === module) {
  runAll().then((r) => {
    console.log((r.failed === 0 ? 'body suite: all green (' : 'body suite: ' + r.failed + ' failed of ') + r.total + ')')
    process.exit(r.failed === 0 ? 0 : 1)
  }).catch((e) => { console.error(e); process.exit(1) })
}
