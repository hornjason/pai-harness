---
doc-type: reference
status: active
owner: jason
updated: 2026-10-02
---

# rungate

## Project Identity

Ship harness — conformity tests, scaffold, and agent briefs for AI-first development
**Tech:** Bun, ESM
- **Repo:** https://github.com/hornjason/pai-harness

## Rules

- Verify before asserting — try it first, report what actually happened
- Never fake results or hide failures — if it fails, report it honestly
- Fix all test failures before reporting done — a green suite is the minimum bar
- Run full test suite (`bun test`) and show real output — no summaries, no skipped files
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work
- Read PROJECT-STATE.md first on session start — it's the session bridge

## Commands

| Action | Command |
|--------|---------|
| Test | `bun test` |
| Type check | `bunx tsc --noEmit` |
| Conformity | `bun test test/scaffold-conformity.test.ts` |
| Create spec | `bunx rungate create-spec "title"` |
| Create SC | `bunx rungate create-sc --pattern <name> --params '<json>'` |
| Convert spec | `bun scripts/convert-spec.ts <file> [--dry-run] [--title "..."] [--governs "..."]` |
| Re-scaffold | `bun ~/Projects/rungate/scripts/scaffold-project.ts .` |


## Workflow
- **Repo:** https://github.com/hornjason/pai-harness
- **Test:** `bun test`
