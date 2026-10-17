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
        { id: "SC-9441", what: "Test SC", done: true }
      ]}],
      sessions: []
    });
    const md = run();
    expect(md).toContain("# Project State");
    expect(md).toContain("| ✅ | SC-9441 | Test SC |");
    expect(md).toContain("Do the thing");
  });

  test("phase emoji: all done = ✅", () => {
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0 — Done", scs: [
        { id: "SC-9441", what: "A", done: true },
        { id: "SC-9442", what: "B", done: true }
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
        { id: "SC-9441", what: "A", done: true },
        { id: "SC-9442", what: "B", done: false }
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
        { id: "SC-9441", what: "A", done: false }
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
        { name: "Phase 0 — Done", scs: [{ id: "SC-9441", what: "A", done: true }] },
        { name: "Phase 1 — Next", scs: [
          { id: "SC-9442", what: "B", done: false },
          { id: "SC-9443", what: "C", done: false }
        ]}
      ],
      sessions: []
    });
    const md = run();
    expect(md).toContain("**Current phase: Phase 1 — Next — 2 SCs open**");
  });

  test("promote-only: spec [x] promotes SC, spec [ ] does not demote", () => {
    writeFileSync(join(SPECS_DIR, "test-promote.md"), `- [x] SC-9441: promoted\n- [ ] SC-9442: still open in spec`);
    writeTestJson({
      updated: "2026-01-01", priorities: [],
      phases: [{ name: "Phase 0", scs: [
        { id: "SC-9441", what: "Should promote", done: false },
        { id: "SC-9442", what: "Should stay done", done: true }
      ]}],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    const scs = json.phases[0].scs;
    expect(scs.find((s: any) => s.id === "SC-9441").done).toBe(true);
    expect(scs.find((s: any) => s.id === "SC-9442").done).toBe(true);
    rmSync(join(SPECS_DIR, "test-promote.md"));
  });

  test("is idempotent", () => {
    const first = run();
    const second = run();
    expect(first).toBe(second);
  });

  // Was "sessions capped at 3" asserting Day 1 and Day 3 present and Day 4
  // absent — the three OLDEST. That is the behaviour that made PROJECT-STATE.md
  // show ancient history while every appended session stayed invisible, and the
  // test locked it in. Inverted rather than deleted: the cap is still 3, but it
  // must be the three most recent, because this file is the session handoff
  // AGENTS.md tells the next session to read first.
  test("sessions capped at 3, newest first", () => {
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
    expect(md).toContain("Day 5");
    expect(md).toContain("Day 4");
    expect(md).toContain("Day 3");
    expect(md).not.toContain("Day 2");
    expect(md).not.toContain("Day 1");
    // Newest must lead, not merely be present.
    expect(md.indexOf("Day 5")).toBeLessThan(md.indexOf("Day 3"));
  });

  test("updates SC count in notes after sync", () => {
    writeTestJson({
      updated: "2026-01-01",
      priorities: [],
      notes: "Session 11 — stuff happened.\nSuite: 1264 pass, 0 fail. 28/56 SCs done.\nMore stuff.",
      phases: [
        { name: "Phase 0", scs: [
          { id: "SC-9441", what: "A", done: true },
          { id: "SC-9442", what: "B", done: true },
          { id: "SC-9443", what: "C", done: false }
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
          { id: "SC-9441", what: "A", done: true },
          { id: "SC-9442", what: "B", done: false }
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
          { id: "SC-9441", what: "A", done: true }
        ]}
      ],
      sessions: []
    });
    run();
    const json = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
    expect(json.notes).toContain("Suite:");
    expect(json.notes).toContain("1/1 SCs done");
  });

  test("refuses when project-state.json is missing but PROJECT-STATE.md is not (#354)", () => {
    // This used to assert a clean exit and the words "not found", which was
    // the behaviour #354 changed. A project with no state file and a project
    // that LOST one exited 0 with the same line — and in this repo, where a
    // pre-commit hook renders the artifact every commit and AGENTS.md tells
    // the next session to read it first, the second case meant the hook had
    // quietly stopped maintaining a file people are told to trust, while
    // saying "skipping".
    //
    // The distinction is the presence of the rendered output, so deleting
    // the source here — with PROJECT-STATE.md still on disk — is now the
    // refusing case. The skip case has no markdown either, and is covered in
    // test/project-state-shape.test.ts against a temp directory rather than
    // by deleting two tracked files out of the working tree.
    const backup = readFileSync(STATE_JSON, "utf-8");
    rmSync(STATE_JSON);
    try {
      let status = 0;
      let output = "";
      try {
        output = execSync("bun scripts/update-project-state.ts 2>&1", {
          cwd: ROOT, encoding: "utf-8", timeout: 5000
        });
      } catch (e: any) {
        status = e.status ?? 1;
        output = e.stdout ?? "";
      }
      expect(status).not.toBe(0);
      expect(output).toContain("outlived its source");
    } finally {
      writeFileSync(STATE_JSON, backup);
    }
  });

  // ── #572: the handoff shows the newest sessions, wherever they were written ──

  /**
   * Every fixture here plants the newest entry at `sessions[0]`, which is
   * where the DA actually wrote session 48 and where the old renderer could
   * not see it. A fixture that appends instead passes under the bug, which
   * is the whole reason this one does not.
   */
  function withSessions(sessions: Array<{ date: string; items: string[] }>) {
    writeTestJson({
      updated: "2026-01-01",
      notes: "",
      priorities: [],
      phases: [],
      sessions,
    });
    return run();
  }

  test("SC-1960: the newest session is rendered from the FRONT of the array", () => {
    const md = withSessions([
      { date: "2026-10-17 session 48", items: ["the newest, written first in the array"] },
      { date: "2026-10-01 session 40", items: ["older"] },
      { date: "2026-10-02 session 41", items: ["older still, but later in the array"] },
    ]);
    expect(md, "the newest session did not reach the handoff").toContain("the newest, written first in the array");

    // And it is FIRST, because the file is read top-down by the next
    // session and a correct entry buried under two older ones is the same
    // failure one step smaller.
    expect(md.indexOf("session 48")).toBeLessThan(md.indexOf("session 41"));
    expect(md.indexOf("session 41")).toBeLessThan(md.indexOf("session 40"));
  });

  test("SC-1961: the position in the array decides nothing", () => {
    // The same three entries in three orders must render identically. The
    // old renderer gives three different answers, and only one of them is
    // right — which is what "it just trusted a position" means.
    const entries = [
      { date: "2026-10-17 newest", items: ["c"] },
      { date: "2026-10-02 middle", items: ["b"] },
      { date: "2026-10-01 oldest", items: ["a"] },
    ];
    const a = withSessions([entries[0]!, entries[1]!, entries[2]!]);
    const b = withSessions([entries[2]!, entries[1]!, entries[0]!]);
    const c = withSessions([entries[1]!, entries[0]!, entries[2]!]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // …and the agreement is not three empty renders.
    expect(a).toContain("newest");
  });

  test("SC-1962: a fourth, older session is dropped and an undated one is named", () => {
    const md = withSessions([
      { date: "2026-10-17 d", items: ["d"] },
      { date: "2026-10-16 c", items: ["c"] },
      { date: "2026-10-15 b", items: ["b"] },
      { date: "2026-10-14 a", items: ["a"] },
    ]);
    expect(md).toContain("2026-10-15 b");
    expect(md, "the fourth-newest session was rendered, so the limit does nothing").not.toContain("2026-10-14 a");

    // An entry with no ISO date cannot be ordered, so it is never rendered.
    // Silence would make it indistinguishable from one that is merely old,
    // so the run says so by name.
    writeTestJson({
      updated: "2026-01-01",
      notes: "",
      priorities: [],
      phases: [],
      sessions: [
        { date: "someday", items: ["unorderable"] },
        { date: "2026-10-17 d", items: ["d"] },
      ],
    });
    const out = execSync("bun scripts/update-project-state.ts 2>&1", { cwd: ROOT, encoding: "utf-8", timeout: 10000 });
    expect(out, "an unorderable entry was ranked without saying so").toContain("someday");
    expect(out).toContain("no ISO date");

    // Ranked below the dated entry, NOT dropped. A project whose dates are
    // all free-form must still get a handoff — excluding them would mean
    // fixing this bug by producing an empty file, which is worse than the
    // bug. Its position is the only thing that changes.
    const md2 = readFileSync(STATE_MD, "utf-8");
    expect(md2).toContain("unorderable");
    expect(md2.indexOf("2026-10-17 d")).toBeLessThan(md2.indexOf("someday"));
  });

  test("SC-1963: the run names the sessions it rendered, not just that it wrote", () => {
    // `rewrote PROJECT-STATE.md` was true on every run that dropped session
    // 48. A reader who sees yesterday's date in this line knows at once.
    writeTestJson({
      updated: "2026-01-01",
      notes: "",
      priorities: [],
      phases: [],
      sessions: [{ date: "2026-10-17 session 48", items: ["x"] }],
    });
    const out = execSync("bun scripts/update-project-state.ts 2>&1", { cwd: ROOT, encoding: "utf-8", timeout: 10000 });
    expect(out).toContain("rendered 1 of 1 session(s)");
    expect(out, "the summary does not say which session reached the file").toContain("2026-10-17");
  });
});
