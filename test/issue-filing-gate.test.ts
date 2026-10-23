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

import { listOpenIssues, type OpenIssue } from "../lib/github";
import { symptomKeys, type Finding } from "../lib/finding-arbiter";
import {
  adjudicateFiling,
  filingAttempts,
  filingGate,
  openFindings,
  readBodyFile,
  trustedCorpus,
  withTimeout,
  FILING_OVERRIDE_LABEL,
  MAX_KEYS_PER_EXISTING_ISSUE,
  type FilingLedgerRow,
} from "../lib/issue-filing-gate";

const REPO = resolve(import.meta.dir, "..");
const HOOK = join(REPO, "hooks", "VerifyPhaseLock.hook.ts");

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

/** A novel correctness finding. Must be allowed. */
const NOVEL_FILING =
  'gh issue create --title "pullRequestCache is never invalidated" ' +
  '--body "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours."';

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
  'completes 88 of 97."';

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
    const v = await adjudicateFiling(filingAttempts(NOVEL_FILING)[0], async () => null);
    expect(v.outcome).toBe("UNMEASURED");
    expect(v.refusal).toBe("UNMEASURED");
  });

  test("FG-5: an EMPTY tracker is a reading, and allows", async () => {
    const v = await adjudicateFiling(filingAttempts(NOVEL_FILING)[0], async () => []);
    expect(v.outcome).toBe("ALLOW");
    expect(v.refusal).toBeNull();
  });

  test("FG-15: a dropped category refuses without ever reading the tracker", async () => {
    let asked = 0;
    const v = await adjudicateFiling(filingAttempts(DROPPED_FILING)[0], async () => {
      asked += 1;
      return [];
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
      OPEN_ISSUES.map(i => ({ id: String(i.number), title: i.title, body: i.body })),
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
    OPEN_ISSUES.map(i => ({ id: String(i.number), title: i.title, body: i.body }));

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
      () => "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours.",
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
    const issues = await listOpenIssues(client, "owner/repo");
    expect(issues.map(i => i.number)).toEqual([10]);
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
    writeFileSync(at, "`pullRequestCache` in lib/pr-cache.ts holds 72 entries for 36 hours.", "utf-8");
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
  const BODY = '--body "`retryBudget` in lib/pr-cache.ts holds 72 entries."';

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
      async () => [],
    );
    const trailingReal = await adjudicateFiling(
      filingAttempts(`gh issue create --title "${STYLE_TITLE}" --title "${REAL_TITLE}" ${BODY}`)[0],
      async () => [],
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
          return [];
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

  test("FG-33 BASELINE: an untrusted author cannot put a suppressor in the corpus", () => {
    expect(trustedCorpus([trusted({ authorAssociation: "NONE" })])).toEqual([]);
    expect(trustedCorpus([trusted({ authorAssociation: "CONTRIBUTOR" })])).toEqual([]);
    expect(trustedCorpus([trusted({ authorAssociation: "" })]), "absent is not trusted").toEqual([]);
  });

  test("FG-34 CONTROL: a trusted author's issue is still in the corpus", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(trustedCorpus([trusted({ authorAssociation: association })])).toHaveLength(1);
    }
  });

  test("FG-35: one issue cannot name enough to match everything", () => {
    const stuffed = Array.from({ length: MAX_KEYS_PER_EXISTING_ISSUE + 10 }, (_, i) => `\`symbolNumber${i}\``).join(" ");
    expect(trustedCorpus([trusted({ body: stuffed })]), "over the cap, so dropped whole").toEqual([]);
    expect(trustedCorpus([trusted()]), "an ordinary issue is unaffected").toHaveLength(1);
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
    // `null`, not `[]`, since #1318. The row is still dropped whole — what
    // changed is what a corpus with nothing left in it REPORTS. `[]` said
    // "the tracker is clean" about a tracker nobody managed to read, and the
    // gate allowed on it. FG-48 is the case that names that directly.
    expect(await read(stuffed), "over the cap, so dropped whole — and that is UNMEASURED").toBeNull();
    expect(
      await read("`retryBudget` in lib/command-retry.ts: 144 of 234."),
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
    // Both rows still reach the ledger, so the clean one is recorded as clean.
    const added = ledgerRows().slice(start);
    expect(added.map(x => x.withheldBy)).toEqual(["DUPLICATE", null]);
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

  test("FG-51 CONTROL: a blocked command still records every row, clean ones included", () => {
    // The ledger is what makes the block affordable: nothing is withheld with
    // no artefact anywhere, which is the failure the old predicate avoided.
    const start = ledgerRows().length;
    runHook(HOOK, `${DUPLICATE_FILING} && ${NOVEL_FILING}`);
    const added = ledgerRows().slice(start);
    expect(added).toHaveLength(2);
    expect(added.map(x => x.emitted), "the clean row is recorded as clean").toEqual([false, true]);
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
});

/**
 * FG-45..FG-49: a refusal must refuse, and a corpus nobody could read is not
 * an empty one (#1318).
 *
 * Both findings here are the same mistake in two places: **a state that could
 * not be measured, reported as a state that passed.** The first shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, twice, in the gate written
 * to catch it.
 *
 * **The `blocking` predicate.** `rows.every(r => !r.emitted)` allowed any
 * command in which at least one clause was clean, so batching a refused
 * filing beside a novel one was a complete bypass — and the cheapest one,
 * because an agent filing several findings at once hits it by accident. The
 * argument for it was that blocking "takes the novel findings down with a
 * duplicate". That step does not hold: this is a **PreToolUse** hook, so
 * nothing has executed. A block costs one re-run with the duplicate clause
 * removed; the findings are in the agent's context, not destroyed. An allow
 * costs a tracker row somebody has to triage. The note the allow emitted said
 * *"Please withdraw them and re-run"* — asking for an action the allow had
 * just made impossible, since a filing that already happened cannot be
 * withdrawn by the agent that made it.
 *
 * **The ledger was lying in the flattering direction.** Rows are written with
 * `disposition: "DROP"` and `withheldBy` set BEFORE `blocking` is computed,
 * so every allowed-anyway refusal was recorded as a successful withhold. Any
 * rate derived from the ledger counted those as saves. FG-47 is the row that
 * fails if the two ever disagree again.
 *
 * **`trustedCorpus` was fail-open.** A non-empty issue list that filters down
 * to empty — every author untrusted, or every issue over the key cap — was
 * returned as `[]`, which is byte-identical to a clean tracker, and the gate
 * ALLOWed. `null` already means UNMEASURED here and already routes to the
 * right refusal, so the fix is to return it.
 */
describe("FG-45..FG-49: a bypass by batching, and a corpus nobody could read", () => {
  const MIXED = `${DUPLICATE_FILING} && ${NOVEL_FILING}`;

  /** The fixture corpus path, which `openFindings` shares with the live one. */
  const fixtureCorpus = async (rows: unknown[]): Promise<readonly Finding[] | null> => {
    const file = join(scratch, "unmeasured-corpus.json");
    writeFileSync(file, JSON.stringify(rows));
    const prior = process.env.RUNGATE_OPEN_FINDINGS;
    process.env.RUNGATE_OPEN_FINDINGS = file;
    try {
      return await openFindings(scratch);
    } finally {
      if (prior === undefined) delete process.env.RUNGATE_OPEN_FINDINGS;
      else process.env.RUNGATE_OPEN_FINDINGS = prior;
    }
  };
  const existing = async (): Promise<readonly Finding[]> => [
    { id: "900", title: "retryBudget gives up early", body: DUPLICATE_BODY },
  ];

  test("FG-45 BASELINE: a duplicate batched beside a novel filing still refuses", async () => {
    const r = await filingGate(MIXED, { projectRoot: scratch, readExisting: existing });
    // The premise, asserted rather than assumed: this command really does
    // carry one of each. Without it the row could pass on a command the
    // parser never split, which is green for the wrong reason.
    expect(r.rows, "the fixture must carry two clauses").toHaveLength(2);
    expect(r.rows.filter(x => x.emitted), "exactly one of them is clean").toHaveLength(1);
    expect(r.refusal, "one refused clause refuses the command").not.toBeNull();
  });

  test("FG-46 CONTROL: a command whose clauses are ALL novel is still allowed", async () => {
    // The control against "refuse everything", which would make FG-45 green
    // and the gate useless. Same call, same corpus, no duplicate clause.
    const r = await filingGate(`${NOVEL_FILING} && ${NOVEL_FILING}`, {
      projectRoot: scratch,
      readExisting: existing,
    });
    expect(r.rows).toHaveLength(2);
    expect(r.refusal).toBeNull();
  });

  test("FG-47: the ledger cannot record a DROP for a filing the gate let through", async () => {
    // The instrument check. A row saying `emitted: false` is a claim that the
    // filing did not happen, and that claim is only true when the command was
    // blocked. Asserting the agreement rather than either side alone is what
    // makes this fail if a later change reintroduces partial admission
    // without also fixing the rows.
    for (const cmd of [MIXED, NOVEL_FILING, DUPLICATE_FILING]) {
      const r = await filingGate(cmd, { projectRoot: scratch, readExisting: existing });
      const withheld = r.rows.filter(x => !x.emitted);
      expect(
        withheld.length > 0 ? r.refusal !== null : true,
        `${cmd.slice(0, 40)}: rows claim ${withheld.length} withheld, refusal=${r.refusal === null ? "null" : "set"}`,
      ).toBe(true);
    }
  });

  test("FG-48 BASELINE: a corpus that filters down to empty is UNMEASURED, not clean", async () => {
    // Driven through `openFindings`, the production reader, not through a
    // helper written alongside the fix — a new binding asserted by a new
    // case is green on arrival and proves nothing. One issue IS present and
    // the key cap drops it, so the reading is "could not be taken", and
    // before this it came back `[]` and allowed.
    const stuffed = Array.from({ length: MAX_KEYS_PER_EXISTING_ISSUE + 10 }, (_, i) => `\`stuffedSymbol${i}\``).join(" ");
    const row = { number: 77, title: "a stuffed issue", body: stuffed };
    // The premise, asserted rather than assumed. My first fixture spelled
    // these `stuffed0`, which the key reader does not treat as a symbol at
    // all — so nothing was over the cap, nothing was dropped, and the case
    // was measuring a corpus that passed straight through while claiming to
    // measure one that had been emptied.
    expect(
      symptomKeys({ id: "77", title: row.title, body: row.body }).length,
      "the fixture must exceed the cap, or this row is about nothing",
    ).toBeGreaterThan(MAX_KEYS_PER_EXISTING_ISSUE);
    expect(
      await fixtureCorpus([row]),
      "every issue dropped is not the same fact as no issues",
    ).toBeNull();
  });

  test("FG-49 CONTROL: a genuinely empty tracker is MEASURED and still allows", async () => {
    // The row that separates "nothing was there" from "nothing survived the
    // filter". Without it the cheapest fix for FG-48 is `always null`, which
    // switches the dedupe off entirely and passes FG-48 while making the
    // gate useless — the fifth shape, green under the wrong repair.
    expect(await fixtureCorpus([]), "an empty tracker is a reading that WAS taken").toEqual([]);
    expect(
      await fixtureCorpus([{ number: 78, title: "retryBudget gives up early", body: DUPLICATE_BODY }]),
      "and an ordinary issue still reaches the corpus",
    ).toHaveLength(1);
  });
});
