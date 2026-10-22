/**
 * What an SC id names, and what a mention of one claims (#330, #352, #358).
 *
 * Four files parsed SC ids with four different regexes. The divergence is
 * #330's stated root cause; it named two of the four.
 *
 *   lib/conformity.ts          extractSCs        `SC-\w+`
 *   scripts/sync-sc-status.ts  coverageClaimIds  `SC-\d+(?!\d)`
 *   scripts/sync-sc-status.ts  findUncheckedSCs  `SC-\d+`
 *   test/spec-sc-ids-unique.ts DECLARATION       `SC-\d+`
 *
 * Measured before the change, over `test/` and `specs/`:
 *
 *   251 registry ids were credited to at least one test file
 *   282 (file, id, spec) credits, because the flipper ticked a bare id in
 *       every spec declaring it
 *   7 of those ids — the single digits — were credited only by prose about
 *       a DIFFERENT issue's criteria
 *   6 anti-criteria were invisible to the lookup entirely
 *   4 ids were declared by more than one spec and nothing noticed
 *
 * After: 244 ids, 263 credits, 0 false single-digit credits, 0 false gains.
 * The exact lost/gained lists are in the PR.
 *
 * ## The notation, now stated rather than assumed
 *
 * `SC-<n>` is global; one spec owns the number.
 * `SC-A<n>` is an anti-criterion and per-spec by design — SPEC-TEMPLATE.md
 * ships `- [ ] SC-A1: [anti-criterion — must NOT happen]`, so every spec
 * numbers its own from A1.
 * An issue's own criteria are NOT SC ids. The harness numbers them
 * positionally, so an issue-prefixed reference to its own first criterion and
 * an issue-prefixed reference to a real three-digit registry id look
 * identical and mean opposite things.
 *
 * This file spells its examples in the 9000 range on purpose. A real id
 * written in a comment is credited as covered (#149's rule, unchanged for
 * unambiguous ids), so a test ABOUT the attribution rule would otherwise
 * certify the criteria it talks about — the self-reference this whole area
 * keeps producing.
 *
 * Covers SC-787..791 of CONFIG-DRIVEN-TESTING-SPEC.md.
 *
 * ## #392 extends this, and for the reason stated above
 *
 * The lower half of this file closes the hole the upper half left: "one spec
 * owns the number" was enforced over CHECKBOX declarations only, so ten ids
 * that GATE-CONTRACTS-SPEC.md owns as `### SC-N:` headings read as unique
 * while a second spec tracked each one. Covers SC-882..887 of
 * HARNESS-STANDARD.md.
 *
 * ## The renumbering #392 deferred, and what it changed here
 *
 * Those ten headings now live in a block no other spec holds, which empties
 * the `crossFormCollisions` bank and retires the qualification the credits
 * depended on. Two cases change shape as a result, and both changes are the
 * same point: a guard whose input has been fixed cannot keep proving itself
 * on that input. The end-to-end credit path moved onto a planted collision,
 * and the real tree now asserts the collision is absent — paired, in both
 * places, with a positive control, because an empty expectation passes just
 * as well when the detector has stopped detecting.
 *
 * The renumbering also created a hazard in the opposite direction. An
 * ambiguous number cannot be credited from a bare mention, so prose about
 * the collision was safe while the collision existed; making it unambiguous
 * means a declaring mention now ticks a live criterion that is false. Covers
 * SC-1410 and SC-1411 of HARNESS-STANDARD.md.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ambiguityOf,
  buildScRegistry,
  crossFormCollisions,
  crossSpecCollisions,
  isAntiCriterion,
  isIssueShaped,
  isQualifiedBy,
  parseScDeclarations,
  parseScHeadingDeclarations,
  qualifierTokens,
  requiresQualification,
  SC_ID_SOURCE,
  scDeclarationPattern,
  scMentionPattern,
} from "../lib/sc-ids";
import { extractSCs } from "../lib/conformity";
import { loadRungateConfig } from "../lib/config-loader";
import { nextSCNumber } from "../lib/create-sc";
import {
  coverageClaimSites,
  findTestFilesForSCs,
  findUncheckedSCs,
  readScRegistry,
  unqualifiedClaims,
  type ScCredit,
} from "../scripts/sync-sc-status";
import { scScanTestTimeout } from "./helpers/sc-scan-budget";

setDefaultTimeout(scScanTestTimeout());

const REPO = join(import.meta.dir, "..");
const SPEC = "FIXTURE-SPEC.md";

/**
 * The whole-registry credit map, computed once for the whole file (#1223).
 *
 * Two cases below ask the identical question — `findTestFilesForSCs(all,
 * reg)` over the real tree — and read different views of the one answer. It
 * is the most expensive reading in this file by an order of magnitude, and
 * it was being paid twice.
 *
 * Memoising it is safe HERE and is not safe inside `findTestFilesForSCs`,
 * which is why the sharing lives at the call site: this file's input is the
 * repository's own `test/` directory and its own registry, neither of which
 * moves during a run, while the scratch-directory callers rewrite their
 * input between calls. See `scanTestTree`.
 */
let wholeRegistryCreditMemo: Map<string, ScCredit[]> | null = null;

function wholeRegistryCredit(): Map<string, ScCredit[]> {
  if (wholeRegistryCreditMemo === null) {
    const reg = readScRegistry();
    const all = [...reg.byId.entries()].flatMap(([id, specs]) =>
      specs.map(specFile => ({ id, specFile })),
    );
    wholeRegistryCreditMemo = findTestFilesForSCs(all, reg);
  }
  return wholeRegistryCreditMemo;
}

const scratch = mkdtempSync(join(tmpdir(), "sc-ns-"));
function testDirWith(name: string, body: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.test.ts"), body);
  return dir;
}
function regWith(ids: string[], file = SPEC) {
  return buildScRegistry([
    { file, content: ids.map(i => `- [ ] ${i}: a fixture criterion\n`).join("") },
  ]);
}
function want(ids: string[], file = SPEC) {
  return ids.map(id => ({ id, specFile: file }));
}

describe("#330: one owner for the id pattern", () => {
  test("every reader is built from the same source string", () => {
    // The root cause was four regexes, so the property to assert is that
    // there is one. Both patterns must contain the shared definition
    // verbatim — a reader that rebuilt its own would not.
    expect(scDeclarationPattern().source).toContain(SC_ID_SOURCE);
    expect(scMentionPattern().source).toContain(SC_ID_SOURCE);
  });

  test("the declaration reader sees an anti-criterion", () => {
    // `SC-\d+` did not. That is how three specs came to declare SC-A1.
    const anti = ["SC", "A94"].join("-");
    const parsed = parseScDeclarations(`- [ ] ${anti}: must not happen\n`, SPEC);
    expect(parsed.map(p => p.id)).toEqual([anti]);
  });

  test("extractSCs and the registry agree on what a declaration is", () => {
    // They disagreed: `SC-\w+` against `SC-\d+`. Asserted over the real
    // corpus rather than a fixture, because the disagreement was in the
    // corpus and a fixture would have been written to agree.
    const specsDir = join(REPO, "specs");
    const files = readdirSync(specsDir, { recursive: true, encoding: "utf-8" })
      .filter(f => f.endsWith(".md") && !f.includes("SPEC-TEMPLATE"));
    expect(files.length).toBeGreaterThan(10);
    const viaExtract = new Set<string>();
    for (const f of files) {
      for (const sc of extractSCs(readFileSync(join(specsDir, f), "utf-8"), f)) {
        viaExtract.add(`${f}|${sc.id}`);
      }
    }
    const reg = readScRegistry();
    const viaRegistry = new Set(
      [...reg.byId.entries()].flatMap(([id, specs]) => specs.map(s => `${s}|${id}`)),
    );
    expect([...viaExtract].filter(k => !viaRegistry.has(k))).toEqual([]);
    expect([...viaRegistry].filter(k => !viaExtract.has(k))).toEqual([]);
  });

  test("a prose fragment is never creditable, however the pattern widens", () => {
    // #330 measured what `SC-\w+` additionally matches across test/:
    // SC-ID, SC-NNN, SC-TEST, SC-X, SC-guard, SC-numbered, SC-to, SC-S01.
    // The defence is not the regex — it is that a credit requires the
    // registry to declare the id, and none of these is ever declared.
    const dir = testDirWith(
      "prose",
      'test("SC-guard and SC-NNN and SC-TEST are prose", () => {});\n',
    );
    const reg = regWith(["SC-9201"]);
    expect([...findTestFilesForSCs(want(["SC-9201"]), reg, dir).keys()]).toEqual([]);
  });
});

describe("#330: coverage is scoped to the spec that owns the criterion", () => {
  test("a bare anti-criterion credits nothing, even in a title", () => {
    // Three specs declare SC-A1. Crediting a bare mention ticks all three.
    const anti = ["SC", "A95"].join("-");
    const dir = testDirWith("bare-anti", `test("${anti}: it holds", () => {});\n`);
    const reg = buildScRegistry([
      { file: "ONE-SPEC.md", content: `- [ ] ${anti}: a\n` },
      { file: "TWO-SPEC.md", content: `- [ ] ${anti}: b\n` },
    ]);
    const scs = [
      { id: anti, specFile: "ONE-SPEC.md" },
      { id: anti, specFile: "TWO-SPEC.md" },
    ];
    expect([...findTestFilesForSCs(scs, reg, dir).keys()]).toEqual([]);
  });

  test("a title naming the spec credits that spec and only that spec", () => {
    // The positive control. Without it, "credit nothing ambiguous" would
    // satisfy the case above and the anti-criteria could never be covered.
    const anti = ["SC", "A95"].join("-");
    const dir = testDirWith(
      "scoped-anti",
      `test("${anti} of ONE-SPEC: it holds", () => {});\n`,
    );
    const reg = buildScRegistry([
      { file: "ONE-SPEC.md", content: `- [ ] ${anti}: a\n` },
      { file: "TWO-SPEC.md", content: `- [ ] ${anti}: b\n` },
    ]);
    const scs = [
      { id: anti, specFile: "ONE-SPEC.md" },
      { id: anti, specFile: "TWO-SPEC.md" },
    ];
    expect([...findTestFilesForSCs(scs, reg, dir).values()].flat()).toEqual([
      { id: anti, specFile: "ONE-SPEC.md" },
    ]);
  });

  test("a qualified COMMENT is a citation, not a claim", () => {
    // The first version of the rule accepted this and gained two credits it
    // should not have: test/behavioral-sc-ratchet.test.ts opens with prose
    // naming SC-A1, SC-A2 and GITHUB-API-MIGRATION-SPEC.md in one sentence,
    // describing the bug this issue fixes. Every ingredient of a qualified
    // claim, and a citation. A window says WHICH criterion is meant; it
    // cannot say whether the mention is a claim.
    const anti = ["SC", "A96"].join("-");
    const dir = testDirWith(
      "cited",
      `// ${anti} in ONE-SPEC.md was missed by the old pattern\ntest("unrelated", () => {});\n`,
    );
    const reg = buildScRegistry([{ file: "ONE-SPEC.md", content: `- [ ] ${anti}: a\n` }]);
    expect([...findTestFilesForSCs([{ id: anti, specFile: "ONE-SPEC.md" }], reg, dir).keys()])
      .toEqual([]);
  });

  test("a file mentioning an id twice is credited once", () => {
    // Found by a mutation that scored 0 red: removing the dedup changed
    // nothing any test could see. A duplicate credit is not harmless —
    // `${credits.length} SCs` is printed as the count, and the report counts
    // entries rather than distinct criteria.
    const dir = testDirWith(
      "twice",
      '// covers SC-9210\ntest("SC-9210: and again", () => {});\n// SC-9210 once more\n',
    );
    const found = findTestFilesForSCs(want(["SC-9210"]), regWith(["SC-9210"]), dir);
    expect([...found.values()].flat()).toEqual([{ id: "SC-9210", specFile: SPEC }]);
  });

  test("an unambiguous id keeps its bare-comment credit", () => {
    // #149's rule, unchanged for the 737 ids it was right about. Tightening
    // every id to title-position would have been a migration, not a fix.
    const dir = testDirWith("plain", "// covers SC-9202\nconst x = 1;\n");
    expect([...findTestFilesForSCs(want(["SC-9202"]), regWith(["SC-9202"]), dir).values()].flat())
      .toEqual([{ id: "SC-9202", specFile: SPEC }]);
  });

  test("the spec's directory qualifies as well as its filename", () => {
    // bootstrap-data-flow/success-criteria.md is cited by its directory far
    // more often than by the filename every split spec shares.
    const dir = testDirWith(
      "by-dir",
      'test("SC-9203 of bootstrap-data-flow: it holds", () => {});\n',
    );
    const reg = buildScRegistry([
      { file: "bootstrap-data-flow/success-criteria.md", content: "- [ ] SC-9203: a\n" },
      { file: "OTHER-SPEC.md", content: "- [ ] SC-9203: b\n" },
    ]);
    const scs = [
      { id: "SC-9203", specFile: "bootstrap-data-flow/success-criteria.md" },
      { id: "SC-9203", specFile: "OTHER-SPEC.md" },
    ];
    expect([...findTestFilesForSCs(scs, reg, dir).values()].flat()).toEqual([
      { id: "SC-9203", specFile: "bootstrap-data-flow/success-criteria.md" },
    ]);
  });
});

describe("#358: an issue's own criterion is not the registry's", () => {
  test("every single-digit id is treated as ambiguous", () => {
    // Not a guess about notation — a property of the corpus. The harness
    // numbers an issue's criteria from 1, and all nine single digits are
    // declared by specs/bootstrap-data-flow/success-criteria.md.
    const reg = readScRegistry();
    for (let i = 1; i <= 9; i++) {
      const id = `SC-${i}`;
      expect(reg.byId.has(id), `${id} is no longer a registry id — re-check this rule`).toBe(true);
      expect(ambiguityOf(id, reg), id).toBe("issue-shaped");
    }
  });

  test("a many-digit id is not issue-shaped", () => {
    // SC-9640 cannot be an issue's 640th criterion, so it needs no qualifier
    // and #194's references to it keep crediting what they always did.
    expect(isIssueShaped("SC-9640")).toBe(false);
    expect(isIssueShaped("SC-1")).toBe(true);
    expect(isIssueShaped("SC-10")).toBe(false);
  });

  test("no test file is credited for a single-digit criterion", () => {
    // The outcome, measured on the repo. Before this change, SC-1..SC-7 were
    // credited by 16 file-mentions and every one was prose about a different
    // issue's criteria.
    const bad = [...wholeRegistryCredit().entries()].flatMap(([f, credits]) =>
      credits.filter(c => isIssueShaped(c.id)).map(c => `${f} claims ${c.id}`),
    );
    expect(bad).toEqual([]);
  });

  test("the whole-registry credit stays large, so the case above is not vacuous", () => {
    // Crediting nothing satisfies every negative case in this file. 244 ids
    // were credited when this shipped; the floor is below that so ordinary
    // churn does not trip it.
    const ids = new Set([...wholeRegistryCredit().values()].flat().map(c => c.id));
    expect(ids.size).toBeGreaterThan(200);
  });

  test("an uncredited ambiguous mention is reported, not silently dropped", () => {
    // Under-crediting is the safe direction and still a measurement error.
    // If nobody can see the number, nobody will ever qualify a mention.
    const reg = readScRegistry();
    const found = unqualifiedClaims(
      "// this is criterion 1 of #341, written as SC-1 by mistake\n",
      reg,
    );
    expect(found.map(f => f.id)).toEqual(["SC-1"]);
    expect(found[0].reason).toContain("criterion N of #NNN");
  });

  /**
   * The census comparison, as ONE binding (#392).
   *
   * It was inline in the real-tree case, and the mutation "compare lengths
   * rather than ids" scored ZERO red against it — today's list is exactly as
   * long as it is allowed to be, so the two readings agree on this tree and
   * only diverge when one id leaves as another arrives. An assertion that
   * cannot be made to fail on the data it runs against is the decorative
   * check `.claude/rules/checks-must-be-able-to-fail.md` is about.
   *
   * Extracted, the planted swap case below drives the same binding the real
   * tree does, and the mutation turns it red.
   */
  function unexpectedCensusIds(found: string[], census: string[]): string[] {
    return found.filter(id => !census.includes(id));
  }

  test("the repo's remaining ambiguous mentions are all accounted for", () => {
    // A census rather than a threshold: these are the ids prose currently
    // names without saying which criterion it means. The list is allowed to
    // shrink. It growing means a new file wrote `SC-N` for an issue's own
    // criterion, which is the thing being stopped.
    //
    // Named rather than counted (#392). This asserted a length of 13, and a
    // length cannot say WHICH — the two added here are a different cause
    // from the eleven below them, and under a count they would have been
    // indistinguishable from someone writing `SC-5` for an issue's criterion.
    //
    // Two ids left this list when GATE-CONTRACTS-SPEC.md's ten subsection
    // headings were renumbered into a block no other spec holds. They were
    // here because the registry had started reading `### SC-N:` headings and
    // two specs then declared each number, so prose ABOUT the collision read
    // as a claim on whichever criterion the reader guessed. #392 banked them
    // and said the fix was to renumber one side rather than qualify the
    // prose; that is now done, and the entries come out in the same change.
    const CENSUS = [
      "SC-1", "SC-2", "SC-3", "SC-4", "SC-5", "SC-6", "SC-7",
      "SC-A1", "SC-A2", "SC-A3", "SC-A4", "SC-A5", "SC-A6",
    ].sort();
    const reg = readScRegistry();
    const dir = join(REPO, "test");
    const ids = new Set<string>();
    for (const f of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
      for (const u of unqualifiedClaims(readFileSync(join(dir, f), "utf-8"), reg)) ids.add(u.id);
    }
    const found = [...ids].sort();
    expect(
      unexpectedCensusIds(found, CENSUS),
      "a new ambiguous SC mention appeared. Name its spec in a describe/test/it " +
        "title, or write an issue's own criterion as \"criterion N of #NNN\".",
    ).toEqual([]);
    expect(found.length, "the census is stale — remove what no longer appears").toBeLessThanOrEqual(CENSUS.length);
  });

  test("a SWAPPED id fails the census, where a count would not notice", () => {
    // Why the census names its ids, proven rather than argued. Measured:
    // replacing the id comparison above with a length comparison scores
    // ZERO red, because today's list is exactly as long as it is allowed to
    // be — the two readings only diverge when one id leaves as another
    // arrives, and that is the case a real tree reaches by someone fixing
    // one mention while adding a different one.
    //
    // Driven over a planted corpus, because the real tree cannot be made to
    // swap on demand and a case that cannot be staged is a case that never
    // runs.
    const reg = readScRegistry();
    const CENSUS = ["SC-1"];
    const dir = testDirWith(
      "census-swap",
      "// this is criterion 2 of #341, written as SC-2 by mistake\n",
    );
    const found = new Set<string>();
    for (const f of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
      for (const u of unqualifiedClaims(readFileSync(join(dir, f), "utf-8"), reg)) found.add(u.id);
    }
    // One in, one out: the length is unchanged and the content is not.
    expect([...found]).toEqual(["SC-2"]);
    expect([...found].length, "the swap changed the count, so this proves nothing")
      .toBe(CENSUS.length);
    expect(
      unexpectedCensusIds([...found], CENSUS),
      "an id comparison let a swapped id through",
    ).toEqual(["SC-2"]);
  });
});

describe("#352: the notation is enforced where ids are read", () => {
  test("an anti-criterion is recognised as per-spec", () => {
    expect(isAntiCriterion("SC-A1")).toBe(true);
    expect(isAntiCriterion("SC-1")).toBe(false);
    expect(isAntiCriterion("SC-9640")).toBe(false);
  });

  test("the four ambiguity kinds are distinct facts, not one bucket", () => {
    // "cannot be credited" was going to be one flag. They are different
    // problems with different fixes — a collision wants renumbering, an
    // anti-criterion wants qualifying, an issue-shaped id wants rewriting —
    // and a single flag would have made the report useless.
    const reg = buildScRegistry([
      { file: "ONE-SPEC.md", content: "- [ ] SC-9204: a\n- [ ] SC-A97: b\n- [ ] SC-1: c\n" },
      { file: "TWO-SPEC.md", content: "- [ ] SC-9205: d\n" },
      { file: "THREE-SPEC.md", content: "- [ ] SC-9205: e\n" },
    ]);
    expect(ambiguityOf("SC-9204", reg)).toBe("none");
    expect(ambiguityOf("SC-A97", reg)).toBe("per-spec");
    expect(ambiguityOf("SC-9205", reg)).toBe("multi-spec");
    expect(ambiguityOf("SC-1", reg)).toBe("issue-shaped");
    expect(ambiguityOf("SC-guard", reg)).toBe("not-a-criterion");
  });

  test("the qualifier window does not reach across a whole file", () => {
    // Otherwise any file mentioning a spec once qualifies every id in it,
    // and "scoped" means nothing.
    const far = `x`.repeat(600);
    const source = `// ONE-SPEC says things\n${far}\ntest("SC-9206 holds", () => {});\n`;
    const at = source.indexOf("SC-9206");
    expect(isQualifiedBy(source, at, "ONE-SPEC.md")).toBe(false);
    expect(isQualifiedBy(`// ONE-SPEC\ntest("SC-9206", () => {});`, 20, "ONE-SPEC.md")).toBe(true);
  });

  test("qualifier tokens are the filename and the containing directory", () => {
    expect(qualifierTokens("bootstrap-data-flow/success-criteria.md")).toEqual([
      "success-criteria",
      "bootstrap-data-flow",
    ]);
    expect(qualifierTokens("HARNESS-STANDARD.md")).toEqual(["HARNESS-STANDARD"]);
  });

  test("claim sites record where the claim was written", () => {
    // The kind is what separates a citation from a claim, so it is asserted
    // rather than trusted.
    const sites = coverageClaimSites(
      '// SC-9207 in prose\ntest("SC-9208: a title", () => {});\nconst x = [SC_9209];\n',
    );
    expect(sites.find(s => s.id === "SC-9207")?.kind).toBe("comment");
    expect(sites.find(s => s.id === "SC-9208")?.kind).toBe("title");
  });

  test("findUncheckedSCs reads the same declarations as the registry", () => {
    // It had its own `SC-\d+` copy — the fourth — so an unchecked
    // anti-criterion was never a candidate for flipping at all.
    const reg = readScRegistry();
    const orphans = findUncheckedSCs().filter(sc => !(reg.byId.get(sc.id) ?? []).includes(sc.specFile));
    expect(orphans.map(o => `${o.specFile}|${o.id}`)).toEqual([]);
    expect(findUncheckedSCs().length).toBeGreaterThan(50);
  });
});

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

// ───────────────────────────────────────────────────────────────────────────
// #392 — the namespace above is global, and only half of it was being read.
//
// `buildScRegistry` parsed `- [ ] SC-N:` lines and nothing else, so
// GATE-CONTRACTS-SPEC.md's ten `### SC-N:` subsection headings were invisible
// and ten ids read as unambiguous while two specs declared each. A comment
// reading `SC-388 (GATE-CONTRACTS-SPEC.md)` therefore ticked
// SCAFFOLD-DECOMPOSITION-SPEC.md's unrelated SC-388 — a criterion that is
// false. Second defect, same root: `nextSCNumber` allocated from ONE spec's
// content, which is how all ten numbers came to be issued twice.
//
// The 9000-range convention above applies here too, and for a sharper reason:
// a title pairing a REAL colliding id with a spec name is a qualified claim,
// which is exactly what credits a multi-spec id. The first draft did that and
// ticked the criterion this section exists to stop being ticked.
// ───────────────────────────────────────────────────────────────────────────

const SPECS_392 = join(REPO, "specs");
const TEST_392 = join(REPO, "test");

function specsOnDisk392(): Array<{ file: string; content: string }> {
  return readdirSync(SPECS_392, { recursive: true, encoding: "utf-8" })
    .filter(f => f.endsWith(".md"))
    .map(f => ({ file: f, content: readFileSync(join(SPECS_392, f), "utf-8") }));
}

describe("SC-882: a heading declares an id just as a checkbox does", () => {
  const BOTH_FORMS =
    "- [x] SC-9101: a checkbox\n\n### SC-9102: a heading\n\n#### SC-9103: a deeper heading\n";

  test("the two forms are parsed by two functions, and the tracked one is unchanged", () => {
    // The split is load-bearing, not tidiness. `parseScDeclarations` IS
    // `extractSCs` (lib/conformity.ts:339) — #330's one owner for what a
    // declaration is — and the conformity engine runs an assertion against
    // every declaration it is handed. The first version of this fix returned
    // headings from it, and ten GATE-CONTRACTS section titles became
    // criteria the gate tried to satisfy. A heading owns a NUMBER; it does
    // not state a checkable claim.
    expect(parseScDeclarations(BOTH_FORMS, "A-SPEC.md").map(d => [d.id, d.form, d.checked])).toEqual([
      ["SC-9101", "checkbox", true],
    ]);
    expect(parseScHeadingDeclarations(BOTH_FORMS, "A-SPEC.md").map(d => [d.id, d.form, d.checked])).toEqual([
      ["SC-9102", "heading", false],
      ["SC-9103", "heading", false],
    ]);
  });

  test("a heading is never reported as checked, whatever it says", () => {
    // There is no `- [x]` to read, so "done" has no source. A heading that
    // came back checked would satisfy a criterion by being titled.
    const decls = parseScHeadingDeclarations("### SC-9111: [x] done and dusted\n", "A-SPEC.md");
    expect(decls.map(d => d.checked)).toEqual([false]);
  });

  test("a heading is declared but NOT tickable, so the flipper can never reach it", () => {
    // The over-correction this guards against. If headings entered `byId` the
    // checkbox flipper would start ticking section titles, and
    // `crossSpecCollisions`'s real-tree assertion would go red over ten ids
    // nobody has decided how to renumber. Two maps, two questions.
    const reg = buildScRegistry([
      { file: "A-SPEC.md", content: "### SC-9104: a heading\n" },
    ]);
    expect(reg.byId.get("SC-9104"), "a heading became tickable").toBeUndefined();
    expect(reg.declaredById.get("SC-9104")).toEqual(["A-SPEC.md"]);
  });

  test("one spec declaring an id in both forms is one declarer, not a collision", () => {
    // GATE-CONTRACTS-SPEC.md itself does this and it is fine — a spec may
    // head a section with the id it also tracks. Counting the file twice
    // would make every such spec collide with itself.
    const reg = buildScRegistry([
      { file: "A-SPEC.md", content: "- [ ] SC-9105: tracked\n\n### SC-9105: and explained\n" },
    ]);
    expect(reg.declaredById.get("SC-9105")).toEqual(["A-SPEC.md"]);
    expect(crossFormCollisions(reg)).toEqual([]);
  });
});

describe("SC-883: an id two specs declare in any form needs a qualifier", () => {
  const planted = () =>
    buildScRegistry([
      { file: "GATE-SPEC.md", content: "### SC-9106: a gate's pass/fail criteria\n" },
      { file: "OTHER-SPEC.md", content: "- [ ] SC-9106: something else entirely\n" },
    ]);

  test("the heading makes it multi-spec, where it used to read as unambiguous", () => {
    expect(ambiguityOf("SC-9106", planted())).toBe("multi-spec");
    expect(requiresQualification("SC-9106", planted())).toBe(true);
  });

  test("the same id with no heading anywhere still needs no qualifier", () => {
    // The positive control. A rule that demanded a qualifier for every id
    // would satisfy the case above and break the 800-odd ordinary credits.
    const reg = buildScRegistry([
      { file: "OTHER-SPEC.md", content: "- [ ] SC-9106: something else entirely\n" },
    ]);
    expect(ambiguityOf("SC-9106", reg)).toBe("none");
    expect(requiresQualification("SC-9106", reg)).toBe(false);
  });
});

describe("SC-884: the reported false credit, and the renumbering that removed it", () => {
  /**
   * #392 banked the collision and said the fix was to renumber one side. That
   * is now done: GATE-CONTRACTS-SPEC.md's ten subsection headings moved to a
   * block no other spec holds, so the two specs that each declared SC-388 are
   * one spec again.
   *
   * Which changes what these cases have to prove. A real-tree assertion that
   * the collision EXISTS cannot survive its own fix, and rewriting it to
   * assert the collision is gone would leave the end-to-end credit path —
   * the actual bug — untested, because there is no longer a real input that
   * exercises it. So the path is driven over a PLANTED collision in a temp
   * tree, and the real tree gets the opposite assertion.
   *
   * No test title in this file pairs a real id with a spec name, and that is
   * not stylistic. A qualified title claim is exactly what credits a
   * multi-spec id, so a title naming SCAFFOLD-DECOMPOSITION beside its number
   * ticks the criterion this file exists to stop being ticked. The first
   * draft did, and the suite caught it — the same self-reference trap
   * `.claude/rules/claiming-sc-coverage.md` records catching itself.
   *
   * The trap is sharper now than it was, and in the opposite direction.
   * While the number was ambiguous, a bare comment mention credited nothing,
   * so prose about it was safe by accident. Renumbering made it unambiguous,
   * which means a mention in a declaring position now credits it for real —
   * over a criterion that is still false. The last case below is the guard.
   */
  const FORMERLY_COLLIDING = "SC-388";

  test("the renumbering landed — one spec declares the number again", () => {
    const reg = buildScRegistry(specsOnDisk392());
    const declarers = reg.declaredById.get(FORMERLY_COLLIDING) ?? [];
    expect(
      declarers,
      "two specs declare this number again. Renumber one side rather than " +
        "qualifying every mention of it.",
    ).toEqual(["SCAFFOLD-DECOMPOSITION-SPEC.md"]);
    expect(ambiguityOf(FORMERLY_COLLIDING, reg)).toBe("none");
  });

  test("a comment claim naming one spec credits nothing in another", () => {
    // The bug, end to end through the real matcher, over a planted tree.
    // The claim is a COMMENT, and a multi-spec id can only be claimed from a
    // title that names its spec, so it credits nothing.
    const dir = mkdtempSync(join(tmpdir(), "sc-884-"));
    try {
      writeFileSync(
        join(dir, "fixture.test.ts"),
        "// SC-9120 (GATE-SPEC.md)\nexport const x = 1;\n",
      );
      const reg = buildScRegistry([
        { file: "GATE-SPEC.md", content: "### SC-9120: a gate's pass/fail criteria\n" },
        { file: "OTHER-SPEC.md", content: "- [ ] SC-9120: something else entirely\n" },
      ]);
      const credited = findTestFilesForSCs(
        [{ id: "SC-9120", specFile: "OTHER-SPEC.md" }],
        reg,
        dir,
      );
      const everywhere = [...credited.entries()].flatMap(([file, cs]) =>
        cs.map(c => `${file} -> ${c.specFile}::${c.id}`),
      );
      expect(everywhere, "a claim naming one spec ticked a criterion in another").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same claim DOES credit once the collision is renumbered away", () => {
    // The positive control, and the thing the renumbering actually buys. A
    // matcher that refused every comment would satisfy the case above and
    // break the 800-odd ordinary credits; this is the same fixture with the
    // heading moved to a number nobody else holds.
    const dir = mkdtempSync(join(tmpdir(), "sc-884-ok-"));
    try {
      writeFileSync(
        join(dir, "fixture.test.ts"),
        "// SC-9120 (GATE-SPEC.md)\nexport const x = 1;\n",
      );
      const reg = buildScRegistry([
        { file: "GATE-SPEC.md", content: "### SC-9121: a gate's pass/fail criteria\n" },
        { file: "OTHER-SPEC.md", content: "- [ ] SC-9120: something else entirely\n" },
      ]);
      const credited = findTestFilesForSCs(
        [{ id: "SC-9120", specFile: "OTHER-SPEC.md" }],
        reg,
        dir,
      );
      expect((credited.get("fixture.test.ts") ?? []).map(c => c.id)).toEqual(["SC-9120"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the criterion it falsely certified is still unsatisfied", () => {
    // The regression, stated as the fact rather than as the checkbox: if the
    // project's rungate config ever grows a `keyFiles` field this test is the
    // one that says so, and the tick becomes legitimate.
    //
    // #1035: this read `.claude/rungate.json` by path, which ADR-001 Step E
    // deleted. `loadRungateConfig` reads whichever layout the project is on
    // and `ResolvedConfigSchema` is `.passthrough()`, so a `keyFiles` key
    // authored in `.claude/rungate/config.json` survives to be seen here —
    // a stripping validator would have made this arm permanently false and
    // the tick permanently illegitimate, which looks the same from outside.
    const cfg = loadRungateConfig(REPO) as Record<string, unknown>;
    const spec = readFileSync(join(SPECS_392, "SCAFFOLD-DECOMPOSITION-SPEC.md"), "utf-8");
    const ticked = spec.includes(`- [x] ${FORMERLY_COLLIDING}:`);
    expect(
      ticked,
      "the criterion is ticked but .claude/rungate.json has no keyFiles field",
    ).toBe("keyFiles" in cfg);
  });

  test("no file in test/ credits that criterion from a declaring position", () => {
    // What renumbering newly made possible, guarded rather than remembered.
    // The number is unambiguous now, so a mention of it on its own line, in
    // a label, or in a parenthetical credits a criterion that is FALSE — and
    // this file is the one most likely to write it, because the number is
    // its subject. Prose must keep it mid-sentence.
    const offenders: string[] = [];
    for (const f of readdirSync(TEST_392).filter(f => f.endsWith(".test.ts"))) {
      const sites = coverageClaimSites(readFileSync(join(TEST_392, f), "utf-8"));
      for (const s of sites) {
        if (s.id !== FORMERLY_COLLIDING) continue;
        if (s.kind === "title" || s.form) offenders.push(`${f} (${s.kind}/${s.form ?? "title"})`);
      }
    }
    expect(
      offenders,
      "a declaring mention credits an unticked criterion whose fact is false. " +
        "Move the id into the middle of a sentence.",
    ).toEqual([]);
  });
});

describe("SC-885: the tree holds no cross-form collisions, and cannot grow one", () => {
  /**
   * This shipped as a counted ratchet banked at ten, per
   * `.claude/rules/checks-must-be-able-to-fail.md`: the guard shipped red,
   * so the number was written down along with what it meant.
   *
   * GATE-CONTRACTS-SPEC.md headed ten subsections whose numbers four other
   * specs had each reissued as a tracked checkbox. #392 recorded that
   * renumbering was a spec-content decision — which side moves, and what
   * happens to the DUPLICATE heading GATE-CONTRACTS carried for its own
   * gate-executor contract — and deferred it. Both questions are now
   * answered: the headings moved to a block nobody else holds, and the
   * duplicate turned out to be a stale pre-#190 contract contradicting the
   * one above it, so it was removed rather than renumbered.
   *
   * The bank is therefore zero, and an empty expectation is the weakest kind
   * of assertion there is — it passes just as well if the detector stops
   * detecting. The two planted cases below are what keep it honest, and they
   * are the reason this reads as a ratchet rather than as a wish.
   */
  const KNOWN: string[] = [];

  test("no cross-form collision exists in the tree", () => {
    const found = crossFormCollisions(buildScRegistry(specsOnDisk392()))
      .map(c => c.split(" ")[0])
      .sort();
    expect(
      found,
      "a cross-form SC id collision appeared. The id is declared as a heading " +
        "in one spec and a checkbox in another, so a bare mention names two criteria. " +
        "Renumber it rather than adding it to this list.",
    ).toEqual([...KNOWN].sort());
  });

  test("the scan reads the real specs, so finding none means something", () => {
    // Without this the case above passes over an empty spec list, a changed
    // directory, or a reader that returns nothing — the assertion that holds
    // vacuously, shape 3 of checks-must-be-able-to-fail.md. It became load
    // bearing the moment the banked number reached zero.
    const reg = buildScRegistry(specsOnDisk392());
    expect(reg.declaredById.size, "no declarations were read at all").toBeGreaterThan(500);
    const headed = [...reg.declaredById.keys()].filter(
      id => !(reg.byId.get(id) ?? []).length,
    );
    expect(
      headed.length,
      "no heading-form declaration was read, so a cross-form collision could not be seen",
    ).toBeGreaterThan(5);
  });

  test("the checkbox-only collision guard still reports nothing, and still can", () => {
    // #330's guard is unchanged and must stay that way — widening IT is what
    // would have forced the renumbering. Proven able to fail alongside.
    expect(crossSpecCollisions(buildScRegistry(specsOnDisk392()))).toEqual([]);
    const planted = buildScRegistry([
      { file: "ONE.md", content: "- [x] SC-9107: a\n" },
      { file: "TWO.md", content: "- [ ] SC-9107: b\n" },
    ]);
    expect(crossSpecCollisions(planted)).toEqual(["SC-9107 declared by ONE.md and TWO.md"]);
  });

  test("the detector reads a cross-form collision when there is one", () => {
    const planted = buildScRegistry([
      { file: "ONE.md", content: "### SC-9108: a heading\n" },
      { file: "TWO.md", content: "- [ ] SC-9108: a checkbox\n" },
    ]);
    expect(crossFormCollisions(planted)).toEqual([
      "SC-9108 declared by ONE.md and TWO.md",
    ]);
    // And an anti-criterion is still per-spec by design, in both forms.
    const anti = buildScRegistry([
      { file: "ONE.md", content: "### SC-A94: a heading\n" },
      { file: "TWO.md", content: "- [ ] SC-A94: a checkbox\n" },
    ]);
    expect(crossFormCollisions(anti)).toEqual([]);
  });
});

/** Ids a single spec heads more than once. One declaration per number. */
function duplicateHeadingIds(content: string, specFile: string): string[] {
  const seen = new Map<string, number>();
  for (const d of parseScHeadingDeclarations(content, specFile)) {
    seen.set(d.id, (seen.get(d.id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
}

describe("SC-1411: no spec heads two subsections with the same id", () => {
  /**
   * The collision that forced the renumbering was not only cross-spec.
   * GATE-CONTRACTS-SPEC.md headed its own gate-executor contract TWICE under
   * one number, and the two blocks disagreed about the input and output
   * types — one of them describing a shape `gates/gate-executor.ts` does not
   * have and never had an entry point for.
   *
   * Nothing could see it. `crossFormCollisions` compares specs to each other,
   * and one file declaring a number twice is one declarer, which is correct
   * for the cross-spec question and blind to this one. So a stale contract
   * sat beside the live one from #190 until a renumbering read the headings
   * in order and found ten where there should have been nine.
   *
   * A duplicate heading is worse than a duplicate checkbox, which
   * `test/spec-sc-ids-unique.test.ts` already refuses: a checkbox at least
   * gets ticked or does not, whereas two contract blocks under one number
   * both read as authoritative and a reader cites whichever they scroll to.
   */
  test("no spec in the tree declares a heading id twice", () => {
    const offenders: string[] = [];
    for (const { file, content } of specsOnDisk392()) {
      for (const id of duplicateHeadingIds(content, file)) offenders.push(`${file}: ${id}`);
    }
    expect(
      offenders,
      "a spec heads two subsections with one id. Both read as the contract and " +
        "a reader cites whichever comes first — give one of them its own number, " +
        "or delete the stale one.",
    ).toEqual([]);
  });

  test("the detector reads a duplicate heading when there is one", () => {
    // Proven able to fail on every run. The real-tree case above is an empty
    // expectation now that the pair is resolved, and an empty expectation
    // passes just as well if the parser stops parsing.
    expect(
      duplicateHeadingIds(
        "### SC-9130: one contract\n\n### SC-9130: a contradicting contract\n",
        "A-SPEC.md",
      ),
    ).toEqual(["SC-9130"]);
  });

  test("a heading and a checkbox under one id in one spec is not a duplicate", () => {
    // The positive control, and the shape GATE-CONTRACTS legitimately uses: a
    // spec may head the section that explains a criterion it also tracks. A
    // detector that counted those would report every such spec and be
    // switched off within a week.
    expect(
      duplicateHeadingIds("- [ ] SC-9131: tracked\n\n### SC-9131: and explained\n", "A-SPEC.md"),
    ).toEqual([]);
  });

  test("the scan reaches the specs that actually use headings", () => {
    // Without this the real-tree case passes over a spec list that no longer
    // contains any heading declarations at all.
    const headed = specsOnDisk392().filter(
      s => parseScHeadingDeclarations(s.content, s.file).length > 0,
    );
    expect(headed.length, "no spec declares a heading, so nothing was examined").toBeGreaterThan(0);
    expect(
      headed.some(s => s.file.includes("GATE-CONTRACTS-SPEC")),
      "the spec this guard was written for declares no headings any more",
    ).toBe(true);
  });
});

describe("SC-887: the report says WHICH spec made the id ambiguous", () => {
  /**
   * Scored ZERO on the first mutation pass: pointing `unqualifiedClaims` back
   * at the checkbox map changed nothing any test could see. Everything above
   * asserts that an ambiguous id stops being credited; nothing asserted that
   * the developer is told why, and the reason is the only route from "my
   * claim was ignored" to "qualify it".
   *
   * Naming only the checkbox holder is worse than naming nothing. It reads
   * "declared by SCAFFOLD-DECOMPOSITION-SPEC.md — to claim it, name the spec
   * in a title", so the developer names the one spec that was never the
   * problem, the claim is still refused, and the message says the same thing
   * again.
   */
  test("an id made ambiguous by a heading reports the spec that heads it", () => {
    const reg = buildScRegistry([
      { file: "GATE-SPEC.md", content: "### SC-9109: a gate's criteria\n" },
      { file: "OTHER-SPEC.md", content: "- [ ] SC-9109: something else\n" },
    ]);
    const claims = unqualifiedClaims("// covers SC-9109\nexport const x = 1;\n", reg);
    expect(claims.map(c => c.id)).toEqual(["SC-9109"]);
    const reason = claims[0]!.reason;
    expect(reason).toContain("multi-spec");
    expect(reason, "the spec whose heading caused the ambiguity is unnamed").toContain("GATE-SPEC.md");
    expect(reason).toContain("OTHER-SPEC.md");
  });

  test("an unambiguous id is not reported at all", () => {
    // The positive control: a reporter that named every mention would satisfy
    // the case above and bury the real ones.
    const reg = buildScRegistry([
      { file: "OTHER-SPEC.md", content: "- [ ] SC-9109: something else\n" },
    ]);
    expect(unqualifiedClaims("// covers SC-9109\nexport const x = 1;\n", reg)).toEqual([]);
  });
});

describe("SC-886: ids are allocated out of the whole namespace, not one file", () => {
  test("nextSCNumber skips a number another spec already declares", () => {
    // The collision generator. Reading one spec's content, GATE-CONTRACTS saw
    // its own 378 and took 379 — which CONFIG-DRIVEN-TESTING had too.
    const reg = buildScRegistry([
      { file: "MINE.md", content: "- [x] SC-9110: mine\n" },
      { file: "THEIRS.md", content: "- [x] SC-9150: theirs\n" },
    ]);
    expect(nextSCNumber("- [x] SC-9110: mine\n", reg)).toBe(9151);
  });

  test("a heading in another spec blocks the number too", () => {
    const reg = buildScRegistry([
      { file: "MINE.md", content: "- [x] SC-9110: mine\n" },
      { file: "THEIRS.md", content: "### SC-9160: a section\n" },
    ]);
    expect(nextSCNumber("- [x] SC-9110: mine\n", reg)).toBe(9161);
  });

  test("with no registry it still behaves exactly as before", () => {
    // `scripts/create-sc.ts` is not the only caller forever, and silently
    // changing the one-argument answer would be a different bug.
    expect(nextSCNumber("- [x] SC-5: a\n- [ ] SC-9: b\n")).toBe(10);
    expect(nextSCNumber("no criteria here")).toBe(1);
  });

  test("the real tree allocates above every id it already declares, in either form", () => {
    const reg = buildScRegistry(specsOnDisk392());
    const next = nextSCNumber("", reg);
    const taken = [...reg.declaredById.keys()]
      .map(id => Number(id.replace(/^SC-[A-Z]?/, "")))
      .filter(Number.isFinite);
    expect(next).toBeGreaterThan(Math.max(...taken));
  });
});
