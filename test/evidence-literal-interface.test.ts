/**
 * #669: a gate keyed to a string the implementer was never told was
 * load-bearing.
 *
 * Measured on run `wf_448af2c4-6c1` (#664). Both AC-6 and AC-7 opened their
 * `awk` range on the literal
 *
 *     ## Ten guards that cut a character count
 *
 * DISCOVERY invented that heading. It appears in neither the issue nor the
 * tree at `3a122903`. The implementer wrote a better one — eleven windows
 * across thirteen files is the measured count — the range came back empty,
 * and both gates read `0` over correct work.
 *
 * A literal the evidence greps for and the tree does not hold is a bet on the
 * implementer guessing a string nobody showed them. It is refused UNLESS the
 * same literal is carried into the implementer's brief as a named interface,
 * which is the one thing that turns a guess into a contract.
 *
 * ## What this deliberately does NOT do
 *
 * It does not refuse a literal merely because the tree lacks it. `grep -c
 * newThing src/` returning 0 before the work is done is what a CORRECT
 * acceptance criterion looks like — the module docstring says so — and the
 * difference between that and #664's heading is whether the implementer was
 * told. So the waiver is the subject of half the cases here.
 *
 * It also reads the tree through an injected `treeContains`. With no reader
 * in hand the clause is UNMEASURED and returns null: `satisfiabilityRefusal`
 * is a leaf and must stay one, and a clause that guessed at a project root
 * would refuse correct runs for a path it got wrong.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { satisfiabilityRefusal } from "../lib/evidence-satisfiability";

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

/** The heading DISCOVERY invented, quoted from the fixture's own command. */
const INVENTED_HEADING = "## Ten guards that cut a character count";

/**
 * A real reader over a real tree, not a stub.
 *
 * A stub `treeContains` would make every case here a test of the argument it
 * was handed. This walks files and asks the same question the production
 * reader has to: does any file's path or content hold this literal?
 */
function treeReader(root: string): (literal: string) => boolean {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  return (literal: string) =>
    files.some((f) => f.slice(root.length + 1).includes(literal) || readFileSync(f, "utf-8").includes(literal));
}

/** A tree shaped like the one #664 ran against: the spec exists, the heading does not. */
function treeWithout(): { root: string; contains: (l: string) => boolean } {
  const root = mkdtempSync(join(tmpdir(), "rungate-669-literal-"));
  mkdirSync(join(root, "specs"));
  writeFileSync(
    join(root, "specs", "HARNESS-STANDARD.md"),
    "# Harness standard\n\n## Some other section\n\nprose\n",
  );
  return { root, contains: treeReader(root) };
}

describe("#669 AC-2: a COMMAND evidence method keyed to a literal the tree does not hold", () => {
  test("#664 AC-7 is refused, and the refusal quotes the absent literal", () => {
    const { root, contains } = treeWithout();
    try {
      const refusal = satisfiabilityRefusal(ac664("AC-7"), { treeContains: contains });
      expect(refusal, "the invented heading was accepted").not.toBeNull();
      expect(refusal, "the refusal does not quote the literal the gate will key on").toContain(
        INVENTED_HEADING,
      );
      expect(refusal, "the refusal does not name the AC").toContain("AC-7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the same literal carried into the brief as a named interface is waived", () => {
    const { root, contains } = treeWithout();
    try {
      expect(
        satisfiabilityRefusal(ac664("AC-7"), {
          treeContains: contains,
          briefInterfaces: [INVENTED_HEADING],
        }),
        "a literal the brief names as an interface was still refused",
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the waiver is the SAME literal, not any literal", () => {
    // A waiver satisfied by the brief naming something else is a waiver that
    // waives everything. The implementer's heading is the one they actually
    // wrote on #664, and it is not the one the gate greps for.
    const { root, contains } = treeWithout();
    try {
      expect(
        satisfiabilityRefusal(ac664("AC-7"), {
          treeContains: contains,
          briefInterfaces: ["## Eleven guards cut a character count (#664, #666)"],
        }),
      ).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an AC that declares its own interfaces is waived too", () => {
    const { root, contains } = treeWithout();
    try {
      expect(
        satisfiabilityRefusal(
          { ...ac664("AC-7"), evidenceInterfaces: [INVENTED_HEADING] },
          { treeContains: contains },
        ),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a literal the tree already holds is not refused", () => {
    // The positive control. Without it a clause that refused every COMMAND
    // would satisfy every case above.
    const root = mkdtempSync(join(tmpdir(), "rungate-669-present-"));
    try {
      mkdirSync(join(root, "specs"));
      writeFileSync(
        join(root, "specs", "HARNESS-STANDARD.md"),
        `# Harness standard\n\n${INVENTED_HEADING}\n\nprose\n`,
      );
      expect(satisfiabilityRefusal(ac664("AC-7"), { treeContains: treeReader(root) })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#669 AC-2: the clause reports UNMEASURED rather than guessing", () => {
  test("with no tree reader the clause refuses nothing", () => {
    // Null is "not provably unsatisfiable", not "verified satisfiable". AC-7
    // has no other defect this decider can see, so it comes back clean — which
    // is the honest answer when nothing read the tree.
    expect(satisfiabilityRefusal(ac664("AC-7"))).toBeNull();
    expect(satisfiabilityRefusal(ac664("AC-7"), {})).toBeNull();
  });

  test("a non-COMMAND evidence method is not inspected for literals", () => {
    const { root, contains } = treeWithout();
    try {
      expect(
        satisfiabilityRefusal(
          {
            id: "AC-9",
            evidenceMethod: { type: "BUN_TEST", command: "bun test test/nothing-like-this-exists.test.ts" },
            threshold: { op: ">=", value: 2 },
          },
          { treeContains: contains },
        ),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#669 AC-2: what counts as a literal, in both directions", () => {
  const absentEverything = () => () => false;

  const refusalFor = (command: string) =>
    satisfiabilityRefusal(
      { id: "AC-1", evidenceMethod: { type: "COMMAND", command }, threshold: { op: ">=", value: 2 } },
      { treeContains: absentEverything() },
    );

  test("a regular expression is not quoted as an absent literal", () => {
    // `^## [^T]` is a pattern, not a string the tree can hold, and a refusal
    // demanding the implementer add it would be nonsense. Only the parts of a
    // command that are plain text are candidates.
    const refusal = refusalFor(`awk '/^## Real heading here/,/^## [^T]/' specs/S.md | grep -c 'x'`);
    expect(refusal, "the plain-text half of the awk range was not read").toContain(
      "## Real heading here",
    );
    expect(refusal, "a bracket expression was quoted back as an absent literal").not.toContain("[^T]");
  });

  test("short and metacharacter-bearing literals are left alone", () => {
    for (const command of [
      `grep -c 'x' lib/a.ts`,
      `grep -cE 'a+b.*c' lib/a.ts`,
      `grep -c "Foo|Bar" lib/a.ts`,
      `test -f lib/a.ts && echo yes`,
    ]) {
      expect(refusalFor(command), command).toBeNull();
    }
  });

  test("an absent marker long enough to be an interface is caught", () => {
    const refusal = refusalFor(`grep -c 'SATISFIABILITY_MARKER_669' lib/a.ts`);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("SATISFIABILITY_MARKER_669");
  });
});
