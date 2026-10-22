---
doc-type: code-map
status: generated
updated: 2026-10-22
scanned-at-sha: 7b5d0e6c
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — rungate

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts .` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

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

| Directory | Files | Types |
|-----------|-------|-------|
| test/ | 668 | ts, unit, types, json, fixtures |
| lib/ | 210 | ts, validators, generators, scaffold |
| scripts/ | 92 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| evals/ | 86 | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, quinn-real-verification, marcus-no-cat |
| docs/ | 47 | research, adr, council, session-log, guides |
| gates/ | 38 | ts, toml, md, sha256, test-fixtures |
| .claude/ | 38 | json, output-styles, agents, rungate, routines |
| hooks/ | 35 | ts, lib, json |
| specs/ | 34 | md, bootstrap-data-flow, json |
| prompts/ | 24 | md |
| config/ | 9 | json, yaml |
| templates/ | 9 | agent-briefs, md |
| workflows/ | 6 | js |
| bin/ | 1 | ts |

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
