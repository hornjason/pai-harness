---
doc-type: reference
status: active
owner: jason
updated: 2026-09-20
---

# Coding Standards

- Use TypeScript strict mode for all source files
- Prefer composition over inheritance
- All public functions must have JSDoc comments
- Error handling: use Result types, never throw in library code
- Imports: group by external, internal, types — separated by blank lines
- Tests required before merging any PR
- No console.log in production code — use structured logger
- Keep functions under 30 lines — extract helpers
- All config from environment variables, never hardcoded
- Database queries in dedicated repository modules, never in route handlers
