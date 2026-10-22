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
/** `git` could not be run, timed out, was signalled, or exited non-zero. */
export const GIT_UNREADABLE = "RETIREMENT_GIT_UNREADABLE";
/** The prefix matches more than one object, so it names no commit in particular. */
export const AMBIGUOUS_SHA = "RETIREMENT_AMBIGUOUS_SHA";
/** The object is in the tree and is not a commit. */
export const NOT_A_COMMIT = "RETIREMENT_NOT_A_COMMIT";
/** The batch returned, and returned nothing about this input. */
export const NO_BATCH_ANSWER = "RETIREMENT_NO_BATCH_ANSWER";

/**
 * Every reason code, in the order a reading is searched for one.
 *
 * ONE declaring position, and the search is over the detail string the
 * producer wrote rather than over the candidate. A reason re-derived at the
 * consumer is a second decider for "why could this not be read", and it can
 * name a cause the reading never gave — which is the two-projections-
 * disagreeing shape this module's `reading`/`unmeasuredReasons` pair exists
 * to avoid.
 */
export const REASON_CODES = [
  NOT_A_GIT_REPOSITORY,
  SHALLOW_HISTORY,
  GIT_UNREADABLE,
  AMBIGUOUS_SHA,
  NOT_A_COMMIT,
  NO_BATCH_ANSWER,
  UNRECOGNISED_CITATION,
] as const;

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

/**
 * The deadline for the whole pass, not for one call.
 *
 * It is a TOTAL because there is exactly one `git cat-file` subprocess for
 * the entire population — see `batchCheckShas`. A per-candidate timeout with
 * a per-candidate subprocess gives N x 60s, which is not a bound.
 */
export const GIT_TIMEOUT_MS = 60_000;

interface GitResult {
  /** True only when git ran to completion and exited 0. */
  ok: boolean;
  out: string;
  /** Why it is not ok, in git's own words where there are any. */
  detail: string;
}

/**
 * Run git and say whether the ANSWER is usable, not merely what it exited.
 *
 * A boolean `ok` rather than a status number, because the one thing callers
 * here must never do is compare an exit code against a literal. `git
 * cat-file -e <sha>^{commit}` — the first implementation of this module —
 * exits 128 for a missing object, and 128 for a broken repository, and 128
 * for an unreadable object store, and 128 for bad ref syntax. Measured, not
 * assumed:
 *
 *   missing object                 exit=128
 *   not a repository               exit=128
 *   malformed ref syntax           exit=128
 *   unreadable object store        exit=128
 *   present object                 exit=0
 *
 * So `status !== 0 -> GONE` read four different events as "retire this
 * rule", and the narrower repair of treating only 0 and 1 as answers reads
 * all five as "cannot tell" and retires nothing, ever. Neither is a
 * measurement. The fix is not a better threshold on that exit code; it is
 * `--batch-check`, which reports absence, ambiguity and type in its OUTPUT
 * and reserves a non-zero exit for not having run.
 */
function git(root: string, args: string[], stdin?: string, timeoutMs = GIT_TIMEOUT_MS): GitResult {
  const r = spawnSync("git", ["-C", root, ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf-8",
    input: stdin,
  });
  // A timeout arrives as `error` on some platforms and as `signal` on
  // others, and reading only `status` makes a killed process look like a
  // clean non-zero exit. Both are checked, and both are named in `detail`
  // so a timeout is visible in the reading as a timeout.
  if (r.error) return { ok: false, out: "", detail: `git ${args[0]}: ${r.error.message}` };
  if (r.signal) return { ok: false, out: "", detail: `git ${args[0]}: killed by ${r.signal}` };
  if (r.status !== 0) {
    return {
      ok: false,
      out: r.stdout ?? "",
      detail: `git ${args[0]} exited ${r.status}: ${(r.stderr ?? "").trim() || "(no stderr)"}`,
    };
  }
  return { ok: true, out: r.stdout ?? "", detail: "" };
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
    shallow: !shallow.ok || shallow.out.trim() === "true",
  };
}

/**
 * Ask git about every sha in ONE subprocess, and keep the four answers apart.
 *
 * `git cat-file --batch-check` emits exactly one line per input line, in
 * input order, and says which of four things happened — measured on this
 * repository:
 *
 *   <full oid> commit <size>   the commit is here
 *   <input> missing            no object of that name
 *   <input> ambiguous          the prefix matches more than one object
 *   <full oid> tree <size>     the name resolves, and not to a commit
 *
 * and exits 0 for all four, reserving non-zero for not having run at all.
 * That separation is the whole reason to use it: absence and failure-to-look
 * become different OBSERVATIONS rather than two values of one exit code, and
 * only the first of them is allowed to retire anything.
 *
 * Only `missing` returns GONE. `ambiguous` does not — an eight-character
 * prefix that matches two objects names no commit in particular, and
 * `lib/failure-intake.ts` writes eight-character prefixes, so this is a real
 * state in a repository this size rather than a hypothetical one.
 *
 * Results are zipped by INDEX, because git echoes the resolved oid for an
 * input it resolved and the raw input for one it did not — so a map keyed by
 * the input silently loses every short sha that worked. A line count that
 * does not match the input count is not a partial answer; the whole batch is
 * UNMEASURED, because nothing then says which line answered which input.
 */
export function batchCheckShas(
  root: string,
  shas: readonly string[],
  history: HistoryState,
  /**
   * The TOTAL deadline for the pass. A parameter rather than only a
   * constant so the kill path has a witness: with no way to make git hang
   * on demand, `r.error`/`r.signal` are otherwise branches no case reaches,
   * and an unreachable branch is the shape this repository pays for most.
   */
  timeoutMs = GIT_TIMEOUT_MS,
): Map<string, CitationReading> {
  const out = new Map<string, CitationReading>();
  if (shas.length === 0) return out;

  const all = (reading: CitationReading) => {
    for (const sha of shas) out.set(sha, reading);
    return out;
  };

  if (!history.readable) {
    return all({
      reading: "UNMEASURED",
      detail: `${root} is not a git repository, so no sha can be looked up (${NOT_A_GIT_REPOSITORY})`,
    });
  }
  if (history.shallow) {
    return all({
      reading: "UNMEASURED",
      detail:
        `the clone is shallow, so an absent commit means the history was truncated and not ` +
        `that the commit is gone (${SHALLOW_HISTORY})`,
    });
  }

  const r = git(root, ["cat-file", "--batch-check"], shas.join("\n") + "\n", timeoutMs);
  if (!r.ok) {
    return all({ reading: "UNMEASURED", detail: `${r.detail} (${GIT_UNREADABLE})` });
  }

  const lines = r.out.split("\n").filter(l => l.length > 0);
  if (lines.length !== shas.length) {
    return all({
      reading: "UNMEASURED",
      detail:
        `cat-file --batch-check answered ${lines.length} of ${shas.length} inputs, so no line ` +
        `can be attributed to an input (${NO_BATCH_ANSWER})`,
    });
  }

  shas.forEach((sha, i) => {
    const parts = lines[i]!.split(" ");
    const verdict = parts[1] ?? "";
    if (verdict === "missing") {
      out.set(sha, { reading: "GONE", detail: `git:${sha} names no object in this history` });
    } else if (verdict === "ambiguous") {
      out.set(sha, {
        reading: "UNMEASURED",
        detail: `git:${sha} matches more than one object, so it names no commit (${AMBIGUOUS_SHA})`,
      });
    } else if (verdict === "commit") {
      out.set(sha, { reading: "RESOLVES", detail: `git:${sha} is a commit in this history` });
    } else {
      out.set(sha, {
        reading: "UNMEASURED",
        detail: `git:${sha} resolves to a ${verdict || "(unreadable)"}, not a commit (${NOT_A_COMMIT})`,
      });
    }
  });
  return out;
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
  index: string[],
  shaReadings: ReadonlyMap<string, CitationReading>,
): CitationReading {
  const sha = GIT_SOURCE.exec(source);
  if (sha) {
    // The sha arm is answered by `batchCheckShas`, once, for the whole
    // population. Looking it up here rather than asking git again is what
    // keeps one binding: a second place deciding "is this commit present"
    // could disagree with the batch, and on a shallow clone the two
    // disagreeing means one of them retires a rule the other kept.
    return (
      shaReadings.get(sha[1]!) ?? {
        reading: "UNMEASURED",
        detail: `${source}: the batch returned no answer for it (${NO_BATCH_ANSWER})`,
      }
    );
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

  // Every sha in one subprocess, before the loop. Two `git` calls for the
  // whole pass — this and `readHistoryState` — so `GIT_TIMEOUT_MS` is the
  // TOTAL deadline rather than a per-candidate one that multiplies.
  //
  // The `new Set` is an EFFICIENCY measure and has no behavioural witness:
  // a duplicated sha gets the same answer twice and the map keyed by sha is
  // identical either way. Recorded as such rather than covered by a case
  // that would pass with or without it.
  const shas = [...new Set(
    candidates.map(c => GIT_SOURCE.exec(c.source)?.[1]).filter((s): s is string => !!s),
  )];
  const shaReadings = batchCheckShas(root, shas, history);

  const kept: T[] = [];
  const retired: RetiredCandidate<T>[] = [];
  const unread: RetiredCandidate<T>[] = [];
  const reasons = new Set<string>();

  for (const candidate of candidates) {
    const read = resolveCitation(root, candidate.source, index, shaReadings);
    if (read.reading === "GONE") {
      retired.push({ candidate, detail: read.detail });
      continue;
    }
    kept.push(candidate);
    if (read.reading === "UNMEASURED") {
      unread.push({ candidate, detail: read.detail });
      // The reason is read off the DETAIL the producer wrote, not
      // re-derived from the candidate here. Re-deriving it was the first
      // version and it was a second decider: it could name SHALLOW_HISTORY
      // for a reading that actually said AMBIGUOUS_SHA, and the two would
      // never be compared.
      reasons.add(
        REASON_CODES.find(code => read.detail.includes(code)) ?? UNRECOGNISED_CITATION,
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

/**
 * The members of `subset` that survived a retirement pass over a population
 * containing them.
 *
 * Exported because it is the SINK: `scripts/extract-constraints.ts` writes
 * what this returns, and a filter spelled inline there is a filter a test can
 * only check by writing the same expression a second time — which asserts
 * that the test agrees with itself. One binding, one thing to mutate.
 *
 * Identity, not hash. A hash is a judgement about a SENTENCE, and
 * `lib/failure-intake.ts` relies on two candidates sharing one for a revert
 * and the fix it reverts, so matching on the hash would drop a survivor
 * alongside a retired twin.
 */
export function survivingSubset<T extends CitingCandidate, S extends T>(
  subset: readonly S[],
  reading: RetirementReading<T>,
): S[] {
  const survived = new Set<T>(reading.kept);
  return subset.filter((c) => survived.has(c));
}

/** One line a caller can print without re-deriving any of the above. */
export function retirementSummary(reading: RetirementReading<unknown>): string {
  return (
    `retirement ${reading.reading}: ${reading.retired.length} retired, ` +
    `${reading.kept.length} kept, ${reading.unread.length} unread` +
    (reading.unmeasuredReasons.length > 0 ? ` — ${reading.unmeasuredReasons.join("; ")}` : "")
  );
}
