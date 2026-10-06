#!/usr/bin/env bun
/**
 * Collect parallel agents' work into the project root so it can be committed (#81).
 *
 * `workflows/ship.js` runs inside a sandbox with no module loading — a
 * top-level `require()` there killed every ship run before it spawned an agent
 * (#69). So ship.js cannot call lib/worktree-collect.ts itself. It shells out
 * to this script through an agent step instead, which runs in a real Bun
 * runtime and imports the library directly.
 *
 * That indirection is the point: the alternative was inlining a second copy of
 * the collection logic into ship.js, and a duplicated helper in this repo has
 * already drifted from its library once — computeACHash sorted its input and
 * the inline copy did not, so the extracted function had never actually matched
 * the code it replaced. One implementation, one place.
 *
 * Usage:
 *   bun scripts/collect-worktree-files.ts <groups.json> <projectRoot>
 *
 * One or more <worktreeBase> directories bound which of this repository's
 * worktrees this run may collect from.
 *
 * <groups.json> holds [{ worktreePath, filesChanged }] — one entry per agent.
 * Prints the collected project-relative paths, one per line, on stdout.
 * Diagnostics go to stderr so stdout stays a clean file list.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { collectWorktreeFiles, groupFilesByWorktree, type AgentBuildResult } from "../lib/worktree-collect";

/**
 * The worktrees git knows about AND that live under this run's worktree base.
 *
 * Git alone is too generous. `git worktree list` returns every worktree of the
 * repository — on this machine, 45 of them, including other developers' and
 * other concurrent sessions' live, unpushed checkouts. Authorising all of them
 * would let one ship run collect another session's uncommitted work into its
 * own commit. With several sessions running at once that is a likely accident
 * well before it is an attack.
 *
 * So intersect: git decides what is genuinely a worktree of this repository,
 * and the bases decide which of those belong to this run. A path must satisfy
 * both. The bases are supplied by the caller because the harness, not this
 * script, knows where it puts the worktrees it creates.
 *
 * MORE THAN ONE BASE, because one is wrong whenever it matters. Agent
 * worktrees are created relative to the repo the workflow script lives in
 * (harnessRoot), not the repo being shipped (projectRoot). Those are normally
 * the same directory, which is why the assumption survived, but they diverge
 * exactly when a project is shipped from its own dedicated worktree — the case
 * parallel collection exists to serve. #77 has the empirical confirmation:
 * projectRoot was rungate-65, every worktree was created under rungate, and
 * rungate-65/.claude/worktrees/ did not exist. A single projectRoot-derived
 * base would authorise nothing there and refuse the whole collection.
 */
/**
 * Where git itself puts this repo's agent worktrees (#120).
 *
 * `git worktree add` run from inside a linked worktree resolves against the
 * COMMON dir, so agent worktrees land under the main checkout regardless of
 * which worktree the caller is in. Neither `projectRoot` nor `harnessRoot`
 * controls that, which is why passing both only *happens* to work: it covers
 * the usual case where one of the two is the main checkout, and fails
 * silently whenever neither is — including when a caller deliberately points
 * harnessRoot at their own worktree to avoid executing another session's
 * uncommitted code (#77).
 *
 * Asking git removes the guess. Returns null rather than throwing: this is an
 * additional base, and losing it should degrade to the caller-supplied
 * behaviour, not fail the collection. The failure is logged, though — a
 * silent catch would turn "git is broken" into "there is no such directory",
 * which is the fail-open shape this project keeps getting bitten by.
 */
export function gitWorktreeBase(projectRoot: string): string | null {
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    // Not a repository is the ordinary case and not worth shouting about;
    // anything else means git is present but unhappy, and the caller is about
    // to make an authorisation decision with less information than it thinks.
    const msg = (e as Error).message || "";
    if (!/not a git repository/i.test(msg)) {
      console.error(`collect: WARNING could not ask git where worktrees live: ${msg.split("\n")[0]}`);
    }
    return null;
  }
  if (!commonDir) return null;

  // <main>/.git -> <main>. Anchored to a trailing path segment so a repo at
  // /srv/.github or a directory merely containing ".git" in its name is not
  // silently truncated. A bare repo (no trailing /.git) yields no match and
  // returns null — it has no working tree, so no agent worktrees either.
  const mainRepo = commonDir.replace(/\/\.git\/?$/, "");
  if (mainRepo === commonDir || mainRepo === "") return null;

  // Resolve before handing it out. The comparison downstream is against
  // realpath'd worktree paths, and on macOS /tmp is a symlink to /private/tmp
  // — an unresolved base silently matches nothing.
  let resolved: string;
  try {
    resolved = realpathSync(mainRepo);
  } catch {
    return null;
  }
  return join(resolved, ".claude", "worktrees");
}

/**
 * Which of this repo's worktrees may be collected from.
 *
 * SCOPE BOUND, because this widens what the caller asked for. Two things keep
 * the widening narrow, and both are load-bearing:
 *
 *   1. Candidates come from `git worktree list` for THIS repository. A path
 *      that is not a registered worktree of projectRoot can never be
 *      authorised, whatever the bases say. Another project's worktrees are
 *      not reachable from here at all.
 *   2. The derived base is specifically `<main>/.claude/worktrees` — the
 *      harness's own agent-worktree directory — not the main checkout.
 *
 * Within those bounds the expansion is the point: #77 and #120 are both runs
 * where the caller's bases authorised NOTHING and a finished implementation
 * was thrown away. What the expansion does admit is another session's agent
 * worktrees under the same main checkout, so it is logged rather than done
 * quietly. The collection itself only ever touches worktrees this run's own
 * agents reported, so a logged line is the proportionate response.
 */
export function authorisedWorktrees(projectRoot: string, bases: string[]): string[] {
  const derived = gitWorktreeBase(projectRoot);
  const callerBases = bases;
  if (derived) bases = [derived, ...bases];
  const out = execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf-8",
  });
  const known = out
    .split("\n")
    .filter(l => l.startsWith("worktree "))
    .map(l => l.slice("worktree ".length).trim())
    .filter(Boolean);

  const realBases: string[] = [];
  for (const b of bases) {
    try {
      realBases.push(realpathSync(resolve(b)));
    } catch {
      // A base that does not exist contributes nothing, rather than everything.
    }
  }
  if (realBases.length === 0) return [];

  const under = (roots: string[], w: string): boolean => {
    let real: string;
    try {
      real = realpathSync(resolve(w));
    } catch {
      return false;
    }
    return roots.some(rb => {
      const rel = relative(rb, real);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    });
  };

  const allowed = known.filter(w => under(realBases, w));

  // Say so when the derived base is what let something through. The caller
  // passed a narrower set; silently widening it is the thing security review
  // objected to, and a run log that records WHICH worktrees were admitted on
  // git's authority rather than the caller's is what makes that reviewable
  // after the fact.
  if (derived) {
    const realCaller: string[] = [];
    for (const b of callerBases) {
      try {
        realCaller.push(realpathSync(resolve(b)));
      } catch {}
    }
    const addedByGit = allowed.filter(w => !under(realCaller, w));
    if (addedByGit.length > 0) {
      console.error(
        `collect: NOTE ${addedByGit.length} worktree(s) authorised via git's common dir ` +
          `(${derived}), not via the caller's bases [${callerBases.join(", ")}]: ${addedByGit.join(", ")}`,
      );
    }
  }

  return allowed;
}

// CLI entry point. Guarded so the module can be imported by tests without
// running the collection and calling process.exit — importing it used to
// print the usage line and abort the test run.
if (import.meta.main) {
  main();
}

function main(): void {
const [groupsPath, projectRoot, ...worktreeBases] = process.argv.slice(2);

if (!groupsPath || !projectRoot || worktreeBases.length === 0) {
  console.error("usage: bun scripts/collect-worktree-files.ts <groups.json> <projectRoot> <worktreeBase>...");
  process.exit(2);
}
if (!existsSync(groupsPath)) {
  console.error(`collect: no such groups file: ${groupsPath}`);
  process.exit(2);
}

let results: AgentBuildResult[];
try {
  const parsed = JSON.parse(readFileSync(groupsPath, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error("expected an array of { worktreePath, filesChanged }");
  results = parsed;
} catch (e) {
  console.error(`collect: ${groupsPath} is not valid input: ${(e as Error).message}`);
  process.exit(2);
}

const groups = groupFilesByWorktree(results);
if (groups.length === 0) {
  // Exit non-zero: the caller is about to commit. "Nothing to collect" when
  // agents reported success means the pairing was lost somewhere upstream,
  // which is the #81 failure itself. Silence here would commit nothing and
  // call it a success.
  console.error("collect: no files resolved to any worktree — refusing to report an empty collection as success");
  process.exit(1);
}

let allowed: string[];
try {
  allowed = authorisedWorktrees(projectRoot, worktreeBases);
} catch (e) {
  console.error(`collect: cannot determine this repository's worktrees: ${(e as Error).message}`);
  process.exit(1);
}

let collected;
try {
  collected = collectWorktreeFiles(groups, projectRoot, allowed);
} catch (e) {
  // A traversal or symlink rejection means the inputs cannot be trusted. Abort
  // rather than hand the caller a partially-collected tree to commit.
  console.error(`collect: ${(e as Error).message}`);
  process.exit(1);
}

for (const m of collected.missing) {
  console.error(`collect: WARNING agent reported a file that does not exist: ${m}`);
}

// Stage here rather than printing a list for the caller to stage.
//
// The caller is workflows/ship.js, which can only reach this script through an
// agent step, so anything printed on stdout comes back as free-form LLM text.
// Parsing a file list out of that text put a language model inside a path
// security boundary: prose, a summary, or an invented path would have flowed
// straight into `git add`, and an agent that simply failed to echo the agreed
// failure token would have been read as success. The set of files to stage is
// decided and acted on in the same process that validated them, so no path
// survives a round trip through generated text.
try {
  if (collected.copied.length > 0) {
    execFileSync("git", ["-C", projectRoot, "add", "--", ...collected.copied], { stdio: "pipe" });
  }
} catch (e) {
  console.error(`collect: staging failed: ${(e as Error).message}`);
  process.exit(1);
}

console.error(
  `collect: ${collected.copied.length} file(s) from ${groups.length} worktree(s)` +
    (collected.missing.length ? `, ${collected.missing.length} missing` : ""),
);

// stdout is a receipt, not an instruction: the count is reportable, and the
// paths are listed only for the run log.
console.log(`COLLECTED ${collected.copied.length}`);
for (const p of collected.copied) console.error(`collect:   staged ${p}`);
}
