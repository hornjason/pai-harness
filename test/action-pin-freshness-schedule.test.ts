/**
 * #789 — the pin freshness check that nothing ran.
 *
 * #377 declared every action the scaffold emits in `lib/workflow-actions.ts`,
 * SHA-pinned the third-party one, and proved the structure with
 * `test/generated-workflow-pins.test.ts`. It also shipped
 * `scripts/check-action-pins.ts` and described it as *"the network check, run
 * deliberately"*.
 *
 * **Deliberately turned out to mean never.** Measured before this change:
 * the string `check-action-pins` appeared in four places in the tree — the
 * script itself, two prose mentions, and one test asserting the script
 * exists. Nothing invoked it. An unwired control is byte-identical to no
 * control, and a rule nothing executes is not a rule
 * (`.claude/rules/config-access.md` says this about ADRs; it was true here).
 *
 * #789's SC-1..SC-4 were already satisfied by #377 — the correction is
 * argued on the issue rather than here. SC-5, *decide and record how the pin
 * gets bumped*, is what this file is about.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Write the bump procedure in a comment and call it recorded.** Half of it
 * was already written in `lib/workflow-actions.ts`, and the pin was five
 * weeks from stale with nobody scheduled to look. It satisfies SC-5 as read
 * aloud and changes nothing about whether anyone finds out.
 *
 * **AC-1 is the case that does not survive it**: a workflow in
 * `.github/workflows/` must invoke the script, on a schedule. No amount of
 * prose moves it.
 *
 * ## Two decisions, made rather than left open
 *
 * - **The schedule is this repository's and is NOT generated into
 *   consumers.** A consumer's pin comes from the rungate version they
 *   installed; a scheduled job in every scaffolded project would ask GitHub
 *   the same question N times and hand each consumer a red workflow they
 *   cannot fix. AC-4 is the negative control, so adding it to the templates
 *   scores as a scope change rather than a tightening.
 * - **`workflow_dispatch` as well as `schedule`.** GitHub disables a
 *   schedule after 60 days of repository inactivity, so a check nobody can
 *   trigger by hand goes quiet on exactly the week nobody pushed.
 *
 * ## The trap this file is built around
 *
 * AC-3 EXECUTES the script against a stubbed `gh` rather than grepping its
 * source for the procedure. That is not caution for its own sake: the
 * battery for #323, one issue earlier, caught a case that grepped a source
 * for a string which appeared at two sites and stayed green when the site it
 * named was deleted (#484). A refusal's text is a behaviour; assert it by
 * provoking it.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/generated-workflow-pins.test.ts`. Counts
 * predicted in `/tmp/789-battery/predictions.md` before the battery ran, and
 * **the baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | read first | **22 pass, 0 fail** | — |
 * | M1 **the cheapest wrong fix**: the workflow deleted, the procedure left as prose | 3 | **3 of 22** | this repository: the original finds one workflow running the script, the mutant none — and AC-2's and AC-3's claims about the procedure are untouched, which is exactly why they are not the witnesses |
 * | M2 `schedule:` removed, leaving `workflow_dispatch` | 1 | **1 of 22** | the `on:` block: a check that only runs when somebody remembers is the state #377 left behind |
 * | M3 `workflow_dispatch:` removed | 1 | **1 of 22** | the same block: a schedule GitHub has disabled after 60 days of inactivity, with no way to run it |
 * | M4 the `GH_TOKEN` env removed from the step | 1 | **1 of 22** | the step: unauthenticated `gh api` hits the anonymous rate limit, which the script reports as UNMEASURED and exits non-zero for — a weekly red about nothing |
 * | M5 the script spells its own procedure instead of importing it | 2 | **2 of 22** | a moved tag: the original's refusal carries `BUMP_PROCEDURE` verbatim, the mutant's carries a paraphrase that no longer mentions re-scaffolding or how a consumer bumps |
 * | M6 the freshness step added to the generator's CI template | 1 | **1 of 22** | a scaffolded consumer: the original's generated workflows never name the script, the mutant's run the harness's check in every consumer's CI |
 * | M7 the workflow's own `setup-bun` pinned by tag | 1 | **1 of 22** | the `uses:` line: the one workflow in the repo exempt from the rule it exists to maintain |
 *
 * **Every row matched, which this file's own rules say to distrust**, so the
 * precondition question was asked of the battery rather than of the code
 * (#492): every case here reads the LIVE tree, so the branch where no such
 * workflow exists is reachable only by AC-4, which generates a consumer and
 * asserts the absence. That is covered. What is NOT covered by any case is
 * whether GitHub ACCEPTS the file — a malformed `on:` block would parse
 * fine as text and never fire. `gh workflow list` after the merge is the
 * only instrument that answers it, and it is recorded on #789 rather than
 * asserted here.
 *
 * None of the mutations is left in the tree; all were run and reverted from
 * `cp` backups, never `git checkout --`, and every source was confirmed
 * byte-identical by sha256 afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { actionRef, BUMP_PROCEDURE, PINNING } from "../lib/workflow-actions";
import { createCiWorkflows } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const SCRIPT = "scripts/check-action-pins.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every workflow in this repository, by name and text. */
function workflows(): Array<{ name: string; text: string }> {
  return readdirSync(WORKFLOWS)
    .filter(n => /\.ya?ml$/.test(n))
    .map(n => ({ name: n, text: readFileSync(join(WORKFLOWS, n), "utf-8") }));
}

/** The `on:` block of a workflow, cut structurally — never a fixed window (#664). */
function triggers(text: string): string {
  const at = text.indexOf("\non:\n");
  if (at < 0) throw new Error("the workflow declares no `on:` block");
  const rest = text.slice(at + "\non:\n".length);
  const next = /\n[A-Za-z_][\w-]*:/.exec(rest);
  const cut = next === null ? rest : rest.slice(0, next.index);
  if (cut.trim() === "") throw new Error("the `on:` block is empty");
  return cut;
}

describe("#789 AC-1: something in this repository actually runs the freshness check", () => {
  test("exactly one workflow invokes the script, and it is scheduled", () => {
    // The case the cheapest wrong fix does not survive. Prose about how to
    // bump a pin does not put the question in front of anybody.
    const invoking = workflows().filter(w => w.text.includes(SCRIPT));
    expect(
      invoking.map(w => w.name),
      `no workflow runs ${SCRIPT} — it is still "run deliberately", which is never (#789)`,
    ).toHaveLength(1);

    const on = triggers(invoking[0].text);
    expect(on, "the check is not scheduled, so it runs only when somebody remembers").toContain("schedule:");
    expect(on, "the schedule carries no cron expression").toMatch(/cron:\s*["']/);
    // GitHub disables a schedule after 60 days of repository inactivity, and
    // a check nobody can trigger by hand goes quiet on exactly the week
    // nobody pushed.
    expect(on, "the check cannot be triggered by hand").toContain("workflow_dispatch:");
  });

  test("the script it names exists, and the step can authenticate", () => {
    const [w] = workflows().filter(x => x.text.includes(SCRIPT));
    expect(readFileSync(join(ROOT, SCRIPT), "utf-8").length).toBeGreaterThan(100);
    // `gh api` unauthenticated hits the anonymous rate limit, which the
    // script correctly reports as UNMEASURED and exits non-zero for — a
    // weekly red for a reason that has nothing to do with the pin, which is
    // how a check becomes one people switch off.
    expect(w.text, "the step has no token, so `gh api` runs unauthenticated").toContain("GH_TOKEN:");
  });

  test("the workflow's own actions follow the declaration, like every other position", () => {
    // Not a second decider: the same `actionRef` the generator uses. A
    // freshness check pinned by a mutable tag would be the one workflow in
    // the repo exempt from the rule it exists to maintain.
    const [w] = workflows().filter(x => x.text.includes(SCRIPT));
    const refs = [...w.text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].map(m => `${m[1]}${m[2]}`.trim());
    expect(refs.length, "the workflow uses no actions, so this checks nothing").toBeGreaterThan(0);
    for (const ref of refs) {
      const action = ref.split("@")[0];
      expect(ref, `${action} does not match what lib/workflow-actions.ts renders`).toBe(actionRef(action));
    }
  });
});

describe("#789 AC-2: the bump procedure has one declaring position", () => {
  test("the script does not spell its own, and names the exported one once", () => {
    // Two near-identical procedures is the shape where somebody updates the
    // copy an operator does not read.
    const src = readFileSync(join(ROOT, SCRIPT), "utf-8");
    expect(src.split("BUMP_PROCEDURE").length - 1, "the script does not use the one binding").toBeGreaterThan(1);
    // The distinctive clause of the procedure must not appear as a literal
    // anywhere in the script — the import is the only route to it.
    expect(src, "the script carries its own copy of the procedure").not.toContain(
      "sha, version and resolvedOn together",
    );
  });

  test("the procedure names the three fields that must move together", () => {
    // Bumping `sha` without `resolvedOn` leaves a reading dated to a commit
    // it was not taken against, which is worse than carrying no date.
    for (const field of ["sha", "version", "resolvedOn"]) {
      expect(BUMP_PROCEDURE, `the procedure does not name ${field}`).toContain(field);
    }
    expect(BUMP_PROCEDURE, "the procedure does not say consumers bump by upgrading").toContain("upgrading rungate");
  });
});

describe("#789 AC-3: the procedure reaches an operator, proved by provoking the refusal", () => {
  /**
   * Run the real script with a `gh` of our own on PATH.
   *
   * EXECUTED, not grepped. The #323 battery one issue earlier caught a case
   * that grepped a source for a string appearing at two sites and stayed
   * green when the named site was deleted (#484). A refusal's text is a
   * behaviour.
   */
  function runWithStubbedGh(sha: string): { code: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "rg-789-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, "gh");
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(sha)}\n`);
    chmodSync(gh, 0o755);
    const r = spawnSync("bun", [join(ROOT, SCRIPT)], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  const declared = PINNING.find(p => p.style === "sha");

  test("a tag that has moved refuses, and the refusal carries the procedure verbatim", () => {
    expect(declared, "no action is declared SHA-pinned, so this case asserts nothing").toBeDefined();
    const moved = "1".repeat(40);
    expect(moved, "the stub returns the declared sha, so nothing has moved").not.toBe(declared!.sha);

    const r = runWithStubbedGh(moved);
    expect(r.code, `a moved tag did not refuse: ${r.out}`).not.toBe(0);
    expect(r.out).toContain("STALE");
    expect(r.out, "the refusal tells an operator nothing about what to do").toContain(BUMP_PROCEDURE);
  });

  test("the control: a tag that has not moved reports current and exits 0", () => {
    // Without this the case above is satisfied by a script that refuses
    // everything, and the weekly workflow would be red from the first run.
    const r = runWithStubbedGh(declared!.sha!);
    expect(r.code, `an unmoved tag refused: ${r.out}`).toBe(0);
    expect(r.out).toContain("current:");
    expect(r.out, "an unmoved tag printed the bump procedure").not.toContain(BUMP_PROCEDURE);
  });
});

describe("#789 AC-4: the schedule is this repository's, not every consumer's", () => {
  test("the generator emits no freshness workflow", () => {
    // The negative control that makes "add it to the templates" a scope
    // change rather than a tightening. A consumer's pin comes from the
    // rungate version they installed; a scheduled job in each of them would
    // ask GitHub the same question N times and hand every consumer a red
    // workflow they cannot fix.
    const root = mkdtempSync(join(tmpdir(), "rg-789-gen-"));
    scratch.push(root);
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "c", ci: { runner: "ubuntu-latest", branches: ["main"] } }, null, 2) + "\n",
    );
    createCiWorkflows(root, []);

    const out = readdirSync(join(root, ".github", "workflows"));
    expect(out.length, "the generator wrote nothing, so this reads nothing").toBeGreaterThan(0);
    for (const name of out) {
      const text = readFileSync(join(root, ".github", "workflows", name), "utf-8");
      expect(text, `the generated ${name} runs the harness's freshness check (#789)`).not.toContain(SCRIPT);
    }
    expect(out, "a freshness workflow was generated into the consumer").not.toContain("action-pins.yml");
  });
});
