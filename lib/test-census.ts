/**
 * test-census.ts — how many tests each file declares, before and after
 *
 * #307 SC-A19. Run `wf_5cdce852-1e2`'s heal loop went from 34 tests to 23
 * across two rounds, with no `skip` and no `todo` recorded. Most of that
 * rewrite was a fair consolidation; three guards had nothing replacing them,
 * and the only thing that noticed was `SECURITY_REVIEW_STALE` — which was
 * looking at something else.
 *
 * A heal agent is told a gate failed and asked to make it pass. Deleting the
 * test is a correct solution to that instruction and an incorrect solution to
 * the problem, and the gate cannot tell the difference afterwards: a suite
 * with the failing test removed is green, and green is what it was asked for.
 *
 * So the count is taken on every gate run and compared to the previous one.
 * Every heal round ends in a gate re-run, so "between gate runs" and "across
 * a heal" are the same window, and the comparison lives where it can be
 * executed by a test rather than in `workflows/ship.js`, which has no
 * filesystem access and could only have asked an agent to do it.
 *
 * This module is the counting and the comparison; `gates/gate-executor.ts`
 * holds the refusal and decides when to bank a new reading.
 *
 * ## The erasure this used to permit, and what closed it (#494)
 *
 * The banked census lives in the run's `workflow-state.json`, which is a
 * file the heal agent can write — `workflows/ship.js` hands it the file by
 * name, with a working `writeWorkflowState` recipe. A heal agent that
 * deleted a test AND the census saw `first-reading` on the next round and
 * passed, because `first-reading` increments neither `fails` nor `warns`.
 * `writeWorkflowState`'s Zod validation did not help: an absent optional
 * key is valid.
 *
 * Since #494 the gate SIGNS the banked census — `signCensus` in
 * `gates/witness.ts`, HMAC over the sorted reading and the run's slug —
 * and stores the signature beside it. The signature alone cannot close the
 * hole, because an agent erasing the census erases the signature with it
 * and the two absences are identical. The second half is a fact the state
 * file does not hold: `~/.rungate/<slug>/witnesses/`, written by
 * `writeWitness` on every gate run and named by no prompt. An unsigned or
 * mismatched census where a witness already exists is UNMEASURED, which is
 * a WARN in this gate, and no longer a first reading.
 *
 * ## What it still does NOT do, stated rather than implied
 *
 * Tamper-EVIDENT, not tamper-proof, and that is the intended goal. The gate
 * salt is readable by anything running as this user, so an agent that knows
 * where it lives can re-sign a census it rewrote. It can also delete the
 * witness directory, which puts the run back to looking like a first round.
 * Both are a different and louder act than deleting a key out of a file the
 * prompt told it to edit, and neither is what the accidental deletion on
 * `wf_5cdce852-1e2` looked like.
 *
 * Closing THAT means a store the run cannot write at all — an append-only
 * log off the machine, or a signing key the gate process does not hold.
 * Filed rather than half-done here. A guard whose limit is written down is
 * a guard somebody can finish; one whose limit is implied is one everybody
 * assumes is complete.
 *
 * ## Why a declaration count and not a run
 *
 * Running the suite twice per heal round costs this project about thirteen
 * minutes a round. A static count costs milliseconds and answers the question
 * actually asked — "did a test stop existing" — rather than "did the number of
 * passing tests go down", which also moves when a heal legitimately fixes a
 * failure.
 *
 * It is deliberately a count of DECLARATIONS, including `.skip` and `.todo`.
 * A heal that converts a failing test to `test.todo` has removed the check
 * just as thoroughly as deleting it, and that conversion is the cheapest way
 * past a count that only looked at live tests.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { testDeclarations } from "./test-case-bodies";

/**
 * Directories a census never walks into.
 *
 * The walk is the whole project, NOT a fixed list of test directories. A
 * `["test", "gates"]` list is rungate's own layout, and a consumer that keeps
 * its tests beside its sources — `src/foo.test.ts`, which is the commonest
 * JavaScript convention there is — would census to `{}` on every run. An
 * empty census compares clean against an empty census forever, so the guard
 * would be dead for exactly the projects it is supposed to protect, and
 * nothing would say so.
 */
export const CENSUS_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "test-fixtures",
  "worktrees",
]);

/**
 * What counts as a test file.
 *
 * The JS/TS family only, stated rather than implied: a consumer whose suite
 * is pytest or `go test` censuses to `{}`, and `censusVerdict` reports that
 * as UNMEASURED rather than as nothing-removed. "We cannot see this
 * project's tests" is a different answer from "no test was removed", and
 * only the first one is honest about a polyglot repo.
 */
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * A file this large is not a hand-written suite, and reading it into memory
 * on every gate run is a cost with no reading behind it.
 *
 * Oversized files are skipped, which is safe BECAUSE the cap is stable: a
 * file over it is absent from both censuses and never reads as a deletion.
 * The one case that does produce a false refusal is a file crossing the cap
 * between rounds, and that is the direction to be wrong in — loudly, naming
 * the file, rather than quietly dropping a test from the comparison.
 */
export const MAX_CENSUS_FILE_BYTES = 2_000_000;

/**
 * Which reader took a census, stamped beside it (#883).
 *
 * A census is BANKED per run and compared round to round, so the first round
 * after this module's reader changes compares an old number against a new
 * one and every file whose count moved reads as a regression. A reading
 * taken with a different instrument is not comparable with one taken by
 * this one, and the honest answer to an incomparable pair is UNMEASURED
 * rather than either verdict.
 *
 * `"1"` is the pre-#883 reader and is never written — a banked census with
 * no stamp IS version 1, which is how the migration is detected at all.
 *
 * **Bump this whenever `testDeclarations` changes what it counts.** Not when
 * it changes how it is spelled: the stamp is about comparability of numbers,
 * and a refactor that moves no count costs every in-flight run a round of
 * UNMEASURED for nothing.
 *
 * **It IS covered by the signature, and the first draft of #883 said the
 * opposite.** That draft's docblock read *"It is NOT a security control…
 * the stamp is not covered by `signCensus`, so an agent that can edit the
 * state file can edit it — but that agent can already delete the census
 * outright."* Both halves are wrong, and writing the sentence is what
 * stopped the question being asked:
 *
 * - Flipping this one byte is CHEAPER than deleting the census and much
 *   quieter. The census still verifies, so the round reports a WARN whose
 *   text explains an ordinary migration and refuses nothing.
 * - `nextCensus` banks the current reading on a reader change, by design —
 *   so the lowered count becomes the baseline and the NEXT round is clean.
 *   The erasure #494 exists to catch is laundered into the record.
 *
 * `signStampedCensus` in `gates/witness.ts` signs the census and this stamp
 * together. A forged or deleted stamp reads `unverified`; an absent one is
 * checked against the v1 payload, which is what a real pre-#883 file has.
 * Still tamper-evident rather than tamper-proof: the boundary is the salt.
 */
export const TEST_CENSUS_READER = "2";

/**
 * How many tests a source file declares.
 *
 * A projection of `testDeclarations`, which is the one binding deciding what
 * a declaration is (#883). Before that it had its own expression, and the
 * two disagreed on 174 of this tree's 483 test files: `gates/gate-executor.ts`
 * refused a round on THIS count while the deletion reading named cases from
 * the other, so an operator handed *"30 test(s) before, 27 after"* beside a
 * list of 8 case names could not reconcile them.
 *
 * ## Comments ARE excluded now, and the old rationale was backwards
 *
 * This docblock used to read:
 *
 *   > Comments are NOT stripped. A commented-out test is a removed test, and
 *   > stripping would make "comment the block out" a way past the guard.
 *
 * The second sentence is inverted, and it is worth leaving the correction
 * here rather than quietly deleting it. Only a DECREASE is refused. With
 * comments counted, commenting a test out leaves the number unchanged, so
 * the guard does not fire — the hole the sentence describes was the one the
 * policy created. Measured on the pre-#883 reader:
 *
 *     countTestDeclarations('test("a", () => {})')     → 1
 *     countTestDeclarations('// test("a", () => {})')  → 1
 *
 * Excluding comments makes the count drop, which is exactly the refusal the
 * guard exists for. The same scan also excludes a `test(` sequence inside a
 * string, a template or a regex, which is where ~225 of the old reader's 443
 * extra matches on this tree came from — prose, counted as coverage.
 */
export function countTestDeclarations(source: string): number {
  return testDeclarations(source).length;
}

/**
 * `{ "test/a.test.ts": 12, … }` for every test file anywhere under `root`.
 *
 * Pass a `skipped` array to be told which files the walk declined to read.
 * Optional so the common caller stays a one-liner, and the gate passes one
 * so it can say so rather than reporting over a comparison that quietly
 * excluded something.
 */
export function censusOf(root: string, skipped: string[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (CENSUS_SKIP.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), r);
      } else if (e.isFile() && TEST_FILE.test(e.name)) {
        // `isFile()`, not `!isDirectory()`. A dirent for a symlink answers
        // false to both, so this walk follows no links in either direction:
        // no symlinked-directory loop, and no `readFileSync` on a link to a
        // character device, which has size 0 and never ends.
        const p = join(dir, e.name);
        if (statSync(p).size > MAX_CENSUS_FILE_BYTES) {
          // Named, not dropped. A skip the caller cannot see is a file
          // silently outside the comparison, which is the shape this whole
          // guard exists to refuse — and a reader looking at "no test was
          // removed" deserves to know which files that sentence is not
          // about.
          skipped.push(r);
          continue;
        }
        out[r] = countTestDeclarations(readFileSync(p, "utf-8"));
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * Files that lost tests between two censuses, named with both numbers.
 *
 * Three rules, and the second is the one a naive implementation misses:
 *
 *   - a file whose count DROPPED is a regression
 *   - a file that DISAPPEARED is a regression of its whole count — deleting
 *     the file is the obvious way past a per-file comparison
 *   - a file that APPEARED is not a regression, and neither is a rise
 *
 * An empty census `before` returns nothing. That is correct and worth
 * stating: it means the guard cannot refuse when it never got a reading, and
 * the caller is responsible for noticing that it got one. A comparison that
 * refused on an absent baseline would fire on every first round.
 */
export function censusRegressions(
  before: Record<string, number>,
  after: Record<string, number>,
): string[] {
  const out: string[] = [];
  for (const [file, was] of Object.entries(before).sort()) {
    const now = after[file];
    if (now === undefined) {
      if (was > 0) out.push(`${file}: the file declared ${was} test(s) and is gone`);
    } else if (now < was) {
      out.push(`${file}: ${was} test(s) before, ${now} after`);
    }
  }
  return out;
}
