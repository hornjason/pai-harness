/**
 * #1261 — the finding arbiter is wired into the `gh issue create` chokepoint.
 *
 * Covers CRC-B5 (CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * The DROPPED_CATEGORY rows below are the criterion, and they are here and
 * not in `test/finding-jury.test.ts` because the criterion is about findings
 * being dropped rather than about a classifier returning a word: the `WIRING`
 * assertion holds `hooks/VerifyPhaseLock.hook.ts` to calling `filingGate`, so
 * a style finding is refused at the chokepoint an agent actually reaches.
 * `classifyCategory` and the three-member `DROPPED_CATEGORIES` set are bound
 * in `test/finding-jury.test.ts`; nothing new is asserted for the id here.
 *
 * ## The channel, which is the whole reason this file is spawned and not unit-called
 *
 * **These hooks signal a refusal on STDOUT and always `process.exit(0)`.** So
 * an exit-code assertion here reads identically for a hook that blocked, a
 * hook that allowed, and a hook that was never wired at all — the sixth shape
 * in `.claude/rules/checks-must-be-able-to-fail.md`, *green on the exit code,
 * witnessing the wrong mechanism*. Every row below asserts on the parsed
 * stdout payload, and the refusal rows assert on `reason` text that only the
 * intended stage can emit: a DUPLICATE row names the colliding issue, a
 * DROPPED_CATEGORY row names the category.
 *
 * ## The order, which is also load-bearing
 *
 * Baseline and control are read FIRST, before any mutant is built. A mutation
 * table whose baseline was never read is an instrument that may simply have
 * stopped reporting (`.claude/rules/parallel-sessions.md`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  listOpenIssues,
  parseOwnerRepo,
  type OpenIssue,
  type OpenIssuePage,
} from "../lib/github";
import {
  adjudicateFiling,
  COMMAND_BLOCKED,
  corpusDropNote,
  corpusSlug,
  filingAttempts,
  filingBatch,
  filingGate,
  ghRepoTarget,
  markBlockedCommand,
  measuredCorpus,
  namedClaim,
  openFindings,
  openPrForBranch,
  priorRefusalFor,
  readBodyFile,
  readLedgerRows,
  SUCCESS_CLAIM_COUNT,
  trustedCorpus,
  unmeasuredCorpus,
  withTimeout,
  FILING_OVERRIDE_LABEL,
  LEDGER_SESSION_ENV,
  MAX_KEYS_PER_EXISTING_ISSUE,
  COMMENT_EXEMPTIONS,
  EXEMPTION_PREFIX,
  commentTargetSentence,
  declaredExemption,
  exemptionReason,
  filingFinding,
  intentsInRun,
  intentOrdinal,
  reserveAllowance,
  releaseAllowance,
  ledgerTitle,
  MAX_LEDGER_TITLE,
  overCapReason,
  namesARepository,
  runIdFor,
  waivableRefusal,
  UNWAIVABLE_REFUSALS,
  INTENT_KEY_SUFFIX,
  INTENT_PENDING,
  NON_CHECKOUT_RUN,
  RUN_WINDOW_MS,
  type CommentExemption,
  type CommentTarget,
  type FilingLedgerRow,
} from "../lib/issue-filing-gate";
import { DROPPED_CATEGORIES } from "../lib/finding-jury";
import type { ArbiterRefusal } from "../lib/finding-arbiter";
import type { FilingAdjudication } from "../lib/issue-filing-gate";
import { toplevel } from "../lib/launch-base";
import type { RemoteReading } from "../lib/worktree-repo";
import {
  readFindingOutcomes,
  summariseFindingOutcomes,
  type ReviewFinding,
} from "../evals/ai-review-control/outcomes";

const REPO = resolve(import.meta.dir, "..");
const HOOK = join(REPO, "hooks", "VerifyPhaseLock.hook.ts");

/**
 * An `OpenIssuePage` holding exactly these issues and nothing else.
 *
 * `considered` equals the length, which is what an ordinary page looks like:
 * `lib/github.ts` dropped none of it. The #1374 cases below supply a page
 * whose `considered` is HIGHER than its `issues`, and that is the input no
 * fixture shaped like a bare array can express — which is why the defect
 * survived two rounds of fixes to the same fail-open.
 */
const page = (issues: OpenIssue[], over: Partial<OpenIssuePage> = {}): OpenIssuePage => ({
  considered: issues.length,
  perPage: 100,
  truncated: false,
  droppedRows: [],
  issues,
  ...over,
});

/**
 * The open tracker the dedupe compares against.
 *
 * One issue, with a measured symptom: two readings (`144`, `234`), a third
 * (`5060`), one symbol and one path. `duplicateOverlap` needs two shared
 * quantities AND one shared location, so this fixture is what lets the two
 * filings below differ in exactly that axis.
 */
const OPEN_ISSUES = [
  {
    number: 900,
    title: "The retry loop drops commands on a long sweep",
    body:
      "`retryBudget` in lib/command-retry.ts gives up after 144 of 234 commands, " +
      "measured over 5060 invocations.",
  },
];

/**
 * Same symptom as #900, different prose. Must be refused as a DUPLICATE.
 *
 * The body is named separately so the inline and `--body-file` rows (#1300)
 * are driven by the SAME bytes. Two copies that drifted would make the pair
 * prove nothing: the whole claim is that where the body is stored does not
 * change the verdict.
 */
/**
 * Declared, since the sibling-refusal fix (#1595, 2026-10-25).
 *
 * This fixture's job is to be a DUPLICATE, and every case that overrides it
 * is about the waiver surviving — not about the declaration. Since the label
 * can no longer carry an UNDECLARED filing past any refusal, an undeclared
 * fixture would make those cases green for the new reason rather than the
 * one they were written for. The declaration is what keeps their one axis
 * the override. It changes nothing about the DUPLICATE verdict itself, which
 * is reached before the comment default is ever consulted.
 */
const DUPLICATE_BODY =
  "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts completes 144 of 234. " +
  `${EXEMPTION_PREFIX} out-of-pr-diff`;

const DUPLICATE_FILING =
  'gh issue create --title "retryBudget gives up early on long command sweeps" ' +
  `--body ${JSON.stringify(DUPLICATE_BODY)}`;

/**
 * A style/diagnostics finding. Refused before the tracker is ever read, which
 * is why this row needs no fixture agreement at all.
 */
const DROPPED_FILING =
  'gh issue create --title "The error message should name the legal values" ' +
  '--body "`legalValues` in lib/config-loader.ts is not printed when the check refuses. ' +
  `${EXEMPTION_PREFIX} out-of-pr-diff"`;

/**
 * What every ALLOW fixture in this file must now say, as the caller types it.
 *
 * One constant, built from the library's own prefix and one of its own
 * tokens, so a fixture cannot declare something `declaredExemption` does not
 * accept and no spelling of the declaration lives in two places.
 */
const DECLARED = `${EXEMPTION_PREFIX} out-of-pr-diff`;

/**
 * A novel correctness finding. Must be allowed.
 *
 * It names a claim because every ALLOW has to: `adjudicateFiling` converts a
 * claimless ALLOW into `NO_CLAIM`. Measured when that stage landed — 17 of
 * this file's cases went red, all of them ALLOW controls.
 *
 * It declares an exemption for the same reason, since #1595: a filing that
 * declares no reason it cannot be a comment is `COMMENT_INSTEAD`. Measured
 * when THAT stage landed — **25** of this file's cases went red, every one an
 * ALLOW control and not one of them for an unrelated reason, which is the
 * population it was built to catch.
 */
const NOVEL_BODY =
  `\`pullRequestCache\` in lib/pr-cache.ts holds 72 entries for 36 hours. Claim 4. ${DECLARED}`;

const NOVEL_FILING =
  'gh issue create --title "pullRequestCache is never invalidated" ' +
  `--body ${JSON.stringify(NOVEL_BODY)}`;

/**
 * A SECOND novel filing, sharing nothing with the first.
 *
 * `FG-165`'s two racers must differ in the finding as well as the process,
 * or the loser could be refused as a duplicate of the winner and the case
 * would go green having measured the dedupe.
 */
const SECOND_NOVEL_FILING =
  'gh issue create --title "branchIndex rebuilds on every read" ' +
  '--body "`branchIndex` in lib/branch-index.ts rescans 418 refs on each of 9120 reads. ' +
  `Claim 4. ${DECLARED}"`;

/**
 * The differential control the DUPLICATE row needs.
 *
 * Same symbol, same file, same `5060` — and the two readings that mattered
 * replaced. It shares ONE quantity where the duplicate shares three, so if
 * this row also blocked, the DUPLICATE row above would be witnessing "names a
 * known symbol" rather than "reports a known reading", and the threshold in
 * `duplicateOverlap` would not be the thing under test.
 */
const SAME_SYMBOL_NEW_READING =
  'gh issue create --title "retryBudget retries too often on a short sweep" ' +
  '--body "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts ' +
  `completes 88 of 97. Claim 4. ${DECLARED}"`;

interface HookReading {
  /** The parsed stdout payload, or `null` when the hook printed nothing. */
  payload: { decision?: string; reason?: string; systemMessage?: string } | null;
  blocked: boolean;
  reason: string;
  exit: number | null;
}

let scratch: string;
let ledger: string;
let issuesFile: string;
let mutantHook: string;

/**
 * A directory of its own for each hook invocation, unless one is named.
 *
 * **The cap counts per RUN and `runIdFor` reads the working directory**, so
 * every spawn sharing `scratch` would share one allowance: the first case in
 * this file to file an issue would spend it and every later case would be
 * `OVER_CAP` — a whole suite reddened by a mechanism none of it is about.
 * One directory per call makes each spawn its own run, which is what an
 * agent is in production, and the cap cases below pin a directory on
 * purpose so accumulation is something a case ASKS for rather than
 * something it inherits.
 */
let runSeq = 0;
function freshRun(): string {
  const dir = join(scratch, `run-${runSeq++}`);
  mkdirSync(dir, { recursive: true });
  checkoutAt(dir);
  return dir;
}

/** The origin a fixture checkout carries, so it is a run and not a bucket. */
const FIXTURE_ORIGIN = "https://github.com/hornjason/pai-harness.git";

/**
 * Make `dir` a checkout `runIdFor` will treat as its own run.
 *
 * **`git init` alone is deliberately not enough, and the fixture says so
 * rather than relying on it.** `runIdFor` buckets a checkout with no origin
 * into `NON_CHECKOUT_RUN`, because `git init /tmp/x` is one command and
 * would otherwise mint a fresh allowance — the bypass the security review
 * of PR #1597 found in the first spelling of this fixture, where `git init`
 * alone separated runs and the suite therefore ASSERTED that a scratch repo
 * is a run. The contract these fixtures encode is *a checkout of a
 * repository*, which is what an agent has in production.
 */
function checkoutAt(dir: string): void {
  // late-env-ok: the child is `git`, which reads none of the variables this
  // file writes — RUNGATE_OPEN_FINDINGS and the ledger session id are read by
  // the gate under test, in this process, never by a git subprocess.
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env } });
  expect(git("init", "-q", "-b", "main").status, `${dir} must be a real checkout`).toBe(0);
  expect(git("remote", "add", "origin", FIXTURE_ORIGIN).status, `${dir} must have an origin`).toBe(
    0,
  );
}

/**
 * `toplevel(dir)`, refusing rather than returning `null`.
 *
 * A case comparing a run id against `toplevel(dir)` is comparing against
 * `string | null`, and `null === null` would hold for a directory that is not
 * a checkout at all — i.e. the assertion would pass on a fixture that never
 * ran `git init`. Refusing here keeps the premise of the fixture separate
 * from the claim of the case.
 */
function checkoutTop(dir: string): string {
  const top = toplevel(dir);
  if (top === null) throw new Error(`${dir} is not a checkout, so the case proves nothing`);
  return top;
}

function runHook(
  hook: string,
  command: string,
  extraEnv: Record<string, string> = {},
  cwd: string = freshRun(),
): HookReading {
  const r = spawnSync("bun", [hook], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf-8",
    cwd,
    env: {
      ...process.env,
      RUNGATE_WORK_DIR: join(scratch, "work"),
      RUNGATE_OPEN_FINDINGS: issuesFile,
      RUNGATE_FINDING_LEDGER: ledger,
      // Pinned, not inherited. The ledger key is minted from this (#1318) and
      // an absent one is a LOUD reading — so without this line the rows below
      // that assert `systemMessage === null` pass on a developer's machine,
      // where Claude Code exports it, and go red in CI, where nothing does.
      // Measured: `env -u CLAUDE_CODE_SESSION_ID bun test <this file>` reddened
      // FG-48 and nothing else. The absent case is exercised deliberately, in
      // FG-70, rather than left to whatever the runner happens to have set.
      CLAUDE_CODE_SESSION_ID: "f9a1c0de-0000-4000-8000-000000000000",
      ...extraEnv,
    },
  });
  const out = (r.stdout ?? "").trim();
  let payload: HookReading["payload"] = null;
  if (out !== "") {
    try {
      payload = JSON.parse(out);
    } catch {
      payload = null;
    }
  }
  return {
    payload,
    blocked: payload?.decision === "block",
    reason: payload?.reason ?? payload?.systemMessage ?? "",
    exit: r.status,
  };
}

/**
 * The same hook, spawned so that two of them can be in flight at once.
 *
 * `runHook` is `spawnSync`, which cannot race anything: the first process has
 * exited before the second starts, so the second reads a ledger the first
 * already wrote and the TOCTOU window never opens. Two REAL processes is the
 * only configuration in which the defect exists at all — one process calling
 * `filingGate` twice is serialised by `await` — so `FG-165` needs this and
 * nothing else in the file does.
 */
function runHookAsync(
  command: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<HookReading> {
  return new Promise(done => {
    // late-env-ok: every variable this child reads is passed explicitly
    // below. Nothing is inherited from an assignment made after startup.
    const child = spawn("bun", [HOOK], {
      cwd,
      env: {
        ...process.env,
        RUNGATE_WORK_DIR: join(scratch, "work"),
        RUNGATE_OPEN_FINDINGS: issuesFile,
        RUNGATE_FINDING_LEDGER: ledger,
        CLAUDE_CODE_SESSION_ID: "f9a1c0de-0000-4000-8000-000000000000",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", code => {
      let payload: HookReading["payload"] = null;
      try {
        payload = JSON.parse(out.trim());
      } catch {
        payload = null;
      }
      done({
        payload,
        blocked: payload?.decision === "block",
        reason: payload?.reason ?? payload?.systemMessage ?? "",
        exit: code,
      });
    });
    child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  });
}

function everyLedgerRow(): FilingLedgerRow[] {
  let text = "";
  try {
    text = readFileSync(ledger, "utf-8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(l => JSON.parse(l) as FilingLedgerRow);
}

/**
 * The DECISION rows — one per adjudicated clause, which is what almost every
 * case here means by "a row".
 *
 * A filing the gate allows also leaves an INTENT row, appended before the
 * decision to reserve the run's allowance (`FilingLedgerRow.intent`). It is a
 * second row about the same clause and it is not a decision, so counting it
 * here would turn "one clause, one countable row" into "one clause, one or
 * two depending on the verdict" everywhere in this file.
 *
 * Read `ledgerIntents()` for that population. It is asserted directly rather
 * than left to this filter — `FG-164` holds the intent row's shape, and
 * `FG-166` holds that an allowed filing writes exactly one of each.
 */
function ledgerRows(): FilingLedgerRow[] {
  return everyLedgerRow().filter(r => r.intent !== true);
}

/**
 * `runIdFor`'s answer as a bare string, for the cases that are not about
 * the reading itself.
 *
 * `runIdFor` returns three states — a checkout, the shared bucket, and
 * `null` for a remote read that FAILED — because collapsing the third into
 * the second moves a real checkout into the shared allowance whenever git
 * times out. Only `FG-174` is about that; everywhere else the run is an
 * input and this unwraps it. The sentinel is deliberately not a real run id,
 * so a case that reaches it by accident cannot quietly match anything.
 */
const runOf = (dir: string): string => runIdFor(dir).run ?? "UNREADABLE-RUN";

/** The reservations — see `ledgerRows()`. */
function ledgerIntents(): FilingLedgerRow[] {
  return everyLedgerRow().filter(r => r.intent === true);
}

/**
 * The cap, held fixed for a case that is measuring something else.
 *
 * An empty allowance on every read and an intent that lands nowhere, so one
 * case can file repeatedly from one directory without its second filing
 * being `OVER_CAP`. Spread it into a `filingGate` call that is about another
 * stage; the cap's own cases inject neither of these.
 */
const noCap = {
  readLedger: () => [] as FilingLedgerRow[],
  appendLedger: () => true,
};

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rg-filing-gate-"));
  ledger = join(scratch, "finding-ledger.jsonl");
  // **In THIS process too, not only in the hook children.** `runHook` has
  // always passed the temp ledger in the child's environment, so the cases
  // that call `filingGate` directly without injecting `readLedger` were
  // reading the developer's live `~/.rungate/finding-ledger.jsonl` — which
  // was invisible while the gate only read it, and stopped being invisible
  // the moment it started appending intent rows: a suite run put 57 fixture
  // rows into the live file and the next case read "this run has already
  // filed 25 issues". Setting it here is also the only thing that makes
  // those cases deterministic.
  process.env.RUNGATE_FINDING_LEDGER = ledger;
  // Pinned in THIS process for the same reason `runHook` pins it in the
  // children: `filingBatch` returns `null` without it, so every row an
  // in-process `filingGate` call writes carries `key: null` and no two rows
  // can be told apart. CI sets no session id, so `FG-166`'s premise — two
  // reservations with different keys — held on a developer's machine and
  // failed on the runner. The absent case is exercised deliberately, by
  // `withSession(undefined, …)` in FG-70, which saves and restores this.
  process.env[LEDGER_SESSION_ENV] = "f9a1c0de-0000-4000-8000-000000000000";
  issuesFile = join(scratch, "open-issues.json");
  writeFileSync(issuesFile, JSON.stringify(OPEN_ISSUES), "utf-8");
  // An empty work dir, so `findActiveWorkflow` reads no VERIFY phase and gate
  // 1 cannot be the thing that blocks any row below.
  mkdirSync(join(scratch, "work"), { recursive: true });

  // The mutant lives in a scratch `hooks/` whose `lib` and `hooks/lib` are
  // symlinks to the real ones, so the hook's relative imports resolve to the
  // code under test. A mutant that fails to LOAD exits non-zero and prints
  // nothing, which on this channel is indistinguishable from a hook that
  // allowed — so `mutant loads and still allows` is asserted explicitly below.
  const mutantDir = join(scratch, "hooks");
  mkdirSync(mutantDir, { recursive: true });
  symlinkSync(join(REPO, "lib"), join(scratch, "lib"));
  symlinkSync(join(REPO, "hooks", "lib"), join(mutantDir, "lib"));

  const WIRING = "const gate = await filingGate(cmd, { projectRoot: process.cwd() });";
  const source = readFileSync(HOOK, "utf-8");
  const occurrences = source.split(WIRING).length - 1;
  // Seventh shape: a mutation that did not apply reddens for the wrong
  // reason, and reads exactly like one that did.
  expect(occurrences, `the wiring line must appear exactly once in ${HOOK}`).toBe(1);
  mutantHook = join(mutantDir, "VerifyPhaseLock.mutant.ts");
  writeFileSync(
    mutantHook,
    source.replace(WIRING, "const gate = { refusal: null, note: null, rows: [] };"),
    "utf-8",
  );
});

/**
 * One case, one ledger. **Required since the cap writes to it (#1595).**
 *
 * The ledger used to be read-only to this process and append-only across the
 * file, so a case could ignore what earlier cases had left in it. The cap
 * reserves an allowance by appending an intent row, and every case that does
 * not name a checkout files from `scratch`, which is one `NON_CHECKOUT` run
 * — so without this the FIRST filing in the file spends the allowance and
 * every later case reads `OVER_CAP`. Measured: 5 cases red, each of them
 * green when run alone, which is the worst way to find this.
 */
beforeEach(() => {
  if (ledger !== undefined) writeFileSync(ledger, "", "utf-8");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("#1261 the parts the decision is built from", () => {
  test("FG-1: a `gh issue create` clause yields its title, body and labels", () => {
    const attempts = filingAttempts(DUPLICATE_FILING);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].title).toBe("retryBudget gives up early on long command sweeps");
    expect(attempts[0].body).toContain("lib/command-retry.ts");
    expect(attempts[0].bodyFile).toBeNull();
  });

  test("FG-27: a repeated --body-file takes the LAST, as `gh` does", () => {
    // `filingAttempts` claims `gh` semantics in a comment; this is the only
    // thing that makes that claim checkable. Reading the first would
    // adjudicate a body the filing is not going to use.
    const attempts = filingAttempts(
      'gh issue create --title t --body-file /first.md --body-file /second.md',
    );
    expect(attempts[0].bodyFile).toBe("/second.md");
  });

  test("FG-2: a command that creates nothing yields no attempt", () => {
    expect(filingAttempts('echo "gh issue create --title x"')).toEqual([]);
    expect(filingAttempts("gh issue list --state open")).toEqual([]);
  });

  test("FG-3: a create hidden behind a comment clause is still a create", () => {
    const attempts = filingAttempts('gh issue comment 900 --body ok && gh issue create --title "x"');
    expect(attempts).toHaveLength(1);
  });

  /**
   * The AI review's second finding on #1282.
   *
   * An attached short flag — `-tFoo` — was recognised by the query collecting
   * `--title` and read as an unknown flag by every other query, so a walk
   * looking for `--body` or `--label` consumed the token AFTER it. The body
   * was dropped, the finding arrived with no symptom, and it escaped the
   * dedupe as UNMEASURED. One arity table, consulted by all three.
   */
  test("FG-19: an attached short flag consumes nothing, so no later flag is dropped", () => {
    const [a] = filingAttempts(
      'gh issue create -tretryBudget --body "`retryBudget` in lib/command-retry.ts" --label bug',
    );
    expect(a.title).toBe("retryBudget");
    expect(a.body, "the body was eaten by the attached -t").toContain("lib/command-retry.ts");
    expect(a.labels, "the label was eaten too").toEqual(["bug"]);
  });

  test("FG-20: every query agrees about where an unrelated attached short ends", () => {
    const [a] = filingAttempts('gh issue create -aalice --title "x" --body "y" --label follow-up');
    expect(a.title).toBe("x");
    expect(a.body).toBe("y");
    expect(a.labels).toEqual(["follow-up"]);
  });

  test("FG-4: an unreadable tracker is UNMEASURED, never ALLOW", async () => {
    const v = await adjudicateFiling(filingAttempts(NOVEL_FILING)[0], async () =>
      unmeasuredCorpus("the open-issue set could not be read"),
    );
    expect(v.outcome).toBe("UNMEASURED");
    expect(v.refusal).toBe("UNMEASURED");
  });

  test("FG-5: an EMPTY tracker is a reading, and allows", async () => {
    const v = await adjudicateFiling(filingAttempts(NOVEL_FILING)[0], async () => measuredCorpus([]));
    expect(v.outcome).toBe("ALLOW");
    expect(v.refusal).toBeNull();
  });

  test("FG-15: a dropped category refuses without ever reading the tracker", async () => {
    let asked = 0;
    const v = await adjudicateFiling(filingAttempts(DROPPED_FILING)[0], async () => {
      asked += 1;
      return measuredCorpus([]);
    });
    expect(v.refusal).toBe("DROPPED_CATEGORY");
    // The cost order is the claim, so it is measured and not asserted in prose.
    expect(asked, "the free stage must run before the one that costs an API call").toBe(0);
  });

  /**
   * The AI review's finding on #1282, turned into a case.
   *
   * `title.trim() === ""` was one disjunct of the UNMEASURED test, so a
   * filing with no `--title` and a body naming the symptom skipped the dedupe
   * entirely — and reported "names no symbol, no file and no reading" about a
   * body naming all three. The reason was false for exactly the input that
   * triggered it, which is the only kind of wrong reason that matters.
   */
  test("FG-17: a blank title does not stop the body being deduplicated", async () => {
    const attempt = {
      title: "",
      body: "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts completes 144 of 234.",
      labels: [],
      bodyFile: null,
      repo: null,
      repeatedValueFlag: false,
    };
    const v = await adjudicateFiling(attempt, async () =>
      measuredCorpus(OPEN_ISSUES.map(i => ({ id: String(i.number), title: i.title, body: i.body }))),
    );
    expect(v.outcome).toBe("REFUSE");
    expect(v.refusal).toBe("DUPLICATE");
    expect(v.duplicateOf).toEqual(["900"]);
  });

  const fromFile = (path: string) => ({
    title: "retryBudget misbehaves",
    body: "",
    labels: [] as string[],
    bodyFile: path,
    repo: null,
    repeatedValueFlag: false,
  });
  const tracker = async () =>
    measuredCorpus(OPEN_ISSUES.map(i => ({ id: String(i.number), title: i.title, body: i.body })));

  test("FG-18: a body-file that cannot be read is UNMEASURED, and says which file", async () => {
    // The arm #1300 narrowed, not removed. A reader returning `null` is the
    // only thing that reaches it now.
    const v = await adjudicateFiling(fromFile("/nope/missing.md"), tracker, () => null);
    expect(v.outcome).toBe("UNMEASURED");
    expect(v.refusal).toBe("UNMEASURED");
    // A reason naming the file, because the old one ("the body is in a file")
    // was true of readable files too and told the reader nothing to act on.
    expect(v.reason).toContain("/nope/missing.md");
  });

  test("FG-24: a body-file IS read, and a duplicate in it is refused", async () => {
    const v = await adjudicateFiling(
      fromFile("/planted/body.md"),
      tracker,
      p => (p === "/planted/body.md" ? DUPLICATE_BODY : null),
    );
    expect(v.outcome).toBe("REFUSE");
    expect(v.refusal).toBe("DUPLICATE");
    expect(v.duplicateOf).toEqual(["900"]);
  });

  test("FG-25 CONTROL: a body-file with a NOVEL body is allowed", async () => {
    // Pins FG-24 to the bytes rather than to the flag. Same path, same
    // reader, different content — the only axis that moved.
    const v = await adjudicateFiling(
      fromFile("/planted/body.md"),
      tracker,
      () => NOVEL_BODY,
    );
    expect(v.outcome).toBe("ALLOW");
  });

  test("FG-26: readBodyFile refuses stdin, an absent path and an oversized file", () => {
    // The real reader, since every row above plants one. Its three `null`
    // arms are the whole of what makes FG-18 reachable in production.
    const at = join(scratch, "fg26-body.md");
    writeFileSync(at, "x".repeat(64), "utf-8");
    expect(readBodyFile("-")).toBeNull();
    expect(readBodyFile(join(scratch, "fg26-absent.md"))).toBeNull();
    expect(readBodyFile(at, 8)).toBeNull();
    // The control: the same file, under a limit that admits it. Without this
    // every row above is consistent with a reader that returns null always.
    expect(readBodyFile(at, 1024)).toBe("x".repeat(64));
    // An EMPTY file is read, not refused — it lands on "names no symbol".
    const empty = join(scratch, "fg26-empty.md");
    writeFileSync(empty, "", "utf-8");
    expect(readBodyFile(empty)).toBe("");
  });

  test("FG-16: listOpenIssues drops pull requests, which the REST API returns as issues", async () => {
    const client = {
      rest: {
        issues: {
          listForRepo: async () => ({
            data: [
              { number: 10, title: "a real issue", body: "x" },
              { number: 11, title: "a pull request", body: "y", pull_request: { url: "…" } },
            ],
          }),
        },
      },
    } as unknown as Parameters<typeof listOpenIssues>[0];
    const read = await listOpenIssues(client, "owner/repo");
    expect(read.issues.map(i => i.number)).toEqual([10]);
    // #1374: the drop is now REPORTED, and the population it was drawn from
    // travels with it. Under the old return shape a caller could only count
    // what survived, so this row's own fixture — two rows in, one out — was
    // indistinguishable from a tracker holding one issue.
    expect(read.considered, "two rows arrived").toBe(2);
    expect(read.droppedRows).toEqual([{ number: 11, reason: "pull-request" }]);
  });
});

describe("#1261 the hook reaches the adjudication — read on stdout, not on the exit code", () => {
  /**
   * Both baselines and both controls are read here, before the mutant rows
   * below touch anything.
   */
  test("FG-6 BASELINE: a duplicate filing is blocked, and the refusal names the issue", () => {
    const r = runHook(HOOK, DUPLICATE_FILING);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("DUPLICATE");
    // Only the dedupe can produce this: the colliding issue's number.
    expect(r.reason).toContain("#900");
    // **The refusal says a waiver exists and does NOT spell it** (#1595,
    // 2026-10-25). This line read `toContain(FILING_OVERRIDE_LABEL)` until
    // the refusal stopped handing the token over: the old text was a recipe
    // with its own permission attached — *"if this one genuinely is the
    // exception"* — and every filing believes that of itself. The token now
    // appears only on a refusal no label waives, to deny it. FG-176 holds
    // both halves.
    expect(r.reason, "the refusal hands the override token to the agent").not.toContain(
      FILING_OVERRIDE_LABEL,
    );
    expect(r.reason, "and it still says a waiver exists, with its cost").toContain(
      "A label waives this refusal",
    );
    // And the exit code says nothing, which is why nothing above reads it.
    expect(r.exit).toBe(0);
  });

  test("FG-7 BASELINE: a diagnostics filing is blocked, and the refusal names the category", () => {
    const r = runHook(HOOK, DROPPED_FILING);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("DROPPED_CATEGORY");
    expect(r.reason).toContain("diagnostics");
    expect(r.exit).toBe(0);
  });

  test("FG-8 CONTROL: a novel finding is allowed", () => {
    const r = runHook(HOOK, NOVEL_FILING);
    expect(r.blocked).toBe(false);
  });

  test("FG-9 CONTROL: the same symbol with a different reading is allowed", () => {
    const r = runHook(HOOK, SAME_SYMBOL_NEW_READING);
    expect(r.blocked).toBe(false);
  });

  test("FG-10 CONTROL: a command that creates no issue is allowed and records nothing", () => {
    const before = ledgerRows().length;
    const r = runHook(HOOK, "git -C . status --short");
    expect(r.blocked).toBe(false);
    expect(ledgerRows().length).toBe(before);
  });

  test("FG-11: the override label waives the refusal and is recorded as a waiver", () => {
    const r = runHook(HOOK, `${DUPLICATE_FILING} --label ${FILING_OVERRIDE_LABEL}`);
    expect(r.blocked).toBe(false);
    const row = ledgerRows().at(-1)!;
    expect(row.overridden).toBe(true);
    expect(row.emitted).toBe(true);
    expect(row.refusal).toBe("DUPLICATE");
  });

  test("FG-12: an unreadable tracker allows the filing and says UNMEASURED out loud", () => {
    const r = runHook(HOOK, NOVEL_FILING, { RUNGATE_OPEN_FINDINGS: join(scratch, "absent.json") });
    expect(r.blocked).toBe(false);
    expect(r.payload?.systemMessage ?? "").toContain("UNMEASURED");
    expect(ledgerRows().at(-1)!.refusal).toBe("UNMEASURED");
  });

  /**
   * #1300, end to end, in the real process that does the reading.
   *
   * The unit rows below plant a reader; this one plants a FILE and lets the
   * hook open it. Both are needed: a reader injected in-process proves the
   * decision, and only this proves the wiring passes a path the spawned hook
   * can actually resolve.
   *
   * Measured before the fix: this row was ALLOWED with `UNMEASURED`, on a
   * body byte-identical to FG-6's, which blocks. That pair is the finding.
   */
  test("FG-21: a duplicate arriving by --body-file is blocked, exactly as inline", () => {
    const at = join(scratch, "fg21-body.md");
    // The SAME bytes FG-6 passes inline, so the pair differs in one axis.
    writeFileSync(at, DUPLICATE_BODY, "utf-8");
    const r = runHook(
      HOOK,
      `gh issue create --title "retryBudget gives up early on long command sweeps" --body-file ${at}`,
    );
    expect(r.blocked, `hook said: ${JSON.stringify(r.payload)}`).toBe(true);
    expect(r.reason).toContain("DUPLICATE");
    expect(r.reason).toContain("#900");
  });

  /**
   * The control FG-21 needs, and it is the one that stops this becoming a
   * gate on "used --body-file". Same flag, same mechanism, different bytes.
   */
  test("FG-22 CONTROL: a NOVEL finding arriving by --body-file is allowed", () => {
    const at = join(scratch, "fg22-body.md");
    writeFileSync(at, NOVEL_BODY, "utf-8");
    const r = runHook(HOOK, `gh issue create --title "pullRequestCache is never invalidated" --body-file ${at}`);
    expect(r.blocked).toBe(false);
  });

  test("FG-23: a --body-file that does not exist is UNMEASURED, and still files", () => {
    // The arm narrows; it does not disappear. A finding nobody could read is
    // not a finding that was rejected.
    const r = runHook(
      HOOK,
      `gh issue create --title "retryBudget gives up early" --body-file ${join(scratch, "absent-body.md")}`,
    );
    expect(r.blocked).toBe(false);
    expect(r.payload?.systemMessage ?? "").toContain("UNMEASURED");
    expect(ledgerRows().at(-1)!.refusal).toBe("UNMEASURED");
  });
});

describe("#1261 every decision lands in the ledger, kept and dropped alike", () => {
  test("FG-13: a refusal and an allow each write one countable row with its category", () => {
    const start = ledgerRows().length;
    runHook(HOOK, DUPLICATE_FILING);
    runHook(HOOK, NOVEL_FILING);
    const added = ledgerRows().slice(start);

    expect(added).toHaveLength(2);
    expect(added[0].emitted).toBe(false);
    expect(added[0].withheldBy).toBe("DUPLICATE");
    expect(added[0].duplicateOf).toEqual(["900"]);
    expect(added[0].disposition).toBe("DROP");
    expect(added[1].emitted).toBe(true);
    expect(added[1].withheldBy).toBeNull();
    expect(added[1].disposition).toBe("ISSUE");
    // The category is on every row, kept and dropped, or the ledger cannot
    // answer the question it was built for.
    for (const row of added) expect(typeof row.category).toBe("string");
  });
});

/**
 * Five rounds of review on this subsystem produced sixteen findings that
 * collapse to four classes. These are the class rows. Each one is written so
 * that it would have caught EVERY instance of its class, not the one line
 * that was reported — which is the whole point of fixing a class.
 */
describe("#1261 the four suppression classes", () => {
  // ── class 1: the gate must adjudicate what `gh` will act on ──
  //
  // pflag is last-wins. The differential pair below is the non-vacuous form:
  // the two titles adjudicate DIFFERENTLY, so a gate reading the first, the
  // last, or the join of both gives three different answers and only one is
  // right. A pair whose values adjudicate the same way is green and proves
  // nothing.
  const STYLE_TITLE = "Typo in the retry comment";
  const REAL_TITLE = "retryBudget drops frames on resume";
  const BODY = `--body "\`retryBudget\` in lib/pr-cache.ts holds 72 entries. Claim 4. ${DECLARED}"`;

  test("FG-28 BASELINE: the LAST --title decides, so a trailing style title blocks", () => {
    const [a] = filingAttempts(`gh issue create --title "${REAL_TITLE}" --title "${STYLE_TITLE}" ${BODY}`);
    expect(a.title, "the join would read both").toBe(STYLE_TITLE);
  });

  test("FG-29 CONTROL: the same two titles swapped allow, which the join cannot do", () => {
    const [a] = filingAttempts(`gh issue create --title "${STYLE_TITLE}" --title "${REAL_TITLE}" ${BODY}`);
    expect(a.title).toBe(REAL_TITLE);
    expect(a.repeatedValueFlag, "the repeat is recorded even though it is resolved").toBe(true);
  });

  test("FG-30: the two orderings reach OPPOSITE outcomes, so the case is not vacuous", async () => {
    const trailingStyle = await adjudicateFiling(
      filingAttempts(`gh issue create --title "${REAL_TITLE}" --title "${STYLE_TITLE}" ${BODY}`)[0],
      async () => measuredCorpus([]),
    );
    const trailingReal = await adjudicateFiling(
      filingAttempts(`gh issue create --title "${STYLE_TITLE}" --title "${REAL_TITLE}" ${BODY}`)[0],
      async () => measuredCorpus([]),
    );
    expect(trailingStyle.outcome).toBe("REFUSE");
    expect(trailingReal.outcome).toBe("ALLOW");
  });

  test("FG-31: --repo retargets the dedupe, so a filing is not compared to the wrong tracker", async () => {
    const [a] = filingAttempts('gh issue create --repo other/project --title "x" --body "y"');
    expect(a.repo).toBe("other/project");

    const asked: Array<string | null> = [];
    await filingGate(
      `gh issue create --repo other/project --title "${REAL_TITLE}" ${BODY}`,
      {
        projectRoot: scratch,
        readExisting: async (_root, repo) => {
          asked.push(repo);
          return measuredCorpus([]);
        },
      },
    );
    expect(asked).toEqual(["other/project"]);
  });

  // ── class 2: a reading that could not be taken is UNMEASURED ──
  test("FG-32: a tracker read that never resolves is bounded, not waited on forever", async () => {
    const started = Date.now();
    await expect(withTimeout(new Promise(() => {}), 50)).rejects.toThrow("timed out");
    expect(Date.now() - started, "it returned, and it returned quickly").toBeLessThan(5_000);
  });

  // ── class 3: the corpus is attacker-controlled on a public repo ──
  const trusted = (over: Partial<OpenIssue> = {}): OpenIssue => ({
    number: 1,
    title: "retryBudget gives up early",
    body: "`retryBudget` in lib/command-retry.ts: 144 of 234 over 5060.",
    authorAssociation: "OWNER",
    ...over,
  });

  /** The findings an arm yields, or `[]` when it took no reading at all. */
  const kept = (r: ReturnType<typeof trustedCorpus>) => (r.reading === "MEASURED" ? r.findings : []);

  test("FG-33 BASELINE: an untrusted author cannot put a suppressor in the corpus", () => {
    for (const association of ["NONE", "CONTRIBUTOR", ""]) {
      const r = trustedCorpus(page([trusted({ authorAssociation: association })]));
      expect(kept(r), `${association || "(absent)"} is not trusted`).toEqual([]);
    }
  });

  test("FG-34 CONTROL: a trusted author's issue is still in the corpus", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(kept(trustedCorpus(page([trusted({ authorAssociation: association })])))).toHaveLength(1);
    }
  });

  test("FG-35: one issue cannot name enough to match everything", () => {
    const stuffed = Array.from({ length: MAX_KEYS_PER_EXISTING_ISSUE + 10 }, (_, i) => `\`symbolNumber${i}\``).join(" ");
    expect(kept(trustedCorpus(page([trusted({ body: stuffed })]))), "over the cap, so dropped whole").toEqual([]);
    expect(kept(trustedCorpus(page([trusted()]))), "an ordinary issue is unaffected").toHaveLength(1);
  });

  test("FG-38: the cap applies to the FIXTURE corpus too, which FG-35 cannot see", async () => {
    // FG-35 drives `trustedCorpus`. The fixture path reaches the same
    // predicate through `asFindings`, a different call site that no case
    // exercised — so mutating the predicate reddened one of the two readers
    // and the other went green having witnessed nothing. The two differ in
    // the author filter, which is why they are two readers and not one.
    const stuffed = Array.from({ length: MAX_KEYS_PER_EXISTING_ISSUE + 10 }, (_, i) => `\`fixtureSymbol${i}\``).join(" ");
    const file = join(scratch, "fixture-corpus.json");
    const read = async (body: string) => {
      writeFileSync(file, JSON.stringify([{ number: 77, title: "a fixture issue", body }]));
      const prior = process.env.RUNGATE_OPEN_FINDINGS;
      process.env.RUNGATE_OPEN_FINDINGS = file;
      try {
        return await openFindings(scratch);
      } finally {
        if (prior === undefined) delete process.env.RUNGATE_OPEN_FINDINGS;
        else process.env.RUNGATE_OPEN_FINDINGS = prior;
      }
    };
    const over = await read(stuffed);
    expect(over.reading, "the one row was dropped, so the set was never compared").toBe("UNMEASURED");
    expect(over.dropped.map(d => d.reason)).toEqual(["over-key-cap"]);
    const ordinary = await read("`retryBudget` in lib/command-retry.ts: 144 of 234.");
    expect(
      ordinary.reading === "MEASURED" ? ordinary.findings : [],
      "an ordinary fixture row is unaffected — this is the control that fails if the reader broke",
    ).toHaveLength(1);
  });

  // ── class 4: a refusal must not take novel siblings with it ──
  test("FG-36 BASELINE: a command whose filings are ALL duplicates is refused", async () => {
    const r = runHook(HOOK, `${DUPLICATE_FILING} && ${DUPLICATE_FILING}`);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("DUPLICATE");
  });

  test("FG-37: one duplicate beside a novel finding blocks, and the novel one is NAMED", async () => {
    // **This row asserted the opposite until FG-45 below.** It read "one
    // duplicate beside a novel finding does NOT take it down", which made
    // batching a refused filing with a clean one the cheapest way past the
    // arbiter. The concern behind it was right and is answered by naming the
    // clean clause in the refusal rather than by letting the command run —
    // see the FG-45 block for the argument and the measurement.
    const start = ledgerRows().length;
    const r = runHook(HOOK, `${DUPLICATE_FILING} && ${NOVEL_FILING}`);
    expect(r.blocked).toBe(true);
    expect(r.reason, "the refusal still names the duplicate").toContain("DUPLICATE");
    // Both rows still reach the ledger, and the two reasons they did not
    // reach the TRACKER are different facts: the first clause was refused,
    // the second only had the misfortune of sharing a command with it
    // (#1344). `null` here until then, which said it was filed.
    const added = ledgerRows().slice(start);
    expect(added.map(x => x.withheldBy)).toEqual(["DUPLICATE", COMMAND_BLOCKED]);
  });
});

/**
 * The `blocking` predicate: a refused filing must not ride through on a clean
 * sibling.
 *
 * ## The defect
 *
 * `filingGate` blocked only when `rows.every(r => !r.emitted)` — when NOTHING
 * in the command was clean. So one duplicate batched with one novel finding
 * was **ALLOWED**, and the refusal was downgraded to a note. The cheapest way
 * past the arbiter was to put a refused filing in the same `&&` chain as a
 * clean one, and a gate with a one-clause bypass is worse than no gate
 * because it reads as working.
 *
 * `emitted` is `verdict.outcome !== "REFUSE" || overridden`, so it is also
 * true for an **UNMEASURED** row. A single unreadable `--body-file` beside any
 * number of duplicates therefore allowed the whole command: a broken
 * adjudicator was a bypass as well as a note, which is the one thing the
 * UNMEASURED policy in this file's header exists to prevent.
 *
 * ## Why blocking is affordable now, when the comment said it was not
 *
 * The argument for `every` was real: a hook's one lever is the whole Bash
 * command, so blocking a mixed command takes novel findings down with a
 * duplicate, and that is the direction this gate must never fail in. What it
 * did not price is that nothing is lost by blocking if the refusal **names
 * the clauses that were clean**. The agent withdraws the refused one and
 * re-runs the rest in one step; the ledger has held every row, clean and
 * refused, since #1261. A finding deferred by one command is not a finding
 * silenced — a finding filed alongside a duplicate was never adjudicated at
 * all, which is the state the old predicate produced.
 *
 * ## What every row in FG-36/FG-37 held fixed
 *
 * Both pre-existing rows drove a command whose clauses were all REFUSE or a
 * mix of REFUSE and ALLOW. Neither drove a mix of REFUSE and **UNMEASURED**,
 * which is the input the `emitted` spelling and the `refusals` spelling
 * disagree on and the only one that separates "block when nothing was clean"
 * from "block when anything refused" at the boundary. FG-47 is that row —
 * the seventh shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 */
describe("a refused filing does not ride through on a clean sibling", () => {
  /** An UNMEASURED filing: the body file does not exist, so nothing was read. */
  const UNMEASURED_FILING =
    'gh issue create --title "pullRequestCache is never invalidated" ' +
    `--body-file ${join(tmpdir(), "rg-filing-gate-absent-body-file.md")}`;

  test("FG-45 BASELINE: a duplicate batched with a novel finding BLOCKS the command", () => {
    const r = runHook(HOOK, `${DUPLICATE_FILING} && ${NOVEL_FILING}`);
    expect(r.blocked, "the duplicate rode through on the clean sibling").toBe(true);
  });

  test("FG-46: the refusal NAMES the clean clause, so re-running it costs one step", () => {
    // The half that makes blocking affordable. Without it this is the fix the
    // original comment argued against, and the novel finding is lost.
    const r = runHook(HOOK, `${DUPLICATE_FILING} && ${NOVEL_FILING}`);
    expect(r.blocked).toBe(true);
    expect(r.reason, "the clean clause must be named verbatim").toContain(
      "pullRequestCache is never invalidated",
    );
    expect(r.reason, "and counted, so the agent knows how many to re-run").toContain("1 of 2");
  });

  test("FG-47: a duplicate beside an UNMEASURED filing blocks — `emitted` said allow", () => {
    // The input FG-36 and FG-37 both held fixed. `emitted` is true for an
    // UNMEASURED row, so under `rows.every(r => !r.emitted)` ONE unreadable
    // body file allowed any number of duplicates beside it.
    const r = runHook(HOOK, `${DUPLICATE_FILING} && ${UNMEASURED_FILING}`);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("DUPLICATE");
  });

  test("FG-48 CONTROL: a clean filing is still allowed, and a second is capped BY NAME", () => {
    // The control against the cheapest wrong fix for the three rows above —
    // block whenever there is more than one clause, or block unconditionally.
    //
    // **This row changed shape when the cap landed (#1595), and the subject
    // survived it.** `FILINGS_PER_RUN` is 1, so a run's second clean filing
    // IS now refused and the old assertion was measuring a property the
    // project deliberately gave up. What it was really guarding is that a
    // clean filing is not refused for being in company — so the halves are
    // now asserted apart: one clean filing runs with nothing to say, and in
    // a two-clause command the first clause still clears on its own merits
    // while the second is refused by a NAMED mechanism rather than by a
    // blanket rule about clause counts.
    const alone = runHook(HOOK, NOVEL_FILING);
    expect(alone.blocked, "a clean filing runs").toBe(false);
    expect(alone.payload?.systemMessage ?? null, "with nothing to say about it").toBe(null);

    const start = ledgerRows().length;
    const pair = runHook(HOOK, `${NOVEL_FILING} && ${SAME_SYMBOL_NEW_READING}`);
    const added = ledgerRows().slice(start);
    expect(added.map(x => x.refusal), "the first clause is clean on its own merits").toEqual([
      null,
      "OVER_CAP",
    ]);
    expect(pair.reason, "and the refusal names the cap, never the clause count").toContain("cap is 1");
  });

  test("FG-49 CONTROL: an UNMEASURED filing ALONE is allowed, loudly", () => {
    // Separates "UNMEASURED no longer excuses a sibling" from "UNMEASURED now
    // refuses", which would make a broken adjudicator a gag on the tracker.
    const r = runHook(HOOK, UNMEASURED_FILING);
    expect(r.blocked).toBe(false);
    expect(r.payload?.systemMessage ?? "").toContain("UNMEASURED");
  });

  test("FG-50 CONTROL: an overridden duplicate still clears its own clause", () => {
    // An override is a decision somebody made and recorded. It must survive
    // the stricter predicate, or the label stops meaning anything.
    //
    // The command no longer runs, and the reason is the SIBLING being over
    // the cap rather than anything about the override (#1595) — so the
    // assertion moved from the command's verdict to the overridden clause's
    // own row, which is where the property always lived. A row that is
    // `overridden` with `emitted` cleared by `markBlockedCommand` is a
    // waiver that worked inside a command that was stopped for another
    // reason, and that is exactly the state this row exists to protect.
    const start = ledgerRows().length;
    runHook(HOOK, `${DUPLICATE_FILING} --label ${FILING_OVERRIDE_LABEL} && ${NOVEL_FILING}`);
    const added = ledgerRows().slice(start);
    expect(added.map(x => x.overridden), "the label still waives the duplicate").toEqual([
      true,
      false,
    ]);
    expect(added.map(x => x.refusal)).toEqual(["DUPLICATE", "OVER_CAP"]);
    expect(added[0].disposition, "and the waived clause is still routed to the tracker").toBe("ISSUE");
  });

});

/**
 * A corpus that filtered to nothing is UNMEASURED, not a clean tracker.
 *
 * ## The defect
 *
 * `openFindings` read the tracker, dropped every issue whose
 * `authorAssociation` is untrusted and every issue over the key cap, and
 * returned the remainder as a list. **A non-empty issue list that filters
 * down to empty was byte-indistinguishable from a tracker with nothing on
 * it**, and the gate ALLOWed on the strength of a comparison it never made.
 *
 * Each filter is individually argued to fail in the safe direction — a
 * duplicate reaches the tracker, never a real finding silenced — and that
 * argument is about ONE issue being dropped. It does not survive
 * composition: when the filters take everything, the gate is not erring
 * toward letting a duplicate through, it is reporting a reading it did not
 * take. A filter with a bug in it reads exactly the same.
 *
 * ## What `null` cost, and why it is gone
 *
 * Carrying the reason required a channel, and `null` had none. A second
 * channel beside `null` would have been two spellings of UNMEASURED — two
 * deciders for one question, the fourth shape — so `null` was collapsed into
 * the `UNMEASURED` arm of `CorpusReading`, which carries its own `why`. That
 * matters beyond tidiness: `adjudicateFiling` used to COMPOSE the sentence
 * *"the open-issue set could not be read"* for every `null`, and that
 * sentence is false for a corpus that was read perfectly well and then
 * emptied by our own filters. This file already paid for a reason that was
 * false for the input it was emitted on, in the `--body-file` arm FG-17
 * covers.
 *
 * ## What every pre-existing row held fixed
 *
 * FG-33, FG-34, FG-35 and FG-38 each hand the corpus readers **one issue**.
 * With one issue, "the filters dropped it" and "the tracker was empty" have
 * the same consequence for the caller, so none of them can see the
 * composition — the seventh shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. The rows below vary that
 * axis: two issues both dropped, and two issues of which one survives.
 *
 * ## Measured, not inferred: the harness's own filing identity
 *
 * The allowlist eating its own corpus was the worst case, and it does not
 * happen. Read from the live tracker on 2026-10-23,
 * `repos/hornjason/pai-harness/issues?state=open`, pull requests excluded:
 * **35 of 35 open issues report `author_association: OWNER`**, which is in
 * `TRUSTED_ASSOCIATIONS`. The author filter currently drops nothing. It is
 * not asserted here, because a case that calls the GitHub API measures a
 * network rather than this code.
 */
describe("a corpus every filter emptied is UNMEASURED, not a clean tracker", () => {
  const issue = (over: Partial<OpenIssue> = {}): OpenIssue => ({
    number: 1,
    title: "retryBudget gives up early",
    body: "`retryBudget` in lib/command-retry.ts: 144 of 234 over 5060.",
    authorAssociation: "OWNER",
    ...over,
  });
  const stuffed = Array.from(
    { length: MAX_KEYS_PER_EXISTING_ISSUE + 10 },
    (_, i) => `\`stuffedSymbol${i}\``,
  ).join(" ");

  test("FG-52 BASELINE: two issues, both filtered out, is UNMEASURED and not an empty corpus", () => {
    const r = trustedCorpus(page([
      issue({ number: 10, authorAssociation: "NONE" }),
      issue({ number: 11, body: stuffed }),
    ]));
    expect(r.reading).toBe("UNMEASURED");
  });

  test("FG-53: the reading names every dropped issue and the filter that took it", () => {
    // A reason that does not say what was dropped is a reason nobody can act
    // on, and the two filters need different repairs — one is a trust
    // decision, the other is an issue to split up.
    const r = trustedCorpus(page([
      issue({ number: 10, authorAssociation: "NONE" }),
      issue({ number: 11, body: stuffed }),
    ]));
    expect(r.dropped.map(d => [d.id, d.reason])).toEqual([
      ["10", "untrusted-author"],
      ["11", "over-key-cap"],
    ]);
    const why = r.reading === "UNMEASURED" ? r.why : "";
    expect(why).toContain("#10");
    expect(why).toContain("#11");
    expect(why, "the association that failed, so the reader can check it").toContain("NONE");
    expect(why, "and the cap, which is the other repair").toContain(
      String(MAX_KEYS_PER_EXISTING_ISSUE),
    );
  });

  test("FG-54 CONTROL: a GENUINELY empty tracker is MEASURED, and allows", () => {
    // The row that stops the fix becoming "an empty corpus always refuses",
    // which would make a project with no open issues unable to file anything.
    const r = trustedCorpus(page([]));
    expect(r.reading).toBe("MEASURED");
    expect(r.reading === "MEASURED" ? r.findings : null).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  test("FG-55 CONTROL: one survivor among two is MEASURED, and the drop is still reported", () => {
    // The other side of the axis. A partial filter is a reading, and the
    // caller is told it read a smaller tracker than the one that exists.
    const r = trustedCorpus(page([issue({ number: 10, authorAssociation: "NONE" }), issue({ number: 11 })]));
    expect(r.reading).toBe("MEASURED");
    expect(r.reading === "MEASURED" ? r.findings.map(f => f.id) : null).toEqual(["11"]);
    expect(r.dropped.map(d => d.id), "the drop survives a successful read").toEqual(["10"]);
  });

  test("FG-56: end to end, a filing against an emptied corpus is UNMEASURED at the hook", () => {
    // The production path, not the unit. Under the defect the hook ALLOWed
    // and said nothing; the filing was adjudicated against a comparison that
    // never happened.
    const file = join(scratch, "emptied-corpus.json");
    writeFileSync(
      file,
      JSON.stringify([{ number: 77, title: "a stuffed fixture issue", body: stuffed }]),
      "utf-8",
    );
    const r = runHook(HOOK, NOVEL_FILING, { RUNGATE_OPEN_FINDINGS: file });
    expect(r.blocked, "UNMEASURED allows — a broken adjudicator is not a gag").toBe(false);
    const said = r.payload?.systemMessage ?? "";
    expect(said, "but it says so").toContain("UNMEASURED");
    expect(said, "and names what emptied it").toContain("#77");
  });

  test("FG-57 CONTROL: a partial drop is reported even when the filing is ALLOWED", () => {
    // Separates "the gate noticed the drop" from "the gate refused". Two
    // rows, one kept, one over the cap: the filing runs and the note still
    // says the dedupe read a smaller tracker than exists.
    const file = join(scratch, "partial-corpus.json");
    writeFileSync(
      file,
      JSON.stringify([
        { number: 77, title: "a stuffed fixture issue", body: stuffed },
        { number: 78, title: "an ordinary fixture issue", body: "`someOtherSymbol` in lib/x.ts." },
      ]),
      "utf-8",
    );
    const r = runHook(HOOK, NOVEL_FILING, { RUNGATE_OPEN_FINDINGS: file });
    expect(r.blocked).toBe(false);
    const said = r.payload?.systemMessage ?? "";
    expect(said).toContain("filtered out of the comparison set");
    expect(said).toContain("#77");
    expect(said, "the surviving row is not reported as a drop").not.toContain("#78");
  });

  test("FG-60: the drop is reported when the command is REFUSED, and it names the filter", () => {
    // `corpusDropNote` had exactly ONE case binding it — FG-57, which drives
    // the ALLOWED path and asserts only the id. The battery is what showed
    // that: M3 (stop pushing the note) was predicted to redden three rows and
    // reddened one. FG-53 and FG-55 read the `dropped` array directly and
    // never reach the rendered note, so a row that came back LOWER than
    // predicted is the whole evidence the path was thin.
    //
    // Two things here that FG-57 cannot see. **A refusal computed against a
    // short corpus is where the shortfall matters most** — the agent is being
    // told its finding is already filed, by a comparison that did not read
    // the whole tracker — and `notes` travels independently of `refusal`, so
    // nothing asserted the two arrive together. And the REASON is the
    // actionable half: "#77 was dropped" is not something anyone can act on
    // until it says which filter took it.
    const file = join(scratch, "blocked-partial-corpus.json");
    writeFileSync(
      file,
      JSON.stringify([
        { number: 77, title: "a stuffed fixture issue", body: stuffed },
        { number: 900, title: "retryBudget gives up early", body: DUPLICATE_BODY },
      ]),
      "utf-8",
    );
    const r = runHook(HOOK, DUPLICATE_FILING, { RUNGATE_OPEN_FINDINGS: file });
    // The premise, asserted rather than assumed: this command really is
    // refused. If the surviving row stopped matching, the case would still
    // see the note and would be green about nothing.
    expect(r.blocked, "the surviving row must still collide, or this proves nothing").toBe(true);
    // `reason` and not `systemMessage`: a `decision: "block"` payload has one
    // text field and it is `reason`, so that is the only channel a refused
    // command has. The `blocked` premise above pins which path produced this
    // string, so the helper's fallback across the two fields cannot make the
    // case green on the path it is not testing.
    const said = r.reason;
    expect(said, "a refusal does not suppress the drop note").toContain("filtered out of the comparison set");
    // Scoped to the note's own paragraph, not to `reason` as a whole. The
    // refusal and the note are concatenated into the one text field a block
    // payload has, and `#900` is named by the REFUSAL — it is the issue the
    // surviving row collided with. Asserting `not.toContain("#900")` over the
    // whole string tests the refusal's wording, which is a different check
    // that would redden every time that sentence is reworded.
    const note = said.split("\n\n").find(p => p.includes("filtered out of the comparison set")) ?? "";
    expect(note).toContain("#77");
    expect(note, "the filter that took it, not just that something went").toContain("over-key-cap");
    expect(note, "the row that survived and caused the refusal is not a drop").not.toContain("#900");
  });
});

describe("the ledger carries every row of a blocked command", () => {
  test("FG-58: a blocked command still records every row, clean ones included", () => {
    // The ledger is what makes the block affordable: nothing is withheld with
    // no artefact anywhere, which is the failure the old predicate avoided.
    //
    // `emitted` is FALSE for both rows since #1344: the hook refused the whole
    // Bash command, so neither clause reached the tracker. "Recorded as clean"
    // now lives where it belongs — in `disposition` and in `withheldBy`, which
    // say the second clause was fine and was never attempted. FG-90 below is
    // the case for that distinction; this row holds the population at two.
    const start = ledgerRows().length;
    runHook(HOOK, `${DUPLICATE_FILING} && ${NOVEL_FILING}`);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(2);
    expect(
      added.map(x => x.emitted),
      "a blocked command filed nothing, so no row of it reached the tracker",
    ).toEqual([false, false]);
    expect(
      added.map(x => x.disposition),
      "the clean row is still recorded as clean — ISSUE is the routing decision",
    ).toEqual(["DROP", "ISSUE"]);
  });
});

/**
 * #1344 — a blocked command filed nothing, and the ledger has to say so.
 *
 * ## The defect
 *
 * Rows are written clause by clause, BEFORE the command-level `blocking` is
 * computed. #1338 made a refused clause block the whole command; the rows
 * already written still read `emitted: true` for every clause that was clean
 * on its own merits. Nothing was filed — a hook's one lever is the whole Bash
 * command and it refused it — so the ledger overcounted filings by one row
 * per clean clause of every blocked mixed command.
 *
 * ## Why an overcount here is not a rounding error
 *
 * This ledger is the only record of what the arbiter considered, and the
 * arbiter refuses filings as duplicates on the strength of it. A count that is
 * high for a STRUCTURAL reason is worse than no count, because no reader can
 * tell it apart from a true one — and the direction it is wrong in is toward
 * making the arbiter more confident than its evidence supports, which
 * suppresses real findings.
 *
 * ## Three states, kept apart, and each one asserted
 *
 * | state | `emitted` | `disposition` | `withheldBy` |
 * |---|---|---|---|
 * | reached the tracker | `true` | `ISSUE` | `null` |
 * | refused on its own merits | `false` | `DROP` | its own `ArbiterRefusal` |
 * | clean, and never attempted | `false` | `ISSUE` | `COMMAND_BLOCKED` |
 *
 * `disposition` stays `ISSUE` on the third row deliberately, and that is the
 * arbiter's own precedent rather than a second vocabulary: `arbitrateBatch`
 * writes `disposition: verdict.disposition` beside
 * `withheldBy: "BATCH_UNMEASURED"` for a candidate that was fine while its
 * batch was not. `disposition` is the adjudication's routing decision;
 * `emitted` is whether it reached a reader. Collapsing the third row into
 * `DROP` would lose the one fact that separates it from the second — that
 * nothing was wrong with it — which is the fact `cleanClauseNote` is built on,
 * and the fact an agent needs in order to re-run the clause.
 *
 * ## The fourth state this does NOT add, named rather than left out
 *
 * `emitted: true` means *the hook allowed the command*, which is a prediction
 * and not an observation: a `gh` that then fails on auth, on the network or on
 * a rate limit files nothing and leaves a row saying it did. This gate runs
 * `PreToolUse` and cannot see the outcome, so that remains **UNMEASURED by
 * this ledger** — named here so nobody reads `emitted: true` as a receipt.
 * Closing it needs a `PostToolUse` reading, which is not this issue.
 *
 * ## The cheapest wrong fix, named
 *
 * Flip `emitted` on the rows **before** `cleanClauseNote` is built. The count
 * goes right, and the refusal stops naming the clauses the agent has to
 * re-run — which is the half that makes blocking a mixed command affordable
 * at all (#1338). FG-94 is red under it, and M2 below is it applied.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (96 tests). Every row's failing SET was predicted before the
 * battery ran, not just its count, and **the baseline row was read first** —
 * `bun` writes its summary to stderr, so a reader parsing stdout alone makes
 * every row below unreadable.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 96 pass, 0 fail | **96 pass, 0 fail** |
 * | M1 `markBlockedCommand` short-circuited to `rows.map(r => ({...r}))` — the genuine pre-#1344 accounting | 6: FG-37, FG-58, FG-90, FG-92, FG-95, FG-96 | **6 of 96, exactly that set** |
 * | M2 the cheapest wrong fix: `clean` read from the MARKED rows, so the note empties | 2: FG-46, FG-94 | **2 of 96, exactly that set** |
 * | M3 `COMMAND_BLOCKED` collapsed to `"DUPLICATE"` — the third state folded into the second | 1: FG-92 | **1 of 96, exactly that set** |
 *
 * **M3 is 1 and not 4 on purpose, and it is the row worth reading.** FG-90,
 * FG-95 and FG-37 compare against the exported constant, so they agree with
 * the mutant by construction — two deciders that agree
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). FG-92 is
 * the only case that spells `"DUPLICATE"` on one side and reads the constant
 * on the other, and asserts the two values are DISTINCT. Delete FG-92 and
 * nothing in this file notices the two states being merged.
 *
 * Before believing M1, the input on which mutant and original differ, run
 * rather than assumed — `${DUPLICATE_FILING} && ${NOVEL_FILING}`, the second
 * row:
 *
 * ```
 * mutant:   emitted=true  disposition=ISSUE withheldBy=null
 * original: emitted=false disposition=ISSUE withheldBy="COMMAND_BLOCKED"
 * ```
 *
 * and for M2, the same input: the refusal contains `1 of 2` on the original
 * and does not on the mutant.
 *
 * None of the three is left in the tree; all were run and reverted, and
 * `lib/issue-filing-gate.ts` was confirmed byte-identical afterwards by
 * sha256.
 */
describe("FG-90..FG-96: a blocked command filed nothing (#1344)", () => {
  /**
   * Read from the one declaring position rather than re-spelled here. A
   * second literal would be a case that agrees with itself: rename the
   * constant in `lib/` and this file would go on asserting the old string
   * against a ledger that had stopped writing it.
   */
  const BLOCKED = COMMAND_BLOCKED;

  /** One duplicate (refused) and one novel finding (clean). Blocked. */
  const MIXED = `${DUPLICATE_FILING} && ${NOVEL_FILING}`;
  /** Two novel findings. Allowed — the positive control. */
  const ALL_CLEAN = `${NOVEL_FILING} && ${SAME_SYMBOL_NEW_READING}`;

  test("FG-90: a blocked command records its CLEAN clause as not emitted", () => {
    const start = ledgerRows().length;
    const r = runHook(HOOK, MIXED);
    // The premise, asserted rather than assumed. A command that stopped being
    // refused would make every assertion below true about nothing.
    expect(r.blocked, "the command must actually be blocked, or this proves nothing").toBe(true);
    const [refused, clean] = ledgerRows().slice(start);
    expect(clean?.title, "the second row is the novel finding").toBe(
      "pullRequestCache is never invalidated",
    );
    expect(clean?.emitted, "nothing was filed: the hook refused the whole command").toBe(false);
    expect(clean?.withheldBy, "and the reason is the command, not the clause").toBe(BLOCKED);
    expect(refused?.emitted, "the refused clause was already right").toBe(false);
  });

  test("FG-91 POSITIVE CONTROL: a clean command still records an emitted row", () => {
    // Without this, a fix that marked every row `emitted: false` would pass
    // FG-90 and zero the ledger, and no case in this file would see it.
    //
    // ONE clause since the cap landed (#1595): `ALL_CLEAN` is two clean
    // filings and `FILINGS_PER_RUN` is 1, so the second is now `OVER_CAP`
    // and the command no longer runs. The property this row guards needs a
    // row that IS emitted, not two of them — a zeroing fix still fails it.
    const start = ledgerRows().length;
    const r = runHook(HOOK, NOVEL_FILING);
    expect(r.blocked, "a clean filing in a fresh run must still run").toBe(false);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(1);
    expect(added.map(x => x.emitted)).toEqual([true]);
    expect(added.map(x => x.withheldBy)).toEqual([null]);
    expect(added.map(x => x.disposition)).toEqual(["ISSUE"]);
  });

  test("FG-142: ALL_CLEAN is two clean filings, and the cap is what stops it", () => {
    // The half FG-91 gave up, kept rather than deleted: `ALL_CLEAN` really
    // is two clauses neither of which is refused on its own merits, and the
    // only thing standing between it and two issues is `FILINGS_PER_RUN`.
    // Without this row, FG-91 narrowing to one clause would look like the
    // fixture having always been one.
    const start = ledgerRows().length;
    runHook(HOOK, ALL_CLEAN);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(2);
    expect(added.map(x => x.refusal)).toEqual([null, "OVER_CAP"]);
  });

  test("FG-92: the two withholdings are distinguishable inside one command", () => {
    // `DUPLICATE` and `COMMAND_BLOCKED` are the two reasons a row of a blocked
    // mixed command did not reach the tracker, and they are opposite facts:
    // the first says the clause was wrong, the second says only that its
    // sibling was. One value for both would make the ledger unable to say
    // which clauses an agent should re-run.
    const start = ledgerRows().length;
    runHook(HOOK, MIXED);
    const added = ledgerRows().slice(start);
    expect(added.map(x => x.withheldBy)).toEqual(["DUPLICATE", BLOCKED]);
    expect(new Set(added.map(x => x.withheldBy)).size, "two reasons, not one").toBe(2);
    expect(
      added[1]?.refusal,
      "the clean clause carries no refusal of its own — it was never refused",
    ).toBeNull();
    expect(added[0]?.refusal, "the refused one does").toBe("DUPLICATE");
  });

  test("FG-93: `emitted` and `withheldBy` are one fact, on every row of both commands", () => {
    // The invariant `test/finding-arbiter.test.ts` holds over `CandidateRecord`,
    // asserted over the rows this writer produces. Two row shapes, one reader.
    const start = ledgerRows().length;
    runHook(HOOK, MIXED);
    runHook(HOOK, ALL_CLEAN);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(4);
    for (const row of added) {
      expect(row.emitted, `${row.title}: withheldBy is null exactly when it reached the tracker`)
        .toBe(row.withheldBy === null);
    }
  });

  test("FG-94: the refusal still NAMES and COUNTS the clean clause", () => {
    // The cheapest wrong fix is to flip `emitted` before `cleanClauseNote` is
    // built, which empties the note: `clean` is `rows.filter(r => r.emitted)`.
    // The count then reads "0 of 2" and the agent is told nothing about what
    // to re-run, which is the whole of what made blocking affordable (#1338).
    const r = runHook(HOOK, MIXED);
    expect(r.blocked).toBe(true);
    expect(r.reason, "the clean clause is still named verbatim").toContain(
      "pullRequestCache is never invalidated",
    );
    expect(r.reason, "and still counted").toContain("1 of 2");
  });

  test("FG-95: an OVERRIDDEN clause a sibling blocked is withheld by the command", () => {
    // An override says a refusal was waived, not that the command ran. When a
    // different clause blocks, the overridden one reached the tracker exactly
    // as little as the clean one did — and the override stays on the row, so
    // an override that was right is still evidence.
    const start = ledgerRows().length;
    const r = runHook(
      HOOK,
      `${DUPLICATE_FILING} --label ${FILING_OVERRIDE_LABEL} && ${DUPLICATE_FILING}`,
    );
    expect(r.blocked, "the un-overridden duplicate must still refuse").toBe(true);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(2);
    expect(added[0]?.overridden, "the first clause carried the label").toBe(true);
    expect(added[0]?.emitted, "and still filed nothing").toBe(false);
    expect(added[0]?.withheldBy).toBe(BLOCKED);
    expect(added[0]?.refusal, "its own refusal is recorded beside the override").toBe("DUPLICATE");
    expect(added[1]?.withheldBy, "the clause that blocked is withheld on its own merits")
      .toBe("DUPLICATE");
  });

  test("FG-96: `markBlockedCommand` touches the emitted rows and only those", () => {
    // The unit half of the chain. The five rows above establish that the hook
    // reaches this binding; this one establishes what the binding does, over
    // an input the hook cannot easily be made to produce — a row that was
    // already withheld, which must come back byte-identical rather than
    // having its reason overwritten by the command's.
    const row = (over: Partial<FilingLedgerRow>): FilingLedgerRow => ({
      at: "2026-10-24T00:00:00.000Z",
      key: "b/0",
      id: "new",
      title: "t",
      symptomHash: "h",
      category: "correctness",
      severity: null,
      disposition: "ISSUE",
      refusal: null,
      emitted: true,
      withheldBy: null,
      jury: null,
      duplicateOf: [],
      overridden: false,
      refiledAfter: null,
      exemption: null,
      run: null,
      ...over,
    });
    const refused = row({
      disposition: "DROP",
      refusal: "DUPLICATE",
      emitted: false,
      withheldBy: "DUPLICATE",
      duplicateOf: ["#900"],
    });
    const cleanRow = row({});
    const [a, b] = markBlockedCommand([refused, cleanRow]);
    expect(a, "an already-withheld row keeps its own reason").toEqual(refused);
    expect(b).toEqual({ ...cleanRow, emitted: false, withheldBy: COMMAND_BLOCKED });
    expect(
      [refused.emitted, cleanRow.emitted],
      "and the caller's own rows are not mutated under it",
    ).toEqual([false, true]);
  });
});

describe("#1261 removing the wiring is the defect, and these rows see it", () => {
  /**
   * Predicted BEFORE running, as a membership and not a direction: the mutant
   * differs from the real hook on exactly **2 of 4** rows, and they are
   * exactly `{FG-6 duplicate, FG-7 dropped-category}`. The two control rows
   * were allowed by the real hook and must stay allowed by the mutant — a
   * mutant that changed those too would be a mutant that failed to load.
   */
  test("FG-14: the unwired hook stops refusing the two baselines, and leaves the controls alone", () => {
    const rows: Array<{ name: string; cmd: string; realBlocked: boolean }> = [
      { name: "duplicate", cmd: DUPLICATE_FILING, realBlocked: true },
      { name: "dropped-category", cmd: DROPPED_FILING, realBlocked: true },
      { name: "novel", cmd: NOVEL_FILING, realBlocked: false },
      { name: "same-symbol-new-reading", cmd: SAME_SYMBOL_NEW_READING, realBlocked: false },
    ];

    const differs: string[] = [];
    for (const row of rows) {
      const real = runHook(HOOK, row.cmd);
      const mutant = runHook(mutantHook, row.cmd);
      expect(real.blocked, `real hook on ${row.name}`).toBe(row.realBlocked);
      // A mutant that failed to load exits non-zero and prints nothing, which
      // on this channel reads exactly like an allow. Assert it ran.
      expect(mutant.exit, `mutant must load and exit 0 on ${row.name}`).toBe(0);
      expect(mutant.blocked, `unwired hook must refuse nothing (${row.name})`).toBe(false);
      if (real.blocked !== mutant.blocked) differs.push(row.name);
    }

    expect(differs).toEqual(["duplicate", "dropped-category"]);
  });
});

/**
 * #1302 — a heredoc body is a program or it is a document, and only one of
 * them is a command.
 *
 * `clauses` tokenized the whole string, heredoc bodies included, so text on
 * its way INTO A FILE parsed as a real filing clause. The phantom carries no
 * `--label`, so the every-or-nothing rule refused the whole command: it never
 * let a filing through, it only blocked legitimate work — and it reached the
 * direct-ship lane the moment the adjudication started running on every phase
 * rather than only in VERIFY.
 *
 * `hooks/BashWriteGuard.hook.ts` settled this exact question in #1240 and
 * settled it the other way round, so the two guards were the precise inverse
 * of each other on the same syntax. The split is reused from
 * `lib/bash-write-guard.ts` rather than written a second time — a second
 * decider on one question is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * The ids start at FG-39 rather than FG-28 because #1304 held FG-28..FG-38
 * against this file while this branch was open. Neither diff contained the
 * other's ids — the collision the swarm brief describes for SC ids, in the
 * test-block namespace. #1304 has since merged, so FG-1..FG-44 are now
 * contiguous here and the gap this paragraph explains no longer exists.
 *
 * **The words are never written adjacent in a literal here.** They are joined
 * at run time, because a fixture spelling them out inside a document heredoc
 * is a fixture this very gate refuses to let anyone write.
 */
describe("#1302 a document heredoc is not a filing", () => {
  const GH = ["gh", "issue", "create"].join(" ");
  const FILING = `${GH} --title "retryBudget drops frames" --body "x" --label follow-up`;

  test("FG-39 BASELINE: a document heredoc whose body mentions the command yields NO attempt", () => {
    // Four spellings, because the defect is about where the body GOES and not
    // about which writer took it. `gh --body-file -` is in the list on
    // purpose: it is a `gh` command whose heredoc is unambiguously content.
    for (const cmd of [
      `cat > /tmp/doc.md <<'EOF'\n${FILING}\nEOF`,
      `cat >> /tmp/doc.md <<'EOF'\n${FILING}\nEOF`,
      `tee /tmp/doc.md <<'EOF'\n${FILING}\nEOF`,
      `gh issue comment 900 --body-file - <<'EOF'\n${FILING}\nEOF`,
    ]) {
      expect(filingAttempts(cmd), `a document body is not a command: ${cmd.slice(0, 32)}`).toEqual([]);
    }
  });

  test("FG-40 CONTROL: an interpreter heredoc that genuinely runs it still yields one", () => {
    // The control against the cheapest wrong fix, "ignore every heredoc",
    // which would make FG-39 green and open a real bypass. This arm was
    // ALREADY 1 before the change and must still be 1 after — the issue's
    // own table reports 0 here and that row does not reproduce.
    for (const cmd of [
      `bash <<'EOF'\n${FILING}\nEOF`,
      `bash -s <<'EOF'\n${FILING}\nEOF`,
      `sh <<'EOF'\n${FILING}\nEOF`,
    ]) {
      expect(filingAttempts(cmd), `an interpreter body is a program: ${cmd.slice(0, 20)}`).toHaveLength(1);
    }
  });

  test("FG-41: a herestring handed to a shell is a program too, which it was NOT before", () => {
    // 0 before the change, 1 after — and this one reverses a DOCUMENTED
    // boundary rather than closing an oversight. `lib/issue-create-override.ts`
    // listed herestrings as out of scope ("a deliberate construction, not a
    // reflex") and `test/verify-phase-lock.test.ts` asserted the allow. Both
    // move in this commit with the reason, because the alternative is a
    // second decider disagreeing with `lib/bash-write-guard.ts`.
    expect(filingAttempts(`bash <<< '${FILING}'`)).toHaveLength(1);
  });

  test("FG-42: a document heredoc BESIDE a real filing leaves exactly the real one", () => {
    // The row that separates "the phantom is gone" from "the whole command is
    // gone". Two attempts before, and the surviving one must be the real
    // filing with its label — not whichever one the parser happened to keep.
    const attempts = filingAttempts(`cat > /tmp/d.md <<'EOF'\n${FILING}\nEOF\n${FILING}`);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].labels).toEqual(["follow-up"]);
  });

  test("FG-43 CONTROL: an UNTERMINATED heredoc is still read, because it is not a heredoc", () => {
    // `stripHeredocs` deliberately leaves a body whose terminator never
    // arrives, and that direction is the safe one: a filing hidden behind an
    // unclosed delimiter must not become invisible. Green before and after.
    expect(filingAttempts(`cat > /tmp/d.md <<'EOF'\n${FILING}\n`)).toHaveLength(1);
  });

  test("FG-44 CONTROL: an ordinary inline filing is untouched", () => {
    const attempts = filingAttempts(FILING);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].labels).toEqual(["follow-up"]);
  });

  /**
   * FG-59: the three spellings that were reported as a live bypass, and are
   * not one.
   *
   * The report was that `heredocView` decides document-versus-program by the
   * WRITER WORD alone, so a clause whose stdout still reaches a shell has its
   * body dropped from the view while the shell executes it. Three spellings
   * were named. **All three already yield one filing attempt**, measured
   * before anything was changed, and the mechanisms differ:
   *
   * | spelling | attempts | why it is caught |
   * |---|---|---|
   * | `cat <<'EOF' \| bash` | 1 | `heredocInterpreter`'s pipe arm — the operator's segment is piped into an interpreter |
   * | `bash -c "$(cat <<'EOF' … )"` | 1 | the opener LINE's command word is `bash`, so the owner arm fires |
   * | `bash <(cat <<'EOF' … )` | 1 | the same: the line's command word is `bash` |
   *
   * They are kept as rows because nothing covered them and the second and
   * third are caught by a reason their own shape does not suggest — they
   * would go red under a narrowing of `heredocInterpreter` to the heredoc's
   * owning SEGMENT, which reads like a tightening.
   *
   * **Four other spellings are a live bypass, and are reported rather than
   * fixed here.** They are in the pull request body with the shell output
   * proving each executes. The fix is in `lib/bash-write-guard.ts`, which is
   * the other guard's decider and was tuned against a 5,060-command corpus
   * this change cannot re-measure.
   */
  test("FG-59 CONTROL: the three reported heredoc-to-shell spellings all yield a filing", () => {
    for (const cmd of [
      `cat <<'EOF' | bash\n${FILING}\nEOF`,
      `bash -c "$(cat <<'EOF'\n${FILING}\nEOF\n)"`,
      `bash <(cat <<'EOF'\n${FILING}\nEOF\n)`,
    ]) {
      expect(filingAttempts(cmd), `the body reaches a shell: ${cmd.slice(0, 24)}`).toHaveLength(1);
    }
  });
});

/**
 * FG-60..FG-65: `--repo`, read the way `gh` reads it.
 *
 * No issue covers this one — it was found while shipping #1318 and the PR
 * body carries it, per the swarm procedure.
 *
 * **The differential.** `gh` resolves `--repo` through `ghrepo.FromFullName`,
 * which accepts a bare `OWNER/REPO`, a `HOST/OWNER/REPO`, a full URL and an
 * scp-style remote. `parseOwnerRepo` accepts the first and throws on the
 * rest. The throw landed in `openFindings`'s `catch`, which returns `null`,
 * which is UNMEASURED, which ALLOWS — so writing `--repo
 * https://github.com/owner/repo` filed perfectly well while skipping the
 * dedupe entirely. Measured against this tracker before the fix:
 * `gh issue list --repo <X> --limit 1` returned the same issue for all three
 * spellings.
 *
 * **The class, which is the finding.** `catch { return null }` in
 * `openFindings` is not a fifth instance beside the others — it is the
 * mechanism by which they become ALLOW. Three separate defects reached the
 * same observable through it, and a review reading the three could not see
 * that the converter was one line. The repair narrows what enters it: a slug
 * decision is made before the `try`, by `corpusSlug`, and the `catch` is left
 * holding only what it was written for, which is the network.
 *
 * **The remaining residue fails CLOSED.** A `--repo` this process cannot
 * resolve now refuses, and that is a deliberate exception to the file's
 * UNMEASURED-allows policy: it is the only unreadable input here that is a
 * fact about the COMMAND rather than about the environment, so the agent can
 * fix it in the same turn. A refusal somebody can act on is not a gag.
 */
describe("FG-60..FG-65: the --repo parser differential", () => {
  const SLUG = "hornjason/pai-harness";

  /** Spellings `gh` accepts and the API client's own validator throws on. */
  const HOST_BEARING = [
    `https://github.com/${SLUG}`,
    `github.com/${SLUG}`,
    `git@github.com:${SLUG}.git`,
  ];

  const withRepo = (spelling: string): string =>
    NOVEL_FILING.replace("gh issue create", `gh issue create --repo '${spelling}'`);

  const allow = async () => measuredCorpus([]);

  test("FG-60: the spellings gh accepts and parseOwnerRepo throws on resolve to one slug", () => {
    for (const spelling of HOST_BEARING) {
      // The differential itself, spelled as an assertion. This half stays
      // true after the fix and is meant to: it is WHY a normaliser exists,
      // and a case asserting only the new behaviour could not say so. If
      // `parseOwnerRepo` ever widens, this row goes red and the normaliser
      // becomes dead code that somebody can then delete on evidence.
      expect(
        () => parseOwnerRepo(spelling),
        `${spelling} must still be what the API client rejects`,
      ).toThrow();
      expect(ghRepoTarget(spelling), spelling).toBe(SLUG);
    }
  });

  test("FG-61 CONTROL: a bare owner/repo is unchanged, and what gh rejects stays null", () => {
    // Without this row the cheapest fix for FG-60 is `() => "hornjason/pai-harness"`,
    // which passes it and resolves every tracker on earth to this one — the
    // fifth shape, green under the wrong repair.
    expect(ghRepoTarget(SLUG)).toBe(SLUG);
    expect(ghRepoTarget(`  ${SLUG}  `), "gh trims, so this is not a different repo").toBe(SLUG);
    for (const bad of [
      "",
      "nota-repo",
      "a/b/c",
      "../../../etc/passwd",
      "https://gitlab.com/o/r",
      "ghe.example.com/o/r",
    ]) {
      // The last two are the ones worth naming: a host this process cannot
      // reach must not resolve to a slug, because a slug would be queried
      // against github.com and answer about a different repository.
      expect(ghRepoTarget(bad), bad).toBeNull();
    }
  });

  test("FG-62: an unresolvable explicit --repo never falls back to this tracker", () => {
    // The tempting repair, refused. Both readings are taken in one case so
    // neither is vacuous: the project's own slug IS resolvable here, so the
    // `null` below is the explicit-target rule firing and not an absent
    // origin.
    expect(
      corpusSlug(REPO, null),
      "the control: with no --repo the project's own tracker is read",
    ).toBe(SLUG);
    expect(corpusSlug(REPO, "nota-repo"), "and an unresolvable one reads NOTHING").toBeNull();
    expect(corpusSlug(REPO, HOST_BEARING[0]), "a resolvable one reads the target").toBe(SLUG);
  });

  test("FG-63: a filing with an unparseable --repo is REFUSED, not allowed as UNMEASURED", async () => {
    const r = await filingGate(withRepo("nota-repo"), {
      projectRoot: scratch,
      readExisting: allow,
    });
    expect(r.rows, "one clause, or this row is about a command the parser never split").toHaveLength(1);
    expect(r.refusal, "an unreadable target the agent CAN fix is fail-closed").not.toBeNull();
    // Text only this stage can emit — the sixth shape. A DUPLICATE refusal
    // names an issue number, a DROPPED_CATEGORY refusal names a category;
    // this one names the value that would not resolve.
    expect(r.refusal ?? "").toContain("nota-repo");
    expect(r.rows[0].emitted).toBe(false);
    expect(r.rows[0].withheldBy).toBe("UNMEASURED");
  });

  test("FG-64 CONTROL: the same filing with a resolvable --repo is allowed", async () => {
    // Against "refuse any --repo", which passes FG-63 and switches the
    // cross-tracker path off entirely.
    //
    // `noCap` because this case files three times from one directory, which
    // is one run: without it the second spelling is OVER_CAP and the case
    // would be measuring the cap it is not about. The three spellings are
    // the axis; the allowance is held fixed.
    for (const spelling of [SLUG, ...HOST_BEARING]) {
      const r = await filingGate(withRepo(spelling), { projectRoot: scratch, readExisting: allow, ...noCap });
      expect(r.rows, spelling).toHaveLength(1);
      expect(r.refusal, spelling).toBeNull();
    }
  });

  test("FG-65 CONTROL: a filing with no --repo at all does not reach this stage", async () => {
    // Against "refuse whenever the slug is null", which passes FG-63 and
    // refuses every filing on a box whose `origin` cannot be read — the
    // gate's own machine, during the five minutes a remote is being renamed.
    const r = await filingGate(NOVEL_FILING, { projectRoot: scratch, readExisting: allow });
    expect(filingAttempts(NOVEL_FILING)[0].repo, "the premise: this clause names no target").toBeNull();
    expect(r.refusal).toBeNull();
  });
});

/**
 * FG-66..FG-71: a ledger row that can be told apart (#1318).
 *
 * Every row this gate wrote carried `id: UNFILED_ID` and no key, so nothing
 * in the live ledger distinguished one row from another — two of its eight
 * rows were identical in every field. The only consumer designed to read it,
 * `summariseFindingOutcomes`, refuses a corpus of repeated ids outright, and
 * its refusal already names the field this writer did not emit.
 *
 * **`${at}/${index}` is the cheapest wrong fix**, and FG-68 applies it to
 * FG-67's own inputs and measures the collision. `ledgerPath()` defaults to
 * one shared file for every agent on the machine and `at` is hoisted outside
 * the row loop, so that scheme is unique within one command and a coin toss
 * across concurrent writers. FG-66 is a BASELINE and is deliberately green
 * under it; FG-67 is the row that is not.
 *
 * **Both axes are varied.** FG-67 moves the session with the pid, the
 * millisecond, the title and the symptom all held fixed; FG-69 moves the pid
 * with the session held fixed. A battery that varied only the first would
 * report a count that cannot come back wrong about the writers it never
 * wrote — the seventh shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
describe("FG-66..FG-71: a ledger row that can be told apart", () => {
  /** One millisecond, held fixed across every session below. */
  const AT = "2026-10-23T13:19:08.819Z";
  const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";
  const SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444";

  const allow = async () => measuredCorpus([]);

  async function withSession<T>(id: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prior = process.env[LEDGER_SESSION_ENV];
    if (id === undefined) delete process.env[LEDGER_SESSION_ENV];
    else process.env[LEDGER_SESSION_ENV] = id;
    try {
      return await fn();
    } finally {
      if (prior === undefined) delete process.env[LEDGER_SESSION_ENV];
      else process.env[LEDGER_SESSION_ENV] = prior;
    }
  }

  const gate = (session: string | undefined, cmd: string) =>
    withSession(session, () =>
      filingGate(cmd, { projectRoot: scratch, now: AT, readExisting: allow }),
    );

  /**
   * The ledger rows as the consumer sees them, keyed on `key` exactly as
   * `evals/ai-review-control/outcomes.ts` says to key them.
   *
   * `key as string` is deliberate for the unkeyed half: a backfill reading
   * these rows would hand the consumer whatever the field holds, and what it
   * holds is what FG-71 is about.
   */
  const asCorpus = (rows: readonly FilingLedgerRow[]): ReviewFinding[] =>
    rows.map(r => ({
      id: r.key as string,
      filedAt: 1_000,
      closed: true,
      citations: [],
      closedInFavourOf: [],
      declared: null,
    }));

  const score = (rows: readonly FilingLedgerRow[]) =>
    summariseFindingOutcomes(readFindingOutcomes(asCorpus(rows), new Set<string>()), "FG-71");

  test("FG-66 BASELINE: every row carries a key, and two clauses of one command differ", async () => {
    // Green under `${at}/${index}` too. Here to prove the field is populated
    // at all, and labelled BASELINE so it is never read as the uniqueness
    // claim — that is FG-67.
    const r = await gate(SESSION_A, `${NOVEL_FILING} && ${NOVEL_FILING}`);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map(x => x.key).filter(k => k === null)).toEqual([]);
    expect(r.rows[0].key).not.toBe(r.rows[1].key);
  });

  test("FG-67: two sessions, one millisecond, same title and symptom — different keys", async () => {
    const a = (await gate(SESSION_A, NOVEL_FILING)).rows[0];
    const b = (await gate(SESSION_B, NOVEL_FILING)).rows[0];
    // The premise, asserted rather than assumed: every field the cheapest
    // wrong fix could key on really is identical across the two rows. Without
    // this the case could pass on two rows that differed somewhere else.
    expect(b.at, "same millisecond").toBe(a.at);
    expect(b.title, "same title").toBe(a.title);
    expect(b.symptomHash, "same symptom").toBe(a.symptomHash);
    expect(b.id, "and the same UNFILED_ID, which is why neither can be the key").toBe(a.id);
    expect(a.key).not.toBe(b.key);
  });

  test("FG-68: the cheapest wrong fix, applied to FG-67's inputs, collides", async () => {
    // Applied and measured rather than named. The mutation cannot be built
    // the usual way — a mutant copy of `lib/issue-filing-gate.ts` in a
    // scratch directory cannot resolve its own relative imports and would
    // fail to LOAD, which on a count reads exactly like a guard that held.
    // So the wrong scheme is spelled here and run against the real rows.
    const cheapest = (row: FilingLedgerRow, index: number) => `${row.at}/${index}`;
    const a = (await gate(SESSION_A, NOVEL_FILING)).rows[0];
    const b = (await gate(SESSION_B, NOVEL_FILING)).rows[0];
    expect(
      cheapest(a, 0),
      "`${at}/${index}` is green on FG-66 and hands two concurrent writers one key",
    ).toBe(cheapest(b, 0));
    expect(a.key, "the shipped scheme does not").not.toBe(b.key);
  });

  test("FG-69 CONTROL on the axis FG-67 holds fixed: one session, two processes", async () => {
    // A session runs parallel subagents and every Bash call spawns its own
    // hook PROCESS, so "two concurrent writers" is not only two sessions.
    // Without this row the battery varies one axis while half the defect
    // sits on the other.
    await withSession(SESSION_A, async () => {
      expect(filingBatch(AT, 101)).not.toBe(filingBatch(AT, 102));
      expect(filingBatch(AT), "and the default is this process").toContain(String(process.pid));
      expect(filingBatch(AT), "with the session identity in it").toContain(SESSION_A.slice(0, 8));
    });
  });

  test("FG-70: an absent session identity is a loud null, not a plausible key", async () => {
    const r = await gate(undefined, NOVEL_FILING);
    expect(r.rows[0].key, "no key was invented to cover the gap").toBeNull();
    expect(r.note ?? "", "and the note names the variable that was missing").toContain(
      LEDGER_SESSION_ENV,
    );
    expect(r.refusal, "loud, and still not a gag on the tracker").toBeNull();
  });

  test("FG-71: rows this writer appends score as a usable corpus; unkeyed ones do not", async () => {
    // The end-to-end reading, and the one that was false when #1318 was
    // filed. Not a new assertion written beside the fix: `usable` is the
    // consumer's own verdict, reached through its own reader.
    const keyed = await gate(SESSION_A, `${NOVEL_FILING} && ${NOVEL_FILING}`);
    expect(score(keyed.rows).usable, "two keyed rows are a corpus that can be scored").toBe(true);

    const unkeyed = await gate(undefined, `${NOVEL_FILING} && ${NOVEL_FILING}`);
    expect(
      score(unkeyed.rows).usable,
      "and two unkeyed rows are refused by name rather than scored as one",
    ).toBe(false);
  });
});

/**
 * FG-72..FG-78: the count is taken before the filter, not after it (#1374).
 *
 * **The third level of one fail-open, and the sequence is the point.**
 * #1338 closed *a corpus that empties completely reads as a clean tracker*.
 * #1366 closed *a partial drop is silent*. Both are correct at their own
 * depth and neither can see this one: `corpusReading`'s `considered` came
 * from `listOpenIssues`'s RETURN, and `listOpenIssues` had already discarded
 * pull requests and malformed rows. So a page of 100 pull requests and zero
 * issues arrived as `considered === 0` — the same arm a genuinely empty
 * tracker takes — and was reported MEASURED-empty, which ALLOWS.
 *
 * The remedy is a boundary move rather than a fourth check at the same
 * depth: `listOpenIssues` returns the population beside the survivors, so
 * there is no longer a position from which a caller can count a list
 * somebody else already filtered.
 *
 * **The trap in testing it, and it is why every row below asserts on
 * `reading`.** The defect and the fix both produce ZERO findings and both
 * allow the filing, so a case asserting "no duplicate was found" — or
 * asserting the verdict at all — passes either way. Only two inputs
 * discriminate: a page that held rows and yielded none (UNMEASURED) and a
 * page that held nothing (MEASURED). FG-72 and FG-73 are that pair.
 *
 * The page cap is the second half and is not live here yet — this tracker is
 * near 50 open issues against a cap of 100. It is live now for any busier
 * consumer, and a truncated page is a reading of a narrower question than
 * the one asked, so it travels as a drop rather than as a refusal.
 */
describe("FG-72..FG-78: the corpus count is the population, not the survivors", () => {
  const clientReturning = (data: unknown[]) =>
    ({
      rest: { issues: { listForRepo: async () => ({ data }) } },
    }) as unknown as Parameters<typeof listOpenIssues>[0];

  const prRow = (n: number) => ({
    number: n,
    title: `pull request ${n}`,
    body: "x",
    pull_request: { url: "https://example.invalid" },
    author_association: "OWNER",
  });
  const issueRow = (n: number) => ({
    number: n,
    title: `issue ${n}`,
    body: `\`widgetCache\` in lib/widget.ts: ${n} of ${n + 1}.`,
    author_association: "OWNER",
  });

  const read = async (data: unknown[]) => trustedCorpus(await listOpenIssues(clientReturning(data), "o/r"));

  test("FG-72 BASELINE: a page of pull requests is UNMEASURED, not an empty tracker", async () => {
    const r = await read(Array.from({ length: 100 }, (_, i) => prRow(i + 1)));
    // Not `findings` and not the verdict: both are the same under the defect
    // and under the fix. `reading` is the only field that moves.
    expect(r.reading, "100 rows arrived and none survived — that is a drop, not a clean tracker").toBe(
      "UNMEASURED",
    );
  });

  test("FG-73 CONTROL: a genuinely empty tracker is still MEASURED", async () => {
    // The other half of the discriminating pair. Without it the cheapest fix
    // for FG-72 is "an empty findings list is always UNMEASURED", which
    // refuses nothing but switches the dedupe off for every project that has
    // not filed its first issue — and passes FG-72 while doing it.
    const r = await read([]);
    expect(r.reading).toBe("MEASURED");
    expect(r.reading === "MEASURED" ? r.findings : null).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  test("FG-74: the reading names what emptied the page, and where", async () => {
    // A reason that says "every issue was filtered out" about a page with no
    // issues in it is false for the input it was emitted on — the defect the
    // `--body-file` arm already paid for once in this file. The drops from
    // the OTHER module have to reach the sentence.
    const r = await read([prRow(10), { number: null }, prRow(12)]);
    expect(r.dropped.map(d => [d.id, d.reason])).toEqual([
      ["10", "pull-request"],
      [null, "malformed-row"],
      ["12", "pull-request"],
    ]);
    const why = r.reading === "UNMEASURED" ? r.why : "";
    expect(why, "the count is the population, so the sentence says 3").toContain("3 issue(s)");
    expect(why).toContain("pull-request");
    expect(why, "an id-less drop renders without a bare #").toContain("(malformed-row:");
    // Asserted as an ABSENCE too, because the first version of this row was
    // green under the cheapest wrong spelling. `#${d.id}` on a null id
    // renders `#null`, which still contains `(malformed-row:` — the fifth
    // shape, certifying the regression it was written to block.
    expect(why, "and never as `#null`").not.toContain("null");
  });

  test("FG-75: a full page is a reading of a narrower question, and says so", async () => {
    const r = await read(Array.from({ length: 100 }, (_, i) => issueRow(i + 1)));
    expect(r.reading, "100 usable issues IS a reading").toBe("MEASURED");
    expect(r.dropped.map(d => d.reason), "and the cap travels with it").toEqual(["page-cap"]);
    expect(r.dropped[0].id, "the cap is a fact about the request, not about a row").toBeNull();
  });

  test("FG-76 CONTROL: a page one short of the cap is not truncated", async () => {
    // `rows.length > perPage` is the cheapest wrong spelling of the
    // predicate and can never fire, because the API cannot return more than
    // was asked for. This row and FG-75 are the pair that separates them;
    // either alone is green under one of the two.
    const r = await read(Array.from({ length: 99 }, (_, i) => issueRow(i + 1)));
    expect(r.reading).toBe("MEASURED");
    expect(r.dropped).toEqual([]);
  });

  test("FG-77: corpusDropNote renders the new reason, and an id-less drop", () => {
    // `corpusDropNote` had exactly ONE case binding it before this — measured
    // during #1366's battery, where a mutation predicted at 3 red came back
    // 1, because every other case asserts the `dropped` array rather than the
    // rendered sentence. A reporting path about to carry a new reason with
    // one witness is a renderer nobody is checking.
    const note = corpusDropNote([
      { id: null, reason: "page-cap", detail: "a full page of 100" },
      { id: "77", reason: "pull-request", detail: "returned as an issue" },
    ]);
    expect(note).toContain("page-cap");
    expect(note).toContain("#77");
    expect(note, "no `#` in front of a drop that names no issue").not.toContain("#(");
    expect(note, "and no `#null` either — see FG-74").not.toContain("null");
    expect(note, "and it still says what it means for the reading").toContain("exists");
  });

  test("FG-78: end to end, a filing against a page of pull requests is told", async () => {
    // The production shape. ALLOWED — a gate that cannot read the tracker
    // must not become a gag on it — and LOUD, which is the half the defect
    // removed: under it the hook allowed and said nothing at all.
    const emptied = async () => trustedCorpus(await listOpenIssues(clientReturning([prRow(9)]), "o/r"));
    const r = await filingGate(NOVEL_FILING, { projectRoot: scratch, readExisting: emptied });
    expect(r.refusal, "never a refusal on a corpus we could not read").toBeNull();
    expect(r.note ?? "", "the UNMEASURED is said out loud").toContain("UNMEASURED");
    expect(r.rows[0].refusal, "and recorded as UNMEASURED rather than as a finding that passed").toBe(
      "UNMEASURED",
    );
  });
});

/**
 * FG-79..FG-89: a filing says what it MOVES, or it is not a filing.
 *
 * `CLAUDE.md` has carried this as prose for the life of the repository —
 * *"before filing an issue … say which claim it moves. Something that moves
 * none of them is cleanup and should say so rather than borrowing urgency."*
 * Nothing executed it. Measured across 2026-10-23, open issues went 53 → 52 →
 * 55 while the close rate fell from 11/h to 7/h: the tracker is an OUTPUT of
 * the review loop, and a loop whose input is unbounded does not converge by
 * closing faster.
 *
 * ## What was broken to prove these can fail
 *
 * The stage was briefly placed FIRST in `adjudicateFiling`, before the dedupe.
 * **34 of this file's 78 cases went red** — every one a dedupe or UNMEASURED
 * case short-circuited before it could run. Moved last, where it can only
 * convert an ALLOW, the number fell to **17**, and all 17 were ALLOW controls
 * whose fixtures genuinely named no claim. That is the population the stage
 * exists to catch, counted rather than argued, and it is why the ordering is
 * part of the design and not an accident of where the code was pasted.
 */
describe("FG-79..FG-89: a filing names the claim it moves", () => {
  const claimless = (title: string, body: string) =>
    `gh issue create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`;

  const NOVEL_NO_CLAIM = claimless(
    "pullRequestCache is never invalidated",
    "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours.",
  );

  test("FG-79: a novel finding naming no claim is REFUSED", async () => {
    const v = await adjudicateFiling(filingAttempts(NOVEL_NO_CLAIM)[0], async () => measuredCorpus([]));
    expect(v.outcome).toBe("REFUSE");
    expect(v.refusal).toBe("NO_CLAIM");
  });

  test("FG-80: the refusal says what to type, in both of the two ways out", async () => {
    // A check that stops somebody without telling them how to proceed is an
    // obstacle — `.claude/rules/self-referential-tests.md`. Both exits are
    // named because they are genuinely different acts: one asserts the work
    // matters, the other declares it cleanup and is counted.
    const v = await adjudicateFiling(filingAttempts(NOVEL_NO_CLAIM)[0], async () => measuredCorpus([]));
    expect(v.reason).toContain("Claim");
    expect(v.reason).toContain(FILING_OVERRIDE_LABEL);
  });

  test("FG-81 CONTROL: the same filing naming a claim is ALLOWED", async () => {
    // The ONLY axis that moves between FG-79 and this row is the claim
    // sentence. Without it FG-79 would be witnessing "this fixture is
    // refused" rather than "a claimless filing is refused".
    const withClaim = claimless(
      "pullRequestCache is never invalidated",
      `\`pullRequestCache\` in lib/pr-cache.ts holds 72 entries for 36 hours. Claim 4. ${DECLARED}`,
    );
    const v = await adjudicateFiling(filingAttempts(withClaim)[0], async () => measuredCorpus([]));
    expect(v.outcome).toBe("ALLOW");
    expect(v.refusal).toBeNull();
  });

  test("FG-82: the claim may be in the TITLE as well as the body", async () => {
    const v = await adjudicateFiling(
      filingAttempts(
        claimless(
          "Claim 4: pullRequestCache is never invalidated",
          `\`pullRequestCache\` in lib/pr-cache.ts holds 72 entries for 36 hours. ${DECLARED}`,
        ),
      )[0],
      async () => measuredCorpus([]),
    );
    expect(v.outcome).toBe("ALLOW");
  });

  test("FG-83: a claim number out of range does NOT satisfy the gate", () => {
    // The hole every format-only check has: a gate whose whole content is
    // "name one" is satisfied by naming a number nobody can look up. This is
    // the vacuous-assertion shape from `.claude/rules/checks-must-be-able-to-fail.md`,
    // closed by bounding rather than by shaping.
    expect(namedClaim("Claim 99 is moved by this")).toBeNull();
    expect(namedClaim("claim 0")).toBeNull();
    expect(namedClaim(`claim ${SUCCESS_CLAIM_COUNT + 1}`)).toBeNull();
  });

  test("FG-84: the spellings a person actually types all read", () => {
    for (const text of [
      "Claim 4",
      "claim 4",
      "CLAIM 4",
      "claims 2 and 4",
      "SUCCESS.md claim 4 — fail-open is the defect",
      "Moves claim #4.",
      "claim  4",
    ]) {
      expect(namedClaim(text), text).not.toBeNull();
    }
  });

  test("FG-85 CONTROL: the near-misses that are NOT a claim", () => {
    // `#4` is an issue number far more often than a claim and `SC-4` is a
    // success criterion. If either read as a claim, the gate would be
    // satisfied by the reference every finding already carries, which is the
    // same as not having a gate.
    for (const text of ["#4", "SC-4", "fixes #4", "reclaimed 4 bytes", "disclaimer 4"]) {
      expect(namedClaim(text), text).toBeNull();
    }
  });

  test("FG-86: a DUPLICATE is still reported as DUPLICATE, not as NO_CLAIM", async () => {
    // The ordering, asserted rather than described. "Already filed as #900" is
    // actionable; "name a claim" about a finding that should not be filed at
    // all sends the agent to do the wrong work.
    const v = await adjudicateFiling(filingAttempts(DUPLICATE_FILING)[0], async () =>
      measuredCorpus([{ id: "900", title: "retryBudget gives up early", body: DUPLICATE_BODY }]),
    );
    expect(v.refusal).toBe("DUPLICATE");
  });

  test("FG-87: an UNMEASURED tracker outranks the claim test", async () => {
    // A policy refusal that outranks a reading failure is a reading failure
    // nobody ever sees. The filing here names no claim AND could not be
    // deduplicated; the second is the one that must be said.
    const v = await adjudicateFiling(filingAttempts(NOVEL_NO_CLAIM)[0], async () =>
      unmeasuredCorpus("the open-issue set could not be read"),
    );
    expect(v.outcome).toBe("UNMEASURED");
    expect(v.refusal).toBe("UNMEASURED");
  });

  test("FG-88: the override label posts a claimless filing only if it DECLARES", async () => {
    // **This case used to assert the bypass, and its old title said so:
    // *"the override label posts a claimless filing, and is counted"*.**
    // `NOVEL_NO_CLAIM` is claimless AND undeclared, which since #1595 is
    // the cheapest route to the tracker — `NO_CLAIM` is issued before
    // `COMMENT_INSTEAD`, so the label waived the sibling and the unwaivable
    // comment default was never consulted. A test certifying that is why
    // nobody saw it. Inverted rather than deleted: the row still exists, it
    // just records the opposite verdict.
    const undeclared = await filingGate(`${NOVEL_NO_CLAIM} --label ${FILING_OVERRIDE_LABEL}`, {
      projectRoot: scratch,
      readExisting: async () => measuredCorpus([]),
    });
    expect(undeclared.refusal, "claimless AND undeclared is not postable by a label").not.toBeNull();
    expect(undeclared.rows[0].overridden, "and the label waived nothing").toBe(false);
    expect(undeclared.rows[0].emitted, "so nothing reached the tracker").toBe(false);

    // **CONTROL, one axis — the declaration added, still claimless.** The
    // original intent of this case survives and is the thing worth keeping:
    // cleanup IS still postable. What it costs is one declared line, which
    // is the whole bargain #1595 struck. Without this row the assertions
    // above are satisfied by a gate that stopped honouring the label at all.
    const declaredClaimless = `${NOVEL_NO_CLAIM.slice(0, -1)} ${DECLARED}"`;
    expect(namedClaim(declaredClaimless), "the control is still claimless").toBeNull();
    expect(declaredClaimless, "and it really declares").toContain(EXEMPTION_PREFIX);
    const r = await filingGate(`${declaredClaimless} --label ${FILING_OVERRIDE_LABEL}`, {
      projectRoot: scratch,
      readExisting: async () => measuredCorpus([]),
    });
    expect(r.refusal, "declared cleanup is still postable").toBeNull();
    expect(r.rows[0].refusal, "and the override is recorded, not erased").toBe("NO_CLAIM");
    expect(r.rows[0].overridden, "as an override").toBe(true);
  });

  test("FG-89: SUCCESS_CLAIM_COUNT equals the claims SUCCESS.md states", () => {
    // The constant exists so the gate needs no I/O to decide — a gate that
    // needs a file read fails open when the read does. This is the agreement
    // that keeps it honest: add a claim to SUCCESS.md and this goes red until
    // the number follows.
    const success = readFileSync(join(resolve(import.meta.dir, ".."), "SUCCESS.md"), "utf-8");
    const harness = success.slice(
      success.indexOf("## Done, for the harness"),
      success.indexOf("## Done, for a consumer"),
    );
    expect(harness.length, "the section headings must both still be present").toBeGreaterThan(200);
    const stated = [...harness.matchAll(/^(\d+)\.\s+\*\*/gm)].map(m => Number(m[1]));
    expect(stated, "the claims are numbered 1..N with no gaps").toEqual(
      Array.from({ length: stated.length }, (_, i) => i + 1),
    );
    expect(SUCCESS_CLAIM_COUNT).toBe(stated.length);
  });
});

/**
 * FG-100..FG-103: an override survives a re-drafted body (#1536).
 *
 * `overridden` read `verdict.outcome === "REFUSE" && labelled`, which is
 * correct about this adjudication and blind to the one before it. The body
 * is an input to the symptom keys, so writing down WHY you are overriding
 * changes the keys, the duplicate stops matching, the verdict is no longer
 * a refusal, and the label is never exercised. Measured on the live ledger,
 * one filing, same title, 37 seconds apart:
 *
 *     10:55:08.109Z  DROP   refusal=DUPLICATE  emitted=false  overridden=false
 *     10:55:45.786Z  ISSUE  refusal=null       emitted=true   overridden=false
 *
 * One `overridden: true` row had ever been written, against two overrides
 * performed that day.
 *
 * ## What was broken to make these fail
 *
 * Restore the one-term predicate — `const overridden = verdict.outcome ===
 * "REFUSE" && labelled` — and **FG-100 and FG-102 go red together**, which
 * is the pair worth having: FG-100 loses the `overridden: true` row and
 * FG-102 loses the `refiledAfter` that makes a silent re-draft visible.
 * FG-101 stays green under that mutation and is labelled BASELINE for
 * exactly that reason: it is the live-refusal path, unchanged by #1536, and
 * a row that moved with the others would not tell anyone which path broke.
 *
 * ## Why the join is the title
 *
 * It is the one thing the re-draft did not touch, and the issue's own
 * evidence is two rows agreeing on it. Keying on the hash is what failed;
 * keying on a *similarity* over prose would fail the same way one layer in.
 */
describe("FG-100..FG-103: an override is a claim about a prior refusal", () => {
  /** Shared by both filings below, and the only thing they share. */
  const TITLE = "retryBudget abandons a sweep once the budget is spent";

  /** A real DUPLICATE of #900 — same symbol, same file, two same readings. */
  const REFUSED =
    `gh issue create --title ${JSON.stringify(TITLE)} ` +
    '--body "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts completes 144 of 234."';

  /**
   * The same filing, re-drafted to explain the override — which is the
   * normal reaction to a refusal and the thing that defeated the counter.
   * It no longer collides with #900 on its own merits, so under the old
   * predicate the label has nothing to waive.
   */
  const REDRAFT =
    `gh issue create --title ${JSON.stringify(TITLE)} ` +
    '--body "Overriding the arbiter: the issue it named is a different defect, about a cache. ' +
    `This one is about a sweep abandoning work it had already started. Claim 4. ${DECLARED}"`;

  const rowsFor = (title: string) => ledgerRows().filter(r => r.title === title);

  test("FG-100: a refusal, then a re-drafted re-filing with the label, is recorded as an override", () => {
    const first = runHook(HOOK, REFUSED);
    expect(first.blocked, "the first filing must actually be refused, or this row proves nothing")
      .toBe(true);
    const refusal = rowsFor(TITLE).at(-1)!;
    expect(refusal.refusal).toBe("DUPLICATE");
    expect(refusal.duplicateOf).toEqual(["900"]);

    const second = runHook(HOOK, `${REDRAFT} --label ${FILING_OVERRIDE_LABEL}`);
    expect(second.blocked, "the re-draft is allowed — nothing here makes the gate stricter").toBe(false);

    const override = rowsFor(TITLE).at(-1)!;
    // The defect, in one assertion: this read `false` before #1536.
    expect(override.overridden).toBe(true);
    // And it NAMES the refusal it waived rather than implying it.
    expect(override.refiledAfter).toBe(refusal.at);
    expect(override.duplicateOf).toEqual(["900"]);
    // The adjudication's own output is untouched: this filing really did
    // not reproduce the collision, and the row must not pretend it did.
    expect(override.refusal, "the live verdict stays what the scorer returned").toBeNull();
    expect(second.reason).toContain(FILING_OVERRIDE_LABEL);
  });

  test("FG-101 BASELINE: an override over a LIVE refusal is still recorded, with no ledger at all", async () => {
    // `readLedger: () => []` is the control. Without it this row would be
    // green under a change that recorded every override from the prior-row
    // lookup and broke the live path — two mechanisms, one observable.
    const r = await filingGate(`${DUPLICATE_FILING} --label ${FILING_OVERRIDE_LABEL}`, {
      projectRoot: scratch,
      readExisting: async () => measuredCorpus(OPEN_ISSUES.map(i => ({ ...i, id: String(i.number) }))),
      readLedger: () => [],
    });
    expect(r.rows[0].refusal, "the live verdict is a refusal").toBe("DUPLICATE");
    expect(r.rows[0].overridden).toBe(true);
    expect(r.rows[0].refiledAfter, "and no prior row was involved").toBeNull();
    expect(r.refusal, "an override does not block").toBeNull();
  });

  test("FG-102: the same re-draft WITHOUT the label is allowed, and says so", () => {
    expect(runHook(HOOK, REFUSED).blocked).toBe(true);
    const refusal = rowsFor(TITLE).at(-1)!;

    const second = runHook(HOOK, REDRAFT);
    // Not stricter. #1536 says in as many words that the defect is the
    // re-draft being INVISIBLE, not its getting through.
    expect(second.blocked).toBe(false);

    const row = rowsFor(TITLE).at(-1)!;
    expect(row.emitted).toBe(true);
    // The label is still what an override means, so this is NOT one...
    expect(row.overridden).toBe(false);
    // ...and the prior refusal is on the row anyway, which is the whole
    // difference between a counted waiver and a silent paraphrase.
    expect(row.refiledAfter).toBe(refusal.at);
    expect(second.reason).toContain("refused at");
  });

  test("FG-103: a ledger that cannot be read is UNMEASURED, not an empty one", () => {
    // `.claude/rules/config-access.md`: an absent store and an unreadable
    // one are different facts, and only one of them is a reading. Collapsed
    // here, a machine that has never filed anything would get a note on its
    // first `gh issue create` — or, far worse, an override attributed to no
    // refusal would be indistinguishable from one there was none to find.
    expect(readLedgerRows(join(scratch, "no-such-ledger.jsonl")), "absent is empty").toEqual([]);
    expect(readLedgerRows(scratch), "a directory cannot be read").toBeNull();

    // A torn final append is skipped rather than refusing the file: several
    // processes append to one ledger and a half-written line is the
    // expected failure, not a corrupt store.
    const torn = join(scratch, "torn-ledger.jsonl");
    const good = { ...ledgerRows()[0], title: "a complete row" };
    writeFileSync(torn, `${JSON.stringify(good)}\n{"at":"2026-`, "utf-8");
    expect(readLedgerRows(torn)?.map(r => r.title)).toEqual(["a complete row"]);
  });

  test("FG-103: `priorRefusalFor` matches a refusal and nothing else", () => {
    const base: FilingLedgerRow = {
      at: "2026-10-24T10:00:00.000Z",
      key: "b/0",
      id: "new",
      title: TITLE,
      symptomHash: "h",
      category: "correctness",
      severity: null,
      disposition: "DROP",
      refusal: "DUPLICATE",
      emitted: false,
      withheldBy: "DUPLICATE",
      jury: null,
      duplicateOf: ["900"],
      overridden: false,
      refiledAfter: null,
      exemption: null,
      run: null,
    };
    const older = { ...base, at: "2026-10-24T09:00:00.000Z" };
    // The most recent wins, and the walk must not depend on file order.
    expect(priorRefusalFor(TITLE, [base, older])?.at).toBe(base.at);
    expect(priorRefusalFor(TITLE, [older, base])?.at).toBe(base.at);

    expect(priorRefusalFor("a different title", [base]), "another finding").toBeNull();
    expect(priorRefusalFor(TITLE, [{ ...base, refusal: null }]), "an ordinary allow").toBeNull();
    // A refusal that was overridden still REACHED the tracker, so it is not
    // a refusal a later filing can be a re-draft of.
    expect(priorRefusalFor(TITLE, [{ ...base, emitted: true, overridden: true }])).toBeNull();

    // The three shapes that are NOT a refusal and look like one. The first
    // spelling of this predicate admitted all three, and `FG-48 CONTROL`
    // caught it on an UNMEASURED row left by an unrelated case.
    expect(
      priorRefusalFor(TITLE, [{ ...base, refusal: "UNMEASURED", withheldBy: "UNMEASURED" }]),
      "UNMEASURED is not a refusal — it is the state of not having adjudicated",
    ).toBeNull();
    expect(
      priorRefusalFor(TITLE, [{ ...base, refusal: null, withheldBy: COMMAND_BLOCKED }]),
      "a clean clause withheld by its sibling was never adjudicated down",
    ).toBeNull();
    expect(
      priorRefusalFor(TITLE, [{ ...base, withheldBy: COMMAND_BLOCKED }]),
      "and nor was a clause the command blocked before its own verdict landed",
    ).toBeNull();
  });
});

/**
 * FG-120..FG-139: not filing is the default, and the gate asks (#1595).
 *
 * `lib/finding-arbiter.ts` decided this in its own docblock — *"THE DEFAULT
 * IS A COMMENT, NOT AN ISSUE … `Disposition` defaults to `COMMENT`, `ISSUE`
 * requires an explicit declared reason from the caller"* — and the decision
 * never reached the path agents use. The hook ran category, dedupe and
 * `NO_CLAIM`, and none of the three asks *should this have been a comment?*
 *
 * Measured when #1595 was filed: 772 issues ever, 48 open, 3 older than three
 * days, and 70–85% of everything closed each day since 2026-10-20 had been
 * filed under six hours before it closed. Filing tracked closing almost
 * exactly — 57 filed against 53 closed that day, 125 against 109 two days
 * earlier — while `open` stayed flat. The hook-side half of the CRC-N3 item
 * about flagging a class rather than an instance is the second block below.
 *
 * ## This gate's failure mode is SILENCE, so the controls are the deliverable
 *
 * A declaration check that always passes refuses nothing and looks exactly
 * like a declaration check everybody satisfies. Four properties, and the
 * third is the one a careless version of this file would miss:
 *
 * 1. undeclared is REFUSED, and the refusal names the comment target;
 * 2. declared is ALLOWED — a gate that refuses everything is not a bar, and
 *    `lib/issue-filing-gate.ts`'s own header warns against exactly that;
 * 3. a mutant that makes the reason check ALWAYS PASS turns a case red.
 *    **The mutant a parse-only test misses is `M1`**: `adjudicateFiling`
 *    still calls `declaredExemption`, still gets the right answer out of it,
 *    and never acts on it. Every assertion about parsing stays green under
 *    M1 — only an assertion about the VERDICT moves, which is why FG-136
 *    reads `outcome` and not `exemption`;
 * 4. the population is asserted: N filings in, N rows on the ledger. An
 *    absent row is UNMEASURED, never an empty population.
 *
 * ## Predicted before running, as values
 *
 * Every row below carries its predicted value in its assertion rather than a
 * direction, because "I expect this to fail" cannot be wrong. The one
 * prediction that was WRONG when this block was first run is recorded at
 * FG-133, and it is kept rather than quietly corrected.
 */
describe("FG-120..FG-135: a filing declares why it cannot be a comment", () => {
  /** The three readings of a comment target, as the gate may be handed them. */
  const onPr: CommentTarget = { reading: "PR", number: 1595, branch: "rg/1595-filing-default" };
  const noPr: CommentTarget = { reading: "NO_PR", branch: "rg/1595-filing-default" };
  const unknownTarget: CommentTarget = { reading: "UNMEASURED", why: "the API said 403" };

  /**
   * A novel, claim-naming correctness finding that declares NOTHING.
   *
   * Every stage before the new one must clear it, or this block would be
   * measuring the stage it shares an input with rather than the new one.
   */
  const UNDECLARED =
    'gh issue create --title "zqxjSweepBudget abandons a sweep it started" ' +
    '--body "`zqxjSweepBudget` in lib/zqxj-sweep.ts drops 31 of 44 commands, over 9107 runs. Claim 4."';

  /** The same filing, declaring one of the three. The only axis that moves. */
  const DECLARED_FILING = `${UNDECLARED.slice(0, -1)} ${DECLARED}"`;

  const allow = async () => measuredCorpus([]);
  const gateOn = (cmd: string, target: CommentTarget = onPr) =>
    filingGate(cmd, {
      projectRoot: scratch,
      readExisting: allow,
      readLedger: () => [],
      readTarget: async () => target,
    });

  test("FG-120: a filing declaring no reason it cannot be a comment is REFUSED", async () => {
    const v = await adjudicateFiling(filingAttempts(UNDECLARED)[0], allow);
    expect(v.outcome).toBe("REFUSE");
    expect(v.refusal).toBe("COMMENT_INSTEAD");
    // The premise, asserted rather than assumed: no EARLIER stage is what
    // refused it. Without this the row could be witnessing the dedupe.
    //
    // Through `DROPPED_CATEGORIES` and not against a literal category name:
    // the first spelling asserted `"correctness"` and the classifier returns
    // `"unclassified"` for this fixture, which is a true statement about the
    // classifier and NOT the property being claimed here. The property is
    // that the category stage did not drop it.
    expect(DROPPED_CATEGORIES.has(v.category), `the category stage cleared it (${v.category})`).toBe(false);
    expect(v.duplicateOf, "and nothing collided, so the dedupe cleared it").toEqual([]);
    expect(namedClaim(UNDECLARED), "and it names a claim, so NO_CLAIM is not what fired").toBe(4);
  });

  test("FG-121 CONTROL: the same filing WITH a declaration is ALLOWED", async () => {
    // A gate that refuses everything is not a bar. This is the row that
    // separates "the declaration is read" from "this fixture is refused",
    // and the declaration sentence is the only thing that differs.
    const v = await adjudicateFiling(filingAttempts(DECLARED_FILING)[0], allow);
    expect(v.outcome).toBe("ALLOW");
    expect(v.refusal).toBeNull();
    expect(v.exemption).toBe("out-of-pr-diff");
  });

  test("FG-122: the refusal NAMES the comment target and says which", async () => {
    const r = await gateOn(UNDECLARED, onPr);
    expect(r.refusal ?? "", "the command is blocked and the refusal is what the agent reads")
      .toContain("PR #1595");
    expect(r.refusal ?? "").toContain("Post it as a comment");
  });

  test("FG-123: the three target readings produce three different sentences", () => {
    // `NO_PR` is a READING and not a gap: a branch with no open PR is a state
    // an agent can act on. Collapsing it into UNMEASURED would be the Silent
    // Default Substitution `.claude/rules/config-access.md` forbids, in the
    // one sentence the agent actually reads.
    expect(commentTargetSentence(onPr)).toContain("PR #1595");
    expect(commentTargetSentence(noPr)).toContain("no open PR");
    expect(commentTargetSentence(noPr)).not.toContain("UNMEASURED");
    expect(commentTargetSentence(unknownTarget)).toContain("UNMEASURED");
    expect(commentTargetSentence(unknownTarget), "and the reading's OWN why, never one composed here")
      .toContain("the API said 403");
  });

  test("FG-124: the list is CLOSED — a token outside it is not a declaration", () => {
    // The hole every format-only check has, closed the way `namedClaim`
    // closes it: by bounding the value rather than by shaping it. Free text
    // here would be the same bar as NO_CLAIM, which three of four filings on
    // 2026-10-23 cleared in one sentence each.
    for (const token of Object.keys(COMMENT_EXEMPTIONS) as CommentExemption[]) {
      expect(declaredExemption(`${EXEMPTION_PREFIX} ${token}`), token).toBe(token);
    }
    for (const miss of [
      `${EXEMPTION_PREFIX} because I need it tracked`,
      `${EXEMPTION_PREFIX} out-of-scope`,
      `${EXEMPTION_PREFIX} important`,
      "out-of-pr-diff",
      "This cannot be a comment.",
    ]) {
      expect(declaredExemption(miss), miss).toBeNull();
    }
  });

  test("FG-125: the spellings a person actually types all read", () => {
    for (const text of [
      "Cannot be a comment: green-check-lies",
      "cannot be a comment: green-check-lies",
      "CANNOT BE A COMMENT: GREEN-CHECK-LIES",
      "Cannot be a comment:  `green-check-lies`",
      "…and so: Cannot be a comment: green-check-lies — the required check goes green.",
      "Cannot be a comment: not-a-token\nCannot be a comment: green-check-lies",
    ]) {
      expect(declaredExemption(text), text).toBe("green-check-lies");
    }
  });

  test("FG-126: the refusal's own text does NOT satisfy the gate", () => {
    // An agent that re-files after a refusal pastes the refusal. An allowlist
    // that names what it exempts becomes evidence those things were named —
    // so the gate's own words must not clear the gate. Measured by feeding
    // the string back through the reader rather than by trusting the layout.
    for (const target of [onPr, noPr, unknownTarget]) {
      const text = exemptionReason(target);
      expect(text, "the refusal does list the tokens, or it is not actionable")
        .toContain("out-of-pr-diff");
      expect(declaredExemption(text), "and listing them does not declare one").toBeNull();
    }
  });

  test("FG-127: a DUPLICATE is still DUPLICATE, not COMMENT_INSTEAD", async () => {
    // "Already filed as #900" is actionable; "declare why this cannot be a
    // comment" about a finding that should not be filed at all sends the
    // agent to do the wrong work. The ordering, asserted rather than said.
    const v = await adjudicateFiling(filingAttempts(DUPLICATE_FILING)[0], async () =>
      measuredCorpus([{ id: "900", title: "retryBudget gives up early", body: DUPLICATE_BODY }]),
    );
    expect(v.refusal).toBe("DUPLICATE");
  });

  test("FG-128: a claimless, undeclared filing is NO_CLAIM — the order is deliberate", async () => {
    // The one ordering choice in #1595 worth defending. Putting this stage
    // before `NO_CLAIM` makes NO_CLAIM unreachable for the common filing —
    // a shipped gate deleted as a side effect of adding one — and the round
    // trip it would save does not exist: `refusalMessage` already tells
    // every refused filing to fix it in the PR or answer it in a comment.
    const claimless = UNDECLARED.replace(" Claim 4.", "");
    expect(namedClaim(claimless), "the fixture really does name no claim").toBeNull();
    const v = await adjudicateFiling(filingAttempts(claimless)[0], allow);
    expect(v.refusal).toBe("NO_CLAIM");
  });

  test("FG-129: an UNMEASURED tracker outranks the declaration test", async () => {
    // A policy refusal that outranks a reading failure is a reading failure
    // nobody ever sees.
    const v = await adjudicateFiling(filingAttempts(UNDECLARED)[0], async () =>
      unmeasuredCorpus("the open-issue set could not be read"),
    );
    expect(v.outcome).toBe("UNMEASURED");
    expect(v.refusal).toBe("UNMEASURED");
  });

  test("FG-130: the override label does NOT post an undeclared filing", async () => {
    // **Reversed on 2026-10-25, and the reversal is the point.** This case
    // used to assert that the label posts an undeclared filing and records
    // the refusal it waived. That made the comment DEFAULT waivable by a
    // token the refusal itself told the agent to use, so the closed list of
    // three exceptions had a fourth member spelled in the message enforcing
    // it — and `arbiter-override` was already on 7 of the 140 issues filed
    // in the two days before this gate shipped.
    //
    // **What this case binds to changed under it, and the honest note is
    // that it is no longer the map.** When the reversal landed, removing
    // `COMMENT_INSTEAD` from `UNWAIVABLE_REFUSALS` turned this row red —
    // measured, at `df839b30`. Then `overrideOf` gained its declaration
    // read, and a clause refused `COMMENT_INSTEAD` is BY DEFINITION one
    // whose `exemption` is null, so the label is refused here whether or
    // not the map entry exists. This row still asserts a true and necessary
    // invariant — an undeclared filing does not reach the tracker under the
    // label — it just no longer discriminates WHICH binding delivers it.
    // `FG-177` is where the two are separated: M7 for the message, M8 for
    // the gate. Raised by the AI review of this PR, which was right, and
    // right about three rows rather than the one I had already found.
    //
    // The declaration costs one line. Nothing legitimate needs the label
    // here, and the route it opened is the one that wins by making the
    // filing WORSE: delete the declaration, add the flag.
    const r = await gateOn(`${UNDECLARED} --label ${FILING_OVERRIDE_LABEL}`);
    expect(r.refusal, "the label carried an undeclared filing to the tracker").not.toBeNull();
    expect(r.rows[0].refusal).toBe("COMMENT_INSTEAD");
    expect(r.rows[0].overridden, "and the ledger must not say a label waived it").toBe(false);
    expect(r.rows[0].emitted).toBe(false);

    // CONTROL, one axis — the same command with the declaration present and
    // NO label. Without it this case is satisfied by a gate that refuses
    // every filing, which is a gag and not a default.
    const declared = await gateOn(DECLARED_FILING);
    expect(declared.refusal, "a declared filing still goes through").toBeNull();
    expect(declared.rows[0].emitted).toBe(true);
  });

  test("FG-131: N filings in, N dispositions recorded — on the real ledger", async () => {
    // The POPULATION, read off the file the hook appends to rather than off
    // a return value. An absent row is UNMEASURED, never an empty
    // population, so the count is asserted before anything about its
    // contents — and the three clauses are deliberately three DIFFERENT
    // outcomes, because three rows that agree cannot show a missing one.
    const before = ledgerRows().length;
    const r = runHook(HOOK, `${DECLARED_FILING} && ${UNDECLARED} && ${DROPPED_FILING}`);
    expect(r.blocked, "the command is blocked, and every clause is still recorded").toBe(true);
    const mine = ledgerRows().slice(before);
    expect(mine, "three clauses in, three rows out").toHaveLength(3);
    expect(
      mine.map(x => x.disposition),
      "and a disposition on every one of them, kept and dropped alike",
    ).toEqual(["ISSUE", "DROP", "DROP"]);
    expect(mine.map(x => x.refusal)).toEqual([null, "COMMENT_INSTEAD", "DROPPED_CATEGORY"]);
  });

  test("FG-132: the declared reason is on the row, allowed and refused alike", async () => {
    // Scope item 3. The rate #1595 wants computable is per CLASS and its
    // denominator is EVERY row in the class, so a column carried only on the
    // refusals could never supply one. `symptomHash` is the class key and
    // has been on the row since #1261, so this needs one new column.
    const r = await gateOn(`${DECLARED_FILING} && ${UNDECLARED}`);
    expect(r.rows.map(x => x.exemption)).toEqual(["out-of-pr-diff", null]);
    expect(
      r.rows.every(x => typeof x.symptomHash === "string" && x.symptomHash !== ""),
      "and the class key the rate groups by is on both",
    ).toBe(true);
  });

  test("FG-133: two clauses of one class in one command — the second is refused", async () => {
    // **The prediction that was wrong.** Before running this block I
    // predicted FG-66 and FG-71 — both of which file `NOVEL_FILING` twice in
    // one command — would go red when this stage landed. They did not: they
    // assert on row identity and row count, which a refusal does not move.
    // So the in-run class check had to be asserted here, on the verdict,
    // rather than inferred from a suite that stayed green.
    const r = await gateOn(`${DECLARED_FILING} && ${DECLARED_FILING}`);
    expect(r.rows.map(x => x.refusal)).toEqual([null, "SAME_CLASS_IN_RUN"]);
    expect(r.refusal ?? "", "and the refusal names the clause to fold it into").toContain("clause 1");
    expect(r.refusal ?? "").toContain("every instance");
  });

  test("FG-134 CONTROL: two clauses of DIFFERENT classes are capped, not class-refused", async () => {
    // Without this row FG-133 would be witnessing "the second clause of a
    // command is refused", which is a gate on the `&&` and not on the class.
    //
    // Under `FILINGS_PER_RUN = 1` the second clause is refused either way,
    // so the control is no longer *allowed vs refused* — it is WHICH
    // refusal, and that is the stronger form: the only axis that moves
    // between this row and FG-133 is whether the two clauses share a class,
    // and the refusal value follows it exactly.
    const r = await gateOn(`${DECLARED_FILING} && ${NOVEL_FILING}`);
    expect(r.rows.map(x => x.refusal)).toEqual([null, "OVER_CAP"]);
  });

  test("FG-135: a clause never collides with ITSELF", async () => {
    // The cheapest wrong implementation compares each clause against a list
    // it has already been added to, which refuses every single-clause filing
    // in the tree and reads exactly like a gate that works.
    const r = await gateOn(DECLARED_FILING);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].refusal).toBeNull();
  });

  test("FG-136: `filingFinding` is the one binding both readers use", () => {
    // Two spellings of "what finding is this command filing" would be two
    // deciders for one question, and the second always agrees with the first
    // until the day it does not.
    const [attempt] = filingAttempts(DECLARED_FILING);
    const { finding, body } = filingFinding(attempt);
    expect(finding.title).toBe(attempt.title);
    expect(body).toBe(attempt.body);
    // A body-file that cannot be read: `body` is null, the finding still
    // carries the inline text. Different fields, different facts.
    const unreadable = filingFinding({ ...attempt, bodyFile: "/nope.md" }, () => null);
    expect(unreadable.body).toBeNull();
    expect(unreadable.finding.body).toBe(attempt.body);
  });
});

/**
 * FG-137..FG-139: the reason check, removed and observed (#1595).
 *
 * The mutant is a real copy of `lib/issue-filing-gate.ts`, not a predicate
 * re-spelled in this file. `FG-68` records why that was not possible there —
 * *"a mutant copy … in a scratch directory cannot resolve its own relative
 * imports and would fail to LOAD, which on a count reads exactly like a guard
 * that held"* — and `buildMutant` is the answer to it: every sibling of the
 * real module is symlinked beside the mutant, so each relative import
 * resolves to the code under test and nothing is rewritten.
 *
 * ## Four things the builder asserts rather than assumes
 *
 * - **the anchor appears exactly once**, or a mutation that did not apply
 *   reads exactly like one that did;
 * - **every relative import of the mutant source has a sibling in its
 *   directory**, so a module-resolution death cannot be mistaken for a
 *   refusal. Type-only imports are erased at transpile and need no sibling
 *   at runtime; they are asserted anyway, because the cost is nothing and
 *   the alternative is a rule about which imports count;
 * - **each mutant gets its OWN directory.** Bun resolves a dynamic
 *   `import()` against a cached listing of the containing directory, so two
 *   mutants written into one scratch dir give row one a load and row two a
 *   miss, with `existsSync` true for both — byte-identical to the mutant
 *   being rejected on the merits;
 * - **the mutant LOADS and still allows the declared filing**, read before
 *   any mutation row below it.
 *
 * ## The two mutants, and which one a careless test misses
 *
 * | id | mutation | what it models |
 * |---|---|---|
 * | `M1` | `declared === null` → `false` | the gate PARSES the declaration and never acts on it |
 * | `M2` | the closed-list membership test is dropped | the list is open: any word declares |
 *
 * **M1 is the one requiring care.** Under it `declaredExemption` is still
 * called, still returns the right value, and still reaches the ledger row —
 * so every assertion about parsing, and every assertion about `exemption`,
 * stays green. Only an assertion on the VERDICT moves. FG-137 reads
 * `outcome`, and FG-139 states the miss by measuring it: the field a
 * parse-only test would have asserted is shown to be identical across the
 * real gate and M1.
 */
describe("FG-137..FG-139, FG-153, FG-156, FG-158, FG-169, FG-177: a mutant turns a case red", () => {
  const LIB = join(REPO, "lib");
  const UNIT = "issue-filing-gate.ts";

  /**
   * A real mutant of the module, in a directory of its own, built once.
   *
   * Memoised so a later row can reach an earlier row's mutant without
   * depending on execution order and without a second `symlinkSync` over the
   * same names — and so the directory-per-mutant property above holds by
   * construction rather than by every caller remembering it.
   */
  const built = new Map<string, string>();
  function buildMutant(name: string, anchor: string, replacement: string): string {
    const already = built.get(name);
    if (already !== undefined) return already;
    const dir = join(scratch, `mut-${name}`);
    mkdirSync(dir, { recursive: true });
    const src = readFileSync(join(LIB, UNIT), "utf-8");
    expect(src.split(anchor).length - 1, `the ${name} anchor must appear exactly once in ${UNIT}`).toBe(1);

    const carried = new Set<string>();
    for (const file of readdirSync(LIB)) {
      if (file === UNIT) continue;
      symlinkSync(join(LIB, file), join(dir, file));
      carried.add(file);
    }
    // Asserted, not assumed: a missing sibling is a load failure, and a load
    // failure reads as a refusal on every channel this battery watches.
    const wanted = [...src.matchAll(/from "\.\/([A-Za-z0-9._-]+)"/g)].map(m => `${m[1]}.ts`);
    expect(wanted.length, "the mutant really does import siblings").toBeGreaterThan(0);
    expect(
      wanted.filter(f => !carried.has(f)),
      `every relative import of the mutant must have a sibling in ${dir}`,
    ).toEqual([]);

    const at = join(dir, UNIT);
    writeFileSync(at, src.replace(anchor, replacement), "utf-8");
    built.set(name, at);
    return at;
  }

  /** `M1` — the declaration is read and never acted on. */
  const M1 = "declared === null";
  /** `M2` — the closed list stops being closed. */
  const M2 = "if (token in COMMENT_EXEMPTIONS) return token as CommentExemption;";
  /** `M3` — the cap never binds, however much the run has filed. */
  const M3 = "spent >= FILINGS_PER_RUN";
  /** `M4` — every refusal becomes waivable, including the cap. */
  const M4 = "return refusal === null || !(refusal in UNWAIVABLE_REFUSALS);";
  /** `M5` — the cap stops seeing filings the label would carry through. */
  const M5 = "|| overrideOf(read2)";
  /** `M6` — the reservation is taken and its position is never read. */
  const M6 = "ordinal > FILINGS_PER_RUN";
  /**
   * `M7` — the comment DEFAULT goes back to being waivable by a label.
   *
   * The MEMBERSHIP, not the predicate: `M4` forces `waivableRefusal` true
   * for everything and would kill a case about the cap just as readily.
   * This removes one key and leaves the other two, so the only behaviour
   * that can move is the one `FG-177` is about.
   */
  const M7 = "  COMMENT_INSTEAD:\n";
  /**
   * The declaration read inside `overrideOf` — the sibling-refusal fix.
   *
   * Separate from `M7` because after that fix the two bindings no longer
   * control the same thing: `M7` decides what the refusal MESSAGE says, and
   * this decides what the GATE does. `FG-177` runs both and asserts which
   * is which, because a mutant that moves nothing is indistinguishable from
   * a case that never exercised the branch.
   */
  const M8 = "      v.exemption !== null &&";

  const UNDECLARED =
    'gh issue create --title "zqxjMutantProbe abandons a sweep it started" ' +
    '--body "`zqxjMutantProbe` in lib/zqxj-mutant.ts drops 23 of 58 commands, over 7731 runs. Claim 4."';
  const DECLARED_FILING = `${UNDECLARED.slice(0, -1)} ${DECLARED}"`;
  const NONSENSE = `${UNDECLARED.slice(0, -1)} ${EXEMPTION_PREFIX} i-just-want-it-tracked"`;

  type Gate = typeof import("../lib/issue-filing-gate");
  const verdictOf = async (gate: Gate, cmd: string) =>
    gate.adjudicateFiling(gate.filingAttempts(cmd)[0], async () => gate.measuredCorpus([]));

  test("FG-137: M1 — the real gate REFUSES the undeclared filing and M1 allows it", async () => {
    const mutant: Gate = await import(buildMutant("always-declared", M1, "false"));

    // BASELINE FIRST. A mutant that failed to load throws above; a mutant
    // that loaded but refuses everything would make the row below pass for
    // the wrong reason, so the declared control is read before the mutation.
    expect(
      (await verdictOf(mutant, DECLARED_FILING)).outcome,
      "the mutant must load and still ALLOW a declared filing",
    ).toBe("ALLOW");

    expect((await verdictOf(await import("../lib/issue-filing-gate"), UNDECLARED)).outcome).toBe("REFUSE");
    expect(
      (await verdictOf(mutant, UNDECLARED)).outcome,
      "with the reason check removed, the undeclared filing sails through",
    ).toBe("ALLOW");
  });

  test("FG-138: M2 — the closed list is what refuses an invented reason", async () => {
    const mutant: Gate = await import(buildMutant("open-list", M2, "return token as CommentExemption;"));

    expect(
      (await verdictOf(mutant, DECLARED_FILING)).outcome,
      "the mutant must load and still ALLOW a real declaration",
    ).toBe("ALLOW");

    const real = await import("../lib/issue-filing-gate");
    expect(
      (await verdictOf(real, NONSENSE)).refusal,
      "an invented token is not a declaration",
    ).toBe("COMMENT_INSTEAD");
    expect(
      (await verdictOf(mutant, NONSENSE)).outcome,
      "and with the membership test gone, any word somebody types is one",
    ).toBe("ALLOW");
  });

  test("FG-139: the field a PARSE-only test would assert is identical under M1", async () => {
    // The miss, measured rather than described. `exemption` is what a test
    // written to "check the reason was read" would assert, and it is the
    // same value on the real gate and on a gate that ignores the reason
    // entirely. A battery that only varied the input would never see it.
    const mutant: Gate = await import(buildMutant("always-declared", M1, "false"));
    const real = await import("../lib/issue-filing-gate");

    const realV = await verdictOf(real, UNDECLARED);
    const mutantV = await verdictOf(mutant, UNDECLARED);
    expect(mutantV.exemption, "the parse agrees, so a parse assertion cannot tell them apart")
      .toBe(realV.exemption);
    expect(mutantV.outcome, "and the verdict does not, which is the only axis that moves")
      .not.toBe(realV.outcome);
  });

  /**
   * FG-140..FG-141: the live target resolver's two local arms.
   *
   * Only the arms that need no credential are asserted, and that is the
   * point rather than a limitation: both of them are states that would
   * otherwise be reported as `NO_PR`, which is a claim about the tracker.
   * The `PR` arm needs a token and is measured by hand — against this
   * worktree on 2026-10-24 `openPrForBranch` returned
   * `{reading:"NO_PR",branch:"rg/1595-filing-default"}`, a real API call for
   * a branch that had no PR open yet.
   */
  test("FG-153: M3 — the cap is what refuses the second filing of a run", async () => {
    // Property 3 of the four #1595 names: a mutant that makes the cap never
    // bind must turn a case red. `spent >= FILINGS_PER_RUN` is the whole
    // decision, and the mutant is that expression forced to `false`.
    const mutant: Gate = await import(buildMutant("uncapped", M3, "false"));
    const dir = join(scratch, "mut-cap-run");
    mkdirSync(dir, { recursive: true });

    const at = "2026-10-24T12:00:00.000Z";
    // The row a spent allowance leaves is the INTENT, not the outcome — the
    // cap counts reservations so that a filing in flight in another process
    // is visible. A fixture built as an emitted row would be a spent
    // allowance the gate cannot see, and every mutant below would go green
    // against a cap that was never loaded.
    const spentRow = {
      at,
      key: `b.1/${at}/0${INTENT_KEY_SUFFIX}`,
      id: "new",
      title: "already filed by this run",
      symptomHash: "h",
      category: "correctness" as const,
      severity: null,
      disposition: "ISSUE" as const,
      refusal: null,
      emitted: false,
      withheldBy: INTENT_PENDING,
      jury: null,
      duplicateOf: [],
      overridden: false,
      refiledAfter: null,
      exemption: "out-of-pr-diff" as const,
      intent: true,
      run: null as string | null,
    };
    const filing =
      'gh issue create --title "zqxjMutantCap loses a sweep" ' +
      `--body "\`zqxjMutantCap\` in lib/zqxj-mutant-cap.ts drops 19 of 37 commands over 8803 runs. Claim 4. ${DECLARED}"`;

    const runOn = (gate: Gate, prior: unknown[], wrote: unknown[] = []) =>
      gate.filingGate(filing, {
        projectRoot: dir,
        now: at,
        readExisting: async () => gate.measuredCorpus([]),
        readLedger: () => prior as never,
        appendLedger: ((r: unknown) => {
          wrote.push(r);
          return true;
        }) as never,
        readTarget: async () => ({ reading: "NO_PR", branch: "b" }) as never,
      });

    // BASELINE FIRST: the mutant loaded, and on an EMPTY ledger it agrees
    // with the real gate. A mutant that refused or allowed everything would
    // make the row below pass for the wrong reason.
    const real: Gate = await import("../lib/issue-filing-gate");
    expect(
      (await runOn(mutant, [])).rows[0].refusal,
      "the mutant must load and still allow a first filing",
    ).toBeNull();
    expect((await runOn(real, [])).rows[0].refusal, "as does the real gate").toBeNull();

    // **This row said "with the cap unable to bind, a run files without
    // limit" and that stopped being true when the race fix landed.** The
    // reservation stage reads the queue AFTER appending, so it refuses an
    // over-cap filing whatever the pre-read decided: M3 no longer produces
    // a bypass, and a mutant that kills nothing is a row that certifies
    // nothing. Restated to the difference that remains, and reported rather
    // than quietly weakened — the pre-read is now a fast path and the
    // ordinal is the decider, which is a design question for the loop
    // refactor and not something to settle by editing an assertion.
    const spent = [{ ...spentRow, run: real.runIdFor(dir).run! }];
    const realWrote: unknown[] = [];
    const mutantWrote: unknown[] = [];
    expect((await runOn(real, spent, realWrote)).rows[0].refusal).toBe("OVER_CAP");
    expect(
      (await runOn(mutant, spent, mutantWrote)).rows[0].refusal,
      "the ordinal refuses it too, so the verdict cannot tell the two apart",
    ).toBe("OVER_CAP");
    // What CAN tell them apart: the real gate refuses before touching the
    // file, and the mutant reserves a slot it has to give straight back.
    expect(realWrote, "the real cap binds before any write").toHaveLength(0);
    expect(mutantWrote.length, "the mutant writes, then releases").toBeGreaterThan(0);
  });

  test("FG-156: M4 — one predicate decides both the waiver and the sentence", async () => {
    // `waivableRefusal` is read twice — by `filingGate` to decide whether the
    // label overrides, and by `refusalMessage` to decide whether to offer it.
    // Forcing it to `true` must move BOTH, or they are not one binding and
    // the pair can drift again exactly as it did: for one review round the
    // gate refused OVER_CAP unwaivably while the message closed by telling
    // the agent to re-run with the label.
    const mutant: Gate = await import(buildMutant("cap-waivable", M4, "return true;"));
    const real: Gate = await import("../lib/issue-filing-gate");
    const dir = join(scratch, "mut-waivable-run");
    mkdirSync(dir, { recursive: true });

    const at = "2026-10-24T12:00:00.000Z";
    const filing =
      'gh issue create --title "zqxjWaiverProbe loses a sweep it started" ' +
      `--body "\`zqxjWaiverProbe\` in lib/zqxj-waiver.ts drops 11 of 43 commands over 5207 runs. Claim 4. ${DECLARED}"`;
    const runOn = (gate: Gate, prior: unknown[], cmd: string = filing) =>
      gate.filingGate(cmd, {
        projectRoot: dir,
        now: at,
        readExisting: async () => gate.measuredCorpus([]),
        readLedger: () => prior as never,
        readTarget: async () => ({ reading: "NO_PR", branch: "b" }) as never,
      });

    // BASELINE FIRST, on both: an empty ledger allows, so neither gate is
    // refusing or allowing everything when the mutation rows are read.
    expect((await runOn(mutant, [])).rows[0].refusal, "the mutant loaded").toBeNull();
    expect((await runOn(real, [])).rows[0].refusal, "as did the real gate").toBeNull();

    const spent = [
      {
        at,
        key: `b.1/${at}/0${INTENT_KEY_SUFFIX}`,
        id: "new",
        title: "already filed by this run",
        symptomHash: "h",
        category: "correctness" as const,
        severity: null,
        disposition: "ISSUE" as const,
        refusal: null,
        emitted: false,
        withheldBy: INTENT_PENDING,
        jury: null,
        duplicateOf: [],
        overridden: false,
        refiledAfter: null,
        exemption: "out-of-pr-diff" as const,
        intent: true,
        run: real.runIdFor(dir).run!,
      },
    ];
    const labelled = `${filing} --label ${FILING_OVERRIDE_LABEL}`;

    // Half one, the waiver. The real gate ignores the label; the mutant
    // honours it and the filing reaches the tracker.
    const realLabelled = await runOn(real, spent, labelled);
    expect(realLabelled.rows[0].overridden).toBe(false);
    expect(realLabelled.rows[0].emitted).toBe(false);
    const mutantLabelled = await runOn(mutant, spent, labelled);
    expect(mutantLabelled.rows[0].overridden, "the label now waives the cap").toBe(true);
    // **Not `refusal === null` any more.** It was, and the race fix changed
    // it: the reservation stage reads the queue after appending and refuses
    // regardless, so the command is still blocked. The LEDGER is what M4
    // still moves — a row recording that a label waived a cap no label can
    // waive, which is the measurement #1261 asks this change to expose.
    // Restated rather than deleted: an assertion that stops discriminating
    // is a row that certifies nothing.
    expect(
      mutantLabelled.rows[0].refusal,
      "the ordinal refuses it either way, so the verdict is not the discriminator",
    ).toBe("OVER_CAP");

    // Half two, the sentence. Same mutation, the OTHER reader: with no label
    // at all the refusal stops saying the label is no use here and switches
    // to the stanza for a refusal a label CAN open. A test asserting only
    // the waiver would leave this half of the predicate unmeasured.
    //
    // **The discriminator is the stanza, not the old recipe.** This read
    // `toContain("re-run with --label arbiter-override")` until the waivable
    // stanza stopped spelling the token (2026-10-25) — so the string it
    // looked for now exists nowhere and the row would have gone red for the
    // wrong reason, which is indistinguishable from the predicate having
    // drifted. Both directions are asserted, because the two stanzas are
    // distinguished by which one is ABSENT as much as by which is present.
    const realText = (await runOn(real, spent)).refusal ?? "";
    const mutantText = (await runOn(mutant, spent)).refusal ?? "";
    expect(realText).toContain("does NOT waive this one");
    expect(
      mutantText,
      "the message follows the predicate rather than deciding again",
    ).toContain("A label waives this refusal");
    expect(
      mutantText,
      "and it stops denying the label, which is the half a one-sided check would miss",
    ).not.toContain("does NOT waive this one");
    // Neither stanza hands the token over on a refusal the label would open.
    expect(mutantText, "the mutant must not reintroduce the recipe either").not.toContain(
      FILING_OVERRIDE_LABEL,
    );
  });

  test("FG-158: M5 — the cap sees what the LABEL would carry through, not what is clean", async () => {
    // The round-4 bypass, as a mutation. `wouldEmit` is what makes the cap
    // read the clause's fate after any override; dropping the override term
    // restores the shape the review found, where a waivable refusal plus the
    // label walks straight past the allowance.
    const mutant: Gate = await import(buildMutant("cap-blind-to-override", M5, "|| false"));
    const real: Gate = await import("../lib/issue-filing-gate");
    const dir = join(scratch, "mut-bypass-run");
    mkdirSync(dir, { recursive: true });

    const at = "2026-10-24T12:00:00.000Z";
    // **The vehicle changed on 2026-10-25 and the case says why.** This drove
    // the bypass through an UNDECLARED filing, because `COMMENT_INSTEAD` was
    // waivable and making the filing worse was the cheapest route. It is
    // unwaivable now, so that route is closed at its source — and a mutant
    // driven down a closed route goes green by construction, witnessing
    // nothing about M5.
    //
    // So the vehicle is `NO_CLAIM`: declared, so it clears the comment
    // default, and naming no SUCCESS.md claim, so it is refused for a reason
    // the label still waives. The shape M5 models is unchanged — a waivable
    // refusal plus the label walking past the allowance — and this is simply
    // the cheapest spelling of it that still exists.
    const body =
      "`zqxjBypass` in lib/zqxj-bypass.ts drops 13 of 61 commands over 4703 runs.";
    const noClaim =
      `gh issue create --title "zqxjBypass abandons a sweep it started" ` +
      `--body "${body} ${DECLARED}" --label ${FILING_OVERRIDE_LABEL}`;
    const declared =
      `gh issue create --title "zqxjBypass abandons a sweep it started" ` +
      `--body "${body} Claim 4. ${DECLARED}"`;

    const runOn = (gate: Gate, prior: unknown[], cmd: string) =>
      gate.filingGate(cmd, {
        projectRoot: dir,
        now: at,
        readExisting: async () => gate.measuredCorpus([]),
        readLedger: () => prior as never,
        readTarget: async () => ({ reading: "NO_PR", branch: "b" }) as never,
      });

    // BASELINE FIRST, both gates, empty ledger: a declared filing is allowed,
    // so neither is refusing everything when the rows below are read.
    expect((await runOn(mutant, [], declared)).rows[0].refusal, "the mutant loaded").toBeNull();
    expect((await runOn(real, [], declared)).rows[0].refusal, "as did the real gate").toBeNull();

    const spent = [
      {
        at,
        key: `b.1/${at}/0${INTENT_KEY_SUFFIX}`,
        id: "new",
        title: "already filed by this run",
        symptomHash: "h",
        category: "correctness" as const,
        severity: null,
        disposition: "ISSUE" as const,
        refusal: null,
        emitted: false,
        withheldBy: INTENT_PENDING,
        jury: null,
        duplicateOf: [],
        overridden: false,
        refiledAfter: null,
        exemption: "out-of-pr-diff" as const,
        intent: true,
        run: real.runIdFor(dir).run!,
      },
    ];

    const realRow = (await runOn(real, spent, noClaim)).rows[0];
    expect(realRow.refusal).toBe("OVER_CAP");
    expect(realRow.emitted, "nothing reached the tracker").toBe(false);

    // **The bypass this modelled is now closed twice, so the row no longer
    // reaches the tracker under M5 either.** The pre-read cap never looks at
    // a clause it thinks is refused — that is the mutation, and it still
    // happens — but the clause is then `emitted` and the reservation stage
    // reads every emitted row, so the ordinal refuses it. What M5 still
    // moves is WHICH refusal the ledger records and whether the run paid a
    // write for it.
    const mutantRow = (await runOn(mutant, spent, noClaim)).rows[0];
    expect(
      mutantRow.refusal,
      "the ordinal catches what the pre-read was mutated into skipping",
    ).toBe("OVER_CAP");
    expect(mutantRow.emitted, "so the bypass does not reopen").toBe(false);
    expect(
      mutantRow.overridden,
      "and no label waived it, because the stage that refused reads the same predicate",
    ).toBe(false);
  });

  test("FG-177: M7 moves the MESSAGE and M8 moves the GATE — which is which", async () => {
    // `FG-176` asserts that an undeclared filing carrying the label is
    // refused. On its own that is not evidence of WHICH binding did it: the
    // clause is refused `COMMENT_INSTEAD` before any label is considered,
    // so a gate that still honoured the label would produce the same
    // `refusal` value on the row and differ only in `overridden` and
    // `emitted`.
    //
    // **This case changed shape with the sibling-refusal fix, and the honest
    // statement is that M7 no longer moves the gate.** It did, and the row
    // below used to assert it. Then `overrideOf` gained `v.exemption !==
    // null`, and a filing refused `COMMENT_INSTEAD` is BY DEFINITION one
    // whose `exemption` is null — so the declaration read refuses it first
    // and the map membership is redundant for this filing's outcome.
    //
    // Redundant, not dead, and the distinction is the point. The two
    // bindings answer different questions: `UNWAIVABLE_REFUSALS` decides
    // what the refusal SAYS, `overrideOf` decides what the gate DOES. Had
    // this case been left asserting that M7 flips the gate, it would have
    // gone red here and the cheap repair — deleting the declaration read as
    // "already covered" — reopens every sibling route. So each mutant is
    // run against the binding it actually controls, and both are asserted
    // to move something.
    const mutant: Gate = await import(
      buildMutant("comment-default-waivable", M7, "  ZZ_NOT_A_REFUSAL:\n")
    );
    const undeclarable: Gate = await import(buildMutant("declaration-unread", M8, "      true &&"));
    const real: Gate = await import("../lib/issue-filing-gate");
    const dir = join(scratch, "mut-comment-waivable-run");
    mkdirSync(dir, { recursive: true });

    const at = "2026-10-25T12:00:00.000Z";
    const labelled = `${UNDECLARED} --label ${FILING_OVERRIDE_LABEL}`;
    const runOn = (gate: Gate, cmd: string) =>
      gate.filingGate(cmd, {
        projectRoot: dir,
        now: at,
        readExisting: async () => gate.measuredCorpus([]),
        readLedger: () => [],
        appendLedger: () => true,
        readTarget: async () => ({ reading: "NO_PR", branch: "b" }) as never,
      });

    // BASELINE FIRST, all three gates: a DECLARED filing is allowed, so none
    // is refusing everything when the rows below are read, and each mutant
    // is known to have loaded. Without this a mutant that died on module
    // resolution reads as one that rejected the bypass on the merits.
    expect((await runOn(mutant, DECLARED_FILING)).rows[0].refusal, "M7 loaded").toBeNull();
    expect((await runOn(undeclarable, DECLARED_FILING)).rows[0].refusal, "M8 loaded").toBeNull();
    expect((await runOn(real, DECLARED_FILING)).rows[0].refusal, "as did the real gate").toBeNull();

    const realRow = (await runOn(real, labelled)).rows[0];
    expect(realRow.refusal).toBe("COMMENT_INSTEAD");
    expect(realRow.overridden, "no label waives the comment default").toBe(false);
    expect(realRow.emitted, "and nothing reaches the tracker").toBe(false);

    // **M7 moves the MESSAGE.** With `COMMENT_INSTEAD` out of the map the
    // refusal stops denying the label and starts describing it as available,
    // which is the text an agent acts on. Asserted on the string because
    // that is the only channel the membership still controls.
    const deny = `--label ${FILING_OVERRIDE_LABEL} does NOT waive this one`;
    const v: FilingAdjudication = {
      outcome: "REFUSE",
      refusal: "COMMENT_INSTEAD",
      reason: "r",
      category: "correctness",
      duplicateOf: [],
      collidingKeys: [],
      symptomHash: "h",
      exemption: null,
    };
    expect(real.refusalMessage(v), "the real refusal denies the label").toContain(deny);
    expect(
      mutant.refusalMessage(v),
      "with the key removed the refusal stops denying the label",
    ).not.toContain(deny);

    // **M7 no longer moves the GATE, and that is asserted rather than left
    // for a reader to assume.** A silent "both false" here is the shape of a
    // mutant that never loaded; the baseline above rules that out, so this
    // row is the redundancy itself, measured.
    const mutantRow = (await runOn(mutant, labelled)).rows[0];
    expect(mutantRow.refusal, "the refusal value is the same on both").toBe("COMMENT_INSTEAD");
    expect(
      mutantRow.overridden,
      "the declaration read refuses it first, so the membership is redundant HERE",
    ).toBe(false);
    expect(mutantRow.emitted, "and nothing reaches the tracker under M7 either").toBe(false);

    // **M8 needs a DIFFERENT INPUT, and finding that out is the point of
    // running it.** On `labelled` M8 moves nothing, because that clause is
    // refused `COMMENT_INSTEAD` and the map membership blocks it whether or
    // not the declaration is read. Measured, not assumed:
    const m8OnComment = (await runOn(undeclarable, labelled)).rows[0];
    expect(
      m8OnComment.overridden,
      "on a COMMENT_INSTEAD clause the two bindings are genuinely redundant",
    ).toBe(false);

    // The input they must disagree on is the SIBLING refusal — undeclared
    // AND claimless, which is refused `NO_CLAIM`, which IS waivable. There
    // the map membership is never consulted and the declaration read is the
    // only thing standing between the label and the tracker. That is the
    // defect `FG-178` reproduces, and this is the mutant proving which line
    // closed it.
    const unclaimed = UNDECLARED.replace(" Claim 4.", "");
    expect(namedClaim(unclaimed), "the claim really came out").toBeNull();
    expect(unclaimed.length, "the strip matched").toBeLessThan(UNDECLARED.length);
    const siblingLabelled = `${unclaimed} --label ${FILING_OVERRIDE_LABEL}`;

    const realSibling = (await runOn(real, siblingLabelled)).rows[0];
    expect(realSibling.refusal, "the precedence issues the sibling, not the comment default").toBe(
      "NO_CLAIM",
    );
    expect(realSibling.overridden, "and the declaration read refuses the waiver").toBe(false);
    expect(realSibling.emitted, "so nothing reaches the tracker").toBe(false);

    const m8Row = (await runOn(undeclarable, siblingLabelled)).rows[0];
    expect(m8Row.refusal, "same refusal, so `refusal` is not the discriminator").toBe("NO_CLAIM");
    expect(m8Row.overridden, "with the declaration unread the label waives it again").toBe(true);
    expect(m8Row.emitted, "and the undeclared filing reaches the tracker").toBe(true);
  });

  test("FG-169: M6 — the ORDINAL is what stops the second racer, not the pre-read", async () => {
    // `FG-166` asserts the second of two interleaved racers is refused. On
    // its own that is not evidence the ORDINAL did it: a cap that still
    // decided from the pre-read would refuse the second too, as soon as the
    // two stopped being simultaneous. M6 removes the position check and
    // nothing else, so the real gate and this one differ in exactly the
    // reading under test.
    const real: Gate = await import("../lib/issue-filing-gate");
    const mutant: Gate = await import(buildMutant("unordered", M6, "false"));
    const dir = join(scratch, "mut-race-run");
    mkdirSync(dir, { recursive: true });
    const at = "2026-10-24T12:00:00.000Z";
    const other = new Date(Date.parse(at) + 1).toISOString();

    const two = 'gh issue create --title "zqxjRaceTwo rebuilds an index it just built" ' +
      `--body "\`zqxjRaceTwo\` in lib/zqxj-race-two.ts rescans 418 refs on 9120 reads. Claim 4. ${DECLARED}"`;
    const one = 'gh issue create --title "zqxjRaceOne loses a sweep it started" ' +
      `--body "\`zqxjRaceOne\` in lib/zqxj-race-one.ts drops 19 of 37 commands over 8803 runs. Claim 4. ${DECLARED}"`;

    /** Both racers read an EMPTY ledger first, then the live one. */
    const raceOn = (gate: Gate, sink: unknown[]) => (cmd: string, now: string) => {
      let reads = 0;
      return gate.filingGate(cmd, {
        projectRoot: dir,
        now,
        readExisting: async () => gate.measuredCorpus([]),
        readLedger: (() => (reads++ === 0 ? [] : [...sink])) as never,
        appendLedger: ((row: unknown) => {
          sink.push(row);
          return true;
        }) as never,
        readTarget: async () => ({ reading: "NO_PR", branch: "b" }) as never,
      });
    };

    const realSink: unknown[] = [];
    const realRace = raceOn(real, realSink);
    expect((await realRace(one, at)).rows[0].emitted, "the real gate's first racer files").toBe(true);
    const realSecond = (await realRace(two, other)).rows[0];
    expect(realSecond.refusal, "and its second is refused on its position").toBe("OVER_CAP");

    const mutantSink: unknown[] = [];
    const mutantRace = raceOn(mutant, mutantSink);
    // BASELINE: the mutant loaded and still allows a first filing, so the row
    // below is not a module that failed to import.
    expect((await mutantRace(one, at)).rows[0].emitted, "the mutant loaded").toBe(true);
    const mutantSecond = (await mutantRace(two, other)).rows[0];
    expect(mutantSecond.refusal, "with no position check, nothing refuses it").toBeNull();
    expect(mutantSecond.emitted, "so both racers file — the race, reopened").toBe(true);
    // Both reserved either way: the mutation is in what the position MEANS,
    // not in whether one was taken. Without this the row above could be an
    // append that silently stopped happening.
    expect(mutantSink, "both took a position and neither gave one back").toHaveLength(2);
    // Three on the real gate: two reservations and the loser's release. The
    // mutant has nothing to release because it never loses, which is the
    // same mutation observed on the other channel.
    expect(realSink, "and the real gate's loser released its slot").toHaveLength(3);
  });

  test("FG-140: a directory that is not a git repository is UNMEASURED, naming it", async () => {
    const notARepo = join(scratch, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    const t = await openPrForBranch(notARepo);
    expect(t.reading, "nobody looked — that is not the same as no PR existing").toBe("UNMEASURED");
    expect(t.reading === "UNMEASURED" ? t.why : "").toContain(notARepo);
  });

  test("FG-141: a DETACHED checkout is UNMEASURED, not a branch with no PR", async () => {
    // The two states one observable would collapse: `head=owner:HEAD` returns
    // an empty list, which is byte-identical to a branch nobody has opened a
    // PR for. Only one of them is a reading.
    const repo = join(scratch, "detached");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      // late-env-ok: the child is `git`, which reads neither of the variables
      // this file writes late — RUNGATE_OPEN_FINDINGS and the ledger session
      // id are both read by the gate under test, in this process, and never
      // by a git subprocess. The detach below is asserted rather than
      // assumed, so a child that somehow lost its environment fails the row.
      spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    const detach = git("checkout", "-q", "--detach");
    expect(detach.status, "the fixture must really detach, or this row proves nothing").toBe(0);

    const t = await openPrForBranch(repo);
    expect(t.reading).toBe("UNMEASURED");
    expect(t.reading === "UNMEASURED" ? t.why : "").toContain("detached");
  });
});

/**
 * FG-143..FG-154: the cap, which is the gate (#1595, scope item 4).
 *
 * ## Why the declaration above it is not the bar
 *
 * It was written as one and it is not. Applied on 2026-10-24 to the three
 * issues filed that day by the author of the bar — #1591, #1592, #1595 —
 * **all three cleared it**, each on an individually sound argument, through
 * the clause *it makes a green check lie*, which in a repository whose
 * subject is checks that lie admits any true finding. Three for three is
 * not a result a bar produces, and the research predicted it: *"a bar an
 * agent applies by asking 'does this block a goal criterion?' re-decides
 * 100 times a day and will drift."*
 *
 * A count has no clause to argue into. That is the whole of why it is here.
 *
 * ## The number, and the two readings it came from
 *
 * `FILINGS_PER_RUN = 1`, from two independent directions that converge:
 *
 * - Cloudflare, 131,246 reviews: **1.2 findings per review**, deliberately
 *   low. The only published per-unit figure, and `runIdFor` makes our unit
 *   the same unit. Floored, because that number counts an inline comment
 *   and this counts a tracker issue.
 * - This machine on 2026-10-24: **64 issues created in 24h across 284
 *   registered worktrees — 0.23 filings per run per day.** A cap of 1 sits
 *   4.4x above the mean, so it cannot bind the ordinary run and binds only
 *   where a run files a SECOND.
 *
 * ## The four properties, and the one that decides whether this is a gate
 *
 * 1. over the cap is refused **even with a perfect declaration** (FG-143).
 *    If a good reason could defeat it, the cap would be the per-finding
 *    judgement it replaces;
 * 2. under the cap is allowed, so it is a bar and not a ban (FG-144);
 * 3. a mutant that makes the cap never bind turns a case red (FG-153);
 * 4. no label waives it (FG-146) — `arbiter-override` answers claims ABOUT
 *    a finding, and the cap makes none.
 *
 * ## What changed elsewhere, measured
 *
 * Landing this reddened **4** cases in this file, every one of them
 * asserting that two clean filings in ONE command are both allowed —
 * FG-48, FG-50, FG-91 and FG-134. That property is exactly what a cap of 1
 * gives up, so all four were reshaped rather than relaxed, and FG-142 keeps
 * the half FG-91 surrendered. Nothing else in the file moved.
 */
describe("FG-143..FG-176: a numeric cap, which no argument defeats", () => {
  const onPr: CommentTarget = { reading: "PR", number: 1595, branch: "rg/1595-filing-default" };
  const AT = "2026-10-24T12:00:00.000Z";

  /** Two filings that are novel, claim-naming and perfectly declared. */
  const first =
    'gh issue create --title "zqxjCapOne loses a sweep it started" ' +
    `--body "\`zqxjCapOne\` in lib/zqxj-cap-one.ts drops 17 of 29 commands over 6301 runs. Claim 4. ${DECLARED}"`;
  const second =
    'gh issue create --title "zqxjCapTwo miscounts its own retries" ' +
    `--body "\`zqxjCapTwo\` in lib/zqxj-cap-two.ts reports 51 of 83 retries across 4409 sweeps. Claim 4. ${DECLARED}"`;

  /**
   * The same filing with its declaration removed — refused, and NOT waivable.
   *
   * It said "waivable" until 2026-10-25, which was true when written and is
   * now the opposite of what the code does: stripping the declaration gives
   * `COMMENT_INSTEAD`, which is in `UNWAIVABLE_REFUSALS`, and the label is
   * separately refused by `overrideOf`'s declaration read.
   */
  const undeclaredSecond = second.replace(` ${DECLARED}`, "");

  /**
   * The row a filing leaves that the cap counts — its INTENT.
   *
   * A real landed filing leaves two rows: the intent that reserved the
   * allowance, and the outcome the hook writes afterwards. The outcome is
   * deliberately NOT what the cap counts (`FilingLedgerRow.intent` says why
   * counting `emitted` cannot see a filing that is in flight), so a fixture
   * that built one would be a spent allowance the gate does not see — and
   * every cap case here would pass for the wrong reason. `FG-149` holds the
   * counter's population directly.
   */
  const landed = (run: string, at: string = AT): FilingLedgerRow => ({
    at,
    key: `b.1/${at}/0${INTENT_KEY_SUFFIX}`,
    id: "new",
    title: "something this run already filed",
    symptomHash: "h",
    category: "correctness",
    severity: null,
    disposition: "ISSUE",
    refusal: null,
    emitted: false,
    withheldBy: INTENT_PENDING,
    jury: null,
    duplicateOf: [],
    overridden: false,
    refiledAfter: null,
    exemption: "out-of-pr-diff",
    intent: true,
    run,
  });

  /** The OUTCOME row the hook writes after a filing is allowed. */
  const outcome = (run: string, at: string = AT): FilingLedgerRow => ({
    ...landed(run, at),
    key: `b.1/${at}/0`,
    emitted: true,
    withheldBy: null,
    intent: false,
  });

  const gateIn = (cmd: string, projectRoot: string, prior: FilingLedgerRow[]) =>
    filingGate(cmd, {
      projectRoot,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => prior,
      readTarget: async () => onPr,
    });

  /**
   * Two CHECKOUTS, so "a different run" is an input and not an argument.
   *
   * Real `git init`s rather than bare directories: since `runIdFor` buckets
   * every non-checkout into one `NON_CHECKOUT` allowance, two bare temp dirs
   * would be the SAME run and FG-145 would be asserting the opposite of what
   * it says. A checkout is also what a run is in production.
   */
  let runA: string;
  let runB: string;
  beforeAll(() => {
    runA = join(scratch, "cap-run-a");
    runB = join(scratch, "cap-run-b");
    for (const dir of [runA, runB]) {
      mkdirSync(dir, { recursive: true });
      checkoutAt(dir);
    }
    expect(runOf(runA), "two checkouts, two runs").not.toBe(runOf(runB));
  });

  test("FG-143: over the cap is REFUSED even with a perfect declaration", async () => {
    // **The row that decides whether this is a gate.** The filing is novel,
    // names a claim, declares a reason from the closed list and collides
    // with nothing. Every judgement in this file clears it. The count does
    // not, and no sentence it could carry would change that.
    const r = await gateIn(second, runA, [landed(runOf(runA))]);
    expect(r.rows[0].refusal).toBe("OVER_CAP");
    expect(r.rows[0].exemption, "the declaration was READ, and did not help").toBe("out-of-pr-diff");
    expect(r.refusal ?? "", "and the refusal says so in as many words").toContain(
      "no argument against this",
    );
  });

  test("FG-144 CONTROL: under the cap, the same filing is ALLOWED", async () => {
    // A gate that refuses everything is not a bar. The only axis that moves
    // between this row and FG-143 is whether the run has already filed.
    const r = await gateIn(second, runA, []);
    expect(r.rows[0].refusal).toBeNull();
    expect(r.refusal).toBeNull();
  });

  test("FG-145 CONTROL: a DIFFERENT run has its own allowance", async () => {
    // Pins FG-143 to the RUN rather than to the ledger having any row in
    // it at all. Same ledger, same filing, different directory.
    const spent = [landed(runOf(runA))];
    expect((await gateIn(second, runA, spent)).rows[0].refusal).toBe("OVER_CAP");
    expect((await gateIn(second, runB, spent)).rows[0].refusal, "runB has filed nothing").toBeNull();
  });

  test("FG-146: `arbiter-override` does NOT waive the cap", async () => {
    // The label waives a claim ABOUT a finding — duplicate, no claim, should
    // have been a comment — and the cap makes no claim about the finding, so
    // there is nothing for a waiver to answer. A label that waived it would
    // hand back exactly the per-finding judgement the cap exists to replace.
    const r = await gateIn(
      `${second} --label ${FILING_OVERRIDE_LABEL}`,
      runA,
      [landed(runOf(runA))],
    );
    expect(r.rows[0].overridden, "the label is read and it waives nothing here").toBe(false);
    expect(r.rows[0].emitted).toBe(false);
    expect(r.refusal, "the command is still blocked").not.toBeNull();
  });

  test("FG-155: the cap's refusal does not advertise the label it ignores", async () => {
    // Found by the AI review of PR #1597, and the contradiction sat inside
    // ONE message: `overCapReason` says "no label waives it" and the closing
    // stanza said "re-run with --label arbiter-override", four lines below
    // it. FG-146 did not move, because the cap held either way — what a
    // refusal SAYS and what it DOES were separate readings, and the thing
    // the agent acts on is the sentence at the bottom.
    const over = (await gateIn(second, runA, [landed(runOf(runA))])).refusal ?? "";
    expect(over).toContain(`--label ${FILING_OVERRIDE_LABEL} does NOT waive this one`);
    expect(over, "and nothing in it tells the agent to re-run with the label").not.toContain(
      `re-run with --label ${FILING_OVERRIDE_LABEL}`,
    );
    // The sentence comes from `UNWAIVABLE_REFUSALS`, so the reason an agent
    // reads is this refusal's own. The shared one said "an accounting of
    // what this run has already filed" over every member, which is true of
    // the cap and false of a missing declaration.
    expect(over, "the cap's refusal gives the cap's reason").toContain("accounting of what this run");

    // CONTROL, one axis — a refusal the label DOES waive. **Its half changed
    // on 2026-10-25**: the waivable stanza no longer spells the token
    // either. The property is no longer "offered here, not there"; it is
    // that the token appears ONLY to be denied, and that the existence of a
    // waiver is still stated so an agent with a real exception is not left
    // guessing. A message that said nothing to anybody would pass the lines
    // above and delete the accounting from every other refusal in the file.
    const waivable = await gateIn(DROPPED_FILING, runA, []);
    expect(waivable.rows[0].refusal, "under the cap, and refused for a waivable reason").toBe(
      "DROPPED_CATEGORY",
    );
    const text = waivable.refusal ?? "";
    expect(text, "a waivable refusal must still say a waiver exists").toContain(
      "A label waives this refusal",
    );
    expect(text, "and must not hand the token over").not.toContain(FILING_OVERRIDE_LABEL);
    expect(text, "naming the cost, which is what makes the statement useful").toContain(
      "counted later",
    );
  });

  test("FG-157: the label does not carry an over-cap filing past the cap", async () => {
    // Found by the AI review of PR #1597 at round 4: with the cap reading
    // only clauses that were already clean, the label waived some other
    // refusal and the filing landed with the run over its allowance.
    //
    // **The cheapest route to it was the undeclared filing, and that one is
    // closed at its source now** — `COMMENT_INSTEAD` became unwaivable on
    // 2026-10-25, so "delete one line, add one flag" no longer reaches the
    // cap at all. The ordering under test is NOT about that one spelling,
    // so the vehicle here is `DUPLICATE`: still waivable, still carried to
    // the tracker by the label, and therefore still something the cap has
    // to see. A case rewritten onto the closed route would be green by
    // construction. `DROPPED_CATEGORY` rather than `DUPLICATE` only because
    // `gateIn` reads an empty corpus, so nothing here can collide with an
    // open issue — the vehicle has to be a refusal reachable without one.
    const cmd = `${DROPPED_FILING} --label ${FILING_OVERRIDE_LABEL}`;
    const over = (await gateIn(cmd, runA, [landed(runOf(runA))])).rows[0];
    expect(over.refusal).toBe("OVER_CAP");
    expect(over.overridden, "the label waives nothing once the cap has converted").toBe(false);
    expect(over.emitted).toBe(false);

    // CONTROL, and ONE axis moves — the run has filed nothing. Same command,
    // same waivable refusal, same label. The override must still work where
    // the cap is not what is being argued with, or this row would pass under
    // a gate that had simply stopped honouring the label at all.
    const under = (await gateIn(cmd, runA, [])).rows[0];
    expect(under.refusal).toBe("DROPPED_CATEGORY");
    expect(under.overridden).toBe(true);
    expect(under.emitted).toBe(true);

    // And the closed route, asserted rather than left to the comment above:
    // undeclared plus the label is refused UNDER the cap as well as over it,
    // so it never becomes a cap question in the first place.
    const undeclaredUnder = (
      await gateIn(`${undeclaredSecond} --label ${FILING_OVERRIDE_LABEL}`, runA, [])
    ).rows[0];
    expect(undeclaredUnder.refusal).toBe("COMMENT_INSTEAD");
    expect(undeclaredUnder.emitted, "the route that beat the gate by filing worse").toBe(false);
  });

  test("FG-159: the cap survives EVERY other refusal, not just the ones I thought of", async () => {
    // **The invariant, as a population rather than an instance.** FG-157
    // proved it for `COMMENT_INSTEAD` and that is one member of a set: the
    // security review named `DUPLICATE`, `NO_CLAIM`, `COMMENT_INSTEAD`,
    // `DROPPED_CATEGORY` and `SAME_CLASS_IN_RUN`, and a fix verified against
    // one of five is a conjunction with four untested arms. Each row is the
    // same shape — allowance spent, the clause independently refused for a
    // WAIVABLE reason, `--label arbiter-override` attached — and each must
    // be refused and must not reach the tracker.
    const L = `--label ${FILING_OVERRIDE_LABEL}`;
    const dup =
      'gh issue create --title "retryBudget misbehaves on a long sweep" ' +
      '--body "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts completes 144 of 234. ' +
      `${DECLARED}"`;
    const noClaim =
      'gh issue create --title "zqxjNoClaim loses a sweep it started" ' +
      `--body "\`zqxjNoClaim\` in lib/zqxj-no-claim.ts drops 17 of 29 commands over 6301 runs. ${DECLARED}"`;

    const corpus = async () =>
      measuredCorpus(OPEN_ISSUES.map(i => ({ id: String(i.number), title: i.title, body: i.body })));
    const run = async (cmd: string, prior: FilingLedgerRow[], readExisting = corpus) =>
      filingGate(cmd, {
        projectRoot: runA,
        now: AT,
        readExisting,
        readLedger: () => prior,
        readTarget: async () => onPr,
      });

    // **`COMMENT_INSTEAD` left the waivable set on 2026-10-25, so its row
    // carries its own expected refusal rather than the shared one.** The
    // invariant the case is about — refused, and nothing reaches the
    // tracker — is unchanged for all four. What changed is WHICH refusal
    // the ledger records for the fourth: the cap converts only clauses that
    // `wouldEmit`, and an unwaivable refusal never would, so that clause is
    // stopped a stage EARLIER and never becomes a cap question. Written as
    // a per-row expectation rather than relaxed to "any refusal", which
    // would stop distinguishing the stages at all.
    const members = [
      ["DUPLICATE", `${dup} ${L}`, "OVER_CAP", true],
      ["NO_CLAIM", `${noClaim} ${L}`, "OVER_CAP", true],
      ["COMMENT_INSTEAD", `${undeclaredSecond} ${L}`, "COMMENT_INSTEAD", false],
      ["DROPPED_CATEGORY", `${DROPPED_FILING} ${L}`, "OVER_CAP", true],
    ] as const;

    const spent = [landed(runOf(runA))];
    for (const [why, cmd, overCap] of members) {
      const row = (await run(cmd, spent)).rows[0];
      expect(row.refusal, `${why} + the label, over the cap, must still be refused`).toBe(overCap);
      expect(row.overridden, `${why}: the label waives nothing here`).toBe(false);
      expect(row.emitted, `${why}: nothing reaches the tracker`).toBe(false);
    }

    // CONTROL for the four rows above, and one axis moves: with the
    // allowance UNSPENT each of those commands is refused for its OWN
    // reason. Without this the rows above would pass against a gate that
    // had stopped honouring the label entirely — and the fourth row is what
    // keeps the first three from reading as "the label does nothing".
    for (const [why, cmd, , waivable] of members) {
      const row = (await run(cmd, [])).rows[0];
      expect(row.refusal, `${why}: under the cap it is still the clause's own refusal`).toBe(why);
      expect(
        row.overridden,
        waivable
          ? `${why}: and the label waives it there`
          : `${why}: no label waives this one, under the cap or over it`,
      ).toBe(waivable);
    }

    // The fifth member needs the allowance spent BY THIS COMMAND, because a
    // sibling only exists once a clause has cleared and a clause can only
    // clear under the cap. Clause 1 lands; clause 2 shares its class and
    // carries the label, and is refused OVER_CAP rather than waived.
    const twoClauses = `${second} ${L} && ${second.replace("miscounts its own retries", "miscounts its retries")} ${L}`;
    const pair = await run(twoClauses, []);
    // Clause 1 CLEARS and spends the allowance. It is not `emitted`, and the
    // reason is #1344 rather than the cap: a hook's one lever is the whole
    // Bash command, so a refusal anywhere marks every row `COMMAND_BLOCKED`.
    // I predicted `emitted: true` here and was wrong about which field says
    // "this clause was clean" on a blocked command.
    expect(pair.rows[0].refusal, "clause 1 cleared on its own merits").toBeNull();
    expect(pair.rows[0].withheldBy, "and lost the tracker only to its neighbour").toBe(
      COMMAND_BLOCKED,
    );
    expect(pair.rows[1].refusal, "clause 2 shares the class AND is over the cap").toBe("OVER_CAP");
    expect(pair.rows[1].emitted).toBe(false);
  });

  test("FG-160: every non-checkout directory is ONE run, so a fresh dir mints nothing", async () => {
    // The allowance was keyable by the filer: `runIdFor` resolved the path,
    // so `mkdir /tmp/x && cd /tmp/x && gh issue create` bought a new one at
    // no cost. Named by the security review of PR #1597; a gate whose unit
    // the filer chooses is not a gate.
    const one = join(scratch, "non-checkout-one");
    const two = join(scratch, "non-checkout-two");
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    expect(runOf(one), "two bare directories are one run").toBe(NON_CHECKOUT_RUN);
    expect(runOf(two)).toBe(NON_CHECKOUT_RUN);

    const spentElsewhere = [landed(NON_CHECKOUT_RUN)];
    const r = await filingGate(second, {
      projectRoot: two,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => spentElsewhere,
      readTarget: async () => onPr,
    });
    expect(r.rows[0].refusal, "a filing from a different bare dir is the same run").toBe("OVER_CAP");

    // CONTROL: a real CHECKOUT is still its own run, so this is a bucket for
    // the unidentifiable rather than a cap collapsed onto one allowance.
    expect(runOf(runA)).not.toBe(NON_CHECKOUT_RUN);
    const checkout = await filingGate(second, {
      projectRoot: runA,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => spentElsewhere,
      readTarget: async () => onPr,
    });
    expect(checkout.rows[0].refusal, "the bucket is not everybody's allowance").toBeNull();
  });

  test("FG-161: an unreadable ledger REFUSES; an absent one allows", async () => {
    // The one place in this file that fails CLOSED, and the distinction it
    // turns on is `readLedgerRows`'s own: `[]` for absent, `null` for
    // present-and-unreadable. A machine that has filed nothing has spent
    // nothing; a ledger nobody can read has an allowance nobody can count,
    // and allowing there is not a loud note — it is the gate removed by
    // anything able to make one file unreadable.
    const unreadable = await filingGate(`${second} --label ${FILING_OVERRIDE_LABEL}`, {
      projectRoot: runA,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => null,
      readTarget: async () => onPr,
    });
    expect(unreadable.rows[0].refusal).toBe("UNMEASURED_CAP");
    expect(unreadable.rows[0].overridden, "and no label waives this one either").toBe(false);
    expect(unreadable.rows[0].emitted).toBe(false);
    expect(unreadable.refusal ?? "", "the refusal names the file an OPERATOR must fix").toContain(
      "could not be read",
    );

    // CONTROL, one axis: the SAME command against an ABSENT ledger — the
    // empty population, which is a reading — is allowed. Without this the
    // row above is satisfied by a gate that refuses every filing on earth.
    const absent = await filingGate(second, {
      projectRoot: runA,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => [],
      readTarget: async () => onPr,
    });
    expect(absent.rows[0].refusal, "nothing filed is not the same as nothing readable").toBeNull();
    expect(absent.rows[0].emitted).toBe(true);
  });

  test("FG-162: a re-draft cannot record an override against a refusal no label waives", async () => {
    // #1536 lets the label waive a PRIOR refusal when the body has been
    // re-drafted. That arm read only `prior !== null`, so a row refused
    // `OVER_CAP` a day ago and re-filed inside a fresh allowance came back
    // `overridden: true` — the ledger's own account saying the label waived
    // the cap. Nothing reaches the tracker that should not; the clause is
    // ALLOWED on its merits by then. What breaks is the count of overrides
    // against the cap, which is the number this change exists to expose.
    const old = new Date(Date.parse(AT) - RUN_WINDOW_MS - 1000).toISOString();
    const refusedBefore = (refusal: "OVER_CAP" | "DUPLICATE"): FilingLedgerRow => ({
      ...landed(runOf(runA), old),
      title: "zqxjCapTwo miscounts its own retries",
      emitted: false,
      disposition: "DROP",
      refusal,
      withheldBy: refusal,
      // A refused filing reserved nothing: the gate only registers an intent
      // for a clause the command-level decision has already cleared.
      intent: false,
    });
    const withLabel = `${second} --label ${FILING_OVERRIDE_LABEL}`;

    const afterCap = await gateIn(withLabel, runA, [refusedBefore("OVER_CAP")]);
    expect(afterCap.rows[0].refusal, "the allowance is free again, so it files").toBeNull();
    expect(afterCap.rows[0].emitted).toBe(true);
    expect(
      afterCap.rows[0].overridden,
      "but no label waived the cap, so the ledger must not say one did",
    ).toBe(false);

    // CONTROL, one axis — the prior refusal is a WAIVABLE one. The #1536
    // behaviour must survive: a re-draft after a DUPLICATE, carrying the
    // label, is a counted override and is recorded as one.
    const afterDup = await gateIn(withLabel, runA, [refusedBefore("DUPLICATE")]);
    expect(afterDup.rows[0].overridden, "a waivable prior refusal still counts").toBe(true);
    expect(afterDup.rows[0].refiledAfter, "and the row names the refusal it answered").toBe(old);
  });

  test("FG-163: a scratch `git init` does not mint an allowance", async () => {
    // **The bypass my own first fix left open, and my own fixtures then
    // asserted.** `resolve()` → `toplevel()` closed `mkdir /tmp/x` and left
    // `git init /tmp/x` — one more command — producing a distinct toplevel
    // and therefore a fresh allowance. I had demonstrated it in the same
    // commit by adding `git init` to `freshRun()` SO THAT each spawn would
    // be its own run. Found by the security review of PR #1597.
    //
    // Measured here rather than argued: two sibling inits, two toplevels,
    // no origin on either. A checkout nobody can name is not a run.
    const one = join(scratch, "scratch-init-one");
    const two = join(scratch, "scratch-init-two");
    for (const dir of [one, two]) {
      mkdirSync(dir, { recursive: true });
      // late-env-ok: the child is `git`, which reads no variable this file
      // writes — the gate reads them in this process, never a subprocess.
      expect(
        spawnSync("git", ["-C", dir, "init", "-q", "-b", "main"], {
          encoding: "utf-8",
          env: { ...process.env },
        }).status,
      ).toBe(0);
    }
    // `checkoutTop` refuses a non-checkout, so these two lines are the
    // fixture's premise — distinct toplevels — and not a claim about the gate.
    expect(checkoutTop(one), "and the two really are distinct ones").not.toBe(checkoutTop(two));
    expect(runOf(one), "yet both are the bucket, because neither has an origin").toBe(
      NON_CHECKOUT_RUN,
    );
    expect(runOf(two)).toBe(NON_CHECKOUT_RUN);

    const spentThere = [landed(NON_CHECKOUT_RUN)];
    const second2 = await filingGate(second, {
      projectRoot: two,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => spentThere,
      readTarget: async () => onPr,
    });
    expect(second2.rows[0].refusal, "so a second scratch repo buys nothing").toBe("OVER_CAP");

    // NEGATIVE CONTROL, one axis: the SAME directory with an origin added is
    // its own run again. Without this the case above passes under a gate
    // that had bucketed every checkout on the machine, which would be a gag
    // rather than a cap — and it is the half that says what `git init` was
    // missing rather than that git was the problem.
    // late-env-ok: the child is `git`, which reads no variable this file
    // writes — the gate reads them in this process, never in a subprocess.
    expect(
      spawnSync("git", ["-C", two, "remote", "add", "origin", FIXTURE_ORIGIN], {
        encoding: "utf-8",
        env: { ...process.env },
      }).status,
    ).toBe(0);
    expect(runOf(two), "an origin is what makes a checkout nameable").toBe(checkoutTop(two));
    const withOrigin = await filingGate(second, {
      projectRoot: two,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => spentThere,
      readTarget: async () => onPr,
    });
    expect(withOrigin.rows[0].refusal, "and a named checkout has its own allowance").toBeNull();
  });

  test("FG-164: an allowed filing writes one INTENT and one outcome", async () => {
    // The intent row is the whole of the race fix and it is a row nobody
    // asked for, so its shape is asserted here rather than inferred from the
    // cap behaving. `ledgerRows()` filters intents out — see its docblock —
    // and this is the case that stops that filter from hiding them.
    const dir = freshRun();
    const r = runHook(HOOK, NOVEL_FILING, {}, dir);
    expect(r.blocked, "the premise: this filing is allowed").toBe(false);

    const intents = ledgerIntents();
    const decisions = ledgerRows();
    expect(intents, "one reservation").toHaveLength(1);
    expect(decisions, "and one decision").toHaveLength(1);
    expect(decisions[0].emitted, "the decision is the filing").toBe(true);
    expect(intents[0].intent).toBe(true);
    // **`emitted: false` on the reservation.** A filing count read off this
    // ledger is `emitted && !intent`, and an intent claiming `emitted` would
    // double every filing it reserved — #1344's overcount, reintroduced by
    // the fix for the race.
    expect(intents[0].emitted, "a reservation is not a receipt").toBe(false);
    expect(intents[0].withheldBy).toBe(INTENT_PENDING);
    // The two rows are one decision, and the key is the join.
    expect(intents[0].key).toBe(`${decisions[0].key}${INTENT_KEY_SUFFIX}`);
    expect(intents[0].run, "and the reservation names the run it spent").toBe(runOf(dir));

    // CONTROL, one axis — the same hook, a filing that is REFUSED. It
    // reserves nothing, which is what makes FG-147 true of the new counter
    // as well as the old one.
    writeFileSync(ledger, "", "utf-8");
    expect(runHook(HOOK, DUPLICATE_FILING, {}, freshRun()).blocked, "the premise").toBe(true);
    expect(ledgerIntents(), "a refusal reserves nothing").toHaveLength(0);
    expect(ledgerRows(), "and still records its decision").toHaveLength(1);
  });

  test("FG-165: two hook PROCESSES racing one allowance file one issue", async () => {
    // **The defect, in the only configuration it exists in.** One session
    // runs parallel subagents and each Bash call spawns its own hook
    // process; `filingGate` reads the ledger, calls the tracker, and returns,
    // and the hook writes afterwards. Two processes inside that window both
    // counted zero filings and both filed. `spawnSync` cannot reproduce it —
    // the first process has exited before the second starts — so this is the
    // one case in the file that spawns asynchronously.
    const dir = freshRun();
    const [a, b] = await Promise.all([
      runHookAsync(NOVEL_FILING, dir),
      runHookAsync(SECOND_NOVEL_FILING, dir),
    ]);
    const blocked = [a, b].filter(r => r.blocked);
    const allowed = [a, b].filter(r => !r.blocked);
    expect(allowed, "exactly one of the two racers is allowed").toHaveLength(1);
    expect(blocked, "and exactly one is refused").toHaveLength(1);
    expect(blocked[0].reason, "by the cap, and not by anything about the finding").toContain(
      "OVER_CAP",
    );
    // The ledger is the other half: one filing landed, whatever the two
    // processes were told. A pass here with two emitted rows would mean the
    // refusal was composed and the row written anyway.
    expect(
      ledgerRows().filter(r => r.emitted),
      "one filing on the ledger",
    ).toHaveLength(1);
    // **Not `toHaveLength(2)`, and the reason is the point of FG-166.**
    // Whether BOTH processes reserve depends on whether they overlapped: if
    // the first finishes before the second reads, the second is refused by
    // the pre-read and never reserves. That is a true outcome, not a weaker
    // one — but it means this case cannot witness the ordinal. Measured: two
    // reservations on this machine, one on the CI runner, same assertion.
    // FG-166 forces the interleave instead of hoping for it.
    const reserved = ledgerIntents().length;
    expect(reserved, "whoever got far enough reserved").toBeGreaterThanOrEqual(1);
    expect(reserved, "and nobody reserved twice").toBeLessThanOrEqual(2);
  });

  test("FG-166: the second racer loses on its ORDINAL, not on the pre-read", async () => {
    // FG-165 spawns two real processes and cannot force the interleave: if
    // the first finishes before the second reads, the second is refused by
    // the pre-read and the ordinal is never exercised. This case IS the
    // interleave, by construction — both gates read an EMPTY ledger before
    // either appends, which is exactly the window — so it is the one that
    // says the ordinal is what decides.
    const dir = freshRun();
    const sink: FilingLedgerRow[] = [];
    // The first read of each call is the pre-read, taken before either
    // racer wrote; every later read sees the live file.
    const racing = () => {
      let reads = 0;
      return () => (reads++ === 0 ? [] : [...sink]);
    };
    // **Two racers are two PROCESSES, and `filingBatch` separates them by
    // pid.** This fixture is one process, so the pid is held fixed and the
    // keys would collide — both rows would be `${session}.${pid}/${at}/0`,
    // the loser's `indexOf` would find the winner's position, and the case
    // would go green reporting that the ordinal works. Varying `now` by a
    // millisecond restores the property the real pair gets for free, and the
    // premise is asserted below rather than assumed.
    const race = (cmd: string, now: string) =>
      filingGate(cmd, {
        projectRoot: dir,
        now,
        readExisting: async () => measuredCorpus([]),
        readLedger: racing(),
        appendLedger: (row: FilingLedgerRow) => {
          sink.push(row);
          return true;
        },
        readTarget: async () => onPr,
      });

    const won = await race(first, AT);
    const lost = await race(second, new Date(Date.parse(AT) + 1).toISOString());
    expect(sink[0].key, "the premise: the two reservations are told apart").not.toBe(sink[1].key);
    expect(won.rows[0].refusal, "the first in the queue files").toBeNull();
    expect(won.rows[0].emitted).toBe(true);
    expect(lost.rows[0].refusal, "the second is over the cap on its position").toBe("OVER_CAP");
    expect(lost.rows[0].emitted).toBe(false);
    // Three rows, not two: both reserved, and the loser GAVE ITS SLOT BACK.
    // A losing reservation left on the file is the stranded allowance by a
    // rarer route than the two-clause one FG-170 holds.
    expect(sink, "both reserved, and the loser released").toHaveLength(3);
    expect(sink[2].releases, "the release names the slot it returns").toBe(sink[1].key);
    expect(
      intentOrdinal(sink.slice(0, 2), sink[1].key, runOf(dir), Date.parse(AT)),
      "and the loser's position before the release is what refused it",
    ).toBe(2);
    expect(
      intentsInRun(sink, runOf(dir), Date.parse(AT)),
      "after it, the run has spent exactly the one filing that landed",
    ).toBe(1);
  });

  test("FG-167: both ledger failures refuse, and each names its own half", async () => {
    // **This case asserted the opposite for one round, and the round was
    // wrong.** The write failure ALLOWED, on `recordAdjudication`'s policy
    // that a measurement apparatus must not block the thing it measures.
    // That policy is right for the row which RECORDS a decision and wrong
    // for the row which MAKES one: a failure to update the cap's state
    // cannot be told apart from an attempt to disable it, so an unwritable
    // ledger switched the cap off. The read path had already settled this
    // in the same commit, and the two branches disagreed about one file.
    //
    // The readings stay separate even though the verdict is now shared,
    // because an operator repairs a different half of the same file.
    const dir = freshRun();
    const run = runOf(dir);
    const row = { ...landed(run), intent: false, emitted: true, withheldBy: null };

    expect(
      reserveAllowance(row, run, { now: Date.parse(AT), append: () => false, readLedger: () => [] })
        .outcome,
      "the WRITER failed, so no position was taken",
    ).toBe("UNRESERVED");
    expect(
      reserveAllowance(row, run, { now: Date.parse(AT), append: () => true, readLedger: () => null })
        .outcome,
      "the STATE could not be read, which is the cap's own input",
    ).toBe("UNCOUNTABLE");

    // And the gate acts on each: one allows loudly, one refuses.
    const unwritable = await filingGate(first, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => [],
      appendLedger: () => false,
      readTarget: async () => onPr,
    });
    expect(unwritable.rows[0].refusal, "an allowance nobody can reserve is not spendable").toBe(
      "UNMEASURED_CAP",
    );
    expect(unwritable.rows[0].emitted).toBe(false);
    expect(unwritable.refusal ?? "", "and the refusal names the WRITE, not the read").toContain(
      "could not be appended",
    );
    expect(unwritable.note ?? "", "with the note naming the file an operator repairs").toContain(
      "took no position in this run's queue",
    );

    // One axis apart: the pre-read succeeds and the VERIFY read does not, so
    // this is the ordinal's own UNMEASURED and not the pre-read's.
    let reads = 0;
    const unreadable = await filingGate(first, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => (reads++ === 0 ? [] : null),
      appendLedger: () => true,
      readTarget: async () => onPr,
    });
    expect(unreadable.rows[0].refusal, "an allowance nobody can count is not spendable").toBe(
      "UNMEASURED_CAP",
    );
  });

  test("FG-168: a BLOCKED command reserves nothing", async () => {
    // The reservation is taken after the command-level decision, and this is
    // why. A clause that is clean inside a command the hook goes on to block
    // files nothing — `markBlockedCommand` has said so since #1344 — so
    // reserving for it would spend the run's allowance on a command that
    // never reached the tracker, and the agent's corrected re-run would come
    // back OVER_CAP. A reservation cannot be taken back, so the ordering is
    // the whole defence.
    const dir = freshRun();
    const sink: FilingLedgerRow[] = [];
    const mixed = `${first} && gh issue create --title "zqxjCapOne loses a sweep it started" --body "a second clause of the same class. Claim 4. ${DECLARED}"`;
    const r = await filingGate(mixed, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => [],
      appendLedger: (row: FilingLedgerRow) => {
        sink.push(row);
        return true;
      },
      readTarget: async () => onPr,
    });
    expect(r.refusal, "the premise: this command is blocked").not.toBeNull();
    expect(sink, "so nothing was reserved").toHaveLength(0);
    expect(
      r.rows.filter(row => row.emitted),
      "and nothing is recorded as filed",
    ).toHaveLength(0);
  });

  test("FG-170: a reservation whose command then refuses is given back", async () => {
    // **A reservation is taken and the command files nothing anyway.** The
    // clause clears the pre-read, appends its intent, and the verify read
    // fails — so it is refused `UNMEASURED_CAP` holding a slot for a filing
    // that never happened. Without the release the run is charged for it
    // and the re-run, once the file is readable again, is `OVER_CAP`.
    //
    // **The two-clause command is NOT this case, and the walk that says it
    // is does not reproduce.** `spent` is incremented inside the clause loop
    // on every cleared clause, so at a cap of one, clause 1 is refused by
    // the pre-read before the reservation stage runs at all — `refusals` is
    // already non-empty and the stage is skipped, reserving nothing.
    // Measured: a version of this case built on `first && second` stays
    // GREEN with the release removed, because nothing was ever reserved. At
    // most one clause per command reaches the stage while the cap is 1, so
    // the reachable strandings are the concurrent loser (`FG-166`) and this
    // one.
    const dir = freshRun();
    const run = runOf(dir);
    const sink: FilingLedgerRow[] = [];
    const append = (row: FilingLedgerRow) => {
      sink.push(row);
      return true;
    };
    let reads = 0;
    const stranded = await filingGate(first, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readTarget: async () => onPr,
      // One axis: the pre-read succeeds and the VERIFY read does not.
      readLedger: () => (reads++ === 0 ? [...sink] : null),
      appendLedger: append,
    });
    expect(stranded.rows[0].refusal, "the premise: it reserved, then could not verify").toBe(
      "UNMEASURED_CAP",
    );
    expect(stranded.rows[0].emitted, "and filed nothing").toBe(false);
    expect(sink, "one reservation and one release").toHaveLength(2);
    expect(sink[1].releases, "which names the slot it returns").toBe(sink[0].key);
    expect(
      intentsInRun(sink, run, Date.parse(AT)),
      "so the run was not charged for a filing that never happened",
    ).toBe(0);

    // The half that makes it a property rather than a count: the re-run,
    // against a ledger that reads again, files.
    const retry = await filingGate(first, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readTarget: async () => onPr,
      readLedger: () => [...sink],
      appendLedger: append,
    });
    expect(retry.rows[0].refusal, "the re-run is not punished for the failed attempt").toBeNull();
    expect(retry.rows[0].emitted).toBe(true);

    // CONTROL, one axis: the allowance is still finite. A second re-run is
    // over the cap, so the row above is not passing under a gate that
    // releases everything it reserves.
    const third = await filingGate(second, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readTarget: async () => onPr,
      readLedger: () => [...sink],
      appendLedger: append,
    });
    expect(third.rows[0].refusal, "and a filing that DID land still spends it").toBe("OVER_CAP");
  });

  test("FG-171: an intent absent from the re-read takes the NEXT position, not the last", async () => {
    // `queue.length` for a not-found key hands us the last EXISTING slot
    // rather than the one after it: with one intent queued and a cap of 1,
    // ordinal 1, `1 > 1` false, WON — while we are genuinely second.
    const run = "/wt/x";
    const now = Date.parse(AT);
    const queued = { ...landed(run), key: "someone-else#intent" };
    expect(
      intentOrdinal([queued], "mine#intent", run, now),
      "our row is not in this reading, so everything in it precedes us",
    ).toBe(2);
    expect(
      intentOrdinal([], "mine#intent", run, now),
      "and an empty queue still makes us first",
    ).toBe(1);

    // **The other not-found cause, which must NOT take the next position.**
    // A null key means `CLAUDE_CODE_SESSION_ID` was absent, so our row IS in
    // the queue and cannot be pointed at. Counting us after it would count
    // us twice and refuse every filing from an unkeyed session — a gag, and
    // a contradiction of `unkeyedLedgerNote`'s stated policy.
    const mine = { ...landed(run), key: null };
    expect(intentOrdinal([mine], null, run, now), "ours is the one in there").toBe(1);
    expect(
      intentOrdinal([queued, mine], null, run, now),
      "and with another ahead of it, last place among what is visible",
    ).toBe(2);
  });

  test("FG-172: a released intent holds no position", async () => {
    const run = "/wt/x";
    const now = Date.parse(AT);
    const taken = { ...landed(run), key: "a#intent" };
    expect(intentsInRun([taken], run, now), "the premise: it counts while held").toBe(1);

    const sink: FilingLedgerRow[] = [taken];
    expect(
      releaseAllowance(taken, row => {
        sink.push(row);
        return true;
      }),
      "the release landed",
    ).toBe(true);
    expect(sink[1].releases, "naming the key it returns").toBe("a#intent");
    expect(sink[1].intent, "and a release is not itself a reservation").not.toBe(true);
    expect(intentsInRun(sink, run, now), "so the slot is free again").toBe(0);

    // A null-keyed intent cannot be named, so it cannot be released, and
    // the function says so instead of appending a row that releases nothing.
    const unkeyed = { ...landed(run), key: null };
    expect(
      releaseAllowance(unkeyed, () => true),
      "nothing can name it, so nothing can give it back",
    ).toBe(false);
  });

  test("FG-173: a title too long for one write is bounded before it is recorded", async () => {
    // The whole race fix rests on an append reaching the filesystem as ONE
    // write. A row large enough to be split can tear, and `readLedgerRows`
    // treats a torn line as expected and skips it — so a torn intent is a
    // reservation that took no position while its writer believes it did.
    // `title` is the one field on the row a FILER sets and nothing else
    // bounds.
    const long = "z".repeat(MAX_LEDGER_TITLE + 50);
    expect(ledgerTitle(long).length, "bounded, with one character marking the cut").toBe(
      MAX_LEDGER_TITLE + 1,
    );
    expect(ledgerTitle("short"), "and a title inside the bound is untouched").toBe("short");

    const r = await filingGate(
      `gh issue create --title "${long}" --body "\`zqxjLongTitle\` in lib/zqxj-long.ts drops 11 of 29 commands over 5503 runs. Claim 4. ${DECLARED}"`,
      {
        projectRoot: freshRun(),
        now: AT,
        readExisting: async () => measuredCorpus([]),
        readTarget: async () => onPr,
        ...noCap,
      },
    );
    expect(r.rows[0].title.length, "the row carries the bounded one").toBe(MAX_LEDGER_TITLE + 1);

    // **The lookup is bounded too, or the bound breaks #1536.**
    // `priorRefusalFor` joins on this field, so a raw title compared against
    // a stored truncated one would never match its own prior refusal and the
    // override would stop surviving a re-draft for exactly the longest
    // titles. One binding, both ends.
    const priorRow = {
      ...landed("/wt/x"),
      intent: false,
      title: ledgerTitle(long),
      refusal: "DUPLICATE" as const,
      withheldBy: "DUPLICATE" as const,
      emitted: false,
    };
    expect(
      priorRefusalFor(long, [priorRow])?.title,
      "the raw title still finds the row written under the bounded one",
    ).toBe(ledgerTitle(long));
  });

  test("FG-147: a REFUSED filing does not consume the allowance", async () => {
    // A gate that counted its own refusals would cap a run out for having
    // been stopped, which is the fastest way to build one that refuses
    // everything. The intent is the only row counted and this is why: it is
    // registered after the command-level decision, so a refused clause never
    // writes one.
    const refusedRow = {
      ...landed(runOf(runA)),
      intent: false,
      emitted: false,
      refusal: "DUPLICATE" as const,
      disposition: "DROP" as const,
    };
    const r = await gateIn(second, runA, [refusedRow]);
    expect(r.rows[0].refusal).toBeNull();
  });

  test("FG-148: a filing outside the window does not count", async () => {
    // Without the window a long-lived checkout is barred for ever, and the
    // window is 24h because every number #1595 measured is a per-day one.
    const old = new Date(Date.parse(AT) - RUN_WINDOW_MS - 1000).toISOString();
    expect((await gateIn(second, runA, [landed(runOf(runA), old)])).rows[0].refusal).toBeNull();
    const justInside = new Date(Date.parse(AT) - RUN_WINDOW_MS + 1000).toISOString();
    expect(
      (await gateIn(second, runA, [landed(runOf(runA), justInside)])).rows[0].refusal,
      "and a filing one second inside the window still counts",
    ).toBe("OVER_CAP");
  });

  test("FG-149: `intentsInRun` is the one binding, and it counts what it says", () => {
    const run = runOf(runA);
    const now = Date.parse(AT);
    expect(intentsInRun([], run, now), "nothing reserved").toBe(0);
    expect(intentsInRun([landed(run)], run, now)).toBe(1);
    expect(intentsInRun([landed(run), landed(run)], run, now)).toBe(2);
    expect(intentsInRun([landed("elsewhere")], run, now), "another run").toBe(0);
    expect(
      intentsInRun([{ ...landed(run), intent: false }], run, now),
      "a refusal reserves nothing",
    ).toBe(0);
    // **The outcome row is not counted, and this is the assertion that says
    // so.** A landed filing leaves an intent AND an outcome, and counting
    // both would halve the cap — a run allowed one filing would be refused
    // its first. Counting the outcome INSTEAD is the defect the intent row
    // exists to fix: it is written after the decision, so a filing in flight
    // in another process is invisible.
    expect(intentsInRun([outcome(run)], run, now), "an outcome row is not a reservation").toBe(0);
    // An unparseable timestamp is COUNTED, not skipped: it is a row this
    // writer appended, and skipping it would let a filing escape the count
    // by carrying a date nobody can read.
    expect(intentsInRun([{ ...landed(run), at: "not a date" }], run, now)).toBe(1);
    // A legacy row written before the column existed has no `run` at all.
    // It must not be attributed to a real checkout.
    const legacy = { ...landed(run) } as Partial<FilingLedgerRow>;
    delete legacy.run;
    expect(intentsInRun([legacy as FilingLedgerRow], run, now), "a row with no run is not this run")
      .toBe(0);
    // And a row written before the column existed carries no `intent`
    // either, so absent must read as false rather than as a reservation.
    const beforeTheColumn = { ...landed(run) } as Partial<FilingLedgerRow>;
    delete beforeTheColumn.intent;
    expect(
      intentsInRun([beforeTheColumn as FilingLedgerRow], run, now),
      "absent is not a reservation",
    ).toBe(0);
  });

  test("FG-150: the refusal names the cap, the run and the comment target", () => {
    const text = overCapReason("/wt/x", 1, onPr);
    expect(text).toContain("cap is 1");
    expect(text).toContain("/wt/x");
    expect(text).toContain("PR #1595");
    expect(text, "and it offers no way out, because there is not one").toContain(
      "no label that waives it",
    );
    // The same self-reference property FG-126 holds for the other refusal:
    // pasting this into a body must not declare anything.
    expect(declaredExemption(text)).toBeNull();
  });

  test("FG-151: the ledger row carries the run, so the denominator is recordable", async () => {
    const r = await gateIn(second, runB, []);
    expect(r.rows[0].run, "the cap's denominator has to be written down to be counted").toBe(
      runOf(runB),
    );
    // `runIdFor` canonicalises through git, so a subdirectory of one
    // checkout is one run. Asserted on the repo this suite lives in, which
    // is the only checkout it can be sure of.
    expect(runOf(join(REPO, "lib"))).toBe(runOf(REPO));
    // And two DIFFERENT checkouts are two runs. `runA` and `runB` each carry
    // an origin, which is what makes them nameable — the earlier version of
    // this comment said a non-checkout was its own run too, which was the
    // policy this branch reversed, and FG-160 now asserts the opposite.
    expect(runOf(runA)).not.toBe(runOf(runB));
  });

  test("FG-154: an UNMEASURED tracker does not excuse the cap", async () => {
    // **The bypass this ordering exists to close.** Every other UNMEASURED
    // arm in this file ALLOWS, and rightly — a broken adjudicator must not
    // gag the tracker. But `lib/issue-filing-gate.ts`'s own header records
    // that a developer's GitHub credential usually is not in the
    // environment, so with the cap behind the tracker read, the no-token
    // configuration would have no cap at all. A gate that switches itself
    // off in the setup most agents run in is not a gate.
    //
    // Observed end to end before it was written down: with
    // `RUNGATE_OPEN_FINDINGS` pointed at an absent file, the real hook
    // allowed the first filing as UNMEASURED and blocked the second
    // `OVER_CAP`.
    const unreadable = async () => unmeasuredCorpus("the open-issue set could not be read");
    const capped = await filingGate(second, {
      projectRoot: runA,
      now: AT,
      readExisting: unreadable,
      readLedger: () => [landed(runOf(runA))],
      readTarget: async () => onPr,
    });
    expect(capped.rows[0].refusal).toBe("OVER_CAP");

    // CONTROL: the same unreadable tracker, an allowance not yet spent.
    // Without it this row could be witnessing "UNMEASURED now refuses".
    const first = await filingGate(second, {
      projectRoot: runA,
      now: AT,
      readExisting: unreadable,
      readLedger: () => [],
      readTarget: async () => onPr,
    });
    expect(first.rows[0].refusal, "a broken adjudicator is still not a gag").toBe("UNMEASURED");
    expect(first.refusal).toBeNull();
  });

  test("FG-152: the closed list cannot grow", () => {
    // #1595: *"Do not let the reason list grow. A fourth clause added later
    // to admit one good finding is how this leaks back, and it will look
    // reasonable at the time."* A prose instruction is not one that
    // survives the next agent with a good reason; this is.
    expect(
      Object.keys(COMMENT_EXEMPTIONS).sort(),
      "adding a fourth clause is how the per-finding judgement comes back — " +
        "the cap is the gate, and this list is only the record of why",
    ).toEqual(["evidence-expires", "green-check-lies", "out-of-pr-diff"]);
  });

  test("FG-174: a remote read that FAILED is not a checkout with no origin", async () => {
    // **Finding 2 of the security review of `31a2324f`, and the shape this
    // file refuses everywhere else.** `readWorktreeRemote` sets `error` for a
    // git timeout, for a git that is not on PATH, AND for a perfectly healthy
    // checkout that simply has no remote. `runIdFor` read that one field, so
    // ten seconds of git being slow re-keyed a real checkout into the shared
    // bucket — the cap's DENOMINATOR moving underneath the count, silently,
    // in the direction that hands a spent run a fresh allowance.
    //
    // INJECTED rather than provoked. With a real git on PATH the failed read
    // is a timeout or a git that vanished between two commands, and neither
    // is producible from a test; `worktreeDiskIdentity` takes the same
    // parameter for the same reason. The default is the real reader and the
    // line below is what says so.
    expect(runIdFor(runA).run, "the DEFAULT reader is the real one").toBe(checkoutTop(runA));

    const failed: RemoteReading = { url: null, error: "spawnSync git ETIMEDOUT", missing: false };
    // The ONE axis this case varies: the same stub with `missing` flipped —
    // the read happened and the repository has no origin. BOTH carry an
    // `error`, which is exactly why reading `error` alone could not tell a
    // fact from a failure to look.
    const absent: RemoteReading = { ...failed, missing: true };

    expect(runIdFor(runA, () => failed).run, "a read that failed is not an answer").toBeNull();
    expect(runIdFor(runA, () => failed).why, "and it carries what git said").toContain("ETIMEDOUT");
    expect(runIdFor(runA, () => absent).run, "an observed absence IS an answer").toBe(
      NON_CHECKOUT_RUN,
    );

    const unreadable = await filingGate(`${second} --label ${FILING_OVERRIDE_LABEL}`, {
      projectRoot: runA,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => [],
      readTarget: async () => onPr,
      readRemote: () => failed,
    });
    expect(unreadable.rows[0].refusal, "an unknown denominator is UNMEASURED").toBe(
      "UNMEASURED_CAP",
    );
    expect(unreadable.rows[0].emitted).toBe(false);
    expect(unreadable.rows[0].overridden, "and no label waives this one either").toBe(false);
    // The refusal names the RUN, not the ledger. FG-161's text is about a
    // file an operator repairs; this one is about a reading that did not
    // happen, and the two have different remedies.
    expect(unreadable.refusal ?? "").toContain("RUN could not be read");
    expect(unreadable.refusal ?? "", "quoting git rather than guessing").toContain("ETIMEDOUT");

    // CONTROL, one axis — `missing: true`, nothing else changed. An empty
    // bucket allows, so without this row the assertions above are satisfied
    // by a gate that refuses every filing on the machine.
    const bucketed = await filingGate(second, {
      projectRoot: runA,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => [],
      readTarget: async () => onPr,
      readRemote: () => absent,
    });
    expect(bucketed.rows[0].refusal, "a checkout with no origin buckets and files").toBeNull();
    expect(bucketed.rows[0].emitted).toBe(true);
    // **`row.run` is NOT the discriminator and this says so.** It is
    // `reading.run ?? NON_CHECKOUT_RUN`, so both arms above write
    // `NON_CHECKOUT` into the row — the failed one as a fallback on a row
    // that was refused and counts towards nothing. A later case reaching for
    // this field to tell the two apart would be reading a value that cannot.
    // The same bound is written on `FilingLedgerRow.run` itself, because an
    // assertion here tells whoever changes this test and a sentence on the
    // field tells whoever reads the field — and it is the second one who
    // writes the first aggregation keyed on `run`.
    expect(bucketed.rows[0].run).toBe(NON_CHECKOUT_RUN);
    expect(unreadable.rows[0].run, "the same value, for a different reason").toBe(NON_CHECKOUT_RUN);
  });

  test("FG-175: a bare `owner/name` origin does not mint an allowance", async () => {
    // **The route the fix in `377e3a06` left open, found by the security
    // review of it.** `runIdFor` asked `repoSlug`, whose LAST branch accepts
    // a bare `owner/name` — because that is how a run's own `repo` ARGUMENT
    // arrives, a different caller asking a different question. Reused as the
    // admission test, `git remote add origin a/b` minted a fresh allowance:
    // two words, no URL, no repository, one command more than the `git init`
    // FG-163 closed.
    const dir = join(scratch, "bare-slug-origin");
    mkdirSync(dir, { recursive: true });
    // late-env-ok: the child is `git`, which reads none of the variables this
    // file writes — the gate reads them in this process, never a subprocess.
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: { ...process.env } });
    expect(git("init", "-q", "-b", "main").status, "the fixture must be a checkout").toBe(0);
    expect(git("remote", "add", "origin", "a/b").status, "git accepts two words").toBe(0);
    // The premise, measured: git STORED it. Without this the case could be
    // passing because git refused the remote, which is a different fact.
    expect(git("remote", "get-url", "origin").stdout.trim()).toBe("a/b");

    expect(runOf(dir), "two words are not a repository").toBe(NON_CHECKOUT_RUN);
    const spentThere = [landed(NON_CHECKOUT_RUN)];
    const bucketed = await filingGate(second, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => spentThere,
      readTarget: async () => onPr,
    });
    expect(bucketed.rows[0].refusal, "so it spends the bucket's allowance").toBe("OVER_CAP");

    // CONTROL, one axis — the SAME directory and the same remote, re-pointed
    // at a real scp-form URL. Without it the row above is satisfied by a gate
    // that buckets every checkout, which is a gag rather than a cap.
    expect(git("remote", "set-url", "origin", "git@github.com:owner/name.git").status).toBe(0);
    expect(runOf(dir), "a transport form naming a repository is a run").toBe(checkoutTop(dir));
    const named = await filingGate(second, {
      projectRoot: dir,
      now: AT,
      readExisting: async () => measuredCorpus([]),
      readLedger: () => spentThere,
      readTarget: async () => onPr,
    });
    expect(named.rows[0].refusal, "and a named checkout has its own allowance").toBeNull();

    // The predicate on the forms it has to separate. It answers *"is this a
    // remote"* and `repoSlug` still answers *"which repository"*, so the two
    // readers do not restate each other.
    expect(namesARepository("git@github.com:owner/name.git")).toBe(true);
    expect(namesARepository("https://github.com/owner/name")).toBe(true);
    expect(namesARepository("https://x-access-token:TOKEN@github.com/owner/name.git")).toBe(true);
    expect(namesARepository("a/b"), "a bare slug is the bypass").toBe(false);
    expect(namesARepository("/srv/git/owner/name"), "and a path is not a remote").toBe(false);
    expect(namesARepository(null)).toBe(false);
    // Measured rather than supposed: with `remote.origin.url` set to the
    // empty string, git's own `get-url` prints the REMOTE NAME back. A reader
    // that took any non-empty answer would read `origin` as a repository.
    expect(namesARepository("origin")).toBe(false);
    // The stated FALSE NEGATIVE from `runIdFor`'s bound table, asserted so
    // the bound is a measurement and not a claim in a docblock: a sub-group
    // checkout is a legitimate unit and buckets with the nowheres, because
    // `normaliseSlug` wants exactly two segments.
    expect(namesARepository("https://git.example.com/group/sub/name.git")).toBe(false);
  });

  test("FG-176: no label waives the comment DEFAULT, and the refusal stops spelling one", async () => {
    // **The default was waivable by a token its own refusal handed over.**
    // `COMMENT_INSTEAD` is the comment default — the thing #1595's spec
    // paragraph is about — and `waivableRefusal` let `arbiter-override`
    // clear it while the message closed with *"If this one genuinely is the
    // exception, re-run with --label arbiter-override"*, four lines under
    // the text saying the list of exceptions is closed. So the closed list
    // had a fourth member, spelled in the refusal that enforced it.
    //
    // Measured rather than argued: `arbiter-override` was already on **7 of
    // the 140** issues filed in the two days before this gate shipped, so
    // the token was in circulation before there was anything to override.
    expect(waivableRefusal("COMMENT_INSTEAD"), "the comment default is not waivable").toBe(false);

    // Through the real hook PROCESS, because what an agent acts on is the
    // text on stdout and not a return value. The two commands differ by the
    // declaration and by the label, and by nothing else: `NOVEL_FILING` is
    // this file's standing ALLOW control, so the undeclared twin is it with
    // one line removed — the cheapest route, and the one worth closing.
    const undeclaredNovel = NOVEL_FILING.replace(` ${DECLARED}`, "");
    expect(undeclaredNovel, "the declaration really came out").not.toContain(EXEMPTION_PREFIX);
    const blocked = runHook(HOOK, `${undeclaredNovel} --label ${FILING_OVERRIDE_LABEL}`);
    expect(blocked.blocked, "the label carried an undeclared filing to the tracker").toBe(true);
    expect(blocked.reason).toContain("COMMENT_INSTEAD");
    expect(blocked.reason, "and it says so rather than going silent").toContain(
      `--label ${FILING_OVERRIDE_LABEL} does NOT waive this one`,
    );

    // **CONTROL, one axis — the declaration present, no label.** A gate that
    // refuses everything is a gag and not a default; this is the row that
    // tells them apart, and it is the same filing with one line added.
    writeFileSync(ledger, "", "utf-8");
    const allowed = runHook(HOOK, NOVEL_FILING, {}, freshRun());
    expect(allowed.blocked, "a declared filing must still go through").toBe(false);

    // The POPULATION, so a refusal added to the map later cannot be
    // waivable and a member removed cannot go unnoticed. Two directions,
    // because membership and non-membership are different claims.
    const unwaivable = Object.keys(UNWAIVABLE_REFUSALS) as ArbiterRefusal[];
    expect(unwaivable.sort(), "the three that make no claim about a finding").toEqual([
      "COMMENT_INSTEAD",
      "OVER_CAP",
      "UNMEASURED_CAP",
    ]);
    for (const refusal of unwaivable) {
      expect(waivableRefusal(refusal), `${refusal} is in the map and still waivable`).toBe(false);
      expect(
        UNWAIVABLE_REFUSALS[refusal],
        `${refusal} has no sentence, so the refusal would give a reason that is not its own`,
      ).toBeTruthy();
    }
    for (const refusal of ["DUPLICATE", "NO_CLAIM", "DROPPED_CATEGORY", "SAME_CLASS_IN_RUN"] as const) {
      expect(waivableRefusal(refusal), `${refusal} stopped being waivable`).toBe(true);
    }
    // And `null` — no refusal at all — is not swept into the unwaivable set
    // by a membership test that forgot it.
    expect(waivableRefusal(null)).toBe(true);
  });

  test("FG-178: deleting the CLAIM as well does not carry an undeclared filing past the label", async () => {
    // **The sibling-refusal bypass, written before the fix and run against
    // the unchanged tree first.** `FG-176` closes the route that deletes the
    // declaration. This asks the next question down: `COMMENT_INSTEAD` is
    // issued **after** `NO_CLAIM` — the precedence is deliberate and
    // defended in `lib/issue-filing-gate.ts`, because putting the comment
    // default first makes `NO_CLAIM` unreachable for the common filing — so
    // a filing that is undeclared **and** claimless is refused `NO_CLAIM`,
    // never `COMMENT_INSTEAD`, and `NO_CLAIM` is waivable.
    //
    // If the label carries that filing to the tracker, the gate is cheaper
    // to beat the WORSE the filing gets: before, drop one line; now, drop
    // two. The unwaivable member is simply never consulted.
    //
    // The precedence itself is NOT the thing to change — making
    // `COMMENT_INSTEAD` win the race deletes a shipped gate as a side effect
    // of adding one, which is exactly what the source comment warns about.
    const undeclaredUnclaimed = NOVEL_FILING.replace(` ${DECLARED}`, "").replace(" Claim 4.", "");

    // **The fixture proves its own premise**, both halves, or a green row
    // below could be a filing that still declared or still claimed and was
    // allowed for an ordinary reason.
    expect(undeclaredUnclaimed, "the declaration really came out").not.toContain(EXEMPTION_PREFIX);
    expect(namedClaim(undeclaredUnclaimed), "the claim really came out").toBeNull();
    // And BOTH `replace` calls actually matched. A `String.replace` whose
    // needle is absent returns the haystack unchanged and silently, so
    // without this the fixture could be `NOVEL_FILING` itself — which names
    // a claim and declares, and would be ALLOWED for ordinary reasons while
    // reading as the bypass being closed.
    expect(undeclaredUnclaimed.length, "neither strip matched").toBeLessThan(
      NOVEL_FILING.length - ` ${DECLARED}`.length,
    );

    // The adjudication, so the row records WHICH refusal was issued. If this
    // is `COMMENT_INSTEAD` the hypothesis is wrong at its first step.
    const v = await adjudicateFiling(
      filingAttempts(undeclaredUnclaimed)[0],
      async () => measuredCorpus([]),
    );
    expect(v.refusal, "the precedence puts NO_CLAIM first for a filing missing both").toBe(
      "NO_CLAIM",
    );

    // **The question.** Through the real hook process, like FG-176, because
    // what reaches the tracker is decided by the process and not by a
    // predicate read in isolation.
    writeFileSync(ledger, "", "utf-8");
    const blocked = runHook(
      HOOK,
      `${undeclaredUnclaimed} --label ${FILING_OVERRIDE_LABEL}`,
      {},
      freshRun(),
    );
    expect(
      blocked.blocked,
      "the label carried a filing that declared nothing AND claimed nothing to the tracker",
    ).toBe(true);

    // **CONTROL, one axis — the claim restored, still undeclared, still
    // labelled.** This is FG-176's row reached from the other side: if it
    // does not block, the row above is measuring the label rather than the
    // sibling refusal, and if the row above blocks only because the gate
    // refuses everything, this one tells us nothing new either.
    writeFileSync(ledger, "", "utf-8");
    const undeclaredOnly = NOVEL_FILING.replace(` ${DECLARED}`, "");
    expect(namedClaim(undeclaredOnly), "the control really does name a claim").toBe(4);
    const stillBlocked = runHook(
      HOOK,
      `${undeclaredOnly} --label ${FILING_OVERRIDE_LABEL}`,
      {},
      freshRun(),
    );
    expect(stillBlocked.blocked, "FG-176's route reopened").toBe(true);
    expect(stillBlocked.reason).toContain("COMMENT_INSTEAD");

    // **CONTROL, the other direction — a complete filing still goes
    // through.** Without this the two rows above are satisfied by a gate
    // that blocks everything, which is a gag and not a default.
    writeFileSync(ledger, "", "utf-8");
    const allowed = runHook(HOOK, NOVEL_FILING, {}, freshRun());
    expect(allowed.blocked, "a declared, claiming filing must still go through").toBe(false);
  });
});
