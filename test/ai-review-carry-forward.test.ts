/**
 * #1381 — the walker. `lib/ai-review-rounds.ts` has exported
 * `readLedger → priorFindings → carryForward → noRepeatsInstruction` since
 * #1351 and nothing called any of them: the ledger had a writer and a reader
 * and no walker, and the reviewer's prompt said so out loud until #1351
 * removed the sentence and left the behaviour. A finding re-posted on every
 * round is arithmetically an extra round, and the tail is where this gate's
 * cost is.
 *
 * ## What these cases are written against
 *
 * Not *"carry-forward works"*. A case asserting only that a finding gets
 * carried is green against a walker that carries resolved findings, against
 * one that carries on an unreadable ledger, and against one that cannot tell
 * a re-emission from a new finding. The property is **the three states stay
 * distinguishable**, and the row that makes the rest mean anything is the
 * DROP: a recorded anchor that differs from the line now must produce an
 * empty carry, because without it a walker that carries everything
 * unconditionally passes every other row in the file.
 *
 * ## Why they execute the bash
 *
 * The walker is a `run:` block. Asserting on its SOURCE would pass against a
 * script that cannot run at all, and every property here — "an unreadable
 * ledger is not an empty one", "a finding with no anchor is carried" — is a
 * behaviour. Each case spawns the real generated script under `bash -e`,
 * which is what Actions runs it with, against a planted git index and a
 * `curl` that answers from a FILE (a ledger body carries ```json fences, and
 * a fixture routed through a shell makes those command substitution).
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AI_REVIEW_ANCHOR_BY_LINE,
  AI_REVIEW_ANCHOR_BY_TEXT,
  AI_REVIEW_ANCHOR_NONE,
  AI_REVIEW_CARRY_ABSENT,
  AI_REVIEW_CARRY_BASENAME,
  AI_REVIEW_CARRY_MARK,
  AI_REVIEW_CARRY_MAX_PAGES,
  AI_REVIEW_CARRY_PATH_VAR,
  AI_REVIEW_CARRY_READ,
  AI_REVIEW_CARRY_STATE_KEY,
  AI_REVIEW_CARRY_STEP_ID,
  AI_REVIEW_CARRY_UNMEASURED,
  AI_REVIEW_EVENT_VAR,
  AI_REVIEW_FINDINGS_DIR_OUTPUT,
  AI_REVIEW_GRAPHQL_VAR,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_LEDGER_API_VAR,
  AI_REVIEW_LEDGER_BOT_LOGIN,
  AI_REVIEW_LEDGER_IDENTITY_V1,
  AI_REVIEW_LEDGER_MARKER,
  AI_REVIEW_LEDGER_PR_VAR,
  AI_REVIEW_LEDGER_REPO_VAR,
  AI_REVIEW_LEDGER_ROUNDS_FIELD,
  AI_REVIEW_LEDGER_SNAPSHOT_BASENAME,
  AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR,
  AI_REVIEW_LEDGER_TEXT_FIELD,
  AI_REVIEW_LEDGER_TOKEN_VAR,
  AI_REVIEW_PREPARE_STEP_ID,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_SNAPSHOT_ROUND_KEY,
  AI_REVIEW_SNAPSHOT_ROUND_VAR,
  AI_REVIEW_THREADS_BASENAME,
  AI_REVIEW_THREADS_PATH_VAR,
  buildCarryScript,
  buildReviewPrompt,
} from "../lib/scaffold/ai-review-step.ts";
// The READER of the file this step writes. Imported so the two sides of the
// snapshot's format are held together by a test rather than by two authors
// agreeing — the writer is bash and the reader is TypeScript, which is the
// arrangement #1568 was.
import {
  ledgerPriorKeysFrom,
  priorKeysFrom,
  readSnapshot,
} from "../lib/ai-review-suppression.ts";
import { threadBody } from "../lib/scaffold/ai-review-findings.ts";
import {
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_FINDING_TEXT,
  AI_REVIEW_LEDGER_IDENTITY,
  AI_REVIEW_LEDGER_ROUNDS_KEY,
  type CarriedFinding,
  carryForward,
  carryKey,
  priorFindings,
  readLedger,
} from "../lib/ai-review-rounds.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ai-review.yml");

function botComment(id: number, body: string) {
  return { id, user: { type: "Bot", login: AI_REVIEW_LEDGER_BOT_LOGIN }, body };
}

/** A ledger comment body in the shape the writer emits. */
function ledgerBody(payload: unknown): string {
  return [
    AI_REVIEW_LEDGER_MARKER,
    "### AI review findings ledger",
    "",
    "```json",
    JSON.stringify(payload),
    "```",
  ].join("\n");
}

function windowBody(rounds: unknown[]): string {
  return ledgerBody({ [AI_REVIEW_LEDGER_ROUNDS_FIELD]: rounds });
}

/** One recorded round, stamped with the identity rule the reader knows. */
function round(n: number, findings: unknown, identity: string = AI_REVIEW_LEDGER_IDENTITY_V1) {
  return { at: `t${n}`, sha: `sha${n}`, run: `run-${n}`, attempt: "1", identity, round: n, [AI_REVIEW_FINDINGS_KEY]: findings };
}

interface Rig {
  /** The comment list the GET answers with. `null` makes the GET FAIL. */
  list?: unknown[] | null;
  /** Per-page answers, for the pagination cases. */
  pages?: unknown[][];
  /** A raw body, for the shapes `JSON.stringify` cannot express. */
  listRaw?: string;
  /** Files planted in the checkout AND added to its index. */
  files?: Record<string, string>;
  /** Environment overrides. */
  env?: Record<string, string>;
  /** A mutant in place of the real script. */
  script?: string;
  /** Suppress writing the carry path into the environment. */
  noPath?: boolean;
  /** Suppress writing the ledger-snapshot path into the environment (#1586). */
  noSnapshotPath?: boolean;
  /**
   * AC-1. The review threads the GraphQL POST answers with, as pages. A
   * `null` makes the POST FAIL, which is the state the adjudicator must read
   * as UNMEASURED rather than as "this pull request has no threads".
   * Undefined serves one empty page, so every pre-existing row still drives
   * the fetch rather than leaving it unexercised.
   */
  threadPages?: Array<Array<{ isResolved: unknown; body: unknown }>> | null;
  /** A raw GraphQL response, for the shapes the helper cannot express. */
  threadsRaw?: string;
  /** Suppress writing the threads path into the environment. */
  noThreadsPath?: boolean;
}

/** One page of the GraphQL answer, in the shape the query asks for. */
function graphqlPage(
  nodes: Array<{ isResolved: unknown; body: unknown }>,
  endCursor: string | null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes: nodes.map(n => ({
              isResolved: n.isResolved,
              comments: { nodes: [{ body: n.body }] },
            })),
          },
        },
      },
    },
  });
}

interface Carried {
  round: number | string;
  file: string;
  line: string;
  severity: string;
  summary: string;
}

function runCarry(rig: Rig = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-carry-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const argvPath = join(dir, "curl-argv.txt");

    const list = rig.list === undefined ? [] : rig.list;
    const listPath = join(dir, "list.json");
    if (list !== null) writeFileSync(listPath, JSON.stringify(list));
    if (rig.listRaw !== undefined) writeFileSync(listPath, rig.listRaw);
    if (rig.pages !== undefined) {
      rig.pages.forEach((p, i) => writeFileSync(join(dir, `page-${i + 1}.json`), JSON.stringify(p)));
    }

    // The GraphQL answers, one file per page, selected by the CURSOR the
    // step sends — so a step that forgot to page, or paged with the wrong
    // cursor, serves page 1 twice and the count comes back wrong.
    const threadPages = rig.threadPages === undefined ? [[]] : rig.threadPages;
    if (threadPages !== null) {
      threadPages.forEach((nodes, i) => {
        const last = i === threadPages.length - 1;
        writeFileSync(
          join(dir, `gql-${i === 0 ? "first" : `c${i}`}.json`),
          rig.threadsRaw !== undefined && last
            ? rig.threadsRaw
            : graphqlPage(nodes, last ? null : `c${i + 1}`),
        );
      });
    }

    const curl = [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" >> ${JSON.stringify(argvPath)}`,
      // The GraphQL POST, told apart by its URL the way the real endpoint is.
      'is_gql=no',
      'for a in "$@"; do case "$a" in *graphql*) is_gql=yes;; esac; done',
      'if [ "$is_gql" = yes ]; then',
      ...(threadPages === null
        ? ["  exit 22"]
        : [
            "  cur=first",
            `  body=""`,
            `  prev=""`,
            `  for a in "$@"; do if [ "$prev" = "-d" ]; then body="$a"; fi; prev="$a"; done`,
            // Whitespace stripped first. `jq -n` pretty-prints unless told
            // not to, so a pattern written against the compact spelling
            // would serve page one forever the day somebody drops `-c` —
            // a red that says "pagination is broken" about a request that
            // is still perfectly valid.
            `  body=\$(printf '%s' "$body" | tr -d ' \\n\\t')`,
            `  case "$body" in *'"cursor":"c'*) cur="\${body##*'"cursor":"'}"; cur="\${cur%%\\"*}";; esac`,
            `  f=${JSON.stringify(dir)}/gql-\${cur}.json`,
            '  if [ -f "$f" ]; then cat "$f"; else printf "{}"; fi',
            "  exit 0",
          ]),
      "fi",
      ...(rig.pages === undefined
        ? []
        : [
            "pg=1",
            'for a in "$@"; do case "$a" in *page=*) pg="${a##*page=}"; pg="${pg%%&*}";; esac; done',
            `f=${JSON.stringify(dir)}/page-\${pg}.json`,
            'if [ -f "$f" ]; then cat "$f"; else printf "[]"; fi',
            "exit 0",
          ]),
      list === null && rig.listRaw === undefined ? "exit 22" : `cat ${JSON.stringify(listPath)}`,
    ].join("\n");
    writeFileSync(join(bin, "curl"), `${curl}\n`, { mode: 0o755 });

    // The "checkout". `cwd` is pinned to it for every case, because the
    // walker resolves a finding's `file` relatively and an unpinned cwd
    // would have it reading this repository's own sources.
    const work = join(dir, "work");
    mkdirSync(work);
    for (const [rel, contents] of Object.entries(rig.files ?? {})) {
      const abs = join(work, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: work,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        encoding: "utf8",
      });
    git("init", "-q", "-b", "main", ".");
    git("add", "-A");

    const carryPath = join(dir, AI_REVIEW_CARRY_BASENAME);
    const snapshotPath = join(dir, AI_REVIEW_LEDGER_SNAPSHOT_BASENAME);
    const threadsPath = join(dir, AI_REVIEW_THREADS_BASENAME);
    const script = join(dir, "carry.sh");
    writeFileSync(script, rig.script ?? buildCarryScript());

    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_WORKSPACE: work,
      [AI_REVIEW_LEDGER_PR_VAR]: "77",
      [AI_REVIEW_LEDGER_REPO_VAR]: "o/r",
      [AI_REVIEW_LEDGER_API_VAR]: "https://api.github.test",
      [AI_REVIEW_LEDGER_TOKEN_VAR]: "t",
      [AI_REVIEW_EVENT_VAR]: "pull_request",
      ...rig.env,
    };
    if (rig.noPath !== true) env[AI_REVIEW_CARRY_PATH_VAR] = carryPath;
    if (rig.noSnapshotPath !== true) env[AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR] = snapshotPath;
    if (rig.noThreadsPath !== true) env[AI_REVIEW_THREADS_PATH_VAR] = threadsPath;
    if (env[AI_REVIEW_GRAPHQL_VAR] === undefined) {
      env[AI_REVIEW_GRAPHQL_VAR] = "https://api.github.test/graphql";
    }
    // The round the snapshot PRECEDES, which the deployed step takes from
    // `steps.ai-review-rounds.outputs.round`. Defaulted here rather than
    // left unset, because unset is its own case (`AC-C7`) and a rig that
    // only ever ran the unset path would have every other row measuring a
    // snapshot no reader accepts.
    if (env[AI_REVIEW_SNAPSHOT_ROUND_VAR] === undefined) {
      env[AI_REVIEW_SNAPSHOT_ROUND_VAR] = "4";
    }

    const r = spawnSync("bash", ["-e", script], {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });

    const file = existsSync(carryPath) ? readFileSync(carryPath, "utf8") : null;
    const state =
      file === null
        ? null
        : (file.split("\n")[0]?.replace(`${AI_REVIEW_CARRY_STATE_KEY}=`, "") ?? null);
    // One row per carried finding, parsed back out of the rendering the
    // reviewer actually reads — not out of an intermediate the test alone
    // can see.
    const carried: Carried[] = (file ?? "")
      .split("\n")
      .map(l => /^ {2}- \[round (.+?)\] (.*?):(.*?) \[(.*?)\] — (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ round: m[1]!, file: m[2]!, line: m[3]!, severity: m[4]!, summary: m[5]! }));
    const argv = existsSync(argvPath)
      ? readFileSync(argvPath, "utf8").split("\n").filter(Boolean)
      : [];
    // `null` for "the step wrote no snapshot" — distinct from `""`, which is
    // a snapshot of an empty body and is a different fact (#1586).
    const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : null;
    // `null` for "the step wrote no thread list", which is the only thing
    // that makes a failed fetch distinguishable from a pull request with no
    // threads — an empty FILE would be the second statement (AC-4).
    const threads = existsSync(threadsPath) ? readFileSync(threadsPath, "utf8") : null;
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", file, state, carried, argv, snapshot, threads };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A finding as the writer records it, with the anchor it was raised against. */
function recorded(file: string, line: number, summary: string, text?: string) {
  return {
    severity: "high",
    file,
    line,
    summary,
    ...(text === undefined ? {} : { [AI_REVIEW_LEDGER_TEXT_FIELD]: text }),
  };
}

// ── AC-C4 (#1601): an anchor survives an edit elsewhere in the file ──────

/**
 * The live defect, as a fixture.
 *
 * On PR #1597 a `high` raised at `lib/issue-filing-gate.ts:1827` on round 5
 * was absent from rounds 6 and 7, and nothing had been fixed — the agent
 * working the PR said so in its own report. Unrelated edits had shifted the
 * file, so line 1827 now held a comment, the recorded text did not match it,
 * and the finding was classified RESOLVED. The required check reported
 * `CLEAN` over a live blocker, twice.
 *
 * The three branches of the carry rule's `select` were always built to fail
 * TOWARD carrying — a null anchor carries, an unreadable anchor carries —
 * and a successfully read WRONG line was indistinguishable from a genuinely
 * fixed one. That is the single failure-open branch, and it is the one
 * ordinary editing produces on every push.
 *
 * Rows 1 and 3 below are not padding. They are what tells "the rule is
 * broken" from "my harness is broken": a battery in which every row reports
 * `dropped` cannot distinguish a real finding from a probe that never
 * worked, and row 2 is the only row whose value changed in #1601.
 */
describe("AC-C4 (#1601): a finding is anchored by its TEXT, not by a line number", () => {
  const ANCHOR = "  const priorRows = (options.readLedger ?? (() => readLedgerRows()))();";
  const SHIFTED = `// a comment nobody asked for\n// and another\n${ANCHOR}\n`;

  const ledger = (text: string | undefined = ANCHOR) => [
    botComment(5, windowBody([round(5, [recorded("lib/a.ts", 1, "TOCTOU on the cap", text)])])),
  ];

  test("AC-C4: row 1 — an unchanged anchor carries (control)", () => {
    const r = runCarry({ list: ledger(), files: { "lib/a.ts": `${ANCHOR}\n` } });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried).toHaveLength(1);
  });

  test("AC-C4: row 2 — the anchor SHIFTED by an edit above it still carries", () => {
    // The red this change exists to turn green. The finding is recorded at
    // line 1; two lines are inserted above it, so line 1 now holds an
    // unrelated comment and the text sits at line 3. Nothing was fixed.
    const r = runCarry({ list: ledger(), files: { "lib/a.ts": SHIFTED } });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(
      r.carried,
      "the finding was dropped by an edit above it — #1601, and the check goes CLEAN over it",
    ).toHaveLength(1);
    expect(r.carried[0]!.summary).toBe("TOCTOU on the cap");
  });

  test("AC-C4: row 3 — an unreadable anchor carries (control)", () => {
    // No such file in the checkout, so the path does not resolve at all.
    const r = runCarry({ list: ledger(), files: { "lib/other.ts": "x\n" } });
    expect(r.carried).toHaveLength(1);
  });

  test("AC-C4: the premise — row 2's fixture really does move the cited line", () => {
    // #500's shape: without this, row 2 is satisfied by a fixture in which
    // nothing shifted and the case stops being about anything.
    const lines = SHIFTED.split("\n");
    expect(lines[0], "line 1 still holds the anchor, so nothing shifted").not.toBe(ANCHOR);
    expect(lines.indexOf(ANCHOR), "the anchor is not in the shifted file at all").toBe(2);
  });

  test("AC-C4: text that is GONE is still resolved — the drop did not stop deciding", () => {
    // The direction this must not be wrong in. Content-addressing must not
    // become "carry everything": a count of zero is the one route to
    // resolved and it has to stay reachable, or every finding is immortal.
    const r = runCarry({ list: ledger(), files: { "lib/a.ts": "something else entirely\n" } });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried).toHaveLength(0);
  });

  test("AC-C4: an AMBIGUOUS anchor carries rather than resolving", () => {
    // Two identical lines. This reader cannot say which one the finding
    // meant, and "nobody can establish whether it is fixed" is not the same
    // fact as "it is fixed". Acceptance item 2: there must be exactly one
    // route to `resolved`, and it must not be reachable by accident.
    const r = runCarry({ list: ledger(), files: { "lib/a.ts": `${ANCHOR}\n${ANCHOR}\n` } });
    expect(r.carried).toHaveLength(1);
  });

  test("AC-C4: a genuinely BLANK anchor keeps the line path, both ways", () => {
    // #1406's distinction, which content-addressing would destroy: a
    // recorded `""` is a real reading of a real blank line, and counting
    // lines equal to `""` matches every blank line in the file — so the
    // finding could never be resolved. It stays on the line comparison.
    const stillBlank = runCarry({
      list: ledger(""),
      files: { "lib/a.ts": "\nconst a = 1;\n" },
    });
    expect(stillBlank.carried, "a still-blank cited line is unresolved").toHaveLength(1);

    const filledIn = runCarry({
      list: ledger(""),
      files: { "lib/a.ts": "const a = 1;\n" },
    });
    expect(filledIn.carried, "a blank line that now has code is resolved").toHaveLength(0);
  });

  test("AC-C4: the MUTANT — the line-number lookup restored — reddens row 2 and only row 2", () => {
    // The mutation acceptance item 3 names, performed and observed. The
    // `text` arm is routed back to the line comparison, which IS the
    // pre-#1601 rule: every row keeps its old answer except the shifted one.
    // Mutating the `select` alone is NOT the old rule and the first draft of
    // this case proved it: the LOOP decides which question is asked, so a
    // `text` row arrives carrying `matches` and no `now`, and a select
    // rewritten to compare `now` carries everything through its absent-key
    // clause. That mutant failed the unchanged-row assertion below rather
    // than passing quietly, which is what that assertion is for.
    //
    // The faithful mutation is one site earlier: make the flatten classify
    // every string anchor as a line anchor, which routes every finding back
    // down the line-number path. That IS pre-#1601.
    const real = buildCarryScript();
    const mutant = real.replace(
      `then (if ((.${AI_REVIEW_LEDGER_TEXT_FIELD} | norm) == "") then "${AI_REVIEW_ANCHOR_BY_LINE}" else "${AI_REVIEW_ANCHOR_BY_TEXT}" end)`,
      `then "${AI_REVIEW_ANCHOR_BY_LINE}"`,
    );
    expect(mutant, "the anchor classifier was not found, so nothing was mutated").not.toBe(real);

    // The input on which mutant and original differ, named and run rather
    // than assumed — and the mutant must still CARRY the unchanged row, or
    // it is a broken mutant rather than the pre-#1601 rule.
    const shifted = runCarry({ list: ledger(), files: { "lib/a.ts": SHIFTED }, script: mutant });
    expect(shifted.status, `the mutant failed for an unrelated reason: ${shifted.stderr}`).toBe(0);
    expect(shifted.carried, "the mutant carried the shifted finding, so it is not the old rule")
      .toHaveLength(0);

    const unchanged = runCarry({
      list: ledger(),
      files: { "lib/a.ts": `${ANCHOR}\n` },
      script: mutant,
    });
    expect(unchanged.carried, "the mutant dropped everything, so row 2 measures nothing")
      .toHaveLength(1);
  });

  test("AC-C4: the carry step and the suppression gate choose the same key namespace", () => {
    // Team-lead's consistency requirement, asserted over an INPUT the two
    // must classify identically rather than over shared code. `anchor`
    // decides `t:` against `n:` in the generated jq; `carryKey` decides the
    // same thing in TypeScript from `recordedText`. A divergence does not
    // fail loudly — it makes the carry and the dedupe talk about different
    // findings, which is #1601's own shape one layer over.
    const script = buildCarryScript();
    expect(script).toContain(`if .anchor == "${AI_REVIEW_ANCHOR_BY_TEXT}" then "t:"`);
    expect(script).toContain(`"${AI_REVIEW_ANCHOR_BY_LINE}"`);

    // The input: a non-empty anchor keys on text, an empty one on the line
    // number. Driven through the real `carryKey`, not described.
    const withText = carryKey({ file: "lib/a.ts", line: 7, summary: "s" }, ANCHOR);
    const withBlank = carryKey({ file: "lib/a.ts", line: 7, summary: "s" }, "");
    expect(withText, "a non-empty anchor must key on the TEXT").toContain("t:");
    expect(withBlank, "an empty anchor must fall back to the LINE").toContain("n:");
    expect(withText).not.toBe(withBlank);

    // And the generated flatten must classify those same two inputs the same
    // way, which is what makes this a comparison and not two statements.
    expect(script).toContain(`then "${AI_REVIEW_ANCHOR_BY_LINE}" else "${AI_REVIEW_ANCHOR_BY_TEXT}" end`);
  });
});

// ── AC-C0: the rig delivers its own fixture unmangled ────────────────────

describe("AC-C0 (#1381): the rig's premise, asserted rather than assumed", () => {
  /**
   * Every row below rests on the stub handing the script a body whose
   * ```json fences survived. Interpolated into generated shell source those
   * backticks are command substitution, the fence is eaten, and a correct
   * walker reads as one that cannot parse its own ledger — which would make
   * every UNMEASURED row below green for the wrong reason.
   */
  test("AC-C0: a planted ledger reaches the script with its fence intact", () => {
    const r = runCarry({
      list: [botComment(5, windowBody([round(1, [recorded("lib/a.ts", 1, "s", "alpha")])]))],
      files: { "lib/a.ts": "alpha\n" },
    });
    expect(r.stderr, "the stub shelled out while answering with the fixture").toBe("");
    expect(r.state, "the fence did not survive the stub").toBe(AI_REVIEW_CARRY_READ);
  });
});

// ── AC-C1: the three states, and they may not collapse ───────────────────

describe("AC-C1 (#1381): READ, ABSENT and UNMEASURED are three facts", () => {
  test("AC-C1: a pull request with no ledger is ABSENT, and the file says so", () => {
    const r = runCarry({ list: [] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.state).toBe(AI_REVIEW_CARRY_ABSENT);
  });

  test("AC-C1: a ledger that was read and holds nothing outstanding is READ, not ABSENT", () => {
    // The distinction that costs findings when it is lost: this one says the
    // earlier rounds were read and the code has answered everything. ABSENT
    // says there was nothing to look in. A walker collapsing them tells the
    // reviewer nothing about which happened.
    const r = runCarry({ list: [botComment(5, windowBody([round(1, [])]))] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried).toHaveLength(0);
  });

  test("AC-C1: a GET that fails is UNMEASURED and says why — never an empty carry", () => {
    const r = runCarry({ list: null });
    expect(r.status, r.stderr).toBe(0);
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(r.file).toContain("reason:");
    expect(r.stdout, "an unreadable history was not announced on the run").toContain("::warning");
  });

  test("AC-C1: a response that is not an array is UNMEASURED, not a list with no ledger", () => {
    const r = runCarry({ listRaw: '{"message":"Not Found"}' });
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });

  test("AC-C1: a marked comment whose fence is unterminated is UNMEASURED", () => {
    // `readLedger`'s rule: a body that HAS the marker and whose JSON block is
    // missing, truncated or unparseable is UNREADABLE and never an empty
    // ledger. Treating a damaged ledger as empty discards every round it
    // holds at the moment nothing can tell that it happened.
    const body = [AI_REVIEW_LEDGER_MARKER, "", "```json", '[{"round":1}]'].join("\n");
    const r = runCarry({ list: [botComment(5, body)] });
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });

  test("AC-C1: a marked comment whose JSON does not parse is UNMEASURED", () => {
    const body = [AI_REVIEW_LEDGER_MARKER, "", "```json", "{not json", "```"].join("\n");
    const r = runCarry({ list: [botComment(5, body)] });
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });

  test("AC-C1: exhausting the page bound is UNMEASURED, never ABSENT", () => {
    // The bound exists to stop an unbounded loop, not to license a
    // conclusion. A full last page means the ledger may be past it.
    const full = Array.from({ length: 100 }, (_, i) => botComment(i, "ordinary"));
    const r = runCarry({ pages: Array.from({ length: AI_REVIEW_CARRY_MAX_PAGES }, () => full) });
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(r.file).toContain(String(AI_REVIEW_CARRY_MAX_PAGES));
  });

  test("AC-C1: a short page ends the walk, and THAT is what licenses ABSENT", () => {
    const full = Array.from({ length: 100 }, (_, i) => botComment(i, "ordinary"));
    const r = runCarry({ pages: [full, [botComment(999, "ordinary")]] });
    expect(r.state).toBe(AI_REVIEW_CARRY_ABSENT);
    expect(r.argv.join(" "), "the second page was never requested").toContain("page=2");
  });

  test("AC-C1: a merge_group entry has no pull request, and that is ABSENT and not a failure", () => {
    const r = runCarry({ env: { [AI_REVIEW_EVENT_VAR]: "merge_group", [AI_REVIEW_LEDGER_PR_VAR]: "" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.state).toBe(AI_REVIEW_CARRY_ABSENT);
    expect(r.argv, "a merge_group entry listed a pull request's comments").toEqual([]);
  });

  test("AC-C1: a pull_request run with no number is UNMEASURED, not ABSENT", () => {
    // The same empty variable as the row above, under a different event, is
    // a different fact. A walker reading "no PR number" as "no history"
    // would report a complete reading it never took.
    const r = runCarry({ env: { [AI_REVIEW_LEDGER_PR_VAR]: "" } });
    expect(r.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });
});

// ── AC-C2: the carry rule, and the DROP that makes it mean something ─────

describe("AC-C2 (#1381): resolved is dropped, unresolved is carried", () => {
  const FINDING = recorded("lib/a.ts", 1, "the guard is inverted", "if (!ok) return;");

  test("AC-C2: an unchanged cited line carries the finding", () => {
    const r = runCarry({
      list: [botComment(5, windowBody([round(2, [FINDING])]))],
      files: { "lib/a.ts": "if (!ok) return;\n" },
    });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried).toHaveLength(1);
    expect(r.carried[0]).toMatchObject({
      round: "2",
      file: "lib/a.ts",
      line: "1",
      summary: "the guard is inverted",
    });
  });

  /**
   * THE CONTROL. Without this row every other row in this file is green
   * against a walker that carries everything unconditionally — and that
   * walker re-posts a fixed finding on every round, which is the defect
   * CRC-N4 is about, arriving through the fix for it.
   */
  test("AC-C2: a cited line whose text has CHANGED drops the finding", () => {
    const r = runCarry({
      list: [botComment(5, windowBody([round(2, [FINDING])]))],
      files: { "lib/a.ts": "if (ok) return;\n" },
    });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(
      r.carried,
      "a finding whose line was changed was carried, so the walker carries everything " +
        "and re-posts fixed findings for ever",
    ).toHaveLength(0);
  });

  test("AC-C2: case and whitespace are incidental, a changed word is not", () => {
    // `normalise` in lib/ai-review-rounds.ts: case and whitespace only. Not
    // punctuation and not stemming — two findings that differ in a word are
    // two findings, and a key that erases the difference suppresses a real
    // one.
    const same = runCarry({
      list: [botComment(5, windowBody([round(2, [FINDING])]))],
      files: { "lib/a.ts": "  IF (!ok)   return;  \n" },
    });
    expect(same.carried, "a reindent resolved a live finding").toHaveLength(1);
    const differs = runCarry({
      list: [botComment(5, windowBody([round(2, [FINDING])]))],
      files: { "lib/a.ts": "if (!okay) return;\n" },
    });
    expect(differs.carried, "a changed identifier did not resolve the finding").toHaveLength(0);
  });

  test("AC-C2: a finding with NO recorded anchor is UNDECIDABLE and is carried", () => {
    // The asymmetry this subsystem is built on. A stale carried finding is
    // visible and somebody argues with it; a silently cleared one is
    // invisible and nobody ever learns it existed. This is the ledger #1319
    // wrote before the text anchor existed, still live on open pull
    // requests.
    const r = runCarry({
      list: [botComment(5, windowBody([round(1, [recorded("lib/a.ts", 1, "no anchor")])]))],
      files: { "lib/a.ts": "something else entirely\n" },
    });
    expect(r.carried, "a finding whose anchor was never recorded was dropped as resolved")
      .toHaveLength(1);
  });

  test("AC-C2: a cited line that cannot be read NOW is carried, not resolved", () => {
    // The file is gone from this commit. That is not evidence the finding was
    // answered, and `carryForward` carries it for the same reason.
    const r = runCarry({
      list: [botComment(5, windowBody([round(1, [FINDING])]))],
      files: {},
    });
    expect(r.carried).toHaveLength(1);
  });

  test("AC-C2: a line that is genuinely BLANK compares like any other line", () => {
    // #1406's distinction, now load-bearing on the read side: the writer
    // emits no `text` key for an anchor it could not read and `""` only for
    // a line it read and found blank. So an empty recorded anchor against a
    // blank line now is a MATCH and carries, and against a line that gained
    // content is a DIFFERENCE and drops.
    const blank = runCarry({
      list: [botComment(5, windowBody([round(1, [recorded("lib/a.ts", 2, "s", "")])]))],
      files: { "lib/a.ts": "x\n\ny\n" },
    });
    expect(blank.carried, "a blank line that is still blank resolved a finding").toHaveLength(1);
    const filled = runCarry({
      list: [botComment(5, windowBody([round(1, [recorded("lib/a.ts", 2, "s", "")])]))],
      files: { "lib/a.ts": "x\nnow has code\ny\n" },
    });
    expect(filled.carried, "a blank line that gained code did not resolve the finding")
      .toHaveLength(0);
  });

  test("AC-C2: one finding across three rounds is listed once, at the EARLIEST round", () => {
    const r = runCarry({
      list: [
        botComment(5, windowBody([round(1, [FINDING]), round(2, [FINDING]), round(3, [FINDING])])),
      ],
      files: { "lib/a.ts": "if (!ok) return;\n" },
    });
    expect(r.carried, "the same finding was listed once per round it was raised on")
      .toHaveLength(1);
    expect(r.carried[0]!.round, "a finding surviving three rounds reported the latest one")
      .toBe("1");
  });

  test("AC-C2: a round stamped with an identity this reader does not know is carried, never keyed", () => {
    // `priorFindings`: only a round stamped with the rule this reader knows
    // gets a key. Keying under the wrong rule does not fail — it silently
    // compares two different things — so an unrecognised rule carries and
    // declines to dedupe.
    const r = runCarry({
      list: [
        botComment(
          5,
          windowBody([round(1, [FINDING], "file+line+summary@v9"), round(2, [FINDING])]),
        ),
      ],
      files: { "lib/a.ts": "if (!ok) return;\n" },
    });
    expect(r.carried, "an unkeyable round was deduped against a keyable one").toHaveLength(2);
  });

  test("AC-C2: a round recorded as UNMEASURED is counted and announced, not skipped", () => {
    // A round whose findings nobody read is not a round that found nothing,
    // and the reviewer is the one who has to know the list is a lower bound.
    const r = runCarry({
      list: [botComment(5, windowBody([round(1, null), round(2, [FINDING])]))],
      files: { "lib/a.ts": "if (!ok) return;\n" },
    });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.file).toContain("unmeasured_rounds=1");
    expect(r.stdout).toContain("LOWER BOUND");
  });

  test("AC-C2: a pre-#1405 bare-array ledger is read, not refused", () => {
    // Still live on every open pull request that has a ledger. Refusing it
    // would discard the history of every pull request mid-flight at the
    // moment this step merged.
    const r = runCarry({
      list: [botComment(5, ledgerBody([round(1, [FINDING])]))],
      files: { "lib/a.ts": "if (!ok) return;\n" },
    });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried).toHaveLength(1);
  });
});

// ── AC-C3: the mutants, so the rows above are not vacuous ────────────────

describe("AC-C3 (#1381): the walker's refusals, performed and observed", () => {
  /**
   * `.claude/rules/checks-must-be-able-to-fail.md`: a check that cannot fail
   * looks exactly like a check that is satisfied. Each row here performs the
   * regression the row above it refuses and watches the verdict change, so
   * real-and-mutant is one measured pair over one input.
   */
  test("AC-C3: the MUTANT — UNMEASURED spelled as ABSENT — makes the unreadable case read as clean", () => {
    const real = buildCarryScript();
    const mutant = real.replace(
      `carry_state '${AI_REVIEW_CARRY_UNMEASURED}'`,
      `carry_state '${AI_REVIEW_CARRY_ABSENT}'`,
    );
    expect(mutant, "the UNMEASURED writer was not found, so nothing was mutated").not.toBe(real);
    expect(runCarry({ list: null, script: mutant }).state).toBe(AI_REVIEW_CARRY_ABSENT);
    expect(runCarry({ list: null }).state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });

  test("AC-C3: the MUTANT — the text comparison removed — carries a resolved finding", () => {
    // #1601 moved what this mutates and not what it means. The drop used to
    // be keyed on the text at the recorded LINE; it is now keyed on how many
    // lines of the file equal the recorded text. Either way this case exists
    // to show the DROP decides an input — widen it and a resolved finding is
    // carried for ever.
    const real = buildCarryScript();
    const mutant = real.replace("(.matches >= 1)", "true");
    expect(mutant, "the comparison was not found, so nothing was mutated").not.toBe(real);
    const r = runCarry({
      list: [
        botComment(
          5,
          windowBody([round(2, [recorded("lib/a.ts", 1, "s", "if (!ok) return;")])]),
        ),
      ],
      files: { "lib/a.ts": "if (ok) return;\n" },
      script: mutant,
    });
    expect(
      r.carried,
      "widening the carry to everything changed nothing, so the comparison decides no input",
    ).toHaveLength(1);
  });

  test("AC-C3: the MUTANT — the UNDECIDABLE arm removed — drops a finding with no anchor", () => {
    const real = buildCarryScript();
    // #1601 made the rule an exclusive `if/elif/else`, so the undecidable
    // arm is the `else`. It had to become exclusive for this case to mean
    // anything: as a leading disjunct the arm was unreachable, because a
    // row with no anchor is asked nothing and the content arm's own
    // absent-key clause carried it. This mutation was 0 red against that
    // draft and is 1 red against this one.
    const mutant = real.replace("else true\n", "else false\n");
    expect(mutant, "the undecidable arm was not found, so nothing was mutated").not.toBe(real);
    const r = runCarry({
      list: [botComment(5, windowBody([round(1, [recorded("lib/a.ts", 1, "no anchor")])]))],
      files: { "lib/a.ts": "something else entirely\n" },
      script: mutant,
    });
    expect(
      r.carried,
      "removing the undecidable arm changed nothing, so it decides no input",
    ).toHaveLength(0);
  });

  test("AC-C3: the MUTANT — the page bound treated as the end of the list — reports ABSENT", () => {
    const real = buildCarryScript();
    const mutant = real.replace(
      `if [ "\${carry_read_complete}" != yes ]; then`,
      "if false; then",
    );
    expect(mutant, "the bound refusal was not found, so nothing was mutated").not.toBe(real);
    const full = Array.from({ length: 100 }, (_, i) => botComment(i, "ordinary"));
    const pages = Array.from({ length: AI_REVIEW_CARRY_MAX_PAGES }, () => full);
    expect(runCarry({ pages, script: mutant }).state).toBe(AI_REVIEW_CARRY_ABSENT);
    expect(runCarry({ pages }).state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });

  test("AC-C3: the MUTANT — the authorship conjunction dropped — adopts an impostor's comment", () => {
    // The walker reads the selected comment's contents into the next
    // reviewer's prompt, so the marker alone would let any commenter put
    // text in front of the reviewer.
    const real = buildCarryScript();
    const mutant = real.replace('(.user.type? // "") == "Bot" and ', "");
    expect(mutant, "the authorship clause was not found, so nothing was mutated").not.toBe(real);
    const impostor = {
      id: 9,
      user: { type: "User", login: AI_REVIEW_LEDGER_BOT_LOGIN },
      body: windowBody([round(1, [recorded("lib/a.ts", 1, "PLANTED", "alpha")])]),
    };
    expect(
      runCarry({ list: [impostor], files: { "lib/a.ts": "alpha\n" }, script: mutant }).carried,
      "dropping the Bot clause changed nothing, so it decides no input",
    ).toHaveLength(1);
    expect(
      runCarry({ list: [impostor], files: { "lib/a.ts": "alpha\n" } }).state,
      "a human-authored comment carrying the marker was adopted as the ledger",
    ).toBe(AI_REVIEW_CARRY_ABSENT);
  });
});

// ── AC-C4: the agreement with the library, which cannot be an import ─────

describe("AC-C4 (#1381): the restated literals agree with lib/ai-review-rounds.ts", () => {
  /**
   * `lib/scaffold/ai-review-step.ts` may not import `lib/ai-review-rounds.ts`
   * — 27 suites copy that module alone into a scratch directory to build
   * mutants, and a relative specifier resolves to nothing there, so the
   * mutant dies on module resolution and every row of every battery reddens
   * for a reason that is not the guard. The literals are therefore restated
   * and bound here, the pattern `AI_REVIEW_LEDGER_IDENTITY_V1` already uses.
   */
  test("AC-C4: the step does not import the library", () => {
    const src = readFileSync(join(ROOT, "lib", "scaffold", "ai-review-step.ts"), "utf8");
    expect(
      /from\s+["'][^"']*ai-review-rounds/.test(src),
      "the step imports the library, so every agreement below is vacuous and 27 mutation " +
        "batteries no longer load their mutant",
    ).toBe(false);
  });

  test("AC-C4: marker, identity, rounds key and text field are the same strings", () => {
    expect(AI_REVIEW_LEDGER_MARKER).toBe(AI_REVIEW_LEDGER_COMMENT_MARKER);
    expect(AI_REVIEW_LEDGER_IDENTITY_V1).toBe(AI_REVIEW_LEDGER_IDENTITY);
    expect(AI_REVIEW_LEDGER_ROUNDS_FIELD).toBe(AI_REVIEW_LEDGER_ROUNDS_KEY);
    expect(AI_REVIEW_LEDGER_TEXT_FIELD).toBe(AI_REVIEW_LEDGER_FINDING_TEXT);
  });

  /**
   * One input through both implementations. The bash is a restatement, and a
   * restatement nobody runs beside the original is a second decider waiting
   * to drift.
   */
  test("AC-C4: the bash and the library carry the same set over one matrix", () => {
    const unchanged = recorded("lib/a.ts", 1, "unchanged", "alpha");
    const changed = recorded("lib/b.ts", 1, "changed", "was beta");
    const noAnchor = recorded("lib/c.ts", 1, "no anchor");
    const files = { "lib/a.ts": "alpha\n", "lib/b.ts": "beta\n", "lib/c.ts": "gamma\n" };
    const body = windowBody([round(1, [unchanged, changed, noAnchor])]);

    const r = runCarry({ list: [botComment(5, body)], files });
    const fromBash = r.carried.map(c => c.summary).sort();

    const reading = readLedger(body);
    const prior = priorFindings(reading);
    expect(prior.status).toBe("AI_REVIEW_PRIOR_MEASURED");
    const now: Record<string, string> = { "lib/a.ts": "alpha", "lib/b.ts": "beta", "lib/c.ts": "gamma" };
    const fromLib = carryForward(
      (prior as unknown as { prior: CarriedFinding[] }).prior,
      f => now[String((f as { file?: unknown }).file)],
    )
      .map(f => String((f as { summary?: unknown }).summary))
      .sort();

    expect(fromBash).toEqual(fromLib);
    expect(fromBash, "the matrix exercised no DROP, so the agreement is vacuous").toEqual([
      "no anchor",
      "unchanged",
    ]);
  });
});

// ── AC-C5: the prompt, and the step that makes its sentence true ─────────

describe("AC-C5 (#1381): the reviewer is told the truth about the carry", () => {
  const prompt = buildReviewPrompt();
  const flat = prompt.replace(/\s+/g, " ");

  test("AC-C5: the prompt names the variable, never a value", () => {
    // AC-6b. The value arrives through `env:`; an expression interpolated
    // into the prompt would be substituted before the action ever saw it.
    expect(flat).toContain(AI_REVIEW_CARRY_PATH_VAR);
    expect(prompt, "an expression reached the prompt text").not.toContain("${{");
  });

  test("AC-C5: the prompt states all three readings by name", () => {
    for (const state of [AI_REVIEW_CARRY_READ, AI_REVIEW_CARRY_ABSENT, AI_REVIEW_CARRY_UNMEASURED]) {
      expect(flat, `the prompt does not name ${state}, so the reviewer cannot tell it apart`)
        .toContain(state);
    }
  });

  test("AC-C5: the prompt says UNMEASURED is not a clean pull request", () => {
    expect(flat).toContain("This is not a pull request with nothing outstanding");
  });

  test("AC-C5: a re-emission is distinguishable in the PAYLOAD, not only in the prose", () => {
    expect(flat, "the prompt does not tell the reviewer how to mark a re-emitted finding")
      .toContain(AI_REVIEW_CARRY_MARK);
  });

  test("AC-C5: the committed workflow carries the step, before the reviewer", () => {
    const yml = readFileSync(WORKFLOW, "utf8");
    const carry = yml.indexOf(`id: ${AI_REVIEW_CARRY_STEP_ID}`);
    const review = yml.indexOf("id: ai-review-action");
    expect(carry, "the walker is not in the committed workflow").toBeGreaterThan(-1);
    expect(carry, "the walker runs after the reviewer it is supposed to inform")
      .toBeLessThan(review);
  });

  test("AC-C5: both the walker and the reviewer are bound to the SAME path", () => {
    const yml = readFileSync(WORKFLOW, "utf8");
    const doc = Bun.YAML.parse(yml) as any;
    const steps = (doc?.jobs?.["ai-review"]?.steps ?? []) as any[];
    const binding = (id: string) =>
      String((steps.find(s => s?.id === id)?.env ?? {})[AI_REVIEW_CARRY_PATH_VAR] ?? "");
    const expected =
      `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.${AI_REVIEW_FINDINGS_DIR_OUTPUT} }}/` +
      AI_REVIEW_CARRY_BASENAME;
    expect(binding(AI_REVIEW_CARRY_STEP_ID)).toBe(expected);
    expect(
      binding("ai-review-action"),
      "the reviewer reads a different path from the one the walker writes, so the file is " +
        "always absent and the carry is always UNMEASURED",
    ).toBe(expected);
  });

  test("AC-C5: the step carries no `if:` and no `continue-on-error`", () => {
    const yml = readFileSync(WORKFLOW, "utf8");
    const at = yml.indexOf(`id: ${AI_REVIEW_CARRY_STEP_ID}`);
    const next = yml.indexOf("      - name:", at);
    const block = yml.slice(at, next === -1 ? undefined : next);
    expect(block, "a skipped step is indistinguishable from a carry that found nothing")
      .not.toContain("\n        if:");
    expect(block).not.toContain("continue-on-error");
  });
});

// ── AC-C6: the extractor slices in the units it measures in (#1568) ──────

/**
 * #1568 — the walker called a VALID ledger unparseable on three consecutive
 * rounds of #1569 and started each of them from nothing.
 *
 * ## The cause, which is not the parser
 *
 * jq's `index` on a string returns a **byte** offset and `.[a:b]` slices by
 * **codepoints**. The extractor measured with one and cut with the other, so
 * it overshot by exactly the number of multi-byte UTF-8 bytes before the cut:
 *
 * ```
 * $ jq -nr '"—abcdef" | index("abc")'   # 3  — bytes
 * $ jq -nr '"—abcdef" | .[1:]'          # abcdef — codepoints
 * $ jq -nr '"xabcdef" | index("abc")'   # 1  — the ASCII control agrees
 * ```
 *
 * #1569's ledger is 13,826 codepoints in 13,846 bytes, 16 of that difference
 * inside the fenced block, so `$rest[:$l]` carried the closing fence and the
 * prose after it into the JSON. `readLedger`'s `indexOf`/`slice` pair agrees
 * with itself, which is why two readers disagreed about the same bytes and
 * only the one in CI was wrong.
 *
 * ## The blast radius, measured rather than reasoned about
 *
 * The first reading of this said non-ASCII *before* the opening fence was
 * harmless, because the `index("\n")` that follows re-finds the end of the
 * fence line and absorbs the drift. That is true only while the overshoot
 * stays inside the seven characters of ```` ```json ````. Probed against the
 * pre-#1568 extractor, one body per row:
 *
 * | where the non-ASCII sits | what the old extractor did |
 * |---|---|
 * | nowhere — pure ASCII | read it |
 * | one em dash before the fence | read it |
 * | four em dashes before the fence | **extraction failed outright** |
 * | one em dash inside the JSON | **returned text that does not parse** |
 * | one em dash inside, nothing after the fence | **returned text that does not parse** |
 *
 * So there is no safe amount and no safe position; there is only an amount
 * small enough that one later search happens to cover for it.
 *
 * ## What the battery before this one held fixed
 *
 * `AC-C1` already has a case for an unterminated fence and a case for a block
 * that does not parse, and `AC-C3` already mutates the refusal. Every fixture
 * in all of them is **ASCII**, and the defect is on the other axis — the
 * seventh shape in `.claude/rules/checks-must-be-able-to-fail.md`, where a
 * battery varies the guard while every row hands it the same shape of input.
 * The em dashes were in the findings' own summaries. This repository writes
 * them in every sentence, so the broken path was the ordinary one.
 *
 * ## Why the fixture is a download and not a construction
 *
 * A hand-built non-ASCII body proves the mechanism; it does not prove the
 * mechanism is what bit #1569. `test/fixtures/ai-review-ledger-1569.json` is
 * the comment verbatim off the API, and the row below it is a MUTANT holding
 * the pre-#1568 extractor, so "red before, green after" is performed on every
 * run rather than asserted once in a pull request description.
 */

/** The pre-#1568 extractor, for mutating the real script back to it. */
const SLICE_EXTRACTOR = [
  `    | (\$b | index(\$m)) as \$i`,
  `    | (if \$i == null then error("marker") else \$b[\$i:] end) as \$after`,
  `    | (\$after | index(\$f)) as \$j`,
  `    | (if \$j == null then error("fence") else \$after[\$j:] end) as \$block`,
  `    | (\$block | index("\\n")) as \$k`,
  `    | (if \$k == null then error("fence") else \$block[\$k + 1:] end) as \$rest`,
  '    | ($rest | index("\\n```")) as $l',
  `    | if \$l == null then error("unterminated") else \$rest[:\$l] end`,
].join("\n");

/** The split-based extractor the real script ships, as one addressable block. */
const SPLIT_EXTRACTOR = [
  `    | (\$b | split(\$m)) as \$mp`,
  `    | (if (\$mp | length) < 2 then error("marker") else (\$mp[1:] | join(\$m)) end) as \$after`,
  `    | (\$after | split(\$f)) as \$fp`,
  `    | (if (\$fp | length) < 2 then error("fence") else (\$fp[1:] | join(\$f)) end) as \$block`,
  `    | (\$block | split("\\n")) as \$lp`,
  `    | (if (\$lp | length) < 2 then error("fence") else (\$lp[1:] | join("\\n")) end) as \$rest`,
  '    | ($rest | split("\\n```")) as $cp',
  `    | if (\$cp | length) < 2 then error("unterminated") else \$cp[0] end`,
].join("\n");

/** The real script with the shipped extractor replaced by the one that bit. */
function sliceExtractorMutant(): string {
  const real = buildCarryScript();
  expect(
    real.split(SPLIT_EXTRACTOR),
    "the shipped extractor was not found verbatim, so the mutant below is the real script",
  ).toHaveLength(2);
  return real.replace(SPLIT_EXTRACTOR, SLICE_EXTRACTOR);
}

/** #1569's ledger comment, verbatim off the API. */
const LEDGER_1569 = JSON.parse(
  readFileSync(join(ROOT, "test", "fixtures", "ai-review-ledger-1569.json"), "utf8"),
) as { id: number; user: { type: string; login: string }; body: string };

describe("AC-C6 (#1568): a valid ledger is read, and an unreadable one still is not", () => {
  test("AC-C6: the fixture is the shape the defect needs, and says so before anything reads it", () => {
    // The premise, asserted rather than assumed. A fixture that had lost its
    // non-ASCII in a round trip would make every row below green against the
    // broken extractor, and the battery would witness nothing.
    expect(LEDGER_1569.user, "the fixture is not authored the way the selector requires").toEqual({
      type: "Bot",
      login: AI_REVIEW_LEDGER_BOT_LOGIN,
    });
    expect(LEDGER_1569.body).toContain(AI_REVIEW_LEDGER_MARKER);
    const bytes = Buffer.byteLength(LEDGER_1569.body, "utf8");
    expect(
      bytes - LEDGER_1569.body.length,
      "the fixture is pure ASCII, so the byte/codepoint disagreement cannot arise in it",
    ).toBeGreaterThan(0);

    // And it is genuinely valid, by a reader that is neither of the two under
    // test. This is the issue's own measurement: `JSON.parse` of the fenced
    // block succeeds while CI called the same bytes unparseable.
    const open = LEDGER_1569.body.indexOf("```json\n");
    const block = LEDGER_1569.body.slice(open + "```json\n".length);
    const payload = JSON.parse(block.slice(0, block.indexOf("\n```"))) as {
      truncated: number;
      rounds: unknown[];
    };
    expect(payload.truncated, "the writer itself believes it wrote a partial ledger").toBe(0);
    expect(payload.rounds.length, "the fixture records no rounds, so there is nothing to lose").toBe(8);
  });

  test("AC-C6: #1569's ledger is READ — and the pre-#1568 extractor calls it UNMEASURED", () => {
    // Red before, green after, as one pair over one input. The mutant is the
    // extractor this issue replaced, so this row fails the moment anyone
    // puts an `index`-measured offset back into a codepoint slice.
    const real = runCarry({ list: [LEDGER_1569] });
    const mutant = runCarry({ list: [LEDGER_1569], script: sliceExtractorMutant() });

    expect(
      mutant.state,
      "the pre-#1568 extractor read #1569's ledger, so this row witnesses no regression",
    ).toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(mutant.file ?? "").toContain("could not be parsed");
    expect(mutant.carried, "the broken extractor carried findings").toHaveLength(0);

    expect(
      real.state,
      `the shipped extractor still cannot read #1569's ledger:\n${real.file}\n${real.stderr}`,
    ).toBe(AI_REVIEW_CARRY_READ);
    expect(
      real.carried.length,
      "the ledger was read and nothing came out of it, which is the failure wearing a different state",
    ).toBeGreaterThan(0);
  });

  test("AC-C6: the bash and the library agree about #1569, which is the whole finding", () => {
    // Two readers, the same bytes, and the one in CI was the one that was
    // wrong. Nothing is planted in the checkout, so every anchor is
    // UNDECIDABLE and both implementations must CARRY all of them — the
    // asymmetry, exercised on a real payload.
    const fromBash = runCarry({ list: [LEDGER_1569] }).carried.map(c => c.summary).sort();

    const reading = readLedger(LEDGER_1569.body);
    const prior = priorFindings(reading);
    expect(prior.status, `the library refused the fixture too: ${JSON.stringify(prior)}`).toBe(
      "AI_REVIEW_PRIOR_MEASURED",
    );
    const fromLib = carryForward(
      (prior as unknown as { prior: CarriedFinding[] }).prior,
      () => undefined,
    )
      .map(f => String((f as { summary?: unknown }).summary))
      .sort();

    expect(fromLib.length, "the library carried nothing, so the agreement below is vacuous").toBeGreaterThan(0);
    expect(fromBash).toEqual(fromLib);
  });

  test("AC-C6: the NEGATIVE control — a genuinely damaged ledger is still refused", () => {
    // Without this row the fix is indistinguishable from "accept everything".
    // The corruption is applied to #1569's own body, so the only difference
    // between this row and the one above is the damage.
    const damaged = LEDGER_1569.body.replace('{"truncated"', '{{"truncated"');
    expect(damaged, "the corruption found nothing to corrupt").not.toBe(LEDGER_1569.body);
    const r = runCarry({ list: [botComment(5, damaged)] });
    expect(r.state, "a ledger that does not parse was accepted").toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(r.carried).toHaveLength(0);

    // Unterminated, on the same non-ASCII body: the split extractor must not
    // fall back to "take the rest of the comment" when the fence is missing.
    const unterminated = LEDGER_1569.body.slice(0, LEDGER_1569.body.lastIndexOf("\n```"));
    expect(unterminated).toContain(AI_REVIEW_LEDGER_MARKER);
    const u = runCarry({ list: [botComment(6, unterminated)] });
    expect(u.state, "an unterminated fenced block was read to the end of the comment").toBe(
      AI_REVIEW_CARRY_UNMEASURED,
    );
  });

  test("AC-C6: the VACUITY control — empty, absent and unreadable are three readings", () => {
    // The conflation #1568 is actually about. A round whose carry failed must
    // not report like a round that had nothing to carry, and the three must
    // stay apart on a NON-ASCII body — which is the input the earlier battery
    // never handed them.
    const summary = "the identifier — reassigned, never re-read";
    const resolved = recorded("lib/a.ts", 1, summary, "const x = 1; // — was");
    const nonAscii = windowBody([round(1, [resolved])]);
    const files = { "lib/a.ts": "something else entirely\n" };

    const absent = runCarry({ list: [] });
    const empty = runCarry({ list: [botComment(5, nonAscii)], files });
    const unreadable = runCarry({
      list: [botComment(5, nonAscii.replace('{"rounds"', '{{"rounds"'))],
      files,
    });

    expect(absent.state, "a pull request with no ledger").toBe(AI_REVIEW_CARRY_ABSENT);
    expect(empty.state, "a ledger that was read and holds nothing outstanding").toBe(AI_REVIEW_CARRY_READ);
    expect(empty.carried, "the finding's cited line changed, so it is resolved and dropped").toHaveLength(0);
    expect(unreadable.state, "a ledger that could not be read").toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(new Set([absent.state, empty.state, unreadable.state]).size).toBe(3);

    // And the measurement that makes this row a finding rather than a
    // restatement of AC-C1: under the pre-#1568 extractor the MIDDLE reading
    // collapses into the right-hand one, so "nothing to carry" and "could not
    // read" become the same observation the moment a summary carries an em
    // dash. Three readings become two.
    const mutant = sliceExtractorMutant();
    const emptyBefore = runCarry({ list: [botComment(5, nonAscii)], files, script: mutant });
    expect(
      emptyBefore.state,
      "the pre-#1568 extractor read this body, so the collapse this issue reports did not happen here",
    ).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });

  test("AC-C6: an ASCII ledger is the POSITIVE control — the old extractor reads it", () => {
    // The axis, named and held. If the pre-#1568 extractor refused ASCII too,
    // the rows above would be measuring a mutant that simply does not work,
    // and nothing in them would be about UTF-8.
    const ascii = windowBody([round(1, [recorded("lib/a.ts", 1, "plain ascii only", "alpha")])]);
    expect(Buffer.byteLength(ascii, "utf8")).toBe(ascii.length);
    const files = { "lib/a.ts": "alpha\n" };
    expect(
      runCarry({ list: [botComment(5, ascii)], files, script: sliceExtractorMutant() }).state,
      "the pre-#1568 extractor cannot read ASCII either, so the mutant is broken rather than byte-confused",
    ).toBe(AI_REVIEW_CARRY_READ);
  });

  test("AC-C6: the refusal has ONE site, so every row above observed the same one", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`: a second branch spelling
    // its own `carry_state AI_REVIEW_CARRY_UNMEASURED` would survive the
    // mutation in AC-C3 and hold a case up while the mutated site was dead.
    const real = buildCarryScript();
    expect(
      real.split(AI_REVIEW_CARRY_UNMEASURED).length - 1,
      "the UNMEASURED state is written from more than one place in the script",
    ).toBe(1);

    // Performed, not described: converting the one site to READ turns an
    // unreadable ledger into a fully-read clean one, which is the direction
    // this subsystem may never fail in.
    const toRead = real.replace(
      `carry_state '${AI_REVIEW_CARRY_UNMEASURED}'`,
      `carry_state '${AI_REVIEW_CARRY_READ}'`,
    );
    expect(toRead).not.toBe(real);
    const damaged = LEDGER_1569.body.replace('{"truncated"', '{{"truncated"');
    expect(
      runCarry({ list: [botComment(5, damaged)], script: toRead }).state,
      "rewriting the refusal changed nothing, so the negative control observes no refusal",
    ).toBe(AI_REVIEW_CARRY_READ);
    expect(runCarry({ list: [botComment(5, damaged)] }).state).toBe(AI_REVIEW_CARRY_UNMEASURED);
  });
});

// ── AC-C7: the ledger snapshot the adjudicator keys from (#1586) ─────────

/**
 * CRC-N4's prior state, captured where it is still the PRIOR state.
 *
 * ## Why the carry step writes it and the adjudicator does not fetch it
 *
 * The generated job runs `ai-review-carry` → the reviewer →
 * `ai-review-persist`, **which upserts this round into the ledger comment**
 * → `ai-review-run`, which adjudicates. An adjudicator that fetched the
 * ledger itself would read a comment already containing the payload it is
 * deciding about: every finding would match a "prior" key that is its own,
 * every round would suppress everything, and the outcome would be CLEAN
 * forever while looking like a dedupe that works. The only position holding
 * the state as it was before the reviewer ran is this step.
 *
 * ## Why the raw body and not the keys
 *
 * `carryKey` is not restated in jq. The bash reaches the body and stops;
 * `readLedger → priorFindings` forms the keys in TypeScript, so there is one
 * decider for a finding's identity. A jq restatement would be #1568's shape
 * again — two readers of the same bytes, differing on a case neither author
 * thought to name.
 *
 * ## The state and the bytes are two files on purpose
 *
 * An absent snapshot cannot say WHY it is absent, and "no earlier findings"
 * versus "the record could not be read" is the distinction #1568 cost three
 * rounds of #1569 to learn. The state stays in the carry file, written on
 * every path by the one `carry_state` site; the snapshot carries only bytes.
 */
describe("AC-C7 (#1586): the ledger snapshot, written where the prior state is still prior", () => {
  const body = () => windowBody([round(1, [recorded("lib/a.ts", 1, "unchecked index", "alpha")])]);

  test("AC-C7: a READ ledger leaves its own bytes for the adjudicator, verbatim", () => {
    const r = runCarry({ list: [botComment(5, body())], files: { "lib/a.ts": "alpha\n" } });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.snapshot, "no snapshot was written on a READ, so the adjudicator has no prior state").not.toBeNull();
    // One provenance line, then the comment byte-identically — `jq -r` adds
    // the trailing newline the shell redirect gives any line, and nothing
    // else may differ. A snapshot that is a RENDERING of the ledger rather
    // than the ledger is a second format for `readLedger` to disagree with.
    const read = readSnapshot(r.snapshot!);
    expect(read.body.replace(/\n$/, "")).toBe(body());
  });

  test("AC-C7: the snapshot says WHICH round it precedes, in a form the reader accepts", () => {
    // Provenance, and it is not decoration. A snapshot taken at the PERSIST
    // step is the same comment fetched the same way and is byte-shaped like
    // a correct one; `ledgerPriorKeysFrom` tells them apart only by comparing the
    // rounds inside the body against this number. Written by bash, parsed
    // by the TypeScript that decides — so the agreement is a test, not a
    // convention.
    const r = runCarry({
      list: [botComment(5, body())],
      files: { "lib/a.ts": "alpha\n" },
      env: { [AI_REVIEW_SNAPSHOT_ROUND_VAR]: "7" },
    });
    expect(r.snapshot!.split("\n")[0]).toBe(`${AI_REVIEW_SNAPSHOT_ROUND_KEY}=7`);
    expect(readSnapshot(r.snapshot!).round).toBe(7);
  });

  test("AC-C7: the snapshot the step wrote is one `readLedger` can key, and the keys are not empty", () => {
    // The join, asserted rather than assumed. A snapshot that round-trips
    // through the shell into something `readLedger` refuses would leave the
    // adjudicator with an empty prior set — which suppresses nothing and so
    // looks exactly like a pull request with no earlier rounds.
    const r = runCarry({ list: [botComment(5, body())], files: { "lib/a.ts": "alpha\n" } });
    const prior = priorFindings(readLedger(readSnapshot(r.snapshot!).body));
    expect(prior.status, `the step's own snapshot did not parse: ${JSON.stringify(prior)}`).toBe(
      "AI_REVIEW_PRIOR_MEASURED",
    );
    const keys = (prior as unknown as { keys: string[] }).keys;
    expect(keys, "the snapshot parsed and produced no keys, so a dedupe built on it never fires").toHaveLength(1);
    // And the key is the TEXT rule, not the line-number fallback. A prior
    // set keyed `n:<line>` can never match a fresh finding keyed `t:<text>`,
    // which is the silent-never-fires half of #1586.
    expect(keys[0]).toContain("t:alpha");
  });

  test("AC-C7: the WRITER and the READER agree end to end — the file the step wrote keys", () => {
    // Both halves of #1586 in one assertion: bash writes the file, the
    // gate's own reader consumes it, and the prior set is non-empty. Every
    // other row in this describe measures one side.
    const r = runCarry({ list: [botComment(5, body())], files: { "lib/a.ts": "alpha\n" } });
    const prior = ledgerPriorKeysFrom(r.file, r.snapshot);
    expect(prior.status, JSON.stringify(prior)).toBe("MEASURED");
    if (prior.status !== "MEASURED") throw new Error("unreachable");
    expect(prior.keys).toHaveLength(1);
  });

  test("AC-C7: a snapshot taken at PERSIST instead of carry is refused, not keyed", () => {
    // The ordering mutant, as an INPUT rather than as a code change: the
    // same ledger, but it already holds the round this snapshot claims to
    // precede, which is exactly what fetching after `ai-review-persist`
    // produces. Suppressing against it would drop this round's own
    // findings and report CLEAN.
    const afterPersist = windowBody([
      round(1, [recorded("lib/a.ts", 1, "unchecked index", "alpha")]),
      round(4, [recorded("lib/a.ts", 1, "unchecked index", "alpha")]),
    ]);
    const r = runCarry({ list: [botComment(5, afterPersist)], files: { "lib/a.ts": "alpha\n" } });
    const prior = ledgerPriorKeysFrom(r.file, r.snapshot);
    expect(prior.status).toBe("UNMEASURED");
    if (prior.status !== "UNMEASURED") throw new Error("unreachable");
    expect(prior.reason).toContain("AFTER this round was recorded");
  });

  test("AC-C7: the MUTANT — the provenance line removed — makes the snapshot unusable", () => {
    // Without the header the two orderings are indistinguishable, so the
    // reader refuses rather than keying a snapshot that might be this
    // round's own. Performed: a copy of the step with the header `printf`
    // deleted, run over the same ledger.
    const real = buildCarryScript();
    const header = real
      .split("\n")
      .find(l => l.includes(AI_REVIEW_SNAPSHOT_ROUND_KEY) && l.includes("printf"));
    expect(header, "the provenance line was not found, so nothing was mutated").toBeDefined();
    const mutant = real.replace(`${header}\n`, "");
    expect(mutant).not.toBe(real);

    const files = { "lib/a.ts": "alpha\n" };
    const m = runCarry({ list: [botComment(5, body())], files, script: mutant });
    expect(m.state, "the mutation moved more than the header").toBe(AI_REVIEW_CARRY_READ);
    expect(m.snapshot, "the mutant wrote no snapshot at all").not.toBeNull();
    expect(ledgerPriorKeysFrom(m.file, m.snapshot).status).toBe("UNMEASURED");
    // And the real step, over the same bytes, keys it.
    const real_run = runCarry({ list: [botComment(5, body())], files });
    expect(ledgerPriorKeysFrom(real_run.file, real_run.snapshot).status).toBe("MEASURED");
  });

  test("AC-C7: an unset round leaves a header the reader refuses, and suppresses nothing", () => {
    // A consumer whose rounds step does not publish an output. The header
    // is written and EMPTY, which is a snapshot that cannot say which round
    // it precedes — refused, so nothing is suppressed. The failure
    // direction is one advisory printed twice.
    const r = runCarry({
      list: [botComment(5, body())],
      files: { "lib/a.ts": "alpha\n" },
      env: { [AI_REVIEW_SNAPSHOT_ROUND_VAR]: "" },
    });
    expect(readSnapshot(r.snapshot!).round).toBeNull();
    expect(ledgerPriorKeysFrom(r.file, r.snapshot).status).toBe("UNMEASURED");
  });

  test("AC-C7: ABSENT and UNMEASURED write NO snapshot, and the carry file still says which", () => {
    // Three readings, one of which has bytes. The other two must be
    // distinguishable from each other at the adjudicator, and the file that
    // distinguishes them is the carry file — not the absence of this one.
    const absent = runCarry({ list: [] });
    const unreadable = runCarry({ list: [botComment(5, body().replace('{"rounds"', '{{"rounds"'))] });

    expect(absent.state).toBe(AI_REVIEW_CARRY_ABSENT);
    expect(absent.snapshot, "an ABSENT reading left bytes for the adjudicator to key from").toBeNull();

    expect(unreadable.state).toBe(AI_REVIEW_CARRY_UNMEASURED);
    expect(unreadable.snapshot, "an UNMEASURED reading left bytes that parsed into a prior set").toBeNull();

    // The whole point: two states, two absent snapshots, and still
    // distinguishable. If this ever collapses, a round that could not read
    // its history suppresses exactly like a round that had none.
    expect(absent.state).not.toBe(unreadable.state);
  });

  test("AC-C7: an unset snapshot path writes nothing and does not disturb the carry", () => {
    // The old workflow, and every consumer that has not re-scaffolded. The
    // step must behave exactly as it did before #1586 rather than refusing:
    // a reader that is not plumbed yet gets no prior set, suppresses
    // nothing, and reports every finding — the direction this is allowed to
    // be wrong in.
    const r = runCarry({
      list: [botComment(5, body())],
      files: { "lib/a.ts": "alpha\n" },
      noSnapshotPath: true,
    });
    expect(r.state, "an unplumbed snapshot path changed the carry's own reading").toBe(AI_REVIEW_CARRY_READ);
    expect(r.snapshot).toBeNull();
    expect(r.carried, "the carry itself stopped working when the snapshot was not plumbed").toHaveLength(1);
  });

  test("AC-C7: the MUTANT — the snapshot write removed — leaves the adjudicator with no prior set", () => {
    // Performed, not described. Without this row every assertion above is
    // satisfied by a step that happens to write the file for some other
    // reason, and the one below is satisfied by a path nothing reaches.
    const real = buildCarryScript();
    const mutant = real.replace(
      `if [ -n "\${${AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR}:-}" ]; then`,
      "if false; then",
    );
    expect(mutant, "the snapshot write was not found, so nothing was mutated").not.toBe(real);
    const files = { "lib/a.ts": "alpha\n" };
    const m = runCarry({ list: [botComment(5, body())], files, script: mutant });
    expect(m.state, "the mutation changed the carry's reading, so it mutated more than the write").toBe(
      AI_REVIEW_CARRY_READ,
    );
    expect(m.snapshot, "removing the write changed nothing, so the write decides no input").toBeNull();
    expect(runCarry({ list: [botComment(5, body())], files }).snapshot).not.toBeNull();
  });

  test("AC-C7: the committed workflow plumbs the snapshot to BOTH the writer and the adjudicator", () => {
    // One path, two steps, composed from the same prepare-step output. A
    // writer and a reader that compose it separately agree until someone
    // edits one of them, and the failure is a dedupe that silently never
    // fires because the file it reads is never the file that was written.
    const yml = readFileSync(WORKFLOW, "utf8");
    // The DECLARATION form specifically — `  VAR: <value>` at the head of a
    // line. A bare `split(VAR + ":")` also counts the `${VAR:-}` guard
    // inside the carry script, which is a use and not a declaration; the
    // first draft of this row did exactly that and read 3 for 2.
    const declarations = yml
      .split("\n")
      .filter(l => new RegExp(`^\\s+${AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR}: \\S`).test(l));
    expect(
      declarations,
      `the snapshot path is not declared in exactly the two steps that use it — the carry step ` +
        `writes it and the adjudicator step reads it, and a step's \`env:\` does not carry ` +
        `forward:\n${declarations.join("\n")}`,
    ).toHaveLength(2);
    // Both declarations compose the SAME path. Two steps that each spell it
    // separately agree until someone edits one, and the failure is a dedupe
    // that never fires because the reader's file is not the writer's.
    expect(new Set(declarations.map(l => l.trim())).size, "the two steps name different paths").toBe(1);
    expect(yml, "the two steps name different basenames").toContain(
      `/${AI_REVIEW_LEDGER_SNAPSHOT_BASENAME}`,
    );

    // The adjudicator step must carry the carry path too, or it can read the
    // bytes and never learn which of the three readings produced them.
    const at = yml.indexOf(`id: ${AI_REVIEW_RUN_STEP_ID}`);
    expect(at, "the adjudicator step is not in the committed workflow").toBeGreaterThan(-1);
    const block = yml.slice(at, yml.indexOf("      - name:", at));
    expect(block, "the adjudicator reads the ledger bytes with no way to read the state").toContain(
      AI_REVIEW_CARRY_PATH_VAR,
    );
    expect(block).toContain(AI_REVIEW_LEDGER_SNAPSHOT_PATH_VAR);
  });
});

/**
 * AC-1's writer: the carry step fetches the pull request's review threads
 * and leaves them where the adjudicator and the thread poster both read
 * them.
 *
 * Every row below runs the REAL generated bash against a faked `curl`, and
 * every row ends by handing what bash wrote to the TypeScript that decides.
 * A writer asserted only on its own bytes is the #1586 shape: the file
 * round-tripped perfectly and keyed nothing, for seven months.
 */
describe("AC-T1 (AC-1): the carry step writes the review threads", () => {
  const KEY = "lib/a.ts\u0000t:alpha\u0000unchecked index";
  const keyed = (key: string) => threadBody({ severity: "high", summary: "unchecked index" }, key);

  test("AC-T1a: a fetched thread reaches the gate's reader as a prior key", () => {
    const r = runCarry({ threadPages: [[{ isResolved: false, body: keyed(KEY) }]] });
    expect(r.threads, "the step wrote no thread list at all").not.toBeNull();
    const prior = priorKeysFrom(r.threads);
    expect(prior.status, `${r.threads}\n${r.stdout}${r.stderr}`).toBe("MEASURED");
    if (prior.status !== "MEASURED") throw new Error("unreachable");
    expect(prior.keys, "the bytes bash wrote parsed and produced no keys").toEqual([KEY]);
  });

  test("AC-T1b: the resolution flag survives the shell, both ways", () => {
    // Not decoration: `carryForwardFromThreads` drops a finding on this
    // field alone, and a transport that flattened it to a string would make
    // every thread read as open — which carries everything and looks fine.
    const r = runCarry({
      threadPages: [
        [
          { isResolved: true, body: keyed(`${KEY} one`) },
          { isResolved: false, body: keyed(`${KEY} two`) },
        ],
      ],
    });
    expect(JSON.parse(r.threads!)).toEqual([
      { isResolved: true, body: keyed(`${KEY} one`) },
      { isResolved: false, body: keyed(`${KEY} two`) },
    ]);
  });

  test("AC-T1c: every page is walked, and the cursor is the one GraphQL gave", () => {
    const r = runCarry({
      threadPages: [
        [{ isResolved: false, body: keyed("one") }],
        [{ isResolved: false, body: keyed("two") }],
        [{ isResolved: true, body: keyed("three") }],
      ],
    });
    const prior = priorKeysFrom(r.threads);
    expect(prior.status, `${r.threads}\n${r.stdout}${r.stderr}`).toBe("MEASURED");
    // Three, in order. A step that ignored the cursor serves page one three
    // times and this reads `["one","one","one"]`, which a length check alone
    // would not catch.
    expect(prior.status === "MEASURED" ? prior.keys : null).toEqual(["one", "two", "three"]);
  });

  test("AC-T1d: a failed POST writes NO file, and says so on the run", () => {
    // AC-4 at the writer. An empty list here would assert the pull request
    // has no threads, and the next round would post a duplicate of every
    // finding while reporting nothing unusual.
    const r = runCarry({ threadPages: null });
    expect(r.threads, "a failed fetch left bytes the adjudicator will key from").toBeNull();
    expect(r.stdout + r.stderr).toContain("could not be read");
    expect(priorKeysFrom(r.threads).status).toBe("UNMEASURED");
  });

  test("AC-T1e: a GraphQL error response writes NO file either", () => {
    // HTTP 200 with an `errors` array — a bad credential, a missing scope, a
    // deleted pull request. `curl -f` succeeds on all three, so this is the
    // failure a fetch cannot see from its exit code.
    const r = runCarry({
      threadsRaw: JSON.stringify({ errors: [{ message: "Bad credentials" }] }),
    });
    expect(r.threads).toBeNull();
    expect(r.stdout + r.stderr).toContain("Bad credentials");
  });

  test("AC-T1f: an unplumbed path writes nothing and does not disturb the carry", () => {
    // Every consumer that has not re-scaffolded. The step must behave as it
    // did before AC-1 rather than refusing.
    const r = runCarry({
      list: [botComment(5, windowBody([round(1, [recorded("lib/a.ts", 1, "unchecked index", "alpha")])]))],
      files: { "lib/a.ts": "alpha\n" },
      noThreadsPath: true,
    });
    expect(r.threads).toBeNull();
    expect(r.state, "an unplumbed thread path changed the carry's own reading").toBe(
      AI_REVIEW_CARRY_READ,
    );
    expect(r.carried, "the carry itself stopped working when the threads were not plumbed").toHaveLength(1);
  });

  test("AC-T1g: a merge_group entry writes an EMPTY list, which is a reading", () => {
    // No pull request, so nothing has been raised on one. MEASURED and
    // empty, not UNMEASURED — and it must not reach the network at all.
    const r = runCarry({ env: { [AI_REVIEW_EVENT_VAR]: "merge_group" } });
    expect(r.threads).toBe("[]");
    expect(priorKeysFrom(r.threads)).toEqual({ status: "MEASURED", keys: [] });
    expect(
      r.argv.some(a => a.includes("graphql")),
      "a merge_group entry queried GitHub for threads on a pull request it does not have",
    ).toBe(false);
  });

  test("AC-T1h: the MUTANT — the write removed — leaves the readers with nothing", () => {
    // Performed. Without this row every assertion above is satisfied by a
    // step that writes the file for some other reason.
    const real = buildCarryScript();
    const mutant = real.replace(
      `printf '%s' "\${threads_acc}" > "\${${AI_REVIEW_THREADS_PATH_VAR}}"`,
      ":",
    );
    expect(mutant, "the thread write was not found, so nothing was mutated").not.toBe(real);
    const pages = [[{ isResolved: false, body: keyed(KEY) }]];
    const m = runCarry({ threadPages: pages, script: mutant });
    expect(m.threads, "removing the write changed nothing, so the write decides no input").toBeNull();
    expect(runCarry({ threadPages: pages }).threads).not.toBeNull();
  });

  test("AC-T1i: the path is declared in the three steps that use it", () => {
    // One writer and TWO readers — the adjudicator and the thread poster —
    // and a step's `env:` does not carry forward. The poster is the one that
    // can open a duplicate, so a declaration missing there is AC-3 failing
    // while AC-1 looks satisfied.
    const yml = readFileSync(WORKFLOW, "utf8");
    const declarations = yml
      .split("\n")
      .filter(l => new RegExp(`^\\s+${AI_REVIEW_THREADS_PATH_VAR}: \\S`).test(l));
    expect(declarations, declarations.join("\n")).toHaveLength(3);
    expect(new Set(declarations.map(l => l.trim())).size, "the steps name different paths").toBe(1);
    expect(yml).toContain(`/${AI_REVIEW_THREADS_BASENAME}`);
  });
});

/**
 * AC-2 (Increment 1b): carry-forward decides "still unanswered" from an OPEN
 * thread, and treats a RESOLVED one as answered.
 *
 * ## The gate and this reader deliberately disagree, and that is the point
 *
 * `aiReviewSuppressionGate` asks "has this already been RAISED?", so a
 * resolved thread counts as raised and the finding is not posted twice. This
 * reader asks "is this still UNANSWERED?", so a resolved thread counts as
 * answered and the finding is dropped. Same input, two questions, two
 * answers. A single shared helper returning one boolean would have to pick
 * one of them and silently break the other — which is why the resolution flag
 * is read here rather than folded away in `priorKeysFrom`.
 *
 * ## Why this is not the anchor rule in different clothes
 *
 * The anchor rule asks the CODE whether a finding is fixed. It cannot see an
 * answer that is not a code change — a false positive closed with a reason,
 * which CRC-C3 exists for. Before this, answering such a thread left the
 * finding carried forever and the reviewer re-raised it every round. That is
 * CRC-N4 measured on #1616: eleven threads for three distinct findings.
 */
describe("AC-C8 (AC-2): a RESOLVED thread answers a carried finding", () => {
  const TEXT = "const n = xs[i]";
  const SUMMARY = "unchecked index";
  const FILE = "lib/a.ts";
  // `carryKey` is nullable, and a null here would spell "no key in the body",
  // which every row below would read as "no thread matched" — row (b) would
  // fail for a reason that has nothing to do with resolution. Refuse it at
  // the fixture rather than diagnosing it at the assertion.
  const liveKey = (): string => {
    const k = carryKey({ file: FILE, line: 1, summary: SUMMARY }, TEXT);
    if (k === null) throw new Error("carryKey returned null, so this fixture cannot key a thread");
    return k;
  };
  const ledger = () => [botComment(5, windowBody([round(5, [recorded(FILE, 1, SUMMARY, TEXT)])]))];
  const files = { [FILE]: `${TEXT}\n` };
  const thread = (isResolved: boolean, key: string = liveKey()) => ({
    isResolved,
    body: threadBody({ severity: "high", summary: SUMMARY }, key),
  });

  test("AC-C8a: the control — an OPEN thread leaves the finding carried", () => {
    // Without this row the next one is satisfied by a step that drops
    // everything the moment any thread exists.
    const r = runCarry({ list: ledger(), files, threadPages: [[thread(false)]] });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried, "an open thread stopped the finding being carried").toHaveLength(1);
  });

  test("AC-C8b: a RESOLVED thread drops it, with the code UNCHANGED", () => {
    // The anchor still matches — `files` is identical to row (a) — so the
    // anchor rule carries. Only the resolution can drop it, which is the
    // whole criterion.
    const r = runCarry({ list: ledger(), files, threadPages: [[thread(true)]] });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(
      r.carried,
      "a thread answered and resolved by a human still carried, so the reviewer re-raises it next round",
    ).toHaveLength(0);
  });

  test("AC-C8c: a resolved thread for a DIFFERENT finding drops nothing", () => {
    // The drop is keyed, not blanket. Without this, a reader that dropped
    // every finding whenever ANY resolved thread existed passes row (b).
    const r = runCarry({
      list: ledger(),
      files,
      threadPages: [[thread(true, `${FILE}\u0000t:something else\u0000a different summary`)]],
    });
    expect(r.carried, "an unrelated resolved thread answered this finding").toHaveLength(1);
  });

  test("AC-C8d: threads that could not be read carry, rather than resolving", () => {
    // The direction this must fail in. An unreadable thread list is not
    // evidence that anything was answered, and the costly error is the silent
    // drop — a live finding that vanishes with the check reporting CLEAN.
    const r = runCarry({ list: ledger(), files, threadPages: null });
    expect(
      r.carried,
      "an unreadable thread list was treated as every finding having been answered",
    ).toHaveLength(1);
  });
});

describe("AC-C8 (AC-2): the drop, performed", () => {
  const TEXT = "const n = xs[i]";
  const SUMMARY = "unchecked index";
  const FILE = "lib/a.ts";
  const ledger = () => [botComment(5, windowBody([round(5, [recorded(FILE, 1, SUMMARY, TEXT)])]))];
  const files = { [FILE]: `${TEXT}\n` };

  test("AC-C8e: the MUTANT — the resolved filter removed — carries the answered finding", () => {
    // Without this row, AC-C8b is satisfied by any step that drops the
    // finding for some other reason, and nothing says the resolution did it.
    // Removing the `--argjson` binding is the smallest edit that disarms the
    // filter without changing the jq program, so the mutant still parses.
    const real = buildCarryScript();
    const mutant = real.replace(` --argjson resolved "\${resolved_bodies}"`, ` --argjson resolved '[]'`);
    expect(mutant, "the resolved binding was not found, so nothing was mutated").not.toBe(real);

    const key = carryKey({ file: FILE, line: 1, summary: SUMMARY }, TEXT);
    expect(key, "the fixture could not key a thread").not.toBeNull();
    const pages = [[{ isResolved: true, body: threadBody({ severity: "high", summary: SUMMARY }, key) }]];

    expect(
      runCarry({ list: ledger(), files, threadPages: pages, script: mutant }).carried,
      "the mutant dropped it too, so the resolved threads are not what row (b) measures",
    ).toHaveLength(1);
    expect(
      runCarry({ list: ledger(), files, threadPages: pages }).carried,
      "the real script stopped dropping it, so row (b) is measuring nothing",
    ).toHaveLength(0);
  });
});

/**
 * AC-C9: the TWO NORMALISERS must fold case the same way.
 *
 * `carryKey` keys a thread body in TypeScript; the generated jq re-derives the
 * same key from that body with its own `norm`. They are two implementations of
 * one function, so the only thing that makes the pair correct is that they
 * agree on every input — and nothing above this block feeds either of them a
 * character the two could disagree about.
 *
 * jq's `norm` folds case with `ascii_downcase`. jq exposes no Unicode-aware
 * downcase at all (`builtins` offers `ascii_downcase` and `ascii_upcase` and
 * nothing else), so the agreement has to be bought on the TypeScript side:
 * `normalise` folds `[A-Z]` only, which is exactly what `ascii_downcase` does.
 *
 * Measured while writing this: the whitespace half of the same expression does
 * NOT diverge. Given `a b c　d`, jq's `[[:space:]]+` and JS's
 * `\s+` both yield `a b c d`, so the population of divergences in `norm` is
 * one, not two. The control below is what keeps this block honest if that ever
 * stops being true.
 */
describe("AC-C9 (AC-2): the jq and TypeScript normalisers fold case identically", () => {
  const TEXT = "const n = xs[i]";
  const FILE = "lib/a.ts";
  const files = { [FILE]: `${TEXT}\n` };

  // The pair differs in ONE respect: whether the summary carries a non-ASCII
  // uppercase letter. Everything else is held fixed, so a disagreement between
  // the rows can only be the case fold.
  const drops = (summary: string) => {
    const ledger = [botComment(5, windowBody([round(5, [recorded(FILE, 1, summary, TEXT)])]))];
    const key = carryKey({ file: FILE, line: 1, summary }, TEXT);
    expect(key, `the fixture could not key a thread for ${JSON.stringify(summary)}`).not.toBeNull();
    const pages = [[{ isResolved: true, body: threadBody({ severity: "high", summary }, key) }]];
    return runCarry({ list: ledger, files, threadPages: pages }).carried;
  };

  test("AC-C9a: the ASCII control — a resolved thread drops its finding", () => {
    // If this row ever goes red the next one proves nothing: both engines
    // would be failing to match for a reason that is not the case fold.
    expect(drops("UNCHECKED Index"), "the ASCII control did not drop").toHaveLength(0);
  });

  test("AC-C9b: a non-ASCII uppercase in the summary drops it too", () => {
    // Red before the fix. `.toLowerCase()` folded "É" to "é" while jq's
    // `ascii_downcase` left it alone, so the two engines keyed the same thread
    // differently, the resolved thread never matched, and the finding was
    // carried for ever — the reviewer re-raising a finding a human had already
    // answered, which is the CRC-N4 failure this whole increment exists to end.
    expect(
      drops("UNCHECKED Índex"),
      "a summary with a non-ASCII uppercase letter did not drop, so the TypeScript and jq " +
        "normalisers disagree about case and a resolved thread cannot answer the finding",
    ).toHaveLength(0);
  });
});

/**
 * AC-C10 (AC-2): an EMPTY thread file is unreadable, not "nothing resolved".
 *
 * `[ -f ]` asks whether the file exists. It does not ask whether it has any
 * bytes, and the two are different states: a job killed mid-write, a disk
 * that filled, an upload that produced the path and nothing else all leave a
 * present, zero-byte file.
 *
 * Measured: `jq -c '[...]' < /dev/null` exits **0** and prints **nothing** —
 * empty input is zero iterations, not an error. So the `if !` branch does not
 * fire, `resolved_bodies` becomes `""` instead of `'[]'`, and the later
 * `--argjson resolved ""` is handed something that is not JSON. jq's own
 * answer to that is `invalid JSON text passed to --argjson`, which kills the
 * carry jq outright — the one invocation that decides what carries.
 *
 * The guard is therefore the wrong SHAPE, not merely too narrow: it tests the
 * exit code of a command that succeeds in the failing case. The fix tests the
 * output instead. A non-empty stdout from `jq -c` is jq's own serialisation
 * and is valid JSON by construction, so emptiness is the whole check and no
 * second parse is needed.
 */
describe("AC-C10 (AC-2): a zero-byte thread file carries, rather than breaking the carry", () => {
  const TEXT = "const n = xs[i]";
  const SUMMARY = "unchecked index";
  const FILE = "lib/a.ts";
  const ledger = () => [botComment(5, windowBody([round(5, [recorded(FILE, 1, SUMMARY, TEXT)])]))];
  const files = { [FILE]: `${TEXT}\n` };

  // The partial write, performed on the INPUT. `threads_fetch` is made to
  // leave the file it always leaves, with no bytes in it — the shape an
  // interrupted job produces. The block under test is not touched.
  const truncatingWriter = () => {
    const real = buildCarryScript();
    const mutant = real.replace(
      `printf '%s' "\${threads_acc}" > "\${${AI_REVIEW_THREADS_PATH_VAR}}"`,
      `: > "\${${AI_REVIEW_THREADS_PATH_VAR}}"`,
    );
    expect(mutant, "the thread write was not found, so no empty file was produced").not.toBe(real);
    return mutant;
  };

  test("AC-C10a: the control — a well-formed thread file leaves the carry working", () => {
    const r = runCarry({ list: ledger(), files, threadPages: [[]] });
    expect(r.state).toBe(AI_REVIEW_CARRY_READ);
    expect(r.carried, "the control did not carry, so row (b) proves nothing").toHaveLength(1);
  });

  test("AC-C10b: a present but EMPTY thread file still produces a reading", () => {
    const r = runCarry({ list: ledger(), files, threadPages: [[]], script: truncatingWriter() });
    expect(
      r.stdout + r.stderr,
      "jq was handed a non-JSON --argjson, so the one invocation that decides what carries died",
    ).not.toContain("invalid JSON text");
    expect(r.state, `${r.stdout}${r.stderr}`).toBe(AI_REVIEW_CARRY_READ);
    expect(
      r.carried,
      "an unreadable thread list dropped a finding instead of carrying it — the direction " +
        "that clears a live finding while the required check reports CLEAN",
    ).toHaveLength(1);
  });
});
