---
description: Profile this repository for FormalSwarm (stack, test command, frozen paths, scratch)
argument-hint: "[optional repo path] [--gitignore]"
---

<!-- FormalSwarm command. The plugin root resolves on every runtime. -->

# FormalSwarm — profile this repository

Resolve the plugin root and the CLI:

```sh
FORMALSWARM_ROOT="${CLAUDE_PLUGIN_ROOT:-${ZCODE_PLUGIN_ROOT:-$(node -p "require('path').dirname(require.resolve('formalswarm/package.json'))" 2>/dev/null)}}"
FS="node $FORMALSWARM_ROOT/core/bin/formalswarm.js"
```

Then run the initialization with the arguments the user provided (default: the current
working directory):

```sh
$FS init $ARGUMENTS
```

Read the summary printed on stderr and **verify it against the repository** before
accepting it:

1. Is the detected `test_command` the one this project actually uses? If not, fix it
   with `--set` at brief time or edit `.formalswarm/profile.json`.
2. Do `frozen_paths` cover every directory a debate must not touch?
3. If `notes` report a missing test command, the seal will have to be given explicit
   checks — say so to the user instead of inventing a command.

Report: detected stack, test command, frozen paths, and any gap. Do not start a debate
in this command.
