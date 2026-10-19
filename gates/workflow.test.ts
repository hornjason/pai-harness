import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { execSync, execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { join } from "path";
import { WorkflowStateSchema } from "./schema";
import { extractTestFailureCount, subtractTestBaseline } from "./gate-executor";
import { typecheckFailures } from "./typecheck-gate";
import {
  missingEvidenceViolations,
  thresholdCrosscheckViolations,
} from "../lib/evidence-required";
import {
  classifyContainerProvenance,
  containerProvenanceViolations,
  resolveContainerRuntime,
} from "../lib/container-provenance";
import { evidencePortabilityViolations } from "../lib/evidence-portability";
import { alreadySatisfiedIds } from "../lib/evidence-prevalidator";
import { readBranchDiff } from "../lib/branch-diff";
import { proveLabelGateVerdict, type LabelRead } from "../lib/prove-label-gate";
import { worktreeDiskIdentity, type RemoteReading } from "../lib/worktree-repo";
import { readSuiteMeasurement, type SuiteReading } from "../lib/suite-measurement";
import {
  EXEC_TIMEOUT_MS,
  GATE_TEST_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
} from "../lib/gate-timeouts";
import {
  outcomeEvidenceViolations,
  goalKeywordCoverage,
  GOAL_COVERAGE_WARN_BELOW,
} from "../lib/ac-quality";

/**
 * Every check in this file gets longer than the processes it starts (#550).
 *
 * File level and not per-test on purpose: `}, 120000);` on `tsc-pass` alone
 * fixes one check, and the exec helpers below are called from dozens. The
 * ordering against the spawns is owned by lib/gate-timeouts.ts and asserted
 * in test/gate-suite-timeouts.test.ts.
 */
setDefaultTimeout(GATE_TEST_TIMEOUT_MS);

const STANDALONE = !process.env.TEST_WORK_DIR;
const TEST_DIR = process.env.TEST_WORK_DIR || "/tmp/gate-viability-test";
const SF = `${TEST_DIR}/workflow-state.json`;

function loadRaw(): any | null {
  if (!existsSync(SF)) return null;
  return JSON.parse(readFileSync(SF, "utf-8"));
}

function sf(path: string): any {
  const wf = loadRaw();
  if (!wf) return undefined;
  const parts = path.replace(/^\./, "").split(".").filter(Boolean);
  let val: any = wf;
  for (const p of parts) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

function exec(cmd: string, cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: EXEC_TIMEOUT_MS }).trim();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: (e.stdout ?? "").trim() };
  }
}

/**
 * Argv-form git, for commands carrying a value out of a config file.
 *
 * `exec` above goes through a shell, so `git status --porcelain -- ${paths}`
 * hands consumer-authored strings to `sh`. `codeCommittedPaths` is read from
 * the project's own `.claude/rungate.json`, and a path list is exactly the
 * kind of field somebody pastes into without thinking about quoting. Argv
 * form removes the shell rather than trying to sanitise for it.
 *
 * `--` is passed by the caller, so a pathspec beginning with `-` is a
 * pathspec and not an option.
 */
function execArgvOf(bin: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(bin, args, { cwd, encoding: "utf-8", timeout: EXEC_TIMEOUT_MS }).trim();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim() || String(e?.message ?? e) };
  }
}

function execArgv(args: string[], cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("git", args, { cwd, encoding: "utf-8", timeout: EXEC_TIMEOUT_MS }).trim();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim() || String(e?.message ?? e) };
  }
}

function loadProjectHarness(): any {
  const root = sf("projectRoot");
  if (!root) return null;
  const p = join(root, ".claude", "rungate.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

/**
 * #314 — the tree a check MEASURES, as opposed to where config is READ.
 *
 * `projectRoot` is the main checkout. On a worktree-isolated run the change
 * under test is not in it, so a command executed there measures code that is
 * already merged and green. Measured on run `wf_5cdce852-1e2`: `tsc-pass` ran
 * the compiler in `projectRoot`, reported PASS, and CI then caught two real
 * type errors on the branch.
 *
 * Returns `null` when the state does not name the tree. Every caller must
 * refuse on `null` rather than substitute `projectRoot` — that substitution is
 * the defect, and it is invisible because it always produces a pass.
 */
export function treeUnderTestViolations(tree: unknown, checkName: string): string[] {
  if (typeof tree !== "string" || tree.trim() === "") {
    return [
      `${checkName}: workflow state does not name treeUnderTest, so there is ` +
        `nothing to measure. This is UNMEASURED, not PASS — measuring ` +
        `projectRoot instead would check the main checkout, which is green by ` +
        `construction and is not the change being shipped (#314).`,
    ];
  }
  return [];
}

/**
 * Does the tree have commits its upstream does not (#174)?
 *
 * The reading that matters is NOT just the count. `git rev-list --count
 * @{upstream}..HEAD` fails outright when there is no upstream, and the old
 * body read that failure as nothing-to-report:
 *
 *     if (!result.ok) return; // no upstream
 *
 * A branch with no upstream has never been pushed, which is the strongest
 * possible failure of a check named "no unpushed commits" — and it was the one
 * input that passed unconditionally. Fail-open, shape one in
 * .claude/rules/checks-must-be-able-to-fail.md, in the check whose whole job is
 * to notice unpushed work.
 *
 * It is reachable, not theoretical. The happy path sets upstream
 * (`workflows/ship.js:3161`, `git push -u origin ${pushTarget}`), but both
 * remediation re-pushes do not — `:3324` and `:4704` run
 * `git push origin HEAD:${shipBranch}`. So a run that needed remediation
 * arrives here with no upstream and is waved through.
 *
 * Exported as the single binding this check's refusal is routed through, so
 * `return []` is one edit and the mutation is a real measurement rather than a
 * claim in a PR body.
 */
export function unpushedViolations(
  count: { ok: boolean; output: string },
  upstream: { ok: boolean; output: string },
): string[] {
  if (count.ok) {
    return count.output === "0" ? [] : [`code-pushed: ${count.output} commits ahead of upstream`];
  }
  if (!upstream.ok) {
    return [
      "code-pushed: the branch has no upstream, so nothing on it has been " +
        "pushed. This is the WORST case for this check, not an exemption from " +
        "it — the previous code returned here and passed (#174). A remediation " +
        "re-push uses `git push origin HEAD:<branch>`, which does not set " +
        "upstream, so this is reachable on any run that needed one.",
    ];
  }
  return [
    `code-pushed: the branch tracks ${upstream.output} but the commit count ` +
      `could not be read. This is UNMEASURED, not PASS — a git invocation that ` +
      `fails for an unknown reason says nothing about whether work is unpushed.`,
  ];
}

/**
 * #315 — `code-committed` has never executed.
 *
 * The body read `harness?.codeCommittedPaths || []` and returned early on an
 * empty list. **Nothing authors that key.** Measured on main: neither
 * rungate's `.claude/rungate/config.json`, nor its legacy
 * `.claude/rungate.json`, nor DailyBriefDashboard's names it. So the check
 * whose entire job is confirming the shipped work is committed hit the early
 * return on every run this repository has ever made — shape one in
 * .claude/rules/checks-must-be-able-to-fail.md, keyed to a config value that
 * does not exist.
 *
 * It compounded with #314: the status also ran in `projectRoot`, the main
 * checkout, which is clean during a worktree run. Both halves had to be
 * fixed or the check means nothing; #314 fixed the tree, this fixes the scope.
 *
 * ## The scope decision (SC-E2), recorded here rather than left to infer
 *
 * The key becomes OPTIONAL WITH A DERIVED DEFAULT rather than required.
 *
 * Requiring it would refuse at scaffold time for every consumer that has
 * never heard of it — an outage for a rule nobody opted into, which is the
 * same reasoning `loadConformityAllowlists` and #302's growth check already
 * apply. And the default is not a guess: for a check named "no uncommitted
 * changes in project", the honest scope is **the whole tree**, and a
 * configured path list is a narrowing a consumer opts into, not the thing
 * that switches the check on.
 *
 * Untracked files are included, because `--porcelain` already honours
 * `.gitignore` and a source file that was never added is exactly the
 * uncommitted work this check exists to catch. Build artefacts that trip it
 * belong in `.gitignore`; that is the right pressure rather than a reason to
 * narrow the check.
 *
 * Exported as the single binding this check's refusal is routed through, so
 * `return []` is one edit and the mutation is a measurement rather than a
 * claim in a PR body.
 */
export function codeCommittedViolations(
  status: { ok: boolean; output: string },
  scope: { configured: boolean; paths: string[] },
): string[] {
  if (!status.ok) {
    return [
      `code-committed: \`git status\` could not be read in the tree under test ` +
        `(${status.output || "no output"}). This is UNMEASURED, not PASS — a git ` +
        `invocation that fails for an unknown reason says nothing about whether the ` +
        `work is committed.`,
    ];
  }
  const dirty = status.output.split("\n").map(l => l.trim()).filter(Boolean);
  if (dirty.length === 0) return [];
  const where = scope.configured ? ` within ${scope.paths.join(", ")}` : "";
  const shown = dirty.slice(0, 10).join("; ");
  return [
    `code-committed: ${dirty.length} uncommitted change(s) in the tree under test${where}: ` +
      `${shown}${dirty.length > 10 ? ` … and ${dirty.length - 10} more` : ""}`,
  ];
}

/**
 * #414 — the worktree-repository check, read from the disk rather than from
 * the agent standing in it.
 *
 * #218 refuses a worktree whose `origin` does not match the run's repo, and
 * the remote it compares is SELF-REPORTED: `workflows/ship.js` has no
 * subprocess (#69), so the only remote it can see is the one the agent said
 * it read. An agent that answers from its brief rather than from
 * `git remote get-url origin` produces a reply indistinguishable from a
 * correct one, and `lib/worktree-repo.ts` has exported the unforgeable half
 * since #218 with nothing able to call it. A gate can: gates run as real
 * subprocesses with the worktree on disk.
 *
 * Exported as the single binding this check's refusal is routed through, so
 * `return []` is one edit and the mutation in
 * `test/suite-binding-mutation.test.ts` is a measurement rather than a claim
 * in a PR body. Keep it one function with one body — a second refusal path
 * for the same fact would survive that mutation.
 *
 * AN EMPTY LIST REFUSES. Every run this fires on has at least a tree under
 * test, so zero entries means the state stopped naming them, and a check that
 * scans nothing reports nothing and is indistinguishable from compliance.
 */
export function worktreeRepoViolations(entries: unknown, expectedRepo: unknown, read?: (p: string) => RemoteReading): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [
      "worktree-repo: the workflow state names no worktree to read, so no checkout " +
        "was compared against this run's repository. This is UNMEASURED, not PASS — " +
        "every run reaches this gate with at least a tree under test, so an empty " +
        "list means the state stopped recording them (#414).",
    ];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const e = (raw ?? {}) as { path?: unknown; reportedRepo?: unknown };
    const path = typeof e.path === "string" ? e.path.trim() : "";
    // One worktree, one reading. A worktree that reported in two parts (#228)
    // appears twice, and two identical refusals for it is noise an operator
    // has to deduplicate by hand. Keyed on the empty string too, so a run of
    // pathless rows refuses once.
    if (seen.has(path)) continue;
    seen.add(path);
    const reported = typeof e.reportedRepo === "string" ? e.reportedRepo : null;
    const got = worktreeDiskIdentity(
      path,
      typeof expectedRepo === "string" ? expectedRepo : null,
      reported,
      read,
    );
    if (got.refusal) out.push(`worktree-repo: ${got.refusal}`);
  }
  return out;
}

/** The tree to run commands in, or null when the state does not name one. */
function treeRoot(): string | null {
  const t = sf("treeUnderTest");
  return typeof t === "string" && t.trim() !== "" ? t : null;
}

const isVerifyPlus = () => { const p = sf("phase"); return ["VERIFY", "SHIP", "DONE"].includes(p); };
const isShipPlus = () => { const p = sf("phase"); return ["SHIP", "DONE"].includes(p); };
const isDone = () => sf("phase") === "DONE";

/**
 * #224 — the suite-to-verdict binding.
 *
 * `environments.local.tests` is the only reading this harness has of whether
 * the suite passed on the tree being shipped, and this is the single site that
 * turns that reading into a refusal. Keep it one function with one body: a
 * second refusal path for the same fact would survive the mutation in
 * test/suite-binding-mutation.test.ts and make the proof vacuous, which is why
 * that file asserts this signature appears exactly once and aborts if it moves.
 *
 * Absent is a refusal, not a pass. That is the whole of #224: the run that
 * reported `regressions: 0` over one failing test had measured nothing, and
 * nothing was read as zero.
 *
 * #530 added the second argument. `environments.local.tests` is an enum with
 * no provenance in it, and until #530 nothing in the harness wrote it — the
 * recorder wrote `suiteMeasurement` and the field was left to a sentence in
 * a heal prompt that only runs when the scope gate fails. Now the recorder
 * writes both in one write, and this reads both: a PASS the measurement does
 * not back is refused, which is the hand-written verdict the ship prompt has
 * only ever forbidden in prose.
 *
 * The clauses do not overlap. An absent field, a `FAIL`, and a declared
 * `SKIP` are each decided before the measurement is consulted at all, and
 * `{tests: "PASS"}` with no `suiteMeasurement` is reached by nothing else.
 *
 * The second argument is REQUIRED, and that is the point of it. Optional, it
 * would be a check any future caller could lose by omission — and losing it
 * is silent, because the three clauses above still refuse everything they
 * refused before, so the call reads exactly like a call that is checking.
 * `readSuiteMeasurement` is a total function that returns UNMEASURED for
 * every unusable input, so there is never a caller with nothing to pass.
 *
 * **What the requirement buys is that the absence now fails CLOSED.** With an
 * optional argument, omitting it meant "no objection". Required, the only
 * thing a caller can hand this for a state with no measurement is an
 * UNMEASURED reading, and `UNMEASURED !== "PASS"` refuses. The failure mode
 * inverted: absence used to be silence and is now a refusal. That is
 * `.claude/rules/config-access.md`'s Silent Default Substitution at a second
 * site — `0`, `{}`, `null` and `SKIP` are indistinguishable from success;
 * `UNMEASURED` is not.
 */
export function suiteVerdictViolations(val: unknown, measurement: SuiteReading): string[] {
  if (val === undefined || val === null || val === "") {
    return [
      "local.tests not set — PASS or SKIP required when dev.testCmd is configured. " +
        "An unmeasured suite is not a passing suite (#224).",
    ];
  }
  if (val === "SKIP") return []; // SKIP is allowed — it says so, rather than implying PASS
  if (val !== "PASS") return [`tests: ${String(val)} — expected PASS`];
  // A PASS has to be backed by the measurement that produced it. No
  // `measurement &&` guard: a branch for an argument that cannot be absent
  // is a branch no test can enter.
  if (measurement.verdict !== "PASS") {
    return [
      `tests: PASS, but the suite measurement behind it reads ${measurement.verdict} — ` +
        `${measurement.reason || "the two disagree"} (#530). A verdict no measurement backs is a ` +
        `verdict somebody typed.`,
    ];
  }
  return [];
}

/**
 * #126 — the Verify fan-out leaves a trace, or the gate refuses.
 *
 * The two checks below used to read their slot and, finding nothing, warn and
 * return:
 *
 *     if (!ev) { console.warn("...not populated — B2 agent may not have run"); return; }
 *
 * A test that returns early passes. The only input either could fail on was a
 * slot written WRONG, so the failure mode this exists for — the agent never
 * ran — was the single case they could not catch. "When populated" was in
 * both names.
 *
 * The producer reached not-populated four ways, three of them silent: the
 * `fails === 0` guard in gates/gate-executor.ts (a verify gate with any
 * failure skips the agents and then reports their absence, which reads as the
 * cause when it is the consequence), `RUNGATE_SKIP_AGENTS`, a LIGHT tier, and
 * a missing prompt file. So the fan-out could be absent in full and the gate
 * said PASS, which makes every compliance number recorded for Verify a number
 * for a stage that may not have run.
 *
 * One function, one body, for the same reason `suiteVerdictViolations` above
 * is: a second refusal path for the same fact would survive the mutation in
 * test/suite-binding-mutation.test.ts and make the proof vacuous.
 *
 * A DELIBERATE skip passes, and must be written down as one. Refusing on
 * every absence would brick LIGHT runs, and a fix that brings its own outage
 * is how the next fail-open gets argued for. But a skip with no reason is an
 * absence with extra steps, and it would be the cheapest way to make this
 * whole check green again — so it refuses.
 */
export function verifyFanoutViolations(label: string, val: unknown, tier: unknown): string[] {
  // The producer tier-gates B1 at gates/gate-executor.ts:1093, so a LIGHT run
  // legitimately has no record. This is the one absence that is expected.
  if (tier === "LIGHT") return [];

  if (val === undefined || val === null || val === "") {
    return [
      `gates.verify.${label} not recorded — the agent left no trace, and an absence is ` +
        `not an approval (#126). A deliberate skip must be recorded as ` +
        `{"skipped": "<reason>"} so the artefact can tell "it approved" from "it never ran".`,
    ];
  }
  if (typeof val !== "object") {
    return [`gates.verify.${label} is ${typeof val}, expected a record (#126)`];
  }

  const skipped = (val as { skipped?: unknown }).skipped;
  if (skipped !== undefined) {
    return typeof skipped === "string" && skipped.trim().length > 0
      ? []
      : [
          `gates.verify.${label} records a skip with no reason — a skip nobody can read ` +
            `is an absence with extra steps (#126)`,
        ];
  }
  return [];
}

/**
 * #235 — the evidence pre-validation reading reaches the verdict.
 *
 * `lib/evidence-prevalidator.ts` dry-runs every AC evidence command at SCOPE
 * and classifies each one `ok` / `broken` / `empty` / `skipped`. Until this
 * function existed the entire result went to `console.error` and nowhere else:
 * a run could be told, in its own log, that three of its ACs could not be
 * measured, and still ship — the detection was never the gap.
 *
 * This is the single site that turns that reading into a refusal, for the same
 * reason `suiteVerdictViolations` above is: a second refusal path for the same
 * fact would survive the mutation in test/suite-binding-mutation.test.ts and
 * make the proof vacuous. That file asserts this signature appears exactly once
 * and aborts when it moves.
 *
 * Absent is a refusal, not a pass. An unmeasured pre-validation says nothing
 * about the evidence commands, and "nothing" has already been read as "clean"
 * once in this harness (#224).
 */
export function prevalidationViolations(val: unknown, gatePhase?: unknown): string[] {
  const unmeasured = [
    "evidencePrevalidation not recorded — a PASS reading is required once any AC " +
      "carries an evidence command. An unmeasured pre-validation is not a clean one (#235).",
  ];

  if (val === undefined || val === null || val === "") return unmeasured;
  if (typeof val !== "object") {
    return [`evidencePrevalidation is ${typeof val}, expected a record with a verdict (#235)`];
  }

  // #280 — a reading whose own `takenAt` says it describes an earlier tree is
  // not evidence about this one.
  //
  // The producer is supposed to re-measure at ship, and this is what makes a
  // producer that stops doing so a REFUSAL rather than a stale artefact
  // recorded as current. That distinction is the whole of #280: the ship gate
  // still refused, correctly and for the right reason, while filing a block
  // stamped `takenAt: "verify"` and an hour old as its own reading.
  //
  // Only at ship, and deliberately only there. A SCOPE reading survives to
  // verify by design (#264) — re-measuring the run's starting conditions
  // after Marcus has run answers a different question — so there is no
  // general "earlier phase is stale" rule to apply here, and inventing one
  // would turn every LIGHT run red.
  const ACCEPTED_AT_SHIP = "ship";
  if (gatePhase === "SHIP" || gatePhase === "DONE") {
    const source = (val as { takenAt?: unknown }).takenAt;
    if (source !== ACCEPTED_AT_SHIP) {
      return [
        `evidence pre-validation was taken at ${source ? `\`${String(source)}\`` : "an unrecorded phase"}, ` +
          "not at ship — the ship gate must measure its own tree. Between verify and ship the " +
          "run commits, pushes, and may move the branch (#280).",
      ];
    }
  }

  const reading = val as { verdict?: unknown; acs?: unknown };
  const verdict = reading.verdict;
  if (verdict === undefined || verdict === null || verdict === "" || verdict === "UNMEASURED") {
    return unmeasured;
  }

  // #295 — derived from `acs`, which is what the producer writes and what
  // `EvidencePrevalidationShape` declares. This read `reading.broken`, a key
  // no writer has ever produced and the schema has never declared, so the list
  // was empty on every run: every FAIL fell through to the "no broken AC ids
  // were recorded" branch below, and the refusal whose job is to say what to
  // fix could not say it.
  //
  // `status === "broken"` and nothing else. `empty` is a warning rather than a
  // refusal (lib/evidence-prevalidator.ts), and `skipped` never ran — folding
  // either in here would turn a FAIL that names two ACs into one that names
  // five, which is the same unusable refusal from the other direction.
  const broken = (Array.isArray(reading.acs) ? reading.acs : [])
    .filter((ac: unknown) => (ac as { status?: unknown })?.status === "broken")
    .map((ac: unknown) => String((ac as { id?: unknown })?.id ?? ""))
    .filter((id: string) => id.length > 0);

  // #669 — an AC whose PRE-CHANGE output already cleared its own threshold
  // cannot observe the work. It printed a satisfying value before a line was
  // written, so it will print one afterwards whatever Marcus does: a check
  // that cannot fail, arriving in the run's own acceptance criteria.
  //
  // Derived through `alreadySatisfiedIds`, the same binding the writer and
  // the schema use, so the refusal cannot name a different set than the
  // reading carries (#295 is the cost of getting that wrong).
  //
  // ONLY on a reading taken at scope, and the restriction is the point. Scope
  // is the one phase whose tree is the pre-change one. At verify and at ship
  // the work has landed, so an AC that satisfies its threshold there is an AC
  // that PASSED — refusing those would turn every successful run red, which
  // is the fastest way to build a refusal everyone learns to click past. A
  // reading with no `takenAt` predates the field and cannot say which tree it
  // describes, so it is not refused either.
  const vacuous =
    (val as { takenAt?: unknown }).takenAt === "scope" ? alreadySatisfiedIds(reading.acs) : [];
  const vacuousRefusal =
    vacuous.length > 0
      ? [
          `evidence pre-validation: ${vacuous.join(", ")} already satisfied their own thresholds ` +
            "on the pre-change tree — an AC that passes before the work is done certifies the " +
            "change without observing it (#669)",
        ]
      : [];

  if (verdict === "FAIL") {
    return [
      ...(broken.length > 0
        ? [`evidence pre-validation: FAIL — broken evidence commands on ${broken.join(", ")}`]
        : [
            "evidence pre-validation: FAIL — but no broken AC ids were recorded, so the " +
              "refusal cannot name what to fix (#235)",
          ]),
      ...vacuousRefusal,
    ];
  }

  if (verdict !== "PASS") {
    return [`evidence pre-validation: ${String(verdict)} — expected PASS`];
  }

  // A PASS carrying broken ids is a contradiction, not a pass. Without this the
  // writer could record the broken list faithfully and still be waved through.
  if (broken.length > 0) {
    return [
      `evidence pre-validation: PASS recorded alongside broken evidence commands on ${broken.join(", ")}`,
      ...vacuousRefusal,
    ];
  }
  return vacuousRefusal;
}

// ═══ SCHEMA VALIDATION ════════════════════════════════════════════════
describe("schema validation", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  test("workflow-state.json validates (includes threshold + behavioral superRefine)", () => {
    const raw = loadRaw();
    const result = WorkflowStateSchema.passthrough().safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      // Narrowed to `false` inside this branch — widen so the always-fail
      // assertion still reports the collected issues as its message.
      expect<boolean>(result.success, issues.join("\n")).toBe(true);
    }
  });
});

// ═══ SCOPE CHECKS (11 functions) ══════════════════════════════════════
describe("scope checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 1. acs-exist
  test("acs-exist: at least one AC", () => {
    expect(sf("acs")?.length ?? 0).toBeGreaterThan(0);
  });

  // 4. acs-have-evidence-method
  test("acs-have-evidence-method", () => {
    const missing = (sf("acs") || []).filter((ac: any) => !ac.evidenceMethod);
    expect(missing.map((ac: any) => ac.id)).toEqual([]);
  });

  // 5. acs-measurable
  test("acs-measurable: thresholds have op and value", () => {
    const bad = (sf("acs") || []).filter((ac: any) => ac.threshold && (!ac.threshold.op || ac.threshold.value == null));
    expect(bad.map((ac: any) => ac.id)).toEqual([]);
  });

  // 6. source-spec-cited (GAP → PORTED)
  test("source-spec-cited: all sourceSpecs have citedInDiscovery=true", () => {
    const specs = sf("sourceSpecs") || [];
    const uncited = specs.filter((s: any) => s.citedInDiscovery === false);
    expect(uncited.map((s: any) => s.path)).toEqual([]);
  });

  // 7. spec-elements-in-acs (GAP → PORTED)
  test("spec-elements-in-acs: if specElements exist, at least one AC references them", () => {
    const specs = sf("sourceSpecs") || [];
    const elements = specs.flatMap((s: any) => s.specElements || []);
    if (elements.length === 0) return;
    const acsWithSpec = (sf("acs") || []).filter((ac: any) => ac.specElement);
    expect(acsWithSpec.length).toBeGreaterThan(0);
  });

  // 8. sizing-declared
  test("sizing-declared", () => {
    expect(sf("sizing")?.predicted).toBeDefined();
  });

  // 9. issue-goal-captured
  test("issue-goal-captured", () => {
    expect((sf("issueGoal") || "").length).toBeGreaterThan(0);
  });

  // 10. acs-no-skillmd-enforcement (GAP → PORTED)
  test("acs-no-skillmd-enforcement: no ACs target SKILL.md", () => {
    const pattern = /SKILL\.md/i;
    const hits = (sf("acs") || []).filter((ac: any) =>
      pattern.test(ac.statement || "") || pattern.test(ac.evidenceMethod?.command || "")
    );
    expect(hits.map((ac: any) => ac.id)).toEqual([]);
  });

  // ac-issue-alignment: ACs cover issueGoal keywords (ADR-009 C4)
  //
  // #423: stays a WARNING, and that is now a decision with a number behind it
  // rather than a deferral. Measured over the 153 workflow states under
  // `~/.rungate` carrying a goal, 71% fall under this threshold — 66% of the
  // 131 whose ACs carry real statements, 73% of the 101 with substantial ones.
  // A check that would refuse two runs in three is an outage, not a gate. The
  // reading moved to `goalKeywordCoverage` so the threshold and the vocabulary
  // can be driven from both sides by a test; what did NOT change is that
  // nothing here refuses.
  test("ac-issue-alignment: ACs cover goal keywords", () => {
    const read = goalKeywordCoverage(sf("issueGoal"), sf("acs"));
    if (read === null) return;
    if (read.coverage < GOAL_COVERAGE_WARN_BELOW) {
      console.warn(
        `WARN: ac-issue-alignment: only ${Math.round(read.coverage * 100)}% goal keyword coverage ` +
          `(${read.covered.length}/${read.keywords.length})`,
      );
    }
  });

  // 11. sourceSpecs-required (#473)
  test("sourceSpecs-required: non-LIGHT tier must have sourceSpecs", () => {
    const tier = sf("sizing.ceremonyTier");
    if (tier === "LIGHT") return;
    const specs = sf("sourceSpecs") || [];
    expect(specs.length, "STANDARD/THOROUGH tier must have at least one sourceSpec").toBeGreaterThanOrEqual(1);
  });

  // 11b. before-state-captured (#1411)
  test("before-state-captured: STANDARD+ must have beforeState in workflow-state", () => {
    const tier = sf("sizing.ceremonyTier");
    const VALID_TYPES = ["text", "screenshot", "api", "none"];
    const bs = sf("beforeState");
    if (!bs) {
      if (tier === "LIGHT") return;
      console.warn("WARN: before-state-captured: beforeState missing for STANDARD+ tier — goal skill should capture before-state (#1411)");
      return;
    }
    expect(VALID_TYPES.includes(bs.type), `beforeState.type must be text|screenshot|api|none, got "${bs.type}"`).toBe(true);
    if (tier !== "LIGHT" && bs.type === "none") {
      console.warn('WARN: before-state-captured: beforeState.type is "none" for STANDARD+ tier — consider capturing actual before-state');
    }
  });

  // 12. discovery-evidence (#473)
  test("discovery-evidence: non-LIGHT tiers have cited sourceSpecs", () => {
    const tier = sf("sizing.ceremonyTier");
    if (tier === "LIGHT") return;
    const specs = sf("sourceSpecs") || [];
    const cited = specs.filter((s: any) => s.citedInDiscovery);
    expect(cited.length, "No sourceSpecs with citedInDiscovery — DISCOVERY may have been skipped").toBeGreaterThanOrEqual(1);
  });

  // 13. governing-spec-exists (#473)
  test("governing-spec-exists: spec file exists on disk", () => {
    const tier = sf("sizing.ceremonyTier");
    if (tier === "LIGHT") return;
    const specs = sf("sourceSpecs") || [];
    if (specs.length === 0) return; // caught by sourceSpecs-required
    const specPath = specs[0].path;
    // #314 — the spec is resolved against the TREE UNDER TEST. A spec added on
    // the branch does not exist in the main checkout, so resolving against
    // projectRoot failed a run for writing its own governing spec; a spec
    // deleted on the branch still exists in main, so the same read passed a
    // run that had removed the thing it claimed to be governed by.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "governing-spec-exists");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    const resolved = specPath.startsWith("/") ? specPath : join(root!, specPath);
    expect(existsSync(resolved), `Governing spec not found: ${resolved}`).toBe(true);
  });

  // 14. harness-port-validation: rungate.json ports match Makefile
  test("harness-port-validation: dev/test/prod ports match Makefile", () => {
    // #314 — this check's SUBJECT is whether two files in the tree agree, so
    // it reads both from the tree under test. It is not a config read: a
    // branch that edits a port in either file would otherwise be graded
    // against the main checkout's copies, where the two already agree.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "harness-port-validation");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const projectRoot = treeRoot();
    if (!projectRoot) return;
    const harnessPath = join(projectRoot, ".claude", "rungate.json");
    const makefilePath = join(projectRoot, "Makefile");
    if (!existsSync(harnessPath) || !existsSync(makefilePath)) return;
    // Named treeHarness, not harness: `harness` means the loadProjectHarness()
    // result everywhere else in this file, and test/gate-optional-config-keys.test.ts
    // enumerates reads off it so no gate check can gate on an unexplained config
    // key. A second const with the same name reading a different file would be
    // invisible to that scan — which is how the scan was first written, and what
    // the security review on #315 caught.
    const treeHarness = JSON.parse(readFileSync(harnessPath, "utf-8"));
    const makefile = readFileSync(makefilePath, "utf-8");

    const warnings: string[] = [];

    // Check dev port — match PORT= in the dev-all/dev section of Makefile
    const devPort = treeHarness?.dev?.apiBase?.match(/:(\d+)/)?.[1];
    if (devPort) {
      const devSection = makefile.match(/dev.*environment[^]*?PORT=(\d+)/i);
      const makeDevPort = devSection?.[1];
      if (makeDevPort && devPort !== makeDevPort) {
        warnings.push(`dev.apiBase port ${devPort} != Makefile dev PORT ${makeDevPort}`);
      }
    }

    // Check prod port — match PORT= in container run commands
    const prodPort = treeHarness?.prod?.apiBase?.match(/:(\d+)/)?.[1];
    if (prodPort) {
      const makeProdPort = makefile.match(/-e PORT=(\d+)/)?.[1];
      if (makeProdPort && prodPort !== makeProdPort) {
        warnings.push(`prod.apiBase port ${prodPort} != Makefile container PORT ${makeProdPort}`);
      }
    }

    if (warnings.length > 0) {
      console.warn(`WARN: harness-port-validation: ${warnings.join("; ")}`);
    }
  });
});

// ═══ VERIFY CHECKS (16 functions) ═════════════════════════════════════
describe("verify checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 12. local-before-prod
  test("local-before-prod: local validated before prod rebuild", () => {
    const prodRebuild = sf("environments")?.prod?.rebuild;
    if (!prodRebuild || prodRebuild === "SKIP") return;
    const localApi = sf("environments")?.local?.api;
    const localTests = sf("environments")?.local?.tests;
    if (localApi !== "PASS" && localTests !== "PASS") {
      expect("prod deployed without local validation").toBe("local.api or local.tests = PASS first");
    }
  });

  // 13. container-has-fix — OCI label SHA comparison (#437)
  test("container-has-fix: container image SHA matches HEAD", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const prodRebuild = sf("environments")?.prod?.rebuild;
    // #314: the container SHA is compared against the tree under test's HEAD, not main's.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "container-has-fix");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    const containerName = harness?.prod?.containerName || harness?.prod?.imageName;
    if (!containerName) return;

    // #341: four early returns used to share one observable outcome — PASS.
    // Container absent, daemon down, no revision label, no runtime installed.
    // Two of them are MORE likely exactly when the check matters, so it was
    // quietest in the situation it exists to catch.
    //
    // Each is now a named outcome, recorded. Which of them should BLOCK is
    // #341 criterion 1's question — it needs the frequency of each measured on a
    // real consumer first, because refusing on a runtime that happens to be
    // down turns real runs red. Only a measured BEHIND blocks today, which
    // is what blocked before.
    const runtime = resolveContainerRuntime(
      harness?.prod?.containerRuntime,
      name => exec(`command -v ${name}`).ok,
    );
    // Argv form: containerName comes out of the consumer's rungate.json and
    // the old line interpolated it into a shell command (#315 security review).
    const inspect =
      runtime.kind === "resolved"
        ? execArgvOf(runtime.runtime, [
            "inspect",
            "--format={{index .Config.Labels \"org.opencontainers.image.revision\"}}",
            "--",
            containerName,
          ])
        : undefined;
    const head = exec("git rev-parse HEAD", root);

    const verdict = classifyContainerProvenance({
      runtime,
      containerName,
      // execArgvOf folds stderr into `output` on failure, which is the text
      // classifyInspectFailure needs to tell absence from a dead daemon.
      inspect: inspect ? { ok: inspect.ok, output: inspect.ok ? inspect.output : "", stderr: inspect.ok ? "" : inspect.output } : undefined,
      head: { ok: head.ok, output: head.output },
      prodRebuild,
    });

    // criterion 3: surfaced, not swallowed. One line per run naming which of the
    // outcomes was reached, so criterion 1's frequencies are collectable from the
    // logs of real runs rather than needing new instrumentation later.
    console.log(
      `container-has-fix: ${verdict.outcome} (${verdict.measured ? "measured" : "UNMEASURED"}) — ${verdict.detail}`,
    );

    const violations = containerProvenanceViolations(verdict);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 14. all-acs-have-evidence (GAP → PORTED)
  // OUTCOME ACs may not have mechanical evidence at ship time — verified at prove via Quinn
  test("all-acs-have-evidence: every AC has evidence in verify+", () => {
    if (!isVerifyPlus()) return;
    const missing = (sf("acs") || []).filter((ac: any) => ac.evidence == null && ac.type !== "OUTCOME");
    expect(missing.map((ac: any) => ac.id)).toEqual([]);
  });

  // 15. all-acs-pass
  // OUTCOME ACs may be PENDING at ship time — they require Quinn/prove for verification
  test("all-acs-pass: every AC has verdict in ship+", () => {
    if (!isShipPlus()) return;
    const noVerdict = (sf("acs") || []).filter((ac: any) => (!ac.verdict || ac.verdict === "PENDING") && ac.type !== "OUTCOME");
    expect(noVerdict.map((ac: any) => ac.id)).toEqual([]);
  });

  // 15b. outcome-acs-no-skip: OUTCOME ACs must be verified, not skipped (#90 RCA)
  test("outcome-acs-no-skip: OUTCOME ACs cannot have SKIP verdict at ship+", () => {
    if (!isShipPlus()) return;
    const skipped = (sf("acs") || []).filter((ac: any) => ac.type === "OUTCOME" && ac.verdict === "SKIP");
    expect(skipped.map((ac: any) => ac.id), "OUTCOME ACs require live verification — start dev server and run the feature (#90 RCA)").toEqual([]);
  });

  // 15c. outcome-evidence-behavioral: OUTCOME evidence is not just a grep count (#90 RCA)
  //
  // #423: this REFUSES now. It was `tsc-pass`'s shape — a name promising a
  // verdict over a body that could only `console.warn` — while its sibling
  // two tests above it has always asserted. An OUTCOME AC records that a
  // user-visible outcome was observed, and a bare number cannot establish
  // one; `0` is indistinguishable from success, which is the anti-pattern
  // `.claude/rules/config-access.md` names as Silent Default Substitution.
  test("outcome-evidence-behavioral: OUTCOME AC evidence is not just a number", () => {
    if (!isShipPlus()) return;
    const violations = outcomeEvidenceViolations(sf("acs"));
    expect(
      violations,
      "OUTCOME ACs need evidence a reader can check — a bare measurement says a number " +
        "was produced, not that the outcome happened (#90 RCA, #423)",
    ).toEqual([]);
  });

  // #339: renamed from the prose title "no FAIL verdicts in DONE". A gate
  // check with a prose name cannot be referenced from a ceremony profile at
  // all, so it was structurally undocumentable rather than merely
  // undocumented. Referenced by nothing else; the rename is local.
  test("no-fail-verdicts-in-done: no AC is FAIL once the run is DONE", () => {
    if (!isDone()) return;
    const fails = (sf("acs") || []).filter((ac: any) => ac.verdict === "FAIL");
    expect(fails.map((ac: any) => ac.id)).toEqual([]);
  });

  // 16. evidence-type-valid (GAP → PORTED)
  test("evidence-type-valid: evidence.type matches allowed enum", () => {
    if (!isVerifyPlus()) return;
    const VALID = ["file-citation", "grep-output", "api-response", "screenshot", "test-output", "command-output", "manual-attestation", "grep"];
    const bad = (sf("acs") || []).filter((ac: any) => {
      if (!ac.evidence || typeof ac.evidence !== "object") return false;
      return !VALID.includes(ac.evidence.type);
    });
    expect(bad.map((ac: any) => `${ac.id}: ${ac.evidence?.type}`)).toEqual([]);
  });

  // 17. evidence-type-ratio (GAP → PORTED, ADR-009 A5: >= 50% behavioral evidence required)
  test("evidence-type-ratio: <50% pattern-only evidence (ADR-009 A5)", () => {
    if (!isVerifyPlus()) return;
    const acs = (sf("acs") || []).filter((ac: any) => ac.evidenceMethod);
    if (acs.length === 0) return;
    const patternOnly = acs.filter((ac: any) => {
      const t = ac.evidenceMethod?.type;
      return !t || t === "pattern" || t === "GREP_CHECK" || t === "grep";
    });
    const ratio = patternOnly.length / acs.length;
    // ADR-009 A5: at least 50% behavioral evidence required
    expect(ratio, `${patternOnly.length}/${acs.length} (${Math.round(ratio * 100)}%) pattern-only — must be < 50% (ADR-009 A5)`).toBeLessThanOrEqual(0.5);
  });

  // 18. evidence-method-executed (GAP → PORTED)
  test("evidence-method-executed: ACs with a threshold have evidence recorded", () => {
    if (!isVerifyPlus()) return;
    const violations = missingEvidenceViolations(sf("acs"));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 19. threshold-crosscheck (GAP → PORTED)
  test("threshold-crosscheck: evidence values meet threshold", () => {
    if (!isVerifyPlus()) return;
    const violations = thresholdCrosscheckViolations(sf("acs"));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 20. tests-pass (GAP → PORTED)
  //
  // #224: run wf_7ac5f614-d21 returned `regressions: 0` on a branch running
  // 3984 pass / 1 fail. The suite reading and the verdict were not connected,
  // and an unmeasured suite read as a passing one. The conversion from reading
  // to refusal now lives in `suiteVerdictViolations` above — one function, one
  // body — so test/suite-binding-mutation.test.ts can remove it from a mutant
  // copy of this file and watch the mutant ship a fixture whose failing test
  // was really run. What was broken to prove it: short-circuiting that
  // function to `return []` turns the gate green on a measured FAIL.
  test("tests-pass: test suite passes", () => {
    if (!isVerifyPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.dev?.testCmd) return;
    // Both halves of one fact, read from one state (#530). The enum is what
    // this check has always read; the measurement is what produced it, and a
    // PASS with nothing behind it is the case the enum alone cannot see.
    const violations = suiteVerdictViolations(
      sf("environments")?.local?.tests,
      readSuiteMeasurement(loadRaw()),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 20b. evidence-prevalidation (#235)
  //
  // The pre-validator already dry-runs every AC evidence command and prints
  // which ones are broken. Nothing read that print. The conversion from
  // reading to refusal lives in `prevalidationViolations` above — one
  // function, one body — so test/suite-binding-mutation.test.ts can remove it
  // from a mutant copy of this file and watch the mutant ship a fixture whose
  // broken evidence command was really dry-run. What was broken to prove it:
  // short-circuiting `prevalidateEvidence` to `return []` makes the fixture
  // measure PASS, and short-circuiting this function makes the gate green on a
  // measured FAIL.
  test("evidence-prevalidation: AC evidence commands pre-validated before ship", () => {
    if (!isVerifyPlus()) return;
    // An AC with no evidence command has no command that can be broken, so a
    // run with none of them has nothing to pre-validate. That is a real early
    // return, like tsc-pass's missing tsconfig — not a fail-open, because the
    // pre-validator classifies exactly those ACs `skipped` itself.
    const acs = sf("acs") || [];
    if (!acs.some((ac: any) => ac?.evidenceMethod?.command)) return;
    const violations = prevalidationViolations(sf("evidencePrevalidation"), sf("phase"));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 21. tsc-pass (GAP → PORTED)
  //
  // #176: this was two early returns and an empty tail — no expect, no tsc
  // invocation, no baseline comparison. The second return read
  // `environments.local.tests` and bailed with a comment deferring to the
  // engineer, so the gate asked the agent it was gating whether it needed to
  // run. No gate defers to its subject. It now runs the
  // compiler and compares the count against the project's declared baseline.
  // What was broken to prove it fails: a project with one bad assignment and
  // `.claude/typecheck-baseline.json` at 0 — see
  // test/gate-vacuous-checks.test.ts, which plants exactly that and watches
  // this go red, then removes it and watches it go green.
  test("tsc-pass: no new TypeScript errors above baseline", () => {
    if (!isVerifyPlus()) return;
    // #314: the compiler runs on the TREE UNDER TEST. Running it in
    // projectRoot typechecked the main checkout, which passes by construction,
    // and let two real type errors through to CI on run wf_5cdce852-1e2.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "tsc-pass");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    // No tsconfig means there is nothing for tsc to check; that is a real
    // early return, not a skipped measurement.
    if (!root || !existsSync(join(root, "tsconfig.json"))) return;

    const baselineFile = join(root, ".claude", "typecheck-baseline.json");
    const baselineRaw = existsSync(baselineFile) ? readFileSync(baselineFile, "utf-8") : null;

    const run = spawnSync("bunx", ["tsc", "--noEmit"], {
      cwd: root,
      encoding: "utf-8",
      timeout: TYPECHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const failures = run.error
      ? [`could not run tsc: ${run.error.message}`]
      : typecheckFailures(
          { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` },
          baselineRaw,
        );
    expect(failures, failures.join("\n")).toEqual([]);
  });

  // 22. code-committed (GAP → PORTED)
  test("code-committed: no uncommitted changes in project", () => {
    if (!isShipPlus()) return;
    // #314: `git status` must run in the tree holding the work. In projectRoot
    // it inspected the main checkout, which is clean during a worktree run, so
    // this check — whose whole job is confirming the work is committed —
    // passed unconditionally on every run this repo has made.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "code-committed");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    // #315: an unset `codeCommittedPaths` used to early-return here, and
    // nothing authors that key, so this check had never run. The whole tree
    // is the default scope; a configured list is a narrowing, not a switch.
    const harness = loadProjectHarness();
    const paths: string[] = harness?.codeCommittedPaths || [];
    const configured = paths.length > 0;
    // Argv form: `paths` comes out of the consumer's own rungate.json and
    // `exec` goes through a shell. The old line interpolated it straight
    // into one.
    const result = execArgv(
      ["status", "--porcelain", ...(configured ? ["--", ...paths] : [])],
      root,
    );
    const violations = codeCommittedViolations(result, { configured, paths });
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 22b. worktree-repo (#414, follow-up to #218)
  test("worktree-repo: every worktree is a checkout of this run's repository", () => {
    if (!isShipPlus()) return;
    // The entries, not just `treeUnderTest`: a decomposed run has one
    // worktree per sub-issue and #218's incident was a SECOND agent landing
    // in the wrong checkout while the first was correct. Checking only the
    // tree under test would read the right answer off the wrong worktree.
    //
    // `treeUnderTest` is included because it is the tree every other check in
    // this file measures — if it is a worktree of another repository then
    // tsc-pass, code-committed and code-pushed all measured that repository,
    // and said PASS.
    const named = Array.isArray(sf("worktrees")) ? sf("worktrees") : [];
    const tree = sf("treeUnderTest");
    const entries = [
      ...(typeof tree === "string" && tree.trim() ? [{ path: tree }] : []),
      ...named,
    ];
    const violations = worktreeRepoViolations(entries, sf("repo"));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 23. code-pushed (GAP → PORTED)
  test("code-pushed: no unpushed commits", () => {
    if (!isShipPlus()) return;
    // #314: in projectRoot this asked whether `main` was ahead of its own
    // upstream, which it is not, so the answer was always 0. #174 filed the
    // same defect against this check independently.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "code-pushed");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    const count = exec("git rev-list --count @{upstream}..HEAD", root);
    const upstream = exec("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", root);
    const violations = unpushedViolations(count, upstream);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  // 25. local-api-validated (GAP → PORTED)
  test("local-api-validated: environments.local.api set", () => {
    if (!isVerifyPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.dev?.apiBase) return;
    const val = sf("environments")?.local?.api;
    if (!val) {
      expect("local.api not set").toBe("PASS or SKIP — required when dev.apiBase is configured");
    } else if (val === "SKIP") {
      // SKIP is allowed
    } else if (val !== "PASS") {
      expect(`api: ${val}`).toBe("PASS");
    }
  });

  // 26. local-ui-validated (GAP → PORTED)
  test("local-ui-validated: environments.local.ui set with skipReason", () => {
    if (!isVerifyPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.dev?.uiBase) return;
    const val = sf("environments")?.local?.ui;
    if (!val) {
      expect("local.ui not set").toBe("PASS or SKIP — required when dev.uiBase is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.local?.uiSkipReason;
      if (!reason) {
        expect("UI SKIP without reason").toBe("uiSkipReason required when SKIP");
      }
    } else if (val !== "PASS") {
      expect(`ui: ${val}`).toBe("PASS");
    }
  });

  // 29. quinn-on-ui-change
  test("quinn-on-ui-change: quinn spawned when UI files change", () => {
    if (!isShipPlus()) return;
    const tier = sf("sizing")?.ceremonyTier;
    if (tier === "LIGHT") return;
    const UI_EXT = /\.(tsx|jsx|css|scss|html|svg|less)$/i;
    const UI_SVC = /template|campaign-html|brief-pipeline|email-template|dashboard/i;
    const allPaths: string[] = [];
    for (const ac of sf("acs") || []) {
      if (ac.statement) allPaths.push(ac.statement);
      if (ac.evidenceMethod?.command) allPaths.push(ac.evidenceMethod.command);
      for (const cf of ac.contextFiles || []) {
        if (cf?.path) allPaths.push(cf.path);
      }
    }
    // Strip absolute project paths to avoid false positives (e.g. /DailyBriefDashboard/ matching "dashboard")
    //
    // #314 — BOTH roots, not just projectRoot. The AC paths this reads are
    // written while the run is in a worktree, so they carry the tree-under-test
    // path; stripping only projectRoot left that path in the string and handed
    // the UI_SVC regex the directory name it exists to not match. This is the
    // one site that legitimately wants projectRoot alongside the tree, because
    // it is sanitising text rather than measuring a tree.
    const joined = [sf("projectRoot"), sf("treeUnderTest")]
      .filter((r): r is string => typeof r === "string" && r !== "")
      .reduce((text, root) => text.replaceAll(root, ""), allPaths.join(" "));
    if (!UI_EXT.test(joined) && !UI_SVC.test(joined)) return;
    const quinn = sf("agents")?.quinn;
    if (!quinn?.spawned) {
      expect("quinn not spawned for UI change").toBe("quinn.spawned required");
    }
    // Quinn depth check: spawned but no testedPaths = code review only (ADR-009 A3)
    // If Quinn has verdict PASS, accept that as sufficient evidence (ship.js doesn't write testedPaths yet)
    if (quinn?.spawned && quinn.verdict !== 'PASS') {
      const testedPaths = quinn.testedPaths;
      expect(Array.isArray(testedPaths) && testedPaths.length > 0, "quinn.testedPaths must not be empty — code review only does not satisfy UI testing (ADR-009 A3)").toBe(true);
    }
    // Quinn screenshot check: WARN when verdict=PASS but no screenshots (ship.js Quinn doesn't capture yet)
    if (quinn?.spawned && quinn.verdict !== 'PASS') {
      const screenshots = quinn.screenshots || [];
      const hasRealScreenshots = screenshots.length > 0 && screenshots.some((s: string) => existsSync(s));
      if (!hasRealScreenshots) {
        expect("quinn.screenshots empty or files missing").toBe("at least 1 screenshot file on disk — browser verification required for UI changes (#90 RCA)");
      }
    }
  });

  // quinn-container-port: Quinn must test the CONTAINER, not the dev server (#1371)
  //
  // #344: this compared against a literal 7776 — one consumer's container
  // port. Every other consumer got a warning saying their correct port was
  // the wrong one, naming a port they do not run. The expected port comes
  // from `container.port`, which was already a declared schema key, and with
  // none configured the check says it could not look rather than inventing a
  // number to disagree with.
  //
  // Still a warning rather than a failure, deliberately and not by oversight:
  // turning it into a refusal changes what blocks live runs and needs its own
  // measurement. What is fixed here is that it stops being wrong.
  test("quinn-container-port: Quinn tested the container, not the dev server", () => {
    const quinn = sf("agents")?.quinn;
    if (!quinn?.spawned) return;
    const agentPort = quinn.port;
    const envPort = sf("environments")?.local?.quinn?.port;
    const port = agentPort || envPort;
    if (!port) {
      console.warn("WARN: quinn-container-port: no port recorded in quinn agent data — cannot verify container testing");
      return;
    }
    // Bound to `harness`, not to a name of its own: #315's key registry only
    // sees reads off a binding called `harness`, so `const expected =
    // loadProjectHarness()?...` would have been a config key the registry
    // could not account for. Its guard caught this on the first run.
    const harness = loadProjectHarness();
    const expected = harness?.container?.port;
    if (!expected) {
      console.warn(
        "WARN: quinn-container-port: the project sets no `container.port`, so whether Quinn " +
          `tested the container could not be determined (it used :${port}). UNMEASURED, not PASS.`,
      );
      return;
    }
    if (port !== expected) {
      console.warn(
        `WARN: quinn-container-port: Quinn tested on port ${port}, expected ${expected} ` +
          `(container.port). Testing the dev server does not validate container behavior.`,
      );
    }
  });

  // brief-ac-alignment: Marcus brief contains all AC ids (ADR-009 C2)
  test("brief-ac-alignment: brief covers all ACs", () => {
    if (!isVerifyPlus()) return;
    const slug = sf("slug");
    if (!slug) return;
    const briefPath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "marcus-brief.md");
    if (!existsSync(briefPath)) {
      // Brief file must exist for STANDARD+ tiers when marcus was spawned
      const marcus = sf("agents")?.marcus;
      if (marcus?.spawned) {
        expect("marcus-brief.md missing").toBe("brief file required when Marcus spawned (ADR-009 C2)");
      }
      return;
    }
    const brief = readFileSync(briefPath, "utf-8");
    const acs = sf("acs") || [];
    const missingIds = acs
      .map((ac: any) => ac.id)
      .filter((id: string) => !brief.includes(id));
    expect(missingIds, `brief-ac-alignment: brief missing AC ids: ${missingIds.join(", ")}`).toEqual([]);
  });

  // ac-spec-traceability (#440)
  test("ac-spec-traceability: AC specElements exist in governing spec", () => {
    if (!isVerifyPlus()) return;
    const specPath = sf("governingSpec")?.path;
    if (!specPath || !existsSync(specPath)) return;
    const specContent = readFileSync(specPath, "utf-8");
    const missing: string[] = [];
    for (const ac of sf("acs") || []) {
      if (!ac.specElement) continue;
      if (!specContent.includes(ac.specElement)) {
        missing.push(`${ac.id}: specElement "${ac.specElement}" not found in spec`);
      }
    }
    expect(missing).toEqual([]);
  });

  // 28. marcus-committed (GAP → PORTED)
  test("marcus-committed: no uncommitted Marcus changes", () => {
    if (!isVerifyPlus()) return;
    const signalDir = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), "signals");
    const slug = sf("slug") || "";
    const signalFile = join(signalDir, `marcus-uncommitted-${slug.replace(/\//g, "-")}`);
    if (existsSync(signalFile)) {
      expect("marcus left uncommitted files").toBe("marcus committed all changes");
    }
  });

  // prove-evidence-type: UI changes require screenshot/api-response evidence (ADR-009 A4)
  test("prove-evidence-type: UI changes require live evidence", () => {
    if (!isVerifyPlus()) return;
    // #314: the changed-file list comes from the branch's history, not main's.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "prove-evidence-type");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    const scopeSha = sf("gates")?.scope?.commitSha;
    if (!scopeSha) return;
    // #531: branch-relative, and an unusable diff says so rather than
    // reading as "nothing changed".
    const changed = readBranchDiff(scopeSha, a => execArgvOf("git", a, root), "prove-evidence-type");
    if (changed.files === null) { console.warn(`WARN: ${changed.reason}`); return; }
    const UI_EXT = /\.(tsx|jsx|css|scss|html|svg|less)$/i;
    const uiChanged = changed.files.filter(f => UI_EXT.test(f));
    if (uiChanged.length === 0) return;
    const slug = sf("slug");
    if (!slug) return;
    const evidencePath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "prove-evidence.json");
    if (!existsSync(evidencePath)) return;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    const afterType = evidence.afterEvidence?.type;
    const VALID_UI_EVIDENCE = ["screenshot", "api-response"];
    expect(afterType, "afterEvidence.type required for UI changes (ADR-009 A4)").toBeTruthy();
    expect(VALID_UI_EVIDENCE.includes(afterType), `afterEvidence.type must be screenshot or api-response for UI changes, got "${afterType}" (ADR-009 A4)`).toBe(true);
  });

  // acHash consistency: verify gate checks scope's AC hash (ADR-009)
  // Hash auto-recomputed by writeWorkflowState on authorized modifications (#43)
  test("acHash-consistency-verify: ACs unchanged since scope", () => {
    if (!isVerifyPlus()) return;
    const acHash = sf("gates")?.scope?.acHash;
    if (!acHash) return;
    const acDefs = (sf("acs") || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const currentHash = require("crypto").createHash("sha256").update(JSON.stringify(acDefs)).digest("hex");
    if (currentHash !== acHash) {
      // Log field-level diff for diagnosis before failing
      const { diffAcHashFields } = require("./orchestrator");
      const diff = diffAcHashFields(acDefs, (sf("acs") || []));
      console.error(`acHash field diff: ${JSON.stringify(diff.changedFields)}`);
    }
    expect(currentHash).toBe(acHash);
  });

  // spec-decision-compliance (#409, Decision #9: WARN tier — console.warn only, no expect failures)
  test("spec-decision-compliance: AC language aligns with spec decisions", () => {
    if (!isVerifyPlus()) return;
    const localPolicies = join(__dirname, "spec-policies.json");
    const homePolicies = join(process.env.HOME || "", ".claude", "skills", "ship", "spec-policies.json");
    const policiesPath = existsSync(localPolicies) ? localPolicies : homePolicies;
    if (!existsSync(policiesPath)) return;
    const policies = JSON.parse(readFileSync(policiesPath, "utf-8"));
    const patterns = policies.implementationPatterns;
    if (!patterns) return;
    const acs = sf("acs") || [];
    let warnCount = 0;
    for (const [key, rule] of Object.entries(patterns) as [string, any][]) {
      if (!rule.antiPatterns || !rule.decision) continue;
      const scopes: string[] = rule.scope || ["statement"];
      for (const ac of acs) {
        for (const scope of scopes) {
          const text = scope === "statement" ? (ac.statement || "") : (ac.evidenceMethod?.command || "");
          if (!text) continue;
          for (const ap of rule.antiPatterns) {
            if (new RegExp(ap, "i").test(text)) {
              console.warn(`WARN: spec-decision-compliance [${key}]: AC "${ac.id}" matches anti-pattern "${ap}" — ${rule.message}`);
              warnCount++;
            }
          }
        }
      }
    }
    if (warnCount > 0) {
      console.warn(`WARN: spec-decision-compliance: ${warnCount} anti-pattern match(es) found — review recommended`);
    }
  });

  // contextual-skip-validation (#91 → ADR-009 A1: SKIP → FAIL for file-matched gates)
  test("contextual-skip-validation: SKIP blocked when changed files require gate", () => {
    if (!isVerifyPlus()) return;
    // #314: the changed-file list comes from the branch's history, not main's.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "contextual-skip-validation");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    const scopeSha = sf("gates")?.scope?.commitSha;
    if (!scopeSha) return;
    // #531: branch-relative, and an unusable diff is UNMEASURED rather than
    // "no changed files — silently return", which is what the previous line
    // said and which waves every file-matched gate below through.
    const changed = readBranchDiff(scopeSha, a => execArgvOf("git", a, root), "contextual-skip-validation");
    if (changed.files === null) { console.warn(`WARN: ${changed.reason}`); return; }

    const FILE_GATE_MAP: Record<string, string[]> = {
      "tsx|jsx": ["local-ui-validated", "quinn-on-ui-change"],
      "css|scss|less|html|svg": ["local-ui-validated"],
      "sql|migration": ["local-api-validated"],
      "Dockerfile|docker-compose|Makefile": ["prod-rebuild-pass"],
    };

    const ENV_GATE_PATH: Record<string, string> = {
      "local-ui-validated": "environments.local.ui",
      "local-api-validated": "environments.local.api",
      "quinn-on-ui-change": "agents.quinn.spawned",
      "prod-rebuild-pass": "environments.prod.rebuild",
    };

    const changedFiles = changed.files;
    let warnCount = 0;
    for (const file of changedFiles) {
      for (const [extPattern, gates] of Object.entries(FILE_GATE_MAP)) {
        const re = new RegExp(`\\.(${extPattern})$`, "i");
        const nameRe = new RegExp(`(${extPattern})`, "i");
        if (!re.test(file) && !nameRe.test(file.split("/").pop() || "")) continue;
        for (const gate of gates) {
          const envPath = ENV_GATE_PATH[gate];
          if (!envPath) continue;
          const val = sf(envPath);
          if (val === "SKIP") {
            expect(`contextual-skip-blocked: "${file}" changed but ${gate} is SKIP`).toBe("gate must not be SKIP when matched files changed (ADR-009 A1)");
            warnCount++;
          }
        }
      }
    }
    if (warnCount > 0) {
      expect(`contextual-skip-validation: ${warnCount} SKIP(s) on file-matched gates`).toBe("contextual-skip-validation: 0 SKIPs (ADR-009 A1)");
    }
  });
});

// ═══ B1/B2 AGENT RESULTS (#1406, #1407) ═════════════════════════════
describe("B1/B2 agent results", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // B2: Evidence Validator prompt file exists
  test("b2-prompt-exists: evidence-validator.md available", () => {
    const promptPath = join(__dirname, "prompts", "evidence-validator.md");
    expect(
      existsSync(promptPath),
      "evidence-validator.md prompt not found in gates/prompts/",
    ).toBe(true);
  });

  // B1: AC Adversary prompt file exists
  test("b1-prompt-exists: ac-adversary.md available", () => {
    const promptPath = join(__dirname, "prompts", "ac-adversary.md");
    expect(
      existsSync(promptPath),
      "ac-adversary.md prompt not found in gates/prompts/",
    ).toBe(true);
  });

  // B2: the evidence validator ran, and left something readable (#126)
  //
  // isShipPlus, NOT isVerifyPlus, and the contract fixtures are what found it.
  // gate-executor runs this suite (`runGateTests`) and only THEN spawns the
  // fan-out and persists its slots — so at the verify gate the slot cannot yet
  // exist, and a check that refuses its absence refuses every first attempt.
  // That is the original circularity with the sign flipped: the gate failing
  // on the fan-out's absence is what skips the fan-out.
  //
  // Verify cannot verify its own not-yet-produced output. Ship can: by then
  // the fan-out has either run or recorded why it did not, and refusing here
  // still blocks the PR, which is the only thing the refusal needed to do.
  test("b2-evidence-validator-structure: results valid when populated", () => {
    if (!isShipPlus()) return;
    const tier = sf("sizing")?.ceremonyTier;
    const ev = sf("gates.verify.evidenceValidator");
    const violations = verifyFanoutViolations("evidenceValidator", ev, tier);
    expect(violations, violations.join("\n")).toEqual([]);
    // Nothing further to validate when the absence was legitimate: a LIGHT run
    // or a recorded skip has no verdicts, by construction.
    if (!ev || (ev as { skipped?: unknown }).skipped !== undefined) return;
    expect(ev.ts, "evidenceValidator.ts must be an ISO timestamp").toBeTruthy();
    expect(Array.isArray(ev.verdicts), "evidenceValidator.verdicts must be an array").toBe(true);
  });

  // B1: the AC adversary ran, and left something readable (#126)
  // isShipPlus for the reason spelled out above B2.
  test("b1-adversary-verify-structure: results valid when populated", () => {
    if (!isShipPlus()) return;
    const tier = sf("sizing")?.ceremonyTier;
    const adv = sf("gates.verify.adversary");
    const violations = verifyFanoutViolations("adversary", adv, tier);
    expect(violations, violations.join("\n")).toEqual([]);
    if (!adv || (adv as { skipped?: unknown }).skipped !== undefined) return;
    expect(adv.ts, "adversary.ts must be an ISO timestamp").toBeTruthy();
    expect(typeof adv.gameable, "adversary.gameable must be a number").toBe("number");
    expect(typeof adv.approved, "adversary.approved must be a boolean").toBe("boolean");
  });
});

// ═══ SPEC TRACEABILITY (2 functions) ══════════════════════════════════
describe("spec traceability", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 31. decision-id-valid (GAP → PORTED)
  test("decision-id-valid: D-NNN IDs in ACs exist in governing spec", () => {
    const specPath = sf("sourceSpecs")?.[0]?.path || sf("governingSpec")?.path;
    if (!specPath || !existsSync(specPath)) return;
    const spec = readFileSync(specPath, "utf-8");
    const ids = new Set<string>();
    for (const ac of sf("acs") || []) {
      const matches = (ac.statement || "").match(/D-\d+/g) || [];
      matches.forEach((id: string) => ids.add(id));
    }
    if (ids.size === 0) return;
    const missing = [...ids].filter(id => !spec.includes(id));
    expect(missing).toEqual([]);
  });

  // 32. evidence-target-valid (GAP → PORTED)
  //
  // #315 found this one while fixing `code-committed`, and it is worse than
  // the defect it was filed for. It read the same unauthored
  // `codeCommittedPaths` key and early-returned — but even past that return
  // it computed an `outside` list and **discarded it**, under a comment
  // saying outside refs are common. It has no assertion. It is a name in the
  // gate list and nothing else, and it cannot fail for any input.
  //
  // Deleted rather than left standing, because a check that asserts nothing
  // reads as coverage in every report that counts gate checks. The threshold
  // it would need — which evidence file references count as out of scope —
  // does not exist yet and inventing one here would be a guess that goes red
  // on every run. It is recorded in OPTIONAL_HARNESS_KEYS in
  // test/gate-optional-config-keys.test.ts so it cannot be quietly re-added,
  // and #338 tracks building it with a threshold that has evidence behind it.
  //
  // #338 measured it, and the original name does not survive the
  // measurement. Across 82 completed runs, 278 of 542 classifiable evidence
  // file references fall OUTSIDE the AC's own contextFiles, and the largest
  // category is the test file that proves the AC. "Within scope" is not a
  // property real runs have, so no threshold for it exists to state.
  //
  // What the same measurement did find is below: 11.1% of evidence commands
  // cannot run anywhere but the machine that wrote them.

  // 32. evidence-portable (#338 — replaces evidence-target-valid)
  test("evidence-portable: no evidence command is pinned to one machine", () => {
    if (!isVerifyPlus()) return;
    const violations = evidencePortabilityViolations(sf("acs"));
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

// ═══ SHIP CHECKS (7 functions) ════════════════════════════════════════
describe("ship checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 35. all-gates-pass (GAP → PORTED)
  test("all-gates-pass: scope + verify gates PASS", () => {
    if (!isShipPlus()) return;
    const scope = sf("gates")?.scope?.result;
    const verify = sf("gates")?.verify?.result;
    if (scope && scope !== "PASS") {
      expect(`scope gate: ${scope}`).toBe("PASS");
    }
    if (verify && verify !== "PASS") {
      expect(`verify gate: ${verify}`).toBe("PASS");
    }
  });

  // 36. branch-merged / code-pushed (GAP → PORTED)
  // Ship gate: code pushed + PR exists = PASS (merge is post-ship, verified at prove)
  // Prove gate: merged to main = PASS
  test("branch-merged: fix is on main", () => {
    if (!isShipPlus()) return;
    // #314: `git branch --contains HEAD` must ask about the branch's HEAD.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "branch-merged");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    const gate = process.env.GATE || "";
    if (gate === "ship") {
      // At ship gate: check code is pushed, not merged
      const commit = sf("buildCommit");
      const agents = sf("agents");
      const pushed = agents?.marcus?.branch;
      if (!commit && !pushed) {
        expect("no commit or branch").toBe("buildCommit or marcus.branch required at ship gate");
      }
      return;
    }
    // At prove gate or verify: check merged to main
    const result = exec("git branch --contains HEAD --list main", root);
    if (result.ok && !result.output.includes("main")) {
      expect("not on main").toBe("merged to main");
    }
  });

  // 38. prod-rebuild-pass (GAP → PORTED)
  test("prod-rebuild-pass: prod rebuild required when configured", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const val = sf("environments")?.prod?.rebuild;
    if (!val) {
      expect("prod.rebuild not set").toBe("PASS or SKIP with reason — required when prod.rebuild is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.prod?.rebuildSkipReason;
      if (!reason) expect("rebuild SKIP without reason").toBe("rebuildSkipReason required");
    } else if (val !== "PASS") {
      expect(`prod rebuild: ${val}`).toBe("PASS or SKIP with reason");
    }
  });

  // 39. prod-smoke-pass (GAP → PORTED)
  test("prod-smoke-pass: prod smoke required when configured", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.smokeTest) return;
    const val = sf("environments")?.prod?.smoke;
    if (!val) {
      expect("prod.smoke not set").toBe("PASS or SKIP with reason — required when prod.smokeTest is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.prod?.smokeSkipReason;
      if (!reason) expect("smoke SKIP without reason").toBe("smokeSkipReason required");
    } else if (val !== "PASS") {
      expect(`prod smoke: ${val}`).toBe("PASS or SKIP with reason");
    }
  });

  // 40. prod-quinn-pass (GAP → PORTED)
  test("prod-quinn-pass: prod quinn required when prod configured", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const val = sf("environments")?.prod?.quinn;
    if (!val) {
      expect("prod.quinn not set").toBe("PASS or SKIP with reason — required when prod.rebuild is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.prod?.quinnSkipReason;
      if (!reason) expect("quinn SKIP without reason").toBe("quinnSkipReason required");
    } else if (val !== "PASS") {
      expect(`prod quinn: ${val}`).toBe("PASS or SKIP with reason");
    }
  });

  // quinn-tested-changed-files (#441)
  test("quinn-tested-changed-files: Quinn tested paths cover UI diffs", () => {
    if (!isShipPlus()) return;
    // #314: the changed-file list comes from the branch's history, not main's.
    const treeViolations = treeUnderTestViolations(sf("treeUnderTest"), "quinn-tested-changed-files");
    expect(treeViolations, treeViolations.join("\n")).toEqual([]);
    const root = treeRoot();
    if (!root) return;
    const scopeSha = sf("gates")?.scope?.commitSha;
    if (!scopeSha) return;
    // #531: branch-relative. This is the check that refused on seven `.tsx`
    // files the branch has never contained.
    const changed = readBranchDiff(scopeSha, a => execArgvOf("git", a, root), "quinn-tested-changed-files");
    if (changed.files === null) { console.warn(`WARN: ${changed.reason}`); return; }
    const UI_EXT = /\.(tsx|jsx|css|scss|html|svg|less)$/i;
    const uiChanged = changed.files.filter(f => UI_EXT.test(f));
    if (uiChanged.length === 0) return;
    const testedPaths = sf("agents")?.quinn?.testedPaths || [];
    if (testedPaths.length === 0) {
      expect(`${uiChanged.length} UI files changed but quinn.testedPaths empty`).toBe("quinn.testedPaths populated");
    }
  });

  // 42. verify-blockers-cleared
  test("verify-blockers-cleared: all Quinn-found bugs re-verified", () => {
    if (!isShipPlus()) return;
    const blockers = sf("verifyBlockers") || [];
    const unresolved = blockers.filter((b: any) => !b.quinnReverified);
    expect(unresolved.map((b: any) => b.id)).toEqual([]);
  });

  // 41. prod-quinn-spot (GAP → PORTED)
  test("prod-quinn-spot: spot check PASS or inherited from full quinn", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const quinn = sf("environments")?.prod?.quinn;
    const spot = sf("environments")?.prod?.quinnSpot;
    if (quinn === "PASS" || spot === "PASS") return; // either is fine
    if (spot === "SKIP") {
      const reason = sf("environments")?.prod?.quinnSpotSkipReason;
      if (!reason) expect("quinnSpot SKIP without reason").toBe("quinnSpotSkipReason required");
    }
  });

  // 43. witness-chain (#473)
  test("witness-chain: witness directory has gate artifacts", () => {
    if (!isShipPlus()) return;
    const slug = sf("slug");
    if (!slug) return;
    const witnessDir = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "witnesses");
    if (!existsSync(witnessDir)) {
      // WARN — witnesses are new, not all workflows have them yet
      console.warn("WARN: No witness directory found — witness chain not verified");
      return;
    }
    const witnesses = readdirSync(witnessDir).filter(f => f.endsWith(".json"));
    expect(witnesses.length, "Witness directory exists but is empty").toBeGreaterThan(0);
  });

  // 44. witness-ac-verdict: AC PASS verdicts must have corresponding witness chain entry (#521)
  test("witness-ac-verdict: AC PASS verdicts have matching witness with valid HMAC", () => {
    if (!isShipPlus()) return;
    const slug = sf("slug");
    if (!slug) return;
    const witnessDir = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "witnesses");
    if (!existsSync(witnessDir)) {
      // No witnesses = cannot verify AC verdicts were set by gate system
      const passACs = (sf("acs") || []).filter((ac: any) => ac.verdict === "PASS");
      if (passACs.length > 0) {
        expect(
          `${passACs.length} AC(s) have PASS verdict but no witness directory exists`,
        ).toBe("witness directory required when ACs have PASS verdicts (#521 — prevents manual workflow-state.json edits)");
      }
      return;
    }
    const witnessFiles = readdirSync(witnessDir).filter(f => f.endsWith(".json"));
    // Load all witness records
    const witnesses: Array<{ gate: string; result: string; hmac: string; [k: string]: any }> = [];
    for (const wf of witnessFiles) {
      try {
        const record = JSON.parse(readFileSync(join(witnessDir, wf), "utf-8"));
        witnesses.push(record);
      } catch { /* skip unparseable */ }
    }
    // Build set of gates that have PASS witnesses with HMAC
    const passedGatesWithHmac = new Set(
      witnesses
        .filter(w => w.result === "PASS" && w.hmac && w.hmac.length > 0)
        .map(w => w.gate),
    );
    // Each AC with PASS verdict must be backed by a prior gate witness
    // The verify gate covers AC evidence checks; scope gate covers AC definition
    // Ship witness is written AFTER this test suite — requiring it here is circular
    // Scope is skipped for LIGHT ceremony tier — only require its witness if it ran
    const scopeRan = sf("gates")?.scope?.ts;
    const requiredGates = scopeRan ? ["scope", "verify"] : ["verify"];
    const missingGates = requiredGates.filter(g => !passedGatesWithHmac.has(g));
    const passACs = (sf("acs") || []).filter((ac: any) => ac.verdict === "PASS");
    if (passACs.length > 0 && missingGates.length > 0) {
      expect(
        `AC PASS verdicts present but missing witness for: ${missingGates.join(", ")}`,
      ).toBe("PASS witnesses with valid HMAC required for verify + ship gates (#521 — manual edits detected)");
    }
  });

  // pre-registration: ACs must predate fix (ADR-009 A2)
  test("pre-registration: scope precedes ship", () => {
    if (!isShipPlus()) return;
    const scopeTs = sf("gates")?.scope?.ts;
    if (!scopeTs) return; // LIGHT tier or pre-ADR-009 — scope gate not run
    const scopeTime = new Date(scopeTs).getTime();
    expect(scopeTime, "scope timestamp must be in the past (ADR-009 A2: pre-registration)").toBeLessThan(Date.now());
    const shipTs = sf("gates")?.ship?.ts;
    if (shipTs) {
      expect(scopeTime, "scope must predate ship (ADR-009 A2: pre-registration)").toBeLessThanOrEqual(new Date(shipTs).getTime());
    }
  });

  // acHash consistency: ship gate checks scope's AC hash (ADR-009)
  // Restored to FAIL: writeWorkflowState now recomputes acHash on authorized modifications,
  // so mismatches indicate unauthorized tampering, not heal agent updates (#43)
  test("acHash-consistency-ship: ACs unchanged since scope", () => {
    if (!isShipPlus()) return;
    const acHash = sf("gates")?.scope?.acHash;
    if (!acHash) return;
    const acDefs = (sf("acs") || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const currentHash = require("crypto").createHash("sha256").update(JSON.stringify(acDefs)).digest("hex");
    if (currentHash !== acHash) {
      // Log field-level diff for diagnosis before failing
      const { diffAcHashFields } = require("./orchestrator");
      const scopeAcDefs = acDefs; // current defs — scope defs are lost, but hash mismatch means they differ
      const diff = diffAcHashFields(acDefs, (sf("acs") || []));
      console.error(`acHash field diff: ${JSON.stringify(diff.changedFields)}`);
    }
    expect(currentHash).toBe(acHash);
  });

  // prove-label-enforcement: needs-prove label must have matching proven label (#1390)
  //
  // The labels come from Octokit, not from a GitHub CLI subprocess (#395).
  // The old call interpolated `issue` and `issueRepo` — both out of workflow
  // state — into a shell command string, and needed `gh` installed and
  // authenticated in whatever tree the gate ran in. `getIssueLabels` takes
  // them as arguments, so no shell parses them.
  //
  // The decision is `proveLabelViolation` and lives in lib/, because it was
  // entangled with the transport and therefore untestable: nothing could
  // exercise the rule without a network and a `gh` binary, so nothing did,
  // and SC-502 was ticked over the subprocess for its whole life.
  test("prove-label-enforcement: needs-prove requires proven label", async () => {
    if (!isShipPlus()) return;
    const issueNumber = sf("issue");
    const issueRepo = sf("issueRepo") || sf("repo");
    if (!issueNumber || !issueRepo) return;

    // #405 — the fail-open is gone. This used to be `catch { return }`, so a
    // missing token, a rate limit, a network blip and a typo'd repo slug all
    // landed in one place and the gate reported clean: "no blocking label"
    // and "could not find out" were the same outcome.
    //
    // `proveLabelGateVerdict` owns the three-way decision and the reasoning
    // behind the token-less case. The read is the only thing left here,
    // because a decision entangled with its transport is a decision nobody
    // tests — the lesson that produced `proveLabelViolation` in the first
    // place.
    const { createGitHubClient, getIssueLabels, resolveGitHubToken } = require("../lib/github");
    const tokenPresent = Boolean(resolveGitHubToken());
    let read: LabelRead;
    try {
      read = {
        labels: await getIssueLabels(createGitHubClient(), issueRepo, Number(issueNumber)),
        tokenPresent,
      };
    } catch (e) {
      read = { error: e, tokenPresent };
    }

    const outcome = proveLabelGateVerdict(read);
    if (outcome.verdict === "UNMEASURED") {
      // Reported, not swallowed. `SKIP` is indistinguishable from success and
      // `UNMEASURED` is not (`.claude/rules/config-access.md`).
      console.error(`PROVE_LABEL_UNMEASURED: ${outcome.message}`);
      return;
    }
    expect(outcome.verdict, outcome.message ?? undefined).toBe("ALLOW");
  });
});

// ═══ PROMPT IMMUTABILITY (#1409, ADR-009) ════════════════════════════
//
// This asserted the macOS `uchg` flag via `ls -lO`, and was broken in both
// directions at once (#92).
//
// It failed OPEN on CI, which is the only place it runs. `ls -lO` is BSD; the
// workflows are ubuntu-latest, where GNU coreutils rejects -O and exits 2. The
// check read `if (result.ok && !output.includes("uchg"))`, so a non-zero exit
// skipped the body, the unlocked list stayed empty, and the test passed. Every
// green CI run in this repo's history passed it without evaluating a file.
//
// It failed CLOSED anywhere it would have worked. chflags is filesystem
// metadata and git does not track it, so a fresh clone or `git worktree add`
// starts with no flags — confirmed by a second session seeing 0 of 3 flagged
// in its worktree against 3 of 3 in the primary checkout at the same commit.
// It failed hardest for a developer doing what the harness tells them to do.
//
// And the remedy it printed, `gates/lock-prompts.sh`, does not exist. Nothing
// in the repo calls chflags at all: the check asserted a property the project
// had no mechanism to establish.
//
// What it actually wants is that the prompts have not been modified. That is
// content, git already tracks it, and it means the same thing on every
// platform and in every checkout.
// A diff against HEAD alone is not enough, and it is worth being explicit
// about why rather than shipping the obvious fix. In CI the working tree IS
// HEAD, so `git diff HEAD` is empty by construction and the check could never
// fail in the one place it runs — the same vacuity, rebuilt. The committed
// checksum baseline is what makes it meaningful there: editing a prompt
// without deliberately updating gates/prompts.sha256 fails on CI, and updating
// the baseline is a reviewable line in the diff. That is also the mechanism
// the old check never had — a way to establish the property, not just assert
// it.
//
// Both checks are kept. The baseline catches committed drift anywhere; the
// HEAD diff catches local tampering before it is ever committed.
describe("prompt immutability", () => {
  const promptDir = join(__dirname, "prompts");
  const baselinePath = join(__dirname, "prompts.sha256");

  test("prompt-immutability: prompt files match the committed checksum baseline", () => {
    if (!existsSync(promptDir)) return;
    const prompts = readdirSync(promptDir).filter(f => f.endsWith(".md")).sort();
    if (prompts.length === 0) return;

    expect(existsSync(baselinePath), `missing ${baselinePath} — the baseline IS the immutability record`).toBe(true);

    const baseline = new Map<string, string>();
    for (const line of readFileSync(baselinePath, "utf-8").split("\n")) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
      if (m) baseline.set(m[2], m[1]);
    }
    // A baseline that parsed to nothing would make every comparison below
    // vacuous, so reject it rather than report success.
    expect(baseline.size, `${baselinePath} contains no usable checksum lines`).toBeGreaterThan(0);

    const drifted: string[] = [];
    for (const f of prompts) {
      const want = baseline.get(f);
      const got = createHash("sha256").update(readFileSync(join(promptDir, f))).digest("hex");
      if (want !== got) drifted.push(f);
    }
    // A prompt added without a baseline entry is drift too — otherwise the
    // way to evade the check is to add a file rather than edit one.
    for (const f of baseline.keys()) {
      if (!prompts.includes(f)) drifted.push(`${f} (in baseline, missing on disk)`);
    }

    expect(
      drifted,
      `Prompt files are immutable (#1409, ADR-009). If a change is intended, update gates/prompts.sha256 in the same commit so it shows up in review.`,
    ).toEqual([]);
  });

  test("prompt-immutability: prompt files are unmodified against HEAD", () => {
    if (!existsSync(promptDir)) return;
    const prompts = readdirSync(promptDir).filter(f => f.endsWith(".md"));
    if (prompts.length === 0) return;

    const repoRoot = join(__dirname, "..");
    const rel = "gates/prompts";
    const result = exec(`git -C "${repoRoot}" diff --name-only HEAD -- "${rel}"`);

    // Fail closed. The predecessor treated a failed command as "nothing to
    // report", which is precisely how it passed vacuously for its whole life.
    expect(result.ok, `could not diff ${rel} against HEAD: ${result.output}`).toBe(true);

    const modified = result.output.split("\n").map(l => l.trim()).filter(Boolean);
    expect(modified, `Prompt files are immutable (#1409, ADR-009) — revert with: git checkout HEAD -- ${rel}`).toEqual([]);
  });
});

// ═══ PROVE CHECKS (ADR-009 B3) ═══════════════════════════════════════
describe("prove checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // prove-evidence exists when prove gate runs
  test("prove-evidence-exists: prove gate produces evidence file", () => {
    const currentGate = process.env.GATE;
    if (currentGate !== "prove") return;
    const slug = sf("slug");
    if (!slug) return;
    const evidencePath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "prove-evidence.json");
    expect(existsSync(evidencePath), "prove-evidence.json must exist after prove gate runs (ADR-009 B3)").toBe(true);
  });

  // prove-evidence has valid verdict enum
  test("prove-evidence-verdict: verdict is PROVEN|UNPROVEN|INCONCLUSIVE", () => {
    const currentGate = process.env.GATE;
    if (currentGate !== "prove") return;
    const slug = sf("slug");
    if (!slug) return;
    const evidencePath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "prove-evidence.json");
    if (!existsSync(evidencePath)) return;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    const VALID_VERDICTS = ["PROVEN", "UNPROVEN", "INCONCLUSIVE"];
    expect(VALID_VERDICTS.includes(evidence.verdict), `prove-evidence verdict must be PROVEN|UNPROVEN|INCONCLUSIVE, got "${evidence.verdict}" (ADR-009 B3)`).toBe(true);
  });
});

// ═══ TEST BASELINE SUBTRACTION (#599) ═══════════════════════════════
describe("test-baseline-subtraction", () => {
  // AC-2: subtracts baseline from total test failures
  test("subtracts baseline from total test failures", () => {
    expect(subtractTestBaseline(5, 3)).toBe(2);
    expect(subtractTestBaseline(10, 0)).toBe(10);
    expect(subtractTestBaseline(0, 0)).toBe(0);
  });

  test("baseline diffing clamps to zero for negative values", () => {
    // If baseline is higher than total (tests were fixed), new failures = 0
    expect(subtractTestBaseline(2, 5)).toBe(0);
    expect(subtractTestBaseline(0, 3)).toBe(0);
  });

  // AC-3: zero new failures = PASS
  test("zero new failures when total equals baseline", () => {
    const newFailures = subtractTestBaseline(3, 3);
    expect(newFailures).toBe(0);
    // 0 new failures should mean PASS
    const resultVal: "PASS" | "FAIL" = newFailures > 0 ? "FAIL" : "PASS";
    expect(resultVal).toBe("PASS");
  });

  test("pre-existing failures do not block when no new failures introduced", () => {
    // Scenario: 7 pre-existing failures, Marcus introduces 0 new ones
    const baseline = 7;
    const totalAfterMarcus = 7;
    const newFailures = subtractTestBaseline(totalAfterMarcus, baseline);
    expect(newFailures).toBe(0);
    const resultVal: "PASS" | "FAIL" = newFailures > 0 ? "FAIL" : "PASS";
    expect(resultVal).toBe("PASS");
  });

  // extractTestFailureCount unit tests
  test("extractTestFailureCount: parses failure count from bun test output", () => {
    const output = `
 42 pass
 3 fail
`;
    expect(extractTestFailureCount(output)).toBe(3);
  });

  test("extractTestFailureCount: returns 0 when no failures in output", () => {
    const output = `
 42 pass
`;
    expect(extractTestFailureCount(output)).toBe(0);
  });

  test("extractTestFailureCount: uses last fail line when multiple present", () => {
    // bun test can print intermediate summaries
    const output = `
 10 pass
 2 fail

 52 pass
 5 fail
`;
    expect(extractTestFailureCount(output)).toBe(5);
  });
});
