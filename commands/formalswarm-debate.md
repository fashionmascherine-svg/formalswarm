---
description: Open a FormalSwarm debate on this repository (theses, antithesis, seal)
argument-hint: "<objective> | <verdict question>"
---

<!-- FormalSwarm command. You are the ORCHESTRATOR: the main session. -->

# FormalSwarm — open a debate

Follow the `formalswarm` skill (load it if it is not already loaded). The user's
arguments are: `$ARGUMENTS` — an objective and, after `|`, the verdict question.
If the user gave no objective, ask for one sentence before doing anything else.

Resolve the CLI:

```sh
FORMALSWARM_ROOT="${CLAUDE_PLUGIN_ROOT:-${ZCODE_PLUGIN_ROOT:-$(node -p "require('path').dirname(require.resolve('formalswarm/package.json'))" 2>/dev/null)}}"
FS="node $FORMALSWARM_ROOT/core/bin/formalswarm.js"
```

Then, in order:

1. **Profile.** `$FS status`. If no profile exists, `$FS init` first and verify the
   detected test command against the repository. If detection is wrong or missing, use
   `--set` rather than editing the profile by hand.
2. **Brief.** Choose 3–6 context files that actually decide the question. Write the
   seal plan: one runnable check per verifier, each able on its own to flip the
   answer; one check for every blocking objection you expect. Then:

   ```sh
   $FS brief --objective "<objective>" --verdict-question "<question>" \
     --context <a,b,c> --seal "<command 1>" --seal "<command 2>"
   ```

   Pilot scale (2+2+2, rounds=1) for a first run or a new kind of task; 5+5+5 only
   with rounds=1 and only after a sound pilot.
3. **Validate.** `$FS validate` — must be green before any agent call.
4. **Launch.**
   - On DeepSeek Harness: call the `workflow` tool with `script` = `$FS body`,
     `meta` = `$FS meta`, `args` = the brief printed by step 2.
   - On Claude Code or ZCode: run the round loop of
     `references/runtimes.md` — `$FS run <scratch>/brief.json`, execute the entries
     with `prompt_final: true` in fresh-context subagents, store each answer with
     `$FS save`, repeat until exit 0.
5. **Report.** Read `<scratch>/outcome.json` and report `global_verdict.outcome`, its
   reason, the warnings, the objection count, and the seal's checks with their exit
   codes and case counts. Apply production changes only on `CONFIRM`, and only from
   this session.
