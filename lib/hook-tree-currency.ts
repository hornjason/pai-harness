/**
 * How OLD are the bytes a hook registration resolves to (#1216).
 *
 * `lib/hook-target-tree.ts` answers *which directory* a registration names.
 * This answers *which commit that directory is on*, and it exists because the
 * first question has been standing in for the second — its own header says so
 * at the end: `hook-target-tree` "answers which directory, never which
 * commit", and `specs/HOOK-ARCHITECTURE-SPEC.md` repeats the caution under
 * *Which tree the table was measured against*.
 *
 * ## The cost, measured twice in one day
 *
 * On 2026-10-23 the finding arbiter merged as #1282 and then adjudicated
 * nothing for several hours. `RUNGATE_HOOKS_DIR` resolves to
 * a hand-maintained working tree, and that tree was **14 commits behind
 * `origin/main`** — it did not contain the arbiter that had just merged. A
 * hand `fetch` + `merge --ff-only` turned it on, and it went stale again
 * within hours, twice the same day (`62536bd3` → `9f2080d6` → `7817f1df`).
 *
 * Nothing on disk said which `main` those hooks were. **A hook that is absent
 * and a hook that is fourteen commits old produce the same observation** —
 * the code runs and finds nothing — and only one of them is a bug in the
 * code.
 *
 * Same class as *An Unreleased Fix Looks Like a Fixed Bug*: a `lib/` fix is
 * dormant until the next publish. Worse here, because a published package
 * carries a version number and a working tree carries nothing at all.
 *
 * ## This is a READING. It does not move anything
 *
 * No `fetch`, no `merge`, no write of any kind. Silently updating a directory
 * somebody is executing from is worse than saying it is old: the operator
 * loses the one moment where they could have noticed, and a hook changing
 * under a running session is a failure mode nobody is looking for. Every git
 * invocation below is a query.
 *
 * Not fetching has a consequence the reading must own: the base is the
 * TARGET directory's own `origin/main`, whose freshness depends on when that
 * tree last fetched. A tree that has never fetched can read `current` against
 * a remote-tracking ref that is itself months old. That is why every line
 * names the base SHA — two directories reporting different `origin/main`
 * SHAs is visible at a glance, and a reader who wants certainty can fetch by
 * hand. Reporting a number without the ref it was taken against would be the
 * same defect one level up.
 *
 * ## Three states, and the third is not a rounding of the first
 *
 * | state | means |
 * |---|---|
 * | `current` | the directory's HEAD contains every commit on the base |
 * | `behind` | N commits on the base are not in that HEAD, N and both SHAs named |
 * | `unmeasured` | not a working tree, absent, base unresolvable, or dirty |
 *
 * `unmeasured` never degrades to `current`. The whole defect is that a
 * reading nobody could take looks exactly like a clean one — the three
 * fail-open shapes in `lib/hook-target-tree.ts`'s header are the same list,
 * one question earlier.
 *
 * **Uncommitted changes read as `unmeasured`, not `current`.** Bytes that
 * correspond to no commit cannot be certified against one, and a hand-edited
 * live hook is precisely how a tree gets code nothing merged. But dirtiness
 * can only ever prevent a `current` reading — it never masks a `behind` one,
 * because "14 behind, and also edited" is strictly more useful than
 * "unmeasured".
 *
 * ## Where the reading has to appear
 *
 * Three surfaces were weighed; two are rejected here rather than in a PR
 * comment, because the rejections are the argument for the one that was
 * taken.
 *
 * - **A case in an existing suite.** CI has no `~/.claude/settings.json`, so
 *   on a runner the reading is UNMEASURED by construction — a permanent
 *   refusal, or a permanent skip. And it reaches whoever runs the suite,
 *   never the session whose hooks are the stale ones. Those are different
 *   people on different machines, and only the second can act.
 * - **A line in each hook's own output.** Fourteen registrations firing on
 *   every tool call is a message an operator stops reading, which is the
 *   failure `hooks/HookCurrency.hook.ts`'s CADENCE note already argues
 *   against. It also inverts: the copy that is fourteen commits old is
 *   exactly the one that does not contain the reporting code, so the stale
 *   hooks would be the silent ones and the current hooks would do all the
 *   reporting.
 * - **A startup report — taken.** Once per session, in the session whose
 *   hooks those are, printed beside `#879`'s reading, which is this one
 *   asked of `.git/hooks` instead.
 *
 * That third bullet's objection applies to the reporter too, and the answer
 * is structural: `HookCurrency` is registered twice — through
 * `${RUNGATE_HOOKS_DIR}` in `.claude/rungate/hooks.json`, which is subject to
 * the staleness it reports, and through `${CLAUDE_PROJECT_DIR}` in the repo's
 * `.claude/settings.json`, which resolves to the session's own checkout and
 * is not. **A reporter must be reachable by a path that cannot be stale for
 * the reason it reports**, and the second registration is what makes that
 * true here.
 *
 * ## Why `ahead` is not a fourth state
 *
 * A directory carrying local commits on top of the base still contains every
 * merged commit, so every merged fix reaches it. That is the question this
 * module asks. Whether the extra commits should exist is a different one and
 * `lib/hook-target-tree.ts` already refuses to answer two questions at once.
 */

import {
  type TargetTreeCensus,
  readEnvScopes,
  registeredTreeCensus,
} from "./hook-target-tree";
import { readRegistrationScopes } from "./hook-scopes";

/** One git query's result. `status` is the exit code; a non-zero one is a reading. */
export interface GitResult {
  status: number;
  stdout: string;
}

/**
 * Run git in a directory.
 *
 * Injected rather than imported, for the reason `readFile` is injected into
 * `readRegistrationScopes`: a function that reaches for `child_process`
 * itself can only be tested against whatever repositories happen to be on the
 * machine running the suite.
 *
 * It must NOT throw for a non-zero exit — a directory that is not a
 * repository is the single most important case here, and an exception would
 * have to be caught somewhere that could turn it into silence.
 */
export type GitRunner = (dir: string, args: string[]) => GitResult;

export type CurrencyState = "current" | "behind" | "unmeasured";

export interface DirectoryCurrency {
  dir: string;
  state: CurrencyState;
  /** Commits on the base that this HEAD does not contain. `null` unless `behind`. */
  behind: number | null;
  /** The ref the comparison was taken against, as written. */
  base: string;
  /** What the base resolved to IN THIS DIRECTORY, so a reader can compare two rows. */
  baseSha: string | null;
  headSha: string | null;
  /** How many hook registrations execute out of this directory. */
  registrations: number;
  detail: string;
}

export interface RegistrationCurrency {
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** One row per distinct directory, sorted, worst state first. */
  directories: DirectoryCurrency[];
  /** Registrations whose path never resolved to a directory at all. */
  unresolved: number;
  /** Registrations this run looked at. Zero is UNMEASURED, not agreement. */
  examined: number;
}

const SHORT = 8;

function short(sha: string): string {
  return sha.slice(0, SHORT);
}

function unmeasured(
  dir: string,
  base: string,
  registrations: number,
  reason: string,
): DirectoryCurrency {
  return {
    dir,
    state: "unmeasured",
    behind: null,
    base,
    baseSha: null,
    headSha: null,
    registrations,
    detail: `${dir} could not be compared with ${base}: ${reason}`,
  };
}

/**
 * The currency of ONE directory.
 *
 * Ordered so each refusal names the cheapest distinct cause. A single
 * "could not read it" would be a refusal nobody can act on — "not a working
 * tree" and "the tree has no `origin/main`" need different repairs, and the
 * second one is a tree someone cloned without a remote, not a stale one.
 */
export function directoryCurrency(
  dir: string,
  base: string,
  git: GitRunner,
  registrations = 0,
): DirectoryCurrency {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    return unmeasured(
      dir,
      base,
      registrations,
      "it is not inside a git working tree — it is absent, or it is a hand-copied directory, and " +
        "either way nothing there relates those bytes to any merged commit",
    );
  }

  const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.status !== 0 || head.stdout.trim() === "") {
    return unmeasured(dir, base, registrations, "it has no HEAD commit");
  }

  const tip = git(dir, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (tip.status !== 0 || tip.stdout.trim() === "") {
    return unmeasured(
      dir,
      base,
      registrations,
      `${base} is not a ref in that tree, so nothing there says which ${base} those bytes came ` +
        `from. This reading never fetches, so an unfetched remote is a refusal and not a pass`,
    );
  }

  const headSha = head.stdout.trim();
  const baseSha = tip.stdout.trim();

  // `HEAD..base` — commits reachable from the base that this HEAD does not
  // contain. The direction is the whole measurement: transposed, the live
  // tree measured on 2026-10-23 reads 1 rather than 14, and 14 is the number
  // that matters. `test/unit/hook-tree-currency.test.ts` pins it with a
  // fixture that is behind by 3 AND ahead by 1, so no transposition can
  // produce the expected count.
  const count = git(dir, ["rev-list", "--count", `${headSha}..${baseSha}`]);
  const raw = count.stdout.trim();
  if (count.status !== 0 || !/^\d+$/.test(raw)) {
    return unmeasured(
      dir,
      base,
      registrations,
      `the commit count between HEAD and ${base} could not be read`,
    );
  }
  const behind = Number(raw);

  if (behind > 0) {
    return {
      dir,
      state: "behind",
      behind,
      base,
      baseSha,
      headSha,
      registrations,
      detail:
        `${dir} is at ${short(headSha)}, ${behind} commit(s) behind ${base} ` +
        `(${short(baseSha)}) in that tree. Anything merged in those ${behind} commit(s) is on ` +
        `main and is not running`,
    };
  }

  // Only reached when the directory is otherwise current, by design: see the
  // header. A dirty tree that is also behind keeps its `behind` reading.
  const dirty = git(dir, ["status", "--porcelain", "--", dir]);
  if (dirty.status !== 0) {
    return unmeasured(dir, base, registrations, "its working-tree status could not be read");
  }
  const modified = dirty.stdout.split("\n").filter(l => l.trim() !== "").length;
  if (modified > 0) {
    return unmeasured(
      dir,
      base,
      registrations,
      `its HEAD is ${base} (${short(baseSha)}) but ${modified} path(s) under it are uncommitted, ` +
        `so the bytes that execute correspond to no commit`,
    );
  }

  return {
    dir,
    state: "current",
    behind: 0,
    base,
    baseSha,
    headSha,
    registrations,
    detail: `${dir} is at ${short(headSha)}, which contains every commit on ${base}`,
  };
}

/** `current` last, so the rows that need acting on are the ones at the top. */
const ORDER: Record<CurrencyState, number> = { behind: 0, unmeasured: 1, current: 2 };

/**
 * The currency of every directory a resolved registration lands in.
 *
 * Takes the census rather than re-resolving anything: `registeredTreeCensus`
 * is the one binding that decides which directory a registration names, and a
 * second resolver here would be two deciders for one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * This is also `registeredTreeCensus`'s first caller outside `test/`. It was
 * shipped by #1006 and nothing in production has ever called it — a library
 * function with no production caller is not shipped, however well tested.
 */
export function registrationCurrency(
  census: TargetTreeCensus,
  base: string,
  git: GitRunner,
): RegistrationCurrency {
  const reasons = [...census.unmeasuredReasons];

  const perDir = new Map<string, number>();
  for (const r of [...census.inRepo, ...census.foreign]) {
    if (r.resolved === null) continue;
    const dir = r.resolved.slice(0, r.resolved.lastIndexOf("/"));
    perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
  }

  const directories = [...perDir.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, n]) => directoryCurrency(dir, base, git, n));

  for (const d of directories) {
    if (d.state !== "current") reasons.push(d.detail);
  }

  if (directories.length === 0) {
    reasons.push(
      `no registration resolved to a directory, so no tree's age was read. Zero directories ` +
        `compared is not agreement — an empty row list here means the run found nothing to ` +
        `look at`,
    );
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    directories: directories.sort((a, b) => ORDER[a.state] - ORDER[b.state]),
    unresolved: census.unresolved.length,
    examined: census.examined,
  };
}

/**
 * Assemble the whole reading from a machine.
 *
 * Every input is injected — `readFile`, the owned-hook list, the registry
 * commands and `git` — so this module keeps no `fs` and no `child_process`
 * import and a case can drive an absent scope, an empty tree or a directory
 * that is not a repository without touching the machine running the suite.
 * `lib/hook-scopes.ts` and `lib/hook-target-tree.ts` are both built this way
 * and the reason is the same one.
 *
 * `base` has no default. A default here would be a second place deciding
 * which branch a tree is measured against, and the caller already has to
 * know (`.claude/rules/config-access.md`: a built-in substituted silently is
 * the anti-pattern).
 */
export function readRegistrationCurrency(input: {
  repoRoot: string;
  home: string;
  base: string;
  readFile: (path: string) => string | null;
  ownedHooks: string[];
  registryCommands: string[];
  git: GitRunner;
}): RegistrationCurrency {
  const census = registeredTreeCensus(
    input.ownedHooks,
    readRegistrationScopes(input.repoRoot, input.home, input.readFile, input.registryCommands),
    readEnvScopes(input.repoRoot, input.home, input.readFile),
    input.repoRoot,
  );
  return registrationCurrency(census, input.base, input.git);
}

/**
 * The reading, as lines a human reads at session start.
 *
 * The headline carries all three counts rather than picking a class, so a
 * `behind` row and an `unmeasured` row can never hide behind each other —
 * which is the shape of the defect, not a formatting preference. Directories
 * that are `current` get no row: they are the ones nobody has to do anything
 * about, and a report whose every line is routine is a report nobody reads.
 */
export function currencyReportLines(r: RegistrationCurrency): string[] {
  const n = (s: CurrencyState) => r.directories.filter(d => d.state === s).length;
  const behind = n("behind");
  const unread = n("unmeasured");
  const current = n("current");
  const total = r.directories.length;

  if (total === 0) {
    return [`Hook tree currency UNMEASURED: ${r.unmeasuredReasons.join("; ")}`];
  }

  const lines: string[] = [
    behind === 0 && unread === 0
      ? `Hook tree currency: ${current} director(ies) current with ${r.directories[0]!.base}`
      : `Hook tree currency: ${current} current, ${behind} BEHIND, ${unread} UNMEASURED — ` +
        `of ${total} director(ies) hook registrations execute from`,
  ];

  for (const d of r.directories) {
    if (d.state === "current") continue;
    const tag = d.state === "behind" ? `BEHIND ${d.behind}` : "UNMEASURED";
    lines.push(`  ${tag}: ${d.detail} [${d.registrations} registration(s)]`);
  }

  if (r.unresolved > 0) {
    lines.push(
      `  UNMEASURED: ${r.unresolved} registration(s) name a path that resolves to no directory ` +
        `at all, so their age was not read either`,
    );
  }

  return lines;
}
