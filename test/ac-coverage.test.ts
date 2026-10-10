/**
 * Every success criterion is covered, or the omission is recorded (#251)
 *
 * Run `wf_e105dd33-220` on #216 was handed **seven** success criteria and
 * went on to implement, verify, commit, security-review and open a PR against
 * **six** acceptance criteria. Nothing refused. Nothing warned.
 *
 * The seventh was the only one that ran against a real consumer:
 *
 * > A throwaway worktree of DailyBriefDashboard re-scaffolds with its
 * > `[self-hosted, mac-mini-live]` runner label and all four extra gates
 * > intact, and `--no-optional --frozen-lockfile` preserved
 *
 * The other six passed honestly, against fixtures. Running the seventh by
 * hand afterwards showed the delivered code destroying `concurrency`,
 * `cancel-in-progress`, `paths-ignore`, the top-level `workflow_dispatch`
 * trigger and the consumer's header comments — while reporting a *preserving*
 * `REPLACED (+0 lines, preserved …)` with `0 refused`.
 *
 * So the cost is not "one AC missing from a report". The run's entire green
 * result was about the half of the problem the fixtures covered, and no gate
 * could tell the difference.
 *
 * ## Two defects, and the second is the one the title names
 *
 * It was not a silent drop — I filed it as one and was wrong.
 * `MAX_ACS_PER_ISSUE = 6` triggered a decomposition, and AC-7/8/9 went to
 * sub-issue #249, which #216 references four times. The mechanism worked.
 *
 * What it got wrong is **which** criteria it kept. The decompose prompt says
 * "If no phases exist, split sequentially", and the fallback on an
 * unmatchable result is `originalAcs.slice(0, MAX_ACS_PER_ISSUE)`. Both are
 * positional. An acceptance criterion is written LAST — it is the one that
 * says "and then the whole thing works" — so position-based splitting defers
 * the falsifying criterion **by construction**, every time, and leaves the
 * shipping phase measuring only the parts it already believed.
 *
 * Note the asymmetry with the rest of this pipeline: a stale security review
 * stops a run cold, an unmeasured suite is not a passing suite, an absent
 * pre-validation reading refuses. An absent acceptance criterion was silent.
 *
 * Both bindings are EXTRACTED BY MARKER AND EXECUTED rather than grepped.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const START = "// ──── AC-COVERAGE-START ────";
const END = "// ──── AC-COVERAGE-END ────";

/** Module scope: a missing marker fails this file at load rather than quietly. */
const BLOCK: string = (() => {
  const a = shipSource.indexOf(START);
  const b = shipSource.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`workflows/ship.js is missing the ${START} / ${END} markers`);
  }
  if (shipSource.indexOf(START, a + 1) !== -1) {
    throw new Error("the AC-COVERAGE markers appear more than once — the slice is ambiguous");
  }
  return shipSource.slice(a, b);
})();

interface Ac {
  id: string;
  type?: string;
  statement?: string;
  /** The ISSUE criteria this AC answers (#258). */
  coversCriteria?: string[];
  /** The governing SPEC's section. A different thing; see #258. */
  specElement?: string;
  evidenceMethod?: { type?: string };
}
interface Deferral {
  specElement?: string;
  reason?: string;
  subIssue?: number;
}
interface Api {
  coverageViolations: (scs: unknown, acs: unknown, deferrals: unknown) => string[];
  prioritiseAcs: (acs: unknown, max: unknown) => Ac[];
}

/**
 * `new Function` over this repository's own workflows/ship.js, read at test
 * time — the same trust boundary as importing it, which the Workflow sandbox
 * makes impossible (#69). Never give it a source from elsewhere.
 */
function load(block: string): Api {
  const out = new Function(`${block}\nreturn { coverageViolations, prioritiseAcs }`)();
  for (const n of ["coverageViolations", "prioritiseAcs"]) {
    if (typeof (out as any)[n] !== "function") {
      throw new Error(`the AC-COVERAGE block does not define ${n}`);
    }
  }
  return out as Api;
}

const api = load(BLOCK);

/**
 * Every criterion id here is BUILT, never written out.
 *
 * A bare criterion id written out literally anywhere in a test file is read
 * as a coverage claim by
 * `findTestFilesForSCs` (#149) — the fixture would certify a real,
 * unimplemented bootstrap criterion as done. `test/sync-sc-status-matching.ts`
 * catches it, and caught it on the first run of this file.
 */
const sc = (n: number) => `SC-${n}`;

/** #216's seven, shortened but keeping the shape that matters. */
const SCS = [
  "re-scaffold preserves the consumer's job list",
  "a lost line is a refusal, not a warning",
  "the harness may overwrite its own jobs",
  "the banner is updated in place",
  "a merged workflow that does not parse is refused",
  "the write is idempotent",
  "a throwaway worktree of DailyBriefDashboard re-scaffolds with its " +
    "[self-hosted, mac-mini-live] runner label and all four extra gates intact",
].map((text, i) => `${sc(i + 1)}: ${text}`);

/**
  * An AC shaped the way Discovery is now required to emit one (#258):
  * `coversCriteria` names the issue criterion, `specElement` names the
  * governing spec's section. They are different fields and this helper keeps
  * them different, because conflating them is the defect under test.
  */
function ac(n: number, extra: Partial<Ac> = {}): Ac {
  return {
    id: `AC-${n}`,
    type: "CODE",
    coversCriteria: [sc(n)],
    specElement: `a section of the governing spec, answering ${sc(n)}`,
    statement: `does thing ${n}`,
    ...extra,
  };
}

const SIX = [1, 2, 3, 4, 5, 6].map(n => ac(n));
const SEVEN = [...SIX, ac(7, { type: "OUTCOME" })];

describe("#251 criterion 1: every SC maps to an AC or to a recorded reason", () => {
  test("full coverage is clean", () => {
    expect(api.coverageViolations(SCS, SEVEN, [])).toEqual([]);
  });

  test("the run that shipped the bug is refused", () => {
    // Six ACs for seven SCs, nothing recorded. This is the exact input.
    const v = api.coverageViolations(SCS, SIX, []);
    expect(v.length, "six ACs for seven SCs was waved through").toBeGreaterThan(0);
  });

  test("the refusal names the uncovered SC by its text, not only by count", () => {
    // "6 of 7 covered" sends a reader to count rows. The text sends them to
    // the thing that was not measured.
    const v = api.coverageViolations(SCS, SIX, []).join("\n");
    expect(v, "the refusal does not quote the uncovered criterion").toContain("mac-mini-live");
  });

  test("a recorded deferral covers it", () => {
    const v = api.coverageViolations(SCS, SIX, [
      { specElement: sc(7), reason: "deferred to Phase 2", subIssue: 249 },
    ]);
    expect(v).toEqual([]);
  });

  test("a deferral with no reason does NOT cover it", () => {
    // The loophole the escape hatch would otherwise open, and the cheapest
    // way to make every case here green again.
    const v = api.coverageViolations(SCS, SIX, [{ specElement: sc(7) }]);
    expect(v.length, "a reasonless deferral bought silence").toBeGreaterThan(0);
  });

  test("a deferral for a DIFFERENT SC does not cover the missing one", () => {
    const v = api.coverageViolations(SCS, SIX, [
      { specElement: sc(3), reason: "deferred", subIssue: 249 },
    ]);
    expect(v.join("\n")).toContain("mac-mini-live");
  });

  test("an AC covering several SCs counts for all of them", () => {
    // `specElement` is comma-separated in real runs — the decompose filter at
    // ship.js already splits on it, so the coverage check has to agree.
    const merged = [...SIX.slice(0, 5), ac(6, { coversCriteria: [`${sc(6)}, ${sc(7)}`] })];
    expect(api.coverageViolations(SCS, merged, [])).toEqual([]);
  });

  test("an AC with no attribution covers nothing, rather than covering anything", () => {
    const orphan = [...SIX.slice(0, 6), { id: "AC-7", type: "CODE", statement: "something" }];
    const v = api.coverageViolations(SCS, orphan, []);
    expect(v.join("\n"), "an AC pointing at no SC was credited with the missing one")
      .toContain("mac-mini-live");
  });

  test("no SCs at all is clean — nothing was asked for, nothing is uncovered", () => {
    expect(api.coverageViolations([], [], [])).toEqual([]);
  });

  test.each([
    ["undefined ACs", undefined],
    ["null ACs", null],
    ["a non-array", "AC-1"],
  ])("%s refuses rather than reading as full coverage", (_label, acs) => {
    const v = api.coverageViolations(SCS, acs, []);
    expect(v.length, "a malformed AC list was read as covering everything").toBeGreaterThan(0);
  });

  test("an SC line with no id is still matched by its text", () => {
    // Real goalData carries the whole checkbox line. Some issues write
    // criteria without SC- ids at all, and those must not silently pass.
    const plain = ["the consumer's CI survives re-scaffolding"];
    const v = api.coverageViolations(plain, [], []);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("\n")).toContain("consumer's CI survives");
  });
});

describe("#251: the split keeps what proves the work, not what came first", () => {
  test("an acceptance criterion written last is kept, not deferred", () => {
    // The whole defect in one case. The seventh is the OUTCOME criterion and
    // it is last, so every positional rule drops it.
    const kept = api.prioritiseAcs(SEVEN, 6);
    expect(kept).toHaveLength(6);
    expect(
      kept.map(a => a.id),
      "the only criterion that could falsify the work was deferred",
    ).toContain("AC-7");
  });

  test("the positional rule it replaces would have dropped it — the control", () => {
    // Stated as a case so the fix is visibly a change in behaviour rather
    // than a rename: `slice(0, 6)` is what ship.js used to do.
    expect(SEVEN.slice(0, 6).map(a => a.id)).not.toContain("AC-7");
  });

  test("evidence that runs a browser counts as acceptance too", () => {
    const acs = [
      ...[1, 2, 3, 4, 5, 6].map(n => ac(n)),
      ac(7, { evidenceMethod: { type: "PLAYWRIGHT" } }),
    ];
    expect(api.prioritiseAcs(acs, 6).map(a => a.id)).toContain("AC-7");
  });

  test("with no acceptance criterion at all the order is unchanged", () => {
    // No reordering for its own sake: a run of uniform CODE criteria must
    // come out in the order discovery wrote them, so this does not quietly
    // reshuffle every run that was already fine.
    const kept = api.prioritiseAcs(SIX.concat(ac(7)), 6);
    expect(kept.map(a => a.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6"]);
  });

  test("several acceptance criteria all survive, and fill from the front after", () => {
    const acs = [
      ...[1, 2, 3, 4, 5].map(n => ac(n)),
      ac(6, { type: "OUTCOME" }),
      ac(7, { type: "OUTCOME" }),
      ac(8),
    ];
    const kept = api.prioritiseAcs(acs, 4).map(a => a.id);
    expect(kept).toContain("AC-6");
    expect(kept).toContain("AC-7");
    expect(kept).toHaveLength(4);
  });

  test("relative order within each class is preserved", () => {
    // Discovery's order carries meaning — dependencies between criteria — so
    // the rule promotes a class, it does not sort.
    const acs = [ac(1), ac(2, { type: "OUTCOME" }), ac(3), ac(4, { type: "OUTCOME" }), ac(5)];
    expect(api.prioritiseAcs(acs, 5).map(a => a.id)).toEqual([
      "AC-2", "AC-4", "AC-1", "AC-3", "AC-5",
    ]);
  });

  test("fewer ACs than the cap are returned untouched", () => {
    expect(api.prioritiseAcs(SIX, 6).map(a => a.id)).toEqual(SIX.map(a => a.id));
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-array", "AC-1"],
  ])("%s yields an empty list rather than throwing mid-run", (_label, acs) => {
    expect(api.prioritiseAcs(acs, 6)).toEqual([]);
  });
});

describe("#251: the decision is wired in, not merely defined", () => {
  test("the decompose fallback no longer slices positionally", () => {
    expect(
      shipSource,
      "the positional fallback is back — an unmatchable decompose result drops the acceptance criterion",
    ).not.toContain("originalAcs.slice(0, MAX_ACS_PER_ISSUE)");
  });

  test("the prompt no longer tells the agent to split sequentially", () => {
    expect(
      shipSource,
      "the decompose prompt still instructs a positional split",
    ).not.toContain("split sequentially");
  });

  test("the coverage check refuses through shipFailed, like every other gate", () => {
    // `shipFailed` is the only producer of a SHIP_FAILED status in ship.js
    // (#252, count asserted in test/ship-failure-report.test.ts), so a
    // `shipFailed(` beside the check is a refusal and a `log(` is not.
    const at = shipSource.indexOf("coverageViolations(goalData.successCriteria");
    expect(at, "ship.js never calls coverageViolations").toBeGreaterThan(-1);
    const after = shipSource.slice(at, at + 1400);
    expect(after, "an uncovered run logs instead of refusing").toContain("shipFailed(");
  });

  test("the coverage decision is written into workflow-state.json", () => {
    // Criterion 3: a reader of a finished run must be able to tell "six ACs
    // because the issue had six SCs" from "six ACs because one was dropped".
    expect(shipSource, "the coverage decision is not recorded anywhere a reader can find it")
      .toContain("acCoverage");
  });

  test("the refusal happens before any code is written", () => {
    // The point of refusing at all is to refuse before the run spends an hour
    // measuring the wrong half. `coverageViolations` is DEFINED above the
    // phase markers, so the index that matters is the call inside
    // runDiscovery, not the definition.
    const call = shipSource.indexOf("coverageViolations(goalData.successCriteria");
    const implement = shipSource.indexOf("PHASE 4: IMPLEMENT");
    expect(call, "ship.js never checks coverage against the issue's criteria")
      .toBeGreaterThan(-1);
    expect(implement).toBeGreaterThan(-1);
    expect(call, "coverage is checked after the implementation has already run")
      .toBeLessThan(implement);
  });
});

/**
 * #258: the input shape a REAL run produces, replayed.
 *
 * Everything above this point uses a fixture I wrote, and every case in it
 * passed while `main` could not ship. Run `wf_0dd46ae5-495` on #254 — the
 * first end-to-end run after #251 merged — refused three success criteria
 * that five ACs covered, and refused them unconditionally: the criteria carry
 * no `SC-N` token, so nothing could ever have covered them.
 *
 * Two assumptions in my fixture were wrong, and neither was knowable from the
 * code:
 *
 *   - Criteria are usually NOT numbered. #254's three are bare checkbox
 *     lines, which is the common case.
 *   - `ac.specElement` names the governing SPEC's section, not the issue's
 *     criteria. Two of the five ACs in that run share one value, which a
 *     criterion reference could not meaningfully do.
 *
 * So the fixture below is READ FROM DISK, copied verbatim out of the run's
 * journal. A fixture written from imagination can only re-test what its
 * author already believed, which is precisely how the first version shipped.
 */
describe("#258: the shape a real run produces", () => {
  const real = JSON.parse(
    readFileSync(join(REPO_ROOT, "test", "fixtures", "wf_0dd46ae5-495-discovery.json"), "utf-8"),
  ) as { successCriteria: string[]; acs: Ac[] };

  /** Attribution as Discovery is now required to record it. */
  const attributed = (ids: number[][]) =>
    real.acs.map((ac, i) => ({ ...ac, coversCriteria: (ids[i] || []).map(n => `C-${n}`) }));

  test("the fixture is the real thing, not a tidied copy", () => {
    // Guards against someone 'fixing' the fixture into the shape that was
    // broken. Each of these three properties is why the run refused.
    expect(real.successCriteria).toHaveLength(3);
    expect(real.acs).toHaveLength(5);
    expect(
      real.successCriteria.some(c => /\bSC-\d+\b/.test(c)),
      "the criteria have been given ids they did not have",
    ).toBe(false);
    const elements = real.acs.map(a => a.specElement);
    expect(
      new Set(elements).size,
      "the duplicate specElement was tidied away — it is the evidence that field is not a criterion reference",
    ).toBeLessThan(elements.length);
  });

  test("the defect, reproduced: unattributed ACs cover nothing", () => {
    // Exactly what the run passed in. Five ACs, three criteria, no
    // attribution — and every criterion comes back uncovered. This is the
    // behaviour, and it is correct NOW: with nothing recording what each AC
    // answers, the check genuinely cannot tell. What was wrong is that there
    // was no way to record it.
    expect(api.coverageViolations(real.successCriteria, real.acs, [])).toHaveLength(3);
  });

  test("with attribution recorded, the same run does NOT refuse", () => {
    // The criterion that falsifies the fix. If this passes and the run still
    // refuses, the fix is in the wrong place.
    const acs = attributed([[1], [2], [3], [1, 2], [1, 2, 3]]);
    expect(
      api.coverageViolations(real.successCriteria, acs, []),
      "a fully attributed run still refuses — main cannot ship",
    ).toEqual([]);
  });

  test("one AC may cover several criteria", () => {
    const acs = attributed([[1, 2, 3], [], [], [], []]);
    expect(api.coverageViolations(real.successCriteria, acs, [])).toEqual([]);
  });

  test("a genuinely uncovered criterion STILL refuses, named by its text", () => {
    // The fix must not buy its green by making the check unable to fail.
    // Criterion 3 is attributed by nobody.
    const acs = attributed([[1], [2], [1], [2], [1, 2]]);
    const v = api.coverageViolations(real.successCriteria, acs, []);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("env recording keeps working unchanged");
    expect(v[0], "the refusal does not say which criterion id was missed").toContain("C-3");
  });

  test("a spec section title carrying an SC number covers nothing — the parser differential", () => {
    // Security review of the first version of this fix, caught before merge.
    // `acCoversIds` also scanned `specElement` "for issues whose criteria
    // genuinely are SC-numbered", with a comment claiming it could only add
    // coverage for an id the criteria already carry. The comment was false.
    //
    // Spec section titles in this repo routinely contain SC numbers — one is
    // in this very fixture. An AC covering NOTHING was credited with SC-633,
    // and a criterion numbered SC-633 came back fully covered by an AC that
    // answers it in no way at all. A parser differential straight through the
    // control this issue had just installed.
    const title = real.acs[2].specElement!;
    expect(title, "the fixture no longer carries an SC number in a spec title").toContain("SC-633");

    const criteria = ["SC-633: something entirely unrelated to the draft lifecycle"];
    const coversNothing = [{ id: "AC-1", type: "CODE", coversCriteria: [], specElement: title }];
    expect(
      api.coverageViolations(criteria, coversNothing, []),
      "an AC that covers nothing was credited via its spec section title",
    ).toHaveLength(1);
  });

  test("an id no criterion defines satisfies nothing", () => {
    // Well-formed attribution naming ids this issue does not have. Stated as
    // a property rather than guarded by a filter: a filter was written here
    // and removed, because its mutation turned zero tests red — it could not
    // change any outcome, since an unknown token in the covered set is never
    // consulted. This case is what actually holds the property.
    const acs = real.acs.map(ac => ({ ...ac, coversCriteria: ["C-99", "SC-633"] }));
    expect(api.coverageViolations(real.successCriteria, acs, [])).toHaveLength(3);
  });

  test("a spec section title in coversCriteria covers nothing", () => {
    // The confusion #258 is about, stated as a case: if an agent puts the
    // specElement value in the attribution field, that must not count.
    const acs = real.acs.map(ac => ({ ...ac, coversCriteria: [ac.specElement!] }));
    expect(api.coverageViolations(real.successCriteria, acs, [])).toHaveLength(3);
  });

  test("an AC carries both fields, with different values", () => {
    // They are different things and a run proves it by holding both at once.
    const acs = attributed([[1], [2], [3], [], []]);
    expect(acs[0].specElement).toBe("A refusal reports the whole run, and leaves no mergeable PR (#252)");
    expect((acs[0] as any).coversCriteria).toEqual(["C-1"]);
    expect(api.coverageViolations(real.successCriteria, acs, [])).toEqual([]);
  });

  test("a deferral still covers an unnumbered criterion, and still needs a reason", () => {
    const acs = attributed([[1], [2], [], [], []]);
    expect(
      api.coverageViolations(real.successCriteria, acs, [
        { specElement: "C-3", reason: "deferred to a follow-up", subIssue: 259 },
      ]),
    ).toEqual([]);
    expect(
      api.coverageViolations(real.successCriteria, acs, [{ specElement: "C-3" }]),
      "a reasonless deferral bought silence on an unnumbered criterion",
    ).toHaveLength(1);
  });

  test("Discovery is REQUIRED to produce the attribution, not merely asked", () => {
    // An optional attribution field is an attribution nobody records, and
    // then every run refuses — the fail-closed half of this defect.
    const at = shipSource.indexOf("coversCriteria: { type: 'array'");
    expect(at, "the discovery schema has no coversCriteria field").toBeGreaterThan(-1);
    const required = shipSource.slice(at, at + 600);
    expect(
      required,
      "coversCriteria is optional, so the model may omit it and every run refuses",
    ).toContain("'evidenceMethod', 'coversCriteria'");
  });

  test("the prompt tells Discovery the run REFUSES, and names the two fields apart", () => {
    expect(shipSource).toContain("EVERY criterion above must appear in some AC's coversCriteria");
    expect(shipSource).toContain("specElement is a different field");
  });
});

/** Each builder throws if its substitution changed nothing, so a rename aborts. */
function mutate(find: string, replace: string): Api {
  if (!BLOCK.includes(find)) {
    throw new Error(`could not build the mutant: ${JSON.stringify(find)} appears 0 times in the block`);
  }
  return load(BLOCK.replace(find, replace));
}

describe("#251: the coverage check can fail", () => {
  test("a check that credits every criterion is caught", () => {
    // The #216 defect as a code change: coverage answers itself and the
    // six-of-seven run goes through.
    const m = mutate("if (covered.has(c.id) || covered.has(c.alias)) continue", "if (true) continue");
    expect(m.coverageViolations(SCS, SIX, [])).toEqual([]);
    expect(api.coverageViolations(SCS, SIX, []).length).toBeGreaterThan(0);
  });

  test("accepting a reasonless deferral is caught", () => {
    const m = mutate(
      "typeof d.reason === 'string' && d.reason.trim().length > 0",
      "true",
    );
    expect(m.coverageViolations(SCS, SIX, [{ specElement: sc(7) }])).toEqual([]);
    expect(api.coverageViolations(SCS, SIX, [{ specElement: sc(7) }]).length).toBeGreaterThan(0);
  });

  test("a refusal that reports a count instead of the text is caught", () => {
    // "6 of 7 covered" is the version of this that looks like it works.
    const m = mutate('"${scLabel(c.text, scIdOf(c.text))}"', "one criterion");
    expect(m.coverageViolations(SCS, SIX, []).join("\n")).not.toContain("mac-mini-live");
    expect(api.coverageViolations(SCS, SIX, []).join("\n")).toContain("mac-mini-live");
  });

  test("ranking by position instead of by what the criterion proves is caught", () => {
    // Renaming the predicate leaves `accepting` undefined at its call sites,
    // so the mutant throws rather than silently reverting to positional —
    // which is the abort-rather-than-pass outcome this harness wants.
    const m = mutate("const accepting = ac =>", "const unusedAccepting = ac =>");
    expect(() => m.prioritiseAcs(SEVEN, 6)).toThrow();
  });

  test("dropping the promotion reverts to the positional split", () => {
    const m = mutate("return first.concat(rest).slice(0, limit)", "return acs.slice(0, limit)");
    expect(m.prioritiseAcs(SEVEN, 6).map((a: Ac) => a.id)).not.toContain("AC-7");
    expect(api.prioritiseAcs(SEVEN, 6).map(a => a.id)).toContain("AC-7");
  });
});
