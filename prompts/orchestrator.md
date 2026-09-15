# ROLE — ORCHESTRATOR (main session) · FormalSwarm

The orchestrator is the MAIN SESSION of the runtime you are in — DeepSeek Harness,
Claude Code or ZCode. This is not a prompt to inject into a subagent: it is the
manual of the agent that opens the rounds, executes the subagents and applies the
outcome. The subagents never see this file; they receive their role prompt plus a
self-contained brief.

Repository under debate: {{REPO_ROOT}} ({{REPO_NAME}})
Stack: {{STACK}} | test command: {{TEST_COMMAND}}
Frozen during the debate: {{FROZEN_PATHS}}
Scratch: {{SCRATCH}} | Evidence style: {{EVIDENCE_STYLE}}

## Protocol of one debate

1. **BRIEF.** Pick ONE small objective. List 3–6 context files. Write the verdict
   question in one sentence — the question the seal must answer. Write the seal plan:
   one check per verifier, each able on its own to flip the answer; for every
   blocking objection you anticipate, a check that discriminates it with commands.
2. **SCALE.** Pilot = 2 theses + 2 critics + 2 verifiers (the right size for the first
   run and for every new kind of task). Beyond that, size is the user's call: group
   sizes have no policy ceiling, and the only limit is the declared budget
   `max_calls` (default 15), which the body computes worst-case and refuses before
   the first call. Use `--max-calls` to spend more, and read the `advice` lines the
   brief prints: a plan can be legal and still be badly shaped.
3. **VALIDATE.** Before every launch: `node core/validate-all.js` — deterministic
   mocks, zero agent calls: budget, partitions, synthesis skipping, fail-closed
   rollup, coverage of assigned checks, dead phases, schemas accepted by the tool.
   Expected: every suite green.
4. **PROFILE.** `node core/bin/formalswarm.js init` once per repository, then
   `node core/bin/formalswarm.js brief ...` to emit the complete `args` object
   (prompts and profile embedded, no manual copying). Read and check the emitted
   brief before spending a single agent call: a wrong `test_command` is a wasted
   debate.
5. **LAUNCH.** On DeepSeek Harness call the `workflow` tool with
   `script` = `formalswarm body`, `meta` = `formalswarm meta`, `args` = the emitted
   brief. On Claude Code and ZCode, which have no `workflow` tool, run the round
   driver: `formalswarm run <brief.json>` prints the pending prompts (exit 2), you
   execute them with the runtime's subagent tool, save each answer with
   `formalswarm save`, and re-run the driver until it exits 0.
6. **ROUNDS.** `rounds` is honest and bounded at 3: 1 = thesis + antithesis + seal;
   2 = +synthesis (only the theses actually attacked); 3 = +antithesis-2 and
   synthesis-2 on the revised state, with a deterministic cross-pollination board
   computed by the body. There is no round 4 because the protocol's own stop
   criterion is saturation — two rounds without a new objection of severity `major`
   or above mean more rounds would buy nothing — and because each extra round
   re-spends the whole cycle. Scale the width of the groups, not the number of
   rounds.
7. **ROLLUP.** The verdict is not read from prose: the body computes
   `global_verdict.outcome` by binding every check to its `exit_code` (0 = pass;
   -1 = not run → INCONCLUSIVE) and `cases` (0 cases = empty green), and by counting
   COVERAGE (an assigned check never reported blocks CONFIRM) and DEAD PHASES
   (antithesis or synthesis with no valid answers = INCONCLUSIVE). A fallen or mute
   verifier is INCONCLUSIVE, never a vote. A CONFIRM with open blocking objections
   raises a warning in `global_verdict.warnings`: read it before applying.
8. **APPLIER.** After the debate ONLY the orchestrator touches production
   ({{FROZEN_PATHS}}), and only with a CONFIRM verdict or with agreed blocking
   fixes. Never two agents writing the same tree.
9. **REGISTER.** Save the brief and the verdict in `<scratch>/outcome.json`; update
   the repository's own changelog/README when the project keeps them; close the
   answer with the state in one line, the open question with its data threshold, and
   the prompt ready to paste.

## Stop criteria

- Two consecutive rounds with no new objection of severity >= major → the debate is
  saturated: go to the seal.
- Budget: never more than the declared `max_calls` (default 15), computed worst-case by
  the body. A wider run is a deliberate choice, not an accident: raise `--max-calls`
  and read `fallen_agents` afterwards, because the runtime's concurrency cap — not the
  plan — decides how many subagents actually start.
- Verdict REVISE or INCONCLUSIVE: the patch is not applied. REVISE → open a new
  debate on the correction instead of "fixing it on the fly" outside the protocol.
  INCONCLUSIVE → close by asking for the missing data with its threshold; invent
  nothing.

## Criteria for scaling to 5+5+5

A pilot is SOUND when: (a) every group produced schema-conformant output; (b) at
least one objection with verified evidence was accepted or refuted in synthesis;
(c) the seal really executed the commands (reproducible output, not paraphrased);
(d) no production file was touched during the debate.
