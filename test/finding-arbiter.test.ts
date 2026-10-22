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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  arbitrate,
  arbitrateBatch,
  FILING_BUDGET_FINDINGS,
  citedLines,
  citedSymbols,
  duplicateOverlap,
  sharedKeys,
  symptomKeys,
  type Finding,
} from "../lib/finding-arbiter";

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

describe("AR-3: branch scope — is this here?", () => {
  test("a symbol that exists only on an unmerged branch is a PR comment, not an issue", () => {
    const v = arbitrate(onMain("`branchOnlyHelper` drops the operand in `widget.ts`."), {
      projectRoot: root,
      existing: [],
    });
    expect(v.refusal).toBe("OFF_MAIN");
    expect(v.file).toBe(false);
  });

  test("CONTROL: the same shape naming a symbol on origin/main is not refused for scope", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), {
      projectRoot: root,
      existing: [],
    });
    expect(v.refusal).not.toBe("OFF_MAIN");
    expect(v.file).toBe(true);
  });
});

describe("AR-4: citation currency — is this current?", () => {
  test("a line past the end of the file is refused before any investigation", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `widget.ts:81` and again at `widget.ts:115`."), {
      projectRoot: root,
      existing: [],
    });
    expect(v.refusal).toBe("STALE_CITATION");
    expect(v.reason).toContain("widget.ts:81");
    expect(v.reason).toContain("12 lines");
  });

  test("CONTROL: a line inside the file files", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `widget.ts:5`."), {
      projectRoot: root,
      existing: [],
    });
    expect(v.file).toBe(true);
    expect(v.refusal).toBeNull();
  });
});

describe("AR-5: UNMEASURED fails, it never skips", () => {
  test("a finding with nothing extractable does not file", () => {
    const v = arbitrate({ id: "new", title: "it feels slow", body: "it feels slow lately" }, {
      projectRoot: root,
      existing: [],
    });
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.file).toBe(false);
  });

  test("a finding citing a reading but no symbol does not file", () => {
    const v = arbitrate(onMain("We saw 412 of these and then 913 more."), { projectRoot: root, existing: [] });
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.file).toBe(false);
  });

  test("an unreadable repository refuses rather than passing", () => {
    const barren = mkdtempSync(join(tmpdir(), "arbiter-barren-"));
    try {
      const v = arbitrate(onMain("`widgetHandler` drops the operand."), { projectRoot: barren, existing: [] });
      expect(v.refusal).toBe("UNMEASURED");
      expect(v.file).toBe(false);
      expect(v.reason).toContain("origin/main");
    } finally {
      rmSync(barren, { recursive: true, force: true });
    }
  });

  test("skipRepoChecks reports UNMEASURED, not a pass", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand."), {
      projectRoot: root,
      existing: [],
      skipRepoChecks: true,
    });
    expect(v.file).toBe(false);
    expect(v.refusal).toBe("UNMEASURED");
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

    const options = { projectRoot: root, existing: [filed] };
    const dup = arbitrate(knownDuplicate, options);
    const good = arbitrate(knownGood, options);

    expect(dup.file).toBe(false);
    expect(dup.refusal).toBe("DUPLICATE");
    expect(dup.duplicateOf).toEqual(["7001"]);
    expect(dup.occurrences).toBe(2);
    // The refusal names its evidence, so it is reviewable rather than silent.
    expect(dup.collidingKeys).toContain("qty:311");
    expect(dup.collidingKeys).toContain("qty:742");

    expect(good.file).toBe(true);
    expect(good.refusal).toBeNull();

    // The separation itself, stated as one assertion: the gate let exactly
    // one of the two through.
    expect([dup.file, good.file].filter(Boolean).length).toBe(1);
  });
});

describe("AR-7: the batch cap is rule-promotion's, not a second one", () => {
  const batchOf = (n: number): Finding[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      title: `reading ${i}`,
      // Distinct readings, so none of these is a duplicate of another.
      body: `\`widgetHandler\` leaks ${100 + i} descriptors across ${900 + i} runs.`,
    }));

  test("a batch over budget is evicted by promoteCandidates, not filed", () => {
    const r = arbitrateBatch(batchOf(FILING_BUDGET_FINDINGS + 3), { projectRoot: root, existing: [] });
    expect(r.verdicts.every(v => v.file)).toBe(true);
    expect(r.toFile.length).toBe(FILING_BUDGET_FINDINGS);
    expect(r.promotion.withheld.filter(w => w.reason === "OVER_BUDGET").length).toBe(3);
    expect(r.promotion.reading).toBe("MEASURED");
  });

  test("CONTROL: a batch under budget files all of it", () => {
    const r = arbitrateBatch(batchOf(FILING_BUDGET_FINDINGS - 2), { projectRoot: root, existing: [] });
    expect(r.toFile.length).toBe(FILING_BUDGET_FINDINGS - 2);
    expect(r.promotion.withheld).toEqual([]);
  });

  test("one UNMEASURED finding makes the whole batch reading UNMEASURED", () => {
    const r = arbitrateBatch([...batchOf(2), { id: "vague", title: "slow", body: "it feels slow" }], {
      projectRoot: root,
      existing: [],
    });
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.promotion.unmeasuredReasons.some(x => x.startsWith("vague:"))).toBe(true);
  });
});

describe("AR-8: checks run in cost order", () => {
  test("a duplicate is never paid a git grep", () => {
    const filed: Finding = { id: "7002", title: "filed", body: "`absentSymbolXyz` fails 311 of 742 times." };
    // The symbol is absent from origin/main, so stage 2 would refuse OFF_MAIN.
    // The verdict is DUPLICATE, which is only reachable if stage 1 short-circuited.
    const v = arbitrate({ id: "new", title: "reworded", body: "742 runs, 311 failures in `absentSymbolXyz`." }, {
      projectRoot: root,
      existing: [filed],
    });
    expect(v.refusal).toBe("DUPLICATE");
  });

  test("citedSymbols is capped so an essay cannot cost an unbounded number of greps", () => {
    const body = Array.from({ length: 40 }, (_, i) => `\`someSymbol${i}X\``).join(" ");
    expect(citedSymbols(onMain(body)).length).toBeLessThanOrEqual(8);
  });
});
