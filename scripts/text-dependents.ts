#!/usr/bin/env bun
/**
 * Print the files that lift the region you just edited (#1054).
 *
 * The third router, beside `scripts/census-routing.ts` (what the diff DID)
 * and `scripts/select-affected-tests.ts` (what the diff IMPORTS). This one
 * answers *who reads the part of this file I touched, as text* — see
 * `lib/text-dependents.ts` for what an anchor is and why the span is only
 * attribution.
 *
 * ## Why a command and not a row in a rule file
 *
 * `.claude/rules/self-referential-tests.md` already carries the Tier 1/2/3
 * tables, which are a hand-maintained enumeration of exactly this coupling,
 * and the repo's own line is that a rule nothing executes is not a rule. The
 * cheapest wrong fix for #1054 was to add a row warning that some tests parse
 * source files; the agent who reddened PR #1034 would have read it, agreed
 * with it, and still had no way to find the four files, because the files are
 * named for the property they assert and not for the subject they lift.
 *
 * ## Output shape, and the one thing it must never do
 *
 * stdout is a `bun test …` line, so it composes: `bun test $(bun
 * scripts/text-dependents.ts)`. stderr carries the attribution grouped by the
 * file you changed, because the attribution is the product — a list of paths
 * with no reason attached is the thing the author already had.
 *
 * Exit 2 on UNMEASURED, and stdout stays EMPTY in that case. An empty
 * selection and "I could not look" must not be the same output, and the
 * composed form above makes the difference load-bearing: `bun test` with no
 * arguments runs the whole suite, which is the safe answer to a reading
 * nobody could take.
 *
 * Exit 2 for the same reason on a path that is not plain — see
 * `refuseUnsafePaths`. Because stdout is reparsed by a shell, this script
 * and `scripts/select-affected-tests.ts` are two producers for one
 * consumer, and they share `SAFE_TEST_PATH` rather than each holding a
 * copy of it.
 */
import { changesFor } from "./census-routing";

import { SAFE_TEST_PATH } from "../lib/affected-tests";
import { textDependents, type ChangedFile } from "../lib/text-dependents";

/**
 * The selection, or the paths that disqualify it.
 *
 * Refuse, do not filter. An unsafe path means the walk produced something
 * nobody predicted, and a selection with that one entry dropped is a
 * selection missing exactly the file that was unusual — worse than no
 * selection, because it still looks like an answer. Empty stdout in the
 * `bun test $(…)` composition degrades to the full suite, which is the safe
 * direction for a test selector and the same direction
 * `scripts/select-affected-tests.ts` takes for the same input.
 *
 * `SAFE_TEST_PATH` is imported, not copied. Two producers emitting into one
 * shell composition need one decider; see its definition in
 * `lib/affected-tests.ts` for what the second copy would have cost.
 */
export function refuseUnsafePaths(tests: string[]): { ok: boolean; unsafe: string[] } {
  const unsafe = tests.filter(t => !SAFE_TEST_PATH.test(t));
  return { ok: unsafe.length === 0, unsafe };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = arg(argv, "root") ?? process.cwd();

  let changed: ChangedFile[];
  try {
    changed = changesFor(root, arg(argv, "base")).map(c => ({ path: c.path, hunks: c.hunks }));
  } catch (e) {
    console.error(
      `text-dependents: could not read the diff — ${(e as Error).message.split("\n")[0]}`,
    );
    process.exit(2);
  }

  const r = textDependents(root, changed);

  if (r.reading === "UNMEASURED") {
    for (const why of r.unmeasuredReasons) console.error(`text-dependents: UNMEASURED — ${why}`);
    console.error(
      `text-dependents: read ${r.filesRead} of ${r.filesSeen} candidate readers — this is not ` +
        "a result, and stdout is empty so a composed `bun test` runs everything",
    );
    process.exit(2);
  }

  // Coverage first and unconditionally. `36/426` and `426/426` are the same
  // verdict when only the verdict is printed (#492).
  console.error(
    `text-dependents: read ${r.filesRead} of ${r.filesSeen} candidate readers, ` +
      `${r.unreadable.length} unreadable, over ${changed.length} changed file(s)`,
  );
  if (r.notAnchorable.length > 0) {
    console.error(
      `text-dependents: ${r.notAnchorable.length} changed path(s) are outside this router's ` +
        `scope and were NOT examined — ${r.notAnchorable.slice(0, 5).join(", ")}` +
        " (prose coupling is scripts/census-routing.ts)",
    );
  }
  if (r.notText.length > 0) {
    console.error(`text-dependents: declined as binary — ${r.notText.join(", ")}`);
  }

  const direct = r.edges.filter(e => e.direct);
  if (direct.length === 0) {
    console.error(
      "text-dependents: nothing in the tree anchors into the regions you changed. That is a " +
        "reading, not a failure — the import graph still has its own opinion, so run " +
        "`bun scripts/select-affected-tests.ts` as well",
    );
  }

  for (const target of [...new Set(direct.map(e => e.target))].sort()) {
    console.error(`\ntext-dependents: ${target} — lifted by`);
    for (const e of direct.filter(d => d.target === target)) {
      const where = `${e.from === e.to ? e.from : `${e.from}-${e.to}`} [${e.scope}]`;
      console.error(`    ${e.reader}\n        ${where} via ${JSON.stringify(trim(e.anchor))}`);
    }
  }
  if (r.helpers.length > 0) {
    console.error(
      `\ntext-dependents: ${r.helpers.length} of those are not test files, so the tests that ` +
        `import them are what runs — ${r.helpers.slice(0, 5).join(", ")}`,
    );
  }
  if (r.ambiguous.length > 0) {
    const [worst] = r.ambiguous;
    console.error(
      `\ntext-dependents: ${r.ambiguous.length} literal(s) occur too often in a changed file to ` +
        `anchor anything and were declined, worst ${JSON.stringify(trim(worst.anchor))} ` +
        `(${worst.occurrences}x in ${worst.target})`,
    );
  }

  const safety = refuseUnsafePaths(r.tests);
  if (!safety.ok) {
    console.error(
      `\ntext-dependents: REFUSED — ${safety.unsafe.length} selected path(s) are not plain test ` +
        "paths and this output is interpolated into a shell command unquoted: " +
        `${safety.unsafe.slice(0, 3).join(", ")}. stdout is empty, so a composed ` +
        "`bun test` runs everything rather than a selection with the odd one dropped",
    );
    process.exit(2);
  }

  if (r.tests.length > 0) console.log(`bun test ${r.tests.join(" ")}`);
}

/** One line, bounded, for a terminal. */
function trim(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}...` : flat;
}
