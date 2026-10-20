/**
 * #722 — rungate owns named jobs, so a workflow file it did not generate was
 * invisible to it.
 *
 * `.claude/rules/harness-managed.md` lists owned PATHS, and the list is a list
 * of files the scaffold WRITES. A file it did not write cannot be added to it
 * without the scaffold then generating it, so there was no strategy under
 * which an unowned workflow could be reported at all. `hornjason/
 * asaCommandCenter` has rungate scaffolded into it and runs five gh-aw
 * workflows the harness has never seen; every run reported clean.
 *
 * A scan that reports a clean CI surface having read 2 of 7 files is
 * `.claude/rules/config-access.md`'s *Silent Default Substitution*: `2/7` and
 * `7/7` are the same PASS and no reader can tell them apart from the output.
 *
 * ## Ownership travels with the file, not with a list in another file
 *
 * The mechanism already exists one directory away. `.claude/rules/*.md` carry
 * `generated-sha:` in their frontmatter and use the `provenance` strategy
 * (#370). The marker is what makes a file self-identifying. This applies the
 * same idea to `.github/workflows/` with the comment syntax YAML has, so the
 * three statuses are a property of the bytes on disk rather than a lookup:
 *
 *   marker present, digest matches  → generated-and-unchanged
 *   marker present, digest differs  → generated-and-hand-edited
 *   no marker                       → NOT-OWNED
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Add the five gh-aw filenames to `OWNED_FILES` and to the table in
 * `harness-managed.md`.** It makes the symptom go away for the one consumer
 * that reported it — those five files stop being invisible — and it is wrong
 * twice over: the list is a list of files the generator writes, so the next
 * scaffold either generates them or the row describes behaviour the code does
 * not have (#208 exactly); and the sixth unowned workflow, in the next
 * consumer, is invisible again.
 *
 * Does this file survive it? Yes, non-vacuously. AC-2 and AC-3 fixture a
 * workflow named nothing in particular and assert it is reported by the
 * ABSENCE of a marker, so no amount of adding names to a list turns them
 * green. AC-6's coverage figure is the one that makes the shortfall legible
 * whatever the cause.
 *
 * ## Why UNMEASURED and not an empty list
 *
 * AC-4. A directory that could not be read produces zero NOT-OWNED files, and
 * so does a directory in which every file is owned. They are the same output
 * and opposite facts — #646's shape, and the reason `reading` is a field
 * rather than something a caller infers from an empty array.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  censusReport,
  stampWorkflow,
  workflowCensus,
  workflowMarker,
} from "../lib/scaffold/workflow-census";

/** A plausible generated workflow, with no marker. */
const GENERATED = `name: CI
on:
  push:
    branches:
      - "main"
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - uses: actions/checkout@v4
      - run: bun test
`;

/** What a consumer's own Copilot workflow looks like: nothing in common. */
const FOREIGN = `name: Issue Triage
on:
  issues:
    types: [opened]
engine: copilot
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - run: echo triage
`;

function projectWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-722-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return root;
}

function statusOf(root: string, name: string): string | undefined {
  return workflowCensus(root).files.find(f => f.name === name)?.status;
}

describe("#722 AC-1: the marker is a YAML comment and changes no document", () => {
  test("the stamped file parses to the same document as the unstamped one", () => {
    // The whole constraint on the marker. A workflow GitHub Actions reads
    // differently because the harness stamped it would be a change to the
    // consumer's CI dressed as bookkeeping.
    const stamped = stampWorkflow(GENERATED);
    expect(stamped).not.toBe(GENERATED);
    expect(Bun.YAML.parse(stamped)).toEqual(Bun.YAML.parse(GENERATED));
  });

  test("the marker is on the first line and recoverable from the raw bytes", () => {
    // Parsing drops comments, so the round-trip above cannot witness that the
    // marker is THERE. Both halves are needed: one says it is invisible to
    // YAML, the other says it is visible to us.
    const stamped = stampWorkflow(GENERATED);
    expect(stamped.split("\n")[0]).toMatch(/^# generated-sha: [0-9a-f]{16}$/);
    expect(workflowMarker(stamped)).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowMarker(GENERATED)).toBeNull();
  });

  test("stamping is idempotent — a re-scaffold does not accumulate markers", () => {
    expect(stampWorkflow(stampWorkflow(GENERATED))).toBe(stampWorkflow(GENERATED));
  });
});

describe("#722 AC-2: every workflow file gets one of the three statuses", () => {
  test("a stamped, untouched file is generated-and-unchanged", () => {
    const root = projectWith({ "ci.yml": stampWorkflow(GENERATED) });
    try {
      expect(statusOf(root, "ci.yml")).toBe("generated-and-unchanged");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a stamped file somebody edited is generated-and-hand-edited", () => {
    const root = projectWith({ "ci.yml": stampWorkflow(GENERATED) + "      - run: echo mine\n" });
    try {
      expect(statusOf(root, "ci.yml")).toBe("generated-and-hand-edited");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a file with no marker is NOT-OWNED", () => {
    const root = projectWith({ "issue-triage.lock.yml": FOREIGN });
    try {
      expect(statusOf(root, "issue-triage.lock.yml")).toBe("NOT-OWNED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("every file present gets a status — none is silently skipped", () => {
    // The vacuity control. A census that returned [] would satisfy every
    // "status is X" case above by never being asked about that file.
    const root = projectWith({
      "ci.yml": stampWorkflow(GENERATED),
      "gates.yml": stampWorkflow(GENERATED.replace("CI", "Gates")),
      "issue-triage.lock.yml": FOREIGN,
      "prove-check.lock.yml": FOREIGN.replace("Issue Triage", "Prove Check"),
    });
    try {
      const c = workflowCensus(root);
      expect(c.files.map(f => f.name).sort()).toEqual([
        "ci.yml", "gates.yml", "issue-triage.lock.yml", "prove-check.lock.yml",
      ]);
      expect(c.reading).toBe("MEASURED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("#722 AC-3: unowned files are named, not counted", () => {
  test("the report names each NOT-OWNED workflow individually", () => {
    // "5 unowned workflows" sends nobody anywhere. The five that cost
    // asaCommandCenter money each have a name, and the name is the whole of
    // what makes the output actionable.
    const names = ["issue-triage", "pr-nitpick-reviewer", "prove-check", "repo-status", "sc-verification"];
    const root = projectWith({
      "ci.yml": stampWorkflow(GENERATED),
      ...Object.fromEntries(names.map(n => [`${n}.lock.yml`, FOREIGN])),
    });
    try {
      const c = workflowCensus(root);
      expect(c.notOwned.sort()).toEqual(names.map(n => `${n}.lock.yml`).sort());
      const report = censusReport(c).join("\n");
      for (const n of names) {
        expect(report, `${n} is not named in the report`).toContain(`${n}.lock.yml`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("#722 AC-4: a scan that could not read reports UNMEASURED", () => {
  test("an absent workflows directory is UNMEASURED, not zero unowned files", () => {
    // Zero NOT-OWNED because nothing was read, and zero NOT-OWNED because
    // everything is owned, are the same array and opposite facts.
    const root = mkdtempSync(join(tmpdir(), "rungate-722-"));
    try {
      const c = workflowCensus(root);
      expect(c.reading).toBe("UNMEASURED");
      expect(c.unmeasuredReasons.join(" ")).toContain("WORKFLOWS_DIR_ABSENT");
      expect(censusReport(c).join("\n")).toContain("UNMEASURED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a workflow file that cannot be read is UNMEASURED and is NAMED", () => {
    const root = projectWith({ "ci.yml": stampWorkflow(GENERATED), "secret.yml": FOREIGN });
    const unreadable = join(root, ".github", "workflows", "secret.yml");
    chmodSync(unreadable, 0o000);
    try {
      const c = workflowCensus(root);
      // A file nobody could open must not be reported as owned OR as unowned
      // — both are claims about bytes that were never looked at.
      expect(c.reading).toBe("UNMEASURED");
      expect(c.unmeasuredReasons.join(" ")).toContain("secret.yml");
      expect(c.notOwned).not.toContain("secret.yml");
    } finally {
      chmodSync(unreadable, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty workflows directory is MEASURED with nothing in it", () => {
    // The control for the case above. If an absent directory is UNMEASURED,
    // a present and empty one has to be MEASURED, or "UNMEASURED" just means
    // "no files" and the distinction this AC is about does not exist.
    const root = projectWith({});
    try {
      const c = workflowCensus(root);
      expect(c.reading).toBe("MEASURED");
      expect(c.files).toEqual([]);
      expect(c.coverage).toEqual({ read: 0, present: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("#722 AC-6: the report carries its own coverage", () => {
  test("a complete scan reports read === present", () => {
    const root = projectWith({ "ci.yml": stampWorkflow(GENERATED), "x.yml": FOREIGN });
    try {
      const c = workflowCensus(root);
      expect(c.coverage).toEqual({ read: 2, present: 2 });
      expect(censusReport(c).join("\n")).toContain("2/2");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a partial scan says so in the figure, not only in the reasons", () => {
    // `36/426` and `426/426` are the same PASS today — #492's sentence, and
    // the reason the figure is in the rendered line and not just the object.
    const root = projectWith({ "ci.yml": stampWorkflow(GENERATED), "secret.yml": FOREIGN });
    const unreadable = join(root, ".github", "workflows", "secret.yml");
    chmodSync(unreadable, 0o000);
    try {
      const c = workflowCensus(root);
      expect(c.coverage).toEqual({ read: 1, present: 2 });
      expect(censusReport(c).join("\n")).toContain("1/2");
    } finally {
      chmodSync(unreadable, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
