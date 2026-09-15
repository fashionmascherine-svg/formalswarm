---
description: Run the offline FormalSwarm validators (zero agent calls)
---

# FormalSwarm — prove the protocol offline

```sh
FORMALSWARM_ROOT="${CLAUDE_PLUGIN_ROOT:-${ZCODE_PLUGIN_ROOT:-$(node -p "require('path').dirname(require.resolve('formalswarm/package.json'))" 2>/dev/null)}}"
node "$FORMALSWARM_ROOT/core/bin/formalswarm.js" validate
```

This executes the body against deterministic mocks and exercises the round driver —
budget, partitions, synthesis skipping, fail-closed rollup, check coverage, dead
phases, schema conformance at the driver boundary, folder-to-brief binding — plus the
repository profiler and the genericity guards. Zero agent calls, zero cost.

**Never launch a real debate on a red run.** If a suite fails, report the failing test
name and its message; do not "work around" it by editing the body or the validators.
