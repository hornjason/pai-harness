/**
 * Refuse a pull request whose closing keyword GitHub will never act on (#1362).
 *
 * Usage:
 *   gh pr view <N> --json number,body,closingIssuesReferences \
 *     | bun scripts/audit-closing-references.ts
 *   bun scripts/audit-closing-references.ts --fixture <file.json>   # offline
 *
 * ## Why this reads a payload instead of calling the API
 *
 * The reading it needs — `closingIssuesReferences` — is GitHub's own answer to
 * the question the check is about, and the one thing this script must not do
 * is compute its own version of it. Taking the field as input makes that a
 * structural impossibility rather than a convention: there is no code path
 * here that could decide an issue is linked.
 *
 * It also makes the whole check runnable offline against a fixture, which is
 * how `test/audit-closing-references.test.ts` exercises the refusal without a
 * network or a token.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * It refuses exactly one state: **`closingIssuesReferences` is empty AND the
 * body contains a closing keyword adjacent to an issue number inside markup
 * the markdown parser does not scan.** That is a contradiction inside one
 * pull request — the author wrote a closing reference and GitHub recorded
 * none — and it is the state that left #1157 open after PR #1208 merged.
 *
 * It does NOT refuse a pull request that merely mentions an issue without
 * closing it. Measured at 2026-10-23T15:31Z, 27 of the 50 open issues had a
 * merged pull request referencing them and 26 of those were discussion
 * mentions — `#1204's class`, `#1286 is open about this`. A check that fired
 * on a mention would be wrong 26 times out of 27 on the only corpus
 * available, and a check wrong that often is one people route around.
 *
 * ONE PROPERTY THIS FILE MUST KEEP, asserted by its test: every refusal exits
 * through REFUSE_EXIT, declared exactly once.
 */

import { readFileSync } from "fs";
import { inertClosingMessage, inertClosingReferences } from "../lib/closing-reference-audit";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

/**
 * A payload that could not be read is UNMEASURED, not a pass.
 *
 * `.claude/rules/config-access.md`'s *Silent Default Substitution*: an
 * unparseable payload and a clean pull request must not produce the same
 * exit, or the check switches itself off the first time the input shape
 * moves.
 */
function refuse(message: string): never {
  console.error(`CLOSING-REFERENCE REFUSED: ${message}`);
  process.exit(REFUSE_EXIT);
}

async function readPayload(): Promise<string> {
  const fixture = arg("fixture");
  if (fixture) return readFileSync(fixture, "utf-8");
  if (process.stdin.isTTY) {
    refuse("no payload on stdin and no --fixture. Pipe `gh pr view <N> --json number,body,closingIssuesReferences`.");
  }
  return await new Response(process.stdin as unknown as ReadableStream).text();
}

async function main(): Promise<void> {
  const raw = (await readPayload()).trim();
  if (!raw) refuse("the payload is empty, so no reading was taken. This is UNMEASURED, not a clean pull request.");

  let pr: { number?: number; body?: string; closingIssuesReferences?: unknown };
  try {
    pr = JSON.parse(raw);
  } catch (e) {
    refuse(`the payload is not JSON (${(e as Error).message}). UNMEASURED, not clean.`);
  }

  // An absent key and an empty list are different facts, and only one of them
  // is a reading — #530's shape. A payload fetched without the field would
  // otherwise look exactly like a pull request that closes nothing.
  if (!("closingIssuesReferences" in pr) || !Array.isArray(pr.closingIssuesReferences)) {
    refuse(
      "the payload carries no closingIssuesReferences array, so the field this check " +
        "compares against was never fetched. Add it to the --json list. UNMEASURED, not clean.",
    );
  }
  if (typeof pr.body !== "string") {
    refuse("the payload carries no body string. Add `body` to the --json list. UNMEASURED, not clean.");
  }

  const prNumber = typeof pr.number === "number" ? pr.number : 0;
  const linked = pr.closingIssuesReferences as unknown[];
  // The linked set is read for its ISSUE NUMBERS, not for its length.
  //
  // This used to return early whenever `linked.length > 0`, and that let the
  // defect through one issue over: a pull request that correctly links #A and
  // also carries a backticked `Fixes #B` passed clean, #B never closed, and
  // #B is then an open issue with a merged pull request — the exact symptom
  // this script exists to find. The contradiction the docblock describes is
  // not "GitHub recorded nothing", it is "the author wrote a closing
  // reference GitHub did not record", and a non-empty linked set does not
  // make that false for a DIFFERENT issue.
  //
  // An entry whose number is unreadable contributes nothing to this set,
  // which is the safe direction: it can only cause an inert reference to be
  // reported, never suppressed.
  const linkedIssues = new Set(
    linked
      .map(e => (e !== null && typeof e === "object" ? (e as { number?: unknown }).number : null))
      .filter((n): n is number => typeof n === "number"),
  );

  // An inert keyword naming an issue that IS linked is harmless — the issue
  // closes on the live reference regardless, so firing on it would be the
  // false positive the docblock refuses to ship. Only the unlinked ones are
  // the contradiction.
  const inert = inertClosingReferences(pr.body).filter(r => !linkedIssues.has(r.issue));
  if (inert.length === 0) {
    const links =
      linked.length > 0 ? `links ${linked.length} issue(s)` : "links none and claims none";
    console.log(`closing references OK: PR #${prNumber} ${links}.`);
    return;
  }
  refuse(inertClosingMessage(inert, prNumber));
}

await main();
