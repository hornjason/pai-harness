---
doc-type: adr
status: proposed
created: 2026-10-05
updated: 2026-10-05
owner: jason
governs: rungate config access — single-loader policy, null-vs-throw contract, degradation observability, dogfood layout integrity
---

# ADR-001: Config Loader Unification

**Status:** Proposed
**Deciders:** Serena Blackwood (architecture), Rayford (DA)
**Trigger:** Issue #70 — consumer project `agentgrit` generated all six agent briefs with no role configuration, silently
**Governing spec:** `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md`

---

## Context

### The problem is larger than three loaders

The brief for this decision described three competing loaders. The source says otherwise. A survey of
non-test production code (`lib/`, `gates/`, `scripts/`) found:

| Access pattern | Sites | Understands directory layout? |
|---|---|---|
| Direct `join(root, ".claude", "rungate.json")` | ~24 | No — legacy only |
| Direct `join(root, ".claude", "rungate", "config.json")` | 3 (all `lib/scaffold/steps.ts`) | Partially — config.json only |
| `loadComplianceConfig()` from `config-loader.ts` | 2 (`lib/organize.ts`, `lib/compliance-report.ts`) | Yes — compliance.json only |
| `loadRungateConfig()` from `config-loader.ts` | **0** | Yes — full merge |

Direct monolith readers include `gates/gate-executor.ts` (5 sites), `gates/brief-assembler.ts`,
`gates/ship-orchestrator.ts`, `lib/conformity.ts` (4 sites), `lib/scanner.ts` (2 sites),
`lib/create-sc.ts`, `scripts/parallel-ship.ts`, `scripts/create-brief.ts`,
`scripts/grade-deterministic.ts`. Every one of them returns null or empty for a consumer on the
directory layout.

### The canonical loader has no production callers

`lib/config-loader.ts:50 loadRungateConfig` is imported by exactly one file in the repository:
`test/compliance-report.test.ts`. It is, in production terms, dead code.

This is the central finding, and it explains how the system shipped in this state.
`CONFIG-DIRECTORY-STRUCTURE-SPEC.md` marks SC-478 and SC-479 complete:

> - [x] SC-478: lib/config-loader.ts contains [loadFromDirectory, loadRungateConfig, .claude/rungate]
> - [x] SC-479: lib/config-loader.ts contains [loadFromMonolith, rungate.json]

Both are **existence assertions over source text**. A loader that is written correctly and called by
nothing satisfies them perfectly. The spec verified that the solution was authored; it never verified
that it was adopted. Twenty-four callers kept reading the legacy path and every success criterion
stayed green.

### Root cause of #70 is adjacent to, not identical with, loader divergence

`scripts/scaffold-rungate-config.ts:97` writes, for every greenfield project:

```ts
writeFileSync(join(dirTarget, "roles.json"), JSON.stringify({}, null, 2) + "\n");
```

An empty object. The migration path is correct — `lib/scaffold/steps.ts:866 splitMonolithToDirectory`
destructures `roles` out of the monolith and preserves it. The greenfield path emits nothing.

agentgrit was greenfield. It received `roles.json = {}`. `buildAgentMeta` received an empty map,
`DEFAULT_AGENT_META` won every merge at `lib/scaffold/steps.ts:594-596`, and six briefs generated with
default role configuration. No error, no warning, no failed gate.

**Unifying the loaders does not fix #70.** A single perfect loader reading an empty `roles.json`
produces the identical outcome. This ADR must therefore decide two things, not one: where config is
read, and whether an empty-but-present config is allowed to look like success.

### Why rungate could not reproduce it

rungate carries a 7,418-byte `.claude/rungate.json` with six roles **and** a populated
`.claude/rungate/` directory with the same six roles. It is the only repository in a configuration its
own scaffold cannot produce. Every test that passes here passes against a config state no consumer
has ever been in. The dogfood is not a dogfood.

### Recurrence evidence

`lib/scaffold/steps.ts:589-591` carries a comment documenting a prior defect in this exact area:

> `buildAgentMeta` takes the whole harness config and reads `.roles` itself.
> Passing `harness?.roles` made it look for `roles.roles`, so every consumer's
> role config was silently dropped and `DEFAULT_AGENT_META` always won.

Same failure mode, same silent substitution, same invisibility. Second occurrence. One is a bug; two
is a structure.

### The fundamental constraint

Configuration here is a read-mostly value with two physical representations and N independent readers.
A system with N readers and M representations and no single resolver converges on N×M drift — not
because anyone is careless, but because every new reader must independently rediscover the full
resolution rule, and the cheapest correct-looking implementation is always the one that handles the
case in front of the author. Twenty-four readers each made a locally reasonable choice. The aggregate
is incoherent. This is not a defect of discipline and cannot be fixed by discipline.

---

## Decision

### D1 — `lib/config-loader.ts` is the sole config access point, enforced mechanically

No module outside `lib/config-loader.ts` may construct a path to `.claude/rungate.json` or
`.claude/rungate/*`. All configuration reads go through the loader module.

**Enforcement: a conformity check that fails the suite — not a lint rule, not convention.**

Add `runConfigAccessValidation(root)` to `lib/conformity.ts`, registered in
`test/scaffold-conformity.test.ts` alongside the existing structural checks. It scans production
source (`lib/`, `gates/`, `scripts/`, `hooks/`, excluding `*.test.ts` and `test/`) for the literals
`"rungate.json"` and `"rungate", "` and fails on any hit outside the allowlist
`["lib/config-loader.ts"]`.

Rationale for this mechanism over the alternatives:

- **Convention has already been tried and already failed.** Spec decisions D-1 and D-2 stated this
  policy in prose on 2026-10-02. The result was 24 violations. A rule nothing executes is not a rule.
  The repo's own standard — "SCs without tests are wishes" (`CLAUDE.md`) — applies to architectural
  rules with equal force.
- **The idiom already exists.** `runDirectoryValidation`, `runModuleDepthCheck`, and
  `runAgentFileValidation` are grep-the-source structural checks in `lib/conformity.ts`. This adds one
  more to a working pattern rather than introducing a second enforcement technology.
- **It travels.** The conformity suite is scaffolded into consumer projects. An ESLint rule configured
  in this repo protects this repo only. rungate's value is the guarantee it exports, so the
  enforcement must be exportable.
- **It is agent-agnostic.** No dependency on Claude Code, hooks, or any agent runtime. It runs under
  `bun test`.

The check **fails**; it does not warn. Several existing checks (`DEPTH-1`, `ABSENCE-1`) only
`console.warn`. Warnings are how 24 violations accumulate unnoticed.

### D2 — Two named functions, not a `strict` option

```ts
// Throws if no config exists. For callers that cannot function without it.
export function loadRungateConfig(projectRoot: string): RungateConfig

// Returns null if no config exists. For callers that legitimately run unscaffolded.
export function tryLoadRungateConfig(projectRoot: string): RungateConfig | null
```

Both perform identical resolution: directory layout first, legacy monolith fallback, full merge of
`roles.json` / `hooks.json` / `compliance.json`. They differ only in the absent-config outcome.

**Corollary — a malformed config is never a missing config.** Both functions throw on JSON parse
failure. `tryLoadRungateConfig` returns null only for *absence*. The current `catch {}` blocks at
`lib/scaffold/steps.ts:46`, `lib/scaffold/steps.ts:50`, and `lib/scanner.ts:422` convert a corrupt
config into a missing one. That behaviour must not be carried forward — distinguishing "not
configured" from "configured wrong" is the entire point, and conflating them is a direct contributor
to #70's silence.

Caller assignment:

| Caller class | Function | Why |
|---|---|---|
| `gates/*` (gate-executor, brief-assembler, ship-orchestrator) | `loadRungateConfig` | A gate run without config is meaningless, not degraded |
| `lib/scaffold/steps.ts` brief and AGENTS.md generation | `loadRungateConfig` | Generating briefs without role config is the #70 bug |
| `lib/scanner.ts:scanProject` | `tryLoadRungateConfig` | Must work on unscaffolded directories by design |
| `lib/organize.ts`, doc tooling | `tryLoadRungateConfig` | Legitimately runs pre-scaffold |
| `scripts/*` one-shot CLIs | `loadRungateConfig` | Fail loudly at the entry point |

Rationale against the alternatives:

- **Against `{ strict: boolean }`:** the contract becomes invisible at the call site and, worse, at
  the type level. `loadRungateConfig(root, { strict: false })` is typed `RungateConfig` but is `null`
  in fact, unless rescued by boolean-literal overloads — precisely the kind of cleverness the next
  maintainer gets wrong. Two names yield two return types, so TypeScript enforces the null check at
  every `try` call site. The compiler becomes the reviewer, and reviewer attention is the scarce
  resource this repo keeps running out of.
- **Against callers wrapping in try/catch:** exceptions as control flow for an expected, routine state
  (unscaffolded directory) imposes a cost at every call site and invites the bare `catch {}` that
  already caused this problem. It also re-decentralises the decision — each caller again decides what
  absence means, which is the disease rather than the cure.

### D3 — Silent null-tolerance is a defect, with a precise name

Yes, and it warrants an anti-pattern entry. But the defect must be named correctly, because the
obvious framing is wrong.

The defect is **not** null-tolerance. `scanProject` must work on unscaffolded directories; making it
throw would crash legitimate paths, as the brief correctly anticipated.

The defect is **unobservable degradation**. `lib/scanner.ts:573` returns `{}` when roles are absent and
`lib/scanner.ts:527` merges silently over defaults. Both produce output byte-indistinguishable from a
successful run. The absence is therefore untestable: every behavioural assertion passes, because the
default is itself valid output.

**Anti-pattern: Silent Default Substitution.** *A code path that substitutes a built-in default for
absent configuration without recording that it did so makes the absence untestable. The system cannot
tell a configured project from an unconfigured one, so no test, gate, or human review can either.*

Remediation — make degradation visible rather than fatal:

1. `ProjectScan` gains `configSource: "directory" | "monolith" | "none"`.
2. `ProjectScan` gains `rolesSource: "config" | "defaults"`.
3. Generators push a warning action when `rolesSource === "defaults"` while `configSource !== "none"` —
   a present config directory with zero roles is a defect, not a valid state.
4. A conformity check asserts generated briefs in a scaffolded project are not all-defaults.

Absence of config on an unscaffolded directory stays silent and valid. Presence of config with empty
contents becomes loud. That is the line, and it is the line #70 crossed undetected.

### D4 — rungate carrying both layouts is a test-integrity defect, remediated in a strict order

Yes. It is the reason this stayed invisible, and it is the highest-leverage item here. But the
remediation sequence is load-bearing, because the monolith is currently keeping 24 production call
sites alive.

Separate two things the constraint statement conflates:

- **The loader must support both layouts indefinitely.** Consumers in the wild are on both. The
  fallback is not negotiable and is not being removed.
- **The rungate repository must stop carrying both.** That is a dogfood decision, independent of the
  loader's capability.

Ordered remediation:

| Step | Action | Precondition |
|---|---|---|
| A | Golden fixture matrix: every config-reading path tested against `directory-only`, `monolith-only`, and `neither` fixtures | none — do this first |
| B | Loader unification per D1/D2; conformity check green | A |
| C | Fix `scripts/scaffold-rungate-config.ts:97` to emit populated default roles | independent of A/B; fixes #70 |
| D | Observability per D3 | B |
| E | Delete `.claude/rungate.json` from rungate; repo runs directory-only | B green — **not before** |

**Step E before step B breaks the 24 monolith readers immediately, including `lib/conformity.ts`
itself, which would take the test suite down with it.** Step A is cheap, reversible, and catches the
entire class without touching rungate's own `.claude/`. It goes first.

---

## Consequences

### Positive

- One resolution rule. A new reader cannot invent a twenty-fifth variant without failing the suite.
- Consumers on the directory layout get working gates, briefs, and scanning for the first time.
- Malformed config surfaces as an error rather than masquerading as absent config.
- The fixture matrix makes every future layout change testable in both directions.
- rungate ends in the state its own scaffold produces, so dogfooding becomes real evidence.

### Negative / costs

- ~24 call sites to migrate. Mechanical, but it touches `gates/`, `lib/`, and `scripts/` simultaneously
  — a wide blast radius for one change. Expect test churn.
- Callers currently tolerating a missing monolith silently will now throw. Each migrated site requires
  a deliberate `load` vs `tryLoad` judgement; a wrong call introduces a crash where there was a
  degraded pass. This is the intended trade, but it is a real cost on first landing.
- `lib/conformity.ts` reads config at 4 sites and must be migrated while remaining the thing that
  validates the migration. Sequence it early and verify the suite still runs.
- The conformity check is a string-literal grep. It will not catch a caller that builds the path by
  concatenation or variable. Accepted: it catches the realistic case, and a stricter AST check is not
  worth the dependency.

### Risks

| Risk | Mitigation |
|---|---|
| Migration lands, #70 still reproduces in consumers | Step C is a separate, independently verifiable fix. Do not close #70 on loader unification alone. |
| A `loadRungateConfig` choice crashes a path that legitimately ran unscaffolded | Fixture `neither` in the Step A matrix exercises exactly this before migration |
| Deleting the monolith too early | Step E gated on Step B green; stated explicitly in the sequence table |
| New SCs repeat the existence-assertion failure | New SCs must assert **adoption** (zero violating read-sites) not **existence** (file contains string). Called out below. |

---

## Alternatives Considered

**A1 — Repair `steps.ts:43` and `scanner.ts:419` independently.**
Rejected, and the brief had already ruled it out correctly. Two correct-but-separate implementations
is what produced this state. The survey makes it worse than the brief assumed: the real count is ~24,
so "repair both" would leave 22 untouched.

**A2 — `loadRungateConfig(root, { strict: boolean })`.**
Rejected under D2. Hides the contract at the call site and defeats compiler enforcement of the null
check. The failure mode of this codebase is unnoticed silent degradation; an option that makes a
nullable return look non-nullable feeds that failure mode directly.

**A3 — Callers wrap `loadRungateConfig` in try/catch.**
Rejected under D2. Re-decentralises the absence decision to every caller — the exact structure being
dismantled — and invites the bare `catch {}` already present at three sites.

**A4 — Make `scanPromptRouting` / `scanAgentMeta` throw on missing config.**
Rejected. Would crash legitimate scans of unscaffolded directories. D3 achieves the actual goal —
detectability — without the crash, by distinguishing absent config from empty config.

**A5 — Keep the monolith as the single canonical format; treat the directory as a view.**
Rejected. It inverts `CONFIG-DIRECTORY-STRUCTURE-SPEC.md` D-1, which is a settled decision with four
Phase 1 and Phase 2 SCs shipped behind it, and it would strand the self-describing compliance policy
(D-3) that depends on `compliance.json` being authoritative. Not re-litigated.

**A6 — ESLint `no-restricted-syntax` rule instead of a conformity check.**
Rejected under D1. Does not travel to consumer projects, adds a second enforcement technology, and
introduces a lint toolchain this repo does not currently depend on for structural rules.

**A7 — Do nothing; fix #70 at `scaffold-rungate-config.ts:97` only.**
Rejected, though it is the smallest change that closes the reported issue. It leaves 24 divergent
readers and the recurrence evidence at `steps.ts:589` predicts a third occurrence. The scaffold fix is
still required — it is Step C — but as part of the structural fix, not instead of it.

---

## PRINCIPLES.md Update

**Recommendation: do not create `PRINCIPLES.md`.**

rungate loads agent context through `CLAUDE.md` (which `@`-includes `AGENTS.md`) and `.claude/rules/*.md`.
A new root `PRINCIPLES.md` would be read by nothing — the same failure mode as a canonical loader with
zero callers, which is the defect this ADR exists to correct. Creating it would be an instance of the
problem.

**Instead, two edits:**

**1. New file — `/Users/jhorn/Projects/rungate/.claude/rules/config-access.md`**

Matches the six existing single-topic rule files. Content:

```markdown
## Config Access — Single Loader

All rungate config reads go through `lib/config-loader.ts`. Never construct a path to
`.claude/rungate.json` or `.claude/rungate/*` anywhere else.

- `loadRungateConfig(root)` — throws when no config exists. Use when the caller cannot function
  without config (gates, brief generation, scaffold role resolution, CLI entry points).
- `tryLoadRungateConfig(root)` — returns null when no config exists. Use only when the caller
  legitimately runs against unscaffolded directories (scanner, organize, doc tooling).

Both throw on malformed JSON. A corrupt config is never a missing config.

Enforced by `runConfigAccessValidation` in `test/scaffold-conformity.test.ts`. The check fails the
suite; it does not warn.

## Never Do

- Never `catch {}` around a config read — it converts corruption into absence.
- Never substitute a built-in default for absent config without recording that you did so
  (anti-pattern: Silent Default Substitution). A present config with empty contents must be loud.
```

**2. One line in `/Users/jhorn/Projects/rungate/AGENTS.md`, under `## Rules`**

```markdown
- Config reads go through lib/config-loader.ts only — see .claude/rules/config-access.md
```

**3. Spec update — `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md`, new "Phase 3 — Adoption" section**

Allocate IDs with `bunx rungate create-sc`. The SCs must assert **adoption**, not existence:

- Zero files outside `lib/config-loader.ts` contain the literal `"rungate.json"` (production source)
- Zero files outside `lib/config-loader.ts` contain the literal `"rungate", "config.json"`
- `lib/config-loader.ts` exports `tryLoadRungateConfig`
- `gates/gate-executor.ts` imports from `config-loader` and contains no direct `.claude` path join
- Scaffolding a greenfield project produces `roles.json` with ≥1 role (behavioural)
- Scaffolding a greenfield project produces briefs whose role metadata differs from `DEFAULT_AGENT_META` (behavioural)
- `ProjectScan` carries `configSource` and `rolesSource`

An existence SC of the form "file X contains string Y" is what let SC-478 and SC-479 pass against a
loader nobody called. Phase 3 must not repeat it.

---

## References

- Issue #70 — agentgrit briefs generated without role configuration
- `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md` — D-1, D-2, SC-478, SC-479
- `lib/config-loader.ts:50` — canonical loader, zero production callers
- `lib/scaffold/steps.ts:43` — directory-only loader, early-returns past the legacy fallback
- `lib/scaffold/steps.ts:589-591` — prior-occurrence comment
- `lib/scanner.ts:419` — monolith-only loader
- `lib/scanner.ts:573` — `if (!harness?.roles) return agentMeta` (silent default substitution)
- `scripts/scaffold-rungate-config.ts:97` — greenfield `roles.json = {}`, root cause of #70
- `lib/scaffold/steps.ts:866` — `splitMonolithToDirectory`, the migration path that does preserve roles
