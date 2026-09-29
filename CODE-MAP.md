---
doc-type: code-map
status: generated
updated: 2026-09-29
scanned-at-sha: 3d8e6ed4
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — rungate

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts .` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | 13 |
| Dependencies | 1 |
| Dev dependencies | 1 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | 149 |
| Unused files | 6 |
| Unused exports | 1 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| .claude/ | 6745 | DS_Store, json, agents, routines, worktrees |
| test/ | 169 | ts, unit, json, fixtures, fixtures/golden-project |
| evals/ | 76 | md, json, reads-agents-md, marcus-context-loading, marcus-tool-hygiene |
| docs/ | 40 | research, adr, DS_Store, council, session-log |
| scripts/ | 40 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| lib/ | 37 | ts, generators |
| gates/ | 33 | ts, gate-salt, toml, md, test-fixtures |
| specs/ | 30 | md, bootstrap-data-flow, json, png |
| prompts/ | 24 | md |
| hooks/ | 20 | ts, lib |
| templates/ | 8 | agent-briefs, md |
| config/ | 7 | json |
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
