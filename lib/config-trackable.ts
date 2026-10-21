/**
 * config-trackable.ts — the harness's own config must not be a file git
 * considers disposable (#505)
 *
 * ## The report
 *
 * A consumer's `.gitignore` ignored `.claude/` wholesale. Its
 * `.claude/rungate.json` had been force-added on one feature branch and was
 * untracked on `main`, so creating a branch off `main` **deleted the file
 * from the working tree** — correctly, from git's point of view: tracked on
 * the branch you leave, ignored on the branch you arrive at. No warning, no
 * prompt, and nothing in `git status` afterwards to say anything had
 * happened. `git clean -x` does the same thing from the other direction.
 *
 * What is lost is not recoverable from defaults: the `pages` map, the
 * consumer list, `remoteHosts`, the `compliance.organize` block. The harness
 * then resolves `absent` and reports "this project has no rungate config",
 * which reads as an unscaffolded project rather than as a checkout artifact.
 *
 * ## Why this is the scaffold's problem and not the consumer's
 *
 * The objection on the issue — that a harness version-controlling its
 * consumers' files on their behalf is worse than the bug — has the boundary
 * in the wrong place. `createGitignore` in `lib/scaffold/steps.ts` already
 * appends `requiredGitignorePatterns()` to an adopting project's
 * `.gitignore` and reports `UPDATED: .gitignore (added N missing entries)`.
 * The scaffold is already an author of that file. The question is only
 * whether, having told a project what to ignore, it may also stop its own
 * config from being one of those things.
 *
 * This makes the config **trackable**. It does not track it: no `git add`,
 * no commit, nothing staged. That remains the consumer's.
 *
 * ## The negation the issue recommends does not work, measured
 *
 * The issue recommends `!.claude/rungate.json` in preference to un-ignoring
 * `.claude/` wholesale, so that `settings.local.json` and `worktrees/` stay
 * ignored. The intent is right and the pattern is inert:
 *
 * ```
 * # .gitignore
 * .claude/
 * !.claude/rungate.json
 * ```
 * ```
 * $ git check-ignore --no-index -q .claude/rungate.json ; echo $?
 * 0
 * $ git add .claude/rungate.json
 * The following paths are ignored by one of your .gitignore files:
 * .claude
 * hint: Use -f if you really want to add them.
 * ```
 *
 * `gitignore(5)`: *"It is not possible to re-include a file if a parent
 * directory of that file is excluded."* git does not descend into an
 * excluded directory, so nothing inside one can be negated. A consumer
 * following that recommendation gets a refusal from `git add` and concludes
 * the harness is wrong.
 *
 * The form that works re-includes the directory and then re-excludes its
 * contents, which keeps everything the issue wanted kept:
 *
 * ```
 * !.claude/
 * .claude/*
 * !.claude/rungate/
 * !.claude/rungate.json
 * ```
 * ```
 * trackable    .claude/rungate.json
 * trackable    .claude/rungate/config.json
 * IGNORED      .claude/settings.local.json
 * IGNORED      .claude/worktrees/x
 * ```
 *
 * ## It asks git rather than reading the file
 *
 * Ignore rules compose from `.gitignore` at every level, `.git/info/exclude`,
 * `core.excludesFile` and the skip-worktree bits. A regex over one
 * `.gitignore` is a detector narrower than what it detects
 * (`.claude/rules/checks-must-be-able-to-fail.md`, second shape), and it
 * would be wrong in the direction that matters: reporting "not ignored" for
 * a config a global excludes file is deleting.
 *
 * `--no-index` is load-bearing for the opposite reason it is in
 * `lib/tracked-vs-ignored.ts`. Without it, `check-ignore` SKIPS paths that
 * are in the index — so on the reported consumer, where the file was
 * force-added on one branch, it would have answered "not ignored" about the
 * exact file that was about to be deleted. The question here is what the
 * RULES say, not what the index currently holds.
 *
 * ## It verifies its own edit, and reverts if it did not work
 *
 * Appending patterns and reporting success is a check that cannot fail: the
 * ignore rule might not be `.claude/`-shaped at all — a `*.json` at the root
 * or a `core.excludesFile` entry needs a different negation, and this block
 * would not help. So the paths are re-measured afterwards, and if they are
 * still ignored the file is restored byte-for-byte and the action says so
 * rather than claiming an `UPDATED:`.
 *
 * The second re-measure is the one that is easy to forget. `.claude/*` is a
 * no-op when `.claude/` was already excluded, and NOT a no-op if the config
 * was ignored by some broader rule — it would newly ignore every other
 * direct child, and any of those that are tracked become the
 * tracked-and-ignored contradiction `lib/tracked-vs-ignored.ts` exists to
 * report. So the set of tracked paths this project's rules match is
 * measured before and after, and a single new entry reverts the write.
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  RUNGATE_CONFIG_IGNORE_PATHS,
  RUNGATE_CONFIG_PARENT_DIR,
} from "./config-loader";

/** What this project's ignore rules say about the config's home. */
export interface TrackableReading {
  /** Config paths the rules match. EMPTY is the state this module wants. */
  ignored: string[];
  /**
   * Non-null when the question could not be answered — not in a repository,
   * git missing, a git error. Never conflated with "none matched": that
   * conflation would turn a broken `git` into the cheapest way to report
   * that a consumer's config is safe.
   */
  failure: string | null;
}

function git(root: string, args: string[], input?: string) {
  const r = spawnSync("git", args, {
    cwd: root,
    input,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { status: -1, stdout: "", stderr: r.error.message };
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Which of `paths` this project's ignore rules match.
 *
 * Exit 0 means at least one matched, 1 means none did — which is a RESULT
 * and not an error — and anything else is a `failure` the caller must
 * surface. A `catch { return [] }` here reads a git error as a clean bill of
 * health, which is the first shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
function matchedByIgnoreRules(root: string, paths: readonly string[]): TrackableReading {
  if (paths.length === 0) return { ignored: [], failure: null };
  const r = git(root, ["check-ignore", "--no-index", "--stdin", "-z"], paths.join("\0") + "\0");
  if (r.status !== 0 && r.status !== 1) {
    return {
      ignored: [],
      failure: `git check-ignore failed (${r.status}): ${r.stderr.trim() || "no output"}`,
    };
  }
  const matched = new Set(r.stdout.split("\0").filter(p => p !== ""));
  return { ignored: paths.filter(p => matched.has(p)), failure: null };
}

/**
 * Whether this project's ignore rules mark the rungate config disposable.
 *
 * A project that is not a git repository has no ignore rules and nothing can
 * delete the file on a checkout, so that is `{ ignored: [], failure: null }`
 * and not an error — the harness scaffolds into trees that are not repos.
 */
export function configPathsIgnored(root: string): TrackableReading {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { ignored: [], failure: null };
  }
  return matchedByIgnoreRules(root, RUNGATE_CONFIG_IGNORE_PATHS);
}

/** Tracked paths this project's ignore rules also match, as a sorted list. */
function trackedAndIgnoredPaths(root: string): TrackableReading {
  const listed = git(root, ["ls-files", "-z"]);
  if (listed.status !== 0) {
    return { ignored: [], failure: `git ls-files failed (${listed.status}): ${listed.stderr.trim()}` };
  }
  const tracked = listed.stdout.split("\0").filter(p => p !== "");
  const reading = matchedByIgnoreRules(root, tracked);
  return { ignored: [...reading.ignored].sort(), failure: reading.failure };
}

/**
 * The block appended to a `.gitignore` that marks the config disposable.
 *
 * Every line is written here exactly as it must appear on disk and nothing
 * downstream transforms it — the same rule `GITIGNORE_SECTIONS` carries, for
 * the same reason (#474): a trailing slash appended by a helper is the
 * difference between a pattern that matches and one that does nothing.
 *
 * The order is the whole mechanism and each line is load-bearing:
 *
 *  1. `!.claude/` — un-exclude the DIRECTORY, so git descends into it. A
 *     negation for anything inside is inert until this line exists.
 *  2. `.claude/*` — re-exclude its contents, so `settings.local.json`,
 *     `worktrees/` and everything else stay ignored exactly as before.
 *  3./4. the two config locations, re-included by name.
 */
export function configTrackabilityBlock(): string {
  const parent = RUNGATE_CONFIG_PARENT_DIR;
  return [
    "",
    `# Added by rungate scaffold: the harness config must survive a branch`,
    `# switch (#505). A bare \`!${RUNGATE_CONFIG_IGNORE_PATHS[1]}\` is INERT while`,
    `# \`${parent}/\` is excluded — git does not descend into an excluded`,
    `# directory — so the directory is re-included and its contents re-excluded.`,
    `!${parent}/`,
    `${parent}/*`,
    `!${RUNGATE_CONFIG_IGNORE_PATHS[0].slice(0, RUNGATE_CONFIG_IGNORE_PATHS[0].lastIndexOf("/"))}/`,
    `!${RUNGATE_CONFIG_IGNORE_PATHS[1]}`,
    "",
  ].join("\n");
}

/**
 * Make the rungate config committable, or say plainly that it could not be.
 *
 * Returns the `actions` strings it pushed, so a caller can assert on the
 * outcome without re-deriving it.
 */
export function ensureConfigTrackable(root: string, actions: string[]): void {
  const before = configPathsIgnored(root);
  if (before.failure !== null) {
    actions.push(`UNMEASURED: .gitignore (could not ask git about the config path — ${before.failure})`);
    return;
  }
  if (before.ignored.length === 0) {
    actions.push("SKIP: .gitignore (the rungate config is already committable)");
    return;
  }

  const gitignorePath = join(root, ".gitignore");
  const had = existsSync(gitignorePath);
  const original = had ? readFileSync(gitignorePath, "utf-8") : "";
  const trackedBefore = trackedAndIgnoredPaths(root);
  if (trackedBefore.failure !== null) {
    actions.push(`UNMEASURED: .gitignore (could not list tracked files — ${trackedBefore.failure})`);
    return;
  }

  writeFileSync(gitignorePath, original.trimEnd() + "\n" + configTrackabilityBlock());

  // Byte-for-byte, and the file is REMOVED rather than blanked when there
  // was none: a project that acquires an empty `.gitignore` from a step that
  // reported a refusal has been changed by a step that said it changed
  // nothing.
  const revert = (why: string) => {
    if (had) writeFileSync(gitignorePath, original);
    else unlinkSync(gitignorePath);
    actions.push(`REFUSED: .gitignore (${why})`);
  };

  const after = configPathsIgnored(root);
  if (after.failure !== null) {
    revert(`could not verify the edit worked — ${after.failure}`);
    return;
  }
  if (after.ignored.length > 0) {
    // The rule is not `.claude/`-shaped, so this block cannot reach it.
    // Name the rule rather than the guess: `check-ignore -v` reports the
    // source file, line and pattern, which is what a consumer needs.
    const why = git(root, ["check-ignore", "--no-index", "-v", ...after.ignored]);
    revert(
      `the rungate config is still ignored after the negation — ${after.ignored.join(", ")}` +
        (why.stdout.trim() ? ` (matched by ${why.stdout.trim().split("\n").join("; ")})` : "") +
        `. Un-ignore it by hand; a config git treats as disposable is deleted by an ordinary branch switch`,
    );
    return;
  }

  const trackedAfter = trackedAndIgnoredPaths(root);
  if (trackedAfter.failure !== null) {
    revert(`could not verify the edit ignored nothing new — ${trackedAfter.failure}`);
    return;
  }
  const newlyIgnored = trackedAfter.ignored.filter(p => !trackedBefore.ignored.includes(p));
  if (newlyIgnored.length > 0) {
    revert(
      `the negation would newly ignore ${newlyIgnored.length} tracked file(s) — ` +
        `${newlyIgnored.slice(0, 3).join(", ")}${newlyIgnored.length > 3 ? ", …" : ""}`,
    );
    return;
  }

  actions.push(
    `UPDATED: .gitignore (the rungate config was ignored — ${before.ignored.join(", ")} — ` +
      `and is now committable; commit it, or the next branch switch deletes it)`,
  );
}
