/**
 * #399 — test fixtures spell SC ids inside the live namespace, so the
 * allocator can mint criteria out of scratch numbers.
 *
 * Covers SC-1520, SC-1521, SC-1522, SC-1523 (CONFIG-DRIVEN-TESTING-SPEC.md).
 *
 * `nextSCNumber` reads the spec registry and cannot see a fixture. So it
 * proposes a number that looks free, is free as far as every guard in the
 * repo is concerned, and collides with a string literal the suite depends on.
 * Found while renumbering GATE-CONTRACTS-SPEC.md (#392 follow-up): the next
 * free number was 896, and 899..912 were already occupied by planted
 * fixtures.
 *
 * ## The collision is not hypothetical — it has already happened
 *
 * `test/stale-issue-scanner.test.ts` plants `SC-379` and `SC-380` as fixture
 * ids. `specs/CONFIG-DRIVEN-TESTING-SPEC.md:77-78` declares both as real
 * tracked criteria. Two different things wear the same id today, and nothing
 * in the tree reports it, because every guard in this area —
 * `crossSpecCollisions`, `crossFormCollisions`, `nextSCNumber`,
 * `requiresQualification` — reasons over `specs/` only. They are all correct
 * about the question they ask and all blind to half the namespace, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s second shape: a detector
 * narrower than what it detects.
 *
 * ## Why 9000 and not 9900
 *
 * The issue proposed the 9900 range, following `test/sc-claim-forms.test.ts`.
 * Measured on the tree, the convention that actually exists is 9000+: 209
 * fixture mentions sit at 9001..9902 across eight files, against 24 strays
 * below. Setting the floor at 9900 would have declared 209 correct, settled
 * fixture ids to be violations and required migrating them for no benefit.
 * The floor goes where the repo converged.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

import {
  FIXTURE_SC_FLOOR, isFixtureScId, scIdsSpelledInSource, strayFixtureIds,
  buildScRegistry, SC_SOURCE_DIRS,
} from "../lib/sc-ids";
import { allocateScNumber, nextSCNumber } from "../lib/create-sc";
import { readScReservations, reservationFor } from "../lib/sc-reservations";

const ROOT = join(import.meta.dir, "..");

function specFiles(dir = join(ROOT, "specs"), acc: Array<{ file: string; content: string }> = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) specFiles(p, acc);
    else if (e.name.endsWith(".md")) acc.push({ file: p.slice(ROOT.length + 1), content: readFileSync(p, "utf-8") });
  }
  return acc;
}

const registry = buildScRegistry(specFiles());

const planted: string[] = [];
afterAll(() => { for (const p of planted) rmSync(p, { recursive: true, force: true }); });

/** A disposable tree containing exactly the files given. */
function plantedTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sc-fixture-"));
  planted.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("SC-1520: one predicate decides what is reserved for fixtures", () => {
  test("the floor is consulted, not re-derived", () => {
    expect(isFixtureScId(`SC-${FIXTURE_SC_FLOOR}`)).toBe(true);
    expect(isFixtureScId(`SC-${FIXTURE_SC_FLOOR - 1}`)).toBe(false);
    expect(isFixtureScId("SC-9902")).toBe(true);
    expect(isFixtureScId("SC-640")).toBe(false);
  });

  test("a non-numeric id is not reserved", () => {
    // `SC-A1` is an anti-criterion, numbered per spec. Treating it as
    // reserved would hide every anti-criterion from the stray guard.
    expect(isFixtureScId("SC-A1")).toBe(false);
    expect(isFixtureScId("SC-")).toBe(false);
  });

  test("both callers consult the predicate rather than the number", () => {
    // The single-binding property, asserted as a count rather than trusted.
    // A second place deciding what is reserved would survive any mutation of
    // the first, and the guard would go green for the wrong reason — the
    // trap `.claude/rules/claiming-sc-coverage.md` names for its own owner.
    const callers = ["lib/create-sc.ts", "lib/sc-ids.ts"]
      .map(f => readFileSync(join(ROOT, f), "utf-8")).join("\n");
    const literal = new RegExp(`>=\\s*${FIXTURE_SC_FLOOR}\\b|\\b${FIXTURE_SC_FLOOR}\\b\\s*<=`, "g");
    const bare = [...callers.matchAll(literal)].length;
    expect(
      bare,
      `the floor is compared against directly ${bare} times — call isFixtureScId instead`,
    ).toBeLessThanOrEqual(1);
  });
});

describe("SC-1521: the allocator sees both halves of the namespace", () => {
  test("it never returns a number any source file spells", () => {
    // Driven over the REAL tree, not a planted pair. A planted pair proves
    // the parameter is read; only the tree proves the answer is right here,
    // today, which is what the renumbering in #392 needed and did not have.
    const spelled = scIdsSpelledInSource(ROOT);
    const next = nextSCNumber("", registry, spelled.keys());
    expect(
      spelled.has(`SC-${next}`),
      `nextSCNumber proposed SC-${next}, which ${spelled.get(`SC-${next}`)?.join(", ")} already spells`,
    ).toBe(false);
    expect(registry.declaredById.has(`SC-${next}`)).toBe(false);
  });

  test("a fixture at a free number moves the allocation past it", () => {
    // The mutation, performed rather than described: plant a fixture one
    // above what the tree would allocate and watch the allocator step over
    // it. Without the third argument this is the #399 bug exactly.
    const baseline = nextSCNumber("", registry, scIdsSpelledInSource(ROOT).keys());
    const planted = [...scIdsSpelledInSource(ROOT).keys(), `SC-${baseline}`];
    expect(nextSCNumber("", registry, planted)).toBe(baseline + 1);
  });

  test("the reserved range does not drag the allocation up with it", () => {
    // The one case where a higher number is the WRONG answer. The 9000s
    // exist to be safe for fixtures, so counting one as taken would push
    // every future criterion past 9000 and destroy the reservation.
    const baseline = nextSCNumber("", registry, scIdsSpelledInSource(ROOT).keys());
    expect(nextSCNumber("", registry, ["SC-9999", "SC-9000"])).toBeLessThan(FIXTURE_SC_FLOOR);
    expect(nextSCNumber("", registry, [...scIdsSpelledInSource(ROOT).keys(), "SC-9999"])).toBe(baseline);
  });

  test("the one-argument answer is unchanged", () => {
    // #392 kept this property deliberately and silently changing it would be
    // a different bug. A consumer with no registry still gets the local read.
    expect(nextSCNumber("- [ ] SC-5: a\n- [ ] SC-9: b\n")).toBe(10);
    expect(nextSCNumber("")).toBe(1);
  });
});

describe("SC-1522: no fixture id sits in the live namespace", () => {
  test("every fixture id is at or above the floor", () => {
    const stray = strayFixtureIds(ROOT, registry);
    const lines = [...stray.entries()]
      .sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3)))
      .map(([id, files]) => `  ${id} — ${files.join(", ")}`);
    expect(
      stray.size,
      `${stray.size} fixture id(s) below SC-${FIXTURE_SC_FLOOR}; move them into the reserved range:\n${lines.join("\n")}`,
    ).toBe(0);
  });

  test("the guard reports a planted stray — through the real function", () => {
    // `expect(size).toBe(0)` over an empty map says the same thing as a
    // clean tree, and the mutation battery proved it: short-circuiting
    // `strayFixtureIds` to `return new Map()` scored 0 red until this case
    // existed. The first version of this test re-filtered a Map it built
    // itself, which asserted that `Array.filter` works.
    //
    // So the whole function runs, against a planted tree, and the planted
    // id is COMPUTED rather than spelled — a below-floor literal here would
    // be a stray in this very file and the guard above would report its own
    // test. That is the self-reference trap
    // `.claude/rules/claiming-sc-coverage.md` has now caught four times.
    const root = plantedTree({
      "test/a.test.ts": `const x = "SC-${FIXTURE_SC_FLOOR - 1}";\n`,
      "lib/b.ts": `const y = "SC-${FIXTURE_SC_FLOOR + 5}";\n`,
    });
    const stray = strayFixtureIds(root, registry);
    expect([...stray.keys()]).toEqual([`SC-${FIXTURE_SC_FLOOR - 1}`]);
    expect(stray.get(`SC-${FIXTURE_SC_FLOOR - 1}`)).toEqual(["test/a.test.ts"]);
  });

  test("the reserved convention is genuinely in use, not merely declared", () => {
    const spelled = scIdsSpelledInSource(ROOT);
    expect(spelled.size, "the scanner found nothing — it is not reading the tree").toBeGreaterThan(100);
    expect([...spelled.keys()].filter(isFixtureScId).length,
      "no reserved-range ids found — the convention is not actually in use").toBeGreaterThan(20);
  });

  test("a declared criterion cited in a test is not a stray", () => {
    // The positive control, and the one that keeps this from becoming a ban
    // on mentioning SC ids in tests. `// covers SC-640` is the project's
    // documented way of claiming coverage and must stay legal.
    const declared = [...registry.declaredById.keys()].find(id => /^SC-\d+$/.test(id))!;
    expect(strayFixtureIds(ROOT, registry).has(declared)).toBe(false);
  });
});

describe("SC-1524: no spec declares into the reserved range", () => {
  test("the reservation holds from the spec side too", () => {
    // The other half, and without it the reservation is one-directional.
    // `nextSCNumber` treats a spec declaration as authoritative at ANY
    // number — if a spec has claimed 9150 then 9150 is claimed, whatever
    // the convention says, and allocating it again is the collision the
    // allocator exists to prevent. That is the right behaviour, and it is
    // only safe while nothing declares up there, which is what this asserts
    // rather than assumes.
    const declared = [...registry.declaredById.entries()].filter(([id]) => isFixtureScId(id));
    expect(
      declared.map(([id, files]) => `${id} in ${files.join(", ")}`),
      `a spec declares a criterion at or above SC-${FIXTURE_SC_FLOOR}, which fixtures are told is safe`,
    ).toEqual([]);
  });

  test("the check is not vacuous — the registry has criteria in it", () => {
    // `toEqual([])` over an empty registry reports the same thing as a clean
    // one. The scan has to have happened for the emptiness to mean anything.
    expect(registry.declaredById.size).toBeGreaterThan(500);
  });
});

describe("SC-1523: the scanner reads the directories it claims to", () => {
  test("EVERY declared source dir is actually walked", () => {
    // Planted, one id per directory, because asserting over the real tree
    // cannot distinguish "gates/ was read and holds no ids" from "gates/ was
    // never opened". Dropping `gates` from SC_SOURCE_DIRS scored 0 red
    // against the real-tree version of this test — a scanner silently
    // skipping a tree reports a clean namespace for exactly the reason the
    // spec-only guards do.
    // The expected set is a LITERAL. Deriving it from SC_SOURCE_DIRS makes
    // the test follow whatever the list says, so dropping `gates` from the
    // list drops it from the test too and the mutation scores 0 — which is
    // exactly what happened. A test parameterised by the thing it checks
    // cannot check it; #397 paid for this lesson once already.
    const MUST_READ = ["test", "lib", "scripts", "gates"];
    expect(SC_SOURCE_DIRS.slice().sort(), "the declared set changed — update MUST_READ deliberately")
      .toEqual(MUST_READ.slice().sort());

    const files: Record<string, string> = {};
    MUST_READ.forEach((d, i) => {
      files[`${d}/probe.ts`] = `const id = "SC-${FIXTURE_SC_FLOOR + 100 + i}";\n`;
    });
    const root = plantedTree(files);
    const found = scIdsSpelledInSource(root);
    const missed = MUST_READ.filter((_, i) => !found.has(`SC-${FIXTURE_SC_FLOOR + 100 + i}`));
    expect(missed, `these source dirs were never read: ${missed.join(", ")}`).toEqual([]);
  });

  test("a missing source dir is skipped, not thrown", () => {
    // The skip is deliberate — a consumer need not have all four — and it is
    // what makes the test above the right place to prove reach.
    const root = plantedTree({ "test/only.test.ts": `const id = "SC-${FIXTURE_SC_FLOOR + 1}";\n` });
    expect([...scIdsSpelledInSource(root).keys()]).toEqual([`SC-${FIXTURE_SC_FLOOR + 1}`]);
  });

  test("a longer id is not read as the shorter one it starts with", () => {
    // `/SC-(\d+)/` without the trailing-digit guard reads `SC-90141` as
    // `SC-9014`, which would make the allocator step over a number nothing
    // uses and the stray guard report an id nobody wrote. Dropping `(?!\d)`
    // scored 0 red before this case existed. Same boundary #148 fixed for
    // the credit scanner, now asserted for this one too.
    // The pair has to be a genuine PREFIX pair — one is the other with a
    // digit appended — or the case proves nothing. The first draft used
    // FLOOR+141 and FLOOR+14, which are 9141 and 9014: not prefixes of each
    // other, so the boundary mutation scored 0 against it.
    const shorter = `SC-${FIXTURE_SC_FLOOR + 14}`;        // SC-9014
    const longer = `${shorter}1`;                          // SC-90141
    expect(longer.startsWith(shorter), "the fixture pair is not a prefix pair").toBe(true);

    const root = plantedTree({ "test/pair.test.ts": `const id = "${longer}";\n` });
    const found = scIdsSpelledInSource(root);
    expect([...found.keys()]).toEqual([longer]);
    expect(found.has(shorter), `${longer} was read as ${shorter}`).toBe(false);
  });

  test("nothing is reported from outside the declared set", () => {
    const files = new Set([...scIdsSpelledInSource(ROOT).values()].flat().map(f => f.split("/")[0]));
    expect([...files].filter(d => !SC_SOURCE_DIRS.includes(d))).toEqual([]);
    expect([...files]).toContain("test");
  });
});

describe("SC-1525: the CLI asks the allocator the whole question", () => {
  test("scripts/create-sc.ts allocates clear of a planted fixture", () => {
    // The call site is its own row. A decider being right is not the same as
    // the caller asking it — SC-1509's lesson, and removing the third
    // argument from the CLI scored 0 red until this existed.
    //
    // Driven as a SUBPROCESS against the real CLI, because the thing under
    // test is the wiring, and a wiring test that imports the function
    // bypasses the wiring.
    // A fixture is planted IN THE TREE at a number above everything the
    // specs declare, so the two answers differ. Without it both halves
    // agree on this tree and the case cannot tell them apart — which is
    // what the mutation battery measured: dropping the CLI's third argument
    // scored 0 red until the probe existed.
    const spec = join(ROOT, "specs", "CONFIG-DRIVEN-TESTING-SPEC.md");
    const before = readFileSync(spec, "utf-8");
    const specOnly = nextSCNumber("", registry);
    const probeFile = join(ROOT, "test", "zz-399-cli-probe.ts");
    // Above the WHOLE namespace, not just this tree's spec registry (#503).
    // `nextSCNumber` is `max(ids) + 1`, so this case only witnesses anything
    // while the probe is the maximum: step it over, and the answer moves.
    // Since `allocateScNumber` reads sibling worktrees and every branch ref,
    // another session's in-flight block can sit above `specOnly`, and then
    // the probe is not the maximum and the number this asserts stops being
    // a statement about the planted id at all. Measured the day it happened:
    // a peer's unmerged branch held a block of nineteen ids above the
    // registry answer, the probe landed inside it, and the CLI correctly
    // allocated past the whole block.
    //
    // The visible symptom is a red case, which is the harmless half. The
    // half worth the comment is the one-id window where the probe lands
    // EXACTLY on the namespace maximum: then `probeId + 1` is the right
    // answer for both the real allocator and one that never read the probe
    // file, and the case goes green having witnessed nothing. The width of
    // that window is not something this fixture controls — another session
    // does — so the fix is to compute the probe above everything rather
    // than to hope.
    //
    // Computed, never spelled: a literal id here would be a stray in this
    // very file, and the guard below would report its own test.
    //
    // #274: the `registry` third argument is the fix the paragraph above
    // asks for, and it was missing. `allocateScNumber`'s `reg` parameter is
    // OPTIONAL, and omitting it silently drops the spec-registry leg — so
    // this read source and sibling namespaces but not the specs, which is a
    // narrower reading than the CLI's own and the precise shape #507 records.
    // It agreed with the right answer only while every spec-declared id was
    // also spelled in a source file. #274 declared SC-2004..SC-2011 in
    // HARNESS-STANDARD.md with no source mention of any of them, the two
    // readings diverged by eight, and the +7 margin landed the probe one
    // below `specOnly` — caught by the guard on the next line, which is the
    // guard doing its job rather than a new failure.
    //
    // Not repaired by widening the margin. That is the cheapest fix and it
    // is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`:
    // it goes green today and re-breaks on the next spec block, and it would
    // leave the probe computed from a reading that structurally cannot see
    // spec declarations.
    // #725: and the owner is passed EXPLICITLY, for the same reason the
    // registry argument is. `allocateScNumber` now takes a reserved block
    // into account, and the CLI's default owner is whatever branch the suite
    // happens to be running on — so without this line the probe is computed
    // from a no-owner reading while the CLI is computed from a branch that
    // may hold a block, and the two readings would differ the first time
    // somebody reserved one. Exactly #507, arriving again: a fixture whose
    // margin is set by something outside it.
    //
    // The owner names nothing, deliberately. This case is about the FIXTURE
    // half of the namespace — does the CLI step over a planted id — and a
    // caller allocating from inside its own block does not step over
    // anything, because a block is filled from the bottom. The premise is
    // asserted rather than assumed on the next line.
    const PROBE_OWNER = "__sc-fixture-namespace-probe__";
    const reserved = readScReservations(ROOT);
    expect(
      reservationFor(reserved.blocks, PROBE_OWNER),
      "the probe owner holds a reserved block, so this case no longer measures the fixture step",
    ).toBeNull();

    const probeId = allocateScNumber(ROOT, "", registry, { owner: PROBE_OWNER }).number + 7;
    expect(probeId, "the probe is not above the registry answer it must beat").toBeGreaterThan(specOnly);
    try {
      writeFileSync(probeFile, `// scratch probe written by test/sc-fixture-namespace.ts\nconst id = "SC-${probeId}";\n`);
      const r = spawnSync("bun", [join(ROOT, "scripts", "create-sc.ts"),
        "--spec", spec, "--pattern", "file-exists",
        "--owner", PROBE_OWNER,
        "--params", JSON.stringify({ file: "PROBE-ONLY.md" })],
        { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
      const out = `${r.stdout}${r.stderr}`;
      expect(out, "the CLI allocated from the spec registry alone").not.toContain(`SC-${specOnly}:`);
      expect(out, "the CLI did not step over the planted fixture").toContain(`SC-${probeId + 1}:`);
    } finally {
      rmSync(probeFile, { force: true });
      writeFileSync(spec, before);
    }
  }, 120_000);
});
