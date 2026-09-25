---
doc-type: code-map
status: generated
updated: 2026-09-25
scanned-at-sha: 4702c8be
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
| Entry points (fallow) | 128 |
| Unused files | 6 |
| Unused exports | 1 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| .claude/ | 1058 | DS_Store, json, agents, worktrees, md |
| test/ | 150 | ts, unit, json, fixtures, fixtures/golden-project |
| evals/ | 76 | md, json, reads-agents-md, marcus-context-loading, marcus-tool-hygiene |
| scripts/ | 39 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| docs/ | 34 | research, adr, DS_Store, council, guides |
| gates/ | 32 | ts, gate-salt, toml, md, test-fixtures |
| specs/ | 30 | md, bootstrap-data-flow, json, png |
| prompts/ | 24 | md |
| lib/ | 22 | ts |
| hooks/ | 19 | ts, lib |
| templates/ | 8 | agent-briefs, md |
| config/ | 6 | json |
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
