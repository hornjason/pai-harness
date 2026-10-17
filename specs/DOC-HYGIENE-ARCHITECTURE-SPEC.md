---
doc-type: spec
status: draft
owner: jason
created: 2026-10-02
updated: 2026-10-02
governs: Doc-hygiene architecture — spec discovery via governs-field, mechanical drift detection, signal-based enforcement
testable: true
compliance: strict
---

# Doc Hygiene Architecture

## Context

Doc-hygiene currently stamps frontmatter (HYGIENE-1 through HYGIENE-10 in `lib/conformity.ts`) but does NOT verify specs match implementation or detect spec drift. `Skill("doc-hygiene")` is referenced at two mandatory positions in HARNESS-STANDARD.md (ITERATION line 326, FEEDBACK line 444) and required by close-gate (HARNESS-GATES.md:110), but no skill implementation exists. Every ship cycle has been non-compliant.

Council session (2026-10-02) produced 12 decisions across 3 rounds with architect, engineer, and security members. This spec codifies those decisions.

## Design Decisions (from Council)

| # | Decision | Rationale |
|---|----------|-----------|
| DEC-001 | Fix logSignal() silent-drop bug at lib/gate-enforcement.ts:221 | existsSync guard silently discards signals when file doesn't exist. appendFileSync creates the file if absent |
| DEC-002 | governs-field in spec frontmatter is the primary discovery mechanism | Persistent read-time source. Not workflow-state.json (session-scoped write-time data) |
| DEC-003 | lib/spec-registry.ts as shared module from day one | Three consumers already parse governs-field independently — centralize the contract |
| DEC-004 | lib/doc-hygiene.ts for content-alignment, extract drift-detection at 300 lines | One module until complexity demands extraction |
| DEC-005 | New checks start as WARN per Decision #9 (spec-policies.json) | Promote to FAIL only after >80% precision over 10+ cycles |
| DEC-006 | No LLM-based semantic comparison (Layer 3) | Layers 0-2 are deterministic, fast, tamper-resistant. Unanimous rejection |
| DEC-007 | Route doc-hygiene signal through GateEnforcement.hook.ts | Pragmatic — close-gate infrastructure doesn't exist yet |
| DEC-008 | Minimal rungate.json config: specDirs only (default ['specs']) | Extend only when second consumer proves the need |
| DEC-009 | #299 spec-alignment is SUBSET of doc-hygiene | Same detection engine, different enforcement boundaries |
| DEC-010 | Skill('doc-hygiene') as thin facade with 5-second fast-exit | git diff since last signal — skip if no governed files changed |
| DEC-011 | Replace manual SPEC_HASHES with auto-generated drift-hashes.json | Deferred to Phase 1 |
| DEC-012 | WARN-to-FAIL promotion must be mechanical | Log findings to signals.jsonl, compliance report surfaces candidates |

## Detection Layers

| Layer | What | Speed | How |
|-------|------|-------|-----|
| L0 | Dead-reference lint | Sub-second | governs: targets resolve to real files |
| L1 | Term/decision-ID extraction | Seconds | D-NNN IDs in ACs exist in governing spec |
| L2 | Hash-based change tracking | Seconds | drift-hashes.json manifest, updated via CLI |
| L3 | LLM semantic comparison | N/A | **Rejected** — non-deterministic, costly, injection surface |

## Success Criteria

### Phase 0 — Enforcement infrastructure (#24)

- [x] SC-504: lib/gate-enforcement.ts must NOT contain [existsSync(signalsFile)]
- [x] SC-505: lib/spec-registry.ts contains [getGoverningSpecs, getGovernedFiles, getUngoverned]
- [x] SC-506: lib/spec-registry.ts contains [governs, frontmatter, specs/, invertedIndex]
- [x] SC-507: test/spec-registry.test.ts contains [getGoverningSpecs, getGovernedFiles, getUngoverned, mock]
- [x] SC-508: hooks/GateEnforcement.hook.ts contains [doc-hygiene, signals, signal]
- [x] SC-509: lib/doc-hygiene.ts contains [runContentAlignment, checkDocHygiene]

### Phase 1 — Content alignment checks (follow-up)

- [x] SC-510: lib/doc-hygiene.ts contains [CONTENT-1, governs, resolve, existsSync]
- [x] SC-511: lib/doc-hygiene.ts contains [CONTENT-2, hash, drift, manifest]
- [x] SC-512: .claude/rungate/compliance.json contains [docHygiene, specDirs]
- [x] SC-513: test/doc-hygiene.test.ts contains [CONTENT-1, CONTENT-2, WARN, governs]

### Phase 2 — Integration + promotion tracking (follow-up)

- [x] SC-514: lib/doc-hygiene.ts contains [git, diff, changed, skip]
- [x] SC-515: lib/compliance-report.ts contains [promotion, precision, WARN, FAIL, 80]

### Phase 3 — A stamp adds, it never replaces (#299)

`DocHygiene.hook.ts` rebuilt every `.md`'s frontmatter from its four required
keys and discarded the rest:

```ts
const fmLines = REQUIRED.map(k => `${k}: ${stamped[k]}`).join('\n');
newContent = content.replace(FRONTMATTER_RE, `---\n${fmLines}\n---`);
```

Editing `.claude/rules/key-files.md` dropped its `description:` — the field
Claude Code's rule loading surfaces a rule by — and all eight rules files
carried it. The damage was one file per edit, only to files somebody had
touched, and nothing went red: **a rules file that has stopped being surfaced
to agents is indistinguishable from one that is surfaced and ignored.**

Underneath it, a second failure. The parser was `line.split(":")`, which
cannot represent a YAML block value, so `harness-managed.md`'s `paths:` list —
the list declaring which files the scaffold owns — would have been flattened
even by a merge written over that parser's output.

Three rules now hold, and the third is the one that keeps the other two:

1. **Add, never replace.** A key already present keeps the value somebody gave
   it, block values included. New keys are appended after everything existing,
   so a diff reads as additions.
2. **Refuse what you cannot read.** A block in a shape the parser does not
   understand is returned unchanged. Rewriting a block you cannot read is
   exactly what this was.
3. **The hook and the library are held in step by an executed parity case.**
   The hook lives in `~/.pai/hooks/`, outside this repo, so it cannot import
   `lib/frontmatter.ts` and the logic is duplicated. The parity test runs both
   over one input and compares bytes; without it the fix decays back into the
   bug the first time one side is edited.

The hook cases are driven where the hook exists and report a named, printed
skip where it does not — a consumer who has never installed PAI must not be
refused for a file they do not have. The convention-parity cases need nothing
but this repo and always run; they are what would have gone red the moment the
hook shipped.

- [x] SC-729: lib/frontmatter.ts contains [stampFrontmatter] — stamping merges into the existing block instead of rebuilding it, so a field the formatter does not own survives a write
- [x] SC-730: lib/frontmatter.ts contains [could not be parsed] — a block in an unrecognised shape is returned unchanged rather than rewritten into something smaller
- [x] SC-731: test/rules-frontmatter.test.ts contains [every rules file declares a description] — the convention the hook violated is asserted over the real files, and this check needs nothing outside this repo so it runs in CI
- [x] SC-732: test/rules-frontmatter.test.ts contains [it agrees with lib/frontmatter.ts on the same input] — the hook is executed and its output compared byte-for-byte with the library, because the two cannot share code and nothing else stops them drifting

#### What was broken to prove it (#299)

Run and counted over `test/rules-frontmatter.test.ts` (22 tests). None is left
in the tree; all were run and reverted.

| Mutation | Red |
|---|---|
| `stampFrontmatter` overwrites keys already present | 2 of 22 |
| the parser guesses at an unindented non-key line instead of refusing | 2 of 22 |
| the trailing newline absorbed back into the last entry's block | 2 of 22 |
| the HOOK's merge reverted to the original rebuild-from-REQUIRED | 3 of 22 — strip, flatten, and the library parity case |

### HYGIENE-6 reports its own coverage (#508)

HYGIENE-6 is advisory about the review BACKLOG, and should stay that way —
119 pending candidates on this repo, and asserting them to zero would block
every push until someone triaged all of them. It was also advisory about
whether the scan happened at all, which was never intended: the body ended in
`expect(true).toBe(true)`, so the only red it could produce was a **timeout**,
and that is the red it produced four times in full runs while passing
standalone every time.

Two things were wrong underneath it, and the first is why the second stayed
invisible for so long.

**The staleness scan spawned one `git log` per document** — the exact code
#323 removed from `runDocHygiene`, in a file #323 did not touch. 91 serial
subprocesses against one repository, nothing wrong with any single one, and
load-sensitive by construction: a busy machine or another suite holding the
index pushes it past bun's 5000ms default. Measured on an idle machine with a
warm cache, three runs each:

| | before | after |
|---|---|---|
| `computeStaleness` over 91 documents | 4169 / 4521 / 3969 ms | 240 / 197 / 189 ms |

Equivalence was checked rather than assumed, because a detector that got
quicker by finding less would pass every timing test: both paths were run
over the same 91 documents and compared date-for-date — **91 agree, 0
differ**. `lastCommitDates` now lives in `lib/git-dates.ts` and is re-exported
from `lib/conformity.ts`, which imports `bun:test` at module scope and so
cannot be imported by a CLI.

**The extractor never said how much it read.** `scan` reported what the walk
could SEE; nothing reported what the read then took, and `0 candidates` over
91 documents is the same line of output as `0 candidates` over 4.
`ScanCoverage` is the reading — `planned`, `read`, and `unread` naming each
file with the errno that stopped it. A planned file that cannot be read is
recorded rather than thrown (one transient file must not take an advisory
backlog report down) and recorded rather than dropped (a partial scan must
not be indistinguishable from a complete one).

Fixing that surfaced a third: `planDocScan`'s flat root scan asked the `.md`
suffix and never asked the filesystem, while the recursive walk beside it
asks `statSync` before it decides. A **directory** named `NOTES.md` at the
project root was planned as a document and handed to `readFileSync`, which
throws EISDIR — a plan naming a file it could never read.

- [x] SC-1964: test/extract-constraints-coverage.test.ts contains [a planned document that cannot be read is named, and the rest are still read] — the file moves between the walk and the read, and the two survivors are still read, so one bad document does not abandon the scan
- [x] SC-1965: test/extract-constraints-coverage.test.ts contains [the counts are the scan's own and move with it] — two fixtures of different sizes, because a constant satisfies a single-fixture count as readily as a measurement does
- [x] SC-1966: test/extract-constraints-coverage.test.ts contains [a directory whose name ends in .md is not planned as a document] — both halves, since dropping every root-level document is the cheapest wrong fix available
- [x] SC-1967: test/extract-constraints-coverage.test.ts contains [on this repository every planned document is read] — the live tree, which is the reading HYGIENE-6 itself now asserts

#### What was broken to prove it (#508)

## Constraints

- All new content-alignment checks MUST start as WARN, not FAIL (spec-policies.json Decision #9)
- Skill('doc-hygiene') MUST exit in <5 seconds on cache hit (no governed files changed)
- governs-field is the ONLY spec discovery mechanism — do not add alternative discovery paths
- No LLM-based detection (DEC-006) — all checks must be deterministic
- Signal logging MUST include check-id, file, and finding-type metadata for promotion tracking

## Anti-Criteria

- [ ] SC-A1: No LLM/AI model calls in lib/doc-hygiene.ts or lib/spec-registry.ts (behavioral)
- [ ] SC-A2: No FAIL-level content checks without 10+ cycle precision data (behavioral)
