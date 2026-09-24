import { describe, test, expect } from "bun:test";
import { findStaleIssues } from "../lib/stale-issue-scanner";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeProject(phases: any[]): string {
  const dir = mkdtempSync(join(tmpdir(), "stale-scan-"));
  writeFileSync(
    join(dir, "project-state.json"),
    JSON.stringify({ phases })
  );
  return dir;
}

describe("stale-issue-scanner", () => {
  test("finds stale issues from completed phases with issue numbers", () => {
    const dir = makeProject([
      {
        name: "Phase F: Matcher Registry (#550-#552, #555)",
        scs: [
          { id: "SC-379", done: true },
          { id: "SC-380", done: true },
        ],
      },
    ]);
    const result = findStaleIssues(dir);
    expect(result.staleIssues).toContain(550);
    expect(result.staleIssues).toContain(552);
    expect(result.staleIssues).toContain(555);
  });

  test("skips phases with incomplete SCs", () => {
    const dir = makeProject([
      {
        name: "Brief Compliance (#558)",
        scs: [
          { id: "SC-400", done: true },
          { id: "SC-402", done: false },
        ],
      },
    ]);
    const result = findStaleIssues(dir);
    expect(result.staleIssues).toEqual([]);
  });

  test("skips phases with no SCs", () => {
    const dir = makeProject([
      { name: "Phase 0+1 (#100)", scs: [], note: "COMPLETE" },
    ]);
    const result = findStaleIssues(dir);
    expect(result.staleIssues).toEqual([]);
  });

  test("deduplicates issue numbers", () => {
    const dir = makeProject([
      {
        name: "Work (#42)",
        scs: [{ id: "SC-1", done: true }],
      },
      {
        name: "More Work (#42)",
        scs: [{ id: "SC-2", done: true }],
      },
    ]);
    const result = findStaleIssues(dir);
    expect(result.staleIssues).toEqual([42]);
  });

  test("returns empty for missing project-state.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-scan-"));
    const result = findStaleIssues(dir);
    expect(result.scanned).toBe(0);
    expect(result.staleIssues).toEqual([]);
  });

  test("handles phases without issue numbers in name", () => {
    const dir = makeProject([
      {
        name: "Agent Brief Templates",
        scs: [{ id: "SC-348", done: true }],
      },
    ]);
    const result = findStaleIssues(dir);
    expect(result.staleIssues).toEqual([]);
  });
});
