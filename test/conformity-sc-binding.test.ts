/**
 * SC-to-behaviour binding for the conformity engine (#209).
 *
 * Until this file existed, `extractSCs` matched only `- [ ]`, so every CHECKED
 * SC — the ones claiming to be done — was never collected and never asserted.
 * The handful that were collected ran inside `try { assertion(root) } catch {}`,
 * so even those could not fail. The suite reported 0 fail while asserting
 * nothing about 261 completed criteria.
 *
 * What was broken to prove these checks can fail, run and reverted:
 *   - restoring the `- \[ \]`-only regex in extractSCs turns the floor test and
 *     every checked-SC test in this file red (0 checked SCs collected)
 *   - re-wrapping the generated body in try/catch turns
 *     "assertion failures propagate" red
 *   - unchecking one `- [x] SC-` line in any spec turns the no-regression
 *     count test red
 *
 * SPEC-REF: CONFIG-DRIVEN-TESTING-SPEC.md § Success Criteria
 * SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Success Criteria (SC-369)
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  extractSCs,
  collectTestableSpecs,
  planSCTests,
  parseFrontmatter,
  type ParsedSC,
} from "../lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "specs");

/**
 * The pre-change baseline, measured on the parent of this commit:
 *   grep -rhc '^- \[x\] SC-' specs/*.md | paste -sd+ - | bc  ->  261
 * The number may only ever go UP. A drop means an SC was unchecked or deleted,
 * which is the cheapest way to make a newly-enforced suite green.
 */
const CHECKED_SC_BASELINE = 261;

/**
 * Checked SCs whose statement matches no pattern in the matcher registry, so
 * no assertion can be built for them. 54 on the day checked SCs were first
 * collected (#209). This is a ratchet, not a target: it may fall freely, and
 * any rise means a new SC was written in prose that the engine cannot bind to.
 */
const UNMATCHED_CHECKED_RATCHET = 54;

function specFiles(): string[] {
  return readdirSync(SPECS_DIR).filter(f => f.endsWith(".md"));
}

// ── AC-1: extractSCs sees both checkbox states ──────────────

describe("AC-1: extractSCs records checkbox state", () => {
  // IDs in the 9000 range deliberately. A single-digit ID written anywhere in
  // a test file — fixture text and comments included — is read by
  // sync-sc-status as a coverage claim for the real criterion of that number
  // (#149, test/sync-sc-status-matching.test.ts). Fixture SCs therefore use
  // numbers this repo does not issue, and this comment avoids naming the one
  // it is warning about.
  const sample = [
    "---",
    "testable: true",
    "---",
    "- [x] SC-9001: done thing",
    "- [ ] SC-9002: pending thing",
    "- [X] SC-9003: done with capital X",
  ].join("\n");

  test("collects checked and unchecked SCs alike", () => {
    const scs = extractSCs(sample, "TEST-SPEC.md");
    expect(scs.map(s => s.id)).toEqual(["SC-9001", "SC-9002", "SC-9003"]);
  });

  test("checked is true for [x] and [X], false for [ ]", () => {
    const byId = new Map(extractSCs(sample, "TEST-SPEC.md").map(s => [s.id, s.checked]));
    expect(byId.get("SC-9001")).toBe(true);
    expect(byId.get("SC-9002")).toBe(false);
    expect(byId.get("SC-9003")).toBe(true);
  });

  test("real specs contribute checked SCs — not zero", () => {
    const checked = specFiles()
      .flatMap(f => extractSCs(readFileSync(join(SPECS_DIR, f), "utf-8"), f))
      .filter(sc => sc.checked);
    expect(checked.length).toBeGreaterThanOrEqual(CHECKED_SC_BASELINE);
  });
});

// ── AC-3: plan shape, and no swallowing ─────────────────────

describe("AC-3: planSCTests binds checked SCs to real assertions", () => {
  function plan(statement: string, checked: boolean) {
    const sc: ParsedSC = { id: "SC-X", statement, specFile: "TEST-SPEC.md", checked };
    const entries = planSCTests([sc]);
    expect(entries.length).toBe(1);
    return entries[0];
  }

  test("checked + matchable -> assert", () => {
    expect(plan("AGENTS.md contains [Rules]", true).kind).toBe("assert");
  });

  test("unchecked + matchable -> todo (never a swallowed assertion)", () => {
    expect(plan("AGENTS.md contains [Rules]", false).kind).toBe("todo");
  });

  test("unchecked + unmatchable -> todo", () => {
    expect(plan("the agent feels confident about the work", false).kind).toBe("todo");
  });

  test("checked + unmatchable -> unmatched", () => {
    expect(plan("the agent feels confident about the work", true).kind).toBe("unmatched");
  });

  test("behavioral -> behavioral, regardless of checkbox", () => {
    expect(plan("Agent finds the file in 3 calls (behavioral)", true).kind).toBe("behavioral");
    expect(plan("Agent finds the file in 3 calls (behavioral)", false).kind).toBe("behavioral");
  });

  test("assertion failures propagate out of the plan entry — nothing is caught", () => {
    const entry = plan("lib/definitely-not-a-real-file.ts contains [anything]", true);
    expect(entry.kind).toBe("assert");
    if (entry.kind !== "assert") throw new Error("unreachable");
    expect(() => entry.assertion(ROOT)).toThrow();
  });

  test("a passing assertion does not throw", () => {
    const entry = plan("AGENTS.md contains [Rules]", true);
    if (entry.kind !== "assert") throw new Error("expected an assert entry");
    expect(() => entry.assertion(ROOT)).not.toThrow();
  });
});

// ── AC-4: every checked SC in this repo actually passes ─────

describe("AC-4: every checked, matchable SC in specs/ passes its assertion", () => {
  test("zero checked SCs fail", () => {
    const failures: string[] = [];
    let asserted = 0;
    for (const [specFile, meta] of collectTestableSpecs(ROOT)) {
      for (const entry of planSCTests(meta.scs)) {
        if (entry.kind !== "assert") continue;
        asserted++;
        try {
          entry.assertion(ROOT);
        } catch (e) {
          failures.push(`${specFile} ${entry.sc.id}: ${String((e as Error).message).split("\n")[0]}`);
        }
      }
    }
    // Vacuity guard: an empty loop would make `failures` trivially empty.
    expect(asserted).toBeGreaterThanOrEqual(150);
    expect(failures).toEqual([]);
  });

  test("unmatched checked SCs do not exceed the ratchet", () => {
    let unmatched = 0;
    for (const [, meta] of collectTestableSpecs(ROOT)) {
      unmatched += planSCTests(meta.scs).filter(e => e.kind === "unmatched").length;
    }
    expect(unmatched).toBeLessThanOrEqual(UNMATCHED_CHECKED_RATCHET);
  });
});

// ── AC-5: no SC was unchecked or deleted to buy green ───────

describe("AC-5: checked SC count does not regress", () => {
  test(`at least ${CHECKED_SC_BASELINE} checked SC checkboxes across specs/`, () => {
    let checked = 0;
    for (const f of specFiles()) {
      checked += (readFileSync(join(SPECS_DIR, f), "utf-8").match(/^- \[[xX]\] SC-/gm) || []).length;
    }
    expect(checked).toBeGreaterThanOrEqual(CHECKED_SC_BASELINE);
  });
});

// ── AC-6: GateEnforcement is a thin trigger ─────────────────

describe("AC-6: hooks/GateEnforcement.hook.ts is a thin trigger", () => {
  test("under 100 lines", () => {
    const content = readFileSync(join(ROOT, "hooks/GateEnforcement.hook.ts"), "utf-8");
    expect(content.trimEnd().split("\n").length).toBeLessThan(100);
  });

  test("delegates to lib/gate-enforcement", () => {
    const content = readFileSync(join(ROOT, "hooks/GateEnforcement.hook.ts"), "utf-8");
    expect(content).toContain("runGateEnforcement");
    expect(content).toContain("../lib/gate-enforcement");
  });
});

// ── parseFrontmatter must see block-style keys (SC-423) ─────

describe("parseFrontmatter sees block-style keys", () => {
  const fm = [
    "---",
    "name: marcus",
    "tiers:",
    "  reinforcement: ['Testing Rules']",
    "  mechanical: ['Workflow']",
    "model: opus",
    "---",
    "body",
  ].join("\n");

  test("a key whose value is an indented block is present, not absent", () => {
    const parsed = parseFrontmatter(fm);
    expect(parsed?.tiers).toBeDefined();
    expect(parsed?.tiers).toContain("reinforcement");
  });

  test("inline keys around the block still parse", () => {
    const parsed = parseFrontmatter(fm);
    expect(parsed?.name).toBe("marcus");
    expect(parsed?.model).toBe("opus");
  });

  test("a key that is genuinely absent stays undefined", () => {
    expect(parseFrontmatter(fm)?.nosuchfield).toBeUndefined();
  });
});
