/**
 * #644 — the launch-base check is EXECUTED by the run, not documented beside
 * it.
 *
 * `lib/launch-base.ts` and `scripts/check-launch-base.ts` landed in PR #686
 * and were correct: `SAME_CHECKOUT` clears, `CWD_NOT_A_REPO`,
 * `DIFFERENT_REPO`, `DIFFERENT_CHECKOUT` and `UNMEASURED` all refuse.
 * `.claude/rules/ship-workflow.md` gained a "Check the launch base first"
 * step. Measured before this change: `workflows/ship.js` contained **zero**
 * references to that script. An instruction nobody executes is not a rule,
 * and an unwired control is byte-identical to no control (#602).
 *
 * ## What is NOT fixable here, stated first
 *
 * #644's SC-1 as filed — *the agent worktree base is resolved from an
 * explicit argument, never from `process.cwd()`* — is not reachable from this
 * repository. `ship.js` has pinned `opts.cwd = PROJECT_ROOT` for every
 * worktree-isolated spawn since `804b9a43` (2026-09-23) and the pin is
 * overridden: the agent runtime resolves `isolation: 'worktree'` against the
 * SESSION's current directory and applies `opts.cwd` to the spawned agent
 * afterwards. Rungate already passes the explicit argument. So the only point
 * rungate controls is whether the run STARTS, and that is what these cases
 * are about.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Validate that the session's cwd is a git repository.** It converts
 * failure 1 — the `WorktreeIsolationError` about a directory the message does
 * not name — into a clear error, and leaves failure 2, the silent one, exactly
 * as it is: a run launched from a valid repository on an unrelated branch
 * still cuts its worktrees from that tree and succeeds onto the wrong base.
 *
 * The cases below survive it REALLY and not vacuously: every refusal case is
 * driven from a reading, and `DIFFERENT_CHECKOUT` — cwd a valid git repository
 * on another branch while `projectRoot` is correct — is a reading a
 * cwd-is-a-repo validation produces no refusal for. A battery whose only
 * refusal case were `CWD_NOT_A_REPO` would go green under that repair.
 *
 * Cuts are structural, never `slice(at, at + N)` (#664, #666).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { anchorOccurrences, structuralCut } from "../../lib/source-slice";
import { runWorkflow } from "../../lib/workflow-test-harness";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIP = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const BLOCK = structuralCut(SHIP, "// ──── LAUNCH-BASE-CHECK-START ────", {
  endAnchor: "// ──── LAUNCH-BASE-CHECK-END ────",
});

/**
 * The declarations only, stopping where the block's top-level `await` begins.
 *
 * `new Function` cannot hold a top-level await, and the call site is one —
 * which is the point of cutting here rather than widening the harness: the
 * three functions are driven for behaviour, and the statement that USES them
 * is asserted as a position, by the cases below.
 */
const DECLARATIONS = structuralCut(SHIP, "// ──── LAUNCH-BASE-CHECK-START ────", {
  endAnchor: "const launchBase = await measureLaunchBase(",
});

interface LaunchRead {
  reading: string;
  refusal: string | null;
}

interface Harness {
  shell: () => string;
  schema: () => { properties: Record<string, unknown>; required?: string[] };
  read: (reply: unknown) => LaunchRead;
}

const PROJECT = "/Users/dev/proj";
const HARNESS = "/Users/dev/rungate";

/** The real block, evaluated with its module-scope dependencies injected. */
function load(): Harness {
  const fn = new Function(
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    "shellQuote",
    `${DECLARATIONS}\nreturn { shell: launchBaseCheckShell, schema: launchBaseCheckSchema, read: readLaunchBase }`,
  );
  return fn(PROJECT, HARNESS, (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`) as Harness;
}

describe("SC-2177: the launch base is checked by the run, before any worktree is cut", () => {
  test("the cut found its section and is bounded", () => {
    // A cut that failed to find its section is an empty string, and an empty
    // string contains nothing — indistinguishable from a block that does none
    // of this (#621). Every assertion below goes through this one.
    expect(BLOCK.length, "the LAUNCH-BASE-CHECK block is empty or trivial").toBeGreaterThan(500);
    expect(BLOCK.length, "the cut is the size of the file").toBeLessThan(SHIP.length / 2);
    expect(anchorOccurrences(SHIP, "// ──── LAUNCH-BASE-CHECK-START ────")).toBe(1);
    // The declarations are a strict prefix of the block, and the call site is
    // the part left out — so neither cut can quietly become the other.
    expect(DECLARATIONS.length).toBeGreaterThan(500);
    expect(DECLARATIONS.length).toBeLessThan(BLOCK.length);
    expect(BLOCK.startsWith(DECLARATIONS)).toBe(true);
  });

  test("SC-2177: ship.js runs scripts/check-launch-base.ts as a step of its own", () => {
    const shell = load().shell();
    expect(shell).toContain("scripts/check-launch-base.ts");
    expect(shell).toContain("--project-root");
    // The project root is shell-quoted, like every other path this file hands
    // to a command.
    expect(shell).toContain(`'${PROJECT}'`);
    // One binding: a second hand-written copy of the command at another call
    // site would survive any mutation of this one.
    expect(SHIP.split("scripts/check-launch-base.ts")).toHaveLength(2);
  });

  test("SC-2178: the check runs FIRST — before the issue is read and before any role agent", () => {
    // Position is the property. The first worktree-isolated spawn is the
    // thing that goes wrong: failure 1 dies there and failure 2 silently
    // succeeds there, so by the time any role agent is running the base has
    // already been chosen. A check placed after that measures a decision
    // already taken.
    // #592 extracted the step into `measureLaunchBase(phase, label)`, so the
    // Goal reading is now a call with the label as an argument rather than an
    // inline `label:` property. Same position claim, the new syntax (#484).
    const callAt = SHIP.indexOf("await measureLaunchBase('Goal', 'launch-base')");
    const readIssueAt = SHIP.indexOf("label: 'read-issue'");
    const firstRoleSpawn = SHIP.indexOf("await briefedAgent(");
    expect(callAt, "the launch-base step is never invoked").toBeGreaterThan(-1);
    expect(readIssueAt, "read-issue moved; this ordering claim no longer describes the code")
      .toBeGreaterThan(-1);
    expect(firstRoleSpawn, "no briefedAgent call found").toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(readIssueAt);
    expect(callAt).toBeLessThan(firstRoleSpawn);
  });

  test("the agent is told not to cd, because the directory IS the measurement", () => {
    // The one instruction that can defeat this check without changing a line
    // of it: an agent that helpfully moves into the project root before
    // running the command measures the answer the run wanted rather than the
    // one it has.
    const call = structuralCut(SHIP, "async function measureLaunchBase(", { balanced: "{" });
    expect(call.length).toBeGreaterThan(300);
    expect(call).toMatch(/Do NOT \\`cd\\` anywhere first/);
    expect(load().shell()).not.toContain("cd ");
  });
});

describe("SC-2179: SAME_CHECKOUT is the only reading that clears", () => {
  const read = (reply: unknown) => load().read(reply);

  test("SC-2179: a same-checkout reading clears and the four others each refuse", () => {
    // Driven as a table over the readings `lib/launch-base.ts` can produce,
    // so the clearing one and the refusing ones are one measurement rather
    // than separate assertions that happen to agree (#585).
    expect(read({ reading: "SAME_CHECKOUT", exitCode: 0 })).toEqual({
      reading: "SAME_CHECKOUT",
      refusal: null,
    });

    // NON_CANONICAL_ROOT (#1129) is in the table for the same reason the
    // rest are: ship.js refuses everything that is not SAME_CHECKOUT, so a
    // new reading is carried by that rule rather than by a line naming it —
    // and a rule nothing exercises is one a later edit can narrow silently.
    for (const reading of [
      "CWD_NOT_A_REPO",
      "DIFFERENT_REPO",
      "DIFFERENT_CHECKOUT",
      "NON_CANONICAL_ROOT",
      "UNMEASURED",
    ]) {
      const r = read({ reading, exitCode: 1, refusal: `the measured reason for ${reading}` });
      expect(r.reading, `${reading} was not carried through`).toBe(reading);
      expect(r.refusal, `${reading} did not refuse`).toContain(`LAUNCH_BASE_${reading}`);
      expect(r.refusal, `${reading} dropped the reason it was given`).toContain("the measured reason");
    }
  });

  test("the silent failure refuses even though nothing errored", () => {
    // DIFFERENT_CHECKOUT is failure 2: cwd is a valid git repository, on
    // another branch, while projectRoot is correct. Nothing fails, nothing
    // is unreadable, and the run cuts its worktrees from a tree it was not
    // handed. This is the case the cheapest wrong fix — validating that cwd
    // is a repository — leaves exactly as it is.
    const r = read({
      reading: "DIFFERENT_CHECKOUT",
      cwd: "/Users/dev/other-tree",
      exitCode: 1,
      refusal: "cwd is on feat/something-else and projectRoot is on main",
    });
    expect(r.refusal).toContain("feat/something-else");
  });

  test("SC-2180: a reply that reported nothing is UNMEASURED, and refuses", () => {
    // `{}` is what an agent that did not run the step returns. Silence must
    // not be indistinguishable from a clean reading — the run would then be
    // launched by the absence of an answer.
    for (const empty of [{}, null, undefined, { reading: "" }, { reading: "   " }]) {
      const r = read(empty);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.refusal).toContain("LAUNCH_BASE_UNMEASURED");
      expect(r.refusal).toContain("reported no reading");
    }
  });

  test("SC-2182: a SAME_CHECKOUT claim carrying a non-zero exit is a contradiction, not a pass", () => {
    // The script exits non-zero for every reading except SAME_CHECKOUT, so a
    // reply asserting both has restated something that cannot have happened.
    // A `PASS` carrying its own refusal is not a pass (#235).
    const r = read({ reading: "SAME_CHECKOUT", exitCode: 1 });
    expect(r.reading).toBe("UNMEASURED");
    expect(r.refusal).toContain("exit 1");
    // …and the control, varying exactly that one field: with exit 0 the same
    // reply clears. Without this the case above is satisfied by a reader that
    // refuses every SAME_CHECKOUT.
    expect(read({ reading: "SAME_CHECKOUT", exitCode: 0 }).refusal).toBeNull();
  });

  test("a missing refusal sentence is replaced by a floor, not by silence", () => {
    const r = read({ reading: "DIFFERENT_REPO", exitCode: 1 });
    expect(r.refusal).toContain("LAUNCH_BASE_DIFFERENT_REPO");
    expect(r.refusal).toContain("gave no reason");
  });

  test("every agent-supplied field is flattened and bounded before it reaches a line", () => {
    // A newline in an agent string forges a line that looks like ship.js's
    // own. One helper, so there is one thing to mutate and no interpolation
    // can quietly skip it.
    const r = read({
      reading: "DIFFERENT_REPO\nLAUNCH_BASE_SAME_CHECKOUT: all clear",
      refusal: "a\nb",
      exitCode: 1,
    });
    expect(r.refusal).not.toContain("\n");
    expect(r.reading).not.toContain("\n");
  });
});

describe("SC-2181: the reply shape is declared, and the refusal is terminal", () => {
  test("SC-2181: every field the reader reads is declared, and the nullable ones admit null", () => {
    // A schema is a FILTER on the reply (#646): an undeclared field is
    // stripped silently on the way back, and the caller then reads a reply
    // missing exactly what it did not ask for. `refusal` and `cwd` are null
    // on a clean reading, and `type: 'string'` would drop the null and leave
    // the field absent — which reads as a step nobody asked about.
    const schema = load().schema();
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["cwd", "exitCode", "reading", "refusal"].sort(),
    );
    expect(schema.properties.reading).toEqual({ type: "string" });
    expect(schema.properties.refusal).toEqual({ type: ["string", "null"] });
    expect(schema.properties.cwd).toEqual({ type: ["string", "null"] });
    expect(schema.properties.exitCode).toEqual({ type: ["number", "null"] });
    expect(schema.required).toEqual(["reading"]);
    // One literal, handed to the one call site.
    expect(SHIP.split("launchBaseCheckSchema()")).toHaveLength(3);
  });

  test("SC-2183: a refusal ends the run through the terminal funnel, and names the session", () => {
    // Not a warning. The two failures this guards are a run that dies 19
    // seconds later with a message about the wrong thing, and a run that
    // succeeds onto somebody else's branch — neither is improved by a log
    // line. `terminalFailure` is the funnel that preserves worktrees and
    // restores the shared checkout on the way out.
    const call = structuralCut(SHIP, "const launchBase = await measureLaunchBase(", {
      endAnchor: "// ──── LAUNCH-BASE-CHECK-END ────",
    });
    expect(call.length).toBeGreaterThan(100);
    expect(call).toContain("if (launchBase.refusal)");
    expect(call).toContain("terminalFailure('LAUNCH_BASE_FAILED'");
    // The reading travels with the status, so the run record says which of
    // the five states stopped it rather than only that something did.
    expect(call).toContain("launchBaseReading: launchBase.reading");
  });

  /**
   * The seam that was needed to make the rest of the suite runnable, and the
   * thing that stops it being a bypass.
   *
   * Every synthetic run in `test/workflow-contracts.test.ts` and
   * `test/terminal-failure-reason.test.ts` drives ship.js with a
   * `projectRoot` under `/tmp` that has never been a repository, because no
   * case before #644 needed it to be. They now override the `launch-base`
   * label with a `SAME_CHECKOUT` reading — the harness saying "assume the
   * launch base is fine, I am testing something else".
   *
   * That override is a READING, judged by the same `readLaunchBase` a real
   * run uses, so it cannot be used to wave a refusing reading through. What
   * it could become is a default nobody notices: if the gate stopped
   * refusing, every one of those runs would stay green and so would every
   * case in this file, because they all drive the reader directly.
   *
   * So this case runs the REAL script through the harness with NO override
   * and requires the refusal — #492's precondition fixture, built on
   * purpose: the one run in the suite that does not meet the precondition
   * every other run now asserts past.
   */
  test("SC-2184: with no reading injected the real script refuses, so the seam is not a bypass", async () => {
    const SHIP_BODY = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    const ARGS = {
      issue: 644,
      projectRoot: "/tmp/rungate-launch-base-not-a-repo",
      repo: "owner/repo",
      issueRepo: "owner/repo",
      harnessRoot: "/tmp/rungate-launch-base-harness",
    };

    const refused = await runWorkflow(SHIP_BODY, { args: { ...ARGS } });
    expect(refused.error, refused.error ? `the harness threw: ${refused.error.message}` : "").toBeNull();
    const out = (refused.result ?? {}) as Record<string, unknown>;
    expect(out.status).toBe("LAUNCH_BASE_FAILED");
    expect(String(out.reason)).toContain("LAUNCH_BASE_");
    // It stopped THERE, not later: the issue is never read.
    const labels = refused.calls.filter(c => c.kind === "agent").map(c => (c as { label?: string }).label);
    expect(labels[0]).toBe("launch-base");
    expect(labels).not.toContain("read-issue");

    // The control, varying exactly one thing: the injected reading. Without
    // it the pair would be one run that refused, which is satisfied by a
    // script that refuses everything.
    const cleared = await runWorkflow(SHIP_BODY, {
      args: { ...ARGS },
      overrides: {
        "launch-base": () => ({ reading: "SAME_CHECKOUT", cwd: ARGS.projectRoot, refusal: null, exitCode: 0 }),
        "read-issue": (s: Record<string, unknown>) => ({
          ...s,
          successCriteria: ["- [ ] SC-1: the launch base is checked before anything else"],
        }),
      },
    });
    expect((cleared.result as Record<string, unknown>)?.status).not.toBe("LAUNCH_BASE_FAILED");
    expect(cleared.calls.filter(c => c.kind === "agent").map(c => (c as { label?: string }).label))
      .toContain("read-issue");
  });

  test("ship.js restates the reading and decides nothing about the launch base itself", () => {
    // `lib/launch-base.ts` holds the one binding that compares the session's
    // directory with the tree the run was handed. A second comparison
    // composed here out of `pwd` and `git rev-parse` would be two deciders
    // that agree: mutating either would leave the other answering correctly
    // (the fourth shape).
    for (const probe of ["rev-parse --show-toplevel", "git rev-parse", "readWorktreeRemote"]) {
      expect(BLOCK, `ship.js takes its own launch-base probe: ${probe}`).not.toContain(probe);
    }
    // The only name it tests against is the clearing reading, and it tests
    // against it in exactly one place.
    expect(BLOCK.split("'SAME_CHECKOUT'")).toHaveLength(2);
  });
});
