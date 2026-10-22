---
doc-type: code-map
status: generated
updated: 2026-10-22
scanned-at-sha: f3b83563
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — rungate

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts .` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

**What this guarantees:** the sections below describe the tree at `scanned-at-sha`.
**What it does not:** that `scanned-at-sha` is the commit you are reading this on. The scan
runs on a branch tip and the squash merge lands it on a `main` that has already moved, so this
file is at best one merge behind and no drift gate can close that (#1163). Per-directory file
counts were removed for the same reason — 22 of 50 consecutive commits moved one. Treat every
row as orientation, not as a fact about your working tree.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | 14 |
| Dependencies | 3 |
| Dev dependencies | 2 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | UNMEASURED |
| Unused files | UNMEASURED |
| Unused exports | UNMEASURED |
| Circular dependencies | UNMEASURED |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Types |
|-----------|-------|
| .claude/ | json, output-styles, agents, rungate, routines |
| bin/ | ts |
| config/ | json, yaml |
| docs/ | research, adr, council, session-log, guides |
| evals/ | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, quinn-real-verification, marcus-no-cat |
| gates/ | ts, toml, md, sha256, test-fixtures |
| hooks/ | ts, lib, json |
| lib/ | ts, validators, generators, scaffold |
| prompts/ | md |
| scripts/ | ts, sh, git-hooks, lib, git-hooks/pre-push |
| specs/ | md, bootstrap-data-flow, json |
| templates/ | agent-briefs, md |
| test/ | ts, unit, types, json, fixtures |
| workflows/ | js |

## Code Health (fallow)

**UNMEASURED** — fallow is not installed (it is an optional tool, not a declared dependency) — no static analysis was run, and no registry fetch was attempted.

## Package Scripts

- `test`
- `posttest`
- `sync-scs`
- `typecheck`
- `verify-merge`
- `test:structure`
- `test:external-deps`
