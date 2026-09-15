'use strict'
/*
 * validate-generic.js — the guards that keep FormalSwarm usable on ANY repository.
 *
 * A plugin that claims to be repo-agnostic must be able to prove it: these suites
 * fail the moment a domain word, a machine-specific path, a language assumption or
 * a drifted manifest creeps back into the shipped files. The legacy `agents/` tree
 * of this repository is deliberately NOT scanned — it is the historical,
 * repository-specific debate and stays untouched.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const brief = require('./brief.js')
const driver = require('./driver.js')

/* Every file FormalSwarm actually ships: the walk below covers the shipped directories
   plus the top-level files. `tests/` IS shipped (package.json `files` includes
   tests/*.js and tests/fixtures/**), so it is scanned like the rest. `agents/`
   (legacy) is not part of the package and stays out. */
function shippedFiles() {
  const list = [
    'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE',
    '.gitignore', '.gitattributes',
    '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'lib/skills.mjs',
  ]
  const walk = (rel) => {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) return
    fs.readdirSync(abs).forEach((entry) => {
      const child = path.join(rel, entry)
      if (fs.statSync(path.join(ROOT, child)).isDirectory()) walk(child)
      else list.push(child.replace(/\\/g, '/'))
    })
  }
  ;['core', 'prompts', 'skills', 'commands', 'tests'].forEach(walk)
  // This validator necessarily contains the forbidden patterns it looks for.
  // And a file that is not here cannot be scanned: `.gitignore` and `.gitattributes`
  // live in the repository but npm does not package them, so a scan of an installed
  // copy must cover what that copy actually contains instead of crashing on the rest.
  return list
    .filter((f) => f !== 'core/validate-generic.js')
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
}

/** Domain words and machine paths that must never appear in a generic plugin. */
const FORBIDDEN = [
  { name: 'polymarket', re: /polymarket/i },
  { name: 'backtest', re: /backtest/i },
  { name: 'a hard-coded WSL path', re: /\/mnt\/c\//i },
  { name: 'a hard-coded home path', re: /\/home\/[a-z0-9_-]+\//i },
  { name: 'a hard-coded Windows user path', re: /c:\\users\\/i },
  { name: 'the MDE acronym', re: /\bMDE\b/ },
  { name: 'dashboard', re: /dashboard/i },
  { name: 'market vocabulary', re: /\b(mercati|mercato|tick size|orderbook)\b/i },
  { name: 'the "era" aggregation concept', re: /\bera\b/i },
  { name: 'ROI', re: /\bROI\b/ },
  { name: 'Italian role names', re: /\b(creatore|critico|verificatore|orchestratore|dibattito|sigillo|tesi|obiezione)\b/i },
]

const tests = []
const prova = (name, fn) => tests.push({ name: name, fn: fn })

/* ── genericity ──────────────────────────────────────────────────────────── */

prova('no shipped file mentions a domain, a language or a machine path', () => {
  const offenders = []
  shippedFiles().forEach((rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    FORBIDDEN.forEach((rule) => {
      const hit = text.match(rule.re)
      if (hit) offenders.push(rel + ' contains ' + rule.name + ' (' + hit[0] + ')')
    })
  })
  assert.deepStrictEqual(offenders, [], offenders.join('\n'))
})

prova('every shipped text file is LF: a CRLF checkout must not break the protocol', () => {
  const offenders = []
  shippedFiles().forEach((rel) => {
    if (fs.readFileSync(path.join(ROOT, rel)).indexOf('\r\n') >= 0) offenders.push(rel)
  })
  assert.deepStrictEqual(offenders, [], 'these files carry CRLF line endings: ' + offenders.join(', '))
})

prova('the executable body is pure: no import, require, process, fs or path', () => {
  const body = brief.readBodySource()
  assert.strictEqual(/\brequire\s*\(/.test(body), false, 'the workflow body cannot require')
  assert.strictEqual(/^\s*import\s/m.test(body), false, 'the workflow body cannot import')
  assert.strictEqual(/\bprocess\./.test(body), false, 'the workflow body has no process global')
  assert.strictEqual(/\bfs\./.test(body), false, 'the workflow body cannot read files')
  assert.strictEqual(/\bpath\.(join|resolve)\s*\(/.test(body), false, 'the workflow body has no path module')
})

prova('the driver rewrites no path: the repository root travels inside the brief', () => {
  assert.strictEqual(driver.body.indexOf('adattaPrompt'), -1)
  assert.strictEqual(driver.BODY_TEXT.indexOf('adattaPrompt'), -1)
  assert.strictEqual(typeof driver.adattaPrompt, 'undefined')
  const source = fs.readFileSync(path.join(__dirname, 'driver.js'), 'utf8')
  assert.strictEqual(/split\(PERCORSO/.test(source), false)
  assert.strictEqual(source.indexOf('/mnt/c/'), -1)
})

prova('every role prompt is shipped and keeps the placeholders the body substitutes', () => {
  const required = {
    orchestrator: ['{{REPO_ROOT}}', '{{SCRATCH}}', '{{EVIDENCE_STYLE}}'],
    thesis: ['{{SCRATCH}}', '{{REPO_ROOT}}', '{{TEST_COMMAND}}', '{{FROZEN_PATHS}}', '{{EVIDENCE_STYLE}}'],
    antithesis: ['{{SCRATCH}}', '{{EVIDENCE_STYLE}}', '{{REPO_ROOT}}'],
    seal: ['{{SCRATCH}}', '{{TEST_COMMAND}}', '{{FROZEN_PATHS}}', '{{EVIDENCE_STYLE}}'],
  }
  brief.ROLES.forEach((role) => {
    const text = brief.readPrompt(role)
    assert.ok(text.length > 200, role + ' looks empty')
    required[role].forEach((token) => assert.ok(text.indexOf(token) >= 0, role + '.md is missing ' + token))
  })
})

prova('a filled prompt has no placeholder left and carries the profile facts', () => {
  const profile = {
    repo_root: '/tmp/any-repo', repo_name: 'any-repo', stack: 'rust',
    test_command: 'cargo test', frozen_paths: ['src', 'tests'],
    scratch: '.formalswarm/scratch', evidence_style: 'path:line',
  }
  brief.ROLES.forEach((role) => {
    const filled = brief.fill(brief.readPrompt(role), profile, '/tmp/any-repo/.formalswarm/scratch/debate_x')
    assert.strictEqual(/\{\{[A-Z_]+\}\}/.test(filled), false, role + ' still has a placeholder: ' + (filled.match(/\{\{[A-Z_]+\}\}/) || [])[0])
    assert.ok(filled.indexOf('cargo test') >= 0 || role === 'antithesis', role + ' should mention the detected test command')
  })
})

/* ── manifests and bundle wiring ─────────────────────────────────────────── */

prova('the package manifest is a valid DSH bundle with a resolvable skills export', () => {
  assert.ok(pkg.name && pkg.version && pkg.description)
  assert.strictEqual(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)), 'the bundle patch must exist')
  const skillsExport = pkg.exports['./skills']
  assert.ok(skillsExport, 'the package must export ./skills for the bundle row')
  assert.ok(fs.existsSync(path.join(ROOT, skillsExport)), 'the skills export must point at a real file')
  assert.strictEqual(pkg.type, 'commonjs')
  assert.ok(pkg.files.indexOf('prompts/**/*.md') >= 0, 'the shipped files list must include the prompts')
})

prova('cordis.patch.yml inserts exactly one row and it matches the package export', () => {
  const text = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = text.split('\n').filter((l) => /^\s*-\s*id:/.test(l))
  assert.strictEqual(rows.length, 1, 'expected one row, found: ' + rows.length)
  const names = text.split('\n').filter((l) => /^\s*name:/.test(l)).map((l) => l.split(':')[1].trim())
  assert.deepStrictEqual(names, [pkg.name + '/skills'])
  assert.ok(text.indexOf('- insert:') >= 0, 'the patch must insert, not replace')
})

prova('every documented role prompt file exists on disk', () => {
  brief.ROLES.forEach((role) => {
    assert.ok(fs.existsSync(path.join(brief.PROMPTS_DIR, role + '.md')), 'missing prompt: ' + role + '.md')
  })
})

prova('the plugin manifests agree with the package name and each other', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
  assert.strictEqual(plugin.name, pkg.name)
  assert.strictEqual(plugin.version, pkg.version)
  assert.ok(plugin.description && plugin.description.length > 40)
  assert.strictEqual(market.plugins[0].name, pkg.name)
  assert.strictEqual(market.plugins[0].source, './')
  assert.ok(market.name && market.owner && market.owner.name)
})

prova('the META block parsed from the body matches the phases the body actually runs', () => {
  const meta = brief.readMeta()
  assert.strictEqual(meta.name, 'formalswarm')
  assert.ok(meta.description.length > 40 && meta.whenToUse.length > 40)
  const titles = meta.phases.map((p) => p.title)
  assert.deepStrictEqual(titles, ['THESIS', 'ANTITHESIS', 'SYNTHESIS', 'ANTITHESIS-2', 'SYNTHESIS-2', 'SEAL'])
  // SYNTHESIS and SYNTHESIS-2 are run through runSynthesis(), so the phase name is
  // matched as a string the body really uses rather than as a literal phase() call.
  const body = brief.readBodySource()
  titles.forEach((t) => assert.ok(body.indexOf("'" + t + "'") >= 0, 'phase ' + t + ' is declared but never used by the body'))
  assert.ok(body.indexOf("phase('THESIS')") >= 0 && body.indexOf("phase('SEAL')") >= 0)
})

/* ── skills, commands, CLI surface ───────────────────────────────────────── */

prova('lib/skills.mjs registers the runtime skill and honours skills: false', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'lib', 'skills.mjs')).href)
  assert.strictEqual(module.name, 'formalswarm-skills')
  assert.deepStrictEqual(Array.from(module.inject), ['skills'])

  const registered = []
  let disposed = 0
  const ctx = {
    skills: { register: (skill) => { registered.push(skill); return () => { disposed += 1 } } },
    logger: { warn: () => {}, info: () => {} },
  }
  const disposer = module.apply(ctx, {})
  assert.strictEqual(registered.length, 1, 'the row must register exactly one skill')
  const skill = registered[0]
  assert.strictEqual(skill.name, 'formalswarm')
  assert.strictEqual(skill.source, 'runtime')
  assert.ok(skill.description.length > 40 && skill.whenToUse.length > 40)
  assert.ok(skill.content.indexOf('# FormalSwarm') >= 0, 'the skill body must be the shipped SKILL.md')
  assert.strictEqual(skill.resourceBase.kind, 'directory')
  assert.ok(fs.existsSync(path.join(skill.resourceBase.path, 'SKILL.md')))
  assert.strictEqual(typeof disposer, 'function', 'apply must hand back the registration disposer')
  disposer()
  assert.strictEqual(disposed, 1)

  const off = []
  module.apply({ skills: { register: (s) => { off.push(s) } }, logger: ctx.logger }, { skills: false })
  assert.strictEqual(off.length, 0, 'skills: false must register nothing')
})

prova('the skill and the commands carry valid frontmatter', () => {
  const frontmatter = (file) => {
    const text = fs.readFileSync(file, 'utf8')
    // \r? so a CRLF checkout cannot break the protocol's own checks
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    assert.ok(match, file + ' has no frontmatter')
    assert.ok(match[1].length <= 1024, file + ' frontmatter exceeds 1024 characters')
    return match[1]
  }
  const skillFm = frontmatter(path.join(ROOT, 'skills', 'formalswarm', 'SKILL.md'))
  assert.ok(/^name:\s*formalswarm\s*$/m.test(skillFm))
  const description = (skillFm.match(/^description:\s*(.+)$/m) || [])[1] || ''
  assert.ok(description.indexOf('Use when') === 0, 'the description must start with "Use when"')

  const commands = fs.readdirSync(path.join(ROOT, 'commands'))
  assert.ok(commands.length >= 3, 'the plugin should ship slash commands')
  commands.forEach((file) => {
    const fm = frontmatter(path.join(ROOT, 'commands', file))
    assert.ok(/^description:\s*\S/m.test(fm), file + ' needs a description')
  })
})

prova('the CLI help lists every command, and each one is reachable', () => {
  const { spawnSync } = require('node:child_process')
  const bin = path.join(__dirname, 'bin', 'formalswarm.js')
  const help = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' })
  assert.strictEqual(help.status, 0)
  ;['init', 'status', 'brief', 'body', 'meta', 'prompt', 'run', 'save', 'fall', 'validate'].forEach((cmd) => {
    assert.ok(help.stdout.indexOf('formalswarm ' + cmd) >= 0, 'help does not document ' + cmd)
  })
  const unknown = spawnSync(process.execPath, [bin, 'nope'], { encoding: 'utf8' })
  assert.strictEqual(unknown.status, 1)
  assert.ok(unknown.stderr.indexOf('unknown command') >= 0)
  const body = spawnSync(process.execPath, [bin, 'body'], { encoding: 'utf8' })
  assert.strictEqual(body.status, 0)
  assert.ok(body.stdout.indexOf('phase(') >= 0 && body.stdout.indexOf("tool: 'formalswarm'") >= 0)
  assert.strictEqual(body.stdout.indexOf('META —'), -1, 'the printed body must not carry the header comment')
})

prova('status and prompt work on an arbitrary repository, and a bad role is refused cleanly', () => {
  const { spawnSync } = require('node:child_process')
  const bin = path.join(__dirname, 'bin', 'formalswarm.js')
  const cli = (argv) => spawnSync(process.execPath, [bin].concat(argv), { encoding: 'utf8', timeout: 120000 })
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'formalswarm-cli-'))
  try {
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.mkdirSync(path.join(project, 'tests'), { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'cli-fixture', scripts: { test: 'node --test' } }), 'utf8')
    fs.writeFileSync(path.join(project, 'src', 'index.js'), 'module.exports = 1\n', 'utf8')

    const status = cli(['status', '--repo', project, '--json'])
    assert.strictEqual(status.status, 0, 'status must succeed on a valid repository\n' + status.stderr)
    const parsed = JSON.parse(status.stdout)
    assert.strictEqual(parsed.profile.stack, 'node')
    assert.strictEqual(parsed.profile.test_command, 'npm test')
    assert.strictEqual(parsed.source, 'detected', 'nothing is stored yet, so the profile comes from live detection')

    const prompt = cli(['prompt', '--role', 'seal', '--repo', project])
    assert.strictEqual(prompt.status, 0, prompt.stderr)
    assert.ok(prompt.stdout.indexOf('npm test') >= 0, 'the filled prompt must carry the detected command')
    assert.ok(prompt.stdout.indexOf(project) >= 0, 'the filled prompt must carry the repository root')
    assert.strictEqual(/\{\{[A-Z_]+\}\}/.test(prompt.stdout), false, 'no placeholder may survive')

    const bad = cli(['prompt', '--role', 'wizard'])
    assert.strictEqual(bad.status, 1)
    assert.ok(bad.stderr.indexOf('unknown role') >= 0)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

prova('brief coerces CLI strings to numbers, honours the ceiling exactly, and caps only on a typo', () => {
  const base = {
    repoRoot: path.join(ROOT, 'tests', 'fixtures', 'rust'),
    objective: 'numeric guard',
    verdictQuestion: 'is the plan honest?',
    context: ['src/main.rs', 'Cargo.toml', 'README.md'],
    sealPlan: ['cargo test'],
    // CLI flags arrive as strings: the brief must still hold numbers, or any
    // consumer that sums them concatenates and reports a nonsense worst case.
    thesis: '3', critics: '2', seals: '3', rounds: '2',
  }
  const built = brief.buildArgs(base)
  assert.strictEqual(built.args.n_thesis, 3)
  assert.strictEqual(typeof built.args.rounds, 'number')
  assert.strictEqual(built.planned, 11) // 3 + 2 + 3 + 3
  assert.strictEqual(JSON.parse(JSON.stringify(built.args)).n_critics, 2)
  assert.strictEqual(built.max_calls, brief.DEFAULT_MAX_CALLS, 'the default ceiling is reported, not hidden')

  // The ceiling is exact: at it the plan passes, one call over it is refused.
  const nine = brief.buildArgs(Object.assign({}, base, { thesis: '3', critics: '3', seals: '3', rounds: '1', maxCalls: '9' }))
  assert.strictEqual(nine.planned, 9)
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { thesis: '3', critics: '3', seals: '3', rounds: '1', maxCalls: '8' })), /budget exceeded/)
  // The default ceiling still refuses the classic oversized plan...
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { thesis: '5', critics: '5', seals: '5', rounds: '2' })), /budget exceeded/)
  // ...and the point of the ceiling is that it is trivially raised.
  assert.strictEqual(brief.buildArgs(Object.assign({}, base, { thesis: '5', critics: '5', seals: '5', rounds: '2', maxCalls: '20' })).planned, 20)
  // Group sizes are the user's call: no clamping, only a typo guard.
  assert.strictEqual(brief.buildArgs(Object.assign({}, base, { thesis: '9', critics: '1', seals: '1', rounds: '1' })).args.n_thesis, 9)
  assert.strictEqual(brief.buildArgs(Object.assign({}, base, { thesis: '100', critics: '60', seals: '40', rounds: '1', maxCalls: '200' })).planned, 200)
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { thesis: 'wizard' })), /positive integer/)
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { thesis: String(brief.MAX_GROUP + 1) })), /sanity ceiling/)
})

prova('brief advises on a badly shaped plan without refusing it', () => {
  const base = {
    repoRoot: path.join(ROOT, 'tests', 'fixtures', 'rust'),
    objective: 'advisory',
    verdictQuestion: 'is the shape sane?',
    context: ['src/main.rs', 'Cargo.toml', 'README.md'],
    sealPlan: ['cargo test', 'cargo clippy'],
  }
  // 100 writers against 2 critics: legal, but each critic would read 50 theses.
  const crowded = brief.buildArgs(Object.assign({}, base, { thesis: '100', critics: '2', seals: '2', rounds: '1', maxCalls: '200' }))
  assert.ok(crowded.advisories.join(' ').indexOf('raise --critics') >= 0)
  assert.strictEqual(crowded.advisories.join(' ').indexOf('have no assigned check'), -1, 'two checks and two verifiers leave nobody idle')

  // 10 verifiers for two checks: eight of them would never be spawned.
  const idle = brief.buildArgs(Object.assign({}, base, { thesis: '2', critics: '2', seals: '10', rounds: '1', maxCalls: '20' }))
  assert.ok(idle.advisories.join(' ').indexOf('8 of 10 verifiers have no assigned check') >= 0)

  // Too many checks on one verifier is the mirror image of the same problem.
  const overloaded = brief.buildArgs(Object.assign({}, base, { thesis: '2', critics: '2', seals: '2', rounds: '1', sealPlan: Array.from({ length: 20 }, (_, i) => 'check ' + i), maxCalls: '30' }))
  assert.ok(overloaded.advisories.join(' ').indexOf('raise --seals') >= 0)

  // A large run says so, because the runtime's concurrency cap is the real arbiter.
  const wide = brief.buildArgs(Object.assign({}, base, { thesis: '30', critics: '30', seals: '30', rounds: '1', maxCalls: '200' }))
  assert.ok(wide.advisories.join(' ').indexOf('large run') >= 0)

  // A well shaped plan produces no noise at all.
  const clean = brief.buildArgs(Object.assign({}, base, { thesis: '2', critics: '2', seals: '2', rounds: '1' }))
  assert.deepStrictEqual(clean.advisories, [])
})

prova('a brief built from any fixture carries the profile, the prompts and an absolute scratch', () => {
  // The repository root is resolved through the VCS when there is one, so this uses a
  // throw-away project outside any work tree: the point is that the plugin adapts to
  // whatever it is pointed at, not to a fixture path.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'formalswarm-generic-'))
  fs.mkdirSync(path.join(project, 'cmd'), { recursive: true })
  fs.writeFileSync(path.join(project, 'go.mod'), 'module example.com/x\n\ngo 1.22\n', 'utf8')
  fs.writeFileSync(path.join(project, 'cmd', 'main.go'), 'package main\n', 'utf8')
  try {
    const built = brief.buildArgs({
      repoRoot: project,
      objective: 'genericity check',
      verdictQuestion: 'does the brief hold?',
      context: ['cmd/main.go', 'go.mod', 'README.md'],
      sealPlan: ['go test ./...'],
      rounds: 1,
    })
    assert.strictEqual(built.args.prompts.thesis, brief.readPrompt('thesis'), 'the prompts travel verbatim')
    assert.strictEqual(built.args.prompts.antithesis, brief.readPrompt('antithesis'))
    assert.strictEqual(built.args.prompts.seal, brief.readPrompt('seal'))
    assert.strictEqual(built.args.profile.stack, 'go')
    assert.strictEqual(built.args.profile.test_command, 'go test ./...')
    assert.strictEqual(built.args.profile.repo_root, project)
    assert.ok(built.args.profile.frozen_paths.indexOf('cmd') >= 0)
    assert.ok(path.isAbsolute(built.args.scratch), 'the scratch path must be absolute')
    assert.ok(built.args.scratch.indexOf('debate_genericity-check') >= 0)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
prova('a brief refuses an objective with no verdict question, and a thin context', () => {
  const base = {
    repoRoot: path.join(ROOT, 'tests', 'fixtures', 'go'),
    objective: 'x', verdictQuestion: 'y',
    context: ['a', 'b', 'c'], sealPlan: ['z'], rounds: 1,
  }
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { verdictQuestion: '' })), /verdict_question is required/)
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { context: ['a', 'b'] })), /3 to 6/)
  assert.throws(() => brief.buildArgs(Object.assign({}, base, { sealPlan: [] })), /at least one runnable check/)
})

async function runAll() {
  let failed = 0
  for (const t of tests) {
    try { await t.fn() } catch (e) { failed++; console.error('FAILED  ' + t.name + ' :: ' + (e && e.message)) }
  }
  return { suite: 'generic', total: tests.length, failed: failed }
}

module.exports = { runAll: runAll, tests: tests, shippedFiles: shippedFiles }

if (require.main === module) {
  runAll().then((r) => {
    console.log((r.failed === 0 ? 'generic suite: all green (' : 'generic suite: ' + r.failed + ' failed of ') + r.total + ')')
    process.exit(r.failed === 0 ? 0 : 1)
  }).catch((e) => { console.error(e); process.exit(1) })
}
