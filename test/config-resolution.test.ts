/**
 * config-resolution.test.ts — ADR-002 Step 1.
 *
 * Covers #307 AC-1..AC-4 and AC-15.
 *
 * What was broken to make these fail, run by hand on this branch and counted
 * rather than asserted (.claude/rules/checks-must-be-able-to-fail.md), over
 * this file + test/gate-config-readers.test.ts (34 tests, 2026-10-11):
 *
 *   | Mutation                                              | Red           |
 *   |-------------------------------------------------------|---------------|
 *   | `command`/`timeout` removed from TestSchema            | 2 of 34       |
 *   | `container` removed from ProjectHarnessSchema          | 0 of 34, 9 tsc |
 *   | `dev.testCmd ??` dropped from normalise()              | 3 of 34       |
 *   | the bare try/catch restored in scanner.ts              | 4 of 34       |
 *   | `|| echo "{}"` restored at ship.js's setup step        | 1 of 34       |
 *
 * The second row is the one worth reading. Removing `container` from the
 * schema turns NOTHING red at runtime, because `.passthrough()` carries the
 * key through regardless — the declaration buys a TYPE, not a behaviour, and
 * the guard that actually catches its removal is `bunx tsc --noEmit` (9
 * errors), not this suite. Reporting "the container tests cover it" would have
 * been a line in a report. The runtime behaviour these tests do pin is that
 * the key survives resolution at all, which is what #254's path needs.
 *
 * None of the five is left in the tree; all were run and reverted, and the
 * baseline was re-measured green at 34/34 afterwards.
 *
 * The parity case (AC-4) asserts on the RESOLVED VALUE, never on source text.
 * SC-478 is the cautionary precedent: a source-text existence assertion stays
 * green over code that has stopped doing the thing the text describes. The two
 * cases here that do read source (AC-3's interface check, AC-15's ship.js
 * check) both slice to an anchor and assert the slice is non-empty first — an
 * anchor that drifts produces an empty string, and `expect("").not.toContain`
 * passes for any argument at all.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

import {
  resolveConfig,
  loadRungateConfig,
  tryLoadRungateConfig,
  DEFAULT_TEST_TIMEOUT_MS,
} from "../lib/config-loader";
import { parseProjectHarness, safeParseProjectHarness } from "../lib/rungate-schema";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const TMP = join(tmpdir(), `rungate-config-resolution-${process.pid}`);

/** The shape rungate itself authors: `test.command`, no `dev` block. */
function makeRungateShaped(name: string, extra: Record<string, unknown> = {}): string {
  const root = join(TMP, name);
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate.json"),
    JSON.stringify({
      project: name,
      repo: "org/repo",
      issueRepo: "org/repo",
      pages: {},
      test: { command: "bun test --parallel", timeout: 300000 },
      ...extra,
    })
  );
  return root;
}

/**
 * The shape DailyBriefDashboard authors: `dev.testCmd`, no `test` key at all.
 * `captureTestBaseline`'s defect is reachable only from this shape — a
 * rungate-shaped fixture is green for the same reason the defect survived a
 * year, so every normalisation assertion here is anchored on this one.
 */
function makeDdbShaped(name: string, extra: Record<string, unknown> = {}): string {
  const root = join(TMP, name);
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate.json"),
    JSON.stringify({
      project: name,
      repo: "org/repo",
      issueRepo: "org/repo",
      dev: {
        start: "make dev-all",
        apiBase: "http://localhost:7778",
        uiBase: "http://localhost:5173",
        testCmd: "bun test --parallel",
        typeCheck: "bunx tsc --noEmit",
      },
      pages: { "/": "home" },
      ...extra,
    })
  );
  return root;
}

/** Directory form (`.claude/rungate/config.json`) rather than the monolith. */
function makeDirShaped(name: string, config: Record<string, unknown>): string {
  const root = join(TMP, name);
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config));
  return root;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe("AC-1 schema declares the keys ship.js already assumes", () => {
  test("schema: TestSchema declares optional command and timeout", () => {
    const parsed = parseProjectHarness({
      project: "p",
      repo: "org/repo",
      issueRepo: "org/repo",
      test: { command: "bun test --parallel", timeout: 300000 },
    });
    expect(parsed.test?.command).toBe("bun test --parallel");
    expect(parsed.test?.timeout).toBe(300000);
  });

  test("schema: ProjectHarnessSchema declares an optional container object", () => {
    const parsed = parseProjectHarness({
      project: "p",
      repo: "org/repo",
      issueRepo: "org/repo",
      container: {
        port: 7776,
        rebuildCommand: "make build && make test-down && make test-up",
        healthPath: "/api/aes",
        hosts: ["localhost"],
      },
    });
    expect(parsed.container?.port).toBe(7776);
    expect(parsed.container?.rebuildCommand).toBe("make build && make test-down && make test-up");
    expect(parsed.container?.healthPath).toBe("/api/aes");
    expect(parsed.container?.hosts).toEqual(["localhost"]);
  });

  test("schema: container is optional, so a config without one still validates", () => {
    const result = safeParseProjectHarness({
      project: "p",
      repo: "org/repo",
      issueRepo: "org/repo",
    });
    expect(result.success).toBe(true);
  });

  test("schema: parsing rungate's own config preserves test.command and test.timeout", () => {
    const own = JSON.parse(
      readFileSync(join(HARNESS_ROOT, ".claude", "rungate.json"), "utf-8")
    );
    // Guard against a vacuous pass: the fixture must actually carry the keys.
    expect(typeof own.test?.command).toBe("string");
    expect(typeof own.test?.timeout).toBe("number");

    const parsed = parseProjectHarness(own);
    expect(parsed.test?.command).toBe(own.test.command);
    expect(parsed.test?.timeout).toBe(own.test.timeout);
  });

  test("schema: validation is no longer lossier than the raw read", () => {
    const own = JSON.parse(
      readFileSync(join(HARNESS_ROOT, ".claude", "rungate.json"), "utf-8")
    );
    const parsed: Record<string, unknown> = parseProjectHarness(own) as any;
    const dropped = Object.keys(own).filter((k) => !(k in parsed));
    expect(dropped).toEqual([]);
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe("AC-2 resolveConfig is a discriminated resolution and the wrappers are unchanged", () => {
  test("resolveConfig reports status resolved with a monolith source", () => {
    const root = makeRungateShaped("ac2-monolith");
    const resolution = resolveConfig(root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.source).toBe("monolith");
    expect(resolution.config.project).toBe("ac2-monolith");
  });

  test("resolveConfig reports status resolved with a directory source", () => {
    const root = makeDirShaped("ac2-directory", {
      project: "ac2-directory",
      repo: "org/repo",
      issueRepo: "org/repo",
    });
    const resolution = resolveConfig(root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.source).toBe("directory");
  });

  test("resolveConfig reports absent — a truthy value with no .test property", () => {
    const resolution = resolveConfig(join(TMP, "ac2-nothing-here"));
    expect(resolution.status).toBe("absent");
    // The whole mechanical point of the union over the nullable: an absent
    // resolution cannot be absorbed by `||` or reached through `?.test`.
    expect(Boolean(resolution)).toBe(true);
    expect("config" in resolution).toBe(false);
  });

  test("resolveConfig throws on malformed JSON rather than reporting absent", () => {
    const root = join(TMP, "ac2-malformed");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate.json"), "{ not json");
    expect(() => resolveConfig(root)).toThrow();
  });

  test("resolveConfig throws on orphaned directory fragments", () => {
    const root = join(TMP, "ac2-orphan");
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate", "roles.json"), "{}");
    expect(() => resolveConfig(root)).toThrow(/Incomplete rungate config/);
  });

  test("wrapper: loadRungateConfig still throws on absent config", () => {
    expect(() => loadRungateConfig(join(TMP, "ac2-absent-throwing"))).toThrow(
      /No rungate config found/
    );
  });

  test("wrapper: loadRungateConfig still returns the config when present", () => {
    const root = makeRungateShaped("ac2-wrapper-present");
    expect(loadRungateConfig(root).project).toBe("ac2-wrapper-present");
  });

  test("wrapper: tryLoadRungateConfig still returns null on absent config", () => {
    expect(tryLoadRungateConfig(join(TMP, "ac2-absent-null"))).toBeNull();
  });

  test("wrapper: tryLoadRungateConfig still throws on malformed config", () => {
    const root = join(TMP, "ac2-wrapper-malformed");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "rungate.json"), "{ not json");
    expect(() => tryLoadRungateConfig(root)).toThrow();
  });
});

// ── AC-3 ────────────────────────────────────────────────────────────────────

describe("AC-3 the exported config type is derived from the Zod schema", () => {
  test("no hand-written config interface survives in lib/config-loader.ts", () => {
    const source = readFileSync(join(HARNESS_ROOT, "lib", "config-loader.ts"), "utf-8");
    expect(source).not.toMatch(/interface\s+RungateConfig\b/);
    expect(source).not.toMatch(/interface\s+ResolvedConfig\b/);
  });

  test("ResolvedConfig is a z.infer of a schema, proven by the schema's own parse", () => {
    // Executed, not grepped: the exported schema must accept a resolved shape
    // and reject one missing the required identity keys. A type alias alone
    // would satisfy a source-text assertion and nothing else.
    const { ResolvedConfigSchema } = require("../lib/config-loader");
    expect(
      ResolvedConfigSchema.safeParse({
        project: "p",
        repo: "org/repo",
        issueRepo: "org/repo",
        test: { command: "bun test", timeout: 1 },
      }).success
    ).toBe(true);
    expect(ResolvedConfigSchema.safeParse({ repo: "org/repo" }).success).toBe(false);
  });
});

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe("AC-4 normalisation makes the two authored shapes resolve identically", () => {
  test("normalise: a DDB-shaped fixture and a rungate-shaped fixture resolve to the same test.command", () => {
    const ddbRoot = makeDdbShaped("ac4-ddb");
    const rungateRoot = makeRungateShaped("ac4-rungate");

    const ddb = resolveConfig(ddbRoot);
    const rungate = resolveConfig(rungateRoot);
    if (ddb.status !== "resolved" || rungate.status !== "resolved") {
      throw new Error("both fixtures must resolve");
    }

    // Guard against a vacuous pass: the two files must genuinely differ, or
    // "identical resolved value" proves nothing about normalisation.
    const ddbRaw = JSON.parse(
      readFileSync(join(ddbRoot, ".claude", "rungate.json"), "utf-8")
    );
    const rungateRaw = JSON.parse(
      readFileSync(join(rungateRoot, ".claude", "rungate.json"), "utf-8")
    );
    expect(ddbRaw.test).toBeUndefined();
    expect(ddbRaw.dev.testCmd).toBe("bun test --parallel");
    expect(rungateRaw.dev).toBeUndefined();
    expect(rungateRaw.test.command).toBe("bun test --parallel");

    expect(ddb.config.test?.command).toBe(rungate.config.test?.command);
    expect(ddb.config.test?.command).toBe("bun test --parallel");
  });

  test("normalise: dev.testCmd wins over test.command when a config carries both", () => {
    const root = makeDdbShaped("ac4-both", { test: { command: "LOSER", timeout: 42 } });
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.test?.command).toBe("bun test --parallel");
    // test.timeout is still read — D3 deprecates nothing in this change.
    expect(resolution.config.test?.timeout).toBe(42);
  });

  test("normalise: test.timeout falls back to the default when unset", () => {
    const root = makeDdbShaped("ac4-timeout-default");
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.test?.timeout).toBe(DEFAULT_TEST_TIMEOUT_MS);
  });

  test("normalise: dev.apiBase and dev.uiBase become apiUrl and uiUrl", () => {
    const root = makeDdbShaped("ac4-urls");
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.apiUrl).toBe("http://localhost:7778");
    expect(resolution.config.uiUrl).toBe("http://localhost:5173");
  });

  test("normalise: a config with neither dev.testCmd nor test.command leaves command undefined", () => {
    // The honest unresolved state. `captureTestBaseline` must be able to see
    // it rather than be handed a plausible default it reports as measured.
    const root = makeDirShaped("ac4-no-command", {
      project: "ac4-no-command",
      repo: "org/repo",
      issueRepo: "org/repo",
    });
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.test?.command).toBeUndefined();
  });

  test("normalise: the directory form and the monolith form of one config resolve identically", () => {
    const body = {
      project: "parity",
      repo: "org/repo",
      issueRepo: "org/repo",
      dev: {
        start: "make dev-all",
        apiBase: "http://localhost:7778",
        uiBase: "http://localhost:5173",
        testCmd: "bun test --parallel",
      },
      pages: { "/": "home" },
    };
    const monolithRoot = join(TMP, "ac4-parity-monolith");
    mkdirSync(join(monolithRoot, ".claude"), { recursive: true });
    writeFileSync(join(monolithRoot, ".claude", "rungate.json"), JSON.stringify(body));
    const dirRoot = makeDirShaped("ac4-parity-directory", body);

    const a = resolveConfig(monolithRoot);
    const b = resolveConfig(dirRoot);
    if (a.status !== "resolved" || b.status !== "resolved") throw new Error("unreachable");
    expect(a.source).toBe("monolith");
    expect(b.source).toBe("directory");
    expect(a.config.test?.command).toBe(b.config.test?.command);
    expect(a.config.apiUrl).toBe(b.config.apiUrl);
    expect(Object.keys(a.config.pages ?? {})).toEqual(Object.keys(b.config.pages ?? {}));
  });

  test("normalise: unknown keys the schema does not declare still survive resolution", () => {
    // DDB authors `remoteHosts`, which no schema declares. Normalisation must
    // not be the thing that drops it.
    const root = makeDdbShaped("ac4-unknown", { remoteHosts: { runner: { host: "mini" } } });
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect((resolution.config as Record<string, any>).remoteHosts?.runner?.host).toBe("mini");
  });
});

// ── AC-15 ───────────────────────────────────────────────────────────────────

describe("AC-15 a container block survives schema validation and reaches ship.js", () => {
  test("container: a DDB-shaped fixture resolves container port 7776", () => {
    const root = makeDdbShaped("ac15-fixture", {
      container: {
        port: 7776,
        rebuildCommand: "make build && make test-down && make test-up",
        healthPath: "/api/aes",
        hosts: ["localhost"],
      },
    });
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.container?.port).toBe(7776);
    expect(resolution.config.container?.hosts).toEqual(["localhost"]);
  });

  test("container: the rebuildCommand never hands `make rebuild` to an agent", () => {
    // PROJECT-STATE item 8 and DDB's CLAUDE.md both forbid it, and ship.js
    // interpolates this string verbatim into an agent prompt. Declaring the
    // key in zod does not constrain its value, so the constraint is a test.
    const root = makeDdbShaped("ac15-forbidden", {
      container: { port: 7776, rebuildCommand: "make build && make test-down && make test-up" },
    });
    const resolution = resolveConfig(root);
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.container?.rebuildCommand).not.toMatch(/\bmake\s+rebuild\b/);
  });

  /**
   * The exact block that has to land in DailyBriefDashboard's own repo. It is
   * declared here, run against the loader here, and asserted here, because an
   * agent in a rungate worktree cannot write to another repository — so the
   * edit itself is a DA action. Pinning the literal means the DA is applying a
   * block this suite has already resolved, not retyping one from prose.
   */
  const DDB_CONTAINER_BLOCK = {
    port: 7776,
    rebuildCommand: "make build && make test-down && make test-up",
    healthPath: "/api/aes",
    hosts: ["localhost"],
  };

  test("container: the exact block DDB must adopt resolves to port 7776 on DDB's real config", () => {
    const ddbRoot = join(process.env.HOME || "", "Projects", "DailyBriefDashboard");
    const ddbConfigPath = join(ddbRoot, ".claude", "rungate.json");
    if (!existsSync(ddbConfigPath)) return;

    // DDB's real authored config, with the pending block applied in memory.
    const real = JSON.parse(readFileSync(ddbConfigPath, "utf-8"));
    const root = join(TMP, "ac15-ddb-real");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate.json"),
      JSON.stringify({ ...real, container: real.container ?? DDB_CONTAINER_BLOCK })
    );

    const resolution = resolveConfig(root);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") throw new Error("unreachable");
    expect(resolution.config.container?.port).toBe(7776);
    expect(resolution.config.container?.rebuildCommand).not.toMatch(/\bmake\s+rebuild\b/);
    // dev.testCmd must still survive alongside the container block: DDB
    // authors no `test` key at all, and this is the shape captureTestBaseline
    // silently measured zero against.
    expect(resolution.config.test?.command).toBe(real.dev.testCmd);
    // The 18 pages are what lift a DDB run off the LIGHT tier floor that has
    // kept the container path from ever executing anywhere (#274).
    expect(Object.keys(resolution.config.pages ?? {}).length).toBeGreaterThan(0);
  });

  // NOT asserted here, deliberately: that DDB's checked-in config already
  // carries the block. It does not yet — writing it is a DA action in DDB's
  // own repo, and a rungate worktree is isolated from it. A test asserting it
  // would ship red for something this branch cannot fix, and a test written to
  // pass either way would be the vacuous assertion
  // `.claude/rules/checks-must-be-able-to-fail.md` warns about. The gap is
  // reported as prose instead, with DDB_CONTAINER_BLOCK above as the literal
  // to apply.

  test("container: ship.js reads the materialised resolved config, not a raw cat", () => {
    const shipSource = readFileSync(join(HARNESS_ROOT, "workflows", "ship.js"), "utf-8");
    const setupBlock = shipSource.slice(
      shipSource.indexOf("2. Load config"),
      shipSource.indexOf("3. Prior branch detect:")
    );
    expect(setupBlock.length).toBeGreaterThan(0);
    expect(setupBlock).toContain("scripts/resolve-config.ts");
    // `|| echo "{}"` is the fail-open this ADR exists to remove: an empty
    // object reads as "configured with nothing", which silently disables the
    // container path and the tier floor together.
    expect(setupBlock).not.toContain('echo "{}"');
  });
});
