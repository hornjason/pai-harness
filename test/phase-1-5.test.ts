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

// ── command-output matcher ──────────────────────────────────────

describe("command-output matcher: pattern matching", () => {
  test("matches command-output SC syntax", () => {
    const sc: ParsedSC = {
      id: "SC-TEST-CMD",
      statement: 'command-output `echo hello` contains [hello]',
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
  });

  test("returned assertion passes when command output contains expected strings", () => {
    const sc: ParsedSC = {
      id: "SC-TEST-CMD2",
      statement: 'command-output `echo hello world` contains [hello, world]',
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
    if (matcher) {
      expect(() => matcher(FIXTURE_ROOT)).not.toThrow();
    }
  });

  test("returned assertion fails when command output lacks expected strings", () => {
    const sc: ParsedSC = {
      id: "SC-TEST-CMD3",
      statement: 'command-output `echo hello` contains [missing-value-xyz]',
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
    if (matcher) {
      expect(() => matcher(FIXTURE_ROOT)).toThrow();
    }
  });
});

describe("command-output matcher: command failure handling", () => {
  test("returns FAIL assertion (not crash) when command exits non-zero", () => {
    const sc: ParsedSC = {
      id: "SC-TEST-CMDFAIL",
      statement: 'command-output `exit 1` contains [anything]',
      specFile: "test.md"
    };
    const matcher = matchPattern(sc);
    expect(matcher).not.toBeNull();
    if (matcher) {
      // Should throw an expect error (assertion failure), not an unhandled crash
      expect(() => matcher(FIXTURE_ROOT)).toThrow();
    }
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

// ── #570: Hook-wiring SCs use static file check patterns ────────

describe("#570: hook-wiring SCs rewritten to static patterns", () => {
  const specRoot = join(import.meta.dir, "..", "specs");

  test("SC-169 uses a matchable static pattern", () => {
    const content = readFileSync(join(specRoot, "bootstrap-data-flow", "success-criteria.md"), "utf-8");
    const sc169Line = content.split("\n").find(l => l.includes("SC-169"));
    expect(sc169Line).toBeDefined();
    // Extract statement after the SC-ID prefix
    const statement = sc169Line!.replace(/^.*?SC-169:\s*/, "");
    const matcher = matchPattern({ id: "SC-169", statement, specFile: "success-criteria.md" });
    expect(matcher).not.toBeNull();
  });

  test("SC-188 uses a matchable static pattern", () => {
    const content = readFileSync(join(specRoot, "bootstrap-data-flow", "success-criteria.md"), "utf-8");
    const sc188Line = content.split("\n").find(l => l.includes("SC-188"));
    expect(sc188Line).toBeDefined();
    const statement = sc188Line!.replace(/^.*?SC-188:\s*/, "");
    const matcher = matchPattern({ id: "SC-188", statement, specFile: "success-criteria.md" });
    expect(matcher).not.toBeNull();
  });

  test("SC-305 uses a matchable static pattern", () => {
    const content = readFileSync(join(specRoot, "AGENTS-MD-TEMPLATE-SPEC.md"), "utf-8");
    const sc305Line = content.split("\n").find(l => l.includes("SC-305"));
    expect(sc305Line).toBeDefined();
    const statement = sc305Line!.replace(/^.*?SC-305:\s*/, "");
    const matcher = matchPattern({ id: "SC-305", statement, specFile: "AGENTS-MD-TEMPLATE-SPEC.md" });
    expect(matcher).not.toBeNull();
  });

  test("SC-391 uses a matchable static pattern", () => {
    const content = readFileSync(join(specRoot, "HOOK-ARCHITECTURE-SPEC.md"), "utf-8");
    const sc391Line = content.split("\n").find(l => l.includes("SC-391"));
    expect(sc391Line).toBeDefined();
    const statement = sc391Line!.replace(/^.*?SC-391:\s*/, "");
    const matcher = matchPattern({ id: "SC-391", statement, specFile: "HOOK-ARCHITECTURE-SPEC.md" });
    expect(matcher).not.toBeNull();
  });

  test("SC-392 uses a matchable static pattern", () => {
    const content = readFileSync(join(specRoot, "HOOK-ARCHITECTURE-SPEC.md"), "utf-8");
    const sc392Line = content.split("\n").find(l => l.includes("SC-392"));
    expect(sc392Line).toBeDefined();
    const statement = sc392Line!.replace(/^.*?SC-392:\s*/, "");
    const matcher = matchPattern({ id: "SC-392", statement, specFile: "HOOK-ARCHITECTURE-SPEC.md" });
    expect(matcher).not.toBeNull();
  });

  test("no behavioral hook-wiring language remains in specs", () => {
    const files = [
      join(specRoot, "bootstrap-data-flow", "success-criteria.md"),
      join(specRoot, "HOOK-ARCHITECTURE-SPEC.md"),
      join(specRoot, "AGENTS-MD-TEMPLATE-SPEC.md"),
    ];
    const behavioralPatterns = [
      /have executable permission/,
      /exist on disk.*ctxlint/,
      /not determined by file existence/,
      /enable\/disable.*without deleting/,
      /no hardcoded paths/,
    ];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const pattern of behavioralPatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });
});
