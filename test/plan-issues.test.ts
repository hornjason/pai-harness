/**
 * `lib/issue-repair.ts` and `scripts/plan-issues.ts --repair` (#1647).
 *
 * ## The write cases assert on the CALLS
 *
 * `plan-spec` shipped a refusal computed after its write loop: the mutations
 * went out and the exit code then said the run had been refused. Nothing
 * reading an exit code can tell that apart from a refusal that stopped
 * something, so every negative case below records what reached GitHub.
 *
 * ## And the demotion cases assert on the ORDER of those calls
 *
 * A demotion removes the issue's edges and then clears its milestone. If the
 * clear ran first and the removal then failed, the issue would already be out
 * of its phase and nothing could still work out which edges to remove — not a
 * re-run of this command, not `plan-deps`, which never removes an edge at all.
 * A test asserting only the SET of calls is green against that ordering bug.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CRITERIA_HEADING,
  alreadyAnnotated,
  annotatedBody,
  parseRepairPlan,
} from "../lib/issue-repair";
import { REFUSAL_EXIT, main as planIssuesMain } from "../scripts/plan-issues";
import type { IssueState, PlanIssuesGitHub } from "../scripts/plan-issues";

/** A plan document: a header, then the rows given. */
function plan(rows: string[]): string {
  return [
    "# A repair plan",
    "",
    "| Issue | Phase | Repair | Criteria | Confidence | Why |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## After",
  ].join("\n");
}

const ANNOTATE = "| #10 | 1 | (a) | `CRC-N2` | HIGH | because |";
const DEMOTE = "| #20 | 5 | **(b)** | — | HIGH | machinery |";

describe("lib/issue-repair: the plan parses, and only the plan's table", () => {
  test("an (a) row is annotate with its ids, a (b) row is demote with none", () => {
    const r = parseRepairPlan(plan([ANNOTATE, DEMOTE]));
    expect(r.reading).toBe("MEASURED");
    expect(r.rows.map(x => `${x.issue}:${x.kind}:${x.criteria.join("+")}`)).toEqual([
      "10:annotate:CRC-N2",
      "20:demote:",
    ]);
  });

  test("several ids in one cell all parse, in document order", () => {
    const r = parseRepairPlan(plan(["| #11 | 2 | (a) | `CRC-B3`, `CRC-B4` | MEDIUM | x |"]));
    expect(r.rows[0].criteria).toEqual(["CRC-B3", "CRC-B4"]);
  });

  test("a table that is not THIS table is not read", () => {
    const other = "| Name | Thing |\n|---|---|\n| #10 | whatever |";
    expect(parseRepairPlan(other).reading).toBe("UNMEASURED");
    // The pair: the same document with the real header IS read.
    expect(parseRepairPlan(plan([ANNOTATE])).reading).toBe("MEASURED");
  });

  test("prose after the table ends it — a later pipe row is not a repair", () => {
    const withTrailer = plan([ANNOTATE]) + "\n| #99 | 9 | (a) | `CRC-Z9` | HIGH | elsewhere |";
    expect(parseRepairPlan(withTrailer).rows.map(r => r.issue)).toEqual([10]);
  });
});

describe("lib/issue-repair: a row it cannot read is a REJECTION, not a skip", () => {
  const cases: [string, string, string][] = [
    ["an unknown repair kind", "| #10 | 1 | (z) | `CRC-N2` | HIGH | x |", "neither (a) nor (b)"],
    ["an (a) naming no criterion", "| #10 | 1 | (a) | — | HIGH | x |", "(a) names no criterion"],
    ["a (b) naming a criterion", "| #10 | 1 | (b) | `CRC-N2` | HIGH | x |", "disagree"],
    ["no issue number", "| none | 1 | (a) | `CRC-N2` | HIGH | x |", "no #<number>"],
    ["a non-numeric phase", "| #10 | one | (a) | `CRC-N2` | HIGH | x |", "is not a number"],
  ];
  for (const [name, row, why] of cases) {
    test(`${name} is rejected by name, and the whole plan is UNMEASURED`, () => {
      const r = parseRepairPlan(plan([row]));
      expect(r.reading).toBe("UNMEASURED");
      expect(r.rejected.map(x => x.why).join(" ")).toContain(why);
      expect(r.rows).toEqual([]);
    });
  }

  test("ONE bad row refuses the whole plan, including the good rows beside it", () => {
    // A partly-unreadable plan is not a partly-done plan. Without this, a
    // typo in row 7 quietly applies rows 1-6 and nobody is told.
    const r = parseRepairPlan(plan([ANNOTATE, "| #11 | 2 | (z) | `CRC-B3` | HIGH | x |"]));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.rows.map(x => x.issue)).toEqual([10]);
    expect(r.unmeasuredReasons.join(" ")).toContain("partly unreadable");
  });

  test("the same issue twice is UNMEASURED, naming both lines", () => {
    const r = parseRepairPlan(plan([ANNOTATE, ANNOTATE]));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("#10 appears twice");
  });
});

describe("lib/issue-repair: the body edit is append-or-replace, never stack", () => {
  test("an absent section is appended and the original body survives intact", () => {
    const out = annotatedBody("## The measurement\n\nThree runs disagreed.", ["CRC-B3"]);
    expect(out).toContain("Three runs disagreed.");
    expect(out).toContain(`${CRITERIA_HEADING}\n\nCRC-B3`);
  });

  test("a present section is REPLACED, so a corrected plan converges", () => {
    const once = annotatedBody("Body.", ["CRC-B3"]);
    const twice = annotatedBody(once, ["CRC-B4"]);
    expect(twice).toContain("CRC-B4");
    expect(twice).not.toContain("CRC-B3");
    expect([...twice.matchAll(/## Criteria this serves/g)]).toHaveLength(1);
  });

  test("a section followed by another heading keeps that heading", () => {
    const body = `Intro.\n\n${CRITERIA_HEADING}\n\nCRC-B3\n\n## How we will know\n\nA test.`;
    const out = annotatedBody(body, ["CRC-B4"]);
    expect(out).toContain("## How we will know");
    expect(out).toContain("A test.");
    expect(out).not.toContain("CRC-B3");
  });

  test("applying the same row twice is a no-op, which is what makes --write re-runnable", () => {
    const once = annotatedBody("Body.", ["CRC-B3", "CRC-B4"]);
    expect(alreadyAnnotated(once, ["CRC-B3", "CRC-B4"])).toBe(true);
    expect(annotatedBody(once, ["CRC-B3", "CRC-B4"])).toBe(once);
    expect(alreadyAnnotated(once, ["CRC-B6"])).toBe(false);
  });
});

describe("scripts/plan-issues --repair: what reaches GitHub", () => {
  function spy(state: Record<number, Partial<IssueState>>) {
    const calls: string[] = [];
    const gh: PlanIssuesGitHub = {
      readIssue: async (_r, number) => ({
        number,
        body: "Body.",
        milestone: `Convergence Phase 5 — x`,
        blockedBy: [],
        blocking: [],
        ...state[number],
      }),
      setBody: async (_r, n, b) => void calls.push(`body#${n}:${b.includes("CRC") ? "withIds" : "noIds"}`),
      clearMilestone: async (_r, n) => void calls.push(`milestone#${n}`),
      removeBlockedBy: async (_r, blocked, blocker) => void calls.push(`edge-${blocked}<-${blocker}`),
    };
    return { gh, calls };
  }

  async function run(rows: string[], gh: PlanIssuesGitHub, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-issues-"));
    try {
      writeFileSync(join(dir, "PLAN.md"), plan(rows));
      return await planIssuesMain(
        ["--repair", "PLAN.md", "--repo", "o/r", "--project-root", dir, ...extra],
        gh,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an (a) row writes the body and touches nothing else", async () => {
    const s = spy({});
    expect(await run([ANNOTATE], s.gh, ["--write"])).toBe(0);
    expect(s.calls).toEqual(["body#10:withIds"]);
  });

  test("a (b) row removes every orphaned edge AND clears the milestone", async () => {
    const s = spy({ 20: { blockedBy: [7, 8], blocking: [30, 31] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls).toEqual([
      "edge-20<-7",
      "edge-20<-8",
      "edge-30<-20",
      "edge-31<-20",
      "milestone#20",
    ]);
  });

  test("the edges come out BEFORE the milestone — order, not just membership", async () => {
    // If the clear ran first and a removal then failed, the issue would be
    // out of its phase with nothing able to work out what to remove.
    const s = spy({ 20: { blocking: [30] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls.indexOf("edge-30<-20")).toBeLessThan(s.calls.indexOf("milestone#20"));
  });

  test("an issue BLOCKING others has those edges removed from the OTHER issue", async () => {
    // The live shape: #1395 blocks six Phase 6 issues, and the edge lives on
    // each of those six, not on #1395. Removing it from #1395 is a no-op that
    // leaves Phase 6 blocked forever.
    const s = spy({ 20: { blocking: [30, 31] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls).toContain("edge-30<-20");
    expect(s.calls).not.toContain("edge-20<-30");
  });

  test("a body that already names the ids is unchanged — re-running writes nothing", async () => {
    const s = spy({ 10: { body: annotatedBody("Body.", ["CRC-N2"]) } });
    expect(await run([ANNOTATE], s.gh, ["--write"])).toBe(0);
    expect(s.calls).toEqual([]);
  });

  test("an issue already out of a milestone is unchanged — no edge is removed twice", async () => {
    const s = spy({ 20: { milestone: null, blocking: [30] } });
    await run([DEMOTE], s.gh, ["--write"]);
    expect(s.calls).toEqual([]);
  });

  test("without --write NOTHING is called, on a plan that would do both", async () => {
    const s = spy({ 20: { blocking: [30] } });
    expect(await run([ANNOTATE, DEMOTE], s.gh)).toBe(0);
    expect(s.calls).toEqual([]);
  });

  test("ONE unreadable row writes nothing at all, including the good row's body", async () => {
    const s = spy({});
    const code = await run([ANNOTATE, "| #11 | 2 | (z) | `CRC-B3` | HIGH | x |"], s.gh, ["--write"]);
    expect(s.calls, "a good row was applied from a plan that could not be fully read").toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a missing plan file refuses before reading any issue", async () => {
    const s = spy({});
    expect(await planIssuesMain(["--repair", "/nope/PLAN.md", "--repo", "o/r", "--write"], s.gh)).toBe(
      REFUSAL_EXIT,
    );
    expect(s.calls).toEqual([]);
  });

  test("--json --write reports `yes`, and `refused` on an unreadable plan", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const good = spy({});
    const bad = spy({});
    let badCode;
    try {
      await run([ANNOTATE], good.gh, ["--write", "--json"]);
      const first = out.length;
      badCode = await run(["| #10 | 1 | (z) | `CRC-N2` | HIGH | x |"], bad.gh, ["--write", "--json"]);
      expect(JSON.parse(out.slice(0, first).join("\n")).wrote).toBe("yes");
      expect(JSON.parse(out.slice(first).join("\n")).wrote).toBe("refused");
    } finally {
      console.log = log;
    }
    expect(good.calls).toEqual(["body#10:withIds"]);
    expect(bad.calls).toEqual([]);
    expect(badCode).toBe(REFUSAL_EXIT);
  });
});
