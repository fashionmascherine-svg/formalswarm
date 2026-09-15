# Protocol reference

## Phases

| Phase | Who | What it must produce |
|---|---|---|
| `THESIS` | `n_thesis` writers, isolated spawns | `thesis`, `findings[]` (claim + evidence), `risks[]`, `proof_measure` |
| `ANTITHESIS` | `n_critics`, each with a disjoint partition of the theses | `objections[]`: `thesis_id`, `type`, `severity`, `evidence`, `fix` |
| `SYNTHESIS` | only the writers actually attacked (`rounds >= 2`) | `revised_thesis`, `responses[]` copying the objection's `evidence` verbatim |
| `ANTITHESIS-2` | `n_critics` on the revised state, with a deterministic board (`rounds = 3`) | new objections only |
| `SYNTHESIS-2` | only the writers attacked in round 2 (`rounds = 3`) | answers to the new objections |
| `SEAL` | `n_seals` verifiers, each with a disjoint slice of `seal_plan` | `checks[]` with `command`, `outcome`, `exit_code`, `cases`, `detail`; `verdict`; `measurement_limit` |

A writer id is canonical and assigned by the body (`thesis-01`, `thesis-02`, …): the id
an agent writes into its own JSON is overwritten. An objection whose `thesis_id` does
not exist is **orphan**: it reaches the seal and never disturbs an unrelated writer.

## Budget and scale

Groups have **no policy ceiling**: how many agents a debate uses is the caller's
decision. A sanity ceiling of 500 per group exists only to catch a typo before it
spawns anything.

The ceiling that matters is the one you declare — `max_calls`, default **15**:

```
planned = n_thesis + n_critics + n_seals
        + (rounds >= 2 ? n_thesis : 0)
        + (rounds >= 3 ? n_critics + n_thesis : 0)
```

`planned > max_calls` → the body throws **before the first call** and nothing is spent.
Raising it is a flag, not a redesign:

| Plan | rounds | Worst case | Needs |
|---|---|---|---|
| 2+2+2 (pilot) | 1 | 6 | default ceiling |
| 2+2+2 | 3 | 12 | default ceiling |
| 5+5+5 | 1 | 15 | default ceiling |
| 5+5+5 | 2 | 20 | `--max-calls 20` |
| 60+40+40 (wide) | 1 | 140 | `--max-calls 140` |
| 20+10+10 (full cycle) | 3 | 120 | `--max-calls 120` |

Real cost is usually below the worst case: synthesis phases start only for writers with
at least one objection, and a critic with an empty partition is never spawned.

Two guards keep a large run honest rather than merely large:

- **The partition scales with the critics.** Writers are dealt round-robin, so each
  critic reads `n_thesis / n_critics` theses. Keep that number small; `brief` advises
  when it is not.
- **The seal brief stays bounded.** Every blocking objection always reaches the
  verifiers; beyond 120 non-blocking entries and 6000 characters per thesis, the brief
  is clipped with an explicit warning, because the full material is in the scratch files
  and in `outcome.json`.

The runtime caps how many subagents actually run at once. A spawn the runtime refuses is
a **fallen agent**, which kills the phase and yields `INCONCLUSIVE` — never a silent
pass. That is why a very wide run should be read together with `fallen_agents`.

## Objection ledger

Every objection has exactly one deterministic state, moved **only** by synthesis:

`to_answer` → `accepted` | `rejected` | `unanswered`; or `orphan` from the start.

- The writer copies the objection's `evidence` string into its response's `objection`
  field. The count compares strings exactly.
- Duplicate evidence strings consume one response each, in order: a duplicated
  objection cannot be "accepted" by collision.
- A writer that was never attacked keeps `to_answer` and its objections still reach
  the seal.
- An objection whose `thesis_id` exists but was **not assigned to the critic that
  filed it** is tagged `out_of_partition`: the isolation the partition promises was
  violated. It is kept and routed to the writer it is about — the objection may still
  be right — but it raises a warning and is marked on the board, so the violation is
  never invisible.

A check is an **assertion that a property holds**: `exit_code: 0` means it holds. A
probe that exits non-zero to *report* a defect (a surviving mutant, a detected
divergence) must be inverted into an assertion — otherwise a real finding is
indistinguishable from a broken command.

`cases` is the denominator: how many instances the tool really evaluated (test cases
run, mutants tried, corpus inputs compared, probes executed). It is what separates a
proof from an empty green.

## Rollup — how the verdict is computed

Per check, from the verifier's own numbers:

| Declared | `exit_code` | `cases` | Normalized |
|---|---|---|---|
| `ok` | `-1` | any | `not_run` |
| `ok` | `!= 0` | any | `failed` |
| `ok` | `0` | `<= 0` | `unsupported` (empty green) |
| `ok` | `0` | `> 0` | `ok` |
| any | any | any | an empty or blank `command` is `unsupported`: a check that names no command cannot be reproduced |
| `failed` / `not_run` | any | any | kept as declared (pessimistic) |

**Coverage is a match, not a count.** Every assigned check must be answered by a
reported check naming the *same command*. A verifier returning the right number of
checks under different names has verified nothing it was asked to, and the review
records it as `coverage incomplete` with the commands never reported and the reported
commands that were never assigned.

Per verifier:

- `REVISE` if any check is `failed`;
- otherwise `REVISE` if the verifier declared `REVISE` — a testimony of failure is
  never softened into missing data, and the note `declared REVISE kept` records that the
  checks did not prove it;
- otherwise `INCONCLUSIVE` if any check is `not_run`/`unsupported`, if coverage is
  incomplete, or if `empty = "yes"`;
- otherwise the declared verdict.

A verdict the checks do not support is reported as `coherence: corrected_by_the_body`
and raises a warning.

Global verdict, in this order:

1. no verifier produced a conformant verdict → `INCONCLUSIVE` (mute seal);
2. fewer verdicts than active verifiers → `INCONCLUSIVE` (incomplete seal);
3. any verifier effective `REVISE` → `REVISE`;
4. any verifier effective `INCONCLUSIVE` → `INCONCLUSIVE`;
5. antithesis or synthesis group dead (no valid answer) → `INCONCLUSIVE`;
6. otherwise → `CONFIRM`.

Warnings are always informative, never decorative:

- `CONFIRM` with blocking objections still open (rejected or unanswered) — read this
  before applying anything;
- orphan objections passed to the seal without synthesis;
- verdicts corrected by the rollup;
- fallen agents per phase.

## Output

`<scratch>/outcome.json` (and `<scratch>/driver/outcome.json` on the round loop):

```
schema_version, tool, objective, verdict_question, repository, config, budget,
global_verdict { outcome, reason, warnings },
objection_count { total, accepted, rejected, unanswered, to_answer, orphan },
theses, current_theses, objections, synthesis, seal_verdicts, verdict_review, fallen_agents
```

## Stop criteria

- Two consecutive rounds with no new objection of severity `major` or `blocking` →
  the debate is saturated; go to the seal.
- `REVISE` → the patch is not applied; open a new debate on the correction.
- `INCONCLUSIVE` → close by asking for the missing data and its threshold.
