import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const REGISTRY_PATH = join(ROOT, "config", "matcher-registry.json");

// Required fields per AC-2
const REQUIRED_FIELDS = ["name", "syntax", "regex", "example", "notes"] as const;

describe("Matcher Registry — config/matcher-registry.json", () => {
  // AC-1 + AC-4: File exists with >= 19 patterns
  test("AC-1/AC-4: matcher-registry.json exists and contains >= 19 patterns", () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true);
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const registry = JSON.parse(raw);
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.length).toBeGreaterThanOrEqual(19);
  });

  // AC-1: All patterns have unique name keys
  test("AC-1: all patterns have unique name keys", () => {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const registry = JSON.parse(raw);
    const names = registry.map((entry: Record<string, unknown>) => entry.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  // AC-2: Every entry has all required fields
  test("AC-2: every entry has required fields (name, syntax, regex, example, notes)", () => {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const registry = JSON.parse(raw);
    const entriesMissingFields: string[] = [];

    for (const entry of registry) {
      for (const field of REQUIRED_FIELDS) {
        if (entry[field] === undefined || entry[field] === null) {
          entriesMissingFields.push(`${entry.name ?? "UNNAMED"} missing ${field}`);
        }
      }
    }

    expect(entriesMissingFields).toEqual([]);
  });

  // AC-3: Schema validation rejects entries with missing required fields
  describe("AC-3: schema validation rejects invalid entries", () => {
    test("rejects entry missing 'name'", () => {
      const invalidEntry = {
        syntax: "X exists",
        regex: "^(\\S+)\\s+exists?\\b",
        example: "AGENTS.md exists",
        notes: "Checks file existence",
      };
      const missing = REQUIRED_FIELDS.filter((f) => !(f in invalidEntry));
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toContain("name");
    });

    test("rejects entry missing 'syntax'", () => {
      const invalidEntry = {
        name: "file-exists",
        regex: "^(\\S+)\\s+exists?\\b",
        example: "AGENTS.md exists",
        notes: "Checks file existence",
      };
      const missing = REQUIRED_FIELDS.filter((f) => !(f in invalidEntry));
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toContain("syntax");
    });

    test("rejects entry missing 'regex'", () => {
      const invalidEntry = {
        name: "file-exists",
        syntax: "X exists",
        example: "AGENTS.md exists",
        notes: "Checks file existence",
      };
      const missing = REQUIRED_FIELDS.filter((f) => !(f in invalidEntry));
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toContain("regex");
    });

    test("rejects entry missing 'example'", () => {
      const invalidEntry = {
        name: "file-exists",
        syntax: "X exists",
        regex: "^(\\S+)\\s+exists?\\b",
        notes: "Checks file existence",
      };
      const missing = REQUIRED_FIELDS.filter((f) => !(f in invalidEntry));
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toContain("example");
    });

    test("rejects entry missing 'notes'", () => {
      const invalidEntry = {
        name: "file-exists",
        syntax: "X exists",
        regex: "^(\\S+)\\s+exists?\\b",
        example: "AGENTS.md exists",
      };
      const missing = REQUIRED_FIELDS.filter((f) => !(f in invalidEntry));
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toContain("notes");
    });

    test("validates all registry entries against schema", () => {
      const raw = readFileSync(REGISTRY_PATH, "utf-8");
      const registry = JSON.parse(raw);

      for (const entry of registry) {
        const missing = REQUIRED_FIELDS.filter((f) => !(f in entry) || entry[f] === null || entry[f] === undefined);
        expect(missing).toEqual([]);
        // Each field should be a non-empty string
        for (const field of REQUIRED_FIELDS) {
          expect(typeof entry[field]).toBe("string");
          expect(entry[field].length).toBeGreaterThan(0);
        }
      }
    });
  });

  // AC-2 bonus: regex fields are valid regular expressions
  test("all regex fields are valid regular expressions", () => {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const registry = JSON.parse(raw);
    const invalidRegex: string[] = [];

    for (const entry of registry) {
      try {
        new RegExp(entry.regex, "i");
      } catch {
        invalidRegex.push(`${entry.name}: ${entry.regex}`);
      }
    }

    expect(invalidRegex).toEqual([]);
  });

  // AC-2 bonus: example matches the regex for each pattern
  test("each example matches its own regex pattern", () => {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const registry = JSON.parse(raw);
    const mismatches: string[] = [];

    for (const entry of registry) {
      const regex = new RegExp(entry.regex, "i");
      if (!regex.test(entry.example)) {
        mismatches.push(`${entry.name}: example "${entry.example}" does not match regex "${entry.regex}"`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
