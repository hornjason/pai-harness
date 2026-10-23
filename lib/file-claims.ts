/**
 * Who is writing which files right now, DECLARED rather than detected (#1413).
 *
 * `.github/workflows/ai-review.yml` is generated from
 * `lib/scaffold/ai-review-step.ts`, so every pull request that changes review
 * behaviour touches both, and therefore conflicts with every other such pull
 * request by construction. On 2026-10-23 #1370 went DIRTY five times in three
 * hours, #1387 rebased four times, and a fourth agent declined to open a pull
 * request at all. Every one of those conflicts had the same three-step
 * resolution: take `origin/main`'s copy, re-run the generator, confirm the
 * second `--fix` pass reports unchanged. A conflict whose resolution is always
 * identical is not a conflict. It is a missing lock.
 *
 * ## Why this is a declaration and not a detector
 *
 * Measured on this machine before any of it was written, and both results
 * killed the obvious implementation:
 *
 *  - `find -newermt '-6 hours'` silently matches nothing here. It returned
 *    empty against a file modified four seconds earlier. `-newer <ref>` works.
 *  - Even working, mtime cannot separate an edit from a checkout. `git
 *    worktree add` bumps every mtime, so a sweep returned 36,939 "recently
 *    edited" files and roughly 30 worktrees "touching" one script. Across 233
 *    worktrees there is no reading that answers who is editing a file now.
 *
 * And the instruments that *are* accurate — `gh pr list`,
 * `closingIssuesReferences`, the tracker — all describe PUSHED state, while
 * the dangerous window is the one before a push. So the signal has to be
 * something a writer WRITES. The gap this closes is that declaring was
 * voluntary and unrecorded, not that it was impossible.
 *
 * ## What this does not cover, stated rather than implied
 *
 * A path with no claim reads as free, and that is a true statement about the
 * registry, not about the disk. This refuses to guess: an undeclared writer is
 * invisible here exactly as it is invisible to `gh pr list`. What it buys is
 * that a writer who declares can be seen by everyone before they branch, with
 * one command, and that the registry is a serialisation point — two agents
 * claiming at once conflict on a JSON array, which is a conflict a person may
 * resolve, unlike the generated YAML this exists to protect.
 *
 * ## Liveness is resolved, never trusted
 *
 * `specs/sc-reservations.json` asks owners to delete their entry when the
 * branch merges, and `.claude/rules/parallel-sessions.md` records that a block
 * nobody prunes is headroom nobody can use. A stale claim is worse than that
 * here: it reports a live writer forever and the next agent routes around a
 * file nobody holds. So {@link liveClaims} takes the set of branches that
 * still exist and are not merged, and a claim whose owner is not among them is
 * DEAD regardless of what the file says.
 */

import { underPrefix } from "./repo-path.ts";

/** The key that tells a store apart from an empty object. See {@link readFileClaims}. */
export const FILE_CLAIMS_CONTROL_KEY = "claims";

/** Repository-relative path of the registry. */
export const FILE_CLAIMS_PATH = "specs/file-claims.json";

/** One declared writer. */
export interface FileClaim {
  /** The branch doing the writing. The thing another session looks you up by. */
  owner: string;
  /**
   * Repository-relative paths this branch is writing. A directory claims
   * everything beneath it; a file claims only itself.
   */
  paths: string[];
  /** The issue the work is for, so a reader can go and read why. */
  issue?: number;
  /** Anything the next agent needs that the issue does not say. */
  note?: string;
}

export type FileClaimStatus = "read" | "absent" | "unreadable";

export interface FileClaimReading {
  status: FileClaimStatus;
  /** Where the reading was taken from, whether or not anything was there. */
  path: string;
  /** Empty under every status except a `read` of a store that declares claims. */
  claims: FileClaim[];
  /** Why it is absent or unreadable. Absent on a clean read. */
  reason?: string;
}

/**
 * Validate one entry, returning why it is unusable or `null`.
 *
 * Every fault refuses the WHOLE store rather than dropping the entry. A
 * registry the reader only partly understands is unreadable, not partly read
 * — the same rule `lib/sc-reservations.ts` applies to an unknown namespace,
 * and for the same reason: a claim silently dropped is a lock silently
 * released, which is the one failure this file must not have.
 */
function claimFault(raw: unknown, index: number): string | null {
  const at = `${FILE_CLAIMS_CONTROL_KEY}[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return `${at} is not an object`;
  const c = raw as Record<string, unknown>;
  if (typeof c.owner !== "string" || c.owner.trim() === "") return `${at} has no owner`;
  const who = c.owner as string;
  if (!Array.isArray(c.paths) || c.paths.length === 0) {
    return `${at} (${who}) claims no paths`;
  }
  for (const [i, p] of (c.paths as unknown[]).entries()) {
    if (typeof p !== "string" || p.trim() === "") return `${at} (${who}) paths[${i}] is not a path`;
    // Repository-relative and nothing else. An absolute path is a claim about
    // one machine, and `..` is a claim about a tree this registry does not
    // describe — both read as a path that no caller's `git diff --name-only`
    // will ever produce, so they would silently never match.
    if (p.startsWith("/")) return `${at} (${who}) paths[${i}] is absolute: ${p}`;
    if (p.split("/").includes("..")) return `${at} (${who}) paths[${i}] escapes the repository: ${p}`;
  }
  if (c.issue !== undefined && (typeof c.issue !== "number" || !Number.isSafeInteger(c.issue))) {
    return `${at} (${who}) has a non-integer issue`;
  }
  if (c.note !== undefined && typeof c.note !== "string") return `${at} (${who}) has a non-string note`;
  return null;
}

/**
 * Read the registry from the bytes of the file.
 *
 * Three outcomes, and the caller must not collapse them:
 *
 *  - `absent` — `raw` is `null`, nobody has declared anything. A real reading.
 *  - `unreadable` — present and not understood. NOT an empty reading: a
 *    registry that fails to parse would otherwise report every file free,
 *    which is the fail-open this whole mechanism exists to prevent.
 *  - `read` — understood, `claims` is what it declares.
 *
 * `{}` and `{"claims": []}` are different facts and the control key is what
 * separates them. The first is a file that has lost its contents; the second
 * is a registry saying, deliberately, that nobody holds anything.
 */
export function readFileClaims(raw: string | null, path = FILE_CLAIMS_PATH): FileClaimReading {
  if (raw === null) {
    return { status: "absent", path, claims: [], reason: "no registry at this path" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return { status: "unreadable", path, claims: [], reason: `not JSON (${why})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unreadable", path, claims: [], reason: "the store is not an object" };
  }
  const store = parsed as Record<string, unknown>;
  if (!(FILE_CLAIMS_CONTROL_KEY in store)) {
    return {
      status: "unreadable",
      path,
      claims: [],
      reason: `the store declares no \`${FILE_CLAIMS_CONTROL_KEY}\` key, so it cannot be told from a file that lost its contents`,
    };
  }
  const list = store[FILE_CLAIMS_CONTROL_KEY];
  if (!Array.isArray(list)) {
    return { status: "unreadable", path, claims: [], reason: `\`${FILE_CLAIMS_CONTROL_KEY}\` is not an array` };
  }
  for (const [i, entry] of list.entries()) {
    const fault = claimFault(entry, i);
    if (fault !== null) return { status: "unreadable", path, claims: [], reason: fault };
  }
  return { status: "read", path, claims: list as FileClaim[] };
}

/**
 * Does `claimed` cover `path`? A directory covers everything beneath it.
 *
 * This is `underPrefix` and nothing else. It used to be four lines of
 * `startsWith` here, which was a SECOND DECIDER for a question
 * `lib/repo-path.ts` already answers —
 * `.claude/rules/checks-must-be-able-to-fail.md`, *two deciders* — and the
 * two disagreed on exactly the inputs a caller produces by accident. The
 * registry side was never the gap: `claimFault` already rejects absolute and
 * `..` paths. It was the CALLER-supplied path, which nothing normalised, and
 * `./lib/x.ts` is what tab-completion hands you.
 *
 * Measured against the local copy before the swap, for the claim `lib`:
 *
 * | path | the old local rule | `underPrefix` |
 * |---|---|---|
 * | `./lib/x.ts` | false | **true** |
 * | `Lib/x.ts` | false | **true** |
 * | `lib\x.ts` | false | **true** |
 * | `library/x.ts` | false | false |
 * | `../lib/x.ts` | false | false |
 *
 * Three contended paths reading FREE, and the last two rows are why the fix
 * is a swap rather than a patch: the centralised rule is segment-aware and
 * refuses a `..` escape, so it is stricter where it matters and looser only
 * where the old rule was wrong. Every fixture anyone would naturally write
 * passes under both, which is why the suite was green (#1436 review).
 */
export function claimCovers(claimed: string, path: string): boolean {
  return underPrefix(path, claimed);
}

/** What a declared owner's branch is doing. Three states, never two. */
export type OwnerState = "live" | "landed" | "unmeasured";

/** The one field of a pull request this decision reads. `gh`'s spelling. */
export interface PullState {
  number: number;
  /** `OPEN`, `CLOSED` or `MERGED`. A draft pull request is `OPEN`. */
  state: string;
}

/**
 * Is this owner still working, judged by its pull requests?
 *
 * ## Two git-only rules were tried first, and both were wrong
 *
 * **Ancestry.** `git merge-base --is-ancestor` and `git branch -r
 * --no-merged` compare commits, and this repository squash-merges: the squash
 * commit is a new object, so a merged branch's tip is never an ancestor of
 * the base and both report it UNMERGED forever. Measured —
 * `rg/1168-eviction-note` merged at 17:43 on 2026-10-23 and `--no-merged`
 * still listed it afterwards.
 *
 * **Subjects.** The replacement asked whether every subject the branch
 * carries ahead of the base also appears among the base's subjects. That is
 * true for a SINGLE-commit pull request, whose squash subject is the commit
 * subject with ` (#N)` appended — and false for every other one. GitHub's
 * squash subject for a multi-commit branch is the PULL REQUEST TITLE; the
 * individual commit subjects go into the squash BODY as `* ` bullets, where
 * `git log --format=%s` cannot see them. Measured against the 15 most
 * recently merged pull requests with surviving refs: **11 of 12 answered
 * `landed=false`**, every one of them merged. Only the one single-commit row
 * was right, and the battery that passed this rule in review had sampled
 * nothing but single-commit branches — it could not have discriminated.
 *
 * Both failures point the same way, and it is the fail-open direction for a
 * lock: a merged branch that reads LIVE holds its files forever.
 * `RUNGATE_BRANCH_CLEANUP` is deliberately unset here, so merged refs are
 * never deleted and nothing else would ever clear the entry. A lock nobody
 * can acquire is worse than no lock, because people route around it.
 *
 * ## So ask the tracker, which is told rather than inferred
 *
 * A pull request's state is a fact somebody recorded, not a shape guessed out
 * of a commit graph that squashing has already destroyed. It is also the same
 * place this project keeps every other claim about who is doing what.
 *
 * The cases, each reachable and each separately witnessed:
 *
 * - `pulls === null` — the tracker could not be read. UNMEASURED. This does
 *   not fall through to landed; an unread tracker is not an empty one.
 * - any pull is `OPEN` — LIVE. Draft counts: a draft is someone working.
 * - pulls exist and none is open — LANDED, merged or abandoned alike. Both
 *   mean nobody is writing those files under this name any more.
 * - no pull at all, but the ref is on the remote — LIVE. A pushed branch with
 *   no pull request yet is the EARLIEST moment a claim matters, and it is
 *   exactly when a second agent is deciding whether to start.
 * - no pull and no ref, refs refreshed — LANDED. There is nothing there.
 * - no pull and no ref, refs NOT refreshed — UNMEASURED. A branch nobody
 *   fetched and a branch somebody deleted look identical, and only one of
 *   them is safe to call free.
 */
export function ownerState(
  pulls: readonly PullState[] | null,
  refExists: boolean,
  refsRefreshed: boolean,
): { state: OwnerState; why: string } {
  if (pulls === null) {
    return { state: "unmeasured", why: "the tracker could not be read for this branch" };
  }
  const open = pulls.filter(p => p.state.toUpperCase() === "OPEN");
  if (open.length > 0) {
    return { state: "live", why: `open pull request ${open.map(p => `#${p.number}`).join(", ")}` };
  }
  if (pulls.length > 0) {
    return {
      state: "landed",
      why: `no open pull request (${pulls.map(p => `#${p.number} ${p.state.toLowerCase()}`).join(", ")})`,
    };
  }
  if (refExists) {
    return { state: "live", why: "branch is on the remote with no pull request yet" };
  }
  if (refsRefreshed) {
    return { state: "landed", why: "no pull request and no branch on the remote" };
  }
  return {
    state: "unmeasured",
    why: "no pull request, and the refs were not refreshed, so \"deleted\" and \"never fetched\" cannot be told apart",
  };
}

/**
 * The claims that cover `path`, among those whose owner is still live.
 *
 * `liveOwners` is the set of branches that exist and are unmerged, supplied by
 * the caller because resolving it is a git operation and this module decides
 * nothing from the filesystem. A claim whose owner is absent from that set is
 * DEAD — the branch merged or went away and nobody pruned the entry — and a
 * dead claim must not hold a file, or the registry becomes a list of places
 * nobody may ever work again.
 */
export function liveClaims(
  claims: readonly FileClaim[],
  path: string,
  liveOwners: ReadonlySet<string>,
): FileClaim[] {
  return claims.filter(c => liveOwners.has(c.owner) && c.paths.some(p => claimCovers(p, path)));
}

/** Every claim on `path`, live or not, so a report can say which is which. */
export function allClaims(claims: readonly FileClaim[], path: string): FileClaim[] {
  return claims.filter(c => c.paths.some(p => claimCovers(p, path)));
}

/**
 * The claims a set of paths runs into, keyed by path.
 *
 * Entries with no live claim are omitted rather than mapped to `[]`: the
 * caller's question is "what is contended", and an empty map is the answer
 * "nothing", which is different from "I checked nothing".
 */
export function contention(
  claims: readonly FileClaim[],
  paths: readonly string[],
  liveOwners: ReadonlySet<string>,
): Map<string, FileClaim[]> {
  const out = new Map<string, FileClaim[]>();
  for (const p of paths) {
    const hits = liveClaims(claims, p, liveOwners);
    if (hits.length > 0) out.set(p, hits);
  }
  return out;
}
