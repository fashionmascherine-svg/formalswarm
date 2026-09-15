# Changelog

All notable changes to FormalSwarm are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

First release: a repo-agnostic multi-agent validation plugin that runs on DeepSeek
Harness, Claude Code and ZCode from a single body.

### Added

- **One deterministic body** (`core/debate.workflow.js`): thesis, antithesis,
  synthesis, second-round antithesis/synthesis and seal, with the worst-case cost
  computed and refused before the first call (declared budget, 15 by default).
- **Deterministic rollup**: every check bound to `exit_code` and `cases`; coverage of
  the assigned checks counted; dead phases, mute seals and empty greens fail closed to
  `INCONCLUSIVE`; unsupported verdicts corrected downwards and recorded.
- **Objection ledger** with deterministic states (`to_answer`, `accepted`, `rejected`,
  `unanswered`, `orphan`), exact-evidence matching and one-response-per-duplicate
  consumption.
- **Repository profiler** (`core/profile.js`): pure, deterministic detection of stack,
  test/lint/build commands, source and test directories, frozen paths, scratch and
  evidence style across Python, Node, Rust, Go, Maven, Gradle, Ruby, PHP, Make and
  unknown repositories, including monorepos, with per-launch overrides.
- **Round driver** (`core/driver.js`) that executes the same body on runtimes without a
  workflow tool, validating every stored answer against the schemas extracted from the
  body itself, with folder-to-brief binding and `<label>@<PHASE>` result keys.
- **Shared CLI** (`formalswarm`): `init`, `status`, `brief`, `body`, `meta`, `prompt`,
  `run`, `save`, `fall`, `validate`.
- **DeepSeek Harness bundle**: `cordis.patch.yml` inserting the `formalswarm-skills`
  row plus `lib/skills.mjs`, registering the protocol as a runtime skill.
- **Claude Code and ZCode plugin**: `.claude-plugin/plugin.json` and
  `marketplace.json`, a `SKILL.md` directory-bundle skill with references, and slash
  commands for init, debate, validate and verdict.
- **Offline suites** (`core/validate-all.js`): body, driver, profiler and genericity —
  the last of which fails if a domain word, a language assumption or a machine path
  ever reaches a shipped file.

### Added (publication)

- `.gitignore`: local state (`.formalswarm/` profiles and scratch), packaging noise,
  editor and OS files, and the one entry that keeps the historical
  repository-specific debate out of the published project.
- `.gitattributes`: `* text=auto eol=lf`. The plugin's own validators read and compare
  its text files, so a Windows checkout with `core.autocrlf=true` would have silently
  broken them. The frontmatter parser also tolerates CRLF now, and a new check fails if
  any shipped file ever carries CRLF.
- CI on GitHub: the offline gate across three Node versions, the packaged artefact run
  from its own tarball, and a bundle-patch loadability check.
- The genericity scan now covers the files a distribution actually contains: npm does
  not package `.gitignore`/`.gitattributes`, so scanning an installed copy crashed on
  them. The check exists to prove what ships, and now it reads exactly that.

- List overrides accept a comma-separated value (`--set frozen_paths=core,lib,prompts`)
  as well as a JSON array, so no Windows shell has to get nested quoting right.

### Changed

- **Scale is the caller's decision.** The fixed 15-call ceiling and the 1–5 group clamp
  are gone. Groups take any size from 1 to 500 (a sanity ceiling against a typo, not a
  policy), and the ceiling that matters is the declared `max_calls`, default 15 to keep
  the pilot safe, raised with `--max-calls`. The plan is refused before the first call,
  and the error says exactly which value would allow it.
- `brief` now prints **scale advice** without refusing anything: a critic partition that
  is getting unreadable, verifiers with no assigned check, too many checks on one
  verifier, a run wide enough that the runtime's concurrency cap becomes the arbiter.
- The seal brief is **bounded** on wide runs: every blocking objection always reaches
  the verifiers, while long thesis texts and a crowded ledger are clipped with an
  explicit warning (nothing is lost — the full material is in the scratch files and in
  `outcome.json`). The second-round board is bounded the same way.
- `save` **refuses** an answer whose `<label>@<PHASE>` was never requested by the driver,
  and names what the round is actually waiting for. A mistyped label used to store an
  answer nobody would ever read, stalling the round loop.

### Notes

- The historical repository-specific debate under `agents/` is intentionally not part
  of this plugin and is left untouched; FormalSwarm is a separate, portable
  implementation.

### Fixed during the first end-to-end validation runs

Found by running the protocol on a real repository, not by reading it:

- **Briefs held strings where numbers belong.** `--thesis 3 --critics 2 --seals 3
  --rounds 2` produced an `args` object whose group sizes were strings, so any
  consumer that summed them concatenated and reported a nonsensical worst case
  (`32330` agent calls, from `"3" + "2" + "3" + "2"`). Group sizes and the round count
  are now coerced and validated once, in `buildArgs`, and the brief on disk holds
  numbers.
- **An over-budget plan was only refused at launch.** `brief` now computes the same
  worst-case formula as the body and refuses the plan before a single agent call is
  spent, and reports validation failures as one readable line instead of a stack
  trace.
- **An objection filed outside a critic's assigned partition was invisible.** The
  partition is what guarantees the antithesis is independent, so a violation can no
  longer pass unnoticed: the objection is kept and routed to the writer it is about,
  tagged `out_of_partition`, marked on the second-round board, and counted in
  `global_verdict.warnings`.
- **A repository with source files but no manifest was "unknown".** Detection now
  falls back to a bounded content probe (two levels deep, skipping build and vendor
  directories) and records the inference in `notes`; a `Makefile` with a `test:`
  target still wins over the probe because it names a real command.
- **The content probe stalled the CLI on large trees** (25 s in a nested checkout):
  it now uses `readdirSync(withFileTypes)` and a bounded entry budget, which brings
  the same call under 1.5 s.

### Fixed after an adversarial review of the implementation

An independent reviewer was pointed at the code with instructions to break it, and
produced ten reproduced defects. All ten are fixed and pinned by regression tests (the
offline gate grew from 93 to 107 checks):

- **Coverage was a count, not a match** — a verifier could report the right *number* of
  checks under different names (or under an empty command) and still reach `CONFIRM`.
  Coverage now matches each assigned check to a reported check by command identity;
  duplicates, unmatched reports and empty commands are recorded, and any mismatch is
  `INCONCLUSIVE`.
- **A declared `REVISE` could be softened into `INCONCLUSIVE`.** A verifier that says
  it saw a failure keeps its verdict; the coverage defect is recorded beside it, not
  instead of it.
- **Empty strings satisfied every schema** — an empty `command` or an empty `thesis`
  now fails the protocol's own content checks, in the body, where all three runtimes
  execute the same code. A schema-valid but empty answer is a fallen agent, not a
  thesis.
- **Arbitrary file write outside the result folder** via `--label`/`--phase` path
  traversal. Labels and phases are restricted to a safe alphabet, `..` is rejected,
  and every artefact path is verified to resolve inside the folder.
- **The folder-to-brief binding failed open**: an unreadable or truncated
  `run_id.json` silently disabled the guard, letting one debate consume another's
  stored answers. It now fails closed, and the signature is written through a rename.
- **`additionalProperties: false` was bypassed** for fields named after
  `Object.prototype` members (`constructor`, `toString`, …), so the driver and the
  harness could disagree on the same payload. The check is now `hasOwnProperty`.
- **An absolute `profile.scratch` was joined onto the repository root**, writing driver
  artefacts inside the target repository instead of the scratch directory.
- **A `--seal` value beginning with a dash was silently swallowed**, running the debate
  with one check fewer than requested. Value-taking flags now consume the next token
  unless it names a known flag, and a flag with no value is an error rather than a
  silent `1`.
- **A falsy element in `objections` crashed the body** with a `TypeError`; non-object
  objections are dropped, recorded against the critic that produced them, and can no
  longer reach the ledger.
- **A brief file containing `null` died with a raw `TypeError`** instead of a
  diagnostic.
- **POSIX-only commands in a repo-agnostic profiler**: the Python interpreter and the
  Gradle wrapper now follow the platform the checks will run on (`python`/`python3`,
  `gradlew.bat`/`./gradlew`).

### Fixed while installing the plugin into ZCode on Windows

- **The offline gate was not portable.** `validate-profile.js` compared against the
  POSIX interpreter unconditionally, so `node core/validate-all.js` failed under
  Windows Node even though the profiler itself was correct. The expectations now derive
  the interpreter from the running platform, and the platform test asks for each
  platform explicitly instead of relying on the one it happens to run on.
- **The end-to-end smoke test hard-coded `python3`**, which a default Windows Python
  installation does not provide; it now emits `python` there. Both suites are green
  under Node on Linux and on Windows.
