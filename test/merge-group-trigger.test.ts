/**
 * #765: every generated workflow whose job produces a REQUIRED status context
 * must handle `merge_group`, or a merge queue waits forever for a check that
 * never reports.
 *
 * ## Why this is not a style check
 *
 * A merge queue builds a temporary `gh-readonly-queue/<base>/...` ref and waits
 * for the required contexts to report against it. A workflow triggered only by
 * `push` and `pull_request` never runs on that ref. The queue does not fail —
 * it sits pending, with no annotation, no red check and nothing in any log. The
 * repository simply stops merging, and the nearest reading of that symptom is
 * "the queue is busy".
 *
 * That is the `UNMEASURED` shape of `.claude/rules/checks-must-be-able-to-fail.md`:
 * a state reached by something that never ran, indistinguishable from success.
 *
 * ## What this file pins, and why each case exists
 *
 * **Both bodies, not one.** `createCiWorkflows` builds `ciYml` from a ternary on
 * `shardCount` (`lib/scaffold/steps.ts`), so there are two complete CI workflow
 * bodies. The first draft of #765 added the trigger to the unsharded one only.
 * Five generator test files — 91 cases — passed before and after, because none
 * of them distinguishes the two bodies on their trigger block. The sharded body
 * is the one that matters most: the required `test` context is the aggregate
 * job, and that job exists only there.
 *
 * **No branches: filter.** `merge_group` takes no branch list, and the queue ref
 * is not the base branch, so a filter would make the trigger present and inert.
 * That is strictly worse than absent: the file then reads as handling the event
 * while the queue still hangs. The case asserts the key stands alone.
 *
 * **ai-review.yml is excluded deliberately, and the exclusion is asserted.**
 * `lib/scaffold/steps.ts` states the reason: the job reviews a pull request, and
 * a merge group has no pull request. Adding the trigger there would manufacture
 * the vacuous run that file's own header argues against. Asserted rather than
 * left to convention, so that "all workflows get merge_group" cannot be applied
 * as a blanket rule by a later reader — and so the omission reads as a decision
 * instead of an oversight.
 *
 * ## The cheapest wrong fix, named
 *
 * Hand-edit `.github/workflows/ci.yml` in this repository and stop. The symptom
 * disappears here, the two consumer repos stay broken, and the next re-scaffold
 * overwrites it without reporting anything, because the `test` job is
 * harness-owned.
 *
 * Does this file survive that fix? **Yes, non-vacuously.** Every case below runs
 * the generator into a temp directory and reads what it wrote. A hand edit to
 * this repo's checked-in file changes nothing any case here observes, so they
 * stay red until the generator itself emits the trigger.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCiWorkflows } from "../lib/scaffold/steps";

/** The event a merge queue fires. Declared once so there is one thing to mutate. */
const QUEUE_EVENT = "merge_group:";

/**
 * Generate into a throwaway tree and hand back the three workflow bodies.
 *
 * `shards` is written into the config rather than passed, because the ternary
 * that selects the CI body reads `shardCount(ci)` off the loaded config — a
 * parameter would be a second decider, and the point of this file is that the
 * two bodies really are reached.
 */
function generate(shards: number): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "rg-merge-group-"));
  try {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify(
        {
          project: "fixture",
          repo: "fixture/fixture",
          ci: { bunVersion: "1.3.14", shards },
          test: { command: "bun test" },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));

    createCiWorkflows(root, [], { force: true });

    const dir = join(root, ".github", "workflows");
    const out: Record<string, string> = {};
    for (const name of ["ci.yml", "gates.yml", "ai-review.yml"]) {
      try {
        out[name] = readFileSync(join(dir, name), "utf8");
      } catch {
        // Recorded as absent rather than skipped. A missing file and a file
        // without the trigger need opposite actions, and a `continue` here
        // would make them the same reading.
      }
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The `on:` block only — everything from `on:` to the next top-level key. */
function triggerBlock(yml: string): string {
  const at = yml.indexOf("\non:");
  if (at < 0) return "";
  const rest = yml.slice(at + 1);
  const end = rest.search(/\n(?=[A-Za-z])/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("#765: a merge queue cannot hang on a check that never reports", () => {
  // The control. A slice that failed to find its section is an empty string,
  // and an empty string contains nothing — indistinguishable from a clean
  // result. Every assertion below reads the slice, so the slice is proved
  // first. `.claude/rules/checks-must-be-able-to-fail.md`, "search the slice".
  test("the fixture really generates both CI bodies, and the slice is non-empty", () => {
    const sharded = generate(4);
    const plain = generate(1);

    expect(Object.keys(sharded).sort()).toEqual(["ai-review.yml", "ci.yml", "gates.yml"]);

    // The two bodies must actually differ, or this file is testing one thing
    // twice and the sharded/unsharded distinction is unmeasured.
    expect(sharded["ci.yml"]).not.toEqual(plain["ci.yml"]);
    expect(sharded["ci.yml"], "the sharded body must carry the aggregate job").toContain("test-shard:");
    expect(plain["ci.yml"], "the unsharded body must not").not.toContain("test-shard:");

    for (const yml of [sharded["ci.yml"], plain["ci.yml"], sharded["gates.yml"]]) {
      expect(triggerBlock(yml).length).toBeGreaterThan(10);
    }
  });

  for (const [label, shards] of [["sharded", 4], ["unsharded", 1]] as const) {
    test(`the ${label} CI body handles merge_group`, () => {
      const block = triggerBlock(generate(shards)["ci.yml"]);
      expect(block, `the ${label} ci.yml has no ${QUEUE_EVENT} — a merge queue would hang on its required check`)
        .toContain(QUEUE_EVENT);
    });
  }

  test("gates.yml handles merge_group", () => {
    expect(triggerBlock(generate(4)["gates.yml"])).toContain(QUEUE_EVENT);
  });

  test("the trigger carries no branches: filter, in either body", () => {
    for (const shards of [4, 1]) {
      for (const name of ["ci.yml", "gates.yml"]) {
        const block = triggerBlock(generate(shards)[name]);
        const lines = block.split("\n");
        const at = lines.findIndex((l) => l.trim() === QUEUE_EVENT);
        expect(at, `${name} (shards=${shards}) must declare ${QUEUE_EVENT} on its own line`).toBeGreaterThan(-1);

        // The next non-comment line must be another top-level event, not an
        // indented `branches:` belonging to merge_group. A filter here matches
        // nothing — the queue ref is gh-readonly-queue/..., never the base —
        // so the trigger would be present and inert, which reads as handled.
        const next = lines.slice(at + 1).find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
        expect(next ?? "", `${name} (shards=${shards}) attached a filter to ${QUEUE_EVENT}`)
          .not.toMatch(/^\s+branches:/);
      }
    }
  });

  // Not strictly about merge_group, but found by the security review of the
  // commit that added it and fixed in the same pass, so the evidence lives
  // beside the change that prompted it.
  //
  // `ci.yml` and `gates.yml` carried no `permissions:` block at all, so both
  // jobs ran with whatever the repository default is. Measured 2026-10-20 via
  // `gh api repos/<r>/actions/permissions/workflow`: pai-harness `read`,
  // agentgrit `read`, **asaCommandCenter `write`**. So on the one consumer that
  // runs credentialed third-party workflows, every generated CI job held a
  // GITHUB_TOKEN that could push, for no reason — both jobs only check out,
  // install and run tests.
  //
  // The cheapest wrong fix: set it on this repo's checked-in ci.yml and stop.
  // The two consumers keep the write token, and this case survives that fix
  // non-vacuously because it reads what the generator emits, not the file.
  test("every generated workflow declares least-privilege permissions", () => {
    for (const shards of [4, 1]) {
      const files = generate(shards);
      for (const name of ["ci.yml", "gates.yml", "ai-review.yml"]) {
        const yml = files[name];
        expect(yml, `${name} (shards=${shards}) was not generated`).toBeDefined();
        expect(yml, `${name} (shards=${shards}) has no permissions: block — it inherits the repository default, which is write on at least one consumer`)
          .toMatch(/\npermissions:\n(?:\s*#[^\n]*\n)*\s+contents: read\n/);
        // No job may quietly widen it back. A job-level permissions: block
        // overrides the top-level one, so a check that only reads the top is
        // satisfied by a file that grants write one level down.
        const jobsAt = yml.indexOf("\njobs:\n");
        expect(jobsAt, `${name} has no jobs: block`).toBeGreaterThan(-1);
        expect(yml.slice(jobsAt), `${name} (shards=${shards}) widens permissions at job level`)
          .not.toMatch(/\bcontents:\s*write\b/);
      }
    }
  });

  test("ai-review.yml does NOT handle merge_group, deliberately", () => {
    // Not an oversight. The job reviews a pull request and a merge group has
    // none, so the run's outcome would mean nothing — the generator says so in
    // a comment. Asserted so nobody applies "every workflow needs merge_group"
    // as a blanket rule, and so the omission is a recorded decision.
    const block = triggerBlock(generate(4)["ai-review.yml"]);
    expect(block.length).toBeGreaterThan(10);
    expect(block, "ai-review has no pull request to review in a merge group").not.toContain(QUEUE_EVENT);
  });
});
