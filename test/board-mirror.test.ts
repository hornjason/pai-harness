/**
 * What the board is allowed to say (#1647).
 *
 * ## What was broken to prove these can fail
 *
 * Run `bash /tmp/rg-bm-battery/battery.sh`, 2026-10-28, against a 28-pass
 * baseline. Every row replaces one line in `lib/board-mirror.ts`:
 *
 *   baseline                                 0 red / 28 pass
 *   cap mirrorText at 6 with `+N more`       1 red / 27 pass
 *   criteriaNamedBy in mention order         1 red / 27 pass
 *   phaseOf without the `\b`                 1 red / 27 pass
 *   openFrontier ignores issue state         2 red / 26 pass
 *   isReady drops `phase !== frontier`       2 red / 26 pass
 *   isReady drops `frontier === null`        1 red / 27 pass
 *   isReady drops the assignee test          1 red / 27 pass
 *   restored                                 0 red / 28 pass
 *
 * **Two of those rows were GREEN on the first run and are the reason the
 * battery was worth running.** `phaseOf` without the boundary changed
 * nothing because the case said `"Subphase 3"`, and the pattern is
 * case-sensitive — it never matched that string with or without the `\b`, so
 * the case could not disagree. And removing the null-phase guard changed
 * nothing because `null !== frontier` already carried it: two lines, one
 * decider, no behavioural test able to say which was live. The guard was
 * deleted rather than tested, and the one case it genuinely earns — both
 * sides null — was added.
 *
 * The first row is not hypothetical either. The cap SHIPPED, with a docblock saying
 * the overflow branch was unreachable because the widest issue named six ids,
 * and the first live run produced
 * `CRC-E1 CRC-E2 CRC-E3 CRC-E4 CRC-E5 CRC-E6 +3 more` for #1437, which names
 * nine. The bound was never measured; it was asserted in a comment. The case
 * below is that issue's real id list.
 *
 * The `isReady` rows are the ones worth having. An earlier version returned
 * "unblocked and unassigned", which made 36 of 46 open issues Ready because
 * this repository has almost no dependency edges — a lane holding the whole
 * backlog, answering "what can I pick up" with "anything".
 */
import { describe, expect, test } from "bun:test";
import {
  criterionIdsIn,
  criteriaNamedBy,
  declaresOwnCriterion,
  isReady,
  isUnblocked,
  mirrorRows,
  mirrorText,
  NAMES_NONE,
  NOT_A_SPEC,
  openFrontier,
  phaseOf,
  specCriteriaIn,
  unlocatableEntries,
} from "../lib/board-mirror";
import { parseCriteria } from "../lib/spec-evidence";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SPEC_ORDER = [
  "CRC-A4",
  "CRC-B3",
  "CRC-B4",
  "CRC-B6",
  "CRC-E1",
  "CRC-E2",
  "CRC-E3",
  "CRC-E4",
  "CRC-E5",
  "CRC-E6",
  "CRC-E7",
  "CRC-E8",
  "CRC-E9",
  "CRC-M11",
  "CRC-N2",
];

/**
 * SC-2610 — the mirror reads every spec in `specs/`, not one named on the
 * command line.
 *
 * The defect this binds is not a crash. `--spec X` filtered the id set to X's
 * criteria, so an issue serving any OTHER spec's criterion got an empty cell,
 * which is indistinguishable from an issue that genuinely serves none. 28
 * cells on the live board were blank on 2026-10-29 and the column was unusable
 * for exactly the question it was built to answer.
 */
describe("SC-2610: every spec contributes, not the one on the command line", () => {
  /** A tree with the spec shapes that matter: two flat, one nested. */
  function tree(specs: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "rg-mirror-specs-"));
    for (const [rel, text] of Object.entries(specs)) {
      const at = join(root, "specs", rel);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, text);
    }
    return root;
  }

  const spec = (...ids: string[]) =>
    ["# A spec", "", "## Success Criteria", "", ...ids.map(id => `- [ ] ${id}: it holds`), ""].join(
      "\n",
    );

  test("two specs in the tree contribute BOTH their ids", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10", "SC-11"), "B-SPEC.md": spec("SC-20") });
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("MEASURED");
      // The whole point, stated as the union. A one-spec reader returns
      // either the first two or the last one, and both are a strict subset.
      expect(r.ids).toEqual(["SC-10", "SC-11", "SC-20"]);
      expect(r.specs.map(s => s.path)).toEqual(["specs/A-SPEC.md", "specs/B-SPEC.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec in a SUBDIRECTORY is read too", () => {
    // `specs/bootstrap-data-flow/` holds six of this repository's specs. A
    // non-recursive walk finds none of them and still reports MEASURED.
    const root = tree({ "A-SPEC.md": spec("SC-10"), "nested/B-SPEC.md": spec("SC-20") });
    try {
      expect(specCriteriaIn(root).ids).toEqual(["SC-10", "SC-20"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the order is deterministic — spec path, then the order inside the spec", () => {
    // Two issues serving the same pair must render the SAME cell, or the
    // column cannot be scanned down a group. A `Set` iteration order that
    // follows the filesystem would break that silently between machines.
    const root = tree({ "Z-SPEC.md": spec("SC-30"), "A-SPEC.md": spec("SC-11", "SC-10") });
    try {
      expect(specCriteriaIn(root).ids).toEqual(["SC-11", "SC-10", "SC-30"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * An id two specs both state cannot be attributed by a cell that has room
   * for the id and not for the spec. Writing it picks one spec at random and
   * the reader has no way to know a choice was made — so it is dropped and
   * reported, and the issue keeps the unambiguous ids it also names.
   */
  test("an id two specs both state is DROPPED and reported, never guessed at", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10"), "B-SPEC.md": spec("SC-10", "SC-20") });
    try {
      const r = specCriteriaIn(root);
      expect(r.ids, "an ambiguous id reached the column").toEqual(["SC-20"]);
      expect(r.collisions).toEqual([{ id: "SC-10", specs: ["specs/A-SPEC.md", "specs/B-SPEC.md"] }]);
      // The control: dropping is not the same as the sweep failing. The
      // unambiguous id from the SAME spec still arrives.
      expect(r.reading).toBe("MEASURED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The other way a cell goes wrong once every spec is read: the issue is
   * writing its OWN acceptance criteria in a spec's shape.
   */
  test("a checkbox line is the issue STATING a criterion, not serving one", () => {
    const serves = { title: "x", body: "## Criteria this serves\n\nSC-10\n" };
    const states = { title: "x", body: "- [ ] SC-10 — a test fails when the trees diverge\n" };
    expect(criteriaNamedBy(serves, ["SC-10"])).toEqual(["SC-10"]);
    expect(criteriaNamedBy(states, ["SC-10"]), "#713's shape reached the column").toEqual([]);
    // Ticked, starred, and indented are the same act.
    expect(criteriaNamedBy({ title: "x", body: "  * [x] SC-10 done" }, ["SC-10"])).toEqual([]);
    // The control: a checkbox for a DIFFERENT id must not suppress this one.
    expect(
      criteriaNamedBy({ title: "x", body: "- [ ] SC-99 other\n\nserves SC-10" }, ["SC-10"]),
    ).toEqual(["SC-10"]);
  });

  /**
   * One spec stating the same id twice is not two specs stating it once.
   *
   * `parseCriteria` matches every `- [ ] ID:` line independently and does
   * not dedupe, so the duplicate pushed the spec's own path twice and read
   * downstream as a cross-spec collision — the id dropped as ambiguous, and
   * a note reading "stated by specs/A-SPEC.md and specs/A-SPEC.md". An
   * unambiguous criterion misreported as ambiguous, for a nonsensical
   * reason. Found by the AI review of #1679. Zero specs state a duplicate
   * today, so this is the case that arrives rather than one that has.
   */
  test("one spec stating an id TWICE is not a collision with itself", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10", "SC-10", "SC-20") });
    try {
      const r = specCriteriaIn(root);
      // The premise: the file really does state it twice, so the dedupe is
      // doing work rather than the fixture being wrong.
      const stated = parseCriteria(readFileSync(join(root, "specs/A-SPEC.md"), "utf-8"));
      expect(stated.filter(c => c.id === "SC-10").length, "the fixture states it once").toBe(2);

      expect(r.reading).toBe("MEASURED");
      expect(r.ids, "a duplicate within one spec was read as ambiguous").toEqual([
        "SC-10",
        "SC-20",
      ]);
      expect(r.collisions, "a spec collided with itself").toEqual([]);
      expect(r.specs[0].ids, "the per-spec list carries the duplicate").toEqual(["SC-10", "SC-20"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * There is no safe fallback for a missing `parentPath`, so there is none.
   *
   * `Dirent.path` under a recursive `readdir` historically resolved to the
   * top-level directory rather than the entry's parent — that bug is WHY
   * `parentPath` exists — so on a runtime old enough to lack `parentPath`,
   * `path` carries the wrong value rather than a usable one. `?? dir` and
   * `?? e.path` are the same guess wearing different names, and both flatten
   * a nested spec silently. I wrote both, one round apart, and the AI review
   * of #1679 caught both.
   */
  test("an entry whose parent cannot be established refuses the sweep", () => {
    // `readdirSync` cannot be asked to omit the field, so the predicate is
    // its own function and the case hands it the shape directly. Without
    // this the refusal is unreachable from a test and reads exactly like a
    // refusal that works.
    expect(unlocatableEntries([{ name: "a.md", parentPath: "specs" }])).toEqual([]);
    expect(unlocatableEntries([{ name: "a.md" }]).map(e => e.name)).toEqual(["a.md"]);
    expect(unlocatableEntries([{ name: "a.md", parentPath: "" }]).map(e => e.name)).toEqual([
      "a.md",
    ]);
    // The control against the live tree: this runtime DOES report it, so the
    // sweep above is measuring specs rather than refusing on every run.
    const r = specCriteriaIn(join(import.meta.dir, ".."));
    expect(r.reading, "this runtime cannot locate its own spec files").toBe("MEASURED");
    expect(
      r.specs.some(s => s.path.includes("/bootstrap-data-flow/")),
      "no nested spec was located, so flattening would be invisible here",
    ).toBe(true);
  });

  /**
   * Both readers of a spec, agreeing by construction rather than by having
   * been fixed twice.
   *
   * The sweep was de-duplicated first and the `--spec` path was left parsing
   * for itself, so the two paths of ONE script disagreed about the very case
   * the fix was written for: `--spec` produced `SC-10 SC-10` in the cell
   * where the sweep produced `SC-10`. Two deciders, and no behavioural test
   * of either can see the other going wrong — so this asserts the property
   * across the call SITES, not just the behaviour of the shared one.
   */
  test("both readers of a spec collapse a repeated id, and neither parses alone", () => {
    const text = spec("SC-10", "SC-10", "SC-20");
    expect(criterionIdsIn(text)).toEqual(["SC-10", "SC-20"]);
    // The premise: without the dedupe there really would be two.
    expect(parseCriteria(text).filter(c => c.id === "SC-10").length).toBe(2);
    // And the cell that would have been written.
    expect(mirrorText(criterionIdsIn(text))).toBe("SC-10 SC-20");

    // The site property. A second `parseCriteria` anywhere in the CLI is a
    // second decider, which is how this bug survived the first fix.
    const cli = readFileSync(join(import.meta.dir, "..", "scripts", "board-mirror.ts"), "utf-8");
    expect(cli.includes("criterionIdsIn"), "the CLI no longer uses the shared reader").toBe(true);
    expect(
      cli.split("\n").filter(l => l.includes("parseCriteria(")),
      "scripts/board-mirror.ts reads a spec for itself instead of through criterionIdsIn, so " +
        "the --spec path and the default sweep can disagree about the same file",
    ).toEqual([]);
  });

  test("a specs/ directory stating nothing is UNMEASURED, not an empty reading", () => {
    const root = tree({ "EMPTY-SPEC.md": "# A spec with no criteria\n" });
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.ids).toEqual([]);
      expect(r.unmeasuredReasons.join(" ")).toContain("no spec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Two ways to reach an empty id set, and they are different facts. The
   * caller refuses on UNMEASURED before printing the collision notes, so if
   * the emptiness came from ambiguity the reason line is the only place that
   * can say so — and the "no spec states a criterion" sentence is then false
   * about a tree full of criteria. Raised by the AI review of #1679.
   */
  test("all-ambiguous is UNMEASURED for the AMBIGUITY, not for an absence", () => {
    const root = tree({ "A-SPEC.md": spec("SC-10"), "B-SPEC.md": spec("SC-10") });
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.ids).toEqual([]);
      const why = r.unmeasuredReasons.join(" ");
      expect(why, "it blamed an absence in a tree that states a criterion").not.toContain(
        "no spec",
      );
      expect(why).toContain("stated by more than one spec");
      // The diagnostic the caller would otherwise never print must be IN the
      // reason, not merely available on a field nothing reads on this path.
      expect(why).toContain("SC-10");
      expect(why).toContain("specs/A-SPEC.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no specs/ directory at all is UNMEASURED, naming the path it looked at", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-mirror-nospecs-"));
    try {
      const r = specCriteriaIn(root);
      expect(r.reading).toBe("UNMEASURED");
      expect(r.unmeasuredReasons.join(" ")).toContain(join(root, "specs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The live control. Every case above builds its own tree, so all of them
   * would still pass against a walk that works on two-file fixtures and finds
   * one spec in the real one. This reads THIS repository.
   */
  test("against this repository, the sweep spans many specs and both id shapes", () => {
    const r = specCriteriaIn(join(import.meta.dir, ".."));
    expect(r.reading).toBe("MEASURED");
    const stating = r.specs.filter(s => s.ids.length > 0);
    expect(stating.length, "a one-spec reader would report 1 here").toBeGreaterThan(10);
    // Two different id namespaces live in different specs, so a cell can only
    // carry both if the sweep really crossed spec boundaries.
    expect(r.ids.some(id => /^SC-\d+$/.test(id)), "no SC- id was found").toBe(true);
    expect(r.ids.some(id => /^CRC-/.test(id)), "no CRC- id was found").toBe(true);
    // And the spec this criterion is stated in is itself in the reading.
    expect(r.ids).toContain("SC-2610");
  });

  /**
   * An exclusion naming a file that no longer exists excludes nothing, and
   * reads in review exactly like one that works.
   *
   * What it changes is narrower than it first looks, and the first version of
   * this case asserted the wrong thing. Every id the template states —
   * `SC-1`, `SC-2`, `SC-A1`, `SC-A2` — is ALSO stated by a real spec, so
   * excluding it removes no id from the column. What it removes is four false
   * collision reports, each naming the template as a spec that states a
   * criterion. That is the claim worth binding, so it is the one asserted.
   */
  /**
   * Every site that builds a pattern around an id must escape it the same
   * way, and the property is asserted across the SITES rather than repaired
   * at one of them: two escapers that agree are behaviourally one, and a
   * mutation of either leaves the other holding the case up
   * (`.claude/rules/checks-must-be-able-to-fail.md`).
   *
   * Found by the AI review of #1679 — `declaresOwnCriterion` interpolated the
   * id raw while its sibling `oneScMentionPattern` escaped it. Today's id
   * grammar contains no metacharacter, so no behavioural case could separate
   * them; what the review saw was the asymmetry.
   */
  test("an id carrying a regex metacharacter is matched LITERALLY, at every site", () => {
    // `.` is the metacharacter, and the id still ENDS in a word character,
    // because both patterns terminate on a boundary and a `)` would fail
    // that for reasons unrelated to escaping.
    const id = "SC-1.5";
    const text = `- [ ] ${id} — the issue states its own\n`;
    // Unescaped, the `.` matches any character, so `SC-115` satisfies the
    // pattern. The positive case cannot show this — it passes either way —
    // so the NEGATIVE is the half that can fail.
    expect(declaresOwnCriterion(text, id), "the literal case stopped matching").toBe(true);
    expect(declaresOwnCriterion("- [ ] SC-115 — something else\n", id)).toBe(false);
    expect(criteriaNamedBy({ title: "x", body: "serves SC-115" }, [id])).toEqual([]);
    // Both sites agree on the same input, which is the property.
    expect(criteriaNamedBy({ title: "x", body: `serves ${id}` }, [id])).toEqual([id]);
    expect(criteriaNamedBy({ title: "x", body: text }, [id]), "a declaration counted").toEqual([]);
  });

  /**
   * The other half of matching an id, and the one `\b` gets wrong.
   *
   * `\b` fires on a word-to-non-word transition, so a trailing hyphen counts
   * as a boundary and `SC-1` matches the front of `SC-1-draft`. That is #148,
   * and `declaresOwnCriterion` reintroduced it one round after the escaping
   * half was fixed — found by the AI review of #1679. Both sites now close
   * the id through `idBoundedPattern`, so this asserts the property at both.
   */
  test("an id does not match the front of a LONGER id, at either site", () => {
    const longer = "- [ ] SC-1-draft — a different criterion entirely\n";
    expect(declaresOwnCriterion(longer, "SC-1"), "SC-1 matched inside SC-1-draft").toBe(false);
    expect(declaresOwnCriterion(longer, "SC-1-draft"), "the real id stopped matching").toBe(true);
    // The digit case #148 was originally about, at the same site.
    expect(declaresOwnCriterion("- [ ] SC-15 — another\n", "SC-1")).toBe(false);
    // And the sibling, on the same inputs, so the two cannot drift apart.
    expect(criteriaNamedBy({ title: "x", body: "serves SC-1-draft" }, ["SC-1"])).toEqual([]);
    expect(criteriaNamedBy({ title: "x", body: "serves SC-15" }, ["SC-1"])).toEqual([]);
  });

  test("the excluded file exists, states criteria, and leaves the sweep", () => {
    const root = join(import.meta.dir, "..");
    expect(NOT_A_SPEC).toEqual(["specs/SPEC-TEMPLATE.md"]);
    const sweep = specCriteriaIn(root);
    for (const p of NOT_A_SPEC) {
      expect(existsSync(join(root, p)), `${p} is excluded but does not exist`).toBe(true);
      // The control: it really would have contributed. A template that had
      // stopped stating criteria would make this exclusion a no-op nobody
      // could see, and the case above would still be green.
      const stated = parseCriteria(readFileSync(join(root, p), "utf-8")).map(c => c.id);
      expect(stated.length, `${p} states nothing, so excluding it does nothing`).toBeGreaterThan(0);
      expect(sweep.specs.map(s => s.path), `${p} is still in the reading`).not.toContain(p);
      expect(
        sweep.collisions.flatMap(c => c.specs),
        `${p} is still named as a colliding spec`,
      ).not.toContain(p);
    }
  });
});

describe("#1647: the Criteria column", () => {
  describe("mirrorText carries every id", () => {
    test("no criteria is an empty cell, not a word", () => {
      // A cell reading "none" sorts and filters as a value. Empty is absence.
      expect(mirrorText([])).toBe(NAMES_NONE);
      expect(NAMES_NONE).toBe("");
    });

    test("one id is just the id", () => {
      expect(mirrorText(["CRC-F1"])).toBe("CRC-F1");
    });

    test("nine ids — #1437's real list — are all nine, uncut", () => {
      const nine = ["CRC-E1", "CRC-E2", "CRC-E3", "CRC-E4", "CRC-E5", "CRC-E6", "CRC-E7", "CRC-E8", "CRC-E9"];
      const cell = mirrorText(nine);
      expect(cell).toBe(nine.join(" "));
      expect(cell).not.toContain("more");
      for (const id of nine) expect(cell).toContain(id);
    });
  });

  describe("criteriaNamedBy asks the question criterion-inventory already asks", () => {
    test("a title mention counts", () => {
      expect(criteriaNamedBy({ title: "CRC-B4's jury never runs in CI", body: "" }, SPEC_ORDER)).toEqual(
        ["CRC-B4"],
      );
    });

    test("a body mention counts", () => {
      expect(criteriaNamedBy({ title: "something", body: "serves CRC-N2 only" }, SPEC_ORDER)).toEqual([
        "CRC-N2",
      ]);
    });

    test("a null body is not a crash and not a match", () => {
      expect(criteriaNamedBy({ title: "nothing here", body: null }, SPEC_ORDER)).toEqual([]);
    });

    test("CRC-B4 does not match inside CRC-B41", () => {
      // The trailing boundary in `oneScMentionPattern` is "not a word
      // character and not a hyphen". Without it the column would credit a
      // criterion the issue never names.
      expect(criteriaNamedBy({ title: "about CRC-B41", body: "" }, ["CRC-B4"])).toEqual([]);
    });

    test("the order is the spec's, not the order the prose happens to mention them", () => {
      // Two issues serving the same pair must render identically, or the
      // column stops being scannable down a group.
      const a = criteriaNamedBy({ title: "CRC-N2 then CRC-A4", body: "" }, SPEC_ORDER);
      const b = criteriaNamedBy({ title: "CRC-A4 then CRC-N2", body: "" }, SPEC_ORDER);
      expect(a).toEqual(["CRC-A4", "CRC-N2"]);
      expect(a).toEqual(b);
    });

    test("an id absent from the spec is never credited, however loudly the issue says it", () => {
      expect(criteriaNamedBy({ title: "CRC-Z9 CRC-Z9 CRC-Z9", body: "" }, SPEC_ORDER)).toEqual([]);
    });
  });

  test("mirrorRows pairs each issue with its own cell", () => {
    const rows = mirrorRows(
      [
        { number: 1, title: "CRC-B3 and CRC-B4", body: "" },
        { number: 2, title: "nothing", body: "" },
      ],
      SPEC_ORDER,
    );
    expect(rows).toEqual([
      { number: 1, criteria: ["CRC-B3", "CRC-B4"], text: "CRC-B3 CRC-B4" },
      { number: 2, criteria: [], text: "" },
    ]);
  });
});

describe("#1647: the Ready lane", () => {
  test("phaseOf reads the number out of a milestone title", () => {
    expect(phaseOf("Convergence Phase 0 — three settings")).toBe(0);
    expect(phaseOf("Convergence Phase 6 — release and detection")).toBe(6);
  });

  test("phaseOf refuses a milestone that is not a phase", () => {
    // `Convergence Machinery` is a real milestone on this repository that no
    // phase row derives, and `plan-spec` reports it as unmanaged. Reading a
    // phase number out of it would put unordered work into the queue.
    expect(phaseOf("Convergence Machinery")).toBeNull();
    expect(phaseOf(null)).toBeNull();
    expect(phaseOf("")).toBeNull();
  });

  test("phaseOf does not read a number out of a word ENDING in Phase", () => {
    // The first spelling of this case was `"Subphase 3"`, and it could not
    // disagree with anything: the pattern is case-sensitive, so `Phase` never
    // matched `subphase` with or without the `\b`. Removing the boundary left
    // the whole file green. The word has to end in a capital `Phase` for the
    // boundary to be the thing under test.
    expect(phaseOf("TestPhase 3 — something")).toBeNull();
    expect(phaseOf("Convergence Phase 3 — something")).toBe(3);
  });

  describe("openFrontier", () => {
    test("is the lowest phase with OPEN work", () => {
      expect(
        openFrontier([
          { state: "OPEN", phase: 3 },
          { state: "OPEN", phase: 1 },
          { state: "OPEN", phase: 5 },
        ]),
      ).toBe(1);
    });

    test("a closed issue does not hold a phase open", () => {
      // The whole point of the lane: finishing Phase 0 must promote Phase 1.
      expect(
        openFrontier([
          { state: "CLOSED", phase: 0 },
          { state: "OPEN", phase: 1 },
        ]),
      ).toBe(1);
    });

    test("an issue in no phase does not become the frontier", () => {
      expect(
        openFrontier([
          { state: "OPEN", phase: null },
          { state: "OPEN", phase: 2 },
        ]),
      ).toBe(2);
    });

    test("no open phased work at all is null, not zero", () => {
      // `0` is a real phase number here, so returning it for "nothing" would
      // make every unphased issue in Phase 0 look ready.
      expect(openFrontier([{ state: "CLOSED", phase: 0 }])).toBeNull();
      expect(openFrontier([])).toBeNull();
    });
  });

  describe("isReady", () => {
    const base = { state: "OPEN", phase: 0, blockedByOpen: 0, assignees: 0 };

    test("open, at the frontier, unblocked, unclaimed", () => {
      expect(isReady(base, 0)).toBe(true);
    });

    test("a later phase is not ready, however unblocked it is", () => {
      expect(isReady({ ...base, phase: 1 }, 0)).toBe(false);
      expect(isReady({ ...base, phase: 6 }, 0)).toBe(false);
    });

    test("an issue in no phase is never ready", () => {
      // There is no guard spelling this; `null !== frontier` carries it. The
      // case stays because the PROPERTY is what matters, and a future edit
      // that special-cases a null phase has to keep it true.
      expect(isReady({ ...base, phase: null }, 0)).toBe(false);
    });

    test("an OPEN blocker refuses it even at the frontier", () => {
      expect(isReady({ ...base, blockedByOpen: 1 }, 0)).toBe(false);
    });

    test("a claimed issue is not ready — somebody already took it", () => {
      expect(isReady({ ...base, assignees: 1 }, 0)).toBe(false);
    });

    test("a closed issue is never ready", () => {
      expect(isReady({ ...base, state: "CLOSED" }, 0)).toBe(false);
    });

    test("no frontier means nothing is ready", () => {
      expect(isReady(base, null)).toBe(false);
    });

    test("an unphased issue when NOTHING is phased is still not ready", () => {
      // The case the `frontier === null` guard actually earns, and the only
      // one: with both sides null, `item.phase !== frontier` is FALSE, so
      // without the guard the function falls through and returns true for an
      // issue that is in no plan at all. A battery removing the guard left
      // every other case green.
      expect(isReady({ ...base, phase: null }, null)).toBe(false);
    });
  });

  describe("isUnblocked reads the OPEN count, which is why Ready is written and not filtered", () => {
    test("zero open blockers and nobody on it", () => {
      expect(isUnblocked({ blockedBy: 0 }, 0)).toBe(true);
    });

    test("one open blocker is blocked", () => {
      expect(isUnblocked({ blockedBy: 1 }, 0)).toBe(false);
    });

    test("an assignee is a claim, not a block, but it still leaves the lane", () => {
      expect(isUnblocked({ blockedBy: 0 }, 1)).toBe(false);
    });
  });
});
