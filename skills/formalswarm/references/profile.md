# Profile reference

FormalSwarm carries **no** knowledge of any language, framework or domain: everything
it knows about the target repository comes from `.formalswarm/profile.json`, detected
by `formalswarm init` or on the fly. Detection is pure and deterministic — the same
tree always produces the same profile — and every field can be overridden per launch.

## Fields

| Field | Meaning |
|---|---|
| `repo_root` | absolute repository root (VCS root, else nearest marker) |
| `repo_name` | basename of the root |
| `vcs` | `git` or `none` |
| `stack` | primary stack, or `unknown` |
| `stacks` | every detected stack (monorepos) |
| `test_stack` | the stack the test command came from |
| `test_command` | canonical test command, or `null` — never a guess |
| `lint_command`, `build_command` | same rule: a real command or `null` |
| `test_runner` | which runner the command belongs to (`pytest`, `package.json:test`, `cargo`, …) |
| `package_manager` | `pnpm` / `yarn` / `bun` / `npm` from the lockfile, else `npm` |
| `stack_commands` | the commands detected for every stack |
| `source_dirs`, `test_dirs` | existing conventional directories |
| `frozen_paths` | `source_dirs + test_dirs` — read-only for the whole debate |
| `scratch` | `.formalswarm/scratch`; the brief makes it absolute |
| `evidence_style` | `path:line` |
| `notes` | what detection could not establish, in plain words |

## Detection

| Stack | Marker | test command |
|---|---|---|
| python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `tox.ini`, `Pipfile` | `python3 -m pytest -q` when pytest is configured, else `python3 -m unittest discover -s tests -v` |
| node | `package.json` | `scripts.test` via the detected package manager, else `npx vitest run` / `npx jest` / `npx mocha` when the dependency is present |
| rust | `Cargo.toml` | `cargo test` |
| go | `go.mod` | `go test ./...` |
| maven | `pom.xml` | `mvn -q test` |
| gradle | `build.gradle(.kts)`, `settings.gradle(.kts)` | `./gradlew test` when the wrapper exists, else `gradle test` |
| ruby | `Gemfile` | `bundle exec rspec` with `spec/`, else `bundle exec rake test` |
| php | `composer.json` | `composer test` when the script exists, else `vendor/bin/phpunit` |
| make | `Makefile` with a `test:` target, and no other marker | `make test` |
| unknown | none of the above | `null` |

When there is no manifest at all, the profile falls back to a **bounded content probe**
(it looks two levels deep for `.py`, `.js`, `.ts`, `.rs`, `.go`, `.rb`, `.php`, skipping
build and vendor directories) and records the guess in `notes`. A repository made of
source files and nothing else is therefore still understood, and the guess is never
silent. A `Makefile` with a `test:` target wins over the probe, because it names an
actual command.

A `null` test command is a **fact the debate can use**, not a failure: pass the real
checks in `--seal`, and the seal verifies those.

## Per-launch overrides

`formalswarm brief --set key=value` (repeatable) overrides any of:

`stack`, `test_command`, `lint_command`, `build_command`, `test_runner`,
`package_manager`, `source_dirs`, `test_dirs`, `frozen_paths`, `scratch`,
`evidence_style`, `notes`, `repo_name`.

Values are parsed as JSON when they start with `[`, `{`, a digit, `t`, `f`, `n` or
`-`; otherwise as a string. An unknown key is **rejected**, never ignored: a typo must
not look like a setting.

The list fields — `source_dirs`, `test_dirs`, `frozen_paths`, `notes` — also accept a
plain comma-separated value:

```sh
--set frozen_paths=core,lib,prompts,skills,commands
```

which is the same as `--set 'frozen_paths=["core","lib","prompts","skills","commands"]'`
without requiring a shell to get the quoting right. On Windows, cmd and PowerShell
disagree about quotes inside an argument; a plugin that claims to work anywhere should
not make the caller win that fight.

```sh
$FS brief --objective "..." --verdict-question "..." \
  --context src/engine.py,src/config.py,tests/test_engine.py \
  --seal "python3 -m pytest -q tests/test_engine.py" \
  --set test_command="python3 -m pytest -q" \
  --set 'frozen_paths=["src","tests"]'
```

## Files

- `.formalswarm/profile.json` — the stored profile.
- `.formalswarm/scratch/` — scratch and artefacts; the profile file itself is never
  written to by a debate.
- `formalswarm init --gitignore` adds `.formalswarm/` to `.gitignore`. Without the
  flag nothing outside `.formalswarm/` is touched.
