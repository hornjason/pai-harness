/**
 * Covers SC-2180..SC-2186 (HARNESS-STANDARD.md) — #728, CI suite sharding.
 *
 * The suite is the wall every branch pays. pai-harness CI averaged 376s of
 * which 313s was one `bun test` on one runner, and `strict` branch protection
 * makes every merge re-run it, so the wall is multiplied by every open PR.
 *
 * Two things this file is really guarding, neither of them the speed:
 *
 * 1. **The required status check is a JOB NAME.** A matrix renames `test` to
 *    `test (1)`, `test (2)`. A repo whose protection requires `test` then
 *    requires a context nothing ever reports, and GitHub holds every PR
 *    pending forever with no error saying why. That is a worse outcome than a
 *    slow suite, and it is invisible until somebody tries to merge.
 *
 * 2. **An unsharded consumer must get byte-identical output.** This change
 *    ships to every downstream project through the scaffold, and most of them
 *    have no shard config at all.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows, shardCount } from "../lib/scaffold/steps";
import { mergeManagedWorkflow } from "../lib/scaffold/managed-workflow";

describe("#728: shardCount reads one declaration", () => {
  test("SC-2180: absent config is one shard, not zero", () => {
    // The direction this is allowed to be wrong in. A matrix over an empty
    // list runs no tests and reports success, so 0 must be unreachable.
    expect(shardCount(undefined)).toBe(1);
    expect(shardCount(null)).toBe(1);
    expect(shardCount({})).toBe(1);
  });

  test("SC-2181: a declared count is honoured", () => {
    expect(shardCount({ shards: 4 })).toBe(4);
    expect(shardCount({ shards: 2 })).toBe(2);
  });

  test("SC-2182: malformed values fall back to 1 and never to 0", () => {
    for (const bad of [0, -3, 1.5, "4", true, [], {}, NaN, Infinity]) {
      expect(shardCount({ shards: bad })).toBe(1);
    }
  });

  test("SC-2183: the count is capped, so a typo cannot bill 10000 runners", () => {
    expect(shardCount({ shards: 10000 })).toBe(32);
    expect(shardCount({ shards: 32 })).toBe(32);
    expect(shardCount({ shards: 33 })).toBe(32);
  });
});

/**
 * The emitted workflow, read off disk.
 *
 * These drive the real `createCiWorkflows` against a planted project and
 * read the file it writes, because the property at stake is a string GitHub
 * matches literally against a branch-protection context. Asserting a
 * template literal in this file would be asserting my own copy of the
 * answer — `.claude/rules/checks-must-be-able-to-fail.md`, the artifact that
 * always agrees.
 */
describe("#728: the emitted CI workflow", () => {
  const emit = (shards?: number): string => {
    const root = mkdtempSync(join(tmpdir(), "rungate-shard-"));
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({
        slug: "shardfix",
        test: { command: "bun test", timeout: 300000 },
        ci: shards === undefined ? {} : { shards },
      }),
    );
    writeFileSync(join(root, ".bun-version"), "1.4.3\n");
    createCiWorkflows(root, [], { force: true });

    const out = join(root, ".github", "workflows", "ci.yml");
    if (!existsSync(out)) {
      throw new Error(
        `the generator wrote no ci.yml for shards=${shards}. UNMEASURED, not a pass.`,
      );
    }
    const yml = readFileSync(out, "utf8");
    rmSync(root, { recursive: true, force: true });
    return yml;
  };

  test("SC-2184: the generator is reachable and writes a workflow", () => {
    // A case that cannot find its subject reports no failures, which is
    // indistinguishable from a clean result. Establish presence first.
    const yml = emit(undefined);
    expect(yml.length).toBeGreaterThan(0);
    expect(yml).toContain("name: CI");
  });

  test("SC-2185: an unsharded consumer gets no matrix at all", () => {
    // Most downstream projects have never heard of this field. They must
    // get what they have today.
    const yml = emit(undefined);
    expect(yml).not.toContain("matrix");
    expect(yml).not.toContain("--shard");
    expect(yml).not.toContain("test-shard");
    expect(yml).toContain("\n  test:");
  });

  test("SC-2186: sharding keeps a job named exactly `test`", () => {
    // THE case. A matrix renames `test` to `test (1)`, and a repo whose
    // protection requires `test` then requires a context nothing reports —
    // every PR pending forever, no error anywhere saying why.
    const yml = emit(4);
    expect(yml).toContain("\n  test-shard:");
    expect(yml).toContain("\n  test:");
    expect(yml).toContain("needs: test-shard");
    expect(yml).toContain("--shard=${{ matrix.shard }}/4");
    expect(yml).toContain("shard: [1, 2, 3, 4]");
  });

  test("SC-2186b: the aggregate runs on a failed shard, and does not hide siblings", () => {
    const yml = emit(3);
    // Without always() a failed shard SKIPS the aggregate, and a skipped
    // required check is not a failed one.
    expect(yml).toContain("if: always()");
    // fail-fast would cancel the siblings and force a re-run per failure,
    // which is the opposite of the throughput this buys.
    expect(yml).toContain("fail-fast: false");
    // And the aggregate must actually refuse: a job that needs the shards
    // but never reads their result is green regardless.
    expect(yml).toContain("needs.test-shard.result");
    expect(yml).toContain("exit 1");
  });

  test("SC-2186c: a malformed shard count emits the unsharded workflow, never an empty matrix", () => {
    // The direction this is allowed to be wrong in. A matrix over an empty
    // list runs no tests and reports success.
    for (const bad of [0, -1, 1.5] as unknown as number[]) {
      const yml = emit(bad);
      expect(yml).not.toContain("matrix");
      expect(yml).toContain("\n  test:");
    }
  });
});

/**
 * SC-2187 — turning sharding OFF must remove the matrix, not orphan it.
 *
 * `mergeJobsSection` decides ownership by asking whether the generated file
 * contains a job of that name. For a conditionally emitted job that is the
 * wrong question: with sharding disabled, `test-shard` is absent from the
 * generated side and so reads as a consumer job to be preserved. The result
 * is a matrix that runs the full suite once per leg, forever, with nothing
 * in the diff saying where it came from.
 *
 * The cheapest wrong fix, named: delete the carried-forward branch entirely
 * so nothing is ever preserved. That makes this case pass and silently
 * destroys every consumer's own pipeline — which is what #216 exists to
 * prevent. The second case here is the control that survives it.
 */
describe("#728: disabling sharding removes the matrix", () => {
  test("SC-2187: a previously-sharded workflow loses test-shard when shards drop to 1", () => {
    const sharded = `name: CI
jobs:
  test-shard:
    runs-on: "ubuntu-latest"
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: bun test --shard=\${{ matrix.shard }}/4
  test:
    runs-on: "ubuntu-latest"
    needs: test-shard
    steps:
      - run: echo ok
`;
    const unsharded = `name: CI
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
    const merged = mergeManagedWorkflow(sharded, unsharded);
    expect(merged).not.toContain("test-shard");
    expect(merged).not.toContain("matrix");
    expect(merged).toContain("\n  test:");
  });

  test("SC-2187b: a genuine consumer job is still carried forward — the control", () => {
    // Without this, 'delete the preserve branch' passes the case above while
    // destroying every consumer pipeline. This is what refuses that fix.
    const withConsumerJob = `name: CI
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
  deploy-docs:
    runs-on: "ubuntu-latest"
    steps:
      - run: ./deploy.sh
`;
    const generated = `name: CI
jobs:
  test:
    runs-on: "ubuntu-latest"
    steps:
      - run: bun test
`;
    const merged = mergeManagedWorkflow(withConsumerJob, generated);
    expect(merged).toContain("deploy-docs");
    expect(merged).toContain("./deploy.sh");
  });
});
