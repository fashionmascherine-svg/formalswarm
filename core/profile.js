'use strict'
/*
 * profile.js — the repo-agnostic layer of FormalSwarm.
 *
 * FormalSwarm knows nothing about any particular repository, language or
 * domain. Everything a debate needs to know about the target repository comes
 * from one small document, `.formalswarm/profile.json`, which this module
 * detects, reads, merges and writes:
 *
 *   - which stack the repository is (python, node, rust, go, maven, gradle,
 *     ruby, php, make, unknown) and which ones coexist in a monorepo;
 *   - the canonical test / lint / build commands the seal can trust;
 *   - which directories are production (frozen for the whole debate) and which
 *     are tests;
 *   - where scratch artefacts go, and the evidence style every claim must use.
 *
 * Detection is PURE and DETERMINISTIC: same tree in, byte-identical profile
 * out. Nothing here writes unless you call `saveProfile()` or
 * `initProfile()`, and those only ever touch `<root>/.formalswarm/`.
 *
 * Every field can be overridden per launch (`resolveProfile(root, overrides)`),
 * which is how a repository detection got wrong — or a repository with no
 * detectable test runner at all — still works: the orchestrator passes the
 * real commands explicitly and the seal uses them.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PROFILE_DIR = '.formalswarm'
const PROFILE_NAME = 'profile.json'
const SCRATCH_DIR = '.formalswarm/scratch'
const EVIDENCE_STYLE = 'path:line'
const SCHEMA_VERSION = 1

/** Candidate production directories, in preference order. */
const SOURCE_DIRS = ['src', 'lib', 'app', 'apps', 'packages', 'cmd', 'pkg', 'internal', 'source', 'core']
/** Candidate test directories, in preference order. */
const TEST_DIRS = ['tests', 'test', 'spec', '__tests__', 'e2e', 'it']
/** Ordered stack markers: the first detected stack becomes the primary one. */
const STACK_MARKERS = [
  ['python', ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'tox.ini', 'Pipfile']],
  ['node', ['package.json']],
  ['rust', ['Cargo.toml']],
  ['go', ['go.mod']],
  ['maven', ['pom.xml']],
  ['gradle', ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  ['ruby', ['Gemfile']],
  ['php', ['composer.json']],
]
/** Lockfiles decide the Node package manager, first match wins. */
const LOCKFILES = [
  ['pnpm', 'pnpm-lock.yaml'],
  ['yarn', 'yarn.lock'],
  ['bun', 'bun.lockb'],
  ['npm', 'package-lock.json'],
]
/**
 * Weak markers, used only when no manifest exists: a repository made of source
 * files and nothing else still has a stack, and calling it "unknown" would force
 * the caller to describe by hand what the tree already says. A weak match is
 * recorded in `notes` so the guess is never silent.
 */
const WEAK_MARKERS = [
  ['python', ['.py']],
  ['node', ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']],
  ['rust', ['.rs']],
  ['go', ['.go']],
  ['ruby', ['.rb']],
  ['php', ['.php']],
]
/** Directories never worth scanning for source files. */
const SCAN_SKIP = ['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', 'venv', 'env', '__pycache__', '.formalswarm', '.tox', 'coverage']
/**
 * How far the content sniffing looks and how many entries it may examine. The
 * probe is a last resort on a repository with no manifest, and it must stay
 * cheap on a large tree or a slow mount: a bounded scan that gives up is worth
 * more than an exact one that stalls the CLI.
 */
const SCAN_MAX_DEPTH = 2
const SCAN_BUDGET = 4000

/* ── tiny fs helpers (never throw: a missing file is a fact, not an error) ── */

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch (e) { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch (e) { return false } }
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (e) { return '' } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }
const listDir = (p) => { try { return fs.readdirSync(p) } catch (e) { return [] } }
const firstExisting = (root, names) => names.filter((n) => isFile(path.join(root, n)))[0] || null
const isText = (v) => typeof v === 'string' && v.trim().length > 0

/* ── repository root ─────────────────────────────────────────────────────── */

/** Marker files that identify a repository root when there is no VCS to ask. */
const hasAnyMarker = (dir) =>
  STACK_MARKERS.some(([, files]) => files.some((f) => isFile(path.join(dir, f)))) ||
  isFile(path.join(dir, 'Makefile')) ||
  isDir(path.join(dir, '.git'))

/**
 * The repository root for `startDir`: the VCS root when there is one, else the
 * nearest ancestor carrying a project marker, else `startDir` itself. A nested
 * checkout therefore resolves to the checkout, never to the enclosing monorepo.
 */
function detectRoot(startDir) {
  const start = path.resolve(startDir || process.cwd())
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (out) return path.resolve(out)
  } catch (e) { /* not a git work tree: fall through to markers */ }
  let dir = start
  for (;;) {
    if (hasAnyMarker(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/* ── stack detection ─────────────────────────────────────────────────────── */

/** Every stack whose marker exists in `root`, in STACK_MARKERS order. */
function detectStacks(root) {
  const stacks = []
  STACK_MARKERS.forEach(([stack, files]) => {
    const marker = files.filter((f) => isFile(path.join(root, f)))[0]
    if (marker) stacks.push({ stack: stack, marker: marker })
  })
  // A Makefile with a test target beats content sniffing: it names the command.
  if (stacks.length === 0 && hasMakeTarget(root, 'test')) stacks.push({ stack: 'make', marker: 'Makefile' })
  // Last resort, and only for a tree with no manifest at all.
  if (stacks.length === 0) {
    const weak = WEAK_MARKERS.filter(([, extensions]) => hasSourceWithExtension(root, extensions))[0]
    if (weak) stacks.push({ stack: weak[0], marker: 'source files (' + weak[1].join('/') + ')' })
  }
  return stacks
}

/**
 * True when the tree holds at least one file with one of `extensions`. Uses
 * `readdirSync(withFileTypes)` so a directory entry costs no extra stat, and
 * stops after SCAN_BUDGET entries: this runs on whatever directory the user
 * points at, including very large ones.
 */
function hasSourceWithExtension(root, extensions, depth) {
  const maxDepth = depth === undefined ? SCAN_MAX_DEPTH : depth
  let budget = SCAN_BUDGET
  const walk = (dir, level) => {
    if (level > maxDepth || budget <= 0) return false
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return false }
    for (let i = 0; i < entries.length; i++) {
      budget -= 1
      if (budget <= 0) return false
      const entry = entries[i]
      if (SCAN_SKIP.indexOf(entry.name) >= 0) continue
      if (entry.isDirectory()) {
        if (walk(path.join(dir, entry.name), level + 1)) return true
      } else if (entry.isFile() && extensions.indexOf(path.extname(entry.name).toLowerCase()) >= 0) {
        return true
      }
    }
    return false
  }
  return walk(root, 0)
}

/** True when `root/Makefile` declares `target:` (used for the `make` fallback). */
function hasMakeTarget(root, target) {
  const body = readText(path.join(root, 'Makefile'))
  if (!body) return false
  return new RegExp('^' + target + '\\s*:', 'm').test(body)
}

/** The Node package manager implied by the lockfile, `npm` when none is present. */
function detectPackageManager(root) {
  const hit = LOCKFILES.filter(([, file]) => isFile(path.join(root, file)))[0]
  return hit ? hit[0] : 'npm'
}

/** How to invoke a package.json script with the detected package manager. */
function nodeScriptCommand(pm, script) {
  if (script === 'test') {
    if (pm === 'npm') return 'npm test'
    if (pm === 'bun') return 'bun run test'
    return pm + ' test'
  }
  if (pm === 'npm') return 'npm run ' + script
  if (pm === 'bun') return 'bun run ' + script
  return pm + ' run ' + script
}

/**
 * The canonical commands for one stack. Every field is either a real command
 * string or null — never a guess dressed up as a command: a null means "the
 * seal must be given explicit checks", which is a fact the debate can use.
 *
 * `options.platform` exists so the caller (and the tests) can ask what the command
 * would look like on another OS: the plugin claims to work on any repository, and a
 * command that cannot run on the machine doing the measuring is not repo-agnostic.
 */
function commandsForStack(root, stack, options) {
  const isWindows = ((options && options.platform) || process.platform) === 'win32'
  const python = isWindows ? 'python' : 'python3'
  const out = { test_command: null, lint_command: null, build_command: null, runner: null }
  const pyproject = readText(path.join(root, 'pyproject.toml'))
  const pkg = readJson(path.join(root, 'package.json'))

  if (stack === 'python') {
    const pytest = isFile(path.join(root, 'pytest.ini')) ||
      /\btool\.pytest\b/.test(pyproject) ||
      /\bpytest\b/.test(pyproject) ||
      /\bpytest\b/.test(readText(path.join(root, 'tox.ini'))) ||
      /\bpytest\b/.test(readText(path.join(root, 'requirements-dev.txt'))) ||
      /\bpytest\b/.test(readText(path.join(root, 'requirements.txt')))
    const testDir = ['tests', 'test'].filter((d) => isDir(path.join(root, d)))[0]
    if (pytest) { out.test_command = python + ' -m pytest -q'; out.runner = 'pytest' }
    else if (testDir) { out.test_command = python + ' -m unittest discover -s ' + testDir + ' -v'; out.runner = 'unittest' }
    if (isFile(path.join(root, '.ruff.toml')) || isFile(path.join(root, 'ruff.toml')) || /\btool\.ruff\b/.test(pyproject)) {
      out.lint_command = 'ruff check .'
    } else if (isFile(path.join(root, '.flake8')) || /\[flake8\]/.test(readText(path.join(root, 'setup.cfg')))) {
      out.lint_command = 'flake8'
    }
    return out
  }

  if (stack === 'node') {
    const pm = detectPackageManager(root)
    const scripts = (pkg && pkg.scripts) || {}
    const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {})
    if (isText(scripts.test) && !/no test specified/i.test(scripts.test)) {
      out.test_command = nodeScriptCommand(pm, 'test'); out.runner = 'package.json:test'
    } else if (deps.vitest) { out.test_command = 'npx vitest run'; out.runner = 'vitest' }
    else if (deps.jest) { out.test_command = 'npx jest'; out.runner = 'jest' }
    else if (deps.mocha) { out.test_command = 'npx mocha'; out.runner = 'mocha' }
    if (isText(scripts.lint)) out.lint_command = nodeScriptCommand(pm, 'lint')
    if (isText(scripts.build)) out.build_command = nodeScriptCommand(pm, 'build')
    return out
  }

  if (stack === 'rust') {
    out.test_command = 'cargo test'; out.build_command = 'cargo build'; out.runner = 'cargo'
    return out
  }

  if (stack === 'go') {
    out.test_command = 'go test ./...'; out.build_command = 'go build ./...'; out.runner = 'go'
    return out
  }

  if (stack === 'maven') {
    out.test_command = 'mvn -q test'; out.build_command = 'mvn -q -DskipTests package'; out.runner = 'maven'
    return out
  }

  if (stack === 'gradle') {
    const wrapper = isFile(path.join(root, 'gradlew')) || isFile(path.join(root, 'gradlew.bat'))
    const gradle = wrapper ? (isWindows ? 'gradlew.bat' : './gradlew') : 'gradle'
    out.test_command = gradle + ' test'; out.build_command = gradle + ' build'; out.runner = 'gradle'
    return out
  }

  if (stack === 'ruby') {
    if (isDir(path.join(root, 'spec'))) out.test_command = 'bundle exec rspec'
    else if (isDir(path.join(root, 'test')) || isDir(path.join(root, 'tests'))) out.test_command = 'bundle exec rake test'
    out.runner = 'ruby'
    return out
  }

  if (stack === 'php') {
    const composer = readJson(path.join(root, 'composer.json'))
    const composerTest = composer && composer.scripts && composer.scripts.test
    if (isText(composerTest)) out.test_command = 'composer test'
    else if (isFile(path.join(root, 'vendor/bin/phpunit'))) out.test_command = 'vendor/bin/phpunit'
    out.runner = 'php'
    return out
  }

  if (stack === 'make') {
    if (hasMakeTarget(root, 'test')) out.test_command = 'make test'
    out.build_command = 'make'
    out.runner = 'make'
    return out
  }

  return out
}

/* ── directory detection ─────────────────────────────────────────────────── */

/** Existing directories from `candidates`, in candidate order. */
const existingDirs = (root, candidates) => candidates.filter((d) => isDir(path.join(root, d)))

/* ── the profile document ────────────────────────────────────────────────── */

/**
 * Detect the profile of the repository rooted at `rootDir`. Pure: reads the
 * tree, writes nothing, and returns a stable object for a stable tree.
 */
function detectProfile(rootDir, options) {
  const root = path.resolve(rootDir)
  const stacks = detectStacks(root)
  const notes = []
  const primary = stacks[0] ? stacks[0].stack : 'unknown'

  const commands = {}
  stacks.forEach((s) => { commands[s.stack] = commandsForStack(root, s.stack, options) })
  const primaryCommands = commands[primary] || { test_command: null, lint_command: null, build_command: null, runner: null }
  // A monorepo can have a primary stack with no runner while a secondary one
  // has a real command: use the first stack that actually answers.
  const fallback = stacks.map((s) => s.stack).filter((s) => commands[s] && commands[s].test_command)[0]
  const test_stack = primaryCommands.test_command ? primary : (fallback || primary)

  const sourceDirs = existingDirs(root, SOURCE_DIRS)
  const testDirs = existingDirs(root, TEST_DIRS)
  const frozen = sourceDirs.concat(testDirs.filter((d) => sourceDirs.indexOf(d) < 0))

  if (stacks.length === 0) notes.push('no stack marker found: pass explicit seal checks and frozen paths')
  if (stacks.length > 0 && stacks[0].marker.indexOf('source files') === 0) {
    notes.push('stack inferred from source files (no manifest marker): verify the detected test command')
  }
  if (stacks.length > 1) notes.push('multiple stacks detected (' + stacks.map((s) => s.stack).join(', ') + '): the primary is ' + primary)
  if (!primaryCommands.test_command && !fallback) notes.push('no test command detected: every seal check must be passed explicitly')
  if (sourceDirs.length === 0) notes.push('no conventional source directory found: frozen_paths is empty')

  return {
    schema_version: SCHEMA_VERSION,
    generated_by: 'formalswarm',
    repo_root: root,
    repo_name: path.basename(root),
    vcs: isDir(path.join(root, '.git')) || isFile(path.join(root, '.git')) ? 'git' : 'none',
    stack: primary,
    stacks: stacks.map((s) => s.stack),
    test_stack: test_stack,
    test_command: (commands[test_stack] || primaryCommands).test_command,
    lint_command: (commands[test_stack] || primaryCommands).lint_command,
    build_command: (commands[test_stack] || primaryCommands).build_command,
    test_runner: (commands[test_stack] || primaryCommands).runner,
    package_manager: isFile(path.join(root, 'package.json')) ? detectPackageManager(root) : null,
    stack_commands: commands,
    source_dirs: sourceDirs,
    test_dirs: testDirs,
    frozen_paths: frozen,
    scratch: SCRATCH_DIR,
    evidence_style: EVIDENCE_STYLE,
    notes: notes,
  }
}

/** Absolute path of the profile file for `root`. */
const profilePath = (root) => path.join(path.resolve(root), PROFILE_DIR, PROFILE_NAME)

/** Read the stored profile, or null when the repository has none. */
function loadProfile(root) {
  const file = profilePath(root)
  if (!isFile(file)) return null
  const data = readJson(file)
  if (!data || typeof data !== 'object') return null
  return data
}

/** Persist `profile` into `<root>/.formalswarm/profile.json`. */
function saveProfile(root, profile) {
  const dir = path.join(path.resolve(root), PROFILE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, PROFILE_NAME)
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  return file
}

/**
 * Fields a caller may override per launch. Anything else in `overrides` is
 * rejected rather than silently ignored: a typo must not look like a setting.
 */
const OVERRIDABLE = [
  'stack', 'test_command', 'lint_command', 'build_command', 'test_runner',
  'package_manager', 'source_dirs', 'test_dirs', 'frozen_paths', 'scratch',
  'evidence_style', 'notes', 'repo_name',
]

/**
 * Fields that hold a list. An override may be a JSON array (`["a","b"]`) or a plain
 * comma-separated string (`a,b`): on Windows, passing a JSON array through cmd and
 * PowerShell needs different, fragile quoting, and a plugin that claims to work
 * anywhere should not require the caller to win that fight.
 */
const ARRAY_FIELDS = ['source_dirs', 'test_dirs', 'frozen_paths', 'notes']
const asList = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return value
}

/**
 * The profile a debate must use: the stored one when present, else detection,
 * with per-launch overrides applied on top. `null` in an override clears the
 * field on purpose; `undefined` leaves it alone.
 */
function resolveProfile(rootDir, overrides) {
  const root = path.resolve(rootDir)
  const stored = loadProfile(root)
  const base = stored || detectProfile(root)
  const source = stored ? 'file' : 'detected'
  const unknown = Object.keys(overrides || {}).filter((k) => OVERRIDABLE.indexOf(k) < 0)
  if (unknown.length > 0) {
    throw new Error('unknown profile override(s): ' + unknown.join(', ') + ' (allowed: ' + OVERRIDABLE.join(', ') + ')')
  }
  const profile = Object.assign({}, base, overrides || {})
  ARRAY_FIELDS.forEach((field) => {
    if (profile[field] !== undefined && profile[field] !== null) profile[field] = asList(profile[field])
  })
  profile.schema_version = SCHEMA_VERSION
  profile.generated_by = 'formalswarm'
  profile.repo_root = root
  profile.repo_name = isText(profile.repo_name) ? profile.repo_name : path.basename(root)
  profile.evidence_style = isText(profile.evidence_style) ? profile.evidence_style : EVIDENCE_STYLE
  profile.scratch = isText(profile.scratch) ? profile.scratch : SCRATCH_DIR
  profile.frozen_paths = Array.isArray(profile.frozen_paths) ? profile.frozen_paths : []
  return { profile: profile, source: source, path: profilePath(root) }
}

/** Absolute scratch directory for a profile. */
function scratchAbs(profile) {
  const scratch = isText(profile.scratch) ? profile.scratch : SCRATCH_DIR
  return path.isAbsolute(scratch) ? scratch : path.join(profile.repo_root, scratch)
}

/**
 * Structural problems that make a profile unusable for a debate. An empty list
 * means the profile is complete enough to launch with.
 */
function validateProfile(profile) {
  const problems = []
  if (!profile || typeof profile !== 'object') return ['profile is not an object']
  if (!isText(profile.repo_root) || !path.isAbsolute(profile.repo_root)) problems.push('repo_root must be an absolute path')
  if (!isText(profile.stack)) problems.push('stack is missing')
  if (!Array.isArray(profile.frozen_paths)) problems.push('frozen_paths must be an array')
  if (!isText(profile.scratch)) problems.push('scratch is missing')
  if (!isText(profile.evidence_style)) problems.push('evidence_style is missing')
  return problems
}

/**
 * Write a fresh profile for `root` (detection, never a stored one). With
 * `options.gitignore` the `.formalswarm/` directory is also added to the
 * repository's `.gitignore` — opt-in, because writing to a file the plugin does
 * not own is never a default.
 */
function initProfile(rootDir, options) {
  const o = options || {}
  const root = path.resolve(rootDir)
  const profile = detectProfile(root)
  const file = saveProfile(root, profile)
  let gitignore = null
  if (o.gitignore) {
    const gi = path.join(root, '.gitignore')
    const body = readText(gi)
    if (!body) { fs.writeFileSync(gi, PROFILE_DIR + '/\n', 'utf8'); gitignore = gi }
    else if (body.split('\n').indexOf(PROFILE_DIR + '/') < 0) {
      fs.writeFileSync(gi, body.replace(/\n?$/, '\n') + PROFILE_DIR + '/\n', 'utf8')
      gitignore = gi
    }
  }
  return { profile: profile, path: file, gitignore: gitignore }
}

module.exports = {
  PROFILE_DIR: PROFILE_DIR,
  PROFILE_NAME: PROFILE_NAME,
  SCRATCH_DIR: SCRATCH_DIR,
  EVIDENCE_STYLE: EVIDENCE_STYLE,
  SCHEMA_VERSION: SCHEMA_VERSION,
  OVERRIDABLE: OVERRIDABLE,
  ARRAY_FIELDS: ARRAY_FIELDS,
  STACK_MARKERS: STACK_MARKERS,
  WEAK_MARKERS: WEAK_MARKERS,
  SOURCE_DIRS: SOURCE_DIRS,
  TEST_DIRS: TEST_DIRS,
  detectRoot: detectRoot,
  detectStacks: detectStacks,
  hasSourceWithExtension: hasSourceWithExtension,
  detectPackageManager: detectPackageManager,
  commandsForStack: commandsForStack,
  detectProfile: detectProfile,
  profilePath: profilePath,
  loadProfile: loadProfile,
  saveProfile: saveProfile,
  resolveProfile: resolveProfile,
  scratchAbs: scratchAbs,
  validateProfile: validateProfile,
  initProfile: initProfile,
  listDir: listDir,
}
