/**
 * SC-to-behaviour binding.
 *
 * The conformity engine used to collect ONLY unchecked (`- [ ]`) SCs and then
 * run each one inside a `try { } catch { }` that swallowed the assertion. Both
 * halves of that are the same defect: a checked SC — the 261 criteria this
 * project reports as DONE — could not fail anything, and the unchecked ones it
 * did collect could not fail either. The suite reported 0 fail because nothing
 * it ran was allowed to go red.
 *
 * These tests pin the repaired contract:
 *   - extractSCs collects both checkbox states and records which it saw
 *   - a CHECKED SC runs as a real assertion and can turn the suite red
 *   - an UNCHECKED SC is `test.todo` — visible, not executed, never swallowed
 *
 * The binding tests run the engine in a scratch project via a child `bun test`
 * and read the real counts out of its output, rather than grepping
 * lib/conformity.ts for the absence of the word "catch". A source-text
 * assertion cannot distinguish "the try was removed" from "the try moved one
 * function up"; a child run that reports `1 fail` can.
 *
 * SPEC-REF: CONFIG-DRIVEN-TESTING-SPEC.md
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { extractSCs, isBehavioralSC, matchPattern } from "../lib/conformity";

const ROOT = join(import.meta.dir, "..");
const CONFORMITY = join(ROOT, "lib", "conformity.ts");

// ── AC-1: extractSCs records the checkbox state ──────────────────

describe("AC-1: extractSCs collects both checkbox states", () => {
  const content = [
    "---",
    "testable: true",
    "---",
    "",
    "- [x] SC-9001: done.md exists",
    "- [ ] SC-9002: todo.md exists",
    "- [X] SC-9003: uppercase.md exists",
  ].join("\n");

  test("collects checked SCs, not only unchecked ones", () => {
    const ids = extractSCs(content, "FIXTURE.md").map(sc => sc.id);
    expect(ids).toContain("SC-9001");
    expect(ids).toContain("SC-9002");
    expect(ids).toContain("SC-9003");
  });

  test("records checked: true for '- [x]'", () => {
    const sc = extractSCs(content, "FIXTURE.md").find(s => s.id === "SC-9001");
    expect(sc?.checked).toBe(true);
  });

  test("records checked: false for '- [ ]'", () => {
    const sc = extractSCs(content, "FIXTURE.md").find(s => s.id === "SC-9002");
    expect(sc?.checked).toBe(false);
  });

  test("treats '- [X]' the same as '- [x]'", () => {
    const sc = extractSCs(content, "FIXTURE.md").find(s => s.id === "SC-9003");
    expect(sc?.checked).toBe(true);
  });

  test("statement excludes the checkbox marker", () => {
    const sc = extractSCs(content, "FIXTURE.md").find(s => s.id === "SC-9001");
    expect(sc?.statement).toBe("done.md exists");
  });
});

// ── AC-3: a checked SC can turn the suite red ────────────────────

interface ChildCounts {
  pass: number;
  fail: number;
  todo: number;
  output: string;
}

/**
 * Build a scratch project containing `specBody` and run the spec-driven half
 * of the conformity engine against it in a child `bun test`.
 */
function runEngineOn(specBody: string, files: Record<string, string> = {}): ChildCounts {
  const dir = mkdtempSync(join(tmpdir(), "sc-binding-"));
  try {
    mkdirSync(join(dir, "specs"), { recursive: true });
    writeFileSync(
      join(dir, "specs", "FIXTURE-SPEC.md"),
      ["---", "doc-type: spec", "testable: true", "compliance: strict", "---", "", "# Fixture", "", specBody, ""].join("\n"),
    );
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);

    const entry = join(dir, "engine.test.ts");
    writeFileSync(
      entry,
      [
        `import { runSpecConformityTests } from ${JSON.stringify(CONFORMITY)};`,
        `runSpecConformityTests(${JSON.stringify(dir)});`,
        "",
      ].join("\n"),
    );

    const res = spawnSync("bun", ["test", entry], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, CI: "1" },
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const num = (label: string) => {
      const m = output.match(new RegExp(`(\\d+)\\s+${label}`));
      return m ? parseInt(m[1], 10) : 0;
    };
    return { pass: num("pass"), fail: num("fail"), todo: num("todo"), output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AC-3: checked SCs run as real assertions", () => {
  // Positive control. If this one is not green, a `1 fail` below proves
  // nothing — the harness itself would be broken.
  test("a checked SC whose assertion holds passes", () => {
    const r = runEngineOn("- [x] SC-9101: PRESENT.md exists", { "PRESENT.md": "# present\n" });
    expect(r.fail).toBe(0);
    // Exactly one — the spec holds exactly one SC, so this pass is that SC
    // and not some unrelated check the engine happens to emit.
    expect(r.pass).toBe(1);
  });

  test("a checked SC whose assertion does NOT hold fails the run", () => {
    const r = runEngineOn("- [x] SC-9102: ABSENT-9102.md exists");
    expect(r.fail).toBe(1);
    expect(r.output).toContain("SC-9102");
  });

  test("an unchecked SC is reported todo, never a swallowed pass", () => {
    const r = runEngineOn("- [ ] SC-9103: ABSENT-9103.md exists");
    expect(r.fail).toBe(0);
    expect(r.pass).toBe(0);
    expect(r.todo).toBe(1);
  });

  test("checked and unchecked SCs in one spec are separated", () => {
    const r = runEngineOn(
      ["- [x] SC-9104: PRESENT.md exists", "- [x] SC-9105: ABSENT-9105.md exists", "- [ ] SC-9106: ABSENT-9106.md exists"].join("\n"),
      { "PRESENT.md": "# present\n" },
    );
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(1);
    expect(r.todo).toBe(1);
  });
});

// ── AC-5: the measure must not be weakened to go green ───────────

describe("AC-5: checked SC count does not regress", () => {
  const BASELINE = 261;

  test(`specs/ holds at least ${BASELINE} checked SCs`, () => {
    const specsDir = join(ROOT, "specs");
    let checked = 0;
    for (const f of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(specsDir, f), "utf-8");
      checked += (content.match(/^- \[x\] SC-/gim) || []).length;
    }
    expect(checked).toBeGreaterThanOrEqual(BASELINE);
  });
});

// ── Ratchet: checked SCs with nothing mechanical behind them ─────

describe("unbound checked SCs ratchet", () => {
  // 54 checked SCs are phrased so that no matcher recognises them, so they
  // are reported (SC-UNBOUND findings) rather than executed. The number is
  // allowed to fall and not to rise: every new checked SC must either be
  // matchable or carry the (behavioral) tag. Lowering it means rewording a
  // spec line, not deleting it — AC-5 above guards the other direction.
  const CEILING = 54;

  test(`no more than ${CEILING} checked SCs lack a pattern matcher`, () => {
    const specsDir = join(ROOT, "specs");
    const unbound: string[] = [];
    for (const f of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(specsDir, f), "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm || !/^testable:\s*true\s*$/m.test(fm[1])) continue;
      for (const sc of extractSCs(content, f)) {
        if (!sc.checked || isBehavioralSC(sc)) continue;
        if (!matchPattern(sc)) unbound.push(`${f} ${sc.id}`);
      }
    }
    expect(unbound.length).toBeLessThanOrEqual(CEILING);
  });
});
