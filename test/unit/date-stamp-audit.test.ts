/**
 * Covers AC-3, AC-5 (#600) — every day-stamp site in the tree, enumerated.
 *
 * #600 was one line in `scripts/update-project-state.ts`. It was also
 * nineteen other lines spelling the same mistake in two syntaxes, and fixing
 * the one that was reported would have left the other nineteen stamping UTC
 * days on documents dated by humans. So the guard is a CENSUS rather than a
 * grep for the known site: it enumerates every day-stamp expression in the
 * tree and refuses any that neither goes through `localCalendarDay` nor says
 * out loud why UTC is intended.
 *
 * Three properties, each a lesson from `.claude/rules/checks-must-be-able-to-fail.md`:
 *
 * - **The scan reports its own coverage** (#492). `36 of 426` and `426 of 426`
 *   are the same PASS, and no reader can tell them apart from the output, so
 *   the file count and byte count are asserted and printed. A census whose
 *   walk silently shrank to four files would otherwise read as a clean tree.
 * - **Comments are blanked before anything is counted** (#484). This file, the
 *   helper's docstring, and the mutation battery all QUOTE the defect in
 *   prose. Scanning raw source reports a quotation as a site, which is both a
 *   false red and — once you add the quotation to an ignore list — a hole.
 * - **The classifier is exercised on synthetic inputs** (#500). Today the tree
 *   is clean, so every assertion about it holds vacuously the moment the
 *   classifier stops classifying. The last block feeds it a raw site, a
 *   justified site, a helper site and an empty justification, and asserts the
 *   verdicts differ.
 *
 * **The cheapest wrong fix, named in advance** (fifth shape): somebody adds a
 * raw stamp and writes `// UTC-INTENTIONAL:` above it with nothing after the
 * colon. That is the 5pm repair for this guard, it is one line, and it is why
 * a justification shorter than `MIN_REASON` is counted as no justification at
 * all — asserted below rather than left as a comment.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = join(import.meta.dir, "..", "..");

/** Directories a census of THIS project's code must not walk into. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "worktrees",
]);

/**
 * Fixtures are sample projects, not this project's code. `test/fixtures/`
 * holds a golden project whose own source is the subject of other tests, and
 * rewriting it would change what those tests measure.
 */
const FIXTURE_SEGMENTS = [join("test", "fixtures") + sep, join("templates") + sep];

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * A calendar DAY derived from an instant's UTC rendering — the defect.
 *
 * All three syntaxes, because they are one question asked three ways and a
 * detector that knows only one reads exactly like a detector that is
 * satisfied (#484). `scripts/` used `.split("T")[0]`, `lib/` used
 * `.slice(0, 10)`, and `lib/scaffold/steps.ts` carried both in one file.
 */
const RAW_DAY_STAMP =
  /toISOString\(\)\s*\.\s*(?:split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\]|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/;

/** A day stamp that goes through the shared rule. */
const HELPER_CALL = /\blocalCalendarDay\s*\(/;

/** The declaration is not a call site. */
const HELPER_DECLARATION = /function\s+localCalendarDay\s*\(/;

/** The marker that makes a UTC day stamp deliberate, and the reason it needs. */
const JUSTIFICATION = /UTC-INTENTIONAL:(.*)$/;
const MIN_REASON = 20;
/** How many lines above a site a justification may sit. */
const JUSTIFICATION_LOOKBEHIND = 4;

export type SiteKind = "helper" | "raw-justified" | "raw-unjustified";

export interface DayStampSite {
  file: string;
  line: number;
  kind: SiteKind;
  text: string;
}

export interface DayStampCensus {
  filesScanned: number;
  bytesScanned: number;
  sites: DayStampSite[];
}

/**
 * `source` with comment bodies blanked and string literals left alone.
 *
 * Blanking rather than deleting keeps every offset and every line number
 * where it was, so a reported site still points at the right place.
 */
export function blankComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === c) {
          i++;
          break;
        } else i++;
      }
    } else i++;
  }
  return out.join("");
}

/**
 * Classify every day-stamp site in one file's source.
 *
 * Sites are found in the COMMENT-BLANKED text; justifications are looked for
 * in the RAW text, because a justification is a comment by construction.
 */
export function dayStampSitesIn(file: string, source: string): DayStampSite[] {
  const raw = source.split("\n");
  const code = blankComments(source).split("\n");
  const sites: DayStampSite[] = [];
  for (let i = 0; i < code.length; i++) {
    const codeLine = code[i];
    const isRaw = RAW_DAY_STAMP.test(codeLine);
    const isHelper = HELPER_CALL.test(codeLine) && !HELPER_DECLARATION.test(codeLine);
    if (!isRaw && !isHelper) continue;
    if (isRaw) {
      sites.push({
        file,
        line: i + 1,
        kind: justifiedAt(raw, i) ? "raw-justified" : "raw-unjustified",
        text: raw[i].trim(),
      });
    }
    if (isHelper) sites.push({ file, line: i + 1, kind: "helper", text: raw[i].trim() });
  }
  return sites;
}

function justifiedAt(rawLines: string[], index: number): boolean {
  for (let k = index; k >= 0 && k >= index - JUSTIFICATION_LOOKBEHIND; k--) {
    const m = JUSTIFICATION.exec(rawLines[k]);
    // A marker with nothing substantive after it is not a justification. It is
    // the cheapest repair available to anyone this guard stops, so it has to
    // cost at least a sentence.
    if (m && m[1].trim().length >= MIN_REASON) return true;
  }
  return false;
}

export function censusOf(root: string): DayStampCensus {
  const census: DayStampCensus = { filesScanned: 0, bytesScanned: 0, sites: [] };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !CODE_EXT.test(entry.name)) continue;
      const rel = relative(root, abs);
      if (FIXTURE_SEGMENTS.some(seg => rel.startsWith(seg))) continue;
      const source = readFileSync(abs, "utf-8");
      census.filesScanned++;
      census.bytesScanned += source.length;
      census.sites.push(...dayStampSitesIn(rel, source));
    }
  };
  walk(root);
  return census;
}

const census = censusOf(ROOT);

describe("day-stamp census (#600)", () => {
  test("the scan reports its own coverage, and the coverage is the whole tree", () => {
    // Printed, not merely asserted: a verdict with no coverage beside it
    // cannot be told apart from a verdict over four files.
    console.log(
      `day-stamp census: ${census.sites.length} sites in ${census.filesScanned} files ` +
        `(${census.bytesScanned} bytes)`,
    );
    expect(census.filesScanned).toBeGreaterThanOrEqual(100);
    expect(census.bytesScanned).toBeGreaterThan(1_000_000);
  });

  test("at least 20 day-stamp sites were enumerated", () => {
    expect(census.sites.length).toBeGreaterThanOrEqual(20);
  });

  test("every raw UTC day stamp is justified — none is left unexplained", () => {
    const unjustified = census.sites
      .filter(s => s.kind === "raw-unjustified")
      .map(s => `${s.file}:${s.line}  ${s.text}`);
    expect(unjustified).toEqual([]);
  });

  test("the 20 converted sites go through the shared helper", () => {
    const helper = census.sites.filter(s => s.kind === "helper");
    expect(helper.length).toBeGreaterThanOrEqual(20);
  });

  test("AC-5: the rule is exactly one exported binding in lib/", () => {
    expect(exportedHelperDeclarations()).toEqual([join("lib", "local-calendar-day.ts")]);
  });

  test("AC-5: every converted call site IMPORTS the rule rather than re-deriving the day", () => {
    // Scoped to the production sites #600 converted. A test file may carry the
    // name inside a fixture string or resolve the module by path at runtime —
    // `test/unit/local-calendar-day.test.ts` does exactly that, so that it can
    // be spawned against a mutant — and neither is a call site re-deriving a
    // day inline, which is the thing this criterion is about.
    const production = census.sites.filter(s => s.kind === "helper" && !s.file.startsWith("test" + sep));
    const callers = [...new Set(production.map(s => s.file))];
    // 20 sites across 17 files — two files carried the stamp twice and one
    // carried both syntaxes.
    expect(production.length).toBeGreaterThanOrEqual(20);
    const withoutImport = callers.filter(f => {
      const source = readFileSync(join(ROOT, f), "utf-8");
      // The declaring module does not import what it exports.
      if (/^export function localCalendarDay\b/m.test(source)) return false;
      return !/\blocalCalendarDay\b[^\n]*\bfrom\s+["']/.test(source);
    });
    expect(withoutImport).toEqual([]);
  });
});

function exportedHelperDeclarations(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!CODE_EXT.test(entry.name)) continue;
      const source = readFileSync(abs, "utf-8");
      if (/^export function localCalendarDay\b/m.test(source)) found.push(relative(ROOT, abs));
    }
  };
  walk(join(ROOT, "lib"));
  return found.sort();
}

/**
 * The classifier, fed inputs rather than asked about the tree.
 *
 * Every assertion above is about a tree that is currently clean, so all of
 * them stay green if `dayStampSitesIn` starts returning nothing. These do
 * not: each one names a verdict the classifier must produce, and a classifier
 * that returns `[]` fails three of them.
 */
describe("day-stamp classifier (#600)", () => {
  const sitesOf = (src: string) => dayStampSitesIn("probe.ts", src);

  // The two syntaxes of the defect, written down ONCE and interpolated into
  // every case below. Declaring them once means this file contributes two
  // justified sites to its own census rather than eight unjustified ones, and
  // a reader can see in one place what the guard is pointed at.
  //
  // UTC-INTENTIONAL: the next two constants ARE the defect, quoted on purpose
  // as the classifier's input rather than used to stamp anything.
  const SPLIT_FORM = 'new Date().toISOString().split("T")[0]';
  const SLICE_FORM = "new Date().toISOString().slice(0, 10)";

  test("a bare UTC day stamp is refused", () => {
    const sites = sitesOf(`const today = ${SPLIT_FORM};\n`);
    expect(sites.map(s => s.kind)).toEqual(["raw-unjustified"]);
  });

  test("the slice syntax is refused too, not just the split one", () => {
    const sites = sitesOf(`const today = ${SLICE_FORM};\n`);
    expect(sites.map(s => s.kind)).toEqual(["raw-unjustified"]);
  });

  test("a justified UTC day stamp is allowed", () => {
    const sites = sitesOf(
      `// UTC-INTENTIONAL: the contrast reading the case asserts against.\nconst utc = ${SPLIT_FORM};\n`,
    );
    expect(sites.map(s => s.kind)).toEqual(["raw-justified"]);
  });

  test("a marker with no reason after it is NOT a justification", () => {
    // The cheapest wrong fix, blocked: this is what somebody writes at 5pm.
    const sites = sitesOf(`// UTC-INTENTIONAL:\nconst utc = ${SPLIT_FORM};\n`);
    expect(sites.map(s => s.kind)).toEqual(["raw-unjustified"]);
  });

  test("a justification too far above the site does not reach it", () => {
    const sites = sitesOf(
      `// UTC-INTENTIONAL: a reason written a long way from the site.\n\n\n\n\n\nconst utc = ${SPLIT_FORM};\n`,
    );
    expect(sites.map(s => s.kind)).toEqual(["raw-unjustified"]);
  });

  test("a helper call is a site, and the helper's own declaration is not", () => {
    const sites = sitesOf(
      "export function localCalendarDay(at: Date = new Date()): string { return ''; }\n" +
        "const today = localCalendarDay();\n",
    );
    expect(sites.map(s => s.kind)).toEqual(["helper"]);
    expect(sites[0].line).toBe(2);
  });

  test("the defect quoted in a comment is not a site", () => {
    // #484: a docstring that quotes the expression reads exactly like the
    // expression. Three of this issue's files quote it.
    const sites = sitesOf(`// never write ${SPLIT_FORM} here\n`);
    expect(sites).toEqual([]);
  });

  test("the defect inside a block comment is not a site either", () => {
    const sites = sitesOf(`/**\n * ${SLICE_FORM} is the UTC day.\n */\n`);
    expect(sites).toEqual([]);
  });
});
