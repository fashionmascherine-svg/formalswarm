---
description: Read the last FormalSwarm outcome and decide whether it may be applied
---

# FormalSwarm — read the verdict

Find the newest `outcome.json` (under `.formalswarm/scratch/`) and report it without
embellishment:

| Report | From |
|---|---|
| outcome | `global_verdict.outcome`: `CONFIRM` / `REVISE` / `INCONCLUSIVE` |
| reason | `global_verdict.reason` |
| warnings | `global_verdict.warnings` — quote every one |
| objections | `objection_count` (accepted / rejected / unanswered / to_answer / orphan) |
| seal | for each entry of `verdict_review`: verifier, declared, effective, coherence, notes |
| checks | for each check: command, exit code, cases |

Then apply these rules exactly:

- **`CONFIRM`** — production may be changed, by THIS session only, and only for what
  the theses proposed. If warnings list blocking objections still open, read them and
  say which ones the seal did not discriminate before touching anything.
- **`REVISE`** — nothing is applied. Quote the failing check with its exit code and
  output. Open a new debate on the correction; never patch "on the fly" outside the
  protocol.
- **`INCONCLUSIVE`** — nothing is applied and nothing is invented: state precisely
  which data is missing and what threshold would settle it.

Never re-word a verdict into something stronger. `INCONCLUSIVE` is not a failure of
the work; a `CONFIRM` invented from prose is.
