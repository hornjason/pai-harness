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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  AI_REVIEW_DRIFT_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_WORKSPACE_WRITE_DENY,
  AI_REVIEW_WORKFLOW_FILE,
  aiReviewClaudeArgs,
  buildReviewPrompt,
  vertexCiConfig,
  type VertexCiDecision,
} from "../lib/scaffold/ai-review-step";

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
