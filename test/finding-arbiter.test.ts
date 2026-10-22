/**
 * The filing arbiter, stage 1 (#1187).
 *
 * The suite is built around one requirement: **the gate must be able to
 * fail.** A filter that passes everything and a filter that works are
 * indistinguishable without a planted pair, so `arbitrate` is driven over a
 * known-good finding and a known-duplicate finding **through the same call
 * the production caller makes**, and the separation is the assertion
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The duplicate fixtures are excerpts of the two real pairs that motivated
 * the issue — #1175/#1177 and #1195/#1196 — carrying the sentences that hold
 * their measurements. Both pairs have **completely different titles**, which
 * is why `TITLE-SIMILARITY` below runs the cheapest wrong fix over the same
 * four bodies and records what it catches.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  arbitrate,
  arbitrateBatch,
  containedCitationPath,
  FILING_BUDGET_FINDINGS,
  citedLines,
  citedSymbols,
  duplicateOverlap,
  sharedKeys,
  symptomKeys,
  UNFILED_ID,
  type Finding,
} from "../lib/finding-arbiter";
import { SEVERITY_RANK, type VerifierVote } from "../lib/finding-jury";

/**
 * A full, agreeing verifier group.
 *
 * Every case below that expects a finding to survive supplies one, because
 * **an absent vote is UNMEASURED and UNMEASURED fails.** That is not
 * ceremony: a suite that could reach `COMMENT` without a jury would be
 * asserting the opposite of the gate it is testing.
 */
const AGREED: readonly VerifierVote[] = [
  { verifier: "v1", real: true, reason: "reproduced" },
  { verifier: "v2", real: true, reason: "reproduced" },
  { verifier: "v3", real: false, reason: "could not reproduce" },
];

// ── The two real duplicate pairs, excerpted ──────────────────────────────

const I1175: Finding = {
  id: "1175",
  title:
    "PROTECTED_FILES matches by basename with no notion of tree: 144 of 234 " +
    "newly-blocked commands are agents writing legitimate /tmp test fixtures",
  body:
    "`PROTECTED_FILES` in the Bash write guard matches by **basename**. Measured on a " +
    "5,060-command real corpus during the rework: of 234 commands the hardened guard " +
    "newly blocks, **144 are interpreter writes to `workflow-state.json` under " +
    "`mkdtemp` or `/tmp`.**\n\n" +
    "`specs/HOOK-ARCHITECTURE-SPEC.md` already defers the same question for the " +
    "`*.hook.ts` arm. Scoping to the project root makes every guard decision depend " +
    "on resolving that root, and `nonCanonicalRoots()` compared a canonicalised path " +
    "against an un-`resolve()`d root, breaking containment in `collectDestination` at " +
    "5 of 6 spellings.",
};

const I1177: Finding = {
  id: "1177",
  title:
    "`PROTECTED_FILES` matches by basename, so BashWriteGuard refuses 144 " +
    "legitimate test fixtures under `/tmp` and `mkdtemp`",
  body:
    "Sweeping 5,060 unique real commands through `lib/bash-write-guard.ts`:\n\n" +
    "| Reading | Count |\n|---|---|\n| newly blocked | 234 |\n" +
    "| of those, interpreter writes to a gate-artifact basename | **144** |\n\n" +
    "`PROTECTED_FILES` is tested with `String.includes` against a resolved-ish " +
    "target string. `specs/HOOK-ARCHITECTURE-SPEC.md` already defers exactly this " +
    "question. `nonCanonicalRoots()` compared a canonicalised path against an " +
    "un-`resolve()`d root, so containment broke in `collectDestination` — measured, " +
    "5 of 6 spellings. `WRITE_INTENT`'s docblock already warns about the failure mode.",
};

const I1195: Finding = {
  id: "1195",
  title:
    "PR introduced two guard defects, measured on merged main: an assignment prefix " +
    "flips 3 of 10 blocked writes to allowed, and cp/mv decisions depend on filesystem state",
  body:
    "`commandWord` now reads `dequote(stripHeredocs(segment))`. That is the right " +
    "direction — it is what fixes the case where `stripQuoted` deleted the verb " +
    "outright. But `dequote` keeps the bytes, so a quoted multi-word assignment value " +
    "survives the split.\n\n" +
    "Ten write commands, each run bare and again prefixed: 3 of 10 flip from blocked " +
    "to allowed, among them `chmod 777 …/hooks/x.hook.ts`. 15 further spellings were " +
    "swept. Tokenise quote-aware rather than dequoting then splitting: walk the " +
    "segment with `readWord`.\n\n" +
    "`isDirDestination` makes the decision from filesystem state. Delete " +
    "`isDirDestination` and the `statSync` import, and always push the destination " +
    "basename for every non-last argument. Assertions must be on `commandWord` and " +
    "`writeTargets` directly, not only through `decideBashWrite`.",
};

const I1196: Finding = {
  id: "1196",
  title: "Two regressions shipped to main, plus H6: `<<WORD` inside a quoted span drops the lines after it",
  body:
    "R1 — a quoted multi-word assignment prefix hides the verb. `commandWord` was " +
    "changed to read `dequote(stripHeredocs(segment))`; `dequote` strips the quote " +
    "characters but keeps the bytes, so a quoted assignment VALUE survives the " +
    "whitespace split.\n\n" +
    "WITNESS rows cover `chmod 777 <hook>` and the copying verbs; 15 spellings were " +
    "checked in total. The fix is to tokenise quote-aware so a quoted span stays " +
    "inside its word — `readWord` in the same module already does exactly this.\n\n" +
    "R2 — the decision depends on filesystem state at decision time. " +
    "`isDirDestination` calls `statSync`. The trailing-slash row isolates `statSync` " +
    "as the cause.",
};

describe("AR-1: dedupe keys on the measured symptom, not the title", () => {
  test("#1175 and #1177 are the same symptom under completely different titles", () => {
    const overlap = duplicateOverlap(I1175, I1177);
    expect(overlap.duplicate).toBe(true);
    // The readings, not the prose, are what agree.
    expect(overlap.keys).toContain("qty:144");
    expect(overlap.keys).toContain("qty:234");
    expect(overlap.keys).toContain("qty:5060");
    expect(overlap.keys).toContain("sym:PROTECTED_FILES");
  });

  test("#1195 and #1196 are the same symptom, filed one minute apart", () => {
    const overlap = duplicateOverlap(I1195, I1196);
    expect(overlap.duplicate).toBe(true);
    expect(overlap.keys).toContain("sym:commandWord");
    expect(overlap.keys).toContain("sym:isDirDestination");
    expect(overlap.keys).toContain("sym:statSync");
  });

  /**
   * THE CHEAPEST WRONG FIX, measured rather than argued.
   *
   * Token-Jaccard over titles at the usual 0.5 threshold catches **neither**
   * pair — 0.348 and 0.100. Over the 40-issue corpus these came from it
   * flags zero pairs of any kind. The row is here so that a later change
   * that quietly reverts to a title key goes red instead of looking cheaper.
   */
  test("TITLE-SIMILARITY: the cheap deduper catches 0 of 2", () => {
    const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
    const jaccard = (a: string, b: string) => {
      const [A, B] = [tokens(a), tokens(b)];
      const shared = [...A].filter(t => B.has(t)).length;
      return shared / (A.size + B.size - shared);
    };
    expect(jaccard(I1175.title, I1177.title)).toBeLessThan(0.5);
    expect(jaccard(I1195.title, I1196.title)).toBeLessThan(0.5);
  });

  test("a finding that cites the other by number is building on it, not duplicating it", () => {
    const citing: Finding = { ...I1177, id: "9999", body: `Follow-on from #1175.\n\n${I1177.body}` };
    expect(duplicateOverlap(citing, I1175).duplicate).toBe(false);
  });

  test("sharing an area of code without sharing a reading is not a duplicate", () => {
    // The shape that produced 17 false positives at a flat key threshold: two
    // findings naming the same functions in the same file, measuring nothing
    // in common.
    const other: Finding = {
      id: "8888",
      title: "A different defect in the same guard",
      body:
        "`commandWord` and `stripHeredocs` are also reached by the hook arm, and " +
        "`writeTargets` drops the operand. 41 spellings were swept, 7 newly blocked.",
    };
    expect(duplicateOverlap(other, I1195).duplicate).toBe(false);
    // ...and it does share the area, which is what makes this a control.
    expect(sharedKeys(other, I1195)).toContain("sym:commandWord");
  });
});

describe("AR-2: extraction refuses the shapes that are not readings", () => {
  test("an issue reference is not a quantity", () => {
    const keys = symptomKeys({ id: "x", title: "t", body: "Caused by #1188 and #1184, see SC-453." });
    expect(keys.filter(k => k.startsWith("qty:"))).toEqual([]);
  });

  test("a hyphenated filename does not yield three symbols", () => {
    const keys = symptomKeys({ id: "x", title: "t", body: "see `specs/HOOK-ARCHITECTURE-SPEC.md`" });
    expect(keys).not.toContain("sym:HOOK");
    expect(keys).not.toContain("sym:ARCHITECTURE");
    expect(keys).toContain("file:specs/hook-architecture-spec.md");
  });

  test("a path:line citation is read as a citation", () => {
    expect(citedLines({ id: "x", title: "t", body: "`hooks/BashWriteGuard.hook.ts:81` and `:115`" }))
      .toEqual([{ path: "hooks/BashWriteGuard.hook.ts", line: 81 }]);
  });
});

// ── A repository to read `origin/main` out of ────────────────────────────

let root = "";

/**
 * `git init` gives a repository with **no remote**, so `origin/main` does not
 * resolve and both repo-backed checks would report UNMEASURED for a reason
 * that is an artefact of the fixture rather than of the finding. The ref is
 * created explicitly for that reason.
 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "arbiter-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, "widget.ts"), Array.from({ length: 12 }, (_, i) =>
    i === 4 ? "export function widgetHandler() {" : `// line ${i + 1}`).join("\n"));
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const onMain = (body: string, id = "new"): Finding => ({ id, title: "a finding", body });
const opts = (extra: Record<string, unknown> = {}) => ({
  projectRoot: root,
  existing: [] as Finding[],
  votes: AGREED,
  ...extra,
});

describe("AR-3: branch scope is a reading, not a refusal", () => {
  /**
   * THE INVERSION. `OFF_MAIN` used to refuse. A finding about code that
   * exists only on the branch under review is not a bad finding — it is
   * exactly what an inline comment is for, and refusing it was the old
   * two-outcome world where the only alternative to an issue was nothing.
   */
  test("a symbol that exists only on an unmerged branch becomes a comment on that branch", () => {
    const v = arbitrate(onMain("`branchOnlyHelper` drops the operand in `widget.ts`."), opts());
    expect(v.scope).toBe("branch");
    expect(v.refusal).toBeNull();
    expect(v.disposition).toBe("COMMENT");
  });

  test("CONTROL: the same shape naming a symbol on origin/main reads main", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), opts());
    expect(v.scope).toBe("main");
    expect(v.disposition).toBe("COMMENT");
  });

  test("a branch-only finding can never be routed to ISSUE, however it is declared", () => {
    // It cannot be out-of-scope work for a PR whose branch is the only place
    // the symbol exists.
    const v = arbitrate(
      { ...onMain("`branchOnlyHelper` drops the operand."), outOfScope: { reason: "different subsystem" } },
      opts(),
    );
    expect(v.scope).toBe("branch");
    expect(v.disposition).toBe("COMMENT");
  });
});

describe("AR-4: citation currency — is this current?", () => {
  test("a line past the end of the file is dropped before any investigation", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `widget.ts:81` and again at `widget.ts:115`."), opts());
    expect(v.refusal).toBe("STALE_CITATION");
    expect(v.reason).toContain("widget.ts:81");
    expect(v.reason).toContain("12 lines");
    expect(v.disposition).toBe("DROP");
  });

  test("CONTROL: a line inside the file posts", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `widget.ts:5`."), opts());
    expect(v.disposition).toBe("COMMENT");
    expect(v.refusal).toBeNull();
  });
});

describe("AR-5: UNMEASURED fails, it never skips", () => {
  test("a finding with nothing extractable does not post", () => {
    const v = arbitrate({ id: "new", title: "it feels slow", body: "it feels slow lately" }, opts());
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.disposition).toBe("DROP");
  });

  test("a finding citing a reading but no symbol does not post", () => {
    const v = arbitrate(onMain("We saw 412 of these and then 913 more."), opts());
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.disposition).toBe("DROP");
  });

  test("an unreadable repository refuses rather than passing", () => {
    const barren = mkdtempSync(join(tmpdir(), "arbiter-barren-"));
    try {
      const v = arbitrate(onMain("`widgetHandler` drops the operand."), opts({ projectRoot: barren }));
      expect(v.refusal).toBe("UNMEASURED");
      expect(v.disposition).toBe("DROP");
      expect(v.reason).toContain("origin/main");
    } finally {
      rmSync(barren, { recursive: true, force: true });
    }
  });

  test("skipRepoChecks reports UNMEASURED, not a pass", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand."), opts({ skipRepoChecks: true }));
    expect(v.disposition).toBe("DROP");
    expect(v.refusal).toBe("UNMEASURED");
  });

  /**
   * THE ONE WITH NO ESCAPE HATCH. A finding nobody voted on has not cleared a
   * quorum; it has not had one. There is deliberately no `skipJury`, because
   * a caller may genuinely have no repository and no caller genuinely has no
   * verifiers.
   */
  test("no verifier group at all is UNMEASURED, not a quiet pass", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), {
      projectRoot: root,
      existing: [],
    });
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.disposition).toBe("DROP");
    expect(v.jury).toBeNull();
  });

  test("a short verifier group is UNMEASURED even when everyone present agreed", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), opts({
      votes: [{ verifier: "v1", real: true, reason: "yes" }, { verifier: "v2", real: true, reason: "yes" }],
    }));
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.jury?.agree).toBe(2);
  });

  test("a group that voted it down is NO_QUORUM — measured, and distinct from unreadable", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), opts({
      votes: [
        { verifier: "v1", real: true, reason: "yes" },
        { verifier: "v2", real: false, reason: "no" },
        { verifier: "v3", real: false, reason: "no" },
      ],
    }));
    expect(v.refusal).toBe("NO_QUORUM");
    expect(v.jury?.reading).toBe("MEASURED");
    expect(v.disposition).toBe("DROP");
  });

  test("a dropped category never reaches the repository checks", () => {
    const v = arbitrate(
      { id: "new", title: "Nit: rename the variable in widget.ts", body: "`widgetHandler` could be clearer." },
      opts(),
    );
    expect(v.refusal).toBe("DROPPED_CATEGORY");
    expect(v.category).toBe("style");
    // Reached before stage 4, so the branch-scope reading was never taken.
    expect(v.scope).toBeNull();
  });
});

describe("AR-6: the planted pair — the gate separates them under the real call", () => {
  /**
   * One batch, one `arbitrate` invocation per finding with identical options,
   * exactly as `scripts/arbitrate-finding.ts` calls it. A control run through
   * a convenience wrapper can be structurally sound and never ask the
   * question the production path asks.
   */
  test("a known-good finding files and a known-duplicate does not", () => {
    const filed: Finding = {
      id: "7001",
      title: "already filed",
      body: "`widgetHandler` mishandles 311 of 742 operands in `widget.ts`.",
    };
    const knownDuplicate: Finding = {
      id: "new-dup",
      title: "worded nothing like the one above",
      body: "Sweeping the corpus: 742 operands, of which `widgetHandler` mishandles 311.",
    };
    const knownGood: Finding = {
      id: "new-good",
      title: "an unrelated reading",
      body: "`widgetHandler` leaks 58 descriptors across 19 runs in `widget.ts`.",
    };

    const options = opts({ existing: [filed] });
    const dup = arbitrate(knownDuplicate, options);
    const good = arbitrate(knownGood, options);

    expect(dup.disposition).toBe("DROP");
    expect(dup.refusal).toBe("DUPLICATE");
    expect(dup.duplicateOf).toEqual(["7001"]);
    expect(dup.occurrences).toBe(2);
    // The refusal names its evidence, so it is reviewable rather than silent.
    expect(dup.collidingKeys).toContain("qty:311");
    expect(dup.collidingKeys).toContain("qty:742");

    expect(good.disposition).toBe("COMMENT");
    expect(good.refusal).toBeNull();

    // The separation itself, stated as one assertion: the gate let exactly
    // one of the two through.
    expect([dup, good].filter(v => v.disposition !== "DROP").length).toBe(1);
  });
});

describe("AR-7: the issue budget is rule-promotion's, not a second one", () => {
  // Each is DECLARED out of scope, which is the only route to ISSUE. The
  // budget caps filings because filings accumulate; comments are not capped
  // because a comment blocks the merge until it is answered.
  const batchOf = (n: number): Finding[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      title: `reading ${i}`,
      // Distinct readings, so none of these is a duplicate of another.
      body: `\`widgetHandler\` leaks ${100 + i} descriptors across ${900 + i} runs.`,
      outOfScope: { reason: "a different subsystem owns this" },
    }));

  test("a batch over budget is evicted by promoteCandidates, not filed", () => {
    const r = arbitrateBatch(batchOf(FILING_BUDGET_FINDINGS + 3), opts());
    expect(r.verdicts.every(v => v.disposition === "ISSUE")).toBe(true);
    expect(r.toFile.length).toBe(FILING_BUDGET_FINDINGS);
    expect(r.promotion.withheld.filter(w => w.reason === "OVER_BUDGET").length).toBe(3);
    expect(r.promotion.reading).toBe("MEASURED");
  });

  test("CONTROL: a batch under budget files all of it", () => {
    const r = arbitrateBatch(batchOf(FILING_BUDGET_FINDINGS - 2), opts());
    expect(r.toFile.length).toBe(FILING_BUDGET_FINDINGS - 2);
    expect(r.promotion.withheld).toEqual([]);
  });

  test("one UNMEASURED finding makes the whole batch reading UNMEASURED", () => {
    const r = arbitrateBatch([...batchOf(2), { id: "vague", title: "slow", body: "it feels slow" }], opts());
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.promotion.unmeasuredReasons.some(x => x.startsWith("vague:"))).toBe(true);
  });

  /**
   * THE DISCRIMINATOR IS CONSULTED, not merely computed.
   *
   * `promoteCandidates` returns a POPULATED `promoted` under an UNMEASURED
   * reading — only its `budget < 1` branch empties it. So this is the case
   * that separates "the batch reading was computed" from "the batch reading
   * decided anything", and without it `arbitrateBatch`'s own header claim —
   * that an unevaluable batch "does not report a measured zero" — would be
   * false while every other row here stayed green.
   */
  test("an UNMEASURED batch files nothing, even though the promoter still ranked a list", () => {
    const r = arbitrateBatch([...batchOf(2), { id: "vague", title: "slow", body: "it feels slow" }], opts());
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.promotion.promoted.length).toBeGreaterThan(0); // the shape being guarded against
    expect(r.toFile).toEqual([]);
  });

  test("comments come back ranked Important, Pre-existing, Nit", () => {
    const sev = (s: "Important" | "Nit" | "Pre-existing"): VerifierVote[] => [
      { verifier: "v1", real: true, reason: "y", severity: s },
      { verifier: "v2", real: true, reason: "y", severity: s },
      { verifier: "v3", real: true, reason: "y", severity: s },
    ];
    const mk = (id: string, n: number): Finding => ({
      id,
      title: `reading ${id}`,
      body: `\`widgetHandler\` leaks ${n} descriptors across ${900 + n} runs.`,
    });
    // Arbitrated one at a time so each carries its own severity, then ranked
    // the way the batch ranks.
    const got = [
      { v: arbitrate(mk("low", 10), opts({ votes: sev("Nit") })), id: "low" },
      { v: arbitrate(mk("high", 20), opts({ votes: sev("Important") })), id: "high" },
      { v: arbitrate(mk("old", 30), opts({ votes: sev("Pre-existing") })), id: "old" },
    ];
    expect(got.map(g => g.v.severity)).toEqual(["Nit", "Important", "Pre-existing"]);
    const ranked = [...got].sort((a, b) => SEVERITY_RANK[a.v.severity!] - SEVERITY_RANK[b.v.severity!]);
    expect(ranked.map(r => r.id)).toEqual(["high", "old", "low"]);
  });
});

describe("AR-8: checks run in cost order", () => {
  test("a duplicate is never paid a git grep", () => {
    const filed: Finding = { id: "7002", title: "filed", body: "`absentSymbolXyz` fails 311 of 742 times." };
    // The symbol is absent from origin/main, so stage 4 would read scope=branch.
    // The verdict is DUPLICATE, which is only reachable if stage 1 short-circuited.
    const v = arbitrate(
      { id: "new", title: "reworded", body: "742 runs, 311 failures in `absentSymbolXyz`." },
      opts({ existing: [filed] }),
    );
    expect(v.refusal).toBe("DUPLICATE");
    expect(v.scope).toBeNull();
  });

  test("a duplicate is never paid a verifier group either — the vote is the dearest instrument", () => {
    const filed: Finding = { id: "7003", title: "filed", body: "`absentSymbolXyz` fails 311 of 742 times." };
    const v = arbitrate(
      { id: "new", title: "reworded", body: "742 runs, 311 failures in `absentSymbolXyz`." },
      { projectRoot: root, existing: [filed] }, // no votes at all
    );
    expect(v.refusal).toBe("DUPLICATE");
  });

  test("citedSymbols is capped so an essay cannot cost an unbounded number of greps", () => {
    const body = Array.from({ length: 40 }, (_, i) => `\`someSymbol${i}X\``).join(" ");
    expect(citedSymbols(onMain(body)).length).toBeLessThanOrEqual(8);
  });

  /**
   * The asymmetry that ran the wrong way: the CHEAP probe was bounded and
   * the expensive one — a `readFileSync`, or a `git show origin/main:<path>`
   * per citation — was not.
   */
  test("citedLines is capped the same way, and the expensive probe is the one that needed it", () => {
    const body = Array.from({ length: 400 }, (_, i) => `\`lib/file${i}.ts:${i + 1}\``).join(" ");
    expect(citedLines(onMain(body)).length).toBeLessThanOrEqual(8);
  });
});

describe("AR-9: the incident that motivated #1187, driven through the real function", () => {
  /**
   * #1195 and #1196: the same symptom, filed **one minute apart** — close
   * enough that neither was in the tracker when the other was arbitrated.
   *
   * The first cut of `arbitrateBatch` compared every finding against a fixed
   * `options.existing` snapshot, so **both read as new** and the PR claiming
   * to close #1187 would not have stopped the incident it cites. These are
   * the real titles and bodies, fetched from the tracker and committed, not
   * a synthetic pair reworded to collide.
   */
  const incident = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "finding-incident-1195-1196.json"), "utf-8"),
  ) as Finding[];

  test("the fixture is the real pair", () => {
    expect(incident.map(f => f.id).sort()).toEqual(["1195", "1196"]);
    // Guards against the fixture being silently emptied, which would make
    // every row below pass vacuously.
    for (const f of incident) expect(f.body.length).toBeGreaterThan(1000);
  });

  test("the two share a measured symptom under completely different titles", () => {
    const [a, b] = incident;
    const overlap = duplicateOverlap(a, b);
    expect(overlap.duplicate).toBe(true);
    expect(overlap.keys).toContain("sym:commandWord");
    expect(overlap.keys).toContain("sym:isDirDestination");
    expect(overlap.keys).toContain("sym:statSync");
  });

  /**
   * THE PAIR IS THE TEST, NOT EITHER ROW.
   *
   * The row below runs the fixtures under their real ids, `1195` and `1196`,
   * and it was green on the merged code. The CLI does not produce that input:
   * it labels every unfiled finding `UNFILED_ID`, so the real batch is two
   * findings both carrying `"new"` — and the self-skip guard, keyed on the id
   * string, made each skip the other AS ITSELF. Measured on merged main: 2
   * survivors under `"new"`/`"new"`, 1 under the real ids. A case that is
   * green for a true reason about an input the production caller never sends
   * is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`.
   */
  test("BOTH IDS UNFILED — the input the CLI actually sends — still yields one survivor", () => {
    const asNew = incident.map(f => ({ ...f, id: UNFILED_ID }));
    const r = arbitrateBatch(asNew, opts({ existing: [] }));
    expect(r.toComment.length).toBe(1);
    expect(r.verdicts.filter(v => v.refusal === "DUPLICATE").length).toBe(1);
  });

  test("a finding is never a duplicate of itself, by reference, even when ids collide", () => {
    const [a] = incident;
    const self = arbitrate(a, opts({ existing: [a] }));
    expect(self.refusal).not.toBe("DUPLICATE");
  });

  test("ONE BATCH, EMPTY TRACKER: exactly one of them survives", () => {
    const r = arbitrateBatch(incident, opts({ existing: [] }));
    // One posts as a comment on the branch it describes; the other collides
    // with it INSIDE THE BATCH, which is the whole fix.
    expect(r.toComment.length).toBe(1);
    const duplicates = r.verdicts.filter(v => v.refusal === "DUPLICATE");
    expect(duplicates.length).toBe(1);
    expect(duplicates[0].duplicateOf.length).toBeGreaterThan(0);
  });

  test("MUTATION: against a fixed snapshot — the shape this replaced — both read as new", () => {
    // The cheapest wrong fix, performed and measured rather than described:
    // arbitrate each against the SAME empty snapshot, as the first cut did.
    const fixed = incident.map(f => arbitrate(f, opts({ existing: [] })));
    expect(fixed.filter(v => v.refusal === "DUPLICATE").length).toBe(0);
  });

  test("the walk order is pinned, so the survivor does not depend on array position", () => {
    const forwards = arbitrateBatch(incident, opts());
    const backwards = arbitrateBatch([...incident].reverse(), opts());
    const dupOf = (r: typeof forwards) => r.verdicts.find(v => v.refusal === "DUPLICATE")!.id;
    expect(dupOf(forwards)).toBe(dupOf(backwards));
  });
});

describe("AR-10: the dedupe threshold against a real long issue", () => {
  /**
   * The review's hypothesis: *"two shared quantities and one shared location
   * is an absolute threshold, and a long issue that happens to quote many
   * numbers matches almost anything."* Measured rather than accepted, over
   * today's 27 open issues:
   *
   *     gh issue list --repo hornjason/pai-harness --state open \
   *       --limit 400 --json number,title,body
   *
   * All pairs: **1 flagged of 351**, and it is the known class — #1187
   * against #1194, because #1187 quotes other findings' readings verbatim in
   * order to argue from them. The six issues with the most keys (40, 39, 26,
   * 19, 16, 13) were each run against an unrelated new finding and shared
   * **0 or 1** key, never reaching the threshold. #1205 and #1207, named in
   * the review as the shape to check, share **zero** keys with each other.
   *
   * So the fraction-of-the-smaller-set threshold the review proposed as the
   * fallback is **not** taken, and this row is why. The case below is the
   * regression: a key-rich finding must not collide with an unrelated one.
   */
  test("a key-rich finding does not collide with an unrelated one", () => {
    const keyRich: Finding = {
      id: "9100",
      title: "A long finding that quotes many readings",
      body:
        "`collectDestination`, `nonCanonicalRoots`, `PROTECTED_FILES`, `stripHeredocs`, `readWord` " +
        "in `lib/bash-write-guard.ts` and `specs/HOOK-ARCHITECTURE-SPEC.md`. Readings: 144, 234, " +
        "5060, 15, 777, 41, 62, 88, 91, 103, 117, 128, 139, 151, 166.",
    };
    const unrelated: Finding = {
      id: "new",
      title: "The release tag fetch depth drops annotated tags",
      body:
        "`fetchTagDepth` in `lib/release-tags.ts` requests 50 refs but the repo carries 312 tags, " +
        "so 262 annotated tags are invisible. Measured over 4 runs.",
    };
    expect(symptomKeys(keyRich).length).toBeGreaterThan(15);
    expect(duplicateOverlap(keyRich, unrelated).duplicate).toBe(false);
  });
});

describe("AR-11: the citation path is contained before anything is read", () => {
  /**
   * The input on this path is an AI reviewer's output — the one input here
   * nobody audits — and it reaches `readFileSync`. The regex cannot emit a
   * leading `/`, so an absolute path never arrives; `../` does, and
   * `../../../../Users/…/settings.json` carries an allowlisted extension.
   * The payoff is a line count and an existence oracle rather than content,
   * which is why this is a containment check and not a subsystem.
   */
  test("a traversing citation resolves to nothing", () => {
    expect(containedCitationPath(root, "../../../../Users/someone/.claude/settings.json")).toBeNull();
    expect(containedCitationPath(root, "a/../../escape.ts")).toBeNull();
  });

  /**
   * An absolute path is rejected BY CONTAINMENT, not by a second check.
   * `resolve(root, "/etc/hosts.json")` is `/etc/hosts.json`, which is not
   * under the root. A separate `isAbsolute` rejection was written, and
   * removing it changed 0 of 63 cases — so it was deleted rather than kept
   * as a guard no mutation could reach.
   */
  test("an absolute citation resolves to nothing, via the same one check", () => {
    expect(containedCitationPath(root, "/etc/hosts.json")).toBeNull();
  });

  test("CONTROL: an in-tree citation resolves, including through a harmless `..`", () => {
    expect(containedCitationPath(root, "lib/widget.ts")).toBe(join(root, "lib", "widget.ts"));
    expect(containedCitationPath(root, "lib/../widget.ts")).toBe(join(root, "widget.ts"));
  });

  test("a finding citing a traversing path is not refused for staleness it cannot have", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `../../../../etc/passwd.json:99999`."), opts());
    expect(v.refusal).not.toBe("STALE_CITATION");
  });
});

/**
 * The CLI's exit status IS the answer, so the exit codes are the contract and
 * are asserted by spawning the script rather than by calling the library it
 * wraps. `0` posts, `3` files, `1` drops — and the flip is visible right
 * here: the default outcome of a good finding is a comment.
 */
describe("AR-12: the CLI contract", () => {
  const script = join(import.meta.dir, "..", "scripts", "arbitrate-finding.ts");
  let scratch = "";

  const run = (args: string[]): { code: number; out: string } => {
    const r = Bun.spawnSync(["bun", script, "--project-root", root, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "arbiter-cli-"));
    writeFileSync(join(scratch, "votes.json"), JSON.stringify(AGREED));
    writeFileSync(join(scratch, "body.md"), "`widgetHandler` leaks 58 descriptors across 19 runs in `widget.ts`.");
    writeFileSync(join(scratch, "empty.json"), "[]");
    // The shape caught end-to-end: entries with neither `number` nor `id`.
    writeFileSync(join(scratch, "nameless.json"), JSON.stringify([{ title: "t", body: "b" }]));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const base = (extra: string[] = []) => [
    "--title", "an unrelated reading",
    "--body-file", join(scratch, "body.md"),
    "--existing", join(scratch, "empty.json"),
    ...extra,
  ];

  test("a good finding exits 0 and says COMMENT — filing is no longer the default", () => {
    const r = run(base(["--votes", join(scratch, "votes.json")]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("COMMENT");
  });

  test("the same finding declared out of scope exits 3 and says ISSUE", () => {
    const r = run(base(["--votes", join(scratch, "votes.json"), "--out-of-scope", "another subsystem owns it"]));
    expect(r.code).toBe(3);
    expect(r.out).toContain("ISSUE");
  });

  test("no --votes exits 1 — a finding nobody voted on has not cleared a quorum", () => {
    const r = run(base());
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
  });

  /**
   * A DUPLICATE withholds a finding, so it has to name WHERE the symptom is
   * already reported or it is not reviewable. A population entry with no
   * identifier produced `"already reported as undefined, undefined"` — a
   * refusal nobody can act on, which is worse than no refusal.
   */
  test("a population entry with no identifier refuses, rather than refusing by name of nothing", () => {
    const r = run([
      "--title", "an unrelated reading",
      "--body-file", join(scratch, "body.md"),
      "--existing", join(scratch, "nameless.json"),
      "--votes", join(scratch, "votes.json"),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
    expect(r.out).not.toContain("undefined, undefined");
  });

  test("--comment renders the posted text, carrying the obligation to answer", () => {
    const r = run(base(["--votes", join(scratch, "votes.json"), "--comment"]));
    expect(r.out).toContain("resolve this thread with a reason");
    expect(r.out).toContain("**Important**");
  });
});

/**
 * NON-TRANSITIVITY IS DELIBERATE, and this is the control that says so.
 *
 * A peer measuring this repo's tracker found that declared duplicates are
 * filed in CHAINS — #547 names #530, which is itself a duplicate — and that a
 * one-hop reader misses most of them. That is true of their instrument and
 * false of this one, and the difference is the whole reason this case exists:
 * **their links are DECLARED and this key's edges are INFERRED.** Transitivity
 * is sound over a declaration and unsound over a similarity.
 *
 * Measured over 220 issues from this tracker:
 *
 *     gh issue list --repo hornjason/pai-harness --state all --limit 220 \
 *       --json number,title,body,state,stateReason
 *
 * 37 edges, and **50 open two-paths** of exactly the shape below — so the
 * chain shape is common, not rare. Closing them transitively would merge the
 * largest connected component, which holds **12 manifestly different issues**
 * (a timezone-frame comparison, a test-census disagreement, a consumer
 * tarball test, a hook registration 178 commits behind) into one symptom,
 * withholding eleven real findings.
 *
 * The component is also held up by one node: **9 of its 12 edges touch #1187
 * itself**, which is an issue *about* other findings and quotes their
 * readings in order to argue from them. And the edges are weak — 3 to 5
 * shared keys, typically a commonly-cited rules file plus two incidental
 * integers — where both genuinely-duplicate pairs score **7**, and
 * #1195/#1196's seven include five symbols naming the same functions.
 *
 * So the greedy one-hop walk is the correct instrument here, and a later
 * change to a transitive or union-find dedupe is a regression. This case
 * turns that change red.
 */
describe("AR-13: the dedupe is one-hop on purpose", () => {
  // A and B share a reading; B and C share a different one; A and C share
  // only the file. The same shape as the 50 measured on the real tracker.
  const A: Finding = { id: "A", title: "alpha reading", body: "`alphaHandler` in `lib/x.ts` mishandles 111 of 222 operands." };
  const B: Finding = { id: "B", title: "both readings", body: "`alphaHandler` in `lib/x.ts` mishandles 111 of 222 operands, and `betaHandler` leaks 333 across 444 runs." };
  const C: Finding = { id: "C", title: "beta reading", body: "`betaHandler` in `lib/x.ts` leaks 333 descriptors across 444 runs." };

  test("the fixture is a chain, not a clique — the premise this rests on", () => {
    expect(duplicateOverlap(A, B).duplicate).toBe(true);
    expect(duplicateOverlap(B, C).duplicate).toBe(true);
    // The open edge. Without this the case would be about a clique and would
    // prove nothing about transitivity.
    expect(duplicateOverlap(A, C).duplicate).toBe(false);
  });

  test("a batch drops the middle and KEEPS both ends", () => {
    const r = arbitrateBatch([A, B, C].map(f => ({ ...f, id: UNFILED_ID })), opts({ existing: [] }));
    expect(r.verdicts.filter(v => v.refusal === "DUPLICATE").length).toBe(1);
    // Two survivors, not one. A transitive dedupe would return one here and
    // would be withholding a finding nothing says is a duplicate of anything.
    expect(r.toComment.length).toBe(2);
  });
});
