/**
 * Covers #624 AC-2 and #648 AC-1..AC-4 — a reinforcement run leaves no
 * tracked brief modified, and the re-grade reads the file the run wrote.
 *
 * The defect #624 is named after: the hill-climb loop composed a rule,
 * wrote it into a tracked agent brief, and nothing committed it. The next
 * `git checkout` threw it away, and the receipt said the reinforcement had
 * been applied — because it had been, to a file nobody kept.
 *
 * #624 Phase 1 routed every write through `writeReinforcedBrief` and gave
 * the choice a name. **This file is the part that observes the working tree
 * rather than the return value**, because a destination constant that says
 * `UNTRACKED` and a write that lands in the repository anyway are the same
 * object as far as the caller can see.
 *
 * #648 is the behaviour change Phase 1 deliberately did not make: the
 * shipped loop now PASSES a destination instead of inheriting
 * `DEFAULT_HILL_CLIMB_DESTINATION`, and the re-grade is bound to the path
 * the write reported rather than re-derived from role config. The last
 * describe block drives the real `persistCompliance` against a scratch
 * checkout, because the unit cases below it can only see what the binding
 * returns and the whole subject of this issue is what the SHIPPED CALLER
 * does with it.
 *
 * The git state is read with `git status --porcelain` against a real
 * scratch checkout, for the reason `.claude/rules/config-access.md` gives
 * about artefacts: asking the function where it wrote is asking the
 * question again, not answering it.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  applyHillClimb,
  REINFORCEMENT_PREFIX,
  setComplianceProjectRoot,
  type ComplianceEntry,
} from "../lib/compliance-report";
import {
  persistCompliance,
  hillClimbProposalDir,
  SHIPPED_HILL_CLIMB_DESTINATION,
  type RegradeRequest,
} from "../scripts/persist-compliance";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const RULE = "Never report PASS with known gaps";
const BRIEF = `# Marcus

## Efficiency Rules

- Read before you write.

## Never Do

- Commit secrets.
`;

/** A real git checkout with the brief TRACKED and committed. */
function scratchRepo(): { root: string; brief: string } {
  const root = mkdtempSync(join(tmpdir(), "hillclimb-git-"));
  made.push(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(root, ".claude/agents"), { recursive: true });
  const brief = join(root, ".claude/agents/marcus.md");
  writeFileSync(brief, BRIEF);
  git("add", "-A");
  git("commit", "-q", "-m", "brief");
  return { root, brief };
}

const porcelain = (root: string): string[] =>
  execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf-8" })
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

const modifiedBriefs = (root: string): string[] =>
  porcelain(root).filter(l => /^M/.test(l) && l.includes(".claude/agents/"));

const action = () => ({
  compId: "COMP-1",
  rule: RULE,
  reinforcement: `${RULE} — list every gap you know of before reporting.`,
  consecutiveFails: 3,
  tier: 1 as const,
});

describe("#624 AC-2: an UNTRACKED reinforcement does not touch the repository", () => {
  test("the reinforcement is applied, and no tracked brief is modified", () => {
    const { root, brief } = scratchRepo();
    // Its own `mkdtempSync` root, not `join(root, "..", Date.now())`.
    // `root`'s parent IS the shared temp directory, so that spelling put a
    // predictable, world-writable path on the end of a recursive delete —
    // and the destination only has to be outside the *checkout*, which an
    // exclusive 0700 directory satisfies without being guessable.
    const untrackedDir = mkdtempSync(join(tmpdir(), "hillclimb-out-"));
    made.push(untrackedDir);

    // The run must be CLEAN before the write, or "nothing modified"
    // afterwards would be a fact about the fixture and not about the code.
    expect(porcelain(root), "the scratch checkout starts clean").toEqual([]);

    const r = applyHillClimb(brief, [action()], { destination: "UNTRACKED", untrackedDir });

    // Asserted FIRST, in the order the criterion asks for: a run that
    // applied nothing also modifies nothing, and would satisfy the second
    // half of this test while doing none of the work.
    expect(r.applied.length, "a run that applied nothing proves nothing here").toBe(1);
    expect(r.write.destination).toBe("UNTRACKED");
    expect(r.write.path).not.toBeNull();
    expect(existsSync(r.write.path as string)).toBe(true);
    expect(
      readFileSync(r.write.path as string, "utf-8"),
      "the insertion has to be AT the destination, not merely reported",
    ).toContain(REINFORCEMENT_PREFIX);

    // The working tree, read from git rather than from the return value.
    expect(modifiedBriefs(root), "a tracked brief was modified by a write that said UNTRACKED")
      .toEqual([]);
    expect(porcelain(root), "the reinforcement landed outside the repository entirely")
      .toEqual([]);
    expect(readFileSync(brief, "utf-8"), "the tracked brief is byte-identical").toBe(BRIEF);
  });

  test("COMMIT leaves the modification neither committed nor reverted, which is why it is not the shipped destination", () => {
    // Two jobs, and #648 adds the second.
    //
    // (1) The positive control, without which the case above is the #500
    // shape — an assertion satisfied by a route that bypasses the feature.
    // "No tracked brief modified" is also true of a run that wrote
    // nothing, crashed, or was handed an action it skipped. Only a pair in
    // which the OTHER destination visibly does modify the tree establishes
    // that the fixture can show a modification at all.
    //
    // (2) #648 AC-3 states the property as a tracked modification being
    // *committed OR reverted by the same code path*. The earlier version
    // of this case asserted only that COMMIT modifies the tree and called
    // that "by design", which records the symptom as the specification.
    // What COMMIT actually does is leave the modification in the working
    // tree with nothing downstream to resolve it — measured live on run
    // `wf_9ab25fd1-6e5`, in the shared primary checkout — so the property
    // is asserted here in full and the conclusion that follows from it,
    // that the shipped loop must not pass COMMIT, is asserted beside it.
    const { root, brief } = scratchRepo();
    expect(porcelain(root)).toEqual([]);
    const headBefore = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();

    const r = applyHillClimb(brief, [action()], { destination: "COMMIT" });

    expect(r.applied.length).toBe(1);
    expect(r.write.path).toBe(brief);
    expect(modifiedBriefs(root), "COMMIT writes the tracked brief in place").toHaveLength(1);
    expect(readFileSync(brief, "utf-8")).not.toBe(BRIEF);

    // Not committed: HEAD is where it was, so the modification is not in
    // history and `git checkout` throws it away.
    expect(
      execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
      "nothing in the code path commits, so the rule is one checkout from gone",
    ).toBe(headBefore);
    // Not reverted either: the dirty tree is still dirty afterwards. Both
    // halves are asserted because AC-3's property is a disjunction, and a
    // case checking only one half passes over the other resolution.
    expect(porcelain(root), "and nothing reverts it, so the shared checkout stays dirty")
      .not.toEqual([]);

    // The conclusion, bound to the shipped constant rather than restated
    // in prose: a destination that cannot satisfy AC-3 is not the one the
    // loop passes. This goes red if someone flips the shipped loop back.
    expect(
      SHIPPED_HILL_CLIMB_DESTINATION,
      "COMMIT satisfies neither half of AC-3, so the shipped loop must not pass it",
    ).not.toBe("COMMIT");
  });

  test("DISCARD composes, reports, and writes nothing anywhere", () => {
    const { root, brief } = scratchRepo();
    const r = applyHillClimb(brief, [action()], { destination: "DISCARD" });

    expect(r.applied.length, "composed and reported").toBe(1);
    expect(r.write.path, "and written nowhere").toBeNull();
    expect(porcelain(root)).toEqual([]);
    expect(readFileSync(brief, "utf-8")).toBe(BRIEF);
  });
});

/**
 * #648 — the SHIPPED loop, driven end to end against a scratch checkout.
 *
 * Everything above calls `applyHillClimb` directly with a destination the
 * test chose. That can never witness this issue: the defect is that
 * `scripts/persist-compliance.ts` passed NO destination and discarded the
 * `write` it got back, so the destination was whatever
 * `DEFAULT_HILL_CLIMB_DESTINATION` happened to be and the re-grade target
 * was re-derived from role config. Both of those are properties of the
 * CALLER, and a test that supplies the destination itself has stepped over
 * the thing under test (`.claude/rules/checks-must-be-able-to-fail.md`,
 * "a fixture that reached the assertion without the feature").
 *
 * So these cases run the real `persistCompliance` over a real git checkout
 * and read the working tree, and the only seam used is the one that
 * observes the re-grade — because spawning `bun scripts/test-brief.ts` for
 * real would spawn an agent.
 */
describe("#648: the shipped hill-climb loop against a scratch git checkout", () => {
  const ROLE = "marcus";
  /**
   * COMP-13 is the id the #646 fixtures use: it is in the fallback
   * reinforcement map and reaches a tier-1 patch at three consecutive
   * fails, which is the shape run `wf_9ab25fd1-6e5` had.
   */
  const COMP = "COMP-13";

  interface Fixture {
    root: string;
    repo: string;
    workDir: string;
    brief: string;
    regrades: RegradeRequest[];
  }

  /**
   * A run directory beside a real git checkout carrying a tracked brief.
   *
   * The work directory is OUTSIDE the checkout on purpose — that is where
   * a ship run's work directory lives — so anything the loop writes into
   * it cannot show up in `git status` by accident and make the AC-3
   * assertion true for the wrong reason.
   */
  function fixture(): Fixture {
    const root = mkdtempSync(join(tmpdir(), "hillclimb-shipped-"));
    made.push(root);
    const repo = join(root, "repo");
    const workDir = join(root, "run");
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    mkdirSync(join(repo, ".claude", "rungate"), { recursive: true });
    mkdirSync(join(workDir, "transcripts"), { recursive: true });

    const brief = join(repo, ".claude", "agents", `${ROLE}.md`);
    writeFileSync(brief, BRIEF);
    writeFileSync(
      join(repo, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "fixture" }),
    );
    writeFileSync(
      join(repo, ".claude", "rungate", "roles.json"),
      JSON.stringify({ [ROLE]: { brief: join(".claude", "agents", `${ROLE}.md`) } }),
    );

    const git = (...a: string[]) =>
      execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-q", "-m", "brief");

    writeFileSync(
      join(workDir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 2,
        issue: 648,
        slug: "hill-climb-destination",
        phase: "VERIFY",
        issueGoal: "choose the hill-climb destination deliberately",
        acs: [],
      }),
    );
    // A transcript for the role, so the re-grade step is REACHED. Without
    // one the loop `continue`s before it, and "no re-grade happened" would
    // be a fact about the fixture.
    writeFileSync(join(workDir, "transcripts", `${ROLE}-1.jsonl`), "{}\n");

    // Three consecutive fails: two in history, one in this run's grade.
    const history = [0, 1].map(i =>
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        issue: `#${600 + i}`,
        role: ROLE,
        schema: 2,
        rules: [{ id: COMP, verdict: "IGNORED" }],
        total: 1,
        followed: 0,
        pct: 0,
        flagged: [],
      } satisfies ComplianceEntry),
    );
    writeFileSync(join(root, "compliance-history.jsonl"), history.join("\n") + "\n");
    writeFileSync(
      join(workDir, "compliance-grade.json"),
      JSON.stringify({
        grades: [
          { role: ROLE, total: 1, followed: 0, flagged: [], rules: [{ id: COMP, verdict: "IGNORED" }] },
        ],
      }),
    );

    // Pin the reinforcement/threshold maps to the built-in fallbacks, as
    // the #646 fixtures do: an empty root resolves no compliance.json, so
    // the case does not depend on whichever root another file left cached.
    setComplianceProjectRoot("");
    return { root, repo, workDir, brief, regrades: [] };
  }

  const runShipped = (f: Fixture, logs: string[] = []) =>
    persistCompliance(f.workDir, f.repo, "648", m => logs.push(m), {
      regrade: req => {
        f.regrades.push(req);
        return "score: 100";
      },
    });

  test("a reinforcement is applied and the tracked checkout is left clean", () => {
    const f = fixture();
    // The fixture has to be able to show a modification, or "clean
    // afterwards" is a fact about the fixture rather than about the code.
    expect(porcelain(f.repo), "the scratch checkout starts clean").toEqual([]);

    const r = runShipped(f);

    // AC-4, asserted BEFORE any git state is read, and in this order: a
    // loop that wrote nothing also dirties nothing, and would satisfy
    // everything below while doing none of the work.
    expect(r.hillClimbApplied, "a run that applied nothing proves nothing here").toBe(1);
    const proposal = join(hillClimbProposalDir(f.workDir), `${ROLE}.md`);
    expect(existsSync(proposal), "the reinforcement was written somewhere real").toBe(true);
    expect(readFileSync(proposal, "utf-8")).toContain(REINFORCEMENT_PREFIX);

    // AC-3, read from git rather than from the return value.
    expect(porcelain(f.repo), "the shipped loop dirtied a tracked checkout").toEqual([]);
    expect(readFileSync(f.brief, "utf-8"), "the tracked brief is byte-identical").toBe(BRIEF);
  });

  test("the re-grade is handed the path the write reported, not the role's tracked brief", () => {
    const f = fixture();

    runShipped(f);

    // AC-2. The two paths DIFFER under the shipped destination, which is
    // what makes this a measurement: before #648 the re-grade re-derived
    // its target from role config and would have scored `f.brief`, the
    // unpatched file, and reported the number as the patched one.
    expect(f.regrades.length, "the re-grade must actually have run").toBe(1);
    expect(f.regrades[0]!.briefPath).toBe(join(hillClimbProposalDir(f.workDir), `${ROLE}.md`));
    expect(f.regrades[0]!.briefPath).not.toBe(f.brief);
    expect(
      readFileSync(f.regrades[0]!.briefPath, "utf-8"),
      "the file the re-grade was pointed at carries the reinforcement",
    ).toContain(REINFORCEMENT_PREFIX);
  });

  test("a destination that wrote nothing refuses the re-grade instead of scoring the old brief", () => {
    const f = fixture();
    const logs: string[] = [];

    // DISCARD forced through the one exported seam, rather than by
    // mutating the shipped constant: the claim is about what the loop does
    // when `write.path` is null, and the seam is how a case reaches that
    // reply without rewriting the source.
    const r = persistCompliance(f.workDir, f.repo, "648", m => logs.push(m), {
      applyHillClimb: (briefPath, actions) =>
        applyHillClimb(briefPath, actions, { destination: "DISCARD" }),
      regrade: req => {
        f.regrades.push(req);
        return "score: 100";
      },
    });

    // Non-vacuity first: a reinforcement WAS composed and applied, so the
    // re-grade step was reached and declined rather than never arrived at.
    expect(r.hillClimbApplied, "the loop must have something to re-grade").toBe(1);
    expect(f.regrades, "nothing was written, so nothing may be re-graded").toEqual([]);
    expect(r.verified, "and the role is not reported as verified").toEqual([]);
    expect(
      logs.join("\n"),
      "a refusal nobody can read is the silence #646 exists to abolish",
    ).toContain("HILL-CLIMB VERIFY refused");
    expect(porcelain(f.repo)).toEqual([]);
  });
});
