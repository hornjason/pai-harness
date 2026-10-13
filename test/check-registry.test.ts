/**
 * Nine named gate checks with no locatable implementation (#339).
 *
 * `config/ceremony-profiles.json` named 41 checks. Nine had no
 * `test("<name>: …")` in `gates/workflow.test.ts`, and nothing checked the
 * correspondence in either direction.
 *
 * Resolving the nine by hand took three passes and got it wrong twice:
 *
 *   acs-have-threshold          gates/schema.ts, as `missing threshold`
 *   acs-no-behavioral-language  gates/schema.ts, as `BEHAVIORAL_PATTERN`
 *   acs-have-type               gates/schema.ts — the field was `.optional()`
 *   spec-drift                  lib/conformity.ts, as `runSpecDrift`
 *   dead-exports                lib/conformity.ts, FALLOW-2 in runFallowCheck
 *   consumer-chain-verified     nothing, anywhere
 *   skill-qc-goal / -ship       a script nothing invokes
 *   evidence-target-valid       already removed in #315
 *
 * No search for a profile's name finds the first five. That is the issue's
 * point made precisely: the information exists, it is not recoverable from
 * the name, and until now it lived in whoever last looked.
 *
 * Covers SC-796..800 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  checkRegistryViolations,
  gateTestsIn,
  parseCheckRegistry,
  profileCheckNames,
  type CheckRegistry,
} from "../lib/check-registry";

const REPO = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf-8");
const readImpl = (p: string) => (existsSync(join(REPO, p)) ? read(p) : null);

const REGISTRY = parseCheckRegistry(JSON.parse(read("config/check-registry.json")));
const PROFILES = JSON.parse(read("config/ceremony-profiles.json"));
const WORKFLOW = read("gates/workflow.test.ts");

function violationsNow(over: Partial<Parameters<typeof checkRegistryViolations>[0]> = {}) {
  return checkRegistryViolations({
    registry: REGISTRY,
    profiles: PROFILES,
    workflowTestSource: WORKFLOW,
    readImpl,
    ...over,
  });
}

describe("#339: every named check resolves, in both directions", () => {
  test("the repo has no registry violations", () => {
    const v = violationsNow();
    expect(v, v.map(x => `[${x.kind}] ${x.detail}`).join("\n")).toEqual([]);
  });

  test("the corpus is non-empty, so the case above is not vacuous", () => {
    // Every assertion in this file is satisfied by a registry describing
    // nothing. 41 names, 38 registered, 30 always-run when this shipped.
    expect(profileCheckNames(PROFILES).size).toBeGreaterThan(30);
    expect(Object.keys(REGISTRY.checks).length).toBeGreaterThan(30);
    expect(gateTestsIn(WORKFLOW, REGISTRY.gateDescribes).length).toBeGreaterThan(50);
  });

  test("a fabricated profile name turns it red", () => {
    // SC-5, driven rather than described.
    const profiles = JSON.parse(JSON.stringify(PROFILES));
    profiles.tiers.STANDARD.checks.verify.push("totally-invented-check");
    const v = violationsNow({ profiles });
    expect(v.map(x => x.kind)).toEqual(["unregistered"]);
    expect(v[0].detail).toContain("totally-invented-check");
    expect(v[0].detail).toContain("STANDARD.verify");
  });

  test("re-adding a delisted name says why it was delisted", () => {
    // A plain "unregistered" would send the next reader looking for an
    // implementation that was already searched for and not found.
    const profiles = JSON.parse(JSON.stringify(PROFILES));
    profiles.tiers.THOROUGH.checks.verify.push("consumer-chain-verified");
    const v = violationsNow({ profiles });
    expect(v.map(x => x.kind)).toEqual(["delisted-in-profile"]);
    expect(v[0].detail).toContain("No implementation anywhere");
  });

  test("an entry pointing at a file that does not exist turns it red", () => {
    const registry: CheckRegistry = {
      ...REGISTRY,
      checks: { ...REGISTRY.checks, "spec-drift": { impl: "lib/nope-9f3a.ts" } },
    };
    const v = violationsNow({ registry }).filter(x => x.kind === "unimplemented");
    expect(v.length).toBe(1);
    expect(v[0].detail).toContain("does not exist");
  });

  test("an entry pointing at a real file that lacks the symbol turns it red", () => {
    // The case that matters more: the file exists, so a path check passes,
    // and the check moved out of it. An entry written from memory and one
    // that has gone stale look identical, and both are caught here.
    const registry: CheckRegistry = {
      ...REGISTRY,
      checks: { ...REGISTRY.checks, "spec-drift": { impl: "lib/conformity.ts", symbol: "runSpecDriftXYZ" } },
    };
    const v = violationsNow({ registry }).filter(x => x.kind === "unimplemented");
    expect(v.length).toBe(1);
    expect(v[0].detail).toContain("written from memory");
  });

  test("a workflow test registered against another file turns it red", () => {
    // Otherwise `tests-pass` could point at lib/conformity.ts and pass,
    // because that file happens to contain the string.
    const registry: CheckRegistry = {
      ...REGISTRY,
      checks: { ...REGISTRY.checks, "tests-pass": { impl: "lib/conformity.ts", symbol: "export" } },
    };
    const v = violationsNow({ registry }).filter(x => x.kind === "unimplemented");
    expect(v.length).toBe(1);
    expect(v[0].detail).toContain("but the registry points at");
  });

  test("a new gate check named by nothing turns it red", () => {
    // The reverse direction, which is the half #339 asked for and the half
    // a one-way map always omits.
    const source = WORKFLOW.replace(
      'describe("verify checks", () => {',
      'describe("verify checks", () => {\n  test("brand-new-check: does a thing", () => {});',
    );
    expect(source).not.toBe(WORKFLOW);
    const v = violationsNow({ workflowTestSource: source }).filter(x => x.kind === "undocumented");
    expect(v.length).toBe(1);
    expect(v[0].detail).toContain("brand-new-check");
  });

  test("alwaysRun ratchets both ways", () => {
    // An entry for a test that is gone, and an entry in the wrong describe.
    // Without this the list becomes a place to park names, which is the
    // exemption-list failure: an allowlist naming a thing becomes evidence
    // for it.
    const gone: CheckRegistry = {
      ...REGISTRY,
      alwaysRun: { ...REGISTRY.alwaysRun, "check-that-left": "verify checks" },
    };
    const a = violationsNow({ registry: gone }).filter(x => x.kind === "stale-always-run");
    expect(a.length).toBe(1);
    expect(a[0].detail).toContain("no longer a test");

    const moved: CheckRegistry = {
      ...REGISTRY,
      alwaysRun: { ...REGISTRY.alwaysRun, "witness-chain": "scope checks" },
    };
    const b = violationsNow({ registry: moved }).filter(x => x.kind === "stale-always-run");
    expect(b.length).toBe(1);
    expect(b[0].detail).toContain('it is in "ship checks"');
  });
});

describe("#339: the discriminator is the describe block, and it is the honest one", () => {
  test("prose test titles outside a gate describe are not checks", () => {
    // A kebab-case heuristic over the whole file collects `baseline`,
    // `zero`, `subtracts` and `pre-existing` from test-baseline-subtraction.
    const names = gateTestsIn(WORKFLOW, REGISTRY.gateDescribes).map(t => t.name);
    for (const prose of ["baseline", "zero", "subtracts", "pre-existing", "extractTestFailureCount"]) {
      expect(names, prose).not.toContain(prose);
    }
  });

  test("the standalone-run placeholder is not counted as a check", () => {
    const tests = gateTestsIn(
      'describe("verify checks", () => {\n  test("skipped — no active workflow (standalone run)", () => {});\n  test("real-check: x", () => {});\n});',
      ["verify checks"],
    );
    expect(tests.map(t => t.name)).toEqual(["real-check"]);
  });

  test("tests in a non-gate describe are ignored", () => {
    const tests = gateTestsIn(
      'describe("verify checks", () => {\n  test("a-check: x", () => {});\n});\ndescribe("unit stuff", () => {\n  test("b-check: y", () => {});\n});',
      ["verify checks"],
    );
    expect(tests).toEqual([{ name: "a-check", describe: "verify checks" }]);
  });

  test("every gate describe in the registry exists in the file", () => {
    // Otherwise a renamed describe silently empties the reverse direction:
    // zero gate tests found, zero undocumented checks, green.
    for (const d of REGISTRY.gateDescribes) {
      expect(WORKFLOW, d).toContain(`describe("${d}"`);
    }
    expect(REGISTRY.gateDescribes.length).toBeGreaterThan(4);
  });
});

describe("#339: acs-have-type was named and not enforced", () => {
  test("the schema now refuses an AC with no type", () => {
    const schema = read("gates/schema.ts");
    expect(schema).toContain("missing type (CODE or OUTCOME)");
  });

  test("the registry records where it lives and why it changed", () => {
    const entry = REGISTRY.checks["acs-have-type"];
    expect(entry.impl).toBe("gates/schema.ts");
    expect(entry.note).toContain("0 of 456");
  });
});

describe("#339: what was delisted is recorded, not forgotten", () => {
  test("no delisted name survives in a ceremony profile", () => {
    const named = profileCheckNames(PROFILES);
    for (const name of Object.keys(REGISTRY.delisted)) {
      expect([...named.keys()], name).not.toContain(name);
    }
  });

  test("every delisted entry says why, in enough words to act on", () => {
    for (const [name, why] of Object.entries(REGISTRY.delisted)) {
      expect(why.length, `${name}'s reason is too short to be a reason`).toBeGreaterThan(40);
    }
    expect(Object.keys(REGISTRY.delisted).length).toBeGreaterThanOrEqual(4);
  });
});
