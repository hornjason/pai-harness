/**
 * gate-config-readers.test.ts — ADR-002 Step 3, the scanner reader.
 *
 * Covers #307 AC-5.
 *
 * `lib/scanner.ts` was counted as migrated to the central loader and was not:
 * the `try/catch` it kept converted the loader's deliberate throw straight back
 * into `null`, so "this project is not configured" and "this project's config
 * is broken" arrived at the caller as the same value. That is the fail-open
 * shape named in .claude/rules/checks-must-be-able-to-fail.md — a `catch` that
 * returns "no problems found".
 *
 * What was broken to make these fail, run by hand and counted: restoring the
 * `try { return resolveConfig(root) } catch { return { status: "absent" } }`
 * around the config read turns 4 red of the 34 tests in this file plus
 * test/config-resolution.test.ts — the source-text check, both refusal cases,
 * and the pair case that asserts the two outcomes differ from each other. The
 * mutation is not left in the tree; it was run and reverted, and the baseline
 * re-measured green afterwards. The full table is in config-resolution.test.ts.
 *
 * Note the catch had to be restored in its *weakened* form (returning the
 * absent status rather than `null`) for the file to still compile. That is the
 * point: even the type-correct version of the catch is the defect, because
 * what makes it a fail-open is collapsing two outcomes into one, not the
 * particular value it collapses them to.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

import { scanProject, resolveHarnessConfig } from "../lib/scanner";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const TMP = join(tmpdir(), `rungate-gate-config-readers-${process.pid}`);

function makeProject(name: string, configBody: string | null, layout: "monolith" | "orphan" = "monolith"): string {
  const root = join(TMP, name);
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  if (configBody !== null) {
    if (layout === "orphan") {
      mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
      writeFileSync(join(root, ".claude", "rungate", "roles.json"), configBody);
    } else {
      writeFileSync(join(root, ".claude", "rungate.json"), configBody);
    }
  }
  return root;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("AC-5 scanner distinguishes an absent config from a broken one", () => {
  test("scanner: no bare catch remains around the config read", () => {
    const source = readFileSync(join(HARNESS_ROOT, "lib", "scanner.ts"), "utf-8");
    const start = source.indexOf("export function resolveHarnessConfig");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start) + 2);
    expect(body).not.toMatch(/\bcatch\b/);
    expect(body).not.toMatch(/\btry\b/);
  });

  test("scanner: an absent config resolves as absent, not as a failure", () => {
    const root = makeProject("scanner-absent", null);
    const resolution = resolveHarnessConfig(root);
    expect(resolution.status).toBe("absent");
  });

  test("scanner: a present config resolves and carries its consumers", () => {
    const root = makeProject(
      "scanner-present",
      JSON.stringify({
        project: "scanner-present",
        repo: "org/repo",
        issueRepo: "org/repo",
        consumers: ["alpha", "beta"],
      })
    );
    const resolution = resolveHarnessConfig(root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.consumers).toEqual(["alpha", "beta"]);
    expect(scanProject(root).consumers).toEqual(["alpha", "beta"]);
  });

  test("scanner: a malformed config throws rather than reading as absent", () => {
    const root = makeProject("scanner-malformed", "{ not json");
    expect(() => resolveHarnessConfig(root)).toThrow();
  });

  test("scanner: an orphaned directory fragment throws rather than reading as absent", () => {
    const root = makeProject("scanner-orphan", "{}", "orphan");
    expect(() => resolveHarnessConfig(root)).toThrow(/Incomplete rungate config/);
  });

  test("scanner: the two outcomes are distinguishable from one another", () => {
    // The whole of AC-5 in one assertion: before this change both of these
    // produced `null` and the caller could not tell them apart.
    const absent = makeProject("scanner-pair-absent", null);
    const broken = makeProject("scanner-pair-broken", "{ not json");

    const absentOutcome = resolveHarnessConfig(absent).status;
    let brokenOutcome = "no-throw";
    try {
      resolveHarnessConfig(broken);
    } catch {
      brokenOutcome = "threw";
    }
    expect(absentOutcome).toBe("absent");
    expect(brokenOutcome).toBe("threw");
    expect(absentOutcome).not.toBe(brokenOutcome);
  });

  test("scanner: a config with no consumers key still falls back to the src/ heuristic", () => {
    const root = makeProject(
      "scanner-fallback",
      JSON.stringify({ project: "scanner-fallback", repo: "org/repo", issueRepo: "org/repo" })
    );
    writeFileSync(join(root, "src", "widget-routes.ts"), "export const x = 1;\n");
    expect(scanProject(root).consumers).toContain("widget");
  });
});
