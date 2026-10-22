/**
 * #675 — the findings reader becomes something a scaffolded project can run.
 *
 * `lib/scaffold/ai-review-findings.ts` has read the payload, classified
 * severities, caught a verdict that contradicts its own findings and routed
 * every refusal through `AI_REVIEW_REQUIRED_EXIT` since #631. All of it is
 * tested. None of it has ever been executed by anything.
 *
 * `lib/scaffold/ai-review-step.ts` said so in the generated workflow, by
 * name, rather than exiting 0 in silence:
 *
 *   The AI review completed and wrote a findings payload, but no step in this
 *   job reads it yet (#675), so a blocking finding would not fail this check.
 *
 * and its source names the blocker exactly: "wiring it into the job needs a
 * way for a scaffolded consumer — which has no copy of rungate's sources — to
 * execute it, and that is #675."
 *
 * This is that way. `lib/cli-commands.ts` is the one position that says where
 * a command lives, `test/cli-contract.test.ts` already holds it to
 * `package.json`'s `files`, and a registered command is a path the generated
 * workflow can name without hardcoding anything about the package layout.
 *
 * ## What this file does NOT cover
 *
 * The generated job still does not run the command. That is the other half of
 * AC-4 and it is a change to `buildReviewRunScript`, where the UNMEASURED
 * branch quoted above lives. Making the reader reachable and making the job
 * reach for it are separable, and this is the first — so `#675` stays open.
 *
 * ## The trap this file exists for
 *
 * `bin/rungate.ts` dispatches by rewriting `process.argv` and then
 * `await import(script)` — the import IS the invocation. So a module whose
 * entry is guarded on `import.meta.main` **loads, runs nothing, and the
 * dispatcher exits 0.** The lib module is guarded exactly that way, correctly,
 * for the `bun lib/...` case.
 *
 * A subcommand in that state adjudicates nothing and reports success, which
 * is the defect #675 is about reproduced one layer up. It is invisible to the
 * obvious case: "a clean payload exits 0" is satisfied by a command that did
 * nothing at all. Every case below that expects a 0 asserts the reader's own
 * output line as well, because the exit code alone cannot tell the two apart.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Write `process.exit(1)` in the wrapper when the reading is not clean.**
 * It is the 5pm repair the moment someone finds the exit code is not
 * propagating, it works, and it puts a second non-zero exit in the tree that
 * `test/ai-review-exit-binding.test.ts`'s zeroed-constant mutant cannot
 * reach — so that case goes green over a refusal that no longer comes from
 * the constant. AC-4 below is red under it.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CLI_COMMANDS } from "../lib/cli-commands";
import { AI_REVIEW_REQUIRED_EXIT, AI_REVIEW_FINDING_FIELDS, AI_REVIEW_FINDINGS_KEY, AI_REVIEW_VERDICT_KEY } from "../lib/scaffold/ai-review-step";

const ROOT = join(import.meta.dir, "..");
const COMMAND = "ai-review-findings";
const WRAPPER = join(ROOT, "scripts", "ai-review-findings.ts");

/** The line `main` prints before it decides anything. A run that produced no
 *  such line did not reach the reader, whatever its exit code says. */
const OUTCOME_LINE = "ai-review findings outcome:";

function payload(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-675-"));
  const path = join(dir, "ai-review-findings.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** Dispatch through the REAL bin, from a scratch cwd so a defect cannot edit
 *  this repository — `test/cli-contract.test.ts` learned that the hard way. */
function runCli(args: string[]) {
  const scratch = mkdtempSync(join(tmpdir(), "rungate-675-cwd-"));
  try {
    return spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), ...args], {
      encoding: "utf-8",
      cwd: scratch,
      timeout: 60_000,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A CONTRACT-COMPLETE blocking payload, built from the field map (#1166).
 *
 * It used to carry `detail` — a key the contract never declares — and no
 * `failure_scenario`, and the reader adjudicated it BLOCKED regardless. That
 * is #1166 in one fixture: the suite's own blocking payload did not satisfy
 * the contract the prompt states, so nothing here could have noticed that
 * nothing enforced it.
 */
const BLOCKING = {
  [AI_REVIEW_VERDICT_KEY]: "BLOCK",
  [AI_REVIEW_FINDINGS_KEY]: [
    {
      [AI_REVIEW_FINDING_FIELDS.severity]: "critical",
      [AI_REVIEW_FINDING_FIELDS.file]: "lib/thing.ts",
      [AI_REVIEW_FINDING_FIELDS.line]: 12,
      [AI_REVIEW_FINDING_FIELDS.summary]: "a credential is logged in plain text",
      [AI_REVIEW_FINDING_FIELDS.failureScenario]:
        "any run with GCP_SA_KEY set writes the key to the job log",
    },
  ],
};

const CLEAN = { [AI_REVIEW_VERDICT_KEY]: "PASS", [AI_REVIEW_FINDINGS_KEY]: [] };

describe("#675: the findings reader is reachable as a command", () => {
  test("AC-1: a blocking payload dispatched through the bin exits non-zero and names the finding", () => {
    const r = runCli([COMMAND, payload(BLOCKING)]);

    // The reader RAN — asserted before the verdict, because a dispatcher that
    // resolved the module and never reached its entry exits 0 in silence and
    // a dispatcher that failed to resolve it exits non-zero in silence. Only
    // this line tells either of those from an adjudication.
    expect(r.stdout, `the reader produced no outcome line:\n${r.stdout}\n${r.stderr}`).toContain(OUTCOME_LINE);
    expect(r.stdout).toContain("BLOCKED");

    expect(r.status, `a blocking payload did not refuse:\n${r.stdout}\n${r.stderr}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.stderr).toContain("lib/thing.ts");
    expect(r.stderr).toContain("::error");
  });

  test("AC-2: a clean payload exits 0 AND says so, so the refusal is not unconditional", () => {
    // The boundary, and the vacuity guard in one. `status === 0` on its own is
    // what the import.meta.main trap produces: the module loads, its guarded
    // entry does not fire, and the dispatcher returns success having read
    // nothing. The outcome line is what distinguishes a decision from silence.
    const r = runCli([COMMAND, payload(CLEAN)]);

    expect(r.stdout, "a clean payload produced no outcome line — nothing adjudicated it").toContain(OUTCOME_LINE);
    expect(r.stdout).toContain("CLEAN");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("::error");
  });

  test("AC-3: a payload that is not there is UNMEASURED and refuses, not a quiet pass", () => {
    // The state a wiring bug produces most often: the path is wrong, the file
    // is absent, and "no findings" is indistinguishable from "no blocking
    // findings" unless the command refuses. Both are reported here — the
    // outcome word and the exit — because a refusal with no reading behind it
    // would be equally wrong in the other direction.
    const r = runCli([COMMAND, join(tmpdir(), "rungate-675-nowhere", "absent.json")]);

    expect(r.stdout).toContain(OUTCOME_LINE);
    expect(r.stdout).toContain("UNMEASURED");
    expect(r.status).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-4: the wrapper declares no exit code of its own", () => {
    // The named cheapest wrong fix, as a case. `aiReviewExitCode` routes every
    // refusal through AI_REVIEW_REQUIRED_EXIT, and test/ai-review-exit-binding
    // proves the refusal comes from that constant by zeroing it in a mutant. A
    // `process.exit(1)` here is a second non-zero exit the mutant cannot reach,
    // so that proof would go green over a refusal it no longer governs.
    const source = readFileSync(WRAPPER, "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

    expect(code, "the comment stripper ate the file").toContain("process.exit(main(");
    expect(
      [...code.matchAll(/process\.exit\(/g)],
      "the wrapper exits in more than one place, so not every exit is the module's",
    ).toHaveLength(1);
    expect(code, "the wrapper names a literal exit code instead of returning the module's").not.toMatch(
      /process\.exit\(\s*[0-9]/,
    );
  });

  test("AC-5: the wrapper calls main unconditionally — no import.meta.main guard", () => {
    // Stated as source rather than behaviour on purpose: the behavioural half
    // is AC-1 and AC-2, which would both go red under the guard, and this says
    // WHY in the place the next person will edit. The lib module keeps its own
    // guard — correct for `bun lib/scaffold/ai-review-findings.ts` — so the
    // two files disagree deliberately and this records that they must.
    const source = readFileSync(WRAPPER, "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

    expect(code).not.toContain("import.meta.main");
    expect(readFileSync(join(ROOT, "lib", "scaffold", "ai-review-findings.ts"), "utf-8")).toContain(
      "if (import.meta.main)",
    );
  });

  test("AC-6: the command is registered, and takes no --project-root", () => {
    // `bin/rungate.ts` appends `--project-root <cwd>` for any command that
    // declares the flag, and this one's single argument is positional — a
    // payload path that lives OUTSIDE the checkout by design. The flag would
    // arrive as a second positional and the reader would be handed a
    // directory.
    const cmd = CLI_COMMANDS[COMMAND];
    expect(cmd, "the command is not in the registry, so the workflow has nothing to name").toBeDefined();
    expect(cmd.script).toBe("scripts/ai-review-findings.ts");
    expect(cmd.projectRootFlag).toBeUndefined();
  });
});
