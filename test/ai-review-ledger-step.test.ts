/**
 * #1168 — the findings ledger: persistence for a finding set that currently
 * evaporates with the runner.
 *
 * Measured on #1168 before any of this was built: `ai-review.yml` has no
 * `upload-artifact` step, the findings payload is written under
 * `RUNNER_TEMP`, and a real run reports zero artifacts. The only reason any
 * historical finding was recoverable at all is that the adjudication step
 * echoes the reader's output into the job log, and logs expire. So the round
 * cap's justification — that N rounds each finding something says more about
 * the change than about the reviewer — rests on a cumulative finding set that
 * nothing was making cumulative.
 *
 * ## Why these cases execute the bash instead of reading it
 *
 * The step is a `run:` block on a runner. Asserting on its SOURCE would make
 * every case below pass against a script that cannot run at all, and the one
 * property that matters most here — *it never writes on top of a read it
 * could not take* — is a behaviour, not a string. Every case spawns the real
 * generated script under `bash -e`, which is what GitHub Actions runs it
 * with, with a `curl` that both ANSWERS and RECORDS ITS OWN ARGV.
 *
 * Recording the argv is what makes the destructive case checkable: "it did
 * not write" is a claim about a request that was never made, and a stub that
 * only answers cannot see the absence of one.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_GIT_ISOLATED,
  AI_REVIEW_LEDGER_API_VAR,
  AI_REVIEW_LEDGER_MERGE_FIELD,
  AI_REVIEW_LEDGER_TURNS_FIELD,
  AI_REVIEW_LEDGER_IDENTITY_V1,
  AI_REVIEW_LEDGER_BOT_LOGIN,
  AI_REVIEW_LEDGER_MARKER,
  AI_REVIEW_LEDGER_MAX_BODY,
  AI_REVIEW_LEDGER_MAX_PAGES,
  AI_REVIEW_LEDGER_MAX_ROUNDS,
  AI_REVIEW_LEDGER_TEXT_FIELD,
  AI_REVIEW_LEDGER_PR_VAR,
  AI_REVIEW_LEDGER_REPO_VAR,
  AI_REVIEW_LEDGER_ROUNDS_FIELD,
  AI_REVIEW_LEDGER_SHA_VAR,
  AI_REVIEW_LEDGER_TRUNCATED_FIELD,
  AI_REVIEW_LEDGER_TOKEN_VAR,
  AI_REVIEW_PERSIST_STEP_ID,
  AI_REVIEW_ROUND_PATH_VAR,
  buildPersistScript,
} from "../lib/scaffold/ai-review-step";
// The reader, imported here on purpose. The recorder's whole job is to hand
// `carryForward` something it can tell apart, and asserting the shape without
// running it through the consumer is how `text: ""` passed review twice.
import { carryForward } from "../lib/ai-review-rounds";
import { readAiReviewFindings } from "../lib/scaffold/ai-review-findings";
// The reader, imported by the TEST only. Neither production file imports the
// other — the step stays import-free because mutation batteries copy it into
// a tmpdir — so an agreement about field names has to be asserted somewhere,
// and the only honest place is where both can be run against each other.
import {
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_ROUNDS_KEY,
  AI_REVIEW_LEDGER_TRUNCATED_KEY,
  AI_REVIEW_TRUNCATION_STATED,
  AI_REVIEW_TRUNCATION_UNKNOWN,
  AI_REVIEW_TURNS_NOT_RECORDED,
  AI_REVIEW_TURNS_READ,
  AI_REVIEW_TURNS_UNREADABLE,
  readLedger,
  readRoundTurns,
} from "../lib/ai-review-rounds";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

/**
 * This file inherited bun's 5,000ms default and `AC-L10` sat on it (#1402).
 *
 * Measured on a detached worktree at clean `origin/main` — nothing of this
 * branch in it — `AC-L10` ran 5003.72ms, 5012.13ms and 7118.04ms, red in 2 of
 * 3. CI never caught it across eight consecutive green runs because the
 * runner is faster, which is the risk rather than the reassurance: the first
 * slower runner reddens whichever pull request happens to be open, and that
 * author pays to discover it was never theirs.
 *
 * The cost is inherent, not accidental. `AC-L10` spawns the persist step once
 * per shape in `SHAPE_CORPUS`, so it is linear in the corpus and grows every
 * time somebody adds a shape — which they should.
 *
 * A hardcoded per-test budget was the other candidate and is rejected here: a
 * literal is a guess about the slowest machine that will ever run this, and
 * the thing that varies IS the machine. `gitFixtureTestTimeout()` calibrates
 * against the box running the suite, which is the mechanism this repository
 * already uses for exactly this on seven sibling suites. It also makes
 * `declaresFileBudget` report this file as DECLARED, so the growth rule in
 * `lib/junit-checks.ts` stops counting it among the files that inherit a
 * default nobody chose — "decided" and "nobody looked" become tellable apart,
 * which is the whole distinction `perTestTimeoutDeclarations` exists to draw.
 */
setDefaultTimeout(gitFixtureTestTimeout());

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github", "workflows", "ai-review.yml");

/** A ledger comment as the step itself would have written it. */
function botComment(id: number, body: string) {
  return { id, user: { type: "Bot", login: "github-actions[bot]" }, body };
}

/**
 * The action's result message, as the SDK declares it and the action writes
 * it — NOT as a reader wishes it were (#1498).
 *
 * Derived from the pinned action rather than from the readers that consume
 * it. `anthropics/claude-code-action@5eb090f3c3afd701a0672cd32981197ca27688f6`
 * (the SHA `lib/claude-code-action.ts` declares, v1 as of 2026-10-19):
 *
 *  - `base-action/src/run-claude-sdk.ts` accumulates `const messages:
 *    SDKMessage[]` and hands that ARRAY to `writeExecutionFile(messages)`.
 *  - `base-action/src/execution-file.ts` is
 *    `writeFile(executionFile, JSON.stringify(messages, null, 2))` — the whole
 *    of it. No wrapper object, no root-level summary.
 *
 * So the document root is a JSON ARRAY of messages and `num_turns` sits on the
 * `type: "result"` member inside it. A reader addressing `.num_turns` at the
 * root finds nothing on any run that has ever happened, which is #1498.
 *
 * The field list is `SDKResultSuccess` in `@anthropic-ai/claude-agent-sdk`'s
 * `sdk.d.ts`, including `permission_denials` as an ARRAY — the `_count` name
 * exists only in `sanitizeSdkOutput`'s `console.log` and never reaches this
 * file, which is #1392, the same defect one key over.
 */
const RESULT_MESSAGE: Record<string, unknown> = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 412_118,
  duration_api_ms: 390_004,
  num_turns: 51,
  result: "CLEAN — no blocking findings.",
  stop_reason: null,
  total_cost_usd: 1.8423,
  usage: { input_tokens: 41, output_tokens: 1180 },
  modelUsage: {},
  permission_denials: [],
  session_id: "sess-1498",
  uuid: "11111111-2222-3333-4444-555555555555",
};

/**
 * A real `SDKMessage[]` as the action writes one: an `init`, some traffic, and
 * the result message LAST. `result === null` plants an array with no result
 * message at all, which is a readable document stating no turn count — and
 * must record UNMEASURED rather than `0`.
 */
function executionMessages(result: Record<string, unknown> | null): unknown[] {
  const messages: unknown[] = [
    { type: "system", subtype: "init", session_id: "sess-1498", model: "claude-opus-4-1" },
    {
      type: "assistant",
      session_id: "sess-1498",
      message: { role: "assistant", content: [{ type: "text", text: "reviewing" }] },
    },
  ];
  if (result !== null) messages.push(result);
  return messages;
}

/** The result message with one field replaced, or — for `undefined` — removed. */
function resultWith(field: string, value: unknown): Record<string, unknown> {
  const r = { ...RESULT_MESSAGE };
  if (value === undefined) delete r[field];
  else r[field] = value;
  return r;
}

/** A comment body in the ledger's own format, holding `rounds`. */
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

/** A ledger in the windowed shape this step writes from #1405 onward. */
function windowBody(rounds: unknown[], over: Record<string, unknown> = {}): string {
  return ledgerBody({ [AI_REVIEW_LEDGER_ROUNDS_FIELD]: rounds, ...over });
}

interface Rig {
  /** The comment list the GET answers with. `null` makes the GET FAIL. */
  list?: unknown[] | null;
  /**
   * One answer per page, chosen by the `page=` in the request URL — #1353.
   * A request for a page past the end gets `[]`, which is what the API does.
   * Takes precedence over `list`.
   */
  pages?: unknown[][];
  /**
   * Raw bytes for the GET's stdout, bypassing JSON entirely. For the case
   * where the transfer SUCCEEDS and the body is not a comment list.
   */
  listRaw?: string;
  /**
   * Bytes the GET writes to STDERR while still exiting 0. This is the `2>&1`
   * case: the step used to merge these into the response body.
   */
  listStderr?: string;
  /** The findings payload on disk. `undefined` plants no file at all. */
  payload?: unknown;
  /**
   * The action's execution file on disk, which is where `num_turns` comes
   * from (#1380). `undefined` plants no file and leaves
   * `AI_REVIEW_EXECUTION_FILE` pointing at a path that does not exist —
   * which is the live state on every run where the action never produced
   * one, and is the state the UNMEASURED branch exists for.
   *
   * A string is written verbatim, for the cases about bytes that are not
   * JSON at all.
   */
  execution?: unknown;
  /**
   * The round number, placed into the round file's REAL three-line format.
   * Pass `rawRound` instead to write arbitrary bytes.
   */
  round?: string;
  /** The round file verbatim, for cases about the format itself. */
  rawRound?: string;
  /**
   * Source files to plant in the step's working directory, relative path to
   * contents. This is the "checkout" the step records cited line text out of.
   */
  files?: Record<string, string>;
  /**
   * REAL symlinks to plant in the checkout, relative link path to its target.
   * Separate from `files` because the subject of #1379 is what the step does
   * with a link, and a fixture that writes a regular file containing a path
   * tests nothing: every string test in the step passes either way, and only
   * a real inode carries the `-L`/`-f` disagreement the defect lives in.
   */
  symlinks?: Record<string, string>;
  /**
   * Files planted AFTER the index is built, so they exist in the checkout
   * and are NOT tracked. The step's boundary is "a file the pull request
   * contains", and an untracked file inside the workspace is the population
   * that separates that from "a file inside the workspace" — anything an
   * earlier step or the reviewer itself wrote there.
   */
  untracked?: Record<string, string>;
  /**
   * Overwrites a TRACKED path on disk after the index is built, leaving the
   * working tree dirty against the index. Mechanically the same write as
   * `untracked`; named apart because the fact under test is different —
   * here the path IS in the index and the two objects disagree.
   */
  dirty?: Record<string, string>;
  /** Overrides for the step's environment. */
  env?: Record<string, string>;
  /** Make the write (POST/PATCH) fail. */
  writeFails?: boolean;
  /** The script under test — defaulted, so a mutant runs the identical rig. */
  script?: string;
}

function runPersist(rig: Rig = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-ledger-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const argvPath = join(dir, "curl-argv.txt");
    const bodyPath = join(dir, "curl-body.txt");

    const list = rig.list === undefined ? [] : rig.list;

    // The GET's answer goes to a FILE the stub `cat`s, and that is not style.
    // A ledger comment body contains ```json fences, and a fixture
    // interpolated into `printf "..."` makes those backticks COMMAND
    // SUBSTITUTION: bash runs `json`, substitutes the empty string, and the
    // marker-matching the case is about silently never happens. Measured
    // here: the two upsert rows failed against a correct script until the
    // fixture stopped going through a shell. A file cannot be mangled.
    const listPath = join(dir, "list.json");
    if (list !== null) writeFileSync(listPath, JSON.stringify(list));

    // #1353. Per-page answers go to per-page FILES for the same reason the
    // single list does: a ledger body carries ```json fences and a fixture
    // routed through a shell becomes command substitution.
    if (rig.pages !== undefined) {
      rig.pages.forEach((p, i) => writeFileSync(join(dir, `page-${i + 1}.json`), JSON.stringify(p)));
    }
    if (rig.listRaw !== undefined) writeFileSync(listPath, rig.listRaw);

    // One stub, two modes, told apart the way the script tells them apart:
    // a write passes `-X`. It records argv AND the request body, so a case
    // can assert on what was SENT and not only on what came back.
    const curl = [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" >> ${JSON.stringify(argvPath)}`,
      "mode=read",
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "-X" ]; then mode="$a"; fi',
      '  if [ "$prev" = "--data-binary" ]; then printf "%s" "$a" > ' + JSON.stringify(bodyPath) + "; fi",
      '  prev="$a"',
      "done",
      'if [ "$mode" != "read" ]; then',
      rig.writeFails ? "  exit 22" : '  printf "%s" "${STUB_WRITE_RESPONSE}"',
      "  exit 0",
      "fi",
      // #1353. Everything below is the READ. The stub answers per page when
      // the case supplies pages, and can write to stderr while still exiting
      // 0 — the state a `2>&1` turns into a corrupt body.
      ...(rig.listStderr === undefined
        ? []
        : [`printf '%s\\n' ${JSON.stringify(rig.listStderr)} >&2`]),
      ...(rig.pages === undefined
        ? []
        : [
            "pg=1",
            'for a in "$@"; do case "$a" in *page=*) pg="${a##*page=}"; pg="${pg%%&*}";; esac; done',
            `f=${JSON.stringify(dir)}/page-\${pg}.json`,
            // A page past the end is `[]`, which is what the real API returns
            // and is the reading that ends the loop.
            'if [ -f "$f" ]; then cat "$f"; else printf "[]"; fi',
            "exit 0",
          ]),
      list === null ? "exit 22" : `cat ${JSON.stringify(listPath)}`,
    ].join("\n");
    writeFileSync(join(bin, "curl"), `${curl}\n`, { mode: 0o755 });

    const findingsPath = join(dir, "findings.json");
    if (rig.payload !== undefined) {
      writeFileSync(
        findingsPath,
        typeof rig.payload === "string" ? rig.payload : JSON.stringify(rig.payload),
      );
    }
    // #1380. The action's execution file. The PATH is always bound, whether
    // or not a file is planted: that is what the generated step does, and
    // the absent-file branch is only reachable through a bound path naming
    // nothing.
    const executionPath = join(dir, "execution.json");
    if (rig.execution !== undefined) {
      writeFileSync(
        executionPath,
        typeof rig.execution === "string" ? rig.execution : JSON.stringify(rig.execution),
      );
    }

    // THE REAL FORMAT, three lines, as `buildRoundsScript` writes it. The
    // first version of this rig wrote a bare "2", and that single number is
    // why the battery could not see a defect worth a MEDIUM: a scrape of
    // every digit and a parse of `review_round=` agree on every input shaped
    // like that, so the fixture and the bug shared a blind spot. Round 2
    // under a budget of 3 was being recorded as 23.
    const roundPath = join(dir, "round.txt");
    writeFileSync(
      roundPath,
      rig.rawRound ??
        `review_round=${rig.round ?? "2"}\nround_budget=3\nround_budget_spent=no\n`,
    );

    // The "checkout". `cwd` is pinned to it for every case, not only the ones
    // that plant files: the step resolves a finding's `file` relatively, so
    // an unpinned cwd would have it reading this repository's real sources
    // out of whatever directory the suite happened to start in.
    const work = join(dir, "work");
    mkdirSync(work);
    for (const [rel, contents] of Object.entries(rig.files ?? {})) {
      const abs = join(work, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    for (const [rel, target] of Object.entries(rig.symlinks ?? {})) {
      const abs = join(work, rel);
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(target, abs);
    }
    // A REAL index, because the step's boundary is now "tracked". `add -A`
    // and no commit is deliberate and sufficient: `ls-files` reads the
    // index, not history, which is the property that has to hold under the
    // job's `fetch-depth: 1` and is asserted here rather than reasoned about.
    // The symlinks are added too — #1379's premise is a COMMITTED symlink,
    // so tracking must not be what refuses it.
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: work,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        encoding: "utf8",
      });
    git("init", "-q", "-b", "main", ".");
    git("add", "-A");
    for (const [rel, contents] of Object.entries({ ...rig.untracked, ...rig.dirty })) {
      const abs = join(work, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }

    const script = join(dir, "persist.sh");
    writeFileSync(script, rig.script ?? buildPersistScript());

    const r = spawnSync("bash", ["-e", script], {
      cwd: work,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        // The write stub echoes a body carrying the run id, so the script's
        // own read-back check has something true to find.
        STUB_WRITE_RESPONSE: JSON.stringify({ id: 5, body: "run-9 ok" }),
        GITHUB_RUN_ID: "run-9",
        GITHUB_RUN_ATTEMPT: "1",
        // #1380. The commit the reviewer READ, which the runner sets and
        // which is the merge commit on a `pull_request` event. Deliberately
        // NOT equal to `AI_REVIEW_LEDGER_SHA` below: the two fields have one
        // source each, and a fixture that gave them the same string could
        // not tell a recorder reading the right one from a recorder reading
        // the other twice.
        GITHUB_SHA: "mergecommit0",
        [AI_REVIEW_FINDINGS_PATH_VAR]: findingsPath,
        [AI_REVIEW_EXECUTION_FILE_VAR]: executionPath,
        [AI_REVIEW_ROUND_PATH_VAR]: roundPath,
        [AI_REVIEW_LEDGER_PR_VAR]: "77",
        [AI_REVIEW_LEDGER_SHA_VAR]: "deadbeef",
        [AI_REVIEW_LEDGER_REPO_VAR]: "o/r",
        [AI_REVIEW_LEDGER_API_VAR]: "https://api.github.test",
        [AI_REVIEW_LEDGER_TOKEN_VAR]: "t",
        ...rig.env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });

    const argv = existsSync(argvPath) ? readFileSync(argvPath, "utf8").split("\n").filter(Boolean) : [];
    const sentRaw = existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : null;
    // What the ledger comment would say, parsed back out of the request.
    // TWO SHAPES (#1405). The bare array is what this step used to write and
    // what fixtures still plant as a legacy ledger; `{rounds, truncated}` is
    // what it writes now. `doc` is the whole document so a case can assert on
    // the field's PRESENCE, which is the distinction the window count exists
    // to carry — an absent `truncated` is "unknown", never zero.
    let rounds: any[] | null = null;
    let doc: any = undefined;
    if (sentRaw !== null) {
      const body = JSON.parse(sentRaw).body as string;
      const fenced = body.split("```json")[1]?.split("```")[0];
      doc = fenced === undefined ? null : JSON.parse(fenced);
      if (Array.isArray(doc)) rounds = doc;
      else if (doc !== null && typeof doc === "object" && Array.isArray(doc.rounds)) {
        rounds = doc.rounds;
      }
    }
    const method = argv.includes("PATCH") ? "PATCH" : argv.includes("POST") ? "POST" : null;
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", argv, rounds, doc, method, sentRaw };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONE_FINDING = { findings: [{ severity: "high", file: "lib/a.ts", line: 4, summary: "s" }] };

describe("AC-L0 (#1168): the rig delivers its own fixture unmangled", () => {
  /**
   * The premise every upsert row rests on, asserted rather than assumed.
   *
   * A ledger body carries ```json fences. Interpolated into generated shell
   * source those backticks are command substitution, the marker is eaten,
   * and a correct script reads as one that cannot find its own comment —
   * which is exactly how the first run of this file failed. Without this row
   * that failure is indistinguishable from a broken script.
   */
  test("AC-L0: the ledger fixture still contains its marker and its fences", () => {
    const body = ledgerBody([{ at: "t0", run: "run-1", round: 1, findings: [] }]);
    const r = runPersist({ list: [botComment(5, body)], payload: ONE_FINDING });
    expect(r.stderr, "the stub shelled out while answering with the fixture").toBe("");
    // Reached the script intact: it found the comment and PATCHed it.
    expect(r.method, "the fixture's marker did not survive the stub").toBe("PATCH");
  });
});

describe("AC-L1 (#1168): a round is written, and the ledger is cumulative", () => {
  test("AC-L1: a first round POSTs a new comment carrying the marker", () => {
    const r = runPersist({ list: [], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("POST");
    expect(r.sentRaw).toContain(AI_REVIEW_LEDGER_MARKER);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds![0].findings).toEqual([
      // `lib/a.ts` is not in this case's checkout, so there was no line to
      // read and the recorded text is empty. AC-L9 is where it is planted.
      // No `text`: nothing is planted at `lib/a.ts` here, so the anchor could
      // not be read and the recorder records its absence (AC-L14, #1406).
      //
      // `failure_scenario: null` and NOT an absent key (#1511). The
      // projection names the field, so a payload that omitted it records
      // `null` — which `blockingContractViolations` treats exactly as it
      // treats an absent one, and which says the reviewer supplied nothing
      // rather than the recorder having dropped it. `ONE_FINDING` omits it
      // on purpose: it is the shape the reviewer is NOT supposed to write,
      // and recording it faithfully is what keeps the refusal reachable.
      { severity: "high", file: "lib/a.ts", line: 4, summary: "s", failure_scenario: null },
    ]);
    expect(r.rounds![0].round).toBe(2);
    // The identity rule is stamped on the entry, so a later round reads which
    // rule the anchors were recorded under instead of assuming its own.
    expect(r.rounds![0].identity).toBe(AI_REVIEW_LEDGER_IDENTITY_V1);
  });

  /**
   * The point of the whole issue, in one row. A ledger that replaced its
   * contents each round would satisfy AC-L1 exactly and make the finding set
   * no more cumulative than the runner did.
   */
  test("AC-L1: a second round PATCHes, and the EARLIER round is still there", () => {
    const prior = [{ at: "t0", sha: "cafe", run: "run-1", attempt: "1", round: 1, findings: [] }];
    const r = runPersist({ list: [botComment(5, ledgerBody(prior))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("PATCH");
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds![0].run).toBe("run-1");
    expect(r.rounds![1].run).toBe("run-9");
  });

  test("AC-L1 CONTROL: a comment WITHOUT the marker is not mistaken for the ledger", () => {
    // Otherwise the first row is consistent with "upsert whatever comment is
    // last", which would overwrite a human's comment and lose every round.
    const r = runPersist({
      list: [{ id: 9, user: { type: "Bot" }, body: "a human talking about ```json [] ```" }],
      payload: ONE_FINDING,
    });
    expect(r.method).toBe("POST");
    expect(r.rounds).toHaveLength(1);
  });
});

describe("AC-L7 (#1319 review): the round number is parsed, never scraped", () => {
  /**
   * The round file states THREE things. Scraping its digits concatenates all
   * of them, so round 2 under a budget of 3 records as 23 — and every round
   * number in the ledger is then wrong in a way that is silent and permanent.
   *
   * The reviewer that found this named the fixture as the fix, and that is
   * the real lesson: a one-number fixture makes a scrape and a parse agree
   * on every row, so the battery was 5 of 5 against a defect it structurally
   * could not express. Seventh shape — the battery varied the guard and held
   * the input's SHAPE fixed.
   */
  test("AC-L7: round 2 under a budget of 3 records 2, not 23", () => {
    const r = runPersist({ round: "2", payload: ONE_FINDING });
    expect(r.rounds![0].round).toBe(2);
  });

  test("AC-L7: a two-digit round under a two-digit budget is still read whole", () => {
    // 12 and 34 concatenate to 1234 under a scrape, and to 12 under a parse.
    const r = runPersist({
      rawRound: "review_round=12\nround_budget=34\nround_budget_spent=no\n",
      payload: ONE_FINDING,
    });
    expect(r.rounds![0].round).toBe(12);
  });

  test("AC-L7: a CRLF round file is still read", () => {
    const r = runPersist({
      rawRound: "review_round=7\r\nround_budget=3\r\nround_budget_spent=no\r\n",
      payload: ONE_FINDING,
    });
    expect(r.rounds![0].round).toBe(7);
  });

  test("AC-L7: a round file with no review_round line records null, not a guess", () => {
    const r = runPersist({
      rawRound: "round_budget=3\nround_budget_spent=no\n",
      payload: ONE_FINDING,
    });
    expect(r.rounds![0].round).toBeNull();
  });

  test("AC-L7: the MUTANT — scraping the digits — reports the concatenation", () => {
    // The defect as it shipped to review, performed and observed, so the row
    // above cannot go green for an unrelated reason later.
    const real = buildPersistScript();
    const mutant = real.replace(
      /parsed_round=\$\(tr -d '\\r'[^\n]*\n/,
      "parsed_round=$(tr -dc '0-9' < \"${AI_REVIEW_ROUND_PATH}\" | head -c 8 || true)\n",
    );
    expect(mutant, "the mutation did not apply").not.toBe(real);
    const r = runPersist({ round: "2", payload: ONE_FINDING, script: mutant });
    expect(r.rounds![0].round, "the scrape must concatenate — that is the defect").toBe(23);
  });
});

describe("AC-L8 (#1319 review): the ledger is identified by AUTHOR, not by a string", () => {
  /**
   * The marker is a string, and a pull request is a place anyone can paste
   * one. Selecting on it alone lets any commenter nominate their own comment
   * as the ledger: this step then PATCHes a human's text away and writes the
   * round history somewhere nobody is watching.
   */
  const HUMAN_IMPOSTOR = {
    id: 99,
    user: { type: "User", login: "someone" },
    body: ledgerBody([{ at: "t0", run: "planted", round: 1, findings: [] }]),
  };

  test("AC-L8: a HUMAN comment carrying the marker is not adopted", () => {
    const r = runPersist({ list: [HUMAN_IMPOSTOR], payload: ONE_FINDING });
    expect(r.method, "it PATCHed a human's comment").toBe("POST");
    expect(r.rounds, "it inherited rounds from a comment anyone could write").toHaveLength(1);
  });

  test("AC-L8 CONTROL: the same body from a BOT is adopted", () => {
    // One axis: identical marker, identical body, different author.
    const r = runPersist({
      list: [{ ...HUMAN_IMPOSTOR, user: { type: "Bot", login: "github-actions[bot]" } }],
      payload: ONE_FINDING,
    });
    expect(r.method).toBe("PATCH");
  });

  test("AC-L8: the OLDEST bot ledger wins, not the newest", () => {
    // `last` would prefer whichever was posted most recently, which is the
    // one an impersonating bot would have just created. The real ledger is
    // the one this step made on round one.
    const r = runPersist({
      list: [
        { id: 10, user: { type: "Bot", login: "github-actions[bot]" }, body: ledgerBody([{ at: "t0", run: "original", round: 1, findings: [] }]) },
        { id: 20, user: { type: "Bot", login: "github-actions[bot]" }, body: ledgerBody([{ at: "t1", run: "newer", round: 1, findings: [] }]) },
      ],
      payload: ONE_FINDING,
    });
    expect(r.argv.join(" ")).toContain("/issues/comments/10");
    expect(r.rounds![0].run).toBe("original");
  });

  test("AC-L8: the MUTANT — marker alone, newest wins — adopts the impostor", () => {
    const real = buildPersistScript();
    // BOTH authorship clauses have to come out. When the login clause was
    // added (#1168), this mutation half-applied: the type check was stripped,
    // the login check survived and still rejected the impostor, and the
    // mutant reported POST — indistinguishable from a guard that held. The
    // old `expect(mutant).not.toBe(real)` was green throughout, because
    // something HAD changed. Assert the population, not that it differs.
    const AUTHOR_CLAUSES = [
      '(.user.type? // "") == "Bot" and ',
      '(.user.login? // "") == $login and ',
    ];
    let mutant = real;
    for (const clause of AUTHOR_CLAUSES) {
      expect(real, `the mutation site is not in the script: ${clause}`).toContain(clause);
      mutant = mutant.replace(clause, "");
    }
    mutant = mutant.replace("] | first // empty", "] | last // empty");
    for (const clause of AUTHOR_CLAUSES) {
      expect(mutant, `a clause survived the mutation: ${clause}`).not.toContain(clause);
    }
    const r = runPersist({ list: [HUMAN_IMPOSTOR], payload: ONE_FINDING, script: mutant });
    expect(r.method, "the mutant must adopt it — that is the defect").toBe("PATCH");
  });
});

describe("AC-L2 (#1168): `null` findings and `[]` findings stay different facts", () => {
  test("AC-L2: a payload that was READ and empty records []", () => {
    const r = runPersist({ payload: { findings: [] } });
    expect(r.rounds![0].findings).toEqual([]);
  });

  test("AC-L2: NO payload at all records null, not []", () => {
    // Collapsing these converts "the reviewer did not run" into "the reviewer
    // was happy" — Silent Default Substitution, in the one record meant to
    // make the finding set cumulative.
    const r = runPersist({ payload: undefined });
    expect(r.rounds![0].findings).toBeNull();
  });

  test("AC-L2: an UNPARSEABLE payload records null and says UNMEASURED out loud", () => {
    const r = runPersist({ payload: "{not json" });
    expect(r.rounds![0].findings).toBeNull();
    expect(r.stdout).toContain("UNMEASURED");
  });
});

/**
 * #1352 — AC-L2 above varies ONE axis: whether the payload parses. Every one
 * of its three rows is a different answer to that question, and all three are
 * handled correctly. The defect sat on the axis it holds fixed — **the shape
 * of the value once it HAS parsed** — which is the seventh shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`: a battery whose rows all
 * meet the same precondition cannot come back wrong about an input nobody
 * wrote.
 *
 * `jq '[ .findings[]? | … ]'` exits 0 on a document that parses but carries
 * no array under `findings`, because `?` suppresses the iteration error. The
 * comprehension yields `[]`, and `[]` is this ledger's spelling of *a round
 * that was read and was clean* — three lines above the jq, in its own words.
 *
 * Measured against jq before this battery was written, so the rows below are
 * a reading rather than a guess: of ten shapes, **six recorded `[]`** and
 * three already refused. `{"findings":{"a":1}}` is one of the three and is
 * right for the wrong reason — it fails when the projection hits a number,
 * not because anything checked the shape.
 */
const SHAPE_CORPUS: {
  name: string;
  /** `undefined` plants no file. Otherwise the payload's exact bytes. */
  raw: string | undefined;
  /** What the ledger must record. `[]` only for a real, readable list. */
  records: "null" | "list";
  /**
   * Whether the step must also SAY so on stdout.
   *
   * True exactly when a file is present and could not be read: that is a
   * surprise, and the note is the only place it appears. False for the
   * absent-file row, and this is a correction to the first draft of this
   * battery rather than a concession — I predicted that row green, it came
   * back red, and the cause was the assertion and not the code. A payload
   * that was never written is already the adjudicator's own loud refusal
   * (`FINDINGS_FILE_ABSENT`), and the ledger's `null` records it durably. A
   * second announcement of a state another step already fails on is noise,
   * and demanding one here would have been this battery inventing a defect.
   */
  notes?: true;
}[] = [
  { name: "no payload at all", raw: undefined, records: "null" },
  { name: "not JSON", raw: "{not json", records: "null", notes: true },
  { name: "an object with no findings key", raw: "{}", records: "null", notes: true },
  { name: "findings is null", raw: '{"findings":null}', records: "null", notes: true },
  { name: "findings is a string", raw: '{"findings":"oops"}', records: "null", notes: true },
  { name: "findings is a number", raw: '{"findings":3}', records: "null", notes: true },
  { name: "findings is an empty object", raw: '{"findings":{}}', records: "null", notes: true },
  { name: "findings is a populated object", raw: '{"findings":{"a":1}}', records: "null", notes: true },
  { name: "the document is an array", raw: "[]", records: "null", notes: true },
  { name: "the document is a string", raw: '"str"', records: "null", notes: true },
  { name: "the document is null", raw: "null", records: "null", notes: true },
  // The two controls. Without them a mutant that recorded `null` for
  // EVERYTHING would pass every row above, which is the cheapest wrong fix
  // available here and the one a reader reaches for first.
  //
  // Both are COMPLETE payloads — `verdict`, and `failure_scenario` on the
  // blocking finding. The first draft omitted them and AC-L10 caught it: the
  // adjudicator refused both controls with `VERDICT_ABSENT` and
  // `BLOCKING_FINDING_INCOMPLETE`, which are adjudication requirements and
  // not shape ones, so the disagreement was my fixture being unlike anything
  // a reviewer writes rather than the two readers differing. A control that
  // is not a realistic input cannot control anything.
  { name: "CONTROL: a readable empty list", raw: '{"findings":[],"verdict":"PASS"}', records: "list" },
  {
    name: "CONTROL: a readable list with one finding",
    raw:
      '{"findings":[{"severity":"high","file":"a.ts","line":1,"summary":"s",' +
      '"failure_scenario":"given x, returns y"}],"verdict":"BLOCK"}',
    records: "list",
  },
];

describe("AC-L9 (#1352): a payload that PARSES but is not a list is UNMEASURED, not a clean round", () => {
  for (const shape of SHAPE_CORPUS) {
    test(`AC-L9: ${shape.name} records ${shape.records === "null" ? "null" : "a list"}`, () => {
      const r = runPersist({ payload: shape.raw });
      const recorded = r.rounds![0].findings;

      if (shape.records === "null") {
        expect(
          recorded,
          `recorded ${JSON.stringify(recorded)}. An empty list is this ledger's spelling of "a ` +
            `round that was read and was clean", so recording one here converts a payload ` +
            `nobody could read into a clean review — and the round cap counts it as converged`,
        ).toBeNull();
        if (shape.notes) {
          expect(
            r.stdout,
            "a payload was on disk and could not be read, and the step said nothing about it — " +
              "the note is the only place that surprise appears",
          ).toContain("UNMEASURED");
        }
      } else {
        expect(recorded, "a readable list was discarded as unmeasured").not.toBeNull();
        expect(Array.isArray(recorded)).toBe(true);
      }
    });
  }
});

describe("AC-L10 (#1352): the ledger and the adjudicator agree about what is unreadable", () => {
  /**
   * The defect was never one wrong branch — it was **two readers of the same
   * payload disagreeing about what it means**, which is the thing that will
   * drift again. So this binds them.
   *
   * It is a CHECK and not an import, and that is deliberate rather than
   * unfinished: `lib/scaffold/ai-review-step.ts` is import-free because many
   * suites copy it into a tmpdir to build mutants, where no relative
   * specifier resolves — the same reason, and the same remedy, as the
   * `lib/git-isolation.ts` binding that module already documents. The test
   * imports both; neither production file imports the other.
   *
   * SCOPE, stated because a binding that does not state one gets read as
   * wider than it is: this agrees about **payload shape** — is there a list
   * of findings here at all. It deliberately does NOT agree about per-item
   * severity, and the row below asserts that divergence rather than
   * excluding it, so nobody later "fixes" the ledger into adjudicating.
   */
  test("AC-L10: every shape the adjudicator refuses, the ledger records as null", () => {
    const disagreements: string[] = [];

    for (const shape of SHAPE_CORPUS) {
      const reader = readAiReviewFindings(shape.raw === undefined ? null : shape.raw);
      const readerUnmeasured = reader.outcome === "UNMEASURED";
      const ledgerNull = runPersist({ payload: shape.raw }).rounds![0].findings === null;

      if (readerUnmeasured !== ledgerNull) {
        disagreements.push(
          `${shape.name}: adjudicator says ${reader.outcome} ` +
            `(${reader.unmeasuredReasons.join(", ") || "no refusal"}), ledger records ` +
            `${ledgerNull ? "null" : "a list"}`,
        );
      }
    }

    expect(
      disagreements,
      "two readers of the same payload disagree about whether it is readable. That is #1352 " +
        "itself: the ledger's `[]` and the adjudicator's UNMEASURED describe the same bytes and " +
        "mean opposite things. Make them agree, or state the divergence here deliberately the " +
        "way the severity row below does",
    ).toEqual([]);
  });

  test("AC-L10: severity adjudication is the ONE deliberate divergence, and it is asserted", () => {
    // The ledger stores what was FOUND; what it means stays with the
    // adjudicator — the step's own docblock says so. An unrecognised severity
    // is therefore a round the ledger records and the adjudicator refuses,
    // and that is correct. Asserted rather than filtered out of the corpus,
    // so a later change that collapses it has to come through here.
    const raw = '{"findings":[{"severity":"nonsense","file":"a.ts","line":1,"summary":"s"}]}';

    expect(readAiReviewFindings(raw).outcome).toBe("UNMEASURED");
    expect(
      runPersist({ payload: raw }).rounds![0].findings,
      "the ledger stopped recording a finding whose severity it is not the judge of",
    ).toHaveLength(1);
  });
});

describe("AC-L3 (#1168): it never writes on top of a read it could not take", () => {
  /**
   * The most destructive thing this step could do: replace a ledger holding
   * N rounds with one holding this round. Afterwards it is indistinguishable
   * from a first round, so this is the case that matters most.
   */
  test("AC-L3: a FAILED comment read writes nothing at all", () => {
    const r = runPersist({ list: null, payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "it wrote a ledger on top of a read that failed").toBeNull();
    expect(r.sentRaw).toBeNull();
    expect(r.stdout).toContain("NOT recorded");
  });

  test("AC-L3: an existing ledger whose payload will not parse is NOT replaced", () => {
    const broken = `${AI_REVIEW_LEDGER_MARKER}\n\n\`\`\`json\n{not an array\n\`\`\``;
    const r = runPersist({ list: [botComment(5, broken)], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "it overwrote a ledger it could not read").toBeNull();
  });

  test("AC-L3 CONTROL: with a READABLE list and ledger it does write", () => {
    // Without this, both rows above are satisfied by a step that never
    // writes under any circumstances.
    const r = runPersist({ list: [], payload: ONE_FINDING });
    expect(r.method).toBe("POST");
  });

  test("AC-L3: the id and the body come from ONE selection, so they cannot disagree", () => {
    // Found by the battery, not by reading. Two independent marker searches
    // can land in a state where the id is empty and the body is not, and
    // that state POSTs a SECOND ledger carrying the first one's rounds —
    // the history forks into two comments and neither is complete.
    const script = buildPersistScript();
    const searches = script.match(/contains\(\\?\$m\)/g) ?? [];
    expect(
      searches.length,
      "the ledger comment is searched for more than once; select it once and read both fields out of that",
    ).toBe(1);
  });

  test("AC-L3: the MUTANT — the failed-read guard removed — overwrites the ledger", () => {
    // The guard removed and nothing else, through the identical rig. This is
    // the cheapest wrong implementation: carry on with an empty page.
    //
    // #1353 moved this branch inside the pagination loop, so it is indented
    // four spaces and the old two-space pattern ran past it to a LATER
    // `exit 0`, deleting a span that included other refusals. The mutant
    // still differed from the real script and still wrote nothing, so the
    // row went red looking like a behavioural finding. That is the seventh
    // shape — a mutation that did not apply as spelled reads exactly like
    // the guard behaving differently — so the survival assertions below are
    // part of the experiment, not decoration.
    const real = buildPersistScript();
    const mutant = real.replace(
      /    ledger_note "the pull request's comments could not be read[\s\S]*?\n    exit 0\n/,
      '    page_body="[]"\n',
    );
    expect(mutant, "the mutation did not apply").not.toBe(real);
    expect(
      real.length - mutant.length,
      "the replacement swallowed more than the one branch it names",
    ).toBeLessThan(600);
    for (const survives of ["more than", "came back as something other than a JSON array"]) {
      expect(mutant, `the mutation deleted an unrelated refusal (${survives})`).toContain(survives);
    }
    const r = runPersist({ list: null, payload: ONE_FINDING, script: mutant });
    expect(r.method, "the mutant must write — that is the defect this guards").toBe("POST");
  });
});

describe("AC-L4 (#1168): it is a recorder, so it never fails the job", () => {
  const cases: Array<[string, Rig]> = [
    ["no pull request (merge_group)", { env: { [AI_REVIEW_LEDGER_PR_VAR]: "" } }],
    ["no token", { env: { [AI_REVIEW_LEDGER_TOKEN_VAR]: "" } }],
    ["no repository", { env: { [AI_REVIEW_LEDGER_REPO_VAR]: "" } }],
    ["the comment read fails", { list: null }],
    ["the write fails", { writeFails: true }],
    ["no findings payload", { payload: undefined }],
    ["an unparseable payload", { payload: "{" }],
    ["an unreadable existing ledger", { list: [botComment(5, `${AI_REVIEW_LEDGER_MARKER}\nnope`)] }],
  ];
  for (const [name, rig] of cases) {
    test(`AC-L4: ${name} exits 0`, () => {
      const r = runPersist({ payload: ONE_FINDING, ...rig });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    });
  }

  test("AC-L4: a merge_group run writes nothing and says nothing", () => {
    // Not a gap worth annotating: a queue entry is not a review round, and a
    // warning on every merge_group run is a warning nobody reads.
    const r = runPersist({ env: { [AI_REVIEW_LEDGER_PR_VAR]: "" } });
    expect(r.method).toBeNull();
    expect(r.stdout.trim()).toBe("");
  });
});

describe("AC-L6 (#1168): a write that landed nothing is said out loud", () => {
  /**
   * Two rounds of one pull request racing on one comment lose an entry
   * without either request failing. This cannot prevent that — a
   * read-modify-write over a REST comment has no compare-and-swap — but a
   * lost round that nobody can see is the failure this whole step exists to
   * end, so it is at least reported.
   *
   * Added because the mutation battery predicted, correctly, that removing
   * the read-back reddened nothing. An uncovered safeguard is a safeguard
   * that will be deleted by the next person who finds it noisy.
   */
  test("AC-L6: a response not carrying this run's id warns about a lost entry", () => {
    const r = runPersist({
      payload: ONE_FINDING,
      env: { STUB_WRITE_RESPONSE: JSON.stringify({ id: 5, body: "someone else's ledger" }) },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("concurrent write");
  });

  test("AC-L6 CONTROL: a response that DOES carry it stays quiet", () => {
    // Without this the row above is satisfied by a step that warns on every
    // successful write, which is a warning nobody would read for long.
    const r = runPersist({ payload: ONE_FINDING });
    expect(r.stdout).not.toContain("concurrent write");
  });
});

// #1353. AC-L3 established that a FAILED read writes nothing. The hole was
// the read that SUCCEEDS and still yields no usable list — curl exiting 0, or
// the ledger sitting on a page nobody asked for. Both produced an empty
// selection, which is byte-identical to "this pull request has no ledger yet",
// and the step POSTed a fresh one over the top.
//
// So these cases are not written against "the ledger works". They are written
// against the property the defect destroyed: THE THREE STATES STAY
// DISTINGUISHABLE — found, read-to-the-end-and-absent, unreadable. A test
// asserting only that a ledger gets written passes against every row below.
describe("AC-L9 (#1353): a read that returns nothing usable is not a pull request with no ledger", () => {
  // `at` and `run` are REQUIRED, not decoration: #1386's shape guard refuses a
  // payload whose entries lack them, and a refused payload produces exactly the
  // observable these cases are about — no write, step exits 0. A fixture
  // missing them would make every row below red for a reason that has nothing
  // to do with pagination.
  const LEDGER = () => botComment(5, ledgerBody([{ at: "t0", run: "original", round: 1, findings: [] }]));
  const filler = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => botComment(from + i, "ordinary comment"));

  test("stderr on a SUCCESSFUL transfer does not corrupt the body — the `2>&1`", () => {
    // curl exits 0 and writes a diagnostic. Merged into stdout it makes the
    // body unparseable, the selection empty, and the step starts again.
    const r = runPersist({
      list: [LEDGER()],
      listStderr: "Warning: Problem transient. Will retry in 1 seconds.",
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "a warning on stderr made the step lose the ledger").toBe("PATCH");
    expect(r.rounds, "the prior round was dropped").toHaveLength(2);
  });

  test("a 200 whose body is not an array refuses, and writes nothing", () => {
    const r = runPersist({ listRaw: '{"message":"Not Found"}', payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "it started a fresh ledger on a body it could not read").toBeNull();
    expect(r.sentRaw).toBeNull();
    expect(r.stdout).toContain("NOT recorded");
  });

  test("a body that is not JSON at all refuses, and writes nothing", () => {
    const r = runPersist({ listRaw: "<html>502 Bad Gateway</html>", payload: ONE_FINDING });
    expect(r.method).toBeNull();
    expect(r.stdout).toContain("NOT recorded");
  });

  test("a ledger on the SECOND page is found, not replaced", () => {
    // The population this matters for: a pull request with more than 100
    // comments, which is exactly a long-running one with many review rounds.
    const r = runPersist({
      pages: [filler(100, 100), [LEDGER()]],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "a ledger past the first page was not found").toBe("PATCH");
    expect(r.rounds).toHaveLength(2);
  });

  test("the OLDEST match still wins when matches sit on different pages", () => {
    // `first`, across pages. An impersonator's comment is newer, so it lands
    // later; breaking on the earliest page carrying a match preserves the
    // property the single-page selection already had.
    const r = runPersist({
      pages: [
        [...filler(99, 200), botComment(5, ledgerBody([{ at: "t0", run: "original", round: 1, findings: [] }]))],
        [botComment(999, ledgerBody([]))],
      ],
      payload: ONE_FINDING,
    });
    expect(r.method).toBe("PATCH");
    expect(r.argv.join(" "), "it patched the newer comment").toContain("/comments/5");
  });

  test("exhausting the page bound refuses rather than concluding there is none", () => {
    // A loop bound is not a reading. Every page full and no match means the
    // ledger may be on the page after the last one looked at.
    const pages = Array.from({ length: AI_REVIEW_LEDGER_MAX_PAGES + 1 }, (_, i) => filler(100, i * 100));
    const r = runPersist({ pages, payload: ONE_FINDING });
    expect(r.method, "it started a fresh ledger after giving up on a list it had not finished").toBeNull();
    expect(r.stdout).toContain("NOT recorded");
  });

  // THE CONTROL, and the reason the rows above are not satisfied by a step
  // that refuses everything. This is the third state: the list WAS read to
  // its end and genuinely holds no ledger. It must still POST, or the first
  // round of every pull request is lost.
  test("CONTROL: a short page with no ledger is read to the end, and DOES post", () => {
    const r = runPersist({ pages: [filler(3, 100)], payload: ONE_FINDING });
    expect(r.method, "a genuine first round stopped being recorded").toBe("POST");
    expect(r.rounds).toHaveLength(1);
  });

  test("CONTROL: an empty first page is also read to the end, and DOES post", () => {
    const r = runPersist({ pages: [[]], payload: ONE_FINDING });
    expect(r.method).toBe("POST");
  });

  // The property itself, stated as one assertion rather than inferred from
  // the rows above: the unreadable state and the absent state must not
  // produce the same observable. If a later change collapses them again,
  // this is the case that says so.
  test("unreadable and absent are not the same observable", () => {
    const unreadable = runPersist({ listRaw: "<html>502</html>", payload: ONE_FINDING });
    const absent = runPersist({ pages: [[]], payload: ONE_FINDING });
    expect(unreadable.method).toBeNull();
    expect(absent.method).toBe("POST");
    expect(unreadable.method).not.toBe(absent.method);
  });

  test("it paginates with a page parameter at all", () => {
    // A positive control on the mechanism: the rows above would also pass
    // against a step that happened to request page 2 by luck of the fixture.
    const r = runPersist({ pages: [filler(100, 0), [LEDGER()]], payload: ONE_FINDING });
    expect(r.argv.join(" ")).toContain("page=2");
  });
});

describe("AC-L5 (#1168): the committed workflow carries the step, in position", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  test("AC-L5: the step is present and the ledger permission is granted", () => {
    expect(yml).toContain(`id: ${AI_REVIEW_PERSIST_STEP_ID}`);
    expect(yml).toContain("pull-requests: write");
  });

  /**
   * Ordering is the whole reason this step needs no `if:`. The adjudicator
   * exits non-zero on a blocking finding, so a ledger after it would record
   * clean rounds and drop blocked ones — biased against exactly the rounds
   * worth recording.
   */
  test("AC-L5: it runs AFTER the reviewer and BEFORE the adjudicator", () => {
    const at = (needle: string) => {
      const i = yml.indexOf(needle);
      expect(i, `${needle} is not in the committed workflow`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("id: ai-review-action")).toBeLessThan(at(`id: ${AI_REVIEW_PERSIST_STEP_ID}`));
    expect(at(`id: ${AI_REVIEW_PERSIST_STEP_ID}`)).toBeLessThan(at("id: ai-review-run"));
  });

  test("AC-L5: the step carries no `if:`, which this job does not allow", () => {
    // A step skipped by a condition reports `skipped`, and this workflow's
    // doctrine is that nothing here may. Read the step's own block rather
    // than the file: an `if:` belonging to another step is not this one's.
    const start = yml.indexOf(`id: ${AI_REVIEW_PERSIST_STEP_ID}`);
    const block = yml.slice(start, yml.indexOf("\n      - name:", start));
    expect(block.length, "the step block could not be isolated").toBeGreaterThan(200);
    expect(block).not.toContain("\n        if:");
  });
});

/**
 * AC-L9 (#1168): the anchor a later round resolves against.
 *
 * The reading half keys a finding on the TEXT at its cited line, because the
 * one repeat this repository can demonstrate moved `:318` → `:375` between
 * rounds while staying byte-identical. The next round cannot read that text
 * for itself — `actions/checkout` runs at `fetch-depth: 1`, so the commit the
 * finding was raised against is not in its checkout — so this step records it
 * at the moment it is still true.
 *
 * Every row here EXECUTES the generated script against a planted checkout.
 * The step asserting the script merely *contains* `sed` would go green on a
 * `sed` that reads the wrong line, which is the failure that matters: a wrong
 * text does not look wrong, it resolves a live finding away.
 */
/** Whether the entry carries an anchor at all. `""` is one; absent is not. */
function hasText(finding: Record<string, unknown>): boolean {
  return Object.hasOwn(finding, AI_REVIEW_LEDGER_TEXT_FIELD);
}

describe("AC-L9 (#1168): the cited line's text is recorded out of the checkout", () => {
  const SRC = "line one\nline two\n  await symlink(target, path);\nline four\n";

  test("AC-L9: the text recorded is the content AT the cited line", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": SRC },
      payload: { findings: [{ severity: "high", file: "lib/a.ts", line: 3, summary: "unsafe" }] },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings[0].text).toBe("  await symlink(target, path);");
  });

  test("AC-L9: an off-by-one would be invisible without naming the line, so name it", () => {
    // Line 1 and line 3 of the same file. A reader that always took the first
    // line, or always the last, passes the row above and fails this one.
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": SRC },
      payload: {
        findings: [
          { severity: "high", file: "lib/a.ts", line: 1, summary: "a" },
          { severity: "low", file: "lib/a.ts", line: 4, summary: "b" },
        ],
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings.map((f: any) => f.text)).toEqual(["line one", "line four"]);
  });

  test("AC-L9: the join is positional — each finding keeps its OWN text", () => {
    // Two files, so a join that pairs the wrong text with the wrong finding
    // produces a visible swap rather than two identical strings.
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "alpha\n", "lib/b.ts": "beta\n" },
      payload: {
        findings: [
          { severity: "high", file: "lib/a.ts", line: 1, summary: "a" },
          { severity: "high", file: "lib/b.ts", line: 1, summary: "b" },
        ],
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings.map((f: any) => [f.file, f.text])).toEqual([
      ["lib/a.ts", "alpha"],
      ["lib/b.ts", "beta"],
    ]);
  });

  test("AC-L9: a path outside the checkout is REFUSED, not read", () => {
    // The reviewer chooses `file`, and this step copies a line of it into a
    // public comment. Each of these resolves to a real, readable file with
    // distinctive contents; an empty text is the refusal, and the contents
    // are what a leak would look like.
    const secret = join(tmpdir(), `ledger-secret-${process.pid}.txt`);
    writeFileSync(secret, "THE-SECRET-LINE\n");
    try {
      const r = runPersist({
        list: [],
        files: { "lib/a.ts": "alpha\n" },
        payload: {
          findings: [
            { severity: "high", file: secret, line: 1, summary: "absolute" },
            { severity: "high", file: "../../etc/hosts", line: 1, summary: "climbing" },
            { severity: "high", file: "lib/a.ts", line: 1, summary: "control" },
          ],
        },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.sentRaw, "an absolute path was read into a public comment").not.toContain(
        "THE-SECRET-LINE",
      );
      // A refusal records NO anchor — see AC-L12. The control is what makes
      // the two absences above a refusal rather than a step that recorded
      // nothing at all.
      expect(r.rounds![0].findings.map((f: any) => hasText(f))).toEqual([false, false, true]);
      expect(r.rounds![0].findings[2].text).toBe("alpha");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  test("AC-L9: an unreadable or absent anchor records NO anchor, and never fails", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "alpha\n" },
      payload: {
        findings: [
          { severity: "high", file: "lib/missing.ts", line: 1, summary: "no such file" },
          { severity: "high", file: "lib/a.ts", line: 999, summary: "past the end" },
          { severity: "high", file: "lib/a.ts", summary: "no line at all" },
          { severity: "high", summary: "no file at all" },
        ],
      },
    });
    // The recorder observes; it never fails the job it is observing (#1110).
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings.map((f: any) => hasText(f))).toEqual([false, false, false, false]);
  });

  /**
   * AC-L14 (#1406) — "no anchor" and "the anchor is a blank line" are two
   * facts, and the recorder wrote one value for both.
   *
   * `rt=""` was the initial value AND the value left behind by every path
   * where the text could not be determined: a refused path spelling, an
   * absent or non-numeric line, a file not in the index, a line past the end
   * of the file. It was also what a genuinely blank cited line produces.
   *
   * The reader's undecidable test is `typeof recordedText !== "string"`, and
   * `""` is a string — so all four failure paths went to the comparison, and
   * a finding whose anchor was never obtained was dropped as RESOLVED the
   * moment the cited line had any content. That is #1351's defect one value
   * over: the repair closed the route through an absent field and left the
   * route through an empty one.
   *
   * The fix is in the recorder because the recorder is the only thing that
   * knows which branch it took. `recordedText === ""` at the reader would be
   * the wrong fix in the other direction — a finding on a line that really is
   * blank would become permanently uncarryable-away.
   */
  describe("AC-L14 (#1406): a missing anchor is absent, a blank anchor is empty", () => {
    const WITH_BLANK = "alpha\n\ngamma\n";

    test("AC-L14: a genuinely blank cited line records an EMPTY anchor, present", () => {
      const r = runPersist({
        list: [],
        files: { "lib/a.ts": WITH_BLANK },
        payload: { findings: [{ severity: "high", file: "lib/a.ts", line: 2, summary: "blank" }] },
      });
      expect(r.status, r.stderr).toBe(0);
      const f = r.rounds![0].findings[0];
      expect(hasText(f), "a blank line is a reading and must be recorded as one").toBe(true);
      expect(f.text).toBe("");
    });

    test.each([
      ["a refused absolute path", { file: "/etc/hosts", line: 1 }],
      ["a path climbing out", { file: "../../etc/hosts", line: 1 }],
      ["a path spelling an option", { file: "--expression=e id", line: 1 }],
      ["a file not in the index", { file: "lib/missing.ts", line: 1 }],
      ["no line number", { file: "lib/a.ts" }],
      ["a zero line", { file: "lib/a.ts", line: 0 }],
      ["a line past the end", { file: "lib/a.ts", line: 99 }],
    ])("AC-L14: %s records NO anchor, not an empty one", (_label, over) => {
      const r = runPersist({
        list: [],
        files: { "lib/a.ts": WITH_BLANK },
        payload: { findings: [{ severity: "high", summary: "s", ...over }] },
      });
      expect(r.status, r.stderr).toBe(0);
      const f = r.rounds![0].findings[0];
      expect(
        hasText(f),
        `recorded ${JSON.stringify(f.text)} — an unread anchor is UNDECIDABLE, and an empty ` +
          "string resolves the finding away the moment the cited line has content",
      ).toBe(false);
    });

    test("AC-L14: the two cases sit in ONE payload and stay apart", () => {
      // The row that fails under a recorder which simply stopped emitting the
      // field at all: the blank anchor is real and must survive.
      const r = runPersist({
        list: [],
        files: { "lib/a.ts": WITH_BLANK },
        payload: {
          findings: [
            { severity: "high", file: "lib/a.ts", line: 1, summary: "content" },
            { severity: "high", file: "lib/a.ts", line: 2, summary: "blank" },
            { severity: "high", file: "lib/a.ts", line: 99, summary: "past the end" },
            { severity: "high", file: "/etc/hosts", line: 1, summary: "refused" },
          ],
        },
      });
      expect(r.status, r.stderr).toBe(0);
      const fs = r.rounds![0].findings;
      expect(fs.map(hasText)).toEqual([true, true, false, false]);
      expect(fs.map((f: any) => f.text)).toEqual(["alpha", "", undefined, undefined]);
      // Positional: the join must not have shifted the survivors up into the
      // slots the absences vacated.
      expect(fs.map((f: any) => f.summary)).toEqual([
        "content",
        "blank",
        "past the end",
        "refused",
      ]);
    });

    test("AC-L14: the reader carries the absent anchor and resolves the blank one", () => {
      // The end of the chain the recorder exists for. Both findings go into
      // `carryForward` against a round where the cited line now has content:
      // the one with no anchor is UNDECIDABLE and carried, the one recorded
      // as genuinely blank is resolved and dropped.
      const r = runPersist({
        list: [],
        files: { "lib/a.ts": WITH_BLANK },
        payload: {
          findings: [
            { severity: "high", file: "lib/a.ts", line: 2, summary: "was blank" },
            { severity: "high", file: "lib/a.ts", line: 99, summary: "never read" },
          ],
        },
      });
      expect(r.status, r.stderr).toBe(0);
      const carried = carryForward(
        r.rounds![0].findings.map((f: any) => ({
          finding: f,
          recordedText: f[AI_REVIEW_LEDGER_TEXT_FIELD],
        })),
        () => "the line has content now",
      );
      expect(carried.map((f: any) => f.summary), "an unread anchor was resolved away").toEqual([
        "never read",
      ]);
    });
  });

  test("AC-L9: a round with no findings still writes a well-formed entry", () => {
    const r = runPersist({ list: [], files: { "lib/a.ts": "alpha\n" }, payload: { findings: [] } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings).toEqual([]);
    expect(r.rounds![0].identity).toBe(AI_REVIEW_LEDGER_IDENTITY_V1);
  });

  test("AC-L9: an UNMEASURED round records findings null and stamps no false anchor", () => {
    // `null` and `[]` stay different all the way through the new annotation.
    const r = runPersist({ list: [], payload: "{ not json" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings).toBeNull();
  });
});

/**
 * AC-L10 (#1168): the ALLOW direction of the ledger's identity check.
 *
 * Every case above asks "is the ledger found when it should be". None asked
 * "is it left alone when it should be" — and a narrowing can only regress in
 * that direction, silently, because a step that adopts too much still passes
 * every case about adoption.
 *
 * `user.type == "Bot"` is a CLASS. Every GitHub App installed on a
 * repository is `type: Bot`, so the original filter narrowed the impostor
 * set from "anyone who can comment" to "any installed app" — a bar an app
 * with comment scope clears. The rows below vary ONE axis: identical marker,
 * identical body, different author.
 */
describe("AC-L10 (#1168): a comment this step did not write is never adopted", () => {
  const PLANTED = ledgerBody([{ at: "t0", run: "planted", round: 1, findings: [] }]);

  test("AC-L10: a DIFFERENT bot login carrying the marker is NOT adopted", () => {
    // The negative control. `type: Bot` is true of this comment, so the row
    // passes under the old filter and fails under it only once the login is
    // bound — which is exactly the regression direction nothing else covers.
    const r = runPersist({
      list: [{ id: 42, user: { type: "Bot", login: "dependabot[bot]" }, body: PLANTED }],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "it PATCHed another app's comment").toBe("POST");
    expect(
      r.rounds,
      "it inherited rounds from a comment another GitHub App wrote",
    ).toHaveLength(1);
    expect(JSON.stringify(r.rounds)).not.toContain("planted");
  });

  test("AC-L10 CONTROL: the same body from THIS login is adopted", () => {
    // Without this row the case above is green under a step that adopts
    // nothing at all — including the ledger it wrote itself.
    const r = runPersist({
      list: [{ id: 42, user: { type: "Bot", login: AI_REVIEW_LEDGER_BOT_LOGIN }, body: PLANTED }],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "it refused to adopt its own ledger").toBe("PATCH");
    expect(r.rounds, "the earlier round was dropped").toHaveLength(2);
  });

  test("AC-L10: the login is a class, so the MARKER has to be the thing nothing else writes", () => {
    // The conjunction's load-bearing term, asserted rather than asserted in
    // prose. `github-actions[bot]` is every GITHUB_TOKEN workflow in this
    // repository, so if a second workflow ever emitted this marker the login
    // check would not tell them apart. One writer, checked.
    const emitters = spawnSync(
      "git",
      ["grep", "-l", "-F", "--", AI_REVIEW_LEDGER_MARKER, "--", ".github/workflows"],
      { cwd: REPO, encoding: "utf8" },
    );
    const files = (emitters.stdout ?? "").split("\n").filter(Boolean);
    // Control: the detector finds the marker where it demonstrably is. A
    // `git grep` that matched nothing reads exactly like "one writer".
    expect(
      files,
      "the marker was found in no workflow at all, so this search proves nothing",
    ).toContain(".github/workflows/ai-review.yml");
    expect(
      files,
      "a second workflow emits the ledger marker, so the login check can no longer " +
        "tell this step's comment from that one's",
    ).toEqual([".github/workflows/ai-review.yml"]);
  });
});

/**
 * AC-L11 (#1168): the prior payload is state parsed out of a comment body.
 *
 * Whatever survives the check below is re-serialised into the next comment,
 * so one malformed entry adopted once is permanent.
 */
describe("AC-L11 (#1168): the prior ledger is validated by shape, and capped", () => {
  test("AC-L11: an array of NON-objects is refused, not adopted", () => {
    // `type == "array"` alone passes every one of these.
    for (const junk of [["a string"], [42], [null], [["nested"]], [{ at: "t" }]]) {
      const r = runPersist({ list: [botComment(5, ledgerBody(junk))], payload: ONE_FINDING });
      expect(r.status, r.stderr).toBe(0);
      expect(
        r.method,
        `a ledger holding ${JSON.stringify(junk)} was adopted and rewritten`,
      ).toBeNull();
    }
  });

  test("AC-L11 CONTROL: a well-formed prior ledger is still adopted", () => {
    // The refusals above are green under a step that refuses everything.
    const ok = [{ at: "t0", sha: "cafe", run: "run-1", attempt: "1", round: 1, findings: [] }];
    const r = runPersist({ list: [botComment(5, ledgerBody(ok))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "a valid ledger was not adopted").toBe("PATCH");
    expect(r.rounds).toHaveLength(2);
  });

  test("AC-L11: an EMPTY prior ledger is readable, not refused", () => {
    // `all(.[]; …)` over `[]` is vacuously true, and that is load-bearing:
    // the ledger is legitimately empty exactly once, and a step that refused
    // it would never record a second round on any pull request.
    const r = runPersist({ list: [botComment(5, ledgerBody([]))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("PATCH");
    expect(r.rounds).toHaveLength(1);
  });

  /**
   * A prior ledger of `n` rounds, named `old-0` … `old-<n-1>`.
   *
   * The names are deliberately NOT `run-<i>`. The rig's `GITHUB_RUN_ID` is
   * `run-9`, so a prior ledger of twelve `run-<i>` rounds already contains
   * `run-9` — and "the new round was recorded" then held vacuously, against a
   * row the fixture itself planted. An eviction-order assertion needs the two
   * populations to be nameable apart.
   */
  function priorRounds(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      at: `t${i}`,
      sha: "cafe",
      run: `old-${i}`,
      attempt: "1",
      round: i + 1,
      findings: [],
    }));
  }

  test("AC-L11: at the cap the OLDEST round is dropped and the COUNT is announced", () => {
    const r = runPersist({
      list: [botComment(5, ledgerBody(priorRounds(AI_REVIEW_LEDGER_MAX_ROUNDS)))],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds, "the ledger grew past its cap").toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
    // The oldest is gone and the newest is present — a cap that dropped the
    // WRONG end keeps the same length and loses every new round instead.
    expect(JSON.stringify(r.rounds), "old-0 should have been dropped").not.toContain('"old-0"');
    expect(JSON.stringify(r.rounds), "old-1 is inside the window and was dropped").toContain(
      '"old-1"',
    );
    expect(JSON.stringify(r.rounds), "this round was not recorded").toContain('"run-9"');
    // A dropped round is gone, not empty. Silence here would make the ledger
    // a window that reports as a history.
    //
    // Assert the COUNT, not the word "cap". The count is the one thing only
    // the announcement branch can write, and `""` and `0` used to reach the
    // SAME `case` arm — so a note keyed on the word was green whether the
    // count had been read or not. That is the sixth shape of
    // `.claude/rules/checks-must-be-able-to-fail.md` living in the arm
    // rather than in the value, and it shipped live in #1386.
    expect(r.stdout, "the evicted count was not announced").toContain("1 of the OLDEST");
  });

  test("AC-L11: the announced count is the number actually evicted, not a constant", () => {
    // The row the one above cannot be: it evicts THREE, so a hardcoded "1",
    // a boolean dressed as a count, and an off-by-one all come back wrong.
    // Two rows differing only in the count is the cheapest way to make the
    // announcement carry information rather than fire.
    const over = AI_REVIEW_LEDGER_MAX_ROUNDS + 2;
    const r = runPersist({ list: [botComment(5, ledgerBody(priorRounds(over)))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds, "the ledger grew past its cap").toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
    expect(JSON.stringify(r.rounds), "old-2 should have been dropped").not.toContain('"old-2"');
    expect(JSON.stringify(r.rounds), "old-3 is inside the window and was dropped").toContain(
      '"old-3"',
    );
    expect(JSON.stringify(r.rounds), "this round was not recorded").toContain('"run-9"');
    expect(r.stdout, "the announced count does not match the eviction").toContain(
      "3 of the OLDEST",
    );
  });

  test("AC-L11: under the cap nothing is dropped and nothing is announced", () => {
    // The control for the rows above: the warning must not fire on every run.
    const r = runPersist({ list: [botComment(5, ledgerBody(priorRounds(1)))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds).toHaveLength(2);
    expect(JSON.stringify(r.rounds), "an under-cap ledger lost its oldest round").toContain(
      '"old-0"',
    );
    expect(r.stdout, "the cap warning fired below the cap").not.toContain("OLDEST");
  });

  test("AC-L11: a count that cannot be read REFUSES the write rather than reading as zero", () => {
    // Fault injection on the count position only. In production the count and
    // the kept list come out of ONE `jq`, so this branch is unreachable while
    // that invocation succeeds — which is exactly why it needs a row: a
    // defensive arm nothing exercises is a line in a report.
    //
    // The defect this blocks is the one that shipped: when the count was a
    // SECOND `jq … 2>/dev/null || true`, its failure produced `""`, `""`
    // shared an arm with `0`, and the ledger was written having evicted
    // rounds it did not mention. A truncated history that reports as a
    // complete one is unrecoverable; a round that was not recorded is not.
    const real = buildPersistScript();
    const COUNT_EXPR = "($d | tostring)";
    expect(
      real.split(COUNT_EXPR).length - 1,
      "the count expression moved — this row mutates a string that is no longer there",
    ).toBe(1);
    const mutant = real.replace(COUNT_EXPR, '("not-a-number")');
    expect(mutant, "the mutation did not apply").not.toBe(real);

    const r = runPersist({
      list: [botComment(5, ledgerBody(priorRounds(AI_REVIEW_LEDGER_MAX_ROUNDS)))],
      payload: ONE_FINDING,
      script: mutant,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "the ledger was written with an unreadable eviction count").toBe(null);
    expect(r.stdout, "the refusal was not announced").toContain("NOT recorded");

    // The control, same rig and the real script: the refusal is the
    // mutation's doing and not something this fixture provokes on its own.
    const control = runPersist({
      list: [botComment(5, ledgerBody(priorRounds(AI_REVIEW_LEDGER_MAX_ROUNDS)))],
      payload: ONE_FINDING,
    });
    expect(control.method, "the unmutated script also refused").toBe("PATCH");
    expect(control.stdout).not.toContain("NOT recorded");
  });
});

/**
 * AC-L15 (#1405): the ledger says on its face that it is a WINDOW.
 *
 * The cap evicts, and the only notice is a warning annotation in a job log
 * that expires. So the notice reaches whoever watched that run and nobody
 * afterwards, and a twelve-round ledger that dropped eight reads exactly
 * like a twelve-round ledger that is the whole history. That is #1168's
 * distinction — gone is not empty — one level up, about the ledger rather
 * than about a round.
 *
 * The reader half merged in #1410 and accepts both shapes already. This is
 * the writer.
 *
 * Three facts have to stay apart, and only two of them are numbers:
 *
 *  - **0** — nothing was ever dropped. A fresh pull request, and also a
 *    legacy bare array SHORTER than the cap, because the list only grows by
 *    one per round and is only ever cut at the cap, so a length below it
 *    means the cut never ran. That is a derivation, not an assumption.
 *  - **N** — exactly N were dropped, carried forward and added to.
 *  - **absent** — the depth cannot be established. A legacy array adopted at
 *    exactly the cap: this round's eviction is known and the ones before it
 *    are not. Writing the lower bound here would be a number a reader cannot
 *    tell from a total.
 */
describe("AC-L15 (#1405): the window count is written, and unknown is not zero", () => {
  // How far past the cap the sequence row drives the real step. Shared with
  // the mutant row below rather than written twice, because that row's job
  // is to prove THIS NUMBER is big enough: it measures the depth at which a
  // saturating total first diverges and asserts this constant reaches it.
  // Lower it to `+ 5` and the mutant row goes red naming the shortfall
  // (#1451).
  const SEQUENCE_ROUNDS = AI_REVIEW_LEDGER_MAX_ROUNDS + 8;

  const entry = (over: Record<string, unknown> = {}) => ({
    at: "t",
    sha: "cafe",
    run: "old",
    attempt: "1",
    round: 1,
    findings: [],
    ...over,
  });
  const nRounds = (n: number) =>
    Array.from({ length: n }, (_, i) => entry({ run: `old-${i}`, round: i + 1 }));

  test("AC-L15: a first round states ZERO dropped, as a field and not as an absence", () => {
    const r = runPersist({ list: [], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("POST");
    expect(Object.hasOwn(r.doc, AI_REVIEW_LEDGER_TRUNCATED_FIELD)).toBe(true);
    expect(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD]).toBe(0);
    expect(r.rounds).toHaveLength(1);
  });

  test("AC-L15: a legacy bare array UNDER the cap migrates to a stated zero", () => {
    // Derived rather than assumed: a list below the cap was never cut.
    const r = runPersist({ list: [botComment(5, ledgerBody(nRounds(3)))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("PATCH");
    expect(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD]).toBe(0);
    expect(r.rounds, "the legacy rounds were discarded by the migration").toHaveLength(4);
    expect(JSON.stringify(r.rounds)).toContain('"old-0"');
  });

  test("AC-L15: a legacy bare array AT the cap migrates to NO count, and says why", () => {
    // The row that fails under `truncated: dropped-this-round`. That number
    // is a lower bound, and a reader cannot tell a lower bound from a total.
    const r = runPersist({
      list: [botComment(5, ledgerBody(nRounds(AI_REVIEW_LEDGER_MAX_ROUNDS)))],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("PATCH");
    expect(
      Object.hasOwn(r.doc, AI_REVIEW_LEDGER_TRUNCATED_FIELD),
      `wrote ${JSON.stringify(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD])} for a depth it cannot know`,
    ).toBe(false);
    expect(Array.isArray(r.doc[AI_REVIEW_LEDGER_ROUNDS_FIELD])).toBe(true);
    expect(r.rounds).toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
    expect(r.stdout, "an unknowable depth was not announced").toContain("cannot be established");
  });

  test("AC-L15: an existing count under the cap is carried forward unchanged", () => {
    const r = runPersist({
      list: [botComment(5, windowBody(nRounds(2), { [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 4 }))],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD]).toBe(4);
    expect(r.rounds, "an object ledger's rounds were not read").toHaveLength(3);
    expect(JSON.stringify(r.rounds)).toContain('"old-0"');
    expect(r.stdout, "a drop was announced where none happened").not.toContain("OLDEST");
  });

  test("AC-L15: an eviction ADDS to the existing count, and the two numbers agree", () => {
    // 4 already gone, 1 more this round, so 5 — and the warning says 1.
    // Both come out of the same `jq`, which is the whole of #1394: two
    // computations of one number are two numbers that can disagree.
    const r = runPersist({
      list: [
        botComment(
          5,
          windowBody(nRounds(AI_REVIEW_LEDGER_MAX_ROUNDS), {
            [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 4,
          }),
        ),
      ],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD], "the count did not accumulate").toBe(5);
    expect(r.rounds).toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
    expect(JSON.stringify(r.rounds), "the oldest round survived the cap").not.toContain('"old-0"');
    expect(r.stdout, "the announced drop is this round's, not the total").toContain(
      "1 of the OLDEST",
    );
  });

  test("AC-L15: a malformed count is UNKNOWN, never zero, and the rounds survive", () => {
    const r = runPersist({
      list: [
        botComment(5, windowBody(nRounds(2), { [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: "4" })),
      ],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      Object.hasOwn(r.doc, AI_REVIEW_LEDGER_TRUNCATED_FIELD),
      "a count that could not be read was written as a number anyway",
    ).toBe(false);
    expect(r.rounds, "a bad count discarded the rounds").toHaveLength(3);
  });

  test("AC-L15: an object whose rounds is not an array is REFUSED, not replaced", () => {
    const r = runPersist({
      list: [botComment(5, ledgerBody({ [AI_REVIEW_LEDGER_ROUNDS_FIELD]: "nope" }))],
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "an unreadable ledger was overwritten").toBe(null);
    expect(r.stdout).toContain("NOT recorded");
  });

  test("AC-L15: the control — what this step writes is what the reader reads", () => {
    // The two sides have no import between them, so the agreement is only
    // real if something runs one against the other.
    const under = runPersist({ list: [botComment(5, ledgerBody(nRounds(3)))], payload: ONE_FINDING });
    const atCap = runPersist({
      list: [botComment(5, ledgerBody(nRounds(AI_REVIEW_LEDGER_MAX_ROUNDS)))],
      payload: ONE_FINDING,
    });
    const bodyOf = (sent: string | null) => JSON.parse(sent!).body as string;

    const stated = readLedger(bodyOf(under.sentRaw));
    if (stated.status !== AI_REVIEW_LEDGER_READ) throw new Error(JSON.stringify(stated));
    expect(stated.truncation.status).toBe(AI_REVIEW_TRUNCATION_STATED);
    if (stated.truncation.status !== AI_REVIEW_TRUNCATION_STATED) throw new Error("unreachable");
    expect(stated.truncation.dropped).toBe(0);
    expect(stated.rounds).toHaveLength(4);

    const unknown = readLedger(bodyOf(atCap.sentRaw));
    if (unknown.status !== AI_REVIEW_LEDGER_READ) throw new Error(JSON.stringify(unknown));
    expect(unknown.truncation.status).toBe(AI_REVIEW_TRUNCATION_UNKNOWN);
    expect(unknown.rounds).toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
  });

  test("AC-L15: the two sides spell the field names identically, with no import between them", () => {
    const script = buildPersistScript();
    expect(AI_REVIEW_LEDGER_ROUNDS_FIELD).toBe(AI_REVIEW_LEDGER_ROUNDS_KEY);
    expect(AI_REVIEW_LEDGER_TRUNCATED_FIELD).toBe(AI_REVIEW_LEDGER_TRUNCATED_KEY);
    expect(script).toContain(`{${AI_REVIEW_LEDGER_TRUNCATED_FIELD}: $t, ${AI_REVIEW_LEDGER_ROUNDS_FIELD}: .}`);
    expect(script, "the step imports the reader, so the agreement is vacuous").not.toContain(
      "ai-review-rounds",
    );
  });

  // AC-4 (#1405): the row that is red when the RECORDED count is wrong.
  //
  // Every other row above compares the written count against a number
  // written beside it in this file, so each one is only as right as the
  // expectation someone typed next to it. A count that is consistently
  // wrong — off by one, or this round's drop instead of the total — agrees
  // with a hand-written expectation that made the same mistake, and nine
  // green rows say nothing about it.
  //
  // This row derives the truth from the loop counter instead. Drive the
  // real step through more rounds than the cap holds, feeding each output
  // back in as the next round's prior ledger, and one equality has to hold
  // at every step for the count to mean what it says:
  //
  //     truncated + retained == rounds written so far
  //
  // Nothing in the step computes that sum, and the right-hand side is the
  // iteration index, so no mutation of the writer can satisfy it by
  // accident. The second assertion is the same law stated over the
  // announcements: the warnings a human read, one per run, have to add up
  // to the number the ledger carries for whoever arrives later. That is
  // #1394's "one computation, not two" extended across time — the two
  // sites now being this round's annotation and the running total.
  test("AC-L15/AC-4: across a sequence past the cap, truncated + retained is every round written", () => {
    // Eight past the cap, and the eight is load-bearing. The deepest total
    // any row above asserts is 5, so a writer that is correct up to 5 and
    // drifts after it is green on every one of them. Running past the
    // deepest typed number is the part of this the other rows cannot reach.
    //
    // That used to be asserted here as "measured: the drift mutant below is
    // red here and nowhere else", with no mutant below it and no measurement
    // anyone could re-run. Both halves were wrong, and #1451 measured them:
    //
    //  - the OBVIOUS drift — `$d`, this round's eviction, written where the
    //    running total belongs — is caught by three rows, not one. The two
    //    shallow ones are "an existing count under the cap is carried
    //    forward unchanged" and "an eviction ADDS to the existing count",
    //    and the first needs no eviction at all. Nothing about depth is
    //    required to see it.
    //  - a total that goes on being RIGHT and then saturates past the
    //    deepest typed number is the one only this row can see: 1 of 100.
    //
    // So the depth claim is true and the mutant that was named for it was
    // not. The real one is the row directly below this test, which also
    // binds `SEQUENCE_ROUNDS` — measured there, the first divergence is at
    // the cap + 6, so this constant carries two rounds of headroom.
    const ROUNDS = SEQUENCE_ROUNDS;
    let body: string | null = null;
    let announced = 0;

    for (let i = 1; i <= ROUNDS; i++) {
      const runId = `seq-${i}`;
      const r = runPersist({
        list: body === null ? [] : [botComment(5, body)],
        payload: ONE_FINDING,
        round: String(i),
        env: {
          GITHUB_RUN_ID: runId,
          STUB_WRITE_RESPONSE: JSON.stringify({ id: 5, body: `${runId} ok` }),
        },
      });
      expect(r.status, `round ${i}: ${r.stderr}`).toBe(0);
      expect(r.sentRaw, `round ${i} wrote nothing`).not.toBeNull();

      const recorded = r.doc?.[AI_REVIEW_LEDGER_TRUNCATED_FIELD];
      expect(typeof recorded, `round ${i} recorded no count`).toBe("number");
      expect(
        recorded + (r.rounds?.length ?? 0),
        `round ${i}: ${recorded} dropped + ${r.rounds?.length} kept is not ${i} written`,
      ).toBe(i);
      expect(r.rounds).toHaveLength(Math.min(i, AI_REVIEW_LEDGER_MAX_ROUNDS));

      const said = r.stdout.match(/(\d+) of the OLDEST/);
      announced += said === null ? 0 : Number(said[1]);
      expect(announced, `round ${i}: the warnings total ${announced}, the ledger says ${recorded}`).toBe(
        recorded,
      );

      body = JSON.parse(r.sentRaw!).body as string;
    }

    // Stated as an absolute so a loop that silently ran zero times cannot
    // pass this: eight rounds are gone and the cap's worth remain. (Eight,
    // not five — the depth moved to `+ 8` and this sentence kept the old
    // number until #1451. The assertions never said five; they are written
    // against the constant, which is the only reason the drift was in the
    // prose and not in the result.)
    const last = readLedger(body!);
    if (last.status !== AI_REVIEW_LEDGER_READ) throw new Error(JSON.stringify(last));
    if (last.truncation.status !== AI_REVIEW_TRUNCATION_STATED) {
      throw new Error(`the reader could not get a count back: ${JSON.stringify(last.truncation)}`);
    }
    expect(last.truncation.dropped).toBe(ROUNDS - AI_REVIEW_LEDGER_MAX_ROUNDS);
    expect(last.rounds).toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
    expect(announced).toBe(ROUNDS - AI_REVIEW_LEDGER_MAX_ROUNDS);
    // The window really is a window, and it is the OLDEST that went: the
    // rounds the count claims are gone are the ones it names.
    expect(last.rounds.map((entry: { round?: unknown }) => entry.round)).toEqual(
      Array.from(
        { length: AI_REVIEW_LEDGER_MAX_ROUNDS },
        (_, i) => ROUNDS - AI_REVIEW_LEDGER_MAX_ROUNDS + 1 + i,
      ),
    );
  });

  // AC-1/AC-2/AC-3 (#1451): the mutant the row above used to CITE.
  //
  // Its comment read "measured: the drift mutant below is red here and
  // nowhere else" and there was no mutant below it — the sentence answered,
  // in the right file, the question that would otherwise have prompted
  // somebody to write one. That is `checks-must-be-able-to-fail.md`'s #1322
  // shape, and SUCCESS.md's "what is not success" list names the weaker
  // version of it directly ("a guard with a passing mutant test").
  //
  // Writing it falsified the claim it was supposed to support. The obvious
  // drift — `$d`, this round's eviction count, written where the running
  // total belongs — moves THREE rows, measured over the whole file:
  //
  //     ($pt + $d) -> ($d + 0)      97 pass / 3 fail
  //       · an existing count under the cap is carried forward unchanged
  //       · an eviction ADDS to the existing count
  //       · across a sequence past the cap  (the row above)
  //
  // The first of those evicts nothing, so depth is not what catches it. A
  // mutation is a thing you spell, and the first spelling of this one —
  // `($d | tostring)` — moved a FOURTH row by colliding with the string
  // `AC-L11`'s count mutant rewrites, tripping its uniqueness guard. That
  // row was reporting a vanished mutation target, not a caught defect.
  //
  // The mutant below is the one the depth actually buys, and it is the
  // comment's own theory made real: a total that is RIGHT up to the deepest
  // number anybody typed and wrong after it. 1 of 100.
  test("AC-L15/AC-4: the MUTANT — a total saturating past the deepest typed number — is caught HERE and not by the shallow rows", () => {
    const real = buildPersistScript();
    const TOTAL_EXPR = "(($pt + $d) | tostring)";
    expect(
      real.split(TOTAL_EXPR).length - 1,
      "the running-total expression moved — this row mutates a string that is no longer there",
    ).toBe(1);
    // Saturate at 5, the deepest total any other row in this file asserts.
    const mutant = real.replace(TOTAL_EXPR, "(([($pt + $d), 5] | min) | tostring)");
    expect(mutant, "the mutation did not apply").not.toBe(real);

    // Half one — "not by the shallow rows", run rather than asserted in
    // prose. These are the two fixtures that DO catch the obvious drift,
    // and they are blind to this one: both land on totals at or under the
    // saturation point, which is the whole reason depth is needed.
    const carried = runPersist({
      list: [botComment(5, windowBody(nRounds(2), { [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 4 }))],
      payload: ONE_FINDING,
      script: mutant,
    });
    expect(
      carried.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD],
      "the carry-forward fixture saw the saturation, so it is not a shallow-blind case",
    ).toBe(4);

    const added = runPersist({
      list: [
        botComment(
          5,
          windowBody(nRounds(AI_REVIEW_LEDGER_MAX_ROUNDS), {
            [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 4,
          }),
        ),
      ],
      payload: ONE_FINDING,
      script: mutant,
    });
    expect(
      added.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD],
      "the accumulate fixture saw the saturation, so it is not a shallow-blind case",
    ).toBe(5);

    // Half two — the sequence DOES see it, and the round it first sees it
    // on is the measurement that justifies `SEQUENCE_ROUNDS`. Driven only
    // as far as it needs to go: one past the predicted divergence, so a
    // divergence that arrives LATE is a failure rather than something this
    // loop runs past.
    const probeTo = AI_REVIEW_LEDGER_MAX_ROUNDS + 6;
    let body: string | null = null;
    let firstDivergence: number | null = null;
    let observed = 0;

    for (let i = 1; i <= probeTo; i++) {
      const runId = `sat-${i}`;
      const r = runPersist({
        list: body === null ? [] : [botComment(5, body)],
        payload: ONE_FINDING,
        round: String(i),
        env: {
          GITHUB_RUN_ID: runId,
          STUB_WRITE_RESPONSE: JSON.stringify({ id: 5, body: `${runId} ok` }),
        },
        script: mutant,
      });
      expect(r.status, `round ${i}: ${r.stderr}`).toBe(0);
      expect(r.sentRaw, `round ${i} wrote nothing`).not.toBeNull();
      observed += 1;

      const recorded = r.doc?.[AI_REVIEW_LEDGER_TRUNCATED_FIELD];
      expect(typeof recorded, `round ${i} recorded no count`).toBe("number");
      if (
        firstDivergence === null &&
        (recorded as number) + (r.rounds?.length ?? 0) !== i
      ) {
        firstDivergence = i;
      }

      body = JSON.parse(r.sentRaw!).body as string;
    }

    // The loop ran. A `firstDivergence` of null and a loop that never
    // executed are the same reading otherwise, and only one of them is a
    // finding.
    expect(observed, "the probe loop ran zero rounds").toBe(probeTo);
    expect(
      firstDivergence,
      "the saturating total was never caught — this row's mutant no longer reaches the defect it names",
    ).toBe(AI_REVIEW_LEDGER_MAX_ROUNDS + 6);

    // And the constant the row above runs on is deep enough to get there.
    // This is the "eight is load-bearing" claim, executable: measured at
    // `+ 5` the row above is GREEN under this mutant and at `+ 6` it is
    // red, so the shipped `+ 8` carries two rounds of headroom. Shorten it
    // and this fails naming the shortfall.
    expect(
      SEQUENCE_ROUNDS,
      `the sequence row runs to the cap + ${SEQUENCE_ROUNDS - AI_REVIEW_LEDGER_MAX_ROUNDS}, which never reaches the cap + 6 where this mutant first diverges`,
    ).toBeGreaterThanOrEqual(firstDivergence!);

    // The control, same rig and the real script: the divergence is the
    // mutation's doing and not something this fixture provokes on its own.
    const control = runPersist({
      list: [
        botComment(
          5,
          windowBody(nRounds(AI_REVIEW_LEDGER_MAX_ROUNDS), {
            [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 4,
          }),
        ),
      ],
      payload: ONE_FINDING,
    });
    expect(
      control.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD],
      "the unmutated script did not accumulate either",
    ).toBe(5);
  });
});

/**
 * AC-L12 (#1379): the path is RESOLVED before a line of it is made public.
 *
 * AC-L9's refusal row reads the SPELLING of `file` — empty, leading `/`,
 * `..` — and a committed symlink needs none of those to leave the checkout.
 * Worse, the test that row relies on is the one that hides the link: `-f`
 * FOLLOWS it, so a link to anything readable is "an ordinary file" by that
 * reading. A pull request author controls repo content, the sink is a comment
 * on a public repository, and the target does not have to be guessed — the
 * adjudicator's env block names
 * `GOOGLE_APPLICATION_CREDENTIALS: /home/runner/work/_temp/...` in every run
 * log.
 *
 * Two different escapes, and they need two different guards, which is why
 * both are planted here:
 *
 *   - the cited file IS a link       → refused by `! -L`, which must be
 *                                      tested BEFORE `-f`
 *   - a PARENT directory is a link   → `! -L` is silent, because the cited
 *                                      file is not itself a link. Only
 *                                      resolving and requiring containment
 *                                      refuses it.
 *
 * Every link here is a REAL inode. A fixture writing a regular file whose
 * contents happen to be a path exercises none of this: the string tests pass
 * identically, `-L` and `-f` agree, and the row goes green against the
 * defect it was written for.
 */
/** Widens containment to match every resolved path. */
const dropContainment = (s: string) => s.replace('"${root}"/*)', "*)");

/**
 * Reverts the read from the INDEX to the working tree — the one-line
 * difference between "quote what the pull request contains" and "quote
 * whatever is on disk". Built from the exported constant rather than a
 * hand-copied string, so a mutation that silently failed to apply cannot
 * read as a guard that decided nothing.
 */
const dropIndexRead = (s: string) =>
  s.replace(
    `marked=$(${AI_REVIEW_GIT_ISOLATED} -C "\${root}" show ":\${rel}" 2>/dev/null | sed -n "\${rl}{s/^/X/;p;q;}" || true)`,
    'marked=$(sed -n "${rl}{s/^/X/;p;q;}" "${real}" 2>/dev/null || true)',
  );

describe("AC-L12 (#1379): a committed symlink does not read outside the checkout", () => {
  const DIRECT = "THE-LINKED-SECRET";
  const VIA_PARENT = "THE-PARENT-LINKED-SECRET";

  /**
   * Plants an outside tree and a checkout that reaches it two ways, then
   * runs `script` (the real step unless a mutant is passed) against both
   * plus an ordinary in-tree file.
   *
   * The fixture paths go into the payload FILE as literal bytes, never
   * through a shell and never through `join()`: `join()` normalises a path
   * before the guard under test can see it, and an interpolated fixture is
   * eaten by the shell — the mangling AC-L0 exists to catch.
   */
  function runWithLinks(script?: string) {
    const outside = mkdtempSync(join(tmpdir(), "ai-review-outside-"));
    writeFileSync(join(outside, "creds.json"), `${DIRECT}\n`);
    writeFileSync(join(outside, "other.json"), `${VIA_PARENT}\n`);
    try {
      return runPersist({
        list: [],
        script,
        files: { "lib/a.ts": "alpha\n" },
        symlinks: {
          "notes/x.md": join(outside, "creds.json"),
          notes2: outside,
        },
        payload: {
          findings: [
            { severity: "high", file: "notes/x.md", line: 1, summary: "the file is a link" },
            { severity: "high", file: "notes2/other.json", line: 1, summary: "a parent is a link" },
            { severity: "high", file: "lib/a.ts", line: 1, summary: "control" },
          ],
        },
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }

  test("AC-L12: neither escape reaches the comment, and the in-tree control still quotes", () => {
    const r = runWithLinks();
    expect(r.status, r.stderr).toBe(0);
    expect(r.sentRaw, "a committed symlink was read into a public comment").not.toContain(DIRECT);
    expect(r.sentRaw, "a LINKED PARENT directory was read into a public comment").not.toContain(
      VIA_PARENT,
    );
    // The negative control, and it is not decoration: without it a repair
    // that deletes the quoting outright satisfies both assertions above and
    // this whole block certifies a step that records nothing.
    expect(r.rounds![0].findings.map(hasText)).toEqual([false, false, true]);
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  /**
   * MEASURED, and it contradicts #1379's own fix sketch, so it is written
   * down rather than papered over: removing `! -L` and leaving containment
   * in place does **not** leak. `readlink -f` resolves the whole chain, so a
   * link pointing outside the workspace fails containment whether or not
   * anything recognised it as a link. On every ESCAPING input the two guards
   * agree — the "two deciders" shape in
   * `.claude/rules/checks-must-be-able-to-fail.md` — and a mutant row
   * claiming `! -L` is what stops the leak would assert a falsehood and go
   * green for the wrong reason.
   *
   * **Containment is the guard that refuses the leak.** Its mutant row is
   * below, and that is the row to read.
   *
   * `! -L` is kept, and ordered first, for two reasons that are not this
   * one. It fails CLOSED where containment cannot run at all — a runner
   * whose `readlink` lacks `-f` leaves `real` empty, and then the link test
   * is the only thing left. And `-f` must never be reached on a link,
   * because `-f` is the test that makes a link transparent.
   *
   * The input that separates the two guards is a link whose target is
   * INSIDE the checkout: containment passes, `! -L` refuses. That is not a
   * leak — the target is in-tree and readable anyway — but it is the one
   * reading `! -L` decides by itself, so it is where the guard is bound.
   */
  test("AC-L12: the MUTANT — `! -L` removed — quotes through an IN-TREE link", () => {
    const real = buildPersistScript();
    const mutant = real.replace('[ ! -L "./${rf}" ] && ', "");
    expect(mutant, "the `! -L` guard was not found, so nothing was mutated").not.toBe(real);

    // `../lib/a.ts` is the link's own bytes, resolved by the kernel relative
    // to the link's directory. Not built with `join()`, which would
    // normalise the `..` away before it reached the filesystem at all.
    const rig: Rig = {
      list: [],
      files: { "lib/a.ts": "alpha\n" },
      symlinks: { "notes/x.md": "../lib/a.ts" },
      payload: {
        findings: [{ severity: "high", file: "notes/x.md", line: 1, summary: "in-tree link" }],
      },
    };

    expect(hasText(runPersist({ ...rig }).rounds![0].findings[0])).toBe(false);
    expect(
      runPersist({ ...rig, script: mutant }).rounds![0].findings[0].text,
      "removing `! -L` changed nothing, so the guard decides no input at all",
    ).toBe("alpha");
  });


  test("AC-L12: the MUTANT — containment AND tracking removed — posts through a linked parent", () => {
    // `! -L` stays, so this row cannot go green on the guard above.
    //
    // Both are dropped together because, MEASURED, dropping containment
    // alone does not leak: `git show ":${rel}"` refuses a path outside the
    // repository too, so the two agree on every escaping input. The row
    // below holds that finding on its own.
    const real = buildPersistScript();
    const mutant = dropIndexRead(dropContainment(real));
    expect(mutant, "neither guard was found, so nothing was mutated").not.toBe(real);
    expect(dropContainment(real), "the containment pattern was not found").not.toBe(real);
    expect(dropIndexRead(real), "the index read was not found").not.toBe(real);
    const r = runWithLinks(mutant);
    expect(
      r.sentRaw,
      "removing both outside-the-tree guards did not leak, so neither is what refuses",
    ).toContain(VIA_PARENT);
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  test("AC-L12: containment alone is SUBSUMED by the index read — measured, not assumed", () => {
    // Written down rather than left as a gap. With containment widened to
    // `*)` and the index read intact, the linked-parent escape is still
    // refused: the resolved path is outside the repository, so
    // `git show ":${rel}"` refuses it as well. Containment is retained for
    // two reasons that are not refusal — it is what keeps `rel` a
    // repo-RELATIVE name rather than an absolute one, and it states the
    // boundary where a reader looks for it — but it decides no input by
    // itself, and a row claiming otherwise would be the "two deciders"
    // shape going green for the wrong reason.
    const r = runWithLinks(dropContainment(buildPersistScript()));
    expect(r.sentRaw).not.toContain(VIA_PARENT);
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  test("AC-L12: the root comes from GITHUB_WORKSPACE when CI sets it", () => {
    // Pointed at the checkout — the reading CI takes — an in-tree file still
    // quotes. Both sides are resolved before they are compared, which is the
    // part a naive containment check gets wrong: on macOS the temp root is
    // reached through a symlink, so a resolved path never prefix-matches an
    // unresolved one and every legitimate quote would be refused.
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "alpha\n" },
      env: { GITHUB_WORKSPACE: "." },
      payload: { findings: [{ severity: "high", file: "lib/a.ts", line: 1, summary: "control" }] },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings[0].text).toBe("alpha");
  });

  test("AC-L12: a GITHUB_WORKSPACE pointing elsewhere refuses the in-tree read", () => {
    // The pair for the row above. Without it, a containment check that always
    // passes reads exactly the same from outside.
    const elsewhere = mkdtempSync(join(tmpdir(), "ai-review-elsewhere-"));
    try {
      const r = runPersist({
        list: [],
        files: { "lib/a.ts": "alpha\n" },
        env: { GITHUB_WORKSPACE: elsewhere },
        payload: { findings: [{ severity: "high", file: "lib/a.ts", line: 1, summary: "x" }] },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(hasText(r.rounds![0].findings[0])).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("AC-L12 (#1357): a cited line past the end of the file renders no quote", () => {
    // #1357's symptom as it reaches THIS step, re-asserted because the fix
    // changes the path `sed` is handed — `${rf}` became the resolved
    // `${real}` — so past-EOF now runs through new code. `sed -n 999p` on a
    // one-line file prints nothing, the field is the empty string, and the
    // comment carries no quote. Identical before this change and after it.
    //
    // #1357's own acceptance is NOT this. It asks the ADJUDICATOR
    // (`lib/scaffold/ai-review-findings.ts`) to carry an unlocatable citation
    // as a distinct named reading, out of a per-file line count taken from
    // the restored tree. That artefact has no producer — #1356 is open — and
    // that is a different module from this step. This row records what the
    // ledger does with the input; it does not close that issue.
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "alpha\n" },
      payload: {
        findings: [
          { severity: "high", file: "lib/a.ts", line: 999, summary: "past the end" },
          { severity: "high", file: "lib/a.ts", line: 1, summary: "control" },
        ],
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings.map(hasText)).toEqual([false, true]);
    expect(r.rounds![0].findings[1].text).toBe("alpha");
  });
});

/**
 * AC-L13 (#1379, second security pass): the cited path is never parsed as an
 * OPTION, and must be a file the pull request actually contains.
 *
 * Two additions to the same arm, from two later reviews.
 *
 * **Argument injection.** `rf` beginning with `-` passed the spelling filter,
 * and `[ -f "${rf}" ]` does not close it: `test -f` treats a leading-dash
 * operand as a filename, so it only requires such a file to exist — and git
 * tracks one happily. `sed` then parses the value as an option, and GNU sed's
 * `--expression=` can supply an `e` command that executes through a shell on
 * a credentialed runner.
 *
 * **Tracked, not merely inside the workspace.** `"${root}"/*` containment
 * answers "is this inside the checkout"; the question worth asking is "is
 * this a file the pull request contains". They differ by exactly the
 * interesting set — `.git/`, and anything an earlier step or the reviewer
 * itself wrote into the workspace. Tracked source is public by construction
 * for a pull request: the reviewer is quoting something already visible in
 * the diff.
 *
 * `git ls-files` subsumes the dot-directory arm that review also suggested,
 * so that arm is deliberately NOT added — two deciders answering one
 * question are behaviourally one, and a mutation of either leaves the other
 * holding the case up.
 *
 * Every fixture name here is written as literal bytes. `join()` is used only
 * to prefix the work directory, and these names carry no `.` or `..`
 * segment for it to normalise; nothing goes through a shell.
 */
describe("AC-L13 (#1379): a cited path is not an option, and must be tracked", () => {
  const CANARY = "INJECTION-CANARY";
  const DASH_N = "DASH-N-CANARY";

  /** Every row carries the in-tree control, because it is load-bearing twice
   *  over now: with four stacked refusals the failure that costs us is not a
   *  leak, it is a quote feature that silently never quotes again — and every
   *  refusal row stays green through exactly that. */
  function runNamed(script?: string) {
    return runPersist({
      list: [],
      script,
      files: {
        "lib/a.ts": "alpha\n",
        "--expression=e id": `${CANARY}\n`,
        "-n": `${DASH_N}\n`,
      },
      payload: {
        findings: [
          { severity: "high", file: "--expression=e id", line: 1, summary: "sed option" },
          { severity: "high", file: "-n", line: 1, summary: "bare flag" },
          { severity: "high", file: "lib/a.ts", line: 1, summary: "control" },
        ],
      },
    });
  }

  test("AC-L13: a `file` spelling a sed option renders no quote, and the control still quotes", () => {
    const r = runNamed();
    expect(r.status, r.stderr).toBe(0);
    expect(r.sentRaw, "an option-named path was read into a public comment").not.toContain(CANARY);
    expect(r.sentRaw, "a flag-named path was read into a public comment").not.toContain(DASH_N);
    expect(r.rounds![0].findings.map(hasText)).toEqual([false, false, true]);
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  test("AC-L13: the MUTANT — the `-*` arm removed — quotes the option-named file", () => {
    const real = buildPersistScript();
    const mutant = real.replace('""|-*|/*|*..*)', '""|/*|*..*)');
    expect(mutant, "the `-*` arm was not found, so nothing was mutated").not.toBe(real);
    const r = runNamed(mutant);
    expect(r.sentRaw, "removing the `-*` arm changed nothing, so it decides no input").toContain(
      CANARY,
    );
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  /**
   * The step plants the file, builds the index, THEN plants the untracked
   * one — so the only difference between the two refusals and the control is
   * membership of the index.
   */
  function runUntracked(script?: string) {
    return runPersist({
      list: [],
      script,
      files: { "lib/a.ts": "alpha\n" },
      untracked: { "lib/scratch.ts": "UNTRACKED-CANARY\n" },
      payload: {
        findings: [
          { severity: "high", file: "lib/scratch.ts", line: 1, summary: "untracked" },
          { severity: "high", file: ".git/config", line: 1, summary: "inside .git" },
          { severity: "high", file: "lib/a.ts", line: 1, summary: "control" },
        ],
      },
    });
  }

  test("AC-L13: an untracked file and a `.git/` path render no quote", () => {
    const r = runUntracked();
    expect(r.status, r.stderr).toBe(0);
    expect(r.sentRaw, "an untracked file in the workspace was quoted publicly").not.toContain(
      "UNTRACKED-CANARY",
    );
    // `.git/config` is inside the workspace and passes containment, so this
    // row can only be green because the line comes out of the index.
    expect(r.rounds![0].findings.map(hasText)).toEqual([false, false, true]);
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  test("AC-L13: the MUTANT — reading the working tree instead of the index — quotes the untracked file", () => {
    const real = buildPersistScript();
    const mutant = dropIndexRead(real);
    expect(mutant, "the index read was not found, so nothing was mutated").not.toBe(real);
    const r = runUntracked(mutant);
    expect(
      r.sentRaw,
      "reading the working tree changed nothing, so containment is being credited for it",
    ).toContain("UNTRACKED-CANARY");
    expect(r.rounds![0].findings[2].text).toBe("alpha");
  });

  /**
   * MEASURED, and the reason this step does NOT spell `--` on its `sed`,
   * against a third review that asked for it as a layer.
   *
   * BSD sed does not implement `--`. It takes it as a FILE OPERAND, and line
   * numbering is continuous across operands, so when a file literally named
   * `--` exists the quote comes from THAT file instead:
   *
   *     $ printf 'alpha\n' > a.ts; printf 'I-AM-THE-DASHDASH-FILE\n' > ./--
   *     $ sed -n 1p -- /abs/a.ts
   *     I-AM-THE-DASHDASH-FILE
   *
   * git tracks a file named `--` (verified), so on a BSD runner `--` would
   * ADD a content-disclosure route of exactly the class this issue is about.
   * On GNU sed it is correct but buys nothing: `sed` is handed `${real}`, an
   * absolute resolved path known to start with `${root}/`, which can never
   * be parsed as an option. A guarantee by construction, not by terminator.
   *
   * `--` IS spelled on `readlink`, where the operand is still the
   * attacker-shaped `rf` and both GNU and BSD readlink accept it.
   */
  /**
   * The gate and the read must be talking about the SAME object.
   *
   * `ls-files` asks the index; a `sed` of the resolved path reads whatever
   * is on disk now. A tracked file that an earlier step modified passes the
   * gate and would get its MODIFIED content quoted — a validator and a
   * consumer looking at two different objects, which is the same class as
   * the symlink defect this whole arm exists to fix, arriving inside the
   * guard that fixed it.
   *
   * Reading the line out of the index with `git show ":${rel}"` collapses
   * them to one object. Without this row that repair is unwitnessed: every
   * other row in this file plants a clean tree, where the index and the
   * working tree agree and the two readings are indistinguishable.
   */
  test("AC-L13: a tracked but DIRTY file quotes the committed line, not the disk line", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "COMMITTED-LINE\n" },
      dirty: { "lib/a.ts": "MODIFIED-ON-DISK\n" },
      payload: { findings: [{ severity: "high", file: "lib/a.ts", line: 1, summary: "dirty" }] },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings[0].text).toBe("COMMITTED-LINE");
    expect(r.sentRaw, "the working-tree line was quoted instead of the committed one").not.toContain(
      "MODIFIED-ON-DISK",
    );
  });

  test("AC-L13: a tracked file named `--` does not displace the quote", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "alpha\n", "--": "I-AM-THE-DASHDASH-FILE\n" },
      payload: { findings: [{ severity: "high", file: "lib/a.ts", line: 1, summary: "control" }] },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings[0].text).toBe("alpha");
    expect(r.sentRaw).not.toContain("I-AM-THE-DASHDASH-FILE");
  });
});

/**
 * Covers AC-T1..AC-T8 (#1380): forward capture of the turn count and of the
 * commit the reviewer actually read.
 *
 * #1380 is filed as a record, and its one actionable line is that history
 * cannot settle whether a re-run on an unchanged tree flips the verdict: at
 * the pre-#1198 26% payload rate, n=20 readable same-tree pairs needs ~290
 * re-runs and 28 exist. The three pairs that WERE readable all flipped, the
 * strongest being merge commit `99d50fc` at round 5 both times — BLOCKED
 * then CLEAN, 51 turns against 52, against a cap of 80.
 *
 * So two fields, and the second is the one that looks redundant.
 *
 *  - `turns` is the only candidate mechanism anyone has for that flip, and
 *    it is a three-state reading rather than a number: no key is a round
 *    written before this, `null` is a round that tried and could not read
 *    one, and a number is the count. `0` is never substituted for any of it.
 *  - `merge` is the commit `actions/checkout` put in the tree, which on a
 *    `pull_request` event is head merged into the base AS IT STOOD. `sha`
 *    is the pull request's head, and the base moves without the head moving
 *    — so two rounds sharing `sha` are not two rounds over one tree, and
 *    the same-tree pair this whole capture exists for cannot be formed from
 *    the field the ledger already had.
 *
 * NO VERDICT FIELD, and that is a refusal rather than an omission — AC-T8.
 */
describe("AC-T1 (#1380, #1498): a readable num_turns is recorded, and the reader reads it back", () => {
  // #1498. THE decisive case. The fixture is a real `SDKMessage[]` — the
  // shape `writeExecutionFile` produces — and before the fix the filter read
  // `.num_turns` off the ARRAY, where it cannot exist, so this records
  // `null`. #1493's own cases fed a top-level `{"num_turns": 51}`, a shape
  // the action does not write, and passed while witnessing nothing about
  // production; PR #1494 round 1 recorded `"turns":null` on a review that
  // ran, returned CLEAN and spent real turns.
  test("AC-T1 (#1498): a real SDKMessage[] stating num_turns 51 records 51", () => {
    const r = runPersist({
      list: [],
      payload: { findings: [] },
      execution: executionMessages(resultWith("num_turns", 51)),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD],
      "the turn count was read off the document ROOT, which on a real execution file is an array — #1498",
    ).toBe(51);
    // Through the real reader, never off the raw object. The step and the
    // reader are two modules that may not import each other, so the only
    // honest place an agreement about this key can be asserted is here.
    expect(readRoundTurns(r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD])).toEqual({
      status: AI_REVIEW_TURNS_READ,
      turns: 51,
    });
  });

  test("AC-T1 (#1498): zero turns is a READ zero, and says so through the reader", () => {
    const r = runPersist({
      list: [],
      payload: { findings: [] },
      execution: executionMessages(resultWith("num_turns", 0)),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readRoundTurns(r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD])).toEqual({
      status: AI_REVIEW_TURNS_READ,
      turns: 0,
    });
  });

  // The result message is not necessarily the only message, and it is the
  // LAST one — the action `break`s out of the iterator on it. A reader that
  // happened to take the first object in the array would be green on a
  // one-message fixture and wrong on every real file.
  test("AC-T1 (#1498): the count is taken from the result message, not from the first message", () => {
    const r = runPersist({
      list: [],
      payload: { findings: [] },
      execution: executionMessages(resultWith("num_turns", 83)),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD]).toBe(83);
  });

  // An exhausted run writes `error_max_turns` and still states its count.
  // That is a reading, not a failure to read: the route block one file over
  // uses the same subtype to explain the empty payload, and the ledger's
  // whole purpose is to compare that count against the cap.
  test("AC-T1 (#1498): an error_max_turns result still states a readable count", () => {
    const r = runPersist({
      list: [],
      payload: { findings: [] },
      execution: executionMessages({
        ...resultWith("subtype", "error_max_turns"),
        num_turns: 80,
        is_error: true,
      }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD]).toBe(80);
  });
});

/**
 * The UNMEASURED half. Every row records `null` and SAYS so, and none
 * records a number — `.claude/rules/config-access.md`'s *Silent Default
 * Substitution*, applied to a field whose entire purpose is to be compared
 * against a cap of 80.
 */
const TURN_SHAPES: { name: string; execution: unknown }[] = [
  { name: "no execution file at all", execution: undefined },
  { name: "an empty execution file", execution: "" },
  { name: "bytes that are not JSON", execution: "not json at all" },
  // Every row below is the REAL array shape with one thing wrong in it
  // (#1498). Before this they were top-level objects, which is a document
  // the action has never written — so each row agreed with the broken reader
  // rather than measuring it.
  {
    name: "a result message with no num_turns key",
    execution: executionMessages(resultWith("num_turns", undefined)),
  },
  { name: "num_turns as a string", execution: executionMessages(resultWith("num_turns", "51")) },
  { name: "num_turns as a float", execution: executionMessages(resultWith("num_turns", 51.5)) },
  { name: "a negative num_turns", execution: executionMessages(resultWith("num_turns", -1)) },
  { name: "num_turns explicitly null", execution: executionMessages(resultWith("num_turns", null)) },
  {
    name: "num_turns as an object",
    execution: executionMessages(resultWith("num_turns", { n: 51 })),
  },
  // #1498's three new unreadable shapes. The first is the one that matters:
  // it is #1493's OWN fixture, and it is a document the action does not
  // write. A reader that still answers 51 to it is reading the root.
  {
    name: "a top-level object stating num_turns — the shape the action never writes",
    execution: { num_turns: 51 },
  },
  { name: "a valid array carrying no result message", execution: executionMessages(null) },
  { name: "an empty array", execution: [] },
  // A result-shaped object nested one level too deep. `..` would find it;
  // the reader must not, because a key found at an unknown depth is a key
  // nobody can say the provenance of.
  {
    name: "a result message wrapped in an envelope object",
    execution: { messages: executionMessages(resultWith("num_turns", 51)) },
  },
];

describe("AC-T2 (#1380): an unreadable turn count is UNMEASURED, never a number", () => {
  for (const shape of TURN_SHAPES) {
    test(`AC-T2: ${shape.name} records null, not 0, and says so`, () => {
      const r = runPersist({ list: [], payload: { findings: [] }, execution: shape.execution });
      expect(r.status, r.stderr).toBe(0);
      const recorded = r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD];
      expect(recorded, "a guessed number was recorded for a count nobody read").toBeNull();
      expect(readRoundTurns(recorded)).toEqual({ status: AI_REVIEW_TURNS_UNREADABLE });
      expect(r.stdout, "the step recorded UNMEASURED and said nothing about it").toContain(
        "UNMEASURED",
      );
    });
  }

  // The round itself survives. A recorder that dropped a round because it
  // could not read one FIELD of it would lose the history the cap depends
  // on — and the findings are the part that carries forward.
  test("AC-T2: the round is still recorded, with its findings, when turns cannot be read", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\nfour\n" },
      payload: ONE_FINDING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds![0].findings).toHaveLength(1);
    expect(r.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD]).toBeNull();
  });
});

/**
 * THREE STATES, in one ledger, through the real reader.
 *
 * A pre-#1380 round carries no key; a round this step wrote carries `null`
 * when it could not read one. "Nobody tried" and "I tried and failed" are
 * different facts, and a reader that collapsed them would date every
 * unreadable round to before this shipped.
 */
describe("AC-T3 (#1380): absent, null and a number are three readings and not two", () => {
  test("AC-T3: a legacy round and a this-run unreadable round do not read alike", () => {
    // A round as the step wrote them BEFORE #1380: no `turns`, no `merge`.
    // `at` and `run` are not decoration — the shaping jq refuses a prior
    // ledger whose entries lack them, so a fixture without both is not a
    // legacy ledger, it is an unreadable one.
    const legacy = {
      at: "t0",
      run: "run-1",
      attempt: "1",
      round: 1,
      sha: "old",
      identity: AI_REVIEW_LEDGER_IDENTITY_V1,
      findings: [],
    };
    const r = runPersist({
      list: [botComment(3, windowBody([legacy]))],
      payload: { findings: [] },
      // No execution file: this round tried to read a count and could not.
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);

    const reading = readLedger(JSON.parse(r.sentRaw ?? '{"body":""}').body);
    expect(reading.status, `${r.stdout}\n${r.stderr}\n${r.argv.join(" ")}`).toBe(
      AI_REVIEW_LEDGER_READ,
    );
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("the ledger did not read");
    expect(reading.rounds).toHaveLength(2);

    expect(reading.rounds[0].turns).toEqual({ status: AI_REVIEW_TURNS_NOT_RECORDED });
    expect(reading.rounds[1].turns).toEqual({ status: AI_REVIEW_TURNS_UNREADABLE });
    expect(
      reading.rounds[0].turns,
      "a round nobody asked about reads the same as one that was asked and could not answer",
    ).not.toEqual(reading.rounds[1].turns);
  });

  // Neither non-READ arm carries a number, so there is no field to reach
  // for without narrowing the status first. The construction
  // `LedgerTruncation` uses, and the reason a `?? 0` has nowhere to land.
  test("AC-T3: neither unknown reading carries a count field at all", () => {
    for (const raw of [undefined, null, "51", 51.5, -1]) {
      expect(Object.hasOwn(readRoundTurns(raw), "turns"), `${String(raw)} carried a count`).toBe(
        false,
      );
    }
  });
});

/**
 * The merge commit, and the pair that isolates it.
 *
 * Each field has one source. A fixture handing them the same string could
 * not tell a recorder reading `GITHUB_SHA` from one reading the head sha
 * twice, so the rig gives them different values and the second case varies
 * exactly one of them.
 */
describe("AC-T4 (#1380): the commit reviewed is recorded, and it is not the head sha", () => {
  test("AC-T4: `merge` is GITHUB_SHA and `sha` is the pull request head", () => {
    const r = runPersist({ list: [], payload: { findings: [] } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].sha).toBe("deadbeef");
    expect(r.rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD]).toBe("mergecommit0");
  });

  // VARY ONE READING. The base moving under a fixed head is the live case —
  // a new merge commit, the same `sha` — and it is exactly where a ledger
  // recording only `sha` reports two rounds over one tree when they are two.
  test("AC-T4: the base moving under a fixed head moves `merge` and not `sha`", () => {
    const first = runPersist({ list: [], payload: { findings: [] } });
    const second = runPersist({
      list: [],
      payload: { findings: [] },
      env: { GITHUB_SHA: "mergecommit1" },
    });
    expect(first.rounds![0].sha).toBe(second.rounds![0].sha);
    expect(first.rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD]).not.toBe(
      second.rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD],
    );
  });

  test("AC-T4: the reader surfaces it as `mergeSha`, apart from `sha`", () => {
    const r = runPersist({ list: [], payload: { findings: [] } });
    const reading = readLedger(JSON.parse(r.sentRaw!).body);
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("the ledger did not read");
    expect(reading.rounds[0].sha).toBe("deadbeef");
    expect(reading.rounds[0].mergeSha).toBe("mergecommit0");
  });

  test("AC-T4: a pre-#1380 round reports no merge commit rather than a wrong one", () => {
    const reading = readLedger(
      ledgerBody({ [AI_REVIEW_LEDGER_ROUNDS_KEY]: [{ round: 1, sha: "head-only", findings: [] }] }),
    );
    if (reading.status !== AI_REVIEW_LEDGER_READ) throw new Error("the ledger did not read");
    expect(reading.rounds[0].sha).toBe("head-only");
    expect(reading.rounds[0].mergeSha).toBe("");
  });
});

/**
 * THE MUTANTS. Three, and the third is the one every other case here is
 * blind to.
 *
 * Each rewrites `buildPersistScript()`'s own text and runs the identical
 * rig, and each asserts the REAL script first — a case that only watched
 * the mutant would pass over a recorder that refuses everything.
 */
function mutatePersist(from: string, to: string): string {
  const src = buildPersistScript();
  const n = src.split(from).length - 1;
  // A mutation that was never applied reads exactly like a guard that held.
  if (n !== 1) throw new Error(`the mutation anchor appears ${n} times, expected 1: ${from}`);
  return src.split(from).join(to);
}

describe("AC-T5 (#1380): the recorder's three mutants", () => {
  test("AC-T5: the MUTANT defaulting turns to 0 turns an unread count into a real one", () => {
    const rig = { list: [] as unknown[], payload: { findings: [] } };
    expect(runPersist(rig).rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD]).toBeNull();

    const mutant = runPersist({ ...rig, script: mutatePersist('turns="null"', 'turns="0"') });
    expect(mutant.status, mutant.stderr).toBe(0);
    expect(mutant.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD]).toBe(0);
    // The damage, named: the reader cannot tell it from AC-T1's genuine
    // zero-turn round, because as far as the ledger says it IS that round.
    expect(readRoundTurns(mutant.rounds![0][AI_REVIEW_LEDGER_TURNS_FIELD])).toEqual({
      status: AI_REVIEW_TURNS_READ,
      turns: 0,
    });
  });

  test("AC-T5: the MUTANT dropping `merge` backdates the round to before #1380", () => {
    const rig = { list: [] as unknown[], payload: { findings: [] } };
    expect(runPersist(rig).rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD]).toBe("mergecommit0");

    const mutant = runPersist({
      ...rig,
      script: mutatePersist(`${AI_REVIEW_LEDGER_MERGE_FIELD}:$merge, `, ""),
    });
    expect(mutant.status, mutant.stderr).toBe(0);
    expect(mutant.rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD]).toBeUndefined();
  });

  /**
   * The two-deciders mutant. Point `merge` at the head sha: every assertion
   * about the field's PRESENCE still holds, every round still carries a
   * commit-shaped string, and the ledger now records one fact twice — so
   * the same-tree pair it exists to form is formed from the wrong commit
   * and nothing downstream can tell. Only a rig whose two commits DIFFER
   * can see it, which is why `GITHUB_SHA` is not `deadbeef`.
   */
  test("AC-T5: the MUTANT reading the head sha twice is caught by the differing pair", () => {
    const rig = { list: [] as unknown[], payload: { findings: [] } };
    const real = runPersist(rig);
    expect(real.rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD]).not.toBe(real.rounds![0].sha);

    const mutant = runPersist({
      ...rig,
      script: mutatePersist(
        `--arg merge "\${GITHUB_SHA:-}"`,
        `--arg merge "\${${AI_REVIEW_LEDGER_SHA_VAR}:-}"`,
      ),
    });
    expect(mutant.status, mutant.stderr).toBe(0);
    expect(mutant.rounds![0][AI_REVIEW_LEDGER_MERGE_FIELD]).toBe(mutant.rounds![0].sha);
  });
});

/**
 * What the two fields COST, measured rather than assumed.
 *
 * The ledger is a 12-round window against GitHub's 65,536-character comment
 * body limit, serialised compactly, and every field added to a round is
 * paid twelve times. A capture that pushed the window past the limit would
 * begin losing the rounds it was added to describe, so the cost is measured
 * as a DIFFERENCE here and the headroom asserted against the limit the API
 * enforces rather than against a budget somebody guessed.
 */
describe("AC-T6 (#1380): the per-round cost, and the window that still fits", () => {
  /** GitHub's hard limit on an issue-comment body. */
  const COMMENT_LIMIT = 65_536;

  test("AC-T6: a full 12-round window carrying both fields is inside the limit", () => {
    const full = Array.from({ length: AI_REVIEW_LEDGER_MAX_ROUNDS }, (_, i) => ({
      at: "2026-10-24T00:00:00Z",
      sha: "a".repeat(40),
      [AI_REVIEW_LEDGER_MERGE_FIELD]: "b".repeat(40),
      run: "40123456789",
      attempt: "1",
      identity: AI_REVIEW_LEDGER_IDENTITY_V1,
      round: i + 1,
      [AI_REVIEW_LEDGER_TURNS_FIELD]: 51,
      findings: [
        {
          severity: "high",
          file: "lib/scaffold/ai-review-step.ts",
          line: 1234,
          summary: "a finding summary of roughly the length these actually are",
          [AI_REVIEW_LEDGER_TEXT_FIELD]: "  const x = readSomething(root, options);",
        },
      ],
    }));
    const withFields = windowBody(full).length;

    // The same window with #1380's two fields removed. A difference, not a
    // guess: a per-round number nobody subtracted is a number nobody took.
    const without = windowBody(
      full.map((round) => {
        const copy: Record<string, unknown> = { ...round };
        delete copy[AI_REVIEW_LEDGER_MERGE_FIELD];
        delete copy[AI_REVIEW_LEDGER_TURNS_FIELD];
        return copy;
      }),
    ).length;

    const perRound = (withFields - without) / AI_REVIEW_LEDGER_MAX_ROUNDS;
    expect(perRound, `#1380 costs ${perRound} characters per round`).toBeLessThan(80);
    expect(
      withFields,
      `a full window carrying both fields is ${withFields} of ${COMMENT_LIMIT} characters`,
    ).toBeLessThan(COMMENT_LIMIT);
  });
});

/**
 * The boundary, asserted so it stays a decision rather than becoming a hole.
 *
 * #1380 asks for "verdict + num_turns + merge commit", and this case used to
 * assert that the verdict was deliberately NOT recorded. **#1511 is the
 * finding that the reasoning behind that was half right**, so the case is
 * rewritten here rather than deleted, and what it asserts is the line that
 * actually matters.
 *
 * What was right: a verdict COMPUTED here would be a second decider
 * answering `AI_REVIEW_SEVERITIES`' question about the same findings — two
 * readings that agree until the day they do not, both reading as covered.
 * That is still true and the step still computes nothing.
 *
 * What was wrong: *"the verdict is a function of the `findings` array"*. It
 * is not. It is a word the reviewer writes beside them, and the gap between
 * the two is CONTRADICTION (#1178). A reader handed findings alone can
 * compute what the word should have been and cannot recover what it was, so
 * every round ever captured out of the ledger scored `VERDICT_ABSENT` and
 * `DETECTED` was unreachable — which is #1511.
 *
 * So: the WORD is transcribed, an OUTCOME is still never recorded, and the
 * two halves are asserted separately because a case that merged them would
 * go green under a writer that computed the word from the severities.
 */
describe("AC-T8 (#1380, #1511): the reviewer's word is transcribed, an outcome is never computed", () => {
  test("AC-T8: the entry carries the verdict WORD the payload stated", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\nfour\n" },
      payload: { ...ONE_FINDING, verdict: "BLOCK" },
      execution: executionMessages(resultWith("num_turns", 51)),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].verdict).toBe("BLOCK");
  });

  test("AC-T8: it transcribes, so a word that CONTRADICTS the findings survives", () => {
    // The input that separates transcription from computation, and the only
    // one that can: a `PASS` over a `high`. A writer deriving the word from
    // `AI_REVIEW_SEVERITIES` records `BLOCK` here and is green on every
    // agreeing payload, which is most of them.
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\nfour\n" },
      payload: { ...ONE_FINDING, verdict: "PASS" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      r.rounds![0].verdict,
      "the recorded word was derived from the findings rather than read — a " +
        "contradiction cannot be observed through a ledger that repairs it",
    ).toBe("PASS");
  });

  test("AC-T8: no OUTCOME-shaped key is recorded, because this step cannot see one", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\nfour\n" },
      payload: { ...ONE_FINDING, verdict: "BLOCK" },
    });
    expect(r.status, r.stderr).toBe(0);
    const keys = Object.keys(r.rounds![0]);
    expect(keys).not.toContain("outcome");
    expect(keys).not.toContain("blocking");
    expect(keys).not.toContain("adjudicated");
  });

  test("AC-T8: the script states the position that makes a COMPUTED verdict a second decider", () => {
    const src = buildPersistScript();
    expect(src).toContain("NEVER computes a verdict");
    expect(src).toContain("A verdict computed here would be a");
  });
});

/**
 * AC-L16 (#1511): the per-finding projection carries `failure_scenario`.
 *
 * `AI_REVIEW_BLOCKING_REQUIRED_FIELDS` is derived from
 * `AI_REVIEW_FINDING_FIELDS` minus `severity`, so a blocking finding missing
 * `failure_scenario` is `BLOCKING_FINDING_INCOMPLETE` and the whole reading
 * is UNMEASURED. The ledger's projection named four of the five fields, so
 * EVERY blocking finding it ever recorded read back incomplete and
 * `DETECTED` was unreachable through the ledger — #1511, found by #1509.
 *
 * The halves are asserted against each other rather than separately: the
 * recorded value is compared to the value the payload stated, and then the
 * recorded round is driven through `readAiReviewFindings`, the consumer
 * whose refusal started this. A case asserting only that the key is present
 * would be green over a recorder that wrote the key with wrong content.
 */
describe("AC-L16 (#1511): a blocking finding's failure_scenario survives the projection", () => {
  const SCENARIO =
    "call writeGateResult with gates.scope already FAIL and a second PASS " +
    "arriving on the same key: the second write wins and the run reports green";

  const BLOCKING = {
    verdict: "BLOCK",
    findings: [
      {
        severity: "high",
        file: "lib/a.ts",
        line: 2,
        summary: "the later write silently replaces an earlier FAIL",
        failure_scenario: SCENARIO,
      },
    ],
  };

  /** The payload `capture.ts` assembles: the round's word and its findings. */
  function replay(entry: Record<string, any>) {
    return readAiReviewFindings(
      JSON.stringify({ verdict: entry.verdict, findings: entry.findings }),
    );
  }

  test("AC-L16: the scenario is recorded verbatim, byte for byte", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\n" },
      payload: BLOCKING,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings[0].failure_scenario).toBe(SCENARIO);
  });

  test("AC-L16: the recorded round reads back MEASURED through the real consumer", () => {
    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\n" },
      payload: BLOCKING,
    });
    expect(r.status, r.stderr).toBe(0);
    const reading = replay(r.rounds![0]);
    expect(reading.unmeasuredReasons).toEqual([]);
    expect(reading.outcome, reading.detail.join(" | ")).toBe("BLOCKED");
  });

  test("AC-L16: the MUTANT — the field dropped from the projection — is UNMEASURED again", () => {
    // The pre-#1511 projection, restored. The defect verbatim rather than a
    // reconstruction of its shape.
    const real = buildPersistScript();
    const WIDE = ", summary, failure_scenario}";
    expect(
      real.split(WIDE).length - 1,
      "the projection moved — this row mutates a string that is no longer there",
    ).toBe(1);
    const mutant = real.replace(WIDE, ", summary}");

    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\n" },
      payload: BLOCKING,
      script: mutant,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds![0].findings[0].failure_scenario).toBeUndefined();
    const reading = replay(r.rounds![0]);
    expect(reading.outcome).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toContain("BLOCKING_FINDING_INCOMPLETE");
  });

  test("AC-L16: the MUTANT — the verdict word dropped from the entry — is VERDICT_ABSENT", () => {
    // The other half of #1511, mutated at its own binding. The two reasons
    // are separate cases because one fix without the other leaves the
    // capture UNMEASURED and a case asserting only `outcome` cannot say
    // which half is missing.
    const real = buildPersistScript();
    const KEY = "verdict:$verdict, ";
    expect(
      real.split(KEY).length - 1,
      "the entry's verdict member moved — this row mutates a string that is no longer there",
    ).toBe(1);
    const mutant = real.replace(KEY, "");

    const r = runPersist({
      list: [],
      files: { "lib/a.ts": "one\ntwo\nthree\n" },
      payload: BLOCKING,
      script: mutant,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(r.rounds![0])).not.toContain("verdict");
    const reading = readAiReviewFindings(JSON.stringify({ findings: r.rounds![0].findings }));
    expect(reading.outcome).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toContain("VERDICT_ABSENT");
  });
});

/**
 * AC-L17 (#1511): the rendered body is MEASURED, and the eviction says which
 * trigger fired.
 *
 * `AI_REVIEW_LEDGER_MAX_ROUNDS`' twelve was derived from "a pathological
 * round is ~4 KB", an estimate nobody measured, and #1511 adds a prose field
 * underneath it. So the body is rendered and counted before it is sent, and
 * a body over `AI_REVIEW_LEDGER_MAX_BODY` evicts another of the oldest
 * rounds through the SAME `truncated` counter and the SAME annotation.
 *
 * Nothing is ever shortened. A `failure_scenario` cut down reads as a
 * complete one and `blockingContractViolations` cannot see the difference,
 * so a round is dropped whole or not at all — which is the one assertion
 * here a reader should check first.
 */
describe("AC-L17 (#1511): a body that would not fit evicts rounds, loudly", () => {
  /** A prior round whose finding carries `size` characters of scenario. */
  function fatRounds(n: number, size: number) {
    return Array.from({ length: n }, (_, i) => ({
      at: "2026-10-24T00:00:00Z",
      sha: "cafe",
      run: `old-${i}`,
      attempt: "1",
      round: i + 1,
      verdict: "BLOCK",
      findings: [
        {
          severity: "high",
          file: "lib/a.ts",
          line: 2,
          summary: `old finding ${i}`,
          failure_scenario: `${i}`.padEnd(size, "x"),
        },
      ],
    }));
  }

  /**
   * THIS round carries a scenario of its own, and that is load-bearing.
   *
   * The projection only touches the round being written; prior entries are
   * re-serialised as they stand. So a fixture whose new round has no
   * findings cannot see a writer that SHORTENS the field — every scenario it
   * inspects came out of the prior ledger untouched, and the
   * "nothing is shortened" case would survive the trimming fix vacuously.
   */
  function fatRig(size: number) {
    return {
      list: [
        botComment(
          5,
          windowBody(fatRounds(AI_REVIEW_LEDGER_MAX_ROUNDS - 2, size), {
            [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 0,
          }),
        ),
      ],
      files: { "lib/a.ts": "one\ntwo\nthree\n" },
      payload: {
        verdict: "BLOCK",
        findings: [
          {
            severity: "high",
            file: "lib/a.ts",
            line: 2,
            summary: "this round's finding",
            failure_scenario: "n".padEnd(size, "y"),
          },
        ],
      },
    };
  }

  /** The body the rig captured, as GitHub would receive it. */
  function sentBody(r: ReturnType<typeof runPersist>): string {
    return JSON.parse(r.sentRaw!).body as string;
  }

  /** Ten prior rounds plus this one — ELEVEN, deliberately under the cap. */
  const TOTAL = AI_REVIEW_LEDGER_MAX_ROUNDS - 1;

  test("AC-L17: a window UNDER the count cap is still cut to fit, and says so", () => {
    const r = runPersist(fatRig(6000));
    expect(r.status, r.stderr).toBe(0);
    expect(r.method, "nothing was written at all").toBe("PATCH");

    const body = sentBody(r);
    expect(
      body.length,
      `the written body is ${body.length} characters, over the ${AI_REVIEW_LEDGER_MAX_BODY} limit`,
    ).toBeLessThanOrEqual(AI_REVIEW_LEDGER_MAX_BODY);

    // ELEVEN rounds is under the twelve-round cap, so the count cap evicts
    // NOTHING here and every dropped round is the measurement's doing. That
    // is what makes this a reading of size rather than of count.
    expect(TOTAL).toBeLessThan(AI_REVIEW_LEDGER_MAX_ROUNDS);
    expect(r.doc.rounds.length).toBeLessThan(TOTAL);
    expect(r.doc.rounds.length).toBeGreaterThan(0);

    // ONE counter, not two. The number in the comment is how many rounds
    // went missing, by either route.
    expect(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD]).toBe(TOTAL - r.doc.rounds.length);

    // The newest survived and the oldest did not — an eviction that dropped
    // the wrong end keeps the same length and loses every new round.
    expect(JSON.stringify(r.doc), "this round was not recorded").toContain('"run-9"');
    expect(JSON.stringify(r.doc), "old-0 should have been dropped").not.toContain('"old-0"');

    // WHICH trigger fired. "at the twelve-round cap" and "the comment would
    // not fit" are different facts a maintainer acts differently on, so the
    // annotation names the limit rather than the cap.
    expect(r.stdout, "the size eviction was not announced").toContain(
      `exceeded GitHub's ${AI_REVIEW_LEDGER_MAX_BODY} character comment limit`,
    );
    expect(r.stdout, "the size eviction did not say how many rounds it cost").toContain(
      "of the OLDEST round(s) were dropped to make this round fit",
    );
  });

  test("AC-L17 CONTROL: the same number of SMALL rounds keeps the whole window, silently", () => {
    // The pair, varying exactly one thing: the length of one string per
    // finding. Same ten prior rounds, same new round, same everything else.
    const r = runPersist(fatRig(20));
    expect(r.status, r.stderr).toBe(0);
    expect(r.doc.rounds).toHaveLength(TOTAL);
    expect(r.doc[AI_REVIEW_LEDGER_TRUNCATED_FIELD]).toBe(0);
    expect(JSON.stringify(r.doc), "an under-limit ledger lost its oldest round").toContain(
      '"old-0"',
    );
    expect(r.stdout, "the size eviction fired under the limit").not.toContain(
      "character comment limit",
    );
    expect(r.stdout, "the cap warning fired below the cap").not.toContain("OLDEST");
  });

  test("AC-L17: nothing is SHORTENED — this round's scenario and every kept one is whole", () => {
    // The assertion that separates this design from the other one on offer,
    // and the reason `fatRig` gives THIS round a finding: the projection
    // only touches the round being written, so a fixture reading prior
    // entries alone would survive the trimming fix without witnessing it.
    const r = runPersist(fatRig(6000));
    expect(r.status, r.stderr).toBe(0);

    const written = r.doc.rounds[r.doc.rounds.length - 1] as Record<string, any>;
    expect(written.run, "the last entry is not the round just written").toBe("run-9");
    expect(
      written.findings[0].failure_scenario.length,
      "the scenario this round recorded was shortened to make the body fit",
    ).toBe(6000);

    let checked = 0;
    for (const round of r.doc.rounds as Array<Record<string, any>>) {
      for (const f of (round.findings ?? []) as Array<Record<string, unknown>>) {
        if (typeof f.failure_scenario !== "string") continue;
        checked += 1;
        expect(
          f.failure_scenario.length,
          `a kept scenario is ${f.failure_scenario.length} characters, not the 6000 recorded`,
        ).toBe(6000);
      }
    }
    // Vacuity control: a loop over nothing asserts nothing.
    expect(checked, "no kept round carried a scenario, so nothing was checked").toBeGreaterThan(1);
  });

  test("AC-L17: the MUTANT — the measurement raised out of reach — writes an over-limit body", () => {
    // ONE binding, so there is exactly one thing to mutate. Raising the
    // comparison IS the pre-#1511 behaviour: the count cap alone decides,
    // twelve large rounds are assembled, and the body GitHub is handed is
    // over its own limit — a write that fails with nothing but a curl status
    // to say why.
    const real = buildPersistScript();
    const GUARD = `-le ${AI_REVIEW_LEDGER_MAX_BODY} `;
    expect(
      real.split(GUARD).length - 1,
      "the body-size comparison moved — this row mutates a string that is no longer there",
    ).toBe(1);
    const mutant = real.replace(GUARD, "-le 99999999 ");

    const m = runPersist({ ...fatRig(6000), script: mutant });
    expect(m.status, m.stderr).toBe(0);
    expect(m.doc.rounds, "the mutant did not keep the whole window").toHaveLength(TOTAL);
    expect(
      sentBody(m).length,
      "the mutant's body fits, so this fixture cannot witness the measurement",
    ).toBeGreaterThan(AI_REVIEW_LEDGER_MAX_BODY);

    // The control, same rig and the real script: the eviction is the
    // measurement's doing, not something this fixture provokes on its own.
    const control = runPersist(fatRig(6000));
    expect(sentBody(control).length).toBeLessThanOrEqual(AI_REVIEW_LEDGER_MAX_BODY);
    expect(control.doc.rounds.length).toBeLessThan(TOTAL);
  });
});

/**
 * AC-L18 (#1511): the floor. One round that cannot be made to fit REFUSES.
 *
 * The eviction loop stops at one round. A round whose own findings exceed
 * the comment limit cannot be made to fit by evicting anything, so the step
 * writes nothing and leaves the existing ledger exactly as it stood — the
 * direction every other failure in this recorder takes, because an
 * unreadable ledger costs one round and an overwritten one costs all of
 * them.
 *
 * It is a wedge and it is an ANNOUNCED one: the same refusal fires on every
 * subsequent round of that pull request, every run. A known gap beats a
 * silent one, and the alternative — shortening the field — is the lie this
 * whole issue is about.
 */
describe("AC-L18 (#1511): a single round that cannot fit is refused, not trimmed", () => {
  const prior = [
    { at: "2026-10-24T00:00:00Z", sha: "cafe", run: "old-0", attempt: "1", round: 1, findings: [] },
  ];

  function oneRound(scenario: string) {
    return {
      list: [botComment(5, windowBody(prior, { [AI_REVIEW_LEDGER_TRUNCATED_FIELD]: 0 }))],
      files: { "lib/a.ts": "one\ntwo\nthree\n" },
      payload: {
        verdict: "BLOCK",
        findings: [
          { severity: "high", file: "lib/a.ts", line: 2, summary: "s", failure_scenario: scenario },
        ],
      },
    };
  }

  test("AC-L18: nothing is written and the existing ledger is untouched", () => {
    const r = runPersist(oneRound("x".repeat(AI_REVIEW_LEDGER_MAX_BODY + 8_000)));
    expect(r.status, "the recorder failed the job it only observes").toBe(0);
    expect(r.method, "an over-limit body was sent to the API").toBe(null);
    expect(r.stdout, "the refusal was silent").toContain("NOT recorded");
    expect(r.stdout, "the refusal did not name the limit it hit").toContain(
      `over GitHub's ${AI_REVIEW_LEDGER_MAX_BODY} character comment limit`,
    );
    expect(
      r.stdout,
      "the refusal did not say that nothing was shortened, which is the decision",
    ).toContain("Nothing was shortened to make it fit");
  });

  test("AC-L18 CONTROL: the same round with a scenario that FITS is written whole", () => {
    // The pair, varying exactly one thing: the length of one string. A
    // refusal that fired on every large payload would pass the row above.
    const fits = "x".repeat(4_000);
    const r = runPersist(oneRound(fits));
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("PATCH");
    expect(r.doc.rounds).toHaveLength(2);
    expect(r.doc.rounds[1].findings[0].failure_scenario).toBe(fits);
    expect(r.stdout).not.toContain("NOT recorded");
  });
});
