# Phase 1.5 Fixture Project

<!-- HARD-CONSTRAINTS-START -->
- All code must use TypeScript strict mode
- Tests required before merging
- No secrets in source control
<!-- HARD-CONSTRAINTS-END -->

## Specs

| Spec | Governs | Testable |
|------|---------|----------|
| specs/example-spec.md | Core utility functions | yes |

## Environment

| Variable | Purpose |
|----------|---------|
| PORT | Server listen port |
| DATABASE_URL | Database connection string |
| DEBUG | Enable debug logging |

## Commands

| Task | Command |
|------|---------|
| Run tests | `bun test` |
| Type check | `bunx tsc --noEmit` |
