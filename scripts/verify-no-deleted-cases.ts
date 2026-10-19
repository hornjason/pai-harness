#!/usr/bin/env bun
/**
 * Did this repair round delete tests that were passing? (#659)
 *
 * On `wf_2abbe96f-546` the verify gate recorded AC-9 FAIL over an evidence
 * command that prints two numbers against one threshold, and the repair
 * round it triggered deleted eight test cases that were green at the commit
 * the gate had just graded — three from
 * `test/unit/hill-climb-receipt.test.ts` and five from
 * `test/compliance-report.test.ts`. Deleting them changed nothing about what
 * AC-9 measures. The round's output was a smaller green tree and nothing in
 * the run said what left.
 *
 * Deleting a failing test is a correct solution to "make this gate pass" and
 * an incorrect solution to the problem, and every downstream reading agrees
 * with it: the suite is green, the census is a net number that a replacement
 * block hides, and the PR diff against the merge base never contained the
 * cases at all. This compares the two BUILD COMMITS, by case NAME, and
 * refuses.
 *
 * Usage:
 *   bun scripts/verify-no-deleted-cases.ts --project <dir> \
 *     --previous <sha> --current <sha> [--ledger <junit.xml>] [--out <file>] \
 *     [--accept <case name>]... [--reason <why>]
 *
 * A deletion you meant is waived PER CASE, by exact name, and `--accept`
 * without `--reason` is refused — a waiver nobody has to justify is a
 * warning nobody reads, which is the rule `scripts/verify-merge-content.ts`
 * states and the model this follows (#661). The reason is written into the
 * artefact beside each case it covers, so a waived round and a clean one
 * are never the same record.
 *
 * Prints one JSON object on stdout; diagnostics go to stderr so stdout stays
 * machine-readable. Exits non-zero when a case the previous build commit
 * proved green is gone — and when a deletion happened that nothing can
 * judge, because an unreadable ledger is UNMEASURED and UNMEASURED is not
 * clean (`.claude/rules/config-access.md`).
 *
 * TWO PROPERTIES THIS FILE MUST KEEP, for the reason
 * `scripts/verify-merge-content.ts` states at greater length:
 *
 *   1. Every refusal exits through `REFUSE_EXIT`, declared exactly once. A
 *      refusal written with a literal `1` would slip past any mutation of
 *      the constant.
 *   2. It decides nothing itself. The deleted set and the verdict both come
 *      from `lib/test-case-deletion.ts`, so there is ONE binding to mutate
 *      rather than a script and a library that agree
 *      (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */

import { writeFileSync } from "fs";

import { deletedCases, deletionReading, ledgerFromJunit, type PassLedger } from "../lib/test-case-deletion";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

const OPTIONS = new Set(["project", "previous", "current", "ledger", "out", "accept", "reason"]);
/** Repeatable, because one waiver per case is the whole point. */
const REPEATABLE = new Set(["accept"]);

class Refused extends Error {}

export interface ParsedArgs extends Record<string, string | string[]> {}

export function parseArgs(argv: string[]): Record<string, any> {
  const out: Record<string, any> = { accept: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Refused(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Refused(`--${m[1]} needs a value`);
    if (REPEATABLE.has(m[1])) out[m[1]].push(value);
    else out[m[1]] = value;
  }
  // The rule this check borrows from `scripts/verify-merge-content.ts`: an
  // unexplained waiver is not a waiver. Refused here rather than defaulted
  // to an empty string, because a blank reason in the artefact reads as a
  // reason nobody wrote down rather than as one that was never required.
  if (out.accept.length > 0 && String(out.reason ?? "").trim().length === 0) {
    throw new Refused(
      `--accept was given for ${out.accept.join(", ")} without --reason. An unexplained waiver ` +
        "is a deletion nobody has to account for, which is the thing this check exists to stop",
    );
  }
  if (out.accept.length === 0 && String(out.reason ?? "").trim().length > 0) {
    throw new Refused("--reason was given with no --accept, so it explains nothing");
  }
  for (const required of ["project", "previous", "current"]) {
    if (!out[required]) throw new Refused(`--${required} is required`);
  }
  // The two build commits being the SAME commit is not a clean comparison,
  // it is a comparison of a tree with itself, and it cannot report anything.
  if (out.previous === out.current) {
    throw new Refused(`--previous and --current name the same commit (${out.previous}) — nothing can be compared`);
  }
  return out;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const ledger: PassLedger = args.ledger
      ? ledgerFromJunit(args.ledger)
      : {
          status: "UNMEASURED",
          reason: "no --ledger was given, so nothing says which cases were passing at the previous build commit",
        };

    const deleted = deletedCases(args.project, args.previous, args.current);
    const reading = deletionReading(deleted, ledger, {
      cases: args.accept,
      reason: String(args.reason ?? ""),
    });

    const result = {
      verdict: reading.verdict,
      previous: args.previous,
      current: args.current,
      cases: reading.cases.map((c: { name: string; file: string }) => ({ name: c.name, file: c.file })),
      reason: reading.verdict === "UNMEASURED" ? reading.reason : null,
      // Recorded unconditionally when present, so a CLEAN reached by waiving
      // and a CLEAN reached by deleting nothing are different records.
      ...(reading.waived ? { waived: reading.waived } : {}),
      ...(reading.unusedWaivers ? { unusedWaivers: reading.unusedWaivers } : {}),
    };
    const json = JSON.stringify(result, null, 2);
    if (args.out) writeFileSync(args.out, json);
    console.log(json);

    // A CLEAN reached by waiving is not a CLEAN reached by deleting nothing,
    // and the console is where an operator actually looks. Saying it here
    // keeps the two distinguishable without the artefact being opened.
    if (reading.waived && reading.waived.length > 0) {
      console.error(
        `WAIVED: ${reading.waived.length} deleted case(s) accepted — ` +
          `${reading.waived.map(w => `${w.file} :: ${w.name}`).join("; ")} — reason: ${reading.waived[0].acceptedReason}`,
      );
    }
    if (reading.unusedWaivers && reading.unusedWaivers.length > 0) {
      console.error(
        `STALE_WAIVER: ${reading.unusedWaivers.join(", ")} matched no deleted case. Either the ` +
          "deletion is gone and the waiver should go with it, or the case was renamed and the " +
          "waiver has silently stopped applying",
      );
    }

    if (reading.verdict !== "CLEAN") {
      console.error(
        reading.verdict === "DELETED"
          ? `DELETED_PASSING_TESTS: ${reading.cases.length} test case(s) that passed at ${args.previous} are ` +
            `absent at ${args.current}: ${reading.cases.map(c => `${c.file} :: ${c.name}`).join("; ")}`
          : `UNMEASURED_DELETION: ${result.reason}`,
      );
      process.exit(REFUSE_EXIT);
    }
  } catch (e: any) {
    // A refusal and a crash both have to be non-zero, and both have to say
    // which they are: a reading that could not be taken is not a clean one.
    console.error(e instanceof Refused ? `REFUSED: ${e.message}` : `UNREADABLE: ${e?.message || e}`);
    process.exit(REFUSE_EXIT);
  }
}
