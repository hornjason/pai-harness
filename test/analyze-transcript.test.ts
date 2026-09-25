import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");
const SCRIPT = join(import.meta.dir, "..", "scripts", "analyze-transcript.ts");

// ── AC-1: Context growth profile ──────────────────────────

describe("AC-1: context growth profile", () => {
  test("JSON output includes startTokens, endTokens, growthRatio, and turns for each agent", async () => {
    const proc = Bun.spawnSync(["bun", SCRIPT, FIXTURES, "--all", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString();
    const analyses = JSON.parse(output);
    expect(analyses.length).toBeGreaterThan(0);
    for (const a of analyses) {
      expect(a.context).toBeDefined();
      expect(typeof a.context.startTokens).toBe("number");
      expect(typeof a.context.endTokens).toBe("number");
      expect(typeof a.context.growthRatio).toBe("number");
      expect(typeof a.context.turns).toBe("number");
    }
  });

  test("growthRatio appears >= 3 times in JSON output", async () => {
    const proc = Bun.spawnSync(["bun", SCRIPT, FIXTURES, "--all", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString();
    const matches = (output.match(/growthRatio/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(3);
  });
});

// ── AC-2: Context efficiency score ────────────────────────

describe("AC-2: context efficiency score", () => {
  test("ratio computed as filesChanged / filesRead", async () => {
    const proc = Bun.spawnSync(["bun", SCRIPT, FIXTURES, "--all", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString();
    const analyses = JSON.parse(output);
    for (const a of analyses) {
      expect(a.efficiency).toBeDefined();
      expect(typeof a.efficiency.ratio).toBe("number");
      expect(Array.isArray(a.efficiency.filesRead)).toBe(true);
      expect(Array.isArray(a.efficiency.filesChanged)).toBe(true);
    }
  });

  test("ratio appears >= 3 times in JSON output", async () => {
    const proc = Bun.spawnSync(["bun", SCRIPT, FIXTURES, "--all", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString();
    const matches = (output.match(/"ratio"/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(3);
  });
});

// ── AC-3: Tool efficiency tracking ───────────────────────

describe("AC-3: tool efficiency tracking", () => {
  test("duplicateReads, bashInsteadOfRead, and deliverableRatio present in output", async () => {
    const proc = Bun.spawnSync(["bun", SCRIPT, FIXTURES, "--all", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString();
    const analyses = JSON.parse(output);
    for (const a of analyses) {
      expect(a).toHaveProperty("duplicateReads");
      expect(a).toHaveProperty("bashInsteadOfRead");
      expect(typeof a.deliverableRatio).toBe("number");
    }
  });

  test(">= 5 references to duplicateReads/bashInsteadOfRead/deliverableRatio in source", async () => {
    const source = readFileSync(SCRIPT, "utf-8");
    const matches = (source.match(/duplicateReads|bashInsteadOfRead|deliverableRatio/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(5);
  });
});

// ── AC-4: writes transcript-analysis.json ─────────────────

describe("AC-4: writes transcript-analysis.json", () => {
  const tmpDir = join(import.meta.dir, "fixtures", "tmp-analyze-output");

  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("writes transcript-analysis.json to specified work directory with --output flag", async () => {
    const proc = Bun.spawnSync(
      ["bun", SCRIPT, FIXTURES, "--all", "--json", "--output", tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const outputFile = join(tmpDir, "transcript-analysis.json");
    expect(existsSync(outputFile)).toBe(true);

    const content = JSON.parse(readFileSync(outputFile, "utf-8"));
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    // Should have the same structure as JSON stdout output
    expect(content[0]).toHaveProperty("agent");
    expect(content[0]).toHaveProperty("efficiency");
    expect(content[0]).toHaveProperty("context");
  });

  test("written file matches stdout JSON output", async () => {
    const proc = Bun.spawnSync(
      ["bun", SCRIPT, FIXTURES, "--all", "--json", "--output", tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const outputFile = join(tmpDir, "transcript-analysis.json");
    const fileContent = JSON.parse(readFileSync(outputFile, "utf-8"));
    const stdoutContent = JSON.parse(proc.stdout.toString());
    expect(fileContent).toEqual(stdoutContent);
  });
});

// ── AC-5: grade output includes efficiency metrics ────────

describe("AC-5: grade output includes efficiency", () => {
  const tmpDir = join(import.meta.dir, "fixtures", "tmp-grade-output");
  const GRADE_SCRIPT = join(import.meta.dir, "..", "scripts", "grade-deterministic.ts");

  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("compliance-grade.json includes efficiency field per graded agent", async () => {
    const proc = Bun.spawnSync(
      ["bun", GRADE_SCRIPT, "--transcripts", FIXTURES, tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const gradeFile = join(tmpDir, "compliance-grade.json");
    expect(existsSync(gradeFile)).toBe(true);

    const gradeOutput = JSON.parse(readFileSync(gradeFile, "utf-8"));
    expect(gradeOutput.grades.length).toBeGreaterThan(0);

    // Each grade should have an efficiency field from analyze-transcript
    for (const grade of gradeOutput.grades) {
      expect(grade).toHaveProperty("efficiency");
      expect(typeof grade.efficiency.ratio).toBe("number");
      expect(typeof grade.efficiency.deliverableRatio).toBe("number");
      expect(typeof grade.efficiency.contextGrowthRatio).toBe("number");
      expect(typeof grade.efficiency.duplicateReads).toBe("number");
    }
  });
});

// ── AC-6: grade output includes timing ──────────────────────────

describe("AC-6: grade output includes timing", () => {
  const tmpDir = join(import.meta.dir, "fixtures", "tmp-grade-timing");
  const GRADE_SCRIPT = join(import.meta.dir, "..", "scripts", "grade-deterministic.ts");

  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("compliance-grade.json includes timing field with role and durationSeconds per agent", async () => {
    const proc = Bun.spawnSync(
      ["bun", GRADE_SCRIPT, "--transcripts", FIXTURES, tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const gradeFile = join(tmpDir, "compliance-grade.json");
    expect(existsSync(gradeFile)).toBe(true);
    const gradeOutput = JSON.parse(readFileSync(gradeFile, "utf-8"));
    expect(gradeOutput).toHaveProperty("timing");
    expect(Array.isArray(gradeOutput.timing)).toBe(true);
    expect(gradeOutput.timing.length).toBeGreaterThan(0);
    for (const entry of gradeOutput.timing) {
      expect(typeof entry.role).toBe("string");
      expect(typeof entry.durationSeconds).toBe("number");
      expect(entry.durationSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  test("timing entries match graded agent roles", async () => {
    const proc = Bun.spawnSync(
      ["bun", GRADE_SCRIPT, "--transcripts", FIXTURES, tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const gradeFile = join(tmpDir, "compliance-grade.json");
    const gradeOutput = JSON.parse(readFileSync(gradeFile, "utf-8"));
    const gradeRoles = gradeOutput.grades.map((g: any) => g.role);
    const timingRoles = gradeOutput.timing.map((t: any) => t.role);
    expect(timingRoles).toEqual(gradeRoles);
  });
});
