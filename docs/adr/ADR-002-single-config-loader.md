---
doc-type: adr
status: proposed
created: 2026-10-11
updated: 2026-10-11
owner: jason
governs: rungate config resolution — mandatory single-loader policy, unresolved-config sentinel semantics, dev/test key normalisation, and the mechanical checks that prevent a sixth reader
---

# ADR-002: Single Config Loader and Unresolved-Config Semantics

**Status:** Proposed
**Deciders:** Serena Blackwood (architecture), Rayford (DA)
**Trigger:** Issue #307 — four config-shape defects that all fire on DailyBriefDashboard's first harness run
**Governing spec:** `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md` (D-1, D-2, SC-478)
**Builds on:** ADR-001 (not re-opened; D2's two-function contract is kept and extended)

---

## Context

### What ADR-001 decided, and what actually landed

ADR-001 proposed three things. Measured on `main` today, one landed:

| ADR-001 decision | State on 2026-10-11 |
|---|---|
| D2 — `loadRungateConfig` throws, `tryLoadRungateConfig` returns null | **Landed.** `lib/config-loader.ts:52` and `:70`. |
| D1 — `runConfigAccessValidation` conformity check, fails the suite | **Never built.** The symbol does not occur anywhere in `lib/`, `test/` or `.claude/rules/`. |
| PRINCIPLES update — `.claude/rules/config-access.md` | **Never created.** `.claude/rules/` holds eight files; this is not one. |

Adoption followed the same split. Exactly **two** production modules import the loader:

```
lib/conformity.ts:15   import { tryLoadRungateConfig } from "./config-loader";
lib/scanner.ts:13      import { loadRungateConfig } from "./config-loader";
```

Against that, the literal `rungate.json` occurs **89 times across 25 production files** (`lib/`, `gates/`, `scripts/`, `hooks/`, `generators/`, `workflows/`, excluding tests). ADR-001 counted ~24 sites and proposed the mechanism that would have held the line. The mechanism was never built, and the count roughly tripled.

**This is the single most important input to this decision.** ADR-001 was correct and had no effect, because the half that was enforcement was the half that did not ship. An ADR that restates the policy and omits the executable check would be the third iteration of the same mistake. The repo already has the vocabulary for this: *"SCs without tests are wishes"* (`CLAUDE.md`), and `.claude/rules/checks-must-be-able-to-fail.md` — *"A rule nothing executes is not a rule."*

### Two corrections to the measured state in the decision brief

Both were checked against source rather than inferred, and both change the argument.

**Correction 1 — `lib/scanner.ts` has already been migrated.** The brief records it as reading "only the legacy monolith" and returning null for directory-layout consumers. It does not; `scanner.ts:426` calls `loadRungateConfig`. But it wraps the call in:

```ts
try {
  return loadRungateConfig(root) as unknown as Record<string, any>;
} catch {
  return null;
}
```

This is worse than it appears, and it matters for D2. ADR-001's central corollary is *"a malformed config is never a missing config"* — the loader throws on corrupt JSON and on an incomplete directory specifically so callers can tell the two apart. This call site catches that throw and converts it back to `null`. **The one production caller of the strict loader discards the entire distinction the strict loader exists to provide.** Migrating a call site is not adoption if the catch block restores the old behaviour; four readers were counted as fixed and one of them re-broke itself.

**Correction 2 — `captureTestBaseline` does not return `0` on rungate.** The brief states it returns `0` on both projects for two different reasons, rungate's being that the monolith does not exist. The monolith does exist: `.claude/rungate.json`, 7,481 bytes, last written 2026-10-10, carrying `test.command = "bun test --parallel --no-isolate"`. `gates/gate-executor.ts:88-93` finds it and runs it. **On rungate, the function works.**

That is a worse finding than the brief's, not a lesser one, and it is the finding this ADR is really about. The function works *only* on the one repository that carries both config layouts simultaneously — the test-integrity defect ADR-001 named as D4 and sequenced as Step E, which was never executed. rungate is in a configuration its own scaffold cannot produce. So:

- On rungate: baseline captured, every self-run green, defect invisible.
- On DDB: `test` is absent (the key is `dev.testCmd`), `return 0` fires, and a fabricated clean baseline is handed to the gate.

A reader that is correct on the dogfood and fail-open on every consumer is indistinguishable from a correct reader until the first consumer run. DDB's first run *is* that run. This is SUCCESS.md claim 5 — *"every green suite and every mutation count in this file is evidence about one ceremony path out of three"* — reproduced in the config layer, where it has had no issue number.

### The duality is three-way, and the schema already decided it

The brief frames `dev.apiBase` vs `apiUrl` as two shapes. There are three, and they disagree in the type system.

`lib/rungate-schema.ts` is the only Zod contract for project config:

```ts
const DevSchema  = z.object({ start, apiBase, uiBase, preStart?, testCmd?, typeCheck?, note? });
const TestSchema = z.object({ start?, apiBase?, note? });     // :13-17 — no `command`, no `timeout`
```

`TestSchema` **does not define `command`.** `z.object` strips unknown keys rather than rejecting them, so parsing rungate's own config succeeds and silently empties the key. Measured, both configs run through `safeParseProjectHarness`:

| | before parse | after parse |
|---|---|---|
| rungate `test` | `{"command":"bun test --parallel --no-isolate","timeout":300000}` | `{}` |
| DDB `dev` | *(as authored)* | preserved in full |
| DDB `test` | absent | `undefined` |

So `gates/gate-executor.ts:142 loadAndValidateHarness` — the *validating* reader, the one that looks most trustworthy — returns a config whose `test.command` the schema deleted. `captureTestBaseline` only sees the command because it bypasses the schema and reads raw JSON at `:91`. **The validated path is strictly more lossy than the unvalidated one**, and nothing reports the loss, because stripping is what `z.object` does on success.

Meanwhile a third definition exists: `RungateConfig` in `lib/config-loader.ts:44` declares `test: { command: string; timeout: number }` as **required and non-optional** — directly contradicting `TestSchema`, which makes the whole object optional and the key nonexistent. Two TypeScript types for one file, neither aware of the other, and the loader's own interface would not typecheck against the schema's output.

The schema is the artefact that has an opinion, and its opinion is that `dev.*` is the consumer shape and `test.command` is not a key. That is also what the brief reports as the documented consumer shape, and what DDB authored. **The duality is already resolved in source; nothing reads the resolution.**

### `container` is undeclared, which is why the Phase C chain stalls

`ProjectHarnessSchema` has no `container` key. SUCCESS.md records this as *"a `container` config key that no schema defines, no generator emits, and DDB does not have"*, and #254's container path is now shippable. Any normalisation this ADR defines must declare `container`, or the fix for #254 keeps resting on a key that validation discards. Recorded here rather than solved; it is a consequence of the shape decision, not a separate one.

### How ship.js actually reaches TypeScript today

The hard constraint is real: `workflows/ship.js` runs in a Workflow sandbox with no module loading (#69). It cannot `import`. The brief asks how it can comply.

It already does, thirty times. `ship.js` reaches harness TypeScript by **spawning a subprocess**, which has an ordinary module loader:

```js
// ship.js:1640 — the exact precedent
bun -e "import {detectPriorBranch} from '${HARNESS_ROOT}/lib/prior-branch.ts'; ..."
// ship.js:4322
bun ${HARNESS_ROOT}/scripts/grade-deterministic.ts --transcripts "$TDIR" --project ${PROJECT_ROOT}
```

`detectPriorBranch` is a library function, consumed from ship.js, under the no-module-loading constraint. The constraint governs ship.js's *own process*, not the processes it starts. **This closes the question the brief treats as open:** ship.js is not exempt from the single-loader policy; it complies across a process boundary rather than an import.

And the thing it does instead today is the fail-open:

```js
// ship.js:1637 — inside the setup agent prompt
cat ${PROJECT_ROOT}/.claude/rungate.json 2>/dev/null || echo "{}"
```

Three defects in one line: it understands only the monolith; it suppresses stderr; and `|| echo "{}"` converts every failure — missing file, unreadable file, malformed JSON — into a valid-looking empty config. That value becomes `setupResult.config`, hence `projectConfig`, hence `pagesConfig`, hence `hasUI`.

**Follow that to the tier floor.** #215 landed `ceremonyTierFloor` at `ship.js:1706-1740`, and SUCCESS.md claim 5 identifies it as the remaining thing between the harness and a real DDB run. Its entire input is `hasUI`, derived from a config obtained by `cat`-ing the monolith. The floor is correct code sitting on a fail-open: if DDB ever migrates to the directory layout — which is what `CONFIG-DIRECTORY-STRUCTURE-SPEC.md` D-1 asks every consumer to do — `cat` returns `{}`, `hasUI` goes false, and the run silently drops to LIGHT, skipping the five subsystems the floor was built to guarantee. The guard against under-ceremony can be disabled by the consumer following the documented migration. That is this repo's signature defect shape — *a check whose input can silently shrink* — and it is currently load-bearing for claim 5.

The in-memory shim at `ship.js:1697-1700` (`dev.apiBase → apiUrl`) is real and correct, and it never reaches the agent at `:1885`, which is sent to read the file on disk. A normalisation applied to an object cannot serve a consumer that reads files. That asymmetry is the whole of question 3.

### The fundamental constraint

ADR-001 named it: N readers × M representations with no single resolver converges on N×M drift. One year of evidence refines it in a way that changes the remedy.

Drift was not the failure. **Defaulting was.** Every one of these readers resolves config correctly on *some* input; each one also encodes, locally and invisibly, what to do when it cannot. `return 0`. `|| echo "{}"`. `catch { return null }`. `write SKIP`. Those are five private answers to one question — *what does "I could not measure this" mean?* — and none of them is at the call site where a reviewer would look for it.

This is why the two halves of the decision are genuinely coupled, and why unifying the loader alone would be insufficient. A single loader with a nullable return gives every caller the same opportunity to default privately. The loader is where resolution belongs; the *shape of the unresolved value* is what determines whether a caller can default by accident.

---

## Decision

### D1 — `lib/config-loader.ts` is the sole config resolver; `workflows/*.js` complies across a subprocess boundary

No module outside `lib/config-loader.ts` may construct a path to `.claude/rungate.json` or `.claude/rungate/*`, and no agent prompt may instruct an agent to read those paths.

Two compliance routes, because there are two kinds of reader:

**TypeScript (`lib/`, `gates/`, `scripts/`, `hooks/`, `generators/`) — import.** Mandatory, no exemptions. The allowlist has exactly one entry: `lib/config-loader.ts`.

**`workflows/*.js` and every agent prompt — materialise, then read the materialised file.** ship.js's setup step invokes a thin CLI over the loader and writes the resolved config to the run's own work directory:

```
bun ${HARNESS_ROOT}/scripts/resolve-config.ts --project ${PROJECT_ROOT} --out ${WORK_DIR}/resolved-config.json
```

This uses the established subprocess pattern (`ship.js:1640`, `:4322`, and 28 other sites), so it introduces no new technology and does not violate #69. Every downstream agent prompt that currently says *"read `${PROJECT_ROOT}/.claude/rungate.json`"* says *"read `${WORK_DIR}/resolved-config.json`"* instead — 11 prompt sites across `ship.js`, `prove.js` and `ship-and-heal.js`.

Three properties make this strictly better than the `cat`, and they are the reason to prefer it over simply teaching the `cat` about both layouts:

- **It is layout-agnostic at the consumer.** DDB on the monolith and rungate on the directory produce byte-identical resolved files. Migration stops being able to change harness behaviour — which, per the tier-floor analysis above, it currently can.
- **It is normalised once.** The `dev.*` → flat mapping happens in the loader (D3), so the `ship.js:1697` in-memory shim and the agent prompt finally read the same value. Today they cannot.
- **It cannot fail open.** `resolve-config.ts` exits non-zero on unresolvable config and writes nothing. No `|| echo "{}"`. An absent `resolved-config.json` is a missing file the next reader must handle explicitly, not an empty object that reads as "configured with nothing".

The materialised file is a **run artefact, not a cache**. It is written once per run into `${WORK_DIR}`, never into the project tree, and never reused across runs.

### D2 — The loader returns a discriminated resolution; `UNMEASURED` is the propagated value, not a loader return

**Answering the brief's question directly: not `null`, not throw — a sentinel. But the sentinel does not go where the question places it.**

Two distinct things need distinct answers, and conflating them is why the question is hard.

**(a) At the loader — a discriminated union, with the existing two wrappers kept.**

```ts
type ConfigResolution =
  | { status: "resolved"; config: ResolvedConfig; source: "directory" | "monolith" }
  | { status: "absent" };          // no config anywhere — a legitimate state
  // malformed JSON / orphaned fragments: throws, per ADR-001 D2. Unchanged.

export function resolveConfig(projectRoot: string): ConfigResolution
```

`loadRungateConfig` (throws) and `tryLoadRungateConfig` (returns null) remain exactly as ADR-001 D2 specified and as `config-loader.ts:52` and `:70` implement them. They become thin wrappers over `resolveConfig`. **ADR-001 is not re-opened** — its two-function contract was right, and the caller-assignment table in its D2 stands. `resolveConfig` is added beneath them for the callers that need to *report* which case they hit rather than merely branch on it.

Why the union earns its place over the nullable that already exists: `null`, `0`, `{}`, `""` and `undefined` are all falsy, so every one of them is silently absorbed by `||` and `?.`. That is not a metaphor for the bug — it is the bug, verbatim, at four of the five sites:

```
gate-executor.ts:93    if (!testCmd) return 0;
ship.js:1637           || echo "{}"
scanner.ts:429         catch { return null }
steps.ts:63,:66,:70    catch {}
```

`{ status: "absent" }` is **truthy and has no `.test` property**. `resolution.test?.command || defaultValue` does not compile under `tsc` and does not silently work at runtime. A caller must destructure `status` to get at anything. That is the entire mechanical value of the choice: it converts a defaulting decision from something you can reach by typing `||` into something you must write a `switch` for, where a reviewer can see it.

**(b) At the caller — unresolved propagates as `UNMEASURED`, never as a measurement.**

This is the half that makes the fail-opens impossible rather than discouraged, and the loader cannot do it, because `captureTestBaseline`'s `return 0` is not a config bug. `0` is a *valid measurement* meaning "no pre-existing failures". No loader return value prevents a caller converting absence into a plausible number. Only the verdict type can.

So: **a function that reports a measurement must be able to report that it has none.**

```ts
type Baseline = { status: "measured"; failures: number } | { status: "unmeasured"; reason: string };
```

This repo has already made this exact change twice and recorded both, which is why it is a decision to copy rather than invent:

- **#227 (timing).** *"An agent with no record now reports `unmeasured`, never zero seconds, and the mutation returning `durationSeconds: 0` for the unmeasured branch turns four tests red."*
- **#224 (suite count).** *"A count with no SHA reads `UNMEASURED` rather than zero."*

Both are SUCCESS.md claim 4 — *"Could not measure" never reads as "nothing wrong"* — and the config layer is the same claim, unaddressed. `captureTestBaseline` returning `0` on DDB is `durationSeconds: 0` with a different variable name.

**What each layer actually buys, stated honestly.** The brief asks why this makes the fail-opens impossible rather than merely discouraged, and the truthful answer is that no single layer does it:

| Layer | Prevents | Does not prevent |
|---|---|---|
| Discriminated union | A TypeScript caller defaulting via `\|\|` or `?.` — it will not compile | A caller writing an explicit `case "absent": return 0` |
| `UNMEASURED` in the verdict type | An explicit default *reading downstream as a clean measurement* | The caller choosing a bad reason string |
| Mechanical checks (D4) | A sixth reader existing at all, in TS or in prompt text | Path construction via run-time string concatenation |

The union is compile-time and `ship.js` is JavaScript — which is precisely why D1 routes ship.js through a CLI that exits non-zero rather than through a type. Each layer covers the other's blind spot. Claiming the union alone closes this would be the kind of unfalsifiable guarantee this repo keeps catching.

### D3 — `dev.*` is the authored shape; the loader emits a normalised resolved shape; nothing is deprecated yet

The schema already decided this (see Context): `DevSchema` defines `apiBase`/`uiBase`/`testCmd`/`typeCheck`; `TestSchema` defines no `command`. DDB — the reference consumer — authored `dev.*`. rungate authored `test.command`, a key its own validator deletes.

**Decision: `dev.*` is canonical as the authored format. The loader normalises into a resolved shape carrying both, with `dev.*` winning.**

```
resolved.apiUrl       ← dev.apiBase
resolved.uiUrl        ← dev.uiBase
resolved.test.command ← dev.testCmd ?? test.command      // dev.* wins
resolved.test.timeout ← test.timeout ?? DEFAULT_TIMEOUT
resolved.container    ← container                         // declared, not stripped
resolved.pages, roles, hooks, compliance, project, repo, issueRepo, contextDocs
```

Three consequences follow, and all three are required for the normalisation to mean anything:

1. **`ResolvedConfig` becomes the single type, derived from the Zod schema** (`z.infer`), not hand-declared. The present contradiction — `RungateConfig.test.command` required at `config-loader.ts:44`, absent from `TestSchema` at `rungate-schema.ts:13` — is two hand-written types drifting, and hand-writing a third would continue it.
2. **`TestSchema` must gain `command` and `timeout`, and the schema must gain `container`.** Until it does, validation strips the keys normalisation just computed, and the validated path stays lossier than the raw one.
3. **`test.command` keeps being read, and is not deprecated in this ADR.** It is rungate's own live config, the thing `captureTestBaseline` currently succeeds on. Deprecating it in the same change that unifies the readers would mean rungate's dogfood and the consumer path both move at once, and neither could serve as a control for the other. Flagged as an open question for Jason rather than decided here.

The normalised value reaches an agent prompt by being **written to a file** — `${WORK_DIR}/resolved-config.json`, per D1. That is the whole answer to "how does a value reach an agent prompt, which reads files rather than objects": stop trying to hand the agent an object, and stop pointing it at the authored file. Point it at the resolved one.

### D4 — Two conformity checks, because there are two bypass routes

ADR-001 proposed one check and it was never built. This ADR proposes two, because the survey shows the single check it proposed would have caught only part of the problem: of the live sites, **11 are prompt text inside `workflows/*.js`**, which a TypeScript-source check does not look at. A check that would have let `ship.js:1637` through is not sufficient.

Both land in `lib/conformity.ts` beside `runDirectoryValidation`, `runModuleDepthCheck` and `runAgentFileValidation`, and both are registered in `test/scaffold-conformity.test.ts` beside the existing two calls at `:8-9`. Same idiom, same file, no new enforcement technology, and it travels into consumer projects with the scaffolded conformity suite — the property an ESLint rule would not have (ADR-001 A6, not re-litigated).

**CHECK-1 — `runConfigAccessValidation(root)`.** Scans `lib/`, `gates/`, `scripts/`, `hooks/`, `generators/`, excluding `*.test.ts` and `test/`, for construction of a path to `.claude/rungate.json` or `.claude/rungate/*`. Allowlist: `lib/config-loader.ts`. **Fails; does not warn** — `DEPTH-1` and `ABSENCE-1` only `console.warn`, and warnings are how 89 sites accumulated.

**CHECK-2 — `runPromptConfigAccessValidation(root)`.** Scans `workflows/*.js` for the literal `.claude/rungate.json` in any string, including inside template literals and agent prompt bodies. Allowlist: empty. This is the check that would have caught `ship.js:1637`, and it is the one ADR-001 did not have.

**Three traps these checks must avoid, all of them documented failures in this repo:**

- **Self-reference.** A check whose source contains the literal it searches for will match itself, and an allowlist naming the exempt files becomes evidence those files are referenced. `lib/conformity.ts` is in the scanned set. The literals must be assembled so the scanner's own source does not satisfy its own pattern, and the test must assert that the check reports zero violations *against its own file*. `.claude/rules/checks-must-be-able-to-fail.md` records this exact trap: *"an SC line that names its own tokens is not evidence for them."*
- **A detector narrower than what it detects.** Both checks are string matching, and neither catches `join(root, ".claude", dynamicName)`. **Accepted, and recorded as a stated limit rather than left implicit** — the same trade ADR-001 made. It catches every one of the 89 present sites; a variable-constructed path is not the realistic failure mode, and an AST check is not worth the dependency.
- **A ratchet nobody can interpret.** These checks ship red — 89 sites, 25 files. They must ship as a **known-violations ratchet with the count recorded in the spec**, decrementing as SC-A1/SC-A8 land, never incrementing. The ratchet refuses on any new file entering the violation set even while the count is above zero; otherwise the checks permit the sixth reader for the entire duration of the migration, which is when it is most likely to be written.

**The mutations that prove each check works.** Required by `.claude/rules/checks-must-be-able-to-fail.md`; the counts are to be measured on the branch and recorded in `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md` beside the new SCs, not predicted here.

| Mutation | Must turn red | Proves |
|---|---|---|
| Add `join(root, ".claude", "rungate.json")` to a clean file not on the ratchet | CHECK-1 | The sixth TypeScript reader is caught — the decision's whole purpose |
| Add `read ${PROJECT_ROOT}/.claude/rungate.json` to a prompt in `ship.js` | CHECK-2 | Prompt text is in scope; ADR-001's blind spot is closed |
| Short-circuit the violation collector to `return []` | both | The check is reached, not merely defined — the `if (false)` class (#188/#200) |
| Remove `lib/config-loader.ts` from the allowlist | CHECK-1 | The allowlist is consulted; a check green because it scans nothing fails here |
| Point the scanner at a directory that does not exist | both | The empty-input case refuses rather than reporting clean — claim 4 applied to the check itself |

The fourth and fifth matter most. A conformity check that silently scans zero files reports zero violations and is indistinguishable from compliance — which is this repo's defining defect, and it would be the most embarrassing possible place to reproduce it.

### D5 — SUCCESS.md claims this moves

Recorded as prose for the DA; `SUCCESS.md` is DA-owned (#296) and is not edited by this ADR.

- **Claim 4 — "Could not measure" never reads as "nothing wrong." Primary.** Five readers currently answer unresolvable config with `0`, `{}`, `null`, `null`, and `SKIP`. All five become `UNMEASURED` or a refusal. The row currently reads *"No for grades, yes for timing"*; config is a third instance of the same defect with no entry.
- **Claim 5 — works on another repo. Primary, and it is the trigger.** Every one of these fail-opens is latent on rungate and live on DDB, because rungate carries both layouts. The tier-floor dependency on `cat` (Context, above) is the sharpest case: #215 is cited in claim 5 as the last thing standing between the harness and a DDB run, and its input is a fail-open.
- **Claim 3 — a bad ship is stopped, not described. Secondary.** A fabricated clean test baseline is a verdict computed from a measurement that was never taken. `gate-executor.ts:88` currently supplies one.
- **Claim 1 — every gate can fail. Secondary, and only if D4 ships with its mutations re-run by hand.** Two new guards that have not been observed failing would add to the problem, not the evidence.

---

## Consequences

### Positive

- One resolution rule, one normalisation, one type. A sixth reader fails the suite instead of being discovered by a consumer.
- Consumers on either layout get identical harness behaviour. Migrating between layouts stops being able to change the ceremony tier.
- The `dev.*`/`apiUrl` shim and the agent prompt read the same value for the first time.
- `test.command` stops being silently stripped by the validator that is supposed to protect it.
- Unresolvable config becomes a distinct, testable outcome at five sites that currently fabricate a clean one.
- ADR-001's Step E (delete rungate's monolith) gains a measured justification it did not have: it is the reason `captureTestBaseline` passes here and fails on DDB.

### Negative / costs

- **89 sites across 25 files.** Substantially more than ADR-001's ~24. This cannot land as one change; the ratchet exists so it does not have to.
- `lib/conformity.ts` both hosts the checks and is among the files in violation (4 sites). It must be migrated while remaining the thing that validates the migration. Sequence it early and confirm the suite still runs — ADR-001 flagged this and it is still true.
- Sites that currently degrade silently will begin to refuse. Each migration is a deliberate `load` vs `tryLoad` vs `resolve` judgement, and a wrong one converts a quiet pass into a crash. That is the intended trade and it is a real cost on first landing.
- Changing `TestSchema` and adding `container` alters validation for any consumer config in the wild. Additive and optional, so low risk — but it is a schema change, not just a loader change.
- The resolved-config artefact adds a file to `${WORK_DIR}` and a failure mode of its own: absent because the resolver was never invoked. The resolver must therefore run in setup, before the first consumer, and its absence must refuse rather than default.

### Risks

| Risk | Mitigation |
|---|---|
| The ratchet is adopted and never decremented; 89 becomes permanent | Count recorded in the spec with the SC that lowers it; refuses on any *new* file even while above zero |
| The checks ship green because they scan nothing | Mutation 5 in D4 — a non-existent scan root must refuse, not report clean |
| `scanner.ts`-style `catch { return null }` reappears at migrated sites | CHECK-1 does not detect this. Call out explicitly in the Marcus brief; a bare catch around a config read is a review-blocking defect |
| ship.js agent ignores the prompt and reads the monolith anyway | Agent compliance is measured from transcripts, never self-reported (#194). CHECK-2 governs the prompt; the transcript governs the agent |
| The resolver CLI itself becomes a second loader | It must be ≤ a thin `resolveConfig` + `JSON.stringify` + write. Any logic in it is a violation of D1 by the module enforcing D1 |

---

## Alternatives Considered

**A1 — Widen each reader's key lookup in place (`test.command || dev.testCmd`).**
Rejected, as the brief had already ruled out. It is the enumeration treadmill: the fifth reader teaches us one key name and the sixth teaches us another. It also leaves `|| 0` in place at every site, which is the actual defect — the key name is the symptom.

**A2 — Normalise DDB's config to rungate's shape.**
Rejected, as the brief had already ruled out, and the schema evidence makes the rejection stronger than the brief stated. `dev.*` is not merely DDB's preference; it is what `DevSchema` declares and `TestSchema` omits. Normalising DDB toward `test.command` would move the reference consumer onto a key the validator deletes.

**A3 — Loader returns `null` for unresolved (status quo, extended to all readers).**
Rejected. `null` is falsy, so every caller can still default by typing `||`, and the five private answers to "what does unresolvable mean" survive unification intact. Unifying the readers without changing the shape of the unresolved value would produce a single loader and the same five fail-opens.

**A4 — Loader throws for all unresolved cases; no non-throwing variant.**
Rejected. `scanProject` and `organize` legitimately run against unscaffolded directories — ADR-001 A4 settled this and it is not re-opened. It also invites `try/catch` at every call site, and `scanner.ts:429` is the live proof of where that leads: the one caller of the throwing loader catches the throw and discards the distinction.

**A5 — Exempt `workflows/ship.js` from the policy, documenting the `cat` as a known limitation.**
Rejected, and this was the live option before the subprocess evidence. The sandbox cannot `import`, but it spawns `bun -e` with harness imports at 30 sites including `detectPriorBranch` at `:1640`. An exemption would be granted on a constraint the file demonstrably does not have, and it would leave 11 prompt sites — the half of the problem that reaches agents — permanently outside the policy.

**A6 — Teach the `cat` about both layouts (`cat .claude/rungate/config.json || cat .claude/rungate.json`).**
Rejected, and it is the tempting small fix. It does not merge `roles.json`/`hooks.json`/`compliance.json`, it does not normalise `dev.*`, it keeps `|| echo "{}"`, and it leaves a second resolution rule in shell that must be maintained in parallel with the TypeScript one. The repo has a worked example of exactly this cost: `ship.js`'s inlined copy of the suite-binding rule, which required a 28-row parity matrix over both copies to stop it drifting silently (#224). A second config resolver would need the same, and would not deserve it.

**A7 — ESLint rule instead of conformity checks.**
Rejected under ADR-001 A6; not re-litigated. It does not travel to consumer projects, which is where the guarantee has to hold.

**A8 — Do ADR-001 Step E first (delete rungate's monolith), then unify.**
Rejected as a *first* step, and ADR-001 already sequenced it last for the right reason: 89 readers currently depend on the monolith, including `lib/conformity.ts`, and deleting it takes the suite down. But the measurement in this ADR raises its priority sharply — Step E is the only thing that makes rungate's dogfood capable of reproducing a consumer defect, and `captureTestBaseline` is the proof. It belongs immediately after the gate readers migrate, not in an indefinite later phase. Raised as an open question for Jason.

---

## PRINCIPLES.md Update

**`PRINCIPLES.md` updated: N/A — the file does not exist in this repository.** Its absence is tracked as #272, alongside `ARCHITECTURE.md`, `MODEL.md` and `CONTEXT.md`.

**What it would require, were it to exist:**

> **Configuration has one resolver.** Every read of project configuration goes through `lib/config-loader.ts`. Processes that cannot import it invoke it across a subprocess boundary and read the materialised result; they do not re-implement resolution.
>
> **Unresolvable is a value, not an absence.** A component that cannot resolve its configuration reports that it could not, in a form a consumer must handle explicitly. It never substitutes a default that is indistinguishable from a successful measurement. `0`, `{}`, `null` and `SKIP` are all indistinguishable from success; `UNMEASURED` is not.
>
> **A policy without an executable check is a preference.** Any architectural rule stated here carries the name of the test that fails when it is violated, and the mutation that was run to prove that test can fail.

**Recommendation: do not create `PRINCIPLES.md`, and close #272 by a different route.**

This repeats ADR-001's recommendation, and the year since has turned it from a judgement into a measurement. rungate loads agent context through `CLAUDE.md` (which `@`-includes `AGENTS.md`) and `.claude/rules/*.md`. A root `PRINCIPLES.md` is in no load path, so it would be read by nothing — which is precisely the defect this ADR exists to correct, committed in the document describing the correction. ADR-001 made this argument, recommended two concrete files instead, and **neither was created**; `.claude/rules/config-access.md` does not exist today. A fourth unread document is not the remedy for three unread documents.

**Instead, three edits — the two ADR-001 specified and never got, plus one:**

1. **`/Users/jhorn/Projects/rungate/.claude/rules/config-access.md`** — ADR-001 drafted this in full. Adopt that draft, extended with: the subprocess rule for `workflows/*.js`; "never `catch {}` around a config read" promoted from prose to a named defect, with `scanner.ts:429` cited as the live instance; and the names of CHECK-1 and CHECK-2.
2. **One line in `AGENTS.md` under `## Rules`** — `- Config reads go through lib/config-loader.ts only — see .claude/rules/config-access.md`.
3. **`specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md`, new "Phase 3 — Adoption" section.** Allocate IDs with `bunx rungate create-sc`. Per ADR-001's own warning, these must assert **adoption and behaviour**, not existence — SC-478 and SC-479 are both satisfied by a loader nobody calls, which is how the repo arrived here. The ratchet count goes in this section, with the date measured.

#272 is better closed by recording where the load-bearing documents actually are than by adding one more that is not loaded.

---

## References

- Issue #307 — four config-shape defects batched for the DDB run; SC-A1 and SC-A8 depend on this ADR
- Issues #69 (no module loading in Workflow sandbox), #215 (ceremony tier floor), #254 (container path), #272 (missing architecture docs), #296 (DA-owned state files)
- `docs/adr/ADR-001-config-loader-unification.md` — D1 never built, D2 landed, D4/Step E outstanding
- `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md` — D-1, D-2, SC-478, SC-479
- `.claude/rules/checks-must-be-able-to-fail.md` — governs D4's mutation requirements
- `SUCCESS.md:139` — the standing table; claims 4 and 5 are what this moves
- `lib/config-loader.ts:52,:70` — the canonical loader and its non-throwing variant
- `lib/rungate-schema.ts:3-17` — `DevSchema` and `TestSchema`; `test.command` is undeclared and stripped
- `lib/scanner.ts:426-431` — migrated to the loader, then discards the malformed/missing distinction
- `lib/scaffold/steps.ts:47-71` — directory reader with three bare `catch {}`
- `gates/gate-executor.ts:88` — `captureTestBaseline`, works on rungate, `return 0` on DDB
- `gates/gate-executor.ts:142` — `loadAndValidateHarness`, strips `test.command` via the schema
- `workflows/ship.js:1637` — `cat … || echo "{}"`, the fail-open feeding the tier floor
- `workflows/ship.js:1640` — `detectPriorBranch` via `bun -e`, the subprocess precedent that makes D1 possible
- `workflows/ship.js:1697-1700` — the in-memory `dev.apiBase → apiUrl` shim that never reaches its consumer
- `workflows/ship.js:1706-1740` — `ceremonyTierFloor` (#215), whose input is the fail-open

---

# Architecture Brief — implementing #307 SC-A1 and SC-A8

For Marcus. This brief is the implementation contract for the two sub-issues that commit to routing through `loadRungateConfig`. Read D1, D2 and D4 above first; this says what to build, in what order, and what must be true before each step is done.

## Before anything: two corrections to the issue text

Both measured on `main` 2026-10-11. Build against these, not against the issue body.

1. **`lib/scanner.ts` is already migrated.** Do not migrate it again. It needs a *different* fix: delete the `try/catch` at `:427-431` that converts the loader's deliberate throw back into `null`.
2. **`captureTestBaseline` works on rungate.** It will pass every local test you run. Its failure is reachable only with a config that has no `test.command` — DDB's shape. **Any test you write for it must use a DDB-shaped fixture**, or it will be green for the same reason the defect survived a year.

## Sequence

Steps 1 and 2 are independent and may run in parallel. Step 3 depends on both. Step 4 depends on 3.

### Step 1 — `ResolvedConfig`, normalisation, and the schema (SC-A1, part 1)

`lib/rungate-schema.ts`
- `TestSchema`: add `command: z.string().optional()` and `timeout: z.number().optional()`. They are stripped today.
- `ProjectHarnessSchema`: add `container` as an optional object (`port`, `rebuildCommand`, `healthPath`, `hosts`) — the shape `ship.js:1660` already declares in its setup JSON schema. Undeclared today, so validation discards it and #254's path rests on a key the validator deletes.

`lib/config-loader.ts`
- Add `resolveConfig(projectRoot): ConfigResolution` per D2(a). `loadRungateConfig` and `tryLoadRungateConfig` become wrappers; **their signatures and semantics do not change** — ADR-001 D2 is not re-opened.
- Add the normalisation from D3. `dev.*` wins. `container` passes through.
- Replace the hand-written `RungateConfig` interface (`:37-48`) with a type derived from the schema. It currently declares `test.command` required while `TestSchema` omits it — two types for one file, disagreeing.

**Done when:** a DDB-shaped fixture (`dev.testCmd`, no `test`) and a rungate-shaped fixture (`test.command`, no `dev`) both resolve to the same normalised `test.command`. Assert on the resolved value, not on source text — SC-478 is the cautionary case.

### Step 2 — the two conformity checks, as a ratchet (SC-A8)

`lib/conformity.ts`, beside `runDirectoryValidation` (`:1893`). Register in `test/scaffold-conformity.test.ts` beside the existing calls at `:8-9`.

- `runConfigAccessValidation(root)` — CHECK-1, D4.
- `runPromptConfigAccessValidation(root)` — CHECK-2, D4. Do not skip this one; it covers 11 sites CHECK-1 cannot see.
- Ship as a known-violations ratchet. Measure the count on your branch — it is ~89 across 25 files, but measure rather than quote me. Record it in the Phase 3 spec section with the date.
- The ratchet **refuses on any new file entering the violation set** even while the count is above zero.
- Route every refusal through one exported violation-collector per check, so the mutation harness has a single site, per `.claude/rules/checks-must-be-able-to-fail.md`.

**Watch the self-reference trap.** `lib/conformity.ts` is inside the scanned set and will contain the literals it searches for. Assemble the patterns so the scanner's own source does not match them, and add a test asserting the check reports zero violations against its own file. An allowlist naming the exempt files becomes evidence those files are referenced.

**Done when:** all five mutations in D4's table have been run by hand on your branch, each count observed and recorded in the spec. Mutations 4 and 5 are not optional — they are what distinguish this check from one that scans nothing and reports clean.

### Step 3 — migrate the gate readers (SC-A1, part 2)

In this order. Each is a separate commit with the ratchet decremented in the same commit.

| Site | Change |
|---|---|
| `lib/scanner.ts:427-431` | Delete the `try/catch`. Use `resolveConfig` and branch on `status`. |
| `gates/gate-executor.ts:88` | `resolveConfig`; return `{status:"unmeasured", reason}` instead of `0`. Propagate into the gate verdict — copy #227's timing fix and #224's suite-count fix; both are worked examples of this exact change. |
| `gates/gate-executor.ts:142,:429,:972` | `resolveConfig`. `:429` and `:972` read `dev.apiBase` directly — take it from the normalised shape. |
| `gates/brief-assembler.ts:116`, `gates/ship-orchestrator.ts:233` | `loadRungateConfig` (throwing). A gate run without config is meaningless, not degraded — ADR-001 D2's caller table. |
| `lib/scaffold/steps.ts:47-71` | `resolveConfig`. Delete all three bare `catch {}` at `:63`, `:66`, `:70`. |

**No bare `catch` around any config read.** That is the defect `scanner.ts` demonstrates and the one CHECK-1 cannot detect for you.

**Done when:** `captureTestBaseline` on a DDB-shaped fixture produces `unmeasured` and the gate reports it as unmeasured — not `0`, and not `PASS`. The mutation that proves it: make the unmeasured branch return `{status:"measured", failures:0}` and watch the suite go red. Record the count.

### Step 4 — `resolve-config.ts` and the ship.js prompts (SC-A1, part 3)

`scripts/resolve-config.ts` — new. Thin: parse `--project` and `--out`, call `resolveConfig`, write JSON, exit non-zero with a message on `absent` or on a throw. **No resolution logic in this file.** Any logic here is a violation of D1 by the module enforcing D1.

`workflows/ship.js`
- `:1637` — replace `cat ${PROJECT_ROOT}/.claude/rungate.json 2>/dev/null || echo "{}"` with the `bun ${HARNESS_ROOT}/scripts/resolve-config.ts` invocation from D1. **Drop the `|| echo "{}"`.** Setup must fail when config cannot be resolved.
- `:1697-1700` — the in-memory shim becomes redundant once the resolver normalises. Remove it in the same commit, or it becomes a second normalisation rule.
- `:1189`, `:1370`, `:1885`, `:1886`, `:2394`, `:2397`, `:3809` — repoint to `${WORK_DIR}/resolved-config.json`.
- `workflows/prove.js:216,:286,:309,:408` and `workflows/ship-and-heal.js:68` — same repointing. These are in CHECK-2's scope and the ratchet will not reach zero without them.

**Done when:** CHECK-2 reports zero violations, and a run on a directory-layout fixture produces the same `hasUI` as the same config in monolith form. That second assertion is the one that matters — it is the tier-floor dependency from the Context section, and it is the difference between #215 being a guarantee and being a guarantee the consumer can switch off by following the migration guide.

## What would make this work wrong

- Migrating a call site and leaving a `catch` that restores the old behaviour. `scanner.ts` is the precedent; it was counted as migrated.
- A conformity check that passes because it scanned nothing. Mutation 5 exists for this.
- Writing the baseline test with a rungate-shaped fixture. It will be green and prove nothing.
- Quoting my ~89 rather than measuring it on your branch.

## Open questions — Jason decides, not Marcus

Do not block Steps 1–4 on these; none of them changes the work above.

1. **Deprecate `test.command`, or support both indefinitely?** D3 keeps reading it and deprecates nothing, because it is rungate's own live config and moving the dogfood and the consumer path in one change leaves neither as a control. A date needs setting eventually.
2. **ADR-001 Step E — delete rungate's `.claude/rungate.json` — now, or after #307?** Measurement (A8) raises its priority: it is the reason `captureTestBaseline` passes here and fails on DDB, and until it happens the dogfood cannot reproduce a consumer defect. It must come after Step 3, never before.
3. **ADR-001's status.** It reads `proposed` while D2 is implemented and D1 is not. Someone should mark it accepted-in-part, or D1 will be read as still under discussion rather than as overdue.
