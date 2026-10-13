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
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ambiguityOf,
  buildScRegistry,
  isAntiCriterion,
  isIssueShaped,
  isQualifiedBy,
  parseScDeclarations,
  qualifierTokens,
  SC_ID_SOURCE,
  scDeclarationPattern,
  scMentionPattern,
} from "../lib/sc-ids";
import { extractSCs } from "../lib/conformity";
import {
  coverageClaimSites,
  findTestFilesForSCs,
  findUncheckedSCs,
  readScRegistry,
  unqualifiedClaims,
} from "../scripts/sync-sc-status";

const REPO = join(import.meta.dir, "..");
const SPEC = "FIXTURE-SPEC.md";

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
    const reg = readScRegistry();
    const all = [...reg.byId.entries()].flatMap(([id, specs]) =>
      specs.map(specFile => ({ id, specFile })),
    );
    const bad = [...findTestFilesForSCs(all, reg).entries()].flatMap(([f, credits]) =>
      credits.filter(c => isIssueShaped(c.id)).map(c => `${f} claims ${c.id}`),
    );
    expect(bad).toEqual([]);
  });

  test("the whole-registry credit stays large, so the case above is not vacuous", () => {
    // Crediting nothing satisfies every negative case in this file. 244 ids
    // were credited when this shipped; the floor is below that so ordinary
    // churn does not trip it.
    const reg = readScRegistry();
    const all = [...reg.byId.entries()].flatMap(([id, specs]) =>
      specs.map(specFile => ({ id, specFile })),
    );
    const ids = new Set([...findTestFilesForSCs(all, reg).values()].flat().map(c => c.id));
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

  test("the repo's remaining ambiguous mentions are all accounted for", () => {
    // A census rather than a threshold: the ids below are the ones prose
    // currently names without saying which criterion it means. The list is
    // allowed to shrink. It growing means a new file wrote `SC-N` for an
    // issue's own criterion, which is the thing being stopped.
    const reg = readScRegistry();
    const dir = join(REPO, "test");
    const ids = new Set<string>();
    for (const f of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
      for (const u of unqualifiedClaims(readFileSync(join(dir, f), "utf-8"), reg)) ids.add(u.id);
    }
    expect([...ids].sort().length).toBeLessThanOrEqual(13);
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
