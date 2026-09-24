import { describe, test, expect } from "bun:test";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

describe("scan-stale-issues", () => {
  const { scanStaleIssues } = require("../scripts/scan-stale-issues");

  const tmpDir = join(import.meta.dir, ".tmp-scan-test");

  function setup(phases: any[]) {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "project-state.json"), JSON.stringify({ phases }));
  }

  function cleanup() {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }

  test("extracts issue numbers from phase names", () => {
    setup([
      { name: "Phase F (#550-#552)", scs: [{ id: "SC-1", done: true }] },
      { name: "Brief Compliance (#558)", scs: [{ id: "SC-2", done: false }] },
    ]);
    const result = scanStaleIssues({ projectRoot: tmpDir, dryRun: true, repo: "test/repo" });
    expect(result.scanned).toBe(2);
    cleanup();
  });

  test("skips phases with incomplete SCs", () => {
    setup([
      { name: "Done (#100)", scs: [{ id: "SC-1", done: true }] },
      { name: "Partial (#200)", scs: [{ id: "SC-2", done: true }, { id: "SC-3", done: false }] },
    ]);
    const result = scanStaleIssues({ projectRoot: tmpDir, dryRun: true, repo: "test/repo" });
    expect(result.scanned).toBe(1);
    cleanup();
  });

  test("skips phases with no SCs", () => {
    setup([
      { name: "Empty (#300)", scs: [] },
    ]);
    const result = scanStaleIssues({ projectRoot: tmpDir, dryRun: true, repo: "test/repo" });
    expect(result.scanned).toBe(0);
    cleanup();
  });

  test("respects exclude list", () => {
    setup([
      { name: "Done (#100)", scs: [{ id: "SC-1", done: true }] },
      { name: "Also Done (#200)", scs: [{ id: "SC-2", done: true }] },
    ]);
    const result = scanStaleIssues({ projectRoot: tmpDir, dryRun: true, repo: "test/repo", exclude: [100] });
    expect(result.scanned).toBe(1);
    cleanup();
  });
});
