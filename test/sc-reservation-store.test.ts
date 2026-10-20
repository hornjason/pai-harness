/**
 * Two concurrent branches cannot be handed the same SC id (#725).
 *
 * No SC id is claimed in this file. The ids this work needs have not been
 * allocated, and hand-writing one is the fourth of the four collisions of
 * 2026-10-19 — made by a session that had read the warning an hour earlier.
 * They are named in the PR for allocation instead.
 *
 * ## What the fixtures have to be, and why
 *
 * Every case here builds TWO real git repositories whose `specs/` exclude
 * each other's ids, and drives the real `allocateScNumber` against each. That
 * is the collision in the issue, reproduced: on branch A the allocator reads a
 * floor that does not contain B's claim and is internally consistent, on B the
 * same mirrored, and the collision exists only in the union.
 *
 * They are real `git init` repositories because `readScNamespace` shells out
 * to `git worktree list` and `git for-each-ref`; in a plain temp directory
 * both fail, and every assertion would then be a statement about git rather
 * than about the store (`test/sc-allocator-leg-provenance.test.ts` pays the
 * same second for the same reason).
 *
 * ## The positive control is the collision itself
 *
 * The first case asserts the two views allocate THE SAME NUMBER with no store
 * present. Without that, "the two numbers differ" is satisfied by two
 * fixtures that were never going to agree, and the case would reach its
 * assertion without the feature (#500). The collision has to exist before a
 * separation can be measured.
 *
 * ## Ids are computed, never spelled
 *
 * A literal `SC-<n>` below 9000 that no spec declares is a stray, and
 * `test/sc-fixture-namespace.test.ts` would report this file. Reserved blocks
 * are pairs of integers in JSON, which is one of the reasons the store is
 * JSON rather than Markdown.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  allocateAgainstReservations,
  allocateScNumber,
  scReservationLeg,
  ScReservationExhaustedError,
} from "../lib/create-sc";
import {
  lowestFreeInBlock,
  readScReservations,
  RESERVATION_REFUSAL,
  RESERVATIONS_CONTROL_KEY,
  reservationFor,
  reservedCeiling,
  reservedIdCount,
  SC_RESERVATIONS_PATH,
  type ScReservation,
} from "../lib/sc-reservations";
import { buildScRegistry, FIXTURE_SC_FLOOR } from "../lib/sc-ids";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** An id as a string, never as a literal — see the header. */
const id = (n: number): string => `SC-${n}`;

const NO_SPECS = buildScRegistry([]);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
}

/**
 * A git repository with one spec declaring `specIds`, and whichever store the
 * caller asks for.
 *
 * `store === undefined` writes no file at all, which is the `absent` state.
 * `store` as a string is written verbatim, so a case can plant something that
 * is not JSON, or JSON that is not the store.
 */
function tree(opts: { specIds: number[]; store?: unknown | string }): string {
  // realpath, because on macOS `/var` is a symlink to `/private/var` and git
  // reports the resolved path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-725-")));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(
    join(root, "specs", "MAIN-SPEC.md"),
    ["# Fixture spec", "", ...opts.specIds.map(n => `- [ ] ${id(n)}: a criterion`), ""].join("\n"),
  );
  if (opts.store !== undefined) {
    writeFileSync(
      join(root, SC_RESERVATIONS_PATH),
      typeof opts.store === "string" ? opts.store : JSON.stringify(opts.store, null, 2),
    );
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base", "--allow-empty"]);
  return root;
}

const block = (owner: string, from: number, to: number): ScReservation => ({ owner, from, to });

/** The store as the allocator sees it, for the common case. */
const storeOf = (...blocks: ScReservation[]): { reservations: ScReservation[] } => ({
  [RESERVATIONS_CONTROL_KEY]: blocks,
}) as { reservations: ScReservation[] };

// ── SC-3: two views that each exclude the other ───────────────────────────

describe("two allocations against views that each exclude the other", () => {
  test("with no store the two views collide — the premise, measured before anything is separated", () => {
    // The defect, reproduced. Both trees declare the same highest id and
    // neither can see the other, so both allocators are individually correct
    // and both answer the same number. This is instance three of 2026-10-19.
    const base = 5000;
    const a = tree({ specIds: [base] });
    const b = tree({ specIds: [base] });

    const na = allocateScNumber(a, "", NO_SPECS).number;
    const nb = allocateScNumber(b, "", NO_SPECS).number;

    expect(na, "the two views did not collide, so nothing below is a measurement of the fix").toBe(nb);
    expect(na).toBe(base + 1);

    // And neither view can see the other's claim — the property the issue
    // says makes the collision invisible on either branch.
    const seen = allocateScNumber(a, "", NO_SPECS).namespace.ids;
    expect(seen.has(id(base + 1)), "view A can already see the id B is about to take").toBe(false);
  });

  test("with one store both views read, the same two allocations do not overlap", () => {
    // Identical to the case above in every dimension except the store, which
    // is the only thing that varies (#585's pair discipline). The store is the
    // same bytes in both trees, because it is committed on main and that is
    // the one thing two unmerged branches share.
    const base = 5000;
    const store = storeOf(block("branch-a", 5100, 5119), block("branch-b", 5120, 5139));
    const a = tree({ specIds: [base], store });
    const b = tree({ specIds: [base], store });

    const na = allocateScNumber(a, "", NO_SPECS, { owner: "branch-a" }).number;
    const nb = allocateScNumber(b, "", NO_SPECS, { owner: "branch-b" }).number;

    expect(na, "branch-a was not allocated from its own block").toBe(5100);
    expect(nb, "branch-b was not allocated from its own block").toBe(5120);
    expect(na, "two concurrent branches were handed the same id").not.toBe(nb);

    // Non-overlap as a property, not as two literals: each number is inside
    // its own owner's block and outside every other owner's.
    const blocks = readScReservations(a).blocks;
    for (const [owner, n] of [["branch-a", na], ["branch-b", nb]] as const) {
      for (const bl of blocks) {
        const inside = n >= bl.from && n <= bl.to;
        expect(inside, `${owner} was handed ${n}, which is inside ${bl.owner}'s block`)
          .toBe(bl.owner === owner);
      }
    }
  });

  test("a caller with no block of its own is allocated above every block, not into one", () => {
    // The row that covers instance two: a renumber during a repair, by
    // somebody who did not think of themselves as allocating and therefore
    // reserved nothing. The floor it would otherwise get lands squarely
    // inside a block another session declared.
    const base = 5000;
    const store = storeOf(block("branch-a", 5001, 5019));
    const t = tree({ specIds: [base], store });

    const bare = allocateScNumber(t, "", NO_SPECS, { owner: "nobody-in-the-store" }).number;
    const floorWithoutStore = allocateScNumber(tree({ specIds: [base] }), "", NO_SPECS).number;

    // The premise: the unreserved floor really does land inside the block, or
    // this case is about a number that was never in danger.
    expect(floorWithoutStore, "the fixture's floor is not inside the reserved block")
      .toBeGreaterThanOrEqual(5001);
    expect(floorWithoutStore).toBeLessThanOrEqual(5019);

    expect(bare, "an unreserved caller was handed an id out of somebody else's block").toBe(5020);
  });

  test("an owner is matched exactly — a prefix does not inherit somebody else's block", () => {
    // The tempting widening, refused up front: `fix/725` matching
    // `fix/725-followup` hands one block to two branches, which is the defect
    // rather than the fix.
    const store = storeOf(block("fix/725", 5200, 5219));
    const t = tree({ specIds: [5000], store });
    expect(allocateScNumber(t, "", NO_SPECS, { owner: "fix/725-followup" }).number).toBe(5220);
    expect(allocateScNumber(t, "", NO_SPECS, { owner: "fix/725" }).number).toBe(5200);
  });

  test("a block is filled from the bottom and steps over ids already taken in it", () => {
    // A block is not a floor. Half-consumed, it still has to hand out the
    // lowest FREE id in it, or a session that allocates twice gets the same
    // number twice.
    //
    // The consumed ids are in the MIDDLE of the block, not at its start,
    // deliberately: with 5300..5302 taken the floor is 5303 and the lowest
    // free id in the block is also 5303, so an allocator that ignored the
    // block entirely would answer correctly and the case would witness
    // nothing (`.claude/rules/checks-must-be-able-to-fail.md` — name an input
    // on which the mutant and the original differ).
    const store = storeOf(block("branch-a", 5300, 5319));
    const t = tree({ specIds: [5305, 5306], store });
    const floorIfTheBlockWereIgnored = allocateScNumber(tree({ specIds: [5305, 5306] }), "", NO_SPECS).number;
    expect(floorIfTheBlockWereIgnored, "the fixture does not separate the block from the floor").toBe(5307);
    expect(allocateScNumber(t, "", NO_SPECS, { owner: "branch-a" }).number).toBe(5300);

    // …and the ids already taken inside it are still stepped over.
    const half = tree({ specIds: [5300, 5301, 5305], store });
    expect(allocateScNumber(half, "", NO_SPECS, { owner: "branch-a" }).number).toBe(5302);
  });

  test("a spent block refuses rather than silently allocating outside itself", () => {
    const spent = Array.from({ length: 3 }, (_, i) => 5400 + i);
    const store = storeOf(block("branch-a", 5400, 5402));
    const t = tree({ specIds: spent, store });
    expect(() => allocateScNumber(t, "", NO_SPECS, { owner: "branch-a" }))
      .toThrow(ScReservationExhaustedError);
  });
});

// ── SC-4: zero known reservations is not "no conflict" ────────────────────

describe("an empty reading is not believed until the control string is found", () => {
  test("an object with no control key and an empty one differ on more than the block count", () => {
    // The pair, and the premise first: both readings carry zero blocks, so
    // this is not a test of the count. `{}` parses, yields nothing, and is
    // byte-indistinguishable from a store that reserves nothing — which is
    // the pre-#725 behaviour wearing a fix.
    const noKey = tree({ specIds: [5000], store: {} });
    const emptyList = tree({ specIds: [5000], store: storeOf() });

    const a = readScReservations(noKey);
    const b = readScReservations(emptyList);

    expect(a.blocks.length, "the two fixtures differ on the block count, so this is not a test of the control")
      .toBe(b.blocks.length);
    expect(a.blocks.length).toBe(0);

    expect(a.status, "a store with no control key reported a completed read").toBe("unreadable");
    expect(b.status, "a store that genuinely reserves nothing was reported unreadable").toBe("read");
    expect(a.reason ?? "", "the unreadable reading carries no reason").toContain(RESERVATIONS_CONTROL_KEY);

    // And the allocator does the two different things.
    expect(() => allocateScNumber(noKey, "", NO_SPECS)).toThrow(RESERVATION_REFUSAL);
    expect(allocateScNumber(emptyList, "", NO_SPECS).number).toBe(5001);
  });

  test("an absent store is a skipped leg and a named gap, and does not refuse", () => {
    // `absent` is the normal state for every consumer project this harness
    // scaffolds. A refusal they cannot act on is a gate everyone learns to
    // click past, so this is the one non-`read` state that still allocates —
    // and it has to say so, or it is a silent pass.
    const t = tree({ specIds: [5000] });
    const { number, namespace } = allocateScNumber(t, "", NO_SPECS);
    expect(number).toBe(5001);

    const leg = namespace.sources.find(s => s.kind === "reservations");
    expect(leg, "the reading does not name the reservations leg at all").toBeDefined();
    expect(leg!.status).toBe("skipped");
    expect(leg!.found).toBe(0);
    expect(leg!.reason ?? "").toContain(SC_RESERVATIONS_PATH);

    expect(
      namespace.unmeasured.some(u => u.includes("reservation store")),
      "an unconsulted reservation store is missing from unmeasured",
    ).toBe(true);
  });

  test("a store that was read names no gap, while unmeasured stays non-empty for other reasons", () => {
    // The other half of the pair above. `unmeasured` is NEVER empty — a clone
    // on another machine is outside anything this process can reach — so a
    // non-empty list is not the evidence. The absence of the reservation
    // sentence is.
    const t = tree({ specIds: [5000], store: storeOf(block("branch-a", 5100, 5119)) });
    const { namespace } = allocateScNumber(t, "", NO_SPECS, { owner: "branch-a" });
    expect(
      namespace.unmeasured.some(u => u.includes("reservation store")),
      "a store that WAS read was reported as unmeasured",
    ).toBe(false);
    expect(namespace.unmeasured.length, "a fully-read namespace claims to be complete").toBeGreaterThan(0);
  });

  test("a read leg counts the ids the store removes, and a skipped one cannot", () => {
    const t = tree({ specIds: [5000], store: storeOf(block("branch-a", 5100, 5119)) });
    const leg = scReservationLeg(readScReservations(t));
    expect(leg.status).toBe("read");
    expect(leg.found, "a read store contributed no occupied ids").toBe(20);
    expect(leg.reason, "a clean read invented a reason").toBeUndefined();
  });

  test("malformed JSON, a non-object, a non-array and a bad block all refuse by name", () => {
    const cases: Array<[string, unknown | string, string]> = [
      ["not JSON at all", "{ this is not json", "invalid JSON"],
      ["a JSON array", "[]", "not a JSON object"],
      ["a non-array control key", { [RESERVATIONS_CONTROL_KEY]: 7 }, "is not an array"],
      ["a block with no owner", storeOf({ from: 1, to: 2 } as unknown as ScReservation), "has no owner"],
      ["a block running backwards", storeOf(block("a", 20, 10)), "runs backwards"],
      ["a non-integer bound", storeOf({ owner: "a", from: 1.5, to: 9 } as unknown as ScReservation), 'no usable "from"'],
      ["a block in the fixture range", storeOf(block("a", FIXTURE_SC_FLOOR - 1, FIXTURE_SC_FLOOR + 5)), "fixture range"],
      ["two owners overlapping", storeOf(block("a", 100, 200), block("b", 150, 250)), "overlap"],
    ];
    for (const [name, store, expected] of cases) {
      const t = tree({ specIds: [5000], store });
      const r = readScReservations(t);
      expect(r.status, `${name} was not reported unreadable`).toBe("unreadable");
      expect(r.reason ?? "", `${name} refused without naming why`).toContain(expected);
      expect(() => allocateScNumber(t, "", NO_SPECS), `${name} did not stop the allocation`)
        .toThrow(RESERVATION_REFUSAL);
    }
  });

  test("the refusal is not vacuous — an adjacent, valid store of the same shape reads", () => {
    // Every row above is a refusal. A reader that refused everything would
    // pass all of them, so one store that differs from the overlap case in
    // exactly one integer has to come back clean.
    const t = tree({ specIds: [5000], store: storeOf(block("a", 100, 200), block("b", 201, 250)) });
    const r = readScReservations(t);
    expect(r.status, "a valid store of the same shape as the refused ones was refused").toBe("read");
    expect(r.blocks.map(b => b.owner)).toEqual(["a", "b"]);
  });
});

// ── the arithmetic, at the binding a battery points at ────────────────────

describe("the allocation decision, exercised directly", () => {
  const blocks = [block("a", 100, 109), block("b", 110, 119)];

  test("an owner with room gets the lowest free id in its block, whatever the floor says", () => {
    expect(allocateAgainstReservations(500, blocks, "a", new Set())).toBe(100);
    expect(allocateAgainstReservations(500, blocks, "a", new Set([100, 101]))).toBe(102);
  });

  test("no owner means above the ceiling, or the floor, whichever is higher", () => {
    expect(allocateAgainstReservations(50, blocks, null, new Set())).toBe(120);
    expect(allocateAgainstReservations(500, blocks, null, new Set())).toBe(500);
  });

  test("an empty store leaves the floor exactly where it was", () => {
    // The compatibility claim, asserted rather than assumed: a project with
    // no reservations must allocate precisely what it did before #725.
    expect(allocateAgainstReservations(777, [], null, new Set())).toBe(777);
    expect(allocateAgainstReservations(777, [], "anyone", new Set())).toBe(777);
  });

  test("the helpers agree with the blocks they are handed", () => {
    expect(reservedCeiling(blocks)).toBe(119);
    expect(reservedCeiling([])).toBe(0);
    expect(reservedIdCount(blocks)).toBe(20);
    expect(reservationFor(blocks, "b")).toEqual(blocks[1]);
    expect(reservationFor(blocks, null)).toBeNull();
    expect(reservationFor(blocks, "  ")).toBeNull();
    expect(lowestFreeInBlock(blocks[0], new Set([100, 101, 102]))).toBe(103);
    expect(lowestFreeInBlock(blocks[0], new Set(Array.from({ length: 10 }, (_, i) => 100 + i)))).toBeNull();
  });
});

// ── the live store in this repository ─────────────────────────────────────

describe("the store this repository ships", () => {
  const ROOT = join(import.meta.dir, "..");

  test("it reads, and it is the control string that says so", () => {
    const r = readScReservations(ROOT);
    expect(r.status, `${SC_RESERVATIONS_PATH} is not readable: ${r.reason ?? ""}`).toBe("read");
  });

  test("no block overlaps another, and none reaches the fixture range", () => {
    // Both are refusals inside the reader, so this case is a statement that
    // the SHIPPED file is on the clean side of them rather than a second
    // decider for the same question.
    const r = readScReservations(ROOT);
    expect(r.status).toBe("read");
    for (const b of r.blocks) {
      expect(b.to, `${b.owner} reaches the fixture range`).toBeLessThan(FIXTURE_SC_FLOOR);
      expect(b.from, `${b.owner} runs backwards`).toBeLessThanOrEqual(b.to);
    }
  });
});
