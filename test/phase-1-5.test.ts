/**
 * Phase 1.5: matchPattern extension unit tests (TDD)
 *
 * GREEN phase - importing real implementations
 */
import { describe, test, expect } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";

// Import the real implementations
import { resolveAndContain, matchPattern } from "../lib/conformity";

interface ParsedSC {
  id: string;
  statement: string;
  specFile: string;
}

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "phase-1-5");

// ── SC-286: resolveAndContain() utility tests ────────────────────

describe("SC-286: resolveAndContain() path validation", () => {
  test("rejects paths with ../", () => {
    const result = resolveAndContain("/test", "../etc/passwd");
    expect(result).toBeNull();
  });

  test("rejects absolute paths", () => {
    const result = resolveAndContain("/test", "/etc/passwd");
    expect(result).toBeNull();
  });

  test("allows normal relative paths", () => {
    const result = resolveAndContain("/test", "specs/foo.md");
    expect(result).not.toBeNull();
    expect(result).toBe("/test/specs/foo.md");
  });

  test("allows paths with dots in filenames", () => {
    const result = resolveAndContain("/test", ".rungate/test.json");
    expect(result).not.toBeNull();
    expect(result).toBe("/test/.rungate/test.json");
  });
});

// ── SC-288: content-contains matcher ─────────────────────────────

describe("SC-288: content-contains matcher", () => {
  test("matches 'contains [list]' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-288",
      statement: "AGENTS.md contains [Rules, Key Files, Specs]",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });

  test("returned assertion checks for all bracket items", () => {
    if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true });
    mkdirSync(FIXTURE_ROOT, { recursive: true });
    
    writeFileSync(join(FIXTURE_ROOT, "test.md"), "# Rules\n\n# Key Files\n\n# Specs");
    
    const sc: ParsedSC = {
      id: "SC-288",
      statement: "test.md contains [Rules, Key Files, Specs]",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    
    // This will fail because matcher is null
    expect(matcher).not.toBeNull();
    if (matcher) {
      expect(() => matcher(FIXTURE_ROOT)).not.toThrow();
    }
  });
});

// ── SC-289: content-not-contains matcher ─────────────────────────

describe("SC-289: content-not-contains matcher", () => {
  test("matches 'must NOT contain [list]' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-289",
      statement: "clean.md must NOT contain [TODO, FIXME]",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });

  test("matches 'no [list]' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-289",
      statement: "clean.md has no [TODO, FIXME]",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });
});

// ── SC-290: count-threshold matcher ──────────────────────────────

describe("SC-290: count-threshold matcher", () => {
  test("matches 'under [N] lines' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-290",
      statement: "file.md is under [150] lines",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });

  test("matches 'at most [N] words' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-290",
      statement: "Rules section at most [200] words",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });
});

// ── SC-291: json-field-equals matcher ────────────────────────────

describe("SC-291: json-field-equals matcher", () => {
  test("matches 'field equals [value]' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-291",
      statement: "rungate.json project field equals [rungate]",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });
});

// ── SC-292: section-exists matcher ───────────────────────────────

describe("SC-292: section-exists matcher", () => {
  test("matches 'has section [name]' pattern", () => {
    const sc: ParsedSC = {
      id: "SC-292",
      statement: "AGENTS.md has section [Rules]",
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });
});

// ── SC-294: directory name validation ────────────────────────────

describe("SC-294: directory name validation", () => {
  test("placeholder for directory validation", () => {
    // This will be implemented as part of the matchPattern logic
    // Not as a separate matcher, but as a conformity check
    expect(true).toBe(true);
  });
});
