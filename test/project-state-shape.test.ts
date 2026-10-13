/**
 * The renderer crashed instead of refusing, which is the same problem from
 * the other side.
 *
 * `scripts/update-project-state.ts` declares
 * `interface Session { date: string; items: string[] }`, and that interface
 * is erased at runtime: the file is `JSON.parse`d into it and nothing checks.
 * An archived session carrying `summary` instead of `items` produced
 *
 *     TypeError: undefined is not an object (evaluating 'session.items.forEach')
 *       at render (scripts/update-project-state.ts:134:15)
 *
 * and nothing else — no path into the document, no index, no statement of
 * what should have been there. The renderer runs from a pre-commit hook,
 * where a stack trace pointing into a script the committer never opened is
 * close to no message at all.
 *
 * A fail-open reports success it did not earn. This reported a failure
 * nobody could act on. Both leave a reader who cannot tell what happened,
 * and the second is the one that teaches people to re-run and hope.
 *
 * Covers SC-778..779 of HARNESS-STANDARD.md. (Not specs/PROJECT-STATE.md,
 * which `.claude/rules/specs-routing.md` marks non-testable; the renderer is
 * harness tooling and its criteria belong with the rest of it.)
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { projectStateViolations } from "../lib/project-state-shape";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "update-project-state.ts");

/** A document the renderer is happy with. */
function good() {
  return {
    updated: "2026-10-12",
    priorities: ["a"],
    phases: [{ name: "Phase 0", scs: [{ id: "SC-1", done: true }] }],
    sessions: [{ date: "2026-10-01", items: ["did a thing"] }],
  };
}

describe("#project-state: the shape is checked before the renderer reads it", () => {
  test("a well-formed document has no violations", () => {
    // The control. Without it a validator that rejected everything would
    // satisfy every case below and block every commit.
    expect(projectStateViolations(good())).toEqual([]);
  });

  test("this repo's own project-state.json passes", () => {
    const doc = JSON.parse(readFileSync(join(REPO, "project-state.json"), "utf-8"));
    expect(projectStateViolations(doc)).toEqual([]);
  });

  test("the exact edit that crashed the renderer is named, not thrown", () => {
    const doc = good() as any;
    doc.sessions.push({ date: "2026-10-12", summary: "wrote summary instead of items" });
    const v = projectStateViolations(doc);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("sessions[1].items");
    // The path, and the fix. A message saying only "invalid" costs the same
    // round-trip the stack trace did.
    expect(v[0]).toContain("summary");
    expect(v[0]).toContain("items");
  });

  test("every problem is reported, not just the first", () => {
    // A writer fixing a hand-edited file wants the whole list. Stopping at
    // the first finding turns one bad edit into four round-trips, which is
    // how a validator becomes something people route around.
    const doc = good() as any;
    doc.sessions.push({ date: "", summary: "x" });
    doc.sessions.push({ items: ["y"] });
    doc.phases.push({ scs: [] });
    const v = projectStateViolations(doc);
    expect(v.length).toBeGreaterThanOrEqual(4);
    expect(v.join("\n")).toContain("sessions[1].date");
    expect(v.join("\n")).toContain("sessions[1].items");
    expect(v.join("\n")).toContain("sessions[2].date");
    expect(v.join("\n")).toContain("phases[1].name");
  });

  test("a missing required key is a violation, not a default", () => {
    for (const key of ["updated", "priorities", "phases", "sessions"]) {
      const doc = good() as any;
      delete doc[key];
      expect(projectStateViolations(doc).join("\n"), key).toContain(key);
    }
  });

  test("a non-object document is refused rather than indexed into", () => {
    expect(projectStateViolations(null)[0]).toContain("object");
    expect(projectStateViolations([])[0]).toContain("array");
    expect(projectStateViolations("{}")[0]).toContain("string");
  });

  test("an items array holding a non-string is caught", () => {
    const doc = good() as any;
    doc.sessions[0].items = ["ok", 42];
    expect(projectStateViolations(doc).join("\n")).toContain("sessions[0].items[1]");
  });
});

describe("#project-state: the script refuses rather than crashing", () => {
  test("the validator is consulted before anything is written", () => {
    // Wiring. The library can be perfect and the script can still parse
    // straight into the renderer — #194's lesson, and #168's.
    const src = readFileSync(SCRIPT, "utf-8");
    const checkAt = src.indexOf("projectStateViolations(parsed)");
    // The CALL, not the import. `src.indexOf("writeFileSync")` finds the
    // import line at the top of the file, which precedes everything and
    // makes this assertion unsatisfiable rather than merely wrong — the kind
    // of mistake that gets "fixed" by loosening the comparison.
    const writes = [...src.matchAll(/writeFileSync\(\s*STATE_(?:MD|JSON)/g)].map(m => m.index!);
    expect(checkAt).toBeGreaterThan(-1);
    expect(writes.length).toBeGreaterThan(0);
    for (const at of writes) expect(checkAt).toBeLessThan(at);
    expect(src).toContain("nothing was written");
  });

  /**
   * Order is not prevention.
   *
   * The case above asserts the validator is consulted before the write, and
   * making the refusal branch unreachable (`if (false)`) scored **0 red** —
   * the check ran first and then the script wrote anyway. So the script is
   * copied somewhere it can be pointed at a bad document and actually run.
   */
  function runScriptOn(state: unknown): { status: number; out: string; wroteMd: boolean } {
    const dir = mkdtempSync(join(tmpdir(), "ps-script-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "specs"));
      symlinkSync(join(REPO, "lib"), join(dir, "lib"));
      symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
      cpSync(SCRIPT, join(dir, "scripts", "update-project-state.ts"));
      writeFileSync(join(dir, "project-state.json"), JSON.stringify(state));
      const r = spawnSync("bun", [join(dir, "scripts", "update-project-state.ts")], {
        cwd: dir,
        encoding: "utf-8",
      });
      return {
        status: r.status ?? 1,
        out: (r.stdout ?? "") + (r.stderr ?? ""),
        wroteMd: existsSync(join(dir, "PROJECT-STATE.md")),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a malformed document exits non-zero and writes no markdown at all", () => {
    const bad = good() as any;
    bad.sessions.push({ date: "2026-10-12", summary: "the edit that crashed it" });
    const r = runScriptOn(bad);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("sessions[1].items");
    expect(r.out).toContain("nothing was written");
    // The assertion the ordering check could not make.
    expect(r.wroteMd).toBe(false);
  });

  test("a well-formed document is written — the control", () => {
    // Without this, refusing unconditionally would satisfy the case above
    // and the renderer would never produce anything again.
    const r = runScriptOn(good());
    expect(r.status, r.out).toBe(0);
    expect(r.wroteMd).toBe(true);
  });

  test("invalid JSON refuses rather than throwing a parse trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-script-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "specs"));
      symlinkSync(join(REPO, "lib"), join(dir, "lib"));
      symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
      cpSync(SCRIPT, join(dir, "scripts", "update-project-state.ts"));
      writeFileSync(join(dir, "project-state.json"), "{ not json");
      const r = spawnSync("bun", [join(dir, "scripts", "update-project-state.ts")], { cwd: dir, encoding: "utf-8" });
      expect(r.status).not.toBe(0);
      expect((r.stdout ?? "") + (r.stderr ?? "")).toContain("not valid JSON");
      expect(existsSync(join(dir, "PROJECT-STATE.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every refusal routes through one exported exit constant", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // One declaration, and no bare `process.exit(1)` alongside it — a second
    // refusal path would survive a mutation of the constant and the mutant
    // would stay red for a reason unrelated to the mutation working.
    expect(src.match(/export const PROJECT_STATE_REFUSE_EXIT = \d+/g)!.length).toBe(1);
    expect(src.match(/process\.exit\(PROJECT_STATE_REFUSE_EXIT\)/g)!.length).toBe(2);
    expect(src).not.toMatch(/process\.exit\(1\)/);
  });
});
