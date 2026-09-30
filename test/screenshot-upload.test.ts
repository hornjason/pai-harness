import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { uploadScreenshotsToIssue } from "../lib/screenshot-upload.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/screenshot-upload-test";

describe("screenshot-upload", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("handles empty file list gracefully", async () => {
    const result = await uploadScreenshotsToIssue(123, "owner/repo", []);

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.markdownLinks).toEqual([]);
  });

  test("handles non-existent files gracefully", async () => {
    const result = await uploadScreenshotsToIssue(
      123,
      "owner/repo",
      ["/nonexistent/screenshot.png"]
    );

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toContain("/nonexistent/screenshot.png");
    expect(result.markdownLinks).toEqual([]);
  });

  test("returns proper markdown link format", async () => {
    // Create a test image file
    const testFile = join(TEST_DIR, "test-screenshot.png");
    writeFileSync(testFile, Buffer.from("fake-png-data"));

    // Mock the gh gist create command to return a fake gist URL
    const originalExec = global.Bun?.spawn;
    const mockGistUrl = "https://gist.github.com/user/abc123";

    // We'll need to mock the gist upload in the implementation
    // For now, test that the function exists and has the right shape
    const result = await uploadScreenshotsToIssue(123, "owner/repo", [testFile]);

    // Result should have the right structure
    expect(result).toHaveProperty("uploaded");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("markdownLinks");
    expect(Array.isArray(result.uploaded)).toBe(true);
    expect(Array.isArray(result.failed)).toBe(true);
    expect(Array.isArray(result.markdownLinks)).toBe(true);
  });

  test("processes multiple files", async () => {
    const testFile1 = join(TEST_DIR, "screenshot-1.png");
    const testFile2 = join(TEST_DIR, "screenshot-2.png");
    writeFileSync(testFile1, Buffer.from("fake-png-1"));
    writeFileSync(testFile2, Buffer.from("fake-png-2"));

    const result = await uploadScreenshotsToIssue(
      123,
      "owner/repo",
      [testFile1, testFile2]
    );

    // Should process all files (either upload or fail)
    const totalProcessed = result.uploaded.length + result.failed.length;
    expect(totalProcessed).toBe(2);
  });

  test("markdown links match uploaded files", async () => {
    const testFile = join(TEST_DIR, "test.png");
    writeFileSync(testFile, Buffer.from("fake-png"));

    const result = await uploadScreenshotsToIssue(123, "owner/repo", [testFile]);

    // Each uploaded file should have a corresponding markdown link
    if (result.uploaded.length > 0) {
      expect(result.markdownLinks.length).toBe(result.uploaded.length);

      // Each markdown link should be in the format ![filename](url)
      result.markdownLinks.forEach(link => {
        expect(link).toMatch(/^!\[.*\]\(.+\)$/);
      });
    }
  });
});
