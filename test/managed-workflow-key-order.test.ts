/**
 * Covers SC-1667..SC-1671 (SCAFFOLD-DECOMPOSITION-SPEC.md), #482.
 *
 * The job-preserving merge carries a consumer's non-`jobs:` top-level keys
 * forward — `concurrency`, `permissions`, `env`, `defaults` — and appends them
 * BELOW `jobs:`, while any comment introducing them stays where it was.
 *
 * YAML top-level keys are order-independent, so the file still means what it
 * meant and `lostLines` is correct to stay quiet: nothing was lost. What moves
 * is the evidence. The comment that explained the block now sits above an
 * unrelated section, and the block is hundreds of lines further down.
 *
 * ## Why that is a defect and not a cosmetic complaint
 *
 * Measured, on a real consumer: a reader saw
 *
 *     # When multiple pushes to main land quickly, cancel in-progress runs
 *     jobs:
 *       test:
 *
 * concluded the `concurrency:` block had been deleted, and restored it by
 * hand. The original was still there, 460 lines down. The committed result
 * had two top-level `concurrency:` keys and no longer parsed — `Map keys must
 * be unique at line 493` — so GitHub Actions rejected the workflow.
 *
 * The harness lost nothing and produced a diff whose most natural reading is
 * that it lost something, and the correction broke the file. That is worse
 * than the deletion would have been, because a deletion fails loudly. The
 * report said `UPDATED`, 0 refusals, jobs preserved — all true, all about the
 * dimension that did not change.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` is about checks that cannot
 * fail. This is the neighbouring shape: **a report that is accurate and still
 * misleads**, because it is silent on the dimension that moved.
 *
 * ## What this file pins
 *
 * Three things, and the order matters. Keeping the key in place (SC-1667) is
 * the fix. Keeping its comment attached (SC-1668) is what the fix is FOR —
 * the comment is the artefact the reader acted on. Reporting any movement
 * that still happens (SC-1669, SC-1670) is what stops "we didn't move
 * anything" being an assumption, and refusing a merged file with a duplicate
 * key (SC-1671) is the backstop for the correction itself.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");

import {
  mergeManagedWorkflow,
  jobNames,
  topLevelKeyOrder,
  duplicateTopLevelKeys,
  movedTopLevelKeys,
} from "../lib/scaffold/managed-workflow";
import { resolveManagedWrite, writeManagedFile } from "../lib/scaffold/steps";

/** The consumer's file, carrying the exact shape that caused the incident. */
const CONSUMER = [
  "name: CI",
  "",
  "on:",
  "  push:",
  "    branches: [main]",
  "",
  "# When multiple pushes to main land quickly, cancel in-progress runs",
  "concurrency:",
  "  group: ci-${{ github.ref }}",
  "  cancel-in-progress: true",
  "",
  "permissions:",
  "  contents: read",
  "",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm run lint",
  "",
].join("\n");

/** What the harness generates: its own job, and nothing else of the consumer's. */
const GENERATED = [
  "name: CI",
  "",
  "on:",
  "  push:",
  "    branches: [main]",
  "",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: bun test",
  "",
].join("\n");

/** Line index of a top-level key, or -1. */
function lineOf(text: string, key: string): number {
  return text.split("\n").findIndex(l => l === `${key}:`);
}

describe("#482: a consumer's top-level key stays where the consumer put it", () => {
  test("SC-1667: a consumer-only top-level key keeps its position relative to jobs", () => {
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED);
    const concurrency = lineOf(merged, "concurrency");
    const permissions = lineOf(merged, "permissions");
    const jobs = lineOf(merged, "jobs");

    expect(concurrency, "concurrency is not in the merged file at all").toBeGreaterThan(-1);
    expect(permissions, "permissions is not in the merged file at all").toBeGreaterThan(-1);
    // Above `jobs:`, where the consumer wrote them. Asserting mere presence is
    // what passes today, and presence is exactly what the reader could not
    // see from the top of the file.
    expect(concurrency, "concurrency moved below jobs").toBeLessThan(jobs);
    expect(permissions, "permissions moved below jobs").toBeLessThan(jobs);
    expect(concurrency, "the two consumer keys swapped order").toBeLessThan(permissions);
  });

  test("SC-1668: a comment above a relocated key travels with it", () => {
    // The whole incident in one assertion. The comment is the artefact the
    // reader acted on, and a comment describing a block 460 lines away is a
    // false deletion signal.
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED).split("\n");
    const comment = merged.findIndex(l => l.startsWith("# When multiple pushes"));
    const concurrency = merged.findIndex(l => l === "concurrency:");

    expect(comment, "the consumer's comment is gone entirely").toBeGreaterThan(-1);
    expect(concurrency - comment, "the comment is no longer immediately above its key").toBe(1);
  });

  test("the merge still does its job — literally", () => {
    // The positive control for both cases above. A merge that returned the
    // consumer's file unchanged would satisfy every position assertion here
    // and would also be a complete failure.
    const merged = mergeManagedWorkflow(CONSUMER, GENERATED);
    expect(jobNames(merged).sort()).toEqual(["lint", "test"]);
    expect(merged).toContain("run: bun test");
    expect(merged).toContain("run: npm run lint");
  });

  test("each key keeps its own body, not just its name", () => {
    // Position is the subject, so what a positional fix most easily breaks is
    // the association between a key and the lines under it. The repo has no
    // YAML parser — `workflowJobNames` and friends read the shape by hand —
    // so this asserts the body sits directly under the key rather than
    // round-tripping through a library the project does not depend on.
    const lines = mergeManagedWorkflow(CONSUMER, GENERATED).split("\n");
    const at = (key: string) => lines.findIndex(l => l === `${key}:`);
    expect(lines[at("concurrency") + 1]).toBe("  group: ci-${{ github.ref }}");
    expect(lines[at("concurrency") + 2]).toBe("  cancel-in-progress: true");
    expect(lines[at("permissions") + 1]).toBe("  contents: read");
    expect(duplicateTopLevelKeys(lines.join("\n"))).toEqual([]);
  });

  test("a generated key the consumer does not have is still added", () => {
    // The other direction. Preserving the consumer's order must not mean
    // refusing to take anything new.
    const withNewKey = GENERATED.replace("jobs:", "env:\n  CI: true\n\njobs:");
    const merged = mergeManagedWorkflow(CONSUMER, withNewKey);
    expect(lineOf(merged, "env"), "the generated env: key was dropped").toBeGreaterThan(-1);
    expect(merged.split("\n")[lineOf(merged, "env") + 1]).toBe("  CI: true");
  });
});

describe("#482: movement that does happen is named", () => {
  test("SC-1669: topLevelKeyOrder reads the keys a file declares - in order", () => {
    expect(topLevelKeyOrder(CONSUMER)).toEqual(["name", "on", "concurrency", "permissions", "jobs"]);
    expect(topLevelKeyOrder(GENERATED)).toEqual(["name", "on", "jobs"]);
    // A reader that returned [] would make every movement report empty, and
    // the two assertions below could not tell that apart from no movement.
    expect(topLevelKeyOrder("").length).toBe(0);
  });

  test("SC-1670: a key that changes position is reported by name and by where it went", () => {
    const before = "a:\n  1\nb:\n  2\nc:\n  3\n";
    const after = "a:\n  1\nc:\n  3\nb:\n  2\n";
    const moved = movedTopLevelKeys(before, after);

    // Named, with both ends. "1 key moved" is not something a reader can act
    // on; "b: 3 -> 5" is.
    expect(moved.map(m => m.key)).toEqual(["b", "c"]);
    expect(moved.find(m => m.key === "b")).toEqual({ key: "b", from: 2, to: 4 });

    // The positive control, in the same test so it cannot drift away from it:
    // an unmoved file reports nothing.
    expect(movedTopLevelKeys(before, before)).toEqual([]);
  });

  test("a key that is only added or only removed is not reported as moved", () => {
    // Added and removed keys shift every index after them. Reporting those as
    // movement would make the signal useless on the common case — a scaffold
    // adding its own key — and useless is how a report gets ignored.
    expect(movedTopLevelKeys("a:\n  1\nb:\n  2\n", "a:\n  1\nnew:\n  0\nb:\n  2\n")).toEqual([]);
    expect(movedTopLevelKeys("a:\n  1\ngone:\n  0\nb:\n  2\n", "a:\n  1\nb:\n  2\n")).toEqual([]);
  });

  test("the live merge moves nothing, and movement would REFUSE rather than warn", () => {
    // Post-fix the merge's contract is that the consumer's order is the
    // consumer's, so movement is a bug in the merge rather than news. A
    // warning for that is a line in a log nobody reads; a refusal is the
    // asymmetry the incident argues for — an unenumerated edge case costs a
    // named refusal and `--force`, and not refusing costs a consumer a file
    // they will misread.
    const write = resolveManagedWrite(CONSUMER, GENERATED);
    expect(write.refusal).toBeNull();
    expect(write.movedKeys, `the merge moved: ${write.movedKeys.map(m => m.key).join(", ")}`).toEqual([]);
  });

  test("the repo's own workflows move nothing either, which is why refusing is safe", () => {
    // The fixture above is one shape this test chose. `release.yml` carries
    // `permissions:` between `on:` and `jobs:` — the exact arrangement that
    // used to relocate — so this is the arm that says the refusal will not
    // fire on real files.
    const stub = "name: X\n\non:\n  push:\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n";
    let checked = 0;
    for (const f of ["ci.yml", "gates.yml", "release.yml"]) {
      const real = readFileSync(join(REPO, ".github", "workflows", f), "utf-8");
      expect(movedTopLevelKeys(real, mergeManagedWorkflow(real, stub)), f).toEqual([]);
      checked++;
    }
    // Not vacuous: a loop over a directory that had been renamed would assert
    // nothing at all.
    expect(checked).toBe(3);
    expect(topLevelKeyOrder(readFileSync(join(REPO, ".github", "workflows", "release.yml"), "utf-8")))
      .toContain("permissions");
  });
});

describe("#482: a merged file with a duplicate top-level key refuses", () => {
  test("SC-1671: the merge refuses rather than writing a workflow that cannot parse", () => {
    // The backstop for the correction this issue describes. Somebody restores
    // a block they believe was deleted; the next re-scaffold is the first
    // thing that can tell them it was not.
    const duplicated = CONSUMER.replace(
      "jobs:",
      "concurrency:\n  group: restored-by-hand\n  cancel-in-progress: true\n\njobs:",
    );
    const write = resolveManagedWrite(duplicated, GENERATED);

    // A refusal in this type is `refusal !== null` with the existing content
    // handed back — there is no REFUSED verb; `writeManagedFile` throws on
    // it and the caller reports. Asserted on both halves, because a refusal
    // that still returns merged content is a warning wearing a refusal's name.
    expect(write.refusal, "the write was not refused").not.toBeNull();
    expect(write.refusal, "the refusal does not name the key").toContain("concurrency");
    expect(write.refusal, "the refusal does not say why it matters").toContain("would not run");
    expect(write.content).toBe(duplicated);
  });

  test("the refusal reaches the caller as a throw naming the file", () => {
    // The end-to-end half. A refusal nothing acts on is a field in a struct.
    const dir = mkdtempSync(join(tmpdir(), "rg-482-"));
    try {
      const file = join(dir, "ci.yml");
      const duplicated = CONSUMER.replace(
        "jobs:",
        "concurrency:\n  group: restored-by-hand\n  cancel-in-progress: true\n\njobs:",
      );
      writeFileSync(file, duplicated);
      expect(() => writeManagedFile(file, GENERATED, "ci.yml", [])).toThrow(/concurrency/);
      // ...and the file on disk is untouched, which is the point of refusing.
      expect(readFileSync(file, "utf-8")).toBe(duplicated);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file with no duplicate is written, so the refusal is not unconditional", () => {
    const write = resolveManagedWrite(CONSUMER, GENERATED);
    expect(write.refusal).toBeNull();
    expect(write.content).toContain("run: bun test");
  });

  test("the duplicate fixture really does declare the key twice, counted", () => {
    // Without this the refusal could be firing on something else entirely and
    // the case above would still pass. Counted in the fixture's own text, by
    // the detector AND independently by a raw line count — so a detector that
    // reported every file as duplicated would disagree with the count.
    const duplicated = CONSUMER.replace(
      "jobs:",
      "concurrency:\n  group: restored-by-hand\n  cancel-in-progress: true\n\njobs:",
    );
    expect(duplicated.split("\n").filter(l => l === "concurrency:").length).toBe(2);
    expect(duplicateTopLevelKeys(duplicated)).toEqual(["concurrency"]);
    // ...and the clean one is clean, so "reports a duplicate" is about the
    // duplicate. Measured on a real consumer at the time this was filed: the
    // `yaml` package rejects exactly this with "Map keys must be unique", and
    // GitHub Actions rejects the workflow. The repo has no YAML dependency,
    // so the property asserted here is the one that causes that — a top-level
    // key declared twice — rather than the library's message.
    expect(CONSUMER.split("\n").filter(l => l === "concurrency:").length).toBe(1);
    expect(duplicateTopLevelKeys(CONSUMER)).toEqual([]);
  });
});
