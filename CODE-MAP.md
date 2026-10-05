---
doc-type: code-map
status: generated
updated: 2026-10-05
scanned-at-sha: 9ae1ab12
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — rungate

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts .` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | 13 |
| Dependencies | 2 |
| Dev dependencies | 1 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | 193 |
| Unused files | 6 |
| Unused exports | 1 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| .claude/ | 23698 | DS_Store, json, output-styles, agents, rungate |
| test/ | 201 | ts, unit, json, fixtures, fixtures/golden-project |
| evals/ | 151 | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, quinn-real-verification, marcus-no-cat |
| lib/ | 57 | ts, validators, generators, scaffold |
| scripts/ | 49 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| docs/ | 43 | research, adr, DS_Store, council, session-log |
| gates/ | 33 | ts, gate-salt, toml, md, test-fixtures |
| specs/ | 33 | md, bootstrap-data-flow, json, png |
| prompts/ | 24 | md |
| hooks/ | 23 | ts, lib |
| config/ | 8 | json, yaml |
| templates/ | 8 | agent-briefs, md |
| workflows/ | 6 | js |

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
