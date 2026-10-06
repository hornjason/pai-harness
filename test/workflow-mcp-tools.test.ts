/**
 * A workflow prompt may not name an MCP tool no agent can reach (#137)
 *
 * SC-534 (GITHUB-API-MIGRATION-SPEC Phase 6)
 *
 * `finalize` told its agent to call `mcp__github__add_issue_comment`. No role
 * grants `mcp__github__*`, so the tool was not in the session; the agent
 * searched, found nothing, said so — and the run still reported SHIPPED.
 * Every completed ship left no comment, no label and no PR on the tracker,
 * while `.claude/rules/parallel-sessions.md` relies on that tracker being the
 * one place a claim is visible.
 *
 * The instruction was wrong at authoring time and stayed wrong for four
 * phases of a spec marked done, because nothing compared what a prompt asks
 * for against what the agent running it is given. This is that comparison.
 *
 * It fails if a workflow prompt names a server no role grants — which is what
 * it did before the Octokit path replaced those calls. Verified by
 * reintroducing one `mcp__github__add_issue_comment` reference into ship.js
 * and watching it go red.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, "workflows");
const ROLES = join(ROOT, ".claude", "rungate", "roles.json");

/** Every `mcp__<server>__` prefix a file mentions, with the lines it is on. */
function mcpServersReferenced(source: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  source.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/mcp__([a-z0-9-]+)__/gi)) {
      const server = m[1];
      if (!found.has(server)) found.set(server, []);
      found.get(server)!.push(i + 1);
    }
  });
  return found;
}

/**
 * The servers a file names that nothing grants.
 *
 * Extracted so it can be tested on a synthetic input below. Left inline, the
 * sweep had no coverage of its own: replacing it with `[]` made every file
 * pass and no test noticed, which is the same vacuous shape it exists to
 * catch.
 */
export function ungrantedServers(source: string, granted: Set<string>): string[] {
  return [...mcpServersReferenced(source).entries()]
    .filter(([server]) => !granted.has(server))
    .map(([server, lines]) => `mcp__${server}__ at ${lines.join(",")}`);
}

/** Servers granted to at least one role, from each role's `tools` string. */
function grantedServers(): Set<string> {
  const roles = JSON.parse(readFileSync(ROLES, "utf-8")) as Record<string, { tools?: string }>;
  const granted = new Set<string>();
  for (const role of Object.values(roles)) {
    for (const m of (role.tools ?? "").matchAll(/mcp__([a-z0-9-]+)__/gi)) granted.add(m[1]);
  }
  return granted;
}

const workflowFiles = readdirSync(WORKFLOWS).filter(f => f.endsWith(".js"));

describe("#137: workflow prompts only name MCP tools some role actually grants", () => {
  test("there are workflow files to check — a silent empty sweep is not a pass", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  test.each(workflowFiles)("%s", file => {
    const source = readFileSync(join(WORKFLOWS, file), "utf-8");
    expect(ungrantedServers(source, grantedServers())).toEqual([]);
  });

  test("the sweep reports an ungranted server when there is one", () => {
    // The positive control. Without it, a change that made the sweep inspect
    // nothing would turn every file above green — and that mutation did
    // survive, which is why this test exists rather than a comment claiming
    // the sweep works.
    expect(ungrantedServers("call mcp__github__get_issue here", new Set(["playwright"])))
      .toEqual(["mcp__github__ at 1"]);
  });

  test("a granted server is not reported", () => {
    expect(ungrantedServers("mcp__playwright__browser_click", new Set(["playwright"]))).toEqual([]);
  });

  test("the granted set is read from roles.json, and github is not in it", () => {
    // Pinned exactly, not spot-checked. A version of grantedServers() that
    // added "github" to the set made every assertion above pass while the
    // sweep stopped catching the one thing it was written for, and
    // `expect(granted.has("playwright")).toBe(true)` did not notice.
    //
    // If a role ever does grant mcp__github__*, this fails — which is the
    // point. That would be a deliberate decision reversing D-9, and it should
    // cost an edit here rather than happening quietly.
    expect([...grantedServers()].sort()).toEqual(["playwright"]);
  });
});
