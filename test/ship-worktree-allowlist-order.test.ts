/**
 * #1098 — the worktree allowlist runs before the agents, not after them.
 *
 * `marcusWorktreePath` is read off `implementResult.buildResult.worktreePath`,
 * a value the implement AGENT reports (#155). Two prompts then name it: the
 * Validate prompt 229 lines below the assignment tells Quinn to run every file
 * check and test in that directory, and the Fix prompt 295 lines below tells
 * the next agent to work in it. `collectDestination` — the allowlist that
 * decides whether a path is this run's project root or one of its own agent
 * worktrees — was not asked about that value until the collection step, ~350
 * lines and two agent invocations later, and then only about `commitDir` and
 * only on the multi-worktree branch.
 *
 * It is not a shell-injection hole; every interpolation is `shellQuote`d. It is
 * an ordering defect: the run decided it would not COMMIT from a directory two
 * agents had already been told to ACT in.
 *
 * WHAT WAS BROKEN TO PROVE THESE FAIL
 * (.claude/rules/checks-must-be-able-to-fail.md): every mutant below is built
 * from the real `workflows/ship.js` on each run, and each builder throws when
 * its substitution changes nothing — so a rename aborts this file rather than
 * passing it. The counts are in the PR body.
 *
 * The CONTROL is the point and it is `an ordinary agent worktree is not
 * refused`: an early check that refuses every worktree satisfies "the bad path
 * is refused before either prompt" perfectly, and would be found on the next
 * real ship and reverted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";
import { structuralCut } from "../lib/source-slice";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function markedBlock(name: string, source: string = shipSource): string {
  return structuralCut(source, `// ──── ${name}-START ────`, {
    endAnchor: `// ──── ${name}-END ────`,
  });
}

const PROJECT_ROOT = "/Users/x/Projects/demo";
const HARNESS_ROOT = "/Users/x/Projects/rungate";
const GOOD_WORKTREE = `${PROJECT_ROOT}/.claude/worktrees/marcus-1098`;
const HARNESS_WORKTREE = `${HARNESS_ROOT}/.claude/worktrees/marcus-1098`;
const FOREIGN = "/Users/x/Projects/someone-else";

/** The one refusal statement, so every claim about it names the same bytes. */
const GUARD = "if (!collectDestination(marcusWorktreePath)) {";

/** ship.js's real allowlist, executed rather than reimplemented here. */
const collectDestination = new Function(
  `${markedBlock("COLLECT-DESTINATION")}\nreturn collectDestination`,
)() as (dir: unknown, projectRoot?: string, harnessRoot?: string) => string | null;

interface GuardRun {
  refusal: { status: string; reason?: string; worktreePath?: string } | null;
  marcusWorktreePath: string | null;
  logs: string[];
}

/**
 * The real MARCUS-WORKTREE block, wrapped so its top-level `return` is legal,
 * with everything it reaches for injected.
 *
 * Executed, not grepped. A source-text assertion that the block "calls
 * collectDestination" is satisfied by a call whose result is thrown away, and
 * PROJECT-STATE.md records that every mutation surviving a first pass in this
 * repository has been a source-text assertion.
 */
function runGuard(worktreePath: unknown, source = shipSource): Promise<GuardRun> {
  const body = markedBlock("MARCUS-WORKTREE", source);
  if (!body.includes("marcusWorktreePath")) {
    throw new Error("could not build the harness: the block no longer binds marcusWorktreePath");
  }
  const logs: string[] = [];
  const run = new Function(
    "implementResult",
    "PROJECT_ROOT",
    "collectDestination",
    "log",
    "terminalFailure",
    `return (async () => {\n${body}\nreturn { refusal: null, marcusWorktreePath }\n})()`,
  );
  return run(
    { buildResult: { worktreePath } },
    PROJECT_ROOT,
    (d: unknown) => collectDestination(d, PROJECT_ROOT, HARNESS_ROOT),
    (m: string) => logs.push(String(m)),
    async (status: string, extra: Record<string, unknown>) => ({
      refusal: { status, ...extra },
      marcusWorktreePath: null,
    }),
  ).then((r: Omit<GuardRun, "logs">) => ({ ...r, logs }));
}

describe("#1098: the reported worktree is allowlisted at the assignment", () => {
  test("the block is at module top level, so a wrapper cannot switch it off", () => {
    // A wrapper outside the markers leaves the extracted bytes identical and
    // every assertion here green while the guard never runs (#266).
    expect(assertMarkedBlockReachable(shipSource, "MARCUS-WORKTREE")).toEqual(["Program"]);
  });

  test("it refuses before either prompt that names the path is built", () => {
    // The witness the issue asks for. "The run eventually fails" passed
    // before this change too — what did not was "the Validate prompt is
    // never built", and the only thing that can say so is the ORDER.
    // The REFUSAL STATEMENT, not the block marker. Measured on the marker
    // this case is green under the wrong fix that leaves the block where it
    // is and moves the check out of it — which is what the battery found
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fifth shape).
    const guardAt = shipSource.indexOf(GUARD);
    const blockAt = shipSource.indexOf("// ──── MARCUS-WORKTREE-START ────");
    const validateAt = shipSource.indexOf("IMPORTANT: Validate against Marcus's worktree at:");
    const fixAt = shipSource.indexOf("IMPORTANT: Work in the worktree at:");

    expect(guardAt, "the allowlist refusal is gone").toBeGreaterThan(-1);
    expect(blockAt, "the MARCUS-WORKTREE block is gone").toBeGreaterThan(-1);
    expect(validateAt, "nothing builds the Validate prompt — this ordering measures nothing")
      .toBeGreaterThan(-1);
    expect(fixAt, "nothing builds the Fix prompt — this ordering measures nothing")
      .toBeGreaterThan(-1);

    expect(guardAt, "the refusal moved below the Validate prompt").toBeLessThan(validateAt);
    expect(guardAt, "the refusal moved below the Fix prompt").toBeLessThan(fixAt);
    // …and it is inside the block the executed cases below slice, so those
    // cases and this one are about the same statement.
    expect(blockAt, "the refusal sits outside the block the executed cases read")
      .toBeLessThan(guardAt);
    expect(guardAt).toBeLessThan(shipSource.indexOf("// ──── MARCUS-WORKTREE-END ────"));
  });

  test("the late consumer is still late — the new guard is what moved, not it", () => {
    // The premise of the fix, asserted rather than assumed. If
    // `collectAgentWork`'s own allowlist call had been hoisted instead, this
    // file would be measuring a second copy of the same decision and the
    // ordering case above would pass for the wrong reason.
    const validateAt = shipSource.indexOf("IMPORTANT: Validate against Marcus's worktree at:");
    const lateAt = shipSource.indexOf("const dest = collectDestination(intoDir)");
    expect(lateAt, "the collector no longer allowlists its destination").toBeGreaterThan(-1);
    expect(lateAt, "the collector's check is no longer the late one this issue is about")
      .toBeGreaterThan(validateAt);
  });

  test("a worktree outside the allowlist ends the run", async () => {
    const got = await runGuard(FOREIGN);
    expect(got.marcusWorktreePath, "the run carried on holding a path it may not act in").toBeNull();
    expect(got.refusal?.status).toBe("WORKTREE_PATH_REFUSED");
    expect(String(got.refusal?.reason)).toContain(FOREIGN);
    expect(got.logs.join("\n")).toContain("IMPLEMENT REFUSED");
  });

  test("an ordinary agent worktree is not refused", async () => {
    // THE CONTROL. Without it, every case above is satisfied by a guard that
    // refuses every run — which is the cheapest way to pass an acceptance row
    // written only around the bad path.
    for (const ok of [GOOD_WORKTREE, HARNESS_WORKTREE, PROJECT_ROOT]) {
      const got = await runGuard(ok);
      expect(got.refusal, `${ok} was refused`).toBeNull();
      expect(got.marcusWorktreePath).toBe(ok);
    }
  });

  test("an implement reply with no worktree at all falls back to the project root", async () => {
    // The uncontained run, which is legitimate and must keep working: a
    // guard that refused it would fire on every non-isolated ship.
    for (const empty of [undefined, null, ""]) {
      const got = await runGuard(empty);
      expect(got.refusal, `${JSON.stringify(empty)} was refused`).toBeNull();
      expect(got.marcusWorktreePath).toBe(PROJECT_ROOT);
    }
  });

  test("the shapes collectDestination exists for are refused here too", async () => {
    // Not a re-test of the allowlist — a check that the allowlist is what
    // this block consults, over the inputs an agent reply can carry (#155).
    for (const bad of [
      "relative/path",
      `${PROJECT_ROOT}/.claude/worktrees/../../../etc`,
      "/tmp/$(id)",
      `${PROJECT_ROOT}/.claude/worktrees/a\nb`,
      `${PROJECT_ROOT}-sibling`,
    ]) {
      const got = await runGuard(bad);
      expect(got.refusal?.status, `${JSON.stringify(bad)} was allowed through`)
        .toBe("WORKTREE_PATH_REFUSED");
    }
  });

  test("removing the guard lets the foreign path reach the prompts", async () => {
    // The mutation, built from the real block so a rename aborts the file.
    const anchor = GUARD;
    expect(shipSource.split(anchor).length - 1, "the guard appears other than exactly once")
      .toBe(1);
    const mutant = shipSource.replace(anchor, "if (false) {");
    expect(mutant, "the mutation changed nothing").not.toBe(shipSource);

    const got = await runGuard(FOREIGN, mutant);
    expect(got.refusal, "the mutant still refused — this case witnesses nothing").toBeNull();
    expect(got.marcusWorktreePath, "the pre-#1098 behaviour: the path is carried to the prompts")
      .toBe(FOREIGN);
  });
});

describe("#1098: the identity boundary vets the destination as well", () => {
  test("it asks the allowlist about every row it already reads", () => {
    const block = markedBlock("COLLECT-IDENTITY");
    expect(block.length, "the COLLECT-IDENTITY cut came back empty").toBeGreaterThan(0);
    expect(block.length, "the cut is the whole of ship.js, not the block")
      .toBeLessThan(shipSource.length);
    // The same binding, not a private re-implementation: a second decider
    // would survive any mutation of the first.
    expect(block).toContain("allowPath: collectDestination");
  });

  test("a row in the right repository but the wrong directory is refused", async () => {
    // The gap identity alone cannot close. A clone of THIS repository parked
    // somewhere else reports a matching `worktreeRepo`, so every identity
    // reading says match — and the directory is still not one this run owns.
    const { worktreeIdentityViolations } = new Function(
      `${markedBlock("WORKTREE-IDENTITY")}\nreturn { worktreeIdentityViolations }`,
    )() as {
      worktreeIdentityViolations: (
        rows: unknown,
        repo: string,
        opts?: Record<string, unknown>,
      ) => string[];
    };
    const row = [{ worktreePath: FOREIGN, worktreeRepo: "git@github.com:hornjason/pai-harness.git" }];
    const repo = "hornjason/pai-harness";
    const allowPath = (d: unknown) => collectDestination(d, PROJECT_ROOT, HARNESS_ROOT);

    expect(
      worktreeIdentityViolations(row, repo, { requirePath: true }),
      "identity alone already refused it — this case measures nothing",
    ).toEqual([]);

    const withAllow = worktreeIdentityViolations(row, repo, { requirePath: true, allowPath });
    expect(withAllow).toHaveLength(1);
    expect(withAllow[0]).toContain("not a directory this run may act in");

    // The control: the same predicate must not refuse a legitimate worktree.
    expect(
      worktreeIdentityViolations(
        [{ worktreePath: GOOD_WORKTREE, worktreeRepo: "git@github.com:hornjason/pai-harness.git" }],
        repo,
        { requirePath: true, allowPath },
      ),
    ).toEqual([]);
  });
});
