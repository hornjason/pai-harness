/**
 * The import reading, and the two text readings it replaces (#1219).
 *
 * Every case here runs THREE readings over the same input — the two greps
 * that guarded the scanner's import isolation before this change, and the
 * parsed reading that replaces them — and asserts all three verdicts. The
 * rows where they disagree are the argument for the change, so they are
 * executed rather than described: if the parsed reading ever stops being the
 * one that is right, a row goes red naming the input.
 *
 * The inputs are the REAL `lib/scanner.ts` source with one line injected,
 * not a toy module. A reading that works on a five-line fixture and not on
 * the file it guards has not been measured on the file it guards.
 *
 * Nothing here is written to disk and nothing is loaded as a module, so the
 * `mkdtemp` hazard in `.claude/rules/self-referential-tests.md` Tier 1 does
 * not apply: the mutants are strings.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { generationImports, isGenerationModule, parseImports } from "./helpers/import-specifiers";

const ROOT = join(import.meta.dir, "..");
const SCANNER = "lib/scanner.ts";
const SCANNER_SOURCE = readFileSync(join(ROOT, SCANNER), "utf-8");

/** The reading `test/unit/scanner.test.ts` used: four function names, whole file. */
function oldSymbolGrep(source: string): boolean {
  return source.match(/generateAgentsMd|generateCodeMap|generateConformityTest|safeWrite/g) !== null;
}

/** The reading `test/scanner.test.ts` AC-3 used: three module paths, whole file. */
function oldPathGrep(source: string): boolean {
  return /from.*generators\/(agents-md|agent-briefs|code-map)/.test(source);
}

/** The parsed reading. */
function parsed(source: string): boolean {
  return generationImports(source, SCANNER).length > 0;
}

/** Real scanner source with one line appended. */
function withLine(line: string): string {
  return `${SCANNER_SOURCE}\n${line}\n`;
}

interface Row {
  what: string;
  line: string;
  oldSymbol: boolean;
  oldPath: boolean;
  /** The correct answer, which is also what the parsed reading must say. */
  violation: boolean;
}

/**
 * The disagreement set, as cases. `oldSymbol` and `oldPath` are what the two
 * text readings say; `violation` is the truth. Wherever a text column differs
 * from `violation`, that reading is wrong about this input.
 */
const ROWS: Row[] = [
  {
    what: "a comment naming a generator function and its module",
    // The shape that reddened CI shard 4 on #1200, with a module path added
    // so it trips the path grep too.
    line: `// The copy that used to live here came from "./generators/code-map" (generateCodeMapInline).`,
    oldSymbol: true,
    oldPath: true,
    violation: false,
  },
  {
    what: "a string literal quoting an import of a generator",
    line: `export const NOTE = 'import { generateCodeMap } from "./generators/code-map"';`,
    oldSymbol: true,
    oldPath: true,
    violation: false,
  },
  {
    what: "a block comment holding a type-only import of a generator",
    // The un-erasure pass rewrites this text too. It is still a comment after
    // the rewrite, so the parser still discards it.
    line: `/* import type { DirRow } from "./generators/code-map"; */`,
    oldSymbol: false,
    oldPath: true,
    violation: false,
  },
  {
    what: "a dynamic import of a generator for a symbol outside the four names",
    line: `export async function notice() { const m = await import("./generators/code-map"); return m.FRESHNESS_NOTICE; }`,
    oldSymbol: false,
    oldPath: false,
    violation: true,
  },
  {
    what: "a static import of a generator for a symbol outside the four names",
    line: `import { directoryTable } from "./generators/code-map";`,
    oldSymbol: false,
    oldPath: true,
    violation: true,
  },
  {
    what: "a namespace import of a generator",
    line: `import * as codeMap from "./generators/code-map";`,
    oldSymbol: false,
    oldPath: true,
    violation: true,
  },
  {
    what: "a type-only import of a generator",
    line: `import type { DirRow } from "./generators/code-map";`,
    oldSymbol: false,
    oldPath: true,
    violation: true,
  },
  {
    what: "a dynamic import of scaffold/steps, where safeWrite actually lives",
    line: `export async function w() { const s = await import("./scaffold/steps"); return s.safeWrite; }`,
    oldSymbol: true,
    oldPath: false,
    violation: true,
  },
  {
    what: "a static import of scaffold/steps for a symbol outside the four names",
    line: `import { generateCodeMapStep } from "./scaffold/steps";`,
    // `generateCodeMapStep` contains `generateCodeMap`, so the symbol grep
    // catches this one by accident. Rename the export and it stops.
    oldSymbol: true,
    oldPath: false,
    violation: true,
  },
  {
    what: "a static import of scaffold/steps under a name none of the four spell",
    line: `import { scaffoldSteps } from "./scaffold/steps";`,
    oldSymbol: false,
    oldPath: false,
    violation: true,
  },
  {
    what: "a require of a generator",
    line: `const briefs = require("./generators/agent-briefs");`,
    oldSymbol: false,
    oldPath: false,
    violation: true,
  },
  {
    what: "a value import of generators/types, which is the typed interface",
    line: `import { } from "./generators/types";`,
    oldSymbol: false,
    oldPath: false,
    violation: false,
  },
];

describe("import reading: the parsed reading is right on every row", () => {
  for (const row of ROWS) {
    test(`${row.what} — ${row.violation ? "is" : "is not"} a generation import`, () => {
      const source = withLine(row.line);
      expect(parsed(source)).toBe(row.violation);
    });
  }
});

describe("import reading: what the text readings got wrong", () => {
  // Not decoration. If a text reading is corrected elsewhere, or the symbol
  // list changes, these rows go red and the disagreement set in #1219 is
  // stale — which is exactly when somebody should be told.
  for (const row of ROWS) {
    test(`${row.what} — text readings read as documented`, () => {
      const source = withLine(row.line);
      expect({ symbol: oldSymbolGrep(source), path: oldPathGrep(source) }).toEqual({
        symbol: row.oldSymbol,
        path: row.oldPath,
      });
    });
  }

  test("the disagreement set is not empty in either direction", () => {
    const falsePositives = ROWS.filter((r) => !r.violation && (r.oldSymbol || r.oldPath));
    const missed = ROWS.filter((r) => r.violation && !r.oldSymbol && !r.oldPath);
    // A reading both text greps miss entirely is the direction that matters:
    // a guard that cannot see the thing it exists to see.
    expect(missed.length).toBeGreaterThan(0);
    expect(falsePositives.length).toBeGreaterThan(0);
  });
});

describe("import reading: an empty reading is UNMEASURED, not zero", () => {
  test("unparseable source throws rather than reporting no imports", () => {
    expect(() => parseImports(`import { a from "./b"; const`, SCANNER)).toThrow(/UNMEASURED/);
  });

  test("a source whose type-pass rewrite would not parse throws too", () => {
    // `export type Foo = …` must survive the rewrite untouched; if the
    // narrowing on that replacement is ever widened, this is the input that
    // stops parsing, and it must throw rather than come back empty.
    const imports = parseImports(`export type Foo = string;\nimport { a } from "./b";`, SCANNER);
    expect(imports.map((i) => i.specifier)).toEqual(["./b"]);
  });

  test("a file with genuinely no imports reads as empty, and does not throw", () => {
    expect(parseImports(`export const x = 1;`, SCANNER)).toEqual([]);
  });

  test("a hashbang does not make a readable file unreadable", () => {
    // `scanImports` refuses `#!/usr/bin/env bun` outright. Measured over the
    // tree, that was the only cause of an unreadable file — 107 of 946, all
    // of them executables — and every one of those would have reported
    // UNMEASURED for a reason that has nothing to do with its imports.
    const body = `import { a } from "./b";\nconst c = await import("./generators/code-map");`;
    const withBang = parseImports(`#!/usr/bin/env bun\n${body}`, SCANNER);
    expect(withBang.map((i) => i.specifier)).toEqual(parseImports(body, SCANNER).map((i) => i.specifier));
    expect(withBang.map((i) => i.specifier)).toEqual(["./b", "./generators/code-map"]);
  });
});

describe("import reading: the real scanner source", () => {
  test("the baseline: unmodified, all three readings say clean", () => {
    // Read this row before any mutation row. Every row above is this source
    // plus one line, so a baseline that is already dirty makes all of them
    // vacuous.
    expect(oldSymbolGrep(SCANNER_SOURCE)).toBe(false);
    expect(oldPathGrep(SCANNER_SOURCE)).toBe(false);
    expect(parsed(SCANNER_SOURCE)).toBe(false);
  });

  test("the reading is taken — scanner.ts has imports, so an empty list is a broken instrument", () => {
    const imports = parseImports(SCANNER_SOURCE, SCANNER);
    expect(imports.length).toBeGreaterThan(5);
  });

  test("generators/types is read as a type-only import, and allowed", () => {
    const types = parseImports(SCANNER_SOURCE, SCANNER).filter((i) => i.resolved === "lib/generators/types");
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((i) => i.typeOnly)).toBe(true);
    expect(types.some((i) => isGenerationModule(i.resolved))).toBe(false);
  });

  test("the comment #1200 had to reword no longer reds anything", () => {
    // Verbatim shape of the comment that cost a CI shard, restored.
    const source = withLine(
      `// One binding for what a "type" is, shared with\n// \`scripts/generate-code-map.ts\` and \`generateCodeMapInline\`.`,
    );
    expect(oldSymbolGrep(source)).toBe(true);
    expect(generationImports(source, SCANNER)).toEqual([]);
  });
});

describe("import reading: module classification", () => {
  test("every generator module except types counts, and a package does not", () => {
    expect(isGenerationModule("lib/generators/code-map")).toBe(true);
    expect(isGenerationModule("lib/generators/agents-md")).toBe(true);
    expect(isGenerationModule("lib/generators/agent-briefs")).toBe(true);
    // Widened on purpose: a generator added tomorrow is covered without an
    // edit here, which is what the three-path grep could not do.
    expect(isGenerationModule("lib/generators/future-generator")).toBe(true);
    expect(isGenerationModule("lib/generators/types")).toBe(false);
    expect(isGenerationModule("lib/scaffold/steps")).toBe(true);
    expect(isGenerationModule("lib/harness-identity")).toBe(false);
    expect(isGenerationModule(null)).toBe(false);
  });

  test("a package specifier resolves to null rather than a repo path", () => {
    const imports = parseImports(`import { z } from "zod";\nimport { join } from "path";`, SCANNER);
    expect(imports.map((i) => i.resolved)).toEqual([null, null]);
  });

  test("the self-naming package specifier resolves into the repo", () => {
    const imports = parseImports(`import { generateCodeMap } from "rungate/lib/generators/code-map";`, SCANNER);
    expect(imports[0].resolved).toBe("lib/generators/code-map");
    expect(isGenerationModule(imports[0].resolved)).toBe(true);
  });
});
