import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runScopePreflightsAndPersist } from "../../gates/gate-executor";
import {
  EvidencePrevalidationSchema,
  WorkflowStateSchema,
  EVIDENCE_PREVALIDATION_FIELDS,
} from "../../gates/schema";
import { measureEvidencePrevalidation } from "../../lib/evidence-prevalidator";

/**
 * The scope gate's evidence pre-validation, measured through the file the gate
 * tests actually read (#235).
 *
 * Before this, `runScopePreflights` called `prevalidateEvidence(...).then(...)`
 * and returned immediately: the verdict landed in stdout, after the gate had
 * already written workflow-state.json and started the gate tests, and nothing
 * downstream could see it. A reading that exists only in a log line is a
 * reading no check can fail on.
 */

const SLOW_MS = 1000;

function tempProject(): { dir: string; sf: string } {
  // A temp dir on purpose, and not the repo: it carries no .claude/rungate.json,
  // so the scope preflights' test-baseline step short-circuits instead of
  // running the whole suite inside a unit test.
  const dir = mkdtempSync(join(tmpdir(), "prevalidation-gate-"));
  return { dir, sf: join(dir, "workflow-state.json") };
}

function baseState(dir: string, acs: unknown[]): Record<string, any> {
  return {
    schemaVersion: 2,
    issue: 235,
    slug: "prevalidation-gate-fixture",
    projectRoot: dir,
    phase: "SCOPE",
    issueGoal: "Persist the evidence pre-validation reading at the scope gate",
    acs,
  };
}

function plant(acs: unknown[]): { dir: string; sf: string; state: Record<string, any> } {
  const { dir, sf } = tempProject();
  const state = baseState(dir, acs);
  writeFileSync(sf, JSON.stringify(state, null, 2));
  return { dir, sf, state };
}

describe("#235: the scope gate awaits pre-validation and persists its reading", () => {
  test("a slow evidence command is still in the file when the gate hands over", async () => {
    const { dir, sf, state } = plant([
      {
        id: "AC-1",
        type: "CODE",
        statement: "the slow evidence command resolves before the gate writes state",
        threshold: { op: "contains", value: "measured" },
        evidenceMethod: { type: "command", command: `sleep ${SLOW_MS / 1000}; echo measured` },
      },
    ]);

    // The planted file has no reading — so "present afterwards" cannot be
    // something the fixture supplied.
    expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation).toBeUndefined();

    const started = Date.now();
    await runScopePreflightsAndPersist(state, sf, dir);
    const elapsed = Date.now() - started;

    const persisted = JSON.parse(readFileSync(sf, "utf-8"));
    expect(
      persisted.evidencePrevalidation,
      "workflow-state.json was written before the pre-validation resolved",
    ).toBeTruthy();
    expect(persisted.evidencePrevalidation.verdict).toBe("PASS");
    expect(persisted.evidencePrevalidation.acs.map((a: any) => a.id)).toEqual(["AC-1"]);

    // The fire-and-forget version returned in microseconds. Waiting for the
    // command is the behaviour under test, so it is asserted rather than
    // inferred from the field being present.
    expect(elapsed, "the pre-validation was not awaited").toBeGreaterThanOrEqual(SLOW_MS - 100);
  }, 30000);

  test("the persisted state still validates against WorkflowStateSchema", async () => {
    const { dir, sf, state } = plant([
      {
        id: "AC-1",
        type: "CODE",
        statement: "the evidence command prints a value the threshold can read",
        threshold: { op: "contains", value: "measured" },
        evidenceMethod: { type: "command", command: "echo measured" },
      },
    ]);

    await runScopePreflightsAndPersist(state, sf, dir);

    const persisted = JSON.parse(readFileSync(sf, "utf-8"));
    const parsed = WorkflowStateSchema.passthrough().safeParse(persisted);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  }, 30000);

  test("a broken evidence command persists a FAIL verdict the schema accepts", async () => {
    const { dir, sf, state } = plant([
      {
        id: "AC-1",
        type: "CODE",
        statement: "the broken evidence command is caught before Marcus runs",
        threshold: { op: "contains", value: "never" },
        evidenceMethod: { type: "command", command: "nonexistent-binary-xyzzy-235 --flag" },
      },
      {
        id: "AC-2",
        type: "CODE",
        statement: "a healthy evidence command sits beside the broken one",
        threshold: { op: "contains", value: "fine" },
        evidenceMethod: { type: "command", command: "echo fine" },
      },
    ]);

    await runScopePreflightsAndPersist(state, sf, dir);

    const reading = JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation;
    expect(reading.verdict).toBe("FAIL");
    expect(reading.reason).toBeNull();

    const broken = reading.acs.find((a: any) => a.id === "AC-1");
    expect(broken.status).toBe("broken");
    expect(broken.needsRewrite).toBe(true);
    expect(broken.diagnostic).toBeTruthy();
    expect(reading.acs.find((a: any) => a.id === "AC-2").status).toBe("ok");

    const parsed = EvidencePrevalidationSchema.safeParse(reading);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();

    // And the whole state round-trips, which is the form the gate tests read.
    const whole = WorkflowStateSchema.passthrough().safeParse(
      JSON.parse(readFileSync(sf, "utf-8")),
    );
    expect(whole.success ? null : whole.error.issues).toBeNull();
  }, 30000);

  test("a pre-validation that throws persists UNMEASURED, not absence and not PASS", async () => {
    // A command that is not a string is the shape discovery can actually
    // produce, and it makes the pre-validator throw rather than return — the
    // case where a swallowed error used to leave the field empty, which reads
    // downstream exactly like "nothing was wrong".
    const { dir, sf, state } = plant([
      {
        id: "AC-1",
        type: "CODE",
        statement: "the pre-validator throws on a command that is not a string",
        threshold: { op: "contains", value: "measured" },
        evidenceMethod: { type: "command", command: 42 },
      },
    ]);

    await runScopePreflightsAndPersist(state, sf, dir);

    const reading = JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation;
    expect(reading, "a throw left the field absent — indistinguishable from clean").toBeTruthy();
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.verdict).not.toBe("PASS");
    expect(reading.reason, "UNMEASURED with no reason is unactionable").toBeTruthy();
    expect(reading.acs).toEqual([]);

    const parsed = EvidencePrevalidationSchema.safeParse(reading);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  }, 30000);

  test("an auto-fixed AC is persisted with both the original and the fixed command", async () => {
    const { dir, sf, state } = plant([
      {
        // Ref-rewrite path: git fails in a temp dir, `|| echo none` makes the
        // command succeed, so this lands on the `ok` path — the one where a
        // dropped rewrite would be invisible until Verify (#118).
        id: "AC-1",
        type: "CODE",
        statement: "the bare main ref is qualified before the command is persisted",
        threshold: { op: "contains", value: "origin" },
        evidenceMethod: { type: "command", command: "git log main..HEAD --oneline || echo none" },
      },
      {
        // Auto-fix path: grep exits 1 on zero matches.
        id: "AC-2",
        type: "CODE",
        statement: "the grep that matches nothing is wrapped so it exits zero",
        threshold: { op: "contains", value: "true" },
        evidenceMethod: { type: "grep", command: "grep 'NEVER_MATCH_THIS_xyzzy_235' /dev/null" },
      },
    ]);

    await runScopePreflightsAndPersist(state, sf, dir);

    const reading = JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation;
    expect(reading.verdict).toBe("PASS");

    const refFixed = reading.acs.find((a: any) => a.id === "AC-1");
    expect(refFixed.status).toBe("ok");
    expect(refFixed.autoFixed).toBe(true);
    expect(refFixed.originalCommand, "the original command was not persisted").toContain(
      "git log main..HEAD",
    );
    expect(refFixed.fixedCommand).toContain("origin/main..HEAD");

    const grepFixed = reading.acs.find((a: any) => a.id === "AC-2");
    expect(grepFixed.autoFixed).toBe(true);
    expect(grepFixed.originalCommand).toBe("grep 'NEVER_MATCH_THIS_xyzzy_235' /dev/null");
    expect(grepFixed.fixedCommand).toContain("|| true");

    const parsed = EvidencePrevalidationSchema.safeParse(reading);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  }, 30000);
});

describe("#235: EvidencePrevalidationSchema refuses readings nobody can act on", () => {
  const ok = {
    verdict: "PASS" as const,
    checkedAt: "2026-10-09T18:04:11.000Z",
    acs: [{ id: "AC-1", status: "ok" as const }],
    reason: null,
  };

  test("the happy reading is accepted", () => {
    expect(EvidencePrevalidationSchema.safeParse(ok).success).toBe(true);
  });

  test("FAIL must name a broken AC", () => {
    const r = EvidencePrevalidationSchema.safeParse({ ...ok, verdict: "FAIL" });
    expect(r.success).toBe(false);
  });

  test("PASS may not carry a broken AC", () => {
    const r = EvidencePrevalidationSchema.safeParse({
      ...ok,
      acs: [{ id: "AC-1", status: "broken", needsRewrite: true, diagnostic: "boom" }],
    });
    expect(r.success).toBe(false);
  });

  test("UNMEASURED must carry a reason", () => {
    expect(
      EvidencePrevalidationSchema.safeParse({ ...ok, verdict: "UNMEASURED", acs: [] }).success,
    ).toBe(false);
    expect(
      EvidencePrevalidationSchema.safeParse({
        ...ok,
        verdict: "UNMEASURED",
        acs: [],
        reason: "the pre-validator threw",
      }).success,
    ).toBe(true);
  });

  test("a measured verdict may not carry a reason", () => {
    const r = EvidencePrevalidationSchema.safeParse({ ...ok, reason: "why would a PASS explain itself" });
    expect(r.success).toBe(false);
  });

  test("an auto-fixed AC must carry both commands", () => {
    const halves = [
      { id: "AC-1", status: "ok", autoFixed: true, fixedCommand: "echo fixed" },
      { id: "AC-1", status: "ok", autoFixed: true, originalCommand: "echo original" },
    ];
    for (const ac of halves) {
      expect(EvidencePrevalidationSchema.safeParse({ ...ok, acs: [ac] }).success).toBe(false);
    }
    expect(
      EvidencePrevalidationSchema.safeParse({
        ...ok,
        acs: [{ id: "AC-1", status: "ok", autoFixed: true, originalCommand: "a", fixedCommand: "b" }],
      }).success,
    ).toBe(true);
  });

  test("the workflow state carries the reading, and absence is allowed", () => {
    const state = {
      schemaVersion: 2 as const,
      issue: 235,
      slug: "s",
      phase: "SCOPE" as const,
      issueGoal: "g",
      acs: [],
    };
    expect(WorkflowStateSchema.safeParse(state).success).toBe(true);
    expect(WorkflowStateSchema.safeParse({ ...state, evidencePrevalidation: ok }).success).toBe(true);
    expect(
      WorkflowStateSchema.safeParse({ ...state, evidencePrevalidation: { verdict: "PASS" } }).success,
    ).toBe(false);
  });
});

describe("#235: measureEvidencePrevalidation never throws", () => {
  test("a runner that rejects produces UNMEASURED carrying the message", async () => {
    const reading = await measureEvidencePrevalidation([{ id: "AC-1" }], "/tmp", async () => {
      throw new Error("prevalidator exploded");
    });
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.reason).toContain("prevalidator exploded");
    expect(reading.acs).toEqual([]);
  });

  test("no ACs is UNMEASURED, not PASS", async () => {
    const reading = await measureEvidencePrevalidation([], "/tmp");
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.reason).toBeTruthy();
  });
});

describe("#235: SCHEMA-GUIDE.md and the schema describe the same reading", () => {
  const guide = readFileSync(join(import.meta.dir, "..", "..", "gates", "SCHEMA-GUIDE.md"), "utf-8");

  /**
   * The field names in the FIRST table under `## evidencePrevalidation`.
   *
   * Bounded to that table on purpose: the section carries two more (the three
   * verdicts, and the per-AC entry fields), and sweeping up every backticked
   * cell in the section would make this list grow with the prose instead of
   * with the schema.
   */
  const documented = (() => {
    const start = guide.indexOf("## evidencePrevalidation");
    if (start === -1) return [];
    const lines = guide.slice(start).split("\n");
    const fields: string[] = [];
    let inTable = false;
    for (const line of lines.slice(1)) {
      const isRow = line.startsWith("|");
      if (isRow) {
        inTable = true;
        const m = line.match(/^\|\s*`([^`]+)`/);
        if (m) fields.push(m[1]);
      } else if (inTable) {
        break;
      }
    }
    return fields;
  })();

  test("the guide has an evidencePrevalidation section with a field table", () => {
    expect(guide).toContain("## evidencePrevalidation");
    expect(documented.length, "no `field` rows found under ## evidencePrevalidation").toBeGreaterThan(0);
  });

  // Both directions: a field added to the schema and left undocumented turns
  // this red, and so does a field documented but never implemented.
  test("every schema field is documented and every documented field exists", () => {
    expect([...EVIDENCE_PREVALIDATION_FIELDS].sort()).toEqual([...documented].sort());
  });

  test("the guide states all three verdicts and that absence means unmeasured", () => {
    for (const verdict of ["PASS", "FAIL", "UNMEASURED"]) {
      expect(guide.slice(guide.indexOf("## evidencePrevalidation"))).toContain(verdict);
    }
    expect(guide).toMatch(/absent means UNMEASURED/i);
  });
});
