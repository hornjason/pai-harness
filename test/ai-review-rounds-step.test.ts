/**
 * The generated round-counting step, and its agreement with the library that
 * decides the same thing (#1168).
 *
 * `lib/ai-review-rounds.ts` is the source of truth and it delegates the
 * budget arithmetic to `reReviewDecision` in `lib/security-verdict.ts`.
 * `lib/scaffold/ai-review-step.ts` cannot import it — a relative import
 * added to that file resolves to nothing inside the `mkdtemp` directory the
 * ai-review mutation batteries copy it into, so the mutant fails to LOAD and
 * every case comparing real against mutant goes red while witnessing nothing
 * (`.claude/rules/self-referential-tests.md`, Tier 1, last row). The rule's
 * own remedy for a file that must stay import-free is an agreement
 * assertion, and this file is it.
 *
 *  - AC-S1  the two cap literals equal the library's
 *  - AC-S2  the generated bash agrees with the library over one input matrix
 *  - AC-S3  the refusal is routed through one constant, and it can fail
 *  - AC-S4  the step is in the committed workflow, with the permission it needs
 *  - AC-S5  nothing the branch under review wrote reaches the prompt
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND,
  AI_REVIEW_ROUND_CAP,
  AI_REVIEW_ROUND_AT_CAP,
  AI_REVIEW_ROUND_OPEN,
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  reviewScopeForRound,
  roundOutcome,
} from "../lib/ai-review-rounds.ts";
import {
  AI_REVIEW_AT_CAP_OUTPUT,
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL,
  AI_REVIEW_FINDINGS_COMMAND,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_ROUNDS_STEP_ID,
  AI_REVIEW_ROUNDS_TITLE,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_ROUND_CAP_LITERAL,
  AI_REVIEW_ROUND_OUTPUT,
  AI_REVIEW_ROUND_PATH_VAR,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_SCOPE_OUTPUT,
  buildReviewPrompt,
  buildRoundsScript,
} from "../lib/scaffold/ai-review-step.ts";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = join(ROOT, ".github/workflows/ai-review.yml");

describe("AC-S1: the literals are bound to the library", () => {
  test("AC-S1: the cap and the diff floor agree", () => {
    expect(
      AI_REVIEW_ROUND_CAP_LITERAL,
      "lib/scaffold/ai-review-step.ts spells the cap as a literal because it " +
        "may not import; change one and change the other",
    ).toBe(AI_REVIEW_ROUND_CAP);
    expect(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL).toBe(AI_REVIEW_DIFF_SCOPE_FROM_ROUND);
  });

  test("AC-S1: ai-review-step.ts still has no relative import of the library", () => {
    // The property the agreement assertion exists to preserve. If somebody
    // "fixes" the duplication with an import, the mutation batteries that
    // copy this file into an mkdtemp stop loading it.
    //
    // Matched on the IMPORT and not on the name: the file names
    // `lib/ai-review-rounds.ts` in prose, deliberately, and a `toContain`
    // over the bare name forbids explaining where the source of truth is.
    const src = readFileSync(join(ROOT, "lib/scaffold/ai-review-step.ts"), "utf8");
    const relativeImports = [
      ...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
    ].map(m => m[1]!);
    expect(relativeImports.filter(s => s.includes("ai-review-rounds"))).toEqual([]);
    expect(src).not.toContain('require("../ai-review-rounds');
  });
});

/**
 * Run the generated script under the shell the runner uses, with the
 * environment the generated step supplies, and a `curl` that answers from a
 * fixture.
 *
 * `bash -e` and not a plain `bash`: a GitHub `run:` block executes
 * under `bash -e`, and spawning a plain shell runs a different program
 * (`.claude/rules/…`, and #1191 in this file's own history).
 */
function runRounds(env: Record<string, string>, totalCount: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-rounds-"));
  try {
    const out = join(dir, "out.txt");
    writeFileSync(out, "");
    const bin = join(dir, "bin");
    require("node:fs").mkdirSync(bin);
    // A curl that answers from the fixture. `--fail-with-body` semantics are
    // reproduced by exiting non-zero when the fixture is null.
    writeFileSync(
      join(bin, "curl"),
      totalCount === null
        ? "#!/usr/bin/env bash\nexit 22\n"
        : `#!/usr/bin/env bash\nprintf '%s' '{"total_count":${totalCount},"workflow_runs":[]}'\n`,
      { mode: 0o755 },
    );
    const script = join(dir, "step.sh");
    writeFileSync(script, buildRoundsScript());
    const r = spawnSync("bash", ["-e", script], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: out,
        AI_REVIEW_ROUNDS_BRANCH: "rg/1168",
        AI_REVIEW_ROUNDS_REPO: "o/r",
        AI_REVIEW_ROUNDS_API: "https://api.github.test",
        AI_REVIEW_ROUNDS_TOKEN: "t",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(out, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
    }
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AC-S2: the bash and the library agree", () => {
  // Every row the library has an opinion about, run through both.
  const MATRIX = ["1", "2", "3", "4", "5", "12"];

  test("AC-S2: the open/at-cap decision is the same in both", () => {
    for (const round of MATRIX) {
      const lib = roundOutcome(round);
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, round);
      expect(sh.status, `round ${round}: ${sh.stderr}`).toBe(0);
      expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT], `round ${round}`).toBe(round);
      const shAtCap = sh.outputs[AI_REVIEW_AT_CAP_OUTPUT] === "1";
      expect(shAtCap, `round ${round}: bash says at_cap=${shAtCap}`).toBe(
        lib.decision === AI_REVIEW_ROUND_AT_CAP,
      );
      expect(lib.decision === AI_REVIEW_ROUND_OPEN || shAtCap).toBe(true);
    }
  }, 30_000);

  test("AC-S2: the bash reports full on EVERY round, including past the floor", () => {
    // It used to restate the library's floor and emit `diff` from round 3 on
    // a round number alone, which is #1241: `reviewScopeForRound` makes that
    // decision from the HELD VERDICT, and the bash has no held verdict to
    // make it from. Rather than two deciders that disagree, the bash makes no
    // decision — it pins `full` until the adjudicator re-emits unresolved
    // findings. The floor constant is still exercised, by the case below and
    // by AC-S6, so removing it is still red.
    for (const round of MATRIX) {
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, round);
      expect(sh.outputs[AI_REVIEW_SCOPE_OUTPUT], `round ${round}`).toBe(REVIEW_SCOPE_FULL);
    }
    // The control: a round at or past the floor is in the matrix, so the row
    // above is not green because it never reached one.
    expect(MATRIX.some(r => Number(r) >= AI_REVIEW_DIFF_SCOPE_FROM_ROUND)).toBe(true);
  }, 30_000);
});

describe("AC-S3: UNMEASURED is red, and the refusal can fail", () => {
  test("AC-S3: a count that cannot be read refuses, and names the permission", () => {
    const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, null);
    expect(sh.status).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(sh.stderr).toContain(AI_REVIEW_ROUNDS_TITLE);
    expect(sh.stderr).toContain("actions: read");
    // Not a skip and not a pass. The three outputs must be absent, or a
    // later step reads an empty round as round 1.
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBeUndefined();
  }, 30_000);

  test("AC-S3: a count of ZERO refuses — it has not counted this run", () => {
    const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, "0");
    expect(sh.status).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBeUndefined();
  }, 30_000);

  test("AC-S3: a missing branch or token refuses before it calls anything", () => {
    for (const blank of ["AI_REVIEW_ROUNDS_BRANCH", "AI_REVIEW_ROUNDS_TOKEN"]) {
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request", [blank]: "" }, "2");
      expect(sh.status, blank).toBe(AI_REVIEW_REQUIRED_EXIT);
    }
  });

  test("AC-S3: the MUTANT — exit 0 instead of the constant — stops refusing", () => {
    // The removal of the non-zero exit, performed and observed. Without it a
    // case that later passes for an unrelated reason is indistinguishable
    // from one that is genuinely caught
    // (`.claude/rules/checks-must-be-able-to-fail.md`).
    const real = buildRoundsScript();
    const occurrences = real.split(`exit ${AI_REVIEW_REQUIRED_EXIT}`).length - 1;
    expect(occurrences, "every refusal must route through the one constant").toBe(2);
    const mutant = real.replaceAll(`exit ${AI_REVIEW_REQUIRED_EXIT}`, "exit 0");

    const dir = mkdtempSync(join(tmpdir(), "ai-review-rounds-mut-"));
    try {
      const out = join(dir, "out.txt");
      writeFileSync(out, "");
      const bin = join(dir, "bin");
      require("node:fs").mkdirSync(bin);
      writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\nexit 22\n", { mode: 0o755 });
      const script = join(dir, "mutant.sh");
      writeFileSync(script, mutant);
      const r = spawnSync("bash", ["-e", script], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_OUTPUT: out,
          AI_REVIEW_ROUNDS_BRANCH: "rg/1168",
          AI_REVIEW_ROUNDS_REPO: "o/r",
          AI_REVIEW_ROUNDS_API: "https://api.github.test",
          AI_REVIEW_ROUNDS_TOKEN: "t",
          AI_REVIEW_EVENT: "pull_request",
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      // Real: 1. Mutant: 0. One input, both observed.
      expect(r.status, "the mutant must NOT refuse, or the case witnessed nothing").toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("AC-S3: merge_group is not a round, and is not a refusal either", () => {
    const sh = runRounds({ AI_REVIEW_EVENT: "merge_group" }, null);
    expect(sh.status).toBe(0);
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBe("");
    expect(sh.outputs[AI_REVIEW_SCOPE_OUTPUT]).toBe("full");
  });
});

describe("AC-S4: the step is in the committed workflow", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  test("AC-S4: the step, its id, and the permission it needs", () => {
    expect(yml).toContain(`id: ${AI_REVIEW_ROUNDS_STEP_ID}`);
    expect(yml).toContain("actions: read");
  });

  test("AC-S4: it runs BEFORE the review action, or its outputs are unreadable", () => {
    const rounds = yml.indexOf(`id: ${AI_REVIEW_ROUNDS_STEP_ID}`);
    const review = yml.indexOf("id: ai-review-action");
    expect(rounds).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(-1);
    expect(rounds).toBeLessThan(review);
  });

  test("AC-S4: the committed workflow carries the generated script verbatim", () => {
    // The drift this catches is a hand-edit of the generated file. The
    // refusal line is the one worth pinning: it is the whole gate.
    expect(yml).toContain(AI_REVIEW_ROUNDS_TITLE);
    expect(yml).toContain("cannot tell which review round it is on");
    expect(yml).toContain(`exit ${AI_REVIEW_REQUIRED_EXIT}`);
  });

  test("AC-S4: the step has no continue-on-error — a counted round or a red check", () => {
    const at = yml.indexOf(`id: ${AI_REVIEW_ROUNDS_STEP_ID}`);
    const next = yml.indexOf("- name:", at);
    const block = yml.slice(at, next === -1 ? undefined : next);
    expect(block).not.toContain("continue-on-error");
  });
});

describe("AC-S5: nothing from the branch under review reaches the prompt", () => {
  const prompt = buildReviewPrompt();
  // The prompt is hard-wrapped, so a phrase spanning a line break is still
  // one phrase. Asserted over the unwrapped text; the `${{` case below
  // deliberately reads the RAW prompt, because a wrap cannot hide one.
  const flat = prompt.replace(/\s+/g, " ");

  test("AC-S5: the round state reaches the reviewer as a FILE, not an expression", () => {
    // AC-6b in test/ai-review-credentialed-job.test.ts forbids any `${{` in
    // the prompt, and it is right: an expression is substituted before the
    // action sees the text, so it is content rather than instruction. The
    // first draft of #1168 interpolated three closed-set values and argued
    // they were safe. They were; the rule is still right, because "this one
    // is a closed set" is how the next one gets in. Asserted here as well as
    // there, because this is the change that would have broken it.
    expect(prompt).not.toContain("${{");
    expect(prompt).toContain(AI_REVIEW_ROUND_PATH_VAR);
  });

  test("AC-S5: the prompt names the four fields the state file carries", () => {
    for (const field of [
      "review_round",
      "round_budget",
      "review_scope",
      "round_budget_spent",
    ]) {
      expect(prompt, `the prompt never tells the reviewer to read ${field}`).toContain(field);
      expect(
        buildRoundsScript(),
        `the step never writes ${field}, so the prompt asks for a field nobody emits`,
      ).toContain(field);
    }
  });

  test("AC-S5: the at-cap branch asks for an approach assessment and refuses silence", () => {
    expect(prompt).toContain("THE ROUND BUDGET IS SPENT");
    expect(prompt).toContain("APPROACH");
    expect(prompt).toContain("non-blocking severity");
    expect(flat).toContain("Do not stay silent");
  });

  test("AC-S5: the prompt tells the reviewer the scope is full, and why", () => {
    // Replaces the narrowed-scope arm, withdrawn in #1241. The field is still
    // written, so the prompt must still say something true about it rather
    // than naming a field it never explains.
    expect(flat).toContain("`review_scope` reads `full` on every round today");
    expect(flat).toContain("read the whole branch, every round");
  });

  test("AC-S5: an absent state file is a stated case, not an undefined one", () => {
    // The file can be missing — the step refuses before writing it when the
    // count is unreadable, and that refusal reds the job, but the reviewer
    // action carries `continue-on-error` and the prompt must still say what
    // to do rather than leave the reviewer to invent a round.
    expect(flat).toContain("absent or unreadable");
  });

  test("AC-S5: the cap the prompt describes is the library's", () => {
    // The prompt says `round_budget` rather than a literal, so the number
    // itself lives in one place. This is the binding that keeps that true.
    expect(buildRoundsScript()).toContain(`round_budget=%s\\n' '${AI_REVIEW_ROUND_CAP}'`);
  });
});

// ── AC-S6 (#1241): the cap bounds re-litigation, never the gate ─────────

/**
 * The defect this block exists for, as it shipped in #1236.
 *
 * A pull request reaches round 4 carrying an unfixed blocking finding from
 * round 2. The prompt told the reviewer the finding was "carried forward for
 * you" — nothing carried it — and told it not to use a blocking severity. The
 * required check went green over a live finding.
 *
 * So two properties, and they are different in kind:
 *
 *  - the cap may not reach the BLOCKING DECISION. Asserted behaviourally,
 *    against the committed verdict step, with a mutant to show the case is
 *    not vacuous.
 *  - the cap may not tell the REVIEWER to withhold a blocking severity, and
 *    the prompt may not promise an enforcement nothing performs. Asserted
 *    over the prompt text, which is the only instruction the reviewer gets.
 */
describe("AC-S6 (#1241): the cap bounds re-litigation, never the gate", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  /** The committed verdict step's bash — the thing that actually decides. */
  function committedVerdictScript(): string {
    const doc = Bun.YAML.parse(yml) as any;
    const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
      (s: any) => s?.id === AI_REVIEW_RUN_STEP_ID,
    );
    if (step === undefined) throw new Error(`no ${AI_REVIEW_RUN_STEP_ID} step in the workflow`);
    const script = String(step.run ?? "");
    if (!script.includes(AI_REVIEW_FINDINGS_COMMAND)) {
      throw new Error(
        `the committed ${AI_REVIEW_RUN_STEP_ID} step does not invoke ` +
          `'${AI_REVIEW_FINDINGS_COMMAND}', so these cases would drive a step that ` +
          `adjudicates nothing`,
      );
    }
    return script;
  }

  /**
   * Run a verdict script with a BLOCKING adjudication, at the cap.
   *
   * The at-cap state is put in the environment under every spelling the step
   * could plausibly read it by, so a step that grew a dependency on it is
   * caught whichever name it used.
   */
  function runVerdict(script: string): { status: number | null; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-cap-gate-"));
    try {
      const bin = join(dir, "bin");
      require("node:fs").mkdirSync(bin);
      writeFileSync(
        join(bin, "bunx"),
        `#!/bin/sh\necho "${AI_REVIEW_OUTCOME_LINE} BLOCKED"\nexit ${AI_REVIEW_REQUIRED_EXIT}\n`,
        { mode: 0o755 },
      );
      const payload = join(dir, "ai-review-findings.json");
      writeFileSync(
        payload,
        JSON.stringify({
          findings: [
            {
              severity: "high",
              file: "lib/a.ts",
              line: 1,
              summary: "raised on round 2 and never fixed",
              failure_scenario: "any input",
            },
          ],
          verdict: "BLOCK",
        }),
      );
      const sh = join(dir, "verdict.sh");
      writeFileSync(sh, script);
      const r = spawnSync("bash", ["-e", sh], {
        encoding: "utf8",
        cwd: dir,
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: dir,
          AI_REVIEW_MODE: "vertex",
          AI_REVIEW_ACTION_OUTCOME: "success",
          [AI_REVIEW_FINDINGS_PATH_VAR]: payload,
          // Every spelling of "the budget is spent".
          AI_REVIEW_AT_CAP: "1",
          [AI_REVIEW_AT_CAP_OUTPUT.toUpperCase()]: "1",
          AI_REVIEW_ROUND: "4",
          [AI_REVIEW_ROUND_OUTPUT.toUpperCase()]: "4",
        },
      });
      return { status: r.status, stdout: r.stdout ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("AC-S6: at cap, an unresolved blocking finding still fails the check", () => {
    // #1241's acceptance criterion, stated in its own words.
    const r = runVerdict(committedVerdictScript());
    expect(
      r.status,
      "a blocking adjudication at the round cap must still exit non-zero — a cap that " +
        "downgrades the verdict is a required check turning itself off",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  }, 30_000);

  test("AC-S6: the MUTANT — a step that honours the cap — goes green, so the case is not vacuous", () => {
    // Without this row the one above is the third shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`: an assertion that holds
    // because the input it varies reaches nothing. This performs the
    // regression — a verdict step that reads the cap and exits 0 — and
    // observes it, so real-red / mutant-green is one measured pair.
    const mutant =
      `if [ "\${AI_REVIEW_AT_CAP:-}" = "1" ]; then\n  exit 0\nfi\n` + committedVerdictScript();
    const r = runVerdict(mutant);
    expect(
      r.status,
      "the mutant must NOT refuse, or the case above witnessed nothing",
    ).toBe(0);
  }, 30_000);

  test("AC-S6: no step in the committed job reads the cap output", () => {
    // The structural half of the behavioural pair. The only producer of
    // `at_cap` is the rounds step; the only legitimate consumer is its own
    // annotation. Any OTHER step referencing it is a route by which the cap
    // could reach a verdict, and this names them rather than waiting for one
    // to change an exit code.
    const doc = Bun.YAML.parse(yml) as any;
    const steps = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []) as any[];
    const readers = steps
      .filter(s => s?.id !== AI_REVIEW_ROUNDS_STEP_ID)
      .filter(s => JSON.stringify(s ?? {}).includes(`outputs.${AI_REVIEW_AT_CAP_OUTPUT}`))
      .map(s => String(s?.id ?? s?.name ?? "(unnamed)"));
    expect(
      readers,
      "a step other than the rounds step reads the at-cap output — the cap must not be " +
        "an input to anything that decides whether this check fails (#1241)",
    ).toEqual([]);
  });

  test("AC-S6: the prompt does not forbid a blocking severity at cap", () => {
    const prompt = buildReviewPrompt();
    const flat = prompt.replace(/\s+/g, " ");
    expect(
      flat,
      "the at-cap arm told the reviewer not to raise a blocking severity, which is how a " +
        "live finding reached a green check (#1241)",
    ).not.toContain("Do not raise it to a blocking severity");
    // And it says the opposite, positively, so the absence above is not the
    // only thing standing between here and the regression.
    expect(flat).toContain("CHANGES NOTHING ABOUT WHAT BLOCKS");
    expect(flat).toContain("exactly as you would on round 1");
  });

  test("AC-S6: the prompt promises no carry-forward while nothing carries forward", () => {
    // The promise and the mechanism are asserted TOGETHER, in one case, so
    // they cannot be re-separated: the sentence is allowed back the moment a
    // production caller exists, and not before.
    const prompt = buildReviewPrompt();
    const flat = prompt.replace(/\s+/g, " ");
    // Detect an IMPORT of the module, not a mention of the symbols. A prose
    // mention is a citation, not a claim — `.claude/rules/claiming-sc-coverage.md`
    // — and the first draft of this case was red because the comment this very
    // change added to `lib/scaffold/ai-review-step.ts` says the word
    // `carryForward` while calling nothing. An importer is the thing a caller
    // cannot be without: the library is a module, so no import, no call site.
    // POSIX ERE, not PCRE: `git grep -E` has no `\s`, and a pattern it cannot
    // match is indistinguishable from a tree with no callers — which is what
    // the control below caught when this line was first written with `\s+`.
    const IMPORTS = String.raw`from[[:space:]]+"[^"]*ai-review-rounds(\.ts)?"`;
    const callers = spawnSync(
      "git",
      ["grep", "-l", "-E", IMPORTS, "--", "lib", "gates", "scripts", "workflows", "bin"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const production = (callers.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .filter(f => f !== "lib/ai-review-rounds.ts");
    // The control: the detector finds an importer when there is one. Without
    // this row, a pattern that matches nothing at all reads exactly like a
    // tree with no production callers, and the branch below holds vacuously.
    const anyImporter = spawnSync(
      "git",
      ["grep", "-l", "-E", IMPORTS, "--", "test"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(
      (anyImporter.stdout ?? "").split("\n").filter(Boolean),
      "the import pattern matches no file anywhere, so it cannot distinguish " +
        "'no production caller' from 'broken detector'",
    ).toContain("test/ai-review-rounds-step.test.ts");
    if (production.length === 0) {
      expect(
        flat,
        `nothing in lib/, gates/, scripts/, workflows/ or bin/ calls carryForward or ` +
          `suppressRepeats, so the prompt may not tell the reviewer a finding "is carried ` +
          `forward for you" — it would stop reporting a live finding on that promise (#1241)`,
      ).not.toContain("carried forward for you");
    } else {
      // A caller exists, so the sentence is earned. Require it, in the other
      // direction, rather than letting the case quietly stop asserting.
      expect(flat, `production callers exist (${production.join(", ")})`).toContain(
        "carried forward",
      );
    }
  }, 30_000);

  test("AC-S6: the committed workflow emits no diff scope while that is true", () => {
    const doc = Bun.YAML.parse(yml) as any;
    const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
      (s: any) => s?.id === AI_REVIEW_ROUNDS_STEP_ID,
    );
    const code = String(step?.run ?? "")
      .split("\n")
      .filter(l => !l.trim().startsWith("#"))
      .join("\n");
    expect(
      code.includes(`${AI_REVIEW_SCOPE_OUTPUT}=diff`),
      "the generated bash narrows the review scope without the held verdict reReviewScope " +
        "requires — a branch whose last round BLOCKED would be diff-scoped, which is #244 " +
        "and the fail-open 46034035 was reverted for (#1241)",
    ).toBe(false);
    // The control: the step must still SET a scope, or the assertion above
    // holds because the whole mechanism vanished.
    expect(code).toContain(`${AI_REVIEW_SCOPE_OUTPUT}=full`);
  });

  test("AC-S6: the library still refuses to diff-scope a held FAIL at the floor", () => {
    // Unchanged and re-stated here, because the bash now pins `full` and can
    // no longer disagree with it. When the adjudicator is wired and the pin
    // comes off, this is the rule the bash has to restate.
    expect(reviewScopeForRound(String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL), { verdict: "FAIL", failures: ["x"] }))
      .toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound(String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL), { verdict: "PASS" }))
      .toBe(REVIEW_SCOPE_DIFF);
  });
});
