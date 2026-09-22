import { describe, test, expect } from "bun:test";
import { join } from "path";
import {
  gradeByRole,
  parseTranscript,
  auditAgent,
  formatReport,
  type ToolCall,
  type Role,
} from "../scripts/audit-transcript.js";
import { evaluateCriteria, getCriteria, ROLES, type TranscriptData } from "../lib/eval-criteria.js";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");

// ── gradeByRole accepts role parameter ──────────────────

describe("gradeByRole", () => {
  test("accepts 'da' role and applies DA-specific criteria", () => {
    const calls: ToolCall[] = [
      { name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 },
      { name: "Read", input: { file_path: "/project/PROJECT-STATE.md" }, order: 1 },
      { name: "Bash", input: { command: "bun test" }, order: 2 },
      { name: "Read", input: { file_path: "/project/specs/SOME-SPEC.md" }, order: 3 },
      { name: "Skill", input: { skill: "harness" }, order: 4 },
    ];
    const results = gradeByRole("da", calls, ["/project/AGENTS.md", "/project/PROJECT-STATE.md", "/project/specs/SOME-SPEC.md"], ["bun test"], [], [], {}, ["AGENTS.md", "PROJECT-STATE.md", "SOME-SPEC.md"]);

    // Should contain DA-specific criteria (DA-01, DA-02, etc.)
    const daIds = results.filter((r) => r.id.startsWith("DA-"));
    expect(daIds.length).toBeGreaterThanOrEqual(3);

    // Should contain shared criteria
    const sharedIds = results.filter((r) => r.id.startsWith("SHARED-"));
    expect(sharedIds.length).toBeGreaterThanOrEqual(3);
  });

  test("accepts 'marcus' role and applies Marcus-specific criteria", () => {
    const calls: ToolCall[] = [
      { name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 },
      { name: "Read", input: { file_path: "/project/PROJECT-STATE.md" }, order: 1 },
      { name: "Read", input: { file_path: "/project/prompts/coding-principles.md" }, order: 2 },
      { name: "Read", input: { file_path: "/project/specs/SPEC.md" }, order: 3 },
      { name: "Edit", input: { file_path: "/project/lib/foo.ts" }, order: 4 },
    ];
    const results = gradeByRole("marcus", calls,
      ["/project/AGENTS.md", "/project/PROJECT-STATE.md", "/project/prompts/coding-principles.md", "/project/specs/SPEC.md"],
      [], ["/project/lib/foo.ts"], [], {}, ["AGENTS.md", "PROJECT-STATE.md", "coding-principles.md"]);

    const marcusIds = results.filter((r) => r.id.startsWith("M-"));
    expect(marcusIds.length).toBeGreaterThanOrEqual(3);
  });

  test("accepts 'quinn' role and applies Quinn-specific criteria", () => {
    const calls: ToolCall[] = [
      { name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 },
      { name: "Read", input: { file_path: "/project/PROJECT-STATE.md" }, order: 1 },
      { name: "Bash", input: { command: "bun test" }, order: 2 },
      { name: "Bash", input: { command: "bunx tsc --noEmit" }, order: 3 },
    ];
    const results = gradeByRole("quinn", calls,
      ["/project/AGENTS.md", "/project/PROJECT-STATE.md"],
      ["bun test", "bunx tsc --noEmit"], [], [], {}, ["AGENTS.md", "PROJECT-STATE.md"]);

    const quinnIds = results.filter((r) => r.id.startsWith("Q-"));
    expect(quinnIds.length).toBeGreaterThanOrEqual(3);
  });
});

// ── FOLLOWED/IGNORED verdicts with evidence ─────────────

describe("verdict output", () => {
  test("results contain FOLLOWED verdict enum", () => {
    const calls: ToolCall[] = [
      { name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 },
    ];
    const results = gradeByRole("marcus", calls, ["/project/AGENTS.md"], [], [], [], {}, ["AGENTS.md"]);
    const followed = results.filter((r) => r.verdict === "FOLLOWED");
    expect(followed.length).toBeGreaterThan(0);
    for (const r of followed) {
      expect(r.evidence).toBeTruthy();
      expect(typeof r.evidence).toBe("string");
    }
  });

  test("results contain IGNORED verdict for violations", () => {
    // No AGENTS.md read in first 5 calls
    const calls: ToolCall[] = [
      { name: "Edit", input: { file_path: "/project/lib/foo.ts" }, order: 0 },
    ];
    const results = gradeByRole("marcus", calls, [], [], ["/project/lib/foo.ts"], [], {}, []);
    const ignored = results.filter((r) => r.verdict === "IGNORED");
    expect(ignored.length).toBeGreaterThan(0);
    for (const r of ignored) {
      expect(r.evidence).toBeTruthy();
    }
  });

  test("every result has id, rule, verdict, evidence, weight, source", () => {
    const calls: ToolCall[] = [
      { name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 },
    ];
    const results = gradeByRole("da", calls, ["/project/AGENTS.md"], [], [], [], {}, ["AGENTS.md"]);
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.rule).toBeTruthy();
      expect(["FOLLOWED", "IGNORED"]).toContain(r.verdict);
      expect(r.evidence).toBeTruthy();
      expect(typeof r.weight).toBe("number");
      expect(r.source).toBeTruthy();
    }
  });
});

// ── Shared eval criteria module ─────────────────────────

describe("eval-criteria module", () => {
  test("getCriteria returns criteria for all roles", () => {
    for (const role of ROLES) {
      const criteria = getCriteria(role);
      expect(criteria.length).toBeGreaterThan(0);
    }
  });

  test("evaluateCriteria returns CriterionResult array", () => {
    const data: TranscriptData = {
      calls: [{ name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 }],
      reads: ["/project/AGENTS.md"],
      bashes: [],
      edits: [],
      writes: [],
      duplicateReads: {},
      firstThreeReads: ["AGENTS.md"],
    };
    const results = evaluateCriteria("da", data);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(["FOLLOWED", "IGNORED"]).toContain(r.verdict);
    }
  });

  test("da criteria include DA-01 through DA-05", () => {
    const criteria = getCriteria("da");
    const daIds = criteria.filter((c) => c.id.startsWith("DA-")).map((c) => c.id);
    expect(daIds).toContain("DA-01");
    expect(daIds).toContain("DA-02");
    expect(daIds).toContain("DA-03");
    expect(daIds).toContain("DA-04");
    expect(daIds).toContain("DA-05");
  });

  test("marcus criteria include M-01 through M-06", () => {
    const criteria = getCriteria("marcus");
    const mIds = criteria.filter((c) => c.id.startsWith("M-")).map((c) => c.id);
    expect(mIds).toContain("M-01");
    expect(mIds).toContain("M-06");
  });

  test("quinn criteria include Q-01 through Q-05", () => {
    const criteria = getCriteria("quinn");
    const qIds = criteria.filter((c) => c.id.startsWith("Q-")).map((c) => c.id);
    expect(qIds).toContain("Q-01");
    expect(qIds).toContain("Q-05");
  });
});

// ── Fixture-based integration tests ─────────────────────

describe("fixture transcript audit", () => {
  test("DA transcript audits with DA role criteria", () => {
    const audit = auditAgent(join(FIXTURES, "agent-da-session1.jsonl"));
    expect(audit.role).toBe("da");
    expect(audit.rules.some((r) => r.id.startsWith("DA-"))).toBe(true);
    expect(audit.score).toBeGreaterThanOrEqual(0);
    expect(["A", "B", "C", "D", "F"]).toContain(audit.grade);
  });

  test("Marcus transcript audits with Marcus role criteria", () => {
    const audit = auditAgent(join(FIXTURES, "agent-marcus-impl1.jsonl"));
    expect(audit.role).toBe("marcus");
    expect(audit.rules.some((r) => r.id.startsWith("M-"))).toBe(true);
  });

  test("Quinn transcript audits with Quinn role criteria", () => {
    const audit = auditAgent(join(FIXTURES, "agent-quinn-validate1.jsonl"));
    expect(audit.role).toBe("quinn");
    expect(audit.rules.some((r) => r.id.startsWith("Q-"))).toBe(true);
  });

  test("role override works", () => {
    const audit = auditAgent(join(FIXTURES, "agent-marcus-impl1.jsonl"), "da");
    expect(audit.role).toBe("da");
    expect(audit.rules.some((r) => r.id.startsWith("DA-"))).toBe(true);
  });

  test("formatReport includes role and verdict columns", () => {
    const audits = [
      auditAgent(join(FIXTURES, "agent-da-session1.jsonl")),
      auditAgent(join(FIXTURES, "agent-marcus-impl1.jsonl")),
    ];
    const report = formatReport(audits);
    expect(report).toContain("Verdict");
    expect(report).toContain("[da]");
    expect(report).toContain("[marcus]");
  });
});

// ── audit-transcript imports shared criteria ────────────

describe("shared criteria import", () => {
  test("gradeByRole is exported from audit-transcript", () => {
    expect(typeof gradeByRole).toBe("function");
  });

  test("gradeByRole returns CriterionResult with id and source", () => {
    const calls: ToolCall[] = [
      { name: "Read", input: { file_path: "/project/AGENTS.md" }, order: 0 },
    ];
    const results = gradeByRole("marcus", calls, ["/project/AGENTS.md"], [], [], [], {}, ["AGENTS.md"]);
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.source).toBeTruthy();
    }
  });
});
