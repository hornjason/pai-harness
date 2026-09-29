/**
 * Tests for rule-health-trend.ts
 *
 * Covers AC-6
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { aggregateTrend, type TrendData, type RuleTrajectory } from "../lib/rule-health-trend";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `rht-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("aggregate trend", () => {
  let tmpDir: string;
  let historyDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    historyDir = join(tmpDir, ".rungate", "rule-health-history");
    mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads daily rule-health JSON files from .rungate/rule-health-history", () => {
    // Write two daily files
    writeFileSync(
      join(historyDir, "2026-09-28.json"),
      JSON.stringify({
        date: "2026-09-28",
        rules: {
          "COMP-1": { score: 80, verdict: "FOLLOWED" },
          "COMP-6": { score: 40, verdict: "IGNORED" },
        },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-29.json"),
      JSON.stringify({
        date: "2026-09-29",
        rules: {
          "COMP-1": { score: 85, verdict: "FOLLOWED" },
          "COMP-6": { score: 60, verdict: "FOLLOWED" },
        },
      }),
    );

    const trend = aggregateTrend(tmpDir);

    expect(trend.dates).toHaveLength(2);
    expect(trend.dates).toContain("2026-09-28");
    expect(trend.dates).toContain("2026-09-29");
  });

  it("produces per-rule score trajectories", () => {
    writeFileSync(
      join(historyDir, "2026-09-27.json"),
      JSON.stringify({
        date: "2026-09-27",
        rules: {
          "COMP-1": { score: 70, verdict: "FOLLOWED" },
          "COMP-6": { score: 30, verdict: "IGNORED" },
        },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-28.json"),
      JSON.stringify({
        date: "2026-09-28",
        rules: {
          "COMP-1": { score: 80, verdict: "FOLLOWED" },
          "COMP-6": { score: 50, verdict: "FOLLOWED" },
        },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-29.json"),
      JSON.stringify({
        date: "2026-09-29",
        rules: {
          "COMP-1": { score: 90, verdict: "FOLLOWED" },
          "COMP-6": { score: 70, verdict: "FOLLOWED" },
        },
      }),
    );

    const trend = aggregateTrend(tmpDir);

    expect(trend.trajectories["COMP-1"]).toBeDefined();
    expect(trend.trajectories["COMP-1"].scores).toEqual([70, 80, 90]);
    expect(trend.trajectories["COMP-1"].trend).toBe("improving");

    expect(trend.trajectories["COMP-6"]).toBeDefined();
    expect(trend.trajectories["COMP-6"].scores).toEqual([30, 50, 70]);
    expect(trend.trajectories["COMP-6"].trend).toBe("improving");
  });

  it("returns empty trend data when no history files exist", () => {
    rmSync(historyDir, { recursive: true, force: true });

    const trend = aggregateTrend(tmpDir);

    expect(trend.dates).toHaveLength(0);
    expect(Object.keys(trend.trajectories)).toHaveLength(0);
  });

  it("detects declining trend", () => {
    writeFileSync(
      join(historyDir, "2026-09-27.json"),
      JSON.stringify({
        date: "2026-09-27",
        rules: { "COMP-1": { score: 90, verdict: "FOLLOWED" } },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-28.json"),
      JSON.stringify({
        date: "2026-09-28",
        rules: { "COMP-1": { score: 70, verdict: "FOLLOWED" } },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-29.json"),
      JSON.stringify({
        date: "2026-09-29",
        rules: { "COMP-1": { score: 50, verdict: "IGNORED" } },
      }),
    );

    const trend = aggregateTrend(tmpDir);
    expect(trend.trajectories["COMP-1"].trend).toBe("declining");
  });

  it("detects stable trend", () => {
    writeFileSync(
      join(historyDir, "2026-09-27.json"),
      JSON.stringify({
        date: "2026-09-27",
        rules: { "COMP-1": { score: 80, verdict: "FOLLOWED" } },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-28.json"),
      JSON.stringify({
        date: "2026-09-28",
        rules: { "COMP-1": { score: 80, verdict: "FOLLOWED" } },
      }),
    );

    writeFileSync(
      join(historyDir, "2026-09-29.json"),
      JSON.stringify({
        date: "2026-09-29",
        rules: { "COMP-1": { score: 82, verdict: "FOLLOWED" } },
      }),
    );

    const trend = aggregateTrend(tmpDir);
    expect(trend.trajectories["COMP-1"].trend).toBe("stable");
  });

  it("sorts dates chronologically", () => {
    writeFileSync(
      join(historyDir, "2026-09-29.json"),
      JSON.stringify({ date: "2026-09-29", rules: { "COMP-1": { score: 90, verdict: "FOLLOWED" } } }),
    );
    writeFileSync(
      join(historyDir, "2026-09-27.json"),
      JSON.stringify({ date: "2026-09-27", rules: { "COMP-1": { score: 70, verdict: "FOLLOWED" } } }),
    );

    const trend = aggregateTrend(tmpDir);
    expect(trend.dates[0]).toBe("2026-09-27");
    expect(trend.dates[1]).toBe("2026-09-29");
  });
});
