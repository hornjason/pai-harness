---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - "AGENTS.md"
  - ".github/workflows/ci.yml"
  - ".github/workflows/gates.yml"
  - ".claude/agents/**"
  - ".claude/rules/**"
  - "test/scaffold-conformity.test.ts"
  - "CODE-MAP.md"
generated-sha: 5c9c9cb87f5f036f
---

These files are managed by rungate. **Do not edit them directly.** What
"managed" means differs per file — the third column says which, because
#208 was a row that promised regeneration for a file the generator skipped
forever.

| File | Strategy | How to customize | What NOT to do |
|------|----------|-----------------|----------------|
| `AGENTS.md` | section-preserving | Everything but `## Hard Constraints` is generated from the scan and `.claude/rungate/`; put non-inferable project rules in that section and they carry forward | Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it |
| `.github/workflows/ci.yml` | job-preserving | Set `ci` fields in `.claude/rungate/config.json`; add your own jobs alongside the generated `test` job | Don't edit the generated `test` job |
| `.github/workflows/gates.yml` | job-preserving | Settings from `.claude/rungate/config.json`; add your own jobs alongside the generated `gates` job | Don't edit the generated `gates` job |
| `.github/workflows/ai-review.yml` | job-preserving | Set `ci.vertex` in `.claude/rungate/config.json` to authenticate on Vertex with Workload Identity Federation; add your own jobs alongside the generated `ai-review` job | Don't edit the generated `ai-review` job |
| `.claude/agents/*.md` | section-preserving | Everything but `## Project Constraints` is generated from `.claude/rungate/roles.json` and the templates; put rules mined from this repo's own history in that section and they carry forward | Don't hand-edit the generated sections — a re-scaffold rewrites them without reporting it |
| `.claude/rules/*.md` | provenance | Edit freely — a hand-edited rule is preserved and reported (#370) | Don't expect edits to survive if you also delete the `generated-sha` marker |
| `test/scaffold-conformity.test.ts` | regenerate | Runs automatically | Don't edit |
| `CODE-MAP.md` | regenerate | Auto-generated from code scan | Don't edit |
| `project-state.json` | create-only | DA-owned (#296) — seeded once, then yours | Don't expect re-scaffold to update it; an agent in a worktree must never write it |
| `PROJECT-STATE.md` | create-only | DA-owned (#296) — maintained by the DA; whether this project derives it from the state JSON is reported per project in .claude/rules/key-files.md | Don't edit directly; don't expect re-scaffold to update it |
| `SUCCESS.md` | create-only | Seeded as a template (#485) — fill in the claims; `bunx rungate create-success` re-seeds | Don't leave it as the seed; SUCCESS-1 refuses a template, and re-scaffold will not fill it in |

| Strategy | What re-scaffold does |
|----------|----------------------|
| regenerate | Rewrites it every run; reports CHANGED only when the bytes differ |
| provenance | Rewrites it unless you edited it, in which case it is preserved and reported (#370) |
| job-preserving | Owns named jobs inside a file you also write to; your jobs are carried forward |
| section-preserving | Rewrites the file every run except for named sections, which are carried forward verbatim |
| create-only | Seeds it once and never touches it again — the content is yours, not the harness's |

### AGENTS.md is section-owned (#568)

Everything in `AGENTS.md` is generated from the scan and your
`.claude/rungate/` config, with one exception: a `## Hard Constraints`
section is yours, and a re-scaffold carries it forward verbatim —
including the `<!-- BEGIN AUTO-EXTRACTED -->` block, and including any
lines you wrote outside it. Put non-inferable project rules there — the
ones an agent cannot read off the code — and nowhere else in the file.

If a run cannot carry every one of those lines forward it **refuses the
write**, names the lines, and leaves your file untouched.

### An agent brief is section-owned too (#655)

`.claude/agents/*.md` works the way `AGENTS.md` does, through the same merge
in `lib/agents-md-sections.ts`. Add a `## Project Constraints` heading to a
brief and everything under it, up to the next `##`, is yours: a re-scaffold
carries it forward verbatim and rewrites the rest, or **refuses the write**
and leaves the brief untouched. A reinforcement the hill-climb applies goes
there in preference to `## Efficiency Rules`, `## Testing Rules` or
`## Never Do`.

### The generated CI jobs are config-driven, never hand-edited (#216, #597)

rungate owns the `test` job in `ci.yml` and the `gates` job in `gates.yml` and
regenerates exactly those; jobs you add are yours and are carried forward.
The `npm install -g` step inside the generated `test` job comes from
`ci.globalTools` in `.claude/rungate/config.json`, an exact-version map that is
the only position in the tree naming a version. **To change a pinned tool,
edit the config and re-scaffold.** A range or dist-tag is refused by name
rather than installed unpinned.

### Every workflow file is reported, owned or not (#722)

A re-scaffold reports **every** file in `.github/workflows/`, not only the ones
it owns:

| Status | What it means |
|--------|---------------|
| generated-and-unchanged | rungate wrote it and nobody has touched it |
| generated-and-hand-edited | rungate wrote it and the bytes have moved; preserved, not rewritten |
| NOT-OWNED | no marker — rungate did not write this and does not manage it |

**A NOT-OWNED workflow is reported by name and otherwise left alone.** What
you do with it is yours; the harness only refuses to keep quiet about it. Each
name is printed individually, because "5 unowned workflows" is not something
anybody can act on.

---

The incidents behind each strategy above — the 37 constraint lines #568 lost,
the unpinned install that re-ran red to green on an identical SHA, the five
`engine: copilot` workflows a clean report never mentioned — are in
`reference/harness-managed-worked-instances.md`. They were moved there by #544
because this rule loads on every file under `.claude/agents/**` and
`.claude/rules/**`, and at 9,484 bytes it put the peak instruction surface
2,124 bytes over budget.
