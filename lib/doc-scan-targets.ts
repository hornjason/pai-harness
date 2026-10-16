/**
 * Where a project's documentation actually lives (#440).
 *
 * `collectScanTargets` was four flat `readdirSync` loops — `*.md`, `docs/*.md`
 * (skipping `archive`), `docs/adr/*.md`, `specs/*.md` — with no recursion.
 * Measured on a consumer project: 84 files scanned, **28 missed**, and every
 * one of the 28 sat in a directory that project's own
 * `.claude/rules/docs-routing.md` names as a documentation location.
 *
 * | Missed | files |
 * |---|---|
 * | `docs/specs/` | 17 |
 * | `reference/` | 5 |
 * | `docs/designs/` | 3 |
 * | `docs/agents/` | 3 |
 *
 * `docs/specs/` is the headline: specs are the densest source of hard
 * constraints in a repo, and the extractor scanned `specs/` (2 files) while
 * skipping `docs/specs/` (17). Same word, different directory, silently
 * dropped.
 *
 * The fix that makes it self-correcting is to stop hardcoding. Every
 * scaffolded project already has a routing table enumerating where its
 * documentation lives — scaffold WRITES that file — so deriving the scan from
 * it makes the extractor track each project's actual layout instead of a list
 * someone has to remember to update.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";

/**
 * Directory names never descended into, wherever they appear.
 *
 * ONE exported list, so there is one thing to mutate and one place to add to.
 * `worktrees` covers `.claude/worktrees`, which is the case the issue names:
 * a worktree is a second copy of the whole repo, so descending into one
 * doubles every constraint and attributes half of them to a path that will
 * not exist tomorrow.
 */
export const SCAN_EXCLUDE_DIRS: readonly string[] = [
  "archive", "node_modules", ".git", "worktrees", "dist", "build", "coverage",
];

/**
 * How deep recursion goes beneath a named root.
 *
 * Bounded because the roots come from a file in the repo, and an unbounded
 * walk driven by repo content is a denial of service with extra steps. Six is
 * well past anything observed: the deepest documentation path measured was
 * `specs/bootstrap-data-flow/<file>.md`, at two.
 */
export const MAX_SCAN_DEPTH = 6;

/**
 * Scanned when a project has no routing table.
 *
 * Exactly the four the hardcoded version used, so a project without a routing
 * table sees no change in behaviour — the fallback is the old code, named and
 * reported rather than assumed.
 */
export const DEFAULT_SCAN_DIRS: readonly string[] = ["docs", "docs/adr", "specs"];

export const ROUTING_RELATIVE_PATH = join(".claude", "rules", "docs-routing.md");

export interface DocScanPlan {
  /** Which list the roots came from. Never inferred by the caller. */
  source: "routing" | "default";
  /** Why, in a sentence — so a report can say it rather than imply it. */
  reason: string;
  /** Directories, relative to the project, that exist and were walked. */
  roots: string[];
  /**
   * Directories the routing table names that are NOT on disk.
   *
   * UNMEASURED, not skipped. A routing table that has drifted from the tree
   * is a finding about the project, and `0`, `[]` and "fine" are
   * indistinguishable if it is dropped — which is the whole subject of
   * `.claude/rules/config-access.md`'s *Silent Default Substitution*.
   */
  unmeasured: string[];
  /** Absolute paths, root-level flat plus each root walked. */
  files: string[];
  /**
   * Paths refused because they resolve outside the project (BUG-440-A).
   *
   * Reported rather than dropped, for the same reason `unmeasured` is: a
   * symlinked documentation root that silently contributes nothing is
   * indistinguishable from one that was read and happened to be empty.
   */
  refused: string[];
}

/**
 * The resolved path, if it is really inside the project. Otherwise null.
 *
 * Lexical checks — `startsWith("/")`, `includes("..")` — cannot see a
 * symlink, and recursion is what made that matter: the flat scan this
 * replaces could not descend into `docs/elsewhere -> /somewhere`, so the
 * exposure arrived with the walk. `extract-constraints` turns every `.md`
 * sentence it reaches into a candidate constraint written to AGENTS.md, so
 * one symlink in a cloned repo would copy markdown from anywhere the process
 * can read into this project's rules.
 *
 * Containment, not a symlink ban: a link within the repo is ordinary, and
 * refusing it would be a narrower detector than the thing being detected.
 */
function containedReal(rootReal: string, path: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  const rel = relative(rootReal, real);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
  return real;
}

/**
 * Everything from the "Where to Create Things" heading onwards.
 *
 * The routing file has TWO tables and they mean different things. The first
 * answers "where do I read about X"; the second answers "where do I put a new
 * X", and it includes `src/` and `test/`. Reading both conflates
 * documentation with source — measured on this repo, it pulled 36 files out
 * of `test/fixtures/`, which is a synthetic project whose "constraints" would
 * then be extracted and attributed to the real one.
 *
 * The cut is by SECTION rather than by column position. A parser tied to a
 * column layout would silently read half when one table changed shape; a
 * heading is what actually separates the two meanings.
 */
const CREATE_SECTION = /^##\s+Where to Create Things\s*$/m;

/**
 * The directories a routing table names as places documentation is READ from.
 *
 * Tokens ending in `/` are directories; `CODE-MAP.md` and friends are single
 * files already caught by the flat root scan.
 */
export function routedDirectories(routingText: string): string[] {
  const cut = CREATE_SECTION.exec(routingText);
  const readSection = cut ? routingText.slice(0, cut.index) : routingText;
  const out: string[] = [];
  for (const m of readSection.matchAll(/`([^`]+)`/g)) {
    const token = m[1]!.trim();
    if (!token.endsWith("/")) continue;
    const dir = token.replace(/\/+$/, "");
    if (dir === "" || dir.startsWith("/") || dir.includes("..")) continue;
    // "(6 specs)" and similar annotations live outside the backticks, but a
    // token with whitespace in it is prose, not a path.
    if (/\s/.test(dir)) continue;
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

interface WalkState {
  projectPath: string;
  rootReal: string;
  /**
   * Resolved paths already handled.
   *
   * Keyed on the RESOLVED path, which is what makes it do two jobs: it stops
   * a symlink loop, and it stops one file reachable under two names from
   * being collected twice. A file counted twice reads as two independent
   * sources agreeing, which is the evidence a reader weighs most heavily.
   */
  seen: Set<string>;
  files: string[];
  refused: string[];
}

/**
 * The project-anchored canonical spelling of a contained path.
 *
 * `real` is correct but anchored on the resolved root, and on macOS that is
 * `/private/var/...` where the caller said `/var/...`. Callers do
 * `relative(projectPath, file)`, so the path has to keep the caller's
 * spelling of the root while taking the resolved spelling of everything
 * below it.
 *
 * Reporting the canonical name also makes the list deterministic: a file
 * reachable both directly and through an internal symlink was otherwise
 * recorded under whichever name `readdirSync` happened to return first.
 */
function anchored(projectPath: string, rootReal: string, real: string): string {
  const rel = relative(rootReal, real);
  return rel === "" ? projectPath : join(projectPath, rel);
}

function walkMarkdown(dir: string, depth: number, st: WalkState): void {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const isMarkdown = entry.endsWith(".md");
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir && SCAN_EXCLUDE_DIRS.includes(entry)) continue;
    if (!isDir && !isMarkdown) continue;

    const real = containedReal(st.rootReal, path);
    if (real === null) {
      st.refused.push(path);
      continue;
    }
    if (st.seen.has(real)) continue;
    st.seen.add(real);

    if (isDir) walkMarkdown(path, depth + 1, st);
    else st.files.push(anchored(st.projectPath, st.rootReal, real));
  }
}

/**
 * Plan the scan for one project.
 *
 * Root-level `.md` files are read FLAT, exactly as before — recursing from
 * the project root would reach `test/`, `lib/` and every fixture in the tree.
 * Only the named documentation directories are walked.
 */
export function planDocScan(projectPath: string): DocScanPlan {
  const routingPath = join(projectPath, ROUTING_RELATIVE_PATH);
  const hasRouting = existsSync(routingPath);

  let declared: string[];
  let source: DocScanPlan["source"];
  let reason: string;

  if (hasRouting) {
    const routed = routedDirectories(readFileSync(routingPath, "utf-8"));
    // UNION with the defaults, never replacement. This repo's own routing
    // table names `docs/adr/` and `docs/research/` but not `docs/` — so a
    // routing-only scan would have LOST the top-level `docs/*.md` the old
    // code read. A fix for a scan that missed 28 files must not miss
    // different ones.
    declared = [...new Set([...routed, ...DEFAULT_SCAN_DIRS])];
    // `source` answers "did the routing table contribute anything", which is
    // not the same question as "does the file exist". A table naming nothing
    // leaves the defaults doing all the work, and saying "routing" there
    // would report a derivation that did not happen.
    source = routed.length > 0 ? "routing" : "default";
    reason = routed.length > 0
      ? `${routed.length} directories named in ${ROUTING_RELATIVE_PATH}, unioned with the default set`
      : `${ROUTING_RELATIVE_PATH} exists but names no directories — the default set only`;
  } else {
    declared = [...DEFAULT_SCAN_DIRS];
    source = "default";
    reason = `no ${ROUTING_RELATIVE_PATH} — scanning the documented default set`;
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(projectPath));
  } catch {
    // Loud, not empty. A project root that cannot be resolved has nothing to
    // scan, and returning zero files would be indistinguishable from a
    // project whose documentation is genuinely empty — Silent Default
    // Substitution, in `.claude/rules/config-access.md`'s terms.
    throw new Error(`cannot scan documentation: ${projectPath} does not resolve to a directory`);
  }

  const st: WalkState = {
    projectPath,
    rootReal,
    seen: new Set<string>(),
    files: [],
    refused: [],
  };

  const roots: string[] = [];
  const unmeasured: string[] = [];
  for (const dir of declared) {
    const abs = join(projectPath, dir);
    let present: boolean;
    try {
      present = statSync(abs).isDirectory();
    } catch {
      present = false;
    }
    if (present && containedReal(st.rootReal, abs) === null) {
      // A routed root that leaves the project is neither walked nor silently
      // treated as missing — "the project does not have this" and "the
      // project points this somewhere I will not follow" are different facts.
      st.refused.push(abs);
      continue;
    }
    // Only a ROUTING entry can be unmeasured. A default directory a project
    // simply does not have is not drift; the routing table is a claim the
    // project made about itself, and a claim that does not hold is a finding.
    if (present) roots.push(dir);
    else if (source === "routing" && !DEFAULT_SCAN_DIRS.includes(dir)) unmeasured.push(dir);
  }

  try {
    for (const f of readdirSync(projectPath)) {
      if (!f.endsWith(".md")) continue;
      const path = join(projectPath, f);
      const real = containedReal(st.rootReal, path);
      if (real === null) { st.refused.push(path); continue; }
      if (st.seen.has(real)) continue;
      st.seen.add(real);
      st.files.push(anchored(projectPath, st.rootReal, real));
    }
  } catch {
    // An unreadable project root is the caller's problem, not a silent empty
    // scan — it will show as zero files against a reason that says otherwise.
  }
  for (const dir of roots) walkMarkdown(join(projectPath, dir), 1, st);

  st.files.sort();
  st.refused.sort();
  return { source, reason, roots, unmeasured, files: st.files, refused: st.refused };
}

/** Relative paths, for a report that a human reads. */
export function planSummary(projectPath: string, plan: DocScanPlan): string {
  const parts = [
    `scan: ${plan.files.length} files from ${plan.roots.length} directories (${plan.source} — ${plan.reason})`,
  ];
  if (plan.refused.length > 0) {
    parts.push(
      `REFUSED: ${plan.refused.map(r => relative(projectPath, r) || r).join(", ")} — resolves outside the project`,
    );
  }
  if (plan.unmeasured.length > 0) {
    parts.push(
      `UNMEASURED: ${plan.unmeasured.join(", ")} — named in ${ROUTING_RELATIVE_PATH} but not present in ${relative(projectPath, projectPath) || "the project"}`,
    );
  }
  return parts.join("\n");
}
