/**
 * A collection cannot write outside this run (#155, security review)
 *
 * SC-559, SC-560 (HARNESS-STANDARD.md)
 *
 * Before #155 the collect step only ever wrote to `PROJECT_ROOT`, a value
 * from the workflow's own arguments. Collecting into `commitDir` means the
 * destination can now be a path an AGENT reported as its worktree, and the
 * first commit of #155 interpolated it raw into a shell command. Two hazards
 * in one line: a destination outside the repository, and `$(...)` executing.
 *
 * `workflows/ship.js:377` already records that exact mistake being made and
 * caught once — `/tmp/$(touch pwned)` expands inside a double-quoted string,
 * and the injection test of the day had only tried `;`-separated commands.
 *
 * The validator is EXECUTED here, not grepped. "ship.js contains
 * collectDestination" stays true after the function is reduced to
 * `return dir`, which is the whole failure mode this file exists to rule out.
 * The extraction is the established pattern — see `loadHeredocSafe` in
 * test/workflow-security-integration.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const PROJECT = "/Users/dev/proj";
const HARNESS = "/Users/dev/harness";

/** Pull the marked helper out of ship.js and run it. */
function loadCollectDestination(): (
  dir: unknown,
  projectRoot?: string,
  harnessRoot?: string,
) => string | null {
  const start = shipSource.indexOf("// ──── COLLECT-DESTINATION-START ────");
  const end = shipSource.indexOf("// ──── COLLECT-DESTINATION-END ────");
  if (start < 0 || end < 0) throw new Error("COLLECT-DESTINATION markers not found in ship.js");
  const body = shipSource.slice(start, end);
  // PROJECT_ROOT / HARNESS_ROOT are the function's defaults and are module
  // scope in ship.js; the tests always pass both explicitly.
  return new Function(
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    `${body}\nreturn collectDestination`,
  )(PROJECT, HARNESS);
}

const collectDestination = loadCollectDestination();

describe("#155: the destinations a collection may write to", () => {
  test("the project root itself", () => {
    expect(collectDestination(PROJECT, PROJECT, HARNESS)).toBe(PROJECT);
  });

  test("an agent worktree under either root", () => {
    const a = `${PROJECT}/.claude/worktrees/wf_abc-1`;
    const b = `${HARNESS}/.claude/worktrees/wf_abc-2`;
    expect(collectDestination(a, PROJECT, HARNESS)).toBe(a);
    expect(collectDestination(b, PROJECT, HARNESS)).toBe(b);
  });
});

describe("#155: the destinations it refuses", () => {
  const refused: [string, unknown][] = [
    ["command substitution", "/tmp/$(touch pwned)"],
    ["backtick substitution", "/tmp/`touch pwned`"],
    // These three sit INSIDE an allowed worktree base on purpose. Written
    // against PROJECT they were refused by the base check and the newline
    // guard could be deleted with the suite still green — a shielded
    // mutation, and a vacuous test of exactly the kind
    // .claude/rules/checks-must-be-able-to-fail.md is about.
    ["a newline carrying a second command", `${PROJECT}/.claude/worktrees/wf_a-1\ntouch pwned`],
    ["a carriage return", `${PROJECT}/.claude/worktrees/wf_a-1\rtouch pwned`],
    ["a NUL", `${PROJECT}/.claude/worktrees/wf_a-1\0/etc`],
    ["traversal out of a worktree", `${PROJECT}/.claude/worktrees/../../../etc`],
    ["a trailing traversal segment", `${PROJECT}/.claude/worktrees/..`],
    ["another project entirely", "/Users/dev/other-project"],
    ["the worktree base itself, not a worktree in it", `${PROJECT}/.claude/worktrees`],
    ["a relative path", ".claude/worktrees/wf_abc-1"],
    ["a path that merely starts with the root's name", `${PROJECT}-evil/x`],
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
  ];

  for (const [name, value] of refused) {
    test(name, () => {
      expect(collectDestination(value, PROJECT, HARNESS)).toBeNull();
    });
  }

  test("a substitution is refused, not stripped", () => {
    // Sanitising would be the wrong answer even if it worked: a "cleaned up"
    // path is a guess about which directory the caller meant.
    expect(collectDestination("/tmp/$(id)", PROJECT, HARNESS)).toBeNull();
  });
});

describe("#155: every path in the collect command is quoted", () => {
  test("the step interpolates no bare path", () => {
    const start = shipSource.indexOf("// ──── COLLECT-AGENT-WORK-START ────");
    const end = shipSource.indexOf("// ──── COLLECT-AGENT-WORK-END ────");
    const block = shipSource.slice(start, end);
    const commandLine = block
      .split("\n")
      .find(l => l.includes("collect-worktree-files.ts") && l.trimStart().startsWith("cd "));
    expect(commandLine).toBeDefined();

    // The allowlist and the quoting are independent layers and the line needs
    // both. `${dest}` written bare satisfies collectDestination and still
    // expands: ship.js:377 is the record of that exact pairing shipping once.
    expect(commandLine).toContain("shellQuote(dest)");
    expect(commandLine).not.toMatch(/\$\{\s*dest\s*\}/);
    expect(commandLine).not.toMatch(/\$\{\s*intoDir\s*\}/);

    // And no interpolation anywhere on it escapes shellQuote. Checked by
    // removing every shellQuote(...) call — balanced to its own closing
    // paren — and asserting nothing interpolated is left behind.
    let stripped = "";
    for (let i = 0; i < commandLine!.length; ) {
      const at = commandLine!.indexOf("${shellQuote(", i);
      if (at < 0) { stripped += commandLine!.slice(i); break; }
      stripped += commandLine!.slice(i, at);
      let depth = 0;
      let j = at + 2;
      for (; j < commandLine!.length; j++) {
        if (commandLine![j] === "(") depth++;
        else if (commandLine![j] === ")" && --depth === 0) break;
      }
      i = commandLine!.indexOf("}", j) + 1;
    }
    expect(stripped).not.toContain("${");
  });

  test("the heredoc delimiter is quoted, so the payload does not expand", () => {
    expect(shipSource).toContain("<<'RUNGATE_GROUPS_EOF'");
  });
});

/**
 * #190 / SC-624: the run's harness root reaches every agent this run spawns.
 *
 * `harnessRoot()` (lib/paths.ts) resolves to the checkout that loaded the
 * module when `HARNESS_ROOT` is unset. Every role here runs with
 * `isolation: "worktree"`, so for a spawned agent that is its own worktree — a
 * different tree from the one the run is grading. An agent that is told
 * nothing does not error; it resolves its worktree and reports a number, which
 * is precisely the failure, so the negative case below REMOVES the injection
 * and watches the value disappear rather than trusting it was ever there.
 *
 * `briefedAgent` is the single place every role spawn passes through, so the
 * root is set there rather than at each call site.
 *
 * Both channels are asserted because they fail independently: `opts.env` is
 * the structured one, the prompt line is what survives if the agent runtime
 * drops an option it does not recognise.
 *
 * The block is EXECUTED, not grepped — "ship.js mentions HARNESS_ROOT" stays
 * true after the assignment is deleted, since the identifier appears a dozen
 * times elsewhere in the file. Same extraction pattern as above.
 */
describe("#190: the run's harness root reaches spawned agents", () => {
  const HARNESS_ROOT = "/Users/dev/harness-main";
  const BLOCK_START = "// ──── BRIEFED-AGENT-START ────";
  const BLOCK_END = "// ──── BRIEFED-AGENT-END ────";
  /** The one line the env injection is routed through, so it can be mutated out. */
  const RUN_ENV_MARKER = "// ── RUN-ENV ──";

  interface Captured { prompt: string; opts: Record<string, unknown> }

  function briefedAgentBlock(): string {
    const start = shipSource.indexOf(BLOCK_START);
    const end = shipSource.indexOf(BLOCK_END);
    if (start === -1 || end === -1) {
      throw new Error(`${BLOCK_START} / ${BLOCK_END} markers missing from workflows/ship.js`);
    }
    return shipSource.slice(start, end);
  }

  /** Evaluate a briefedAgent block against fakes for everything it closes over. */
  function loadBriefedAgent(block: string, roles: Record<string, unknown> = {}) {
    const calls: Captured[] = [];
    // `new Function` over this repository's own workflows/ship.js, read at
    // test time — the same trust boundary as importing it, which the Workflow
    // sandbox makes impossible. Established pattern, see
    // test/briefed-agent-model.test.ts. Never give it a source from elsewhere.
    const factory = new Function(
      "ROLES", "PROJECT_ROOT", "HARNESS_ROOT", "timedAgent",
      "loadContextPaths", "loadReinforcementRules",
      `${block}\nreturn briefedAgent;`,
    );
    const call = factory(
      roles,
      PROJECT,
      HARNESS_ROOT,
      async (prompt: string, opts: Record<string, unknown>) => {
        calls.push({ prompt, opts: { ...opts } });
        return { ok: true };
      },
      async () => [],
      async () => [],
    ) as (p: string, o: Record<string, unknown>) => Promise<unknown>;
    return { call, calls };
  }

  const ROLES = { marcus: { brief: ".claude/agents/marcus.md", isolation: "worktree" } };

  test("the injection is routed through exactly one line", () => {
    // Without this, a second assignment elsewhere would keep the mutant below
    // working and the negative case would quietly stop proving anything.
    const hits = briefedAgentBlock().split("\n").filter(l => l.includes(RUN_ENV_MARKER));
    expect(hits).toHaveLength(1);
  });

  test("a role spawn's environment carries the run's harness root", async () => {
    const { call, calls } = loadBriefedAgent(briefedAgentBlock(), ROLES);
    await call("do the thing", { role: "marcus", label: "marcus" });
    expect((calls[0].opts.env as Record<string, string>)?.HARNESS_ROOT).toBe(HARNESS_ROOT);
  });

  test("the prompt names the run's harness root, not the agent's worktree", async () => {
    const { call, calls } = loadBriefedAgent(briefedAgentBlock(), ROLES);
    await call("do the thing", { role: "marcus", label: "marcus" });
    expect(calls[0].prompt).toContain(`HARNESS_ROOT=${HARNESS_ROOT}`);
  });

  test("a caller's own env keys survive alongside it", async () => {
    const { call, calls } = loadBriefedAgent(briefedAgentBlock(), ROLES);
    await call("x", { role: "marcus", label: "marcus", env: { OTHER: "1" } });
    const env = calls[0].opts.env as Record<string, string>;
    expect(env.OTHER).toBe("1");
    expect(env.HARNESS_ROOT).toBe(HARNESS_ROOT);
  });

  test("the positive control: with the injection removed nothing else supplies it", async () => {
    // Delete the one marked line and the value is gone from BOTH channels —
    // which is what an agent gets today, and why it resolves its own worktree.
    // If this case still found a harness root, the three above would be
    // passing on something other than the injection.
    const mutant = briefedAgentBlock()
      .split("\n")
      .filter(l => !l.includes(RUN_ENV_MARKER))
      .join("\n");
    expect(mutant).not.toBe(briefedAgentBlock());

    const { call, calls } = loadBriefedAgent(mutant, ROLES);
    await call("do the thing", { role: "marcus", label: "marcus" });
    expect((calls[0].opts.env as Record<string, string> | undefined)?.HARNESS_ROOT).toBeUndefined();
    expect(calls[0].prompt).not.toContain(HARNESS_ROOT);
  });
});
