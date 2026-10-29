---
description: Every command the rungate CLI exposes in this project, generated from its command registry
generated-sha: 3591e8cd6565a628
---

## Command Routing

Generated from the CLI's own command registry, so it cannot list a subset.
Run one as `bun bin/rungate.ts <command>`.
`bun bin/rungate.ts --help` prints each command's own arguments.

| Command | What it does |
|---------|--------------|
| `scaffold` | Generate or refresh a project's agent files, rules and conformity suite |
| `create-spec` | Create a spec file with the required frontmatter |
| `create-success` | Seed SUCCESS.md — what this project is for, and the claims that prove it |
| `create-sc` | Generate a matchable success-criterion line from a registered pattern |
| `convert-spec` | Convert an existing document into a testable spec |
| `audit-specs` | Report which success criteria are matched, unmatched or uncovered |
| `audit-spec-evidence` | Refuse a ticked criterion that does not name what proved it |
| `plan-spec` | Derive a repository's milestones from a spec's Phase placement table |
| `sync-spec-tests` | Regenerate the conformity suite from the specs |
| `generate-code-map` | Regenerate CODE-MAP.md from the source tree |
| `extract-constraints` | Extract constraints from a project's docs into agent rules |
| `ai-review-findings` | Adjudicate an AI review's findings payload — exits non-zero on a blocking finding |
| `ai-review-threads` | Post an AI review's findings onto the pull request's diff as review threads |
| `record-ai-review-unmeasured` | Record WHICH kind of unmeasured each unmeasured AI-review round was |
