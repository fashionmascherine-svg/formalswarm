'use strict'
/*
 * validate-profile.js — validate OFFLINE the repository profiler (core/profile.js),
 * which is what makes FormalSwarm repo-agnostic: the same plugin must infer a
 * Python, Node, Rust, Go, Maven, Gradle, Ruby, PHP, Make or unknown repository
 * without a single hard-coded path. No agent call, no cost.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const profiles = require('./profile.js')

/** The interpreter the profiler emits on the platform this suite is running on. */
const PY = process.platform === 'win32' ? 'python' : 'python3'

const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures')
const fixture = (name) => path.join(FIXTURES, name)

let counter = 0
// Per-process unique root: the suite must not share directories with any other run,
// or a leftover file can answer an assertion and rm->mkdir can hit ENOTEMPTY on Windows.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'formalswarm-profile-tests-'))
const rmTree = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
const freshDir = (name) => {
  const dir = path.join(tmpRoot, name + '-' + (++counter))
  rmTree(dir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const tests = []
const prova = (name, fn) => tests.push({ name: name, fn: fn })

/* ── stack detection ─────────────────────────────────────────────────────── */

prova('python + pytest + ruff', () => {
  const p = profiles.detectProfile(fixture('python-pytest'))
  assert.strictEqual(p.stack, 'python')
  assert.strictEqual(p.test_command, PY + ' -m pytest -q')
  assert.strictEqual(p.lint_command, 'ruff check .')
  assert.strictEqual(p.test_runner, 'pytest')
  assert.deepStrictEqual(p.frozen_paths, ['src', 'tests'])
  assert.strictEqual(p.evidence_style, 'path:line')
  assert.strictEqual(p.vcs, 'none')
})

prova('python without pytest falls back to unittest on the existing test directory', () => {
  const p = profiles.detectProfile(fixture('python-unittest'))
  assert.strictEqual(p.stack, 'python')
  assert.strictEqual(p.test_command, PY + ' -m unittest discover -s tests -v')
  assert.strictEqual(p.test_runner, 'unittest')
  assert.deepStrictEqual(p.frozen_paths, ['lib', 'tests'])
})

prova('node with a pnpm lockfile and full scripts', () => {
  const p = profiles.detectProfile(fixture('node-pnpm'))
  assert.strictEqual(p.stack, 'node')
  assert.strictEqual(p.package_manager, 'pnpm')
  assert.strictEqual(p.test_command, 'pnpm test')
  assert.strictEqual(p.lint_command, 'pnpm run lint')
  assert.strictEqual(p.build_command, 'pnpm run build')
})

prova('node with only a test-runner dependency still gets a real command', () => {
  const p = profiles.detectProfile(fixture('node-vitest'))
  assert.strictEqual(p.test_command, 'npx vitest run')
  assert.strictEqual(p.test_runner, 'vitest')
  assert.strictEqual(p.package_manager, 'npm') // no lockfile: npm is the honest default
})

prova('rust, go, php, ruby and make each get their own command', () => {
  assert.strictEqual(profiles.detectProfile(fixture('rust')).test_command, 'cargo test')
  assert.strictEqual(profiles.detectProfile(fixture('go')).test_command, 'go test ./...')
  assert.strictEqual(profiles.detectProfile(fixture('php')).test_command, 'composer test')
  assert.strictEqual(profiles.detectProfile(fixture('ruby')).test_command, 'bundle exec rspec')
  const make = profiles.detectProfile(fixture('make-only'))
  assert.strictEqual(make.stack, 'make')
  assert.strictEqual(make.test_command, 'make test')
})

prova('an unrecognisable repository is "unknown" with a null command, never a guess', () => {
  const p = profiles.detectProfile(fixture('unknown'))
  assert.strictEqual(p.stack, 'unknown')
  assert.strictEqual(p.test_command, null)
  assert.strictEqual(p.lint_command, null)
  assert.ok(p.notes.join(' ').indexOf('no stack marker found') >= 0)
  assert.ok(p.notes.join(' ').indexOf('no test command detected') >= 0)
  assert.ok(p.notes.join(' ').indexOf('no conventional source directory') >= 0)
})

prova('a tree with source files but no manifest is still detected, and says so', () => {
  const dir = freshDir('weak')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'tool.py'), 'x = 1\n', 'utf8')
  const p = profiles.detectProfile(dir)
  assert.strictEqual(p.stack, 'python')
  assert.ok(p.notes.join(' ').indexOf('inferred from source files') >= 0, 'a weak match must never be silent')
})

prova('a Makefile with a test target names the command, beating content sniffing', () => {
  const dir = freshDir('makewins')
  fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\t@echo ok\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'tool.py'), 'x = 1\n', 'utf8')
  const p = profiles.detectProfile(dir)
  assert.strictEqual(p.stack, 'make')
  assert.strictEqual(p.test_command, 'make test')
})

prova('a monorepo records every stack and still picks one honest primary', () => {
  const p = profiles.detectProfile(fixture('monorepo'))
  assert.deepStrictEqual(p.stacks, ['python', 'node'])
  assert.strictEqual(p.stack, 'python')
  assert.strictEqual(p.stack_commands.node.test_command, 'pnpm test')
  assert.strictEqual(p.stack_commands.python.test_command, PY + ' -m unittest discover -s tests -v')
  assert.ok(p.frozen_paths.indexOf('packages') >= 0, 'a monorepo package directory is a source directory')
  assert.ok(p.notes.join(' ').indexOf('multiple stacks detected') >= 0)
})

prova('the stack_commands map exists for every stack the profile reports', () => {
  const p = profiles.detectProfile(fixture('monorepo'))
  p.stacks.forEach((s) => assert.ok(p.stack_commands[s], 'missing commands for ' + s))
})

/* ── root detection ──────────────────────────────────────────────────────── */

prova('detectRoot walks up to the nearest marker when there is no VCS', () => {
  const base = freshDir('rootwalk') // under os.tmpdir: outside any git work tree
  const project = path.join(base, 'a', 'b', 'project')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(project, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8')
  assert.strictEqual(profiles.detectRoot(path.join(project, 'src')), project)
  assert.strictEqual(profiles.detectRoot(project), project)
})

prova('detectRoot returns the starting directory when nothing marks a project', () => {
  const base = freshDir('rootplain')
  const dir = path.join(base, 'plain', 'dir')
  fs.mkdirSync(dir, { recursive: true })
  assert.strictEqual(profiles.detectRoot(dir), dir)
})

prova('detectRoot is not confused by a .git entry (marker path)', () => {
  const dir = freshDir('gitmarker')
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'deep', 'inside'), { recursive: true })
  assert.strictEqual(profiles.detectRoot(path.join(dir, 'deep', 'inside')), dir)
})

/* ── determinism, storage, overrides ─────────────────────────────────────── */

prova('the emitted commands follow the platform the checks will actually run on', () => {
  const mine = profiles.detectProfile(fixture('python-pytest'))
  const posix = profiles.detectProfile(fixture('python-pytest'), { platform: 'linux' })
  const windows = profiles.detectProfile(fixture('python-pytest'), { platform: 'win32' })
  assert.strictEqual(posix.test_command, 'python3 -m pytest -q')
  assert.strictEqual(windows.test_command, 'python -m pytest -q', 'Windows has no python3 by default')
  assert.strictEqual(mine.test_command, (process.platform === 'win32' ? windows : posix).test_command,
    'with no explicit platform the profiler must follow the one it is running on')

  const dir = freshDir('gradle')
  fs.writeFileSync(path.join(dir, 'build.gradle'), 'plugins { id "java" }\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'gradlew'), '#!/bin/sh\n', 'utf8')
  assert.strictEqual(profiles.commandsForStack(dir, 'gradle', { platform: 'linux' }).test_command, './gradlew test')
  assert.strictEqual(profiles.commandsForStack(dir, 'gradle', { platform: 'win32' }).test_command, 'gradlew.bat test')
  assert.strictEqual(profiles.commandsForStack(dir, 'gradle').test_command,
    process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test',
    'with no explicit platform the wrapper must follow the one it is running on')
})

prova('detection is deterministic: the same tree yields a byte-identical profile', () => {
  const a = profiles.detectProfile(fixture('python-pytest'))
  const b = profiles.detectProfile(fixture('python-pytest'))
  assert.deepStrictEqual(a, b)
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b))
})

prova('saveProfile / loadProfile round-trip, and the stored profile wins over detection', () => {
  const dir = freshDir('store')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest' } }), 'utf8')
  assert.strictEqual(profiles.loadProfile(dir), null)
  const detected = profiles.detectProfile(dir)
  const file = profiles.saveProfile(dir, detected)
  assert.strictEqual(file, profiles.profilePath(dir))
  assert.deepStrictEqual(profiles.loadProfile(dir), detected)

  const edited = Object.assign({}, detected, { test_command: 'node --test' })
  profiles.saveProfile(dir, edited)
  const resolved = profiles.resolveProfile(dir, {})
  assert.strictEqual(resolved.source, 'file')
  assert.strictEqual(resolved.profile.test_command, 'node --test')
})

prova('per-launch overrides win, null clears, and an unknown key is rejected', () => {
  const dir = freshDir('override')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest' } }), 'utf8')
  const resolved = profiles.resolveProfile(dir, { test_command: 'node --test', frozen_paths: ['lib'], lint_command: null })
  assert.strictEqual(resolved.profile.test_command, 'node --test')
  assert.deepStrictEqual(resolved.profile.frozen_paths, ['lib'])
  assert.strictEqual(resolved.profile.lint_command, null)
  assert.throws(() => profiles.resolveProfile(dir, { test_comand: 'typo' }), /unknown profile override/)
})

prova('initProfile writes the profile and only touches .gitignore when asked', () => {
  const dir = freshDir('init')
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n\ngo 1.22\n', 'utf8')
  const first = profiles.initProfile(dir, {})
  assert.ok(fs.existsSync(first.path))
  assert.strictEqual(first.gitignore, null)
  assert.strictEqual(fs.existsSync(path.join(dir, '.gitignore')), false)

  const second = profiles.initProfile(dir, { gitignore: true })
  assert.strictEqual(second.gitignore, path.join(dir, '.gitignore'))
  const body = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
  assert.strictEqual(body, '.formalswarm/\n')
  // Idempotent: running it again must not append a second line.
  profiles.initProfile(dir, { gitignore: true })
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.formalswarm/\n')
})

prova('scratchAbs resolves the scratch directory against the repository root', () => {
  const p = profiles.detectProfile(fixture('rust'))
  assert.strictEqual(profiles.scratchAbs(p), path.join(p.repo_root, '.formalswarm', 'scratch'))
  const absolute = Object.assign({}, p, { scratch: '/var/tmp/elsewhere' })
  assert.strictEqual(profiles.scratchAbs(absolute), '/var/tmp/elsewhere')
})

prova('list overrides accept the comma form, so no shell has to quote a JSON array', () => {
  const dir = freshDir('listform')
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n\ngo 1.22\n', 'utf8')
  const comma = profiles.resolveProfile(dir, { frozen_paths: 'core, lib ,prompts', source_dirs: 'core,lib' })
  assert.deepStrictEqual(comma.profile.frozen_paths, ['core', 'lib', 'prompts'])
  assert.deepStrictEqual(comma.profile.source_dirs, ['core', 'lib'])
  const json = profiles.resolveProfile(dir, { frozen_paths: ['a', 'b'] })
  assert.deepStrictEqual(json.profile.frozen_paths, ['a', 'b'])
  // An explicit null clears the field, and an empty frozen list stays an empty list
  // (never the string 'null', never a leftover from detection).
  const cleared = profiles.resolveProfile(dir, { frozen_paths: null })
  assert.deepStrictEqual(cleared.profile.frozen_paths, [])
})

prova('validateProfile reports the structural problems that make a profile unusable', () => {
  assert.deepStrictEqual(profiles.validateProfile(profiles.detectProfile(fixture('rust'))), [])
  const broken = profiles.validateProfile({ repo_root: 'relative', stack: '', frozen_paths: 'src', scratch: '', evidence_style: '' })
  assert.strictEqual(broken.length, 5)
  assert.ok(broken.join(' ').indexOf('repo_root must be an absolute path') >= 0)
  assert.deepStrictEqual(profiles.validateProfile(null), ['profile is not an object'])
})

prova('frozen paths only ever name directories that exist', () => {
  const p = profiles.detectProfile(fixture('python-pytest'))
  p.frozen_paths.forEach((d) => assert.ok(fs.statSync(path.join(p.repo_root, d)).isDirectory(), d + ' is not a directory'))
  assert.ok(p.source_dirs.indexOf('app') < 0, 'a directory that does not exist must not be listed')
})

prova('nested: the content probe finds the stack below the root and never invents a command', () => {
  const p = profiles.detectProfile(fixture('nested'))
  assert.strictEqual(p.stack, 'python')
  assert.strictEqual(p.test_command, null, 'no manifest names a runner: the profile must say so, not guess')
  assert.ok(p.notes.join(' ').indexOf('no test command detected') >= 0, p.notes.join(' '))
})

async function runAll() {
  let failed = 0
  for (const t of tests) {
    try { await t.fn() } catch (e) { failed++; console.error('FAILED  ' + t.name + ' :: ' + (e && e.message)) }
  }
  rmTree(tmpRoot)
  return { suite: 'profile', total: tests.length, failed: failed }
}

module.exports = { runAll: runAll, tests: tests }

if (require.main === module) {
  runAll().then((r) => {
    console.log((r.failed === 0 ? 'profile suite: all green (' : 'profile suite: ' + r.failed + ' failed of ') + r.total + ')')
    process.exit(r.failed === 0 ? 0 : 1)
  }).catch((e) => { console.error(e); process.exit(1) })
}
