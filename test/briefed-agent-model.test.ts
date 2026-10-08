/**
 * The `model` field in the roles config has to reach the agent call.
 *
 * It did not. `briefedAgent` read `roleConfig.brief` and `roleConfig.isolation`
 * and ignored `roleConfig.model`, so every role agent ran on the workflow
 * default. The field was configured in two places, enforced by a conformity
 * rule (AGENT-8), stamped into each generated brief's frontmatter — and never
 * applied to anything.
 *
 * That made it the most expensive kind of dead config: one that looks live from
 * every direction. `.claude/rungate.json` said marcus and discovery were opus.
 * `.claude/rungate/roles.json` said sonnet. Conformity compared the briefs
 * against the second and passed. 149 graded runs were attributed to a model
 * choice that was never in effect, and the obvious next experiment — "try opus
 * and see if compliance improves" — would have changed a number in a file and
 * produced an identical run.
 *
 * ship.js runs inside the Workflow sandbox and is not importable, so this uses
 * the marker-extraction pattern from test/decomposed-ship-dispatch.test.ts:
 * pull the delimited block out and evaluate it against injected fakes. That
 * gives behavioural coverage. A grep for the string `opts.model` would pass
 * against a line that never executes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const BLOCK_START = "// ──── BRIEFED-AGENT-START ────";
const BLOCK_END = "// ──── BRIEFED-AGENT-END ────";

interface Captured { prompt: string; opts: Record<string, unknown> }

type BriefedAgent = (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;

/** Evaluate the real briefedAgent block against fakes for everything it closes over. */
function loadBriefedAgent(roles: Record<string, unknown>): { call: BriefedAgent; calls: Captured[] } {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error(
      `${BLOCK_START} / ${BLOCK_END} markers missing from workflows/ship.js — ` +
        `this test extracts the real function rather than a copy of it`,
    );
  }
  const block = shipSource.slice(start, end);
  const calls: Captured[] = [];

  // `new Function` with an interpolated body is a code-injection shape, and a
  // scanner will flag it. The interpolated value here is this repository's own
  // workflows/ship.js, read off disk at test time — the same trust boundary as
  // `import`ing it, which the Workflow sandbox makes impossible. Already the
  // established pattern in test/decomposed-ship-dispatch.test.ts. It must never
  // be given a path or a source from anywhere else.
  //
  // HARNESS_ROOT is module scope in ship.js and briefedAgent now reads it
  // (#190, SC-624). Omitting it here throws ReferenceError, which is the
  // correct signal — this harness has to supply every binding the real block
  // closes over, not the subset that happened to be enough once.
  const factory = new Function(
    "ROLES", "PROJECT_ROOT", "HARNESS_ROOT", "agent", "loadContextPaths", "loadReinforcementRules",
    `${block}\nreturn briefedAgent;`,
  );

  const call = factory(
    roles,
    "/project",
    "/harness",
    async (prompt: string, opts: Record<string, unknown>) => {
      calls.push({ prompt, opts: { ...opts } });
      return { ok: true };
    },
    async () => [],
    async () => [],
  ) as BriefedAgent;

  return { call, calls };
}

describe("the configured model reaches the agent call", () => {
  test("a role's model is applied", async () => {
    const { call, calls } = loadBriefedAgent({ marcus: { brief: ".claude/agents/marcus.md", model: "opus" } });
    await call("do the thing", { role: "marcus", label: "implement" });
    expect(calls[0].opts.model, "roleConfig.model never reached agent()").toBe("opus");
  });

  test("each role gets its OWN model, not the first one seen", async () => {
    // A cache keyed on anything but the role would make the second agent
    // inherit the first one's model — invisible, because both calls succeed.
    const { call, calls } = loadBriefedAgent({
      marcus: { brief: "a.md", model: "opus" },
      rook: { brief: "b.md", model: "sonnet" },
    });
    await call("x", { role: "marcus", label: "a" });
    await call("y", { role: "rook", label: "b" });
    expect(calls.map(c => c.opts.model)).toEqual(["opus", "sonnet"]);
  });

  test("an explicit model from the caller wins over the config", async () => {
    // Same precedence the isolation option already uses. A config value that
    // overrode an explicit argument would be a surprise at the call site.
    const { call, calls } = loadBriefedAgent({ marcus: { brief: "a.md", model: "opus" } });
    await call("x", { role: "marcus", label: "a", model: "haiku" });
    expect(calls[0].opts.model).toBe("haiku");
  });

  test("a role with no configured model does not get one invented", async () => {
    // Setting a default here would silently pin every unconfigured role to one
    // model and hide the fact that the config is incomplete.
    const { call, calls } = loadBriefedAgent({ quinn: { brief: "q.md" } });
    await call("x", { role: "quinn", label: "a" });
    expect("model" in calls[0].opts, "a model was invented for a role that configures none").toBe(false);
  });

  test("a call with no role at all is passed through untouched", async () => {
    const { call, calls } = loadBriefedAgent({});
    await call("x", { label: "plain", model: "sonnet" });
    expect(calls[0].opts).toEqual({ label: "plain", model: "sonnet" });
  });
});

describe("wiring the model did not disturb what already worked", () => {
  test("isolation still comes from the role config", async () => {
    const { call, calls } = loadBriefedAgent({ marcus: { brief: "a.md", model: "opus", isolation: "worktree" } });
    await call("x", { role: "marcus", label: "a" });
    expect(calls[0].opts.isolation).toBe("worktree");
    expect(calls[0].opts.cwd).toBe("/project");
  });

  test("roles default to worktree isolation when the config omits it", async () => {
    const { call, calls } = loadBriefedAgent({ marcus: { brief: "a.md" } });
    await call("x", { role: "marcus", label: "a" });
    expect(calls[0].opts.isolation).toBe("worktree");
  });

  test("the brief is still the first mandatory read", async () => {
    const { call, calls } = loadBriefedAgent({ marcus: { brief: ".claude/agents/marcus.md", model: "opus" } });
    await call("do the thing", { role: "marcus", label: "a" });
    expect(calls[0].prompt).toContain("/project/.claude/agents/marcus.md");
    expect(calls[0].prompt).toContain("do the thing");
  });

  test("`role` is not leaked into the agent options", async () => {
    const { call, calls } = loadBriefedAgent({ marcus: { brief: "a.md", model: "opus" } });
    await call("x", { role: "marcus", label: "a" });
    expect("role" in calls[0].opts).toBe(false);
  });
});

describe("the two config layouts agree about models", () => {
  // The bug above was survivable only because nothing compared them.
  // tryLoadRungateConfig prefers the directory form; the ship skill reads the
  // monolith directly. While both files exist, a disagreement means the
  // pipeline runs one model and every check reports the other.
  const readJson = (p: string) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf-8"));

  test("roles.json and rungate.json configure the same model for every role", () => {
    const monolith = readJson(".claude/rungate.json").roles as Record<string, { model?: string }>;
    const directory = readJson(".claude/rungate/roles.json") as Record<string, { model?: string }>;

    const disagreements: string[] = [];
    for (const role of new Set([...Object.keys(monolith), ...Object.keys(directory)])) {
      const a = monolith[role]?.model;
      const b = directory[role]?.model;
      if (a !== b) disagreements.push(`${role}: rungate.json=${a} roles.json=${b}`);
    }
    expect(
      disagreements,
      "the file the ship skill reads disagrees with the file conformity checks (#90)",
    ).toEqual([]);
  });
});
