/*
 * FormalSwarm — debate.workflow.js
 * One deterministic multi-agent body: thesis / antithesis / synthesis / seal.
 * Three groups — thesis writers, critics (antithesis), seal verifiers (real
 * commands and real exit codes) — at any scale, from a 2+2+2 pilot to hundreds of
 * agents, with the size of the run stated up front and refused if it exceeds the
 * declared budget (`args.max_calls`, default 15).
 *
 * This file is the body of the `workflow` tool: it contains no import/require,
 * it reads no file (which is why the prompts travel in args.prompts) and it ends
 * with `return <json>`. The SAME text is executed, unchanged, by:
 *   - DeepSeek Harness, through its `workflow` tool;
 *   - Claude Code and ZCode, through `core/driver.js`, which supplies the same
 *     primitives (agent / parallel / pipeline / phase / log) and replays the
 *     body across rounds of real subagent answers.
 * That is what makes the verdict bit-for-bit identical on all three runtimes.
 *
 * META — pass to the `meta` parameter of the workflow tool (NOT part of the body):
 * {
 *   "name": "formalswarm",
 *   "description": "Repo-agnostic multi-agent debate at any scale: parallel theses, adversarial antithesis, and a seal whose verdict is computed deterministically from real command exit codes.",
 *   "whenToUse": "When a proposed change, an audit, or a technical claim must be validated by independent thesis writers, adversarial critics, and verifiers that actually run the repository's tests and measurements — at any scale, from a 2+2+2 pilot to hundreds of agents.",
 *   "phases": [
 *     { "title": "THESIS",       "detail": "thesis writers produce independent proposals/findings in parallel (isolated spawns)" },
 *     { "title": "ANTITHESIS",   "detail": "critics attack ONLY their assigned theses (partition made by the body), evidence re-read" },
 *     { "title": "SYNTHESIS",    "detail": "only the theses actually attacked answer their objections (rounds >= 2)" },
 *     { "title": "ANTITHESIS-2", "detail": "second wave on the revised state, with a deterministic cross-pollination board (rounds = 3)" },
 *     { "title": "SYNTHESIS-2",  "detail": "answers to the second round's new objections (rounds = 3)" },
 *     { "title": "SEAL",         "detail": "verifiers run the checks: verdict bound to exit code and case counter" }
 *   ]
 * }
 *
 * ARGS — the `args` parameter of the workflow tool (produced by
 * `node core/bin/formalswarm.js brief ...`, which embeds repo profile and prompts):
 * {
 *   "objective":        "...",                     // REQUIRED: one sentence, one objective
 *   "verdict_question": "...",                     // REQUIRED: the question the seal answers
 *   "context":          ["src/x.py", "..."],       // REQUIRED: 3-6 files to read (guarded)
 *   "seal_plan":        ["check 1", "check 2"],    // REQUIRED: runnable checks, each able to flip the answer
 *   "profile": {                                   // REQUIRED: the target repository profile
 *     "repo_root": "/abs/path", "repo_name": "x", "stack": "python",
 *     "test_command": "python3 -m pytest -q",
 *     "frozen_paths": ["src", "tests"],
 *     "scratch": ".formalswarm/scratch", "evidence_style": "path:line", "notes": []
 *   },
 *   "scratch": ".formalswarm/scratch/debate_<slug>",   // optional override
 *   "n_thesis": 2, "n_critics": 2, "n_seals": 2,       // any size from 1 to 500 per group
 *   "max_calls": 15,                                   // budget ceiling for the whole run; raise it freely
 *   "rounds": 1,                                       // 1 = thesis+antithesis+seal; 2 = +SYNTHESIS; 3 = +ANTITHESIS-2+SYNTHESIS-2
 *   "prompts": { "thesis": "...", "antithesis": "...", "seal": "..." }  // full text of prompts/*.md
 * }
 *
 * DETERMINISTIC ROLLUP (the seal of seals, computed by the body, never negotiated):
 * - every seal check carries exit_code (0 = passed; -1 = not run) and cases
 *   (rows/cases the tool really saw; -1 = the tool counts nothing);
 * - an "ok" with exit_code -1 (the not-run sentinel) is a check NOT RUN ->
 *   INCONCLUSIVE; an "ok" with any other non-zero exit_code is "failed" -> REVISE;
 * - an "ok" with cases <= 0 is empty green or unmeasured and becomes
 *   "unsupported" (the -1 sentinel never crosses the rollup: it blocks CONFIRM);
 * - COVERAGE: the ASSIGNED checks are compared with the REPORTED ones — a missing
 *   check (or an empty seal) makes the verdict INCONCLUSIVE, whatever the agent
 *   declared;
 * - a verifier declaring CONFIRM that its own checks do not support is CORRECTED on
 *   the spot; the correction only ever moves in the pessimistic direction (a
 *   declared "failed" with exit_code 0 stays failed);
 * - DEAD PHASES: a whole group fallen (antithesis or synthesis with no valid answer)
 *   is not a vote: global verdict INCONCLUSIVE; every fallen agent raises a warning;
 * - global_verdict: REVISE when any check fails or a verifier says REVISE;
 *   INCONCLUSIVE for a mute/incomplete seal, a check not run or unsupported,
 *   empty=yes, or a dead phase; CONFIRM only when everything else is clean.
 *   Fail-closed: silence is never a vote.
 *
 * METHODOLOGICAL NOTE: the thesis and antithesis groups run on isolated spawns (the
 * `agent` hook has a fresh context and shares no conversation); a `fork` primitive
 * does not exist here and would destroy the independence of the antithesis, so the
 * real zero-cost mechanism is the deterministic partition made below, which hands
 * each critic ONLY its own theses. The programmatic part of the seal (Group 3) lives
 * in the exit_code/cases constraint and in this rollup, which judges the reported
 * facts, not the verifiers' prose.
 */
const a = args || {}
const isText = (s) => typeof s === 'string' && s.trim().length > 0
const required = (k) => {
  if (a[k] === undefined || a[k] === null) throw new Error('args.' + k + ' is required')
}
required('objective')
required('verdict_question')
required('context')
required('seal_plan')
if (!Array.isArray(a.context) || a.context.length < 3 || a.context.length > 6 || !a.context.every(isText)) {
  throw new Error('args.context must hold 3 to 6 file paths (received: ' + (Array.isArray(a.context) ? a.context.length : 'not-a-list') + ')')
}
if (!Array.isArray(a.seal_plan) || a.seal_plan.length < 1 || !a.seal_plan.every(isText)) {
  throw new Error('args.seal_plan must be a non-empty list of runnable checks (strings)')
}
if (!a.prompts || !isText(a.prompts.thesis) || !isText(a.prompts.antithesis) || !isText(a.prompts.seal)) {
  throw new Error('args.prompts requires { thesis, antithesis, seal }: read prompts/*.md and pass them verbatim')
}
if (!a.profile || typeof a.profile !== 'object' || !isText(a.profile.repo_root)) {
  throw new Error('args.profile.repo_root is required: run `formalswarm init` in the target repository and pass the resulting profile')
}

// Numbers are validated: a truthy non-numeric argument (e.g. "abc") must fail HERE
// with a clear error instead of turning into NaN and producing the misleading
// "no thesis was produced".
const toNumber = (v, name, preset) => {
  if (v === undefined || v === null || v === '') return preset
  const n = Math.floor(Number(v))
  if (!isFinite(n)) throw new Error('args.' + name + ' must be a number (received: ' + JSON.stringify(v) + ')')
  return n
}
// Scaling is the user's call: the groups have no policy ceiling, only a sanity one
// that catches a typo (--thesis 100000) before it spawns anything. The real ceiling
// is the declared budget below, and it is meant to be raised.
const MAX_GROUP = 500
const DEFAULT_MAX_CALLS = 15
const groupSize = (value, name, preset) => {
  const n = toNumber(value, name, preset)
  if (n < 1) throw new Error('args.' + name + ' must be at least 1 (received: ' + n + ')')
  if (n > MAX_GROUP) throw new Error('args.' + name + ' is ' + n + ', above the sanity ceiling of ' + MAX_GROUP + ' agents per group')
  return n
}
const nT = groupSize(a.n_thesis, 'n_thesis', 2)
const nK = groupSize(a.n_critics, 'n_critics', 2)
const nS = groupSize(a.n_seals, 'n_seals', 2)
const rounds = Math.max(1, Math.min(3, toNumber(a.rounds, 'rounds', 1)))

// BUDGET (worst case: every synthesis needed, every group at full size). The ceiling
// defaults to the safe pilot value and is raised explicitly — a run that would cost
// more than declared is refused BEFORE the first call, never discovered halfway.
const maxCalls = Math.max(1, toNumber(a.max_calls, 'max_calls', DEFAULT_MAX_CALLS))
const planned = nT + nK + nS + (rounds >= 2 ? nT : 0) + (rounds >= 3 ? nK + nT : 0)
if (planned > maxCalls) {
  throw new Error('budget exceeded: ' + planned + ' planned calls > max_calls=' + maxCalls +
    ' (plan is ' + nT + '+' + nK + '+' + nS + ' rounds=' + rounds + '; pass args.max_calls=' + planned + ' — or --max-calls ' + planned + ' — to allow it)')
}
const budget = { planned: planned, executed: 0, max_calls: maxCalls }
const call = (prompt, opts) => { budget.executed += 1; return agent(prompt, opts) }

/* ── repository facts, taken from the profile (no domain knowledge here) ──── */
const repo = a.profile
const repoRoot = repo.repo_root
const repoName = isText(repo.repo_name) ? repo.repo_name : repoRoot
const stack = isText(repo.stack) ? repo.stack : 'unknown'
const testCommand = isText(repo.test_command) ? repo.test_command : 'none detected — the seal must be given explicit commands'
const frozen = Array.isArray(repo.frozen_paths) && repo.frozen_paths.length > 0 ? repo.frozen_paths.join(', ') : 'the repository source and test directories'
const evidence = isText(repo.evidence_style) ? repo.evidence_style : 'path:line'
const scratchRaw = isText(a.scratch) ? a.scratch : (isText(repo.scratch) ? repo.scratch : '.formalswarm/scratch')
// The brief always carries an absolute scratch path; this is the fallback for a
// hand-written brief, and it keeps every agent on the same directory.
const scratch = (scratchRaw.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(scratchRaw))
  ? scratchRaw
  : repoRoot.replace(/[\\/]+$/, '') + '/' + scratchRaw.replace(/^[\\/]+/, '')
const extraNotes = Array.isArray(repo.notes) && repo.notes.length > 0 ? ' Profile notes: ' + repo.notes.join(' | ') + '.' : ''

const fill = (text) => String(text)
  .split('{{SCRATCH}}').join(scratch)
  .split('{{REPO_ROOT}}').join(repoRoot)
  .split('{{REPO_NAME}}').join(repoName)
  .split('{{STACK}}').join(stack)
  .split('{{TEST_COMMAND}}').join(testCommand)
  .split('{{FROZEN_PATHS}}').join(frozen)
  .split('{{EVIDENCE_STYLE}}').join(evidence)

const pad2 = (i) => String(i + 1).padStart(2, '0')
const shorten = (s, n) => { const t = String(s); return t.length > n ? t.slice(0, n) + '…' : t }

const commonBrief = [
  'REPOSITORY: ' + repoRoot + ' (' + repoName + ') — stack: ' + stack + '.',
  'CANONICAL TEST COMMAND: ' + testCommand,
  'OBJECTIVE OF THE DEBATE: ' + a.objective,
  'VERDICT QUESTION (the seal answers this): ' + a.verdict_question,
  'CONTEXT FILES (read them BEFORE stating anything; use grep/offset on large files):',
  a.context.map((f) => '- ' + f).join('\n'),
  'SCRATCH DIRECTORY (the only place where you may write experiments and notes): ' + scratch + ' (mkdir -p if missing).',
  'RULES FOR EVERYONE: production is frozen (never write to ' + frozen + '); every statement about the code carries a ' + evidence + ' reference verified personally; no concurrent requests to a shared service; no invented data — if something is missing, state exactly what is missing and what threshold would suffice.' + extraNotes,
].join('\n')

/* ── output schemas (only keywords the workflow tool accepts) ─────────────── */

const schemaThesis = {
  type: 'object',
  required: ['id', 'thesis', 'findings', 'risks', 'proof_measure'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    thesis: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'evidence'],
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    proof_measure: { type: 'string' },
  },
}

const schemaObjections = {
  type: 'object',
  required: ['objections'],
  additionalProperties: false,
  properties: {
    objections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['thesis_id', 'type', 'severity', 'evidence', 'fix'],
        additionalProperties: false,
        properties: {
          thesis_id: { type: 'string' },
          type: { type: 'string', enum: ['hallucination', 'dead_control', 'dead_guard', 'logic_bug', 'bad_measurement', 'empty_green', 'safety', 'other'] },
          severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const schemaSynthesis = {
  type: 'object',
  required: ['revised_thesis', 'responses'],
  additionalProperties: false,
  properties: {
    revised_thesis: { type: 'string' },
    responses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['objection', 'outcome', 'reason'],
        additionalProperties: false,
        properties: {
          objection: { type: 'string' },
          outcome: { type: 'string', enum: ['accepted', 'rejected'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const schemaVerdict = {
  type: 'object',
  required: ['checks', 'verdict', 'measurement_limit', 'rationale', 'empty'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'outcome', 'detail', 'exit_code', 'cases'],
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          outcome: { type: 'string', enum: ['ok', 'failed', 'not_run'] },
          detail: { type: 'string' },
          exit_code: { type: 'integer' },
          cases: { type: 'integer' },
        },
      },
    },
    verdict: { type: 'string', enum: ['CONFIRM', 'REVISE', 'INCONCLUSIVE'] },
    measurement_limit: { type: 'string' },
    rationale: { type: 'string' },
    empty: { type: 'string', enum: ['yes', 'no'] },
  },
}

/* ── THESIS ──────────────────────────────────────────────────────────────── */

phase('THESIS')
log('Thesis writers at work: ' + nT + ' independent positions (isolated spawns, no shared context)')
const thesisRuns = await parallel(
  Array.from({ length: nT }, (_, i) => () => call(
    [
      fill(a.prompts.thesis),
      commonBrief,
      'YOU ARE THESIS WRITER number ' + (i + 1) + ' of ' + nT + ': independent perspective, do not coordinate with the other writers.',
      'Your id is "thesis-' + pad2(i) + '": use it in the id field.',
      'Write the full readable text of the thesis into ' + scratch + '/thesis_' + pad2(i) + '.md',
      'OUTPUT SCHEMA (respect every required field): ' + JSON.stringify(schemaThesis),
    ].join('\n\n'),
    { label: 'thesis-' + (i + 1), phase: 'THESIS', schema: schemaThesis }
  ))
)

const fallen = []
const theses = []
thesisRuns.forEach((r, i) => {
  // An empty string satisfies every JSON schema, so the content check has to live
  // here — where all three runtimes run the same code. A schema-valid answer with no
  // text is not a thesis.
  if (r && typeof r === 'object' && isText(r.thesis)) {
    r.id = 'thesis-' + pad2(i) // canonical id assigned by the body: never trust the one the agent wrote
    theses.push(r)
  } else {
    fallen.push({
      phase: 'THESIS',
      agent: 'thesis-' + (i + 1),
      reason: r && typeof r === 'object' ? 'empty thesis text' : 'no answer',
    })
  }
})
if (theses.length === 0) throw new Error('no thesis was produced: check args.prompts.thesis and the brief')
log('Theses produced: ' + theses.map((t) => t.id).join(', '))

const thesisIds = theses.map((t) => t.id)
const thesisState = {}
theses.forEach((t) => { thesisState[t.id] = { state: 'original', text: t.thesis } })
// FULL projection of a thesis: findings/risks/measure reach the seal and the round-2
// critics, not just the text (a verifier must be able to REPRODUCE the findings).
const fullThesis = (t) => ({
  id: t.id,
  state: thesisState[t.id].state,
  thesis: thesisState[t.id].text,
  findings: t.findings,
  risks: t.risks,
  proof_measure: t.proof_measure,
})
// Scale guards: a run with hundreds of agents must not turn the seal brief into a
// megabyte of prose. The seal material keeps EVERY blocking objection and clips long
// theses; nothing is lost, because the full texts live in the scratch files.
const BOARD_MAX_LINES = 200
const MATERIAL_MAX_OBJECTIONS = 120
const MATERIAL_MAX_THESIS_CHARS = 6000
let clippedTheses = 0
const materialThesis = (t) => {
  const full = fullThesis(t)
  if (full.thesis.length <= MATERIAL_MAX_THESIS_CHARS) return full
  clippedTheses += 1
  return Object.assign({}, full, { thesis: full.thesis.slice(0, MATERIAL_MAX_THESIS_CHARS) + '\n[truncated in the brief: the full text is in the scratch file written by the writer]' })
}
// Fail-closed on PHASES: the death of a whole group is not a vote.
let antithesisDead = false
let synthesisDead = false

/* ── objection ledger: every entry has a deterministic state, moved only by
      SYNTHESIS, never by a critic's own claim ─────────────────────────────── */
const ledger = []
const addObjections = (round, split) => {
  split.good.forEach((o) => ledger.push({ round: round, thesis_id: o.thesis_id, data: o, state: 'to_answer' }))
  split.orphan.forEach((o) => ledger.push({ round: round, thesis_id: null, data: o, state: 'orphan' }))
}
const splitByThesis = (list) => {
  const good = []
  const orphan = []
  const safe = list || []
  safe.forEach((o) => {
    // Last line of defence: nothing that is not an objection may reach the ledger,
    // whatever resolver produced it.
    if (!o || typeof o !== 'object') return
    ;(thesisIds.indexOf(o.thesis_id) >= 0 ? good : orphan).push(o)
  })
  return { good: good, orphan: orphan }
}
// An objection filed against a thesis the critic was NOT assigned breaks the
// isolation the protocol promises. It is kept — it may still be right — but it is
// tagged, routed to the correct writer, and counted in the warnings: a violated
// partition must never be invisible. The same pass drops anything that is not an
// objection at all and flags an objection that carries no evidence.
const collectCriticism = (runs, prefix, mapping, phaseName, assignment) => {
  const gathered = []
  runs.forEach((r, i) => {
    const who = prefix + (mapping[i] !== undefined ? mapping[i] + 1 : i + 1)
    if (!r || !Array.isArray(r.objections)) {
      fallen.push({ phase: phaseName || 'ANTITHESIS', agent: who, reason: 'no answer' })
      return
    }
    const usable = []
    let malformed = 0
    r.objections.forEach((o) => { if (o && typeof o === 'object') usable.push(o); else malformed += 1 })
    if (malformed > 0) {
      fallen.push({ phase: phaseName || 'ANTITHESIS', agent: who, reason: malformed + ' malformed objection(s) dropped before the ledger' })
    }
    const allowed = assignment && assignment[i] ? assignment[i] : null
    usable.forEach((o) => {
      let entry = o
      if (!isText(o.evidence)) entry = Object.assign({}, entry, { unsubstantiated: true })
      if (allowed && allowed.indexOf(o.thesis_id) < 0) entry = Object.assign({}, entry, { out_of_partition: true })
      gathered.push(entry)
    })
  })
  return gathered
}

/* ── ANTITHESIS (round 1) ────────────────────────────────────────────────── */

phase('ANTITHESIS')
const partitionR1 = []
for (let i = 0; i < nK; i++) partitionR1.push(theses.filter((_, j) => j % nK === i))
const activeR1 = partitionR1.map((p, i) => ({ i: i, theses: p })).filter((p) => p.theses.length > 0)
log('Round-1 critics: ' + activeR1.length + ' active out of ' + nK + ' (partition made by the body: each critic receives ONLY its own theses)')
const criticismR1 = await parallel(
  activeR1.map((p) => () => call(
    [
      fill(a.prompts.antithesis),
      commonBrief,
      'YOU ARE CRITIC number ' + (p.i + 1) + ' of ' + nK + '. You are assigned ONLY the following theses (partition assigned by the orchestrator): do not judge the other writers\' theses.',
      'ASSIGNED THESES (JSON): ' + JSON.stringify(p.theses),
      'OUTPUT SCHEMA: ' + JSON.stringify(schemaObjections),
    ].join('\n\n'),
    { label: 'critic-' + (p.i + 1), phase: 'ANTITHESIS', schema: schemaObjections }
  ))
)
const validR1 = criticismR1.filter((r) => r && Array.isArray(r.objections)).length
if (activeR1.length > 0 && validR1 === 0) antithesisDead = true
const r1 = splitByThesis(collectCriticism(criticismR1, 'critic-', activeR1.map((p) => p.i), undefined, activeR1.map((p) => p.theses.map((t) => t.id))))
addObjections(1, r1)
log('Round-1 objections: ' + r1.good.length + ' assignable, ' + r1.orphan.length + ' orphan (to the seal), blocking: ' + r1.good.filter((o) => o.severity === 'blocking').length)

/* ── SYNTHESIS: one helper for every round ───────────────────────────────── */

const allSynthesis = []
const runSynthesis = async (phaseTitle, goodObjections, round) => {
  phase(phaseTitle)
  const byThesis = {}
  goodObjections.forEach((o) => { (byThesis[o.thesis_id] = byThesis[o.thesis_id] || []).push(o) })
  const attacked = Object.keys(byThesis)
  if (attacked.length === 0) {
    log('No objection to answer: ' + phaseTitle + ' skipped (zero calls)')
    return { expected: 0, done: 0 }
  }
  log(phaseTitle + ': ' + attacked.length + ' of ' + theses.length + ' theses have objections; the others cost nothing')
  const runs = await parallel(
    attacked.map((id, k) => () => {
      const t = theses.filter((x) => x.id === id)[0]
      const mine = byThesis[id]
      const previous = thesisState[id]
      return call(
        [
          fill(a.prompts.thesis),
          commonBrief,
          'YOU ARE THESIS WRITER "' + id + '" IN THE SYNTHESIS PHASE. Original thesis (JSON): ' + JSON.stringify(t),
          'Current state of your thesis (' + previous.state + '): ' + previous.text,
          'OBJECTIONS ADDRESSED TO YOU — answer them ONE BY ONE (JSON): ' + JSON.stringify(mine),
          'In the `objection` field of every response COPY EXACTLY the `evidence` field of the objection you are answering: the accepted/rejected count is deterministic and compares those strings.',
          'Accept the objections that are right and fix the thesis; reject the wrong ones WITH AN ARGUMENT. Write the revised version into ' + scratch + '/synthesis_r' + round + '_' + pad2(k) + '.md',
          'OUTPUT SCHEMA: ' + JSON.stringify(schemaSynthesis),
        ].join('\n\n'),
        { label: 'synthesis-' + id, phase: phaseTitle, schema: schemaSynthesis }
      )
    })
  )
  let done = 0
  runs.forEach((r, k) => {
    const id = attacked[k]
    if (r && typeof r === 'object' && isText(r.revised_thesis)) {
      done += 1
      allSynthesis.push({ phase: phaseTitle, thesis_id: id, synthesis: r })
      thesisState[id] = { state: 'revised', text: r.revised_thesis }
    } else {
      fallen.push({
        phase: phaseTitle,
        agent: 'synthesis-' + id,
        reason: r && typeof r === 'object' ? 'empty revised thesis' : 'no answer',
      })
    }
  })
  return { expected: attacked.length, done: done }
}
const closeRound = (round) => {
  const byThesis = {}
  allSynthesis
    .filter((f) => f.phase === (round === 1 ? 'SYNTHESIS' : 'SYNTHESIS-2'))
    .forEach((f) => { byThesis[f.thesis_id] = f.synthesis })
  const entries = {}
  ledger.forEach((entry) => {
    if (entry.round === round && entry.thesis_id !== null) (entries[entry.thesis_id] = entries[entry.thesis_id] || []).push(entry)
  })
  Object.keys(entries).forEach((id) => {
    const s = byThesis[id]
    if (!s) return // thesis never attacked: stays "to_answer" and reaches the seal material
    const responses = (s.responses || []).map((x) => ({ objection: x.objection, outcome: x.outcome, used: false }))
    entries[id].forEach((entry) => {
      const idx = responses.findIndex((r) => !r.used && r.objection === entry.data.evidence)
      if (idx >= 0) {
        responses[idx].used = true // duplicate evidence: each response consumes ONE entry only
        entry.state = responses[idx].outcome === 'accepted' ? 'accepted' : 'rejected'
      } else {
        entry.state = 'unanswered'
      }
    })
  })
}

if (rounds >= 2) {
  const s1 = await runSynthesis('SYNTHESIS', r1.good, 1)
  if (s1.expected > 0 && s1.done === 0) synthesisDead = true
  closeRound(1)
}

/* ── ANTITHESIS 2 + SYNTHESIS 2 (rounds = 3 only) ─────────────────────────── */

let r2 = { good: [], orphan: [] }
if (rounds >= 3) {
  phase('ANTITHESIS-2')
  const current = theses.map(fullThesis)
  const boardLines = ledger.map((v) => 'R' + v.round + ' [' + (v.thesis_id || 'orphan') + '][' + v.data.severity + '/' + v.data.type + '][' + v.state + ']' + (v.data.out_of_partition ? '[out-of-partition]' : '') + ' ' + shorten(v.data.evidence, 160))
  // A board is a navigational aid, not the ledger: on a run with hundreds of
  // objections an unbounded board would crowd out the theses it is meant to frame.
  const board = boardLines.slice(0, BOARD_MAX_LINES).join('\n') +
    (boardLines.length > BOARD_MAX_LINES ? '\n… ' + (boardLines.length - BOARD_MAX_LINES) + ' further entries omitted from the board: the full ledger is in the outcome, read it there' : '')
  const partitionR2 = []
  for (let i = 0; i < nK; i++) partitionR2.push(current.filter((_, j) => j % nK === i))
  const activeR2 = partitionR2.map((p, i) => ({ i: i, theses: p })).filter((p) => p.theses.length > 0)
  log('ANTITHESIS-2: ' + activeR2.length + ' critics on the revised state, with a cross-pollination board')
  const criticismR2 = await parallel(
    activeR2.map((p) => () => call(
      [
        fill(a.prompts.antithesis),
        commonBrief,
        'YOU ARE CRITIC number ' + (p.i + 1) + ' of ' + nK + ' IN THE SECOND ROUND. You are assigned ONLY these theses in their CURRENT STATE (JSON): ' + JSON.stringify(p.theses),
        'FIRST-ROUND BOARD (deterministic synthesis by the orchestrator, state of every objection):\n' + board,
        'Do NOT re-file objections marked "accepted" (they are absorbed into the revision); reopening a "rejected" one requires NEW evidence; look for fresh material or for repairs done badly.',
        'OUTPUT SCHEMA: ' + JSON.stringify(schemaObjections),
      ].join('\n\n'),
      { label: 'critic2-' + (p.i + 1), phase: 'ANTITHESIS-2', schema: schemaObjections }
    ))
  )
  const validR2 = criticismR2.filter((r) => r && Array.isArray(r.objections)).length
  if (activeR2.length > 0 && validR2 === 0) antithesisDead = true
  r2 = splitByThesis(collectCriticism(criticismR2, 'critic2-', activeR2.map((p) => p.i), 'ANTITHESIS-2', activeR2.map((p) => p.theses.map((t) => t.id))))
  addObjections(2, r2)
  log('Round-2 objections: ' + r2.good.length + ' assignable, ' + r2.orphan.length + ' orphan')
  const s2 = await runSynthesis('SYNTHESIS-2', r2.good, 2)
  if (s2.expected > 0 && s2.done === 0) synthesisDead = true
  closeRound(2)
}

/* ── SEAL ────────────────────────────────────────────────────────────────── */

phase('SEAL')
const activeSeals = Math.min(nS, a.seal_plan.length)
const perSeal = Array.from({ length: activeSeals }, (_, i) => a.seal_plan.filter((_, j) => j % activeSeals === i))
const finalTheses = theses.map(fullThesis)
const everyObjection = ledger.filter((v) => v.thesis_id !== null).map((v) => ({ round: v.round, thesis_id: v.thesis_id, state: v.state, severity: v.data.severity, type: v.data.type, evidence: v.data.evidence, fix: v.data.fix, out_of_partition: v.data.out_of_partition === true }))
// Every BLOCKING objection is always in the material — the seal has to judge each of
// them with a command. Non-blocking ones are quality notes and are bounded.
const objectionsForSeal = everyObjection.filter((o) => o.severity === 'blocking')
  .concat(everyObjection.filter((o) => o.severity !== 'blocking').slice(0, Math.max(0, MATERIAL_MAX_OBJECTIONS - everyObjection.filter((o) => o.severity === 'blocking').length)))
const objectionsOmitted = everyObjection.length - objectionsForSeal.length
const material = {
  current_theses: theses.map(materialThesis),
  objections: objectionsForSeal,
  objections_omitted: objectionsOmitted,
  orphan_objections: ledger.filter((v) => v.thesis_id === null).map((v) => ({ round: v.round, severity: v.data.severity, type: v.data.type, evidence: v.data.evidence, fix: v.data.fix })),
}
const openBlocking = everyObjection.filter((o) => o.severity === 'blocking' && o.state !== 'accepted')
log('Seal: ' + activeSeals + ' verifiers over ' + a.seal_plan.length + ' checks; blocking objections still open: ' + openBlocking.length)
const sealRuns = await parallel(
  Array.from({ length: activeSeals }, (_, i) => () => call(
    [
      fill(a.prompts.seal),
      commonBrief,
      'YOU ARE SEAL VERIFIER number ' + (i + 1) + ' of ' + activeSeals + '. ASSIGNED CHECKS — run ALL of them for real, with real commands: ' + JSON.stringify(perSeal[i]),
      'For EVERY check report: the exact command; the outcome; the REAL exit_code ($? — use "command; echo exit=$?"; -1 only when not run); cases = how many rows/cases the tool REALLY saw (-1 only when the tool counts nothing); detail with the output.',
      'MATERIAL UNDER JUDGEMENT (JSON): ' + JSON.stringify(material),
      'BLOCKING OBJECTIONS STILL OPEN — judge them WITH COMMANDS, not with taste: ' + JSON.stringify(openBlocking),
      'Your verdict is RE-CHECKED by the body: a CONFIRM with a failed check, with cases=0, or with empty=yes is corrected on the spot. When two findings contradict each other: write the discriminating script and report its output and exit code.',
      'Your scripts, if any, go only into ' + scratch + '/seal_' + (i + 1) + '/.',
      'OUTPUT SCHEMA: ' + JSON.stringify(schemaVerdict),
    ].join('\n\n'),
    { label: 'seal-' + (i + 1), phase: 'SEAL', schema: schemaVerdict }
  ))
)
const sealVerdicts = []
sealRuns.forEach((r, i) => {
  if (r && typeof r === 'object') sealVerdicts.push({ index: i, data: r }) // ORIGINAL index: labels never shift when a colleague falls
  else fallen.push({ phase: 'SEAL', agent: 'seal-' + (i + 1) })
})

/* ── DETERMINISTIC ROLLUP ────────────────────────────────────────────────── */

const normalizeChecks = (checks) => (checks || []).map((c) => {
  const exit = typeof c.exit_code === 'number' ? c.exit_code : -1
  const cases = typeof c.cases === 'number' ? c.cases : -1
  let outcomeNorm = c.outcome
  const notes = []
  if (c.outcome === 'ok' && exit === -1) { outcomeNorm = 'not_run'; notes.push('outcome "ok" but exit_code=-1 (the not-run sentinel): the check does not appear to have been run') }
  else if (c.outcome === 'ok' && exit !== 0) { outcomeNorm = 'failed'; notes.push('outcome "ok" but exit_code=' + exit) }
  else if (c.outcome === 'ok' && cases <= 0) { outcomeNorm = 'unsupported'; notes.push(cases === 0 ? 'empty green: 0 cases seen' : 'cases not counted (the -1 sentinel): the green is unverifiable') }
  // A check that names no command is not a measurement, whatever its exit code says.
  // A declared failure is never softened by this: it stays failed.
  if (outcomeNorm !== 'failed' && !isText(c.command)) {
    outcomeNorm = 'unsupported'
    notes.push('empty command: a check that names no command cannot be reproduced, so it proves nothing')
  }
  return { command: c.command, declared_outcome: c.outcome, exit_code: exit, cases: cases, normalized_outcome: outcomeNorm, notes: notes }
})
const verdictReview = sealVerdicts.map((v) => {
  const assigned = perSeal[v.index] ? perSeal[v.index] : []
  const checks = normalizeChecks(v.data.checks)
  const failed = checks.some((c) => c.normalized_outcome === 'failed')
  // COVERAGE IS A MATCH, NOT A COUNT. Every assigned check must be answered by a
  // reported check that names the SAME command: a verifier that returns the right
  // number of checks under different names has verified nothing it was asked to.
  const outstanding = assigned.slice()
  const unassigned = []
  checks.forEach((c) => {
    const at = outstanding.indexOf(c.command)
    if (at >= 0) outstanding.splice(at, 1)
    else unassigned.push(String(c.command))
  })
  const missing = outstanding.length
  const unsupported = checks.some((c) => c.normalized_outcome === 'unsupported' || c.normalized_outcome === 'not_run') || missing > 0
  const declared = v.data.verdict
  let effective = declared
  if (failed) effective = 'REVISE'
  // A verifier that says it saw a failure is never softened into "missing data": its
  // checks not supporting the claim is exactly the case the protocol warns about, but
  // the verdict it declared stays, and the coverage defect is recorded next to it.
  else if (declared === 'REVISE') effective = 'REVISE'
  else if (unsupported || v.data.empty === 'yes') effective = 'INCONCLUSIVE'
  const checkNotes = checks.map((c) => c.notes).reduce((x, y) => x.concat(y), [])
  const coverageNotes = []
  if (missing > 0) coverageNotes.push('coverage incomplete: assigned ' + assigned.length + ', matched ' + (assigned.length - missing) + '; never reported: ' + outstanding.join(', '))
  if (unassigned.length > 0) coverageNotes.push('reported checks outside the assignment: ' + unassigned.join(', '))
  const softened = !failed && declared === 'REVISE' && unsupported
  const notes = coverageNotes.concat(checkNotes)
  if (softened) notes.push('declared REVISE kept although the checks do not prove a failure: a verifier may have seen something an exit code cannot capture')
  if (effective !== declared) notes.push('declared verdict ' + declared + ', recomputed ' + effective + ' from the checks')
  return { verifier: 'seal-' + (v.index + 1), declared: declared, effective: effective, coherence: effective === declared ? 'ok' : 'corrected_by_the_body', notes: notes }
})
let globalOutcome
let globalReason
const warnings = []
if (sealVerdicts.length === 0) {
  globalOutcome = 'INCONCLUSIVE'
  globalReason = 'mute seal: no verifier produced a conformant verdict (fallen agents or rejected schema)'
} else if (sealVerdicts.length < activeSeals) {
  globalOutcome = 'INCONCLUSIVE'
  globalReason = 'incomplete seal: ' + (activeSeals - sealVerdicts.length) + ' of ' + activeSeals + ' verifiers fell'
} else if (verdictReview.some((p) => p.effective === 'REVISE')) {
  globalOutcome = 'REVISE'
  globalReason = 'at least one seal check fails (exit_code != 0) or a verifier declares REVISE'
} else if (verdictReview.some((p) => p.effective === 'INCONCLUSIVE')) {
  globalOutcome = 'INCONCLUSIVE'
  globalReason = 'a check was not run or is empty green in the seal: the measurement is missing'
} else if (antithesisDead || synthesisDead) {
  globalOutcome = 'INCONCLUSIVE'
  globalReason = 'a debate phase died: ' + (antithesisDead ? 'antithesis with no valid answer' : '') + (antithesisDead && synthesisDead ? '; ' : '') + (synthesisDead ? 'synthesis with no valid answer' : '')
} else {
  globalOutcome = 'CONFIRM'
  globalReason = 'every check of the ' + activeSeals + ' verifiers: outcome ok, exit_code 0, cases > 0'
}
if (globalOutcome === 'CONFIRM' && openBlocking.length > 0) {
  warnings.push('CONFIRM with ' + openBlocking.length + ' blocking objection(s) still open (rejected or unanswered): check that the seal judged them with dedicated checks')
}
if (material.orphan_objections.length > 0) {
  warnings.push(material.orphan_objections.length + ' objection(s) point at non-existent thesis ids: passed to the seal without synthesis')
}
const outOfPartition = everyObjection.filter((o) => o.out_of_partition)
if (outOfPartition.length > 0) {
  warnings.push(outOfPartition.length + ' objection(s) were filed by a critic outside its assigned partition (the isolation the protocol promises was violated): they were kept and routed to the correct writer, but read them with care')
}
const unsubstantiated = ledger.filter((v) => v.data.unsubstantiated)
if (unsubstantiated.length > 0) {
  warnings.push(unsubstantiated.length + ' objection(s) carry no evidence: an objection without evidence is itself a hallucination, and none of them may be accepted on its word')
}
if (objectionsOmitted > 0) {
  warnings.push(objectionsOmitted + ' non-blocking objection(s) were left out of the seal brief to keep it bounded (every blocking one is included): the full ledger is in this outcome')
}
if (clippedTheses > 0) {
  warnings.push(clippedTheses + ' thesis text(s) were truncated in the seal brief: the full versions are the scratch files the writers wrote')
}
if (planned > 15) {
  warnings.push('large run: ' + planned + ' planned agent calls across ' + nT + ' thesis writers, ' + nK + ' critics and ' + nS + ' verifiers — the runtime concurrency cap is the final arbiter, and a spawn it refuses is recorded as a fallen agent')
}
const corrected = verdictReview.filter((p) => p.coherence !== 'ok')
if (corrected.length > 0) warnings.push(corrected.length + ' seal verdict(s) corrected by the rollup')
const fallenByPhase = {}
fallen.forEach((c) => { fallenByPhase[c.phase] = (fallenByPhase[c.phase] || 0) + 1 })
Object.keys(fallenByPhase).forEach((f) => warnings.push('phase ' + f + ': ' + fallenByPhase[f] + ' fallen agent(s)'))
const count = { total: ledger.length, accepted: 0, rejected: 0, unanswered: 0, to_answer: 0, orphan: 0 }
ledger.forEach((v) => { count[v.state] = (count[v.state] || 0) + 1 })

/* ── OUTCOME ─────────────────────────────────────────────────────────────── */

return {
  schema_version: 2,
  tool: 'formalswarm',
  objective: a.objective,
  verdict_question: a.verdict_question,
  repository: { root: repoRoot, name: repoName, stack: stack, test_command: testCommand, frozen_paths: repo.frozen_paths || [], evidence_style: evidence },
  config: { thesis: nT, critics: nK, seals: nS, rounds: rounds, scratch: scratch, seal_checks: a.seal_plan.length, active_seals: activeSeals },
  budget: budget,
  global_verdict: { outcome: globalOutcome, reason: globalReason, warnings: warnings },
  objection_count: count,
  theses: theses,
  current_theses: finalTheses,
  objections: ledger,
  synthesis: allSynthesis,
  seal_verdicts: sealVerdicts.map((v) => v.data),
  verdict_review: verdictReview,
  fallen_agents: fallen,
}
