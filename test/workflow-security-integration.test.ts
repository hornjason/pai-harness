import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

import {
  buildSafeGitAdd,
  buildSafeSSHCommand,
  resolveEvidencePath,
  validateEvidenceCommand,
} from "../lib/workflow-security";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const HELPERS_START = "// ──── SECURITY-HELPERS-START ────";
const HELPERS_END = "// ──── SECURITY-HELPERS-END ────";

/**
 * ship.js runs inside the Workflow sandbox and is not importable as a module.
 * Extract the delimited security-helper block and evaluate it against the real
 * lib/workflow-security.ts exports so the helpers get behavioural coverage,
 * not just grep coverage.
 */
function loadShipSecurityHelpers(projectRoot: string) {
  const start = shipSource.indexOf(HELPERS_START);
  const end = shipSource.indexOf(HELPERS_END);
  if (start === -1 || end === -1) {
    throw new Error(
      "ship.js is missing the SECURITY-HELPERS-START/END markers",
    );
  }
  const block = shipSource.slice(start + HELPERS_START.length, end);
  const logs: string[] = [];
  const factory = new Function(
    "buildSafeGitAdd",
    "buildSafeSSHCommand",
    "PROJECT_ROOT",
    "log",
    `${block}\nreturn { relativizePaths, safeGitAddCommand, safeSSHCommand };`,
  );
  const helpers = factory(
    buildSafeGitAdd,
    buildSafeSSHCommand,
    projectRoot,
    (m: string) => logs.push(m),
  );
  return { ...helpers, logs };
}

describe("AC-1: lib/workflow-security.ts exported surface", () => {
  test("exports exactly seven security functions", () => {
    const source = readFileSync(
      join(REPO_ROOT, "lib", "workflow-security.ts"),
      "utf-8",
    );
    const exported = source.match(/^export function /gm) || [];
    expect(exported.length).toBe(7);
  });
});

describe("AC-5: ship.js loads lib/workflow-security.ts", () => {
  test("requires the module through HARNESS_ROOT", () => {
    expect(shipSource).toContain("/lib/workflow-security.ts");
    expect(shipSource).toMatch(
      /require\(`\$\{HARNESS_ROOT\}\/lib\/workflow-security\.ts`\)/,
    );
  });

  test("references at least three safe builders", () => {
    const builders = [
      "buildSafeGitAdd",
      "buildSafeSSHCommand",
      "validateEvidenceCommand",
      "resolveEvidencePath",
    ];
    const referenced = builders.filter((b) => shipSource.includes(b));
    expect(referenced.length).toBeGreaterThanOrEqual(3);
  });
});

describe("AC-6: no inline shell-interpolated git add or ssh in ship.js", () => {
  test("no interpolated git add", () => {
    const hits = shipSource.match(/git add \$\{/g) || [];
    expect(hits.length).toBe(0);
  });

  test("no hand-rolled ssh option strings", () => {
    const hits = shipSource.match(/ssh -o ConnectTimeout/g) || [];
    expect(hits.length).toBe(0);
  });

  test("no quote-wrapped filesChanged join feeding a shell command", () => {
    const hits = shipSource.match(/map\(f => `"\$\{f\}"`\)/g) || [];
    expect(hits.length).toBe(0);
  });
});

describe("ship.js safeGitAddCommand behaviour", () => {
  const ROOT = "/repo";

  test("quotes ordinary relative paths", () => {
    const { safeGitAddCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeGitAddCommand(["lib/a.ts", "test/b.test.ts"], ROOT)).toBe(
      "git add 'lib/a.ts' 'test/b.test.ts'",
    );
  });

  test("relativises absolute paths under the commit directory", () => {
    const { safeGitAddCommand } = loadShipSecurityHelpers(ROOT);
    const worktree = "/repo/.claude/worktrees/wf_1";
    expect(safeGitAddCommand([`${worktree}/lib/a.ts`], worktree)).toBe(
      "git add 'lib/a.ts'",
    );
  });

  test("relativises absolute paths under PROJECT_ROOT", () => {
    const { safeGitAddCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeGitAddCommand([`${ROOT}/lib/a.ts`], "/somewhere/else")).toBe(
      "git add 'lib/a.ts'",
    );
  });

  // Rejection must fail CLOSED. Falling back to `git add .` would broaden a
  // detection into staging the whole worktree — including whatever else the
  // agent left there — which is strictly worse than the unsafe path itself.
  test("returns null when a path is unsafe", () => {
    const { safeGitAddCommand, logs } = loadShipSecurityHelpers(ROOT);
    const cmd = safeGitAddCommand(["lib/a.ts; rm -rf /"], ROOT);
    expect(cmd).toBeNull();
    expect(logs.join("\n")).toContain("REJECTED");
  });

  test("returns null when a path escapes the repo", () => {
    const { safeGitAddCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeGitAddCommand(["../../etc/passwd"], ROOT)).toBeNull();
  });

  test("returns null rather than widening scope to git add .", () => {
    const { safeGitAddCommand } = loadShipSecurityHelpers(ROOT);
    for (const bad of [["a.ts\u0000b"], ["/etc/passwd"], ["x`whoami`.ts"], ["a$(id).ts"]]) {
      expect(safeGitAddCommand(bad, ROOT)).toBeNull();
    }
  });

  // An empty list is not a rejection — nothing was flagged, the agent simply
  // did not report paths. That keeps the long-standing behavior.
  test("falls back to a static command when nothing changed", () => {
    const { safeGitAddCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeGitAddCommand([], ROOT)).toBe("git add .");
    expect(safeGitAddCommand(undefined, ROOT)).toBe("git add .");
  });
});

describe("ship.js aborts the commit when staging is refused", () => {
  test("every safeGitAddCommand call site handles null", () => {
    const lines = shipSource.split("\n");
    const callSites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /=\s*safeGitAddCommand\(/.test(l));

    expect(callSites.length).toBeGreaterThanOrEqual(3);

    for (const { l, i } of callSites) {
      const varName = l.match(/(?:const|let)\s+(\w+)\s*=/)![1];
      // The guard must appear within a few lines of the assignment.
      const window = lines.slice(i + 1, i + 6).join("\n");
      expect(window).toContain(`${varName} === null`);
      expect(window).toContain("SHIP_FAILED");
    }
  });
});

describe("ship.js safeSSHCommand behaviour", () => {
  const ROOT = "/repo";

  test("builds a quoted command from the safe argv array", () => {
    const { safeSSHCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeSSHCommand("macmini", "hostname")).toBe(
      "ssh '-o' 'ConnectTimeout=5' '-o' 'StrictHostKeyChecking=no' '--' 'macmini' 'hostname' 2>&1",
    );
  });

  test("single-quotes a remote command containing shell metacharacters", () => {
    const { safeSSHCommand } = loadShipSecurityHelpers(ROOT);
    const cmd = safeSSHCommand("macmini", "echo $HOME && whoami");
    expect(cmd).toContain("'echo $HOME && whoami'");
    expect(cmd.endsWith("2>&1")).toBe(true);
  });

  test("escapes embedded single quotes in the remote command", () => {
    const { safeSSHCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeSSHCommand("macmini", "echo 'hi'")).toContain(
      `'echo '\\''hi'\\'''`,
    );
  });

  test("returns null for a host containing shell metacharacters", () => {
    const { safeSSHCommand, logs } = loadShipSecurityHelpers(ROOT);
    expect(safeSSHCommand("evil;rm -rf /", "hostname")).toBeNull();
    expect(logs.join("\n")).toContain("evil");
  });

  test("returns null for a host that looks like an ssh option", () => {
    const { safeSSHCommand } = loadShipSecurityHelpers(ROOT);
    expect(safeSSHCommand("-oProxyCommand=touch /tmp/pwn", "hostname")).toBeNull();
  });
});

describe("ship.js Discovery evidence hardening", () => {
  test("evidence commands are screened with validateEvidenceCommand", () => {
    expect(shipSource).toContain("validateEvidenceCommand(");
  });

  test("contextFiles paths are screened with resolveEvidencePath", () => {
    expect(shipSource).toContain("resolveEvidencePath(");
  });

  test("the lib screens the patterns ship.js relies on", () => {
    expect(validateEvidenceCommand("grep -c foo lib/a.ts").safe).toBe(true);
    expect(validateEvidenceCommand("rm -rf /tmp/x").safe).toBe(false);
    expect(() => resolveEvidencePath("/repo", "../etc/passwd")).toThrow();
    expect(resolveEvidencePath("/repo", "lib/a.ts")).toBe("/repo/lib/a.ts");
  });
});

describe("ship.js still validates as a workflow script", () => {
  test("scripts/validate-workflow.ts passes on workflows/ship.js", () => {
    const out = execFileSync(
      "bun",
      [join(REPO_ROOT, "scripts", "validate-workflow.ts"), SHIP_PATH],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
    expect(out).toContain("PASSED");
    expect(out).toContain("no dangerous inline construction");
  });
});
