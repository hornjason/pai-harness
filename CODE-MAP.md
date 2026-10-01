---
doc-type: code-map
status: generated
updated: 2026-10-01
scanned-at-sha: e526f5dd
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — rungate

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts /Users/jhorn/Projects/rungate` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | 13 |
| Dependencies | 1 |
| Dev dependencies | 1 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | 170 |
| Unused files | 6 |
| Unused exports | 1 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| test/ | 186 | ts, unit, json, fixtures, fixtures/golden-project |
| evals/ | 142 | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, quinn-real-verification, marcus-no-cat |
| lib/ | 50 | ts, validators, generators, scaffold |
| docs/ | 43 | research, adr, DS_Store, council, session-log |
| scripts/ | 43 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| gates/ | 33 | ts, gate-salt, toml, md, test-fixtures |
| specs/ | 30 | md, bootstrap-data-flow, json, png |
| .claude/ | 26 | DS_Store, json, output-styles, agents, lock |
| prompts/ | 24 | md |
| hooks/ | 21 | ts, lib |
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
