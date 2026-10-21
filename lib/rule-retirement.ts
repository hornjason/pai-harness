/**
 * Retire a candidate whose citation no longer resolves (#544, SC-1941).
 *
 * ## Why this is the half that makes the rest safe
 *
 * `lib/failure-intake.ts` mines candidates out of commit subjects and
 * `scripts/extract-constraints.ts` mines them out of documents. Both cite a
 * position: a commit sha, or a `path:line`. Neither has ever checked that the
 * position is still there, and `lib/rule-promotion.ts` says so in its own
 * WHAT THIS DOES NOT COVER:
 *
 *   > Nothing reads whether the cited evidence still resolves. [...] a
 *   > candidate citing a commit that has been rebased away still ranks on its
 *   > date.
 *
 * That is not a theoretical gap in this repository. `main` is squash-merged
 * and branches are rebased onto it constantly, so the sha a candidate was
 * mined from is routinely not the sha that landed. A candidate citing one
 * ranks top of the list — recency is the only ordering signal — and arrives
 * at the top of the rule file pointing at nothing.
 *
 * Retirement is also the only thing in the lifecycle that REMOVES. A ladder
 * that only adds degrades the thing it feeds: `docs/research/context-
 * management.md` measures rule-set effectiveness collapsing past roughly
 * sixteen rules, over the total in context. So the generator has to be able
 * to stop emitting, and this is where it does.
 *
 * ## Retire, do not warn
 *
 * SC-1941 says *auto-retired, not warned about*, and the spec gives the
 * reason three sections earlier: a warning is how 1,010 candidates
 * accumulated. A retired candidate is dropped from the population the
 * promoter ranks and reported with the detail that retired it. Nothing asks
 * anybody to approve it.
 *
 * ## UNANSWERABLE IS NOT RESOLVED, AND IT IS NOT GONE EITHER
 *
 * This is the whole correctness question and it has a direction.
 *
 * `git cat-file -e <sha>` on a shallow clone answers "no" for every commit
 * that predates the cut — including every commit that is perfectly fine
 * upstream. `actions/checkout@v4` with no `fetch-depth` clones to depth 1, so
 * a CI runner is in that state by default. A retirement check that read a
 * shallow clone's "no" as GONE would retire the entire mined tier on its
 * first CI run, and the diff would look like the system working.
 *
 * So there are three readings and not two: RESOLVES, GONE, and UNMEASURED —
 * and UNMEASURED never retires anything. `lib/line-citation.ts` makes the
 * same distinction for the same reason and is reused rather than reimplemented
 * for the `path:line` form.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * Each is asserted as a case in `test/rule-retirement.test.ts`.
 *
 * - **A resolving citation is not a correct one.** `readLineCitation` returns
 *   UNMEASURED, never VALID, for a line that exists, because whether it is
 *   still the line the sentence describes cannot be decided mechanically. A
 *   sha that resolves says only that the commit is in this history. This
 *   module retires what is demonstrably gone and makes no claim about the
 *   rest.
 * - **A citation form it does not recognise is UNMEASURED, so it survives.**
 *   A candidate whose `source` is neither `git:<sha>` nor `path:line` is
 *   kept, and the reading says it was not read. The other direction —
 *   retiring everything unrecognised — turns a parser gap into silent data
 *   loss, and a parser gap is the defect this repository has shipped most
 *   recently (`\Z` in a JavaScript regex, #1028).
 * - **Nothing deletes an existing `.claude/rules/*.md` file.** Retirement
 *   happens at the generator: a retired candidate is not emitted on the next
 *   run, so the rule stops being written. A hand-edited rule is preserved by
 *   #370 and is not the generator's to retire.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { readLineCitation, repoFileIndex, type LineCitation } from "./line-citation";

/** Why a citation could not be answered. Exported so a caller compares against the producer's spelling. */
export const NOT_A_GIT_REPOSITORY = "RETIREMENT_NOT_A_GIT_REPOSITORY";
export const SHALLOW_HISTORY = "RETIREMENT_SHALLOW_HISTORY";
export const UNRECOGNISED_CITATION = "RETIREMENT_UNRECOGNISED_CITATION";

export type CitationReading =
  /** The position is in the tree. Says nothing about whether it is the right position. */
  | { reading: "RESOLVES"; detail: string }
  /** The position is demonstrably not in the tree. The only arm that retires. */
  | { reading: "GONE"; detail: string }
  /** The question could not be asked. Never retires. */
  | { reading: "UNMEASURED"; detail: string };

/** `git:<sha>`, as `lib/failure-intake.ts` writes it. */
const GIT_SOURCE = /^git:([0-9a-f]{7,40})$/;
/** `<path>:<line>`, as `scripts/extract-constraints.ts` writes it. */
const LINE_SOURCE = /^(.+):(\d+)$/;

function git(root: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", ["-C", root, ...args], {
    timeout: 60_000,
    encoding: "utf-8",
  });
  return { status: r.error ? -1 : (r.status ?? -1), out: r.stdout ?? "" };
}

/**
 * The state of the repository that every sha question is answered against.
 *
 * Read ONCE per retirement pass rather than per candidate: two `git` calls
 * for a thousand candidates, and — more to the point — one answer, so a
 * population cannot contain candidates judged against different beliefs
 * about whether the history is complete.
 */
export interface HistoryState {
  /** `git cat-file` can be asked at all. */
  readable: boolean;
  /** The clone is truncated, so an absent sha means nothing. */
  shallow: boolean;
}

export function readHistoryState(root: string): HistoryState {
  if (!existsSync(join(root, ".git"))) return { readable: false, shallow: false };
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);
  return {
    readable: true,
    // A `rev-parse` that could not run is not a repository with full history.
    shallow: shallow.status !== 0 || shallow.out.trim() === "true",
  };
}

/**
 * THE resolver. One binding, so there is one thing to mutate.
 *
 * `index` is `repoFileIndex(root)`, hoisted for the same reason as
 * `HistoryState`: it is the file list the `path:line` arm is answered
 * against, and computing it per candidate would let two candidates disagree
 * about what is in the tree.
 */
export function resolveCitation(
  root: string,
  source: string,
  history: HistoryState,
  index: string[],
): CitationReading {
  const sha = GIT_SOURCE.exec(source);
  if (sha) {
    if (!history.readable) {
      return {
        reading: "UNMEASURED",
        detail: `${source}: ${root} is not a git repository, so no sha can be looked up`,
      };
    }
    if (history.shallow) {
      return {
        reading: "UNMEASURED",
        detail:
          `${source}: the clone is shallow, so an absent commit means the history was ` +
          `truncated and not that the commit is gone`,
      };
    }
    const present = git(root, ["cat-file", "-e", `${sha[1]}^{commit}`]);
    return present.status === 0
      ? { reading: "RESOLVES", detail: `${source} is a commit in this history` }
      : { reading: "GONE", detail: `${source} names no commit in this history` };
  }

  const line = LINE_SOURCE.exec(source);
  if (line) {
    const cite: LineCitation = { path: line[1]!, line: Number(line[2]), raw: source };
    const read = readLineCitation(root, index, cite);
    // `readLineCitation` has two arms and neither says "correct". BROKEN is
    // the one that names a position that is not there; its UNMEASURED means
    // the line exists and whether it is the right line is undecidable, which
    // is a reason to KEEP.
    return read.reading === "BROKEN"
      ? { reading: "GONE", detail: `${source}: ${read.detail}` }
      : { reading: "RESOLVES", detail: `${source}: ${read.detail}` };
  }

  return {
    reading: "UNMEASURED",
    detail: `${source}: not a citation form this module reads (${UNRECOGNISED_CITATION})`,
  };
}

/** The minimum a candidate needs to be judged. Structurally what `PromotableCandidate` is. */
export interface CitingCandidate {
  source: string;
  hash: string;
}

export interface RetiredCandidate<T> {
  candidate: T;
  detail: string;
}

export interface RetirementReading<T> {
  /**
   * The single discriminator. `unmeasuredReasons` is the other projection of
   * the same computation, so the two cannot disagree.
   */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Survivors, in input order. The population the promoter ranks. */
  kept: T[];
  /** Dropped, each with the detail that dropped it. */
  retired: RetiredCandidate<T>[];
  /** Judged but unanswerable. Kept, and counted here so the silence is visible. */
  unread: RetiredCandidate<T>[];
}

/**
 * Drop every candidate whose citation is demonstrably gone.
 *
 * A pass over a repository whose history cannot be read retires NOTHING and
 * says so. `0 retired` from a shallow clone and `0 retired` from a tree where
 * every citation is good are the same empty list, and only the reading tells
 * them apart — which is the shape `.claude/rules/checks-must-be-able-to-
 * fail.md` is about and the one this module is most likely to take.
 */
export function retireUnresolvable<T extends CitingCandidate>(
  candidates: readonly T[],
  root: string,
): RetirementReading<T> {
  const history = readHistoryState(root);
  const index = repoFileIndex(root);

  const kept: T[] = [];
  const retired: RetiredCandidate<T>[] = [];
  const unread: RetiredCandidate<T>[] = [];
  const reasons = new Set<string>();

  for (const candidate of candidates) {
    const read = resolveCitation(root, candidate.source, history, index);
    if (read.reading === "GONE") {
      retired.push({ candidate, detail: read.detail });
      continue;
    }
    kept.push(candidate);
    if (read.reading === "UNMEASURED") {
      unread.push({ candidate, detail: read.detail });
      reasons.add(
        !history.readable && GIT_SOURCE.test(candidate.source)
          ? NOT_A_GIT_REPOSITORY
          : history.shallow && GIT_SOURCE.test(candidate.source)
            ? SHALLOW_HISTORY
            : UNRECOGNISED_CITATION,
      );
    }
  }

  const unmeasuredReasons = [...reasons].sort();
  return {
    reading: unmeasuredReasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons,
    kept,
    retired,
    unread,
  };
}

/** One line a caller can print without re-deriving any of the above. */
export function retirementSummary(reading: RetirementReading<unknown>): string {
  return (
    `retirement ${reading.reading}: ${reading.retired.length} retired, ` +
    `${reading.kept.length} kept, ${reading.unread.length} unread` +
    (reading.unmeasuredReasons.length > 0 ? ` — ${reading.unmeasuredReasons.join("; ")}` : "")
  );
}
