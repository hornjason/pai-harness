/**
 * #839 sub-issue: one accessor for `ci.workflowOverrides`.
 *
 * A consumer declines a generated top-level workflow key by declaring it in
 * the config. Nothing read that key before this file existed, so the whole
 * point is to make sure the FIRST reader is also the ONLY reader, and that it
 * answers the three questions the other accessors in `lib/config-readers.ts`
 * already answer in the open:
 *
 *  - absent config is `{}` — and a caller that needs to tell "no config" from
 *    "a config declaring no overrides" asks `resolveConfig`, which is the
 *    distinction ADR-001 D2 exists for;
 *  - a malformed config THROWS. A bare catch here would turn a corrupt config
 *    into "the consumer declined nothing", which silently hands every
 *    top-level key back to the generator;
 *  - both layouts resolve. Every pre-#214 reader read the monolith only, so a
 *    consumer who followed the documented migration got `{}` and no warning.
 *
 * The accessor's own shape refusal is deliberate too: `workflowOverrides: "no"`
 * is corruption inside well-formed JSON, and reading it as "no overrides" is
 * the same defect as the bare catch, arriving one layer down.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { readWorkflowOverrides } from "../lib/config-readers";
import { resolveConfig } from "../lib/config-loader";
import { stripJsComments } from "../lib/strip-js-comments";

const REPO = join(import.meta.dir, "..");

/** The authored declines every layout case below reads back. */
const AUTHORED_OVERRIDES = {
  "ci.yml": { decline: ["permissions"] },
  "gates.yml": { decline: ["on", "concurrency"] },
};

const EXPECTED: Record<string, string[]> = {
  "ci.yml": ["permissions"],
  "gates.yml": ["on", "concurrency"],
};

const scratch: string[] = [];

type Layout = "directory" | "monolith" | "neither" | "malformed" | "no-overrides";

function makeRoot(layout: Layout, ci?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-839-"));
  scratch.push(root);
  const claude = join(root, ".claude");
  mkdirSync(claude, { recursive: true });

  if (layout === "neither") return root;

  const dir = join(claude, "rungate");

  if (layout === "malformed") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ this is not json");
    return root;
  }

  const base = { project: "overrides-fixture", repo: "x/y", issueRepo: "x/y" };
  const body =
    layout === "no-overrides"
      ? { ...base, ci: { shards: 4 } }
      : { ...base, ci: { workflowOverrides: ci ?? AUTHORED_OVERRIDES } };

  if (layout === "monolith") {
    writeFileSync(join(claude, "rungate.json"), JSON.stringify(body, null, 2));
    return root;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(body, null, 2));
  return root;
}

function cleanup(): void {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
}

// ── AC-1: the reading, and the two empties a caller can still tell apart ────

describe("AC-1: the declined keys per workflow file, and two distinguishable empties", () => {
  test("a declaring config yields its declines, keyed by workflow file", () => {
    const root = makeRoot("directory");
    try {
      expect(readWorkflowOverrides(root)).toEqual(EXPECTED);
      // Not vacuous: the fixture really declares something, so the empty
      // cases below are about absence rather than about an empty fixture.
      expect(Object.values(EXPECTED).flat().length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("absent config and a config declaring no overrides both read {} — and resolveConfig separates them", () => {
    const none = makeRoot("neither");
    const silent = makeRoot("no-overrides");
    try {
      expect(readWorkflowOverrides(none)).toEqual({});
      expect(readWorkflowOverrides(silent)).toEqual({});

      // The accessor's `{}` is the same object in both cases ON PURPOSE. The
      // caller that needs the distinction does not guess from the emptiness;
      // it asks the resolver, and gets two different answers.
      expect(resolveConfig(none).status).toBe("absent");
      expect(resolveConfig(silent).status).toBe("resolved");
    } finally {
      cleanup();
    }
  });

  test("a file declared with no declines reads as an empty list, not as an absent file", () => {
    const root = makeRoot("directory", { "ci.yml": { decline: [] } });
    try {
      const read = readWorkflowOverrides(root);
      // Key present, list empty. `"ci.yml" in read` is the distinction, and it
      // is lost the moment an empty list is dropped from the reading.
      expect(Object.keys(read)).toEqual(["ci.yml"]);
      expect(read["ci.yml"]).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ── AC-2: corruption is never absence ───────────────────────────────────────

describe("AC-2: a malformed config throws rather than reading as 'no overrides'", () => {
  test("unparseable JSON throws", () => {
    const bad = makeRoot("malformed");
    try {
      expect(() => readWorkflowOverrides(bad)).toThrow();
    } finally {
      cleanup();
    }
  });

  test("a well-formed config whose overrides are the wrong SHAPE throws, naming the key", () => {
    // Each of these is valid JSON and meaningless as a declaration. Reading
    // any of them as `{}` hands every top-level key back to the generator
    // while the consumer believes it declined one.
    const wrong: Array<[string, unknown]> = [
      ["a string where the map belongs", "permissions"],
      ["an array where the map belongs", ["ci.yml"]],
      ["an entry that is not an object", { "ci.yml": "permissions" }],
      ["a decline list that is not an array", { "ci.yml": { decline: "permissions" } }],
      ["a decline entry that is not a string", { "ci.yml": { decline: [7] } }],
      ["a decline entry that is blank", { "ci.yml": { decline: ["  "] } }],
    ];
    try {
      for (const [why, value] of wrong) {
        const root = makeRoot("directory", value);
        expect(() => readWorkflowOverrides(root), why).toThrow(/workflowOverrides/);
      }
    } finally {
      cleanup();
    }
  });
});

// ── AC-3: both layouts, or the documented migration switches the feature off ─

describe("AC-3: a directory-layout consumer reads the same as a monolith consumer", () => {
  test("the two layouts agree, and both agree with what was authored", () => {
    const dir = makeRoot("directory");
    const mono = makeRoot("monolith");
    try {
      expect(readWorkflowOverrides(dir)).toEqual(EXPECTED);
      // Parity rather than a second literal: a reader that handled only the
      // directory form passes the line above and is the bug this guards.
      expect(readWorkflowOverrides(dir)).toEqual(readWorkflowOverrides(mono));
    } finally {
      cleanup();
    }
  });
});

// ── AC-4: one reader, and the rules file names it ───────────────────────────

const SCAN_DIRS = ["lib", "scripts", "gates", "hooks", "workflows", "bin"];
const KEY = "workflowOverrides";
const ACCESSOR = `read${KEY[0].toUpperCase()}${KEY.slice(1)}`;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(child);
    }
  };
  for (const dir of SCAN_DIRS) walk(join(REPO, dir));
  return out;
}

/**
 * Files that name the CONFIG KEY in code — comments stripped, and the
 * accessor's own name discounted, so a future caller may write
 * `readWorkflowOverrides(root)` and a future comment may explain the key
 * without either reading as a second reader.
 */
function keyReaders(): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const code = stripJsComments(readFileSync(file, "utf-8")).split(ACCESSOR).join("");
    if (code.includes(KEY)) hits.push(relative(REPO, file));
  }
  return hits.sort();
}

describe("AC-4: the accessor is the single reader, and the accessor table says so", () => {
  test("exactly one file in the tree names the config key in code", () => {
    const files = sourceFiles();
    // The instrument first: an empty walk reports perfect compliance.
    expect(files.length).toBeGreaterThan(100);
    expect(keyReaders()).toEqual(["lib/config-readers.ts"]);
  });

  test("the scan can see a second reader when there is one", () => {
    // Without this the assertion above is satisfied by a scan that strips the
    // key out of every file it reads.
    const planted = stripJsComments(
      ["// a comment naming ci.workflowOverrides, which is prose", "const x = ci.workflowOverrides;"].join("\n"),
    ).split(ACCESSOR).join("");
    expect(planted.includes(KEY)).toBe(true);

    const prose = stripJsComments("// ci.workflowOverrides is read by readWorkflowOverrides\n")
      .split(ACCESSOR).join("");
    expect(prose.includes(KEY)).toBe(false);
  });

  test("the rules file names the accessor in the same table as the roles/slug/remote-hosts row", () => {
    const doc = readFileSync(join(REPO, ".claude", "rules", "config-access.md"), "utf-8");
    const rows = doc
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"));
    // Slice, not document: a match anywhere in the file would be satisfied by
    // the prose below the table.
    expect(rows.length).toBeGreaterThan(3);

    const siblings = rows.filter((row) => row.includes("config-readers"));
    expect(siblings.some((row) => row.includes("roles"))).toBe(true);
    expect(siblings.some((row) => row.includes(ACCESSOR))).toBe(true);
  });
});
