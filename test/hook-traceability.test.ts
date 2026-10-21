import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { loadRungateConfig } from "../lib/config-loader";

const HARNESS_ROOT = resolve(import.meta.dir, "..");

/**
 * #898 — five `at least 14` floors stood in for one agreement between four
 * positions, and a floor cannot witness an addition.
 *
 * Measured as #879's battery row M10: deleting the newly added `HookCurrency`
 * row from the spec table was **0 red across 92 tests**, while the same hook's
 * `.claude/settings.json`, `.claude/rungate/hooks.json` and hook-file-comment
 * positions were each 1 red. Three of Tier 2's four positions were enforced
 * generally; the fourth was enforced only for whichever fourteen hooks existed
 * when the number was written.
 *
 * What the census found the moment it was pointed at the real populations
 * (2026-10-21), none of which any floor could see:
 *
 *   19 hook files on disk
 *   17 registry entries   — ProjectStateSync and TestSuiteRelease are in NO registry
 *   17 spec table rows    — BashToolGuard and ProjectStateSync have no row
 *   16 monolith entries   — which is what this file USED to read, one release stale
 *
 * That last line is its own defect and is why the registry reading now goes
 * through `loadRungateConfig` (`.claude/rules/config-access.md`: never read
 * only `.claude/rungate.json`). This file hardcoded the monolith, so #879's
 * hook was invisible to it — the floor was green over a population that did
 * not contain the thing most recently added to the repo.
 */

/** The declaration. Everything else is a position that must agree with it. */
const HOOK_FILES = readdirSync(join(HARNESS_ROOT, "hooks"))
  .filter(f => f.endsWith(".hook.ts"))
  .sort();

/**
 * The hook file a row or a registry entry names — ONE binding, so there is one
 * thing to mutate. A second extractor would survive any mutation of the first
 * and the agreement would hold up on whichever copy was not broken.
 */
function namedHookFile(text: unknown): string | null {
  return String(text).match(/([A-Za-z0-9_-]+\.hook\.ts)/)?.[1] ?? null;
}

/**
 * A hook that is deliberately not registered says so IN ITS OWN HEADER.
 *
 * Caller-owned on purpose. A central allowlist of exempt files becomes
 * evidence those files are referenced, and then the orphan checks that read
 * references go green because of the exemption list itself — this repo has
 * been bitten by that shape, so the declaration lives with the thing it is
 * about and travels when the file moves.
 */
const UNREGISTERED_MARKER = "NOT REGISTERED";

const unregisteredDeclaration = (file: string): string | null => {
  const content = readFileSync(join(HARNESS_ROOT, "hooks", file), "utf-8");
  const line = content.split("\n").find(l => l.includes(UNREGISTERED_MARKER));
  return line ? line.trim() : null;
};

describe("#898: the four hook positions agree, named rather than counted", () => {
  test("AC-1: the declaration is non-empty", () => {
    // The anchor. Every agreement below is an equality against this list, and
    // two empty sets are perfectly equal — if the directory read silently
    // returned nothing, every other case here would pass having compared
    // nothing to nothing (#621).
    expect(HOOK_FILES.length, "no hook files were read at all").toBeGreaterThan(0);
  });

  test("AC-2: every hook file has a spec table row, and every row a file", () => {
    // The two directions are one claim and are asserted as one: a floor could
    // not see an addition, and it could not see a DELETION either — a hook
    // removed from `hooks/` leaves a stale row and the count still clears.
    expect(specTableHooks().sort()).toEqual(HOOK_FILES);
  });

  test("AC-3: every registry entry names a hook file that exists", () => {
    const missing = registryHooks().filter(h => !HOOK_FILES.includes(h));
    expect(missing, "the registry names hooks that are not on disk").toEqual([]);
  });

  test("AC-4: every hook file is registered, or says why it is not", () => {
    // NOT a count and NOT an allowlist. Registering a hook makes it RUN, so
    // which hooks should be registered is a behavioural decision this census
    // does not get to make — what it can refuse is a hook being absent from
    // every registry with nobody having said so.
    const registered = registryHooks();
    const silent = HOOK_FILES.filter(
      f => !registered.includes(f) && !unregisteredDeclaration(f),
    );
    expect(
      silent,
      `unregistered and undeclared — register it, or write a "${UNREGISTERED_MARKER}" line in its header saying why not`,
    ).toEqual([]);
  });

  test("AC-5: a registered hook does not also declare itself unregistered", () => {
    // The mirror, and the thing that stops AC-4's declaration becoming a
    // permanent waiver: once a hook IS registered its declaration is stale,
    // and a stale declaration would keep satisfying AC-4 if it were ever
    // deregistered again, which is the state AC-4 exists to catch.
    const registered = registryHooks();
    const contradictory = HOOK_FILES.filter(
      f => registered.includes(f) && unregisteredDeclaration(f),
    );
    expect(contradictory, "a registered hook still carries its unregistered declaration").toEqual([]);
  });

  test("AC-6: each declaration gives a reason, not just the marker", () => {
    // A bare marker is a waiver nobody has to justify, which is a warning
    // nobody reads. The same rule `verify-merge-content` applies to `--accept`.
    for (const file of HOOK_FILES) {
      const line = unregisteredDeclaration(file);
      if (!line) continue;
      expect(
        line.replace(UNREGISTERED_MARKER, "").replace(/[^A-Za-z]/g, "").length,
        `${file} declares itself unregistered with no reason`,
      ).toBeGreaterThan(20);
    }
  });
});

/** Rows of the spec's current-state table, as the hook files they name. */
function specTableHooks(): string[] {
  const spec = readFileSync(join(HARNESS_ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md"), "utf-8");
  const rows = spec.split("\n").filter(l => l.startsWith("| ") && l.includes(".hook.ts"));
  // A table that stopped matching is an empty list, and an empty list agrees
  // with nothing — so the reading refuses rather than returning it.
  expect(rows.length, "no rows were read from the spec current-state table").toBeGreaterThan(0);
  return rows.map(namedHookFile).filter((h): h is string => h !== null);
}

/**
 * The registry, through the ONE loader.
 *
 * Never a hardcoded `.claude/rungate.json`: both layouts are supported, this
 * repo is on the directory layout, and the hardcoded read is what made #879's
 * hook invisible here (`.claude/rules/config-access.md`).
 */
function registryHooks(): string[] {
  const hooks = (loadRungateConfig(HARNESS_ROOT) as { hooks: unknown[] }).hooks;
  expect(hooks.length, "the loader resolved no hook entries at all").toBeGreaterThan(0);
  return hooks.map(h => namedHookFile((h as any)?.command ?? h)).filter((h): h is string => h !== null);
}

describe("Hook SC Traceability (SC-370)", () => {
  const hooksDir = join(HARNESS_ROOT, "hooks");
  const hookFiles = HOOK_FILES;

  for (const file of hookFiles) {
    test(`${file} contains SC- reference`, () => {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const hasSC = /SC-\d+/.test(content);
      expect(hasSC).toBe(true);
    });
  }
});

describe("Hook config in the resolved registry (SC-391, SC-392)", () => {
  // Through the loader, not a hardcoded path — see registryHooks above.
  const entries = (loadRungateConfig(HARNESS_ROOT) as { hooks: any[] }).hooks;

  test("the registry resolves a hooks array", () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length, "no hook entries resolved").toBeGreaterThan(0);
  });

  test("EVERY hook entry has hookFor and command fields (SC-391)", () => {
    // `>= 14` of N passes while N-14 entries are malformed. The claim was
    // always "every", so it is asserted as every, and the failure NAMES the
    // entries rather than reporting that a count was short.
    const bad = entries.filter(h => !h?.hookFor || !h?.command).map(h => h?.name ?? JSON.stringify(h));
    expect(bad, "hook entries missing hookFor or command").toEqual([]);
  });

  test("EVERY hook entry has an enabled field (SC-392)", () => {
    const bad = entries.filter(h => !(h && "enabled" in h)).map(h => h?.name ?? JSON.stringify(h));
    expect(bad, "hook entries missing enabled").toEqual([]);
  });
});

describe("HOOK-ARCHITECTURE-SPEC current state table (SC-370)", () => {
  const specPath = join(HARNESS_ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md");
  const specContent = readFileSync(specPath, "utf-8");

  const tableLines = specContent
    .split("\n")
    .filter(line => line.startsWith("| ") && line.includes(".hook.ts"));

  // The count floor that used to live here is gone: AC-2 above asserts the
  // table names exactly the hooks on disk, which is the agreement the floor
  // was standing in for and is the thing a floor structurally cannot check.

  test("every hook row in spec table has an SC reference", () => {
    expect(tableLines.length, "no table rows were read").toBeGreaterThan(0);
    for (const line of tableLines) {
      expect(line).toMatch(/SC-\d+/);
    }
  });
});

describe("Hook line count limits (SC-367, SC-371)", () => {
  const hooksDir = join(HARNESS_ROOT, "hooks");

  test("AgentBriefGuard.hook.ts is under 50 lines (SC-367)", () => {
    const content = readFileSync(join(hooksDir, "AgentBriefGuard.hook.ts"), "utf-8");
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeLessThan(50);
  });

  test("no hook file exceeds 150 lines (SC-371)", () => {
    const hookFiles = readdirSync(hooksDir).filter(f => f.endsWith(".hook.ts"));
    for (const file of hookFiles) {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(150);
    }
  });
});
