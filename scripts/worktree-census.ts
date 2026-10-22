#!/usr/bin/env bun
/**
 * What is actually true about each registered worktree (#1021).
 *
 * `git -C . worktree list` prints 170 lines here and marks an abandoned
 * worktree exactly the same as one a session is typing into right now. That
 * is not a cosmetic problem. On 2026-10-16 the stale directories were tidied
 * by hand — an ordinary thing to do, from a list where nothing distinguished
 * them — and two sessions lost uncommitted work, one about 500 lines and one
 * holding PR #452's branch (`.claude/rules/parallel-sessions.md`).
 *
 * So this is a READING, not a reaper. It deletes nothing, removes nothing,
 * unlocks nothing and prunes nothing. It takes four readings per worktree and
 * prints them with the verdict they imply. Removal stays a human decision
 * made with the evidence in front of it.
 *
 *   1. its branch has a MERGED pull request, at the commit the worktree holds
 *   2. `git status --porcelain` was read and was empty
 *   3. no process holds a file under it
 *   4. nothing under it has been modified inside a declared age
 *
 * ## The distinction the whole file exists for
 *
 * A reading that could not be TAKEN is not a reading that came back negative.
 * `0`, `{}`, `null`, an empty string and a command that died are all
 * indistinguishable from "clean" if you only look at the output, and
 * collapsing them is exactly how 2026-10-16 happened: `git status` in a
 * directory that no longer exists prints nothing at all, which reads as a
 * pristine tree.
 *
 * Every reading is therefore `Measured<T>` — a value, or the reason there is
 * no value — and a worktree with any unmeasured reading is **UNMEASURED**,
 * counted apart from ABANDONED and never folded into it. `verdictFor` is the
 * only place a verdict is decided, so that property is provable in one place
 * rather than argued about in four.
 *
 * ## Why the merge reading asks the pull request and not git
 *
 * Because ancestry does not work here. A squash merge destroys it:
 * `git merge-base --is-ancestor` reports ORPHANED for all six of the commits
 * #511 and #512 recovered, whose content is fully on main
 * (`scripts/verify-merge-content.ts` carries the measurement). An ancestry
 * guard fires on the NORMAL case — every squash merge this repo makes — and
 * a worktree holding real unmerged work would be reported abandoned. There is
 * no ancestry question anywhere in this file, and a test asserts that.
 *
 * The pull request is asked instead, and it is asked for an IDENTITY, not an
 * implication: the branch counts as merged only when the worktree's `HEAD` is
 * the exact `headRefOid` GitHub merged. A branch that gained commits after
 * its PR merged reads `MERGED_BUT_MOVED` and is not abandoned-ward, because
 * those commits are on no other ref and are precisely the work that gets lost.
 *
 * ## What this must never do, and how it is kept from doing it
 *
 * - **No deletion.** There is no `rm`, no `worktree remove`, no `worktree
 *   prune` and no `--force` anywhere, asserted by the test.
 * - **No acting on the process reading.** It answers "who holds this"; it
 *   never signals anybody. `pkill` is not in this file and must not be.
 * - **No writes into the worktrees it reads.** Status is taken with
 *   `git --no-optional-locks`, which is what keeps a refresh of the index out
 *   of a directory another session is working in.
 *
 * Usage:
 *   bun scripts/worktree-census.ts [--repo <dir>] [--older-than 7d]
 *                                  [--json] [--out <file>] [--no-gh]
 *                                  [--gh-repo <owner/name>] [--max-entries <n>]
 *
 * stdout: the table, or the JSON verdict with `--json`.
 * stderr: diagnostics and refusals.
 * exit:   0 when the census was produced, however many rows are UNMEASURED —
 *         an unmeasured row is a finding, not a failure. REFUSE_EXIT when the
 *         census could not be produced at all.
 */

import { execFileSync } from "child_process";
import { lstatSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { gitIsolatedArgs, gitIsolatedEnv } from "../lib/git-isolation";

/**
 * The ONE place this script runs `git` (#1048).
 *
 * ## Why a seam and not the flags at each call site
 *
 * `git -C <dir>` runs the configuration of whatever repository it is pointed
 * at, and this tool's whole purpose is to point it at directories nobody is
 * currently thinking about — 175 of them on the machine this was written on
 * (`git worktree list --porcelain | grep -c '^worktree '`, 2026-10-22 01:30;
 * the number moves every time a session starts or finishes). So the question
 * is not whether these two call sites are isolated today. It is whether the
 * THIRD one will be, and a call site is the unit that gets forgotten.
 *
 * `lib/git-isolation.ts` is the single declaring position for WHAT isolation
 * is. This function is the single declaring position for WHERE this module
 * applies it. Adding the `-c` flags inline at both sites would have been the
 * cheaper change and is the thing #1001 exists to prevent: two spellings that
 * drift, with nothing comparing them.
 *
 * ## What was measured, because "read-only subcommand" is not a safety class
 *
 * git 2.50.1, a scratch repo whose own `.git/config` carries the poison —
 * the scope `GIT_CONFIG_GLOBAL=/dev/null` cannot reach:
 *
 * | subcommand | poisoned key | unisolated | isolated |
 * |---|---|---|---|
 * | `--no-optional-locks status --porcelain` | `core.fsmonitor` | **ran it** | not run |
 * | `--no-optional-locks status --porcelain` | `core.excludesFile` | **plant INVISIBLE** | `?? plant.txt` |
 * | `--no-optional-locks status --porcelain` | `core.hooksPath` | not fired | not fired |
 * | `status --porcelain` (no lock flag) | `core.hooksPath` | **hook fired** | not fired |
 * | `worktree list --porcelain` | all three | nothing fired | nothing fired |
 *
 * Three things follow, and only the first is the security argument:
 *
 *   1. `--no-optional-locks` does NOT stop `core.fsmonitor`. It stops the
 *      index WRITE, so `post-index-change` does not fire — which means the
 *      hook exposure here was closed by a flag chosen for an unrelated
 *      reason, and would reopen the day somebody drops it.
 *   2. **`core.excludesFile` falsifies the reading itself.** An untracked
 *      file goes invisible, so a worktree holding work reports CLEAN — in
 *      the tool whose output decides what is safe to remove. That is a
 *      correctness defect, not a parity argument, and it is the one that
 *      would bite on this machine first.
 *   3. `worktree list` executed nothing under any of the three. It is
 *      genuinely `rev-parse`-class, and no behavioural case can witness its
 *      isolation — see `test/worktree-census.test.ts`, which says so rather
 *      than shipping a fixture that would pass either way.
 *
 * Isolation changes no output on this machine: no global, system or local
 * config here sets any key in `GIT_ISOLATION_CONFIG` (measured 2026-10-22).
 */
function censusGit(args: readonly string[], maxBuffer?: number): string {
  return execFileSync("git", gitIsolatedArgs(args), {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: gitIsolatedEnv(),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
}

/**
 * The one exit code every refusal travels through, declared exactly once.
 *
 * `test/worktree-census.test.ts` builds a mutant copy with this set to 0 and
 * runs every negative case twice — real refuses, mutant does not. A refusal
 * exiting with a hard-coded number instead of this constant would slip past
 * that mutation, so there are none; the success path exits by returning.
 */
export const REFUSE_EXIT = 1;

export class CensusRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CensusRefused";
  }
}

/* ------------------------------------------------------------------ *
 * Measured<T>: a value, or the reason there is no value
 * ------------------------------------------------------------------ */

export type Measured<T> = { measured: true; value: T } | { measured: false; why: string };

export const took = <T>(value: T): Measured<T> => ({ measured: true, value });
export const couldNotRead = <T>(why: string): Measured<T> => ({ measured: false, why });

/* ------------------------------------------------------------------ *
 * The worktree list
 * ------------------------------------------------------------------ */

export interface WorktreeRecord {
  /** Absolute, as git reports it. */
  path: string;
  head: string | null;
  /** Short branch name, or null when detached. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string;
  /** git itself says the directory is gone. */
  prunable: boolean;
  prunableReason: string;
  /** The first entry: the checkout everything else is linked to. */
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are blank-line separated and the first is always the main checkout.
 * `locked` and `prunable` may appear bare or with a reason, and a bare
 * `locked` is still locked — reading the reason as the fact would turn an
 * explicit do-not-touch marker into nothing.
 */
export function parseWorktreeList(porcelain: string): WorktreeRecord[] {
  const out: WorktreeRecord[] = [];
  let cur: WorktreeRecord | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      cur = {
        path: rest,
        head: null,
        branch: null,
        detached: false,
        locked: false,
        lockReason: "",
        prunable: false,
        prunableReason: "",
        isMain: out.length === 0,
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (key === "HEAD") cur.head = rest;
    else if (key === "branch") cur.branch = rest.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "locked") {
      cur.locked = true;
      cur.lockReason = rest;
    } else if (key === "prunable") {
      cur.prunable = true;
      cur.prunableReason = rest;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading 1 — does the branch have a merged pull request?
 * ------------------------------------------------------------------ */

export type MergeState =
  /** A merged PR, at exactly the commit this worktree holds. */
  | "MERGED"
  /** A merged PR, but the branch has moved since: those commits are on no other ref. */
  | "MERGED_BUT_MOVED"
  | "OPEN"
  | "CLOSED"
  | "NO_PR"
  /** No branch to ask about. */
  | "DETACHED";

export interface PullRequest {
  number: number;
  headRefName: string;
  headRefOid: string;
  state: string;
}

export interface BranchPulls {
  merged: PullRequest | null;
  open: PullRequest | null;
  closed: PullRequest | null;
}

/**
 * Index pull requests by head branch.
 *
 * A branch can carry several over its life, so all three states are kept
 * rather than last-one-wins: a branch with a merged PR *and* a later open one
 * is a branch somebody is still using, and a reader that kept only the merged
 * row would call it abandoned.
 */
export function indexPullRequests(prs: PullRequest[]): Map<string, BranchPulls> {
  const byBranch = new Map<string, BranchPulls>();
  for (const pr of prs) {
    if (!pr || typeof pr.headRefName !== "string") continue;
    let slot = byBranch.get(pr.headRefName);
    if (!slot) {
      slot = { merged: null, open: null, closed: null };
      byBranch.set(pr.headRefName, slot);
    }
    if (pr.state === "MERGED") slot.merged = pr;
    else if (pr.state === "OPEN") slot.open = pr;
    else slot.closed = pr;
  }
  return byBranch;
}

/**
 * The merge reading for one worktree.
 *
 * `index` being null means the pull request list could not be fetched, which
 * is UNMEASURED for every row — not "no PR found".
 */
export function mergeReading(
  record: WorktreeRecord,
  index: Map<string, BranchPulls> | null,
  indexWhy: string,
): Measured<{ state: MergeState; pr: number | null }> {
  if (record.branch === null) return took({ state: "DETACHED" as MergeState, pr: null });
  if (index === null) return couldNotRead(`pull requests not read: ${indexWhy}`);
  const slot = index.get(record.branch);
  if (!slot) return took({ state: "NO_PR" as MergeState, pr: null });
  if (slot.open) return took({ state: "OPEN" as MergeState, pr: slot.open.number });
  if (slot.merged) {
    // Identity, never ancestry. A squash merge leaves the branch head on no
    // ref main can reach, so "is it an ancestor" is the wrong question; "is
    // it the commit GitHub merged" is a fact with one answer.
    if (record.head && slot.merged.headRefOid && record.head !== slot.merged.headRefOid) {
      return took({ state: "MERGED_BUT_MOVED" as MergeState, pr: slot.merged.number });
    }
    if (!record.head || !slot.merged.headRefOid) {
      return couldNotRead(
        `PR #${slot.merged.number} is merged but the head commit could not be compared`,
      );
    }
    return took({ state: "MERGED" as MergeState, pr: slot.merged.number });
  }
  return took({ state: "CLOSED" as MergeState, pr: slot.closed ? slot.closed.number : null });
}

/* ------------------------------------------------------------------ *
 * Reading 2 — is the working tree clean?
 * ------------------------------------------------------------------ */

/**
 * `git status --porcelain`, read or refused.
 *
 * **The trap this exists to avoid.** An empty `git status` in a worktree
 * whose directory is gone is not an empty `git status` — the command fails
 * and prints nothing, and nothing is what clean looks like. So the exit
 * status decides, never the emptiness of stdout.
 *
 * `--no-optional-locks` because this reads worktrees other sessions are
 * using: without it, status refreshes and rewrites the index, which is a
 * write into somebody else's run from a tool whose whole claim is that it
 * only reads. It buys nothing against `core.fsmonitor`, which `status` runs
 * either way — that is `censusGit`'s job, and the measurement is there.
 */
export function cleanReading(dir: string): Measured<{ clean: boolean; entries: number }> {
  let out: string;
  try {
    out = censusGit(["--no-optional-locks", "-C", dir, "status", "--porcelain"]);
  } catch (e) {
    const msg = String((e as Error).message || "").split("\n").slice(0, 2).join(" ").trim();
    return couldNotRead(`git status failed: ${msg}`);
  }
  const lines = out.split("\n").filter(l => l.trim() !== "");
  return took({ clean: lines.length === 0, entries: lines.length });
}

/* ------------------------------------------------------------------ *
 * Reading 3 — does any process hold a file under it?
 * ------------------------------------------------------------------ */

export interface Holder {
  pid: string;
  command: string;
  path: string;
}

/**
 * Parse `lsof -F pcn` and attribute every open path to the deepest root that
 * contains it.
 *
 * Output is a stream of records: a `p<pid>` line opens a process, `c<cmd>`
 * names it, and each following `n<path>` is one of its open files — cwd and
 * the executable included, which is what makes a shell sitting in a worktree
 * visible at all.
 *
 * Matching walks the path upward against a set rather than testing every
 * root against every path: with 170 roots and 50k open files the quadratic
 * form is the difference between a tool people run and one they do not.
 */
export function holdersByRoot(lsofOutput: string, roots: string[]): Map<string, Holder[]> {
  const rootSet = new Set(roots);
  const found = new Map<string, Holder[]>();
  let pid = "";
  let command = "";
  for (const line of lsofOutput.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const body = line.slice(1);
    if (tag === "p") {
      pid = body;
      command = "";
    } else if (tag === "c") {
      command = body;
    } else if (tag === "n") {
      if (!body.startsWith("/")) continue;
      let probe = body;
      while (probe.length > 1) {
        if (rootSet.has(probe)) {
          const list = found.get(probe);
          if (list) list.push({ pid, command, path: body });
          else found.set(probe, [{ pid, command, path: body }]);
          break;
        }
        const cut = probe.lastIndexOf("/");
        if (cut <= 0) break;
        probe = probe.slice(0, cut);
      }
    }
  }
  return found;
}

/**
 * Run lsof once for the whole machine.
 *
 * Once, not per worktree: `lsof +D <dir>` descends the tree and 170 of those
 * is minutes of work, where one full enumeration is a fraction of a second.
 *
 * A failure here is UNMEASURED for every row at once, which is the honest
 * reading — "lsof is not installed" and "nothing holds any of them" are the
 * same empty output and must not be the same answer.
 */
export function readLsof(): Measured<string> {
  try {
    const out = execFileSync("lsof", ["-w", "-n", "-P", "-F", "pcn"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
    if (out.trim() === "") {
      return couldNotRead("lsof produced no output at all, which no running system does");
    }
    return took(out);
  } catch (e) {
    // lsof exits non-zero when some file systems could not be stat'd even
    // though it listed plenty. Partial output is still a real reading of the
    // processes it did see; empty output is not.
    const err = e as { stdout?: string | Buffer; message?: string };
    const partial = err.stdout ? String(err.stdout) : "";
    if (partial.trim() !== "") return took(partial);
    const msg = String(err.message || "").split("\n")[0];
    return couldNotRead(`lsof failed: ${msg}`);
  }
}

/* ------------------------------------------------------------------ *
 * Reading 4 — how recently was anything under it modified?
 * ------------------------------------------------------------------ */

export interface AgeValue {
  newestMtimeMs: number;
  scanned: number;
  stale: boolean;
}

/**
 * The newest mtime anywhere under the worktree, or the reason there isn't one.
 *
 * **A partial walk is refused, not reported.** Every way this walk can come
 * up short — an unreadable subdirectory, a tree past `maxEntries` — makes the
 * answer a LOWER bound on recency, and a lower bound can only ever make a
 * live worktree look old. That is the one direction that costs work, so a
 * walk that did not finish returns no value.
 *
 * `.git` is skipped because this script runs `git status` in every worktree
 * and that touches the git directory: including it would mean measuring our
 * own footprints. `node_modules` is skipped because in these worktrees it is
 * a symlink to the main checkout, shared by all of them, and its mtime says
 * nothing about any one. Symlinks are stat'd, never followed.
 *
 * A worktree nested inside another — `.claude/worktrees/*` under the main
 * checkout — is walked as part of its container, which makes the container
 * look as fresh as its freshest child. That is left alone deliberately: it
 * errs toward IN_USE, and the only direction worth engineering against is
 * the one that makes a live worktree look abandoned.
 */
export function ageReading(
  root: string,
  nowMs: number,
  olderThanMs: number,
  maxEntries: number,
): Measured<AgeValue> {
  const SKIP = new Set([".git", "node_modules"]);
  let newest = 0;
  let scanned = 0;
  const stack: string[] = [root];
  try {
    newest = lstatSync(root).mtimeMs;
  } catch (e) {
    return couldNotRead(`cannot stat the worktree directory: ${String((e as Error).message).split("\n")[0]}`);
  }
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return couldNotRead(
        `walk stopped at ${dir}: ${String((e as Error).message).split("\n")[0]} — ` +
          `a partial walk can only under-report recency`,
      );
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      scanned += 1;
      if (scanned > maxEntries) {
        return couldNotRead(
          `more than ${maxEntries} entries under this worktree — ` +
            `a truncated walk can only under-report recency`,
        );
      }
      const abs = join(dir, ent.name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        // A file that vanished between readdir and lstat is something
        // changing right now, which is the opposite of stale.
        return couldNotRead(`${abs} disappeared mid-walk`);
      }
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (ent.isDirectory() && !ent.isSymbolicLink()) stack.push(abs);
    }
  }
  return took({ newestMtimeMs: newest, scanned, stale: nowMs - newest >= olderThanMs });
}

/* ------------------------------------------------------------------ *
 * The verdict — one decider, and only one
 * ------------------------------------------------------------------ */

export interface Readings {
  merge: Measured<{ state: MergeState; pr: number | null }>;
  clean: Measured<{ clean: boolean; entries: number }>;
  holders: Measured<Holder[]>;
  age: Measured<AgeValue>;
}

export type Verdict = "ABANDONED" | "IN_USE" | "UNMEASURED";

/**
 * Which readings could not be taken, by name.
 *
 * One binding, used by both the verdict and the report. Two copies would be
 * two deciders that agree, which no test can tell apart.
 */
export function unmeasuredReadings(r: Readings): string[] {
  const out: string[] = [];
  if (!r.merge.measured) out.push("merge");
  if (!r.clean.measured) out.push("clean");
  if (!r.holders.measured) out.push("holders");
  if (!r.age.measured) out.push("age");
  return out;
}

/**
 * Rows that are IN_USE before any reading is consulted, and why.
 *
 * The main checkout is never a candidate for removal, and a lock is somebody
 * having already said so in writing. One binding rather than two, because
 * both the verdict and the evidence column ask this and a second copy would
 * be a decider no mutation of the first can reach.
 *
 * It is also the reason the summary can carry an unmeasured READING with no
 * unmeasured VERDICT: a locked worktree whose directory is unreadable is
 * still IN_USE, and the counts would otherwise look like they disagree.
 */
export function decidedWithoutReadings(record: WorktreeRecord): string | null {
  if (record.isMain) return "main checkout";
  if (record.locked) return `locked${record.lockReason ? `: ${record.lockReason}` : ""}`;
  return null;
}

/**
 * The only place a verdict is decided.
 *
 * ABANDONED requires all four readings to have been TAKEN and all four to
 * point the same way. Anything unmeasured is UNMEASURED, never ABANDONED,
 * and that is the property the whole file is for — `git status` in a deleted
 * directory prints exactly what a pristine tree prints.
 */
export function verdictFor(record: WorktreeRecord, r: Readings): Verdict {
  if (decidedWithoutReadings(record) !== null) return "IN_USE";
  if (unmeasuredReadings(r).length > 0) return "UNMEASURED";
  // One narrowing cast of the whole object rather than four checks the
  // compiler would accept: a second `if (!r.merge.measured) ...` here would
  // be a second decider for a question `unmeasuredReadings` already answers,
  // and two deciders that agree are one that no test can mutate.
  const t = r as {
    merge: { value: { state: MergeState } };
    clean: { value: { clean: boolean } };
    holders: { value: Holder[] };
    age: { value: AgeValue };
  };
  const abandonedWard =
    t.merge.value.state === "MERGED" &&
    t.clean.value.clean === true &&
    t.holders.value.length === 0 &&
    t.age.value.stale === true;
  return abandonedWard ? "ABANDONED" : "IN_USE";
}

/**
 * Why a row is not ABANDONED, in the words of the readings themselves.
 *
 * An UNMEASURED row reports what it could not read AND what it did read, so
 * a reader can see that a worktree whose PR lookup failed is also one a
 * process is holding. A verdict is a summary; the evidence is the output.
 */
export function evidenceFor(record: WorktreeRecord, r: Readings): string[] {
  const why: string[] = [];
  const settled = decidedWithoutReadings(record);
  if (settled !== null) why.push(settled);
  if (record.prunable) why.push(`git calls it prunable: ${record.prunableReason || "no reason given"}`);
  if (!r.merge.measured) why.push(`merge UNMEASURED (${r.merge.why})`);
  else if (r.merge.value.state !== "MERGED") why.push(`merge: ${r.merge.value.state}`);
  if (!r.clean.measured) why.push(`clean UNMEASURED (${r.clean.why})`);
  else if (!r.clean.value.clean) why.push(`${r.clean.value.entries} uncommitted change(s)`);
  if (!r.holders.measured) why.push(`holders UNMEASURED (${r.holders.why})`);
  else if (r.holders.value.length > 0) {
    const names = [...new Set(r.holders.value.map(h => `${h.command}[${h.pid}]`))].slice(0, 4);
    why.push(`held by ${names.join(", ")}`);
  }
  if (!r.age.measured) why.push(`age UNMEASURED (${r.age.why})`);
  else if (!r.age.value.stale) why.push("modified inside the declared age");
  return why;
}

/* ------------------------------------------------------------------ *
 * Census
 * ------------------------------------------------------------------ */

export interface CensusRow {
  path: string;
  branch: string | null;
  head: string | null;
  verdict: Verdict;
  readings: {
    merge: Measured<{ state: MergeState; pr: number | null }>;
    clean: Measured<{ clean: boolean; entries: number }>;
    holders: Measured<{ count: number; by: string[] }>;
    age: Measured<{ newestMtimeMs: number; ageMs: number; stale: boolean }>;
  };
  unmeasured: string[];
  evidence: string[];
}

export interface CensusResult {
  repo: string;
  takenAt: string;
  olderThanMs: number;
  /** Present always, so "nobody warned me" and "there was nothing to warn about" differ. */
  warnings: string[];
  counts: {
    total: number;
    abandoned: number;
    inUse: number;
    unmeasured: number;
    /**
     * Rows with an unmeasured reading that are IN_USE anyway because the main
     * checkout and a locked worktree are settled before readings are
     * consulted. Reported so `unmeasuredByReading` summing above
     * `counts.unmeasured` is an explained difference rather than a puzzle.
     */
    unmeasuredButSettled: number;
  };
  /** How many rows each reading could not be taken for. */
  unmeasuredByReading: Record<string, number>;
  rows: CensusRow[];
}

/**
 * `git worktree prune` is a hazard here and the census is where to say so.
 *
 * prune drops `.git/worktrees/<name>` for ANY registered worktree whose
 * directory is already gone — not only the one the person running it was
 * thinking about. It deletes no branch and no commit, so the blast radius is
 * bookkeeping, but a session whose directory was removed out from under it
 * loses the registration that makes `git worktree repair` possible.
 */
export function pruneWarnings(records: WorktreeRecord[]): string[] {
  const gone = records.filter(r => r.prunable);
  if (gone.length === 0) return [];
  return [
    `${gone.length} registered worktree(s) have no directory on disk. ` +
      `\`git worktree prune\` would drop the bookkeeping for ALL of them, not just yours: ` +
      gone.map(r => r.path).join(", "),
  ];
}

export interface CensusOptions {
  repo: string;
  olderThanMs: number;
  maxEntries: number;
  nowMs: number;
  pulls: Measured<PullRequest[]>;
  lsof: Measured<string>;
}

/** Resolve a path through symlinks, or keep it: /tmp is /private/tmp here. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function census(records: WorktreeRecord[], opts: CensusOptions): CensusResult {
  const index = opts.pulls.measured ? indexPullRequests(opts.pulls.value) : null;
  const indexWhy = opts.pulls.measured ? "" : opts.pulls.why;

  const canonicalOf = new Map<string, string>();
  for (const r of records) canonicalOf.set(r.path, canonical(r.path));
  const held = opts.lsof.measured
    ? holdersByRoot(opts.lsof.value, [...new Set(canonicalOf.values())])
    : new Map<string, Holder[]>();

  const rows: CensusRow[] = [];
  const counts = {
    total: records.length,
    abandoned: 0,
    inUse: 0,
    unmeasured: 0,
    unmeasuredButSettled: 0,
  };
  const unmeasuredByReading: Record<string, number> = { merge: 0, clean: 0, holders: 0, age: 0 };

  for (const record of records) {
    const dir = canonicalOf.get(record.path) as string;
    const merge = mergeReading(record, index, indexWhy);
    const clean = cleanReading(record.path);
    const holders: Measured<Holder[]> = opts.lsof.measured
      ? took(held.get(dir) ?? [])
      : couldNotRead(opts.lsof.why);
    const age = ageReading(record.path, opts.nowMs, opts.olderThanMs, opts.maxEntries);
    const readings: Readings = { merge, clean, holders, age };

    const verdict = verdictFor(record, readings);
    const unmeasured = unmeasuredReadings(readings);
    for (const name of unmeasured) unmeasuredByReading[name] += 1;
    if (unmeasured.length > 0 && verdict !== "UNMEASURED") counts.unmeasuredButSettled += 1;
    if (verdict === "ABANDONED") counts.abandoned += 1;
    else if (verdict === "UNMEASURED") counts.unmeasured += 1;
    else counts.inUse += 1;

    rows.push({
      path: record.path,
      branch: record.branch,
      head: record.head,
      verdict,
      readings: {
        merge,
        clean,
        holders: holders.measured
          ? took({
              count: holders.value.length,
              by: [...new Set(holders.value.map(h => `${h.command}[${h.pid}]`))],
            })
          : couldNotRead(holders.why),
        age: age.measured
          ? took({
              newestMtimeMs: age.value.newestMtimeMs,
              ageMs: opts.nowMs - age.value.newestMtimeMs,
              stale: age.value.stale,
            })
          : couldNotRead(age.why),
      },
      unmeasured,
      evidence: evidenceFor(record, readings),
    });
  }

  return {
    repo: opts.repo,
    takenAt: new Date(opts.nowMs).toISOString(),
    olderThanMs: opts.olderThanMs,
    warnings: pruneWarnings(records),
    counts,
    unmeasuredByReading,
    rows,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function renderTable(result: CensusResult): string {
  const header = ["VERDICT", "MERGE", "TREE", "HELD", "AGE", "WORKTREE", "EVIDENCE"];
  const body = result.rows.map(row => [
    row.verdict,
    row.readings.merge.measured ? row.readings.merge.value.state : "UNMEASURED",
    row.readings.clean.measured ? (row.readings.clean.value.clean ? "clean" : "dirty") : "UNMEASURED",
    row.readings.holders.measured ? String(row.readings.holders.value.count) : "UNMEASURED",
    row.readings.age.measured ? humanAge(row.readings.age.value.ageMs) : "UNMEASURED",
    row.path,
    row.evidence.join("; "),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map(r => r[i].length).concat(0)),
  );
  // The last column is free-form, so it is not padded.
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();

  const lines = [line(header), ...body.map(line), ""];
  for (const w of result.warnings) lines.push(`WARNING: ${w}`);
  if (result.warnings.length === 0) lines.push("WARNING: none — every registered worktree has a directory on disk.");
  lines.push("");
  lines.push(
    `${result.counts.total} worktrees: ${result.counts.abandoned} ABANDONED, ` +
      `${result.counts.inUse} IN_USE, ${result.counts.unmeasured} UNMEASURED ` +
      `(declared age ${humanAge(result.olderThanMs)}, taken ${result.takenAt})`,
  );
  lines.push(
    "unmeasured readings: " +
      Object.entries(result.unmeasuredByReading)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") +
      ` (${result.counts.unmeasuredButSettled} of them on rows settled as IN_USE ` +
      `before readings — the main checkout and locked worktrees)`,
  );
  lines.push("This tool removes nothing. UNMEASURED is not ABANDONED; neither is a licence to delete.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export interface Args {
  repo: string;
  olderThanMs: number;
  maxEntries: number;
  json: boolean;
  out: string | null;
  gh: boolean;
  ghRepo: string | null;
}

const DURATION = /^([0-9]+)(m|h|d)$/;

export function parseDuration(text: string): number {
  const m = DURATION.exec(text);
  if (!m) {
    throw new CensusRefused(
      `--older-than ${text} is not a duration — use <n>m, <n>h or <n>d, e.g. 7d`,
    );
  }
  const n = Number(m[1]);
  const unit = { m: 60000, h: 3600000, d: 86400000 }[m[2] as "m" | "h" | "d"];
  return n * unit;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: process.cwd(),
    olderThanMs: parseDuration("7d"),
    maxEntries: 20000,
    json: false,
    out: null,
    gh: true,
    ghRepo: null,
  };
  const need = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) throw new CensusRefused(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = need(i++, a);
    else if (a === "--older-than") args.olderThanMs = parseDuration(need(i++, a));
    else if (a === "--max-entries") {
      const v = Number(need(i++, a));
      if (!Number.isInteger(v) || v < 1) throw new CensusRefused(`--max-entries needs a positive integer`);
      args.maxEntries = v;
    } else if (a === "--json") args.json = true;
    else if (a === "--out") args.out = need(i++, a);
    else if (a === "--no-gh") args.gh = false;
    else if (a === "--gh-repo") args.ghRepo = need(i++, a);
    else throw new CensusRefused(`unknown argument: ${a}`);
  }
  return args;
}

/** `git worktree list --porcelain`, or a refusal naming why it could not run. */
export function readWorktreeList(repo: string): string {
  try {
    return censusGit(["-C", repo, "worktree", "list", "--porcelain"], 64 * 1024 * 1024);
  } catch (e) {
    const msg = String((e as Error).message || "").split("\n").slice(0, 2).join(" ").trim();
    throw new CensusRefused(`cannot list worktrees in ${repo}: ${msg}`);
  }
}

/**
 * Every pull request, in one call.
 *
 * One call and not 170: `gh pr list --head <branch>` per worktree is 170
 * round trips against a rate limit, and a tool that gets throttled half way
 * reports the second half as unmeasured for a reason that is about itself.
 */
export function readPullRequests(repoFlag: string | null): Measured<PullRequest[]> {
  const argv = ["pr", "list", "--state", "all", "--limit", "2000", "--json",
    "number,headRefName,headRefOid,state"];
  if (repoFlag) argv.push("--repo", repoFlag);
  try {
    const out = execFileSync("gh", argv, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return couldNotRead("gh did not return a list of pull requests");
    return took(parsed as PullRequest[]);
  } catch (e) {
    const msg = String((e as Error).message || "").split("\n")[0];
    return couldNotRead(`gh pr list failed: ${msg}`);
  }
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const records = parseWorktreeList(readWorktreeList(args.repo));
  const result = census(records, {
    repo: args.repo,
    olderThanMs: args.olderThanMs,
    maxEntries: args.maxEntries,
    nowMs: Date.now(),
    pulls: args.gh
      ? readPullRequests(args.ghRepo)
      : couldNotRead<PullRequest[]>("--no-gh was passed, so no pull request was consulted"),
    lsof: readLsof(),
  });
  const rendered = args.json ? JSON.stringify(result, null, 2) : renderTable(result);
  if (args.out) {
    try {
      writeFileSync(args.out, JSON.stringify(result, null, 2));
    } catch (e) {
      throw new CensusRefused(`cannot write ${args.out}: ${String((e as Error).message).split("\n")[0]}`);
    }
  }
  process.stdout.write(rendered + "\n");
  return result.counts.total;
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CensusRefused) {
      process.stderr.write(`worktree-census: ${e.message}\n`);
      process.exit(REFUSE_EXIT);
    }
    throw e;
  }
}
