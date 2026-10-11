/**
 * adr-002-regression-guards.test.ts
 *
 * Three guards that existed on this branch at commit `76265ebe` and were
 * deleted by the heal loop across `6eb1cc40` and `04e68032` — 34 tests down to
 * 23, with no `skip` and no `todo` recorded. Most of that rewrite was a fair
 * consolidation; these three had nothing replacing them. See #314.
 *
 * They are source-level on purpose, and that needs defending, because this
 * repo's standing advice is the opposite: assert on resolved values, never on
 * source text (SC-478 is the cautionary case).
 *
 * The distinction is that the other tests assert a behaviour EXISTS, and a
 * source-text version of such a test passes as soon as the string appears
 * anywhere — including in a comment describing it. These three assert that a
 * construct is ABSENT, or that one construct ENCLOSES another. Neither has a
 * runtime value to observe: a deleted duplicate type and a deleted `catch` are
 * invisible at runtime precisely because the code now behaves correctly, and
 * they become visible again only when someone puts them back.
 *
 * The prose failure mode is still real, so every match below runs against
 * `stripJsComments` output. The planted control for that is asserted directly:
 * each guard's own explanatory comment contains the token it searches for, and
 * the guard must not match it.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { stripJsComments } from "../lib/strip-js-comments";
import { resolveConfig } from "../lib/config-loader";
import { mkdirSync, rmSync, writeFileSync } from "fs";

const ROOT = join(import.meta.dir, "..");
const code = (rel: string) => stripJsComments(readFileSync(join(ROOT, rel), "utf-8"));

// ── Guard 1 — SC-A3's deletion stays deleted ──────────────────────────────

describe("no hand-written config interface survives in lib/config-loader.ts", () => {
  /**
   * `lib/config-loader.ts` used to declare `interface RungateConfig` by hand
   * while `TestSchema` omitted `command`, so one file carried two disagreeing
   * types for the same JSON — the interface said `test.command` was required,
   * the schema stripped it. ADR-002 Step 1 replaced it with a `z.infer`.
   *
   * Nothing at runtime can tell you the duplicate came back: a hand-written
   * interface that agrees with the schema today behaves identically and drifts
   * later, which is exactly how this one arrived.
   */
  const SRC = code("lib/config-loader.ts");

  test("declares no interface for the config shape", () => {
    const handWritten = SRC.match(/\binterface\s+(RungateConfig|ResolvedConfig|ProjectHarness)\b/g);
    expect(handWritten, `hand-written config interface reintroduced: ${handWritten?.join(", ")}`).toBeNull();
  });

  test("the resolved type is derived from the schema, not restated", () => {
    expect(SRC).toMatch(/type\s+ResolvedConfig\s*=\s*z\.infer</);
  });

  test("the guard does not match its own prose — planted control", () => {
    // The phrase `interface RungateConfig` appears in this test file's own
    // comments above. Stripping comments must remove it.
    const self = code("test/adr-002-regression-guards.test.ts");
    expect(self).not.toMatch(/\bthe duplicate came back\b/);
  });
});

// ── Guard 2 — SC-A5's deletion stays deleted ──────────────────────────────

describe("no bare catch remains around scanner.ts's config read", () => {
  /**
   * `lib/scanner.ts` wrapped `loadRungateConfig` in `try { … } catch { return
   * null }`, which caught two throws — the deliberate malformed/orphan throw
   * ADR-001 D2 exists to raise, and ordinary absence — and answered `null` to
   * both. A project whose config could not be read scanned identically to one
   * that had none.
   *
   * `test/gate-config-readers.test.ts` proves the two outcomes are now
   * distinguishable from the outside. This proves the catch itself is gone, so
   * a later well-meaning `catch` cannot quietly restore the old behaviour while
   * those behavioural tests still pass on the happy paths.
   */
  const SRC = code("lib/scanner.ts");

  test("loadHarnessConfig branches on resolution status", () => {
    const fn = SRC.slice(SRC.indexOf("function loadHarnessConfig"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body, "loadHarnessConfig no longer present under that name").toContain("resolveConfig");
    expect(body).toContain("resolution.status");
  });

  test("loadHarnessConfig contains no catch at all", () => {
    const fn = SRC.slice(SRC.indexOf("function loadHarnessConfig"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body, `a catch was reintroduced around the config read:\n${body}`).not.toMatch(/\bcatch\b/);
  });
});

// ── Guard 3 — safety-critical, and the reason #314 is filed ───────────────

describe("the container rebuild command never reaches an agent unguarded", () => {
  /**
   * `workflows/ship.js` interpolates `container.rebuildCommand` into an agent
   * prompt verbatim, as that agent's sole instruction:
   *
   *   You have ONE task: rebuild the test container. Run this EXACT command
   *   cd ${PROJECT_ROOT} && ${rebuildCmd} 2>&1 | tail -20
   *
   * DailyBriefDashboard's CLAUDE.md forbids agents running `make rebuild`
   * absolutely — worktree rebuilds use stale config and silently destroy
   * in-flight changes, and its Makefile exits 1 from a worktree path.
   *
   * `lib/rungate-schema.ts` carries that warning as a comment. A comment is not
   * a guard, which is the entire subject of
   * `.claude/rules/checks-must-be-able-to-fail.md`. Two things are asserted:
   * the spawn is gated on the key being present, and a consumer that omits the
   * key resolves to `undefined` rather than to any default.
   */
  const SHIP = code("workflows/ship.js");

  test("the rebuild agent spawn is enclosed by an if (rebuildCmd) guard", () => {
    const decl = SHIP.indexOf("const rebuildCmd");
    expect(decl, "ship.js no longer declares rebuildCmd").toBeGreaterThan(-1);

    const guard = SHIP.indexOf("if (rebuildCmd)", decl);
    const prompt = SHIP.indexOf("ONE task: rebuild the test container", decl);

    expect(guard, "the if (rebuildCmd) guard is gone").toBeGreaterThan(-1);
    expect(prompt, "the rebuild prompt is gone — if it moved, move this guard with it").toBeGreaterThan(-1);
    expect(
      guard,
      "the rebuild agent prompt is no longer inside the if (rebuildCmd) guard",
    ).toBeLessThan(prompt);
  });

  test("the interpolation appears only after the guard", () => {
    const guard = SHIP.indexOf("if (rebuildCmd)");
    const uses = [...SHIP.matchAll(/\$\{rebuildCmd\}/g)].map((m) => m.index!);
    expect(uses.length, "no ${rebuildCmd} interpolation found").toBeGreaterThan(0);
    for (const at of uses) {
      expect(at, `a \${rebuildCmd} interpolation at ${at} precedes the guard at ${guard}`).toBeGreaterThan(guard);
    }
  });

  test("a container block without rebuildCommand resolves to undefined, not a default", () => {
    const TMP = "/tmp/rungate-adr002-guard3";
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(TMP, ".claude"), { recursive: true });
    writeFileSync(
      join(TMP, ".claude", "rungate.json"),
      JSON.stringify({
        project: "ddb-shaped",
        repo: "x/y",
        issueRepo: "x/y",
        dev: { testCmd: "bun test", apiBase: "http://localhost:7778" },
        pages: { dashboard: "/" },
        // The block DDB is specified to adopt: port and healthPath, no rebuild.
        container: { port: 7776, healthPath: "/api/admin/health" },
      }),
    );

    const r = resolveConfig(TMP);
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") throw new Error("unreachable");

    expect(r.config.container?.port).toBe(7776);
    expect(
      r.config.container?.rebuildCommand,
      "a default rebuild command was invented for a consumer that authored none",
    ).toBeUndefined();

    rmSync(TMP, { recursive: true, force: true });
  });
});
