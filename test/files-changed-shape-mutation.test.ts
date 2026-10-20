/**
 * Covers SC-2051 (HARNESS-STANDARD.md), issue #611 AC-6.
 *
 * `test/files-changed-path-shape.test.ts` proves the shape guard refuses an
 * annotated element. That is not the same claim as "the annotated element
 * can no longer reach the collection audit" — a suite that watched the guard
 * and never watched it ABSENT would be the decorative check
 * `.claude/rules/checks-must-be-able-to-fail.md` is about: every one of its
 * observations is satisfied by a run that refuses nothing, as long as the
 * fixture never gets as far as the audit.
 *
 * So the pre-#611 defect is REBUILT as a mutant — `filesChangedShapeRefusal`
 * short-circuited to `return null` in a copy of `workflows/ship.js` — and
 * the observation suite is SPAWNED against it, with one argv, differing only
 * in `SHIP_UNDER_TEST`. Four properties, all asserted rather than left as
 * conventions:
 *
 * - **The mutant and the original are shown to differ on a named input
 *   first.** A 0 and a "the mutation was never applied" look identical, and
 *   the only thing that separates them is an input on which the two behave
 *   differently, run rather than argued (#485, #297).
 * - **`ran` is read before any verdict.** A suite that failed to resolve its
 *   imports reports no failures and is indistinguishable from a suite that
 *   passed.
 * - **Green and red are compared by NAME.** "13 of 29" is satisfied by any
 *   thirteen; only these thirteen mean what this claims.
 * - **The mutation is local.** The two call sites, the rule table, the rule
 *   decider and the bare-path recovery are all asserted byte-identical
 *   between the real source and the mutant, so the reds are caused by the
 *   guard answering null and not by a mutant that damaged what it is
 *   measured through.
 *
 * The builder THROWS when its target moves rather than returning an
 * unmutated copy: a mutation harness that silently no-ops reports green over
 * a mutation that never happened.
 *
 * The literal claim of AC-6 — "the annotated fixture reaches the collection
 * audit again" — is also PERFORMED below, by running the mutant's own
 * decomposed-ship block and handing what it forwards to the real
 * `auditWorktreeClaims`.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria (SC-2051)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");
const SUITE = join(REPO_ROOT, "test", "files-changed-path-shape.test.ts");
const shipSource = readFileSync(SHIP, "utf-8");

/** The one binding the mutation removes. */
const GUARD_ANCHOR = "function filesChangedShapeRefusal(buildResult, label) {";

/**
 * What must survive the mutation untouched. If any of these moved, the reds
 * below would be measuring damage rather than the guard's absence.
 */
const LOCAL_SITES: Record<string, string> = {
  "the runImplement call site": "const shapeRefusal = filesChangedShapeRefusal(buildResult, 'marcus')",
  "the decomposed call site": "const subShapeRefusal = filesChangedShapeRefusal(buildResult, `marcus-sub-${subIssue.number}`)",
  "the rule table": "const FILES_CHANGED_SHAPE_RULES = [",
  "the rule decider": "function filesChangedShapeRule(p) {",
  "the bare-path recovery": "function barePathCandidate(element) {",
};

function occurrences(src: string, needle: string): number {
  let n = 0;
  let at = src.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = src.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * The pre-#611 source, rebuilt: the guard still exists, is still called from
 * both paths, and answers null for every result — which is exactly what a
 * pipeline with no element contract does.
 */
export function buildShapeRemovalMutant(src: string = shipSource): string {
  const hits = occurrences(src, GUARD_ANCHOR);
  if (hits !== 1) {
    throw new Error(
      `could not build the mutant: the guard anchor appears ${hits} times in workflows/ship.js, expected exactly 1. ` +
        `Either it was renamed, or a second copy exists and short-circuiting one would leave the other refusing.`,
    );
  }
  for (const [label, site] of Object.entries(LOCAL_SITES)) {
    const n = occurrences(src, site);
    if (n !== 1) {
      throw new Error(`could not build the mutant: ${label} appears ${n} times, expected exactly 1`);
    }
  }
  const out = src.replace(
    GUARD_ANCHOR,
    `${GUARD_ANCHOR}\n  return null // MUTANT: #611's element contract removed`,
  );
  if (out === src) throw new Error("could not build the mutant: the replacement changed nothing");
  return out;
}

/**
 * Extract the guard from an arbitrary ship.js source.
 *
 * SECURITY-HELPERS is prepended because the block also holds #830's
 * `reportedPathRefusal`, which calls `pathRefusal` from that block.
 */
function guardFrom(src: string): (r: unknown, label: string) => string | null {
  const start = src.indexOf("// ──── FILES-CHANGED-SHAPE-START ────");
  const end = src.indexOf("// ──── FILES-CHANGED-SHAPE-END ────");
  if (start < 0 || end < 0) throw new Error("FILES-CHANGED-SHAPE markers not found");
  const helpersStart = src.indexOf("// ──── SECURITY-HELPERS-START ────");
  const helpersEnd = src.indexOf("// ──── SECURITY-HELPERS-END ────");
  if (helpersStart < 0 || helpersEnd < 0) throw new Error("SECURITY-HELPERS markers not found");
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${src.slice(helpersStart, helpersEnd)}\n${src.slice(start, end)}\nreturn filesChangedShapeRefusal;`,
  )("/repo", () => {}) as never;
}

/** The element measured on wf_68a566ab-500. */
const MEASURED = "lib/scaffold/steps.ts (modified — added the refusal, ~40 lines)";

type SuiteRun = { ran: number; green: string[]; red: string[]; argv: string[]; output: string };

let TMP = "";
let JUNIT = "";
let MUTANT_PATH = "";
let mutantSource = "";
let real: SuiteRun;
let mutant: SuiteRun;

/**
 * Spawn the observation suite against one ship.js. The argv is returned so
 * the two spawns can be compared: "the same suite, spawned the same way" is
 * the premise of reading one against the other.
 */
function spawnSuite(shipPath: string): SuiteRun {
  const argv = ["test", SUITE, "--reporter=junit", `--reporter-outfile=${JUNIT}`];
  if (existsSync(JUNIT)) rmSync(JUNIT);
  const r = spawnSync("bun", argv, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 180000,
    env: { ...process.env, SHIP_UNDER_TEST: shipPath },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const xml = existsSync(JUNIT) ? readFileSync(JUNIT, "utf-8") : "";
  const green: string[] = [];
  const red: string[] = [];
  for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[3] ?? "";
    (body.includes("<failure") || body.includes("<error") ? red : green).push(m[1]!);
  }
  return { ran: green.length + red.length, green: green.sort(), red: red.sort(), argv, output };
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "files-changed-shape-mutation-"));
  JUNIT = join(TMP, "report.xml");
  MUTANT_PATH = join(TMP, "ship.mutant.js");
  mutantSource = buildShapeRemovalMutant();
  writeFileSync(MUTANT_PATH, mutantSource);
  real = spawnSuite(SHIP);
  mutant = spawnSuite(MUTANT_PATH);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ── the mutant is built, and the builder refuses when its target moves ──────

describe("#611 AC-6: the shape-removal mutant", () => {
  test("the guard anchor is located exactly once in ship.js", () => {
    expect(occurrences(shipSource, GUARD_ANCHOR)).toBe(1);
  });

  test("the mutant differs from the real source and keeps the block", () => {
    expect(mutantSource).not.toBe(shipSource);
    expect(mutantSource).toContain("// ──── FILES-CHANGED-SHAPE-START ────");
    expect(mutantSource).toContain("MUTANT: #611's element contract removed");
  });

  test("the mutation is local: every other site is byte-identical in the mutant", () => {
    for (const [label, site] of Object.entries(LOCAL_SITES)) {
      expect(occurrences(shipSource, site), `${label} is not unique in ship.js`).toBe(1);
      expect(occurrences(mutantSource, site), `${label} did not survive the mutation`).toBe(1);
    }
  });

  test("mutant and original differ on a NAMED input, run rather than argued", () => {
    // Before believing any count. A fixture both sources handle identically
    // is not a mutation, it is the code run twice (#485, #297).
    const before = guardFrom(shipSource)({ success: true, filesChanged: [MEASURED] }, "marcus");
    const after = guardFrom(mutantSource)({ success: true, filesChanged: [MEASURED] }, "marcus");
    expect(typeof before, "the real guard did not refuse the measured element").toBe("string");
    expect(before).toContain("annotated path");
    expect(after, "the mutant still refuses it — the mutation was not applied").toBeNull();
  });

  test("the builder ABORTS when the guard is renamed", () => {
    const renamed = shipSource.replace(GUARD_ANCHOR, "function filesChangedRefusal(buildResult, label) {");
    expect(renamed).not.toBe(shipSource);
    expect(() => buildShapeRemovalMutant(renamed)).toThrow(/could not build the mutant/);
    expect(() => buildShapeRemovalMutant(renamed)).toThrow(/the guard anchor appears 0 times/);
  });

  test("the builder ABORTS when a call site moves", () => {
    // A mutant built against a source whose call sites have gone would
    // measure nothing, and would do it quietly.
    const moved = shipSource.replace(LOCAL_SITES["the decomposed call site"]!, "// removed");
    expect(moved).not.toBe(shipSource);
    expect(() => buildShapeRemovalMutant(moved)).toThrow(
      /the decomposed call site appears 0 times/,
    );
  });
});

// ── the instrument, read before any verdict ────────────────────────────────

describe("#611 AC-6: the observation suite ran, both times", () => {
  test("the two spawns share one argv and differ only in SHIP_UNDER_TEST", () => {
    expect(mutant.argv).toEqual(real.argv);
  });

  test("the BASELINE is believable: the real spawn ran every case and all are green", () => {
    // Read first. An empty or absent baseline means the instrument stopped
    // reporting, and every row below it is uninterpretable (#60).
    expect(real.ran, `the real spawn reported no cases:\n${real.output}`).toBeGreaterThan(20);
    expect(real.red, "the real source is not green — the mutant rows mean nothing").toEqual([]);
  });

  test("the mutant spawn LOADED — it ran the same cases, it did not die on import", () => {
    expect(mutant.ran, `the mutant spawn reported no cases:\n${mutant.output}`).toBe(real.ran);
  });
});

// ── the count, and which rows produced it ──────────────────────────────────

describe("#611 AC-6: short-circuiting the guard turns the observations red", () => {
  test("at least three cases go red under the removal mutation", () => {
    expect(mutant.red.length).toBeGreaterThanOrEqual(3);
  });

  test("the reds are ABOUT the guard's absence, named one by one", () => {
    // A count alone cannot tell a working mutant from a broken one. These
    // are the cases whose subject is the refusal itself; every one of them
    // must be in the red list, and each must have been green on the real
    // source.
    const MUST_GO_RED = [
      "the measured element is refused",
      "an element at any index is checked, not just the first",
      "it names the annotation as the problem",
      "it quotes the bare path the element would have been",
      "a run whose implement reader ran hands the audit ZERO annotated elements",
      "an input ONLY the shape decider reaches: a space-separated annotation",
    ];
    for (const name of MUST_GO_RED) {
      const found = mutant.red.filter(r => r.includes(name));
      expect(found.length, `"${name}" stayed green under the mutation`).toBeGreaterThan(0);
      expect(real.green.filter(g => g.includes(name)).length, `"${name}" was not green on the real source`)
        .toBeGreaterThan(0);
    }
  });

  test("the positive controls stay GREEN under the mutation", () => {
    // The asymmetry is the measurement. A mutant that turns everything red
    // has broken the suite, not removed a guard — and `an input ONLY
    // pathRefusal reaches` staying green is what proves the shape guard and
    // the path table are two deciders rather than one.
    const MUST_STAY_GREEN = [
      "an ordinary list is NOT refused",
      "paths this repository actually contains are all accepted",
      "a genuine shell metacharacter still gets pathRefusal's staging sentence, unchanged",
      "an input ONLY pathRefusal reaches: a one-token path carrying a metacharacter",
      "CONTROL: the audit IS reachable, and the annotated element DOES produce a violation there",
    ];
    for (const name of MUST_STAY_GREEN) {
      expect(
        mutant.red.filter(r => r.includes(name)).length,
        `"${name}" went red — the mutant damaged the suite rather than removing the guard`,
      ).toBe(0);
    }
  });
});

// ── the literal claim: the fixture reaches the audit again ─────────────────

describe("#611 AC-6: under the mutant, the annotated element reaches the collection audit", () => {
  /** Run the decomposed-ship block out of an arbitrary ship.js source. */
  async function forwardedUnder(src: string): Promise<string[]> {
    const slice = (name: string) => {
      const a = src.indexOf(`// ──── ${name}-START ────`);
      const b = src.indexOf(`// ──── ${name}-END ────`);
      if (a < 0 || b < 0) throw new Error(`${name} markers not found`);
      return src.slice(a, b);
    };
    const factory = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal",
      "worktreeIdentity", "REPO", "taskSourceRefusal",
      "establishRunRef", "integrateWave", "waveNeedsIntegration",
      "measureLaunchBase",
      // SECURITY-HELPERS beneath the shape block: #830's
      // `reportedPathRefusal` lives there too and calls `pathRefusal`.
      `${slice("SECURITY-HELPERS")}\n${slice("FILES-CHANGED-SHAPE")}\n`
        + `${slice("DECOMPOSED-SHIP")}\nreturn runDecomposedShip;`,
    );
    const run = factory(
      () => {},
      async (p: string) => ({
        success: true,
        worktreePath: "/wt/a",
        worktreeRepo: "git@github.com:owner/project.git",
        taskSource: "brief",
        filesChanged: p.includes("beta") ? [MEASURED] : ["lib/alpha.ts"],
        testOutput: "2 pass",
      }),
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      "/tmp/work", 611, REPO_ROOT, {},
      async () => ({ success: true, buildResult: {} }),
      new Function(`${slice("IMPLEMENT-RESULT")}\nreturn implementRefusal;`)(),
      new Function(`${slice("WORKTREE-IDENTITY")}\nreturn worktreeIdentity;`)(),
      "owner/project",
      new Function(`${slice("BRIEF-PRECEDENCE")}\nreturn taskSourceRefusal;`)(),
      async () => ({ branch: "rungate/run-611", refusal: null }),
      async () => ({ ok: true, integrated: 0 }),
      new Function(`${slice("RUN-REF")}\nreturn waveNeedsIntegration;`)(),
      async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
    );
    const result: any = await run([
      { number: 1, title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
      { number: 2, title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
    ]);
    return Array.isArray(result?.buildResult?.filesChanged) ? result.buildResult.filesChanged : [];
  }

  /** The real claim audit, from the REAL source — the phase being reached. */
  function realAudit() {
    const slice = (name: string) => {
      const a = shipSource.indexOf(`// ──── ${name}-START ────`);
      const b = shipSource.indexOf(`// ──── ${name}-END ────`);
      return shipSource.slice(a, b);
    };
    return new Function(
      "PROJECT_ROOT", "log",
      `${slice("SECURITY-HELPERS")}\n${slice("COLLECT-CLAIM")}\nreturn auditWorktreeClaims`,
    )("/repo", () => {}) as (r: unknown) => { violations: Array<{ detail: string }> };
  }

  test("the real source forwards nothing annotated", async () => {
    expect(await forwardedUnder(shipSource)).not.toContain(MEASURED);
  });

  test("the mutant forwards it, and the audit refuses it with the git add sentence", async () => {
    const forwarded = await forwardedUnder(mutantSource);
    expect(forwarded, "the mutant did not forward the annotated element").toContain(MEASURED);

    const violations = realAudit()([
      { worktreePath: "/wt/a", filesChanged: forwarded, claimedFiles: forwarded },
      { worktreePath: "/wt/b", filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]).violations;
    const staging = violations.filter(v => v.detail.includes("git add refuses the path"));
    expect(staging.length, "the pre-#611 failure did not reproduce").toBeGreaterThan(0);
    expect(staging[0]!.detail).toContain("a shell metacharacter");
  });
});
