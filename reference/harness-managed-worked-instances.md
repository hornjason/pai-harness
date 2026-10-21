---
description: Worked instances behind `.claude/rules/harness-managed.md` — the incidents behind each ownership strategy, moved out of the peak instruction surface (#544)
doc-type: reference
status: active
owner: jason
updated: 2026-10-21
---

# Harness-managed files — the worked instances

This is the record half of `.claude/rules/harness-managed.md`. The rule stays
in `.claude/rules/`, where an agent loads it on demand when it touches a
managed file. These instances live here, where they are read when somebody is
changing what the scaffold owns.

The move was #544 and nothing was rewritten: every section below is the text
that was in the rules file, at its original heading level, in its original
order.

## Why the move happened here and not in #1009

`harness-managed.md` carries `paths:`, so it loads on demand and #1009's
launch-surface measurement excluded it at `bytes: 0`. It was therefore the one
rule in the tree with no budget over it at all, and it had grown to 9,484
bytes — not coincidentally, the same way `checks-must-be-able-to-fail.md` grew
to 119,308 before anything measured it.

#544 extended the measurement from the launch surface to the peak: for every
file in the repository, the launch surface plus every scoped rule whose globs
match it. The first reading, on 2026-10-21:

```
  56,640  LAUNCH
   9,484  + .claude/rules/harness-managed.md  [.claude/agents/** .claude/rules/** …]
  66,124  PEAK on .claude/agents/aditi.md   (budget 64,000)
```

2,124 bytes over, and the whole overrun was in the rule nothing had ever
measured. Path-scoping was a budget escape hatch, and it had been used.

### AGENTS.md is section-owned (#568)

It was the only user-owned content in the tree that survived regeneration
until #655, which is a promise `specs/bootstrap-data-flow/` makes and nothing
kept until #568: one run on a consumer removed 37 constraint lines and
reported `REGENERATED: AGENTS.md`, exit 0.

### An agent brief is section-owned too (#655)

A rule mined from THIS repository's compliance history — the output of the
hill-climb loop — is non-inferable by construction, and until #655 it had
nowhere in the project to live. Every brief surface was rebuilt from
harness-wide inputs on the next `bunx rungate scaffold .`:
`templates/agent-briefs/_shared.md` resolves under the harness's own templates
directory, so a project rule written there reaches every consumer;
`roles.json`'s `tiers.reinforcement` carries section NAMES, not rule text; and
the write itself was a bare `writeFileSync`.

The section is **opt-in**. No template emits it, because a generated section
would collide with yours and the merge would refuse every run. A heading plus
one line is a section; a heading alone is not.

The `## Hard Constraints` spelling is AGENTS.md's and only AGENTS.md's. A
brief section is scoped to one role; using one heading for both would make a
rule written in the wrong file look like it was in the right one.

### The CI job's global-tool installs are generated, never hand-edited (#597)

The `npm install -g` step in `ci.yml`'s generated `test` job is written from
`ci.globalTools` in `.claude/rungate/config.json` — a package-name-to-exact-
version map — by `globalToolInstallStep` in `lib/scaffold/steps.ts`. That
config is the only position in the tree that names a version; the generator
carries no literal, and neither should you.

A version typed straight into `ci.yml` is overwritten on the next run of the
generator without being reported, because the `test` job is harness-owned —
and in the meantime it is a second position naming a version, which is the
defect (#621, #622) rather than a shortcut around it.

Only an EXACT version is installed. A range, `latest` or any other dist-tag is
refused BY NAME in a comment in the generated file rather than installed
unpinned, because an unpinned install is the state #597 is about: three Layer 1
compliance checks shell out to `agnix` and `npx @reporails/cli`, CI installed
neither, and an identical SHA re-ran red to green with no code change. A
project that declares no `ci.globalTools` gets no install step and a comment
saying so — absent is reported, not silently defaulted.

### The workflow files are job-owned, not file-owned (#216)

rungate owns the `test` job in `ci.yml` and the `gates` job in `gates.yml`, and
regenerates exactly those. Jobs you add are yours and are carried forward
verbatim on every re-scaffold — re-scaffolding is how you take an update, so it
must not delete your pipeline.

Write added jobs as ordinary indented blocks under `jobs:`. If re-scaffold
cannot carry a job forward — a flow mapping (`jobs: {deploy: {...}}`), or a
file it cannot parse — it refuses the write, names the jobs at risk and the
line delta, and leaves your file untouched.

### Every workflow file is reported, owned or not (#722)

The ownership table in the rule is a list of files the generator **writes**.
That is why a workflow it did not write could not be added to it: the next
scaffold would either start generating the file or the row would describe
behaviour the code does not have, which is #208 exactly.

So ownership travels with the bytes instead. Each generated workflow carries a
`# generated-sha:` marker on its first line — a YAML comment, invisible to
anything that parses the file.

The report line also carries its own coverage — `read N/M file(s)` — and a
directory that could not be read reports `UNMEASURED` rather than an empty
list. A scan that read 2 of 7 files and a scan that read all 7 are otherwise
the same clean report, and no reader can tell them apart from the output.

This matters on a tree the harness was added to rather than one it created.
One consumer ran five `engine: copilot` workflows that cost money, failed on
quota and emailed its owner, and every scaffold run reported clean — not
because anything went wrong, but because nothing had ever looked.
