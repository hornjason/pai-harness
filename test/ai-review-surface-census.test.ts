/**
 * ai-review-surface-census.test.ts — the committed workflow came out of the
 * generator, and the test surface GREW (#857).
 *
 * ## AC-12: the output is not hand-edited, and not stale
 *
 * `lib/scaffold/ai-review-step.ts` is a generator and
 * `.github/workflows/ai-review.yml` is its output, committed. The project
 * rule is fix the source, not the output, and the failure that rule exists
 * for is invisible from CI: a hand-edited workflow behaves exactly as
 * intended, and the next `scaffold --fix` silently reverts it. Nothing in
 * #853 or #856 compared the two, so both could have landed correct in CI
 * and absent from the generator.
 *
 * The case regenerates into a scratch directory from this repository's own
 * `.claude/rungate/` config and compares the bytes. Not a step-by-step
 * containment check: two of those already exist, for the restore step and
 * the report script, and each of them passes over every line it does not
 * name. The whole file is the claim.
 *
 * ## AC-13: the surface grew rather than being replaced
 *
 * A suite whose count stayed flat while its subject changed is
 * indistinguishable from a suite whose disagreeing cases were rewritten to
 * agree with the new code — and rewriting them is the cheapest way to make
 * a changed script pass an existing suite. So the claim is not "the suite
 * is green"; it is that every case that existed before this work **still
 * exists**, by name.
 *
 * `.claude/ai-review-surface-ratchet.json` holds the 248 titles as they
 * stood at `bc56a7c2`, the commit before #853 merged. Measured at the time
 * of writing: 272 titles now, 0 of the 248 missing, 24 added.
 *
 * **The baseline is a committed file and not a `git show` of that commit,
 * deliberately.** CI checks out shallow, so the commit is frequently not in
 * the clone — and a reading that could not be taken is not a reading that
 * passed. A ratchet file is readable on every runner.
 *
 * Comparison is over a FLAT set of titles rather than per file, because a
 * case moved from one suite to another is a reorganisation and not a
 * deletion, and a per-file comparison would call it one.
 *
 * ## What this does NOT claim
 *
 * #857's AC-12 also asks that the whole ai-review surface still passes.
 * That is not asserted here. Spawning 272 cases from inside one of them
 * duplicates what the sharded CI job already does, costs minutes, and the
 * recursion makes the failure message worse rather than better. The green
 * `test-shard` jobs on the pull request are the evidence for that half, and
 * saying so is better than a case that re-runs the suite to produce a
 * number CI already printed.
 *
 * ## The cheapest wrong fix, named
 *
 * When `AC-13` goes red because a case was deliberately renamed, the 5pm
 * repair is to **regenerate the ratchet from HEAD**. It is one command, the
 * red goes away, and the ratchet then says "the surface today contains the
 * surface today" — which is true of every tree and evidence about none. A
 * rename edits its one entry; a deletion has to say why in the commit.
 * `AC-13c` is the control that keeps the comparison from being vacuous.
 * **The growth case is what refuses the regenerated baseline** — row P5
 * below is that repair applied, and it is 1 red.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file + `ai-review-untrusted-restore` +
 * `ai-review-workflow` — the two suites holding the pre-existing per-step
 * byte-identity cases (76 tests). Every count predicted before the battery
 * ran, in `/tmp/857-battery/predictions.md`, and **the baseline row was
 * read first**.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 0 fail | **76 pass, 0 fail** | — |
 * | P1 a line hand-added to the committed workflow | 1 | **1 of 76** | the committed file: the generator emits no `# hand-edited` comment above `jobs:` |
 * | P2 `caseTitles` short-circuited to `return []` | 3 | **3 of 76** | the live surface: 272 titles against 0 |
 * | P3 the ratchet's `titles` emptied, count left at 248 | 1 | **1 of 76** | the ratchet: `titles.length` 0 against `baselineTotal` 248 |
 * | P4 the `SELF` exclusion removed | 1 | **1 of 76** | `test/`: 18 surface files against 19 |
 * | P5 **the cheapest wrong fix**: the ratchet regenerated from HEAD | 1 | **1 of 76** | the ratchet: `baselineTotal` 272 against a surface of 272, so `>` fails |
 *
 * **P3 is 1 and not 2 by design, and that is the whole argument for
 * `AC-13c`.** With no titles in the ratchet, *"every case still exists"*
 * passes vacuously — the empty set is a subset of everything — and the
 * growth case still compares against an unchanged `baselineTotal`. The
 * instrument control is the only thing that can see it, which is why it
 * asserts in BOTH positions rather than only over the live surface.
 *
 * **P4 is why the `SELF` exclusion is asserted rather than just written.**
 * Removing it changes no verdict anywhere except the one case that looks
 * for it: the numbers simply get four bigger and the census starts counting
 * itself.
 *
 * None of the five mutations is left in the tree; all were restored from a
 * `cp` backup — never `git checkout --` — and all three mutated files were
 * confirmed byte-identical after every row by sha256.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_WORKFLOW_FILE } from "../lib/scaffold/ai-review-step";
import { createCiWorkflows } from "../lib/scaffold/steps";

const REPO = join(import.meta.dir, "..");
const RATCHET = join(REPO, ".claude", "ai-review-surface-ratchet.json");

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/**
 * Every `test("…")` / `it(`…`)` title in a suite. ONE binding, so there is
 * one thing to mutate; a second extractor would be two deciders agreeing.
 */
export function caseTitles(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)(?:test|it)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[2]);
  return out;
}

/**
 * This file's own name. It matches the surface glob, and counting its four
 * cases toward "the surface grew" would let the census satisfy its own
 * assertion — the self-reference trap `.claude/rules/self-referential-tests.md`
 * describes, met head on. The growth claim is about suites that test the
 * ai-review subject, not about the census of them.
 */
const SELF = "ai-review-surface-census.test.ts";

function surfaceFiles(): string[] {
  return readdirSync(join(REPO, "test"))
    .filter(f => /^ai-review-.*\.test\.ts$/.test(f) && f !== SELF)
    .sort();
}

function currentTitles(): string[] {
  return surfaceFiles().flatMap(f => caseTitles(readFileSync(join(REPO, "test", f), "utf-8")));
}

// ── AC-12: the committed workflow is the generator's output ─────────────

describe("AC-12 (#857): the committed ai-review workflow came out of the generator", () => {
  test("it is byte-identical to a fresh regeneration from this repo's config", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-regen-"));
    scratch.push(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    cpSync(join(REPO, ".claude", "rungate"), join(dir, ".claude", "rungate"), { recursive: true });

    createCiWorkflows(dir, []);

    const emittedPath = join(dir, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);
    expect(
      existsSync(emittedPath),
      "the generator wrote no ai-review workflow, so this case compared nothing",
    ).toBe(true);
    const emitted = readFileSync(emittedPath, "utf-8");
    const committed = readFileSync(
      join(REPO, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE),
      "utf-8",
    );

    // The coverage control. Two empty strings are byte-identical, and that
    // is what a generator that threw halfway or a mis-pointed path gives.
    expect(emitted.length, "the regenerated workflow is empty").toBeGreaterThan(2000);

    if (emitted !== committed) {
      const a = emitted.split("\n");
      const b = committed.split("\n");
      const first = a.findIndex((l, i) => l !== b[i]);
      throw new Error(
        `.github/workflows/${AI_REVIEW_WORKFLOW_FILE} is not what the generator emits — it was ` +
          `hand-edited, or the generator changed and nobody ran \`bun bin/rungate.ts scaffold . --fix\`.\n` +
          `First difference at line ${first + 1}:\n` +
          `  generator: ${JSON.stringify(a[first])}\n` +
          `  committed: ${JSON.stringify(b[first])}`,
      );
    }
  });
});

// ── AC-13: the surface grew, and nothing was quietly replaced ───────────

describe("AC-13 (#857): the ai-review test surface grew rather than moved", () => {
  const ratchet = JSON.parse(readFileSync(RATCHET, "utf-8")) as {
    baseCommit: string;
    baselineTotal: number;
    titles: string[];
  };

  test("AC-13c: the instrument reads something, in both positions", () => {
    // Without this the comparison below is satisfied by an extractor that
    // returns nothing: the empty set is a subset of everything, and a
    // regex that stopped matching is exactly how that happens.
    expect(ratchet.titles.length, "the ratchet is empty").toBe(ratchet.baselineTotal);
    expect(ratchet.baselineTotal).toBeGreaterThan(200);
    expect(surfaceFiles().length, "no ai-review suites were found").toBeGreaterThan(10);
    expect(
      currentTitles().length,
      "the title extractor read almost nothing from the live suites",
    ).toBeGreaterThan(200);

    // And that it reads a title it cannot have invented.
    expect(currentTitles()).toContain("AC-10: mode none does not run the check at all");

    // The census does not count itself. Asserted, because the exclusion is
    // one line and its absence is invisible — the numbers simply get four
    // bigger and every case here stays green.
    expect(existsSync(join(REPO, "test", SELF)), "SELF no longer names this file").toBe(true);
    expect(surfaceFiles(), "the census is counting its own cases").not.toContain(SELF);
  });

  test("every case that existed before this work still exists, by name", () => {
    const now = new Set(currentTitles());
    const gone = ratchet.titles.filter(t => !now.has(t));
    expect(
      gone,
      `cases present at ${ratchet.baseCommit.slice(0, 8)} and absent now. A case renamed on ` +
        `purpose edits its entry in .claude/ai-review-surface-ratchet.json in the same commit; ` +
        `a case deleted says why. Regenerating the whole ratchet from HEAD makes this green and ` +
        `makes it evidence about nothing`,
    ).toEqual([]);
  });

  test("and the surface is strictly larger than it was", () => {
    expect(
      currentTitles().length,
      `the ai-review surface has ${currentTitles().length} cases against ${ratchet.baselineTotal} ` +
        `at ${ratchet.baseCommit.slice(0, 8)}. Flat is the reading this case exists to refuse: a ` +
        `suite whose count held while its subject changed is indistinguishable from one whose ` +
        `disagreeing cases were rewritten to agree`,
    ).toBeGreaterThan(ratchet.baselineTotal);
  });
});
