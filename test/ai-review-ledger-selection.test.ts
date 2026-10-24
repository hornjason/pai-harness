/**
 * #1412 — two comments on one pull request carry the ledger marker, and the
 * reader that picks between them took the first.
 *
 * ## What was measured, not argued
 *
 * `GET /repos/hornjason/pai-harness/issues/1319/comments` on 2026-10-24:
 *
 * ```
 * 6366643009  github-actions[bot]  Bot   carries the marker
 * 6366808951  hornjason            User  carries the marker
 * 6367341924  hornjason            User  does not
 * ```
 *
 * #1386 is the same shape. The second marker-carrying comment is prose that
 * QUOTES the marker while discussing it, which is a thing any comment can do
 * — so the rationale the step used to carry, *nothing else writes that
 * marker, which is the load-bearing term*, is false about the repository
 * that wrote it. Making the marker more exotic does not help: a quotable
 * string cannot be made unquotable.
 *
 * ## The two defects, which are separate
 *
 *   1. **The rationale.** `lib/scaffold/ai-review-step.ts` told the next
 *      reader that marker uniqueness protected them, which invites the one
 *      change that breaks the selection — relaxing the login clause.
 *   2. **The reader.** `scripts/record-ai-review-unmeasured.ts` selected the
 *      ledger on the MARKER ALONE, with no author check at all, took the
 *      first match, and then PATCHed it. On #1319 the bot's comment happens
 *      to be older, so the API's oldest-first ordering handed it the right
 *      document — by luck, not by a clause. Fixing the prose leaves that
 *      reader exactly as unable to tell one ledger from two.
 *
 * This file is about (2), and the bar it holds is narrower than "the marker
 * is unique by convention": **a reader handed more than one matching comment
 * must refuse, by name, rather than picking one.** Ambiguous and absent are
 * different states and neither one is a reading.
 *
 * Covers AC-1 … AC-9 (#1412). No SC id is claimed: no block is reserved for
 * this branch in `specs/sc-reservations.json`, and a hand-written id is an
 * allocation (`.claude/rules/parallel-sessions.md`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  AI_REVIEW_LEDGER_ABSENT,
  AI_REVIEW_LEDGER_BOT_LOGIN_NAME,
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_MAX_MATCHES,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_UNREADABLE,
  type LedgerCandidate,
  type LedgerSelection,
  selectLedgerComment,
} from "../lib/ai-review-rounds.ts";
import { AI_REVIEW_LEDGER_BOT_LOGIN } from "../lib/scaffold/ai-review-step.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "lib", "ai-review-rounds.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A ledger body of the shape the generated persist step actually writes. */
function ledgerBody(rounds: unknown[]): string {
  return [
    AI_REVIEW_LEDGER_COMMENT_MARKER,
    "## AI review ledger",
    "",
    "```json",
    JSON.stringify({ rounds, truncated: 0 }),
    "```",
    "",
  ].join("\n");
}

const ROUND = { at: "t0", sha: "cafe", run: "1", attempt: "1", round: 1, findings: [] };

function bot(id: number, body: string = ledgerBody([ROUND])): LedgerCandidate {
  return { id, body, login: AI_REVIEW_LEDGER_BOT_LOGIN_NAME, type: "Bot" };
}

/**
 * The second comment on #1319, rebuilt: a HUMAN discussing the marker.
 *
 * It carries the marker inside prose rather than as a ledger, which is the
 * population this whole file is about. It is written the way the real one is
 * — the marker quoted mid-sentence — and not as a ledger body with the
 * author swapped, because the thing being tested is whether the selection
 * reads the AUTHOR, and a fixture that differs on two axes measures neither.
 */
function human(id: number): LedgerCandidate {
  return {
    id,
    body:
      `Two comments on #1319 carry \`${AI_REVIEW_LEDGER_COMMENT_MARKER}\`. One is ` +
      "the ledger. The other is this one.",
    login: "hornjason",
    type: "User",
  };
}

/* ─────────────────────────── the mutant harness ─────────────────────────── */

/**
 * A copy of `lib/ai-review-rounds.ts` with the ambiguity bound widened.
 *
 * The mutation the issue asks for, spelled as the issue asks for it: **the
 * refusal returns the first match instead.** Raising
 * `AI_REVIEW_LEDGER_MAX_MATCHES` past any list the cases build makes
 * `matches.length > MAX` false, so control falls through to `matches[0]` —
 * which is the pre-#1412 behaviour, performed, not described.
 *
 * Two properties are asserted rather than assumed, both for reasons
 * `.claude/rules/checks-must-be-able-to-fail.md` names:
 *
 *   * the anchor appears **exactly once**, so no second bound can hold the
 *     refusal up while the mutation reads as applied;
 *   * **no relative specifier survives** the rewrite, or the mutant dies on
 *     module resolution and a load failure reads as a guard that held.
 */
const MUTATION_ANCHOR = "export const AI_REVIEW_LEDGER_MAX_MATCHES = 1;";

function buildMutant(): string {
  const source = readFileSync(SOURCE, "utf-8");
  const occurrences = source.split(MUTATION_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the bound appears ${occurrences} times in ` +
        `${SOURCE}, so a mutation of it proves nothing`,
    );
  }
  const widened = source.replace(
    MUTATION_ANCHOR,
    "export const AI_REVIEW_LEDGER_MAX_MATCHES = Number.MAX_SAFE_INTEGER;",
  );
  const absolutised = widened.replace(
    /from (['"])(\.[^'"]*)\1/g,
    (_m, q: string, rel: string) => `from ${q}${resolve(join(ROOT, "lib"), rel)}${q}`,
  );
  const survivors = [...absolutised.matchAll(/from ['"](\.[^'"]*)['"]/g)].map(m => m[1]);
  if (survivors.length > 0) {
    throw new Error(`relative imports survived the rewrite: ${survivors.join(", ")}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "ledger-selection-mutant-"));
  scratch.push(dir);
  const path = join(dir, "ai-review-rounds.mutant.ts");
  writeFileSync(path, absolutised);
  return path;
}

const MUTANT = await import(buildMutant());
const mutantSelect = MUTANT.selectLedgerComment as (
  c: readonly LedgerCandidate[],
) => LedgerSelection;

/* ───────────────────────────────── cases ────────────────────────────────── */

describe("AC-1 … AC-3 (#1412): three readings, and they stay apart", () => {
  test("AC-1: no marked bot comment is ABSENT — a MEASURED reading of nothing", () => {
    const r = selectLedgerComment([
      { id: 1, body: "an ordinary review comment", login: "hornjason", type: "User" },
      { id: 2, body: "another", login: AI_REVIEW_LEDGER_BOT_LOGIN_NAME, type: "Bot" },
    ]);
    expect(r.status).toBe(AI_REVIEW_LEDGER_ABSENT);
  });

  test("AC-2: exactly one still READS, and carries the comment", () => {
    // The positive control. Without it every refusal below is satisfied by a
    // selection that refuses everything, including the ledger it wrote.
    const r = selectLedgerComment([human(99), bot(7), { id: 8, body: "hi", login: "x", type: "User" }]);
    expect(r.status, JSON.stringify(r)).toBe(AI_REVIEW_LEDGER_READ);
    if (r.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(r.comment.id).toBe(7);
    expect(r.comment.body).toContain(AI_REVIEW_LEDGER_COMMENT_MARKER);
  });

  test("AC-3: TWO marked bot comments REFUSE, and the refusal names both ids", () => {
    const r = selectLedgerComment([bot(10), human(99), bot(20)]);
    expect(r.status, "it picked one of two documents it cannot tell apart").toBe(
      AI_REVIEW_LEDGER_UNREADABLE,
    );
    if (r.status !== AI_REVIEW_LEDGER_UNREADABLE) throw new Error("unreachable");
    // A refusal that does not say WHICH documents collided cannot be acted
    // on, and this is the only field a caller can print.
    expect(r.reason).toContain("10");
    expect(r.reason).toContain("20");
    expect(r.reason).toContain("2 comments");
  });

  test("AC-3: the three readings are three different statuses", () => {
    // Stated as a comparison rather than three separate assertions, because
    // the defect this file exists for is two of them collapsing into one.
    const statuses = new Set([
      selectLedgerComment([]).status,
      selectLedgerComment([bot(1)]).status,
      selectLedgerComment([bot(1), bot(2)]).status,
    ]);
    expect(statuses.size, [...statuses].join(", ")).toBe(3);
  });
});

describe("AC-4 … AC-6 (#1412): the login clause is the load-bearing term", () => {
  test("AC-4: a `type: \"User\"` comment carrying the marker is NOT the ledger", () => {
    // The #1319 population, with the ledger removed: one human comment that
    // quotes the marker. ABSENT, not READ and not ambiguous.
    const r = selectLedgerComment([human(6366808951)]);
    expect(r.status, "a comment anyone can write was adopted as the ledger").toBe(
      AI_REVIEW_LEDGER_ABSENT,
    );
  });

  test("AC-4: the real #1319 shape — one bot ledger beside one human quote — READS", () => {
    // Two comments carry the marker and exactly one is the ledger, so this
    // is NOT the ambiguous case. The login clause is what makes that true,
    // and without it this row would refuse a pull request that is fine.
    const r = selectLedgerComment([bot(6366643009), human(6366808951)]);
    expect(r.status, JSON.stringify(r)).toBe(AI_REVIEW_LEDGER_READ);
    if (r.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(r.comment.id).toBe(6366643009);
  });

  test("AC-5: another app's bot login carrying the marker is not the ledger", () => {
    // `type: "Bot"` is a CLASS. Every installed GitHub App clears it, so the
    // type alone narrows the impostor set and does not close it.
    const r = selectLedgerComment([
      { id: 42, body: ledgerBody([ROUND]), login: "dependabot[bot]", type: "Bot" },
    ]);
    expect(r.status).toBe(AI_REVIEW_LEDGER_ABSENT);
  });

  test("AC-5 CONTROL: one axis — the same body from THIS login is adopted", () => {
    const body = ledgerBody([ROUND]);
    const foreign = selectLedgerComment([{ id: 42, body, login: "dependabot[bot]", type: "Bot" }]);
    const ours = selectLedgerComment([
      { id: 42, body, login: AI_REVIEW_LEDGER_BOT_LOGIN_NAME, type: "Bot" },
    ]);
    expect(foreign.status).toBe(AI_REVIEW_LEDGER_ABSENT);
    expect(ours.status).toBe(AI_REVIEW_LEDGER_READ);
  });

  test("AC-6: the login this reader selects on is the one the step writes as", () => {
    // Two declarations, bound here rather than by an import:
    // `lib/scaffold/ai-review-step.ts` is copied into a tmpdir by mutation
    // batteries, where a relative specifier dies on resolution.
    expect(AI_REVIEW_LEDGER_BOT_LOGIN_NAME).toBe(AI_REVIEW_LEDGER_BOT_LOGIN);
  });
});

describe("AC-7 (#1412): a marked bot comment with no usable id refuses", () => {
  test("AC-7: an unaddressable ledger is UNREADABLE, never absent", () => {
    // The caller PATCHes by id. A match whose id did not survive the API
    // read is a ledger that exists and cannot be written to, and calling it
    // absent licenses POSTing a second one on top of a live history.
    const r = selectLedgerComment([{ id: null, body: ledgerBody([ROUND]), login: AI_REVIEW_LEDGER_BOT_LOGIN_NAME, type: "Bot" }]);
    expect(r.status).toBe(AI_REVIEW_LEDGER_UNREADABLE);
  });
});

describe("AC-8 … AC-9 (#1412): the refusal is proved able to fail", () => {
  test("AC-8: the bound is 1, and the mutant widened it", async () => {
    expect(AI_REVIEW_LEDGER_MAX_MATCHES).toBe(1);
    expect(MUTANT.AI_REVIEW_LEDGER_MAX_MATCHES).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("AC-9: the MUTANT returns the first match where the real source refuses", () => {
    // The removal of the refusal, performed and observed. Both halves are
    // asserted: a case that only watched the mutant would pass over a
    // binding that refuses everything, and a case that only watched the real
    // source would pass over a mutation that never applied.
    const list = [bot(10), human(99), bot(20)];
    const real = selectLedgerComment(list);
    const mutated = mutantSelect(list);
    expect(real.status, "the real source did not refuse the ambiguity").toBe(
      AI_REVIEW_LEDGER_UNREADABLE,
    );
    expect(mutated.status, "the mutation did not apply — the mutant still refused").toBe(
      AI_REVIEW_LEDGER_READ,
    );
    if (mutated.status !== AI_REVIEW_LEDGER_READ) throw new Error("unreachable");
    expect(mutated.comment.id, "the mutant is meant to take the FIRST match").toBe(10);
  });

  test("AC-9: the mutant still agrees on the one-match and no-match readings", () => {
    // So AC-9's red is about the AMBIGUITY and not about a mutant that
    // stopped working. One axis: the number of marked bot comments.
    expect(mutantSelect([]).status).toBe(AI_REVIEW_LEDGER_ABSENT);
    expect(mutantSelect([bot(7)]).status).toBe(AI_REVIEW_LEDGER_READ);
    expect(mutantSelect([human(99)]).status).toBe(AI_REVIEW_LEDGER_ABSENT);
  });
});

/**
 * AC-10 (#1412): the recorder, run for real against a faked `gh`.
 *
 * The cases above establish what the binding decides. This one establishes
 * that the recorder ASKS it — a binding nothing calls is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` with the second decider
 * being nobody. The script is spawned, not imported, because its refusal is
 * a line on stdout and an exit code, and that is what a reader gets.
 *
 * The fake answers the one `gh api` call the no-write path makes and prints
 * the same bytes real `gh` does: one compact `@json` object per line, in the
 * key order the `-q` expression builds.
 */
describe("AC-10 (#1412): the recorder refuses an ambiguous pull request", () => {
  function runRecorder(comments: LedgerCandidate[]): { out: string; status: number } {
    const dir = mkdtempSync(join(tmpdir(), "ledger-selection-gh-"));
    scratch.push(dir);
    const fixture = join(dir, "comments.jsonl");
    writeFileSync(fixture, comments.map(c => JSON.stringify(c)).join("\n") + "\n");
    const fake = join(dir, "gh");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'if [ "$1" = "api" ]; then cat "$LEDGER_FIXTURE"; exit 0; fi',
        'echo "the recorder called gh with an unexpected command: $*" >&2',
        "exit 97",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        join(ROOT, "scripts", "record-ai-review-unmeasured.ts"),
        "--repo", "o/r", "--pr", "77",
      ],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LEDGER_FIXTURE: fixture },
    });
    return {
      out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
      status: r.exitCode,
    };
  }

  test("AC-10: two marked bot comments — SKIPPED, named, and non-zero", () => {
    const r = runRecorder([bot(10), human(99), bot(20)]);
    expect(r.out, r.out).toContain(AI_REVIEW_LEDGER_UNREADABLE);
    expect(r.out).toContain("10, 20");
    expect(r.out, "an ambiguous ledger was not counted as refused").toContain("1 refused");
    expect(r.status, "the run reported success over a ledger it could not identify").not.toBe(0);
  });

  test("AC-10 CONTROL: the #1319 shape — one bot ledger, one human quote — is read", () => {
    // Without this row the case above is green under a recorder that
    // refuses every pull request, including the ones that are fine.
    const r = runRecorder([bot(6366643009), human(6366808951)]);
    expect(r.out, r.out).toContain("#77: 1 round(s)");
    expect(r.out).not.toContain("refused");
    expect(r.status, r.out).toBe(0);
  });

  test("AC-10: a human quote ALONE is no ledger, not a ledger", () => {
    const r = runRecorder([human(99)]);
    expect(r.out, r.out).toContain("#77: no ledger comment");
    expect(r.status, r.out).toBe(0);
  });
});
