---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - ".github/workflows/ci.yml"
  - ".github/workflows/gates.yml"
  - ".claude/agents/**"
  - ".claude/rules/**"
  - "test/scaffold-conformity.test.ts"
  - "CODE-MAP.md"
generated-sha: d9cf6fc767464109
---

These files are managed by rungate. **Do not edit them directly.** What
"managed" means differs per file — the third column says which, because
#208 was a row that promised regeneration for a file the generator skipped
forever.

| File | Strategy | How to customize | What NOT to do |
|------|----------|-----------------|----------------|
| `.github/workflows/ci.yml` | job-preserving | Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job | Don't edit the generated `test` job |
| `.github/workflows/gates.yml` | job-preserving | Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job | Don't edit the generated `gates` job |
| `.claude/agents/*.md` | regenerate | Settings from `.claude/rungate/roles.json` | Don't edit briefs |
| `.claude/rules/*.md` | provenance | Edit freely — a hand-edited rule is preserved and reported (#370) | Don't expect edits to survive if you also delete the `generated-sha` marker |
| `test/scaffold-conformity.test.ts` | regenerate | Runs automatically | Don't edit |
| `CODE-MAP.md` | regenerate | Auto-generated from code scan | Don't edit |
| `project-state.json` | create-only | DA-owned (#296) — seeded once, then yours | Don't expect re-scaffold to update it; an agent in a worktree must never write it |
| `PROJECT-STATE.md` | create-only | DA-owned (#296) — generated from project-state.json by the DA | Don't edit directly; don't expect re-scaffold to update it |

| Strategy | What re-scaffold does |
|----------|----------------------|
| regenerate | Rewrites it every run; reports CHANGED only when the bytes differ |
| provenance | Rewrites it unless you edited it, in which case it is preserved and reported (#370) |
| job-preserving | Owns named jobs inside a file you also write to; your jobs are carried forward |
| create-only | Seeds it once and never touches it again — the content is yours, not the harness's |

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
