/**
 * Covers SC-833, SC-834, SC-835, SC-836 (HARNESS-STANDARD.md).
 *
 * #144 — `IssueCloseGuard` predicts, from the text of a Bash command, whether
 * that command will close a protected issue. Five consecutive security-review
 * rounds on 2026-10-06 each found a real differential between what it
 * believes and what the shell plus `gh` actually do, and the class does not
 * close: `gh api -X PATCH repos/o/n/issues/23 -f state=closed` mentions
 * neither of the words the hook looks for, and neither does a wrapper script.
 *
 * Jason's decision of 2026-10-08 was Option C — keep the hook as fast
 * feedback, move the control to an outcome check. So these tests are about
 * the OUTCOME check, and AC-5 is explicit that no new round may be opened
 * against the hook's parser. None is.
 *
 * AC-1 asks for positive controls, and names the failure they exist to
 * catch: "an audit that reopens every closed issue satisfies the negative
 * case and is worse than nothing."
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  closedWithoutRecord,
  report,
  shouldReopen,
  EXEMPT_LABEL,
  FINDING_LABEL,
  toClosedIssue,
  NOT_PLANNED,
  AUDIT_EPOCH,
  PROTECTED_LABELS,
  type ClosedIssue,
} from "../lib/issue-closure-audit";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "audit-issue-closures.ts");
const WORKFLOW = join(ROOT, ".github", "workflows", "issue-audit.yml");
const HOOK = join(ROOT, "hooks", "IssueCloseGuard.hook.ts");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** Closed after the epoch unless a case says otherwise. */
const AFTER = "2026-10-14T12:00:00Z";
const BEFORE = "2026-10-01T12:00:00Z";

const issue = (over: Partial<ClosedIssue> = {}): ClosedIssue => ({
  number: 1,
  title: "an issue",
  closedBy: null,
  stateReason: "completed",
  labels: [],
  closedAt: AFTER,
  ...over,
});

describe("#144 SC-833: the audit reads the outcome, not the command", () => {
  test("a close the hook cannot see is caught by the audit", () => {
    // AC-2's named regression: `gh api -X PATCH repos/o/n/issues/N -f
    // state=closed`. The hook is EXPECTED to miss it — it mentions neither
    // `issue` nor `close` in the shape the parser looks for — and the audit
    // is expected to catch it. That close leaves GitHub nothing to attribute
    // the closure to, which is the whole signal.
    const found = closedWithoutRecord([issue({ number: 23, closedBy: null })]);
    expect(found.length, "a raw REST close was not caught").toBe(1);
    expect(found[0].issue.number).toBe(23);
  });

  test("a close the pipeline made is left alone", () => {
    // The positive control AC-1 demands. An audit that flags everything
    // satisfies the case above and is worse than nothing.
    const found = closedWithoutRecord([
      issue({ number: 1, closedBy: "pull request #376" }),
      issue({ number: 2, closedBy: "commit d23c40dd" }),
    ]);
    expect(found, "the audit flagged issues that shipped normally").toEqual([]);
  });

  test("the two cases are distinguished in one call, not by two predicates", () => {
    // Both shapes in one list. A predicate that answered them separately
    // could be right twice and still wrong about a mixed tracker.
    const found = closedWithoutRecord([
      issue({ number: 1, closedBy: "pull request #376" }),
      issue({ number: 2, closedBy: null }),
      issue({ number: 3, closedBy: "commit abc1234" }),
      issue({ number: 4, closedBy: null }),
    ]);
    expect(found.map(f => f.issue.number)).toEqual([2, 4]);
  });

  test("an empty tracker produces no findings and does not throw", () => {
    expect(closedWithoutRecord([])).toEqual([]);
  });
});

describe("#144 SC-834: a deliberate close is not a false positive", () => {
  // AC-4. There is prior art in this repo for a check that cried wolf until
  // it was switched off, and this is the axis it would do it on.
  test("closed as not planned is left alone", () => {
    expect(closedWithoutRecord([issue({ stateReason: NOT_PLANNED })])).toEqual([]);
  });

  test("an explicit exemption label is honoured", () => {
    expect(closedWithoutRecord([issue({ labels: [EXEMPT_LABEL] })])).toEqual([]);
  });

  test("the audit does not re-report what it already flagged", () => {
    expect(closedWithoutRecord([issue({ labels: [FINDING_LABEL] })])).toEqual([]);
  });

  test("the exemption label and the finding label are different words", () => {
    // Collapsing them would let the audit silence itself on its second run:
    // it applies the mark, then reads its own mark as an exemption, and the
    // finding disappears while the issue stays closed.
    expect(EXEMPT_LABEL).not.toBe(FINDING_LABEL);
  });

  test("an exemption does not require the other exemptions", () => {
    // Each branch alone must suppress, or the audit is really one check
    // wearing three names.
    expect(closedWithoutRecord([issue({ stateReason: NOT_PLANNED, labels: [] })])).toEqual([]);
    expect(closedWithoutRecord([issue({ stateReason: "completed", labels: [EXEMPT_LABEL] })]))
      .toEqual([]);
    expect(closedWithoutRecord([issue({ stateReason: "completed", labels: ["bug"] })]).length)
      .toBe(1);
  });
});

describe("#144 SC-834: the ratchet starts from a recorded date", () => {
  // Measured 2026-10-13: without an epoch the audit reports 19 of the last
  // 100 closed issues in this repo, and spot-checking five found no merge
  // commit, no closing PR and no Completion Report on any of them. They are
  // true positives. Flagging all nineteen on day one is still the behaviour
  // that gets a check switched off, so the control banks the number and
  // ratchets forward.
  test("a close from before the epoch is not a finding", () => {
    expect(closedWithoutRecord([issue({ closedAt: BEFORE })])).toEqual([]);
  });

  test("a close from after the epoch is", () => {
    expect(closedWithoutRecord([issue({ closedAt: AFTER })]).length).toBe(1);
  });

  test("the epoch is a constant, not a default that can be raised by forgetting", () => {
    expect(Number.isNaN(Date.parse(AUDIT_EPOCH)), `${AUDIT_EPOCH} is not a date`).toBe(false);
    // Called with no epoch argument at all, it must still cut off.
    expect(closedWithoutRecord([issue({ closedAt: BEFORE })])).toEqual([]);
  });

  test("a missing or unparseable close date is NOT treated as old", () => {
    // Otherwise a malformed reading is the cheapest way past the audit,
    // which is the fail-open this whole control replaces.
    expect(closedWithoutRecord([issue({ closedAt: null })]).length).toBe(1);
    expect(closedWithoutRecord([issue({ closedAt: "not a date" })]).length).toBe(1);
  });

  test("an explicit older epoch reaches history", () => {
    expect(closedWithoutRecord([issue({ closedAt: BEFORE })], "2020-01-01T00:00:00Z").length)
      .toBe(1);
  });
});

describe("#144 SC-835: what the audit does about it, and what it does not", () => {
  // AC-3: the action is stated and justified. Label and report; reopen only
  // behind a flag, and then only for the issues the hook itself protects.
  const finding = (labels: string[]) => ({ issue: issue({ labels }), reason: "x" });

  test("reopen is off by default, whatever the labels say", () => {
    expect(shouldReopen(finding(PROTECTED_LABELS), false)).toBe(false);
    expect(shouldReopen(finding([]), false)).toBe(false);
  });

  test("with --reopen, only ship-priority issues are reopened", () => {
    expect(shouldReopen(finding(["p1-ship-next"]), true)).toBe(true);
    expect(shouldReopen(finding(["p2-this-week"]), true)).toBe(true);
    expect(shouldReopen(finding(["bug"]), true), "a flag that reopened everything would make the cautious default pointless")
      .toBe(false);
    expect(shouldReopen(finding([]), true)).toBe(false);
  });

  test("the report says so when it found nothing", () => {
    // A control that prints nothing on a clean run is indistinguishable from
    // one that did not run.
    expect(report([], 42)).toContain("42 closed issues scanned, none");
  });

  test("the report names every finding", () => {
    const out = report(closedWithoutRecord([issue({ number: 7, title: "seven" })]), 9);
    expect(out).toContain("#7 seven");
    expect(out).toContain("1 of 9");
  });
});

describe("#144 SC-836: the GraphQL reading becomes the decision's input", () => {
  test("a pull-request closer is a record", () => {
    expect(toClosedIssue({
      number: 1, title: "t", stateReason: "COMPLETED", labels: { nodes: [] },
      closedAt: AFTER,
      timelineItems: { nodes: [{ closer: { __typename: "PullRequest", number: 376 } }] },
    })).toEqual({
      number: 1, title: "t", stateReason: "completed", labels: [],
      closedAt: AFTER, closedBy: "pull request #376",
    });
  });

  test("a commit closer is a record", () => {
    expect(toClosedIssue({
      number: 2, title: "t", stateReason: null, labels: { nodes: [{ name: "bug" }] },
      timelineItems: { nodes: [{ closer: { __typename: "Commit", oid: "abc" } }] },
    }).closedBy).toBe("commit abc");
  });

  test("a null closer is the signal, and so is an absent timeline", () => {
    expect(toClosedIssue({
      number: 3, title: "t", labels: { nodes: [] },
      timelineItems: { nodes: [{ closer: null }] },
    }).closedBy).toBeNull();
    expect(toClosedIssue({ number: 4, title: "t" }).closedBy).toBeNull();
  });

  test("stateReason is lowercased, because GraphQL shouts it", () => {
    // GraphQL returns NOT_PLANNED; the decision compares against not_planned.
    // A case mismatch here would silently disable the whole exemption.
    const got = toClosedIssue({ number: 5, title: "t", stateReason: "NOT_PLANNED" });
    expect(got.stateReason).toBe(NOT_PLANNED);
    expect(closedWithoutRecord([got]), "the case mismatch disabled the exemption").toEqual([]);
  });
});

function mutantScript(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const DECL = "export const REFUSE_EXIT = 1;";
  const n = src.split(DECL).length - 1;
  if (n !== 1) throw new Error(`could not build the mutant: the exit constant appears ${n} times`);
  let out = src.replace(DECL, "export const REFUSE_EXIT = 0;");
  out = out.replace(/from "(\.\.?\/[^"]+)"/g,
    (_m, spec) => `from ${JSON.stringify(join(ROOT, "scripts", spec))}`);
  if (/from "\.\.?\//.test(out)) {
    throw new Error("could not build the mutant: a relative import survived rewriting");
  }
  const dir = mkdtempSync(join(tmpdir(), "rungate-closemut-"));
  scratch.push(dir);
  const path = join(dir, "audit.mutant.ts");
  writeFileSync(path, out);
  return path;
}

function fixtureFile(nodes: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-closefix-"));
  scratch.push(dir);
  const path = join(dir, "nodes.json");
  writeFileSync(path, JSON.stringify(nodes));
  return path;
}

const run = (script: string, args: string[]) => {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8", timeout: 120_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

describe("#144 SC-836: the script runs, refuses through one exit, and writes nothing by default", () => {
  const BARE = {
    number: 23, title: "closed by a raw PATCH", stateReason: "COMPLETED",
    closedAt: "2099-01-01T00:00:00Z",
    labels: { nodes: [] }, timelineItems: { nodes: [{ closer: null }] },
  };
  const SHIPPED = {
    number: 24, title: "closed by a merged PR", stateReason: "COMPLETED",
    closedAt: "2099-01-01T00:00:00Z",
    labels: { nodes: [] },
    timelineItems: { nodes: [{ closer: { __typename: "PullRequest", number: 99 } }] },
  };

  test("a bare close is reported and the run is red", () => {
    const r = run(SCRIPT, ["--fixture", fixtureFile([BARE, SHIPPED])]);
    expect(r.out).toContain("#23 closed by a raw PATCH");
    expect(r.out, "the shipped issue was reported too").not.toContain("#24");
    expect(r.code, "findings left the scheduled job green").not.toBe(0);
  }, 180_000);

  test("a clean tracker exits 0 and says what it scanned", () => {
    const r = run(SCRIPT, ["--fixture", fixtureFile([SHIPPED])]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("1 closed issues scanned, none");
  }, 180_000);

  test("it writes nothing without --apply", () => {
    // A scheduled job that labels by default is one bad predicate away from
    // editing the whole tracker. The read-only default is the safety.
    const r = run(SCRIPT, ["--fixture", fixtureFile([BARE])]);
    expect(r.out).toContain("read-only");
    expect(r.out).toContain("--apply");
  }, 180_000);

  const NEGATIVE: Array<[string, string[], string]> = [
    ["no repo and no fixture", [], "--repo owner/name is required"],
    ["an unreadable fixture", ["--fixture", "/nope/nope.json"], "could not read the fixture"],
    ["a limit out of range", ["--repo", "o/n", "--limit", "500"], "--limit must be an integer"],
  ];
  for (const [name, args, expected] of NEGATIVE) {
    test(`refuses ${name}, and the mutant does not`, () => {
      const real = run(SCRIPT, args);
      expect(real.code, `the real script allowed ${name}`).not.toBe(0);
      expect(real.out).toContain(expected);
      const mutant = run(mutantScript(), args);
      expect(mutant.code, "zeroing REFUSE_EXIT changed nothing — the refusal has another path")
        .toBe(0);
      expect(mutant.out).toContain(expected);
    }, 180_000);
  }

  test("the mutant builder aborts rather than passing quietly when its target moves", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src.split("export const REFUSE_EXIT = 1;").length - 1).toBe(1);
    expect(/process\.exit\((?!REFUSE_EXIT)/.test(src),
      "a literal process.exit() would slip past the mutation").toBe(false);
  });
});

describe("#144 SC-835: the hook is reclassified, and the control is scheduled", () => {
  test("the hook's own source states that it is not an authorization boundary", () => {
    // The important half of the decision. As long as the hook is DESCRIBED as
    // a boundary, every security review is correct to keep finding bypasses,
    // and each round is cheap to generate and expensive to answer. AC-5 says
    // a new round against the parser means this reclassification did not
    // take — so the scope has to be where a reviewer reads it.
    // Exact case, deliberately. SC-835's generated conformity test does a
    // case-sensitive `contains`, and a laxer assertion here would go green
    // over a capitalisation that turns that one red — two checks of the same
    // fact disagreeing is worse than one.
    const src = readFileSync(HOOK, "utf-8");
    expect(src, "the hook does not say what it is not").toContain("not an authorization boundary");
    expect(src, "the hook does not say what it IS").toContain("speed bump");
  });

  test("the audit runs on a schedule, not when someone remembers", () => {
    const wf = readFileSync(WORKFLOW, "utf-8");
    // Anchored to the JOB KEY, not to the string anywhere. A bare
    // `toContain("audit-issue-closures")` is satisfied by the script's own
    // path on the run: line, so renaming the job scored 0 of 34 — the
    // detector was reading the wrong thing, which is this repo's own
    // recurring defect met one more time.
    expect(wf, "no job is named audit-issue-closures").toMatch(/^ {2}audit-issue-closures:$/m);
    expect(wf, "a control that only fires locally is the same fail-open as #140")
      .toMatch(/^\s*schedule:/m);
    expect(wf).toMatch(/cron:\s*"/);
    expect(wf, "the job does not run the audit").toContain("scripts/audit-issue-closures.ts");
  });

  test("the workflow can write issues and nothing else", () => {
    const wf = readFileSync(WORKFLOW, "utf-8");
    expect(wf).toMatch(/issues:\s*write/);
    expect(wf, "a token that can push is more than this job needs")
      .toMatch(/contents:\s*read/);
  });

  test("every action is pinned to a commit SHA", () => {
    const uses = readFileSync(WORKFLOW, "utf-8")
      .split("\n")
      .filter(l => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const ref = line.split("uses:")[1].trim().split(/\s+#/)[0];
      expect(ref, `not pinned to a SHA: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test("no workflow input reaches a shell as interpolated text", () => {
    const src = readFileSync(WORKFLOW, "utf-8")
      .split("\n")
      .filter(l => !/^\s*#/.test(l));
    const ENV_ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{[^}]+\}\}\s*$/;
    for (const line of src.filter(l => l.includes("${{"))) {
      expect(ENV_ASSIGNMENT.test(line), `an expression reaches a shell: ${line.trim()}`).toBe(true);
    }
  });
});
