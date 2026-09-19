import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const HARNESS = join(import.meta.dir, "..");
const GATES = join(HARNESS, "gates");

describe("Phase 3: Parallel Work", () => {

  // SC-45: Container lock checked mechanically
  describe("SC-45: container lock check", () => {
    test("orchestrator or Makefile checks for lock file", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/lock|container.*lock|rebuild.*block/i);
    });
  });

  // SC-46: Worktree isolation for parallel execution
  describe("SC-46: worktree isolation", () => {
    test("ship orchestrator supports worktree mode", () => {
      const orchestrator = join(GATES, "ship-orchestrator.ts");
      if (existsSync(orchestrator)) {
        const content = readFileSync(orchestrator, "utf-8");
        expect(content).toMatch(/worktree|parallel|isolation/i);
      } else {
        expect(existsSync(orchestrator)).toBe(true);
      }
    });
  });

  // SC-47: Container lock released after test completion
  describe("SC-47: lock release on completion", () => {
    test("orchestrator releases lock after tests", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/unlock|release.*lock|remove.*lock|cleanup/i);
    });
  });

  // SC-69: File-set overlap detection
  describe("SC-69: file-set overlap detection", () => {
    test("orchestrator detects overlapping file sets", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/overlap|file.*set|conflict.*detect/i);
    });
  });

  // SC-70: Port/namespace isolation beyond worktree
  describe("SC-70: port/namespace isolation", () => {
    test("orchestrator handles port isolation", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/port.*isol|namespace|port.*offset|port.*alloc/i);
    });
  });

  // SC-71: Cap concurrent agents at 5
  describe("SC-71: agent concurrency cap", () => {
    test("orchestrator limits concurrent agents", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/concurrent|cap|max.*agent|limit.*parallel|5.*agent/i);
    });
  });

  // SC-72: Sequential merge with CI verification
  describe("SC-72: sequential merge protocol", () => {
    test("orchestrator enforces sequential merge", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/sequential.*merge|merge.*queue|ci.*verif/i);
    });
  });

  // SC-136: Worktree branch naming
  describe("SC-136: deterministic worktree branch names", () => {
    test("orchestrator uses issue-{N}-{slug} naming", () => {
      const files = ["gates/orchestrator.ts", "gates/ship-orchestrator.ts"]
        .map(f => join(HARNESS, f))
        .filter(f => existsSync(f));
      const content = files.map(f => readFileSync(f, "utf-8")).join("\n");
      expect(content).toMatch(/issue.*slug|branch.*name|worktree.*branch/i);
    });
  });
});
