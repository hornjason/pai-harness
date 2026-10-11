/**
 * gate-config-readers.test.ts — ADR-002 Step 3, first row.
 *
 * `lib/scanner.ts:426-431` wrapped the loader in a bare `try/catch` that turned
 * BOTH the deliberate malformed/orphan throw AND genuine absence into `null`.
 * `.claude/rules/checks-must-be-able-to-fail.md` names that exact line as the
 * fail-open archetype: a catch that answers "nothing here".
 *
 * These assertions are executed against real temp project roots — a scan is
 * run and its outcome observed — not matched against scanner.ts's source text.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { scanProject } from "../lib/scanner";

const TMP = "/tmp/rungate-gate-config-readers-test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function project(name: string): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

describe("scanner distinguishes an absent config from a broken one", () => {
  test("absent config scans clean and reports no harness config", () => {
    const root = project("absent");

    const scan = scanProject(root);

    expect(scan.harnessConfig).toBeNull();
    expect(scan.consumers).toEqual([]);
  });

  test("a resolved config is read, with consumers taken from it", () => {
    const root = project("resolved");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate.json"),
      JSON.stringify({
        project: "resolved",
        repo: "x/y",
        issueRepo: "x/y",
        pages: {},
        consumers: ["alpha", "beta"],
        test: { command: "bun test", timeout: 30000 },
      })
    );

    const scan = scanProject(root);

    expect(scan.harnessConfig).not.toBeNull();
    expect(scan.consumers).toEqual(["alpha", "beta"]);
  });

  // The regression. Before this change both of the next two cases produced the
  // SAME observable outcome as the "absent" case above — `harnessConfig: null`,
  // `consumers: []` — so a project whose config could not be read scanned as a
  // project that had none.
  test("malformed JSON reaches the caller as a throw, not as an absent config", () => {
    const root = project("malformed");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate.json"), "{ not json");

    expect(() => scanProject(root)).toThrow();
  });

  test("an orphan directory fragment reaches the caller as a throw", () => {
    const root = project("orphan");
    const configDir = join(root, ".claude", "rungate");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "roles.json"), JSON.stringify({ marcus: { brief: "m.md" } }));

    expect(() => scanProject(root)).toThrow(/Incomplete rungate config/);
  });
});
