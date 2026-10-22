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
  roundOutcome,
} from "../lib/ai-review-rounds.ts";
import {
  AI_REVIEW_AT_CAP_OUTPUT,
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL,
  AI_REVIEW_ROUNDS_STEP_ID,
  AI_REVIEW_ROUNDS_TITLE,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_ROUND_CAP_LITERAL,
  AI_REVIEW_ROUND_OUTPUT,
  AI_REVIEW_ROUND_PATH_VAR,
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

  test("AC-S2: the scope floor is the same in both", () => {
    for (const round of MATRIX) {
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, round);
      const expected =
        Number(round) >= AI_REVIEW_DIFF_SCOPE_FROM_ROUND ? REVIEW_SCOPE_DIFF : REVIEW_SCOPE_FULL;
      expect(sh.outputs[AI_REVIEW_SCOPE_OUTPUT], `round ${round}`).toBe(expected);
    }
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

  test("AC-S5: the diff branch states the no-repeat key is not the line number", () => {
    expect(prompt).toContain("NOT on the line number");
    expect(prompt).toContain("carried forward");
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
