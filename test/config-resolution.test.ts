/**
 * config-resolution.test.ts — ADR-002 Step 1.
 *
 * The defect this file exists for: rungate authors `test.command`, DDB authors
 * `dev.testCmd`, and every reader picks one. `captureTestBaseline` passes here
 * and fails on DDB for that reason alone — so **every assertion below that
 * matters is made against a DDB-shaped fixture**, not against rungate's shape.
 *
 * Assertions are on the RESOLVED VALUE, never on source text (SC-478 is the
 * cautionary case: source-text existence assertions survived mutation).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  resolveConfig,
  loadRungateConfig,
  tryLoadRungateConfig,
  DEFAULT_TEST_TIMEOUT,
} from "../lib/config-loader";
import { parseProjectHarness } from "../lib/rungate-schema";

const TMP = "/tmp/rungate-config-resolution-test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const TEST_CMD = "bun test src/**/*.test.ts";

/**
 * DDB's authored shape, measured off
 * /Users/jhorn/Projects/DailyBriefDashboard/.claude/rungate.json on 2026-10-11:
 * `dev.testCmd` present, NO `test` key at all.
 */
function ddbShaped(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "ddb-shaped",
    repo: "x/y",
    issueRepo: "x/y",
    dev: {
      start: "make dev-all",
      apiBase: "http://localhost:7778",
      uiBase: "http://localhost:5173",
      testCmd: TEST_CMD,
      typeCheck: "bunx tsc --noEmit",
    },
    pages: { dashboard: "/", settings: "/settings" },
    ...extra,
  };
}

/** rungate's own authored shape: `test.command`, no `dev` key. */
function rungateShaped(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "rungate-shaped",
    repo: "x/y",
    issueRepo: "x/y",
    pages: {},
    test: { command: TEST_CMD, timeout: 300000 },
    ...extra,
  };
}

function writeMonolith(name: string, config: Record<string, unknown>): string {
  const projectDir = join(TMP, name);
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "rungate.json"), JSON.stringify(config));
  return projectDir;
}

function writeDirectory(name: string, config: Record<string, unknown>): string {
  const projectDir = join(TMP, name);
  const configDir = join(projectDir, ".claude", "rungate");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
  return projectDir;
}

// ── AC-1 — the schema declares what ship.js already assumes ────────────────
describe("schema declares the keys the harness reads", () => {
  test("TestSchema keeps command and timeout instead of stripping them", () => {
    const parsed = parseProjectHarness(rungateShaped());

    // Before: TestSchema declared only start/apiBase/note, so zod DELETED
    // these two and the validated path was lossier than the raw one.
    expect(parsed.test?.command).toBe(TEST_CMD);
    expect(parsed.test?.timeout).toBe(300000);
  });

  test("ProjectHarnessSchema keeps the whole container block", () => {
    const container = {
      port: 7776,
      rebuildCommand: "make build && make test-down && make test-up",
      healthPath: "/health",
      hosts: ["localhost"],
    };

    const parsed = parseProjectHarness(ddbShaped({ container }));

    expect(parsed.container).toEqual(container);
  });

  test("a container block with a mistyped port is rejected, not silently dropped", () => {
    expect(() => parseProjectHarness(ddbShaped({ container: { port: "7776" } }))).toThrow();
  });
});

// ── AC-2 — the discriminated resolution ────────────────────────────────────
describe("resolveConfig", () => {
  test("reports the monolith as resolved and names the source", () => {
    const projectDir = writeMonolith("mono", rungateShaped());

    const resolution = resolveConfig(projectDir);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.source).toBe("monolith");
    expect(resolution.config.project).toBe("rungate-shaped");
  });

  test("reports the directory form as resolved and names the source", () => {
    const projectDir = writeDirectory("dir", rungateShaped());

    const resolution = resolveConfig(projectDir);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.source).toBe("directory");
  });

  test("absence is a status, not a falsy value", () => {
    const projectDir = join(TMP, "none");
    mkdirSync(projectDir, { recursive: true });

    const resolution = resolveConfig(projectDir);

    expect(resolution.status).toBe("absent");
    // The whole point of the union: the absent case is TRUTHY and carries no
    // `.test`, so `resolution.test?.command || fallback` cannot absorb it.
    expect(Boolean(resolution)).toBe(true);
    expect((resolution as Record<string, unknown>).test).toBeUndefined();
  });

  test("malformed JSON throws rather than resolving to absent", () => {
    const projectDir = join(TMP, "malformed");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "rungate.json"), "{ not json");

    expect(() => resolveConfig(projectDir)).toThrow();
  });

  test("an orphan directory fragment throws rather than resolving to absent", () => {
    const projectDir = join(TMP, "orphan");
    const configDir = join(projectDir, ".claude", "rungate");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "roles.json"), JSON.stringify({ marcus: {} }));

    expect(() => resolveConfig(projectDir)).toThrow(/Incomplete rungate config/);
  });
});

describe("the two wrappers keep ADR-001 D2 semantics", () => {
  test("loadRungateConfig throws on absence with the unchanged message", () => {
    const projectDir = join(TMP, "throwing");
    mkdirSync(projectDir, { recursive: true });

    expect(() => loadRungateConfig(projectDir)).toThrow(/No rungate config found/);
  });

  test("tryLoadRungateConfig returns null on absence and the config when present", () => {
    const absent = join(TMP, "absent-wrapper");
    mkdirSync(absent, { recursive: true });
    const present = writeMonolith("present-wrapper", rungateShaped());

    expect(tryLoadRungateConfig(absent)).toBeNull();
    expect(tryLoadRungateConfig(present)!.project).toBe("rungate-shaped");
  });

  test("tryLoadRungateConfig still throws on malformed rather than returning null", () => {
    const projectDir = join(TMP, "malformed-wrapper");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "rungate.json"), "{ not json");

    expect(() => tryLoadRungateConfig(projectDir)).toThrow();
  });

  test("both wrappers hand back the normalised shape, not the raw file", () => {
    const projectDir = writeMonolith("normalised-wrapper", ddbShaped());

    expect(loadRungateConfig(projectDir).test?.command).toBe(TEST_CMD);
    expect(tryLoadRungateConfig(projectDir)!.test?.command).toBe(TEST_CMD);
  });
});

// ── AC-4 — the Done-when: two shapes, one resolved value ───────────────────
describe("normalisation — the DDB shape and the rungate shape converge", () => {
  test("a DDB-shaped fixture and a rungate-shaped fixture resolve to the same test.command", () => {
    const ddbRoot = writeMonolith("ddb-fixture", ddbShaped());
    const rungateRoot = writeDirectory("rungate-fixture", rungateShaped());

    const ddb = resolveConfig(ddbRoot);
    const rungate = resolveConfig(rungateRoot);
    if (ddb.status !== "resolved" || rungate.status !== "resolved") {
      throw new Error("both fixtures must resolve");
    }

    // Resolved values, not source text.
    expect(ddb.config.test?.command).toBe(TEST_CMD);
    expect(rungate.config.test?.command).toBe(TEST_CMD);
    expect(ddb.config.test?.command).toBe(rungate.config.test!.command!);
  });

  test("dev.testCmd wins when both are authored", () => {
    const projectDir = writeMonolith(
      "both-shapes",
      ddbShaped({ test: { command: "LOSER bun test", timeout: 42 } })
    );

    const resolution = resolveConfig(projectDir);
    if (resolution.status !== "resolved") throw new Error("unreachable");

    expect(resolution.config.test?.command).toBe(TEST_CMD);
    // timeout has no dev.* counterpart, so the authored test.timeout survives.
    expect(resolution.config.test?.timeout).toBe(42);
  });

  test("timeout falls back to the default when nothing authored one", () => {
    const projectDir = writeMonolith("no-timeout", ddbShaped());

    const resolution = resolveConfig(projectDir);
    if (resolution.status !== "resolved") throw new Error("unreachable");

    expect(resolution.config.test?.timeout).toBe(DEFAULT_TEST_TIMEOUT);
  });

  test("apiUrl and uiUrl are normalised off dev.*", () => {
    const projectDir = writeMonolith("urls", ddbShaped());

    const resolution = resolveConfig(projectDir);
    if (resolution.status !== "resolved") throw new Error("unreachable");

    expect(resolution.config.apiUrl).toBe("http://localhost:7778");
    expect(resolution.config.uiUrl).toBe("http://localhost:5173");
  });

  test("a config with neither dev.testCmd nor test.command resolves to an absent command, not a guess", () => {
    const projectDir = writeMonolith("no-command", {
      project: "bare",
      repo: "x/y",
      issueRepo: "x/y",
      pages: {},
    });

    const resolution = resolveConfig(projectDir);
    if (resolution.status !== "resolved") throw new Error("unreachable");

    // `undefined` is the honest answer. A default of "bun test" here is the
    // fail-open that lets a gate report 0 failures for a suite it never ran.
    expect(resolution.config.test?.command).toBeUndefined();
  });
});

// ── AC-15 (fixture half) — the container block survives resolution ─────────
describe("container config survives validation and normalisation", () => {
  const container = {
    port: 7776,
    rebuildCommand: "make build && make test-down && make test-up",
    healthPath: "/health",
    hosts: ["localhost"],
  };

  test("a DDB-shaped project root resolves container.port 7776", () => {
    const projectDir = writeMonolith("ddb-container", ddbShaped({ container }));

    const resolution = resolveConfig(projectDir);
    if (resolution.status !== "resolved") throw new Error("unreachable");

    expect(resolution.config.container?.port).toBe(7776);
    expect(resolution.config.container?.rebuildCommand).toBe(
      "make build && make test-down && make test-up"
    );
    expect(resolution.config.container?.hosts).toEqual(["localhost"]);
  });

  test("the resolved container block is what ship.js's conditional reads", () => {
    const projectDir = writeMonolith("ship-shape", ddbShaped({ container }));
    const resolution = resolveConfig(projectDir);
    if (resolution.status !== "resolved") throw new Error("unreachable");

    // ship.js:3754-3760 — `projectConfig.container || null`, then
    // `.rebuildCommand`, `.hosts`, `.port`, `.healthPath`. Executed here
    // rather than asserted as source text.
    const containerConfig = (resolution.config as Record<string, any>).container || null;
    expect(containerConfig).not.toBeNull();
    expect(containerConfig.rebuildCommand).toBeTruthy();
    expect(containerConfig.healthPath || "/").toBe("/health");

    // PROJECT-STATE item 8: `make rebuild` must never be handed to an agent.
    expect(containerConfig.rebuildCommand).not.toMatch(/\bmake\s+rebuild\b/);
  });
});
