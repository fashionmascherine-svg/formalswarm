# Runtimes reference

One body, three runtimes. `core/debate.workflow.js` is executed **unchanged** on all
of them; only the component that turns an agent call into a subagent differs. The
verdict is therefore computed from the same logic everywhere, bit for bit.

Resolve the plugin root once:

```sh
FORMALSWARM_ROOT="${CLAUDE_PLUGIN_ROOT:-${ZCODE_PLUGIN_ROOT:-$(node -p "require('path').dirname(require.resolve('formalswarm/package.json'))" 2>/dev/null)}}"
FS="node $FORMALSWARM_ROOT/core/bin/formalswarm.js"
```

## Common step zero: profile and validate

```sh
$FS init                       # once per repository (writes .formalswarm/profile.json)
$FS status                     # check stack, test command, frozen paths
$FS validate                   # offline, zero agent calls — must be green
```

## DeepSeek Harness — the `workflow` tool

The harness has a `workflow` tool whose body cannot read files, which is why the
brief embeds the prompts and the profile.

```sh
$FS brief --objective "..." --verdict-question "..." \
  --context a,b,c --seal "cmd1" --seal "cmd2"      # writes <scratch>/brief.json
$FS body > /tmp/body.js                            # the `script` parameter
$FS meta                                           # the `meta` parameter (JSON)
```

Then call the `workflow` tool with `script` = the file printed by `body`, `meta` =
the object printed by `meta`, and `args` = the JSON printed by `brief`. The tool
spawns every subagent itself, in parallel per phase. Nothing else is needed — the
harness is the only runtime with a native orchestration primitive.

On this runtime the outcome object comes back as the workflow tool's return
value: nothing writes it to disk for you. Save it to `<scratch>/outcome.json`
yourself (e.g. from the orchestrator session) so the verdict stays auditable and
step 5 below reads the same file on all three runtimes.

`args` can also be given to the round loop below instead, which is useful for a
headless run or to inspect the prompts before spending calls.

## Claude Code — subagents through the Task tool

Claude Code plugins have no `workflow` tool, so the body runs through the driver, one
phase at a time:

```sh
$FS run <scratch>/brief.json          # exit 2: an intermediate round
```

`run` prints the pending calls and writes `<scratch>/driver/pending.json`. For every
entry with `prompt_final: true`:

1. read `<scratch>/driver/<label>@<PHASE>.prompt.txt`;
2. spawn a subagent (Task tool) with that prompt as its **entire** instruction — do
   not add conversation context: independence is the point;
3. write the subagent's answer verbatim to a file and store it:
   `$FS save --label <label> --phase <PHASE> --raw answer.txt --dir <scratch>/driver`;
4. if the subagent failed, store the fall instead:
   `$FS fall --label <label> --phase <PHASE> --reason "..." --dir <scratch>/driver`.

Entries with `prompt_final: false` were built on placeholders: do not execute them,
just re-run the driver. Repeat until `run` exits 0 and prints the global verdict.

## ZCode — subagents through the Agent tool

Identical loop, same commands, same files: ZCode's subagent tool is `Agent`, and its
plugin root is `${ZCODE_PLUGIN_ROOT}` (the manifest is the same `.claude-plugin/` one,
which ZCode consumes as legacy-compatible). Spawn a fresh-context `general-purpose`
child pointed at the prompt file — declared plugin agents are diagnostic-only on
current ZCode builds, so never rely on a named agent type.

```sh
$FS run <scratch>/brief.json
# execute pending entries with prompt_final=true through the Agent tool, then
$FS save --label ... --phase ... --raw ... --dir <scratch>/driver
$FS run <scratch>/brief.json          # exit 0 when complete
```

## Driver exit codes and files

| Exit | Meaning |
|---|---|
| `0` | debate complete: `outcome.json` written (and mirrored into `<scratch>/`) |
| `2` | intermediate round: execute the `prompt_final: true` entries of `pending.json` |
| `1` | error: invalid brief, failed body, missing file, or a folder signed by another debate |

| File (in `--dir`, default `<scratch>/driver`) | Meaning |
|---|---|
| `run_id.json` | hash of `args` + body; a different brief on the same folder is refused |
| `<label>@<PHASE>.prompt.txt` | the exact prompt, always the last version built on real upstream results |
| `<label>@<PHASE>.json` | a stored, schema-validated answer |
| `<label>@<PHASE>.FALLEN.json` | a declared fallen agent (the body sees `null`) |
| `pending.json` | the calls of the current round |
| `outcome.json` | the final body output |

Every `run` replays the **whole body** from the beginning with the answers stored so
far. That is what keeps the three runtimes identical — the body is deterministic and
stateless, so it does not "resume", it recomputes — and it is why the phase log
repeats ("Theses produced: …" on every round) and why `pending.json` also lists calls
whose prompts were built on placeholders. Only the entries with `prompt_final: true`
are meant to be executed.

## Why the same verdict everywhere

The driver extracts the schemas **from the body text** and validates every stored
answer against them before the body ever sees it; a non-conformant answer becomes a
fallen agent, exactly as an unsupported payload does on the harness. The brief is the
same object on all three runtimes, and the rollup is the body's own code. There is no
per-runtime verdict logic to drift.
