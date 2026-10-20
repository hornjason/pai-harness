/**
 * Every test file under a directory, at any depth (#733).
 *
 * A LEAF module, in the shape `lib/git-dates.ts` established (#508) and
 * `lib/local-calendar-day.ts` followed: one exported walk, no relative
 * imports, so there is exactly one thing to mutate and every call site names
 * the same rule.
 *
 * ## Why this exists
 *
 * `scripts/sync-sc-status.ts` walked `specs/` recursively and `test/` flat —
 * three times, in three places, each `readdirSync(d).filter(f =>
 * f.endsWith(".test.ts"))`. Measured on `main` at `eb3612a3`: 59 `.test.ts`
 * files in `test/unit` and **50** (spec, id) credits the credit rule could
 * not see.
 *
 * Nothing was red. `lib/sc-cover.ts` reaches the same verdict by a second
 * route — it runs `matchPattern(d)` and executes the assertion — and a
 * conformity matcher happens to pass for all 50, so the working route
 * covered for the broken one and the checkboxes were right anyway. Two
 * routes to one verdict with no comparison between them is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape, and the
 * only reason it surfaced at all is that somebody counted the files.
 *
 * ## Why the skip set is a parameter and not a constant in here
 *
 * `test/fixtures/` must earn no SC credit — a scaffolding tree that plants
 * example criteria would otherwise tick real checkboxes. But "which
 * directories are uninteresting" is the CALLER's question:
 * `lib/test-census.ts` counts declarations and deliberately descends into
 * places the credit rule must not. Baking one answer in here would make the
 * next caller add a second walk, which is the defect this module exists to
 * remove.
 */
import { readdirSync } from "fs";
import { join } from "path";

/**
 * Directories the SC credit rule does not descend into.
 *
 * `fixtures` is the load-bearing entry: a planted criterion in a scaffolding
 * tree is example text, not a claim about this project. The rest are the
 * ordinary noise any walk of a repository has to decline.
 */
export const TEST_WALK_SKIP: ReadonlySet<string> = new Set([
  "fixtures",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

/** What counts as a test file to the credit rule. */
const TEST_FILE = /\.test\.ts$/;

/**
 * Every test file under `dir`, as paths relative to `dir`, sorted.
 *
 * Sorted deliberately, and it is not cosmetic: `readdir` order is a property
 * of the filesystem, so two walks of one tree agree without anybody having
 * asked for an order. A caller that reports these paths to a human — all
 * three in `sync-sc-status.ts` do — would otherwise produce output that
 * reorders between machines for no reason anyone can see (#500's
 * determinism row: comparing two walks of the same tree proves nothing, so
 * the ORDER has to be the thing that is fixed).
 *
 * A directory that does not exist yields `[]` rather than throwing, because
 * an unscaffolded project legitimately has no `test/`. A directory that
 * exists and cannot be read is a different fact and is allowed to throw —
 * an empty list there would be a permission error reported as a clean tree.
 */
export function walkTestFiles(dir: string, skip: ReadonlySet<string> = TEST_WALK_SKIP): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e: any) {
      // Only an absent directory is tolerated, and only at the root. Anything
      // else — EACCES, ENOTDIR — is a reading nobody took, and returning []
      // for it would report an unreadable tree as a tree with no tests.
      if (e?.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(abs, e.name), next);
      } else if (e.isFile() && TEST_FILE.test(e.name)) {
        out.push(next);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}
