/**
 * Which open pull request a finding belongs on (#1343).
 *
 * ## The hand-routing this replaces
 *
 * Measured while working #1261: about 45% of filings named a file an open PR
 * was already changing, and a finding routed to the tracker in that situation
 * is a race — the PR lands and the issue describes code that no longer exists.
 * The same shape arrives from the other direction on the review path, because
 * `ai-review` reads the MERGE REF: a defect that lives on `main` is attributed
 * to whichever pull request is standing closest, and a `high` naming a file
 * that PR never opened is a red no author can clear from their branch. Both
 * were being resolved by hand, one finding at a time, by reading the finding
 * and then reading diffs until one of them contained the file.
 *
 * That lookup is mechanical and this module is it.
 *
 * ## What a match claims, and what it does not
 *
 * #1343 is right that file-level matching is the cheap signal: a finding that
 * names a file an open PR touches may have nothing to do with that PR's
 * change. So the reading here is deliberately narrower than "these are about
 * the same thing". **It is a claim about a race, not about a topic**: somebody
 * is editing this file right now, so a tracker row about it will be stale
 * before anybody reads it, and the person holding the file is the person who
 * can act. That claim is true whether or not the finding and the PR share a
 * subject, which is why the cheap signal is the right one for THIS question.
 *
 * The paths come from the arbiter's own `symptomKeys` — the `file:` half —
 * rather than from a second path extractor written here. One extractor, so a
 * mutation of it cannot be covered by a duplicate that nobody mutated
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * ## No imports, on purpose
 *
 * `test/finding-pr-routing.test.ts` mutates a copy of this file in a temp
 * directory and runs the suite against it. A relative import would die on
 * module resolution there and read as the mutation being rejected on the
 * merits. So the key-to-path step takes `symptomKeys(finding)` output as a
 * string array instead of importing the function that produced it.
 */

/** The prefix `symptomKeys` puts on a repository path. */
export const FILE_KEY_PREFIX = "file:";

/** An open pull request, as little of one as routing needs. */
export interface OpenPullRequest {
  number: number;
  /** Repo-relative paths in its diff, as the API listed them. */
  files: readonly string[];
  /**
   * GitHub's OWN count of the changed files.
   *
   * Carried so a short `files` array is detectable. `gh pr list --json files`
   * fetches one page, and a list cut off at the page size is indistinguishable
   * from a complete one — a PR whose diff was truncated can hold the cited
   * path and never match, which turns a positive answer into a silent
   * `TRACKER`. Comparing the two numbers is a truncation detector that needs
   * no constant and so cannot be wrong about a page size nobody re-read.
   */
  declaredFileCount: number;
}

/**
 * The open pull requests, or the reason there is no reading of them.
 *
 * A corpus that could not be fetched is **not** a corpus with no matches.
 * That conflation is the fail-open `lib/github.ts` closed for the issue list
 * in #1374, and it is worse here: "no open PR touches this file" is the
 * reading that sends the finding to the tracker.
 */
export type OpenPrCorpus =
  | { status: "measured"; prs: readonly OpenPullRequest[] }
  | { status: "unmeasured"; why: string };

/**
 * Where the finding goes.
 *
 * Six values and not fewer. Each one is a different instruction to whoever is
 * holding the finding, and the two that look collapsible are the two that must
 * not be: `TRACKER` says the question was asked and no open PR owns the file,
 * `UNMEASURED` says it was not asked. `NO_CITED_PATH` is a third state again —
 * the question does not apply, because this instrument routes by path and the
 * finding named none.
 */
export type Route =
  /** The PR under review changes a cited file. It belongs where it is. */
  | "THIS_PR"
  /** Exactly one other open PR changes a cited file. `prs` names it. */
  | "OTHER_PR"
  /** Several do, and picking one would be a guess. `prs` names them all. */
  | "AMBIGUOUS"
  /** No open PR changes any cited file. The tracker is the right home. */
  | "TRACKER"
  /** The finding cites no repository path, so this instrument says nothing. */
  | "NO_CITED_PATH"
  /** The corpus could not be read, or was read incompletely. */
  | "UNMEASURED";

export interface Routing {
  route: Route;
  /** Every path the finding cites — the population the rest is drawn from. */
  citedPaths: string[];
  /** The pull requests this route names. Empty unless `OTHER_PR`/`AMBIGUOUS`. */
  prs: number[];
  /** The cited paths that produced the match. Empty when there was none. */
  matchedPaths: string[];
  /** How many open PRs were considered. `null` when there was no corpus. */
  consideredPrs: number | null;
  /** Why, in a sentence a reader can act on without re-running anything. */
  reason: string;
}

export interface RouteOptions {
  corpus: OpenPrCorpus;
  /**
   * The pull request the finding arrived on, when it arrived on one.
   *
   * Never reported as an `OTHER_PR`: routing a finding away from the PR it is
   * already on is not routing, it is a loop.
   */
  thisPr?: number;
  /**
   * That PR's changed files, when the caller knows them firsthand.
   *
   * The caller's own diff beats the corpus row for the same PR, because the
   * caller read it from the tree it is standing in and the corpus row is a
   * fetch that may already be stale — #1370 merged between two `gh pr list`
   * calls thirty seconds apart while this was being written.
   */
  changedFiles?: readonly string[];
}

/**
 * Paths, from `symptomKeys` output.
 *
 * Lower-cased already by the arbiter; normalised again here so a caller
 * passing a raw path list (the `file` field of an `ai-review` payload, which
 * is not a symptom key) gets the same treatment.
 */
export function citedPathsFromKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(FILE_KEY_PREFIX)) continue;
    const path = normalisePath(key.slice(FILE_KEY_PREFIX.length));
    if (path !== "" && !out.includes(path)) out.push(path);
  }
  return out;
}

/** One spelling of a path: lower-case, no `./` and no leading slash. */
export function normalisePath(value: string): string {
  let path = value.trim().toLowerCase().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  return path;
}

/**
 * Does `path` name the file `cited` names?
 *
 * Equality, or `cited` as a whole trailing SEGMENT of `path` — never a bare
 * `endsWith`. A finding may cite `rungate.ts` where the diff says
 * `bin/rungate.ts`, and a bare suffix test would make that cited path match
 * `lib/my-rungate.ts` just as well, which manufactures an `AMBIGUOUS` out of
 * two unrelated files.
 */
export function pathMatches(cited: string, path: string): boolean {
  return path === cited || path.endsWith("/" + cited);
}

/** Paths of `cited` this pull request's diff contains. */
function pathsIn(cited: readonly string[], files: readonly string[]): string[] {
  const normalised = files.map(normalisePath);
  return cited.filter(c => normalised.some(f => pathMatches(c, f)));
}

/**
 * The single place that decides, over paths the caller already extracted.
 *
 * The order is load-bearing and each step is commented with why it sits where
 * it does. The one that is easy to get backwards is `THIS_PR`: it is answered
 * BEFORE the corpus is consulted at all, because it is decided from the
 * caller's own diff and is therefore still correct when the corpus is
 * unreadable. Demoting it below the corpus guard would turn an answerable
 * question into `UNMEASURED` on every network hiccup.
 */
export function routePaths(citedPaths: readonly string[], options: RouteOptions): Routing {
  const cited = citedPaths.map(normalisePath).filter(p => p !== "");
  const unique: string[] = [];
  for (const p of cited) if (!unique.includes(p)) unique.push(p);
  const corpus = options.corpus;
  const considered = corpus.status === "measured" ? corpus.prs.length : null;
  const base = { citedPaths: unique, prs: [] as number[], matchedPaths: [] as string[], consideredPrs: considered };

  // ── 1. is there anything to route ON? ──
  if (unique.length === 0) {
    return {
      ...base,
      route: "NO_CITED_PATH",
      reason: "the finding cites no repository path, so no pull request can be matched by file",
    };
  }

  // ── 2. does the PR it arrived on already own it? ──
  const ownRow =
    corpus.status === "measured" && options.thisPr !== undefined
      ? corpus.prs.find(p => p.number === options.thisPr)
      : undefined;
  const ownFiles = options.changedFiles ?? ownRow?.files;
  if (ownFiles !== undefined) {
    const own = pathsIn(unique, ownFiles);
    if (own.length > 0) {
      return {
        ...base,
        route: "THIS_PR",
        matchedPaths: own,
        ...(options.thisPr !== undefined ? { prs: [options.thisPr] } : {}),
        reason: `this change touches ${own.join(", ")}, so the finding is about the diff at hand`,
      };
    }
  }

  // ── 3. was the corpus read at all? ──
  if (corpus.status !== "measured") {
    return { ...base, route: "UNMEASURED", reason: `the open pull requests were not read: ${corpus.why}` };
  }

  // ── 4. was every diff read in full? ──
  const truncated = corpus.prs.filter(p => p.files.length !== p.declaredFileCount);
  if (truncated.length > 0) {
    return {
      ...base,
      route: "UNMEASURED",
      prs: truncated.map(p => p.number),
      reason:
        `${truncated.map(p => `#${p.number} listed ${p.files.length} of ${p.declaredFileCount} files`).join("; ")}` +
        " — a diff read in part can hold the cited path and never match, so neither a hit nor a miss is a reading here",
    };
  }

  // ── 5. who else is holding the file? ──
  const scored = corpus.prs
    .filter(p => p.number !== options.thisPr)
    .map(p => ({ pr: p.number, matched: pathsIn(unique, p.files) }))
    .filter(row => row.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length || a.pr - b.pr);
  if (scored.length === 0) {
    return {
      ...base,
      route: "TRACKER",
      reason: `none of the ${corpus.prs.length} open pull requests change ${unique.join(", ")}`,
    };
  }
  const best = scored[0].matched.length;
  const top = scored.filter(row => row.matched.length === best);
  if (top.length > 1) {
    return {
      ...base,
      route: "AMBIGUOUS",
      prs: top.map(row => row.pr),
      matchedPaths: top[0].matched,
      reason:
        `${top.map(row => `#${row.pr}`).join(" and ")} both change ${top[0].matched.join(", ")} — ` +
        "picking one would be a guess, so the choice stays with whoever is holding the finding",
    };
  }
  return {
    ...base,
    route: "OTHER_PR",
    prs: [scored[0].pr],
    matchedPaths: scored[0].matched,
    reason: `#${scored[0].pr} changes ${scored[0].matched.join(", ")}, which this finding names`,
  };
}

/** One line a caller can print without re-deriving any of the above. */
export function routingSummary(routing: Routing): string {
  const where = routing.prs.length > 0 ? ` ${routing.prs.map(n => `#${n}`).join(",")}` : "";
  return `ROUTE ${routing.route}${where}: ${routing.reason}`;
}
