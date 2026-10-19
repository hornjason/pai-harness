/**
 * SC id reservations, as a file in the repository rather than in a prompt (#725).
 *
 * ## Why a file, when the allocator already reads every worktree and every ref
 *
 * `readScNamespace` (#503) reads sibling worktrees' `specs/` and every local
 * and remote-tracking ref. That is a reading of ids that have already been
 * **written down somewhere this machine can see**. It cannot see an id a
 * session has decided to use and not yet typed, and it cannot see anything on
 * another clone at all.
 *
 * On 2026-10-19 that produced four collisions in one day. The first was eight
 * PRs merging in sequence, two of which both claimed SC-2161 and SC-2162. The
 * other three are the ones that matter for this module, because **in none of
 * them was the allocator ever run**:
 *
 * | Instance | How the id was consumed |
 * |---|---|
 * | two | a renumber during the repair of instance one, picked by reading the highest id in the tree by hand |
 * | three | two branches each allocating correctly against a view that excluded the other, found only by sweeping branch diffs |
 * | four | ids hand-written into a new test file, caught by `sc-fixture-namespace` |
 *
 * So no change to what the allocator *returns* could have prevented three of
 * the four: nothing consulted it. The class is "an id consumed without going
 * through the allocator", and the only thing that covers that class is a
 * declaration someone makes **before** consuming the ids, in a place every
 * other session reads. That is this file.
 *
 * The convention already existed — five sessions were handed disjoint blocks
 * in their briefs — and it worked. It lived entirely in prompts, so nothing in
 * the tree recorded which blocks were reserved or by whom, and it survived
 * exactly as long as everyone remembered. Instance two was made by the person
 * handing the blocks out, outside any block, because a repair did not feel
 * like an allocation. A renumber is an allocation.
 *
 * ## `{}` and `{"reservations": []}` are not the same state
 *
 * This is `.claude/rules/config-access.md`'s *Silent Default Substitution* in
 * the place it does the most damage: **zero known reservations is not "no
 * conflict", it is very often an unread store.** A `JSON.parse` that succeeds
 * and yields an object with no `reservations` key gives an empty block list,
 * which is byte-identical to a store that genuinely reserves nothing — and the
 * allocator then allocates as if nothing were reserved, which is the pre-#725
 * behaviour wearing a fix.
 *
 * So `RESERVATIONS_CONTROL_KEY` is the control string
 * `.claude/rules/checks-must-be-able-to-fail.md` asks for: a string that MUST
 * be present if the store holds anything at all. Absent, the reading is
 * `unreadable`, not empty, and `allocateScNumber` refuses rather than
 * returning a number.
 *
 * Three states, three different facts:
 *
 * | State | Means | Allocator |
 * |---|---|---|
 * | `absent` | no store in this tree — the normal state for a scaffolded consumer | allocates, with a `skipped` leg and a named `unmeasured` entry |
 * | `unreadable` | a store is there and this process could not read it | **refuses** |
 * | `read` | the store parsed and declared its control key | allocates, treating every block as occupied |
 *
 * `absent` does not refuse on purpose. Every consumer project this harness
 * scaffolds has no store, and a refusal they cannot act on is the fastest way
 * to build a gate everyone learns to click past.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { FIXTURE_SC_FLOOR } from "./sc-ids";

/**
 * Where the store lives, relative to the project root.
 *
 * `specs/` because SC ids are a property of the spec namespace, and because
 * the cross-tree reader already points every session at that directory. It is
 * JSON rather than Markdown so that a reserved block is a pair of integers
 * and never the string `SC-<N>` — a store spelling ids literally would be
 * picked up by `scIdsSpelledInSource` and by `spec-sc-ids-unique`, and a
 * reservation would then read as a declaration.
 */
export const SC_RESERVATIONS_PATH = "specs/sc-reservations.json";

/**
 * The key that must be present if the store holds anything.
 *
 * One binding, because a second place that decides what a readable store looks
 * like would survive any mutation of the first
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export const RESERVATIONS_CONTROL_KEY = "reservations";

/** The message prefix every refusal out of this module and its allocator uses. */
export const RESERVATION_REFUSAL = "SC reservation store is present and unreadable";

/** One declared block. `from` and `to` are inclusive. */
export interface ScReservation {
  /** Branch name or issue ref. The thing another session can look you up by. */
  owner: string;
  from: number;
  to: number;
  note?: string;
}

export type ScReservationStatus = "read" | "absent" | "unreadable";

export interface ScReservationReading {
  status: ScReservationStatus;
  /** Absolute path the reading was taken from, whether or not it existed. */
  path: string;
  /** Empty under every status except a `read` of a store that declares blocks. */
  blocks: ScReservation[];
  /** Why it could not be read, or why the store is absent. Absent on a clean read. */
  reason?: string;
}

/** A positive integer and nothing else — `1.5`, `NaN` and `"7"` are all refused. */
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/**
 * Validate one entry, returning the reason it is unusable or `null`.
 *
 * A block at or above the fixture floor is refused rather than clamped: the
 * 9000s exist so a fixture can spell an id that no criterion will ever take,
 * and a reservation up there is a declaration the allocator structurally
 * cannot honour (`nextSCNumber` drops fixture ids on purpose). Silently
 * ignoring it would make the store say one thing and the allocator do another.
 */
function blockFault(raw: unknown, index: number): string | null {
  const at = `${RESERVATIONS_CONTROL_KEY}[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return `${at} is not an object`;
  const b = raw as Record<string, unknown>;
  if (typeof b.owner !== "string" || b.owner.trim() === "") return `${at} has no owner`;
  if (!isCount(b.from)) return `${at} (${String(b.owner)}) has no usable "from"`;
  if (!isCount(b.to)) return `${at} (${String(b.owner)}) has no usable "to"`;
  if ((b.to as number) < (b.from as number)) return `${at} (${String(b.owner)}) runs backwards`;
  if ((b.to as number) >= FIXTURE_SC_FLOOR) {
    return `${at} (${String(b.owner)}) reaches into the fixture range, which the allocator cannot honour`;
  }
  if (b.note !== undefined && typeof b.note !== "string") return `${at} (${String(b.owner)}) has a non-string note`;
  return null;
}

/**
 * Two blocks that overlap are a collision the store itself declares.
 *
 * This is the one failure mode a reservation file adds that a prompt did not
 * have, so it is refused rather than merged: a store that hands the same id to
 * two owners is strictly worse than no store, because the sessions reading it
 * both believe they are separated.
 */
function overlapFault(blocks: ScReservation[]): string | null {
  const sorted = [...blocks].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.from <= prev.to) {
      return `${prev.owner} (${prev.from}-${prev.to}) and ${cur.owner} (${cur.from}-${cur.to}) overlap`;
    }
  }
  return null;
}

/**
 * Read the store, naming which of the three states it is in.
 *
 * Never throws. The refusal belongs to the allocator, which is the thing with
 * a number to withhold; a reader that threw would make `absent` and
 * `unreadable` reach the caller the same way.
 */
export function readScReservations(root: string): ScReservationReading {
  const path = join(root, SC_RESERVATIONS_PATH);
  if (!existsSync(path)) {
    return { status: "absent", path, blocks: [], reason: `no reservation store at ${SC_RESERVATIONS_PATH}` };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { status: "unreadable", path, blocks: [], reason: (err as Error).message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "unreadable", path, blocks: [], reason: `invalid JSON: ${(err as Error).message}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unreadable", path, blocks: [], reason: "the store is not a JSON object" };
  }

  // The control string. An object with no `reservations` key yields an empty
  // block list through every other path in this function, and that empty list
  // is indistinguishable from a store that reserves nothing — so it is checked
  // before any empty result is believed.
  const declared = (parsed as Record<string, unknown>)[RESERVATIONS_CONTROL_KEY];
  if (declared === undefined) {
    return {
      status: "unreadable",
      path,
      blocks: [],
      reason: `the store declares no "${RESERVATIONS_CONTROL_KEY}" key, so an empty reading would be a reading of nothing`,
    };
  }
  if (!Array.isArray(declared)) {
    return { status: "unreadable", path, blocks: [], reason: `"${RESERVATIONS_CONTROL_KEY}" is not an array` };
  }

  const faults = declared.map((b, i) => blockFault(b, i)).filter((f): f is string => f !== null);
  if (faults.length > 0) {
    return { status: "unreadable", path, blocks: [], reason: faults.join("; ") };
  }

  const blocks = declared.map(b => {
    const r = b as Record<string, unknown>;
    const block: ScReservation = { owner: r.owner as string, from: r.from as number, to: r.to as number };
    if (typeof r.note === "string") block.note = r.note;
    return block;
  });

  const overlap = overlapFault(blocks);
  if (overlap !== null) {
    return { status: "unreadable", path, blocks: [], reason: `the store declares an overlap: ${overlap}` };
  }

  return { status: "read", path, blocks };
}

/** How many ids the store declares occupied. `0` under every non-`read` status. */
export function reservedIdCount(blocks: ScReservation[]): number {
  return blocks.reduce((n, b) => n + (b.to - b.from + 1), 0);
}

/** The highest id any block reaches, or `0` when nothing is reserved. */
export function reservedCeiling(blocks: ScReservation[]): number {
  return blocks.reduce((n, b) => Math.max(n, b.to), 0);
}

/**
 * The block reserved to `owner`, or `null`.
 *
 * Exact match on the owner string. A prefix or substring match is the tempting
 * widening and it is the wrong one: `fix/725` matching `fix/725-followup`
 * hands one block to two branches, which is the defect this file exists over.
 */
export function reservationFor(blocks: ScReservation[], owner: string | null): ScReservation | null {
  if (owner === null || owner.trim() === "") return null;
  return blocks.find(b => b.owner === owner) ?? null;
}

/**
 * The lowest id in `block` that nothing in `taken` already holds, or `null`
 * when the block is spent.
 *
 * `null` is a refusal the caller has to say something about. Falling back to
 * "allocate above the block" would quietly undo the separation the block was
 * handed out to provide, on the one day it matters.
 */
export function lowestFreeInBlock(block: ScReservation, taken: ReadonlySet<number>): number | null {
  for (let n = block.from; n <= block.to; n++) if (!taken.has(n)) return n;
  return null;
}

/**
 * The branch name a CLI should look itself up by, or `null`.
 *
 * `null` on a detached HEAD or on anything that is not a git checkout, and
 * never a guess: an owner this function invented would match no block, which
 * routes the caller to the no-block path — above every reservation — rather
 * than into somebody else's.
 */
export function currentScOwner(root: string): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 30_000,
      // Captured, not inherited — a `fatal: not a git repository` in the
      // middle of a suite's output breaks every downstream reader of it (#60).
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}
