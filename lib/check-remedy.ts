/**
 * The remedy line a conformity failure carries, and the routing to the rule
 * file that explains the whole family (#813).
 *
 * ## Why this exists
 *
 * The checks in `.claude/rules/self-referential-tests.md`'s Tier 1 assert a
 * property about the REPOSITORY, not about a unit of code. They go red on a
 * pull request that never opened the file they are about: add a spec, and
 * `HYGIENE-4` fails; add a script, and `HYGIENE-3` fails. The agent who needs
 * that document is by definition staring at a test failure, and measured on
 * `e0429b82` not one of those failures named it — two references in the whole
 * executable tree, both prose inside a docblock, against 321 for
 * `checks-must-be-able-to-fail`.
 *
 * So the document was unreachable from the only place it was ever needed.
 *
 * ## The two layers, and why they are not one
 *
 * `lib/conformity.ts` is published, and `lib/scaffold/steps.ts` generates the
 * consumer test that calls it. The rule file has exactly one copy in this tree
 * and no template copy, so it does NOT ship. Hardcoding its path into the
 * published failure text would point every consumer at a file they do not
 * have — a dangling route, which is the defect `test/rule-provenance.test.ts`
 * exists to catch and cannot catch across the package boundary.
 *
 * Hence `fix` and `pointer` are separate:
 *
 *  - The **fix** is a claim about the project's own tree and is true anywhere.
 *    "Add a row to `.claude/rules/specs-routing.md`" is the real remedy in a
 *    consumer exactly as it is here.
 *  - The **pointer** is DERIVED, not configured: it is emitted only when the
 *    rule file is present under `root`. No new config key, nothing for a
 *    consumer to set, absent where it would be wrong, and it begins working
 *    for a consumer on the day they adopt the file.
 *
 * A config key was the other option and is worse: it is a second decider about
 * whether the document exists, and the two could disagree — the key set in a
 * project that deleted the file routes an agent to nothing.
 */

import { existsSync } from "fs";
import { join } from "path";

/**
 * The document, relative to a project root.
 *
 * Spelled once. A second copy is the thing
 * `.claude/rules/checks-must-be-able-to-fail.md` calls two deciders that
 * agree: the existence probe and the printed path would be free to drift, and
 * the failure mode is silent — a pointer that prints a path nobody checked.
 */
export const SELF_REFERENTIAL_RULES = ".claude/rules/self-referential-tests.md";

/**
 * The routing sentence, or `""` when this project does not carry the document.
 *
 * Returns the empty string rather than throwing or omitting a field, because
 * every caller is composing a message and an empty segment drops out of a
 * `filter(Boolean).join()` without a branch at each site.
 */
export function ruleDocPointer(root: string): string {
  if (!existsSync(join(root, SELF_REFERENTIAL_RULES))) return "";
  return (
    `This check asserts a property of the REPOSITORY, so it can go red on a change ` +
    `that never touched its subject. ${SELF_REFERENTIAL_RULES} lists the others ` +
    `that behave this way and what each one wants.`
  );
}

/**
 * A conformity failure message: what is wrong, what to do, and where the rest
 * of the family is documented.
 *
 * The `fix` is mandatory and takes no default. A default would let a new check
 * be written with no remedy and still look like it had one, which is the
 * failure this module was built to end — `test/check-remedy.test.ts` holds the
 * population of Tier 1 checks for the same reason.
 */
export function remedyMessage(opts: {
  root: string;
  check: string;
  violations: string[];
  fix: string;
}): string {
  const { root, check, violations, fix } = opts;
  const subject = violations.length === 0 ? "(none)" : violations.join(", ");
  return [
    `${check}: ${violations.length} violation(s) — ${subject}`,
    `FIX: ${fix}`,
    ruleDocPointer(root),
  ]
    .filter(Boolean)
    .join("\n");
}
