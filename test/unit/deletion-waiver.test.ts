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

import {
  WAIVER_SEPARATOR,
  deletionReading,
  type DeletedCase,
  type PassLedger,
} from "../../lib/test-case-deletion";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "verify-no-deleted-cases.ts");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const KEPT = "the one that stays";
const GONE_A = "the one the repair deleted";
const GONE_B = "the other one the repair deleted";
const FILE = "test/a.test.ts";
const COMPLIANCE = "test/compliance-report.test.ts";

/** A waiver as the refusal prints it: a waiver is copied, never retyped. */
const W = (name: string, file = FILE) => `${file}${WAIVER_SEPARATOR}${name}`;
const W_CLI = (name: string, file = FILE) => ["--accept", W(name, file)];

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
    const r = deletionReading(DELETED, LEDGER, { cases: [W(GONE_A)], reason: "superseded by the table-driven case" });
    expect(r.verdict, "a waiver is per case, so one waiver cannot clear two deletions").toBe("DELETED");
    expect(r.cases.map(c => c.name)).toEqual([GONE_B]);
    expect(r.waived?.map(w => w.name)).toEqual([GONE_A]);
    expect(r.waived?.[0]?.acceptedReason).toBe("superseded by the table-driven case");
  });

  test("waiving every deleted case clears the verdict, and the record says so", () => {
    const r = deletionReading(DELETED, LEDGER, { cases: [W(GONE_A), W(GONE_B)], reason: "both merged into one case" });
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
    const r = deletionReading(DELETED, LEDGER, { cases: [W(GONE_A), W("a case that was renamed")], reason: "why" });
    expect(r.unusedWaivers).toEqual([W("a case that was renamed")]);
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
    const deleted: DeletedCase[] = SC2092.map(name => ({ name, file: COMPLIANCE }));
    const ledger: PassLedger = { status: "MEASURED", passed: SC2092, failed: [] };

    // Waiving one by its FULL name leaves the other two refused, by name.
    const one = deletionReading(deleted, ledger, { cases: [`${COMPLIANCE}${WAIVER_SEPARATOR}${SC2092[0]}`], reason: "folded into the table" });
    expect(one.verdict).toBe("DELETED");
    expect(one.cases.map(c => c.name)).toEqual([SC2092[1], SC2092[2]]);

    // The prefix waives nothing and is reported stale. Under `startsWith`
    // it would silently clear all three and this reads CLEAN.
    const prefix = deletionReading(deleted, ledger, { cases: [`${COMPLIANCE}${WAIVER_SEPARATOR}SC-2092`], reason: "folded into the table" });
    expect(prefix.verdict, "a prefix is not a case name").toBe("DELETED");
    expect(prefix.cases).toHaveLength(3);
    expect(prefix.waived ?? []).toHaveLength(0);
    expect(prefix.unusedWaivers).toEqual([`${COMPLIANCE}${WAIVER_SEPARATOR}SC-2092`]);
  });

  /**
   * The same widening in the dimension a name cannot see.
   *
   * The real round deleted cases from TWO files at once — five from
   * `test/compliance-report.test.ts` and three from
   * `test/unit/hill-climb-receipt.test.ts`. Test files share names: `the
   * baseline`, `the control`, `it refuses`. A waiver keyed on the name
   * alone clears every file that declares it, and the operator who waived
   * one deletion never learns they waived two.
   *
   * Every other case in this file plants its cases in ONE file, so a
   * name-only matcher and a file-and-name matcher agree on all of them.
   * This is the only case that can tell them apart.
   */
  test("a case name shared by two files is waived in ONE of them", () => {
    const shared = "the baseline";
    const deleted: DeletedCase[] = [
      { name: shared, file: "test/a.test.ts" },
      { name: shared, file: "test/b.test.ts" },
    ];
    const ledger: PassLedger = { status: "MEASURED", passed: [shared], failed: [] };

    const r = deletionReading(deleted, ledger, { cases: [W(shared, "test/a.test.ts")], reason: "a's copy moved" });
    expect(r.verdict, "b's deletion was never accounted for").toBe("DELETED");
    expect(r.cases).toEqual([{ name: shared, file: "test/b.test.ts" }]);
    expect(r.waived?.map(w => w.file)).toEqual(["test/a.test.ts"]);
  });

  test("a waiver naming no file is refused, not matched on the name alone", () => {
    expect(() => deletionReading(DELETED, LEDGER, { cases: [GONE_A], reason: "why" }))
      .toThrow(/names no file/);
    // And the empty halves of the separator are refused too, so the form
    // cannot be satisfied by writing the separator and nothing else.
    expect(() => deletionReading(DELETED, LEDGER, { cases: [` ${WAIVER_SEPARATOR}${GONE_A}`], reason: "why" }))
      .toThrow(/empty file or case name/);
  });

  /**
   * The waiver records the ledger's reading; it does not erase it.
   *
   * Waiving a case the ledger proved GREEN is an operator saying "I removed
   * a passing test on purpose". Waiving one the ledger cannot judge is an
   * operator saying "I removed something and nobody knows what it was".
   * Both are permitted and they are not the same act, so a CLEAN that
   * reported them identically would have thrown away the distinction this
   * whole module exists to carry.
   */
  test("each waived case carries what the ledger said about it", () => {
    const partial: PassLedger = { status: "MEASURED", passed: [GONE_A], failed: [] };
    const r = deletionReading(DELETED, partial, { cases: [W(GONE_A), W(GONE_B)], reason: "both deliberate" });
    expect(r.verdict).toBe("CLEAN");
    expect(r.waived?.map(w => [w.name, w.ledgerReading])).toEqual([
      [GONE_A, "green"],
      [GONE_B, "unjudged"],
    ]);

    // A red deletion reads as red, not as unjudged — the distinction
    // `deletionReading` already makes for unwaived cases, made here too.
    const withRed: PassLedger = { status: "MEASURED", passed: [], failed: [GONE_A] };
    const red = deletionReading(DELETED, withRed, { cases: [W(GONE_A)], reason: "it was failing anyway" });
    expect(red.waived?.[0]?.ledgerReading).toBe("red");
  });

  test("the waiver also covers a case the ledger cannot judge", () => {
    // An unjudged deletion is UNMEASURED rather than DELETED, and that is a
    // refusal too. A waiver that cleared only the DELETED arm would leave
    // the operator with a refusal they have already accounted for and no
    // way to say so.
    const thin: PassLedger = { status: "MEASURED", passed: [KEPT], failed: [] };
    expect(deletionReading(DELETED, thin).verdict).toBe("UNMEASURED");
    const r = deletionReading(DELETED, thin, { cases: [W(GONE_A), W(GONE_B)], reason: "deleted deliberately" });
    expect(r.verdict).toBe("CLEAN");
    expect(r.waived).toHaveLength(2);
  });
});

describe("#661-5: the script refuses an unexplained waiver", () => {
  test("--accept with no --reason is refused, and the refusal names the cases", () => {
    const { root, previous, current } = repoWithDeletion();
    const r = runScript(["--project", root, "--previous", previous, "--current", current, ...W_CLI(GONE_A)]);
    expect(r.status, "an unexplained waiver must not be accepted").not.toBe(0);
    expect(r.stderr).toContain("REFUSED");
    expect(r.stderr).toContain(GONE_A);
    expect(r.stderr).toContain("--reason");
  });

  test("--accept naming no file is refused at the door, not reported as stale", () => {
    const { root, previous, current } = repoWithDeletion();
    const r = runScript([
      "--project", root, "--previous", previous, "--current", current,
      "--accept", GONE_A, "--reason", "deliberate",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSED");
    expect(r.stderr).toContain("names no file");
    // The distinction being protected: a bare name must NOT come back as a
    // stale waiver. That reads as a mistyped case name beside a refused
    // run, and sends the operator to check the name rather than the form.
    expect(r.stderr).not.toContain("STALE_WAIVER");
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
      ...W_CLI(GONE_A), ...W_CLI(GONE_B), "--reason", "folded into one table-driven case",
    ]);
    expect(r.status, `expected a clear run, got: ${r.stderr}`).toBe(0);
    expect(r.stderr, "a waived round must not look like a clean one on the console").toContain("WAIVED");

    // The ledger proved both green, so no WAIVED_UNMEASURED line — and a
    // run that waived something unjudgeable must say so, which is the
    // half that makes this assertion mean anything.
    expect(r.stderr).not.toContain("WAIVED_UNMEASURED");
    const noLedger = runScript([
      "--project", root, "--previous", previous, "--current", current,
      "--out", join(root, "no-ledger.json"),
      ...W_CLI(GONE_A), ...W_CLI(GONE_B), "--reason", "folded into one table-driven case",
    ]);
    expect(noLedger.status, "a waived round with no ledger still clears").toBe(0);
    expect(noLedger.stderr, "but it must not look like the measured one").toContain("WAIVED_UNMEASURED");

    const artefact = JSON.parse(readFileSync(out, "utf-8"));
    expect(artefact.verdict).toBe("CLEAN");
    expect(artefact.waived.map((w: { name: string }) => w.name).sort()).toEqual([GONE_B, GONE_A].sort());
    for (const w of artefact.waived) {
      expect(w.acceptedReason, "the reason travels WITH the case, not beside it")
        .toBe("folded into one table-driven case");
    }
  });
});
