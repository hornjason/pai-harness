/**
 * Generator unit test: code-map
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { FRESHNESS_NOTICE, generateCodeMap } from "../lib/generators/code-map";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";

describe("generateCodeMap with mock ProjectScan", () => {
  test("returns string with code-map frontmatter", () => {
    const scan = mockProjectScan({
      name: "map-project",
      dirs: [{ name: "src", types: ["ts"] }],
      deps: 5,
      devDeps: 3,
    });
    const result = generateCodeMap(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("doc-type: code-map");
    expect(result).toContain("status: generated");
  });

  test("includes project name in title", () => {
    const scan = mockProjectScan({ name: "named-project" });
    const result = generateCodeMap(scan);
    expect(result).toContain("# Code Map — named-project");
  });

  test("includes directory structure table", () => {
    const scan = mockProjectScan({
      name: "dir-test",
      dirs: [
        { name: "src", types: ["ts", "tsx"] },
        { name: "lib", types: ["ts"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Directory Structure");
    expect(result).toContain("| lib/ | ts |");
    expect(result).toContain("| src/ | ts, tsx |");
  });

  test("includes dependency counts", () => {
    const scan = mockProjectScan({
      name: "deps-test",
      deps: 15,
      devDeps: 9,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Dependencies | 15 |");
    expect(result).toContain("| Dev dependencies | 9 |");
  });

  test("includes API routes when present", () => {
    const scan = mockProjectScan({
      name: "api-test",
      routes: [
        { method: "POST", path: "/api/users", file: "src/routes.ts" },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## API Routes");
    expect(result).toContain("| POST | /api/users | src/routes.ts |");
  });

  test("omits API routes section when empty", () => {
    const scan = mockProjectScan({
      name: "no-routes",
      routes: [],
    });
    const result = generateCodeMap(scan);
    expect(result).not.toContain("## API Routes");
  });

  test("includes source modules when present", () => {
    const scan = mockProjectScan({
      name: "modules-test",
      modules: [
        { file: "src/helpers.ts", exports: ["parseDate", "formatCurrency"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Source Modules");
    expect(result).toContain("| src/helpers.ts | parseDate, formatCurrency |");
  });

  test("omits modules section when empty", () => {
    const scan = mockProjectScan({
      name: "no-modules",
      modules: [],
    });
    const result = generateCodeMap(scan);
    expect(result).not.toContain("## Source Modules");
  });

  test("includes summary table with counts", () => {
    const scan = mockProjectScan({
      name: "summary-test",
      dirs: [
        { name: "a", types: ["ts"] },
        { name: "b", types: ["js"] },
        { name: "c", types: ["md"] },
      ],
      deps: 10,
      devDeps: 5,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Source directories | 3 |");
    expect(result).toContain("| Dependencies | 10 |");
  });
});

// ── #1163: the census is gone, and cannot come back quietly ──────────────

/**
 * The per-directory file census, removed — and held removed.
 *
 * The question these cases ask is not "does the string `fileCount` appear".
 * It is whether the RENDERED table can carry a per-directory number again,
 * because that is the thing that was wrong: MEASURED over the 50 commit
 * transitions ending at `b7281397`, 22 of them moved a count and 0 moved the
 * directory list. A reader cannot tell a count that is right from one that
 * is two merges old, so the file stopped carrying one.
 *
 * **What was broken to prove these fail** (`.claude/rules/checks-must-be-able-to-fail.md`):
 * the renderer's row template was put back to
 * `| ${d.name}/ | ${(d as any).types.length} | ${d.types.join(", ")} |` —
 * the cheapest way to reintroduce a per-directory number now that
 * `fileCount` is off the type. `the table has exactly two columns` went
 * **red**, naming the three-cell row. Restoring the two-column template
 * turned it green again.
 *
 * The ORDER case is the second half, and it is here because the old sort was
 * `b.fileCount - a.fileCount`: an order derived from the census is still the
 * census, one indirection away. Reversing the input must not reverse the
 * output.
 */
describe("#1163: CODE-MAP carries no per-directory census", () => {
  const dirs = [
    { name: "zeta", types: ["ts"] },
    { name: "alpha", types: ["md"] },
    { name: "mid", types: ["json"] },
  ];

  /** The body rows of the `## Directory Structure` table, header excluded. */
  function directoryRows(md: string): string[] {
    const section = md.split("## Directory Structure")[1];
    if (section === undefined) return [];
    return section
      .split("\n## ")[0]
      .split("\n")
      .filter(l => l.startsWith("| ") && !l.startsWith("| Directory") && !l.startsWith("|---"));
  }

  test("the table has exactly two columns, so no count column can return", () => {
    const md = generateCodeMap(mockProjectScan({ name: "census", dirs }));
    const rows = directoryRows(md);
    // The instrument first: a reader that found no rows would satisfy every
    // assertion below by having nothing to check.
    expect(rows, "the Directory Structure table was not found, so this reading is a refusal").toHaveLength(
      dirs.length,
    );
    expect(md, "the header gained a column").toContain("| Directory | Types |");
    const widths = [...new Set(rows.map(r => r.split("|").length))];
    expect(
      widths,
      `a directory row carries more than two cells — the per-directory census is back, and 22 of ` +
        `50 consecutive commits moved one (#1163):\n${rows.join("\n")}`,
    ).toEqual([4]); // "", name, types, "" — two cells between three pipes plus the trailing empty
  });

  test("the rows are ordered by name, not by anything that was counted", () => {
    const forward = generateCodeMap(mockProjectScan({ name: "census", dirs }));
    const reversed = generateCodeMap(mockProjectScan({ name: "census", dirs: [...dirs].reverse() }));
    expect(
      directoryRows(forward).map(r => r.split("|")[1].trim()),
      "the rows are not in name order",
    ).toEqual(["alpha/", "mid/", "zeta/"]);
    // ONE input difference, and it is the input order. If the renderer ever
    // sorts by a property of the entry again, these two diverge.
    expect(reversed, "reversing the input reversed the output — the order is not derived from the name").toBe(
      forward,
    );
  });

  test("the file states what it guarantees and what it does not", () => {
    const md = generateCodeMap(mockProjectScan({ name: "census", dirs }));
    expect(md, "a map that does not say how fresh it is invites the next reader to trust a stale row").toContain(
      FRESHNESS_NOTICE,
    );
    // Not a decorative sentence: it has to name the thing that cannot be
    // fixed, or it is reassurance rather than a disclaimer.
    expect(FRESHNESS_NOTICE).toContain("scanned-at-sha");
    expect(FRESHNESS_NOTICE).toContain("#1163");
  });
});
