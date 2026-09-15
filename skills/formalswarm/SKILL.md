---
name: formalswarm
description: Use when a change, refactor, audit or technical claim in any repository must be validated before it is applied, when a verdict must be backed by commands that were actually run, or when the user asks for a debate, an adversarial review, or a fail-closed seal of the agent's own work.
---

# FormalSwarm

## Overview

FormalSwarm validates a claim about **any** repository with three independent groups
and one rule: **the verdict is computed from real exit codes, never from prose.**

| Group | Role | Produces |
|---|---|---|
| 1 | Thesis writers (parallel, isolated) | independent proposals, or findings for an audit |
| 2 | Critics (antithesis) | objections with re-read evidence; blocking / major / minor |
| 3 | Seal verifiers | checks actually executed: `exit_code`, `cases`, `detail` |

The orchestrator is the **main session**. It never votes: a deterministic rollup binds
every check to its exit code and case count, counts coverage of the assigned checks,
and fails closed — a missing check, a mute verifier or an empty green makes the
outcome `INCONCLUSIVE`, never `CONFIRM`.

**Core principle:** silence is not a vote. A green without cases is not a proof.

## When to use

- A non-trivial change, migration, refactor or audit needs validation before applying.
- A verdict must survive scrutiny: "it works" is not evidence, a command is.
- Two designs or two claims contradict each other and a discriminating command decides.
- The user asks for a debate, adversarial review, seal, or fail-closed verification.

**Do not use** for: trivial edits, exploratory conversation, or anything whose answer
is already fixed by a test you can simply run and paste.

## Quick reference

Resolve the plugin root once (works on all three runtimes):

```sh
FORMALSWARM_ROOT="${CLAUDE_PLUGIN_ROOT:-${ZCODE_PLUGIN_ROOT:-$(node -p "require('path').dirname(require.resolve('formalswarm/package.json'))" 2>/dev/null)}}"
FS="node $FORMALSWARM_ROOT/core/bin/formalswarm.js"
```

| Step | Command |
|---|---|
| Profile the repository (once) | `$FS init [--gitignore]` |
| Inspect the profile | `$FS status` |
| Build the brief (args object) | `$FS brief --objective S --verdict-question S --context a,b,c --seal "cmd"` |
| Prove the logic offline (0 agent calls) | `$FS validate` |
| Get the workflow body / meta | `$FS body` / `$FS meta` |
| Get a filled role prompt | `$FS prompt --role thesis` |
| Run the round loop (no workflow tool) | `$FS run <scratch>/brief.json` |

## Protocol in one pass

1. `init` the repository (or rely on live detection) and check the `test_command` the
   profile reports: a wrong command wastes a whole debate.
2. `brief` with ONE objective, 3–6 context files, and a **seal plan**: one runnable
   check per verifier, each able on its own to flip the answer. Size the groups to the
   question — the default 2+2+2 pilot, or as wide as you want (`--thesis 60 --critics 40
   --seals 40 --max-calls 200`); the budget is refused before the first call, never
   discovered halfway.
3. `validate` — offline, zero calls. Never launch on red.
4. Launch: on DeepSeek Harness call the `workflow` tool with `body` + `meta` + the
   brief. On Claude Code and ZCode use the round loop in `references/runtimes.md`.
5. Read `global_verdict` from `<scratch>/outcome.json`: `CONFIRM`, `REVISE` or
   `INCONCLUSIVE`. Apply production changes **only** on `CONFIRM`, and only from the
   orchestrator session — never from a subagent.

## Why not one careful agent

A single agent asked to validate a change produces a *prose* verdict from ad-hoc
commands. Observed failure modes, all of them mechanical here:

| One careful agent | FormalSwarm |
|---|---|
| Ran `unittest discover` (0 tests) and separately a targeted run (3 tests), and had to notice the contradiction itself | every check reports its own `cases`; `cases: 0` cannot pass |
| Decided by inspection that the suite was insufficient | coverage of the assigned checks is counted, and a missing check is `INCONCLUSIVE` |
| The verdict was a judgement, however well argued | the verdict is computed from exit codes, case counts and coverage |
| Nothing bounded the investigation | worst-case budget, refused before the first call |

The protocol does not make the agents smarter. It makes the *verdict* auditable: a
reader can recompute it from `<scratch>/outcome.json` without trusting any prose.

## Red flags — stop

- Launching without `$FS validate` green.
- A seal check with `cases: 0`, `exit_code: -1`, or an assertion that cannot fail.
- A test command that silently discovers nothing (`unittest discover` without `-s`, a
  runner with no test files): that is an empty green, not a pass.
- Reporting an exit code from one command and a case count from a different one.
- Reporting `CONFIRM` while an assigned check is missing from the output.
- Applying a patch on `REVISE` or `INCONCLUSIVE`: on `INCONCLUSIVE` ask for the
  missing data with its threshold; on `REVISE` open a new debate on the correction.
- More than the declared `--max-calls`: the body refuses, but plan the budget before,
  not after. On a very wide run, read `fallen_agents` — the runtime's concurrency cap,
  not the plan, decides how many subagents actually start.

## Deep dives

- `references/protocol.md` — phases, budget, rounds, objection ledger, rollup rules.
- `references/profile.md` — profile fields, detection table, per-launch overrides.
- `references/runtimes.md` — exact launch procedure per runtime, and the round loop.
