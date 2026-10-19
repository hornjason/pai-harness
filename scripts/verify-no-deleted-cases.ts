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
 *     --previous <sha> --current <sha> [--ledger <junit.xml>] [--out <file>]
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

const OPTIONS = new Set(["project", "previous", "current", "ledger", "out"]);

class Refused extends Error {}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Refused(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Refused(`--${m[1]} needs a value`);
    out[m[1]] = value;
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
    const reading = deletionReading(deleted, ledger);

    const result = {
      verdict: reading.verdict,
      previous: args.previous,
      current: args.current,
      cases: reading.cases.map(c => ({ name: c.name, file: c.file })),
      reason: reading.verdict === "UNMEASURED" ? reading.reason : null,
    };
    const json = JSON.stringify(result, null, 2);
    if (args.out) writeFileSync(args.out, json);
    console.log(json);

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
