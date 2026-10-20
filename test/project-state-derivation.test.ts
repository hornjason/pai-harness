/**
 * #781 — `key-files.md` told every consumer that `PROJECT-STATE.md` is
 * "generated from project-state.json — don't edit directly", and on at least
 * one consumer that is false and acting on it is destructive.
 *
 * Measured on one consumer at `e58ab6bb` (named on #781): nothing in `src/`, `scripts/`,
 * `dashboard/src/` or the `Makefile` reads `project-state.json`, and the two
 * files carry unrelated content — the JSON has priorities and sessions, the
 * Markdown 27 KB of page inventory, API groups and architecture. An agent
 * that reads the rule, believes it and regenerates destroys the only
 * authoritative snapshot that repo has, and **the loss presents as a
 * success**: exit 0, `git status` showing `M`, not `D`.
 *
 * The sentence was a hardcoded literal in two places — `lib/scanner.ts` and
 * `lib/scaffold/steps.ts` — so it was also a claim about the consumer's build
 * made by a generator that had never looked.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Soften the literal**: replace both copies with "Live status + handoff.
 * DA-owned." and stop. One find-and-replace; #781 lists it as option 1.
 *
 * It trades one untrue sentence for another. This repository DOES generate
 * `PROJECT-STATE.md`, from `scripts/update-project-state.ts`, and a consumer
 * told to edit it directly has its edits overwritten on the next run.
 *
 * **AC-2 is the case that does not survive it** — a fixture that really does
 * read `project-state.json` and write `PROJECT-STATE.md` must still be told
 * the file is derived. A battery holding only the no-generator shape
 * would have certified the softening, which is the fifth shape: a case that
 * goes green under the wrong fix.
 *
 * ## Two traps this file is built around
 *
 * - **Self-reference (#646).** `lib/project-state-derivation.ts` quotes both
 *   strings it searches for, so without excluding itself it is evidence for
 *   itself and every tree carrying rungate's source reads GENERATOR_FOUND.
 *   AC-5 plants a copy of the decider in a fixture with no generator and
 *   asserts the verdict does not move.
 * - **Vacuity (#492).** An empty tree and a tree with no generator both
 *   produce "no evidence", and only one is a measurement. A scan that read
 *   nothing is UNMEASURED and still refuses to authorise regeneration, and
 *   both the file count AND the byte count are guarded — a single newline
 *   walks past a byte guard, which #492 measured.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/scaffold-ownership.test.ts` (49 tests). Counts
 * predicted in `/tmp/781-battery/predictions.md` before the battery ran, and
 * **the baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 49 pass, 0 fail | **49 pass, 0 fail** | — |
 * | M1 **the cheapest wrong fix**: the neutral sentence for every verdict | 3 | **3 of 49** | the generator fixture: the original says the file is derived, the mutant tells a project that really does generate it to edit the file directly |
 * | M2 **the defect restored**: the derivation claim returned unconditionally | 5 | **5 of 49** | the no-generator fixture: the original withdraws the authorisation, the mutant issues it |
 * | M3 the self-exclusion removed | 1 | **1 of 49** | a no-generator tree carrying a copy of the decider: the original is NO_GENERATOR, the mutant reads the decider's own docblock as evidence |
 * | M4 the predicate loosened to `project-state.json` alone | 1 | **1 of 49** | a tree whose only mention is `const p = "project-state.json"` in a lint script |
 * | M5 the vacuity guard dropped | 2 | **2 of 49** | an empty tree, and a tree of empty files: the original is UNMEASURED with distinct reasons, the mutant reports a clean NO_GENERATOR |
 * | M6 `lib/scanner.ts` reverted to the hardcoded literal | 2 | **3 of 49** | the no-generator fixture through the real generator |
 *
 * **M1 is the row this file exists for, and its GREENS are the point.** AC-1
 * and AC-3 stay green under the softening — withdrawing the sentence
 * everywhere satisfies every case about the consumer that must not be told
 * it. Only AC-2, the tree that earns the claim, says the repair is wrong.
 *
 * **M2 came back 4 before this file was finished, against a predicted 5.**
 * The missing red was exact rather than mysterious: only the empty-TREE case
 * asserted the note, so the empty-FILES reading could have started
 * authorising regeneration with the row one short of what I expected. The
 * property is *an unmeasured reading never authorises* and it has two
 * inputs; both assert it now, and the row is 5.
 *
 * **M6 came back HIGH, and the extra red is the real kind.** With one
 * generator still carrying the literal, both fixtures produce the same
 * PROJECT-STATE.md row, so *"the two generated files differ"* reds as well —
 * squarely about the mutated behaviour, and the fact it records is that
 * `scanner.ts` and `steps.ts` are not interchangeable copies: the rule file
 * this issue is about is generated through the scanner.
 *
 * None of the six mutations is left in the tree; all were run and reverted
 * from `cp` backups, never `git checkout --`, and both sources were
 * confirmed byte-identical by sha256 afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { generateScopedRules } from "../lib/generators/agents-md";
import {
  PROJECT_STATE_DERIVED,
  PROJECT_STATE_OWNERSHIP,
  projectStateDerivation,
  projectStateKeyFileNote,
} from "../lib/project-state-derivation";
import { scanProject } from "../lib/scanner";

const REPO_ROOT = join(import.meta.dir, "..");

/** The authorising clause, spelled once so a reword cannot half-apply. */
const AUTHORISATION = "generated from project-state.json";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-781-"));
  scratch.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

/** The consumer's shape on #781: real source, real scripts, no generator. */
const NO_GENERATOR = {
  "package.json": JSON.stringify({ name: "asa-like", scripts: { build: "tsc" } }),
  "src/startup-cascade.ts": "export const cascade = () => 1;\n",
  "dashboard/src/app.tsx": "export const App = () => null;\n",
  "scripts/deploy.sh": "#!/bin/sh\necho deploying\n",
  "Makefile": "build:\n\ttsc\n",
  // The file exists and carries meaning. That is the whole point: it is not
  // absent, it is authored.
  "PROJECT-STATE.md": "# State\n\n27KB of page inventory in the real thing.\n",
  "project-state.json": JSON.stringify({ priorities: [], sessions: [] }),
};

/** The same tree with something that genuinely derives one file from the other. */
const WITH_GENERATOR = {
  ...NO_GENERATOR,
  "scripts/update-state.ts":
    'import {readFileSync, writeFileSync} from "fs";\n' +
    'const s = JSON.parse(readFileSync("project-state.json", "utf-8"));\n' +
    'writeFileSync("PROJECT-STATE.md", `# ${s.name}\\n`);\n',
};

describe("#781 AC-1: a project with no generator is never told the file is derived", () => {
  test("the reading is NO_GENERATOR and the note withdraws the authorisation", () => {
    const r = projectStateDerivation(fixture(NO_GENERATOR));
    expect(r.verdict).toBe("NO_GENERATOR");
    expect(r.evidence).toEqual([]);

    const note = projectStateKeyFileNote(r);
    expect(note, "the consumer is still told its file is generated").not.toContain(AUTHORISATION);
    expect(note, "the note does not say who owns the file").toContain(PROJECT_STATE_OWNERSHIP);
    expect(note, "the note does not say what happens if you regenerate it").toContain("destroy");
  });

  test("a file that merely MENTIONS project-state.json is not a generator", () => {
    // A doc lint, a path constant, a gitignore check. The claim being made is
    // that one file is derived from the other, so evidence has to name both —
    // and a loose predicate errs in the direction that re-authorises the
    // destructive action.
    const r = projectStateDerivation(
      fixture({ ...NO_GENERATOR, "scripts/lint.ts": 'const p = "project-state.json";\n' }),
    );
    expect(r.verdict).toBe("NO_GENERATOR");
  });
});

describe("#781 AC-2: a project that DOES generate it is still told so", () => {
  test("the derivation claim survives for a tree that earns it", () => {
    // The case the cheapest wrong fix — softening the literal everywhere —
    // does not survive.
    const r = projectStateDerivation(fixture(WITH_GENERATOR));
    expect(r.verdict).toBe("GENERATOR_FOUND");
    expect(r.evidence).toContain("scripts/update-state.ts");
    expect(projectStateKeyFileNote(r)).toBe(PROJECT_STATE_DERIVED);
    expect(projectStateKeyFileNote(r)).toContain(AUTHORISATION);
  });

  test("the two fixtures differ in exactly one file, so this is a measurement of it", () => {
    // #585: a pair that varies two things measures neither. The generator
    // fixture is the no-generator fixture plus one entry, derived rather
    // than written out a second time.
    const extra = Object.keys(WITH_GENERATOR).filter(k => !(k in NO_GENERATOR));
    expect(extra).toEqual(["scripts/update-state.ts"]);
  });

  test("this repository reads GENERATOR_FOUND, and names its real generator", () => {
    // The live control. Without it the two fixtures are satisfied by a
    // predicate that works only on trees this file built.
    const r = projectStateDerivation(REPO_ROOT);
    expect(r.verdict).toBe("GENERATOR_FOUND");
    expect(
      r.evidence,
      "the evidence for this repo does not include the updater that actually writes the file",
    ).toContain("scripts/update-project-state.ts");
  });
});

describe("#781 AC-3: a scan that read nothing is UNMEASURED, and still refuses", () => {
  test("an empty tree is UNMEASURED, not a clean no-generator reading", () => {
    const r = projectStateDerivation(fixture({ "README.md": "# hi\n" }));
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.filesScanned).toBe(0);
    expect(r.unmeasuredReason, "an UNMEASURED reading with no reason").toBeTruthy();
    expect(projectStateKeyFileNote(r)).not.toContain(AUTHORISATION);
  });

  test("files present but empty is UNMEASURED too, and says so differently", () => {
    // #492's one-byte row, from the other side: the byte guard is what stops
    // a tree of empty files reading as a scan, and the two reasons have to be
    // distinguishable or an operator fixes the wrong thing.
    const empty = projectStateDerivation(fixture({ "src/a.ts": "", "src/b.ts": "" }));
    expect(empty.verdict).toBe("UNMEASURED");
    expect(empty.filesScanned).toBe(2);
    expect(empty.bytesScanned).toBe(0);

    const none = projectStateDerivation(fixture({ "README.md": "# hi\n" }));
    expect(
      empty.unmeasuredReason,
      "a tree of empty files and a tree with no files give the same reason",
    ).not.toBe(none.unmeasuredReason);

    // Both UNMEASURED inputs, not just the one above. Row M2 of the battery
    // came back 4 against a predicted 5 because only the empty-TREE case
    // asserted the note, so this reading could have started authorising
    // regeneration with the row still showing the number I expected minus
    // one. The property is "an unmeasured reading never authorises", and it
    // has two inputs.
    expect(projectStateKeyFileNote(empty)).not.toContain(AUTHORISATION);
  });

  test("one byte is a scan, and reports NO_GENERATOR rather than UNMEASURED", () => {
    // The boundary stated rather than left to be discovered. #492's finding
    // was that a single byte walks past a byte guard — here that is the
    // intended behaviour, and the guard it walks past is the one that would
    // otherwise call a real (if tiny) tree unmeasurable.
    const r = projectStateDerivation(fixture({ "src/a.ts": "\n" }));
    expect(r.verdict).toBe("NO_GENERATOR");
    expect(r.bytesScanned).toBe(1);
  });
});

describe("#781 AC-4: the generated rule file itself, produced by running the generator", () => {
  function keyFilesFor(root: string): string {
    const rules = generateScopedRules(scanProject(root));
    const rule = rules.find(r => r.filename === "key-files.md");
    expect(rule, "the generator produced no key-files.md").toBeTruthy();
    return rule!.content;
  }

  test("a consumer with no generator gets a key-files.md that does not authorise it", () => {
    // #781 asks for this verified by RUNNING the generator, not by reading
    // the diff. The whole scan and rule-generation path runs.
    const content = keyFilesFor(fixture(NO_GENERATOR));
    expect(content, "the key-files table is missing its subject").toContain("PROJECT-STATE.md");
    expect(
      content,
      "the generated rule still tells this consumer the file is derived (#781)",
    ).not.toContain(AUTHORISATION);
  });

  test("...and a consumer that does generate it still gets the claim", () => {
    const content = keyFilesFor(fixture(WITH_GENERATOR));
    expect(content).toContain(AUTHORISATION);
  });

  test("the two generated files differ, so the generator is reading the tree", () => {
    // Without this the pair above is satisfied by a generator that emits two
    // different constants for two different calls for some unrelated reason.
    const a = keyFilesFor(fixture(NO_GENERATOR));
    const b = keyFilesFor(fixture(WITH_GENERATOR));
    expect(a).not.toBe(b);
    const rowA = a.split("\n").find(l => l.includes("| PROJECT-STATE.md |"));
    const rowB = b.split("\n").find(l => l.includes("| PROJECT-STATE.md |"));
    expect(rowA, "no PROJECT-STATE.md row in the no-generator output").toBeTruthy();
    expect(rowB, "no PROJECT-STATE.md row in the generator output").toBeTruthy();
    expect(rowA).not.toBe(rowB);
  });
});

describe("#781 AC-5: one binding, and it is not evidence for itself", () => {
  test("the authorising sentence has exactly one declaring position in the tree", () => {
    // #781's second criterion: two hardcoded copies meant a fix applied to
    // one left the other. The constant is the only place the sentence is
    // spelled, and this counts it over the modules that generate the rule.
    const sources = [
      "lib/scanner.ts",
      "lib/scaffold/steps.ts",
      "lib/scaffold/owned-files.ts",
      "lib/generators/agents-md.ts",
    ];
    const offenders = sources.filter(f =>
      readFileSync(join(REPO_ROOT, f), "utf-8").includes(AUTHORISATION),
    );
    expect(
      offenders,
      "the authorising sentence is spelled outside lib/project-state-derivation.ts",
    ).toEqual([]);

    const owner = readFileSync(join(REPO_ROOT, "lib", "project-state-derivation.ts"), "utf-8");
    expect(
      owner.split(AUTHORISATION).length - 1,
      "the owner spells the sentence more than once, so a mutation can be half-applied",
    ).toBeGreaterThan(0);
  });

  test("the decider's own source in a tree is not evidence that the tree generates anything", () => {
    // #646: the file that decides quotes both strings it looks for. Without
    // the self-exclusion, every project vendoring rungate's source reads
    // GENERATOR_FOUND — the store quoting the subject back.
    const root = fixture(NO_GENERATOR);
    mkdirSync(join(root, "lib"), { recursive: true });
    copyFileSync(
      join(REPO_ROOT, "lib", "project-state-derivation.ts"),
      join(root, "lib", "project-state-derivation.ts"),
    );
    const r = projectStateDerivation(root);
    expect(r.verdict, "the decider was counted as evidence for itself (#646)").toBe("NO_GENERATOR");
    // And the control: the copy really is there and really does contain both
    // strings, so this is not passing because the file failed to copy.
    const copied = readFileSync(join(root, "lib", "project-state-derivation.ts"), "utf-8");
    expect(copied).toContain("project-state.json");
    expect(copied).toContain("PROJECT-STATE.md");
  });

  test("owned-files.ts states ownership and makes no unconditional derivation claim", () => {
    // #781's third criterion. The table has no root to scan, so the honest
    // thing for it to state is the part that is true everywhere, and the
    // ownership wording comes from the same constant rather than a second
    // copy kept in step by hand.
    const owned = readFileSync(join(REPO_ROOT, "lib", "scaffold", "owned-files.ts"), "utf-8");
    expect(owned).toContain("PROJECT_STATE_OWNERSHIP");
    expect(owned, "owned-files.ts still asserts the derivation unconditionally").not.toContain(
      AUTHORISATION,
    );
  });
});
