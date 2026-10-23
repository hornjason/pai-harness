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

import { describe, expect, test } from "bun:test";
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
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_LEDGER_API_VAR,
  AI_REVIEW_LEDGER_IDENTITY_V1,
  AI_REVIEW_LEDGER_BOT_LOGIN,
  AI_REVIEW_LEDGER_MARKER,
  AI_REVIEW_LEDGER_MAX_ROUNDS,
  AI_REVIEW_LEDGER_PR_VAR,
  AI_REVIEW_LEDGER_REPO_VAR,
  AI_REVIEW_LEDGER_SHA_VAR,
  AI_REVIEW_LEDGER_TOKEN_VAR,
  AI_REVIEW_PERSIST_STEP_ID,
  AI_REVIEW_ROUND_PATH_VAR,
  buildPersistScript,
} from "../lib/scaffold/ai-review-step";

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github", "workflows", "ai-review.yml");

/** A ledger comment as the step itself would have written it. */
function botComment(id: number, body: string) {
  return { id, user: { type: "Bot", login: "github-actions[bot]" }, body };
}

/** A comment body in the ledger's own format, holding `rounds`. */
function ledgerBody(rounds: unknown[]): string {
  return [
    AI_REVIEW_LEDGER_MARKER,
    "### AI review findings ledger",
    "",
    "```json",
    JSON.stringify(rounds),
    "```",
  ].join("\n");
}

interface Rig {
  /** The comment list the GET answers with. `null` makes the GET FAIL. */
  list?: unknown[] | null;
  /** The findings payload on disk. `undefined` plants no file at all. */
  payload?: unknown;
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
        [AI_REVIEW_FINDINGS_PATH_VAR]: findingsPath,
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
    let rounds: any[] | null = null;
    if (sentRaw !== null) {
      const body = JSON.parse(sentRaw).body as string;
      const fenced = body.split("```json")[1]?.split("```")[0];
      rounds = fenced === undefined ? null : JSON.parse(fenced);
    }
    const method = argv.includes("PATCH") ? "PATCH" : argv.includes("POST") ? "POST" : null;
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", argv, rounds, method, sentRaw };
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
      { severity: "high", file: "lib/a.ts", line: 4, summary: "s", text: "" },
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
    // the cheapest wrong implementation: carry on with an empty `comments`.
    const real = buildPersistScript();
    const mutant = real.replace(
      /  ledger_note "the pull request's comments could not be read[\s\S]*?\n  exit 0\n/,
      '  comments="[]"\n',
    );
    expect(mutant, "the mutation did not apply").not.toBe(real);
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
      const texts = r.rounds![0].findings.map((f: any) => f.text);
      expect(r.sentRaw, "an absolute path was read into a public comment").not.toContain(
        "THE-SECRET-LINE",
      );
      // The control is what makes the two empties above a refusal rather than
      // a step that records nothing at all.
      expect(texts).toEqual(["", "", "alpha"]);
    } finally {
      rmSync(secret, { force: true });
    }
  });

  test("AC-L9: an unreadable or absent anchor records the empty string, and never fails", () => {
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
    expect(r.rounds![0].findings.map((f: any) => f.text)).toEqual(["", "", "", ""]);
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

  test("AC-L11: at the cap the OLDEST round is dropped and the drop is announced", () => {
    const full = Array.from({ length: AI_REVIEW_LEDGER_MAX_ROUNDS }, (_, i) => ({
      at: `t${i}`,
      sha: "cafe",
      run: `run-${i}`,
      attempt: "1",
      round: i + 1,
      findings: [],
    }));
    const r = runPersist({ list: [botComment(5, ledgerBody(full))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds, "the ledger grew past its cap").toHaveLength(AI_REVIEW_LEDGER_MAX_ROUNDS);
    // The oldest is gone and the newest is present — a cap that dropped the
    // WRONG end keeps the same length and loses every new round instead.
    expect(JSON.stringify(r.rounds), "run-0 should have been dropped").not.toContain('"run-0"');
    expect(JSON.stringify(r.rounds)).toContain('"run-9"');
    expect(JSON.stringify(r.rounds), "this round was not recorded").toContain('"run-9"');
    // A dropped round is gone, not empty. Silence here would make the ledger
    // a window that reports as a history.
    expect(r.stdout, "the ledger dropped a round and said nothing").toContain("cap");
  });

  test("AC-L11: under the cap nothing is dropped and nothing is announced", () => {
    // The control for the row above: the warning must not fire on every run.
    const few = [{ at: "t0", sha: "cafe", run: "run-0", attempt: "1", round: 1, findings: [] }];
    const r = runPersist({ list: [botComment(5, ledgerBody(few))], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.rounds).toHaveLength(2);
    expect(JSON.stringify(r.rounds), "an under-cap ledger lost its oldest round").toContain(
      '"run-0"',
    );
    expect(r.stdout, "the cap warning fired below the cap").not.toContain("cap");
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
    expect(r.rounds![0].findings.map((f: any) => f.text)).toEqual(["", "", "alpha"]);
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
    const mutant = real.replace('[ ! -L "${rf}" ] && ', "");
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

    expect(runPersist({ ...rig }).rounds![0].findings[0].text).toBe("");
    expect(
      runPersist({ ...rig, script: mutant }).rounds![0].findings[0].text,
      "removing `! -L` changed nothing, so the guard decides no input at all",
    ).toBe("alpha");
  });

  test("AC-L12: the MUTANT — containment removed — posts through a linked parent", () => {
    // `! -L` stays. Only the pattern that requires the resolved path to sit
    // under the workspace is widened to match everything, so this row cannot
    // go green on the guard the row above already covers.
    const real = buildPersistScript();
    const mutant = real.replace('"${root}"/*)', "*)");
    expect(mutant, "the containment pattern was not found, so nothing was mutated").not.toBe(real);
    const r = runWithLinks(mutant);
    expect(
      r.sentRaw,
      "removing containment did not leak, so `! -L` alone is being credited for it",
    ).toContain(VIA_PARENT);
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
      expect(r.rounds![0].findings[0].text).toBe("");
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
    expect(r.rounds![0].findings.map((f: any) => f.text)).toEqual(["", "alpha"]);
  });
});
