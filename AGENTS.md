# AGENTS.md

Instructions for any agent working in this repository. Read this first; the checks
below are cheap and non-negotiable.

## Gate before every push (mandatory, zero agent calls)

```
node core/validate-all.js    # must print: ALL SUITES GREEN — 114 checks
node tests/smoke-e2e.js      # must print: e2e smoke: ALL GREEN
```

If either fails, stop and fix before anything else. Never push on a red gate, and
never weaken a check to make it pass.

## Push procedure — Windows git only

Git Credential Manager already holds a valid credential for github.com, so `push`
asks nothing. Run exactly:

```
git -C "C:\Users\soldi\Desktop\GitHub\FormalSwarm" status --short --branch
git -C "C:\Users\soldi\Desktop\GitHub\FormalSwarm" add -A
git -C "C:\Users\soldi\Desktop\GitHub\FormalSwarm" commit -m "<message>"
git -C "C:\Users\soldi\Desktop\GitHub\FormalSwarm" push
```

Never use WSL/Linux git on this repository: Windows git and WSL git do not share
configuration, and the push must stay the Windows one.

## Verify after the push

- `git status --short --branch` shows `## main...origin/main` with no `ahead`/`behind`.
- The CI badge reads `passing`:
  `https://github.com/fashionmascherine-svg/formalswarm/actions/workflows/ci.yml/badge.svg`
  (a fresh run can stay `unknown` for a minute; wait and re-check).

## Never commit

`.formalswarm/`, `agents/`, `node_modules/`, `*.tgz`.

## Commit message style

Imperative mood; explain the *why*; one concern per commit. No generic "fix".

## Project invariants (a check fails if you break most of these)

- One body for three runtimes: `core/debate.workflow.js` is pure (no `require`,
  `import`, `process`, `fs`, `path`) and is the single source of truth.
- The verdict is computed by code from `exit_code` and `cases`, never from prose;
  every unclear state fails closed toward `REVISE`/`INCONCLUSIVE`.
- No domain word and no machine path in any shipped file — the genericity suite
  fails if one ever returns.
- Subagent prompts are written in English.

## After changing any shipped file, refresh the installed plugin copy

ZCode runs the plugin from its cache, not from this checkout:

1. `npm pack` in the repository root.
2. Extract the tarball.
3. Copy the extracted content over
   `C:\Users\soldi\.zcode\cli\plugins\cache\formalswarm\formalswarm\<version>\`
   (the ZCode registry already points there — do not touch ZCode's own config).
4. Re-run the gate from the installed copy; it must print the same check count
   as the checkout.
