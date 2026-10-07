import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { detectDrift, extractKeywords } from "../scripts/detect-sc-drift";

const ROOT = join(import.meta.dir, "..");
const TEMP_DIR = join(ROOT, ".tmp-sc-drift-test");
const TEMP_SPECS = join(TEMP_DIR, "specs");

beforeAll(() => {
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
  mkdirSync(TEMP_SPECS, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
});

describe("SC drift detection", () => {
  test("detects drift when SC references nonexistent file", () => {
    // Create a spec with SC referencing a fake file
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-001: lib/nonexistent-file.ts exists
- [ ] SC-002: scripts/also-fake.ts contains [someKeyword]
`;
    writeFileSync(join(TEMP_SPECS, "test-drift.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should find 2 drifted SCs (both reference nonexistent files)
    expect(result.checked).toBe(2);
    expect(result.drifted.size).toBe(1);
    expect(result.drifted.has("test-drift.md")).toBe(true);

    const driftedSCs = result.drifted.get("test-drift.md")!;
    expect(driftedSCs.length).toBeGreaterThanOrEqual(2);
    expect(driftedSCs.some(d => d.scId === "SC-001")).toBe(true);
    expect(driftedSCs.some(d => d.scId === "SC-002")).toBe(true);
  });

  test("passes when SC references existing file", () => {
    // Create actual files
    mkdirSync(join(TEMP_DIR, "lib"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "lib", "real-file.ts"), "export const foo = 42;");

    // Create spec referencing real file
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-100: lib/real-file.ts exists
`;
    writeFileSync(join(TEMP_SPECS, "test-valid.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should not find any drift for this SC
    expect(result.checked).toBeGreaterThanOrEqual(1);
    const validDrifted = result.drifted.get("test-valid.md");
    expect(validDrifted).toBeUndefined();
  });

  test("detects stale keyword when file exists but keyword missing", () => {
    // Create file without the expected keyword
    mkdirSync(join(TEMP_DIR, "scripts"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "scripts", "test-script.ts"), "// No special keyword here\nconst x = 1;");

    // Create spec expecting keyword
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-200: scripts/test-script.ts contains [specialKeyword]
`;
    writeFileSync(join(TEMP_SPECS, "test-stale.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should find stale SC
    expect(result.stale.size).toBe(1);
    expect(result.stale.has("test-stale.md")).toBe(true);

    const staleSCs = result.stale.get("test-stale.md")!;
    expect(staleSCs.length).toBe(1);
    expect(staleSCs[0].scId).toBe("SC-200");
    expect(staleSCs[0].keyword).toBe("specialKeyword");
  });

  test("passes when file contains expected keyword", () => {
    // Create file with keyword
    mkdirSync(join(TEMP_DIR, "gates"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "gates", "test-gate.ts"), "// Contains expectedKeyword\nconst y = 2;");

    // Create spec expecting keyword
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-300: gates/test-gate.ts contains [expectedKeyword]
`;
    writeFileSync(join(TEMP_SPECS, "test-keyword-present.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should not find stale for this SC
    const stale = result.stale.get("test-keyword-present.md");
    expect(stale).toBeUndefined();
  });

  test("handles specs with no file references", () => {
    const specContent = `---
doc-type: spec
---

# Test Spec

## Success Criteria

- [ ] SC-400: Something without file paths
- [ ] SC-401: Another behavioral criterion
`;
    writeFileSync(join(TEMP_SPECS, "test-no-refs.md"), specContent);

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);

    // Should check these SCs but find no drift/stale
    expect(result.checked).toBeGreaterThanOrEqual(2);
    const drift = result.drifted.get("test-no-refs.md");
    const stale = result.stale.get("test-no-refs.md");
    expect(drift).toBeUndefined();
    expect(stale).toBeUndefined();
  });
});

/**
 * `contains [a, b]` is two requirements (#141)
 *
 * `extractKeywords` returned the bracket contents as one string, so a
 * multi-keyword SC was searched for the literal text `"resolveSyncPaths,
 * harnessRoot"` — comma and space included — which no source file contains.
 * Every multi-keyword SC was therefore reported stale regardless of the file,
 * and `sync-sc-status.ts` refuses to flip a stale SC. A criterion the
 * conformity engine had just PASSED could not be marked done, and the printed
 * reason was "keyword missing from file", which is not what was wrong.
 */
describe("#141: keyword extraction", () => {
  test("a comma-separated list is separate keywords, not one literal", () => {
    expect(extractKeywords("x.ts contains [resolveSyncPaths, harnessRoot]")).toEqual([
      "resolveSyncPaths",
      "harnessRoot",
    ]);
  });

  test("a single keyword is unchanged", () => {
    expect(extractKeywords("x.ts contains [onlyOne]")).toEqual(["onlyOne"]);
  });

  test("`not contains` is an absence clause and yields nothing", () => {
    // This detector only answers "a file exists but lacks a term it should
    // have". Read as a positive requirement it inverts the SC: SC-539 says
    // ship.js must NOT contain `git merge ${worktreeBranch}`, and the
    // detector reported it stale for being correct.
    expect(extractKeywords("workflows/ship.js not contains [git merge]")).toEqual([]);
  });

  test("a positive clause alongside a negative one still extracts", () => {
    expect(
      extractKeywords("hooks/x.ts contains [redactSecrets] and not contains [} catch {}]"),
    ).toEqual(["redactSecrets"]);
  });

  test("a statement with no contains clause yields nothing", () => {
    expect(extractKeywords("lib/real-file.ts exists")).toEqual([]);
  });
});

describe("#141: a multi-keyword SC is only stale for the terms it is missing", () => {
  test("every missing term is named, and a present one is not", () => {
    mkdirSync(join(TEMP_DIR, "workflows"), { recursive: true });
    writeFileSync(join(TEMP_DIR, "workflows", "multi.ts"), "export const present = 1;\n");
    writeFileSync(
      join(TEMP_SPECS, "test-multi.md"),
      `# Multi\n\n- [ ] SC-500: workflows/multi.ts contains [present, absentOne, absentTwo]\n`,
    );

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);
    const stale = result.stale.get("test-multi.md")!;

    expect(stale).toBeDefined();
    // Before the fix this read the whole bracket string back; a reader who
    // fixed one term and re-ran would discover the next one by iteration.
    expect(stale[0].keyword).toBe("absentOne, absentTwo");
  });

  test("an SC whose terms are all present is not stale at all", () => {
    writeFileSync(join(TEMP_DIR, "workflows", "allthere.ts"), "alpha beta gamma\n");
    writeFileSync(
      join(TEMP_SPECS, "test-allthere.md"),
      `# All\n\n- [ ] SC-501: workflows/allthere.ts contains [alpha, beta, gamma]\n`,
    );

    const result = detectDrift(TEMP_SPECS, TEMP_DIR);
    // The failure that blocked #141: this was stale because it searched for
    // "alpha, beta, gamma" as one string.
    expect(result.stale.get("test-allthere.md")).toBeUndefined();
  });
});
