/**
 * #590 — proving `scripts/check-state-record-closes.ts` can refuse.
 *
 * Every negative case runs TWICE: once against the real script, and once
 * against a mutant copy whose single exported exit-code constant is set to 0.
 * The second run is the evidence. A test that only asserts "exit code != 0"
 * cannot tell a refusal from a crash, a typo, or a module-resolution failure
 * — and `.claude/rules/checks-must-be-able-to-fail.md` counts five shipped
 * bugs of exactly that shape in one day.
 *
 * The mutant also has to be observed RUNNING, not merely exiting 0: a script
 * that died before reaching the comparison exits 0 under no circumstances,
 * but a script whose import failed looks identical to one that found nothing.
 * So each case asserts the mutant still printed the refusal it declined to
 * act on.
 *
 * `test/rook-review-scope.test.ts` is the worked example this copies.
 *
 * ## What was broken to prove it
 *
 * Run and counted rather than asserted, over this file plus
 * `test/closing-keywords.test.ts` (59 tests). Every count was predicted
 * before the battery ran, as `.claude/rules/checks-must-be-able-to-fail.md`
 * requires, and each mutant was checked against an input on which it and the
 * original differ.
 *
 * | Mutation | Predicted | Red |
 * |---|---|---|
 * | `stateRecordCloseViolations` short-circuited to `return []` | 12 | **13** |
 * | the colon separator removed — `fixed: #586` stops matching | 7 | 7 |
 * | the `\b` in front of the keyword stem removed | 1 | 1 |
 * | the declared-but-unclosed loop short-circuited | 3 | 3 |
 * | `BANKED` in the live-record case emptied | 1 | 1 |
 *
 * The first row came back one HIGH, and the extra red is "the same issue
 * closed twice in two texts is one finding" — a case that genuinely depends
 * on the mutated behaviour and that the prediction simply failed to
 * enumerate, not a crashing mutant. Every other case touching the comparison
 * went red, which is the discriminator that section prescribes.
 *
 * Two rows are worth keeping for what they say about the SHAPE of the
 * coverage rather than its size:
 *
 *   - the colon row does NOT include the live-record case. The live record
 *     is the only fixture nobody wrote, and it is blind to a narrowing of
 *     the detector — it can only witness a close the detector still sees.
 *     The form table is the thing holding that line.
 *   - the `BANKED` row is 1, which is what makes the live-record case a
 *     witness rather than a subset assertion that is true of everything. It
 *     fails when the bank is emptied, so it is reading the real #586.
 *
 * None of the five is left in the tree; all were run and reverted, and
 * `scripts/check-state-record-closes.ts` was confirmed byte-identical
 * afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-state-record-closes.ts");
const source = readFileSync(SCRIPT, "utf-8");
const REPO = "hornjason/pai-harness";

// ── The mutant ───────────────────────────────────────────────────────────
//
// Built once, in a temp directory OUTSIDE the repo. Running it from there is
// what proves the script has no relative imports: a later `from "../lib/..."`
// would make every mutant die on module resolution, exiting non-zero, which
// would read as "the mutation was rejected on the merits" when in fact the
// mutant never ran.

let MUTANT = "";
let MUTANT_DIR = "";
let FIX = "";

beforeAll(() => {
  MUTANT_DIR = mkdtempSync(join(tmpdir(), "state-closes-mutant-"));
  const mutated = source.replace(/STATE_CLOSES_REFUSE_EXIT\s*=\s*1\b/, "STATE_CLOSES_REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error(
      "could not build the mutant: no `STATE_CLOSES_REFUSE_EXIT = 1` in " +
        "scripts/check-state-record-closes.ts",
    );
  }
  MUTANT = join(MUTANT_DIR, "check-state-record-closes.ts");
  writeFileSync(MUTANT, mutated);

  FIX = mkdtempSync(join(tmpdir(), "state-closes-fix-"));
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** A `project-state.json` holding one session, written to a scratch path. */
function stateFile(name: string, session: unknown): string {
  const dir = join(FIX, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project-state.json");
  writeFileSync(path, JSON.stringify({ updated: "2026-10-17", priorities: [], phases: [], sessions: [], session }, null, 2));
  return path;
}

/**
 * Assert a case is refused, and that the refusal is what is being observed.
 *
 * `reason` must match the real run's stderr AND the mutant's: the mutant is
 * the same code with the exit removed, so a mutant that printed nothing
 * either crashed or never reached the comparison, and in both of those a
 * `code === 0` means nothing at all.
 */
function expectRefused(args: string[], reason: RegExp) {
  const real = run(SCRIPT, args);
  expect(real.code, `expected a refusal for [${args.join(" ")}]\n${real.err}`).not.toBe(0);
  expect(real.err).toMatch(reason);

  const mutant = run(MUTANT, args);
  expect(
    mutant.err,
    `the mutant printed nothing for [${args.join(" ")}] — it crashed or never reached ` +
      `the comparison, so its exit code is not evidence.\n${mutant.err}`,
  ).toMatch(reason);
  expect(
    mutant.code,
    `the mutant (STATE_CLOSES_REFUSE_EXIT = 0) still exited ${mutant.code} for ` +
      `[${args.join(" ")}] — this case is not being caught by the refusal under test.\n${mutant.err}`,
  ).toBe(0);
}

// ── The property the mutant protects ─────────────────────────────────────

describe("#590 AC-6: the refusal is routed through exactly one exit code", () => {
  test("STATE_CLOSES_REFUSE_EXIT is declared once", () => {
    const decls = source.match(/STATE_CLOSES_REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("every process.exit goes through it", () => {
    const exits = source.match(/process\.exit\(([^)]*)\)/g) || [];
    expect(exits.length, "no process.exit at all — nothing can refuse").toBeGreaterThan(0);
    for (const e of exits) {
      expect(
        e,
        `${e} bypasses STATE_CLOSES_REFUSE_EXIT, so the mutant cannot neutralise it and the ` +
          `negative cases below would pass for the wrong reason`,
      ).toBe("process.exit(STATE_CLOSES_REFUSE_EXIT)");
    }
  });

  test("the script has no relative imports", () => {
    // Without this, the mutant run from a temp directory dies on module
    // resolution — a non-zero exit that reads as a rejected mutation.
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, "a relative import would make every mutant run fail to resolve").toEqual([]);
  });
});

// ── The cases ────────────────────────────────────────────────────────────

describe("#590 AC-6: zeroing the exit constant turns the real refusals green", () => {
  test("an undeclared keyword-derived close — the #586 shape — refuses, and the mutant does not", () => {
    const path = stateFile("undeclared", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [508],
      summary:
        "#582 closed #508: the body was expect(true). Filed and not fixed: #586, where a " +
        "scaffold run rewrites spec criteria text.",
    });
    expectRefused(["--state", path, "--repo", REPO], /will CLOSE #586/);
  });

  test("a declared close with no keyword behind it refuses, and the mutant does not", () => {
    const path = stateFile("missing", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [508, 586],
      summary: "#582 closed #508: the body was expect(true).",
    });
    expectRefused(["--state", path, "--repo", REPO], /declares #586 closed/);
  });

  test("a qualified reference with no --repo refuses, and the mutant does not", () => {
    const path = stateFile("unknown-repo", {
      number: 49,
      date: "2026-10-17",
      suite: "green",
      issues_closed: [],
      summary: "fixes some-owner/some-repo#586",
    });
    expectRefused(["--state", path], /unknown/i);
  });

  test("an empty session summary refuses rather than reporting a clean record", () => {
    const path = stateFile("empty", {
      number: 49, date: "2026-10-17", suite: "green", issues_closed: [], summary: "   ",
    });
    expectRefused(["--state", path, "--repo", REPO], /no text was read/);
  });

  test("a state document with no session record refuses, and the mutant does not", () => {
    const dir = join(FIX, "no-session");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "project-state.json");
    writeFileSync(path, JSON.stringify({ updated: "2026-10-17", priorities: [], phases: [], sessions: [] }));
    expectRefused(["--state", path, "--repo", REPO], /no "session" record/);
  });

  test("an unreadable state file refuses, and the mutant does not", () => {
    expectRefused(["--state", join(FIX, "nope", "absent.json"), "--repo", REPO], /could not be read/);
  });

  test("an unparseable entry in 'Issues closed:' refuses, and the mutant does not", () => {
    const path = stateFile("bad-list", {
      number: 49, date: "2026-10-17", suite: "green",
      issues_closed: "508,not-a-number",
      summary: "#582 closed #508.",
    });
    expectRefused(["--state", path, "--repo", REPO], /not an issue number/);
  });

  test("an unknown option refuses, and the mutant does not", () => {
    expectRefused(["--nonsense", "x"], /unknown option/);
  });
});

describe("#590: the positive control — a record whose sets agree is not refused", () => {
  // An audit that refused every record would satisfy all eight cases above
  // and be worse than nothing.
  test("a clean record exits 0 and reports what it read", () => {
    const path = stateFile("clean", {
      number: 50,
      date: "2026-10-18",
      suite: "green",
      issues_closed: [586, 590],
      summary: "This closes #586 and fixes #590. Filed and not yet looked at: see #591.",
    });
    const real = run(SCRIPT, ["--state", path, "--repo", REPO]);
    expect(real.code, real.err).toBe(0);
    expect(real.out).toContain("OK");
    // Coverage, not merely a verdict: 36 of 426 and 426 of 426 are the same
    // PASS, and no reader can tell them apart from the output.
    expect(real.out).toMatch(/\d+ of \d+ texts read/);
    expect(real.out).toContain("2 in this repository");
  });

  test("the title, the body and the commit message are all read", () => {
    // A check that read only the summary would pass a PR whose BODY carries
    // the keyword, which is where a `Closes #N` line usually lives.
    const path = stateFile("texts", {
      number: 50, date: "2026-10-18", suite: "green", issues_closed: [], summary: "a clean summary",
    });
    const body = join(FIX, "texts", "body.md");
    writeFileSync(body, "Closes #777\n");
    expectRefused(["--state", path, "--repo", REPO, "--body-file", body], /will CLOSE #777/);

    const message = join(FIX, "texts", "message.txt");
    writeFileSync(message, "docs: record session 50\n\nresolves #778\n");
    expectRefused(["--state", path, "--repo", REPO, "--message-file", message], /will CLOSE #778/);

    expectRefused(["--state", path, "--repo", REPO, "--title", "fix #779 at last"], /will CLOSE #779/);
  });
});
