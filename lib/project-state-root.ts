/**
 * Where the project-state generator is allowed to run — and everywhere it is
 * not.
 *
 * Split out of the hook so that every refusal has an input which reaches it:
 * a guard only the hook can exercise is a guard whose ordering nothing can
 * test. The readings below are taken by the caller, which is the half that
 * touches the filesystem; this half only decides.
 */

/** What the caller resolved about the directory a tool call claimed. */
export interface RootReading {
  /** The claimed directory, fully resolved. */
  projectRoot: string;
  /**
   * `git rev-parse --git-common-dir`, resolved — the MAIN checkout. `null`
   * when the directory is in no repository at all.
   */
  repoRoot: string | null;
  /** The claimed directory is a linked worktree of `repoRoot`. */
  linkedWorktree: boolean;
  /** The generator is a tracked file of that repository. */
  generatorTracked: boolean;
}

export type GeneratorTarget =
  | { ok: true; projectRoot: string }
  /**
   * Every refusal names itself. Without an outcome a decline and a hook that
   * never ran are the same observation.
   */
  | { ok: false; outcome: string };

function decline(outcome: string): GeneratorTarget {
  return { ok: false, outcome };
}

/** Resolve a reading to the generator that may run for it. */
export function generatorTarget(r: RootReading): GeneratorTarget {
  if (r.repoRoot === null) return decline("declined-outside-repo");

  if (r.repoRoot !== r.projectRoot) {
    return decline("declined-not-repo-root");
  }

  if (!r.generatorTracked) return decline("declined-untracked-generator");
  return { ok: true, projectRoot: r.projectRoot };
}
