#!/usr/bin/env bun
/**
 * ai-review-control/outcomes-run.ts — backfill the finding-outcome taxonomy
 * over a repository's real history (#1225).
 *
 *   bun evals/ai-review-control/outcomes-run.ts --repo hornjason/pai-harness
 *   bun evals/ai-review-control/outcomes-run.ts --repo <o/n> --json
 *
 * `outcomes.ts` is pure and knows nothing about `gh` or `git`. This is the
 * half that turns a repository into the corpus it scores, and every judgement
 * it makes about what counts is declared here rather than buried:
 *
 * - **An issue is a finding; a pull request is not.** The tracker is where
 *   findings land in this repo — the inline-comment surface Anthropic measures
 *   holds 3 comments repo-wide, measured 2026-10-22, which is why the corpus
 *   is the tracker and the summary says so.
 * - **A citation is the issue number in a conventional-commit SUBJECT scope**
 *   (`fix(#1169): …`), and nothing else. The trailing `(#1201)` is the pull
 *   request and is excluded — it is the merge, not the finding. Closing
 *   keywords in the commit BODY were scanned too, in the first version, and
 *   the plants refused the result: it moved 21 findings into FIXED, and both
 *   of the two sampled were prose. `gh closes #23 in unprotected/x` is a test
 *   command being described and `Closing #23 but no workflow-state.json
 *   found` is quoted tool output. Commit bodies here discuss issue numbers
 *   constantly, so a keyword scan over them is a detector that reads
 *   discussion as evidence — and it errs toward FIXED, which is the direction
 *   that makes the reviewer look better than it is.
 * - **A supersede target is an id named by the LAST comment on a closed
 *   finding.** The close is where "duplicate of #N" is written. Earlier
 *   comments cite freely and reading them all turns every discussion into a
 *   supersede edge.
 *
 *   Be precise about how strong that edge is, because `outcomes.ts` walks it
 *   transitively and transitivity is only sound over a relation that is
 *   actually transitive. It is a **reference inside a human-authored close**,
 *   not a parsed declaration and not an inferred similarity. Measured over
 *   the 101 SUPERSEDED rows on 2026-10-22: 71 carry an explicit supersession
 *   phrase (`duplicate of`, `superseded by`, `shipped in`, `closed by`), and
 *   the remaining 30 carry only a bare `#N`. Six of those 30 were read by
 *   hand and all six were genuine — "Delivered in the same commit as Phase 1
 *   … (PR #667)", "Merged with its parent #621 in #628" — so the shortfall is
 *   in the phrase list, not in the edges. The claim this supports is "a human
 *   closing this finding pointed at that one", and no more.
 *
 *   The distinction matters to anyone reusing the walk: rg-1187's finding
 *   arbiter builds edges by shared symptom keys, and transitivity over a
 *   *similarity* relation is unsound — measured there, it merges 12 unrelated
 *   issues into one component through a single articulation point. Transitive
 *   here, one-hop there, and the difference is who authored the edge.
 *
 * ## The shallow-clone refusal
 *
 * A shallow checkout is the failure this script is most likely to suffer and
 * least likely to show. `git log origin/main` in a depth-limited clone returns
 * a perfectly well-formed history that happens to start four days ago, so
 * every finding older than the cut loses its citation and lands in NO_ACTION —
 * a noise metric that reports almost pure noise, with nothing in the output
 * saying why. Writing this script in such a clone produced exactly that: 294
 * commits where the real history has 1205. So a truncated history is a
 * refusal, naming `git fetch --deepen`, and not a warning.
 *
 * It asks the precise question rather than the cheap one. `git rev-parse
 * --is-shallow-repository` stays `true` after a deepen that reached the root,
 * and it answers for the whole object store rather than for the branch being
 * read: in the checkout this was written against it reported `true` while the
 * only boundary left belonged to a ref `origin/main` cannot reach. Refusing on
 * that flag would have made the instrument unrunnable in the repository it was
 * built for — a guard that fails closed on the wrong question is still a guard
 * nobody can use. The question that matters is whether a root of `origin/main`
 * is a graft, so that is the one asked.
 *
 * ## The plants decide whether the run is a reading
 *
 * `REVIEW_OUTCOME_PLANTS` holds four real findings whose outcome was
 * established independently. If the sweep disagrees with any of them the run
 * exits non-zero regardless of how clean the counts look, because a sweep that
 * cannot see its own known-positives is not distinguishable from a blind one.
 * They are repo-specific by construction, so `--no-plants` runs the taxonomy
 * against another repository — and the output then says, in the population
 * line, that it was unplanted.
 */
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";

import {
  REVIEW_OUTCOME_PLANTS,
  readFindingOutcomes,
  summariseFindingOutcomes,
  verifyOutcomePlants,
  type FindingCitation,
  type ReviewFinding,
} from "./outcomes";

/** Non-zero for every refusal, through one constant. */
const REFUSED = 1;

/** `fix(#12, #13): …` — the scope of a conventional commit subject. */
const SUBJECT_SCOPE = /^[a-z]+(?:\(([^)]*)\))?!?:/;
/** `… (#1201)` — the squash merge's pull request, never the finding. */
const SUBJECT_PR = /\(#(\d+)\)\s*$/;
const ISSUE_REF = /#(\d+)/g;

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${r.stderr ?? ""}`);
  return r.stdout;
}

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/**
 * Issue references in a blob of text, as STRINGS.
 *
 * `ReviewFinding.id` is a string since #1253 — an unfiled candidate has no
 * issue number — so the whole corpus is keyed on strings and this never
 * parses to a number on the way through. `String(Number(x))` would also
 * normalise `#007` to `7`; here `007` and `7` stay distinct, which is right,
 * because two spellings of a reference are two references until something
 * resolves them.
 */
function refs(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map(m => m[1]);
}

/** No `body`: it is not read, and a field nobody consumes reads as evidence. */
interface Commit {
  sha: string;
  at: number;
  subject: string;
  filesChanged: number;
}

/**
 * Read `origin/main`'s commits with the file count attached.
 *
 * `--name-only` with a record separator rather than `--shortstat`: a commit
 * that changed nothing and a commit whose stat line failed to parse must be
 * tellable apart, and a count of listed paths cannot be ambiguous about zero.
 */
function readCommits(repoDir: string): Commit[] {
  const out = run("git", [
    "-C",
    repoDir,
    "log",
    "origin/main",
    "--format=\u0001%H\u0002%ct\u0002%s\u0003",
    "--name-only",
  ]);

  const commits: Commit[] = [];
  for (const chunk of out.split("\u0001")) {
    if (chunk.trim() === "") continue;
    const [header, rest = ""] = chunk.split("\u0003");
    const [sha, at, subject] = header.split("\u0002");
    const filesChanged = rest.split("\n").filter(l => l.trim() !== "").length;
    commits.push({ sha, at: Number(at), subject, filesChanged });
  }
  return commits;
}

/**
 * Roots of `origin/main` that are shallow boundaries rather than real roots.
 *
 * Exported so a test can point it at a deliberately shallow clone: a guard
 * nobody has watched fail is a line in a report. A parentless commit and a
 * graft are the same shape to `git log`, and `.git/shallow` is the only thing
 * that tells them apart.
 */
export function graftedRoots(repoDir: string): string[] {
  const shallowPath = run("git", ["-C", repoDir, "rev-parse", "--git-path", "shallow"]).trim();
  const absolute = shallowPath.startsWith("/") ? shallowPath : `${repoDir}/${shallowPath}`;
  if (!existsSync(absolute)) return [];

  const boundary = new Set(
    readFileSync(absolute, "utf-8").split("\n").map(l => l.trim()).filter(l => l !== ""),
  );
  return run("git", ["-C", repoDir, "rev-list", "--max-parents=0", "origin/main"])
    .split("\n")
    .map(l => l.trim())
    .filter(l => l !== "" && boundary.has(l));
}

interface GhIssue {
  number: number;
  state: string;
  created_at: string;
  pull_request?: unknown;
}

function readTracker(repo: string): { issues: GhIssue[]; lastComment: Map<number, string> } {
  const issues = JSON.parse(
    run("gh", ["api", "--paginate", `repos/${repo}/issues?state=all&per_page=100`]),
  ) as GhIssue[];

  const comments = JSON.parse(
    run("gh", ["api", "--paginate", `repos/${repo}/issues/comments?per_page=100`]),
  ) as { html_url: string; body: string; created_at: string }[];

  // Keyed by the number in the URL, which is the only place the API puts it on
  // this endpoint. Latest wins — the close is the last thing written.
  const latest = new Map<number, { at: number; body: string }>();
  for (const c of comments) {
    const m = /\/(?:issues|pull)\/(\d+)#/.exec(c.html_url);
    if (m === null) continue;
    const n = Number(m[1]);
    const at = epoch(c.created_at);
    const have = latest.get(n);
    if (have === undefined || at >= have.at) latest.set(n, { at, body: c.body ?? "" });
  }

  return {
    issues: issues.filter(i => i.pull_request === undefined),
    lastComment: new Map([...latest].map(([n, v]) => [n, v.body])),
  };
}

export function buildCorpus(
  issues: GhIssue[],
  lastComment: Map<number, string>,
  commits: Commit[],
): { findings: ReviewFinding[]; shipped: Set<string> } {
  const citations = new Map<string, FindingCitation[]>();
  const shipped = new Set<string>();

  for (const c of commits) {
    const cited = new Set<string>();
    const scope = SUBJECT_SCOPE.exec(c.subject);
    if (scope?.[1] !== undefined) for (const n of refs(scope[1], ISSUE_REF)) cited.add(n);

    const pr = SUBJECT_PR.exec(c.subject);
    if (pr !== null) {
      shipped.add(pr[1]);
      cited.delete(pr[1]);
    }

    const entry: FindingCitation = { sha: c.sha, at: c.at, filesChanged: c.filesChanged };
    for (const n of cited) citations.set(n, [...(citations.get(n) ?? []), entry]);
  }

  const findings = issues.map<ReviewFinding>(i => {
    const closed = i.state === "closed";
    const comment = closed ? (lastComment.get(i.number) ?? "") : "";
    return {
      id: String(i.number),
      filedAt: epoch(i.created_at),
      closed,
      citations: citations.get(String(i.number)) ?? [],
      closedInFavourOf: [...new Set(refs(comment, ISSUE_REF))].filter(n => n !== String(i.number)),
      declared: null,
    };
  });

  return { findings, shipped };
}

/**
 * `, #23..#1229` when every id is an issue number, and nothing when they are
 * not. A candidate-ledger corpus keys unfiled rows on a symptom hash, and
 * `Math.min` over those coerces to `NaN` and prints `#NaN..#NaN` — a range
 * that looks like a reading and is not one. Omitting it says less and lies
 * less; the count beside it is the number that matters.
 */
function idRange(findings: readonly ReviewFinding[]): string {
  const numeric = findings.map(f => Number(f.id));
  if (findings.length === 0 || numeric.some(n => !Number.isFinite(n))) return "";
  return `, #${Math.min(...numeric)}..#${Math.max(...numeric)}`;
}

export function main(argv: string[]): number {
  const at = argv.indexOf("--repo");
  const repo = at === -1 ? "" : (argv[at + 1] ?? "");
  if (repo === "") {
    process.stderr.write("usage: outcomes-run.ts --repo <owner/name> [--json] [--no-plants]\n");
    return REFUSED;
  }
  const repoDir = argv.includes("--dir") ? (argv[argv.indexOf("--dir") + 1] ?? ".") : ".";

  const grafted = graftedRoots(repoDir);
  if (grafted.length > 0) {
    process.stderr.write(
      `refusing to measure a truncated history: ${grafted.join(", ")} looks like a root of ` +
        "origin/main but is a shallow boundary. `git log origin/main` would return a " +
        "well-formed history that starts at the depth cut, and every finding older than it " +
        "would lose its citation and land in NO_ACTION. Run `git fetch --deepen=5000 origin main`.\n",
    );
    return REFUSED;
  }

  const commits = readCommits(repoDir);
  const { issues, lastComment } = readTracker(repo);
  const { findings, shipped } = buildCorpus(issues, lastComment, commits);

  const readings = readFindingOutcomes(findings, shipped);
  const planted = !argv.includes("--no-plants");
  const run_ = summariseFindingOutcomes(
    readings,
    `every issue in ${repo} (${findings.length} findings${idRange(findings)}), scored against ` +
      `${commits.length} commits on ` +
      `origin/main. Pull requests are excluded: the tracker is the finding surface here. ` +
      (planted ? `Plants: ${REVIEW_OUTCOME_PLANTS.map(p => `#${p.id}`).join(", ")}.` : "UNPLANTED."),
  );

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ summary: run_, readings }, null, 2)}\n`);
  } else {
    process.stdout.write(`population: ${run_.population}\n  ${run_.filter}\n`);
    process.stdout.write(`citation filter: ${run_.citationFilter}\n`);
    process.stdout.write(`  dropped ${run_.droppedCitations} citation(s) under it\n\n`);
    for (const [k, v] of [
      ["FIXED", run_.fixed],
      ["SUPERSEDED", run_.superseded],
      ["NO_ACTION", run_.noAction],
      ["WRONG", run_.wrong],
      ["INTENTIONAL", run_.intentional],
      ["DIDNT_MATTER", run_.didntMatter],
      ["OPEN", run_.open],
      ["SUPPRESSED", run_.suppressed],
      ["UNMEASURED", run_.unmeasured],
    ] as const) {
      process.stdout.write(`  ${k.padEnd(14)}${v}\n`);
    }
    process.stdout.write(
      `\nclosed=${run_.closed} cost=${run_.cost} costRate=${run_.costRate?.toFixed(3) ?? "-"}\n` +
        `declaredCoverage=${run_.declaredCoverage} noiseRate=${run_.noiseRate?.toFixed(3) ?? "WITHHELD"}\n`,
    );
  }

  if (!run_.usable) {
    process.stderr.write(`${run_.detail.filter(d => d.includes("measured nothing")).join("\n")}\n`);
    return REFUSED;
  }

  if (planted) {
    const plants = verifyOutcomePlants(readings);
    for (const line of plants.detail) process.stderr.write(`plant: ${line}\n`);
    if (!plants.verified) return REFUSED;
    // stderr under --json, and not stdout: a --json mode whose stdout carries
    // a trailing human line is not JSON, and every consumer of the flag dies
    // on `Extra data: line N`. The confirmation is diagnostic either way.
    const agreed = `plants: ${REVIEW_OUTCOME_PLANTS.length}/${REVIEW_OUTCOME_PLANTS.length} agree\n`;
    if (argv.includes("--json")) process.stderr.write(agreed);
    else process.stdout.write(agreed);
  }

  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
