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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
  readBodyFile,
  SUCCESS_CLAIM_COUNT,
  trustedCorpus,
  unmeasuredCorpus,
  withTimeout,
  FILING_OVERRIDE_LABEL,
  LEDGER_SESSION_ENV,
  MAX_KEYS_PER_EXISTING_ISSUE,
  type FilingLedgerRow,
} from "../lib/issue-filing-gate";
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
const DUPLICATE_BODY =
  "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts completes 144 of 234.";

const DUPLICATE_FILING =
  'gh issue create --title "retryBudget gives up early on long command sweeps" ' +
  `--body ${JSON.stringify(DUPLICATE_BODY)}`;

/**
 * A style/diagnostics finding. Refused before the tracker is ever read, which
 * is why this row needs no fixture agreement at all.
 */
const DROPPED_FILING =
  'gh issue create --title "The error message should name the legal values" ' +
  '--body "`legalValues` in lib/config-loader.ts is not printed when the check refuses."';

/**
 * A novel correctness finding. Must be allowed.
 *
 * It names a claim because every ALLOW now has to: the last stage of
 * `adjudicateFiling` converts a claimless ALLOW into `NO_CLAIM`. Measured when
 * that stage landed — 17 of this file's cases went red, all of them ALLOW
 * controls, which is the population it was built to catch.
 */
const NOVEL_FILING =
  'gh issue create --title "pullRequestCache is never invalidated" ' +
  '--body "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours. Claim 4."';

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
  'completes 88 of 97. Claim 4."';

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

function runHook(hook: string, command: string, extraEnv: Record<string, string> = {}): HookReading {
  const r = spawnSync("bun", [hook], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf-8",
    cwd: scratch,
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

function ledgerRows(): FilingLedgerRow[] {
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

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rg-filing-gate-"));
  ledger = join(scratch, "finding-ledger.jsonl");
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
      () => "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours. Claim 4.",
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
    expect(r.reason).toContain(FILING_OVERRIDE_LABEL);
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
    writeFileSync(at, "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours. Claim 4.", "utf-8");
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
  const BODY = '--body "`retryBudget` in lib/pr-cache.ts holds 72 entries. Claim 4."';

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

  test("FG-48 CONTROL: a command whose filings are ALL clean is still allowed", () => {
    // The control against the cheapest wrong fix for the three rows above —
    // block whenever there is more than one clause, or block unconditionally.
    const r = runHook(HOOK, `${NOVEL_FILING} && ${SAME_SYMBOL_NEW_READING}`);
    expect(r.blocked, "two novel findings in one command must still run").toBe(false);
    expect(r.payload?.systemMessage ?? null, "and with nothing to say about them").toBe(null);
  });

  test("FG-49 CONTROL: an UNMEASURED filing ALONE is allowed, loudly", () => {
    // Separates "UNMEASURED no longer excuses a sibling" from "UNMEASURED now
    // refuses", which would make a broken adjudicator a gag on the tracker.
    const r = runHook(HOOK, UNMEASURED_FILING);
    expect(r.blocked).toBe(false);
    expect(r.payload?.systemMessage ?? "").toContain("UNMEASURED");
  });

  test("FG-50 CONTROL: an overridden duplicate beside a novel finding still allows", () => {
    // An override is a decision somebody made and recorded. It must survive
    // the stricter predicate, or the label stops meaning anything.
    const r = runHook(
      HOOK,
      `${DUPLICATE_FILING} --label ${FILING_OVERRIDE_LABEL} && ${NOVEL_FILING}`,
    );
    expect(r.blocked).toBe(false);
    expect(r.payload?.systemMessage ?? "").toContain(FILING_OVERRIDE_LABEL);
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
 * at all (#1338). FG-94 is red under it.
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

  test("FG-91 POSITIVE CONTROL: a fully clean command still records emitted rows", () => {
    // Without this, a fix that marked every row `emitted: false` would pass
    // FG-90 and zero the ledger, and no case in this file would see it.
    const start = ledgerRows().length;
    const r = runHook(HOOK, ALL_CLEAN);
    expect(r.blocked, "two novel findings in one command must still run").toBe(false);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(2);
    expect(added.map(x => x.emitted)).toEqual([true, true]);
    expect(added.map(x => x.withheldBy)).toEqual([null, null]);
    expect(added.map(x => x.disposition)).toEqual(["ISSUE", "ISSUE"]);
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
    for (const spelling of [SLUG, ...HOST_BEARING]) {
      const r = await filingGate(withRepo(spelling), { projectRoot: scratch, readExisting: allow });
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
      "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours. Claim 4.",
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
          "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours.",
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

  test("FG-88: the override label posts a claimless filing, and is counted", async () => {
    const r = await filingGate(`${NOVEL_NO_CLAIM} --label ${FILING_OVERRIDE_LABEL}`, {
      projectRoot: scratch,
      readExisting: async () => measuredCorpus([]),
    });
    expect(r.refusal, "cleanup is still postable").toBeNull();
    expect(r.rows[0].refusal, "and the override is recorded, not erased").toBe("NO_CLAIM");
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
