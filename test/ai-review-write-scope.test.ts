/**
 * ai-review-write-scope.test.ts — the reviewer may not write into the tree
 * it is reviewing (#817, and #677 AC-1 reopened by #800).
 *
 * On PR #815 the reviewer modified `.claude/rules/self-referential-tests.md`
 * — an imperative-voice rules document that happened to be in the diff — and
 * the `git diff --exit-code` drift step refused the review. Twice, the same
 * file, deterministically. The guard was right and the review was unusable.
 *
 * Two things are wrong and they need separate fixes, because either one alone
 * leaves the other standing:
 *
 *   - the reviewer COULD write into the checkout — `Write` was granted bare
 *   - the reviewer WANTED to, because it read a document addressed to an
 *     agent and acted on it rather than reviewing it. That is the injection
 *     shape with a benign payload, and the generated prompt said nothing
 *     about repo content being data, while the hand-written
 *     `.github/workflows/claude-review.yml` has said so since #732
 *
 * ## The trap this file exists to keep shut
 *
 * The obvious repair is `Write(//path/**)`. Claude Code's permission
 * documentation says it is accepted and NEVER CONSULTED — file permissions
 * are checked against `Edit(path)` and `Read(path)` rules only. A reviewer
 * reading the diff would see a scoped grant; the tree would be exactly as
 * writable as before. `.claude/rules/checks-must-be-able-to-fail.md`'s whole
 * subject, arriving in a permission string.
 *
 * So the first case below is a prohibition on the WRONG spelling, and it is
 * the most valuable case in the file: it fails on the fix somebody reaches
 * for first.
 *
 * ## What is NOT proved here
 *
 * That the rule is honoured at run time. No test in this repository can
 * establish that — it needs a real review on a real runner, and it is the
 * issue's own AC-5. What these cases establish is that the rule is SPELLED in
 * the form the documentation says is consulted, survives into the generated
 * file intact, and is not silently the inert form.
 *
 * The `git diff --exit-code` drift step remains the thing that MEASURES
 * whether the tree moved, and a case below asserts it is still there — a
 * permission is a claim and a diff is a reading.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_FINDINGS_BASENAME,
  AI_REVIEW_FINDINGS_DIR_OUTPUT,
  AI_REVIEW_FINDINGS_DIR_SUFFIX,
  AI_REVIEW_JOB,
  AI_REVIEW_PREPARE_STEP_ID,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_SETTING_SOURCES,
  AI_REVIEW_WORKSPACE_WRITE_DENY,
  AI_REVIEW_WORKFLOW_FILE,
  aiReviewClaudeArgs,
  buildPrepareScript,
  buildReviewPrompt,
  vertexCiConfig,
  type VertexCiDecision,
} from "../lib/scaffold/ai-review-step";

/**
 * Run the real prepare script with a chosen `RUNNER_TEMP`, and read back
 * what it told the rest of the job through `GITHUB_OUTPUT`.
 *
 * The outputs are read from the FILE the script appends to, not from its
 * stdout: that is the channel the workflow actually consumes, and a script
 * that echoes a path while writing nothing to `GITHUB_OUTPUT` hands every
 * later step an empty string.
 */
function runPrepare(
  runnerTemp?: string,
  extraEnv: Record<string, string> = {},
  shims: Record<string, string> = {},
): {
  code: number;
  dir: string;
  path: string;
  out: { stdout: string; stderr: string; runnerTemp: string };
} {
  const home = mkdtempSync(join(tmpdir(), "rg-824-home-"));
  scratch.push(home);
  const temp = runnerTemp ?? home;
  const outputFile = join(home, "github-output");
  writeFileSync(outputFile, "");

  // Tool shims, prepended to PATH. The two readings this step depends on —
  // `chmod` taking, and `stat` reading the mode back — have no input a unit
  // test can supply as a non-root user: a filesystem that ignores modes, a
  // runner with no `stat`. Replacing the TOOL is the input. `shimsWork`
  // below is the instrument control that a shim directory on PATH does not
  // by itself change the verdict.
  let path = process.env.PATH ?? "/usr/bin:/bin";
  if (Object.keys(shims).length > 0) {
    const bin = join(home, "shim-bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(shims)) {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    }
    path = `${bin}:${path}`;
  }

  const scriptPath = join(home, "prepare.sh");
  writeFileSync(scriptPath, buildPrepareScript());
  const r = Bun.spawnSync(["bash", "-e", scriptPath], {
    cwd: home,
    env: {
      PATH: path,
      HOME: home,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: outputFile,
      ...extraEnv,
    },
  });
  const text = readFileSync(outputFile, "utf-8");
  return {
    code: r.exitCode,
    dir: /^dir=(.*)$/m.exec(text)?.[1] ?? "",
    path: /^path=(.*)$/m.exec(text)?.[1] ?? "",
    out: {
      stdout: new TextDecoder().decode(r.stdout),
      stderr: new TextDecoder().decode(r.stderr),
      runnerTemp: temp,
    },
  };
}

const SOURCE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

const FIXTURE_CI = {
  runner: "ubuntu-latest",
  bunVersion: "1.2.0",
  vertex: {
    project: "fixture-vertex-project",
    workloadIdentityProvider:
      "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider",
  },
};
const VERTEX: VertexCiDecision = vertexCiConfig(FIXTURE_CI);

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

let PROJECT = "";
const generated = () =>
  readFileSync(join(PROJECT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8");

beforeAll(() => {
  PROJECT = mkdtempSync(join(tmpdir(), "ai-review-write-scope-"));
  scratch.push(PROJECT);
  mkdirSync(join(PROJECT, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(PROJECT, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "write-scope-fixture", ci: FIXTURE_CI }, null, 2) + "\n",
  );
  createCiWorkflows(PROJECT, []);
});

// ── AC-1: the rule is spelled in the form that is consulted ──────────────

describe("AC-1: the deny rule uses Edit(path), never Write(path)", () => {
  test("no inert path rule reaches the CLI", () => {
    // The cheapest wrong fix, refused by a case rather than by a comment.
    // Claude Code accepts `Write(...)` and never consults it, so that spelling
    // would ship a grant that reads as scoped and is worth nothing.
    //
    // Scanned over the EMITTED ARGUMENTS and the generated file, not over the
    // module's source. The first draft scanned the source and went red on the
    // docblock above, which quotes the wrong spelling in order to warn about
    // it — a checker that greps for a token cannot tell a rule from a sentence
    // about a rule, and this repository has recorded that trap three times.
    // The property is about what the reviewer is handed, so that is the slice.
    const INERT = /\b(Write|MultiEdit|NotebookEdit|Glob)\s*\(/g;
    for (const [label, text] of [
      ["the rendered args", aiReviewClaudeArgs(VERTEX)],
      ["the generated workflow", generated()],
    ] as const) {
      expect(
        [...text.matchAll(INERT)].map(m => m[0]),
        `${label} carries a path rule against a tool whose path rules are never consulted`,
      ).toEqual([]);
    }
  });

  test("the scan can see a rule when there is one", () => {
    // Non-vacuity. Without this, the prohibition above is satisfied by a
    // regex that matches nothing, or by `aiReviewClaudeArgs` returning "".
    const INERT = /\b(Write|MultiEdit|NotebookEdit|Glob)\s*\(/g;
    expect([..."--disallowedTools Write(./**)".matchAll(INERT)].length).toBe(1);
    expect(aiReviewClaudeArgs(VERTEX).length, "the args are empty").toBeGreaterThan(0);
    expect(generated(), "the generated file does not hold the args").toContain("--disallowedTools");
  });

  test("the rule names Edit, and names a path", () => {
    expect(AI_REVIEW_WORKSPACE_WRITE_DENY).toStartWith("Edit(");
    expect(
      AI_REVIEW_WORKSPACE_WRITE_DENY,
      "a bare tool name is the tool-level deny that is already in the list",
    ).toMatch(/^Edit\(.+\)$/);
  });

  test("the rule carries no whitespace, so it survives an unquoted args string", () => {
    // `claude_args` is emitted unquoted and split by the action. A rule
    // containing a space — `Edit(//${{ github.workspace }}/**)` is the
    // tempting one — arrives at the CLI in three pieces, which is the same
    // nothing as `Write(path)` reached by a different route.
    expect(AI_REVIEW_WORKSPACE_WRITE_DENY).not.toMatch(/\s/);
    expect(aiReviewClaudeArgs(VERTEX)).not.toMatch(/--disallowedTools\s+\S*\s+\S*\(/);
  });
});

// ── AC-2: it reaches the generated file ──────────────────────────────────

describe("AC-2: the rule survives generation", () => {
  test("the scaffolded workflow denies file modification in the checkout", () => {
    const doc = Bun.YAML.parse(generated()) as any;
    expect(Object.keys(doc.jobs ?? {}), "the ai-review job is gone").toContain(AI_REVIEW_JOB);
    const args = (doc.jobs[AI_REVIEW_JOB].steps as any[])
      .map(s => String(s?.with?.claude_args ?? ""))
      .filter(a => a.includes("--disallowedTools"));
    expect(args.length, "no step hands the action a denial list").toBe(1);
    expect(args[0]).toContain(AI_REVIEW_WORKSPACE_WRITE_DENY);
  });

  test("it moves with the constant, so the generated file is not a second copy", async () => {
    // `toContain(AI_REVIEW_WORKSPACE_WRITE_DENY)` is satisfied by the rule
    // typed into the args template a second time. The input on which the
    // mutant and the original differ, named rather than assumed: the
    // constant's own value.
    const SENTINEL = "Edit(./sentinel/**)";
    const needle = `export const AI_REVIEW_WORKSPACE_WRITE_DENY = ${JSON.stringify(
      AI_REVIEW_WORKSPACE_WRITE_DENY,
    )};`;
    const count = source.split(needle).length - 1;
    if (count !== 1) {
      throw new Error(`could not build the mutant: the declaration appears ${count} times`);
    }
    const dir = mkdtempSync(join(tmpdir(), "ai-review-write-mutant-"));
    scratch.push(dir);
    const path = join(dir, "ai-review-step.ts");
    writeFileSync(
      path,
      source.replace(
        needle,
        `export const AI_REVIEW_WORKSPACE_WRITE_DENY = ${JSON.stringify(SENTINEL)};`,
      ),
    );
    const mutant = (await import(path)) as {
      aiReviewClaudeArgs: (v: VertexCiDecision) => string;
    };
    expect(mutant.aiReviewClaudeArgs(VERTEX)).toContain(SENTINEL);
    expect(
      mutant.aiReviewClaudeArgs(VERTEX),
      "the args still carry the real rule, so they are a second copy",
    ).not.toContain(AI_REVIEW_WORKSPACE_WRITE_DENY);
  });
});

// ── AC-3: the prompt declares repo content as data ───────────────────────

describe("AC-3: the reviewer is told the tree is its subject, not its instructions", () => {
  test("the prompt says repo content is data and must not be acted on", () => {
    const prompt = buildReviewPrompt();
    expect(prompt).toContain("DATA, NOT INSTRUCTIONS");
    expect(
      prompt.toLowerCase(),
      "the prompt does not say what to do with a file that gives instructions",
    ).toContain("report that as a finding");
  });

  test("it names the shape that actually bit us", () => {
    // Not a generic warning. #815's reviewer acted on a rules document
    // written in the imperative and addressed to an agent, so the prompt
    // names that case rather than leaving the reader to generalise from
    // "untrusted input".
    const prompt = buildReviewPrompt().toLowerCase();
    expect(prompt).toContain("imperative");
    expect(prompt).toContain("agent");
  });

  test("it says what an edit costs, because the drift step is what enforces it", () => {
    expect(buildReviewPrompt()).toContain("fails the job");
  });
});

// ── AC-4: the reading that measures it is still there ────────────────────

describe("AC-4: the drift step is not removed on the strength of a permission", () => {
  test("the generated job still diffs the tree after the review", () => {
    // A permission is a claim; a diff is a reading. Deleting the drift step
    // because the grant is now scoped is the repair that would make this
    // whole issue invisible next time — and it is exactly the step that
    // caught it this time.
    const doc = Bun.YAML.parse(generated()) as any;
    const step = (doc.jobs[AI_REVIEW_JOB].steps as any[]).find(
      s => s && s.id === AI_REVIEW_DRIFT_STEP_ID,
    );
    expect(step, `no drift step in the generated job:\n${generated()}`).toBeDefined();
    expect(String(step.run)).toContain("git diff");
  });
});

// ── #824: the other half of the same decision — where the reviewer MAY write ──

/**
 * #824 AC-1 and AC-2.
 *
 * The file this suite lives in already owns one half of "where may the
 * reviewer write": the deny on the checkout. The source says so at
 * `AI_REVIEW_WORKSPACE_WRITE_DENY` — *"'where may the reviewer write' is ONE
 * decision whose other half is #824"* — so the grant is asserted here rather
 * than in a file of its own, where the deny and the grant could be respelled
 * against each other.
 *
 * ## What reproduced
 *
 * The reviewer was handed a findings path outside the checkout and granted
 * nothing. `--add-dir` appeared nowhere in the generator. Measured on PR #815
 * job 118797389663: `num_turns: 47`, `permission_denials_count: 5`, no
 * payload written, and the reviewer put its result where it COULD write —
 * into the tree under review, which the drift step then refused. One cause,
 * three symptoms.
 *
 * Separately the action's config dump reported
 * `"settingSources": ["user", "project", "local"]`: the reviewer loaded its
 * permission settings from the branch it was reviewing.
 *
 * ## The cheapest wrong fixes, each with a case on it
 *
 * 1. **`--add-dir "$RUNNER_TEMP"`.** One flag, makes the write succeed, and
 *    hands the reviewer the drift BASELINE — which lives in that directory
 *    at a name the reviewer can derive — in the same stroke. Named in two
 *    other docblocks as the repair to refuse. `AC-1c` reds on it.
 * 2. **Move the findings path inside the checkout.** Makes the write succeed
 *    and puts the output where the drift step cannot tell a payload from an
 *    edit to the branch. `AC-1c` reds on `--add-dir .` and the prepare
 *    script's own `RUNNER_TEMP` refusal is unchanged above.
 * 3. **Respell the deny as `Edit(**)` now that an `--add-dir` exists.**
 *    #836 measured `Edit(**)` as BLOCKED in both columns, so it would deny
 *    the payload write and turn every review into an UNMEASURED with no
 *    payload. `test/ai-review-untrusted-restore.test.ts` already applies
 *    that respelling to a copy of the module and observes it refused; this
 *    file does not restate it.
 *
 * ## AC-8 is delegated, deliberately
 *
 * AC-8 asks that the committed `.github/workflows/ai-review.yml` be
 * regenerated. `test/ai-review-surface-census.test.ts` AC-12 already asserts
 * the committed file is BYTE-IDENTICAL to a fresh regeneration, which is
 * strictly stronger than "it contains these two flags" and is the same
 * question. A third spelling of it here would be the duplicate decider this
 * cluster keeps finding. What AC-12 does NOT cover — and `AC-1e` below does
 * — is that the `${{ steps.… }}` expression inside the grant RESOLVES: a
 * typo'd step id, or a prepare step ordered after the review step, yields an
 * empty string, and `--add-dir` with no value swallows the flag after it.
 * Both files would still be byte-identical to each other.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **That the CLI honours the grant at run time.** No test here can; it
 *   needs a real review on a real runner, which is the issue's AC-5 and is
 *   #825's subject. #836's four-spelling table is the nearest measurement:
 *   it ran the real CLI and recorded `Edit(./**)` as the one pattern that
 *   blocks the checkout and WROTE to an `--add-dir` path. That table is the
 *   evidence this grant is compatible with the deny; it was taken against
 *   that CLI version and nothing re-takes it here.
 * - **That `--setting-sources user` is a flag the pinned action passes
 *   through.** `claude_args` is documented as passed through and the other
 *   five flags in the same string are known to arrive; this one is asserted
 *   to be PRESENT and correctly spelled, not to be OBEYED. The restore step
 *   (#836) remains the measurement that the checkout's `.claude` is the
 *   base's, and it is not removed by this.
 * - **A leftover owned by another local user.** The refusal is now "ANY
 *   pre-existing path", which does not consult the owner at all, so there
 *   is nothing left to be unmeasured about ownership — `AC-1g` plants a
 *   file and `AC-1o` plants a symlink, and both refuse. What is NOT
 *   covered is the case where another user owns `RUNNER_TEMP` itself and
 *   can win a race between the `-e` test and the `mkdir`; `mkdir` without
 *   `-p` makes that a refusal rather than an adoption, which is the best
 *   this shape can do without a lock.
 * - **Whether the write probe beats `[ -w ]`.** `AC-1m` reds if the probe
 *   is deleted and does NOT red if it is replaced by `[ -w "${dir}" ]` —
 *   there is no input available to a unit test where the writable bit is
 *   set and the write still fails. The probe is kept because the cases it
 *   adds over the bit are real and unreachable here: a read-only mount, a
 *   full disk, a quota, an immutable flag. That is a reasoned preference,
 *   not a measured one, and this is the record of which.
 * - **`stat` shims stand in for a filesystem without POSIX modes.**
 *   `AC-1k` and `AC-1l` replace the TOOL, which proves the script's
 *   branches; no case here runs on such a filesystem. `AC-1n` is the
 *   instrument control that shimming is not itself what produces the
 *   refusals.
 * - **Concurrent jobs on one runner colliding in the findings directory.**
 *   The nonce is `GITHUB_RUN_ID`-`GITHUB_RUN_ATTEMPT`, which is unique per
 *   attempt; two jobs of the SAME attempt would share it. Only one job in
 *   this workflow writes there, so it is unreachable today and nothing here
 *   asserts it stays that way.
 */
describe("#824 AC-1: the reviewer is granted its findings directory, and nothing wider", () => {
  const DIR_EXPR = `\${{ steps.${AI_REVIEW_PREPARE_STEP_ID}.outputs.${AI_REVIEW_FINDINGS_DIR_OUTPUT} }}`;

  test("AC-1a: the args grant exactly the prepare step's findings directory", () => {
    const args = aiReviewClaudeArgs(VERTEX);
    // Reds on the tree this was written against: `--add-dir` appeared
    // nowhere in the generator, which is the defect verbatim.
    expect(args, "the reviewer is still granted no writable directory").toContain(
      `--add-dir ${DIR_EXPR}`,
    );
    // Reds on a second grant added elsewhere in the string — the action
    // concatenates `claude_args` rather than deduplicating, so two
    // `--add-dir` flags are two grants and the narrower one does not win.
    expect(
      [...args.matchAll(/--add-dir\b/g)].length,
      "more than one --add-dir: the grant is no longer one decision",
    ).toBe(1);
  });

  test("AC-1b: the grant is a real step output, not a value the branch supplies", () => {
    // Non-vacuity, and the property that makes AC-1a worth anything: the
    // granted directory must come from a step this job ran. A literal path,
    // or a `vars.*`/`inputs.*` expression, would be a grant a repository can
    // repoint at the checkout. Reds on `--add-dir /tmp/findings`.
    const args = aiReviewClaudeArgs(VERTEX);
    const granted = /--add-dir\s+(\S+(?:\s+\S+)*?)\s+--/.exec(args)?.[1] ?? "";
    expect(granted, "the --add-dir value could not be read back out of the args").toBe(DIR_EXPR);
    expect(granted, "the grant does not read a step output").toContain("steps.");
  });

  test("AC-1c: the grant is not the temp root, the workspace, or the checkout", () => {
    // The cheapest wrong fixes, 1 and 2. Each of these tokens appearing in
    // the `--add-dir` value is a different way of handing over more than the
    // payload: `RUNNER_TEMP`/`runner.temp` carries the drift baseline and the
    // credential, `github.workspace` and `.` are the tree under review.
    const args = aiReviewClaudeArgs(VERTEX);
    const granted = /--add-dir\s+(.*?)\s+--/.exec(args)?.[1] ?? "";
    const WIDER = ["RUNNER_TEMP", "runner.temp", "github.workspace", "GITHUB_WORKSPACE"];

    // The scan can see one when there is one. Without this the loop below is
    // satisfied by a `granted` that failed to parse and came back empty.
    expect(granted.length, "nothing was extracted, so this case measured nothing").toBeGreaterThan(0);
    for (const token of WIDER) {
      expect(
        `--add-dir \${{ ${token} }} --x`.includes(token),
        "the token scan cannot see a token it is handed",
      ).toBe(true);
      expect(granted, `the reviewer is granted ${token}, which is wider than its payload`).not.toContain(
        token,
      );
    }
    expect(granted, "the grant is the working directory, which is the checkout").not.toBe(".");
  });

  test("AC-1d: the prepare step creates the directory and exports it, payload inside it", () => {
    const { out, code, dir, path } = runPrepare();
    expect(code, `the prepare step refused on a healthy runner:\n${out.stderr}`).toBe(0);

    // Reds on the tree this was written against: there was no `dir` output
    // and no directory, only a path to a file that was never created.
    expect(dir, "the prepare step exported no findings directory").not.toBe("");
    expect(statSync(dir).isDirectory(), `${dir} is not a directory`).toBe(true);

    // The payload must be INSIDE the granted directory, or the grant names
    // somewhere the reviewer has no reason to write and the payload path is
    // still ungranted — the defect, with a directory added beside it.
    expect(path, "the payload is not inside the directory the reviewer is granted").toStartWith(
      dir + "/",
    );
    // And the directory must not BE the temp root, which is AC-1c's wrong
    // fix arriving through the script instead of through the args.
    expect(dir, "the findings directory is RUNNER_TEMP itself").not.toBe(out.runnerTemp);
    expect(dir.startsWith(out.runnerTemp + "/"), `${dir} is not under RUNNER_TEMP`).toBe(true);

    // 0700: a job sharing a self-hosted runner can otherwise read the
    // findings, or plant one before the reviewer runs.
    expect(statSync(dir).mode & 0o777, "the findings directory is not 0700").toBe(0o700);
  });

  test("AC-1e: the granted expression names a step that exists, and runs first", () => {
    // What AC-12's byte-identity cannot see. An expression naming a step id
    // that does not exist resolves to the EMPTY STRING at run time, and
    // `--add-dir` then consumes the flag after it — the grant silently
    // becomes nothing and takes a neighbour with it. Reds on a one-character
    // typo in the step id, and on a prepare step reordered after the review.
    const doc = Bun.YAML.parse(generated()) as any;
    const steps = doc.jobs[AI_REVIEW_JOB].steps as any[];
    const ids = steps.map(s => s?.id);

    const prepareAt = ids.indexOf(AI_REVIEW_PREPARE_STEP_ID);
    const reviewAt = ids.indexOf(AI_REVIEW_ACTION_STEP_ID);
    expect(prepareAt, `no step has id ${AI_REVIEW_PREPARE_STEP_ID}`).toBeGreaterThan(-1);
    expect(reviewAt, `no step has id ${AI_REVIEW_ACTION_STEP_ID}`).toBeGreaterThan(-1);
    expect(prepareAt, "the findings directory is chosen AFTER the reviewer runs").toBeLessThan(
      reviewAt,
    );

    const args = String(steps[reviewAt]?.with?.claude_args ?? "");
    const named = /--add-dir\s+\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/.exec(
      args,
    );
    expect(named, `the grant in the generated workflow is not a step output:\n${args}`).not.toBeNull();
    expect(named![1], "the grant names a step id no step in this job carries").toBe(
      AI_REVIEW_PREPARE_STEP_ID,
    );
    // And the output it reads is one the prepare script actually writes.
    expect(named![2]).toBe(AI_REVIEW_FINDINGS_DIR_OUTPUT);
    expect(
      buildPrepareScript(),
      `the prepare script never writes a \`${named![2]}=\` line to GITHUB_OUTPUT`,
    ).toContain(`${named![2]}=`);
  });
});

describe("#824 AC-1: a findings directory the runner could not provide REFUSES", () => {
  // #675's shape, and the gap the analysis flagged before any of this was
  // written. Without these, a prepare step that could not produce the
  // directory still exports a path; the reviewer is handed a path it cannot
  // write; the action exits 0 having written nothing; and the report step
  // reads that as `executed` — "the reviewer ran and wrote nothing", a
  // verdict ABOUT THE REVIEWER for a failure of the runner. The existing
  // `routeUnmeasured` branch does not cover it: that one fires on a
  // named-but-unreadable execution file, which is a different reading.

  test("AC-1f: mkdir failing refuses, and exports no path for anything to read", () => {
    // The input: a RUNNER_TEMP whose parent is a FILE, so `mkdir -p` cannot
    // create it. Reds on the tree this was written against, which ran no
    // mkdir, exited 0, and exported a path to a file in a directory that did
    // not exist.
    const root = mkdtempSync(join(tmpdir(), "rg-824-"));
    scratch.push(root);
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory\n");

    const { out, code, dir, path } = runPrepare(join(blocker, "temp"));
    expect(code, `the prepare step accepted a temp root it could not create:\n${out.stdout}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(out.stderr, "the refusal was not annotated").toContain("::error");
    expect(out.stderr, "the refusal does not name what it could not do").toContain(
      "could not be created",
    );
    // The second half, and the one that makes it a refusal rather than a
    // warning: nothing downstream may read a findings path out of a prepare
    // step that failed. Reds on a fix that annotates and keeps going.
    expect(path, "a failed prepare step still exported a findings path").toBe("");
    expect(dir, "a failed prepare step still exported a findings directory").toBe("");
  });

  /** A RUNNER_TEMP already holding the exact path the script will derive. */
  function withLeftover(make: (p: string) => void): { runnerTemp: string; env: Record<string, string> } {
    const runnerTemp = mkdtempSync(join(tmpdir(), "rg-824-left-"));
    scratch.push(runnerTemp);
    make(join(runnerTemp, `${AI_REVIEW_FINDINGS_BASENAME}-7-1${AI_REVIEW_FINDINGS_DIR_SUFFIX}`));
    return { runnerTemp, env: { GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" } };
  }

  test("AC-1g: a leftover at the findings path that is not a directory refuses, and is NOT deleted", () => {
    // A reused runner holding something at this path. `mkdir -p` would
    // adopt a directory in silence and fail on a file, so the refusal is
    // explicit and comes BEFORE the mkdir — reds on a fix that lets the
    // mkdir speak for it, which reports "could not be created" and sends
    // the reader to the wrong cause.
    const { runnerTemp, env } = withLeftover(p => writeFileSync(p, "a previous generator's payload\n"));
    const leftover = join(runnerTemp, `${AI_REVIEW_FINDINGS_BASENAME}-7-1${AI_REVIEW_FINDINGS_DIR_SUFFIX}`);

    const { out, code, path } = runPrepare(runnerTemp, env);
    expect(code, `a leftover at the findings path was accepted:\n${out.stdout}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(out.stderr, "the refusal blamed the mkdir rather than the leftover").toContain(
      "already exists",
    );
    expect(path, "a refused prepare step still exported a findings path").toBe("");
    // The half that matters most on a machine with sixteen self-hosted
    // runners on it: refusing, not deleting. Reds on an `rm -rf "${dir}"`
    // repair, which is the obvious one and which has no reading afterwards
    // that would show what it removed.
    expect(
      readFileSync(leftover, "utf-8"),
      "the step DELETED a path it did not create — another user's data, on a shared runner",
    ).toContain("a previous generator's payload");
  });

  test("AC-1o: a SYMLINK at the findings path refuses, and is not followed", () => {
    // HIGH, and the reason the `-L` test comes first. `-e`, `-d` and `-O`
    // all DEREFERENCE, so a symlink this job owns — one a prior job on a
    // reused self-hosted runner left behind — satisfies every one of them
    // while pointing anywhere at all. The directory is then handed to the
    // reviewer as `--add-dir`, which is a WRITE GRANT to wherever the link
    // resolves.
    //
    // Reds on the ownership-test form this replaced, and reds on a `-L`
    // test placed after `-d`: by then the link has already been followed.
    const target = mkdtempSync(join(tmpdir(), "rg-824-target-"));
    scratch.push(target);
    writeFileSync(join(target, "someone-elses-file"), "untouched\n");

    const { runnerTemp, env } = withLeftover(p => symlinkSync(target, p));
    const { out, code, dir, path } = runPrepare(runnerTemp, env);

    expect(code, `a symlinked findings directory was accepted:\n${out.stdout}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(out.stderr, "the refusal does not say the path was a symlink").toContain("SYMLINK");
    // The grant must not be published. Reds on a fix that annotates and
    // carries on — `--add-dir` would then name the link.
    expect(dir, "a symlinked path was still exported as the granted directory").toBe("");
    expect(path, "a refused prepare step still exported a findings path").toBe("");
    // And nothing was written through the link, or removed from behind it.
    expect(readdirSync(target), "the step wrote or deleted through the symlink").toEqual([
      "someone-elses-file",
    ]);
  });

  test("AC-1j: chmod failing refuses rather than continuing unprotected", () => {
    // The input is the TOOL: a `chmod` that exits 1. Reds on
    // `chmod 700 "${dir}" 2>/dev/null || true`, which is what this was
    // written as first — a hardening that cannot fail, continuing with a
    // directory every other job on the runner can read, and reporting
    // success.
    const { out, code, path } = runPrepare(undefined, {}, { chmod: 'echo "chmod: refused" >&2; exit 1' });
    expect(code, `a failed chmod was swallowed:\n${out.stdout}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(out.stderr, "the refusal does not say the mode could not be set").toContain("mode 0700");
    expect(out.stderr, "the tool's own complaint never reached the annotation").toContain("refused");
    expect(path, "a refused prepare step still exported a findings path").toBe("");
  });

  test("AC-1k: a chmod that reports success WITHOUT the mode taking refuses", () => {
    // The case the exit-code check cannot see, and the reason the mode is
    // read back at all: a filesystem with no POSIX modes accepts the call
    // and changes nothing. Input: a `chmod` that exits 0 and does nothing,
    // over a directory pre-created 0755.
    //
    // Reds on trusting chmod's exit code — i.e. on the version of this fix
    // that checks `chmod`'s status and stops there, which is the repair the
    // AC-1j case above would otherwise be satisfied by.
    //
    // The mode is supplied by a `stat` shim rather than by pre-creating the
    // directory, because since the `-L`/`-e` hardening a pre-existing path
    // refuses before the mode is ever read — which would have made this
    // case green for the wrong reason.
    const { out, code, path } = runPrepare(undefined, {}, { chmod: "exit 0", stat: "echo 755" });

    expect(code, `a directory reported as 0755 was accepted as 0700:\n${out.stdout}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(out.stderr, "the refusal does not report the mode it read back").toContain("755");
    expect(path, "a refused prepare step still exported a findings path").toBe("");
  });

  test("AC-1l: a mode that cannot be READ BACK is UNMEASURED and refuses", () => {
    // `it is 0700` and `nobody looked` must not be the same answer — this
    // file's standing convention, and the direction the read-back itself
    // could fail open in. Input: a `stat` that fails whichever spelling is
    // tried. Reds on a read-back written as `mode=$(stat ... || echo 700)`
    // or guarded by `|| true`.
    const { out, code, path } = runPrepare(undefined, {}, { chmod: "exit 0", stat: "exit 1" });
    expect(code, `an unreadable mode was accepted:\n${out.stdout}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(out.stderr).toContain("UNMEASURED");
    expect(out.stderr, "the refusal does not say the mode could not be read").toContain("READ BACK");
    expect(path, "a refused prepare step still exported a findings path").toBe("");
  });

  test("AC-1m: with both readings subverted, the write itself still refuses", () => {
    // Defence in depth, measured. Both tool readings are made to agree that
    // the directory is fine — `chmod` is a no-op reporting success, `stat`
    // reports 700 — over a directory that is really 0500. The only thing
    // left between the reviewer and a payload it cannot write is the write.
    //
    // Reds on deleting the probe. It does NOT red on replacing the probe
    // with `[ -w ]`, and that is recorded rather than claimed otherwise:
    // see WHAT THIS DOES NOT COVER.
    expect(
      process.getuid?.(),
      "running as root: a 0500 directory is still writable, so this case cannot witness anything",
    ).not.toBe(0);

    // The directory is made unwritable by the `mkdir` shim rather than
    // pre-created, for the same reason as AC-1k: a pre-existing path now
    // refuses before any of this is reached.
    const { out, code, path } = runPrepare(undefined, {}, {
      mkdir: 'exec /bin/mkdir -m 500 "$3" 2>/dev/null || exec /usr/bin/mkdir -m 500 "$3"',
      chmod: "exit 0",
      stat: "echo 700",
    });
    expect(code, `an unwritable findings directory was accepted:\n${out.stdout}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(out.stderr, "the refusal is not the write's").toContain("a write into it STILL failed");
    expect(path, "a refused prepare step still exported a findings path").toBe("");
  });

  test("AC-1n instrument control: a shim directory on PATH does not by itself refuse", () => {
    // Without this, every case above is satisfied by a script that refuses
    // whenever PATH has an extra entry, or by shims that break the script
    // for a reason unrelated to the tool under test. The shims here are
    // honest passthroughs, so the verdict must be the healthy one.
    const { code, out, dir } = runPrepare(undefined, {}, {
      chmod: 'exec /bin/chmod "$@"',
      stat: 'exec /usr/bin/stat "$@" 2>/dev/null || exec /bin/stat "$@"',
    });
    expect(code, `passthrough shims refused a healthy runner:\n${out.stderr}`).toBe(0);
    expect(dir, "the passthrough run exported no directory").not.toBe("");
  });

  test("AC-1h: whitespace in RUNNER_TEMP refuses rather than splitting the grant", () => {
    // `claude_args` is emitted unquoted and split on whitespace by the
    // action — the same hazard `AI_REVIEW_WORKSPACE_WRITE_DENY` is spelled
    // relative to avoid. A space in the granted path means `--add-dir`
    // names a path that does not exist and the remainder becomes a stray
    // argument, so the reviewer is denied its own output file with no
    // annotation anywhere. Unreachable on a GitHub-hosted runner, reachable
    // on a self-hosted one whose work directory a human chose.
    const spaced = mkdtempSync(join(tmpdir(), "rg-824-sp-")) + "/a b";
    mkdirSync(spaced, { recursive: true });
    scratch.push(spaced);

    const { out, code, path } = runPrepare(spaced);
    expect(code, `a RUNNER_TEMP containing a space was accepted:\n${out.stdout}`).toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(out.stderr).toContain("whitespace");
    expect(path, "a refused prepare step still exported a findings path").toBe("");
  });

  test("AC-1i control: a healthy runner is not refused by any of the three", () => {
    // Without this, AC-1f/g/h are satisfied by a prepare step that refuses
    // everything — which is the cheapest wrong fix for any refusal, and
    // here it would take ai-review permanently red and get the step deleted.
    const { code, out } = runPrepare();
    expect(code, `the prepare step refuses a runner with nothing wrong with it:\n${out.stderr}`).toBe(0);
    expect(out.stderr, "a healthy prepare step annotated an error").not.toContain("::error");
  });
});

describe("#824 AC-2: the reviewer's settings come from the runner, not from the branch", () => {
  test("AC-2a: the args narrow the setting sources to the user scope", () => {
    const args = aiReviewClaudeArgs(VERTEX);
    // Reds on the tree this was written against: no `--setting-sources` at
    // all, so the action's default `["user","project","local"]` stood and
    // the reviewer read `.claude/settings.json` out of the checkout.
    expect(args, "the reviewer still loads settings from the branch it reviews").toContain(
      `--setting-sources ${AI_REVIEW_SETTING_SOURCES}`,
    );
    expect(AI_REVIEW_SETTING_SOURCES, "the constant carries whitespace, so it splits").not.toMatch(/\s/);
  });

  test("AC-2b: neither source that reads the checkout is listed", () => {
    // Reds on `--setting-sources user,project,local` — the spelling that
    // adds the flag and changes nothing, which is what a reviewer sees as
    // "the flag is there" in a diff.
    const value = /--setting-sources\s+(\S+)/.exec(aiReviewClaudeArgs(VERTEX))?.[1] ?? "";
    expect(value.length, "no setting-sources value was extracted").toBeGreaterThan(0);
    for (const scope of ["project", "local"]) {
      expect(
        `user,${scope}`.split(",").includes(scope),
        "the scope scan cannot see a scope it is handed",
      ).toBe(true);
      expect(
        value.split(","),
        `${scope} settings are read out of the checkout, which is the branch under review`,
      ).not.toContain(scope);
    }
    expect(value.split(","), "the user scope was dropped along with the other two").toContain("user");
  });

  test("AC-2c: it is declared in exactly one position", () => {
    // AC-2's own wording. The action concatenates `claude_args`; a second
    // `--setting-sources` is a second answer and nothing says which wins.
    //
    // Counted over the EMITTED ARGS and over the constant's ASSIGNMENTS, not
    // over occurrences of the flag in the module source. Measured: the
    // source carries two, one of which is the docblock explaining why the
    // flag is there. AC-1's docblock in this same file records that trap —
    // a checker that greps for a token cannot tell a rule from a sentence
    // about a rule — and this is the third time this repository has walked
    // into it.
    expect(
      [...aiReviewClaudeArgs(VERTEX).matchAll(/--setting-sources/g)].length,
      "the flag is emitted twice",
    ).toBe(1);
    expect(
      [...source.matchAll(/AI_REVIEW_SETTING_SOURCES\s*=/g)].length,
      "the constant is assigned more than once, so two positions can disagree",
    ).toBe(1);
    // Non-vacuity: the counter can see two when there are two.
    expect(
      [..."--setting-sources user --x --setting-sources local".matchAll(/--setting-sources/g)].length,
    ).toBe(2);
    expect(
      [...generated().matchAll(/--setting-sources/g)].length,
      "the generated workflow carries two setting-source declarations",
    ).toBe(1);
  });
});
