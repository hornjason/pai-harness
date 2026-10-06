/**
 * #69 — the Grade phase's tail never ran.
 *
 * Nine top-level `require()` calls sat at ship.js:1784-1869. The workflow
 * sandbox has no module loading, so every one of them threw — and all nine sat
 * inside try/catch, so `require is not defined` was swallowed and logged as a
 * WARN. Compliance persistence, compliance history, hill-climb brief patching
 * and transcript re-grading had therefore never executed, while the run
 * reported success.
 *
 * The fix moves the block to scripts/persist-compliance.ts, which runs in a
 * real Bun runtime. These tests are the behavioural coverage that block never
 * had: it was unreachable code, so nothing could have tested it in place.
 *
 * The ratchet assertion — ship.js now has ZERO top-level require() — lives in
 * test/workflow-security-integration.test.ts next to the counter it banks.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { persistCompliance } from "../../scripts/persist-compliance";

const HARNESS_ROOT = join(import.meta.dir, "..", "..");

let root: string;
let workDir: string;

/** A workflow-state.json that satisfies WorkflowStateSchema, which validates on write. */
function writeState(dir: string) {
  writeFileSync(
    join(dir, "workflow-state.json"),
    JSON.stringify({
      schemaVersion: 2,
      issue: 69,
      slug: "persist-compliance",
      phase: "VERIFY",
      issueGoal: "remove top-level require from ship.js",
      acs: [],
    }),
  );
}

function writeGrade(dir: string, grades: unknown[], extra: Record<string, unknown> = {}) {
  writeFileSync(join(dir, "compliance-grade.json"), JSON.stringify({ grades, ...extra }));
}

const GRADE_A = {
  role: "marcus",
  total: 4,
  followed: 3,
  flagged: ["COMP-7"],
  rules: [
    { id: "COMP-1", verdict: "FOLLOWED" },
    { id: "COMP-7", verdict: "IGNORED" },
  ],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "persist-compliance-"));
  workDir = join(root, "run");
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#69: persistCompliance reads the grade off disk", () => {
  test("throws when compliance-grade.json is absent", () => {
    // Fails LOUD. The whole defect was a silent skip, so "grading never ran"
    // must not read the same as "grading ran and found nothing".
    writeState(workDir);
    expect(() => persistCompliance(workDir, HARNESS_ROOT, "69", () => {})).toThrow(
      /no compliance-grade\.json/,
    );
  });

  test("throws when compliance-grade.json is not valid JSON", () => {
    writeState(workDir);
    writeFileSync(join(workDir, "compliance-grade.json"), "{not json");
    expect(() => persistCompliance(workDir, HARNESS_ROOT, "69", () => {})).toThrow(
      /not valid JSON/,
    );
  });

  test("takes the grade from the file, not from a caller-supplied value", () => {
    // The point of reading the file: scripts/grade-deterministic.ts writes it,
    // so the number cannot be reshaped by an agent restating it (#81 lesson).
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);
    const r = persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    expect(r.graded).toBe(1);

    const ws = JSON.parse(readFileSync(join(workDir, "workflow-state.json"), "utf-8"));
    expect(ws.compliance.grades).toEqual([
      { role: "marcus", followed: 3, total: 4, pct: 75, flagged: ["COMP-7"] },
    ]);
  });
});

describe("#69: workflow-state persistence", () => {
  test("records efficiency and timing alongside the grades", () => {
    writeState(workDir);
    writeGrade(workDir, [GRADE_A], { timing: [{ role: "marcus", seconds: 12 }] });
    writeFileSync(join(workDir, "efficiency.json"), JSON.stringify({ toolCalls: 42 }));
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});

    const ws = JSON.parse(readFileSync(join(workDir, "workflow-state.json"), "utf-8"));
    expect(ws.compliance.efficiency).toEqual({ toolCalls: 42 });
    expect(ws.compliance.timing).toEqual([{ role: "marcus", seconds: 12 }]);
  });

  test("efficiency is read from disk, never interpolated into a shell command", () => {
    // Why the file and not a CLI argument: efficiency originates from an agent
    // restating analyze-transcript.ts output, and interpolating agent-derived
    // JSON into a shell string is the #81 shape. A presentational field is not
    // worth that, so the data never touches a command line.
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);
    writeFileSync(
      join(workDir, "efficiency.json"),
      JSON.stringify({ toolCalls: 7, note: "'; touch /tmp/pwned-69; echo '" }),
    );
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});

    const ws = JSON.parse(readFileSync(join(workDir, "workflow-state.json"), "utf-8"));
    expect(ws.compliance.efficiency.toolCalls).toBe(7);
    expect(existsSync("/tmp/pwned-69")).toBe(false);
  });

  test("an absent efficiency.json records null rather than failing", () => {
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    const ws = JSON.parse(readFileSync(join(workDir, "workflow-state.json"), "utf-8"));
    expect(ws.compliance.efficiency).toBeNull();
  });

  test("a missing workflow-state.json does not discard the compliance history", () => {
    // Deliberately non-fatal, matching the original. The grade record is the
    // more valuable artifact and must survive a state file that is not there.
    writeGrade(workDir, [GRADE_A]);
    const r = persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    expect(r.persisted).toBe(false);
    expect(r.graded).toBe(1);
    expect(existsSync(join(root, "compliance-history.jsonl"))).toBe(true);
  });

  test("the failure to persist is reported, never silent", () => {
    // This is the #69 defect in miniature: the original logged a WARN that
    // nobody saw because the code had never run far enough to emit one.
    writeGrade(workDir, [GRADE_A]);
    const logs: string[] = [];
    persistCompliance(workDir, HARNESS_ROOT, "69", m => logs.push(m));
    expect(logs.join("\n")).toContain("could not persist compliance data");
  });

  test("pct is 0 rather than NaN when a role has no rules", () => {
    writeState(workDir);
    writeGrade(workDir, [{ role: "quinn", total: 0, followed: 0, rules: [] }]);
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    const ws = JSON.parse(readFileSync(join(workDir, "workflow-state.json"), "utf-8"));
    expect(ws.compliance.grades[0].pct).toBe(0);
  });
});

describe("#69: compliance history", () => {
  const historyPath = () => join(root, "compliance-history.jsonl");

  test("appends one entry per graded role with per-rule verdicts", () => {
    writeState(workDir);
    writeGrade(workDir, [GRADE_A, { role: "quinn", total: 2, followed: 2, rules: [{ id: "COMP-2", verdict: "FOLLOWED" }] }]);
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});

    const lines = readFileSync(historyPath(), "utf-8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].role).toBe("marcus");
    expect(lines[0].issue).toBe("#69");
    expect(lines[0].scores).toEqual({ "COMP-1": "FOLLOWED", "COMP-7": "IGNORED" });
    expect(lines[1].scores).toEqual({ "COMP-2": "FOLLOWED" });
  });

  test("a rule with no verdict is recorded N/A rather than dropped", () => {
    writeState(workDir);
    writeGrade(workDir, [{ role: "marcus", total: 1, followed: 0, rules: [{ id: "COMP-9" }] }]);
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    const entry = JSON.parse(readFileSync(historyPath(), "utf-8").trim());
    expect(entry.scores).toEqual({ "COMP-9": "N/A" });
  });

  test("history accumulates across runs instead of overwriting", () => {
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);
    persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    persistCompliance(workDir, HARNESS_ROOT, "70", () => {});

    const lines = readFileSync(historyPath(), "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).issue).toBe("#69");
    expect(JSON.parse(lines[1]).issue).toBe("#70");
  });

  test("the current run is excluded from the history it is compared against", () => {
    // `.slice(0, -1)` drops the entry just appended. Without it the run trends
    // against itself: the first run would report "last 2: 75% → 75%" comparing
    // one grade to a copy of itself, and every later run would carry a
    // duplicate that damps any real movement.
    //
    // The trend line is the observable. With the slice, a first run has a
    // single data point and formatComplianceReport prints no trend line at all
    // (it requires pcts.length > 1). Drop the slice and the line appears.
    // Asserting on its ABSENCE is what makes this detect the mutation rather
    // than merely exercise the code.
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);

    const first: string[] = [];
    persistCompliance(workDir, HARNESS_ROOT, "69", m => first.push(m));
    expect(first.join("\n")).toContain("Score: 3/4 (75%)");
    expect(first.join("\n")).not.toContain("Trend (last");

    // Second run, a different score: the window is exactly the one prior run.
    writeGrade(workDir, [{ ...GRADE_A, total: 4, followed: 2 }]);
    const second: string[] = [];
    persistCompliance(workDir, HARNESS_ROOT, "70", m => second.push(m));
    expect(second.join("\n")).toContain("Trend (last 2): 75% → 50%");

    expect(readFileSync(historyPath(), "utf-8").trim().split("\n").length).toBe(2);
  });
});

describe("#69: hill-climb", () => {
  test("no brief for a role is reported and skipped, not thrown", () => {
    writeState(workDir);
    writeGrade(workDir, [{ role: "nobody-has-this-role", total: 1, followed: 0, rules: [{ id: "COMP-1", verdict: "IGNORED" }] }]);
    const logs: string[] = [];
    expect(() => persistCompliance(workDir, HARNESS_ROOT, "69", m => logs.push(m))).not.toThrow();
  });

  test("a clean grade applies no reinforcements", () => {
    writeState(workDir);
    writeGrade(workDir, [{ role: "marcus", total: 2, followed: 2, rules: [{ id: "COMP-1", verdict: "FOLLOWED" }] }]);
    const r = persistCompliance(workDir, HARNESS_ROOT, "69", () => {});
    expect(r.hillClimbApplied).toBe(0);
    expect(r.verified).toEqual([]);
  });
});

describe("#69: the CLI contract ship.js depends on", () => {
  // spawnSync, not execFileSync: execFileSync returns stdout and throws away
  // stderr on success, and the warnings this script emits on the success path
  // are exactly what some of these tests assert on.
  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const r = spawnSync("bun", [join(HARNESS_ROOT, "scripts", "persist-compliance.ts"), ...args], {
      encoding: "utf-8",
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("emits a single JSON receipt on stdout and exits 0", () => {
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);
    const { status, stdout } = run([workDir, HARNESS_ROOT, "69"]);
    expect(status).toBe(0);
    // One line, parseable. ship.js reaches this through an agent, so stdout is
    // relayed as generated text — prose on stdout would be relayed too.
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, persisted: true, graded: 1 });
  });

  test("exits non-zero with ok:false when there is no grade to persist", () => {
    writeState(workDir);
    const { status, stdout } = run([workDir, HARNESS_ROOT, "69"]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false });
  });

  test("exits 2 on missing arguments", () => {
    expect(run([workDir]).status).toBe(2);
  });

  test("a malformed efficiency.json degrades to null, it does not fail the run", () => {
    writeState(workDir);
    writeGrade(workDir, [GRADE_A]);
    writeFileSync(join(workDir, "efficiency.json"), "{broken");
    const { status, stdout, stderr } = run([workDir, HARNESS_ROOT, "69"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout.trim()).ok).toBe(true);
    expect(stderr).toContain("efficiency.json is unreadable");
    const ws = JSON.parse(readFileSync(join(workDir, "workflow-state.json"), "utf-8"));
    expect(ws.compliance.efficiency).toBeNull();
  });
});
