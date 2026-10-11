/**
 * #274 Phase 1 — the consumer-UI fixture, and ship.js's tier chain run over it.
 *
 * Every self-run rungate has ever made was rewritten to LIGHT. rungate's own
 * `.claude/rungate/config.json` declares `"pages": {}`, so `hasUI` is false, so
 * the downgrade in `workflows/ship.js` fires and five tier-gated subsystems
 * never execute. A consumer that declares pages takes the other branch, and
 * until this fixture nothing in this repo stood in for one.
 *
 * Three things make this a measurement rather than a restatement:
 *
 * - The fixture is read through `lib/config-loader.ts` and `gates/schema.ts` —
 *   the harness's own readers. A `JSON.parse` here would assert that a file
 *   contains what I typed into it, which is true of every file.
 * - The tier statements are SLICED OUT OF ship.js AND EXECUTED, by
 *   `test/helpers/consumer-ship-sites.ts`. Asserting that ship.js "contains
 *   ceremonyTierFloor" stays green after the call is reduced to a comment —
 *   the failure mode `.claude/rules/checks-must-be-able-to-fail.md` exists for.
 * - The same extracted chain is run twice over inputs differing in `pages`
 *   alone. Without the second run, an extractor that always answered STANDARD
 *   would be indistinguishable from a tier chain that works.
 *
 * ship.js is resolved from this file's own directory, never from HARNESS_ROOT:
 * under worktree isolation that variable can name a different checkout than the
 * one being graded (#190).
 *
 * What was broken to prove these can fail, run and counted rather than asserted
 * (none left in the tree; every mutation was run and reverted):
 *
 * | Mutation | Red |
 * |---|---|
 * | ship.js's floor return reduced to `return tier` | 1 of 23 here, and 6 of 31 in `test/ship-ceremony-tier-floor.test.ts` |
 * | the `ceremonyTierFloor(` call site renamed in ship.js | 11 of 23 — every case that extracts, each throwing "appears 0 times" |
 * | the fixture cut from four pages to two | 1 of 23 — the page count; the tier still resolves, which is why the count is its own assertion |
 * | the fixture's `pages` emptied to `{}` | 4 of 23 — the count, the STANDARD resolution, the pages-only-difference check and the raise-never-lowers check |
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { WorkflowStateSchema } from "../gates/schema";
import { loadRungateConfig, tryLoadRungateConfig } from "../lib/config-loader";
import {
  CONSUMER_FIXTURE_ROOT,
  REPO_ROOT,
  TIER_SITES,
  countOccurrences,
  loadConsumerFixture,
  namedShipSites,
  runHasUIACs,
  runTierChain,
  scanExpectActuals,
  shipSource,
  tierChainSlices,
  tierChainSource,
} from "./helpers/consumer-ship-sites";

const fixture = loadConsumerFixture();
const fixtureConfig = fixture.config;
const fixtureRaw = fixture.raw;
const fixtureState = fixture.state;

// ── AC-1: the fixture, read back through the harness's own readers ────────

describe("#274 AC-1: the consumer fixture loads through the harness's own readers", () => {
  test("it is on the CONSUMER form — a monolith, with no config.json to shadow it", () => {
    // The monolith branch of `resolveRungateConfig` is not a legacy path: it is
    // the shape every project rungate ships into uses. Asserting the directory
    // marker is ABSENT is what proves the monolith branch is the one that ran.
    expect(existsSync(join(CONSUMER_FIXTURE_ROOT, ".claude", "rungate", "config.json"))).toBe(false);
    expect(existsSync(join(CONSUMER_FIXTURE_ROOT, ".claude", "rungate.json"))).toBe(true);
    expect(tryLoadRungateConfig(CONSUMER_FIXTURE_ROOT)).not.toBeNull();
  });

  test("the loaded config declares four distinct pages", () => {
    const pages = fixtureConfig.pages as Record<string, string>;
    const routes = Object.keys(pages);
    expect(routes.length).toBe(4);
    // Distinct, non-empty routes: three copies of one entry is one page wearing
    // a count, and `hasUI` would read it as three.
    expect(new Set(routes).size).toBe(4);
    for (const route of routes) {
      expect(route.startsWith("/")).toBe(true);
      expect(String(pages[route]).length).toBeGreaterThan(0);
    }
  });

  test("the container block carries an INERT rebuild command", () => {
    // SC-6: nothing this issue adds may run, schedule or instruct an agent to
    // run `make rebuild` or a raw podman/docker command. The fixture has to
    // carry a container to exercise the container-verify site, so the command
    // it carries is asserted to be incapable of rebuilding anything.
    const container = fixtureRaw.container as Record<string, unknown>;
    expect(container).toBeDefined();
    const rebuild = container.rebuildCommand;
    expect(typeof rebuild).toBe("string");
    expect(String(rebuild).length).toBeGreaterThan(0);
    for (const forbidden of [/\bmake\b/, /\bpodman\b/, /\bdocker\b/, /\bsudo\b/, /\bsystemctl\b/, /\bssh\b/]) {
      expect(String(rebuild)).not.toMatch(forbidden);
    }
    expect(Array.isArray(container.hosts)).toBe(true);
    expect(typeof container.port).toBe("number");
    expect(typeof container.healthPath).toBe("string");
  });

  test("no value anywhere in the fixture can rebuild a container", () => {
    // The whole file, not just the one key: a `prod.rebuild` of `make rebuild`
    // would satisfy the check above and still be the thing SC-6 forbids.
    const whole = readFileSync(join(CONSUMER_FIXTURE_ROOT, ".claude", "rungate.json"), "utf-8");
    for (const forbidden of [/make\s+rebuild/, /\bpodman\b/, /\bdocker\b/, /\bsudo\b/]) {
      expect(whole).not.toMatch(forbidden);
    }
  });

  test("the config declares a reachable-looking remoteHosts entry", () => {
    const remoteHosts = fixtureRaw.remoteHosts as Record<string, Record<string, unknown>>;
    expect(remoteHosts).toBeDefined();
    const names = Object.keys(remoteHosts);
    expect(names.length).toBeGreaterThanOrEqual(1);
    for (const name of names) {
      expect(typeof remoteHosts[name].host).toBe("string");
      expect(typeof remoteHosts[name].preFlightCmd).toBe("string");
    }
  });

  test("the fixture workflow-state reads back through WorkflowStateSchema as XS / LIGHT", () => {
    expect(fixtureState.sizing?.predicted).toBe("XS");
    expect(fixtureState.sizing?.ceremonyTier).toBe("LIGHT");
    expect(fixtureState.acs.length).toBeGreaterThanOrEqual(2);
  });

  test("the workflow-state reader is load-bearing — a bad tier is refused, not passed through", () => {
    // Without this, `WorkflowStateSchema.parse` could be the identity function
    // and the test above would read exactly the same.
    const raw = JSON.parse(readFileSync(fixture.statePath, "utf-8"));
    raw.sizing.ceremonyTier = "CEREMONIAL";
    expect(() => WorkflowStateSchema.passthrough().parse(raw)).toThrow();
  });

  test("ship.js's own hasUIACs expression reads the fixture's AC set as carrying UI evidence", () => {
    // The UI-evidence AC is asserted by running the site that consumes it
    // (`workflows/ship.js`'s `hasUIACs`), not by a predicate this file invented
    // — a hand-written `some(ac => ...)` would keep agreeing with itself after
    // ship.js changed what counts as UI evidence.
    expect(runHasUIACs(fixtureState.acs)).toBe(true);
    const codeOnly = fixtureState.acs
      .filter((ac) => ac.type !== "OUTCOME")
      .map((ac) => ({ ...ac, evidenceMethod: { type: "BUN_TEST" } }));
    expect(codeOnly.length).toBeGreaterThanOrEqual(1);
    expect(runHasUIACs(codeOnly)).toBe(false);
  });
});

// ── AC-2: the extractor, and what it refuses ──────────────────────────────

describe("#274 AC-2: the tier chain is extracted from the on-disk ship.js", () => {
  test("the chain is read from workflows/ship.js on disk, not from a copy in a test", () => {
    const onDisk = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    expect(shipSource).toBe(onDisk);
    for (const slice of tierChainSlices()) {
      expect(countOccurrences(onDisk, slice.text)).toBe(1);
    }
  });

  test("every named site is located exactly once", () => {
    const sites = namedShipSites();
    expect(sites.length).toBe(TIER_SITES.length);
    for (const site of sites) {
      expect(site.occurrences).toBe(1);
      expect(site.text.length).toBeGreaterThan(0);
    }
  });

  test("the extracted statements are assembled in source order", () => {
    const slices = tierChainSlices();
    const offsets = slices.map((s) => s.index);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    let cursor = -1;
    for (const slice of slices) {
      const at = tierChainSource().indexOf(slice.text);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("a second copy of any named site aborts extraction rather than picking one", () => {
    for (const slice of tierChainSlices()) {
      const doubled = `${shipSource}\n${slice.text}\n`;
      expect(() => tierChainSource(doubled)).toThrow(/appears 2 times/);
    }
  });

  test("a renamed site aborts extraction rather than quietly dropping it", () => {
    const call = tierChainSlices().find((s) => s.name === "ceremonyTierFloor call");
    expect(call).toBeDefined();
    const renamed = shipSource.replace(call!.text, "const flooredTier = ceremonyFloor(discovery.ceremonyTier, hasUI)");
    expect(renamed).not.toBe(shipSource);
    expect(() => tierChainSource(renamed)).toThrow(/appears 0 times/);
  });

  test("a missing floor region aborts extraction", () => {
    const stripped = shipSource.replace("// ──── CEREMONY-TIER-FLOOR-START ────", "// gone");
    expect(stripped).not.toBe(shipSource);
    expect(() => tierChainSource(stripped)).toThrow(/CEREMONY-TIER-FLOOR/);
  });
});

// ── AC-3: the chain, run over the fixture and over pages:{} ───────────────

describe("#274 AC-3: the declared pages are what lift the run off LIGHT", () => {
  test("the chain resolves the fixture's XS/LIGHT discovery to STANDARD", () => {
    const resolved = runTierChain(fixtureConfig, fixtureState.sizing?.ceremonyTier);
    expect(resolved.hasUI).toBe(true);
    expect(resolved.pageCount).toBe(Object.keys(fixtureConfig.pages as object).length);
    expect(resolved.tier).toBe("STANDARD");
    expect(resolved.logs.join("\n")).toContain(`${resolved.pageCount} pages declared`);
  });

  test("the same chain over a pages:{} config leaves the same discovery at LIGHT", () => {
    const emptied = { ...fixtureRaw, pages: {} };
    const resolved = runTierChain(emptied, fixtureState.sizing?.ceremonyTier);
    expect(resolved.hasUI).toBe(false);
    expect(resolved.pageCount).toBe(0);
    expect(resolved.tier).toBe("LIGHT");
  });

  test("pages is the ONLY input that differs between those two runs", () => {
    const emptied: Record<string, unknown> = { ...fixtureRaw, pages: {} };
    const differing = Object.keys(fixtureRaw).filter(
      (key) => JSON.stringify(fixtureRaw[key]) !== JSON.stringify(emptied[key]),
    );
    expect(differing).toEqual(["pages"]);
  });

  test("the chain raises and never lowers", () => {
    const thorough = runTierChain(fixtureConfig, "THOROUGH");
    expect(thorough.tier).toBe("THOROUGH");
    const standard = runTierChain(fixtureConfig, "STANDARD");
    expect(standard.tier).toBe("STANDARD");
    expect(standard.logs).toEqual([]);
  });

  test("rungate's own config is the real pages:{} case, and the chain downgrades it", () => {
    // Not a hypothetical — this is why no self-run has ever entered a tier-gated
    // subsystem. The fixture's whole purpose is to be the other side of it.
    const own = loadRungateConfig(REPO_ROOT);
    expect(Object.keys(own.pages as object).length).toBe(0);
    const downgraded = runTierChain(own, "STANDARD");
    expect(downgraded.tier).toBe("LIGHT");
    expect(downgraded.logs.join("\n")).toContain("pages:{} empty");
  });

  test("each extracted statement is load-bearing — removing it changes the answer", () => {
    const without = (name: string): string => {
      const slice = tierChainSlices().find((s) => s.name === name);
      if (!slice) throw new Error(`no extracted slice named ${name}`);
      const mutated = tierChainSource().replace(slice.text, "");
      if (mutated === tierChainSource()) throw new Error(`could not remove the ${name} slice`);
      return mutated;
    };
    const light = fixtureState.sizing?.ceremonyTier;
    // Drop the raise and the fixture stops being raised.
    const noRaise = runTierChain(fixtureConfig, light, without("raise"));
    expect(noRaise.tier).toBe("LIGHT");
    // Drop the floor call and `flooredTier` is undefined, so the answer is no
    // longer STANDARD — which is why the assertion is on the value, not a delta.
    const noFloorCall = runTierChain(fixtureConfig, light, without("ceremonyTierFloor call"));
    expect(noFloorCall.tier).not.toBe("STANDARD");
    // Drop the downgrade and rungate's own run stops being rewritten.
    const own = loadRungateConfig(REPO_ROOT);
    const noDowngrade = runTierChain(own, "STANDARD", without("!hasUI downgrade"));
    expect(noDowngrade.tier).toBe("STANDARD");
  });
});

// ── AC-4: neither suite asserts a tier value it wrote itself ──────────────

/**
 * A tier a test typed into an `expect(...)` argument is a tier nothing
 * resolved. Both suites are scanned for that shape mechanically, rather than
 * the prohibition living in a comment: every ceremony tier under assertion here
 * has to arrive from executing `workflows/ship.js`.
 *
 * The scanner lives in the helper, which is NOT one of the scanned files — a
 * scanner that scanned itself could be satisfied, or defeated, by its own text.
 */
const SCANNED = ["consumer-ceremony-fixture.test.ts", "ship-ceremony-tier-floor.test.ts"] as const;

describe("#274 AC-4: no assertion reads back a hand-written tier", () => {
  for (const name of SCANNED) {
    test(`${name} asserts no tier literal it supplied itself`, () => {
      const scan = scanExpectActuals(readFileSync(join(REPO_ROOT, "test", name), "utf-8"));
      expect(scan.total).toBeGreaterThan(10);
      expect(scan.tierLiteralActuals).toEqual([]);
    });
  }

  test("the scanner can SEE a hand-written tier — positive control", () => {
    // The scan above is worthless if the scanner cannot find a violation. This
    // is the one it is looking for, assembled rather than written out so the
    // scan of this very file cannot trip over the control.
    const literal = `"STAND${"ARD"}"`;
    const control = [
      `expect(state.sizing.ceremonyTier).toBe(${literal});`,
      `expect(${literal}).toBe(run.tier);`,
      `expect(run.tier).toBe(${literal});`,
    ].join("\n");
    const scan = scanExpectActuals(control);
    expect(scan.total).toBe(3);
    // Only the middle one puts the tier where the ACTUAL value belongs.
    expect(scan.tierLiteralActuals.length).toBe(1);
  });
});
