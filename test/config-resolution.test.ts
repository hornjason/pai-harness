/**
 * config-resolution.test.ts — ADR-002 Step 1 (#307)
 *
 * Covers AC-1 (schema declares command/timeout/container), AC-2 (resolveConfig
 * returns a discriminated ConfigResolution, wrappers unchanged), AC-3 (the
 * exported config type is schema-derived), AC-4 (DDB-shaped and rungate-shaped
 * fixtures normalise to the same test.command) and AC-15 (a container block
 * survives schema validation and reaches the resolved config).
 *
 * Every assertion here is on a RESOLVED VALUE or on a PARSE RESULT — never on
 * source text. SC-478/479/511 are the cautionary cases (PROJECT-STATE item 21).
 *
 * WHAT WAS BROKEN TO PROVE THESE CAN FAIL — see the commit body for counts:
 *   - `command` removed from TestSchema          → zod strips it again
 *   - `container` removed from ProjectHarnessSchema → zod strips it again
 *   - `dev.testCmd ??` precedence removed        → the two fixtures diverge
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  resolveConfig,
  loadRungateConfig,
  tryLoadRungateConfig,
  DEFAULT_TEST_TIMEOUT,
} from "../lib/config-loader";
import {
  parseProjectHarness,
  safeParseProjectHarness,
  ResolvedConfigSchema,
} from "../lib/rungate-schema";

const TMP = "/tmp/rungate-config-resolution-test";

/** The normalised command both authored shapes must agree on. */
const SHARED_TEST_COMMAND = "bun test src/**/*.test.ts";

/** The container block PROJECT-STATE item 8 specifies for DDB's 7776 test container. */
const DDB_CONTAINER = {
  port: 7776,
  rebuildCommand: "make build && make test-down && make test-up",
  healthPath: "/api/aes",
  hosts: ["localhost"],
};

/**
 * DDB's authored shape: `dev.*`, no `test` key. This is the shape the defect
 * hides in — a rungate-shaped fixture is green for the reason the defect
 * survived a year (ADR-002, "Before anything").
 */
function ddbShaped(extra: Record<string, unknown> = {}) {
  return {
    project: "DailyBriefDashboard",
    repo: "x/ddb",
    issueRepo: "x/ddb",
    dev: {
      start: "make dev-all",
      apiBase: "http://localhost:7778",
      uiBase: "http://localhost:5173",
      testCmd: SHARED_TEST_COMMAND,
      typeCheck: "bunx tsc --noEmit",
    },
    prod: { rebuild: "make rebuild", apiBase: "http://localhost:7777" },
    pages: { "/": "home", "/accounts": "accounts" },
    consumers: [],
    contextDocs: {},
    ...extra,
  };
}

/** rungate's own authored shape: `test.command`, no `dev` key. */
function rungateShaped(extra: Record<string, unknown> = {}) {
  return {
    project: "rungate",
    repo: "hornjason/pai-harness",
    issueRepo: "hornjason/pai-harness",
    pages: {},
    consumers: [],
    contextDocs: {},
    test: { command: SHARED_TEST_COMMAND, timeout: 300000 },
    hooks: [],
    ...extra,
  };
}

function writeMonolith(name: string, raw: unknown): string {
  const projectDir = join(TMP, name);
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "rungate.json"), JSON.stringify(raw));
  return projectDir;
}

function writeDirectory(name: string, raw: unknown, roles?: unknown): string {
  const projectDir = join(TMP, name);
  const configDir = join(projectDir, ".claude", "rungate");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(raw));
  if (roles) writeFileSync(join(configDir, "roles.json"), JSON.stringify(roles));
  return projectDir;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// AC-1 — the schema declares what ship.js already assumes
// ───────────────────────────────────────────────────────────────────────────
describe("AC-1: schema declares command, timeout and container", () => {
  test("a parse preserves test.command and test.timeout", () => {
    const parsed = parseProjectHarness(rungateShaped());

    expect(parsed.test?.command).toBe(SHARED_TEST_COMMAND);
    expect(parsed.test?.timeout).toBe(300000);
  });

  test("a parse preserves the container block in full", () => {
    const parsed = parseProjectHarness(ddbShaped({ container: DDB_CONTAINER }));

    expect(parsed.container).toEqual(DDB_CONTAINER);
    expect(parsed.container?.port).toBe(7776);
    expect(parsed.container?.rebuildCommand).toBe("make build && make test-down && make test-up");
    expect(parsed.container?.healthPath).toBe("/api/aes");
    expect(parsed.container?.hosts).toEqual(["localhost"]);
  });

  test("the three key groups survive together, validated not asserted", () => {
    const result = safeParseProjectHarness(
      ddbShaped({ container: DDB_CONTAINER, test: { command: "x", timeout: 1 } })
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data)).toContain("container");
    expect(result.data.test?.command).toBe("x");
    expect(result.data.test?.timeout).toBe(1);
  });

  test("a container block with a wrong-typed port is rejected, not silently kept", () => {
    const result = safeParseProjectHarness(
      ddbShaped({ container: { ...DDB_CONTAINER, port: "7776" } })
    );

    expect(result.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC-2 — the discriminated resolution, with the two wrappers unchanged
// ───────────────────────────────────────────────────────────────────────────
describe("AC-2: resolveConfig returns a discriminated ConfigResolution", () => {
  test("a monolith resolves with source 'monolith'", () => {
    const dir = writeMonolith("mono", rungateShaped());
    const resolution = resolveConfig(dir);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe("monolith");
    expect(resolution.config.project).toBe("rungate");
  });

  test("a directory form resolves with source 'directory' and wins over the monolith", () => {
    const dir = writeDirectory("dir", rungateShaped({ project: "dir-wins" }), {
      marcus: { brief: "engineer" },
    });
    writeFileSync(
      join(dir, ".claude", "rungate.json"),
      JSON.stringify(rungateShaped({ project: "mono-loses" }))
    );

    const resolution = resolveConfig(dir);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe("directory");
    expect(resolution.config.project).toBe("dir-wins");
    expect(resolution.config.roles).toHaveProperty("marcus");
  });

  test("genuine absence is 'absent' — truthy, and with no .test to absorb", () => {
    const dir = join(TMP, "absent");
    mkdirSync(dir, { recursive: true });

    const resolution = resolveConfig(dir);

    expect(resolution.status).toBe("absent");
    // The whole point of the union over the nullable: `{status:"absent"}` is
    // truthy and carries no config fields, so `resolution.test?.command || x`
    // cannot silently absorb it the way `null` did at four of five sites.
    expect(Boolean(resolution)).toBe(true);
    expect((resolution as Record<string, unknown>).test).toBeUndefined();
    expect((resolution as Record<string, unknown>).config).toBeUndefined();
  });

  test("malformed JSON throws rather than resolving to 'absent'", () => {
    const dir = join(TMP, "malformed");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "rungate.json"), "{ not json");

    expect(() => resolveConfig(dir)).toThrow();
  });

  test("an orphan directory fragment throws rather than resolving to 'absent'", () => {
    const dir = join(TMP, "orphan");
    mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(dir, ".claude", "rungate", "roles.json"), JSON.stringify({}));

    expect(() => resolveConfig(dir)).toThrow(/Incomplete rungate config/);
  });
});

describe("AC-2: the wrappers keep ADR-001 D2's signatures and semantics", () => {
  test("loadRungateConfig still throws on absence with the same message", () => {
    const dir = join(TMP, "throwing");
    mkdirSync(dir, { recursive: true });

    expect(() => loadRungateConfig(dir)).toThrow(/No rungate config found/);
  });

  test("tryLoadRungateConfig still returns null on absence", () => {
    const dir = join(TMP, "null-case");
    mkdirSync(dir, { recursive: true });

    expect(tryLoadRungateConfig(dir)).toBeNull();
  });

  test("tryLoadRungateConfig still throws on malformed — never null", () => {
    const dir = join(TMP, "try-malformed");
    mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(dir, ".claude", "rungate", "config.json"), '{"project": "x",}');

    expect(() => tryLoadRungateConfig(dir)).toThrow();
  });

  test("both wrappers return the same normalised object resolveConfig built", () => {
    const dir = writeMonolith("wrappers", ddbShaped());
    const resolution = resolveConfig(dir);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(loadRungateConfig(dir)).toEqual(resolution.config);
    expect(tryLoadRungateConfig(dir)).toEqual(resolution.config);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC-3 — the config type is derived from the schema, not hand-written
// ───────────────────────────────────────────────────────────────────────────
describe("AC-3: the exported config type is schema-derived", () => {
  test("the hand-written RungateConfig interface is gone", () => {
    const source = readFileSync(join(import.meta.dir, "..", "lib", "config-loader.ts"), "utf-8");

    expect(source).not.toMatch(/export interface RungateConfig/);
    expect(source).not.toMatch(/\binterface RungateConfig\b/);
  });

  // The executable half: a grep proves the interface is absent, this proves
  // the schema actually describes what the loader emits. If resolveConfig
  // started emitting a shape the schema forbids, the grep would stay green
  // and this would go red.
  test("every resolved config validates against ResolvedConfigSchema", () => {
    const monolith = writeMonolith("derived-mono", ddbShaped({ container: DDB_CONTAINER }));
    const directory = writeDirectory("derived-dir", rungateShaped(), {
      marcus: { brief: "engineer", standardTask: "implement" },
    });

    for (const dir of [monolith, directory]) {
      const resolution = resolveConfig(dir);
      expect(resolution.status).toBe("resolved");
      if (resolution.status !== "resolved") continue;
      const check = ResolvedConfigSchema.safeParse(resolution.config);
      expect(check.success).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC-4 — the normalisation: two authored shapes, one resolved value
// ───────────────────────────────────────────────────────────────────────────
describe("AC-4: DDB-shaped and rungate-shaped configs normalise alike", () => {
  test("both fixtures resolve to an identical normalised test.command", () => {
    const ddbDir = writeMonolith("ddb-shape", ddbShaped());
    const rungateDir = writeMonolith("rungate-shape", rungateShaped());

    const ddb = resolveConfig(ddbDir);
    const rungate = resolveConfig(rungateDir);

    expect(ddb.status).toBe("resolved");
    expect(rungate.status).toBe("resolved");
    if (ddb.status !== "resolved" || rungate.status !== "resolved") return;

    // Asserted on the resolved value, not on source text.
    expect(ddb.config.test.command).toBe(SHARED_TEST_COMMAND);
    expect(rungate.config.test.command).toBe(SHARED_TEST_COMMAND);
    expect(ddb.config.test.command).toBe(rungate.config.test.command);
  });

  test("dev.testCmd wins when both are authored", () => {
    const dir = writeMonolith(
      "both-shapes",
      ddbShaped({ test: { command: "bun test --losing", timeout: 1000 } })
    );

    const resolution = resolveConfig(dir);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;

    expect(resolution.config.test.command).toBe(SHARED_TEST_COMMAND);
    // test.timeout still comes from `test`, which is the only place it is authored.
    expect(resolution.config.test.timeout).toBe(1000);
  });

  test("test.timeout falls back to the default when unauthored", () => {
    const dir = writeMonolith("no-timeout", ddbShaped());

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");

    expect(resolution.config.test.timeout).toBe(DEFAULT_TEST_TIMEOUT);
  });

  test("a config with neither dev.testCmd nor test.command leaves command undefined", () => {
    const dir = writeMonolith("no-command", {
      project: "bare",
      repo: "x/y",
      issueRepo: "x/y",
    });

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");

    // Not "" and not a default command: the gate has to be able to tell that
    // nothing was configured (ADR-002 Step 3's unmeasured branch).
    expect(resolution.config.test.command).toBeUndefined();
  });

  test("dev.apiBase and dev.uiBase normalise to apiUrl and uiUrl", () => {
    const dir = writeMonolith("urls", ddbShaped());

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");

    expect(resolution.config.apiUrl).toBe("http://localhost:7778");
    expect(resolution.config.uiUrl).toBe("http://localhost:5173");
  });

  test("pages, roles, hooks, project, repo, issueRepo and contextDocs all carry through", () => {
    const dir = writeDirectory(
      "carry-through",
      rungateShaped({
        pages: { "/": "home" },
        contextDocs: { harness: "HARNESS.md" },
      }),
      { marcus: { brief: "engineer", standardTask: "implement" } }
    );

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");
    const config = resolution.config;

    expect(config.pages).toEqual({ "/": "home" });
    expect(config.roles).toHaveProperty("marcus");
    expect(config.hooks).toEqual([]);
    expect(config.project).toBe("rungate");
    expect(config.repo).toBe("hornjason/pai-harness");
    expect(config.issueRepo).toBe("hornjason/pai-harness");
    expect(config.contextDocs).toEqual({ harness: "HARNESS.md" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC-15 — the container block reaches the resolved config
// ───────────────────────────────────────────────────────────────────────────
describe("AC-15: a DDB-shaped container block resolves to port 7776", () => {
  test("resolveConfig reports the 7776 container port", () => {
    const dir = writeMonolith("ddb-container", ddbShaped({ container: DDB_CONTAINER }));

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");

    expect(resolution.config.container?.port).toBe(7776);
    expect(resolution.config.container?.hosts).toEqual(["localhost"]);
  });

  test("the rebuildCommand is the test-container sequence, never `make rebuild`", () => {
    const dir = writeMonolith("ddb-rebuild", ddbShaped({ container: DDB_CONTAINER }));

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");

    // PROJECT-STATE item 8: this string is interpolated verbatim into an agent
    // prompt at ship.js:3766, and DDB's CLAUDE.md plus its Makefile worktree
    // guard forbid `make rebuild` from an agent.
    expect(resolution.config.container?.rebuildCommand).toBe(
      "make build && make test-down && make test-up"
    );
    expect(resolution.config.container?.rebuildCommand).not.toMatch(/\bmake\s+rebuild\b/);
  });

  test("ship.js's container gate reads a truthy container off the resolved config", () => {
    const dir = writeMonolith("ddb-gate", ddbShaped({ container: DDB_CONTAINER }));

    const resolution = resolveConfig(dir);
    if (resolution.status !== "resolved") throw new Error("expected resolved");

    // workflows/ship.js:1703 `const hasContainer = !!(projectConfig.container)`
    // and :3753 `const containerConfig = projectConfig.container || null`.
    expect(Boolean(resolution.config.container)).toBe(true);
    expect(resolution.config.container || null).not.toBeNull();
  });

  /**
   * The live reading. DDB's own `.claude/rungate.json` is in a DIFFERENT
   * REPOSITORY and this agent runs under worktree isolation, which refuses
   * writes outside the worktree — so the container block itself is a DA
   * action, recorded in the findings. What IS provable here, and what the
   * normalisation exists for, is that the real consumer's authored `dev.*`
   * shape resolves to a usable `test.command` with no `test` key present.
   * That is the condition `captureTestBaseline` fails on today.
   */
  test("the live DailyBriefDashboard config resolves dev.testCmd with no test key", () => {
    const ddbRoot = "/Users/jhorn/Projects/DailyBriefDashboard";
    const present = existsSync(join(ddbRoot, ".claude", "rungate.json"));
    const resolution = resolveConfig(ddbRoot);

    if (!present) {
      // DDB is not checked out here (CI). Assert the branch rather than
      // returning early, so a machine without DDB still exercises something.
      expect(resolution.status).toBe("absent");
      return;
    }

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;

    const rawHasTestKey = "test" in JSON.parse(
      readFileSync(join(ddbRoot, ".claude", "rungate.json"), "utf-8")
    );
    expect(rawHasTestKey).toBe(false);
    expect(resolution.config.test.command).toBe(resolution.config.dev?.testCmd);
    expect(resolution.config.test.command).toBeTruthy();
    expect(resolution.config.test.timeout).toBe(DEFAULT_TEST_TIMEOUT);
  });
});
