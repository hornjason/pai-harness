#!/usr/bin/env bun
/**
 * Decide whether the LOCAL review loop gets another round (#1342).
 *
 * The loop this bounds is the one a person drives: run the local review, relay
 * what it found, the agent pushes a fix, run the local review again. On
 * 2026-10-23 it went five rounds on #1304 and four of the five pushes were
 * triggered by review output rather than by anything the implementing agent
 * found. Nothing ended it except the lead noticing, and a lead who is AFK is
 * not a mechanism.
 *
 * `lib/local-review-rounds.ts` holds the whole decision and this file holds
 * none of it. What is here is the part a library cannot be: a place the loop's
 * driver can ask the question without being able to import anything.
 *
 * Usage:
 *   bun scripts/local-review-round.ts --rounds <file.json> [--cap <n>] [--out <file>]
 *
 * `--rounds` is a JSON array, oldest round first, of
 * `{"findings":[{"id","title","body"}]}` — EVERY round so far, the one just
 * returned included. The reading is about the last entry.
 *
 * **Exit 0 means run another round. Any other exit means do not.** The reading
 * is printed on stdout either way, and a refusal is not a silence: an
 * `AT_CAP` reading carries the classes this round raised in `newClasses`, and
 * those are to be FILED rather than fixed-and-re-reviewed. The cap bounds the
 * loop; it was never meant to bound the information.
 *
 * TWO PROPERTIES THIS FILE MUST KEEP, both asserted by
 * test/local-review-rounds.test.ts (`.claude/rules/checks-must-be-able-to-fail.md`):
 *
 *   1. Every refusal exits through REFUSE_EXIT, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs each
 *      refusing case twice — real refuses, mutant does not. An exit written
 *      with a literal would slip past the mutation and leave the case
 *      indistinguishable from one passing by accident.
 *   2. The mutant is copied into a sandbox that carries `lib/` with it, and
 *      every case asserts the mutant PRINTED A DECISION as well as exiting 0.
 *      A mutant that died on module resolution also exits non-zero, which
 *      reads as the mutation having been rejected on the merits; a mutant that
 *      printed the decision demonstrably reached the mechanism.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import {
  LOCAL_REVIEW_UNMEASURED,
  appendRound,
  localHistoryPath,
  localRoundReading,
  parseHistory,
  runAnotherRound,
  summarise,
  type LocalRoundReading,
} from "../lib/local-review-rounds.ts";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["rounds", "cap", "out", "history", "findings", "pr", "repo"]);

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Error(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${m[1]} needs a value`);
    out[m[1]] = value;
  }
  return out;
}

/**
 * Read the rounds file.
 *
 * A file that is absent, unreadable or not JSON returns the refusal STRING
 * rather than an empty array. An empty array is a reading — "no round has
 * happened" — and a file nobody could open is not one. Collapsing them is how
 * a broken path becomes a loop that believes it is on round 1 forever.
 */
function readRounds(path: string | undefined): { rounds: unknown } | { refusal: string } {
  if (!path) return { refusal: "--rounds is required: the reading is about a specific loop's history" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    return { refusal: `--rounds ${path} could not be read (${firstLine(e)})` };
  }
  try {
    return { rounds: JSON.parse(raw) };
  } catch (e) {
    return { refusal: `--rounds ${path} is not JSON (${firstLine(e)})` };
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0];
}

/**
 * Record this round, then read the whole history back.
 *
 * The RECORDING and the DECISION are one command on purpose. Two commands
 * means a driver that calls the second and forgets the first, and that driver
 * does not fail — it reports round 1 forever, which is the unbounded loop
 * wearing the bound's clothes. There is no way to ask this script for a
 * verdict on a round it has not written down.
 *
 * The write happens BEFORE the reading, and a write that fails is a refusal.
 * The round happened; a history that does not hold it makes the next turn
 * miscount, so "I could not record this" is not a state from which a verdict
 * may be issued.
 */
function recordThenRead(
  historyPath: string,
  findingsPath: string | undefined,
): { rounds: unknown } | { refusal: string } {
  if (!findingsPath) {
    return { refusal: "--findings is required with --history: a round is recorded by what it found" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(findingsPath, "utf-8"));
  } catch (e) {
    return { refusal: `--findings ${findingsPath} could not be read as JSON (${firstLine(e)})` };
  }
  // Both the adjudicator's `{findings:[...]}` envelope and a bare array, so a
  // driver can pipe the reviewer's payload through unchanged.
  const findings = Array.isArray(payload)
    ? payload
    : (payload as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings)) {
    return {
      refusal:
        `--findings ${findingsPath} holds no findings array — a round whose findings cannot ` +
        `be read is not a round that found nothing, and recording it as one would clear the ` +
        `loop on an unread payload`,
    };
  }

  const existing = readHistoryBytes(historyPath);
  if ("refusal" in existing) return existing;
  const appended = appendRound(parseHistory(existing.raw), findings, new Date().toISOString());
  if ("refusal" in appended) return appended;

  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, `${JSON.stringify(appended.rounds, null, 2)}\n`);
  } catch (e) {
    return { refusal: `the review history at ${historyPath} could not be written (${firstLine(e)})` };
  }
  return { rounds: appended.rounds };
}

/**
 * The history's bytes, `raw: null` for a file that is NOT THERE, and a
 * refusal for one that is there and could not be read.
 *
 * **Those are the only two things a failed read is allowed to collapse to,
 * and collapsing them was a high finding on this pull request's first push.**
 * The previous reading returned `null` for every failure; `null` is what an
 * absent history looks like, so a permission-denied read became round 1 and
 * the next line OVERWROTE the file it had just failed to open. Driven as a
 * loop that is not a quiet data loss — it is the unbounded loop itself, every
 * turn re-reading as the first: the regression case ran 12 turns before its
 * backstop, against 1 now.
 *
 * `ENOENT` and nothing else is absence, and it is read from the error rather
 * than from a prior `existsSync`. That removes the window between the two
 * calls, and it is the narrower reading: an `EACCES`, an `EISDIR` or an `EIO`
 * are all "there is something here I cannot read", which is the fact this
 * distinction exists to keep.
 */
function readHistoryBytes(path: string): { raw: string | null } | { refusal: string } {
  try {
    return { raw: readFileSync(path, "utf-8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { raw: null };
    return {
      refusal:
        `the review history at ${path} exists and could not be read (${firstLine(e)}) — ` +
        `how many rounds this loop has already spent is unknown, and it is not being read ` +
        `as round 1: that would restart the count on every turn, which is a cap that can ` +
        `never be reached`,
    };
  }
}

if (import.meta.main) {
  let reading: LocalRoundReading;
  try {
    const args = parseArgs(process.argv.slice(2));

    // Three ways to name the loop, in order of explicitness. `--pr` is the
    // one a driver can use without bookkeeping, which is the difference
    // between a mechanism and a thing somebody has to remember.
    let historyPath: string | null | undefined = args.history;
    if (historyPath === undefined && args.pr !== undefined) {
      historyPath = localHistoryPath(args.repo ?? "", args.pr);
      if (historyPath === null) {
        throw new Error(
          `--pr ${args.pr} and --repo ${args.repo ?? "(none)"} do not name a pull request — ` +
            `--repo must be owner/name and --pr a positive integer. Refused rather than ` +
            `resolved from the working directory, which would file one pull request's rounds ` +
            `under another's`,
        );
      }
    }

    const read =
      historyPath !== undefined && historyPath !== null
        ? recordThenRead(historyPath, args.findings)
        : readRounds(args.rounds);
    reading =
      "refusal" in read
        ? {
            decision: LOCAL_REVIEW_UNMEASURED,
            round: null,
            newClasses: [],
            repeats: [],
            reason: read.refusal,
          }
        : localRoundReading(read.rounds, args.cap === undefined ? undefined : Number(args.cap));
    if (args.out) writeFileSync(args.out, `${JSON.stringify(reading)}\n`);
  } catch (e) {
    reading = {
      decision: LOCAL_REVIEW_UNMEASURED,
      round: null,
      newClasses: [],
      repeats: [],
      reason: `local-review-round could not read its own arguments: ${firstLine(e)}`,
    };
  }

  console.log(JSON.stringify(reading));
  console.error(`local-review-round: ${summarise(reading)}`);
  if (!runAnotherRound(reading)) process.exit(REFUSE_EXIT);
}
