import { test, expect, describe } from "bun:test";
import {
  prevalidateEvidence,
  measureEvidencePrevalidation,
  type PrevalidationResult,
  type ACInput,
} from "../lib/evidence-prevalidator";

const PROJECT_ROOT = import.meta.dir + "/..";

describe("evidence-prevalidator: prevalidateEvidence", () => {
  // AC-2: status ok — command succeeds with output
  test("returns status ok when evidence command succeeds with output", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-1",
        evidenceMethod: { type: "command", command: "echo hello" },
        threshold: { op: "contains", value: "hello" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AC-1");
    expect(results[0].status).toBe("ok");
    expect(results[0].needsRewrite).toBeFalsy();
  });

  // AC-2: status broken — command exits non-zero with no stdout
  test("returns status broken when command exits non-zero with no stdout", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-2",
        evidenceMethod: { type: "command", command: "false" },
        threshold: { op: "==", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AC-2");
    expect(results[0].status).toBe("broken");
  });

  // AC-2: status empty — command succeeds but returns zero-length output
  test("returns status empty when command succeeds but returns empty output", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-3",
        evidenceMethod: { type: "command", command: "printf ''" },
        threshold: { op: "==", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("AC-3");
    expect(results[0].status).toBe("empty");
  });

  // AC-3: auto-fix grep commands that exit 1 on zero matches
  test("auto-fixes grep exit code 1 by wrapping with || true", async () => {
    // grep for something that won't exist — exits 1
    const acs: ACInput[] = [
      {
        id: "AC-4",
        evidenceMethod: {
          type: "grep",
          command: "grep 'NEVER_MATCH_THIS_xyzzy_12345' /dev/null",
        },
        threshold: { op: ">=", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].autoFixed).toBe(true);
    expect(results[0].fixedCommand).toBeTruthy();
    // The fixed command should handle zero-match gracefully
    expect(results[0].fixedCommand).toContain("|| true");
  });

  // AC-3: auto-fix bun test piped through grep — flagged and rewritten
  test("auto-fixes bun test piped through grep to direct bun test", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-5",
        evidenceMethod: {
          type: "command",
          command: "bun test test/canary.test.ts | grep -c pass",
        },
        threshold: { op: ">=", value: "1" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    // Should flag the pipe pattern and rewrite
    expect(results[0].autoFixed).toBe(true);
    expect(results[0].fixedCommand).toMatch(/bun test/);
    expect(results[0].fixedCommand).not.toContain("|");
  });

  // AC-4: needsRewrite when auto-fix can't repair
  test("returns needsRewrite true when auto-fix cannot repair command", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-6",
        evidenceMethod: {
          type: "command",
          command: "nonexistent-binary-xyz --flag",
        },
        threshold: { op: "==", value: "0" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("broken");
    expect(results[0].needsRewrite).toBe(true);
    expect(results[0].diagnostic).toBeTruthy();
    expect(typeof results[0].diagnostic).toBe("string");
  });

  // AC-1: function signature — accepts ACs array and projectRoot
  test("handles multiple ACs and returns per-AC results", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-A",
        evidenceMethod: { type: "command", command: "echo foo" },
        threshold: { op: "contains", value: "foo" },
      },
      {
        id: "AC-B",
        evidenceMethod: { type: "command", command: "echo bar" },
        threshold: { op: "contains", value: "bar" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("AC-A");
    expect(results[1].id).toBe("AC-B");
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("ok");
  });

  // AC-1: skips ACs without evidenceMethod.command
  test("skips ACs without evidenceMethod.command", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-X",
        evidenceMethod: { type: "manual" },
        threshold: { op: "==", value: "done" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skipped");
  });

  // AC-2: broken — grep on nonexistent file (exit 2, not 1)
  test("marks grep on nonexistent file as broken, not auto-fixable", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-Y",
        evidenceMethod: {
          type: "grep",
          command: "grep 'pattern' /nonexistent/path/file.ts",
        },
        threshold: { op: ">=", value: "1" },
      },
    ];
    const results = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("broken");
    expect(results[0].needsRewrite).toBe(true);
    expect(results[0].diagnostic).toContain("nonexistent");
  });
});

describe("#118: bare main refs are qualified before the command is persisted", () => {
  /**
   * The repair has to reach the CALLER, not just the dry-run. The prevalidator
   * communicates fixes through `fixedCommand`; a result that says `ok` with no
   * `fixedCommand` tells the caller to keep the original. A stale-`main`
   * command usually dry-runs clean here — local `main` is only sometimes
   * behind — so without carrying the rewrite onto the ok path, the normalizer
   * would be a no-op in exactly the case it exists for.
   */

  test("an ok command still reports the rewritten form", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-1",
        // Succeeds regardless of ref drift, so it lands on the `ok` path.
        evidenceMethod: { type: "command", command: "git log main..HEAD --oneline | head -1 || echo none" },
        threshold: { op: "exists", value: "true" },
      },
    ];
    const [r] = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(r.fixedCommand, "the rewrite never reached the caller").toContain("origin/main..HEAD");
    expect(r.autoFixed).toBe(true);
  });

  test("the exact #103 command is repaired", async () => {
    const acs: ACInput[] = [
      {
        id: "AC-4",
        evidenceMethod: {
          type: "command",
          command: "git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?",
        },
        threshold: { op: "==", value: "0" },
      },
    ];
    const [r] = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(r.fixedCommand).toContain("origin/main");
    expect(r.fixedCommand).not.toMatch(/--exit-code main\b/);
  });

  test("a command with no bare ref is left exactly as written", async () => {
    // No spurious fixedCommand: the caller must be able to tell "nothing to do"
    // from "here is a replacement", or every AC looks rewritten.
    const acs: ACInput[] = [
      { id: "AC-2", evidenceMethod: { type: "command", command: "echo hello" }, threshold: { op: "contains", value: "hello" } },
    ];
    const [r] = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(r.status).toBe("ok");
    expect(r.fixedCommand).toBeUndefined();
    expect(r.autoFixed).toBeFalsy();
  });

  test("a broken command is reported broken AND ref-corrected", async () => {
    // Both facts matter: the caller needs to rewrite it, and the rewrite it
    // starts from should not reintroduce the stale ref.
    const acs: ACInput[] = [
      {
        id: "AC-3",
        evidenceMethod: { type: "command", command: "git rev-parse main && false" },
        threshold: { op: "exists", value: "true" },
      },
    ];
    const [r] = await prevalidateEvidence(acs, PROJECT_ROOT);
    expect(r.status).toBe("broken");
    expect(r.fixedCommand).toContain("origin/main");
  });
});

describe("#235: an auto-fix carries the command it replaced", () => {
  /**
   * `fixedCommand` on its own says what to run next and nothing about what was
   * wrong. Once the reading is persisted, the original is the only way to tell
   * a repair from a command that was always written that way — so every
   * auto-fixed result carries both forms, and nothing else carries either.
   */

  test("the ref-rewrite ok path reports both commands", async () => {
    // `; echo done` keeps the command on the `ok` path whether or not the
    // range has commits — an empty range lands on `empty`, which is a
    // different branch than the one this test is about.
    const original = "git log main..HEAD --oneline; echo done";
    const [r] = await prevalidateEvidence(
      [{ id: "AC-1", evidenceMethod: { type: "command", command: original }, threshold: { op: "exists", value: "true" } }],
      PROJECT_ROOT,
    );
    expect(r.status).toBe("ok");
    expect(r.autoFixed).toBe(true);
    expect(r.originalCommand).toBe(original);
    expect(r.fixedCommand).toContain("origin/main..HEAD");
    expect(r.fixedCommand).not.toBe(r.originalCommand);
  });

  test("the grep exit-code fix reports both commands", async () => {
    const original = "grep 'NEVER_MATCH_THIS_xyzzy_235' /dev/null";
    const [r] = await prevalidateEvidence(
      [{ id: "AC-2", evidenceMethod: { type: "grep", command: original }, threshold: { op: ">=", value: "0" } }],
      PROJECT_ROOT,
    );
    expect(r.autoFixed).toBe(true);
    expect(r.originalCommand).toBe(original);
    expect(r.fixedCommand).toBe(`${original} || true`);
  });

  test("the bun-test pipe rewrite reports both commands", async () => {
    const original = "bun test test/canary.test.ts | grep -c pass";
    const [r] = await prevalidateEvidence(
      [{ id: "AC-3", evidenceMethod: { type: "command", command: original }, threshold: { op: ">=", value: "1" } }],
      PROJECT_ROOT,
    );
    expect(r.autoFixed).toBe(true);
    expect(r.originalCommand).toBe(original);
    expect(r.fixedCommand).toBe("bun test test/canary.test.ts");
  });

  test("a command that was not fixed reports neither", async () => {
    const [r] = await prevalidateEvidence(
      [{ id: "AC-4", evidenceMethod: { type: "command", command: "echo hello" }, threshold: { op: "contains", value: "hello" } }],
      PROJECT_ROOT,
    );
    expect(r.autoFixed).toBeFalsy();
    expect(r.originalCommand).toBeUndefined();
    expect(r.fixedCommand).toBeUndefined();
  });
});

describe("#235: measureEvidencePrevalidation turns results into one reading", () => {
  test("all-ok is a PASS with no reason", async () => {
    const reading = await measureEvidencePrevalidation(
      [{ id: "AC-1", evidenceMethod: { type: "command", command: "echo ok" }, threshold: { op: "contains", value: "ok" } }],
      PROJECT_ROOT,
    );
    expect(reading.verdict).toBe("PASS");
    expect(reading.reason).toBeNull();
    expect(reading.acs).toHaveLength(1);
    expect(reading.checkedAt).toBeTruthy();
  });

  test("one broken command is a FAIL", async () => {
    const reading = await measureEvidencePrevalidation(
      [
        { id: "AC-1", evidenceMethod: { type: "command", command: "echo ok" }, threshold: { op: "contains", value: "ok" } },
        { id: "AC-2", evidenceMethod: { type: "command", command: "nonexistent-binary-xyzzy-235" }, threshold: { op: "==", value: "0" } },
      ],
      PROJECT_ROOT,
    );
    expect(reading.verdict).toBe("FAIL");
    expect(reading.acs.filter((a) => a.status === "broken").map((a) => a.id)).toEqual(["AC-2"]);
  });

  test("an empty-output command is a PASS that still names the AC", async () => {
    // `empty` is a warning at the gate, not a refusal — but it has to survive
    // into the reading, or the warning is the only record of it.
    const reading = await measureEvidencePrevalidation(
      [{ id: "AC-1", evidenceMethod: { type: "command", command: "printf ''" }, threshold: { op: "==", value: "0" } }],
      PROJECT_ROOT,
    );
    expect(reading.verdict).toBe("PASS");
    expect(reading.acs[0].status).toBe("empty");
  });
});
