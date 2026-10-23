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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_LEDGER_API_VAR,
  AI_REVIEW_LEDGER_MARKER,
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
  /** The round number file's contents. */
  round?: string;
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
    const roundPath = join(dir, "round.txt");
    writeFileSync(roundPath, rig.round ?? "2");

    const script = join(dir, "persist.sh");
    writeFileSync(script, rig.script ?? buildPersistScript());

    const r = spawnSync("bash", ["-e", script], {
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
    const body = ledgerBody([{ run: "run-1" }]);
    const r = runPersist({ list: [{ id: 5, body }], payload: ONE_FINDING });
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
      { severity: "high", file: "lib/a.ts", line: 4, summary: "s" },
    ]);
    expect(r.rounds![0].round).toBe(2);
  });

  /**
   * The point of the whole issue, in one row. A ledger that replaced its
   * contents each round would satisfy AC-L1 exactly and make the finding set
   * no more cumulative than the runner did.
   */
  test("AC-L1: a second round PATCHes, and the EARLIER round is still there", () => {
    const prior = [{ at: "t0", sha: "cafe", run: "run-1", attempt: "1", round: 1, findings: [] }];
    const r = runPersist({ list: [{ id: 5, body: ledgerBody(prior) }], payload: ONE_FINDING });
    expect(r.status, r.stderr).toBe(0);
    expect(r.method).toBe("PATCH");
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds![0].run).toBe("run-1");
    expect(r.rounds![1].run).toBe("run-9");
  });

  test("AC-L1 CONTROL: a comment WITHOUT the marker is not mistaken for the ledger", () => {
    // Otherwise the first row is consistent with "upsert whatever comment is
    // last", which would overwrite a human's comment and lose every round.
    const r = runPersist({ list: [{ id: 9, body: "a human talking about ```json [] ```" }], payload: ONE_FINDING });
    expect(r.method).toBe("POST");
    expect(r.rounds).toHaveLength(1);
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
    const r = runPersist({ list: [{ id: 5, body: broken }], payload: ONE_FINDING });
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
    ["an unreadable existing ledger", { list: [{ id: 5, body: `${AI_REVIEW_LEDGER_MARKER}\nnope` }] }],
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
