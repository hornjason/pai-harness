/**
 * #661 criterion 5 — a deletion you meant is waived per case, and only with
 * a reason.
 *
 * Modelled on `scripts/verify-merge-content.ts`, which is the only place in
 * this repository those two flags exist and the model the criterion names.
 * The rule it borrows is the whole point: **an `--accept` with no `--reason`
 * is refused**, because a waiver nobody has to account for is a warning
 * nobody reads, and a check whose refusal can be switched off for free is a
 * check that will be switched off.
 *
 * The waiver lives in `deletionReading`, not in the script. A script that
 * filtered its own input before calling the library would be a second
 * decider agreeing with the first, and a mutation of either would leave the
 * other holding every case up — `.claude/rules/checks-must-be-able-to-fail.md`,
 * the fourth shape. The cases below drive BOTH: the library directly, and
 * the script as a subprocess, so the flag and the decision cannot drift.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { deletionReading, type DeletedCase, type PassLedger } from "../../lib/test-case-deletion";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "verify-no-deleted-cases.ts");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const KEPT = "the one that stays";
const GONE_A = "the one the repair deleted";
const GONE_B = "the other one the repair deleted";

const DELETED: DeletedCase[] = [
  { name: GONE_A, file: "test/a.test.ts" },
  { name: GONE_B, file: "test/a.test.ts" },
];
const LEDGER: PassLedger = { status: "MEASURED", passed: [GONE_A, GONE_B, KEPT], failed: [] };

/** A repo whose second commit removes two passing cases from one file. */
function repoWithDeletion(): { root: string; previous: string; current: string } {
  const root = mkdtempSync(join(tmpdir(), "deletion-waiver-"));
  made.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(root, "test"), { recursive: true });

  const before = `import { test } from "bun:test";
test("${KEPT}", () => {});
test("${GONE_A}", () => {});
test("${GONE_B}", () => {});
`;
  writeFileSync(join(root, "test/a.test.ts"), before);
  git("add", "-A");
  git("commit", "-q", "-m", "build 1");
  const previous = git("rev-parse", "HEAD");

  writeFileSync(join(root, "test/a.test.ts"), `import { test } from "bun:test";\ntest("${KEPT}", () => {});\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "build 2 — the repair round");
  const current = git("rev-parse", "HEAD");
  return { root, previous, current };
}

/** A JUnit ledger saying all three cases passed at the previous commit. */
function junit(root: string): string {
  const p = join(root, "ledger.xml");
  writeFileSync(
    p,
    `<?xml version="1.0"?><testsuites><testsuite name="test/a.test.ts">` +
      [KEPT, GONE_A, GONE_B].map(n => `<testcase name="${n}" classname="test/a.test.ts"/>`).join("") +
      `</testsuite></testsuites>\n`,
  );
  return p;
}

const runScript = (args: string[]) =>
  spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });

describe("#661-5: the waiver is per case, and only with a reason", () => {
  test("without a waiver the deletion is refused — the premise of every case below", () => {
    // Read first. If this were already CLEAN the waiver cases would pass
    // without the waiver doing anything, which is a fixture satisfying its
    // assertion by a route that bypasses the feature (#500).
    const r = deletionReading(DELETED, LEDGER);
    expect(r.verdict).toBe("DELETED");
    expect(r.cases.map(c => c.name).sort()).toEqual([GONE_B, GONE_A].sort());
  });

  test("waiving ONE case leaves the other refused", () => {
    const r = deletionReading(DELETED, LEDGER, { cases: [GONE_A], reason: "superseded by the table-driven case" });
    expect(r.verdict, "a waiver is per case, so one waiver cannot clear two deletions").toBe("DELETED");
    expect(r.cases.map(c => c.name)).toEqual([GONE_B]);
    expect(r.waived?.map(w => w.name)).toEqual([GONE_A]);
    expect(r.waived?.[0]?.acceptedReason).toBe("superseded by the table-driven case");
  });

  test("waiving every deleted case clears the verdict, and the record says so", () => {
    const r = deletionReading(DELETED, LEDGER, { cases: [GONE_A, GONE_B], reason: "both merged into one case" });
    expect(r.verdict).toBe("CLEAN");
    // The distinction that matters: CLEAN-by-waiving and CLEAN-by-deleting-
    // nothing must not be the same object, or the waiver is invisible in
    // the record and the next reader sees a round that deleted nothing.
    const cleanOutright = deletionReading([], LEDGER);
    expect(r.verdict).toBe(cleanOutright.verdict);
    expect(r).not.toEqual(cleanOutright);
    expect(r.waived).toHaveLength(2);
    for (const w of r.waived ?? []) expect(w.acceptedReason).toBe("both merged into one case");
  });

  test("a waiver that matches no deleted case is reported, not silently dropped", () => {
    const r = deletionReading(DELETED, LEDGER, { cases: [GONE_A, "a case that was renamed"], reason: "why" });
    expect(r.unusedWaivers).toEqual(["a case that was renamed"]);
  });

  /**
   * The cheapest wrong fix, named and guarded against: widen `matches` from
   * equality to a prefix.
   *
   * It is the 5pm repair and it is the one an operator asks for. The real
   * round this check exists for deleted FIVE cases from one file, three of
   * them sharing the literal prefix `SC-2092: `, and typing three
   * seventy-character names is exactly the friction that makes
   * `--accept SC-2092` look reasonable. One character of code — `===` to
   * `startsWith` — and it works.
   *
   * It is wrong because the waiver then covers deletions nobody read. The
   * three SC-2092 cases are three different claims; accepting one is not
   * accepting the other two, and under a prefix the operator never sees
   * them go by.
   *
   * None of the other cases in this file can see that fix. Their two names
   * share no prefix, so `startsWith` and `===` agree on every input they
   * supply, and all of them stay green over a waiver that has stopped being
   * per-case. This one is the witness, and the names are the production
   * ones verbatim so it stays pointed at the real shape.
   */
  test("a prefix the operator would reach for waives NOTHING, and says so", () => {
    const SC2092 = [
      "SC-2092: a tier promotion is a typed outcome carrying tier and promotion as fields",
      "SC-2092: a reinforcement already in the brief is its own outcome kind",
      "SC-2092: a brief with no section the rule belongs in is its own outcome kind",
    ];
    const deleted: DeletedCase[] = SC2092.map(name => ({ name, file: "test/compliance-report.test.ts" }));
    const ledger: PassLedger = { status: "MEASURED", passed: SC2092, failed: [] };

    // Waiving one by its FULL name leaves the other two refused, by name.
    const one = deletionReading(deleted, ledger, { cases: [SC2092[0]], reason: "folded into the table" });
    expect(one.verdict).toBe("DELETED");
    expect(one.cases.map(c => c.name)).toEqual([SC2092[1], SC2092[2]]);

    // The prefix waives nothing and is reported stale. Under `startsWith`
    // it would silently clear all three and this reads CLEAN.
    const prefix = deletionReading(deleted, ledger, { cases: ["SC-2092"], reason: "folded into the table" });
    expect(prefix.verdict, "a prefix is not a case name").toBe("DELETED");
    expect(prefix.cases).toHaveLength(3);
    expect(prefix.waived ?? []).toHaveLength(0);
    expect(prefix.unusedWaivers).toEqual(["SC-2092"]);
  });

  test("the waiver also covers a case the ledger cannot judge", () => {
    // An unjudged deletion is UNMEASURED rather than DELETED, and that is a
    // refusal too. A waiver that cleared only the DELETED arm would leave
    // the operator with a refusal they have already accounted for and no
    // way to say so.
    const thin: PassLedger = { status: "MEASURED", passed: [KEPT], failed: [] };
    expect(deletionReading(DELETED, thin).verdict).toBe("UNMEASURED");
    const r = deletionReading(DELETED, thin, { cases: [GONE_A, GONE_B], reason: "deleted deliberately" });
    expect(r.verdict).toBe("CLEAN");
    expect(r.waived).toHaveLength(2);
  });
});

describe("#661-5: the script refuses an unexplained waiver", () => {
  test("--accept with no --reason is refused, and the refusal names the cases", () => {
    const { root, previous, current } = repoWithDeletion();
    const r = runScript(["--project", root, "--previous", previous, "--current", current, "--accept", GONE_A]);
    expect(r.status, "an unexplained waiver must not be accepted").not.toBe(0);
    expect(r.stderr).toContain("REFUSED");
    expect(r.stderr).toContain(GONE_A);
    expect(r.stderr).toContain("--reason");
  });

  test("--reason with no --accept is refused, because it explains nothing", () => {
    const { root, previous, current } = repoWithDeletion();
    const r = runScript(["--project", root, "--previous", previous, "--current", current, "--reason", "because"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("explains nothing");
  });

  test("--accept with --reason clears the run, and the artefact carries both", () => {
    const { root, previous, current } = repoWithDeletion();
    const out = join(root, "deleted-cases.json");

    // The premise, measured in the same fixture: without the waiver this
    // run refuses. Otherwise the waived run below proves nothing.
    const refused = runScript([
      "--project", root, "--previous", previous, "--current", current, "--ledger", junit(root),
    ]);
    expect(refused.status, "the fixture must refuse before a waiver can be shown to clear it").not.toBe(0);
    expect(refused.stderr).toContain("DELETED_PASSING_TESTS");

    const r = runScript([
      "--project", root, "--previous", previous, "--current", current, "--ledger", junit(root),
      "--out", out,
      "--accept", GONE_A, "--accept", GONE_B, "--reason", "folded into one table-driven case",
    ]);
    expect(r.status, `expected a clear run, got: ${r.stderr}`).toBe(0);
    expect(r.stderr, "a waived round must not look like a clean one on the console").toContain("WAIVED");

    const artefact = JSON.parse(readFileSync(out, "utf-8"));
    expect(artefact.verdict).toBe("CLEAN");
    expect(artefact.waived.map((w: { name: string }) => w.name).sort()).toEqual([GONE_B, GONE_A].sort());
    for (const w of artefact.waived) {
      expect(w.acceptedReason, "the reason travels WITH the case, not beside it")
        .toBe("folded into one table-driven case");
    }
  });
});
