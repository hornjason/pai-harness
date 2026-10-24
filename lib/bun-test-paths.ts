/**
 * bun-test-paths.ts — the decision behind BunTestPathGuard (#1544)
 *
 * One question: does this Bash command hand `bun test` a path that matches
 * no file?
 *
 * ## What bun does, measured in this tree on bun 1.3.14
 *
 * | command | exit | summary line |
 * |---|---|---|
 * | `bun test <absent>` | 1 | no test file matched at all |
 * | `bun test <real> <absent>` | **0** | `Ran 4 tests across 1 file.` |
 * | `bun test <real> ./<absent>` | **0** | nothing about the absent path |
 *
 * A path argument that matches no file is treated as a name FILTER. Bun
 * exits non-zero only when the whole filter set matched zero files; if at
 * least one path matched, every unmatched argument is silent and the run
 * exits 0. So a typo'd path alongside real ones is indistinguishable from a
 * suite that ran and passed — which is `.claude/rules/checks-must-be-able-to-fail.md`'s
 * sixth shape, *green on the exit code, witnessing the wrong mechanism*, in
 * the instrument every agent in this repo verifies its own work with.
 *
 * The live instance: on 2026-10-24, shipping #1536, a verification command
 * named `test/sc-reservations.test.ts`. The real file is
 * `test/sc-reservation-store.test.ts`. Five other paths ran, the command
 * exited 0 reporting `181 pass, 0 fail`, and the suite that would have
 * caught the defect was never opened. CI found it afterwards, on
 * `test-shard (3)`.
 *
 * ## Why a pre-flight stat and not the summary line
 *
 * `Ran N tests across M files` is the only output that distinguishes the two
 * cases — M must equal the number of path arguments. It is a sound reading
 * and it is POST-HOC: it needs the run to have happened and the reader to
 * have thought to look. This refuses before bun is invoked, costs one
 * `existsSync` per argument, and does not depend on anybody remembering.
 *
 * ## Why a hook and not a wrapper script
 *
 * Measured on this tree: 55 sites execute `bun test` with a path argument,
 * 49 of them inside `test/`. A wrapper covers 0 of them on the day it lands,
 * and covers an agent typing `bun test …` by hand — the case that produced
 * this issue — never. The Bash tool is the one chokepoint every agent-composed
 * command passes through.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward ALLOWING. The guard fires on every `bun test` an agent runs, so a
 * false refusal is a wall in front of correct work, repeated. Three classes
 * of argument are therefore skipped rather than resolved, because the hook
 * sees the command BEFORE the shell expands it:
 *
 * - a glob (`test/*.test.ts`) — the shell expands it, bun never sees the
 *   metacharacters, and `existsSync` on the unexpanded string is always false
 * - a variable or substitution (`$SUITE`, `$(…)`, backticks) — the hook has
 *   no access to shell state
 * - anything that is not path-shaped — bun treats a bare word as a substring
 *   name filter and that is a legitimate thing to type
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * Asserted as cases in `test/bun-test-path-guard.test.ts`, not merely listed,
 * so a later widening goes red rather than silently changing behaviour.
 *
 * - A spawn from inside an already-running process. The 49 `test/` sites and
 *   `scripts/test-clean-env.ts` never reach the Bash tool, so no PreToolUse
 *   hook can see them. `suitePathArguments` is exported for a caller that
 *   wants to check its own arguments; nothing is forced to.
 * - `bun test --cwd <dir> <path>`. The paths resolve against `--cwd`, not the
 *   tool call's cwd. `--cwd` is a flag and is skipped, so its paths are
 *   resolved against the wrong root and may read as absent — a false refusal,
 *   which is the direction above, and not one this has seen in the tree.
 * - A path that exists but contains no test bun will collect. Present on
 *   disk is the whole reading; bun's own collection rules are not modelled.
 */
import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";

import { suitePathArgumentsBySegment } from "./test-suite-lock";

/**
 * The field the hook protocol reads for a refusal.
 *
 * Declared ONCE and exported, so the refusal has a single mutable site and
 * `test/bun-test-path-guard.test.ts` can remove it and observe the guard
 * stop refusing. A second inlined `'block'` would bypass the mutation and
 * the case would go green having witnessed nothing.
 */
export const BUN_TEST_PATH_GUARD_DECISION = "block";

/**
 * Shell syntax that makes a whole SEGMENT unresolvable.
 *
 * A command substitution spans several whitespace tokens — `$(bun scripts/x.ts)`
 * tokenises to `$(bun` and `scripts/x.ts)` — so the second looks like an
 * ordinary path and resolves to nothing. Judged per segment for that reason,
 * not per argument. This was a live false refusal in the first implementation.
 */
const UNRESOLVABLE_SEGMENT = /\$\(|`|\$\{/;

/** Shell syntax that makes a single ARGUMENT unresolvable. */
const UNRESOLVABLE_ARGUMENT = /[*?\[\]$~]/;

/**
 * A segment whose first command is `cd <target>`, behind any number of
 * opening subshells. `cd /x && …`, `( cd /x && … )` and `( ( cd /x && … ) )`
 * all match.
 *
 * The repetition is not speculative. A single optional `(` lost the root on
 * `( ( cd X && bun test a.test.ts ) )` and refused a correct command — found
 * by a 16-row battery over subshell spellings, which is the only row of the
 * sixteen that was wrong, and not one that would have been hand-written.
 */
const LEADING_CD = /^\s*(?:\(\s*)*cd\s+(\S+)/;

/**
 * Every directory `bun test` might run in: the tool call's cwd, plus every
 * `cd` target the command names. Null when a `cd` target cannot be resolved,
 * because then the set cannot be enumerated and nothing can be said.
 *
 * ## Why a SET of roots and not the one true cwd
 *
 * Raised by the AI review on PR #1562 and it was right in both directions.
 * `splitTopLevel` does not track parenthesis depth, and this project mandates
 * `( cd <dir> && … )` for any command working outside the session's own
 * directory — so the first implementation resolved against the session cwd
 * while bun would run in the cd'd tree. Measured: it REFUSED
 * `( cd <target> && bun test test/real.test.ts )` naming a path that exists
 * exactly where bun would have looked, and ALLOWED a path absent there but
 * present in the session cwd.
 *
 * Modelling subshell scoping properly needs a depth counter, and a depth
 * counter is a detector the next spelling defeats — the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. Refusing only when a path
 * is absent under EVERY candidate root makes the scoping question stop
 * mattering instead of answering it: a typo is absent under all of them, and
 * a correct path exists under at least one.
 *
 * The cost is declared rather than hidden: a path that exists under one root
 * and not under the one bun actually uses is ALLOWED. That is the direction
 * this guard is allowed to be wrong in, it is strictly better than the
 * single-root reading it replaces, and it is not the #1536 shape — a typo'd
 * filename exists nowhere.
 */
function candidateRoots(command: string, cwd: string): string[] | null {
  const roots = [cwd];
  for (const { segment } of suitePathArgumentsBySegment(command)) {
    const cd = LEADING_CD.exec(segment);
    if (!cd) continue;
    const target = cd[1];
    // `cd $WORKTREE`, `cd "$(git rev-parse …)"`, `cd -`: the set of roots
    // cannot be enumerated, so the command is not judged at all.
    if (UNRESOLVABLE_SEGMENT.test(target) || UNRESOLVABLE_ARGUMENT.test(target) || target === "-") {
      return null;
    }
    roots.push(isAbsolute(target) ? target : resolve(cwd, target));
  }
  return roots;
}

export interface MissingTestPath {
  /** The argument exactly as it was typed. */
  argument: string;
  /** Where it resolved to, so a reader can see which root was searched. */
  resolved: string;
}

export interface BunTestPathRefusal {
  missing: MissingTestPath[];
  message: string;
}

function refusalMessage(missing: MissingTestPath[], roots: string[]): string {
  const names = missing.map((m) => `  ${m.argument}  →  ${m.resolved}`).join("\n");
  const plural = missing.length === 1 ? "a path that matches" : "paths that match";
  // Every root is named. A refusal naming one directory while bun would have
  // run in another is what made the first implementation's defect invisible.
  const where = roots.length === 1 ? roots[0] : `any of ${roots.join(", ")}`;
  return (
    `This \`bun test\` names ${plural} no file under ${where}:\n${names}\n\n` +
    `Bun treats an unmatched path argument as a NAME FILTER. It exits non-zero only ` +
    `when NOTHING matched; with at least one real path alongside, the run exits 0 and ` +
    `reports a pass total, so the argument above would contribute nothing and nobody ` +
    `could see it from the outside. Measured on bun 1.3.14 (#1544).\n\n` +
    `Check the spelling against the tree. If you want to confirm a run afterwards, the ` +
    `tell is bun's own summary: \`Ran N tests across M files\` — M must equal the number ` +
    `of paths you passed.\n\n` +
    `RUNGATE_BUN_TEST_PATH_GUARD=warn or =off reverses this without a code change.`
  );
}

/**
 * The refusal, or null when every path argument resolves.
 *
 * An unreadable command — absent, or not a string — is NOT refused. Unlike
 * the cd guard, whose false allow costs a peer half a day, this one's false
 * refusal blocks the agent in front of it, and a payload with no command
 * string is a hook-protocol problem rather than evidence of a bad path.
 */
export function bunTestPathRefusal(command: unknown, cwd: string): BunTestPathRefusal | null {
  if (typeof command !== "string" || command.trim() === "") return null;

  const roots = candidateRoots(command, cwd);
  // A command naming a `cd` target this cannot resolve is not judged.
  if (roots === null) return null;

  const missing: MissingTestPath[] = [];
  for (const { segment, paths } of suitePathArgumentsBySegment(command)) {
    if (UNRESOLVABLE_SEGMENT.test(segment)) continue;
    for (const argument of paths) {
      if (UNRESOLVABLE_ARGUMENT.test(argument)) continue;
      if (isAbsolute(argument)) {
        if (!existsSync(argument)) missing.push({ argument, resolved: argument });
        continue;
      }
      // Absent under EVERY root, or it is not missing. See `candidateRoots`.
      const tried = roots.map((root) => resolve(root, argument));
      if (tried.every((p) => !existsSync(p))) {
        missing.push({ argument, resolved: tried.join(", ") });
      }
    }
  }

  if (missing.length === 0) return null;
  return { missing, message: refusalMessage(missing, roots) };
}

export type BunTestPathGuardMode = "warn" | "block" | "off";

export const BUN_TEST_PATH_GUARD_MODE_VAR = "RUNGATE_BUN_TEST_PATH_GUARD";

/**
 * `block`. The ladder exists so the decision is a configuration change rather
 * than a code change made under pressure, and the rung is taken here.
 */
export const BUN_TEST_PATH_GUARD_DEFAULT_MODE: BunTestPathGuardMode = "block";

export interface BunTestPathGuardModeReading {
  mode: BunTestPathGuardMode;
  /** The value that was set and not understood. A guard must not turn itself off on a typo. */
  unrecognised?: string;
}

export function bunTestPathGuardMode(
  env: NodeJS.ProcessEnv = process.env,
): BunTestPathGuardModeReading {
  const raw = env[BUN_TEST_PATH_GUARD_MODE_VAR];
  if (raw === undefined || raw === "") return { mode: BUN_TEST_PATH_GUARD_DEFAULT_MODE };
  if (raw === "warn" || raw === "block" || raw === "off") return { mode: raw };
  // An unrecognised value falls back to the DEFAULT, not to `off`. A gate
  // that switches itself off on a misspelling is a gate nobody can rely on.
  return { mode: BUN_TEST_PATH_GUARD_DEFAULT_MODE, unrecognised: raw };
}
