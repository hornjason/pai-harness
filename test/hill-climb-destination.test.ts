/**
 * The hill-climb loop's output has a destination, and the destination has a
 * name (#624).
 *
 * Covers SC-2081, SC-2082 (INSTRUCTION-COMPLIANCE-SPEC.md).
 *
 * `applyHillClimb` used to compose the reinforced brief and then write the
 * tracked file at the bottom of the same loop, as a side effect of having
 * composed it. Nobody had chosen that: the issue's three defensible answers
 * are commit it behind review, write it somewhere that is not a tracked file,
 * or discard it deliberately and say so, and the behaviour was the fourth —
 * the first one by accident, with no review step and no record.
 *
 * So composing and writing are now two things, and the write goes through one
 * exported binding that names which of the three it is doing. The evidence
 * that the write is no longer a side effect is the DISCARD case: the same
 * composition runs, reports the same applied reinforcement, and leaves every
 * file on disk exactly as it found it.
 *
 * Every case asserts the reinforcement was actually applied before it reads
 * any file state. A run that skipped leaves the brief unchanged too, and a
 * case that only checked the brief could not tell the two apart.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

import {
  DEFAULT_HILL_CLIMB_DESTINATION,
  HILL_CLIMB_DESTINATIONS,
  applyHillClimb,
  untrackedBriefPath,
  writeReinforcedBrief,
  type HillClimbAction,
  type HillClimbDestination,
} from "../lib/compliance-report";

const REINFORCEMENT =
  "NEVER read a file with cat, head, or tail via Bash — use Read with offset/limit.";

const BRIEF = `---
name: discovery
---

## Never Do
- Read files not relevant to the issue — stay scoped

## Context (READ THIS FIRST)
- Read AGENTS.md first
`;

function action(): HillClimbAction {
  return {
    compId: "COMP-7",
    rule: "No cat/head via Bash",
    reinforcement: REINFORCEMENT,
    consecutiveFails: 3,
    tier: 1,
  };
}

interface Fixture {
  briefPath: string;
  untrackedDir: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hill-climb-destination-"));
  // The brief lives in its own directory so "the untracked copy is not beside
  // the brief" is a thing the case can assert rather than assume.
  const briefPath = join(root, "agents", "discovery.md");
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, BRIEF);
  return { briefPath, untrackedDir: join(root, "untracked") };
}

describe("hill-climb destination", () => {
  test("AC-1: COMMIT writes the brief in place and names what it did", () => {
    const { briefPath, untrackedDir } = fixture();

    const result = applyHillClimb(briefPath, [action()], {
      destination: "COMMIT",
      untrackedDir,
    });

    expect(result.applied.length).toBe(1);
    expect(result.write.destination).toBe("COMMIT");
    expect(result.write.path).toBe(briefPath);
    expect(readFileSync(briefPath, "utf-8")).toContain(REINFORCEMENT);
  });

  test("AC-1: UNTRACKED leaves the brief byte-identical and writes the reinforced copy elsewhere", () => {
    const { briefPath, untrackedDir } = fixture();
    const before = readFileSync(briefPath, "utf-8");

    const result = applyHillClimb(briefPath, [action()], {
      destination: "UNTRACKED",
      untrackedDir,
    });

    expect(result.applied.length).toBe(1);
    expect(result.write.destination).toBe("UNTRACKED");
    expect(result.write.path).toBe(untrackedBriefPath(briefPath, untrackedDir));
    expect(dirname(result.write.path!)).not.toBe(dirname(briefPath));

    expect(readFileSync(briefPath, "utf-8")).toBe(before);
    expect(readFileSync(result.write.path!, "utf-8")).toContain(REINFORCEMENT);
  });

  test("AC-1: DISCARD composes the reinforcement and writes nothing anywhere", () => {
    const { briefPath, untrackedDir } = fixture();
    const before = readFileSync(briefPath, "utf-8");

    const result = applyHillClimb(briefPath, [action()], {
      destination: "DISCARD",
      untrackedDir,
    });

    // The composition still happened — this is what makes the untouched files
    // below evidence that the write is not a side effect of composing.
    expect(result.applied.length).toBe(1);
    expect(result.write.destination).toBe("DISCARD");
    expect(result.write.path).toBe(null);

    expect(readFileSync(briefPath, "utf-8")).toBe(before);
    expect(existsSync(untrackedBriefPath(briefPath, untrackedDir))).toBe(false);
  });

  test("AC-1: the applied line names the destination, so a log says where the rule went", () => {
    for (const destination of HILL_CLIMB_DESTINATIONS) {
      // A fresh brief per destination: COMMIT writes the reinforcement into
      // the file, and the next pass over the same brief would skip it as
      // already present.
      const { briefPath, untrackedDir } = fixture();
      const result = applyHillClimb(briefPath, [action()], { destination, untrackedDir });
      expect(result.applied.length).toBe(1);
      expect(result.applied[0]).toContain("COMP-7");
      expect(result.applied[0]).toContain(destination);
    }
  });

  test("AC-1: every destination the binding names is handled by the writer", () => {
    expect([...HILL_CLIMB_DESTINATIONS].sort()).toEqual([
      "COMMIT",
      "DISCARD",
      "UNTRACKED",
    ]);

    // #648. `write.destination` is the NAME the caller passed, echoed
    // back, so asserting it is asking the question again rather than
    // answering it (`.claude/rules/checks-must-be-able-to-fail.md`, #530).
    // The distinguishing property of a destination is WHERE, and the
    // earlier version of this loop never asserted one: under a writer that
    // ignores its destination and always writes the tracked brief, every
    // iteration still echoed the right name, `write.path` was never null
    // so the `continue` never fired, and the content check read the file
    // the mutant had wrongly written. Measured: that mutation was green
    // here and red in five other cases. So the expected PATH is written
    // down per destination, and `DISCARD` is asserted to be null rather
    // than skipped past.
    const expectedPath = (
      destination: HillClimbDestination,
      briefPath: string,
      untrackedDir: string,
    ): string | null =>
      destination === "COMMIT"
        ? briefPath
        : destination === "UNTRACKED"
          ? join(untrackedDir, basename(briefPath))
          : null;

    for (const destination of HILL_CLIMB_DESTINATIONS) {
      const { briefPath, untrackedDir } = fixture();
      const before = readFileSync(briefPath, "utf-8");
      const write = writeReinforcedBrief(briefPath, "reinforced", {
        destination,
        untrackedDir,
      });
      expect(write.destination).toBe(destination);
      expect(`${destination}:${write.path}`).toBe(
        `${destination}:${expectedPath(destination, briefPath, untrackedDir)}`,
      );
      if (write.path === null) {
        // Nothing anywhere, not merely nothing reported.
        expect(readFileSync(briefPath, "utf-8")).toBe(before);
        expect(existsSync(join(untrackedDir, basename(briefPath)))).toBe(false);
        continue;
      }
      expect(readFileSync(write.path, "utf-8")).toBe("reinforced");
      if (destination !== "COMMIT") {
        expect(readFileSync(briefPath, "utf-8"), "the tracked brief was written anyway").toBe(before);
      }
    }
  });

  test("SC-2082: the default destination is one binding, and it is one of the three names", () => {
    const named: readonly HillClimbDestination[] = HILL_CLIMB_DESTINATIONS;
    expect(named).toContain(DEFAULT_HILL_CLIMB_DESTINATION);

    const { briefPath, untrackedDir } = fixture();
    const result = applyHillClimb(briefPath, [action()], { untrackedDir });
    expect(result.applied.length).toBe(1);
    expect(result.write.destination).toBe(DEFAULT_HILL_CLIMB_DESTINATION);
  });

  test("AC-1: a run that applies nothing writes nothing", () => {
    const { briefPath, untrackedDir } = fixture();
    const before = readFileSync(briefPath, "utf-8");

    const promotion: HillClimbAction = { ...action(), tier: 3, promotion: "Deploy a hook" };
    const result = applyHillClimb(briefPath, [promotion], {
      destination: "COMMIT",
      untrackedDir,
    });

    expect(result.applied.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.write.path).toBe(null);
    expect(readFileSync(briefPath, "utf-8")).toBe(before);
  });
});
