/**
 * gate-config-readers.test.ts — ADR-002 Step 3, scanner row (#307, AC-5)
 *
 * `lib/scanner.ts:427-431` wrapped the loader in a bare `try/catch` that
 * returned `null`. It swallowed TWO distinct outcomes:
 *   - the deliberate orphan/malformed throw (ADR-001 D2's whole point), and
 *   - the ordinary "no config found" throw.
 * Both arrived at the caller as `null`, so a broken config was indistinguishable
 * from an unconfigured project — `.claude/rules/checks-must-be-able-to-fail.md`
 * names this exact line as the fail-open example.
 *
 * These are BEHAVIOURAL assertions over `scanProject`, not source-text greps:
 * restoring the `try/catch` turns the two refusal cases red.
 *
 * WHAT WAS BROKEN TO PROVE THEY CAN FAIL — see the commit body for counts:
 *   - the `try { ... } catch { return null }` restored around the config read.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { scanProject } from "../lib/scanner";

const TMP = "/tmp/rungate-gate-config-readers-test";

function project(name: string): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, description: "fixture" }));
  return dir;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("AC-5: scanner distinguishes a broken config from an absent one", () => {
  test("an orphan directory fragment refuses the scan instead of scanning as unconfigured", () => {
    const root = project("orphan");
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "roles.json"), JSON.stringify({}));

    expect(() => scanProject(root)).toThrow(/Incomplete rungate config/);
  });

  test("a malformed config.json refuses the scan instead of scanning as unconfigured", () => {
    const root = project("malformed");
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "config.json"), '{"project": "x",}');

    expect(() => scanProject(root)).toThrow();
  });

  test("a malformed monolith refuses the scan", () => {
    const root = project("malformed-mono");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate.json"), "{ not json");

    expect(() => scanProject(root)).toThrow();
  });

  test("a genuinely absent config scans cleanly — absence is not an error", () => {
    const root = project("absent");

    const scan = scanProject(root);

    expect(scan.harnessConfig).toBeNull();
    expect(scan.consumers).toEqual([]);
  });

  test("a resolved config's consumers reach the scan", () => {
    const root = project("configured");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate.json"),
      JSON.stringify({
        project: "configured",
        repo: "x/y",
        issueRepo: "x/y",
        consumers: ["alpha", "beta"],
        test: { command: "bun test", timeout: 30000 },
      })
    );

    const scan = scanProject(root);

    expect(scan.consumers).toEqual(["alpha", "beta"]);
    expect(scan.harnessConfig).not.toBeNull();
    expect(scan.harnessConfig?.project).toBe("configured");
  });

  test("the resolved config the scan carries is the normalised one", () => {
    const root = project("normalised");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate.json"),
      JSON.stringify({
        project: "normalised",
        repo: "x/y",
        issueRepo: "x/y",
        dev: {
          start: "make dev",
          apiBase: "http://localhost:7778",
          uiBase: "http://localhost:5173",
          testCmd: "bun test src/**/*.test.ts",
        },
      })
    );

    const scan = scanProject(root);

    expect(scan.harnessConfig?.test?.command).toBe("bun test src/**/*.test.ts");
    expect(scan.harnessConfig?.apiUrl).toBe("http://localhost:7778");
  });
});
