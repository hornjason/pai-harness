---
doc-type: reference
status: active
owner: jason
updated: 2026-09-14
---

# workflow-state.json Schema Guide

Read this BEFORE writing ACs or workflow-state.json. The scope gate validates every field.

## AC Required Fields

Every AC must have all of these:

| Field | Type | Constraints |
|---|---|---|
| `id` | string | `AC-1`, `AC-2`, `AC-A1` (A-prefix for anti-criteria) |
| `type` | enum | `CODE` or `OUTCOME` only |
| `statement` | string | Min 5 words. No garbage (see below) |
| `threshold` | object | `{ op, value, unit }` — see Threshold Rules |
| `evidenceMethod` | object | `{ type, command }` — see Evidence Types |

Optional: `specElement` (string), `contextFiles` (array), `verdict`, `evidence`.

## Threshold Rules

```
value: string | number    ← NEVER boolean (true/false will fail Zod validation)
op:    "==" | ">=" | "<=" | ">" | "<" | "!=" | "contains" | "exists"
unit:  string (optional)
```

**Common mistake:** `{ "op": "exists", "value": true }` — FAILS. Use `"value": "true"` (string).

**Weak threshold:** `{ "op": ">=", "value": 1 }` — FAILS. Threshold `>= 1` effectively always passes.

## Evidence Method Types

Valid `type` values (case-sensitive): `GREP_CHECK`, `FILE_EXISTS`, `CURL_CHECK`, `BUN_TEST`, `SCREENSHOT`, `PLAYWRIGHT`, `COMMAND`, `MANUAL`, `grep`, `command`, `api`, `screenshot`, `manual`

### Rewrite provenance — `authoredCommand` and `rewrites` (#614)

`command` is what will RUN. Three places legitimately change it before it
does, and each one records what it changed.

| Field | Type | Meaning |
|---|---|---|
| `authoredCommand` | string | The command as the discovery agent wrote it. Written once by the FIRST rewrite and never overwritten |
| `rewrites` | `{by, from, to}[]` | Every change to `command`, oldest first. `by` names the site: `discovery-path-normalize`, `evidence-type-ratio`, `normalize-git-refs` |

**A `rewrites` list with no `authoredCommand` beside it is rejected at write
time.** It is the same pairing as `evidencePrevalidation`'s
`autoFixed`/`originalCommand`/`fixedCommand`, and for the same reason: a
rewrite that reports only its replacement cannot be reviewed, and a repaired
command is then indistinguishable from one that was always written that way.

Both are absent on an AC nothing has rewritten. Absence means "as authored",
not "unknown".

```json
{ "evidenceMethod": {
  "type": "COMMAND",
  "command": "git log origin/main..HEAD --oneline | wc -l | tr -d ' '",
  "authoredCommand": "git log main..HEAD --oneline | wc -l | tr -d ' '",
  "rewrites": [{ "by": "normalize-git-refs",
                 "from": "git log main..HEAD --oneline | wc -l | tr -d ' '",
                 "to": "git log origin/main..HEAD --oneline | wc -l | tr -d ' '" }]
} }
```

Write it with `recordEvidenceRewrite` in `lib/evidence-command-transport.ts`,
never by assigning `command` directly — that function is the single site that
changes an evidence command, and a direct assignment is what made run
`wf_c92dd0a7-fe6`'s corruption unattributable.

## Statement Constraints

**Garbage patterns (auto-rejected):**
- "file exists", "it works", "code is correct/good/done"
- "tests pass", "changes are made/applied/done", "no errors"

**Behavioral language (auto-rejected):**
- "DA should", "remember to", "make sure", "don't forget"

## Ceremony Tier Requirements

| Requirement | LIGHT (XS) | STANDARD (S/M) | THOROUGH (L) |
|---|---|---|---|
| `sourceSpecs[]` | not required | **REQUIRED** | **REQUIRED** |
| `governingSpec` | not required | **REQUIRED** | **REQUIRED** |
| `specElement` on ACs | not required | at least 1 AC per specElement | at least 1 AC per specElement |
| spec-prohibited checks | skipped | **ACTIVE** | **ACTIVE** |
| hardcoded value checks | skipped | **ACTIVE** | **ACTIVE** |

### sourceSpecs format
```json
{ "path": ".github/workflows/issue-triage.md", "citedInDiscovery": true,
  "specElements": ["frontmatter schema pattern", "add-comment config"] }
```
Paths must be relative to projectRoot (not `~/`). The gate resolves: `join(projectRoot, path)`.

### governingSpec format
```json
{ "path": "/Users/jhorn/.claude/PAI/specs/CI-ENFORCEMENT-SPEC.md",
  "detectedFrom": "ship-workflow-discovery" }
```
Path must be absolute (starts with `/`) or relative to projectRoot. `~` is NOT expanded.

## agents.rook

The security reviewer's result lives at `agents.rook`. Six fields carry it:

| Field | Type | Meaning |
|---|---|---|
| `spawned` | boolean | Whether rook actually ran on this ship run |
| `verdict` | `PASS` \| `FAIL` \| `SKIP` \| `EXHAUSTED` \| `null` | The review outcome |
| `failures` | string[] | One entry per blocking problem found |
| `testedPaths` | string[] | The files git said changed — what was actually reviewed |
| `refusal` | `"SECURITY_REREVIEW_EXHAUSTED"` | The named refusal. Only on an `EXHAUSTED` record |
| `rounds` | integer ≥ 1 | Remediate/re-review rounds spent. Required on `EXHAUSTED` |

**A `FAIL` verdict must carry a non-empty `failures` list.** A FAIL with an empty
or absent list is a verdict nobody can act on — it blocks the run without naming
what to fix. `failures` must be an array of strings; a bare string is rejected at
write time, so put one finding per entry rather than joining them into prose.

**`EXHAUSTED` means the remediate/re-review cycle ran out of attempts, and it is
not a pass.** A remediation committed after the review leaves the run holding a
verdict for code it no longer ships (#169), so the new tip is re-reviewed — and
that loop is capped (#171). Spending the cap ends the run with code nobody
reviewed, which is the exact thing this gate exists to stop. It is its own
outcome, distinguishable from both neighbours and readable as neither:

- It is **not a `PASS`**. Nothing concluded the code was clean; the attempts ran
  out. Any reader asking `verdict === "PASS"` must get `false`, and
  `securityReviewIsClean` in `scripts/record-security-verdict.ts` is that reader.
- It is **not a `FAIL`**. Rook named no blocking problem, so an `EXHAUSTED`
  record carries **no `failures`** — a findings list is how "the review found
  something" is written down. Zod rejects an `EXHAUSTED` record that has one.

Zod also rejects `refusal` on any verdict other than `EXHAUSTED`, and an
`EXHAUSTED` verdict missing `refusal` or `rounds`. Recording the refusal
honestly while parking the verdict at `PASS` is the fail-open the pairing
closes.

```json
{ "agents": { "rook": {
  "spawned": true,
  "verdict": "EXHAUSTED",
  "refusal": "SECURITY_REREVIEW_EXHAUSTED",
  "rounds": 2,
  "testedSha": "3192a75...", "testedPaths": ["gates/run-gate.ts"]
} } }
```

```json
{ "agents": { "rook": {
  "spawned": true,
  "verdict": "FAIL",
  "failures": ["secret logged at gates/run-gate.ts:120", "unvalidated path join in lib/github.ts"],
  "testedSha": "3192a75...", "testedPaths": ["gates/run-gate.ts", "lib/github.ts"]
} } }
```

A `PASS` or `SKIP` verdict may omit `failures` entirely.

Write it with `scripts/record-security-verdict.ts`, not by hand — `workflows/ship.js`
calls it in the Verify fan-out (#129). The exhausted state is
`--verdict EXHAUSTED --rounds <n>`; the recorder derives `refusal` from the
verdict rather than accepting it as an argument.

## suiteMeasurement

The suite result, bound to the commit it ran against (#224). Top-level, optional,
and **absent means UNMEASURED** — not "clean".

| Field | Type | Meaning |
|---|---|---|
| `verdict` | `PASS` \| `FAIL` \| `PARTIAL` | Derived from the count and the declared scope, never supplied by a caller |
| `measuredSha` | string | The commit the suite actually ran against — 7-40 hex, never a ref name |
| `failures` | number | Failing tests: `0` for a PASS, at least `1` for a FAIL |
| `measuredAt` | string | ISO timestamp of the run (optional) |
| `tests` | number \| null | Tests the runner COLLECTED, or `null` when it did not say (#490) |
| `ran` | number | Tests that actually executed — `pass + fail`. Absent only on a record older than #673 |
| `skip` | number | Tests the runner skipped. Absent only on a record older than #673 |
| `todo` | number | Tests marked todo. Absent only on a record older than #673 |
| `files` | number \| null | Test files the runner said it discovered, or `null` when it did not say. Never `0` — a run over no files is refused, not recorded (#490) |

**`tests` and `ran` are different quantities and both are recorded (#673).**
On run `wf_62d68d55-81c` they were `13915` and `13084`; the changelog line carried
one, this record carried the other, and nothing said which was which, so a reader
comparing either against a previous run's number could be comparing different
things. The difference is exactly `skip + todo`, which is why all four are here —
nobody should have to subtract to learn what a number means.

**`PARTIAL` means the reading was taken over less than the whole suite**, declared
by the caller through `--scope` because the runner's output cannot say it: `bun
test test/one.ts` and `bun test` print the same shape. It is writable and it is
not a result — `readSuiteMeasurement` resolves it to `UNMEASURED` by name, so no
gate can act on it, and the recorder writes no `environments.local.tests` at all
for one (`SKIP` would SATISFY the gate, which is the defect inverted).

**A measurement with no `measuredSha` is rejected at write time.** A count with no
commit attached cannot be checked against the tree being shipped, so it is not
evidence: run `wf_7ac5f614-d21` published `regressions: 0` over a branch whose
suite had one failing test, and nothing could tell. `"HEAD"` is rejected for the
same reason — it names whatever the checkout happened to be.

**The verdict and the count may not contradict each other.** A `PASS` with failing
tests, and a `FAIL` with none, are both refused by Zod.

```json
{ "suiteMeasurement": {
  "verdict": "FAIL", "measuredSha": "dd242a62aea9371d788abb58f3d26922d5dd6cbc",
  "failures": 1, "measuredAt": "2026-10-09T18:04:11Z"
} }
```

`UNMEASURED` is **not** a writable verdict. It is what `lib/suite-measurement.ts`
returns for the absence of a usable record — no record, no SHA, a malformed SHA,
no count, or a self-contradicting one — and it reads with `failures: null` rather
than `0`, so a consumer cannot add an unmeasured run into a clean total.

Write it with `scripts/record-suite-measurement.ts`, not by hand:

```
bun scripts/record-suite-measurement.ts --state <workflow-state.json> --project <project root> --output <captured suite output> --scope full|partial
```

The commit is read from `--project`, not supplied (#312). A SHA a caller types
can agree with HEAD by construction, which is the provenance check answering
itself — so `--sha` is refused by name, as is `--result`: the verdict comes
from the count and has no other source.

**The count is read from the runner's output, not supplied either (#469, #490).**
`--failures <n>` is refused by name for the same reason as `--sha`: it was a
number an agent typed after reading a summary, and the run this guards against
had no summary to read. A run whose output carries no pass/fail counts, or
which executed nothing, is **refused rather than recorded** — the absence then
reads UNMEASURED through `lib/suite-measurement.ts`, which is what absence
already means here.

## evidencePrevalidation

The scope gate's dry-run of every AC evidence command, written before the gate
tests read the file (#235). Top-level, optional, and **absent means UNMEASURED**
— the gate never got as far as measuring.

| Field | Type | Meaning |
|---|---|---|
| `verdict` | `PASS` \| `FAIL` \| `UNMEASURED` | Derived from the per-AC results, never supplied by a caller |
| `checkedAt` | string | ISO timestamp of the dry-run |
| `acs` | array | One entry per AC: `id`, `status`, and the auto-fix fields below. Empty — and only empty — when UNMEASURED |
| `broken` | array of AC ids | The ACs `acs` classified `broken`, in measured order. Derived, never supplied. Required on a FAIL (#274) |
| `alreadySatisfied` | array of AC ids | The ACs whose **pre-change** output already cleared their own threshold. Derived from the baselines under `acs`, never supplied (#669) |
| `reason` | string \| null | Why the reading is UNMEASURED. Null, and only null, when it is not |
| `takenAt` | `scope` \| `verify` \| `ship`, optional | Which gate measured it (#264, #280). Absent means a run older than the field |

**The three verdicts:**

| Verdict | Means |
|---|---|
| `PASS` | Every evidence command was dry-run and none is broken. `empty` output is a warning, not a refusal, and still appears in `acs` |
| `FAIL` | At least one AC's command is broken and could not be auto-fixed. A FAIL must name one — a FAIL with no `broken` entry is refused by Zod |
| `UNMEASURED` | The pre-validation did not produce a result: it threw, or there were no ACs. Carries a `reason` and no `acs` |

**The FAIL shape, and why `broken` is part of it (#274).** A FAIL carries two
views of the same fact: the per-AC results under `acs`, and the ids under
`broken`. The second is not redundancy. `prevalidationViolations` in
`gates/workflow.test.ts` — the single site that turns this reading into a
refusal — names the ACs to fix out of `broken`, and until #274 **no writer
produced that key**: `measureEvidencePrevalidation` returned per-AC results and
nothing else, so every genuine FAIL refused with "no broken AC ids were
recorded", which was true of the key and false of the reading. Fail-closed, so
nothing shipped that should not have — but a refusal the heal loop cannot act
on costs a round and teaches it nothing.

So a FAIL must satisfy all three of these, and Zod refuses it otherwise:

| On a FAIL | Rule |
|---|---|
| `acs` | At least one entry with `status: "broken"` |
| `broken` | Present, and exactly the ids of those entries, in the same order |
| `reason` | `null` — a measured verdict explains itself through its ACs |

`broken` is **derived, never supplied.** It is mapped from the same filter the
verdict is derived from, at the single site that derives it, and the schema
compares it against `acs` on every verdict — a PASS or an UNMEASURED that names
a broken AC is refused the same way a FAIL that names the wrong one is. A list a
writer could set independently of `acs` would be a second source of truth for
one fact, and the refusal would name whichever of the two was wrong.

It is optional only for backward compatibility, the same way `takenAt` is: a
reading written before the field existed still validates. A FAIL does not get
that amnesty, because naming what to fix is the entire job of that verdict.

Unlike `suiteMeasurement`, `UNMEASURED` **is** writable here. There, recording it
would give a caller a way to park an unmeasured run in the field that proves the
suite ran. Here the failure runs the other way: a pre-validation that threw and
one that found nothing wrong both used to leave the field empty, and absence
reads downstream exactly like "clean". Recording the throw, with its reason, is
what makes the two distinguishable — and absence still means nobody measured.

Each entry in `acs` carries:

| AC field | Type | Meaning |
|---|---|---|
| `id` | string | The AC the command belongs to |
| `status` | `ok` \| `broken` \| `empty` \| `skipped` | Dry-run outcome. `skipped` means the AC has no command |
| `baseline` | object | What the command printed on the **pre-change** tree, beside the threshold it will be judged against (#669). See below |
| `autoFixed` | boolean | The command was repaired. Requires **both** command fields below |
| `originalCommand` | string | The command as the AC was written |
| `fixedCommand` | string | The command to run instead |
| `needsRewrite` | boolean | Broken and not auto-fixable — a human or Marcus must rewrite it |
| `diagnostic` | string | Why it is broken |

**An `autoFixed` entry must carry both `originalCommand` and `fixedCommand`.** A
repair that reports only its replacement cannot be reviewed — there is nothing
to compare it to, and it is indistinguishable from a command that was always
written that way. This includes the ref-rewrite path (`main` → `origin/main`),
which returns `status: "ok"`: the command dry-runs clean and only diverges at
Verify, so the rewrite is the only record that anything happened.

### `baseline` — the pre-change reading (#669)

The pre-change tree stops existing the moment Marcus writes a line. Until
#669 the pre-validation ran every AC's command against it, kept `ok` /
`broken` / `empty` / `skipped`, and threw the output away — so the one tree on
which a threshold is known **not** to be satisfied was measured and then
forgotten, and nothing ever compared the output to the AC's own bar.

| Baseline field | Type | Meaning |
|---|---|---|
| `verdict` | `MEASURED` \| `UNMEASURED` | Whether the output is a value a threshold can be compared against |
| `output` | string | What the command printed, verbatim and trimmed. Non-empty on a MEASURED baseline |
| `reason` | string \| null | Why it is UNMEASURED. Null, and only null, when it is MEASURED |
| `threshold` | object \| null | The AC's threshold as written — `op`, `value`, `unit`. Recorded beside the output so both read without re-running anything |
| `satisfiesThreshold` | boolean \| null | Whether the pre-change output already clears the bar. **Null, and only null, when no comparison was made** |

**An UNMEASURED baseline is never reduced to a threshold comparison.** Two
outputs reach that verdict: nothing at all, and a tool version banner. The
second is the one that hid. Run `wf_448af2c4-6c1` carried an AC whose evidence
command kept only the line bun prints before it runs anything —

```
bun test v1.3.14 (d1632b29)
```

— which is 27 characters from a command that exited zero, so it classified
`ok` and every downstream reader saw an AC with evidence. There is no
measurement in it. Worse, a `contains "bun test"` threshold is **true** of
that string, so the comparison it was about to be fed would have reported the
AC satisfied by the tool's own name. The two unmeasured states carry different
reasons, because "it printed nothing" and "it printed only a banner" are fixed
by different edits.

`satisfiesThreshold` is `null` rather than `false` whenever no comparison
happened. `false` claims the bar was tested and missed — a statement about the
tree — while null says nobody could test it. Collapsing the two is how an AC
that cannot measure anything reads as one that simply has not landed yet.

The schema refuses a baseline that contradicts itself, the same way it already
refuses an `UNMEASURED` reading with no reason:

| Contradiction | Why |
|---|---|
| `UNMEASURED` with no `reason` | An absence nobody can explain is not actionable |
| `UNMEASURED` with a non-null `satisfiesThreshold` | An output nobody could read was reduced to a comparison |
| `MEASURED` with a `reason` | A measured output explains itself |
| `MEASURED` with empty `output` | A command that printed nothing measured nothing |
| `satisfiesThreshold` with `threshold: null` | There was no bar to clear |
| `alreadySatisfied` disagreeing with the baselines under `acs` | The refusal would name the wrong AC |
| `alreadySatisfied` absent while a baseline is satisfied | A vacuous AC nothing records is one nothing can refuse |

**`alreadySatisfied` is a refusal at scope and nowhere else.**
`prevalidationViolations` names those ids only when `takenAt` is `scope`,
which is the one phase whose tree is the pre-change one. At verify and at ship
the work has landed, so an AC that satisfies its threshold there is an AC that
**passed** — refusing those would turn every successful run red. A reading
with no `takenAt` predates the field and cannot say which tree it describes,
so it is not refused either.

```json
{ "evidencePrevalidation": {
  "verdict": "FAIL", "checkedAt": "2026-10-09T18:04:11.000Z", "reason": null,
  "broken": ["AC-2"], "alreadySatisfied": [], "takenAt": "scope",
  "acs": [
    { "id": "AC-1", "status": "ok", "autoFixed": true,
      "originalCommand": "git log main..HEAD --oneline",
      "fixedCommand": "git log origin/main..HEAD --oneline",
      "baseline": { "verdict": "MEASURED", "output": "0", "reason": null,
        "threshold": { "op": ">=", "value": 1 }, "satisfiesThreshold": false } },
    { "id": "AC-2", "status": "broken", "needsRewrite": true,
      "diagnostic": "Command failed with exit code 127",
      "baseline": { "verdict": "UNMEASURED", "output": "",
        "reason": "the command ran and printed nothing, so there is no value to compare against the threshold",
        "threshold": { "op": "contains", "value": "ok" }, "satisfiesThreshold": null } }
  ]
} }
```

Three gates write it — `gates/gate-executor.ts`, `runScopePreflightsAndPersist`
at scope and `ensurePrevalidationPersisted` at verify and at ship — after the
dry-run resolves and before the gate tests run. Not by hand.

**`takenAt` decides whether the gate now running needs its own reading, and
the policy lives in one predicate: `shouldRetakePrevalidation`.**

| Gate | What survives | Why |
|---|---|---|
| verify | a `scope` reading | It measured the run's starting conditions. Re-measuring those after Marcus has run answers a different question than the one the scope gate refuses on (#264) |
| verify | nothing else | The premise of another verify attempt is that the branch moved. Freezing the reading means no heal round can clear a refusal. Run `wf_c71f950f-c88` made four verify attempts with all six ACs PASS, every one judged against a single frozen reading, and reported SHIP_FAILED |
| ship | **nothing** | Between verify and ship the run commits, pushes, and may move the branch. Defensible one phase later, indefensible three (#280) |

Before #280 there was no ship branch at all, so the ship gate consumed
whatever block verify had left behind. On run `wf_ea3e428f-64f` that was a
reading an hour old, stamped `takenAt: "verify"`, that disagreed with the tree
by four of six ACs — the ship gate recorded a description of a tree it was not
gating. It still refused, and for the right reason; what it got wrong was
filing a stale artefact as current, which is precisely what `takenAt` was
added to make impossible to misread.

**The consumer enforces it too.** `prevalidationViolations` in
`gates/workflow.test.ts` refuses a reading at ship whose `takenAt` is anything
but `ship`, so a producer that stops re-measuring turns the gate RED rather
than quietly going stale again. There is no general "an earlier phase is
stale" rule — a `scope` reading surviving to verify is correct — so the check
is scoped to ship on purpose.

**The dry-run uses `EVIDENCE_CWD` when it is set**, which is the directory the
evidence collector uses, and which `workflows/ship.js` sets under worktree
isolation. A pre-validator looking somewhere other than where the evidence will
be collected calls the branch's own new files missing.

## Changelog Actor Values

Valid `actor` enum (lowercase only): `da`, `marcus`, `quinn`, `rook`, `gate-runner`

## Common Scope Gate Failures

| Check name | What it validates | Fix |
|---|---|---|
| `workflow-state.json validates` | Zod schema parse | Fix threshold value types, actor casing, enum values |
| `governing spec exists and is readable` | sourceSpecs[0].path resolves to a file | Use absolute path or path relative to projectRoot |
| `sourceSpecs-required` | STANDARD+ has sourceSpecs[] | Add sourceSpecs with referenced pattern files |
| `discovery-evidence` | sourceSpecs have `citedInDiscovery: true` | Set the flag on each sourceSpec |
| `spec-elements-in-acs` | ACs reference declared specElements | Add `specElement` field to ACs matching sourceSpec elements |
| `no 'DA should'` | No behavioral delegation in AC statements | Rewrite as measurable assertions |
| `no hardcoded paths` | No `/usr/`, `/opt/`, `/home/`, `/tmp/` in statements | Use relative descriptions, not absolute paths |

## Correct vs Incorrect AC

```json
// CORRECT
{
  "id": "AC-1", "type": "CODE",
  "statement": "sc-verification.md exists with pull_request trigger in frontmatter",
  "threshold": { "op": "contains", "value": "pull_request", "unit": "trigger" },
  "evidenceMethod": { "type": "grep", "command": "grep 'pull_request' .github/workflows/sc-verification.md" },
  "specElement": "gh-aw workflow frontmatter schema pattern"
}

// INCORRECT — 4 problems
{
  "id": "AC-1", "type": "CODE",
  "statement": "file exists",                          // garbage pattern, < 5 words
  "threshold": { "op": "exists", "value": true },      // boolean value, needs "true" string
  "evidenceMethod": { "type": "check" },                // invalid type, use "command"
  "specElement": "something"                            // doesn't match any sourceSpec specElement
}
```

## Writing workflow-state.json

Use **writeWorkflowState()** via `bun -e`, not the Write tool or Bash `cat >` / `echo >`:

```
bun -e "import {writeWorkflowState} from './gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('WORK_DIR/workflow-state.json','utf8')); /* apply fix */; writeWorkflowState('WORK_DIR/workflow-state.json', s);"
```

This validates via Zod at write time with enum-specific error formatting. Invalid values produce immediate feedback (e.g., `acs.0.threshold.op: expected one of [==, >=, ...], got "equals"`) instead of opaque gate failures later.
