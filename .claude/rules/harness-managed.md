---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - ".github/workflows/**"
  - ".claude/agents/**"
  - "CODE-MAP.md"
  - "test/scaffold-conformity.test.ts"
---

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| `.github/workflows/ci.yml` | Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job | Don't edit the generated `test` job |
| `.github/workflows/gates.yml` | Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job | Don't edit the generated `gates` job |
| `.claude/agents/*.md` | Settings from `.claude/rungate/roles.json` | Don't edit briefs |
| `test/scaffold-conformity.test.ts` | Runs automatically | Don't edit |
| `CODE-MAP.md` | Auto-generated from code scan | Don't edit |

### The workflow files are job-owned, not file-owned (#216)

rungate owns the `test` job in `ci.yml` and the `gates` job in
`gates.yml`, and regenerates exactly those. **Jobs you add are yours and are
carried forward verbatim on every re-scaffold** — re-scaffolding is how you
take an update, so it must not delete your pipeline.

Write added jobs as ordinary indented blocks under `jobs:`. If re-scaffold
cannot carry a job forward — a flow mapping (`jobs: {deploy: {...}}`), or a
file it cannot parse — it **refuses the write**, names the jobs at risk and
the line delta, and leaves your file untouched. Re-run with `--force` only
if you mean to discard them.
