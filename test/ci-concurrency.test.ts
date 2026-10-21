/**
 * #937 / #952 — the CI templates emitted no `concurrency:` key, and the first
 * fix for it did not work.
 *
 * ## What a concurrency group actually decides
 *
 * A run is cancelled only by another run that lands in the SAME group. So
 * there are two ways to stop main-push runs being cancelled: make the flag say
 * no, or make sure a main run is never in a group with anything else. #937
 * took the first and it failed in production. This takes the second.
 *
 *   - A **push** keys on `github.sha`, unique per commit. Every main run is
 *     alone in its group and there is no second occupant to cancel it. That
 *     matters because a main run is the only run that will ever build that
 *     commit: losing it leaves a gap in main's history with no red check
 *     anywhere saying so.
 *
 *   - **Everything else** keys on `github.ref` — unique per pull request
 *     (`refs/pull/<n>/merge`) and per queue entry (`gh-readonly-queue/...`),
 *     but STABLE across pushes to the same pull request. That stability is
 *     load-bearing: it is what lets a PR supersede itself, the one case where
 *     cancelling is the right answer.
 *
 * ## Why not the #937 form
 *
 * `group: ci-${{ github.ref }}` with
 * `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` reads
 * correctly and does not work. Measured on this repository's own `main` after
 * #942 merged at 16:45:10 — three push runs cancelled inside eight minutes
 * with that expression in the file, one of them one second after the next run
 * was created, and every cancelled run had **job count 0**, which is
 * cancellation at queue time. Ruled out at the time: the file (all five
 * commits carried the expression), a second `concurrency:` key (there was
 * exactly one), and the event (`event=push`).
 *
 * The MECHANISM is now named, and it is not the flag. GitHub's workflow-syntax
 * reference: *"any existing `pending` job or workflow in the same concurrency
 * group will be canceled"* — the default, independent of `cancel-in-progress`,
 * which governs only the RUNNING job. The pending slot is governed by `queue`,
 * default `single`: at most one pending per group. So a group holds one
 * running plus one pending and a THIRD arrival evicts the pending one, which
 * is why every cancelled run had job count 0 and why every clean window on
 * that day had fewer than three in the group.
 *
 * Two hypotheses are dead and should not be resurrected. (1) The expression
 * coercing to a truthy `"false"` — disproved by a run that survived 4m22s
 * through a newer arrival. (2) "a transition effect" — disproved because its
 * counter-example had only TWO runs in the group, the case the model predicts
 * is clean.
 *
 * `queue: max` is the other documented lever and **cannot be combined with
 * `cancel-in-progress: true`** (validation error), which pull requests need.
 * So a per-commit group is the form that serves both events.
 *
 * ## The lesson this file is written around
 *
 * #937's suite had 17 passing cases and 7 mutation rows, and every one of them
 * passed on a fix that did not work. They modelled GitHub's documented
 * expression semantics and then asserted against the model. No local test can
 * falsify an assumption about the runner.
 *
 * So the property asserted here is deliberately one that does not depend on
 * runner semantics: **two pushes to main must produce two different group
 * strings.** If that holds, cancellation between them is impossible whatever
 * `cancel-in-progress` coerces to. It is still a model — but a model of string
 * construction, which happens in the generator rather than on the runner.
 *
 * The live control remains outstanding and is named in the PR, and it is
 * THREE main pushes inside one run's duration, all reaching a conclusion —
 * not two. The group holds one running plus one pending, so two in a group is
 * the case the model predicts is clean; reading a clean two-run window as
 * evidence is the mistake that got #952 retracted once and reopened.
 *
 * ## What was broken to prove these fail
 *
 * **Re-measured in full after rebasing onto `41d287c5`**, not carried over —
 * and the rebase is exactly why. #940/#945 added a `workflow_dispatch` trigger
 * to both templates while this branch was open, so what this file READS moved
 * under a file that stayed green. A row measured on a tree nobody can check
 * out is a claim rather than a count
 * (`.claude/rules/parallel-sessions.md`). The earlier table over 17 cases is
 * superseded by this one; nothing from it is carried.
 *
 * Baseline `bun test --isolate test/ci-concurrency.test.ts`: **23 pass /
 * 0 fail**, read before the first row and re-measured after the last. Each row
 * applied by a script that asserts its anchor count before writing and refuses
 * a no-op edit, then reverted from a pristine `cp` and verified by sha256;
 * `lib/scaffold/steps.ts` confirmed byte-identical afterwards.
 *
 * | #  | What I broke | Red | The cases it reddens |
 * |----|--------------|-----|---|
 * | M0 | `CI_CONCURRENCY` gone from both templates — **the tree before #937** | **16 of 23** | every case that reads a group, both AC-1 cases, the cancel-capable floor, and the #917 gains-the-block case |
 * | M4 | the ternary keyed on `'pull_request'` instead of `'push'` — fully inverted | **13 of 23** | both arms at once: main collapses AND the PR gets a per-sha group |
 * | W  | **the fix that shipped and failed**: #937's ref group + event flag | **9 of 23** | two-pushes, three-pushes, unrelated-runs, the dispatch case, #917 |
 * | M2 | the group always `github.ref` | **9 of 23** | the same nine as W |
 * | M3 | the block added to the SHARDED template only | **8 of 23** | every `shards=1` case, AC-1 at `shards=1`, the cancel-capable floor |
 * | M1 | the group always `github.sha` | **7 of 23** | **both halves of the negative control** — `a pull request STILL supersedes itself`, `keeps two pushes to the SAME pull request in ONE group`, the dispatch case, #917 |
 * | M5 | the alternative ternary `pull_request && ref \|\| sha` with `cancel-in-progress: ${{ event == 'pull_request' }}` | **2 of 23** | only `an on-demand re-run does not land in a push's group` |
 *
 * **Row W is not a hypothetical.** It is the exact block that was on `main`
 * and that production falsified, so it is the one row with an outside
 * measurement behind it as well as a count.
 *
 * **W and M2 are red on exactly the same nine cases, and that is the finding,
 * not a redundancy.** W is M2 plus the flag change, and nothing in this file
 * can tell them apart: the difference between `cancel-in-progress: true` and
 * `${{ github.event_name == 'pull_request' }}` is decided on the runner, and
 * the runner is the thing that cannot be modelled here. Keeping both rows
 * records that the flag is NOT what this fix relies on. If W had scored lower
 * than M2, this file would be claiming knowledge about the flag it does not
 * have.
 *
 * **M1 is the row the negative control exists for.** Keying everything on
 * `github.sha` passes every main-push assertion in this file — two groups,
 * three groups, unrelated runs apart — and silently ends pull-request
 * supersession. Without `a pull request STILL supersedes itself` the battery
 * could not tell the right fix from that one. M1 and M2 are the two halves of
 * the ternary and they fail disjoint sets of the group cases.
 *
 * **Row M5 is the one that decided the shape, and it is 2 rather than 0.**
 * `pull_request && github.ref || github.sha` with the event-valued flag was
 * the other candidate on #952, and it is equivalent to the shipped form on
 * every `push`, `pull_request` and `merge_group` input. It differs on
 * `workflow_dispatch`, which #945 added to these templates today: it keys a
 * manual re-run on `github.sha`, which is the SAME group as that commit's push
 * run, with `cancel-in-progress` resolving false — so an on-demand re-run of a
 * commit whose push run is still going sits PENDING rather than running, which
 * is most of what #945 shipped the trigger for. (The stronger claim, that a
 * further arrival then evicts it, follows from the same eviction model but has
 * no measurement here and is not asserted.) The shipped form keys a dispatch
 * on `github.ref`, so it shares a group with no push at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";

/** Render ci.yml the way a consumer gets it, for one shard setting. */
function generated(shards: number, seed?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-952-"));
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
 * is long and grows, and a window that happens to reach far enough today is a
 * window that stops reaching.
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

/** The value of one sub-key inside a top-level block. */
function subKey(text: string, key: string, sub: string): string {
  const hit = topLevelBlock(text, key).find((l) => new RegExp(`^\\s+${sub}:`).test(l));
  if (hit === undefined) throw new Error(`no ${key}.${sub} in the rendered workflow`);
  return hit.slice(hit.indexOf(":") + 1).trim();
}

interface Ctx { event_name: string; ref: string; sha: string }

function field(name: string, ctx: Ctx): string {
  if (name === "event_name") return ctx.event_name;
  if (name === "ref") return ctx.ref;
  if (name === "sha") return ctx.sha;
  throw new Error(`unmodelled github context field — refusing to guess: github.${name}`);
}

/**
 * Resolve one `${{ ... }}` expression to the string GitHub would substitute.
 *
 * Narrow on purpose, and it THROWS on anything it does not model rather than
 * leaving the text unchanged. An unrecognised expression left as a literal is
 * the same string in every context — including two pushes to main — so the
 * failure mode of guessing is a file that passes on a defect.
 */
function resolveExpr(expr: string, ctx: Ctx): string {
  const ternary = /^github\.(\w+)\s*==\s*'([^']*)'\s*&&\s*github\.(\w+)\s*\|\|\s*github\.(\w+)$/.exec(expr);
  if (ternary) {
    return field(ternary[1], ctx) === ternary[2] ? field(ternary[3], ctx) : field(ternary[4], ctx);
  }
  const plain = /^github\.(\w+)$/.exec(expr);
  if (plain) return field(plain[1], ctx);
  throw new Error(`unmodelled expression — refusing to guess: ${expr}`);
}

/** A boolean-valued key, with the same refusal to guess. */
function evalBool(value: string, ctx: Ctx): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(value);
  if (!m) throw new Error(`not a boolean literal and not an expression: ${value}`);
  const cmp = /^github\.(\w+)\s*(==|!=)\s*'([^']*)'$/.exec(m[1]);
  if (!cmp) throw new Error(`unmodelled expression — refusing to guess: ${m[1]}`);
  return cmp[2] === "==" ? field(cmp[1], ctx) === cmp[3] : field(cmp[1], ctx) !== cmp[3];
}

const MAIN_PUSH_A: Ctx = { event_name: "push", ref: "refs/heads/main", sha: "aaaa1111" };
const MAIN_PUSH_B: Ctx = { event_name: "push", ref: "refs/heads/main", sha: "bbbb2222" };
const PR5_FIRST: Ctx = { event_name: "pull_request", ref: "refs/pull/5/merge", sha: "cccc3333" };
const PR5_SECOND: Ctx = { event_name: "pull_request", ref: "refs/pull/5/merge", sha: "dddd4444" };
const PR6: Ctx = { event_name: "pull_request", ref: "refs/pull/6/merge", sha: "eeee5555" };
const QUEUE_1: Ctx = {
  event_name: "merge_group",
  ref: "refs/heads/gh-readonly-queue/main/pr-5-aaaa",
  sha: "ffff6666",
};
const QUEUE_2: Ctx = {
  event_name: "merge_group",
  ref: "refs/heads/gh-readonly-queue/main/pr-6-bbbb",
  sha: "99997777",
};
const MAIN_PUSH_C: Ctx = { event_name: "push", ref: "refs/heads/main", sha: "cccc9999" };
// #940/#945 added `workflow_dispatch` to both templates AFTER this file was
// first written. A trigger the battery has no context for is a trigger whose
// group nothing here decides, so it is modelled rather than assumed: a manual
// re-run names a ref and a sha like any other event, and which of the two the
// ternary picks is the whole question.
const DISPATCH_MAIN: Ctx = { event_name: "workflow_dispatch", ref: "refs/heads/main", sha: "aaaa1111" };
const DISPATCH_MAIN_AGAIN: Ctx = { event_name: "workflow_dispatch", ref: "refs/heads/main", sha: "bbbb2222" };

const SHARD_MODES: number[] = [1, 4];

/** The `group:` value with every expression resolved — what GitHub compares. */
function groupFor(text: string, ctx: Ctx): string {
  return subKey(text, "concurrency", "group").replace(
    /\$\{\{\s*(.+?)\s*\}\}/g,
    (_m: string, expr: string) => resolveExpr(expr, ctx),
  );
}

function cancels(text: string, ctx: Ctx): boolean {
  return evalBool(subKey(text, "concurrency", "cancel-in-progress"), ctx);
}

describe("#952 — the render produced a real workflow", () => {
  // Vacuity floor: most cases below read a block out of this text and would
  // throw on an empty render, but the two #917 cases compare two renders to
  // each other and two empty strings agree.
  test.each(SHARD_MODES)("shards=%i renders a CI workflow with triggers and jobs", (shards: number) => {
    const text = generated(shards);
    expect(text).toContain("\nname: CI\n");
    expect(topLevelBlock(text, "on").join("\n")).toContain("pull_request:");
    expect(topLevelBlock(text, "jobs").join("\n")).toContain("runs-on:");
  });

  test("the two shard modes really do render different workflows", () => {
    // Otherwise `test.each` over both is one case run twice and M3 — the block
    // added to one template only — would score 0.
    expect(generated(4)).not.toBe(generated(1));
    expect(generated(4)).toContain("test-shard");
    expect(generated(1)).not.toContain("test-shard");
  });
});

describe("#937 AC-1 — both templates emit a concurrency block", () => {
  test.each(SHARD_MODES)("shards=%i has concurrency.group and cancel-in-progress", (shards: number) => {
    const text = generated(shards);
    expect(subKey(text, "concurrency", "group")).not.toBe("");
    expect(subKey(text, "concurrency", "cancel-in-progress")).not.toBe("");
  });
});

describe("#952 — a main push is alone in its group, so nothing can cancel it", () => {
  test.each(SHARD_MODES)("shards=%i puts two pushes to main in DIFFERENT groups", (shards: number) => {
    // The whole fix. Cancellation between two runs requires one group; two
    // groups makes it impossible regardless of what cancel-in-progress
    // coerces to on the runner, which is the part #937 got wrong.
    const text = generated(shards);
    expect(groupFor(text, MAIN_PUSH_A)).not.toBe(groupFor(text, MAIN_PUSH_B));
  });

  test.each(SHARD_MODES)("shards=%i keeps two pushes to the SAME pull request in ONE group", (shards: number) => {
    // The arm that refuses "key everything on github.sha". That would make
    // main safe and silently end pull-request supersession, so every
    // abandoned commit on a PR would run to completion on the self-hosted
    // pool. Same ref, different sha: the input on which the two halves of the
    // ternary disagree.
    const text = generated(shards);
    expect(groupFor(text, PR5_FIRST)).toBe(groupFor(text, PR5_SECOND));
  });

  test.each(SHARD_MODES)("shards=%i puts THREE main pushes in three groups", (shards: number) => {
    // Two is not the acceptance condition and never was. The group holds one
    // running plus one pending; a THIRD arrival is what evicts the pending
    // one, which is why twenty-five minutes of two-run windows read clean and
    // why the consumer repo looked fixed. The local analogue of the live
    // control is three distinct shas producing three distinct groups.
    const text = generated(shards);
    const groups = [MAIN_PUSH_A, MAIN_PUSH_B, MAIN_PUSH_C].map((c) => groupFor(text, c));
    expect(new Set(groups).size, `three main pushes collapsed into ${new Set(groups).size} group(s)`).toBe(3);
  });

  test.each(SHARD_MODES)("shards=%i — a pull request STILL supersedes itself", (shards: number) => {
    // THE NEGATIVE CONTROL, and it is the case that separates this fix from
    // the wrong one. Every "three main pushes, none cancelled" assertion above
    // passes on a group keyed UNCONDITIONALLY on `github.sha` — and that fix
    // silently ends pull-request supersession, so every abandoned commit on a
    // PR runs to completion. Without this case the battery cannot tell the two
    // apart.
    //
    // Asserted as a CONJUNCTION rather than as two cases in different blocks,
    // because supersession needs both halves and either half alone is green
    // under a mutation of the other. Same group is what makes them collide;
    // cancel-in-progress is what makes the collision supersede rather than
    // queue.
    const text = generated(shards);
    expect(groupFor(text, PR5_FIRST), "two pushes to one PR no longer share a group").toBe(
      groupFor(text, PR5_SECOND),
    );
    expect(cancels(text, PR5_SECOND), "the newer PR run would queue behind the older, not supersede it").toBe(
      true,
    );
  });

  test.each(SHARD_MODES)("shards=%i — an on-demand re-run does not land in a push's group", (shards: number) => {
    // #940/#945 added `workflow_dispatch` AFTER the group was chosen, and a
    // trigger nothing here models is a trigger whose group nothing here
    // decides. Both contexts carry a sha that a main push also carries, which
    // is the input the two candidate ternaries disagree on:
    //
    //   event_name == 'push'         → dispatch keys on REF, push keys on SHA:
    //                                  different groups, so a manual re-run
    //                                  can neither evict nor be evicted by the
    //                                  push run for that commit.
    //   event_name == 'pull_request' → dispatch keys on SHA, the SAME group as
    //                                  that commit's push run, with
    //                                  cancel-in-progress false: the dispatch
    //                                  sits PENDING, and a third arrival
    //                                  evicts it. That is #952 reinstated on
    //                                  the path #945 just shipped.
    const text = generated(shards);
    expect(groupFor(text, DISPATCH_MAIN), "a manual re-run shares a group with the push it re-runs").not.toBe(
      groupFor(text, MAIN_PUSH_A),
    );
    // And the dispatch path is not itself sha-keyed, or the row above would be
    // satisfied by a group that is unique per run and decides nothing.
    expect(groupFor(text, DISPATCH_MAIN)).toBe(groupFor(text, DISPATCH_MAIN_AGAIN));
  });

  test.each(SHARD_MODES)("shards=%i keeps unrelated runs apart", (shards: number) => {
    const text = generated(shards);
    const groups = [MAIN_PUSH_A, MAIN_PUSH_B, PR5_FIRST, PR6, QUEUE_1, QUEUE_2].map((c) => groupFor(text, c));
    expect(new Set(groups).size).toBe(6);
  });

  test("the group really is cancel-capable, or none of the above is a claim", () => {
    // Vacuity floor for the three cases above: with cancel-in-progress false,
    // "they are in different groups" would be protecting nothing and the
    // group could be anything at all.
    for (const shards of SHARD_MODES) {
      expect(cancels(generated(shards), PR5_FIRST)).toBe(true);
    }
  });
});

describe("#952 — the resolver refuses to guess", () => {
  test("an unmodelled expression throws rather than resolving to itself", () => {
    expect(() => resolveExpr("github.run_id", MAIN_PUSH_A)).toThrow(/unmodelled github context field/);
    expect(() => resolveExpr("hashFiles('**')", MAIN_PUSH_A)).toThrow(/unmodelled expression/);
  });

  test("the ternary resolves both ways, asserted on the resolver itself", () => {
    const e = "github.event_name == 'push' && github.sha || github.ref";
    expect(resolveExpr(e, MAIN_PUSH_A)).toBe("aaaa1111");
    expect(resolveExpr(e, PR5_FIRST)).toBe("refs/pull/5/merge");
  });

  test("evalBool can say false, so `cancel-in-progress: true` is a measured true", () => {
    expect(evalBool("false", MAIN_PUSH_A)).toBe(false);
    expect(evalBool("${{ github.event_name == 'pull_request' }}", MAIN_PUSH_A)).toBe(false);
    expect(() => evalBool("maybe", MAIN_PUSH_A)).toThrow(/not a boolean literal/);
  });
});

describe("#937 AC-3 — #917 sub-key semantics decide who gets it", () => {
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

  test("a consumer that already declares the sub-keys keeps its own values", () => {
    // #917 merges sub-key by sub-key and the consumer wins a key both sides
    // declare. Worth pinning rather than assuming: it means a consumer already
    // carrying the broken arrangement is NOT repaired by a re-scaffold, which
    // is a real limitation of landing this upstream and is stated in the PR.
    const text = generated(4, CONSUMER_WITH_BLOCK);
    expect(subKey(text, "concurrency", "group")).toBe("ci-${{ github.ref }}");
    expect(groupFor(text, MAIN_PUSH_A)).toBe(groupFor(text, MAIN_PUSH_B));
    expect(text, "the consumer's own job was overwritten").toContain("./deploy.sh");
  });

  test("a consumer with no concurrency block at all gains the generated one", () => {
    // The arm that stops "the consumer always wins" from being the whole rule:
    // if it were, landing this in the generator would reach nobody.
    const text = generated(4, CONSUMER_WITH_BLOCK.replace(/\nconcurrency:\n(?:  .*\n)+/, "\n"));
    expect(groupFor(text, MAIN_PUSH_A)).not.toBe(groupFor(text, MAIN_PUSH_B));
    expect(groupFor(text, PR5_FIRST)).toBe(groupFor(text, PR5_SECOND));
    expect(text, "the consumer's own job was overwritten").toContain("./deploy.sh");
  });
});
