/**
 * `readdirSync`, sorted (#827).
 *
 * A LEAF module, in the shape `lib/local-calendar-day.ts` established: one
 * exported binding, no relative imports, so there is exactly one thing to
 * mutate and every call site names the same rule.
 *
 * ## Why this exists
 *
 * Directory enumeration order is the filesystem's, and it is not an order:
 * APFS hands entries back in a different sequence from ext4. The scan
 * renders tables straight from these reads, so three generated files —
 * `.claude/rules/specs-routing.md` and the prompt-routing tables in
 * `.claude/agents/discovery.md` and `marcus.md` — came out as a different
 * PERMUTATION on Linux and on macOS, with byte-identical rows.
 *
 * The consequence is sharper than a cosmetic diff: the repository could be a
 * fixed point of its own generator on the machine its files were last
 * written on and on no other. #827 was measured on a Mac and reported five
 * drifting files; CI found three more that no amount of looking on the
 * author's machine would have shown.
 *
 * ## Why one module rather than a `.sort()` per call site
 *
 * The scan exists TWICE — `lib/scanner.ts` and `lib/scaffold/steps.ts` carry
 * parallel copies, which is the duplication #829 removed for the spec scan
 * and which is still there for the rest. Twenty-four `.sort()` calls are
 * twenty-four things to forget; one binding is one.
 * `test/harness-fixed-point.test.ts` asserts that neither file calls
 * `readdirSync` at all, so a new call site cannot reintroduce the class by
 * reaching for the raw import.
 *
 * Plain `.sort()`: the default lexicographic order over UTF-16 code units is
 * locale-independent, unlike `localeCompare`, and a generator whose output
 * depends on the runner's locale is the same defect in a different coat.
 */
import { readdirSync } from "fs";

export interface ReaddirSortedOptions {
  recursive?: boolean;
}

export function readdirSorted(dir: string, opts?: ReaddirSortedOptions): string[] {
  return (opts ? readdirSync(dir, opts) : readdirSync(dir)).map(String).sort();
}
