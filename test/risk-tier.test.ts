/**
 * Covers CRC-E1, CRC-E2, CRC-E4 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * What was broken to prove these can fail, with predicted membership, is in
 * the pull request for #1437. The single decision site the battery mutates is
 * `alwaysHighReason` in `lib/risk-tier.ts`; `E4-9` asserts it is the only one,
 * so a later branch cannot inline a second prefix comparison and go green
 * while witnessing nothing (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALWAYS_HIGH_PREFIXES,
  LOW_MAX_FILES,
  LOW_MAX_LINES,
  RISK_TIERS,
  alwaysHighReason,
  classifyChange,
} from "../lib/risk-tier";
import { normaliseRepoPath, underPrefix } from "../lib/repo-path";
import { structuralCut } from "../lib/source-slice";

const ROOT = join(import.meta.dir, "..");
const RISK_TIER_SOURCE = join(ROOT, "lib", "risk-tier.ts");

/** A change that is LOW on every axis, so each case varies exactly one. */
const SMALL = { changedFiles: ["lib/a.ts", "test/a.test.ts"], linesChanged: 20 };

describe("CRC-E1: the tiers are written down — low none, medium one, high two", () => {
  test("E1-1: every tier names how many PEOPLE it needs", () => {
    expect(RISK_TIERS.low.humansRequired).toBe(0);
    expect(RISK_TIERS.medium.humansRequired).toBe(1);
    expect(RISK_TIERS.high.humansRequired).toBe(2);
  });

  test("E1-2: the count a reading reports is the count the table declares", () => {
    // Not a restatement of E1-1: this binds the READING to the table, so a
    // classifier that invents its own number fails here and not there.
    for (const [tier, policy] of Object.entries(RISK_TIERS)) {
      const reading =
        tier === "high"
          ? classifyChange({ ...SMALL, changedFiles: [".github/workflows/ci.yml"] })
          : tier === "medium"
            ? classifyChange({ changedFiles: ["lib/a.ts"] })
            : classifyChange(SMALL);
      expect(reading.tier, tier).toBe(tier as never);
      expect(reading.humansRequired, tier).toBe(policy.humansRequired);
    }
  });

  test("E1-3: every tier says what it means, in a sentence a person can act on", () => {
    for (const [tier, policy] of Object.entries(RISK_TIERS)) {
      expect(policy.meaning.length, tier).toBeGreaterThan(20);
    }
  });
});

describe("CRC-E2: the CHANGE sets the tier, not the author", () => {
  test("E2-1: the input type names no author, actor, login, team or branch", () => {
    const source = readFileSync(RISK_TIER_SOURCE, "utf-8");
    const block = structuralCut(source, "export interface ChangeUnderReview", {
      balanced: "{",
    });
    expect(block.length).toBeGreaterThan(0);
    // Comments inside the block are prose and may discuss authorship; the
    // assertion is about DECLARED FIELDS, so strip them first and assert the
    // strip left something, or this passes vacuously.
    const fields = block.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(fields).toContain("changedFiles");
    expect(fields).not.toMatch(/\b(author|actor|login|team|branch|user)\b/i);
  });

  test("E2-2: two changes identical except for who wrote them cannot differ", () => {
    // The structural assertion above is the real binding. This one is the
    // behavioural restatement: the function takes one argument and there is
    // no second place to put an identity, so passing one changes nothing.
    const withIdentity = { ...SMALL, author: "jhorn", trusted: true } as never;
    expect(classifyChange(withIdentity)).toEqual(classifyChange(SMALL));
  });
});

describe("CRC-E4: any CI workflow file, and any owner path, always needs a human", () => {
  test("E4-1: a workflow file is HIGH however it is spelled", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "./.github/workflows/ci.yml",
      "/.github/workflows/ci.yml",
      ".github\\workflows\\ci.yml",
      ".GITHUB/Workflows/CI.yml",
      ".github/workflows/nested/deep.yaml",
    ]) {
      const r = classifyChange({ changedFiles: [file], linesChanged: 1 });
      expect(r.tier, file).toBe("high");
      expect(r.reasons, file).toContain("CI_WORKFLOW_FILE");
    }
  });

  test("E4-2: one workflow file among many ordinary ones still forces HIGH", () => {
    const r = classifyChange({
      changedFiles: ["lib/a.ts", ".github/workflows/ci.yml", "README.md"],
      linesChanged: 3,
    });
    expect(r.tier).toBe("high");
  });

  test("E4-3: a near-miss prefix is NOT a workflow file", () => {
    // The control. Without it, "return high always" passes E4-1 and E4-2.
    for (const file of [
      ".github/workflows-archive/old.yml",
      ".github/workflow/ci.yml",
      "docs/.github/workflows/ci.yml",
      "lib/github/workflows/ci.yml",
    ]) {
      const r = classifyChange({ changedFiles: [file], linesChanged: 1 });
      expect(r.tier, file).not.toBe("high");
    }
  });

  test("E4-4: an owner-listed sensitive path is HIGH, and says so by its own name", () => {
    const r = classifyChange({
      changedFiles: ["billing/charge.ts"],
      linesChanged: 1,
      sensitivePaths: ["billing"],
    });
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("OWNER_SENSITIVE_PATH");
    expect(r.reasons).not.toContain("CI_WORKFLOW_FILE");
  });

  test("E4-5: owner paths ADD to the floor and cannot subtract from it", () => {
    // There is no configuration shape that removes the built-in prefix: the
    // only config input is a list that is iterated for MORE escalations.
    const r = classifyChange({
      changedFiles: [".github/workflows/ci.yml"],
      linesChanged: 1,
      sensitivePaths: [],
    });
    expect(r.tier).toBe("high");
    expect(ALWAYS_HIGH_PREFIXES).toContain(".github/workflows");
  });

  test("E4-6: an unreadable entry is UNMEASURED, not LOW", () => {
    for (const file of [null, 123, {}, "", '"lib/\\303\\251.ts"', "lib/my file.ts", "$HOME/x"]) {
      const r = classifyChange({ changedFiles: [file], linesChanged: 1 });
      expect(r.tier, JSON.stringify(file)).toBeNull();
      expect(r.refusals, JSON.stringify(file)).toContain("CHANGED_FILE_UNREADABLE");
      expect(r.humansRequired, JSON.stringify(file)).toBeNull();
    }
  });

  test("E4-7: UNMEASURED wins over an escalation already found", () => {
    // "HIGH, and also I could not read part of this" is a reading the caller
    // must see. Reporting HIGH alone hides that the list was not understood.
    const r = classifyChange({
      changedFiles: [".github/workflows/ci.yml", 42],
      linesChanged: 1,
    });
    expect(r.tier).toBeNull();
    expect(r.refusals).toContain("CHANGED_FILE_UNREADABLE");
  });

  test("E4-8: an absent list and an empty list are different refusals", () => {
    expect(classifyChange({ changedFiles: null }).refusals).toEqual([
      "CHANGED_FILES_UNREADABLE",
    ]);
    expect(classifyChange({ changedFiles: [] }).refusals).toEqual([
      "CHANGED_FILES_EMPTY",
    ]);
  });

  test("E4-8b: a CONFIGURED prefix that cannot be read is UNMEASURED, not 'not sensitive'", () => {
    // The fail-open the push review found in this branch's own code: an owner
    // writes a glob, `underPrefix` cannot read it, every path reads as
    // not-sensitive, and the owner sees LOW on exactly what the setting was
    // written to catch. Silence is what makes it worse than no setting.
    for (const bad of ["billing/**", "src/auth/*", "", "a b", 42, null, "../escape"]) {
      const r = classifyChange({
        changedFiles: ["lib/a.ts"],
        linesChanged: 1,
        sensitivePaths: [bad] as never,
      });
      expect(r.tier, JSON.stringify(bad)).toBeNull();
      expect(r.refusals, JSON.stringify(bad)).toContain("SENSITIVE_PATH_UNREADABLE");
    }
  });

  test("E4-8c: a readable prefix still works, with or without a trailing slash", () => {
    // The control. Without it, "refuse every configured prefix" passes E4-8b.
    for (const good of ["billing", "billing/", "billing//"]) {
      const r = classifyChange({
        changedFiles: ["billing/charge.ts"],
        linesChanged: 1,
        sensitivePaths: [good],
      });
      expect(r.tier, good).toBe("high");
      expect(r.reasons, good).toContain("OWNER_SENSITIVE_PATH");
    }
    // And an empty list is not a bad list.
    expect(classifyChange({ ...SMALL, sensitivePaths: [] }).tier).toBe("low");
  });

  test("E4-9: alwaysHighReason is the ONLY place a prefix is compared", () => {
    const source = readFileSync(RISK_TIER_SOURCE, "utf-8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("underPrefix");
    // One call site inside alwaysHighReason per loop, and nowhere else.
    const block = structuralCut(code, "export function alwaysHighReason", {
      balanced: "{",
    });
    const inBlock = (block.match(/underPrefix\(/g) ?? []).length;
    const inFile = (code.match(/underPrefix\(/g) ?? []).length;
    expect(inBlock).toBeGreaterThan(0);
    expect(
      inFile,
      "a second prefix comparison outside alwaysHighReason bypasses the " +
        "mutation that proves CRC-E4 can fail — route it through " +
        "alwaysHighReason instead",
    ).toBe(inBlock);
  });
});

describe("the size axis, and that LOW is reachable at all", () => {
  test("SZ-1: a small change touching nothing sensitive is LOW", () => {
    const r = classifyChange(SMALL);
    expect(r.tier).toBe("low");
    expect(r.humansRequired).toBe(0);
    expect(r.reasons).toEqual(["NO_ESCALATION"]);
  });

  test("SZ-2: unknown size is MEDIUM, never LOW", () => {
    for (const linesChanged of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = classifyChange({ changedFiles: ["lib/a.ts"], linesChanged });
      expect(r.tier, String(linesChanged)).toBe("medium");
      expect(r.reasons, String(linesChanged)).toContain("SIZE_UNKNOWN");
    }
  });

  test("SZ-3: over either ceiling is MEDIUM, and each ceiling acts alone", () => {
    const manyFiles = Array.from({ length: LOW_MAX_FILES + 1 }, (_, i) => `lib/f${i}.ts`);
    expect(classifyChange({ changedFiles: manyFiles, linesChanged: 1 }).tier).toBe("medium");
    expect(
      classifyChange({ changedFiles: ["lib/a.ts"], linesChanged: LOW_MAX_LINES + 1 }).tier,
    ).toBe("medium");
    // And exactly at each ceiling it is still LOW, or the comparison is off by one.
    const atFiles = Array.from({ length: LOW_MAX_FILES }, (_, i) => `lib/f${i}.ts`);
    expect(classifyChange({ changedFiles: atFiles, linesChanged: LOW_MAX_LINES }).tier).toBe("low");
  });
});

describe("lib/repo-path.ts — the one spelling both callers compare in", () => {
  test("RP-1: the spellings that must collapse to one path", () => {
    for (const spelling of [
      "lib/mine.ts",
      "./lib/mine.ts",
      "/lib/mine.ts",
      "lib\\mine.ts",
      "lib/mine.ts:12",
      "lib/mine.ts:12:4",
      "  lib/mine.ts  ",
      "LIB/Mine.ts",
    ]) {
      expect(normaliseRepoPath(spelling), spelling).toBe("lib/mine.ts");
    }
  });

  test("RP-1b: dot segments COLLAPSE — one strip is a bypass, not a normalisation", () => {
    // The push review's finding on #1435. `.replace(/^\.\//, "")` removes one
    // leading `./`, so `././lib/mine.ts` survived as `./lib/mine.ts` and
    // compared unequal to the very path it names.
    for (const spelling of [
      "./lib/mine.ts",
      "././lib/mine.ts",
      "./././lib/mine.ts",
      "lib/./mine.ts",
      "lib/../lib/mine.ts",
      "./lib/../lib/./mine.ts",
      "lib//mine.ts",
    ]) {
      expect(normaliseRepoPath(spelling), spelling).toBe("lib/mine.ts");
    }
    // A `..` escaping the root is refused, never clamped into a real file.
    for (const escaping of ["../outside.ts", "lib/../../outside.ts", ".."]) {
      expect(normaliseRepoPath(escaping), escaping).toBeNull();
    }
  });

  test("RP-1c: the same bypass reaches CRC-E4, so it is bound there too", () => {
    for (const file of [
      ".github/./workflows/ci.yml",
      "././.github/workflows/ci.yml",
      ".github/../.github/workflows/ci.yml",
      ".github//workflows//ci.yml",
    ]) {
      const r = classifyChange({ changedFiles: [file], linesChanged: 1 });
      expect(r.tier, file).toBe("high");
      expect(r.reasons, file).toContain("CI_WORKFLOW_FILE");
    }
    // And the control in the other direction: a `..` that genuinely leaves
    // the workflows directory is NOT a workflow file.
    expect(
      classifyChange({
        changedFiles: [".github/workflows/../dependabot.yml"],
        linesChanged: 1,
      }).tier,
    ).not.toBe("high");
  });

  test("RP-2: what it refuses rather than guessing at", () => {
    for (const bad of [null, undefined, 123, {}, [], "", '"lib/\\303\\251.ts"', "a b/c.ts", "x|y"]) {
      expect(normaliseRepoPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("RP-3: underPrefix is segment-aware and refuses on either side", () => {
    expect(underPrefix(".github/workflows/ci.yml", ".github/workflows")).toBe(true);
    expect(underPrefix(".github/workflows", ".github/workflows")).toBe(true);
    expect(underPrefix(".github/workflows-archive/x.yml", ".github/workflows")).toBe(false);
    expect(underPrefix("lib/a.ts", ".github/workflows")).toBe(false);
    expect(underPrefix(42, ".github/workflows")).toBe(false);
    expect(underPrefix("lib/a.ts", "a b")).toBe(false);
  });

  test("RP-4: alwaysHighReason returns null for an unreadable path, not a reason", () => {
    // The distinction classifyChange depends on: unreadable is a REFUSAL one
    // layer up, never an escalation reason here.
    expect(alwaysHighReason(42)).toBeNull();
    expect(alwaysHighReason("lib/my file.ts", ["lib"])).toBeNull();
  });
});
