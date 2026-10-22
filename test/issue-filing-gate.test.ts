/**
 * #1261 — the finding arbiter is wired into the `gh issue create` chokepoint.
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

import { listOpenIssues } from "../lib/github";
import {
  adjudicateFiling,
  filingAttempts,
  FILING_OVERRIDE_LABEL,
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

/** Same symptom as #900, different prose. Must be refused as a DUPLICATE. */
const DUPLICATE_FILING =
  'gh issue create --title "retryBudget gives up early on long command sweeps" ' +
  '--body "Measured over 5060 invocations: `retryBudget` in lib/command-retry.ts ' +
  'completes 144 of 234."';

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
    expect(attempts[0].bodyFromFile).toBe(false);
  });

  test("FG-2: a command that creates nothing yields no attempt", () => {
    expect(filingAttempts('echo "gh issue create --title x"')).toEqual([]);
    expect(filingAttempts("gh issue list --state open")).toEqual([]);
  });

  test("FG-3: a create hidden behind a comment clause is still a create", () => {
    const attempts = filingAttempts('gh issue comment 900 --body ok && gh issue create --title "x"');
    expect(attempts).toHaveLength(1);
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
      bodyFromFile: false,
    };
    const v = await adjudicateFiling(attempt, async () =>
      OPEN_ISSUES.map(i => ({ id: String(i.number), title: i.title, body: i.body })),
    );
    expect(v.outcome).toBe("REFUSE");
    expect(v.refusal).toBe("DUPLICATE");
    expect(v.duplicateOf).toEqual(["900"]);
  });

  test("FG-18: a body-file filing is UNMEASURED, and says that rather than guessing", async () => {
    const v = await adjudicateFiling(
      { title: "retryBudget misbehaves", body: "", labels: [], bodyFromFile: true },
      async () => [],
    );
    expect(v.outcome).toBe("UNMEASURED");
    expect(v.reason).toContain("in a file");
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
