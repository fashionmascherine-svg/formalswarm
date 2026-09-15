# Contributing

## Run the gate first — always

```sh
node core/validate-all.js   # must print: ALL SUITES GREEN — 114 checks
npm run test:e2e            # must end: e2e smoke: ALL GREEN
```

Both must exit `0` before you propose anything. The gate is offline: zero agent calls,
about four seconds. The e2e needs `python` (or `python3`) on `PATH`.

## The tests are the specification

Every behavior this plugin promises is pinned by a counted check in `core/validate-*.js`.
A change without a check is a claim without a measurement — add the check that would
fail without your change, and update the printed check count anywhere the docs state it.

## What must never enter a commit

- `.formalswarm/` — local profiles and debate scratch (gitignored).
- `agents/` — a legacy tree that references a private checkout; it stays on disk, never in git.
- `node_modules/`, `*.tgz` — packaging noise.
- A machine path (`/home/…`, `C:\Users\…`, `/mnt/c/…`) or a domain word in any shipped
  file: `core/validate-generic.js` fails the gate if one ever returns.

## House rules

- One body, three runtimes: `core/debate.workflow.js` is the single source of truth.
  It must stay pure — no `require`, `import`, `process`, `fs`, `path` — so the same
  text runs on DeepSeek Harness, Claude Code and ZCode.
- The verdict is computed from `exit_code` and `cases`, never from prose. Fail closed:
  if you must choose between swallowing a problem and returning `INCONCLUSIVE`,
  return `INCONCLUSIVE`.
- Subagent prompts are in English; docs may be any language, code comments English.
- Every factual claim in `README.md` must be recomputable by a command in this repository.
- Commit messages: imperative mood, explain *why*, one concern per commit. No generic "fix".
