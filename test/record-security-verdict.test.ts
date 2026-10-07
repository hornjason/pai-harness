import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildRookRecord, failureList } from "../scripts/record-security-verdict";

/**
 * scripts/record-security-verdict.ts — the run artefact must answer "did
 * security run, and what did it say?" (#129, AC-4).
 *
 * Before this, `agents.rook` was never written: a run where rook reported a
 * reproduced guard bypass and a run where rook never spawned produced
 * byte-identical workflow-state.json files.
 *
 * This runs the real script against a real file rather than asserting on its
 * source text. PROJECT-STATE.md: every mutation that survived a first pass in
 * session 34 was a source-text assertion.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-security-verdict.ts");

let DIR = "";
let STATE = "";

/** The smallest workflow-state.json that writeWorkflowState will accept. */
function baseState() {
  return {
    schemaVersion: 2,
    issue: 129,
    slug: "pai-harness-129",
    phase: "VERIFY",
    issueGoal: "make the security review able to fail a run",
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "a rook FAIL verdict stops the ship run before a PR is opened",
        threshold: { op: "==", value: 0, unit: "exit code" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
  };
}

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "record-security-"));
  STATE = join(DIR, "workflow-state.json");
  writeFileSync(STATE, JSON.stringify(baseState(), null, 2));
});

afterEach(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

function run(args: string[]) {
  const r = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function readState() {
  return JSON.parse(readFileSync(STATE, "utf-8"));
}

describe("the verdict reaches workflow-state.json", () => {
  test("a FAIL is recorded with its findings", () => {
    const findings = join(DIR, "rook-findings.json");
    writeFileSync(
      findings,
      JSON.stringify({ failures: ["secret logged at gates/run-gate.ts:120", "unvalidated path join"] }),
    );
    const scope = join(DIR, "rook-scope.json");
    writeFileSync(scope, JSON.stringify({ sha: "a".repeat(40), base: "b".repeat(40), files: ["lib/a.ts"] }));

    const r = run([
      "--state", STATE, "--verdict", "FAIL", "--spawned", "true",
      "--findings", findings, "--scope", scope,
    ]);
    expect(r.code, r.err).toBe(0);

    const rook = readState().agents.rook;
    expect(rook.spawned).toBe(true);
    expect(rook.verdict).toBe("FAIL");
    expect(rook.failures).toEqual([
      "secret logged at gates/run-gate.ts:120",
      "unvalidated path join",
    ]);
    expect(rook.testedSha).toBe("a".repeat(40));
    expect(rook.testedPaths).toEqual(["lib/a.ts"]);
  });

  test("a PASS is recorded too, so silence is not ambiguous", () => {
    const scope = join(DIR, "rook-scope.json");
    writeFileSync(scope, JSON.stringify({ sha: "c".repeat(40), base: "d".repeat(40), files: ["lib/a.ts", "lib/b.ts"] }));
    const r = run(["--state", STATE, "--verdict", "PASS", "--spawned", "true", "--scope", scope]);
    expect(r.code, r.err).toBe(0);

    const rook = readState().agents.rook;
    expect(rook).toEqual({
      spawned: true,
      verdict: "PASS",
      testedSha: "c".repeat(40),
      testedPaths: ["lib/a.ts", "lib/b.ts"],
    });
  });

  test("the record survives the Zod schema with its failures intact", () => {
    // AgentSchema is a plain z.object, which STRIPS undeclared keys. Without
    // `failures` declared, a FAIL round-trips as a verdict with no reasons.
    const findings = join(DIR, "f.json");
    writeFileSync(findings, JSON.stringify({ failures: ["one", "two"] }));
    expect(run(["--state", STATE, "--verdict", "FAIL", "--spawned", "true", "--findings", findings]).code).toBe(0);
    expect(readState().agents.rook.failures).toEqual(["one", "two"]);
  });

  test("the changelog records that security ran", () => {
    run(["--state", STATE, "--verdict", "PASS", "--spawned", "true"]);
    const entry = readState().changelog.find((c: { event: string }) => c.event === "security-verdict");
    expect(entry).toBeDefined();
    expect(entry.actor).toBe("rook");
  });

  test("existing agents are not clobbered", () => {
    const s = baseState() as Record<string, unknown>;
    s.agents = { marcus: { spawned: true, verdict: "PASS", branch: "129-x" } };
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    expect(run(["--state", STATE, "--verdict", "PASS", "--spawned", "true"]).code).toBe(0);
    const agents = readState().agents;
    expect(agents.marcus.branch).toBe("129-x");
    expect(agents.rook.verdict).toBe("PASS");
  });
});

describe("the recorder fails closed", () => {
  test("a FAIL with no findings file still names something actionable", () => {
    // gates/SCHEMA-GUIDE.md: a FAIL verdict must carry a non-empty failures
    // list. A FAIL with nothing attached blocks the run without saying what to
    // fix, and the missing file IS the thing worth recording.
    expect(run(["--state", STATE, "--verdict", "FAIL", "--spawned", "false"]).code).toBe(0);
    const rook = readState().agents.rook;
    expect(rook.failures.length).toBeGreaterThan(0);
    expect(rook.failures[0]).toMatch(/no findings file|transcript/i);
  });

  test("a findings file that is not JSON does not become a PASS", () => {
    const findings = join(DIR, "broken.json");
    writeFileSync(findings, "not json at all");
    expect(run(["--state", STATE, "--verdict", "FAIL", "--spawned", "true", "--findings", findings]).code).toBe(0);
    const rook = readState().agents.rook;
    expect(rook.verdict).toBe("FAIL");
    expect(rook.failures.length).toBeGreaterThan(0);
  });

  test("the findings file cannot turn a FAIL into a PASS", () => {
    // The file is agent-authored. It supplies detail; it never supplies the
    // verdict, which the workflow computed.
    const findings = join(DIR, "f.json");
    writeFileSync(findings, JSON.stringify({ verdict: "PASS", result: "PASS", failures: [] }));
    expect(run(["--state", STATE, "--verdict", "FAIL", "--spawned", "true", "--findings", findings]).code).toBe(0);
    expect(readState().agents.rook.verdict).toBe("FAIL");
  });

  test("an unrecognised verdict is refused rather than written", () => {
    const r = run(["--state", STATE, "--verdict", "PROBABLY_FINE", "--spawned", "true"]);
    expect(r.code).not.toBe(0);
    expect(readState().agents).toBeUndefined();
  });

  test("a missing --state is refused", () => {
    expect(run(["--verdict", "PASS", "--spawned", "true"]).code).not.toBe(0);
  });

  test("a non-boolean --spawned is refused", () => {
    expect(run(["--state", STATE, "--verdict", "PASS", "--spawned", "yes"]).code).not.toBe(0);
  });

  test("an unknown option is refused rather than ignored", () => {
    expect(run(["--state", STATE, "--verdict", "PASS", "--spawned", "true", "--force", "1"]).code).not.toBe(0);
  });
});

describe("failureList / buildRookRecord", () => {
  test("a PASS keeps an empty list out of the record", () => {
    expect(buildRookRecord("PASS", true, null, null)).toEqual({ spawned: true, verdict: "PASS" });
  });

  test("blank and whitespace findings are dropped, not recorded", () => {
    expect(failureList("FAIL", { failures: ["  ", "", "real finding"] })).toEqual(["real finding"]);
  });

  test("a bare array of findings is accepted as well as {failures}", () => {
    expect(failureList("FAIL", ["a", "b"])).toEqual(["a", "b"]);
  });

  test("a FAIL never ends up with an empty list", () => {
    for (const f of [null, undefined, {}, [], { failures: [] }, { failures: "prose" }, "text"]) {
      expect(failureList("FAIL", f).length, JSON.stringify(f)).toBeGreaterThan(0);
    }
  });

  test("a malformed scope contributes no testedPaths rather than a wrong one", () => {
    const r = buildRookRecord("PASS", true, null, { sha: 42, files: "lib/a.ts" });
    expect(r.testedSha).toBeUndefined();
    expect(r.testedPaths).toBeUndefined();
  });
});
