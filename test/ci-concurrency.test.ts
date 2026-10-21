/**
 * #937 — neither CI template emitted a `concurrency:` block, so every consumer
 * wrote one, and the obvious thing to write cancels its own main-push runs.
 *
 * ## The events are not alike, and a flat `true` cannot tell them apart
 *
 *   - A pull request's ref is `refs/pull/<n>/merge`, unique to that PR. A new
 *     push to PR #5 can only cancel PR #5, and superseding it is the point:
 *     the older commit's result is about code nobody will merge.
 *
 *   - A push to main shares ONE ref with every other push to main. Two merges
 *     within a few minutes cancel the first, and the first is the only run
 *     that will ever build that commit. Measured on asaCommandCenter (#1839):
 *     five cancelled runs, every one a main push, and `test` is among the jobs
 *     a main push runs — so what was lost was a test result for a commit now
 *     in main's history, with no red check anywhere saying so.
 *
 *   - `merge_group` must resolve false too. A queue entry builds its own
 *     `gh-readonly-queue/...` ref and cancelling one mid-flight dequeues the
 *     PR behind it. The generator already emits `merge_group:` (#839), so this
 *     is reachable on any consumer that turns a queue on.
 *
 * ## Why the semantics are EVALUATED and not matched
 *
 * `expect(text).toContain("github.event_name == 'pull_request'")` passes over
 * `!=`, over `'push'`, and over the expression being pasted into `group:`
 * instead. The cases below run the expression against each event name, which
 * is the only form in which "false on a main push" is a claim about behaviour.
 * `evalBool` THROWS on an operand it does not model rather than returning
 * false, because a silent false here reads as "safe" and is how a rewritten
 * expression would pass this file.
 *
 * ## What was broken to prove these fail
 *
 * Baseline `bun test --isolate test/ci-concurrency.test.ts`: **17 pass / 0
 * fail**, read before the first mutation and re-measured at 17/0 after the
 * last. Every row applied to `lib/scaffold/steps.ts` by a script that ASSERTS
 * its anchor count before writing and refuses a no-op edit, then reverted from
 * a pristine `cp` and verified by sha256. `git checkout --` is never used: it
 * restores from the INDEX, so it would destroy the unstaged work around it.
 *
 * | #  | What I broke | Red |
 * |----|--------------|-----|
 * | M0 | `CI_CONCURRENCY` gone from both templates — **the tree as it stood** | **11 of 17** |
 * | M1 | `cancel-in-progress` dropped, `group` kept | **9 of 17** |
 * | M3 | `== 'pull_request'` flipped to `!= 'pull_request'` | **7 of 17** |
 * | W  | **the cheapest wrong fix**: `cancel-in-progress: true` | **5 of 17** |
 * | M2 | the block added to the SHARDED template only | **5 of 17** |
 * | M4 | `'pull_request'` changed to `'push'` | **5 of 17** |
 * | M5 | `group` made a constant, `ci-rungate` | **4 of 17** |
 *
 * **M0 is not a reconstruction of the defect, it IS the tree as it stood** —
 * `d514ff50` emits no concurrency key from either template.
 *
 * **Row W is the block asaCommandCenter actually had**, and it is the row that
 * matters. It satisfies "a concurrency block exists", "the group names
 * `github.ref`", both shard modes, and — correctly — the #917 case that says a
 * consumer keeps its own value. What it fails is the main-push case and the
 * merge-queue case, which is the whole content of #937.
 *
 * **W, M2 and M4 all score 5 on three different sets**, which is why they are
 * three rows. W leaves `pull_request` right and both main-push and merge_group
 * wrong; M4 leaves merge_group right and `pull_request` wrong; M2 leaves every
 * event right under `shards: 4` and unrendered under `shards: 1`. A single
 * count would have read as one mutation measured three times.
 *
 * **M2 is the row that makes the shared constant worth having.** Two separate
 * template literals is two places to fix, and a fix applied to one of them
 * reports clean over every unsharded consumer.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";

/** Render ci.yml the way a consumer gets it, for one shard setting. */
function generated(shards: number, seed?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-937-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ ci: { shards } }, null, 2),
    );
    const path = join(root, ".github", "workflows", "ci.yml");
    if (seed !== undefined) writeFileSync(path, seed);
    const actions: string[] = [];
    createCiWorkflows(root, actions);
    expect(actions.join("\n"), `the scaffold refused:\n${actions.join("\n")}`).not.toContain("REFUSED");
    return readFileSync(path, "utf-8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A top-level block, cut structurally: from its column-zero key to the next
 * column-zero key. Not a fixed line count — the comment above `permissions:`
 * is long and grows, and a window that happened to reach far enough today is
 * a window that stops reaching.
 */
function topLevelBlock(text: string, key: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) throw new Error(`no top-level ${key}: in the rendered workflow`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_-]+:/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** The value of one sub-key inside a top-level block, comments stripped. */
function subKey(text: string, key: string, sub: string): string {
  const hit = topLevelBlock(text, key).find((l) => new RegExp(`^\\s+${sub}:`).test(l));
  if (hit === undefined) throw new Error(`no ${key}.${sub} in the rendered workflow`);
  return hit.slice(hit.indexOf(":") + 1).trim();
}

interface Ctx { event_name: string; ref: string }

/**
 * Evaluate a GitHub expression down to a boolean.
 *
 * Deliberately narrow, and it THROWS rather than returning false on anything
 * it does not model. A `false` for an unrecognised expression is the reading
 * that makes "does not cancel a main push" pass for the wrong reason, so the
 * unmodelled case has to be louder than the modelled ones.
 */
function evalBool(value: string, ctx: Ctx): boolean {
  if (value === "true") return true;
  if (value === "false") return false;

  const expr = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(value);
  if (!expr) throw new Error(`not a boolean literal and not an expression: ${value}`);

  const cmp = /^github\.(event_name|ref)\s*(==|!=)\s*'([^']*)'$/.exec(expr[1]);
  if (!cmp) throw new Error(`unmodelled expression — refusing to guess: ${expr[1]}`);

  const left = cmp[1] === "event_name" ? ctx.event_name : ctx.ref;
  return cmp[2] === "==" ? left === cmp[3] : left !== cmp[3];
}

const PULL_REQUEST: Ctx = { event_name: "pull_request", ref: "refs/pull/5/merge" };
const OTHER_PR: Ctx = { event_name: "pull_request", ref: "refs/pull/6/merge" };
const PUSH_TO_MAIN: Ctx = { event_name: "push", ref: "refs/heads/main" };
const MERGE_GROUP: Ctx = {
  event_name: "merge_group",
  ref: "refs/heads/gh-readonly-queue/main/pr-5-abc123",
};

const SHARD_MODES: number[] = [1, 4];

/** `group:` with the expressions resolved, which is what GitHub compares. */
function groupFor(text: string, ctx: Ctx): string {
  return subKey(text, "concurrency", "group").replace(
    /\$\{\{\s*github\.(event_name|ref)\s*\}\}/g,
    (_m, f) => (f === "event_name" ? ctx.event_name : ctx.ref),
  );
}

function cancels(text: string, ctx: Ctx): boolean {
  return evalBool(subKey(text, "concurrency", "cancel-in-progress"), ctx);
}

describe("#937 — the render produced a real workflow", () => {
  // Vacuity floor. Every assertion below reads a block out of this text, and
  // an empty or truncated render would make most of them throw — but the two
  // #917 cases compare two renders to each other, and two empty strings agree.
  test.each(SHARD_MODES)("shards=%i renders a CI workflow with triggers and jobs", (shards: number) => {
    const text = generated(shards);
    expect(text).toContain("\nname: CI\n");
    expect(topLevelBlock(text, "on").join("\n")).toContain("pull_request:");
    expect(topLevelBlock(text, "jobs").join("\n")).toContain("runs-on:");
  });

  test("the two shard modes really do render different workflows", () => {
    // Otherwise `test.each` over both is one case run twice, and M2 — the
    // block added to one template only — would score 0.
    expect(generated(4)).not.toBe(generated(1));
    expect(generated(4)).toContain("test-shard");
    expect(generated(1)).not.toContain("test-shard");
  });
});

describe("#937 AC-1 — both templates emit a concurrency block", () => {
  test.each(SHARD_MODES)("shards=%i has concurrency.group and cancel-in-progress", (shards: number) => {
    const text = generated(shards);
    expect(subKey(text, "concurrency", "group")).toContain("github.ref");
    expect(subKey(text, "concurrency", "cancel-in-progress")).not.toBe("");
  });
});

describe("#937 AC-2 — the expression is evaluated, not matched", () => {
  test.each(SHARD_MODES)("shards=%i cancels a pull_request run", (shards: number) => {
    expect(cancels(generated(shards), PULL_REQUEST)).toBe(true);
  });

  test.each(SHARD_MODES)("shards=%i does NOT cancel a push to main", (shards: number) => {
    // The defect. A main push is the only run that will ever build that commit.
    expect(cancels(generated(shards), PUSH_TO_MAIN)).toBe(false);
  });

  test.each(SHARD_MODES)("shards=%i does NOT cancel a merge_group entry", (shards: number) => {
    expect(cancels(generated(shards), MERGE_GROUP)).toBe(false);
  });

  test("the evaluator can say true — a flat `true` cancels a main push", () => {
    // Negative control. Without it, "does not cancel a push" is satisfied by
    // an evaluator that answers false to everything.
    expect(evalBool("true", PUSH_TO_MAIN)).toBe(true);
    expect(evalBool("${{ github.event_name == 'pull_request' }}", PUSH_TO_MAIN)).toBe(false);
    expect(evalBool("${{ github.event_name == 'pull_request' }}", PULL_REQUEST)).toBe(true);
  });

  test("an expression the evaluator does not model throws rather than reading false", () => {
    // A silent false is the reading under which a rewritten expression passes
    // every case above for the wrong reason.
    expect(() => evalBool("${{ github.actor != 'dependabot[bot]' }}", PUSH_TO_MAIN))
      .toThrow(/unmodelled expression/);
    expect(() => evalBool("maybe", PUSH_TO_MAIN)).toThrow(/not a boolean literal/);
  });
});

describe("#937 — the group keeps unrelated runs apart", () => {
  test.each(SHARD_MODES)("shards=%i gives two PRs and main three distinct groups", (shards: number) => {
    const text = generated(shards);
    const groups = [PULL_REQUEST, OTHER_PR, PUSH_TO_MAIN, MERGE_GROUP].map((c) => groupFor(text, c));
    expect(new Set(groups).size).toBe(4);
    // And the control: a constant group would collide, which is what makes
    // the `github.ref` in it load-bearing rather than decorative.
    expect(groups.every((g) => g === groups[0])).toBe(false);
  });
});

describe("#937 AC-3 — #917 sub-key semantics decide who gets it", () => {
  /** An already-scaffolded consumer with its own, wrong, cancel-in-progress. */
  const CONSUMER_WITH_BLOCK = `# Managed by rungate — do not edit.
name: CI

on:
  push:
    branches:
      - "main"

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: "ubuntu-latest"
    steps:
      - run: ./deploy.sh
`;

  test("a consumer that already declares cancel-in-progress keeps its own value", () => {
    // #917 merges sub-key by sub-key and the consumer wins a key both sides
    // declare. That is deliberate — it is also why this change is a no-op on
    // asaCommandCenter, which fixed itself consumer-side first.
    const text = generated(4, CONSUMER_WITH_BLOCK);
    expect(subKey(text, "concurrency", "cancel-in-progress")).toBe("true");
    expect(text, "the consumer's own job was overwritten").toContain("./deploy.sh");
  });

  test("a consumer with no concurrency block at all gains the generated one", () => {
    // The arm that stops "the consumer always wins" from being the whole rule:
    // if it were, landing this in the generator would reach nobody.
    const text = generated(4, CONSUMER_WITH_BLOCK.replace(
      /\nconcurrency:\n(?:  .*\n)+/,
      "\n",
    ));
    expect(cancels(text, PUSH_TO_MAIN)).toBe(false);
    expect(cancels(text, PULL_REQUEST)).toBe(true);
    expect(text, "the consumer's own job was overwritten").toContain("./deploy.sh");
  });
});
