/**
 * Anti-criteria — things that must NOT be true of the harness.
 *
 * Covers SC-737 of GATE-CONTRACTS-SPEC.md.
 */
import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import { remedyMessage } from "../lib/check-remedy";

const HARNESS = join(import.meta.dir, "..");

describe("Anti-Criteria: must NOT happen", () => {

  // SC-A1: No workflow file references specific projects
  //
  // #304. `findTsFiles` does not recurse, so for the whole life of this check
  // the three consumer references under `lib/scaffold/` were invisible to it
  // — a guard passing because of what it never looked at, in the file whose
  // entire job is refusing consumer specifics. It is now recursive, and the
  // three are held as an exact list below: a subdirectory left out of the
  // walk is a subdirectory nobody measures again, where a count refuses
  // growth and goes red as an instruction to delist.
  //
  // #924. The SECOND consumer's check was a bare
  // `expect(hits(needle)).toEqual([])` with no failure message, twelve lines
  // below a sibling that had a full one. On 2026-10-21 it reddened two
  // unrelated branches in four hours — `fix/887-detect-existing-pr` over
  // `lib/prior-branch.ts`, `fix/909-protection-gate` over
  // `lib/branch-protection.ts` — both times correctly, and both times
  // printing an array diff that named the file it found and nothing about
  // what to write instead. Adding a message to that one line would have
  // fixed one instance of a class, so the consumers are a TABLE now: the
  // message is generated from the row, and a third consumer cannot be added
  // without one.
  describe("SC-A1: no project-specific references in workflows", () => {
    /**
     * Every consumer the harness must not name, and the files each is still
     * allowed to be named in.
     */
    const CONSUMERS: { needle: string; known: string[] }[] = [
      {
        needle: "DailyBriefDashboard",
        // `lib/scaffold/managed-workflow.ts` delisted in #482: the comment
        // that named a consumer was on the merge path that issue deleted,
        // and the replacement says "a real consumer" with the detail in the
        // issue. The ratchet caught it the moment the file went clean, which
        // is the half of "both ways" that usually never fires.
        known: ["lib/scaffold/steps.ts"],
      },
      // Zero, and always has been, so there is no list to keep. A hit is
      // fixed in the source file it appeared in; there is nothing to add it
      // to, which is the whole reason the empty-set assertion is correct.
      { needle: "asaCommandCenter", known: [] },
    ];

    /**
     * What to write INSTEAD — the half the bare assertion left out, and the
     * half an agent staring at an array diff cannot derive.
     *
     * Provenance comments are wanted in this tree: `lib/scaffold/ai-review-step.ts`
     * cites run ids and pools at length and that is good practice. Only the
     * consumer's NAME is refused, and both branches #924 records tripped over
     * exactly that distinction while writing a note that was otherwise right.
     */
    const CONSUMER_FIX =
      `delete the NAME, keep the note. Write "a real consumer" or "one consumer" where ` +
      `the name was, and put the repository, the run id and the file in the GitHub issue, ` +
      `which is where that detail is readable and where it does not ship to every other ` +
      `consumer (#304). A runtime string naming a consumer is the same violation and ` +
      `worse, because it reaches output rather than only the source. Do NOT add the file ` +
      `to its row in CONSUMERS in test/anti.test.ts — that list only shrinks.`;

    const hits = (needle: string) =>
      findTsFiles(HARNESS, ["gates", "scripts", "lib"])
        .filter(f => readFileSync(f, "utf-8").includes(needle))
        .map(f => f.slice(HARNESS.length + 1))
        .sort();

    for (const { needle, known } of CONSUMERS) {
      const title = known.length
        ? `no ${needle} references outside the known list`
        : `no ${needle} references`;

      test(title, () => {
        const unexpected = hits(needle).filter(f => !known.includes(f));
        expect(
          unexpected,
          remedyMessage({
            root: HARNESS,
            check: `SC-A1 (${needle})`,
            violations: unexpected,
            fix: CONSUMER_FIX,
          }),
        ).toEqual([]);
      });

      // Only where there IS a list that can go stale. With an empty `known`
      // the ratchet is the assertion above with its filter removed — a
      // duplicate case carrying a message about delisting something that was
      // never listed, which is worse output than no case at all.
      if (known.length === 0) continue;

      test(`the ${needle} known list is exactly what is there — it ratchets both ways`, () => {
        // A stale entry is as bad as a missing one: it reads as a measured
        // exception while naming a file that no longer has the problem.
        const found = hits(needle);
        const moved = [
          ...found.filter(f => !known.includes(f)).map(f => `${f} (new, not listed)`),
          ...known.filter(f => !found.includes(f)).map(f => `${f} (listed, now clean)`),
        ];
        expect(
          found,
          remedyMessage({
            root: HARNESS,
            check: `SC-A1 (${needle} known list)`,
            violations: moved,
            fix:
              `DELIST the file you cleaned from the ${needle} row of CONSUMERS in ` +
              `test/anti.test.ts. The list only shrinks — never add an entry to silence a ` +
              `NEW mention; that one is fixed in the source file (#304, #482). ` +
              `If "the walk reaches subdirectories" is ALSO red, delist nothing: the walk ` +
              `stopped reaching the file and it is still there, which is the exact pair ` +
              `#304 measured.`,
          }),
        ).toEqual(known);
      });
    }

    test("the walk reaches subdirectories — planted control", () => {
      // The assertions above would pass vacuously against a non-recursive
      // walk, which is exactly how they passed before #304. `lib/scaffold/`
      // is the directory it could not see.
      const files = findTsFiles(HARNESS, ["lib"]).map(f => f.slice(HARNESS.length + 1));
      expect(
        files.some(f => f.startsWith("lib/scaffold/")),
        "the walk never reached lib/scaffold/, so every consumer-name assertion above is " +
          "passing over a fraction of the tree — which is how #304 stayed green for a " +
          "month. Restore the recursion in findTsFiles at the bottom of this file; do not " +
          "relax the assertions it feeds.",
      ).toBe(true);
      expect(
        files.length,
        `the walk found ${files.length} files under lib/, and lib/ has held far more than ` +
          "30 since #304 — so the walk is reading a fraction of the tree and the " +
          "assertions above are vacuous. Fix findTsFiles, not this number.",
      ).toBeGreaterThan(30);
    });
  });

  // SC-A2: No hardcoded file paths in rungate.json generation
  describe("SC-A2: no hardcoded paths in config generation", () => {
    test("no dashboard/src/App.tsx in scaffold", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(
        scaffold,
        "scripts/scaffold-project.ts spells one consumer's file path as a literal. A " +
          "scaffolded project decides its own layout, so read the path from the project's " +
          "own config through lib/config-loader.ts and emit what it says. If the scaffold " +
          "genuinely needs a path before any config exists, derive it from an argument the " +
          "caller passes — a literal here is wrong for every project but the one it came " +
          "from (#304).",
      ).not.toContain("dashboard/src/App.tsx");
    });

    test("no callGemini patterns in scaffold", () => {
      const scaffold = readFileSync(join(HARNESS, "scripts/scaffold-project.ts"), "utf-8");
      expect(
        scaffold,
        "scripts/scaffold-project.ts names a consumer's own helper function. Generate " +
          "from the project's config rather than from a symbol that exists in exactly one " +
          "repository; if the generated code needs to call something, take its name from " +
          "config and say in the template why (#304).",
      ).not.toContain("callGemini");
    });
  });

  // SC-A3: No "PAI" references in runtime paths
  describe("SC-A3: no PAI naming in runtime paths", () => {
    test("no .pai- prefixed paths in gate/lib code", () => {
      const files = findTsFiles(HARNESS, ["gates", "lib", "scripts"]);
      for (const f of files) {
        const content = readFileSync(f, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comments and strings that are documentation
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
          // Check for .pai- in actual path construction
          if (line.match(/["'`].*\.pai-/) && !line.includes("CLAUDE.md") && !line.includes("doc-type")) {
            expect(
              `${f}:${i + 1}: ${line.trim()}`,
              "a runtime path is still spelled with the `.pai-` prefix, which is this " +
                "harness's old name. Rename the path to its `.rungate` spelling and " +
                "migrate any on-disk directory with it — do NOT widen the skip conditions " +
                "a few lines above to step over the line, and do not move the literal into " +
                "a comment to get past the comment skip. Documentation may say `.pai-` " +
                "freely; a path a running harness constructs may not.",
            ).not.toMatch(/\.pai-/);
          }
        }
      }
    });

    test("lock files use rungate naming", () => {
      // Per file rather than over the concatenation the check used to build:
      // the property is the same — a pattern cannot span two files unless it
      // straddles the join, which is not a case anyone means — and a failure
      // can then name the file instead of printing the whole of `lib/` as the
      // received value (#924).
      const offenders = findTsFiles(HARNESS, ["gates", "lib", "scripts"])
        .filter(f => /pai-testing-lock|\.pai-lock/.test(readFileSync(f, "utf-8")))
        .map(f => f.slice(HARNESS.length + 1))
        .sort();
      expect(
        offenders,
        "a lock file is still named with the harness's old `pai` prefix. Rename it to its " +
          "`rungate` spelling at every position that constructs or reads it — the writer, " +
          "the reader and the cleanup path — in one change, because a half-rename leaves " +
          "two locks that cannot see each other. Narrowing the pattern here is not the fix.",
      ).toEqual([]);
    });
  });

  // SC-A4: Generated briefs minimize inferable content
  test.todo("SC-A4: generated briefs minimize inferable content");

  // SC-A5: External tool findings never silently dropped
  test.todo("SC-A5: external tool findings never silently dropped");

  // SC-A6: Composite scoring never rewards inferable heading presence
  test.todo("SC-A6: composite scoring excludes inferable headings");
});

/**
 * Recursive since #304. The flat version read only the top level of each
 * directory, so every check in this file that joined its output and searched
 * the result was reporting on a fraction of the tree it claimed to cover.
 */
function findTsFiles(root: string, dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dirPath: string) => {
    if (!existsSync(dirPath)) return;
    for (const e of readdirSync(dirPath, { withFileTypes: true })) {
      const p = join(dirPath, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "test-fixtures") continue;
        walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        files.push(p);
      }
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return files;
}
