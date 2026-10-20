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
lines you wrote outside it.

It was the only user-owned content in the tree that survived
regeneration until #655, which is a promise `specs/bootstrap-data-flow/`
makes and nothing kept until #568: one run on a consumer removed 37
constraint lines and reported `REGENERATED: AGENTS.md`, exit 0. Put
non-inferable project rules there — the ones an agent cannot read off the
code — and nowhere else in the file.

If a run cannot carry every one of those lines forward it **refuses the
write**, names the lines, and leaves your file untouched.

### An agent brief is section-owned too (#655)

A rule mined from THIS repository's compliance history — the output of the
hill-climb loop — is non-inferable by construction, and until #655 it had
nowhere in the project to live. Every brief surface was rebuilt from
harness-wide inputs on the next `bunx rungate scaffold .`:
`templates/agent-briefs/_shared.md` resolves under the harness's own
templates directory, so a project rule written there reaches every
consumer; `roles.json`'s `tiers.reinforcement` carries section NAMES, not
rule text; and the write itself was a bare `writeFileSync`.

So `.claude/agents/*.md` now works the way `AGENTS.md` does, through the
same merge in `lib/agents-md-sections.ts`:

- Add a `## Project Constraints` heading to a brief and everything under
  it, up to the next `##`, is yours. A re-scaffold carries it forward
  verbatim and rewrites the rest.
- The section is **opt-in**. No template emits it, because a generated
  section would collide with yours and the merge would refuse every run.
  A heading plus one line is a section; a heading alone is not.
- If a run cannot carry every one of those lines forward it **refuses the
  write**, names the lines, and leaves the brief untouched — the same
  refusal-rather-than-silent-loss property #568 gave AGENTS.md.
- A reinforcement the hill-climb applies goes there in preference to
  `## Efficiency Rules`, `## Testing Rules` or `## Never Do`, so what the
  loop writes is the content a re-scaffold preserves.

The `## Hard Constraints` spelling is AGENTS.md's and only AGENTS.md's. A
brief section is scoped to one role; using one heading for both would make
a rule written in the wrong file look like it was in the right one.

### The CI job's global-tool installs are generated, never hand-edited (#597)

The `npm install -g` step in `ci.yml`'s generated `test` job is written from
`ci.globalTools` in `.claude/rungate/config.json` — a package-name-to-exact-
version map — by `globalToolInstallStep` in `lib/scaffold/steps.ts`. That
config is the only position in the tree that names a version; the generator
carries no literal, and neither should you.

**To change, add or remove a pinned tool, edit the config and re-scaffold.**
A version typed straight into `ci.yml` is overwritten on the next run of the
generator without being reported, because the `test` job is harness-owned —
and in the meantime it is a second position naming a version, which is the
defect (#621, #622) rather than a shortcut around it.

Only an EXACT version is installed. A range, `latest` or any other dist-tag
is refused BY NAME in a comment in the generated file rather than installed
unpinned, because an unpinned install is the state #597 is about: three
Layer 1 compliance checks shell out to `agnix` and `npx @reporails/cli`, CI
installed neither, and an identical SHA re-ran red to green with no code
change. A project that declares no `ci.globalTools` gets no install step and
a comment saying so — absent is reported, not silently defaulted.

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

### Every workflow file is reported, owned or not (#722)

The table above is a list of files this generator **writes**. That is why a
workflow it did not write could not be added to it: the next scaffold would
either start generating the file or the row would describe behaviour the
code does not have, which is #208 exactly.

So ownership travels with the bytes instead. Each generated workflow carries
a `# generated-sha:` marker on its first line — a YAML comment, invisible
to anything that parses the file — and a re-scaffold reports **every** file
in `.github/workflows/`:

| Status | What it means |
|--------|---------------|
| generated-and-unchanged | rungate wrote it and nobody has touched it |
| generated-and-hand-edited | rungate wrote it and the bytes have moved; preserved, not rewritten |
| NOT-OWNED | no marker — rungate did not write this and does not manage it |

**A NOT-OWNED workflow is reported by name and otherwise left alone.** What
you do with it is yours; the harness only refuses to keep quiet about it.
Each name is printed individually, because "5 unowned workflows" is not
something anybody can act on.

The line also carries its own coverage — `read N/M file(s)` — and a
directory that could not be read reports `UNMEASURED` rather than an empty
list. A scan that read 2 of 7 files and a scan that read all 7 are otherwise
the same clean report, and no reader can tell them apart from the output.

This matters on a tree the harness was added to rather than one it created.
One consumer ran five `engine: copilot` workflows that cost money, failed on
quota and emailed its owner, and every scaffold run reported clean — not
because anything went wrong, but because nothing had ever looked.
