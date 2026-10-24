---
doc-type: code-map
status: generated
updated: 2026-10-24
scanned-at-sha: 960f26d1
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
| .claude/ | json, md |
| bin/ | ts |
| config/ | json, yaml |
| docs/ | md |
| evals/ | json, md, sh, ts, yaml |
| gates/ | json, md, sha256, toml, ts |
| hooks/ | json, ts |
| lib/ | ts |
| prompts/ | md |
| scripts/ | sh, ts |
| specs/ | json, md |
| templates/ | md |
| test/ | example, json, jsonl, md, ts |
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
