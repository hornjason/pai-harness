/**
 * Observed failures, mined from the one source that is always in the tree:
 * `fix:` and `Revert` commit subjects (#545).
 *
 * ## Why this source, and not the three others #545 names
 *
 * #545 lists four intake sources — correction language in transcripts, revert
 * and fix-up commits, CI failures on merged PRs, and gate refusals in
 * `workflow-state.json`. Three of them are unreachable from a check running in
 * the configuration CI runs it in:
 *
 * | Source | Needs | Present under an empty `HOME`, no credentials |
 * |---|---|---|
 * | `git log` fix/revert | the repository | **yes** |
 * | CI failures on merged PRs | an authenticated API client | no |
 * | Gate refusals | a populated `~/.rungate` run store | no |
 * | Transcripts | a session store, and a confidentiality decision | no |
 *
 * A miner whose input is absent on a runner has no failing input there and
 * passes vacuously, which is the defect class this repository pays for most
 * often. `git log` is the only one of the four that is offline, in-tree, dated
 * and citable by construction.
 *
 * ## Why a commit subject is a rule candidate at all
 *
 * The thing #544 has to rank on is *a specific observed failure*, not a
 * general principle — "a two-run window cannot falsify a three-arrival model"
 * rather than "verify before asserting". Signal-phrase extraction over prose
 * produces the second kind, 1,010 times on one consumer, with no dates.
 *
 * This repository's commit convention already produces the first kind. Four
 * subjects from `main`, unaltered, beside the hand-written rule each one
 * corresponds to:
 *
 * | Subject | The rule somebody later wrote by hand |
 * |---|---|
 * | `fix(#960): the drift reading stops consulting a config the reviewer can write` | *a control whose input the measured thing can write is not a control* |
 * | `fix(#921): take the containment reading off $HOME` | *run the guard in the configuration CI runs it in* |
 * | `fix(#926, #962): give the bookkeeping list a reachability witness` | *never source a fixture from the list it tests* |
 * | `fix(#506): CONFIG-1 reads the source it could not reach, instead of refusing over it` | *an unreadable position refuses; it does not read as clean* |
 *
 * Each arrives carrying a sha, an ISO date and the issue numbers it cites.
 * Evidence is a property of this source rather than something a scorer infers
 * from text shape, and that is the whole reason #544's promotion criterion can
 * be mechanical.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * This is a classifier, so the honest question is what it misclassifies. Each
 * escape below is asserted as a case in `test/failure-intake-promotion.test.ts`
 * rather than described here and left unmeasured — a documented escape nobody
 * ran is a sentence, not a boundary.
 *
 * - **A trivial `fix:` is mined as though it were an incident.** `fix(#1): the
 *   typo in the README heading (#2)` carries a sha, a date and two issue
 *   numbers, so it outranks every doc-prose candidate. Nothing here reads the
 *   diff, and "was this failure worth a rule" is not a question a subject line
 *   can answer. Narrowing by diff size or by touched path is the obvious next
 *   move and is deliberately not taken here, because a narrowing measured
 *   against nothing is the other half of this defect class.
 * - **A defect fixed under `feat:` is invisible.** `feat(#892): the collect
 *   refusal says whether the copies it refuses are the same bytes` is on `main`
 *   and is rule-shaped; it is not mined, because widening to every
 *   conventional type would admit `chore` and `docs` with it.
 * - **A revert of a revert reads as a failure.** `Revert "Revert "fix(#7): …""`
 *   is a re-land — the original change was right after all — and is classified
 *   as a revert anyway.
 * - **A subject with no description is dropped, not reported.** `fix(#5):` with
 *   nothing after it falls under the ten-character floor and leaves no trace in
 *   the reading. It is counted in `commitsScanned` and nowhere else.
 *
 * The first two are the ones that matter: they are a false positive and a false
 * negative of the SAME classifier, and closing either without measuring the
 * other is how a detector ends up refusing every commit or seeing none.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { contentHash } from "./content-hash";

/** Where a candidate's evidence came from. */
/**
 * `gate-refusal` is produced by `lib/intake-sources.ts`, and `finding` by
 * `lib/finding-arbiter.ts` (#1187) — neither by this module (#545). They
 * live here because `CandidateEvidence` is the one declaration every
 * producer writes against — a second kind union would be two tables
 * agreeing until they did not.
 *
 * `finding` was added rather than reusing one of the others because a
 * finding that survived the filing arbiter is a different kind of
 * observation from a commit subject or a gate refusal: it carries a symptom
 * key, and the thing being budgeted is an ISSUE rather than a rule. The
 * ranking and the cap are `lib/rule-promotion.ts`'s either way, which is the
 * point of adding a member here instead of writing a second promoter.
 */
export type EvidenceKind = "fix-commit" | "revert-commit" | "gate-refusal" | "finding";

export interface CandidateEvidence {
  kind: EvidenceKind;
  /** The commit's ISO 8601 committer date. A candidate without one is not evidence-backed. */
  date: string;
  /** The commit sha. The citation a reader can check. */
  citation: string;
  /** Every `#N` the subject names, in order of appearance, deduplicated. */
  issues: number[];
}

export interface EvidenceCandidate {
  /** The failure, in the committer's own words. Never re-derived. */
  rule: string;
  /** `git:<short sha>`, so a candidate says where to look without a line number that rots. */
  source: string;
  /** The whole subject, kept so the reading never has to be re-parsed to be read. */
  context: string;
  hash: string;
  evidence: CandidateEvidence;
}

/**
 * Why a reading is not a reading. Exported because a caller that wants to
 * distinguish the cases must compare against the producer's own spelling
 * rather than a second copy of it.
 */
export const NOT_A_GIT_REPOSITORY = "NOT_A_GIT_REPOSITORY";
export const SHALLOW_HISTORY = "SHALLOW_HISTORY";
export const GIT_LOG_FAILED = "GIT_LOG_FAILED";

/**
 * How far back to read. Bounded on purpose: HYGIENE-6 is a caller, and #508
 * records that check timing out at 5001ms because a scan it owned had become
 * load-sensitive. One `git log` is one subprocess, and this cap keeps its
 * output bounded as well.
 */
export const MAX_COMMITS_SCANNED = 500;

export interface FailureIntakeReading {
  /**
   * The single discriminator. `unmeasuredReasons` and this field are two
   * projections of one computation, so they cannot disagree.
   */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /**
   * Commits the log actually returned. A reading that produced no candidates
   * over 500 commits and one that produced none over 1 are the same empty
   * list, and only this number tells them apart.
   */
  commitsScanned: number;
  candidates: EvidenceCandidate[];
}

const CONVENTIONAL_FIX = /^fix(?:\(([^)]*)\))?!?:\s*(.+)$/;
const REVERT = /^Revert\s+"(.+)"\s*$/;
const TRAILING_PR = /\s*\(#\d+\)\s*$/;
const ISSUE_REF = /#(\d+)/g;

/**
 * The floor a candidate's text has to clear, matching the one
 * `extractSignalPhrases` applies to doc prose so the two producers do not
 * disagree about what counts as a sentence.
 */
const MIN_RULE_LENGTH = 10;

export interface ClassifiedSubject {
  kind: EvidenceKind;
  rule: string;
  issues: number[];
}

/**
 * THE detector. One binding, so there is one thing to mutate — a second place
 * deciding "is this commit a reported failure" would survive any mutation of
 * this one and the guard would go green for the wrong reason.
 *
 * Returns `null` for a subject that reports no failure.
 */
export function classifyCommitSubject(subject: string): ClassifiedSubject | null {
  const trimmed = subject.trim();

  const reverted = REVERT.exec(trimmed);
  if (reverted) {
    const inner = reverted[1];
    const innerFix = CONVENTIONAL_FIX.exec(inner);
    const description = describe(innerFix ? innerFix[2] : inner);
    if (!description) return null;
    return { kind: "revert-commit", rule: description, issues: issueRefs(trimmed) };
  }

  const fixed = CONVENTIONAL_FIX.exec(trimmed);
  if (fixed) {
    const description = describe(fixed[2]);
    if (!description) return null;
    return { kind: "fix-commit", rule: description, issues: issueRefs(trimmed) };
  }

  return null;
}

/**
 * The sentence, with the trailing `(#PR)` the squash merge appended removed.
 * The PR number is not discarded — `issueRefs` reads it off the whole subject
 * — it is removed from the TEXT, because a rule that ends in a bare number
 * reads as a citation rather than a statement.
 */
function describe(raw: string): string | null {
  const text = raw.replace(TRAILING_PR, "").trim().replace(/[.;]$/, "");
  return text.length >= MIN_RULE_LENGTH ? text : null;
}

function issueRefs(subject: string): number[] {
  const seen: number[] = [];
  for (const m of subject.matchAll(ISSUE_REF)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

function gitStdout(root: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync("git", ["-C", root, ...args], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf-8",
  });
  if (r.error) return { status: -1, out: "", err: r.error.message };
  return { status: r.status ?? -1, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

/**
 * Mine `fix:` and `Revert` commits into evidence-bearing candidates.
 *
 * Three states are refusals rather than empty readings, and the third is the
 * one this module exists to be honest about:
 *
 * - **no repository** — nothing to read. A scaffolded project with no `.git`
 *   hits this and it is not a failure of the project.
 * - **`git log` could not run** — including a repository with no commits at
 *   all, which exits 128. An empty history is not a history with no fixes.
 * - **a shallow clone** — the reading is of a truncated history, so zero
 *   candidates means nothing. `actions/checkout@v4` with no `fetch-depth`
 *   clones to depth 1, so this is the state a CI runner is in by default and
 *   the reading there is UNMEASURED on every run, not a silent pass.
 *
 * In every case the candidates found so far are still returned. Withholding
 * them would make a refusal and an empty tree look alike from the outside,
 * which is the shape being avoided.
 */
export function mineFixCommits(
  root: string,
  options?: { maxCommits?: number },
): FailureIntakeReading {
  const unmeasuredReasons: string[] = [];
  const empty = (): FailureIntakeReading => ({
    reading: "UNMEASURED",
    unmeasuredReasons,
    commitsScanned: 0,
    candidates: [],
  });

  if (!existsSync(join(root, ".git"))) {
    unmeasuredReasons.push(NOT_A_GIT_REPOSITORY);
    return empty();
  }

  const shallow = gitStdout(root, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.status === 0 && shallow.out.trim() === "true") {
    unmeasuredReasons.push(SHALLOW_HISTORY);
  }

  const max = options?.maxCommits ?? MAX_COMMITS_SCANNED;
  // %x1f is the ASCII unit separator: it cannot occur in a subject, so the
  // split cannot be defeated by a commit message containing the delimiter.
  const log = gitStdout(root, [
    "log",
    "--no-merges",
    `-n${max}`,
    "--format=%H%x1f%cI%x1f%s",
  ]);
  if (log.status !== 0) {
    unmeasuredReasons.push(`${GIT_LOG_FAILED}: ${log.err || "(no stderr)"}`);
    return empty();
  }

  const lines = log.out.split("\n").filter((l) => l.length > 0);
  const candidates: EvidenceCandidate[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const [sha, date, subject] = line.split("\u001f");
    if (!sha || !date || subject === undefined) continue;
    const classified = classifyCommitSubject(subject);
    if (!classified) continue;
    const hash = contentHash(classified.rule);
    // The dedup key carries the KIND; the hash does not.
    //
    // Those are two different questions and the first draft asked only one.
    // `Revert "fix(#921): take the containment reading off $HOME"` describes
    // the same sentence as the commit it reverts and means the opposite
    // thing, so a key of the sentence alone drops one of the two — measured,
    // as the first red this module's battery produced.
    //
    // The HASH stays the sentence, because the hash is what
    // `reference/rejected-constraints.md` matches on, and a
    // veto is a judgement about a sentence. So vetoing one vetoes both, which
    // is the intended reading and is asserted rather than assumed.
    const key = `${classified.kind}:${hash}`;
    // Newest first, so the first occurrence of a repeated sentence is the one
    // kept — a re-land cites the most recent observation, not the oldest.
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      rule: classified.rule,
      source: `git:${sha.slice(0, 8)}`,
      context: subject,
      hash,
      evidence: {
        kind: classified.kind,
        date,
        citation: sha,
        issues: classified.issues,
      },
    });
  }

  return {
    reading: unmeasuredReasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons,
    commitsScanned: lines.length,
    candidates,
  };
}
