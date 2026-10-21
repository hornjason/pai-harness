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
 * ## What is checked instead, and why it delegates
 *
 * **The generator may only run at the root of a real git repository.** That
 * is not a list, it is a question `lib/paths.ts:repoRootFrom` already
 * answers — it resolves `--git-common-dir` and `realpathSync`es the result
 * precisely so callers can compare stable strings. No second definition of
 * "trusted root" is declared here; this module composes that one.
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
 * - **A hostile repository.** `git init` in a writable directory makes a real
 *   repo root, so an attacker who can create a directory AND run `git init`
 *   still reaches the generator. This narrows the population from "any
 *   writable directory" to "any directory someone made a repo"; it does not
 *   empty it. Closing it needs an allowlist of known project roots, which is
 *   the new declaring position this issue exists to refuse — so it is named
 *   here rather than half-built.
 * - **A generator that is a regular file with hostile contents.** Confining
 *   WHERE is not reviewing WHAT.
 * - **`git` config in the resolved repo.** `repoRootFrom` shells out to `git`
 *   in the candidate directory, so `core.fsmonitor`/`core.hooksPath`/
 *   `core.pager` there execute. That is the same exposure as
 *   `CommitEnforcement`'s and is tracked with it — one isolation set,
 *   declared once, is the fix for both.
 *
 * Issue: #1001. Refs #971, #999, #910, #296.
 */

import { lstatSync, realpathSync } from "fs";
import { isAbsolute, join } from "path";
import { repoRootFrom } from "./paths";

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

  let st;
  try {
    // `lstat`, not `stat`: a symlink must be SEEN, not followed.
    st = lstatSync(script);
  } catch {
    return { ok: false, outcome: "declined-no-generator", detail: { ...detail, script } };
  }
  if (st.isSymbolicLink()) {
    // Confining the directory does nothing if a link inside it reaches out.
    return { ok: false, outcome: "declined-symlinked-generator", detail: { ...detail, script } };
  }
  if (!st.isFile()) {
    return { ok: false, outcome: "declined-no-generator", detail: { ...detail, script } };
  }

  return { ok: true, projectRoot, script };
}
