import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const ROUTINES_DIR = resolve(ROOT, ".claude", "routines");

describe("routines", () => {
  describe("post-merge-conformity routine", () => {
    const routinePath = resolve(ROUTINES_DIR, "post-merge-conformity.md");

    it("routine file exists", () => {
      expect(existsSync(routinePath)).toBe(true);
    });

    it("has pull_request trigger for merged PRs", () => {
      const content = readFileSync(routinePath, "utf-8");
      const pullRequestMatches = content.match(/pull_request/g);
      expect(pullRequestMatches).not.toBeNull();
      expect(pullRequestMatches!.length).toBeGreaterThanOrEqual(1);
    });

    it("references scaffold conformity checks", () => {
      const content = readFileSync(routinePath, "utf-8");
      // Must reference running conformity tests
      expect(
        content.includes("scaffold-conformity") ||
        content.includes("conformity") ||
        content.includes("bun test")
      ).toBe(true);
    });

    it("specifies merged action filter", () => {
      const content = readFileSync(routinePath, "utf-8");
      // Must filter for merged/closed PRs
      expect(
        content.includes("merged") || content.includes("closed")
      ).toBe(true);
    });
  });

  describe("nightly-stale-issues routine", () => {
    const routinePath = resolve(ROUTINES_DIR, "nightly-stale-issues.md");

    it("routine file exists", () => {
      expect(existsSync(routinePath)).toBe(true);
    });

    it("has schedule/cron trigger", () => {
      const content = readFileSync(routinePath, "utf-8");
      expect(
        content.includes("schedule") || content.includes("cron")
      ).toBe(true);
    });

    it("references scan-stale-issues script", () => {
      const content = readFileSync(routinePath, "utf-8");
      expect(content.includes("scan-stale-issues")).toBe(true);
    });

    it("includes a cron expression or schedule frequency", () => {
      const content = readFileSync(routinePath, "utf-8");
      // Must have a cron expression (5-field like "0 2 * * *") or frequency keyword
      const hasCronExpr = /\d+\s+\d+\s+\*/.test(content);
      const hasFrequency = /daily|nightly|every\s+day/i.test(content);
      expect(hasCronExpr || hasFrequency).toBe(true);
    });
  });

  describe("routine file validation", () => {
    it("both routines have correct trigger syntax and reference correct scripts", () => {
      const postMergePath = resolve(ROUTINES_DIR, "post-merge-conformity.md");
      const nightlyPath = resolve(ROUTINES_DIR, "nightly-stale-issues.md");

      // Both files must exist
      expect(existsSync(postMergePath)).toBe(true);
      expect(existsSync(nightlyPath)).toBe(true);

      const postMerge = readFileSync(postMergePath, "utf-8");
      const nightly = readFileSync(nightlyPath, "utf-8");

      // Post-merge: pull_request trigger + conformity reference
      expect(postMerge).toContain("pull_request");
      expect(
        postMerge.includes("scaffold-conformity") ||
        postMerge.includes("conformity")
      ).toBe(true);

      // Nightly: schedule trigger + stale-issues reference
      expect(
        nightly.includes("schedule") || nightly.includes("cron")
      ).toBe(true);
      expect(nightly).toContain("scan-stale-issues");
    });
  });
});
