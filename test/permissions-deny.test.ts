import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const settingsPath = join(__dirname, "..", ".claude", "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

describe("permissions.deny (#45, narrowed in #62)", () => {
  test("cat is denied", () => {
    // "Bash(cat *)" only matches cat as the leading command with an argument,
    // which is always a file read — no false positives.
    expect(settings.permissions.deny).toContain("Bash(cat *)");
  });

  test("head is NOT denied by glob — the glob cannot see file operands", () => {
    // "Bash(head *)" matched stdin filters too (`bun test | head -20`).
    // BashToolGuard + lib/bash-file-read.ts handle head precisely instead.
    expect(settings.permissions.deny).not.toContain("Bash(head *)");
  });

  test("tail is NOT denied by glob — the glob cannot see file operands", () => {
    expect(settings.permissions.deny).not.toContain("Bash(tail *)");
  });

  test("cat is NOT in allow list", () => {
    expect(settings.permissions.allow).not.toContain("Bash(cat *)");
  });

  test("deny array exists and has entries", () => {
    expect(settings.permissions.deny).toBeInstanceOf(Array);
    expect(settings.permissions.deny.length).toBeGreaterThanOrEqual(1);
  });
});
