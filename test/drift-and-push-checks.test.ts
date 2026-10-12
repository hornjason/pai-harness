import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectDrift } from "../scripts/detect-sc-drift";
import { unpushedViolations } from "../gates/workflow.test";

/**
 * Two checks that could not fire, found by an independent audit of the
 * backlog and fixed together because they are the same defect in different
 * subsystems.
 *
 * #158 — `detectDrift` read `specs/` without descending, so it could not see
 * any criterion in a subdirectory. That is a tenth flat collector, missed by
 * #225's sweep, and the one that mattered most: `scripts/sync-sc-status.ts`
 * scans recursively and then calls `detectDrift` as its gate before flipping
 * a checkbox to `[x]`. The flipper could see all 254 SCs under
 * `specs/bootstrap-data-flow/`; the brake could see none of them. A
 * subdirectory SC could never be reported stale and so flipped ungated.
 *
 * #174 — `code-pushed: no unpushed commits` returned early when
 * `git rev-list --count @{upstream}..HEAD` failed. A branch with no upstream
 * has never been pushed, which is the worst case that check exists to catch,
 * and it was the single input that passed unconditionally.
 *
 * Both are "a check that passed because of what it never looked at" — one by
 * narrowing its view of the input, one by reading an error as an all-clear.
 */

const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rg-drift-"));
  scratch.push(d);
  return d;
}
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("#158: spec drift detection descends into subdirectories", () => {
  /**
   * A spec whose criterion names a file that does not exist is STALE. The
   * question each case asks is only whether the detector looked.
   */
  function plantSpec(root: string, rel: string): void {
    const full = join(root, "specs", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(
      full,
      ["---", "doc-type: spec", "testable: true", "---", "",
       "- [x] SC-9201: file-that-does-not-exist-4b2a.ts exists", ""].join("\n"),
    );
  }

  test("a criterion in a subdirectory spec is examined at all", () => {
    const root = tmp();
    mkdirSync(join(root, "specs", "nested"), { recursive: true });
    plantSpec(root, "nested/success-criteria.md");

    const result = detectDrift(join(root, "specs"), root);
    expect(
      result.checked,
      "no criterion was examined — the collector did not descend, which is #158",
    ).toBeGreaterThan(0);
  });

  test("a top-level spec is still examined, so the fix did not trade one for the other", () => {
    // The converse. A collector rewritten to only walk subdirectories would
    // satisfy the case above and break every spec that is not in one.
    const root = tmp();
    mkdirSync(join(root, "specs"), { recursive: true });
    plantSpec(root, "top.md");

    expect(detectDrift(join(root, "specs"), root).checked).toBeGreaterThan(0);
  });

  test("both are examined in one pass, which is the actual requirement", () => {
    const root = tmp();
    mkdirSync(join(root, "specs", "nested"), { recursive: true });
    plantSpec(root, "top.md");
    plantSpec(root, "nested/success-criteria.md");

    expect(
      detectDrift(join(root, "specs"), root).checked,
      "one of the two specs was invisible to the detector",
    ).toBe(2);
  });

  test("the real repo's subdirectory specs are reachable by the detector", () => {
    // Pointed at the tree rather than a fixture, because the fixture proves
    // the collector descends and this proves it descends into the directory
    // the defect was actually about.
    const ROOT = join(import.meta.dir, "..");
    const result = detectDrift(join(ROOT, "specs"), ROOT);
    expect(
      result.checked,
      "far fewer criteria examined than specs/ declares — the detector is not seeing the subdirectory specs",
    ).toBeGreaterThan(400);
  });
});

describe("#174: a branch with no upstream fails the unpushed-commits check", () => {
  const OK = (output: string) => ({ ok: true, output });
  const FAILED = { ok: false, output: "" };

  test("no upstream is a refusal, not an exemption", () => {
    // The defect verbatim. This input is the one the old `if (!result.ok)
    // return` passed unconditionally.
    const v = unpushedViolations(FAILED, FAILED);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("no upstream");
  });

  test("an upstream that exists but an unreadable count is UNMEASURED, not clean", () => {
    // The second fail-open, which a fix written only against the no-upstream
    // case would leave behind: git failing for a reason nobody identified
    // says nothing about whether work is unpushed.
    const v = unpushedViolations(FAILED, OK("origin/feature"));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("UNMEASURED");
  });

  test("commits ahead of upstream are reported with the count", () => {
    const v = unpushedViolations(OK("3"), OK("origin/feature"));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("3 commits ahead");
  });

  test("a branch level with its upstream passes", () => {
    // The converse, and the reason the three cases above are not satisfied by
    // a function that refuses everything.
    expect(unpushedViolations(OK("0"), OK("origin/feature"))).toEqual([]);
  });

  test("the four readings are distinguishable, not one message reused", () => {
    // Three refusals that read the same would make the check's output useless
    // for diagnosis, and would hide a fix that collapsed two branches into one.
    const messages = [
      unpushedViolations(FAILED, FAILED)[0],
      unpushedViolations(FAILED, OK("origin/x"))[0],
      unpushedViolations(OK("3"), OK("origin/x"))[0],
    ];
    expect(new Set(messages).size, "two refusals are indistinguishable").toBe(3);
  });
});
