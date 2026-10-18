---
description: Every rungate config read goes through lib/config-loader.ts — both layouts, and a corrupt config is never a missing one
doc-type: reference
status: active
owner: jason
updated: 2026-10-14
---

## Config access — one loader

All rungate config reads go through `lib/config-loader.ts`. Never construct a
path to `.claude/rungate.json` or `.claude/rungate/*` anywhere else.

| You want | Call | On absent config |
|---|---|---|
| config, and you cannot run without it | `loadRungateConfig(root)` | throws |
| config, and running unscaffolded is normal | `tryLoadRungateConfig(root)` | `null` |
| to *report* which case you hit | `resolveConfig(root)` | `{ status: "absent" }` |
| just the roles / slug / remote hosts | `lib/config-readers.ts` | `{}` / `null` / `{}` |

All three throw on malformed JSON. **A corrupt config is never a missing
config** — that distinction is the whole point, and conflating them is how #70
stayed silent for a month.

`workflows/*.js` cannot import (#69). It complies across a subprocess
boundary: `scripts/resolve-config.ts` writes the resolved config into the
run's work directory and every prompt reads that file. Never `cat` the
project's config from a prompt.

## Never do

- **Never `catch {}` around a config read.** It converts corruption into
  absence. `lib/scanner.ts:427` is the live instance: it is the one production
  caller of the throwing loader and it catches the throw, so the site counted
  as migrated while behaving exactly as it did before.
- **Never read only `.claude/rungate.json`.** Both layouts are supported
  indefinitely — consumers in the wild are on both. A monolith-only read means
  a consumer who followed the documented migration silently gets nothing, and
  that has already switched off the ceremony tier control (#310), custom
  matchers (#212/#90), role grading, pre-flight checks and the
  task-completion conformity run (#214).
- **Never substitute a built-in default for absent config without recording
  that you did so.** Anti-pattern: *Silent Default Substitution*. A present
  config with empty contents must be loud. `0`, `{}`, `null` and `SKIP` are
  all indistinguishable from success; `UNMEASURED` is not.

## An absent credential is UNMEASURED, not a silent pass

*Silent Default Substitution* again, in the place it does the most damage: a
generated CI job that cannot authenticate. A tree with no credential has not
**passed** an AI review — it has not **had** one, and those are different
states. Only one of them is reportable, so say which.

The rule for `lib/scaffold/ai-review-step.ts` and anything shaped like it:

- **Resolve the mode inside `run:`, never in an `if:` expression.** `secrets`
  is not available in `if:` at all — `${{ secrets.X != '' }}` fails workflow
  validation — and `vars` is, which makes a `vars` condition the tempting fix
  and the worse one: a step skipped by `if:` reports **skipped**, and a
  skipped required check can be treated as satisfied. That is a green
  required check for a review that never ran.
- **Emit a warning annotation naming the state UNMEASURED.** Exiting zero
  with no output is the silent default. `GCP_SA_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are the credentials the
  step resolves a mode from, and the annotation names all three, because a
  warning that does not say what was missing is a warning nobody can act on.
- **Let the consumer decide whether UNMEASURED is fatal, and read the switch
  exactly.** `vars.RUNGATE_REQUIRE_AI_REVIEW` turns the refusal on when it is
  the string `true` and at no other value — not `TRUE`, not `1`, not a
  prefix. A loose reading of a variable that turns a gate on is a gate that
  turns itself on by accident, and the honest default for a tree that has
  never configured a credential is an annotation, not a red pipeline on the
  first scaffold.
- **Route the non-zero exit through one exported constant.** One site to
  mutate, so a test can prove the refusal is what the case observed. A later
  branch that inlines its own literal bypasses the mutation and the case goes
  green having witnessed nothing —
  `.claude/rules/checks-must-be-able-to-fail.md`.

## Enforced by

`runConfigAccessValidation` (CONFIG-1, TypeScript sources) and
`runPromptConfigAccessValidation` (CONFIG-2, workflow prompt text) in
`lib/conformity.ts`. They **fail** the suite; they do not warn — warnings are
how 61 sites accumulated with the policy written down twice.

Both are known-violations ratchets reading `.claude/config-access-ratchet.json`,
and they refuse in **both** directions: over its number fails, under its number
fails, and a file absent from the ratchet is allowed nothing. So a new reader
fails the suite even while the total is above zero, and clearing a file means
deleting its entry in the same commit.

Neither check can see a bare `catch` around a config read. That one is on you,
and on `test/config-access-adoption.test.ts`, which asserts malformed throws.

## Why this file exists

ADR-001 (2026-10-05) specified this rule and the check that enforces it. The
rule was never written and the check was never built, so six days later the
violation count had tripled. ADR-002 (2026-10-11) specified both again. The
check shipped in #309; this file shipped in #214, two ADRs after it was first
asked for.

That is the argument for writing it down somewhere that loads, rather than in
a document nobody reads: *a rule nothing executes is not a rule*, and a rule
in an ADR is a rule nothing executes.
