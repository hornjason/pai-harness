---
doc-type: code-map
status: generated
updated: 2026-09-20
scanned-at-sha: 6fed6860
generator: rungate/scripts/generate-code-map.ts
---

# Code Map — rungate

Auto-generated architecture snapshot. Re-run `bun generate-code-map.ts /Users/jhorn/Projects/rungate` to refresh.
Regenerate when src/ has commits since scanned-at-sha.

## Summary

| Metric | Count |
|--------|-------|
| Source directories | 11 |
| Dependencies | 1 |
| Dev dependencies | 1 |
| API routes | 0 |
| React components | 0 |
| Entry points (fallow) | 75 |
| Unused files | 4 |
| Unused exports | 2 |
| Circular dependencies | N/A |
| Module import mappings | 0 |
| Page-component mappings | 0 |

## Directory Structure

| Directory | Files | Types |
|-----------|-------|-------|
| test/ | 71 | ts, unit, json, fixtures, fixtures/golden-project |
| gates/ | 32 | ts, gate-salt, toml, md, test-fixtures |
| prompts/ | 24 | md |
| scripts/ | 21 | ts, sh, git-hooks, lib, git-hooks/pre-push |
| hooks/ | 15 | ts, lib |
| config/ | 11 | json, profiles, yaml |
| specs/ | 11 | md, json, png |
| .claude/ | 11 | DS_Store, agents, worktrees, json, md |
| workflows/ | 5 | js |
| lib/ | 5 | ts |
| docs/ | 1 | adr |

## Code Health (fallow)

### Unused Files (4)

- test/fixtures/golden-project/src/config.ts
- test/fixtures/golden-project/src/utils.ts
- test/fixtures/phase-1-5-project/src/config.ts
- test/fixtures/phase-1-5-project/src/utils.ts

## Package Scripts

- `test`
- `test:structure`
- `test:external-deps`
