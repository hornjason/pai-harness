/**
 * #669: a command whose output quantity is not the threshold's quantity.
 *
 * Measured on run `wf_448af2c4-6c1` (#664). AC-6's threshold counts **red test
 * cases**:
 *
 *     >= 11  "converted cases red when the helper returns the whole document…"
 *
 * and its command counts **matching lines of prose in a markdown section**:
 *
 *     awk '/^## Ten guards…/,/^## [^T]/' specs/HARNESS-STANDARD.md \
 *       | grep -ciE 'whole document.*(predicted|measured)|predicted.*measured'
 *
 * Both sides are integers, so the comparison is well-typed and meaningless.
 * The gate returned FAIL on correct, complete work and sent the run into a
 * repair cycle that would have been asked to make a line count in a markdown
 * file reach eleven, which no honest record produces.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward NOT refusing, like every other clause in `satisfiabilityRefusal`. A
 * unit that names no quantity this knows, or names one compatible with what
 * the command counts, is accepted. The refusal fires only on a DECLARED unit
 * that is provably about a different quantity — which is why the negative
 * controls below are as load-bearing as the positive ones.
 *
 * ## The cheapest wrong fix, named
 *
 * Widen AC-7's threshold from `== 1` to `>= 1` and leave the unit alone (the
 * parent issue names this one itself). It makes the symptom go away for AC-7
 * and touches nothing about the class — and these cases survive it, because
 * none of them reads a threshold VALUE. The one that would go green under it
 * is a case asserting "AC-7 fails", and there is deliberately no such case
 * here: AC-7's defect in this clause's terms is its absent literal, which
 * `test/evidence-literal-interface.test.ts` owns.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { satisfiabilityRefusal } from "../lib/evidence-satisfiability";
import { stripJsComments } from "../lib/strip-js-comments";

const REPO_ROOT = join(import.meta.dir, "..");

interface FixtureAc {
  id: string;
  threshold?: { op?: string; value?: string | number; unit?: string };
  evidenceMethod?: { type?: string; command?: string };
}

const FIXTURE: { acs: FixtureAc[] } = JSON.parse(
  readFileSync(join(REPO_ROOT, "test", "fixtures", "ac-set-664.json"), "utf-8"),
);

const ac664 = (id: string): FixtureAc => {
  const found = FIXTURE.acs.find((a) => a.id === id);
  if (!found) throw new Error(`the #664 fixture no longer carries ${id}`);
  return found;
};

/** An AC with exactly the three fields this clause reads. */
const ac = (command: string, unit: string | undefined, op = ">=", value: string | number = 1) => ({
  id: "AC-1",
  evidenceMethod: { type: "COMMAND", command },
  threshold: { op, value, ...(unit === undefined ? {} : { unit }) },
});

describe("#669 AC-1: the fixture is the real AC set, not a convenient retelling", () => {
  // A case that replays a fixture proves nothing about the run it names if the
  // fixture has drifted into an illustration. These assert the two fields the
  // clause reads are the ones the run recorded, so the battery below cannot
  // pass over a fixture somebody simplified.
  test("AC-6 carries the run's own threshold unit and its own command", () => {
    const a = ac664("AC-6");
    expect(a.threshold?.unit).toBe(
      "converted cases red when the helper returns the whole document, with predicted and measured counts both recorded",
    );
    expect(a.threshold?.op).toBe(">=");
    expect(a.threshold?.value).toBe(11);
    expect(a.evidenceMethod?.command).toContain("grep -ciE");
    expect(a.evidenceMethod?.command).toContain("specs/HARNESS-STANDARD.md");
  });

  test("no test reads the #664 AC set out of ~/.rungate", () => {
    // ~/.rungate/pai-harness-664 is a run directory: it is not in the
    // repository, it is deleted between runs, and a scan over an absent AC set
    // finds no defects — which reads exactly like an AC set with nothing wrong
    // with it. The fixture is committed for that reason, so the prohibition is
    // asserted rather than written in a comment.
    const offenders: string[] = [];
    for (const f of new Bun.Glob("test/**/*.test.ts").scanSync(REPO_ROOT)) {
      // Comments are stripped first. Several files DESCRIBE the run directory
      // a defect was measured in — `~/.rungate/pai-harness-254/…` — which is
      // provenance and exactly what this repo asks for. A scan that could not
      // tell prose from a read would make those two the same thing, which is
      // the defect `.claude/rules/checks-must-be-able-to-fail.md` calls a
      // detector narrower than what it detects, inverted.
      // A run directory is a legitimate thing for a test to build a path into
      // — a dozen files do, for work dirs and artefacts. The prohibited shape
      // is narrower and is the one this fixture replaces: reading a run's AC
      // SET out of one.
      const code = stripJsComments(readFileSync(join(REPO_ROOT, f), "utf-8"));
      if (/\.rungate[^\n"'`]*(?:workflow-state|ac-set|\bacs\b)/.test(code)) offenders.push(f);
    }
    expect(offenders, "a test reads an AC set from a run directory").toEqual([]);
  });
});

describe("#669 AC-1: a declared unit that is not what the command counts", () => {
  test("#664 AC-6 is refused, naming the id, the unit text and the counted thing", () => {
    const refusal = satisfiabilityRefusal(ac664("AC-6"));
    expect(refusal, "the #664 AC-6 unit mismatch was accepted").not.toBeNull();
    expect(refusal, "the refusal does not name the AC").toContain("AC-6");
    expect(refusal, "the refusal does not quote the declared unit").toContain(
      "converted cases red when the helper returns the whole document",
    );
    expect(refusal, "the refusal does not say what the command counts").toMatch(/lines/i);
  });

  test("a count of lines declared as a count of tests, files, words or bytes", () => {
    for (const unit of [
      "converted cases red under the mutation",
      "test files read by the scan",
      "assertions that go red",
      "words of prose",
      "bytes written",
    ]) {
      expect(
        satisfiabilityRefusal(ac(`grep -c 'x' specs/S.md`, unit)),
        `a grep -c counting lines was accepted with unit "${unit}"`,
      ).not.toBeNull();
    }
  });

  test("the counted thing follows the command, not a table of guesses", () => {
    // `wc -l` after something that prints FILE NAMES counts files, so "files"
    // is the right unit there and the wrong one after a plain grep. Without
    // this pair the clause could key on the word alone and still be green.
    expect(satisfiabilityRefusal(ac(`grep -rl 'x' lib | wc -l`, "files holding the marker"))).toBeNull();
    expect(satisfiabilityRefusal(ac(`find lib -name '*.ts' | wc -l`, "files in lib"))).toBeNull();
    expect(
      satisfiabilityRefusal(ac(`grep -c 'x' lib/a.ts`, "files holding the marker")),
      "grep -c prints one count per FILE, so it can never be a count of files",
    ).not.toBeNull();
    expect(satisfiabilityRefusal(ac(`wc -w lib/a.ts`, "lines of prose"))).not.toBeNull();
  });
});

describe("#669 AC-1: the negative controls, which are what make it usable", () => {
  test("a unit that agrees with the counted thing is accepted", () => {
    for (const [command, unit] of [
      [`grep -c 'x' lib/a.ts`, "matching lines in lib/a.ts"],
      [`grep -c 'x' lib/a.ts`, "occurrences of the marker"],
      [`grep -c 'x' lib/a.ts`, "violations remaining"],
      [`grep -c 'x' lib/a.ts`, "rows in the table"],
      [`grep 'x' lib/a.ts | wc -l`, "lines"],
      [`wc -w lib/a.ts`, "words of prose"],
      [`grep -rl 'x' lib | wc -l`, "paths still carrying the read"],
    ] as const) {
      expect(satisfiabilityRefusal(ac(command, unit)), `${command} // ${unit}`).toBeNull();
    }
  });

  test("a command whose output is not a count is not inspected for unit agreement", () => {
    // #664 AC-1 and AC-4 are plain `bun test` runs declaring units about
    // windows and sites. Nothing here can say what a test run's output IS, so
    // nothing here refuses it.
    expect(satisfiabilityRefusal(ac664("AC-1"))).toBeNull();
    expect(satisfiabilityRefusal(ac664("AC-4"))).toBeNull();
    expect(satisfiabilityRefusal(ac(`cat f.ts`, "test cases"))).toBeNull();
  });

  test("an absent or empty unit is not refused by this clause", () => {
    // Deliberate, and the reason is in `test/evidence-satisfiability.test.ts`:
    // every counting case there is written without a unit and expects null.
    // "An evidence command whose output is a count must declare what it
    // counts" is stated to Discovery in the prompt (asserted in
    // test/discovery-ac-validation.test.ts); it is not retro-enforced against
    // the thousands of unit-less ACs already in flight, because a refusal that
    // fires on every historical AC is a refusal everyone learns to widen.
    expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts`, undefined))).toBeNull();
    expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts`, "   "))).toBeNull();
  });

  test("a unit naming no quantity this knows is accepted", () => {
    for (const unit of [
      "fixed-character slice windows remaining in test/",
      "things",
      "converted test sites importing the shared helper",
      "SC ids covered",
    ]) {
      expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts`, unit)), unit).toBeNull();
    }
  });

  test("a unit naming BOTH quantities is accepted", () => {
    // "red cases, one per line of the table" names a compatible quantity as
    // well as an incompatible one, so the author has said how the two relate
    // and this is not the place to argue with them.
    expect(
      satisfiabilityRefusal(ac(`grep -c 'x' specs/S.md`, "red cases, one per matching line")),
    ).toBeNull();
  });
});
