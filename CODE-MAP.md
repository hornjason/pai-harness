---
doc-type: code-map
status: generated
updated: 2026-10-06
scanned-at-sha: f74832fe
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
| Entry points (fallow) | 213 |
| Unused files | 6 |
| Unused exports | 2 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| .claude/ | 30894 | DS_Store, json, output-styles, agents, rungate |
| test/ | 223 | ts, unit, types, json, fixtures |
| evals/ | 151 | marcus-tdd-order, marcus-tdd-vs-speed, marcus-surgical, quinn-real-verification, marcus-no-cat |
| lib/ | 60 | ts, validators, generators, scaffold |
| scripts/ | 52 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| docs/ | 44 | research, adr, DS_Store, council, session-log |
| gates/ | 34 | ts, gate-salt, toml, md, sha256 |
| specs/ | 32 | md, bootstrap-data-flow, json |
| hooks/ | 24 | ts, lib |
| prompts/ | 24 | md |
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
