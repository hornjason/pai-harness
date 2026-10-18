import { execSync, execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import {
  writeGateResult,
  generateHmac,
  generateShipEvidence,
  runConvergence,
  writeGateSummary,
  markCommandlessACsAsSkip,
  type GateResult,
} from "./orchestrator";
import { writeWitness } from "./witness";
import { normalizeGitRefs } from "../lib/git-ref-normalizer";
import { recordEvidenceRewrite } from "../lib/evidence-command-transport";
import { GATE_SUITE_TIMEOUT_MS } from "../lib/gate-timeouts";
import { checksRunFrom, readJunitCheckNames } from "../lib/junit-checks";
import { safeParseProjectHarness, type ProjectHarness } from "../lib/rungate-schema";
import { DEFAULT_TEST_TIMEOUT, resolveConfig, type ResolvedConfig } from "../lib/config-loader";
import { censusOf, censusRegressions } from "../lib/test-census";
import { readSuiteRun } from "../lib/suite-run-reading";
import {
  slugExists,
  shouldRebuildContainer,
  shouldRefreshScaffold,
  worktreeBranchName,
  checkPortCollision,
  trackPreExistingFailures,
  releaseLock,
  detectFileSetOverlap,
  sequentialMergeOrder,
  shouldRunCIVerification,
  requiresResearchEscalation,
} from "./ship-orchestrator";
import {
  measureEvidencePrevalidation,
  type EvidencePrevalidationReading,
} from "../lib/evidence-prevalidator";
import { EvidencePrevalidationSchema, type PrevalidationSource } from "./schema";
import { scanGaps, type GapScanResult } from "../lib/gap-scanner";
import { deepMerge } from "../lib/deep-merge";
import { livenessPlan, probeTarget } from "../lib/dev-liveness";
import { livenessEvidenceContradictions } from "../lib/liveness-contradiction";
import { createGitHubClient, getIssue, addLabels } from "../lib/github";
import {
  classifySpecComplianceRun,
  execErrorOutput,
  missingSpecComplianceFiles,
  SPEC_COMPLIANCE_FILES,
} from "./spec-compliance-probe";
// ── Test output parser (moved here from run-gate.ts to break circular dep) ──

/**
 * Bun's timeout explanation, which is printed AFTER its own `(fail)` marker
 * where every other kind of detail is printed before it (#550).
 *
 * Captured from bun 1.3.14 rather than written from memory:
 * `  ^ this test timed out after 300ms.`
 */
const TIMEOUT_EXPLANATION = /^\s*\^\s*this test timed out after\b/;

/**
 * What a failure's detail says when the runner printed no reason for it.
 *
 * It used to be the bare string `"failed"`, which is a refusal with no
 * reason in the one field a heal prompt reads — and worse, it reads like
 * something the runner said rather than like the parser giving up. On the
 * run that produced #550 the reader went looking for a check that had
 * reported "failed" and found a check whose output said `Type check PASS`.
 *
 * So it names the component that had nothing to say. The behaviour is
 * unchanged; what changed is where it sends the next reader.
 */
const UNEXPLAINED_FAILURE =
  "no explanation was captured for this failure — the runner printed nothing between this " +
  "check's marker and the previous one, and gate-executor.ts's parseTestResults has no reason " +
  "to report. The check failed; why it failed was not recorded (#550).";

export function parseTestResults(output: string): GateResult[] {
  const results: GateResult[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/\(pass\)\s+(.+?)(?:\s+\[|$)/);
    if (pm) {
      results.push({ check: pm[1].trim(), result: "PASS", detail: "passed" });
      continue;
    }
    const fm = lines[i].match(/\(fail\)\s+(.+?)(?:\s+\[|$)/);
    if (fm) {
      // Bun prints a failure's source excerpt, error and stack BEFORE its
      // `(fail)` line, so the detail is scanned BACKWARD to the previous
      // marker (#314). Scanning forward gave every entry the NEXT failure's
      // detail and left the last one holding the run summary, which is what
      // the heal prompt was being fed on run wf_5cdce852-1e2.
      //
      // #550: a TIMEOUT is the one exception, and it goes the other way.
      // Bun prints `^ this test timed out after Nms.` AFTER the marker, so
      // the backward scan from the NEXT failure walked over it and took it,
      // while the test it belonged to was left with nothing. Observed live:
      // `tsc-pass` recorded `detail: "failed"` and `local-api-validated`'s
      // detail opened with a timeout that was not its own — which reads as a
      // diagnosis of the wrong check, and was read that way.
      const own: string[] = [];
      for (let j = i + 1; j < lines.length && TIMEOUT_EXPLANATION.test(lines[j]); j++) {
        own.push(lines[j].trim());
      }
      const detailLines: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        if (/\(pass\)\s+/.test(lines[j]) || /\(fail\)\s+/.test(lines[j])) break;
        if (/^bun test v/.test(lines[j])) break;
        // Belongs to the marker above it, not to this one.
        if (TIMEOUT_EXPLANATION.test(lines[j])) break;
        const trimmed = lines[j].trim();
        if (trimmed) detailLines.unshift(trimmed);
      }
      const detail = [...own, ...detailLines];
      results.push({
        check: fm[1].trim(),
        result: "FAIL",
        detail: detail.length > 0 ? detail.join("\n") : UNEXPLAINED_FAILURE,
      });
    }
  }
  return results;
}

// ── Test baseline functions (#599) ───────────────────────────────────────

/**
 * The failure count a runner's output STATES, or `null` when it states none.
 *
 * Uses the last "N fail" line (bun may print intermediate summaries).
 *
 * The nullable answer is the whole of #307's parser half. Bun prints ` 0 fail`
 * on a clean run, so output carrying no fail line at all is a runner that
 * crashed, timed out, or is not bun — and a consumer whose `dev.testCmd` is
 * jest, pytest or a Makefile target produces exactly that on EVERY run. "The
 * suite reported zero failures" and "nothing here reports failures" are
 * different facts and only the first is a clean tree.
 */
export function parseTestFailureCount(testOutput: string): number | null {
  const failMatches = [...testOutput.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
  if (failMatches.length === 0) return null;
  return parseInt(failMatches[failMatches.length - 1][1]);
}

/**
 * Extract the failure count from bun test output, treating "no count stated"
 * as zero.
 *
 * Kept exactly as it was, deliberately: `gates/workflow.test.ts` pins this
 * contract and #307 is forbidden from changing the gate checks. The honest
 * reading is `parseTestFailureCount` above, and the two are compared against
 * each other in `test/test-baseline-unmeasured.test.ts` so this wrapper cannot
 * drift away from the parser it wraps.
 */
export function extractTestFailureCount(testOutput: string): number {
  return parseTestFailureCount(testOutput) ?? 0;
}

/**
 * Subtract test baseline from total failures to get new-only failure count.
 * Clamps to 0 — if baseline exceeds total (tests were fixed), result is 0.
 */
export function subtractTestBaseline(totalFailures: number, baseline: number): number {
  return Math.max(0, totalFailures - baseline);
}

/**
 * What a run can honestly say about the tree it started from (#307 SC-A6).
 *
 * `measured` is the only reading that licenses "the suite was clean before
 * this change". `unmeasured` carries the reason, because a baseline nobody
 * took is news an operator can act on — usually by setting one key.
 */
export type TestBaselineReading =
  | { status: "measured"; failures: number; command: string }
  | { status: "unmeasured"; reason: string };

/**
 * Capture the test baseline by running the project's suite at scope time.
 *
 * This used to return `0` for four different facts, and the scope gate
 * printed "0 pre-existing failures — clean suite" for all of them:
 *
 *   1. no `.claude/rungate.json` — the path was built here by hand, so every
 *      consumer on the documented `.claude/rungate/` layout took this branch
 *   2. no `test.command` — including every consumer that authored
 *      `dev.testCmd`, which is the canonical spelling ADR-002 D3 normalises TO
 *   3. the suite ran and printed something unparseable
 *   4. the suite ran and nothing was failing
 *
 * #490 added a fifth, which the four above could not distinguish because the
 * reading was taken off the FAIL line alone: **the suite ran and executed
 * nothing.** A renamed directory or a glob that stopped matching prints
 * `0 pass / 0 fail / Ran 0 tests across 1 file.` and exits 0, and that was a
 * `measured` baseline of zero — the strongest claim available about a tree
 * nobody looked at, with the verify gate subtracting against it. The reading
 * goes through `lib/suite-run-reading.ts` now, which refuses it.
 *
 * Only the fourth is a clean tree, and a fabricated baseline is the worst
 * direction for this particular number to be wrong in: it asserts the
 * strongest claim available about the tree, and the verify gate subtracts
 * against it.
 *
 * It worked on rungate the whole time, which is why nothing caught it — this
 * repo's own config carries `test.command`, so branch 2 was never taken here.
 * See `test/test-baseline-unmeasured.test.ts` for the consumer-shaped
 * fixtures that do take it.
 *
 * The timeout now comes from the resolved config rather than from a `|| 300000`
 * that disagreed with `DEFAULT_TEST_TIMEOUT`. A consumer that sets no
 * `test.timeout` therefore gets the shorter one — and a suite killed by it
 * reports UNMEASURED naming the timeout, where before it reported a clean
 * tree. The failure mode moved from silent and wrong to loud and fixable.
 */
export function captureTestBaseline(state: Record<string, any>): TestBaselineReading {
  const projectRoot = state.projectRoot || process.cwd();

  const resolution = resolveConfig(projectRoot);
  if (resolution.status === "absent") {
    return {
      status: "unmeasured",
      reason: `no rungate config under ${join(projectRoot, ".claude")} — nothing says how to run this project's suite`,
    };
  }

  const testCmd = resolution.config.test?.command;
  if (!testCmd) {
    // Both spellings named on purpose. "No test command" sends an operator
    // looking for the key they already did not set.
    return {
      status: "unmeasured",
      reason:
        `the ${resolution.source} config at ${resolution.path} sets neither ` +
        `dev.testCmd nor test.command`,
    };
  }

  const timeout = resolution.config.test?.timeout ?? DEFAULT_TEST_TIMEOUT;
  console.log(`Test baseline: running "${testCmd}" to capture pre-existing failures...`);

  let output: string;
  try {
    output = execSync(`${testCmd} 2>&1`, { encoding: "utf-8", timeout, cwd: projectRoot });
  } catch (e: any) {
    // A suite with failures exits non-zero, so the count normally arrives
    // through here. `e.stdout` is also empty on a timeout kill, which the
    // parser below turns into UNMEASURED rather than into a clean tree.
    output = e.stdout || "";
  }

  const run = readSuiteRun(output);
  if (run.status !== "MEASURED") {
    return {
      status: "unmeasured",
      reason: `"${testCmd}" did not measure this project (timeout ${timeout}ms) — ${run.reason}`,
    };
  }

  return { status: "measured", failures: run.fail, command: testCmd };
}

/**
 * Write a reading into `gateContract.baselines`, in place (#307).
 *
 * Pure and exported so the propagation is EXECUTABLE. The reading being
 * honest buys nothing if the two lines that record it quietly write a `0`,
 * and a `captureTestBaseline` test cannot see that.
 *
 * The two keys are mutually exclusive, enforced by deleting the other one
 * each way. A reason sitting beside a number would let `?? 0` keep reading
 * the run as a measured clean tree — which is the defect the reason exists
 * to report, reintroduced one field over.
 */
export function recordTestBaseline(
  baselines: Record<string, any>,
  reading: TestBaselineReading,
): void {
  if (reading.status === "measured") {
    baselines.testBaseline = reading.failures;
    delete baselines.testBaselineUnmeasured;
  } else {
    delete baselines.testBaseline;
    baselines.testBaselineUnmeasured = reading.reason;
  }
}

/** What a gate run does about the tests that existed when it last looked. */
export type CensusVerdict =
  | { kind: "unmeasured"; reason: string }
  | { kind: "first-reading"; files: number }
  | { kind: "no-regression"; files: number }
  | { kind: "regression"; regressions: string[] };

/**
 * Whether tests disappeared since the last gate run (#307 SC-A19).
 *
 * Every heal round ends in a gate re-run, so "since the last gate run" and
 * "across a heal" are the same window. A heal agent is told a gate failed and
 * asked to make it pass; deleting the test is a correct solution to that
 * instruction and an incorrect solution to the problem, and nothing
 * downstream can tell, because a suite with the failing test removed is green
 * and green is what it asked for. Run `wf_5cdce852-1e2` went from 34 tests to
 * 23 across two rounds with no `skip` and no `todo` recorded.
 *
 * `first-reading` is NOT a pass. There is nothing to compare on the first
 * gate run of a run, and a verdict that said "no regression" there would be
 * the reading nobody took wearing the answer's clothes — the whole subject of
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * Neither is `unmeasured`, and it is the arm that keeps this guard alive on a
 * project that is not this one. A tree with no recognisable test file
 * censuses to `{}`, `{}` compares clean against `{}` on every subsequent
 * round, and the guard would be permanently and silently dead for exactly the
 * repos it exists to protect — a polyglot consumer, or one whose suite the
 * walk cannot see. Reported, every run, rather than inferred from silence.
 */
export function censusVerdict(
  previous: Record<string, number> | undefined,
  current: Record<string, number>,
): CensusVerdict {
  const files = Object.keys(current).length;
  if (files === 0) {
    return {
      kind: "unmeasured",
      reason:
        "no .test/.spec file in the JS/TS family was found in the tree under test, " +
        "so a heal round that deleted one could not be seen",
    };
  }
  if (!previous || Object.keys(previous).length === 0) return { kind: "first-reading", files };
  const regressions = censusRegressions(previous, current);
  return regressions.length > 0 ? { kind: "regression", regressions } : { kind: "no-regression", files };
}

/**
 * The reading to carry into the next gate run (#307 SC-A19).
 *
 * A regression does NOT bank the reduced census. Banking it would make the
 * next round compare against the tree the deletion produced, so a second
 * round would find no regression and the refusal would clear itself — a
 * guard that forgets what it refused is a guard you only have to get past
 * once.
 */
/**
 * Write the banked census into the state FILE (#307 SC-A19).
 *
 * Found by review, and without it the guard was permanently dead. Setting
 * `state.gateContract.testCensus` in memory reaches disk only by accident:
 * `writeGateResult` further down does its own `readState(sf)` and writes
 * THAT back, so the in-memory mutation is discarded. Every subsequent gate
 * run would have found no census, answered `first-reading`, logged a
 * reassuring line, and compared nothing — forever.
 *
 * Read-modify-write against the file rather than a whole-state write,
 * because the gate tests and any heal agent have been writing to it since
 * this process loaded `state`, and clobbering their edits to record a census
 * trades one silent loss for another.
 */
export function persistTestCensus(stateFilePath: string, census: Record<string, number>): void {
  const fresh = JSON.parse(readFileSync(stateFilePath, "utf-8"));
  fresh.gateContract = fresh.gateContract || {};
  fresh.gateContract.testCensus = census;
  writeFileSync(stateFilePath, JSON.stringify(fresh, null, 2));
}

/**
 * The census the last gate run banked, read off DISK (#307 SC-A19).
 *
 * Not off the in-memory `state`, which was loaded when the process started:
 * the gate tests and any heal agent have been writing the file since, and
 * comparing against a stale copy and then persisting over the fresh one is
 * how a round's reading quietly disappears. The direction it disappears in
 * is toward not refusing.
 *
 * A file that cannot be read or parsed returns `undefined`, which
 * `censusVerdict` turns into `first-reading` — said out loud rather than
 * passed quietly.
 */
export function readPersistedCensus(stateFilePath: string): Record<string, number> | undefined {
  try {
    const onDisk = JSON.parse(readFileSync(stateFilePath, "utf-8"));
    const census = onDisk?.gateContract?.testCensus;
    return census && typeof census === "object" && !Array.isArray(census) ? census : undefined;
  } catch {
    return undefined;
  }
}

export function nextCensus(
  previous: Record<string, number> | undefined,
  current: Record<string, number>,
  verdict: CensusVerdict,
): Record<string, number> {
  // `unmeasured` holds the previous reading too. Banking an empty census
  // over a real one would turn a tree the walk briefly could not read — a
  // worktree mid-checkout, a `dist` rename — into a permanent amnesia, and
  // the round after it would compare clean against nothing.
  if (verdict.kind === "regression" || verdict.kind === "unmeasured") return previous ?? current;
  return current;
}

/** What the verify gate does with whatever scope recorded (#307). */
export type BaselineAdjustment =
  | { kind: "subtract"; baseline: number; fails: number }
  | { kind: "unmeasured"; reason: string }
  | { kind: "none" };

/**
 * The verify gate's reading of the recorded baseline (#307).
 *
 * `none` and `unmeasured` subtract the same amount — nothing — so the
 * arithmetic is not what separates them. What `unmeasured` stops is the run
 * claiming a clean starting tree it never looked at, and the only way to say
 * that is to have kept the two apart all the way from `captureTestBaseline`.
 *
 * A number of `0` is `none`: the suite ran, nothing was failing, there is
 * nothing to subtract and nothing to report.
 */
export function baselineAdjustment(
  baselines: Record<string, any> | undefined,
  fails: number,
): BaselineAdjustment {
  const b = baselines ?? {};
  if (typeof b.testBaseline === "number" && b.testBaseline > 0) {
    return { kind: "subtract", baseline: b.testBaseline, fails: subtractTestBaseline(fails, b.testBaseline) };
  }
  if (typeof b.testBaselineUnmeasured === "string" && b.testBaselineUnmeasured.length > 0) {
    return { kind: "unmeasured", reason: b.testBaselineUnmeasured };
  }
  return { kind: "none" };
}

// ── Gate executor contract interfaces (SC-373, SC-376) ───────────────────

export interface GateExecutorInput {
  gate: string;
  slug: string;
  issue: number;
  workDir: string;
  stateFilePath: string;
  /**
   * The tree this gate runs its own subprocesses in, resolved once by the
   * caller (#190). Required, not optional: a gate that resolves its own root
   * can run its subprocesses — including `bun scripts/sync-spec-tests.ts`,
   * which WRITES — in a different tree from the run it is grading, and say
   * nothing, because both trees exist. `gates/run-gate.ts resolveRunRoot()`
   * is where it comes from.
   */
  harnessRoot: string;
}

export interface GateExecutorResult {
  resultVal: "PASS" | "FAIL";
  passes: number;
  fails: number;
  warns: number;
  results: GateResult[];
  attempt: number;
  exitCode: number;
}

// ── State + harness loading ──────────────────────────────────────────────

/**
 * What a gate can say about the project's config (#311 SC-A8).
 *
 * THREE outcomes, not two. Four readers in this file built
 * `.claude/rungate.json` by hand and branched on `existsSync`, which
 * collapses "this project has no rungate" and "this project is on the
 * documented directory layout" into one answer — and a third case,
 * "configured and unreadable", into the same one again via a bare `catch`.
 *
 * The cost of that collapse is specific and was never a warning: a consumer
 * on `.claude/rungate/` got its ceremony overrides switched off (#310), its
 * type check skipped, its dev-server liveness unprobed and its prove-gate
 * environment empty, and each of those looks exactly like a project that
 * configured none of them.
 *
 * `unreadable` exists because a gate must not crash on a corrupt config and
 * must not call it absent either. ADR-001 D2's corollary — a malformed
 * config is never a missing config — survives the conversion from a throw to
 * a value, which is the shape SC-1453 established for the one other site
 * whose throw crosses into a gate.
 */
export type GateConfigReading =
  | { status: "resolved"; config: ResolvedConfig; source: "directory" | "monolith"; path: string }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

/** The single config read for this file. One binding, so one thing to mutate. */
export function readGateConfig(projectRoot: string): GateConfigReading {
  if (!projectRoot) return { status: "absent" };
  try {
    const resolution = resolveConfig(projectRoot);
    return resolution.status === "resolved"
      ? {
          status: "resolved",
          config: resolution.config,
          source: resolution.source,
          path: resolution.path,
        }
      : { status: "absent" };
  } catch (e: any) {
    return { status: "unreadable", reason: e?.message || String(e) };
  }
}

/**
 * Say an unreadable config out loud, once, wherever it is hit.
 *
 * Returning `null` quietly is what every one of these sites used to do, and
 * the whole point of the three-way reading is that one of the three is news.
 */
function reportUnreadable(where: string, reading: GateConfigReading): void {
  if (reading.status === "unreadable") {
    console.error(
      `WARN: ${where} could not read the rungate config — ${reading.reason}. ` +
        `This is UNMEASURED, not an unconfigured project.`,
    );
  }
}

export function loadAndValidateHarness(projectRoot: string): ProjectHarness | null {
  const reading = readGateConfig(projectRoot);
  reportUnreadable("ceremony overrides", reading);
  if (reading.status !== "resolved") return null;

  const result = safeParseProjectHarness(reading.config);
  if (!result.success) {
    console.warn(`WARN: rungate config schema validation failed (${reading.path}):`);
    for (const err of result.error.issues) {
      console.warn(`  - ${err.path.join(".")}: ${err.message}`);
    }
    return null;
  }
  return result.data;
}

/**
 * The URLs and commands the prove gate probes (#311 SC-A8).
 *
 * `apiBase` and `uiBase` come off the NORMALISED names. ADR-002 D3 resolves
 * `dev.apiBase` to `apiUrl` and collapses an authored `null` — what a
 * greenfield scaffold writes for a base URL it could not detect — into the
 * same absence an omitted key gives. Reading `dev.apiBase` raw here would
 * reintroduce the second spelling of "not set" that the normaliser exists to
 * remove, and `if (apiBase)` would then be deciding on a `null` the rest of
 * the harness has already agreed to treat as absent.
 *
 * Extracted from the prove block so it can be run against a fixture: every
 * field below was empty for every consumer on the directory layout, and the
 * symptom was a liveness probe that silently did not happen.
 */
export function proveEnvironment(projectRoot: string): {
  apiBase: string;
  uiBase: string;
  devStart: string;
  devHealthPath: string;
  prodCfg: { apiBase?: string; healthPath?: string };
} {
  const empty = { apiBase: "", uiBase: "", devStart: "", devHealthPath: "", prodCfg: {} };
  const reading = readGateConfig(projectRoot);
  reportUnreadable("prove gate environment", reading);
  if (reading.status !== "resolved") return empty;

  const c = reading.config;
  return {
    apiBase: c.apiUrl || "",
    uiBase: c.uiUrl || "",
    devStart: c.dev?.start || "",
    devHealthPath: c.dev?.healthPath || "",
    prodCfg: { apiBase: c.prod?.apiBase || "", healthPath: c.prod?.healthPath || "" },
  };
}

/**
 * Make a `<remote>/<branch>` ref resolvable, fetching it if it is not (#118).
 *
 * Qualifying evidence commands to `origin/main` only helps if that ref exists.
 * It frequently does not: a CI checkout fetches the PR merge ref and nothing
 * else, and a fresh agent worktree inherits whatever the shared clone last
 * fetched. `git diff origin/main` against a missing ref exits non-zero with a
 * message on stderr, which the verdict logic below reads as a code failure —
 * reproducing the exact false FAIL this issue is about, one layer down.
 *
 * Returns false when the ref still cannot be resolved, so the caller can say
 * "could not measure" instead of "failed".
 */
/** Exported for test: one entry per (cwd, ref) actually resolved. */
export const __refResolutionCache = new Map<string, boolean>();
const REF_RESOLUTION_CACHE = __refResolutionCache;

function ensureRemoteRef(ref: string, cwd: string): boolean {
  // Memoized per (cwd, ref) for the life of the process. A gate run commonly
  // has a dozen ACs all diffing against origin/main; without this each one
  // pays its own fetch, and the 60s timeout below turns an offline remote into
  // minutes of dead gate time before any verdict exists. Negative results are
  // cached too — that is the expensive case, and re-attempting a fetch that
  // just failed within the same run has nothing new to learn.
  const key = `${cwd}\u0000${ref}`;
  const cached = REF_RESOLUTION_CACHE.get(key);
  if (cached !== undefined) return cached;
  const ok = resolveRemoteRef(ref, cwd);
  REF_RESOLUTION_CACHE.set(key, ok);
  return ok;
}

function resolveRemoteRef(ref: string, cwd: string): boolean {
  // execFileSync with an argv array throughout: no shell, so a ref name can
  // never be interpreted as a command. The shape checks below stay as a
  // second line, but they are no longer what makes this safe.
  const resolves = () => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd, stdio: "pipe", timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (resolves()) return true;
  const slash = ref.indexOf("/");
  if (slash <= 0) return false;
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || !/^[A-Za-z0-9._/-]+$/.test(branch)) return false;
  try {
    // Explicit refspec: `git fetch origin main` alone writes FETCH_HEAD and
    // does not necessarily create refs/remotes/origin/main, which is the name
    // the evidence command uses.
    execFileSync("git", ["fetch", "--quiet", remote, `${branch}:refs/remotes/${remote}/${branch}`], {
      cwd, stdio: "pipe", timeout: 60000,
    });
  } catch {
    // Offline, no remote, or no permission. Not fatal here — the caller
    // reports it as unmeasurable rather than guessing a verdict.
    return false;
  }
  return resolves();
}

/**
 * Remote refs an evidence command depends on, e.g. `origin/main`.
 *
 * Scanned narrowly, because this function's mistakes go both ways. Reading a
 * ref that is not there makes a measurable AC unmeasurable and blocks it;
 * missing one that is there lets the stale-ref FAIL through. A bare scan for
 * `origin/...` anywhere in the string does both: `grep -r origin/main docs/`
 * names no ref at all, and `git log -- docs/origin/main.md` names a path.
 *
 * So: only inside a `git` invocation, and only before the `--` pathspec
 * separator, and not when preceded by a path character.
 */
export function remoteRefsIn(command: string): string[] {
  const refs = new Set<string>();
  for (const invocation of command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?([^|&;]*)/g)) {
    const beforePathspec = invocation[1].split(" -- ")[0];
    // Segment-wise, so a `.` can appear inside a ref name (`release-2.1`) but
    // `..` terminates it — `origin/main..HEAD` depends on `origin/main`, and
    // asking git to fetch `main..HEAD` fetches nothing.
    const inRefPosition = /(?<![\w/.-])(origin|upstream)\/([A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*)/g;
    for (const m of beforePathspec.matchAll(inRefPosition)) refs.add(`${m[1]}/${m[2]}`);
  }
  return [...refs];
}

/**
 * Exported for test. This is where evidence commands actually execute, and it
 * is the last place a stale git ref can be caught (#118).
 */
export function autoPopulateACs(state: Record<string, any>, sf: string): void {
  let acUpdated = false;
  for (let i = 0; i < (state.acs || []).length; i++) {
    const ac = state.acs[i];
    if (ac.verdict && ac.verdict !== "PENDING" && ac.verdict !== "FAIL") continue;
    const rawCmd = ac.evidenceMethod?.command;
    if (!rawCmd) continue;
    // Qualify bare `main`/`master` to `origin/...` at the point of execution,
    // not only at prevalidation (#118).
    //
    // Prevalidation is not a chokepoint: the verify-gate re-implementation path
    // authors NEW ACs after Scope has already run, so a command can reach here
    // having never been prevalidated. Normalizing only there would fix the
    // commands that were already least likely to be wrong.
    //
    // Writing it back onto the AC means the repaired form is what gets
    // persisted and reported, so a human reading the failure sees the command
    // that actually ran.
    //
    // #614: through `recordEvidenceRewrite`, so the authored form survives
    // the repair. This is the last site that changes an evidence command,
    // and it used to be the one that made the authored text unrecoverable.
    const cmd = normalizeGitRefs(rawCmd).command;
    recordEvidenceRewrite(ac.evidenceMethod, "normalize-git-refs", cmd);

    // A ref the command needs but the clone does not have is an ENVIRONMENT
    // fault, not a code failure. Letting it fall through produces a non-zero
    // exit with a message on stderr, which the verdict logic below scores as
    // FAIL — recreating the false FAIL this whole issue is about, one layer
    // down. Found by CI: the runner checks out the PR merge ref and has no
    // refs/remotes/origin/main at all, so the corrected command failed there
    // while passing on every developer machine.
    const evidenceCwdForRefs = process.env.EVIDENCE_CWD || state.projectRoot || process.cwd();
    const missingRefs = remoteRefsIn(cmd).filter(r => !ensureRemoteRef(r, evidenceCwdForRefs));
    if (missingRefs.length > 0) {
      // Blocking, not SKIP.
      //
      // The first version of this marked the AC SKIP, reasoning that an
      // unmeasured AC should not be scored as a code failure. Security review
      // caught what that actually bought: gates/orchestrator.ts advances when
      // every AC is PASS or SKIP, so an unresolvable ref would have turned a
      // blocking gate into a passing one. Anything able to make a ref
      // unresolvable — a typo, a network blip, a ref name chosen for the
      // purpose — would have been a gate bypass.
      //
      // What #118 is actually about is narrower than "never FAIL here". The
      // #103 damage was a confident, specific, fabricated finding — named
      // files, named line numbers — that a second agent then acted on. Saying
      // "origin/main is unreachable, I measured nothing" is the opposite of
      // that. It blocks, and it is honest about why, which is what lets a
      // human or a heal step fix the environment instead of the code.
      console.warn(`WARN: AC ${ac.id} needs ${missingRefs.join(", ")} which could not be resolved or fetched — blocking as UNMEASURED (environment fault, not a code defect)`);
      state.acs[i].verdict = "FAIL";
      state.acs[i].evidence = {
        type: "unmeasured",
        content: `Evidence requires ${missingRefs.join(", ")}; the ref is absent and could not be fetched. This is an environment fault — the AC was NOT evaluated, so no claim is made about the code. Fix the checkout (fetch the ref), then re-run; do not change code in response to this.`,
      };
      acUpdated = true;
      continue;
    }
    try {
      const evidenceCwd = process.env.EVIDENCE_CWD || state.projectRoot || process.cwd();
      const isTestRunner = /bun test\b/.test(cmd);
      const cmdTimeout = isTestRunner ? 300000 : 10000;
      const output = execSync(cmd, { encoding: "utf-8", timeout: cmdTimeout, cwd: evidenceCwd }).trim();
      const lastLine = output.split("\n").pop() || "";
      let verdict: "PASS" | "FAIL" = "FAIL";
      if (isTestRunner) {
        verdict = "PASS";
      }
      const { op, value } = ac.threshold || {};
      if (!isTestRunner && op && value !== undefined) {
        const num = parseFloat(lastLine);
        const exp = parseFloat(String(value));
        switch (op) {
          case "==": verdict = lastLine === String(value) || (!isNaN(num) && num === exp) ? "PASS" : "FAIL"; break;
          case "!=": verdict = lastLine !== String(value) ? "PASS" : "FAIL"; break;
          case ">=": verdict = !isNaN(num) && num >= exp ? "PASS" : "FAIL"; break;
          case "<=": verdict = !isNaN(num) && num <= exp ? "PASS" : "FAIL"; break;
          case ">": verdict = !isNaN(num) && num > exp ? "PASS" : "FAIL"; break;
          case "<": verdict = !isNaN(num) && num < exp ? "PASS" : "FAIL"; break;
          case "contains": verdict = output.includes(String(value)) ? "PASS" : "FAIL"; break;
        }
      }
      state.acs[i].verdict = verdict;
      state.acs[i].evidence = { type: "command-output", content: lastLine };
      acUpdated = true;
    } catch (e: any) {
      // grep returns exit 1 on zero matches — valid result, not an error
      const stderr = e.stderr?.toString?.() || "";
      const stdout = (e.stdout?.toString?.() || "").trim();
      if (stdout !== "" || e.status === 1) {
        const lastLine = stdout.split("\n").pop() || "0";
        let verdict: "PASS" | "FAIL" = "FAIL";
        const { op, value } = ac.threshold || {};
        if (op && value !== undefined) {
          const num = parseFloat(lastLine);
          const exp = parseFloat(String(value));
          switch (op) {
            case "==": verdict = lastLine === String(value) || (!isNaN(num) && num === exp) ? "PASS" : "FAIL"; break;
            case "!=": verdict = lastLine !== String(value) ? "PASS" : "FAIL"; break;
            case ">=": verdict = !isNaN(num) && num >= exp ? "PASS" : "FAIL"; break;
            case "<=": verdict = !isNaN(num) && num <= exp ? "PASS" : "FAIL"; break;
            case ">": verdict = !isNaN(num) && num > exp ? "PASS" : "FAIL"; break;
            case "<": verdict = !isNaN(num) && num < exp ? "PASS" : "FAIL"; break;
            case "contains": verdict = stdout.includes(String(value)) ? "PASS" : "FAIL"; break;
          }
        }
        state.acs[i].verdict = verdict;
        state.acs[i].evidence = { type: "command-output", content: lastLine };
        acUpdated = true;
      } else {
        console.warn(`WARN: AC ${ac.id} evidence command failed: ${e.message?.slice(0, 100) || 'unknown'}`);
      }
    }
  }
  // #513 SC-A1: ACs without evidenceMethod.command get SKIP, not generic output
  const skipped = markCommandlessACsAsSkip(sf);
  if (skipped > 0) {
    const refreshed = JSON.parse(readFileSync(sf, "utf-8"));
    Object.assign(state, refreshed);
  } else if (acUpdated) {
    writeFileSync(sf, JSON.stringify(state, null, 2));
  }
}

// ── Verify-gate early checks ────────────────────────────────────────────

function checkVerifyPendingACs(state: Record<string, any>): { results: GateResult[]; failCount: number } {
  const results: GateResult[] = [];
  let failCount = 0;
  const pendingCodeACs = (state.acs || []).filter(
    (ac: any) => ac.type !== "OUTCOME" && (!ac.verdict || ac.verdict === "PENDING")
  );
  if (pendingCodeACs.length > 0) {
    for (const ac of pendingCodeACs) {
      failCount++;
      results.push({
        check: `verify-ac-evidence-gap: ${ac.id} still PENDING after auto-populate`,
        result: "FAIL" as const,
        detail: `${ac.id} evidence command may be broken or matching 0 tests — check evidenceMethod.command: ${ac.evidenceMethod?.command || "(none)"}`,
      });
    }
    console.log(`Verify AC evidence gap: ${pendingCodeACs.length} CODE AC(s) still PENDING — ${pendingCodeACs.map((ac: any) => ac.id).join(", ")}`);
  }
  return { results, failCount };
}

// ── Prove reproducer (B3) ───────────────────────────────────────────────

async function runProveReproducer(state: Record<string, any>, issue: number, issueRepo: string, workDir: string, harnessRoot: string, stateFile: string): Promise<void> {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") {
    console.log("prove gate: LIGHT tier — skipping reproducer (API check only)");
    return;
  }

  let issueBody = "";
  let issueTitle = "";
  if (issue && issueRepo) {
    try {
      const github = createGitHubClient();
      const issueData = await getIssue(github, issueRepo, issue);
      issueBody = issueData.body || "";
      issueTitle = issueData.title || "";
      console.log(`prove gate: read issue #${issue} from GitHub (${issueTitle.slice(0, 60)})`);
    } catch (e: any) {
      console.error(`prove gate: FAIL — could not read issue from GitHub: ${e.message?.slice(0, 200)}`);
      process.exit(1);
    }
  } else {
    console.error("prove gate: FAIL — issue number and repo required for prove");
    process.exit(1);
  }

  const projectRoot = state.projectRoot || "";
  const proveEnv = proveEnvironment(projectRoot);
  const { apiBase, uiBase, devStart, devHealthPath, prodCfg } = proveEnv;

  // #304. This used to curl `${apiBase}/api/admin/health` and `process.exit(1)`
  // on failure — the worst of the three copies of that route, because the
  // consequence is a hard refusal rather than a FAIL line. A consumer whose
  // health route is anything else had its prove gate killed on a server that
  // was up, told to start it.
  //
  // The UNMEASURED branch is a REFUSAL RELAXATION and has to be recorded as
  // one. Before this change a consumer with `dev.apiBase` set got
  // `process.exit(1)` when its server was down; no consumer sets
  // `dev.healthPath` yet, so on merge every one of them stops being refused
  // here. Reporting DOWN instead would be wrong — that is the whole issue —
  // but letting the gap evaporate into a stdout line is the fail-open the
  // security review named. So the reading is written to the workflow state,
  // which is durable and which later gates read, as well as to
  // `prove-input.json`.
  //
  // It is both recorded and consumed since #346: the contradiction check
  // below refuses when an OUTCOME AC claims server-dependent evidence while
  // liveness was never measured. Recording it without reading it left the
  // control #304 relaxed genuinely removed — #213's shape, where a field is
  // written and nothing is decided on it.
  //
  // The reproducer prompt still does not read it, and that was once claimed
  // here without checking: `gates/prompts/prove-reproducer.md` never
  // mentions liveness. The refusal below is what reads it.
  const devTarget = probeTarget("dev", { apiBase, healthPath: devHealthPath });
  let devLiveness: { tier: string; status: "UP" | "UNMEASURED"; detail: string } | null = null;
  if (apiBase) {
    if (devTarget.kind === "unmeasured") {
      devLiveness = { tier: "dev", status: "UNMEASURED", detail: devTarget.detail };
      console.warn(`WARN: prove gate — dev liveness UNMEASURED: ${devTarget.detail}`);
    } else {
      try {
        execFileSync("curl", ["-sf", "--max-time", "10", "--", devTarget.url], {
          timeout: 10000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
        });
        devLiveness = { tier: "dev", status: "UP", detail: devTarget.safeUrl };
        console.log(`prove gate: health check PASS (${devTarget.safeUrl})`);
      } catch {
        console.error(`prove gate: FAIL — dev server not responding at ${devTarget.safeUrl}`);
        if (devStart) console.error(`Start it with: ${devStart}`);
        process.exit(1);
      }
    }
  }

  // Prod health check — WARN only. Third copy of the same hardcoded route
  // (#304), and the one most likely to go unnoticed, because its only
  // consequence is a warning line nobody reads.
  let prodLiveness: { tier: string; status: "UP" | "DOWN" | "UNMEASURED"; detail: string } | null = null;
  if (prodCfg.apiBase) {
    const prodTarget = probeTarget("prod", prodCfg);
    if (prodTarget.kind === "unmeasured") {
      prodLiveness = { tier: "prod", status: "UNMEASURED", detail: prodTarget.detail };
      console.warn(`WARN: prove gate — prod liveness UNMEASURED: ${prodTarget.detail}`);
    } else {
      try {
        execFileSync("curl", ["-sf", "--max-time", "10", "--", prodTarget.url], {
          timeout: 10000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
        });
        prodLiveness = { tier: "prod", status: "UP", detail: prodTarget.safeUrl };
        console.log(`prove gate: prod health check PASS (${prodTarget.safeUrl})`);
      } catch {
        // DOWN here, unlike dev, is a measurement: the route was configured
        // and the probe ran. UNMEASURED above is not.
        prodLiveness = { tier: "prod", status: "DOWN", detail: prodTarget.safeUrl };
        console.warn(`WARN: prove gate — prod server not responding at ${prodTarget.safeUrl} (STANDARD+ requires prod evidence)`);
      }
    }
  }

  const proveInput = {
    issueBody, issueTitle, issueNumber: issue,
    acs: state.acs || [], apiBase, uiBase,
    beforeState: state.beforeState || null, projectRoot,
    // #304: the liveness readings, including the ones that measured nothing.
    // UNMEASURED has to be durable or relaxing the refusal above is a silent
    // fail-open.
    liveness: [devLiveness, prodLiveness].filter(Boolean),
  };
  // And on the workflow state, which is the durable artefact later gates
  // read. prove-input.json is consumed by one spawned agent and discarded;
  // writing only there would make the record as ephemeral as the stdout line
  // it replaced.
  state.liveness = proveInput.liveness;
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const proveInputPath = join(workDir, "prove-input.json");
  writeFileSync(proveInputPath, JSON.stringify(proveInput, null, 2));

  // #346: the reading is now CONSUMED. Written after the artefacts so the
  // record survives the refusal — a run that refuses here should still leave
  // behind the state that explains why.
  //
  // Not "refuse when liveness is UNMEASURED", which would reinstate the
  // false FAIL #304 removed. Only the contradiction: evidence claimed from a
  // server the run reports it never found.
  const contradictions = livenessEvidenceContradictions(state.acs || [], state.liveness || []);
  if (contradictions.length > 0) {
    console.error(`prove gate: FAIL — evidence claimed from a server whose liveness was never measured`);
    for (const c of contradictions) console.error(`  - ${c}`);
    console.error(
      `Set the tier's \`healthPath\` in .claude/rungate/config.json so liveness can be measured, ` +
      `or correct the evidence.`,
    );
    process.exit(1);
  }

  const proveProjectPrompt = join(__dirname, "prompts", "prove-reproducer.md");
  const proveHomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "prove-reproducer.md");
  const provePromptPath = existsSync(proveProjectPrompt) ? proveProjectPrompt : proveHomePrompt;
  if (existsSync(provePromptPath)) {
    console.log("B3: Spawning Prove Reproducer (Sonnet)...");
    let reproducerOutput = "";
    try {
      reproducerOutput = execSync(
        `cat '${proveInputPath}' | claude -p - --model sonnet --system-prompt-file "${provePromptPath}" --output-format text --allowedTools "Bash,Read" --max-turns 10`,
        { encoding: "utf-8", timeout: 180000, cwd: harnessRoot }
      );
    } catch (e: any) {
      reproducerOutput = e.stdout || "";
      console.warn(`WARN: B3 reproducer process exited with error: ${e.message?.slice(0, 200)}`);
    }

    const jsonMatch = reproducerOutput.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const proveEvidence = {
          issueNumber: issue, verdict: parsed.verdict || "INCONCLUSIVE",
          commitSHA: execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: projectRoot || undefined }).trim(),
          capturedAt: new Date().toISOString(),
          criteriaResults: parsed.criteriaResults || [],
          reproduced: parsed.reproduced ?? false,
          evidence: parsed.evidence || [],
          source: "B3-prove-reproducer",
        };
        writeFileSync(join(workDir, "prove-evidence.json"), JSON.stringify(proveEvidence, null, 2));
        console.log(`B3: prove-evidence.json written — verdict: ${proveEvidence.verdict}`);
      } catch {
        console.warn("WARN: B3 reproducer JSON parse failed");
      }
    } else {
      console.warn("WARN: B3 reproducer produced no parseable JSON — prove.test.ts will generate evidence");
    }
  }
}

// ── Scope pre-flight checks ─────────────────────────────────────────────

/**
 * Reduce a pre-validation reading to the lines the gate prints.
 *
 * Printing is all this does. The verdict reaches later checks through
 * workflow-state.json, not through stdout — see runScopePreflightsAndPersist.
 */
function reportPrevalidation(reading: EvidencePrevalidationReading): void {
  if (reading.verdict === "UNMEASURED") {
    console.error(`EVIDENCE PRE-VALIDATION: UNMEASURED — ${reading.reason}`);
    return;
  }

  const broken = reading.acs.filter((r) => r.status === "broken");
  const empty = reading.acs.filter((r) => r.status === "empty");
  const autoFixed = reading.acs.filter((r) => r.autoFixed);

  if (broken.length > 0) {
    console.error(`EVIDENCE PRE-VALIDATION: ${broken.length} AC(s) have broken evidence commands:`);
    for (const r of broken) {
      console.error(`  - ${r.id}: ${r.diagnostic}`);
    }
  }
  if (empty.length > 0) {
    console.warn(`EVIDENCE PRE-VALIDATION: ${empty.length} AC(s) have evidence commands that return empty output:`);
    for (const r of empty) {
      console.warn(`  - ${r.id}: command runs but produces no output`);
    }
  }
  if (autoFixed.length > 0) {
    console.log(`EVIDENCE PRE-VALIDATION: ${autoFixed.length} AC(s) auto-fixed: ${autoFixed.map((r) => r.id).join(", ")}`);
  }
  if (broken.length === 0 && empty.length === 0) {
    console.log(`EVIDENCE PRE-VALIDATION: all ${reading.acs.filter((r) => r.status === "ok").length} evidence commands validated OK`);
  }
}

export async function runScopePreflights(state: Record<string, any>, harnessRoot: string): Promise<void> {
  // Duplicate slug check (SC-44)
  const existingSlug = slugExists(state.issue);
  if (existingSlug && existingSlug !== state.slug) {
    console.warn(`WARN: Issue #${state.issue} already has slug "${existingSlug}" — current slug is "${state.slug}"`);
  }

  // Container rebuild check (SC-7)
  const canRebuild = shouldRebuildContainer(state.projectRoot || process.cwd());
  if (!canRebuild) {
    console.log("Container rebuild: SKIP (prod.rebuild is null)");
  }

  // Worktree branch naming (SC-136)
  if (state.worktree) {
    const branch = worktreeBranchName(state.issue, state.slug);
    console.log(`Worktree branch: ${branch}`);
    if (state.worktree?.activePorts) {
      const collision = checkPortCollision(state.worktree.basePort || 3000, state.worktree.offset || 0, state.worktree.activePorts);
      if (collision) console.error(`WARN: Port collision detected for offset ${state.worktree.offset}`);
    }
  }

  // File-set overlap detection (SC-69)
  if (state.parallelFiles && state.briefFiles) {
    const overlap = detectFileSetOverlap(state.parallelFiles, state.briefFiles);
    if (overlap.length > 0) {
      console.error(`WARN: File overlap with parallel issue: ${overlap.join(", ")}`);
    }
  }

  // Spec-compliance check
  try {
    execSync(`bun scripts/sync-spec-tests.ts 2>&1`, { encoding: "utf-8", timeout: 10000, cwd: harnessRoot });
  } catch { /* sync script failure is non-blocking */ }

  // Three outcomes, because there are three facts (#197). This used to print
  // `SPEC DRIFT DETECTED: spec-compliance tests failed` with an empty failure
  // list for every fixture project in the suite, because fixtures are not
  // this repo and have no spec-compliance suite — and `execSync` throws the
  // same way whether a test failed or the file was absent.
  {
    const missing = missingSpecComplianceFiles(harnessRoot);
    let ok = true;
    let output = "";
    if (missing.length === 0) {
      try {
        output = execSync(
          `bun test ${SPEC_COMPLIANCE_FILES.join(" ")} 2>&1`,
          { encoding: "utf-8", timeout: 30000, cwd: harnessRoot }
        );
      } catch (e) {
        ok = false;
        output = execErrorOutput(e);
      }
    }
    const v = classifySpecComplianceRun({ ok, output, missing });
    if (v.verdict === "DRIFT") {
      console.error(`SPEC DRIFT DETECTED: ${v.detail}`);
      console.error(`Run: bun test test/spec-compliance.test.ts — to see which claims drifted`);
      if (v.failures.length) console.error(v.failures.join("\n"));
    } else if (v.verdict === "UNMEASURED") {
      // Not an alarm, and not silence either. An alarm naming zero drifted
      // claims teaches its reader to skip the line, and a line everyone skips
      // is the same as no line on the run where it matters.
      //
      // But "this project has no suite" and "this project has the suite and
      // it did not produce a reading" are not the same news. The first is an
      // ordinary fact about a fixture; the second is a timeout, a crash, or a
      // suite that ran nothing in a repo that is supposed to run it, and it
      // needs the same visibility a failure gets. Only the first stays quiet.
      const noSuiteHere = missing.length >= SPEC_COMPLIANCE_FILES.length;
      const report = noSuiteHere ? console.log : console.error;
      report(`Spec compliance: UNMEASURED — ${v.detail}`);
    } else {
      console.log(`Spec compliance: ${v.detail}`);
    }
  }

  // Capture test baseline — pre-existing failures (#599, #307)
  //
  // An unmeasured baseline records NO number. Writing 0 beside a reason would
  // leave `?? 0` at the verify gate reading it as a measured clean tree, and
  // the two keys would be a second answer to the same question. Absent is the
  // only encoding a default cannot absorb.
  const testBaseline = captureTestBaseline(state);
  state.gateContract = state.gateContract || {};
  state.gateContract.baselines = state.gateContract.baselines || {};
  recordTestBaseline(state.gateContract.baselines, testBaseline);
  if (testBaseline.status === "measured") {
    console.log(
      testBaseline.failures > 0
        ? `Test baseline: ${testBaseline.failures} pre-existing failure(s) captured — will be subtracted at verify`
        : `Test baseline: 0 pre-existing failures — clean suite`,
    );
  } else {
    console.error(`Test baseline: UNMEASURED — ${testBaseline.reason}`);
  }

  // Track pre-existing failures (SC-33)
  if (state.preExistingFailures?.length > 0) {
    trackPreExistingFailures(state.slug, state.preExistingFailures);
  }

  await stampEvidencePrevalidation(state, "scope");
}

/**
 * Take the evidence pre-validation reading and stamp it on the state (#598).
 *
 * AWAITED (#235). This used to be `prevalidateEvidence(...).then(...)` with no
 * await: the function returned immediately, the gate wrote workflow-state.json
 * and launched the gate tests, and the verdict landed in stdout some time
 * afterwards — too late for anything to read, and with rejections swallowed
 * into a warning that looked the same as a clean run.
 *
 * One function rather than an inline block because there are now two gates
 * that need it (#261) and a second copy of this is a second source of truth
 * for a field whose whole purpose is to be the single reading.
 *
 * The cwd is `EVIDENCE_CWD` first (#264), which is what the evidence COLLECTOR
 * at `evidenceCwdForRefs` and `evidenceCwd` already uses. `workflows/ship.js`
 * sets it exactly when the gate's working directory differs from the project
 * root — that is, under the worktree isolation `marcus` always runs with. This
 * line read `state.projectRoot` and so dry-ran the branch's commands in the
 * MAIN repo, where the branch's new files do not exist, while the collector
 * ran the same commands in the worktree, where they do. One set of commands,
 * two directories, opposite answers; on run wf_c71f950f-c88 the three commands
 * this called broken reported 18 pass in the worktree. A pre-validator that
 * does not look where the evidence will be collected is not pre-validating
 * anything.
 */
export async function stampEvidencePrevalidation(
  state: Record<string, any>,
  takenAt: PrevalidationSource,
): Promise<void> {
  if (!(state.acs?.length > 0)) return;

  const evidenceCwd = process.env.EVIDENCE_CWD || state.projectRoot || process.cwd();
  const reading = { ...(await measureEvidencePrevalidation(state.acs, evidenceCwd)), takenAt };

  // Validated before it is stamped, not after: an unparseable reading must
  // not reach the file at all, and the refusal has to leave the state saying
  // "unmeasured" rather than silently saying nothing.
  const parsed = EvidencePrevalidationSchema.safeParse(reading);
  state.evidencePrevalidation = parsed.success
    ? reading
    : {
        verdict: "UNMEASURED",
        checkedAt: reading.checkedAt,
        takenAt,
        acs: [],
        reason:
          "the evidence pre-validation reading did not validate against EvidencePrevalidationSchema: " +
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400),
      };

  reportPrevalidation(state.evidencePrevalidation as EvidencePrevalidationReading);
}

/**
 * Make sure the reading exists before the verify gate's suite reads for it
 * (#261).
 *
 * The scope gate was the only writer, and `workflows/ship.js` skips the scope
 * gate outright when Discovery sizes a run LIGHT:
 *
 *     const skipScope = discovery.ceremonyTier === 'LIGHT'
 *
 * The consumer — `evidence-prevalidation` in gates/workflow.test.ts — is
 * guarded by `isVerifyPlus()`, so it ran anyway, and an absent reading is a
 * refusal (#235, correctly: "the writer never ran" and "the writer ran and
 * measured nothing" are the same failure). Composed, EVERY LIGHT-tier run
 * failed its verify gate on every attempt, regardless of the code it was
 * shipping, and no change to that code could have healed it. Run
 * wf_ed24496e-e49 reached VERIFY with all six ACs PASS and spent two heal
 * rounds against the gate's own plumbing.
 *
 * Same root as #126 with the sign flipped: there a check that could not fail,
 * here a check that could not pass, both because a check's phase did not imply
 * its producer's phase.
 *
 * A SCOPE reading is preserved. It measured this run's starting conditions,
 * and re-measuring them after Marcus has run answers a different question than
 * the one the scope gate's refusal was about.
 *
 * A VERIFY reading is RE-TAKEN (#264). The first version of this said "only
 * when absent", which froze both kinds alike, and that is the half of #261 the
 * fix for #261 reintroduced. Run wf_c71f950f-c88 made four verify attempts
 * over thirteen minutes with all six of its ACs PASS, every one of them judged
 * against one reading taken at 00:29 — so the heal rounds had nothing they
 * could change. A verify attempt is a new measurement opportunity by
 * definition: the whole point of the attempt is that the branch moved.
 *
 * "A reading exists" cannot tell those two apart, which is why the reading now
 * records which gate took it rather than being inferred from the tier. Absent
 * means a run older than this field, and absent is preserved — the behaviour
 * it already had.
 *
 * The reading does not mean quite the same thing on the two tiers, and that is
 * worth saying out loud rather than leaving for someone to infer wrongly. At
 * scope it means "these evidence commands were already broken before any work
 * started" — #598's point, which is to stop Marcus running against commands
 * that cannot produce evidence. Here it means "these evidence commands are
 * broken now". For the gate's actual question — can this run's claims be
 * evidenced? — the verify-time reading is the more relevant of the two, and a
 * LIGHT run has no earlier one to prefer. Nothing downstream consumes the
 * reading's auto-fix suggestions, so taking it late costs nothing but the
 * earliness #598 wanted, which a LIGHT run was never going to get.
 *
 * Persisting is the other half, and `runScopePreflightsAndPersist`'s comment
 * already says why: `runGateTests` spawns bun against workflow-state.json as
 * it stands on disk, so a reading written after the tests start is a reading
 * they never see. The write is one statement after the await for the same
 * reason it is there.
 */
export async function ensurePrevalidationPersisted(
  state: Record<string, any>,
  sf: string,
  takenAt: "verify" | "ship" = "verify",
): Promise<boolean> {
  if (!shouldRetakePrevalidation(state.evidencePrevalidation, takenAt)) return false;
  await stampEvidencePrevalidation(state, takenAt);
  writeFileSync(sf, JSON.stringify(state, null, 2));
  return true;
}

/**
 * Which gates take their own pre-validation reading, as one executable
 * function rather than a branch per gate in `runGate` (#280).
 *
 * `runGate` had `if (gate === "verify")` and nothing for ship, so the ship
 * gate consumed whatever block verify had left behind. The shape of that bug
 * is why this is a function: a per-gate branch inside a 300-line dispatch is
 * invisible to every test that does not spawn the whole gate, and the gate
 * spawns bun. Adding the ship branch there would have left the mapping
 * unprovable — measured, not assumed: with the branch inline, deleting it
 * scored ZERO red across 52 tests.
 *
 * The scope gate is absent on purpose. It takes its reading through
 * `runScopePreflightsAndPersist`, which has an ordering constraint of its own
 * (measure, then persist, before `runGateTests` spawns bun against the file),
 * and folding it in here would put one of the two writes out of that order.
 */
export async function prevalidationForGate(
  gate: string,
  state: Record<string, any>,
  sf: string,
): Promise<boolean> {
  if (gate !== "verify" && gate !== "ship") return false;
  return ensurePrevalidationPersisted(state, sf, gate);
}

/**
 * Does the gate now running need its OWN reading, or does the one on the state
 * still answer its question?
 *
 * One exported predicate, so there is one binding to mutate and one place the
 * policy is written down. Every previous fix in this family moved the boundary
 * one phase and stopped — #261 (producer in a phase the consumer did not
 * share), #264 (reading taken in the wrong directory and never re-taken on
 * heal), #280 (reading not re-taken at the next phase). The condition used to
 * be inline and phase-blind, which is how each of them got through.
 *
 * **At verify, a SCOPE reading survives.** It measured the run's starting
 * conditions, and re-measuring those after Marcus has run answers a different
 * question than the one the scope gate refuses on. A VERIFY reading does not
 * survive: the whole premise of another verify attempt is that the branch
 * moved, and freezing the reading means no heal round can clear a refusal.
 *
 * **At ship, nothing survives — this is #280's decision, taken explicitly
 * rather than inherited (SC-5).** The old condition, `takenAt !== "verify"`,
 * would have preserved a scope reading all the way to ship. That is defensible
 * one phase later and indefensible three: between verify and ship the run
 * commits, pushes, and may move the branch, and on run `wf_ea3e428f-64f` the
 * implementation never reached `projectRoot` at all, so the two readings
 * differed by four ACs. A reading whose own `takenAt` says it describes an
 * earlier tree is not evidence about the tree being shipped. Re-measuring is a
 * dry-run of commands that already ran once; the cost of taking it again is
 * far below the cost of a ship gate recording a stale artefact as current.
 *
 * An ABSENT reading is always re-taken, on both — that is the #261 case, and
 * it is the behaviour this already had.
 */
export function shouldRetakePrevalidation(
  existing: unknown,
  takenAt: "verify" | "ship",
): boolean {
  if (!existing || typeof existing !== "object") return true;
  if (takenAt === "ship") return true;
  return (existing as { takenAt?: unknown }).takenAt === "verify";
}

/**
 * The scope gate's pre-flight step: measure, then persist — in that order.
 *
 * The ordering is the whole point. `runGateTests` spawns bun against
 * workflow-state.json as it stands on disk, so a reading written after the
 * tests start is a reading they never see, and a gate check on a field that is
 * always absent is a check that cannot fail. The write is here, one statement
 * after the await, so the two cannot drift apart.
 *
 * writeFileSync rather than writeWorkflowState on purpose: the scope gate's
 * job is to REPORT an invalid state as a FAIL, and writeWorkflowState throws
 * on one, which would turn that report into a crash. The reading itself is
 * schema-validated in runScopePreflights before it is stamped on.
 */
export async function runScopePreflightsAndPersist(
  state: Record<string, any>,
  sf: string,
  harnessRoot: string,
): Promise<void> {
  await runScopePreflights(state, harnessRoot);
  writeFileSync(sf, JSON.stringify(state, null, 2));
}

// ── Verify pre-flight checks ────────────────────────────────────────────

function runVerifyPreflights(state: Record<string, any>): void {
  // Blast radius check (SC-59, SC-60)
  if (state.blastRadius) {
    const { filesRead = 0, filesChanged = 0 } = state.blastRadius;
    if (filesRead < filesChanged) {
      console.error(`WARN: Blast radius — read ${filesRead} files but changed ${filesChanged} (read should be >= changed)`);
    }
    const readWriteRatio = filesRead / Math.max(filesChanged, 1);
    if (readWriteRatio < 3) {
      console.error(`WARN: Read/write ratio ${readWriteRatio.toFixed(1)} (target >= 3:1)`);
    }
  }

  // Fix-on-find check (SC-109)
  if (state.foundIssues) {
    const dropped = (state.foundIssues || []).filter((i: any) => !i.disposition);
    if (dropped.length > 0) {
      console.error(`FAIL: ${dropped.length} found issues silently dropped — must be fixed, filed, or scoped out`);
    }
  }

  // Files changed outside brief scope (SC-134)
  if (state.filesChangedOutsideBrief?.length > 0) {
    console.error(`WARN: Files changed outside brief: ${state.filesChangedOutsideBrief.join(", ")}`);
  }

  // Scaffold refresh check (SC-38)
  if (shouldRefreshScaffold(state.slug)) {
    console.log("Post-verify: scaffold refresh recommended (verify gate PASS)");
  }

  // Research escalation check (SC-112)
  if (requiresResearchEscalation(state.slug)) {
    console.log("Research escalation: iteration 2+ — research tool invocation required before next attempt");
  }
}

// ── Type check ──────────────────────────────────────────────────────────

export function typeCheckCommand(state: Record<string, any>): string | null {
  // State first, config second — unchanged. What changed is that the config
  // half can now see a directory-layout project, which it could not, so a
  // consumer that configured `dev.typeCheck` and got no type check and no
  // message is no longer a reachable state (#311 SC-A8).
  //
  // `null` is a real authored value here: #87 made `typeCheck` nullable so
  // the scaffold can record "we looked and there is nothing to type-check",
  // which is a different fact from nobody configuring it. Both end in "do
  // not run a command", so this returns `null` for both and the caller does
  // not have to know which.
  const reading = readGateConfig(state.projectRoot || process.cwd());
  reportUnreadable("type check", reading);
  const fromConfig = reading.status === "resolved" ? reading.config.dev?.typeCheck : undefined;
  return state.dev?.typeCheck || fromConfig || null;
}

function runTypeCheck(state: Record<string, any>): void {
  const typeCheckCmd = typeCheckCommand(state);
  if (typeCheckCmd) {
    try {
      execSync(typeCheckCmd, { encoding: "utf-8", timeout: 30000, cwd: state.projectRoot || process.cwd() });
      console.log(`Type check PASS: ${typeCheckCmd}`);
    } catch (e: any) {
      console.error(`Type check FAIL: ${typeCheckCmd}`);
      console.error((e.stdout || "").split("\n").slice(0, 10).join("\n"));
    }
  }
}

// ── Test execution ──────────────────────────────────────────────────────

/**
 * Where the run's JUnit report goes (#532).
 *
 * The console output names only the FAILURES — bun 1.3.14 prints no `(pass)`
 * markers at all — so it cannot say which checks a gate ran and did not
 * fail, which is the one thing refusal retirement needs. The JUnit reporter
 * writes alongside the console output rather than replacing it, so a single
 * spawn still feeds the detail parser its `(fail)` lines.
 */
export function junitReportPath(workDir: string, gate: string): string {
  return join(workDir, `gate-${gate}-junit.xml`);
}

function runGateTests(gate: string, workDir: string, state: Record<string, any>, harnessRoot: string): { testOutput: string; testExitCode: number; junitPath: string } {
  let testOutput: string;
  let testExitCode = 0;
  const junitPath = junitReportPath(workDir, gate);
  try {
    testOutput = execSync(
      `bun test gates/ --test-name-pattern "${gate === 'scope' ? 'schema|scope' : gate === 'verify' ? 'schema|scope|verify|B1|B2' : gate === 'ship' ? 'schema|scope|verify|ship|B1|B2' : gate === 'prove' ? 'prove' : '.*'}" --reporter=junit --reporter-outfile=${JSON.stringify(junitPath)} 2>&1`,
      {
        encoding: "utf-8",
        timeout: GATE_SUITE_TIMEOUT_MS,
        cwd: harnessRoot,
        env: { ...process.env, TEST_WORK_DIR: workDir, GATE: gate, PROJECT_ROOT: state.projectRoot || process.cwd() },
      },
    );
  } catch (e: any) {
    testOutput = e.stdout || "";
    testExitCode = e.status || 1;
  }
  return { testOutput, testExitCode, junitPath };
}

// ── Result parsing ──────────────────────────────────────────────────────

function parseGateResults(testOutput: string, earlyResults: GateResult[], earlyFails: number): { passes: number; fails: number; warns: number; results: GateResult[] } {
  let passes = 0;
  let fails = 0;
  const warns = 0;
  const results: GateResult[] = [];

  const allPassMatches = [...testOutput.matchAll(/^\s*(\d+)\s+pass\s*$/gm)];
  const allFailMatches = [...testOutput.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
  const passMatch = allPassMatches.length > 0 ? allPassMatches[allPassMatches.length - 1] : null;
  const failMatch = allFailMatches.length > 0 ? allFailMatches[allFailMatches.length - 1] : null;
  if (passMatch) passes = parseInt(passMatch[1]);
  if (failMatch) fails = parseInt(failMatch[1]);

  results.push(...parseTestResults(testOutput));

  if (earlyResults.length > 0) {
    results.push(...earlyResults);
    fails += earlyFails;
  }

  if (results.length === earlyResults.length) {
    if (fails > 0) {
      results.push({ check: "test-suite", result: "FAIL", detail: `${fails} tests failed` });
    } else {
      results.push({ check: "test-suite", result: "PASS", detail: `${passes} tests passed` });
    }
  }

  return { passes, fails, warns, results };
}

// ── Conformity findings ─────────────────────────────────────────────────

/**
 * #213, second verdict-bearing catch.
 *
 * The `catch {}` at the end of this function covered both the read and the
 * parse, so a findings file that exists and cannot be read left
 * `state.conformityFindings` absent — exactly what a project with no findings
 * file at all produces. Every consumer tests `if (state.conformityFindings)`,
 * so "the conformity scan found nothing" and "the conformity scan's output is
 * corrupt" were the same value, and the second one reads as the first.
 *
 * The marker is a distinct shape rather than a thrown error on purpose. This
 * runs inside gate post-processing after the verdict is computed; making it
 * fatal would turn a bookkeeping fault into a crash. UNMEASURED has to be
 * recorded as UNMEASURED, and the one thing it must never do is pass for
 * clean.
 *
 * The error message is withheld from the recorded marker on purpose: a JSON
 * parse error quotes the bytes it choked on, and this file is machine-written
 * from a scan of the project. `err.name` says enough to tell a parse failure
 * from a read failure without copying file contents into workflow-state.json.
 */
export function unreadableConformityMarker(path: string, err: unknown): Record<string, unknown> {
  const name = err instanceof Error ? err.name : typeof err;
  return {
    unreadable: true,
    path,
    reason: name,
    detail:
      `${path} exists and could not be read as JSON (${name}). This is UNMEASURED, not an ` +
      `empty findings list — treat it as "the conformity scan's output is unusable".`,
  };
}

/** True when a recorded findings value is the unreadable marker above. */
export function conformityFindingsUnreadable(findings: unknown): boolean {
  return !!findings && typeof findings === "object" &&
    (findings as Record<string, unknown>).unreadable === true;
}

export function readConformityFindings(state: Record<string, any>): void {
  const projectRoot = state.projectRoot || process.cwd();
  const findingsPath = join(projectRoot, ".rungate", "conformity-findings.json");
  if (existsSync(findingsPath)) {
    try {
      const findings = JSON.parse(readFileSync(findingsPath, "utf-8"));
      if (findings.total > 0) {
        console.log(`\n── CONFORMITY FINDINGS (${findingsPath}) ──`);
        if (findings.findings?.length > 0) {
          console.log(`  Issues: ${findings.failures} FAIL, ${findings.warnings} WARN`);
          for (const f of findings.findings) {
            console.log(`  ${f.severity}: ${f.file} — ${f.message}`);
            if (f.fixCommand) console.log(`    Fix: ${f.fixCommand}`);
          }
        }
        if (findings.constraintCandidates?.length > 0) {
          console.log(`  Constraint candidates: ${findings.candidateCount} pending review`);
          for (const c of findings.constraintCandidates) {
            console.log(`    "${c.rule}" (${c.source})`);
          }
        }
        if (findings.staleness?.length > 0) {
          console.log(`  Stale docs: ${findings.staleCount}`);
          for (const s of findings.staleness) {
            console.log(`    ${s.file} — ${s.daysSince}d old (${s.type} threshold: ${s.threshold}d)`);
          }
        }
        console.log(`──────────────────────────────────────────`);
      }
      if (!state.conformityFindings) {
        state.conformityFindings = findings;
      }
    } catch (e) {
      const marker = unreadableConformityMarker(findingsPath, e);
      console.error(`WARN: ${marker.detail}`);
      if (!state.conformityFindings) {
        state.conformityFindings = marker;
      }
    }
  }
}

// ── Batch diagnosis ─────────────────────────────────────────────────────

function printBatchDiagnosis(fails: number, results: GateResult[]): void {
  if (fails > 0) {
    const failResults = results.filter(r => r.result === "FAIL");
    const infra = failResults.filter(r => /B1|B2|B3|adversary|reproducer|health|port/.test(r.check));
    const acRelated = failResults.filter(r => /evidence|verdict|AC|ac[- ]|threshold/.test(r.check));
    const chain = failResults.filter(r => /hash|chain|pushed|merge|spec-trace/.test(r.check));
    const other = failResults.filter(r => !infra.includes(r) && !acRelated.includes(r) && !chain.includes(r));

    console.log(`\nBATCH DIAGNOSIS: ${failResults.length} failures — fix all before re-running`);
    if (infra.length) console.log(`  Infrastructure (${infra.length}): ${infra.map(r => r.check.split(" > ").pop()).join(", ")}`);
    if (acRelated.length) console.log(`  AC/Evidence (${acRelated.length}): ${acRelated.map(r => r.check.split(" > ").pop()).join(", ")}`);
    if (chain.length) console.log(`  Chain integrity (${chain.length}): ${chain.map(r => r.check.split(" > ").pop()).join(", ")}`);
    if (other.length) console.log(`  Other (${other.length}): ${other.map(r => r.check.split(" > ").pop()).join(", ")}`);
  }
}

// ── B1/B2 agent logic ───────────────────────────────────────────────────

function spawnB1AdversaryAtScope(state: Record<string, any>, workDir: string, harnessRoot: string): void {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return;

  const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
  const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
  const promptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
  if (!existsSync(promptPath)) {
    console.warn("WARN: ac-adversary.md prompt not found — adversary will not run");
    return;
  }

  const reportPath = join(workDir, "adversary-report.json");
  try { unlinkSync(reportPath); } catch {}
  const acInputFile = join(workDir, "adversary-input.json");
  writeFileSync(acInputFile, JSON.stringify(state.acs || [], null, 2));
  const { spawn } = require("child_process");
  const child = spawn("sh", ["-c",
    `claude -p "$(cat '${acInputFile}')" --model haiku --system-prompt-file "${promptPath}" --output-format json --allowedTools "" --max-turns 3 > "${reportPath}.tmp" 2>/dev/null && mv "${reportPath}.tmp" "${reportPath}"`
  ], { detached: true, stdio: "ignore", cwd: harnessRoot });
  child.unref();
  console.log("B1: AC Adversary spawned in background — verify gate will check result");
}

/**
 * #304 — the probe used to curl a literal `${apiBase}/api/admin/health`.
 *
 * `apiBase` came from config; the path did not. It is one consumer's
 * route, and because this only runs for a project that sets `dev.apiBase` —
 * which rungate does not — DDB is the only project that has ever reached the
 * line. It worked for one consumer by coincidence.
 *
 * The decision now lives in `livenessPlan` in lib/dev-liveness.ts, which is
 * pure, so every branch is exercisable without a server. This function does
 * the one thing that needs a network. Three outcomes, all recorded:
 *
 *   not-applicable — nothing asked for a server. Silent, as before.
 *   unmeasured     — asked for, not configured. WARNed and recorded as a
 *                    WARN result, never as a FAIL. A probe with no route
 *                    reporting DOWN is a false FAIL on a healthy server, and
 *                    its stated remedy is to start something already running.
 *   probe          — exactly one http(s) URL, argv-form, no shell.
 */
/**
 * The `dev` shape `livenessPlan` asks about, off the normalised names (#311).
 *
 * `apiBase` is `apiUrl`, for `proveEnvironment`'s reason: the normaliser
 * collapses an authored `null` into absence, and a raw read would put the
 * second spelling of "not set" back in front of a probe that treats the two
 * differently.
 */
export function livenessDev(
  reading: GateConfigReading,
): { apiBase?: string; healthPath?: string; start?: string } | undefined {
  if (reading.status !== "resolved") return undefined;
  const c = reading.config;
  return {
    apiBase: c.apiUrl || undefined,
    healthPath: c.dev?.healthPath ?? undefined,
    start: c.dev?.start,
  };
}

function checkDevServerLiveness(state: Record<string, any>, results: GateResult[]): number {
  let addedFails = 0;
  if (!state.projectRoot) return 0;

  // The `catch { harness = null }` that was here is the instance
  // `.claude/rules/config-access.md` names by rule: it converted corruption
  // into absence, and absence into a probe that does not happen. Now the
  // three readings are distinct, and the unreadable one is said out loud
  // before being treated the way absence is — because the ALTERNATIVE for a
  // liveness probe with no target is reporting DOWN on a healthy server,
  // which is #304 and is worse (#311 SC-A8).
  const reading = readGateConfig(state.projectRoot);
  reportUnreadable("dev-server liveness", reading);
  const plan = livenessPlan(state.acs, livenessDev(reading));
  if (plan.kind === "not-applicable") return 0;

  if (plan.kind === "unmeasured") {
    results.push({
      check: "dev-server-liveness: UNMEASURED",
      result: "WARN" as const,
      detail: plan.detail,
    });
    console.log(`Dev server liveness: UNMEASURED — ${plan.detail}`);
    return 0;
  }

  try {
    // Argv form: both halves of the URL come out of the consumer's own
    // rungate.json and the old line interpolated them into a shell string.
    execFileSync("curl", ["-sf", "--max-time", "5", "--", plan.url], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // safeUrl everywhere it is printed or recorded: `detail` lands in
    // ship-evidence.json, which is durable (#213).
    console.log(`Dev server liveness: ${plan.safeUrl} — UP`);
  } catch {
    addedFails++;
    results.push({
      check: "dev-server-liveness: OUTCOME ACs require running dev server",
      result: "FAIL" as const,
      detail: `${plan.safeUrl} not responding — run '${plan.startHint}' first`,
    });
    console.log(`Dev server liveness: ${plan.safeUrl} — DOWN. Start with: ${plan.startHint}`);
  }
  return addedFails;
}

function checkB1ReportAtVerify(state: Record<string, any>, workDir: string, results: GateResult[]): { fails: number; warns: number } {
  let addedFails = 0;
  let addedWarns = 0;
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return { fails: 0, warns: 0 };

  const reportPath = join(workDir, "adversary-report.json");
  if (!existsSync(reportPath)) {
    addedFails++;
    results.push({ check: "B1-adversary: report missing", result: "FAIL" as const, detail: "adversary-report.json not found — adversary may still be running or failed. Re-run verify." });
    console.log("B1: adversary report not yet available — verify FAIL");
  } else {
    try {
      const raw = readFileSync(reportPath, "utf-8");
      const jsonMatch = raw.match(/\{[\s\S]*"gameable"[\s\S]*\}/);
      if (jsonMatch) {
        const report = JSON.parse(jsonMatch[0]);
        console.log(`B1: Adversary report — gameable: ${report.gameable}, approved: ${report.approved}`);
        if (report.gameable > 0) {
          let outcomeCount = 0;
          for (const exploit of report.exploits || []) {
            const ac = (state.acs || []).find((a: any) => a.id === exploit.acId);
            const isOutcome = ac?.type === "OUTCOME";
            if (isOutcome) {
              addedFails++;
              outcomeCount++;
              results.push({ check: `B1-adversary: ${exploit.acId} gameable (OUTCOME)`, result: "FAIL" as const, detail: exploit.exploit });
            } else {
              addedWarns++;
              results.push({ check: `B1-adversary: ${exploit.acId} gameable`, result: "WARN" as const, detail: exploit.exploit });
            }
          }
          if (outcomeCount > 0) console.log(`B1: ${outcomeCount} OUTCOME AC(s) gameable — FAIL (need behavioral evidence)`);
          const codeCount = (report.gameable || 0) - outcomeCount;
          if (codeCount > 0) console.log(`B1: ${codeCount} CODE AC(s) gameable — WARN`);
        }
      } else {
        console.warn("WARN: B1 adversary report has no parseable JSON — treating as incomplete");
      }
    } catch (e: any) {
      console.warn(`WARN: B1 report read failed: ${e.message?.slice(0, 200)}`);
    }
  }
  return { fails: addedFails, warns: addedWarns };
}

function runB2EvidenceValidation(state: Record<string, any>): void {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return;

  const scopeSha = state.gates?.scope?.commitSha;
  const fixSha = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();

  if (!scopeSha || !state.projectRoot) return;

  console.log("B2: Running evidence commands in clean worktree...");
  const tmpWorktree = join("/tmp", `pai-evidence-${Date.now()}`);

  try {
    execSync(`git worktree add "${tmpWorktree}" ${fixSha} --detach`, { cwd: state.projectRoot, encoding: "utf-8" });

    const verdicts: any[] = [];
    for (const ac of state.acs || []) {
      if (!ac.evidenceMethod?.command) continue;
      const cmd = ac.evidenceMethod.command;

      let fixOutput = "";
      try {
        fixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: tmpWorktree }).trim();
      } catch (e: any) {
        fixOutput = (e.stdout || "").trim() || `ERROR: ${e.message?.slice(0, 100)}`;
      }

      let preFixOutput = "";
      const scopeWorktree = join("/tmp", `pai-metamorphic-${Date.now()}`);
      try {
        execSync(`git worktree add "${scopeWorktree}" ${scopeSha} --detach`, { cwd: state.projectRoot, encoding: "utf-8" });
        preFixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: scopeWorktree }).trim();
      } catch {
        preFixOutput = "METAMORPHIC_SKIP";
      } finally {
        try { execSync(`git worktree remove "${scopeWorktree}" --force`, { cwd: state.projectRoot }); } catch {}
      }

      const actual = parseFloat(fixOutput) || 0;
      const expected = parseFloat(ac.threshold?.value || "0");
      const op = ac.threshold?.op || ">=";
      let passes = false;
      if (op === ">=") passes = !isNaN(actual) && actual >= expected;
      else if (op === "==") passes = fixOutput === String(ac.threshold?.value) || (!isNaN(actual) && actual === expected);
      else if (op === "!=") passes = fixOutput !== String(ac.threshold?.value);
      else if (op === ">") passes = !isNaN(actual) && actual > expected;
      else if (op === "<=") passes = !isNaN(actual) && actual <= expected;
      else if (op === "<") passes = !isNaN(actual) && actual < expected;
      else if (op === "contains") passes = fixOutput.includes(String(ac.threshold?.value || ""));
      else if (op === "exists") passes = fixOutput.length > 0;

      if (fixOutput === preFixOutput && preFixOutput !== "METAMORPHIC_SKIP") {
        console.warn(`WARN: metamorphic — ${ac.id} evidence identical pre/post fix (trivially satisfiable)`);
      }

      verdicts.push({
        acId: ac.id, command: cmd, rawOutput: fixOutput,
        threshold: ac.threshold, actual: fixOutput,
        verdict: passes ? "PASS" : "FAIL",
        metamorphic: fixOutput === preFixOutput ? "IDENTICAL" : "DIFFERENT",
      });
    }

    for (const v of verdicts) {
      const ac = (state.acs || []).find((a: any) => a.id === v.acId);
      if (ac) {
        ac.verdict = v.verdict;
        ac.evidence = { type: "command-output", content: v.rawOutput };
      }
    }

    console.log(`B2: ${verdicts.filter(v => v.verdict === "PASS").length}/${verdicts.length} evidence commands PASS`);
  } catch (e: any) {
    console.warn(`WARN: B2 worktree setup failed: ${e.message?.slice(0, 200)}`);
  } finally {
    try { execSync(`git worktree remove "${tmpWorktree}" --force`, { cwd: state.projectRoot }); } catch {}
  }
}

/**
 * Why the Verify fan-out is not going to run this time, or null if it is (#126).
 *
 * One function, one body, so the branches can be driven directly and the call
 * site can be mutated — `test/verify-fanout-recording.test.ts` does both. The
 * three conditions were previously inline and repeated on two `if`s with no
 * `else`, which is how the fan-out came to be skippable without a trace.
 *
 * Order is deliberate and is the reporting order, not a precedence accident:
 * a gate that already has failures is the reason a reader needs first, because
 * it is the one that explains the run. `RUNGATE_SKIP_AGENTS` is last because a
 * run with that set has usually also failed something, and reporting the env
 * var would bury the real cause.
 *
 * Returning null means RUN — the only path on which the agents are spawned, so
 * a new skip condition that forgets to come through here is a silent skip
 * again, and that is what the call-site mutation checks.
 */
export function fanoutSkipReason(
  fails: number,
  testExitCode: number,
  skipAgents: unknown,
): string | null {
  if (fails !== 0) return `verify gate had ${fails} failing check(s) before the fan-out`;
  if (testExitCode !== 0) return `the project test command exited ${testExitCode}`;
  if (skipAgents !== undefined && skipAgents !== null && skipAgents !== "") {
    return "RUNGATE_SKIP_AGENTS is set";
  }
  return null;
}

function runB2EvidenceValidatorAgent(state: Record<string, any>, workDir: string, results: GateResult[], harnessRoot: string): { agentResult: any; warns: number } {
  let addedWarns = 0;
  let agentResult: any = null;
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  // Recorded rather than returned empty (#126): the consumer allows a LIGHT
  // absence, but an artefact that SAYS why is one a reader does not have to
  // reconstruct the tier rules to interpret.
  if (tier === "LIGHT") return { agentResult: { skipped: "LIGHT ceremony tier" }, warns: 0 };

  const b2ProjectPrompt = join(__dirname, "prompts", "evidence-validator.md");
  const b2HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "evidence-validator.md");
  const b2PromptPath = existsSync(b2ProjectPrompt) ? b2ProjectPrompt : b2HomePrompt;
  if (!existsSync(b2PromptPath)) {
    console.warn("WARN: evidence-validator.md prompt not found — B2 agent will not run");
    // Recorded, not just warned (#126). A missing prompt disabled evidence
    // validation entirely, silently, and the gate check read the resulting
    // absence as clean. The run now carries the reason it did not happen.
    return { agentResult: { skipped: `evidence-validator.md prompt not found at ${b2PromptPath}` }, warns: 0 };
  }

  console.log("B2: Spawning Evidence Validator agent...");
  const b2Input = JSON.stringify({
    acs: (state.acs || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      threshold: ac.threshold, evidence: ac.evidence, verdict: ac.verdict,
      evidenceMethod: ac.evidenceMethod,
    })),
  }, null, 2);
  const b2InputPath = join(workDir, "b2-input.json");
  writeFileSync(b2InputPath, b2Input);

  let b2Output = "";
  try {
    b2Output = execSync(
      `cat '${b2InputPath}' | claude -p - --model haiku --system-prompt-file "${b2PromptPath}" --output-format text --allowedTools "" --max-turns 3`,
      { encoding: "utf-8", timeout: 60000, cwd: harnessRoot },
    );
  } catch (e: any) {
    b2Output = e.stdout || "";
    console.warn(`WARN: B2 Evidence Validator exited with error: ${e.message?.slice(0, 200)}`);
  }

  const b2Json = b2Output.match(/\{[\s\S]*"verdicts"[\s\S]*\}/);
  if (b2Json) {
    try {
      const b2Report = JSON.parse(b2Json[0]);
      agentResult = {
        ts: new Date().toISOString(),
        verdicts: b2Report.verdicts || [],
        source: "B2-evidence-validator-agent",
      };
      const b2Fails = (b2Report.verdicts || []).filter((v: any) => v.verdict === "FAIL");
      if (b2Fails.length > 0) {
        for (const v of b2Fails) {
          addedWarns++;
          results.push({ check: `B2-validator: ${v.acId} evidence gap`, result: "WARN" as const, detail: v.rawOutput || "threshold not met" });
        }
        console.log(`B2: ${b2Fails.length} evidence gap(s) found — WARN`);
      } else {
        console.log(`B2: All evidence validated — ${(b2Report.verdicts || []).length} ACs checked`);
      }
    } catch {
      console.warn("WARN: B2 Evidence Validator JSON parse failed");
    }
  } else {
    console.warn("WARN: B2 Evidence Validator produced no parseable JSON");
  }

  return { agentResult, warns: addedWarns };
}

function runB1AdversaryAtVerify(state: Record<string, any>, workDir: string, results: GateResult[], harnessRoot: string): { agentResult: any; warns: number } {
  let addedWarns = 0;
  let agentResult: any = null;
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return { agentResult: { skipped: "LIGHT ceremony tier" }, warns: 0 };

  const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
  const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
  const b1PromptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
  if (!existsSync(b1PromptPath)) {
    console.warn("WARN: ac-adversary.md prompt not found — B1 verify agent will not run");
    // Same as B2 above (#126): a missing prompt turned adversarial
    // verification off without a trace anyone downstream could read.
    return { agentResult: { skipped: `ac-adversary.md prompt not found at ${b1PromptPath}` }, warns: 0 };
  }

  console.log("B1: Spawning AC Adversary agent at verify...");
  const b1Input = JSON.stringify({
    acs: (state.acs || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      threshold: ac.threshold, evidence: ac.evidence, verdict: ac.verdict,
      evidenceMethod: ac.evidenceMethod,
    })),
  }, null, 2);
  const b1InputPath = join(workDir, "b1-verify-input.json");
  writeFileSync(b1InputPath, b1Input);

  let b1Output = "";
  try {
    b1Output = execSync(
      `cat '${b1InputPath}' | claude -p - --model haiku --system-prompt-file "${b1PromptPath}" --output-format text --allowedTools "" --max-turns 3`,
      { encoding: "utf-8", timeout: 60000, cwd: harnessRoot },
    );
  } catch (e: any) {
    b1Output = e.stdout || "";
    console.warn(`WARN: B1 AC Adversary exited with error: ${e.message?.slice(0, 200)}`);
  }

  const b1Json = b1Output.match(/\{[\s\S]*"gameable"[\s\S]*\}/);
  if (b1Json) {
    try {
      const b1Report = JSON.parse(b1Json[0]);
      agentResult = {
        ts: new Date().toISOString(),
        gameable: b1Report.gameable || 0,
        approved: b1Report.approved ?? true,
        exploits: b1Report.exploits || [],
        source: "B1-adversary-verify-agent",
      };
      if (b1Report.gameable > 0) {
        for (const exploit of b1Report.exploits || []) {
          addedWarns++;
          results.push({ check: `B1-adversary-verify: ${exploit.acId} gameable`, result: "WARN" as const, detail: exploit.exploit });
        }
        console.log(`B1: ${b1Report.gameable} gameable AC(s) found at verify — WARN`);
      } else {
        console.log(`B1: All ACs approved at verify — no exploits found`);
      }
    } catch {
      console.warn("WARN: B1 AC Adversary JSON parse failed");
    }
  } else {
    console.warn("WARN: B1 AC Adversary produced no parseable JSON");
  }

  return { agentResult, warns: addedWarns };
}

// ── Ship post-processing ────────────────────────────────────────────────

function runShipPreflights(state: Record<string, any>): void {
  releaseLock(state.slug);
  if (state.mergeQueue) {
    const ordered = sequentialMergeOrder(state.mergeQueue);
    const next = ordered[0];
    if (next && shouldRunCIVerification(next)) {
      console.log(`Next in merge queue: ${next.slug} (CI verification required)`);
    }
  }
}

// ── Merge gate ──────────────────────────────────────────────────────────

function runMergeGate(state: Record<string, any>, sf: string): never {
  const marcusBranch = state.agents?.marcus?.branch;
  const scopeSha = state.gates?.scope?.commitSha;

  let diffBase: string;
  if (marcusBranch && marcusBranch !== "main") {
    diffBase = `main...${marcusBranch}`;
  } else if (scopeSha) {
    diffBase = `${scopeSha}...HEAD`;
  } else {
    console.log("merge gate: no branch or scope SHA — skipping diff checks");
    const { resultVal, attempt } = writeGateResult(sf, "merge", 1, 0, 0, [], state.projectRoot);
    console.log(`Gate merge: ${resultVal} (attempt ${attempt})`);
    process.exit(0);
  }

  let mergePass = 0;
  let mergeFail = 0;
  const mergeResults: any[] = [];

  const deletedResult = execSync(`git diff ${diffBase} --diff-filter=D --name-only`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const deletedTests = deletedResult.split("\n").filter(f => /\.test\.(ts|tsx)$/.test(f));
  if (deletedTests.length > 0) {
    mergeFail++;
    mergeResults.push({ check: "merge: no test file deletions", result: "FAIL", detail: deletedTests.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: no test file deletions", result: "PASS" });
  }

  const changedResult = execSync(`git diff ${diffBase} --name-only`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const gateHookChanges = changedResult.split("\n").filter(f => /^(gates|hooks)\//.test(f));
  const issueTargetsGates = (state.issueGoal || "").toLowerCase().includes("gate");
  if (gateHookChanges.length > 0 && !issueTargetsGates) {
    mergeResults.push({ check: "merge: gate/hook modifications", result: "WARN", detail: gateHookChanges.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: gate/hook modifications", result: "PASS" });
  }

  const statResult = execSync(`git diff ${diffBase} --shortstat`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const insertions = parseInt((statResult.match(/(\d+) insertion/) || ["0","0"])[1]);
  const size = state.sizing?.predicted || "M";
  if ((size === "XS" && insertions > 200) || (size === "S" && insertions > 500)) {
    mergeResults.push({ check: "merge: scope proportionality", result: "WARN", detail: `${insertions} insertions for ${size} issue` });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: scope proportionality", result: "PASS" });
  }

  const { resultVal: mergeResultVal, attempt: mergeAttempt } = writeGateResult(sf, "merge", mergePass, mergeFail, 0, mergeResults, state.projectRoot);
  console.log(`Gate merge: ${mergeResultVal} (attempt ${mergeAttempt})`);
  process.exit(mergeResultVal === "PASS" ? 0 : 1);
}

// ── Prove gate post-processing ──────────────────────────────────────────

async function runProvePostProcessing(state: Record<string, any>, workDir: string, issue: number, issueRepo: string, resultVal: string): Promise<never> {
  const proveEvidencePath = join(workDir, "prove-evidence.json");
  if (existsSync(proveEvidencePath)) {
    try {
      const proveEvidence = JSON.parse(readFileSync(proveEvidencePath, "utf-8"));
      if (proveEvidence.verdict === "PROVEN" && issue && issueRepo) {
        try {
          // Use Octokit addLabels (POST additive — D-5) instead of gh CLI
          const github = createGitHubClient();
          await addLabels(github, issueRepo, issue, ["proven"]);
          console.log(`prove gate: added "proven" label to #${issue}`);
        } catch (e: any) {
          console.warn(`WARN: prove gate — failed to add proven label: ${e.message?.slice(0, 200)}`);
        }
      }
    } catch {
      // prove-evidence.json parse failure — already warned earlier
    }
  }
  process.exit(resultVal === "PASS" ? 0 : 1);
  throw new Error("unreachable");
}

// ── Ceremony override support ───────────────────────────────────────────

const PROTECTED_CHECKS = [
  "tests-pass",
  "tsc-pass",
  "code-committed",
  "all-acs-have-evidence",
  "all-acs-pass",
  "branch-merged",
  "code-pushed",
];

/**
 * Apply ceremony overrides from rungate.json and ensure protected checks are present.
 * Returns path to the modified ceremony profile (written to temp location).
 */
export function applyCeremonyOverrides(
  baseCeremonyPath: string,
  harnessConfig: ProjectHarness | null,
  projectRoot: string
): string {
  if (!existsSync(baseCeremonyPath)) {
    return baseCeremonyPath;
  }

  const baseProfile = JSON.parse(readFileSync(baseCeremonyPath, "utf-8"));

  // No overrides? Use base profile as-is
  if (!harnessConfig?.ceremonyOverrides) {
    return baseCeremonyPath;
  }

  // Deep merge overrides into base tiers
  const mergedProfile = { ...baseProfile };
  mergedProfile.tiers = deepMerge(baseProfile.tiers || {}, harnessConfig.ceremonyOverrides);

  // Validate protected checks are present in all tiers
  for (const [tierName, tierConfig] of Object.entries(mergedProfile.tiers)) {
    const checks = (tierConfig as any)?.checks;
    if (!checks || typeof checks !== "object") continue;

    for (const [gateName, checkList] of Object.entries(checks)) {
      if (!Array.isArray(checkList)) continue;

      // Find which protected checks apply to this gate
      const gateProtectedChecks = PROTECTED_CHECKS.filter(pc => {
        // tests-pass, tsc-pass, code-committed, all-acs-* belong to verify gate
        if (gateName === "verify" && ["tests-pass", "tsc-pass", "code-committed", "all-acs-have-evidence", "all-acs-pass"].includes(pc)) {
          return true;
        }
        // branch-merged, code-pushed belong to ship gate
        if (gateName === "ship" && ["branch-merged", "code-pushed"].includes(pc)) {
          return true;
        }
        return false;
      });

      // Re-add any missing protected checks
      const missing = gateProtectedChecks.filter(pc => !checkList.includes(pc));
      if (missing.length > 0) {
        console.warn(`WARN: Protected checks re-added to ${tierName}.${gateName}: ${missing.join(", ")}`);
        (checks as any)[gateName] = [...checkList, ...missing];
      }
    }
  }

  // Write merged profile to temp location
  const tempDir = join(projectRoot, ".rungate");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  const tempProfilePath = join(tempDir, "ceremony-profile-merged.json");
  writeFileSync(tempProfilePath, JSON.stringify(mergedProfile, null, 2));

  return tempProfilePath;
}

// ── Main executor ───────────────────────────────────────────────────────

export async function executeGate(input: GateExecutorInput): Promise<GateExecutorResult> {
  const { gate, slug, issue, workDir, stateFilePath: sf, harnessRoot } = input;

  const baseCeremonyProfile = existsSync(join(__dirname, "ceremony-profiles.json"))
    ? join(__dirname, "ceremony-profiles.json")
    : join(process.env.HOME || "", ".claude", "skills", "ship", "ceremony-profiles.json");

  const state = JSON.parse(readFileSync(sf, "utf-8"));
  const issueRepo = state.issueRepo || state.repo || "";

  // Validate rungate.json (SC-6)
  const harnessConfig = loadAndValidateHarness(state.projectRoot || "");

  // Apply ceremony overrides from rungate.json
  const CEREMONY_PROFILE = applyCeremonyOverrides(
    baseCeremonyProfile,
    harnessConfig,
    state.projectRoot || process.cwd()
  );

  // Auto-populate AC verdicts
  autoPopulateACs(state, sf);

  // Gaps gate: WARN-only mechanical drift detection
  if (gate === "gaps") {
    const projectRoot = state.projectRoot || process.cwd();
    const gapResults = scanGaps(projectRoot, workDir);

    console.log("\n── GAP SCANNER ──");
    console.log(`Drift checks: ${gapResults.warnings} WARN, ${gapResults.passes} PASS\n`);

    const results: GateResult[] = [];
    for (const gapResult of gapResults.results) {
      // Map SKIP to PASS for GateResult (which only supports PASS|FAIL|WARN)
      const mappedStatus = gapResult.status === "SKIP" ? "PASS" : gapResult.status;
      results.push({
        check: gapResult.check,
        result: mappedStatus,
        detail: gapResult.detail,
      });
      console.log(`${gapResult.status}: ${gapResult.check} — ${gapResult.detail}`);
    }

    // Gaps gate is WARN-only: never fails, never blocks ship
    const { resultVal, attempt } = writeGateResult(sf, "gaps", gapResults.passes, 0, gapResults.warnings, results, projectRoot);
    console.log(`\nGate gaps: ${resultVal} (attempt ${attempt}) — informational only, does not block ship`);

    return {
      resultVal: "PASS" as const,
      passes: gapResults.passes,
      fails: 0,
      warns: gapResults.warnings,
      results,
      attempt,
      exitCode: 0,
    };
  }

  // Early results accumulator
  let earlyResults: GateResult[] = [];
  let earlyFails = 0;

  // Verify gate: check for PENDING ACs
  if (gate === "verify") {
    const pending = checkVerifyPendingACs(state);
    earlyResults = pending.results;
    earlyFails = pending.failCount;
  }

  // B3: Prove Reproducer
  if (gate === "prove") {
    await runProveReproducer(state, issue, issueRepo, workDir, harnessRoot, sf);
  }

  // Scope pre-flight checks — awaited, and persisted before the gate tests
  // read the file (#235)
  if (gate === "scope") {
    await runScopePreflightsAndPersist(state, sf, harnessRoot);
  }

  // The reading the verify gate is about to check for, if nothing took it
  // (#261). Before the gate suite is spawned, which is the whole ordering
  // constraint — see ensurePrevalidationPersisted.
  await prevalidationForGate(gate, state, sf);

  // Type check (scope or verify)
  if (gate === "scope" || gate === "verify") {
    runTypeCheck(state);
  }

  // Verify pre-flight checks
  if (gate === "verify") {
    runVerifyPreflights(state);
  }

  // Ship pre-flight checks
  if (gate === "ship") {
    runShipPreflights(state);
  }

  // Set phase for gate tests
  const GATE_PHASE_MAP: Record<string, string> = { scope: "SCOPE", verify: "VERIFY", ship: "SHIP", prove: "DONE" };
  const gatePhase = GATE_PHASE_MAP[gate];
  if (gatePhase && state.phase !== gatePhase) {
    const priorPhase = state.phase;
    state.phase = gatePhase;
    writeFileSync(sf, JSON.stringify(state, null, 2));
    console.log(`Phase set to ${gatePhase} for gate tests (was ${priorPhase})`);
  }

  // Run tests
  const { testOutput, testExitCode, junitPath } = runGateTests(gate, workDir, state, harnessRoot);

  // Parse results
  let { passes, fails, warns, results } = parseGateResults(testOutput, earlyResults, earlyFails);

  // Subtract test baseline at verify gate (#599) — pre-existing failures don't block
  if (gate === "verify") {
    const adjustment = baselineAdjustment(state.gateContract?.baselines, fails);
    if (adjustment.kind === "subtract") {
      console.log(`Test baseline subtraction: ${fails} total - ${adjustment.baseline} baseline = ${adjustment.fails} new failure(s)`);
      fails = adjustment.fails;
    } else if (adjustment.kind === "unmeasured") {
      // #307. WARN, not FAIL: the house precedent is
      // `dev-server-liveness: UNMEASURED` above, and a probe that could not
      // run must never become a defect in the code it could not measure.
      warns++;
      results.push({
        check: "test-baseline: UNMEASURED",
        result: "WARN" as const,
        detail:
          `no pre-existing-failure count was taken at scope, so every failure below ` +
          `is attributed to this change — ${adjustment.reason}`,
      });
      console.warn(`Test baseline: UNMEASURED — ${adjustment.reason}`);
    }
  }

  // Did a heal round delete a test? (#307 SC-A19)
  //
  // Runs on every gate, not just verify: a heal round ends in a gate re-run
  // whichever gate it was healing, and the scope gate heals too.
  //
  // AFTER the baseline subtraction above, deliberately. This was written
  // before it and a security review caught the fail-open: a census FAIL
  // incremented into `fails` is indistinguishable from a suite failure to
  // `subtractTestBaseline`, so a run carrying three pre-existing failures
  // would have had the deleted-test refusal subtracted to zero. A baseline
  // is a statement about the SUITE and can say nothing about whether a heal
  // round removed a test.
  //
  // The census reads `treeUnderTest`, not `projectRoot`. On a decomposed run
  // the agent's edits are in a worktree, and a census of the main checkout
  // would compare a tree nobody touched against itself — green every round,
  // for the one kind of run this guard most needs to watch.
  {
    const censusRoot = state.treeUnderTest || state.projectRoot || process.cwd();
    const censusSkipped: string[] = [];
    const current = censusOf(censusRoot, censusSkipped);
    if (censusSkipped.length > 0) {
      // Reported every run. "No test was removed" is a sentence about the
      // files that were read, and a reader is owed the list it is not about.
      console.warn(
        `Test census: ${censusSkipped.length} file(s) too large to count and excluded from the ` +
          `comparison: ${censusSkipped.join(", ")}`,
      );
    }
    // The PREVIOUS census comes off disk, not off the in-memory `state`.
    // `state` was loaded when this process started; the gate tests and any
    // heal agent have been writing the file since. Comparing against the
    // stale copy and then persisting over the fresh one is how a round's
    // reading quietly disappears — and the direction it disappears in is
    // toward not refusing.
    const previous = readPersistedCensus(sf);
    const verdict = censusVerdict(previous, current);
    const banked = nextCensus(previous, current, verdict);
    state.gateContract = state.gateContract || {};
    state.gateContract.testCensus = banked;
    // To DISK, not just to `state` — `writeGateResult` below re-reads the
    // file, so an in-memory mutation here never lands and the next run
    // would find no census to compare against. See `persistTestCensus`.
    persistTestCensus(sf, banked);

    if (verdict.kind === "regression") {
      fails++;
      results.push({
        check: "test-census: a round removed tests",
        result: "FAIL" as const,
        detail:
          `${verdict.regressions.join("; ")}. A gate that passes because its test is gone ` +
          `is not a gate that passed. Restore the test, or say in the PR which check ` +
          `replaced it (#307 SC-A19).`,
      });
      console.error(`Test census: REFUSED — ${verdict.regressions.join("; ")}`);
    } else if (verdict.kind === "unmeasured") {
      // A WARN rather than silence. An empty census compares clean against
      // an empty census on every subsequent round, so a guard that said
      // nothing here would be permanently dead on a polyglot consumer and
      // would look exactly like a guard that keeps finding nothing wrong.
      warns++;
      results.push({
        check: "test-census: UNMEASURED",
        result: "WARN" as const,
        detail: `${verdict.reason} (tree: ${censusRoot})`,
      });
      console.warn(`Test census: UNMEASURED — ${verdict.reason}`);
    } else if (verdict.kind === "first-reading") {
      // Said out loud rather than passed quietly: a run with nothing to
      // compare has not been checked, and silence is how that becomes
      // "checked and clean".
      console.log(`Test census: first reading this run — ${verdict.files} test file(s), nothing to compare yet`);
    } else {
      console.log(`Test census: no test was removed (${verdict.files} file(s) compared)`);
    }
  }

  console.log(`\nTest results: ${passes} pass, ${fails} fail, ${warns} warn`);

  // Conformity findings
  readConformityFindings(state);

  // Batch diagnosis
  printBatchDiagnosis(fails, results);

  // B1/B2 agent logic
  let b2AgentResult: any = null;
  let b1VerifyAgentResult: any = null;

  if (gate === "scope" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    spawnB1AdversaryAtScope(state, workDir, harnessRoot);
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0) {
    fails += checkDevServerLiveness(state, results);
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    const b1Report = checkB1ReportAtVerify(state, workDir, results);
    fails += b1Report.fails;
    warns += b1Report.warns;
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    runB2EvidenceValidation(state);
  }

  // The fan-out runs, or records why it did not (#126).
  //
  // The guard below was three conditions repeated on two `if`s with no `else`,
  // so a verify gate that already had a failure skipped both agents and left
  // their slots empty — and the gate then printed "B2 agent may not have run",
  // which is true and reads like the cause when it is the consequence. On run
  // wf_e105dd33-220 that sent me looking for a crashed agent that had never
  // started.
  //
  // Skipping is still right: the gate is failing anyway and these agents are
  // expensive. Skipping SILENTLY is what made the absence unreadable.
  if (gate === "verify") {
    const fanoutSkip = fanoutSkipReason(fails, testExitCode, process.env.RUNGATE_SKIP_AGENTS);

    if (fanoutSkip) {
      console.log(`B1/B2: skipped — ${fanoutSkip}`);
      b2AgentResult = { skipped: fanoutSkip };
      b1VerifyAgentResult = { skipped: fanoutSkip };
    } else {
      const b2 = runB2EvidenceValidatorAgent(state, workDir, results, harnessRoot);
      b2AgentResult = b2.agentResult;
      warns += b2.warns;

      const b1 = runB1AdversaryAtVerify(state, workDir, results, harnessRoot);
      b1VerifyAgentResult = b1.agentResult;
      warns += b1.warns;
    }
  }

  // What this gate RAN, not only what it failed (#532).
  //
  // Read here rather than inside `writeGateResult` so the reading is taken
  // after every late push to `results` above — the AC-verdict failures, the
  // census WARN, the liveness probe. Those have no testcase behind them and
  // the JUnit report cannot know about them, so they are unioned in; a
  // `checksRun` that omitted them would not cover the failure ledger, and
  // the subtraction in lib/gate-refusal-currency.ts would read a check that
  // is still failing as resolved.
  const junit = readJunitCheckNames(junitPath);
  const checksRun = checksRunFrom(junit, results.map(r => r.check));
  if (checksRun === null) {
    // UNMEASURED, said out loud. An absent `checksRun` retires nothing, which
    // is the safe direction — but silence is how that becomes "this gate ran
    // nothing", and those are opposite facts.
    console.warn(`checksRun: UNMEASURED — ${junit.reason || "no reading"} (${junitPath})`);
  } else {
    console.log(`checksRun: ${checksRun.length} check(s) ran, ${junit.skipped} filtered out or skipped`);
  }

  // Write gate result
  const { resultVal, attempt } = writeGateResult(sf, gate, passes, fails, warns, results, state.projectRoot, checksRun);
  console.log(`Gate ${gate}: ${resultVal} (attempt ${attempt})`);

  // Persist B1/B2 agent results
  if (gate === "verify" && (b2AgentResult || b1VerifyAgentResult)) {
    const freshState = JSON.parse(readFileSync(sf, "utf-8"));
    freshState.gates = freshState.gates || {};
    freshState.gates.verify = freshState.gates.verify || {};
    if (b2AgentResult) {
      freshState.gates.verify.evidenceValidator = b2AgentResult;
    }
    if (b1VerifyAgentResult) {
      freshState.gates.verify.adversary = b1VerifyAgentResult;
    }
    if (state.conformityFindings) {
      freshState.conformityFindings = state.conformityFindings;
    }
    writeFileSync(sf, JSON.stringify(freshState, null, 2));
  }

  // Write tamper-evident witness
  try {
    const witnessPath = writeWitness(slug, gate, resultVal, testOutput, issue, state.projectRoot);
    console.log(`Witness: ${witnessPath}`);
  } catch (e: any) {
    console.error(`Witness write failed: ${e.message}`);
  }

  // Gate-specific post-processing (merge and prove exit directly)
  if (gate === "merge") {
    runMergeGate(state, sf);
  }

  if (gate === "prove") {
    await runProvePostProcessing(state, workDir, issue, issueRepo, resultVal);
  }

  // Ship-specific: HMAC + evidence
  if (gate === "ship" && resultVal === "PASS") {
    const hash = generateHmac(sf, slug, issue, state.projectRoot);
    console.log(`HMAC: ${hash}`);
    const evidencePath = generateShipEvidence(sf, workDir, issue, issueRepo, passes, fails, warns);
    console.log(`Ship evidence: ${evidencePath}`);
  }

  // Verify-specific: convergence
  if (gate === "verify" && resultVal === "FAIL" && existsSync(CEREMONY_PROFILE)) {
    const convergenceResult = runConvergence(sf, gate, resultVal, CEREMONY_PROFILE);
    if (convergenceResult.action === "circuit-break") {
      console.log(`CIRCUIT BREAK — iteration ${convergenceResult.iteration}`);
      return { resultVal, passes, fails, warns, results, attempt, exitCode: 2 };
    } else if (convergenceResult.action === "stall") {
      console.log(`STALL DETECTED — same failures, iteration ${convergenceResult.iteration}`);
    } else if (convergenceResult.action === "loop-back") {
      console.log(`LOOP-BACK — iteration ${convergenceResult.iteration}`);
    }
  }

  // Gate summary
  const sessionId = process.env.SESSION_ID || "unknown";
  const summaryResult = writeGateSummary(gate, passes, fails, warns, results, issue, slug, sessionId);
  const exitCode = summaryResult === "BLOCKED" ? 1 : 0;

  return { resultVal, passes, fails, warns, results, attempt, exitCode };
}
