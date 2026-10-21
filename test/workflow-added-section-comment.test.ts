/**
 * #941 — a top-level section the merge ADDS arrived without the comment block
 * introducing it.
 *
 * A fresh consumer gets the generated file verbatim, comments and all. An
 * already-scaffolded consumer went through `mergeManagedWorkflow`, which
 * appends a generated key the consumer lacks — and a comment above a top-level
 * key lived in the SECTION ABOVE IT, so the key travelled and its reasoning did
 * not. Measured on this repo's own `ci.yml`: `UPDATED (+4 lines)`, those four
 * being a blank, `concurrency:` and its two sub-keys, with twelve lines of
 * comment dropped.
 *
 * This is #482's defect class through a different door — #482 was a key MOVING
 * away from its comment, this is a key ARRIVING without one — and it is not
 * cosmetic. The comment is the only thing in a consumer's file that says why
 * `cancel-in-progress` is an expression rather than `true`, in a file whose
 * header says "do not edit". Simplifying it to `true` is what made one
 * consumer cancel its own main-branch CI on every merge.
 *
 * ## What these cases assert, and why not the obvious thing
 *
 * The obvious case asserts the comment's TEXT is present after a merge. It
 * passes vacuously the moment anyone rewords the template. What is asserted
 * here is the structural invariant: for every top-level key the merge ADDS,
 * the contiguous comment block above it in the output is the same block that
 * was above it in the generated source. Both sides are read off the real
 * render, so a reword moves both and the case still bites on a dropped block.
 *
 * The comment block is read here by a reader of this file's own — a walk
 * upward from the key line over column-zero `#` lines. Calling the production
 * splitter would make the case agree with the code under test by construction,
 * which is `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Re-insert the generated comment above the key whenever the generated text
 * has one.** The reported symptom disappears and two things break: a consumer
 * who wrote their OWN commentary above that key has it joined by the
 * generator's, and every subsequent upgrade appends another copy — the key is
 * present by then, so nothing ever strips the previous one. AC-2's two arms
 * and AC-4 are what refuse it: the consumer's block must come back unchanged,
 * and a second scaffold must be a byte-for-byte no-op.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  MANAGED_MARKER_PREFIX,
  mergeManagedWorkflow,
  planManagedWrite,
  topLevelKeyOrder,
} from "../lib/scaffold/managed-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";

// ── reading the fixture off the real generator ─────────────────────────────

/**
 * The workflow the generator writes into an empty repository — the FRESH path,
 * which has never had this defect, and the source every expectation below is
 * derived from. Nothing here spells a line of the template: a reworded comment
 * moves both sides of every comparison.
 */
function freshRender(): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-941-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    createCiWorkflows(root, []);
    return readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8")
      .split("\n")
      .filter(l => !l.startsWith(MANAGED_MARKER_PREFIX))
      .join("\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The line index of a top-level key, and the start of the block above it. */
function blockBounds(text: string, key: string): { from: number; at: number } {
  const lines = text.split("\n");
  const at = lines.findIndex(l => l === `${key}:` || l.startsWith(`${key}: `));
  if (at < 0) throw new Error(`no top-level \`${key}:\` in the workflow`);
  let from = at;
  while (from > 0 && lines[from - 1].startsWith("#")) from--;
  // A comment run reaching line zero is the managed banner. It introduces the
  // file, not the first key, and the merge replaces it wholesale.
  return { from: from === 0 ? at : from, at };
}

/**
 * The contiguous comment block introducing a top-level key: the run of
 * column-zero `#` lines immediately above it, with no blank between.
 *
 * Deliberately not `splitTopLevel`. A case that reads its subject with the
 * subject's own reader cannot witness a change to that reader.
 */
function commentBlockAbove(text: string, key: string): string[] {
  const { from, at } = blockBounds(text, key);
  return text.split("\n").slice(from, at);
}

/** The same text with a key's introducing comment block removed. */
function withoutCommentBlockAbove(text: string, key: string): string {
  const { from, at } = blockBounds(text, key);
  const lines = text.split("\n");
  return [...lines.slice(0, from), ...lines.slice(at)].join("\n");
}

/**
 * The file an older generator wrote: the named top-level sections gone, and
 * the comment blocks introducing them gone with them.
 */
function withoutSections(text: string, keys: string[]): string {
  const lines = text.split("\n");
  const isTop = (l: string) => /^[A-Za-z_][A-Za-z0-9_.\-]*:(\s|$)/.test(l);
  const out: string[] = [];
  let dropping = false;
  let held: string[] = [];
  for (const line of lines) {
    if (isTop(line)) {
      const key = line.replace(/:.*$/, "");
      dropping = keys.includes(key);
      if (!dropping) out.push(...held, line);
      held = [];
      continue;
    }
    if (dropping) continue;
    // A column-zero comment run may introduce the key below it, so it is held
    // until that key says whether it is being dropped.
    if (line.startsWith("#")) held.push(line);
    else {
      out.push(...held, line);
      held = [];
    }
  }
  out.push(...held);
  return out.join("\n");
}

/** Top-level keys in `after` that `before` does not declare. */
function addedKeys(before: string, after: string): string[] {
  const had = new Set(topLevelKeyOrder(before));
  return topLevelKeyOrder(after).filter(k => !had.has(k));
}

const GENERATED = freshRender();

// The key the generator introduced most recently, and the one measured on the
// issue. Named by DERIVATION — the added top-level key whose generated block
// is non-empty — so this file does not pin the template to one key.
const COMMENTED = topLevelKeyOrder(GENERATED).filter(k => commentBlockAbove(GENERATED, k).length > 0);

describe("#941 the fixture: the generated template really carries what these cases measure", () => {
  test("at least one top-level key is introduced by a column-zero comment block", () => {
    // Without this, every comparison below holds vacuously over empty arrays:
    // a template whose keys carry no comments agrees with a merge that drops
    // every comment.
    expect(COMMENTED.length, "no top-level key in the generated workflow has a comment above it").toBeGreaterThan(0);
  });

  test("removing a section from the fixture removes its comment block too", () => {
    // The consumer fixtures are built by deletion. If the deletion left the
    // comment behind, the merge would be adding a key that already had its
    // block in place and AC-1 would pass without the fix.
    const before = withoutSections(GENERATED, COMMENTED);
    for (const key of COMMENTED) {
      const block = commentBlockAbove(GENERATED, key);
      expect(before, `the consumer fixture still carries ${key}'s comment block`).not.toContain(block[0]);
    }
    expect(addedKeys(before, GENERATED)).toEqual(COMMENTED);
  });
});

describe("#941 AC-1: a top-level section the merge ADDS carries its introducing comment", () => {
  test("every added key's comment block in the output is the block the generator put above it", () => {
    const before = withoutSections(GENERATED, COMMENTED);
    const merged = mergeManagedWorkflow(before, GENERATED);

    const added = addedKeys(before, merged);
    expect(added, "the merge added none of the keys the consumer lacks").toEqual(COMMENTED);
    for (const key of added) {
      expect(
        commentBlockAbove(merged, key),
        `\`${key}:\` was added without the comment block introducing it`,
      ).toEqual(commentBlockAbove(GENERATED, key));
    }
  });

  test("two adjacent added sections each get their own block, and only their own", () => {
    // Added keys are emitted one after another in generated order, so a fix
    // that re-attaches a block to the wrong neighbour — or to both — is
    // invisible with a single added key.
    const order = topLevelKeyOrder(GENERATED);
    const pair = order.filter((k, i) => k !== "jobs" && (COMMENTED.includes(k) || COMMENTED.includes(order[i + 1])));
    const before = withoutSections(GENERATED, pair);
    const merged = mergeManagedWorkflow(before, GENERATED);

    expect(pair.length, "the fixture adds fewer than two adjacent sections").toBeGreaterThan(1);
    expect(addedKeys(before, merged), "the pair fixture did not add both keys").toEqual(pair);
    for (const key of pair) {
      expect(
        commentBlockAbove(merged, key),
        `\`${key}:\` carries a comment block that is not the generator's`,
      ).toEqual(commentBlockAbove(GENERATED, key));
    }
  });
});

describe("#941 AC-2: a section the consumer already has is untouched, comments included", () => {
  test("the generator's block is not injected above a key the consumer already declares", () => {
    // The arm that refuses "copy the generated section whenever it differs".
    // The consumer has the key with a value of their own and no commentary;
    // the generator's reasoning is not theirs to receive on an UPDATE.
    const key = COMMENTED[0];
    const before = withoutCommentBlockAbove(GENERATED, key);
    const merged = mergeManagedWorkflow(before, GENERATED);

    expect(addedKeys(before, GENERATED), "the fixture dropped the key as well as its comment").toEqual([]);
    expect(commentBlockAbove(merged, key), `the generator's block was injected above an existing \`${key}:\``).toEqual(
      [],
    );
  });

  test("the consumer's OWN comment above that key survives and is not joined by the generator's", () => {
    // #917's precedent, one level up: where both sides declare the same thing,
    // the consumer's stands. A comment is the consumer's statement about their
    // own file, and replacing it is the data loss #216 exists to prevent.
    const key = COMMENTED[0];
    const mine = ["# Ours. Raised with the platform team, do not revert.", "# See INFRA-4412."];
    const before = withoutCommentBlockAbove(GENERATED, key)
      .split("\n")
      .flatMap(l => (l === `${key}:` ? [...mine, l] : [l]))
      .join("\n");
    const merged = mergeManagedWorkflow(before, GENERATED);

    expect(commentBlockAbove(merged, key), "the consumer's own commentary was replaced or added to").toEqual(mine);
    expect(merged, "the generator's block was merged in beside the consumer's").not.toContain(
      commentBlockAbove(GENERATED, key)[0],
    );
  });
});

describe("#941 AC-3: the fresh path and the merge path agree about the added key", () => {
  test("a newly-added key reads the same in a merged file as in a fresh render", () => {
    const before = withoutSections(GENERATED, COMMENTED);
    const fresh = planManagedWrite(null, GENERATED).content;
    const merged = planManagedWrite(before, GENERATED).content;

    for (const key of COMMENTED) {
      expect(
        commentBlockAbove(merged, key),
        `an upgraded consumer and a new one disagree about what \`${key}:\` means`,
      ).toEqual(commentBlockAbove(fresh, key));
    }
  });
});

describe("#941 AC-4: adding the block is idempotent", () => {
  test("the block is written exactly once, however many times the scaffold runs", () => {
    // The inverse defect: a fix that re-inserts the comment on every run
    // appends a copy per upgrade, because the key is present from the second
    // run onward and nothing strips the previous one.
    const before = withoutSections(GENERATED, COMMENTED);
    const once = mergeManagedWorkflow(before, GENERATED);
    const twice = mergeManagedWorkflow(once, GENERATED);

    for (const key of COMMENTED) {
      const first = commentBlockAbove(GENERATED, key)[0];
      const count = twice.split("\n").filter(l => l === first).length;
      expect(count, `\`${key}:\`'s comment block appears ${count} times after two scaffolds`).toBe(1);
    }
  });

  test("the second scaffold writes nothing: SKIP, byte-identical", () => {
    // Not merely "the same comment": the whole file. A merge that re-derives
    // the block each run can be idempotent in the comment and still move a
    // blank line, which is an UPDATED with a diff for every consumer forever.
    const before = withoutSections(GENERATED, COMMENTED);
    const first = planManagedWrite(before, GENERATED);
    const second = planManagedWrite(first.content, GENERATED);

    expect(first.verb, "the upgrade did not write").toBe("UPDATED");
    expect(second.verb, "the second scaffold is not a no-op").toBe("SKIP");
    expect(second.content).toBe(first.content);
  });

  test("the upgraded file is not refused on the next run", () => {
    // The failure mode this case exists for is specific. The added block sits
    // between two sections, so a reader that files it under the section ABOVE
    // hands it to `jobs:` — where the jobs merge drops it, and the write then
    // refuses lines it cannot prove it wrote. A consumer whose next scaffold
    // REFUSES is worse off than one that never got the comment.
    const before = withoutSections(GENERATED, COMMENTED);
    const first = planManagedWrite(before, GENERATED);
    const second = planManagedWrite(first.content, GENERATED);

    expect(second.refusal, "the upgraded file is refused by the run after it").toBeNull();
    expect(second.lostLines, "the next run would drop lines the harness wrote").toEqual([]);
  });
});
