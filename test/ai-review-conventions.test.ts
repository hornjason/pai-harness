/**
 * ai-review-conventions.test.ts — the reviewer is handed this repository's
 * review conventions, and a separate check says whether it loaded them
 * (#1167).
 *
 * ## The defect
 *
 * `claude_args` carries `--setting-sources user`, so project settings never
 * load and none of the eleven files in `.claude/rules/` reaches the agent
 * reviewing against them. There was no `REVIEW.md`, no `CODEOWNERS` and no PR
 * template either: `git ls-tree origin/main .github/` returned `workflows/`
 * and `copilot-instructions.md`. The reviewer got a diff and the generic
 * prompt, and nothing else.
 *
 * ## Why the loader alone would have been half the work
 *
 * Anthropic's own write-up of this (`solving-code-review-at-anthropic`)
 * describes `REVIEW.md` as the code owners' statement of what matters in
 * their part of the tree, and then adds the sentence this file is built to:
 * *"We check separately whether the reviewer actually follows it."*
 *
 * This repository already has eleven rule files' worth of the other thing —
 * an instruction with no compliance reading — and `#1009` is the record of
 * what that costs. A loader with no check would have made twelve.
 *
 * ## The three positions that must agree, and the one constant behind them
 *
 * `AI_REVIEW_CONVENTIONS_FILE` is read in three places and spelled in none
 * of them:
 *
 *   1. `buildReviewPrompt` tells the reviewer to read that name first;
 *   2. `AI_REVIEW_UNTRUSTED_PATHS` restores that name from the pull
 *      request BASE before the reviewer starts, so a branch cannot write
 *      the instructions its own reviewer runs under;
 *   3. `buildReviewRunScript` refuses a payload whose execution transcript
 *      carries no read of that name.
 *
 * A prompt naming one file and a check looking for another is a check that
 * is green on every tree. `AC-C6` is the case that holds them together.
 *
 * ## The evidence is third-party, and that is the whole design
 *
 * The reading comes out of the action's own execution transcript — the
 * `tool_use` blocks the SDK recorded — and never out of the findings payload.
 * A payload field saying "I read the conventions" is the agent grading its
 * own gate, and a reviewer that ignored the file is precisely the reviewer
 * whose self-report is worth nothing.
 *
 * ## An absent transcript REFUSES, and the premise for that was measured
 *
 * The first draft warned there and passed. Two readings turned it round:
 *
 *   * Across this repository's last 40 `ai-review` runs, the step's
 *     `AI_REVIEW_EXECUTION_FILE` is EMPTY on every run the action skipped on
 *     its workflow-validation guard — which is a run with no payload — and
 *     SET on all five where the agent executed. Run `39835040833` is the
 *     decisive one: a findings payload on disk, the adjudicator unable to
 *     fetch, and `/home/runner/work/_temp/claude-execution-output.json` in
 *     the step's env. This block runs only inside `[ -s findings-path ]`, so
 *     wherever it runs a payload exists, so the transcript is there.
 *   * `ai-review-workflow.test.ts` AC-9a asserts a CLEAN adjudication's
 *     output contains no `UNMEASURED` anywhere, so an operator grepping a
 *     green run gets a true answer. A fail-open warning on the success path
 *     breaks that invariant for every consumer.
 *
 * ## What the FIRST version of this check got wrong
 *
 * #1233 shipped a matcher that looked for `"file_path": ".../REVIEW.md"` and
 * nothing else. A review of the merged commit found two ways past it, and
 * the second is the one that mattered:
 *
 *   1. an unanchored directory prefix — a `?`-quantified group running
 *      to the last slash — matched ANY directory, so a `sub/REVIEW.md`
 *      credited a check that is about the ROOT file — the one the
 *      restore step takes from the base. A branch adding its own `docs/REVIEW.md` could have
 *      the reviewer read that instead and still pass. `AC-C1e`.
 *   2. **The tool name was not matched at all.** A `Write` whose
 *      `file_path` ends in `REVIEW.md` leaves the same text in the
 *      transcript as a `Read` does, `Write` is in the reviewer's
 *      allowedTools, and the granted `--add-dir` is OUTSIDE the checkout,
 *      so such a write is not even caught by the drift step. A check whose
 *      whole purpose is to be unsatisfiable without reading was
 *      satisfiable by writing. `AC-C1d`.
 *
 * Both are the second shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * — a detector narrower than what it detects, green for an event that is not
 * the one it names. Both were written as failing cases and watched red
 * against the shipped matcher before anything was changed.
 *
 * The repair binds the tool name to the path within one `tool_use` block —
 * `[^{}]` cannot cross into a neighbouring block — and anchors the path on
 * `${PWD}`, the same directory the `[ -f ]` test reads, escaped through
 * `escape_ere`. Three properties of the repair are themselves falsifiable,
 * and each has a case, because each is a way the stricter matcher could
 * refuse every legitimate review instead: key order (`AC-C2c`), pretty-
 * printed transcripts (`AC-C2d`), and a workspace path carrying a regex
 * metacharacter (`AC-C12`).
 *
 * ## The cheapest wrong fixes, named
 *
 * Two, and both are run rather than argued about.
 *
 * **Restore the shipped single-key matcher** — `AC-C9`. It is what main
 * carried, it is green on every positive case here, and it reopens both
 * bypasses. This is the repair somebody reaches for the first time the
 * anchored matcher refuses a review they believe was fine.
 *
 * **Grep the bare filename anywhere in the transcript** — `AC-C9b`. The
 * five-minute version, and the one that reads most reasonably: *does the
 * transcript mention the conventions at all?* It credits a reviewer that
 * only wrote ABOUT the file. `AC-C1b` is the case that survives it.
 *
 * ## What was broken to prove it
 *
 * Counts and case lists predicted before the battery ran, baseline row read
 * first. Mutations applied by hand to `lib/scaffold/ai-review-step.ts`,
 * reverted, and the file confirmed byte-identical by SHA-256
 * (`2eef3c64…`) — never by `git checkout --`. Over this file alone.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 0 fail | **22 pass, 0 fail** | — |
 * | M1 the whole conventions block deleted | 13 | **14** — C12 as well | a payload whose transcript never read the file: original refuses, mutant adjudicates it clean |
 * | M2 the `[ -f ]` guard replaced by `true` | 2 — C3, C6 | **2**, the same two | a consumer checkout with no conventions file: original passes, mutant refuses |
 * | M3 **the shipped matcher restored** | 5 — C1d, C1e, C9, C9b, C11 | **6** — C12 as well; re-measured **5** after the rebase, see below | a `Write` to the conventions path: original refuses, mutant credits it as a read |
 * | M4 the absent-transcript branch returned to a warning | 2 — C4, C11b | **2**, the same two | a payload with no transcript: original refuses, mutant reports a green check |
 * | M5 the conventions entry removed from `AI_REVIEW_UNTRUSTED_PATHS` | 1 — C6 | **1**, C6 | the restore list: a branch could then supply its own reviewer's instructions |
 * | M6 `tr -d` removed, the file grepped line by line | 2 — C2d, C9 | **2**, the same two | a pretty-printed transcript: original credits the read, mutant refuses every review |
 * | M7 `conv_b` dropped, so only one key order is accepted | 2 — C2c, C9b | **2**, the same two | an input-first `tool_use` block: original credits it, mutant refuses |
 * | M8 `escape_ere` bypassed, `${PWD}` interpolated raw | 1 — C12 | **1**, C12 | a workspace at `…/my.repo` and a read under `…/myXrepo`: original refuses, mutant credits it |
 *
 * **Two rows came back one higher than predicted and both excesses are
 * `AC-C12`.** That is the case working, not noise: C12 is the only case
 * whose subject is the ANCHOR itself, so it reds on any mutation that
 * removes the anchor as well as on the one that unescapes it. M1 deletes the
 * block and M3 replaces the anchored pattern with the same unanchored
 * directory prefix; both leave the decoy path credited. The prediction treated C12 as belonging to M8 alone
 * and simply forgot it is cross-cutting — the same mistake, and the same
 * correction, as AC-F6c in `ai-review-failure-route.test.ts`.
 *
 * Several rows redden a case on *"the mutation did not apply"* rather than
 * on behaviour, and that is also the guard working: C8, C9 and C9b build
 * their mutants by rewriting a string in the generated script, so a mutation
 * that already removed that string leaves them witnessing nothing, and each
 * asserts it still differs before it asserts anything else.
 *
 * ## M3, re-measured after the rebase — and the count that matched by accident
 *
 * The table above was taken against `2eef3c64…`. The rebase onto `76eed806`
 * (#1241, #1187) moved this generator to `70abb0b9…`, so M3 — the row the
 * whole change rests on — was run again there, and it is worth writing down
 * that it came back **5 red: C1d, C1e, C9, C11, C12**.
 *
 * Five was the predicted count. It is **not** the predicted set. `C9b` was
 * predicted and stayed green; `C12` was not predicted and reddened. A count
 * that matches while the membership does not is the reading a battery is
 * supposed to catch, and it would have been invisible without the case list
 * beside the number — which is the argument for predicting the list and not
 * just the total.
 *
 * The two M3 runs differ because a mutation is a thing you SPELL, and the two
 * spellings are not the same experiment. The first replaced the whole
 * `conv_path`/`conv_a`/`conv_b` machinery with the shipped one-line `grep`,
 * which deletes the string `C9b` rewrites to build its own mutant — so C9b
 * reddened on *"the mutation did not apply"*, exactly the paragraph above
 * this one, and not on behaviour. The second kept the variables and restored
 * only the shipped SEMANTICS — the unanchored prefix, the single key — which
 * leaves C9b a string to rewrite and a real check that still refuses a prose
 * mention, so it passes for a true reason.
 *
 * The second spelling is the better experiment and the one to repeat: it
 * changes the behaviour under test and nothing else. Both agree on every row
 * that matters here — C1d and C1e, the two bypasses — and neither is a flake.
 *
 * ## What this does NOT claim
 *
 * It does not claim the reviewer OBEYS the conventions — only that it loaded
 * them. The cap on non-blocking findings and the evidence each finding
 * carries are properties of the payload, adjudicated by
 * `lib/scaffold/ai-review-findings.ts`, and are not this file's subject.
 * Saying so is better than a case whose name implies a reading it does not
 * take.
 *
 * It does not assert anything about the reviewer's INTENT input — the linked
 * issue and the pull request body, which is #1167's second acceptance
 * bullet. The prompt may carry no `${{ }}` expression at all (an expression
 * is substituted before the action sees it, so a repository variable inside
 * the prompt is text an attacker who can set a variable controls), so intent
 * needs a step that writes it to a file under the granted `--add-dir` and a
 * prompt that names the path. That is a second mechanism and it is not here.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_CONVENTIONS_FILE,
  AI_REVIEW_CONVENTIONS_FILE_PATTERN,
  AI_REVIEW_CONVENTIONS_TITLE,
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_UNTRUSTED_PATHS,
  buildReviewPrompt,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";
import { stubBunx } from "./helpers/stub-bunx";

/**
 * A fixture version for the adjudicator's `bunx` pin, never the real one —
 * `ai-review-failure-route.test.ts` gives the reason: passing the tree's own
 * version makes every assertion agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

/** A clean payload, so every case here is about the conventions reading. */
const PAYLOAD = '{"findings": [], "verdict": "PASS"}';

/**
 * One `tool_use` content block.
 *
 * `order` exists because **the key order is not ours to choose**. The block
 * is whatever `JSON.stringify` makes of the SDK's own object, and nothing in
 * this repository pins that. A check that binds the tool NAME to the
 * `file_path` has to hold under either spelling, so both are built here and
 * both are asserted — `AC-C2` reads name-first and `AC-C2c` input-first.
 * Writing only the order that happens to pass is the vacuous-assertion shape.
 */
function toolUse(
  name: string,
  filePath: string,
  order: "name-first" | "input-first" = "name-first",
): unknown {
  return order === "name-first"
    ? { type: "tool_use", id: "toolu_01", name, input: { file_path: filePath } }
    : { type: "tool_use", id: "toolu_01", input: { file_path: filePath }, name };
}

/**
 * A transcript in the shape the action writes: a JSON array of SDK messages,
 * a tool call being a `tool_use` content block on an assistant message.
 *
 * `indent` is a parameter for the same reason `order` is: the action's own
 * `writeExecutionFile` decides whether this document is one line or many, and
 * this repository does not pin that either. A reading that only works on the
 * minified form is a detector narrower than what it detects, and the pretty
 * form is one upstream commit away. `AC-C2d` is the case that holds it.
 */
function transcriptOf(blocks: unknown[], indent = 0): string {
  return JSON.stringify(
    [
      { type: "system", subtype: "init", message: "Claude Code initialized" },
      { type: "assistant", message: { content: blocks } },
      { type: "result", subtype: "success", is_error: false, num_turns: 9 },
    ],
    null,
    indent,
  );
}

/**
 * The common case: some `Read` calls, plus anything else the case wants.
 *
 * Built from parts rather than from a literal so a case can vary exactly one
 * thing — which path the reviewer read — and nothing else.
 */
function transcript(reads: string[], extra: unknown[] = []): string {
  return transcriptOf([...reads.map(p => toolUse("Read", p)), ...extra]);
}

/**
 * Drive the real report step over a workspace this case owns.
 *
 * `cwd` is the scratch directory and not this repository, because the
 * property under test is whether the CHECKOUT carries a conventions file —
 * the step's working directory on a runner is `GITHUB_WORKSPACE`, the tree
 * under review. Inheriting the suite's own cwd would make every case read
 * this repository's `REVIEW.md` and `AC-C3`, the consumer case, could not be
 * written at all.
 *
 * The adjudicator is planted (`stubBunx`) for the reason that helper gives:
 * the real command names this tree's version and would reach the registry.
 * Its default here ANSWERS CLEAN, so a case that reaches it exits 0 — which
 * makes "the conventions refusal fired" and "the adjudication failed"
 * distinguishable by exit code alone.
 */
function runReport(opts: {
  /** `null` writes no conventions file into the workspace. */
  conventions?: string | null;
  /**
   * `null` sets no transcript variable; `"unreadable"` names a missing path.
   * A function receives the workspace directory, because the paths a real
   * reviewer records are absolute and under it — and since #1167's repair the
   * check anchors on exactly that, so a fixture naming some other absolute
   * path would be asserting against a path no runner produces.
   */
  transcript?: string | ((workspace: string) => string) | null | "unreadable";
  payload?: string | null;
  adjudicator?: string;
  script?: string;
  /** Put the workspace in a directory whose name contains a regex metacharacter. */
  dotted?: boolean;
}): Run {
  // RESOLVED, and the fixture is wrong without it. On macOS `tmpdir()` is
  // `/var/folders/…`, a symlink to `/private/var/folders/…`, and a shell
  // spawned with `cwd` there reports the PHYSICAL path in `${PWD}`. Since
  // the check anchors the reviewer's read on `${PWD}`, a transcript built
  // from the unresolved path names a directory the step never sees — so
  // every positive case would fail for a reason that is this harness's and
  // not the step's, and a later editor would "fix" it by loosening the
  // anchor. A runner has no such symlink; resolving here makes the fixture
  // model the runner rather than this laptop.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ai-review-conventions-")));
  scratch.push(root);

  // `dotted` puts the workspace in a directory whose name carries a `.`,
  // which is what a runner does for any repository with one in its name —
  // `/home/runner/work/my.repo/my.repo`. It is the only input on which an
  // escaped anchor and an unescaped one differ, so it is the only input
  // that can say whether `escape_ere` is doing anything. AC-C12.
  const dir = opts.dotted ? join(root, DOTTED_DIR) : root;
  if (opts.dotted) mkdirSync(dir, { recursive: true });

  const sh = join(dir, "report.sh");
  writeFileSync(sh, opts.script ?? buildReviewRunScript(FIXTURE_VERSION));
  writeFileSync(join(dir, "github_output"), "");

  if (opts.conventions !== null) {
    writeFileSync(join(dir, AI_REVIEW_CONVENTIONS_FILE), opts.conventions ?? "# conventions\n");
  }

  const env: Record<string, string> = {
    PATH: stubBunx(opts.adjudicator ?? `echo "${AI_REVIEW_OUTCOME_LINE} CLEAN"; exit 0`),
    HOME: process.env.HOME ?? dir,
    GITHUB_OUTPUT: join(dir, "github_output"),
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: "success",
  };
  // The runner sets this on every step. The scratch directory IS the
  // workspace here, which is what makes `cwd` and the anchored paths agree.
  env.GITHUB_WORKSPACE = dir;

  const payload = opts.payload === undefined ? PAYLOAD : opts.payload;
  if (payload !== null) {
    const findings = join(dir, "ai-review-findings.json");
    writeFileSync(findings, payload);
    env[AI_REVIEW_FINDINGS_PATH_VAR] = findings;
  }

  if (opts.transcript === "unreadable") {
    env[AI_REVIEW_EXECUTION_FILE_VAR] = join(dir, "claude-execution-output.json");
  } else if (opts.transcript !== null && opts.transcript !== undefined) {
    const p = join(dir, "claude-execution-output.json");
    writeFileSync(
      p,
      typeof opts.transcript === "function" ? opts.transcript(dir) : opts.transcript,
    );
    env[AI_REVIEW_EXECUTION_FILE_VAR] = p;
  }

  const r = Bun.spawnSync(["bash", "-e", sh], { cwd: dir, env });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

/**
 * A workspace directory name carrying an ERE metacharacter, and the decoy
 * that differs from it only where that metacharacter sits. GitHub allows a
 * `.` in a repository name, so `/home/runner/work/my.repo/my.repo` is an
 * ordinary runner path — and unescaped, its `.` matches `X`.
 */
const DOTTED_DIR = "my.repo";
const DOTTED_DECOY = "myXrepo";

/** The conventions at the absolute path the reviewer's checkout puts them at. */
const conventionsIn = (workspace: string) => join(workspace, AI_REVIEW_CONVENTIONS_FILE);

/** Any other file in the same checkout, for the cases that need a non-match. */
const otherFileIn = (workspace: string) => join(workspace, "lib", "scanner.ts");

describe("AC-C: the reviewer's load of the conventions is read, not assumed (#1167)", () => {
  test("AC-C1: a review whose transcript never read the conventions is refused", () => {
    const run = runReport({
      transcript: (ws: string) => transcript([otherFileIn(ws)]),
    });

    expect(
      run.code,
      `a review that ignored the conventions reported a green check:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.err, "the refusal does not name the file it is about").toContain(
      AI_REVIEW_CONVENTIONS_FILE,
    );
    expect(run.err, "the refusal is not titled as unmeasured").toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );
    // BEFORE the adjudication, which is the placement claim and not a
    // decoration: the planted adjudicator answers CLEAN and exits 0, so its
    // outcome line in the log would mean the refusal came after a verdict
    // had already been taken over findings produced without the conventions.
    expect(
      run.out,
      "the adjudicator ran anyway, so a verdict was taken over an unconventioned review",
    ).not.toContain(AI_REVIEW_OUTCOME_LINE);
  });

  test("AC-C1b: a transcript that MENTIONS the conventions without reading them is refused", () => {
    // The input the cheapest wrong fix cannot tell apart. The reviewer
    // grepped for the name and wrote a finding about the file; it never
    // opened it.
    const run = runReport({
      transcript: (ws: string) =>
        transcript(
          [otherFileIn(ws)],
          [
            {
              type: "tool_use",
              name: "Grep",
              input: { pattern: AI_REVIEW_CONVENTIONS_FILE, path: "." },
            },
            { type: "text", text: `No ${AI_REVIEW_CONVENTIONS_FILE} conventions were applicable.` },
          ],
        ),
    });

    expect(
      run.code,
      `a mention of the file was accepted as a read of it:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-C1c: a read of a DIFFERENT file whose name ends in the same word is refused", () => {
    // The anchor. `docs/OLD-REVIEW.md` contains `REVIEW.md` as a substring,
    // and an unanchored match would credit it.
    const run = runReport({
      transcript: (ws: string) =>
        transcript([join(ws, "docs", `OLD-${AI_REVIEW_CONVENTIONS_FILE}`)]),
    });

    expect(
      run.code,
      `a read of a different file was credited as the conventions:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-C1d: a WRITE to the conventions path is not a read of it", () => {
    // The gate bypass the team lead's review caught on the shipped version
    // (#1233, live on main at ai-review.yml). The first matcher looked for
    // `"file_path": ".../REVIEW.md"` and NOTHING ELSE, and a `Write` block
    // carries exactly that text. `Write` is in the reviewer's allowedTools
    // and the granted `--add-dir` is outside the checkout, so a reviewer
    // could satisfy the check by writing a file it never read — in the one
    // directory the drift step does not watch.
    const run = runReport({
      transcript: (ws: string) =>
        transcriptOf([toolUse("Read", otherFileIn(ws)), toolUse("Write", conventionsIn(ws))]),
    });

    expect(
      run.code,
      `a WRITE satisfied a check about reading:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-C1e: a read of the conventions name in a SUBDIRECTORY is not the root one", () => {
    // The second half of the same review. `([^"]*/)?` matched any directory,
    // so a `sub/REVIEW.md` anywhere in the tree credited a check that is
    // about the root file — and the root file is the one the restore step
    // takes from the base. A branch that adds its own `docs/REVIEW.md` could
    // have the reviewer read that instead and still pass.
    const run = runReport({
      transcript: (ws: string) =>
        transcript([join(ws, "sub", AI_REVIEW_CONVENTIONS_FILE)]),
    });

    expect(
      run.code,
      `a subdirectory file was credited as the root conventions:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-C2: THE CONTROL — a transcript carrying the read passes, and says so", () => {
    // Without this the refusal above is indistinguishable from a gate stuck
    // closed, which is the state `ai-review-workflow.test.ts` AC-9a exists to
    // rule out one branch further on.
    const run = runReport({ transcript: (ws: string) => transcript([conventionsIn(ws)]) });

    expect(
      run.code,
      `a review that DID read the conventions was refused:\n${run.out}\n${run.err}`,
    ).toBe(0);
    expect(run.out, "the positive reading was not emitted").toContain(
      AI_REVIEW_CONVENTIONS_TITLE,
    );
    expect(run.out, "the adjudication did not run after the conventions reading").toContain(
      AI_REVIEW_OUTCOME_LINE,
    );
    // The invariant AC-9a holds elsewhere, asserted here for the one branch
    // this change added to the green path.
    expect(run.out, "a passing conventions reading still reported UNMEASURED").not.toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );
  });

  test("AC-C2b: a relative read of the conventions counts", () => {
    // The agent's cwd is the workspace, so a bare `REVIEW.md` is a legitimate
    // spelling of the same read. The pattern anchors at a path separator OR
    // at the opening quote for exactly this.
    const run = runReport({ transcript: transcript([AI_REVIEW_CONVENTIONS_FILE]) });
    expect(
      run.code,
      `a relative read of the conventions was not credited:\n${run.out}\n${run.err}`,
    ).toBe(0);
  });

  test("AC-C2c: the read counts whichever order the SDK serialised the block in", () => {
    // The non-vacuity control for AC-C1d. Binding the tool name to the path
    // means the matcher now depends on how the two sit together in the JSON,
    // and nothing here pins that order. If only one spelling is accepted,
    // the check is one upstream serialisation change away from refusing
    // every review — which is the failure direction that costs the most.
    const run = runReport({
      transcript: (ws: string) =>
        transcriptOf([toolUse("Read", conventionsIn(ws), "input-first")]),
    });

    expect(
      run.code,
      `an input-first tool_use block was not credited:\n${run.out}\n${run.err}`,
    ).toBe(0);
  });

  test("AC-C2d: a pretty-printed transcript is read the same as a minified one", () => {
    // `writeExecutionFile` upstream decides whether this document is one
    // line or many, and a line-oriented `grep` over a multi-key pattern
    // reads them differently. A detector that only works on the minified
    // form is narrower than what it detects.
    const run = runReport({
      transcript: (ws: string) => transcriptOf([toolUse("Read", conventionsIn(ws))], 2),
    });

    expect(
      run.code,
      `a pretty-printed transcript was read as having no conventions load:\n${run.out}\n${run.err}`,
    ).toBe(0);
  });

  test("AC-C3: a consumer checkout with no conventions file is not refused", () => {
    // This generator writes jobs for repositories that have never heard of
    // the file. A gate that refuses them is a gate that gets deleted.
    const run = runReport({
      conventions: null,
      transcript: transcript(["/home/runner/work/consumer/consumer/src/index.ts"]),
    });

    expect(
      run.code,
      `a consumer with no conventions document was refused:\n${run.out}\n${run.err}`,
    ).toBe(0);
    expect(
      run.out + run.err,
      "a repository with no conventions file was told about conventions",
    ).not.toContain(AI_REVIEW_CONVENTIONS_TITLE);
    expect(run.out, "the adjudication did not run").toContain(AI_REVIEW_OUTCOME_LINE);
  });

  test("AC-C4: a payload with no readable transcript is refused, and says something else", () => {
    const run = runReport({ transcript: "unreadable" });

    expect(
      run.code,
      `a payload nothing can be read about reported a green check:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.err, "the refusal is not titled as unmeasured").toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );

    // A DIFFERENT sentence from AC-C1's. Two states wearing one message is
    // two states nobody can tell apart from outside the job — the defect
    // `ai-review-failure-route.test.ts` AC-F6c is the control for.
    const ignored = runReport({
      transcript: (ws: string) => transcript([otherFileIn(ws)]),
    });
    expect(
      run.err,
      "an absent transcript and an ignored file produce the same sentence",
    ).not.toBe(ignored.err);
  });

  test("AC-C5: no payload means no conventions reading — the states do not merge", () => {
    // The block is inside the payload branch on purpose. With no payload the
    // review did not happen at all, and that is already reported by #1180's
    // refusal; reporting it twice under two titles is one state as two.
    const run = runReport({ payload: null, transcript: (ws: string) => transcript([conventionsIn(ws)]) });
    expect(
      run.out + run.err,
      "a run with no payload was adjudicated on its conventions",
    ).not.toContain(AI_REVIEW_CONVENTIONS_TITLE);
  });

  test("AC-C11: the anchor is THIS checkout, not any absolute path ending in the name", () => {
    // The anchor is `${PWD}` — the same directory the `-f` test above read,
    // so the two cannot disagree about which checkout is being talked about.
    // This is the case that fails if the anchor is ever dropped back to
    // "some directory, then the name": a conventions file at an absolute
    // path outside this workspace is not this repository's, and the
    // reviewer reading one has not read the one the restore step placed.
    const run = runReport({
      transcript: () =>
        transcript([join("/somewhere/else/entirely", AI_REVIEW_CONVENTIONS_FILE)]),
    });

    expect(
      run.code,
      `a conventions file outside the checkout was credited:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.err, "the refusal is not titled as unmeasured").toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );
  });

  test("AC-C12: the anchor is ESCAPED — a `.` in the workspace is not a wildcard", () => {
    // The only input on which `escape_ere` and no escaper at all differ.
    // Without it the anchor for `/…/my.repo` matches `/…/myXrepo`, so a
    // check that reads as anchored accepts a path from a directory that is
    // not this checkout — the bypass AC-C11 refuses, reopened by the
    // escaping rather than by the pattern.
    const run = runReport({
      dotted: true,
      transcript: (ws: string) =>
        transcript([conventionsIn(ws.replace(DOTTED_DIR, DOTTED_DECOY))]),
    });

    expect(
      run.code,
      `an unescaped '.' in the workspace matched a different directory:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);

    // The pair: the real path in the same dotted workspace still passes, so
    // this is not a case that reds because dotted workspaces break outright.
    expect(
      runReport({ dotted: true, transcript: (ws: string) => transcript([conventionsIn(ws)]) }).code,
      "the escaped anchor refused the real path in a dotted workspace",
    ).toBe(0);
  });

  test("AC-C11b: the two conventions refusals say different things", () => {
    // Both wear AI_REVIEW_UNMEASURED_TITLE, which every other refusal in
    // this step wears too, so the title cannot be what tells them apart. An
    // operator who cannot tell "the reviewer ignored the file" from "there
    // was nothing to read it in" goes looking in the wrong place — the
    // defect `ai-review-failure-route.test.ts` AC-F6c is the control for.
    const ignored = runReport({ transcript: (ws: string) => transcript([otherFileIn(ws)]) });
    const noTranscript = runReport({ transcript: "unreadable" });

    expect(ignored.code, "the ignored-file state did not refuse").toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(noTranscript.code, "the absent-transcript state did not refuse").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(
      new Set([ignored.err, noTranscript.err]).size,
      "two conventions states produce one sentence",
    ).toBe(2);
  });

  test("AC-C6: the prompt, the restore list and the check all name ONE file", () => {
    // Three literals that agree today are two deciders too many. Changing
    // the constant must move all three or this case reds.
    expect(
      buildReviewPrompt(),
      "the prompt does not tell the reviewer to read the conventions",
    ).toContain(AI_REVIEW_CONVENTIONS_FILE);

    expect(
      AI_REVIEW_UNTRUSTED_PATHS,
      "the conventions are not restored from the base, so a branch can write its own reviewer's instructions",
    ).toContain(AI_REVIEW_CONVENTIONS_FILE);

    const script = buildReviewRunScript(FIXTURE_VERSION);
    expect(script, "the check does not test for the file in the checkout").toContain(
      `[ -f "${AI_REVIEW_CONVENTIONS_FILE}" ]`,
    );
    expect(script, "the check does not grep the transcript for a read of it").toContain(
      AI_REVIEW_CONVENTIONS_FILE_PATTERN,
    );
  });

  test("AC-C6b: the escaped pattern is DERIVED, so a rename cannot leave it behind", () => {
    // `REVIEW.md` and `REVIEW\.md` differ by one backslash, which is the
    // kind of difference a reader checks once and never again.
    expect(AI_REVIEW_CONVENTIONS_FILE_PATTERN.replace(/\\/g, "")).toBe(
      AI_REVIEW_CONVENTIONS_FILE,
    );
    expect(
      new RegExp(`^${AI_REVIEW_CONVENTIONS_FILE_PATTERN}$`).test(AI_REVIEW_CONVENTIONS_FILE),
      "the escaped pattern does not match the name it was derived from",
    ).toBe(true);
    expect(
      new RegExp(`^${AI_REVIEW_CONVENTIONS_FILE_PATTERN}$`).test(
        AI_REVIEW_CONVENTIONS_FILE.replace(".", "X"),
      ),
      "the pattern's `.` is unescaped, so it matches any character",
    ).toBe(false);
  });

  test("AC-C7: the COMMITTED workflow carries the check, not only the generator", () => {
    // `ai-review-surface-census.test.ts` compares the whole file against a
    // regeneration, which covers this and everything else. Named here too
    // because a generator change that was never scaffolded is the one way
    // this work ships inert, and a case that says so by name is cheaper to
    // read than a byte diff.
    const committed = readFileSync(
      join(import.meta.dir, "..", ".github", "workflows", "ai-review.yml"),
      "utf8",
    );
    expect(committed, "the committed workflow has no conventions check").toContain(
      `[ -f "${AI_REVIEW_CONVENTIONS_FILE}" ]`,
    );
    expect(committed, "the committed prompt does not name the conventions").toContain(
      `\`${AI_REVIEW_CONVENTIONS_FILE}\``,
    );
  });

  test("AC-C8: THE MUTANT — the refusals stop when the exit constant is zeroed", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job
    // is to exit non-zero". Both refusals are observed STOPPING, which is the
    // removal of the non-zero exit performed rather than argued about.
    const real = buildReviewRunScript(FIXTURE_VERSION);
    const mutant = real.replace(
      new RegExp(`exit ${AI_REVIEW_REQUIRED_EXIT}\\n(\\s*)fi\\n(\\s*)else`),
      "exit 0\n$1fi\n$2else",
    );
    expect(mutant, "the mutation did not apply").not.toBe(real);

    const ignoredReal = runReport({
      transcript: (ws: string) => transcript([otherFileIn(ws)]),
    });
    const ignoredMutant = runReport({
      transcript: (ws: string) => transcript([otherFileIn(ws)]),
      script: mutant,
    });

    expect(ignoredReal.code, "the real script did not refuse").toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      ignoredMutant.code,
      "the mutant did not differ — this case witnesses nothing about the refusal",
    ).toBe(0);
  });

  test("AC-C9: THE REGRESSION — the shipped single-key matcher, restored and run", () => {
    // Not a hypothetical wrong fix: this IS what #1233 shipped to main, and
    // it is the repair somebody reaches for the moment the anchored matcher
    // refuses a review they believe was fine. It is shorter, it is green on
    // every positive case in this file, and it reopens both bypasses.
    //
    // Applied rather than described. The three inputs it is run on are the
    // three it cannot tell apart: a mention, a Write, and a subdirectory
    // file.
    const real = buildReviewRunScript(FIXTURE_VERSION);
    const shipped = real.replace(
      /\n *if tr -d '\\n' <[^\n]*\n/,
      `\n        if grep -qE '"file_path"[[:space:]]*:[[:space:]]*"([^"]*/)?${AI_REVIEW_CONVENTIONS_FILE_PATTERN}"' "\${${AI_REVIEW_EXECUTION_FILE_VAR}}"; then\n`,
    );
    expect(shipped, "the mutation did not apply").not.toBe(real);

    const written = (ws: string) =>
      transcriptOf([toolUse("Read", otherFileIn(ws)), toolUse("Write", conventionsIn(ws))]);
    const nested = (ws: string) => transcript([join(ws, "sub", AI_REVIEW_CONVENTIONS_FILE)]);

    // A MENTION is deliberately not in this list. The shipped matcher
    // refuses one correctly — it wanted a `file_path` key, and prose has
    // none — so putting it here would be a row that reds for a reason that
    // is not this mutation's. The mention is AC-C9b's subject, against the
    // other repair.
    for (const [name, t] of [
      ["a WRITE", written],
      ["a subdirectory file", nested],
    ] as const) {
      expect(
        runReport({ transcript: t }).code,
        `the real check accepted ${name} as a read of the conventions`,
      ).toBe(AI_REVIEW_REQUIRED_EXIT);
      expect(
        runReport({ transcript: t, script: shipped }).code,
        `the shipped matcher already refused ${name}, so this is not the regression it is named for`,
      ).toBe(0);
    }

    // And it is a PLAUSIBLE repair, which is what makes it the dangerous
    // one: it passes the legitimate read too.
    expect(
      runReport({ transcript: (ws: string) => transcript([conventionsIn(ws)]), script: shipped })
        .code,
      "the regression is not a plausible repair, so naming it proves nothing",
    ).toBe(0);
  });

  test("AC-C9b: THE OTHER CHEAP FIX — grep the bare name anywhere in the transcript", () => {
    // The five-minute version, and the one that looks most reasonable
    // written down: "does the transcript mention the conventions at all?"
    // It credits a reviewer that only wrote ABOUT the file. AC-C1b is the
    // case that survives it.
    const real = buildReviewRunScript(FIXTURE_VERSION);
    const bare = real.replace(
      /grep -qE "\$\{conv_a\}\|\$\{conv_b\}"/,
      `grep -qE '${AI_REVIEW_CONVENTIONS_FILE_PATTERN}'`,
    );
    expect(bare, "the mutation did not apply").not.toBe(real);

    const mention = (ws: string) =>
      transcript(
        [otherFileIn(ws)],
        [{ type: "text", text: `No ${AI_REVIEW_CONVENTIONS_FILE} conventions were applicable.` }],
      );

    expect(
      runReport({ transcript: mention }).code,
      "the real check accepted a mention as a read of the conventions",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      runReport({ transcript: mention, script: bare }).code,
      "the bare-name grep already refused a mention, so AC-C1b is not the case that survives it",
    ).toBe(0);
    expect(
      runReport({ transcript: (ws: string) => transcript([conventionsIn(ws)]), script: bare }).code,
      "the bare-name grep is not a plausible repair, so naming it proves nothing",
    ).toBe(0);
  });

  test("AC-C10: the conventions document the prompt points at exists", () => {
    // A prompt telling an agent to read a doc that is not there is the
    // `.claude/rules/self-referential-tests.md` row, applied to the one
    // reader that cannot ask anybody.
    const path = join(import.meta.dir, "..", AI_REVIEW_CONVENTIONS_FILE);
    const body = readFileSync(path, "utf8");
    expect(body.length, "the conventions document is empty").toBeGreaterThan(0);
    // The three things the prompt promises it states. Checked as subjects
    // rather than as wording: this document is prose a human owns, and a
    // byte-comparison against the prompt would make editing it a test
    // failure.
    for (const subject of ["flag", "evidence", "generated"]) {
      expect(
        body.toLowerCase(),
        `the prompt tells the reviewer this document covers "${subject}" and it does not`,
      ).toContain(subject);
    }
  });
});
