/**
 * #659 AC-6 — absence is not the finding. A case that was RED at the
 * previous build commit and then deleted does not fire the check.
 *
 * The defect this guards against is the one this whole repo keeps meeting:
 * a check whose verdict is a constant. "This name is gone" is true of a
 * deleted passing test, of a deleted failing test, of a renamed test and of
 * a test that was moved to another file — and only the first is the thing
 * `wf_2abbe96f-546` did. A check that fires on absence alone would refuse
 * every ordinary rename, and would be switched off within a week.
 *
 * So the reading has three outcomes and not two:
 *
 *   CLEAN       nothing left, or what left was not green before
 *   DELETED     a case the previous build commit PROVED green is gone
 *   UNMEASURED  the previous commit's ledger does not say — which is NOT
 *               "the case was red", the distinction
 *               `lib/suite-run-reading.ts` exists for
 *
 * ## The fixture is executed, not described
 *
 * The ledger here is a real bun JUnit report, produced by really running a
 * file with two passing cases and one failing one, and the deletion is a
 * real git pair in a scratch repository. A hand-written
 * `{passed: [...], failed: [...]}` would prove the reading can read an
 * object; it would not prove that a failing case reaches it as failing
 * (`.claude/rules/checks-must-be-able-to-fail.md`, "the fixture has to be
 * measured on the producing side too").
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { deletedCases, deletionReading, ledgerFromJunit, type DeletedCase } from "../../lib/test-case-deletion";

const GREEN_A = "a case that passes and is then deleted";
const GREEN_B = "a second case that passes and is then deleted";
const RED = "a case that fails and is then deleted";

const WITH_CASES = `import { expect, test } from "bun:test";
test(${JSON.stringify(GREEN_A)}, () => { expect(1).toBe(1); });
test(${JSON.stringify(GREEN_B)}, () => { expect(2).toBe(2); });
test(${JSON.stringify(RED)}, () => { expect(1).toBe(2); });
`;

const WITHOUT_CASES = `import { expect, test } from "bun:test";
test("the case that survived the repair", () => { expect(1).toBe(1); });
`;

let root = "";
let before = "";
let after = "";
let ledgerPath = "";
let deleted: DeletedCase[] = [];

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deleted-case-"));
  mkdirSync(join(root, "test"), { recursive: true });
  const file = join(root, "test", "repair.test.ts");

  git(["init", "-q", "-b", "main"]);
  writeFileSync(file, WITH_CASES);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "the commit the gate graded"]);
  before = git(["rev-parse", "HEAD"]).trim();

  // The ledger, MEASURED: the previous build commit's own suite, run for
  // real, with two cases green and one red.
  ledgerPath = join(root, "gate-verify-junit.xml");
  spawnSync("bun", ["test", "test/repair.test.ts", "--reporter=junit", `--reporter-outfile=${ledgerPath}`], {
    cwd: root,
    encoding: "utf-8",
  });

  writeFileSync(file, WITHOUT_CASES);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "the repair commit"]);
  after = git(["rev-parse", "HEAD"]).trim();

  deleted = deletedCases(root, before, after);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("#659 AC-6: the ledger is real", () => {
  test("the previous commit's run reports two passes and one failure", () => {
    // The premise. If the report could not be read, or if the failing case
    // came back green, every verdict below would be about something else.
    const ledger = ledgerFromJunit(ledgerPath);
    expect(ledger.status).toBe("MEASURED");
    if (ledger.status !== "MEASURED") return;
    expect(ledger.passed).toEqual([GREEN_A, GREEN_B]);
    expect(ledger.failed).toEqual([RED]);
  });

  test("all three cases really were deleted", () => {
    expect(deleted.map(d => d.name).sort()).toEqual([GREEN_A, GREEN_B, RED].sort());
  });
});

describe("#659 AC-6: what fires and what does not", () => {
  test("the two cases that were GREEN fire; the one that was RED does not", () => {
    const reading = deletionReading(deleted, ledgerFromJunit(ledgerPath));
    expect(reading.verdict).toBe("DELETED");
    if (reading.verdict !== "DELETED") return;
    expect(reading.cases.map(c => c.name).sort()).toEqual([GREEN_A, GREEN_B].sort());
    expect(reading.cases.map(c => c.name), "a red case was reported as a deleted proof").not.toContain(RED);
  });

  test("a run in which every deleted case was red is CLEAN", () => {
    // Absence alone cannot satisfy the check. Same deletions, different
    // ledger — so this case varies exactly one thing, and it is the one the
    // check is supposed to be about.
    const reading = deletionReading(deleted, {
      status: "MEASURED",
      passed: ["something else entirely"],
      failed: [GREEN_A, GREEN_B, RED],
    });
    expect(reading.verdict).toBe("CLEAN");
  });

  test("a case the ledger never ran is UNMEASURED, not red and not clean", () => {
    const reading = deletionReading(deleted, { status: "MEASURED", passed: [GREEN_A], failed: [] });
    expect(reading.verdict).toBe("UNMEASURED");
    if (reading.verdict !== "UNMEASURED") return;
    expect(reading.reason).toContain(GREEN_B);
    expect(reading.reason).toContain(RED);
    // …and the deletion it could not judge is still reported, because an
    // operator who has to resolve an UNMEASURED needs the names.
    expect(reading.cases.map(c => c.name)).toContain(GREEN_B);
  });

  test("an unreadable ledger is UNMEASURED and says why", () => {
    const reading = deletionReading(deleted, ledgerFromJunit(join(root, "no-such-report.xml")));
    expect(reading.verdict).toBe("UNMEASURED");
    if (reading.verdict !== "UNMEASURED") return;
    expect(reading.reason).toMatch(/could not be read|ENOENT/);
  });

  test("nothing deleted is CLEAN even when there is no ledger at all", () => {
    // The arm that keeps the check usable. A ledger is only needed to judge
    // a deletion, so a round that deleted nothing must not refuse for want
    // of one — otherwise every run refuses and the refusal stops meaning
    // anything.
    const reading = deletionReading([], { status: "UNMEASURED", reason: "no report was written" });
    expect(reading.verdict).toBe("CLEAN");
  });

  test("the reading is a projection of the same lists, not a second decider", () => {
    // A DELETED reading may not also be UNMEASURED, and vice versa. One
    // discriminator, per `.claude/rules/config-access.md`.
    const unjudgeable = deletionReading(deleted, { status: "MEASURED", passed: [GREEN_A], failed: [RED] });
    expect(unjudgeable.verdict).toBe("UNMEASURED");
    const judged = deletionReading(deleted, { status: "MEASURED", passed: [GREEN_A, GREEN_B], failed: [RED] });
    expect(judged.verdict).toBe("DELETED");
  });

  test("a ledger naming the case under its full describe chain still counts", () => {
    // bun's JUnit report carries `outer > inner > case name`; the deletion
    // reading carries the bare name the source declares. A matcher that
    // demanded equality would read every case inside a describe block as
    // never having run, and UNMEASURED would be the only verdict this check
    // ever produced on a real suite.
    const reading = deletionReading(deleted, {
      status: "MEASURED",
      passed: [`#646 outer > inner > ${GREEN_A}`, `#646 outer > ${GREEN_B}`],
      failed: [`#646 outer > ${RED}`],
    });
    expect(reading.verdict).toBe("DELETED");
    if (reading.verdict !== "DELETED") return;
    expect(reading.cases.map(c => c.name).sort()).toEqual([GREEN_A, GREEN_B].sort());
  });
});
