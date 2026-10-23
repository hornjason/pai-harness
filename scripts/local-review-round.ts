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

import { readFileSync, writeFileSync } from "fs";

import {
  LOCAL_REVIEW_UNMEASURED,
  localRoundReading,
  runAnotherRound,
  summarise,
  type LocalRoundReading,
} from "../lib/local-review-rounds.ts";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["rounds", "cap", "out"]);

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

if (import.meta.main) {
  let reading: LocalRoundReading;
  try {
    const args = parseArgs(process.argv.slice(2));
    const read = readRounds(args.rounds);
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
