/**
 * #600 — every day stamp in the tree goes through `localCalendarDay`, or says
 * in writing why it is UTC on purpose.
 *
 * Fixing `scripts/update-project-state.ts` alone would have left nineteen
 * other sites doing the same thing, each one a day stamp that is wrong for
 * four hours a day. This file is the ratchet: it ENUMERATES the sites rather
 * than asserting that one of them is clean, and it reports its own coverage —
 * how many files it read and how many sites it found — because a scan that
 * reports a verdict without its coverage cannot be told from a scan that read
 * nothing (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The escape hatch is deliberate and deliberately narrow: an instant
 * (`new Date().toISOString()` in full) is zone-free and correct, and a few
 * places genuinely need the UTC day. Those write `UTC-INTENTIONAL: <reason>`
 * in the comment block attached to the line. An empty marker is refused —
 * a waiver nobody has to justify is a warning nobody reads.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..", "..");

/** Where day stamps can live. `workflows/` is included even though it carries none today. */
const SCANNED_DIRS = ["lib", "scripts", "gates", "hooks", "bin", "test", "workflows"];

/**
 * A day stamp written the old way: an instant collapsed to its first ten
 * characters. All three spellings, because this tree carried two of them in
 * one file and a detector that knew one spelling reads exactly like a
 * detector that is satisfied (#484).
 */
const RAW_DAY_STAMP =
  /\.toISOString\(\)\s*\.\s*(?:split\(\s*(['"])T\1\s*\)\s*\[\s*0\s*\]|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/;

/** A day stamp written the new way. The definition itself is not a call site. */
const HELPER_CALL = /(?<!function\s)\blocalCalendarDay\s*\(/;

/** The waiver, which must carry a reason. */
const JUSTIFICATION = /UTC-INTENTIONAL:\s*\S/;

/** A line that is nothing but comment, for walking up to an attached block. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

export type SiteKind = "helper" | "raw";

export interface DayStampSite {
  file: string;
  line: number;
  kind: SiteKind;
  justified: boolean;
  text: string;
}

/**
 * Blank out comments, preserving line numbering.
 *
 * Load-bearing rather than tidy: `lib/local-calendar-day.ts`'s own docstring
 * QUOTES the defect it replaced, and a scanner reading raw source reports
 * that quote as a day stamp — the exact shape that made #484's comment-
 * stripping row 3 red instead of 4. Proven below by scanning the real file
 * both ways.
 */
export function withoutComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split("\n")) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      line = " ".repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, m => " ".repeat(m.length));
    const open = line.indexOf("/*");
    if (open !== -1) {
      line = line.slice(0, open);
      inBlock = true;
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    out.push(line);
  }
  return out;
}

/**
 * Is the site at `index` waived?
 *
 * The marker must be on the line itself or in the comment block ATTACHED to
 * it — walk up only while the lines above are comments. A fixed window of N
 * lines would let an unrelated waiver three lines up cover a new site that
 * arrived underneath it.
 */
function isJustified(rawLines: string[], index: number): boolean {
  if (JUSTIFICATION.test(rawLines[index] ?? "")) return true;
  for (let i = index - 1; i >= 0; i--) {
    const line = rawLines[i] ?? "";
    if (!COMMENT_LINE.test(line)) return false;
    if (JUSTIFICATION.test(line)) return true;
  }
  return false;
}

/** Every day stamp site in one file's source. The ONE classifier. */
export function dayStampSitesIn(file: string, source: string): DayStampSite[] {
  const rawLines = source.split("\n");
  const code = withoutComments(source);
  const sites: DayStampSite[] = [];
  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    if (!line.trim()) continue;
    const kind: SiteKind | null = RAW_DAY_STAMP.test(line)
      ? "raw"
      : HELPER_CALL.test(line)
        ? "helper"
        : null;
    if (!kind) continue;
    sites.push({
      file,
      line: i + 1,
      kind,
      justified: kind === "helper" ? true : isJustified(rawLines, i),
      text: rawLines[i].trim(),
    });
  }
  return sites;
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name === "fixtures") continue;
      const abs = join(dir, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(abs);
      else if (/\.(ts|js|mjs|cjs)$/.test(name)) found.push(abs);
    }
  };
  for (const d of SCANNED_DIRS) walk(join(root, d));
  return found;
}

export interface AuditReading {
  filesScanned: number;
  sites: DayStampSite[];
  unjustified: DayStampSite[];
}

export function auditDayStamps(root: string): AuditReading {
  const files = sourceFiles(root);
  const sites: DayStampSite[] = [];
  for (const abs of files) {
    sites.push(...dayStampSitesIn(relative(root, abs), readFileSync(abs, "utf-8")));
  }
  return { filesScanned: files.length, sites, unjustified: sites.filter(s => !s.justified) };
}

function withTree<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "daystamp-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The three literals below are the scanner's own fixtures — the defect text
// it has to recognise — so each carries its own marker. A block comment above
// the first would not reach the other two, which is the point of walking up
// only through an attached comment block and is asserted directly below.
const RAW_SPLIT = 'const d = new Date().toISOString().split("T")[0];'; // UTC-INTENTIONAL: scanner fixture, not a stamp this project writes
const RAW_SLICE = "const d = new Date().toISOString().slice(0, 10);"; // UTC-INTENTIONAL: scanner fixture, not a stamp this project writes
const RAW_SUBSTR = "const d = new Date().toISOString().substring(0, 10);"; // UTC-INTENTIONAL: scanner fixture, not a stamp this project writes

describe("day-stamp audit — the classifier can tell the three cases apart (#600)", () => {
  test("an unjustified raw stamp is reported, in all three spellings", () => {
    for (const text of [RAW_SPLIT, RAW_SLICE, RAW_SUBSTR]) {
      const sites = dayStampSitesIn("x.ts", `${text}\n`);
      expect(sites.map(s => s.kind), text).toEqual(["raw"]);
      expect(sites[0].justified, text).toBe(false);
    }
  });

  test("a helper call is a site and is never reported", () => {
    const sites = dayStampSitesIn("x.ts", "const d = localCalendarDay();\n");
    expect(sites.map(s => s.kind)).toEqual(["helper"]);
    expect(sites[0].justified).toBe(true);
  });

  test("the helper's own definition is not counted as a call site", () => {
    expect(dayStampSitesIn("x.ts", "export function localCalendarDay(at = new Date()) {\n")).toEqual([]);
  });

  test("a raw stamp with an attached justification is a site and is not reported", () => {
    const sites = dayStampSitesIn("x.ts", `// UTC-INTENTIONAL: the API this feeds is UTC-only\n${RAW_SPLIT}\n`);
    expect(sites.map(s => s.kind)).toEqual(["raw"]);
    expect(sites[0].justified).toBe(true);
  });

  test("a justification with no reason after it does not waive anything", () => {
    // The cheapest wrong fix for a red audit is to paste the marker. A bare
    // marker has to stay red or the hatch is a rubber stamp.
    const sites = dayStampSitesIn("x.ts", `// UTC-INTENTIONAL:\n${RAW_SPLIT}\n`);
    expect(sites[0].justified).toBe(false);
  });

  test("a justification detached by a blank line does not reach the site", () => {
    // Walking up stops at the first non-comment line, so an unrelated waiver
    // further up cannot cover a site that arrives underneath it.
    const sites = dayStampSitesIn("x.ts", `// UTC-INTENTIONAL: something else entirely\n\n${RAW_SPLIT}\n`);
    expect(sites[0].justified).toBe(false);
  });

  test("a raw stamp inside a comment is not a site at all", () => {
    // And the stripper is what makes that true, not luck: the same text
    // un-stripped is reported.
    expect(dayStampSitesIn("x.ts", `// example: ${RAW_SPLIT}\n`)).toEqual([]);
    expect(dayStampSitesIn("x.ts", `${RAW_SPLIT}\n`).length).toBe(1);
  });

  test("a block comment spanning lines is stripped without losing line numbers", () => {
    const src = `/**\n * ${RAW_SPLIT}\n */\n${RAW_SLICE}\n`;
    const sites = dayStampSitesIn("x.ts", src);
    expect(sites.length).toBe(1);
    expect(sites[0].line).toBe(4);
  });
});

describe("day-stamp audit — the walk reaches the classifier (#600)", () => {
  test("a planted unjustified site in a scanned directory is reported by path and line", () => {
    // End to end, not the classifier alone: walk, strip, classify, waive.
    const reading = withTree(
      {
        "lib/clean.ts": "export const d = localCalendarDay();\n",
        "scripts/dirty.ts": `export function f() {\n  return ${RAW_SPLIT}\n}\n`,
      },
      auditDayStamps,
    );
    expect(reading.filesScanned).toBe(2);
    expect(reading.sites.length).toBe(2);
    expect(reading.unjustified.map(s => `${s.file}:${s.line}`)).toEqual(["scripts/dirty.ts:2"]);
  });

  test("a site under fixtures/ is out of scope", () => {
    const reading = withTree({ "test/fixtures/golden/u.ts": `export const d = ${RAW_SPLIT}\n` }, auditDayStamps);
    expect(reading.filesScanned).toBe(0);
    expect(reading.sites).toEqual([]);
  });
});

describe("day-stamp audit — the live tree (#600)", () => {
  const reading = auditDayStamps(ROOT);

  test("the scan read files and found sites — coverage, before any verdict", () => {
    // A scan that read nothing reports zero unjustified sites and is
    // indistinguishable from a clean tree. Say the numbers out loud.
    console.log(
      `day-stamp audit: ${reading.sites.length} day-stamp sites ` +
        `(${reading.sites.filter(s => s.kind === "helper").length} via localCalendarDay, ` +
        `${reading.sites.filter(s => s.kind === "raw").length} raw) ` +
        `across ${reading.filesScanned} scanned files; ${reading.unjustified.length} unjustified`,
    );
    expect(reading.filesScanned).toBeGreaterThan(100);
    expect(reading.sites.length).toBeGreaterThanOrEqual(20);
  });

  test("every converted call site is a helper call, and there are at least twenty", () => {
    expect(reading.sites.filter(s => s.kind === "helper").length).toBeGreaterThanOrEqual(20);
  });

  test("no site in the tree is an unjustified raw day stamp", () => {
    expect(reading.unjustified.map(s => `${s.file}:${s.line}  ${s.text}`)).toEqual([]);
  });

  test("the defect quoted in the helper's own docstring is stripped, not counted", () => {
    // The #484 row, reproduced on this tree: raw source reports the quote as
    // a stamp, stripped source does not. Without this the stripper could be
    // deleted and every case above would still pass.
    const source = readFileSync(join(ROOT, "lib", "local-calendar-day.ts"), "utf-8");
    expect(dayStampSitesIn("lib/local-calendar-day.ts", source).filter(s => s.kind === "raw")).toEqual([]);
    const unstripped = source.split("\n").filter(l => RAW_DAY_STAMP.test(l));
    expect(unstripped.length, "the docstring no longer quotes the defect").toBeGreaterThan(0);
  });

  test("scripts/update-project-state.ts — the defect site — carries no raw stamp", () => {
    const source = readFileSync(join(ROOT, "scripts", "update-project-state.ts"), "utf-8");
    const sites = dayStampSitesIn("scripts/update-project-state.ts", source);
    expect(sites.filter(s => s.kind === "raw")).toEqual([]);
    expect(sites.filter(s => s.kind === "helper").length).toBe(1);
  });
});
