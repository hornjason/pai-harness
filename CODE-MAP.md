---
doc-type: code-map
status: generated
updated: 2026-10-13
scanned-at-sha: 842885b8
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
| Dev dependencies | 1 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | 346 |
| Unused files | 6 |
| Unused exports | 29 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| .claude/ | 118357 | DS_Store, json, output-styles, agents, rungate |
| test/ | 345 | ts, unit, types, json, fixtures |
| evals/ | 151 | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, quinn-real-verification, marcus-no-cat |
| lib/ | 89 | ts, validators, generators, scaffold |
| scripts/ | 64 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| docs/ | 45 | research, adr, DS_Store, council, session-log |
| gates/ | 37 | ts, gate-salt, toml, md, sha256 |
| specs/ | 32 | md, bootstrap-data-flow, json |
| hooks/ | 25 | ts, lib |
| prompts/ | 24 | md |
| config/ | 9 | json, yaml |
| templates/ | 8 | agent-briefs, md |
| workflows/ | 6 | js |
| bin/ | 1 | ts |

## Code Health (fallow)

### Unused Files (6)

- test/fixtures/golden-project/src/config.ts
- test/fixtures/golden-project/src/db.ts
- test/fixtures/golden-project/src/utils/format.ts
- test/fixtures/golden-project/src/utils.ts
- test/fixtures/phase-1-5-project/src/config.ts
- test/fixtures/phase-1-5-project/src/utils.ts

## Package Scripts

- `test`
- `posttest`
- `sync-scs`
- `test:structure`
- `test:external-deps`
