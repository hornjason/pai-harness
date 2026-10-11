import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * The one way to ask which spec files exist (#225).
 *
 * `specs/` has subdirectories — `specs/bootstrap-data-flow/` holds six specs
 * and 254 SCs — and until this existed, eight callers each decided for
 * themselves whether to descend. Seven did not:
 *
 *   lib/conformity.ts:354   the specMap SC conformity runs on
 *   lib/conformity.ts:1056  SPEC-FRONTMATTER
 *   lib/conformity.ts:1068  SPEC-DISCOVERY-TESTABLE
 *   lib/conformity.ts:1139  DRIFT-2
 *   lib/gap-scanner.ts:235
 *   scripts/sync-spec-tests.ts:98
 *   scripts/sync-spec-tests.ts:309
 *
 * All seven were the same line — `readdirSync(specsDir).filter(f =>
 * f.endsWith(".md"))` — and the eighth, `lib/conformity.ts:558`, hand-rolled
 * a one-level descent inline.
 *
 * DRIFT-2 is why this is a shared function and not seven edits. Its stated job
 * is "every testable spec is referenced by at least one test", and because it
 * collected flat it had never looked at five specs that no test references,
 * while reporting 20 pass / 0 fail. A detector narrower than what it detects,
 * guarding the one thing it cannot see
 * (.claude/rules/checks-must-be-able-to-fail.md). Seven separate fixes would
 * leave the eighth caller free to reintroduce it; one function means the next
 * caller cannot get it wrong without going out of its way.
 *
 * Returns paths relative to `specsDir`, so `join(specsDir, p)` reads the file
 * and `specs/${p}` names it in a finding — the shape every caller already
 * used for the flat case.
 */
export function collectSpecFiles(specsDir: string): string[] {
  if (!existsSync(specsDir)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      // INDEX.md is a split spec's table of contents and carries no
      // frontmatter, so collecting it would make SPEC-FRONTMATTER fail on a
      // file that is correct as it is. `lib/conformity.ts:562` already
      // excluded it for that reason; this is that exclusion, kept.
      //
      // SPEC-TEMPLATE.md is deliberately NOT excluded. It is `testable:
      // false`, so every testable-spec check already filters it out, and the
      // flat collectors did include it — dropping it here would quietly
      // narrow SPEC-FRONTMATTER's coverage, which is the opposite of what
      // this change is for.
      if (entry.name === "INDEX.md") continue;
      out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  };
  walk(specsDir, "");
  return out.sort();
}
