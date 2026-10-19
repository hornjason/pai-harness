/**
 * Covers #624 AC-2 — a reinforcement run leaves no tracked brief modified.
 *
 * The defect #624 is named after: the hill-climb loop composed a rule,
 * wrote it into a tracked agent brief, and nothing committed it. The next
 * `git checkout` threw it away, and the receipt said the reinforcement had
 * been applied — because it had been, to a file nobody kept.
 *
 * AC-1 routed every write through `writeReinforcedBrief` and gave the
 * choice a name. **This file is the part that observes the working tree
 * rather than the return value**, because a destination constant that says
 * `UNTRACKED` and a write that lands in the repository anyway are the same
 * object as far as the caller can see.
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

import { applyHillClimb, REINFORCEMENT_PREFIX } from "../lib/compliance-report";

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

  test("the same run against COMMIT does modify the tracked brief", () => {
    // The positive control, and the case without which the one above is
    // the #500 shape — an assertion satisfied by a route that bypasses the
    // feature. "No tracked brief modified" is also true of a run that
    // wrote nothing, crashed, or was handed an action it skipped. Only a
    // pair in which the OTHER destination visibly does modify the tree
    // establishes that the fixture can show a modification at all.
    const { root, brief } = scratchRepo();
    expect(porcelain(root)).toEqual([]);

    const r = applyHillClimb(brief, [action()], { destination: "COMMIT" });

    expect(r.applied.length).toBe(1);
    expect(r.write.path).toBe(brief);
    expect(modifiedBriefs(root), "COMMIT writes the tracked brief in place, by design")
      .toHaveLength(1);
    expect(readFileSync(brief, "utf-8")).not.toBe(BRIEF);
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
