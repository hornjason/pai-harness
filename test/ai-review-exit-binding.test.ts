import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_REQUIRED_EXIT } from "../lib/scaffold/ai-review-step";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * Covers AC-8e (#631 — every refusal exits through one imported constant).
 *
 * The thing under test is an EXIT CODE, so every case below runs the module as
 * a script. A case asserting only "non-zero" cannot tell a refusal from a
 * crash, a bad import or a syntax error, so each refusal runs TWICE: once
 * against `lib/scaffold/ai-review-findings.ts` as it stands, and once against a
 * copy whose imported `AI_REVIEW_REQUIRED_EXIT` is zeroed in
 * `lib/scaffold/ai-review-step.ts`. The second run is the evidence — the
 * mutant must still SAY the same thing and exit 0, which is the removal of the
 * non-zero exit, performed and observed.
 *
 * The input on which the mutant and the original differ, named rather than
 * assumed: every refusal fixture below. The real module exits
 * AI_REVIEW_REQUIRED_EXIT; the mutant prints the identical refusal and exits 0.
 *
 * A refusal that inlined its own literal would survive the mutation, and the
 * case would go green having witnessed nothing —
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */

const LIB = join(import.meta.dir, "..", "lib", "scaffold");
const FINDINGS_PATH = join(LIB, "ai-review-findings.ts");
const STEP_PATH = join(LIB, "ai-review-step.ts");

const findingsSource = readFileSync(FINDINGS_PATH, "utf-8");
const stepSource = readFileSync(STEP_PATH, "utf-8");

let SCRATCH = "";
/** The zeroed-constant copy of the module, importable from outside the repo. */
let MUTANT = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-exit-"));

  const mutatedStep = stepSource.replace(
    /AI_REVIEW_REQUIRED_EXIT\s*=\s*1\b/,
    "AI_REVIEW_REQUIRED_EXIT = 0",
  );
  if (mutatedStep === stepSource) {
    throw new Error(
      "could not build the mutant: no `AI_REVIEW_REQUIRED_EXIT = 1` in " +
        "lib/scaffold/ai-review-step.ts",
    );
  }

  const dir = join(SCRATCH, "mutant");
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "ai-review-step.ts"), mutatedStep);
  copyFileSync(FINDINGS_PATH, join(dir, "ai-review-findings.ts"));
  MUTANT = join(dir, "ai-review-findings.ts");
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
}

let runSeq = 0;

function runModule(modulePath: string, args: string[]): Run {
  const r = spawnSync("bun", [modulePath, ...args], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? SCRATCH },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function fixtureFile(body: string): string {
  const path = join(SCRATCH, `findings-${runSeq++}.json`);
  writeFileSync(path, body);
  return path;
}

/** Every input that must refuse, one per refusal branch in the module. */
function refusalCases(): Array<[string, string[]]> {
  return [
    ["no path at all", []],
    ["an absent file", [join(SCRATCH, "no-such-file.json")]],
    ["an unparseable file", [fixtureFile('{"verdict": "PASS",')]],
    ["a document with no findings key", [fixtureFile('{"verdict": "PASS", "results": []}')]],
    [
      "a finding with no severity",
      [fixtureFile('{"verdict": "PASS", "findings": [{"title": "x"}]}')],
    ],
    [
      "a PASS contradicted by its payload",
      [fixtureFile('{"verdict": "PASS", "findings": [{"severity": "critical", "title": "x"}]}')],
    ],
    // The case above carries a blocking severity, so it also refuses as a
    // BLOCK — it reaches the assertion by a route that bypasses the
    // contradiction branch. This one can only refuse as a contradiction, and
    // deleting that branch is 3 red rather than 2 because of it.
    [
      "a BLOCK verdict with nothing blocking beneath it",
      [fixtureFile('{"verdict": "BLOCK", "findings": [{"severity": "low", "title": "x"}]}')],
    ],
    [
      "a real blocking finding",
      [fixtureFile('{"verdict": "BLOCK", "findings": [{"severity": "critical", "title": "x"}]}')],
    ],
  ];
}

describe("AC-8e: every refusal exits through the imported constant", () => {
  test("AC-8e: the module imports the exit code and declares no other", () => {
    const code = stripJsComments(findingsSource);
    expect(code).toMatch(/import\s*\{[^}]*AI_REVIEW_REQUIRED_EXIT[^}]*\}\s*from\s*["']\.\/ai-review-step["']/);
    expect(
      (code.match(/AI_REVIEW_REQUIRED_EXIT\s*=/g) || []).length,
      "the module assigns its own exit code — the mutation would not reach it",
    ).toBe(0);
  });

  test("AC-8e: no non-zero exit literal anywhere in the module", () => {
    const code = stripJsComments(findingsSource);

    expect(
      code.match(/process\.exit\(\s*[1-9]/g) || [],
      "a hand-written non-zero process.exit bypasses AI_REVIEW_REQUIRED_EXIT, " +
        "so the mutant cannot neutralise it",
    ).toEqual([]);

    // The only numeric literal anything may return is 0; a non-zero exit code
    // has to arrive as the imported constant.
    const returned = code.match(/return\s+[0-9]+/g) || [];
    for (const site of returned) {
      expect(site, `${site} is a hand-written exit code`).toMatch(/return\s+0\b/);
    }

    // …and the constant is used, once, so the mutation has somewhere to land.
    expect(
      (code.match(/\bAI_REVIEW_REQUIRED_EXIT\b/g) || []).length,
      "AI_REVIEW_REQUIRED_EXIT should appear exactly twice in code: the import " +
        "and the single site that returns it",
    ).toBe(2);
  });

  test("AC-8e: the module's only relative import is ./ai-review-step", () => {
    const rel = [...stripJsComments(findingsSource).matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map(
      m => m[1],
    );
    expect(
      [...new Set(rel)],
      "a second relative import would make the mutant die on module resolution, " +
        "and an import that throws reads as a refusal",
    ).toEqual(["./ai-review-step"]);
  });

  test("AC-8e: the real module refuses and the zeroed-constant mutant does not", () => {
    for (const [label, args] of refusalCases()) {
      const real = runModule(FINDINGS_PATH, args);
      expect(real.code, `${label} did not refuse\n${real.out}`).toBe(AI_REVIEW_REQUIRED_EXIT);

      const mutant = runModule(MUTANT, args);
      expect(
        mutant.code,
        `${label}: the mutant (AI_REVIEW_REQUIRED_EXIT = 0) still exited ` +
          `${mutant.code} — this refusal is not routed through the constant\n${mutant.out}`,
      ).toBe(0);
      expect(
        mutant.out,
        `${label}: the mutant said something different, so it is not the same ` +
          `run with a different exit code — it did not get as far as refusing`,
      ).toBe(real.out);
    }
  });

  test("AC-8e: a clean reading exits 0 under both, so the mutant is not just quiet", () => {
    const clean = fixtureFile('{"verdict": "PASS", "findings": []}');
    const real = runModule(FINDINGS_PATH, [clean]);
    expect(real.code, `a clean review failed the job\n${real.out}`).toBe(0);
    const mutant = runModule(MUTANT, [clean]);
    expect(mutant.code).toBe(0);
    expect(mutant.out, "the mutant stopped reading the file, so it is not a mutant").toBe(real.out);
  });
});
