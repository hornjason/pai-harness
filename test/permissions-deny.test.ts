import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const settingsPath = join(__dirname, "..", ".claude", "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

describe("permissions.deny (#45)", () => {
  test("cat is denied", () => {
    expect(settings.permissions.deny).toContain("Bash(cat *)");
  });

  test("head is denied", () => {
    expect(settings.permissions.deny).toContain("Bash(head *)");
  });

  test("tail is denied", () => {
    expect(settings.permissions.deny).toContain("Bash(tail *)");
  });

  test("cat is NOT in allow list", () => {
    expect(settings.permissions.allow).not.toContain("Bash(cat *)");
  });

  test("deny array exists and has entries", () => {
    expect(settings.permissions.deny).toBeInstanceOf(Array);
    expect(settings.permissions.deny.length).toBeGreaterThanOrEqual(3);
  });
});
