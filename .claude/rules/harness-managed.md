---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - ".github/workflows/**"
  - ".claude/agents/**"
  - "CODE-MAP.md"
  - "test/scaffold-conformity.test.ts"
---

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

The workflow files are the one exception, and only partly (#216): re-scaffold
regenerates **the jobs rungate wrote** and carries over jobs and top-level keys
it did not. Add your own job and it survives. Edit a job rungate owns and the
next re-scaffold **refuses** rather than overwriting it — it names the job and
the line delta, and `--force` is the only thing that overrides it.

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| `.github/workflows/ci.yml` | Set `ci` fields in `.claude/rungate/config.json`; add your own jobs freely | Don't edit the `test` job — re-scaffold refuses until you move it out |
| `.github/workflows/gates.yml` | Settings from `.claude/rungate/config.json`; add your own jobs freely | Don't edit the `gates` job — re-scaffold refuses until you move it out |
| `.claude/agents/*.md` | Settings from `.claude/rungate/roles.json` | Don't edit briefs |
| `test/scaffold-conformity.test.ts` | Runs automatically | Don't edit |
| `CODE-MAP.md` | Auto-generated from code scan | Don't edit |
