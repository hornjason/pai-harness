/**
 * Tests for #560: Quinn must validate in Marcus's worktree, not a fresh one.
 *
 * Verifies:
 *   1. briefedAgent respects explicit isolation overrides (doesn't force worktree)
 *   2. Marcus IMPLEMENT result includes worktreePath in schema
 *   3. Quinn VALIDATE receives worktree path, not its own worktree
 *   4. Marcus-fix iterations receive worktree path
 *   5. prove.js briefedAgent has the same fix
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHIP_PATH = join(__dirname, "..", "..", "workflows", "ship.js");
const PROVE_PATH = join(__dirname, "..", "..", "workflows", "prove.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");
const proveSource = readFileSync(PROVE_PATH, "utf-8");

describe("worktree isolation (#560)", () => {
  describe("briefedAgent respects explicit isolation", () => {
    test("ship.js briefedAgent checks for caller-provided isolation before defaulting", () => {
      // briefedAgent must not blindly overwrite opts.isolation
      // It should check if the caller already set isolation
      expect(shipSource).toMatch(/'isolation' in opts|hasOwnProperty.*isolation/);
    });

    test("prove.js briefedAgent checks for caller-provided isolation before defaulting", () => {
      expect(proveSource).toMatch(/'isolation' in opts|hasOwnProperty.*isolation/);
    });
  });

  describe("BUILD_RESULT_SCHEMA includes worktreePath", () => {
    test("BUILD_RESULT_SCHEMA has worktreePath property", () => {
      expect(shipSource).toContain("worktreePath");
      // Verify it's in the schema definition, not just anywhere
      const schemaMatch = shipSource.match(
        /BUILD_RESULT_SCHEMA\s*=\s*\{[\s\S]*?required:/
      );
      expect(schemaMatch).not.toBeNull();
      expect(schemaMatch![0]).toContain("worktreePath");
    });
  });

  describe("Marcus IMPLEMENT reports worktreePath", () => {
    test("Marcus implement prompt instructs reporting worktreePath", () => {
      // The marcus implement prompt should ask for the working directory
      // Look for worktreePath instruction near the marcus implement call
      const implementSection = shipSource.match(
        /PHASE 4: IMPLEMENT[\s\S]*?PHASE 5: VALIDATE/
      );
      expect(implementSection).not.toBeNull();
      expect(implementSection![0]).toContain("worktreePath");
    });
  });

  describe("Quinn VALIDATE uses Marcus's worktree", () => {
    test("Quinn validate call sets isolation explicitly (not worktree)", () => {
      // Find the quinn-local agent call opts in VALIDATE phase
      const validateSection = shipSource.match(
        /PHASE 5: VALIDATE[\s\S]*?PHASE 6: COMMIT/
      );
      expect(validateSection).not.toBeNull();
      // The opts line with quinn-local label should include isolation override
      const quinnOptsLine = validateSection![0].match(
        /label:.*quinn-local.*schema:.*GATE_RESULT_SCHEMA/s
      );
      expect(quinnOptsLine).not.toBeNull();
      expect(quinnOptsLine![0]).toContain("isolation");
    });

    test("Quinn validate prompt references worktree path variable", () => {
      const validateSection = shipSource.match(
        /PHASE 5: VALIDATE[\s\S]*?PHASE 6: COMMIT/
      );
      expect(validateSection).not.toBeNull();
      // Quinn's prompt should include the worktree path for validation
      expect(validateSection![0]).toMatch(
        /marcusWorktreePath|implementResult.*worktreePath|buildResult.*worktreePath/
      );
    });
  });

  describe("Marcus-fix iterations use Marcus's worktree", () => {
    test("Marcus-fix call sets isolation explicitly (not worktree)", () => {
      const validateSection = shipSource.match(
        /PHASE 5: VALIDATE[\s\S]*?PHASE 6: COMMIT/
      );
      expect(validateSection).not.toBeNull();
      // The opts line with marcus-fix label should include isolation override
      const marcusFixOpts = validateSection![0].match(
        /label:.*marcus-fix.*role:.*marcus/s
      );
      expect(marcusFixOpts).not.toBeNull();
      expect(marcusFixOpts![0]).toContain("isolation");
    });

    test("Marcus-fix prompt references worktree path", () => {
      const validateSection = shipSource.match(
        /PHASE 5: VALIDATE[\s\S]*?PHASE 6: COMMIT/
      );
      expect(validateSection).not.toBeNull();
      // The marcus-fix briefedAgent call should include worktree path in the prompt
      const marcusFixSection = validateSection![0].match(
        /marcus-fix[\s\S]*?marcus-fix|worktree.*marcus-fix/s
      );
      // Alternatively, just check that marcusWorktreePath appears near marcus-fix
      expect(validateSection![0]).toMatch(
        /marcusWorktreePath[\s\S]*?marcus-fix/
      );
    });
  });

  describe("worktree path captured after IMPLEMENT", () => {
    test("worktree path is extracted from buildResult after implement", () => {
      const postImplement = shipSource.match(
        /runImplement\(\)[\s\S]*?PHASE 5: VALIDATE/
      );
      expect(postImplement).not.toBeNull();
      expect(postImplement![0]).toMatch(
        /marcusWorktreePath|worktreePath/
      );
    });
  });
});
