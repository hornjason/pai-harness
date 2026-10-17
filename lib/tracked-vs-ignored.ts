/**
 * A file that is both tracked and ignored (#471).
 *
 * A `.gitignore` rule written with a trailing slash — `node_modules/` — does
 * not match a **symlink** named `node_modules`. `git add .` therefore tracks
 * it, and what lands in the commit is a mode `120000` blob whose entire
 * content is a machine-absolute path:
 *
 * ```
 * $ git ls-files -s node_modules
 * 120000 b8d92fe8221f2696f298301e01225ec1973e5336 0  node_modules
 * $ git cat-file -p b8d92fe8
 * /Users/<someone>/Projects/<their-project>/node_modules
 * ```
 *
 * Reported from a consumer repo with two such entries against a `.gitignore`
 * that named both correctly. **`git status` was clean throughout**, and that
 * is the whole problem: the rule is right, the mental model is right, and the
 * only thing that reveals the divergence is `git ls-files`.
 *
 * Any worktree-isolated agent that symlinks `node_modules` instead of
 * installing hits this, and the harness is what creates those worktrees.
 *
 * ## The obvious detector does not catch the reported case, measured
 *
 * The shape this was filed as is *fail when `git ls-files` returns a path
 * that `git check-ignore` also matches*. That is a real contradiction and it
 * is the first finding below — but run against the reported case it reports
 * nothing, for the same reason the bug exists:
 *
 * ```
 * $ git check-ignore --no-index -v node_modules
 * $ echo $?
 * 1
 * ```
 *
 * `node_modules/` does not match a symlink named `node_modules`, and
 * `check-ignore` says so just as faithfully as `git add` did. Asking it
 * about a path below the link does not help either — `git check-ignore
 * --no-index node_modules/anything` is `fatal: pathspec ... is beyond a
 * symbolic link`. A detector built only on the agreement between those two
 * commands is narrower than the thing it was written to detect, which is the
 * second shape in `.claude/rules/checks-must-be-able-to-fail.md` arriving in
 * the check rather than in the ignore rule.
 *
 * So there are two findings, and the second is the one that catches #471:
 *
 * 1. **tracked and ignored** — a statement of intent contradicting itself,
 *    whatever rule produced it. Catches a `git add -f` of an ignored file.
 * 2. **a tracked symlink pointing at an absolute path** — which needs no
 *    ignore rule to be wrong. The blob's content is a path on one machine,
 *    so the checkout is broken for everyone else, and no `.gitignore` edit
 *    can make it right.
 *
 * ## `--no-index`, and why its absence would be a check that cannot fail
 *
 * `git check-ignore` SKIPS files in the index unless `--no-index` is given.
 * Without it the command is asked about tracked paths and answers about
 * untracked ones, so the comparison is between a list and the empty set and
 * can never report anything. The one flag is the difference between this
 * module and a green line in a report.
 *
 * ## Exit codes, and the fail-open that is one `catch` away
 *
 * `git check-ignore` exits 0 when something matched, **1 when nothing
 * matched**, and 128 on an error. A `try { ... } catch { return [] }` around
 * it reads the error case as the clean case, which is the first shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. So 1 is a result and
 * anything else is a `failure` the caller must surface.
 *
 * ## It does not read `git status`
 *
 * Asserted by a test, not merely intended. `git status` was clean in the
 * reported case, so a detector that consults it cannot see this at all.
 */
import { spawnSync } from "child_process";

/**
 * Why a tracked path is a finding. A path can be both.
 *
 * `absolute-symlink` deliberately does not mention ignore rules: a committed
 * link to `/Users/<someone>/...` is wrong in a repository that never had a
 * rule about it.
 */
export type FindingReason = "tracked-and-ignored" | "absolute-symlink" | "unreadable-symlink";

/** One tracked path that should not be tracked the way it is. */
export interface Finding {
  path: string;
  /** The index mode: `100644` a file, `100755` executable, `120000` a symlink. */
  mode: string;
  sha: string;
  /**
   * For a symlink, the blob's content — which IS the link target, and is
   * usually an absolute path that means nothing on another machine. Null for
   * anything else: the path and the mode are the finding there.
   */
  linkTarget: string | null;
  reasons: FindingReason[];
}

export interface TrackedIgnoredReading {
  findings: Finding[];
  /**
   * How many tracked paths were compared. An empty corpus and a clean one
   * give the same verdict, and only this tells them apart.
   */
  trackedCount: number;
  /**
   * Non-null when the comparison could not be made. Never conflated with
   * "nothing found": that conflation is the defect this module is about,
   * arriving in the detector instead of in the ignore rule.
   */
  failure: string | null;
}

function run(root: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd: root,
    input,
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: -1, stdout: "", stderr: r.error.message };
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** `<mode> <sha> <stage>\t<path>` per NUL-separated record. */
function parseLsFiles(out: string): Array<{ mode: string; sha: string; path: string }> {
  const entries: Array<{ mode: string; sha: string; path: string }> = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, sha] = record.slice(0, tab).split(/\s+/);
    if (!mode || !sha) continue;
    entries.push({ mode, sha, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * Every tracked path this repository's ignore rules also match.
 *
 * `root` must be inside a git repository; anything else is a `failure`
 * rather than an empty result.
 */
export function trackedAndIgnored(root: string): TrackedIgnoredReading {
  const listed = run(root, ["ls-files", "-s", "-z"]);
  if (listed.status !== 0) {
    return {
      findings: [],
      trackedCount: 0,
      failure: `git ls-files failed (${listed.status}): ${listed.stderr.trim() || "no output"}`,
    };
  }
  const tracked = parseLsFiles(listed.stdout);
  if (tracked.length === 0) {
    return { findings: [], trackedCount: 0, failure: null };
  }

  // `--no-index` or this asks about the wrong set. `--stdin -z` because a
  // path may contain anything, including a newline.
  const checked = run(
    root,
    ["check-ignore", "--no-index", "--stdin", "-z"],
    tracked.map(t => t.path).join("\0") + "\0",
  );
  // 0: at least one matched. 1: none did, which is the clean answer and not
  // an error. Anything else is an error, and reporting it as clean is the
  // fail-open this whole module exists to be the opposite of.
  if (checked.status !== 0 && checked.status !== 1) {
    return {
      findings: [],
      trackedCount: tracked.length,
      failure: `git check-ignore failed (${checked.status}): ${checked.stderr.trim() || "no output"}`,
    };
  }

  const matched = new Set(checked.stdout.split("\0").filter(p => p !== ""));
  const findings: Finding[] = [];
  for (const entry of tracked) {
    const reasons: FindingReason[] = [];
    if (matched.has(entry.path)) reasons.push("tracked-and-ignored");

    let linkTarget: string | null = null;
    if (entry.mode === "120000") {
      // The blob of a symlink IS its target. `node_modules` tracked as a
      // directory of files is wasteful; `node_modules` tracked as a link to
      // an absolute path is what breaks on another machine, and the mode is
      // the only thing that tells the two apart.
      const blob = run(root, ["cat-file", "-p", entry.sha]);
      linkTarget = blob.status === 0 ? blob.stdout.trim() : null;
      if (linkTarget === null) {
        // A link whose target could not be read is a finding, not a pass.
        // Treating it as "no target, therefore not absolute" would make a
        // broken `cat-file` the cheapest way to clear this check — the
        // fail-open this module's own docstring warns about, one branch
        // below where it warns about it. Found by security review.
        reasons.push("unreadable-symlink");
      } else if (linkTarget.startsWith("/")) {
        // A relative link is a repository making a statement about itself
        // and is portable. An absolute one is a statement about one
        // filesystem.
        reasons.push("absolute-symlink");
      }
    }

    if (reasons.length > 0) {
      findings.push({ path: entry.path, mode: entry.mode, sha: entry.sha, linkTarget, reasons });
    }
  }
  return { findings, trackedCount: tracked.length, failure: null };
}

/** The refusal text, naming the mode and — for a link — where it points. */
export function describeFindings(reading: TrackedIgnoredReading): string[] {
  if (reading.failure !== null) return [`UNMEASURED: ${reading.failure}`];
  return reading.findings.map(f => {
    const kind = f.mode === "120000" ? "symlink" : `mode ${f.mode}`;
    const target = f.linkTarget !== null ? ` -> ${f.linkTarget}` : "";
    const why = f.reasons
      .map(r => {
        if (r === "tracked-and-ignored") return "matched by this repository's own ignore rules";
        if (r === "absolute-symlink") {
          return "a link to an absolute path, which resolves to nothing on another machine";
        }
        return "UNMEASURED: a link whose target could not be read, so it cannot be judged";
      })
      .join("; ");
    return `${f.path} is tracked (${kind}${target}): ${why}`;
  });
}
