import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const STATE_JSON = join(ROOT, "project-state.json");
const STATE_MD = join(ROOT, "PROJECT-STATE.md");
const SPECS_DIR = join(ROOT, "specs");

let originalJson: string;
let originalMd: string;

describe("update-project-state", () => {
  beforeAll(() => {
    originalJson = readFileSync(STATE_JSON, "utf-8");
    originalMd = existsSync(STATE_MD) ? readFileSync(STATE_MD, "utf-8") : "";
  });

  afterAll(() => {
    writeFileSync(STATE_JSON, originalJson);
    if (originalMd) writeFileSync(STATE_MD, originalMd);
    for (const f of ["test-spec.md", "test-promote.md"]) {
      const p = join(SPECS_DIR, f);
      if (existsSync(p)) rmSync(p);
    }
  });

  function writeTestJson(state: any) {
    writeFileSync(STATE_JSON, JSON.stringify(state, null, 2));
  }

  function run() {
    execSync("bun scripts/update-project-state.ts", { cwd: ROOT, timeout: 10000 });
    return readFileSync(STATE_MD, "utf-8");
  }

  test("script exists", () => {
    expect(existsSync(join(ROOT, "scripts/update-project-state.ts"))).toBe(true);
  });

  test("runs fast (under 2s)", () => {
    const start = Date.now();
    run();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("generates markdown from JSON", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: ["Do the thing"],
      phases: [{ name: "Phase 0 — Test", scs: [
        { id: "SC-900", what: "Test SC", done: true }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("# Project State");
    expect(md).toContain("| ✅ | SC-900 | Test SC |");
    expect(md).toContain("Do the thing");
  });

  test("phase emoji: all done = ✅", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0 — Done", scs: [
        { id: "SC-900", what: "A", done: true },
        { id: "SC-901", what: "B", done: true }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## ✅ Phase 0 — Done (COMPLETE)");
  });

  test("phase emoji: some done = 🔄", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0 — Mixed", scs: [
        { id: "SC-900", what: "A", done: true },
        { id: "SC-901", what: "B", done: false }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## 🔄 Phase 0 — Mixed (IN PROGRESS)");
  });

  test("phase emoji: none done = ⬜", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 1 — Empty", scs: [
        { id: "SC-900", what: "A", done: false }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("## ⬜ Phase 1 — Empty (NOT STARTED)");
  });

  test("current phase = first phase with open SCs", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [
        { name: "Phase 0 — Done", scs: [{ id: "SC-900", what: "A", done: true }] },
        { name: "Phase 1 — Next", scs: [
          { id: "SC-901", what: "B", done: false },
          { id: "SC-902", what: "C", done: false }
        ]}
      ],
      sessions: []
    });
    const md = run();
    expect(md).toContain("**Current phase: Phase 1 — Next — 2 SCs open**");
  });

  test("promote-only: spec [x] promotes SC, spec [ ] does not demote", () => {
    writeFileSync(join(SPECS_DIR, "test-promote.md"), `- [x] SC-900: promoted\n- [ ] SC-901: still open in spec`);
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0", scs: [
        { id: "SC-900", what: "Should promote", done: false },
        { id: "SC-901", what: "Should stay done", done: true }
      ]}],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    const scs = json.phases[0].scs;
    expect(scs.find((s: any) => s.id === "SC-900").done).toBe(true);
    expect(scs.find((s: any) => s.id === "SC-901").done).toBe(true);
    rmSync(join(SPECS_DIR, "test-promote.md"));
  });

  test("is idempotent", () => {
    const first = run();
    const second = run();
    expect(first).toBe(second);
  });

  test("sessions capped at 3", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [],
      sessions: [
        { date: "Day 1", items: ["a"] },
        { date: "Day 2", items: ["b"] },
        { date: "Day 3", items: ["c"] },
        { date: "Day 4", items: ["d"] },
        { date: "Day 5", items: ["e"] }
      ]
    });
    const md = run();
    expect(md).toContain("Day 1");
    expect(md).toContain("Day 3");
    expect(md).not.toContain("Day 4");
  });

  test("updates SC count in notes after sync", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      notes: "Session 11 — stuff happened.\nSuite: 1264 pass, 0 fail. 28/56 SCs done.\nMore stuff.",
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-900", what: "A", done: true },
          { id: "SC-901", what: "B", done: true },
          { id: "SC-902", what: "C", done: false }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    // After sync, notes should say 2/3 SCs done (two done out of three)
    expect(json.notes).toContain("2/3 SCs done");
    expect(json.notes).not.toContain("28/56 SCs done");
    // Preserve surrounding text
    expect(json.notes).toContain("Session 11");
    expect(json.notes).toContain("More stuff.");
  });

  test("appends SC count to notes when no pattern exists", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      notes: "Session 11 — no counts here.",
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-900", what: "A", done: true },
          { id: "SC-901", what: "B", done: false }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    expect(json.notes).toContain("Suite:");
    expect(json.notes).toContain("1/2 SCs done");
    // Original text preserved
    expect(json.notes).toContain("Session 11 — no counts here.");
  });

  test("appends SC count when notes field is absent", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-900", what: "A", done: true }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    expect(json.notes).toContain("Suite:");
    expect(json.notes).toContain("1/1 SCs done");
  });

  test("exits cleanly when project-state.json missing", () => {
    const backup = readFileSync(STATE_JSON, "utf-8");
    rmSync(STATE_JSON);
    try {
      const output = execSync("bun scripts/update-project-state.ts", {
        cwd: ROOT, encoding: "utf-8", timeout: 5000
      });
      expect(output).toContain("not found");
    } finally {
      writeFileSync(STATE_JSON, backup);
    }
  });
});
