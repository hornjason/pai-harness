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
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_LEDGER_API_VAR,
  AI_REVIEW_LEDGER_BOT_LOGIN,
  AI_REVIEW_LEDGER_IDENTITY_V1,
  AI_REVIEW_LEDGER_MARKER,
  AI_REVIEW_LEDGER_PR_VAR,
  AI_REVIEW_LEDGER_REPO_VAR,
  AI_REVIEW_LEDGER_ROUNDS_FIELD,
  AI_REVIEW_LEDGER_TEXT_FIELD,
  AI_REVIEW_LEDGER_TOKEN_VAR,
  AI_REVIEW_PREPARE_STEP_ID,
  buildCarryScript,
  buildReviewPrompt,
} from "../lib/scaffold/ai-review-step.ts";
import {
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_FINDING_TEXT,
  AI_REVIEW_LEDGER_IDENTITY,
  AI_REVIEW_LEDGER_ROUNDS_KEY,
  type CarriedFinding,
  carryForward,
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

    const curl = [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" >> ${JSON.stringify(argvPath)}`,
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
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", file, state, carried, argv };
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
    const real = buildCarryScript();
    const mutant = real.replace(
      "or ((.now | norm) == (.recorded | norm))",
      "or true",
    );
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
    const mutant = real.replace("(.recorded == null)\n", "(false)\n");
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
