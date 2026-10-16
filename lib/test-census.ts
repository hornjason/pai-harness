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
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

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
 * Declaration forms bun recognises. `test` and `it`, bare or with a modifier.
 *
 * Anchored on a word boundary so `subtest(` and `omit(` do not count, and
 * requiring the open paren so a bare mention in prose does not. The modifier
 * list is explicit rather than `\w+` because `test.each(...)(...)` and a
 * hypothetical `test.anything` should not silently start counting — an
 * unrecognised form is better as a miss we can see than as a count nobody
 * can explain.
 */
const DECLARATION =
  /(?<![.\w$])(?:test|it)(?:\.(?:skip|todo|only|failing|each|skipIf|todoIf|only))?\s*[(`]/g;

/**
 * How many tests a source file declares.
 *
 * Comments are NOT stripped. A commented-out test is a removed test, and
 * stripping would make "comment the block out" a way past the guard. The
 * cost is that prose saying `test(` counts, which inflates a file's number
 * — and inflation is harmless here, because only a DECREASE is refused.
 * The one direction this may be wrong in is toward not refusing, which is
 * the direction a guard over somebody else's edits has to be wrong in.
 */
export function countTestDeclarations(source: string): number {
  return [...source.matchAll(DECLARATION)].length;
}

/** `{ "test/a.test.ts": 12, … }` for every test file anywhere under `root`. */
export function censusOf(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (CENSUS_SKIP.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), r);
      } else if (TEST_FILE.test(e.name)) {
        out[r] = countTestDeclarations(readFileSync(join(dir, e.name), "utf-8"));
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
