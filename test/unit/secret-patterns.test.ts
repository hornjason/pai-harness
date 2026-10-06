/**
 * Every generated secret scanner carries the same registry.
 *
 * There were three copies and they disagreed:
 *
 *   scripts/git-hooks/pre-commit:22      8 patterns
 *   lib/scaffold/steps.ts  -> gates.yml   3 patterns
 *   lib/scaffold/steps.ts  -> pre-commit  3 patterns
 *
 * CI missed `gho_`, `ghs_`, `github_pat_`, `sk-ant-`, and PEM private key
 * blocks entirely — a committed private key passed CI. The generated CONSUMER
 * pre-commit hook carried the same weak set, so every downstream project
 * inherited the gap while this repo's own checked-in hook had the full list.
 *
 * The generated gates.yml asserted the opposite in a comment: "Two tiers
 * matching the pre-commit hook, so local and CI cannot disagree about what
 * counts as a secret." It was not true, and nothing checked it. A comment is
 * not a mechanism. These tests are the mechanism.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  TIER1_SECRET_PATTERNS,
  TIER2_ASSIGNMENT_ERE,
  tier1Ere,
  unshellSafePatterns,
} from "../../lib/secret-patterns";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const steps = readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
const gatesYml = readFileSync(join(REPO_ROOT, ".github", "workflows", "gates.yml"), "utf-8");
const repoPreCommit = readFileSync(join(REPO_ROOT, "scripts", "git-hooks", "pre-commit"), "utf-8");

describe("the registry covers the key formats that actually leak", () => {
  test("includes the five CI used to miss", () => {
    const ids = TIER1_SECRET_PATTERNS.map(p => p.id);
    for (const id of ["github-oauth", "github-server", "github-pat-fine", "anthropic", "private-key"]) {
      expect(ids, `${id} was missing from CI and is the reason this registry exists`).toContain(id);
    }
  });

  test("every pattern survives embedding in single-quoted generated shell", () => {
    // A quote or backtick here produces a scanner that either fails to parse
    // or silently matches the wrong thing — invisible in review, which is why
    // this is a test and not a convention.
    expect(unshellSafePatterns(), "these patterns would break the generated shell").toEqual([]);
  });

  test("the alternation is valid regex and matches real key shapes", () => {
    const re = new RegExp(tier1Ere());
    const shouldMatch: Array<[string, string]> = [
      ["AWS", "AKIA" + "A".repeat(16)],
      ["GitHub PAT", "ghp_" + "a".repeat(36)],
      ["GitHub OAuth", "gho_" + "b".repeat(36)],
      ["GitHub server", "ghs_" + "c".repeat(36)],
      ["OpenAI", "sk-" + "d".repeat(48)],
      ["Anthropic", "sk-ant-" + "e".repeat(95)],
      ["PEM", "-----BEGIN RSA PRIVATE KEY-----"],
      ["PEM bare", "-----BEGIN PRIVATE KEY-----"],
      ["PEM openssh", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ];
    for (const [label, sample] of shouldMatch) {
      expect(re.test(sample), `${label} key shape is not caught`).toBe(true);
    }
  });

  test("does not fire on ordinary text", () => {
    // A scanner nobody can commit through gets disabled, so the false-positive
    // side is load-bearing too.
    const re = new RegExp(tier1Ere());
    for (const benign of [
      "const apiKey = process.env.OPENAI_API_KEY",
      "see docs/sk-notes.md",
      "https://github.com/hornjason/pai-harness",
      "-----BEGIN CERTIFICATE-----",
    ]) {
      expect(re.test(benign), `false positive on: ${benign}`).toBe(false);
    }
  });
});

describe("generated scanners use the registry, not their own copy", () => {
  test("steps.ts interpolates tier1Ere() rather than inlining patterns", () => {
    const inlined = steps.match(/AKIA\[A-Z0-9\]\{16\}/g) || [];
    expect(
      inlined.length,
      "a secret pattern is hardcoded in the generator again — import it from lib/secret-patterns.ts",
    ).toBe(0);
    // Both generated scanners: gates.yml and the consumer pre-commit hook.
    expect((steps.match(/\$\{tier1Ere\(\)\}/g) || []).length).toBe(2);
  });

  test("the generated gates.yml carries every registry pattern", () => {
    // Asserts the OUTPUT, not just the generator — the two can diverge until
    // someone re-scaffolds, and gates.yml is committed.
    for (const p of TIER1_SECRET_PATTERNS) {
      expect(gatesYml, `gates.yml is missing ${p.id} (${p.description})`).toContain(p.ere);
    }
  });

  test("gates.yml keeps the tier-2 assignment scan", () => {
    expect(gatesYml).toContain(TIER2_ASSIGNMENT_ERE);
  });

  test("gates.yml no longer claims a parity it does not have", () => {
    // The specific false statement that let this sit: it asserted the CI and
    // hook registries matched while they differed 3 to 8.
    expect(gatesYml).not.toContain("Two tiers matching the pre-commit hook");
  });

  test("this repo's own pre-commit hook is not weaker than the registry", () => {
    // scripts/git-hooks/pre-commit is checked in, not generated, so it can
    // drift independently. It was the STRONGEST of the three copies; this
    // keeps it from quietly becoming the weakest.
    for (const p of TIER1_SECRET_PATTERNS) {
      const key = p.ere.split(/[[(\\]/)[0];
      if (key.length < 4) continue; // too generic to grep for meaningfully
      expect(repoPreCommit, `scripts/git-hooks/pre-commit no longer covers ${p.id}`).toContain(key);
    }
  });
});

describe("deduplication must not narrow coverage", () => {
  test("sk- keys shorter than 48 chars are still caught", () => {
    // The regression the security review caught. pre-commit used {48}, CI used
    // {20,}; merging to a single registry by taking the hook's value would
    // have silently narrowed CI. When registries disagree, the union is the
    // safe merge — a dedup must never remove coverage that existed.
    const re = new RegExp(tier1Ere());
    expect(re.test("sk-" + "a".repeat(24)), "a 24-char sk- key slipped through").toBe(true);
    expect(re.test("sk-" + "a".repeat(48))).toBe(true);
  });

  test("every string embedded in generated shell is validated, not just tier 1", () => {
    // The validator used to inspect only TIER1, while tier-2 expressions are
    // interpolated into the same shell — a validator with a narrower view
    // than the thing it validates.
    const src = readFileSync(join(REPO_ROOT, "lib", "secret-patterns.ts"), "utf-8");
    expect(src).toContain("tier2-assignment");
    expect(src).toContain("tier2-allowlist");
    expect(unshellSafePatterns()).toEqual([]);
  });
});
