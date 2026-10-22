/**
 * Where `ProjectStateSync` is allowed to run a generator — and everywhere it
 * is not (#1001).
 *
 * ## The defect this exists to close
 *
 * The hook took a `project-state.json` path out of a tool call, stripped the
 * filename, and ran `scripts/update-project-state.ts` from whatever was left:
 *
 *     const projectRoot = filePath.replace(/\/project-state\.json$/, "");
 *     const script = join(projectRoot, "scripts", "update-project-state.ts");
 *     if (!existsSync(script)) …decline…
 *     execFileSync("bun", [script, "--skip-tests"], { cwd: projectRoot });
 *
 * `projectRoot` is wherever the tool call pointed. Anything able to write two
 * files — `<anywhere>/project-state.json` and
 * `<anywhere>/scripts/update-project-state.ts` — got code execution as the
 * user, on the next `Write` or `Edit`, in every session on this machine.
 *
 * **It is a permission-gate bypass, and that is the part that matters.**
 * `Bash` is gated far more tightly than `Write`. The agent never runs a
 * command; the hook runs it on the agent's behalf, with the agent's choice of
 * directory. #971/#999 converted the spawn from a shell string to an argv,
 * which closed metacharacter injection and left this untouched — the hook's
 * own header says so: *"`existsSync(script)` above is a bar, not a wall — it
 * only requires the payload to be a real directory, and /tmp is writable."*
 *
 * ## The cheapest wrong fix, named so it cannot be mistaken for this one
 *
 * *"Allow anything under `$HOME/Projects`."* It satisfies the symptom, it is
 * a prefix test, and it is **a new list of trusted paths** — a fourth
 * position declaring something this repo already decides elsewhere. It also
 * does not work: a planted root inside the prefix passes it. `AC-4` is that
 * input, and it is red against that fix.
 *
 * The cheapest wrong fix for the SECOND round is different and more
 * tempting: *"also `realpath` the leaf."* It closes the symlinked-directory
 * hole completely, reads like a security fix in a diff, and leaves the
 * forged repository exactly as open as it was — a forgery's generator is a
 * perfectly ordinary file. `AC-14` is the input it does not survive.
 *
 * ## What is checked instead, and why it delegates
 *
 * **The generator may only run at the root of a real git repository, and it
 * must be a TRACKED file of that repository.** Neither is a list; both are
 * questions something else already answers — `lib/paths.ts:repoRootFrom`
 * resolves `--git-common-dir` and `realpathSync`es the result so callers can
 * compare stable strings, and `git ls-files --error-unmatch` decides
 * membership. No second definition of "trusted root" is declared here.
 *
 * ### Why the repo-root test alone was not enough
 *
 * The first version of this module shipped with only the root test, and its
 * limits note claimed an attacker needed "to create a directory AND run
 * `git init`". That is false, and measured false on this machine:
 *
 *     mkdir -p $D/.git/objects $D/.git/refs/heads $D/scripts
 *     printf 'ref: refs/heads/main\n' > $D/.git/HEAD
 *     git -C $D rev-parse --show-toplevel   →  $D
 *     git -C $D rev-parse --git-common-dir  →  .git
 *
 * Three `mkdir`s and a 24-byte file, every one of them reachable with
 * `Write` — the exact primitive this issue exists to contain. "Any writable
 * directory" became "any writable directory plus three mkdirs", which is not
 * a narrowing, and saying it was is worse than the gap: a reader checking
 * the limits would have stopped there.
 *
 * The tracked test refuses it, because **the barrier is `.git/index`** — a
 * binary file with a trailing checksum, not something a text write produces.
 * It also asks the better question: *is this generator part of a project*
 * rather than *is there a `.git` directory here*. `AC-14` is the forgery and
 * `AC-15` is an untracked file dropped into a REAL repository, which is what
 * an attacker gets from any checkout on the machine.
 *
 * ### Both sides must be resolved, and this machine is why
 *
 * The obvious spelling of the anchor is wrong:
 *
 *     if (claimedRoot !== repoRootFrom(claimedRoot)) decline   // WRONG
 *
 * `repoRootFrom` realpaths its answer and the claimed path has not been
 * realpathed, so the two can never agree through a symlink. Measured:
 * `/Users/jhorn/Projects/pai-harness` is a symlink to
 * `/Users/jhorn/Projects/rungate`, and the live `project-state.json` is
 * written through the former. That spelling **refuses the only real caller
 * there is**, silently, as a security improvement. `AC-3` is that input.
 *
 * ### The whole path is resolved, not the leaf
 *
 * `lstat` on the last component sees a link AT the leaf and is blind to one
 * above it: a `scripts` directory symlinked anywhere, with an ordinary file
 * at the end of it, reports no link at all. `projectRoot` is already
 * resolved, so comparing `realpathSync(script)` against the expected path
 * catches a link at ANY depth. `AC-16` is that input, and it asserts the
 * leaf-level `lstat` reads false on it so the arm cannot quietly become a
 * duplicate of `AC-7`.
 *
 * ### A linked worktree is NOT the root of its repository
 *
 * `repoRootFrom` resolves `--git-common-dir`, so from a linked worktree it
 * returns the MAIN checkout. A worktree therefore reads as `not-repo-root`
 * and the generator does not run there. That is a behaviour change and it is
 * deliberate: `PROJECT-STATE.md` is DA-owned and an agent in a worktree must
 * never write it (#296), which #910's SC-3 raised as an open question while
 * the hook was registered on `Write` **and** `Edit` and taking the other
 * answer by default. The outcome is recorded distinctly so the decision is
 * visible in the evidence rather than buried in a refusal count.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A repository whose CONFIG is hostile.** `repoRootFrom` shells out to
 *   `git` in the candidate directory before the tracked-file test can run,
 *   and that call is not isolated. `rev-parse --git-common-dir` neither
 *   refreshes the index nor fires a hook, so `core.fsmonitor` and
 *   `core.hooksPath` do not execute on it — but that is a property of the
 *   subcommand, not a boundary. Isolating `repoRootFrom` itself is the right
 *   fix and is not done here: `test/harness-root.test.ts` stages
 *   `lib/paths.ts` into a scratch directory, so an import added to it fails
 *   to load there (`.claude/rules/self-referential-tests.md`, Tier 1).
 * - **A real project someone else controls.** Tracked means part of a
 *   project, not part of YOUR project. An attacker who can commit to a
 *   repository on this machine can change what the generator does, which is
 *   the next item and not a smaller problem.
 * - **A generator that is a regular file with hostile contents.** Confining
 *   WHERE is not reviewing WHAT.
 * - **A race between the checks and the spawn.** Everything here resolves
 *   paths once; a component swapped for a symlink afterwards is not seen.
 *
 * Issue: #1001. Refs #971, #999, #910, #296.
 */

import { spawnSync } from "child_process";
import { realpathSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import { repoRootFrom } from "./paths";
import { gitIsolatedArgs, gitIsolatedEnv } from "./git-isolation";

/** The generator this hook runs, relative to a project root. */
export const GENERATOR_RELPATH = join("scripts", "update-project-state.ts");

export type ProjectStateTarget =
  | { ok: true; projectRoot: string; script: string }
  /**
   * `outcome` is the string the hook records. Every refusal has one: a
   * decline and a hook that never ran are otherwise the same observation,
   * which is #910.
   */
  | { ok: false; outcome: string; detail: Record<string, unknown> };

/**
 * Resolve a `project-state.json` path to the generator that may run for it.
 *
 * Pure apart from the filesystem reads it is about, and separate from the
 * hook so every refusal has an input that reaches it — a guard that only the
 * hook can exercise is a guard whose ordering nothing can test.
 */
export function projectStateTarget(filePath: string): ProjectStateTarget {
  const claimed = filePath.replace(/\/project-state\.json$/, "");
  const detail: Record<string, unknown> = { filePath, claimedRoot: claimed };

  // Resolve the CLAIMED side too. Without this the comparison below is a
  // string match between a resolved and an unresolved path, which disagrees
  // through any symlink — including the one the real caller arrives through.
  let projectRoot: string;
  try {
    projectRoot = realpathSync(claimed);
  } catch (e) {
    return { ok: false, outcome: "declined-unresolvable-root", detail: { ...detail, error: (e as Error).message } };
  }
  detail.projectRoot = projectRoot;

  const repoRoot = repoRootFrom(projectRoot);
  if (repoRoot === null) {
    // No repository at all: the planted-directory case this issue is about.
    return { ok: false, outcome: "declined-outside-repo", detail };
  }
  if (repoRoot !== projectRoot) {
    // A subdirectory, or a LINKED WORKTREE — `--git-common-dir` resolves to
    // the main checkout from inside one. Recorded distinctly because of the
    // #296 interaction; `repoRoot` in the detail tells the two apart.
    return { ok: false, outcome: "declined-not-repo-root", detail: { ...detail, repoRoot } };
  }

  const script = join(projectRoot, GENERATOR_RELPATH);
  // INVARIANT, not a guard. `realpathSync` returns an absolute path and
  // `join` keeps it absolute, so `script` can never be read as a flag by the
  // spawned `bun`. Stated because the pre-fix code had no such guarantee —
  // a `file_path` of `-rf/project-state.json` built the argv
  // `-rf/scripts/update-project-state.ts`, which `bun` parses as options.
  // Asserted rather than branched on: a condition no input can satisfy is
  // not a check (`.claude/rules/checks-must-be-able-to-fail.md`), and
  // pretending otherwise would hide which mechanism actually closes this.
  if (!isAbsolute(script)) {
    throw new Error(`projectStateTarget produced a relative generator path: ${script}`);
  }

  // Resolve the WHOLE path, not the leaf. `lstat` on the last component is
  // blind to a symlinked INTERMEDIATE: `scripts` may be a link to anywhere
  // with a perfectly ordinary file at the end of it, and `lstat` reports no
  // link. `projectRoot` is already resolved, so any disagreement here is a
  // link at some depth below it.
  let realScript: string;
  try {
    realScript = realpathSync(script);
  } catch {
    return { ok: false, outcome: "declined-no-generator", detail: { ...detail, script } };
  }
  if (realScript !== script) {
    return {
      ok: false,
      outcome: "declined-symlinked-generator",
      detail: { ...detail, script, resolved: realScript },
    };
  }
  if (!statSync(realScript).isFile()) {
    return { ok: false, outcome: "declined-no-generator", detail: { ...detail, script } };
  }

  if (!trackedInRepo(projectRoot, GENERATOR_RELPATH)) {
    // THE ANCHOR. A `.git` directory is three `mkdir`s and a 24-byte `HEAD`
    // away from any `Write`; a TRACKED file is not.
    //
    // LAST, so that every check above it stays reachable. Tracking is the
    // strongest test here, and putting it first would make the symlink
    // branches unreachable — git does not descend a symlinked directory, so
    // a link would be refused as untracked and the branch that exists to
    // name it could never be taken (`.claude/rules/checks-must-be-able-to-fail.md`).
    // Order changes which refusal is RECORDED, never whether one happens:
    // nothing is spawned until all of them pass.
    return { ok: false, outcome: "declined-untracked-generator", detail: { ...detail, script } };
  }

  return { ok: true, projectRoot, script };
}

/**
 * Is `relPath` a tracked file of the repository at `root`?
 *
 * `ls-files --error-unmatch` rather than a filesystem test, because the
 * question is *is this part of a project* and only git can answer it. The
 * barrier is the INDEX: `.git/index` is a binary file carrying a trailing
 * checksum, so the three-`mkdir`s forgery that satisfies `rev-parse` has no
 * index at all and this refuses it. Committed content raises the bar again,
 * but the index alone is already past what writing text files can reach.
 *
 * ISOLATED, because this runs `git` in a directory the caller chose and git
 * executes that repository's config — `lib/git-isolation.ts`. `--` so a
 * relative path can never be read as a revision or a flag.
 */
function trackedInRepo(root: string, relPath: string): boolean {
  const r = spawnSync("git", gitIsolatedArgs(["-C", root, "ls-files", "--error-unmatch", "--", relPath]), {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "ignore", "ignore"],
    env: gitIsolatedEnv(),
  });
  return r.status === 0;
}
