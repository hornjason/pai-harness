/**
 * Covers SC-2560..SC-2569 (SPEC-AUTHORING-SPEC.md).
 *
 * `lib/spec-evidence.ts` is a check, so the thing worth asserting is not that
 * it finds the planted defects — it is that **it can fail at all**. A guard
 * that returns an empty violation list for every input passes every
 * `toEqual([])` anyone writes against it and is indistinguishable from a
 * satisfied one (`.claude/rules/checks-must-be-able-to-fail.md`, third shape).
 *
 * So every negative case below is run TWICE against one input: once through
 * the real module, and once through a MUTANT copy with `evidenceViolations`
 * short-circuited to `return []` on its first line. Real red, mutant green,
 * same bytes in. That second assertion is the whole point — it is the
 * removal of the refusal, performed and observed, so a case that later starts
 * passing for an unrelated reason stops looking the same as a case that is
 * genuinely caught.
 *
 * Four properties are asserted rather than left as conventions:
 *
 * - **The mutation anchor appears exactly once**, so no path through the
 *   decider can survive by living at a second site.
 * - **The module has no relative imports**, so the mutant loads from a temp
 *   directory instead of dying on module resolution — a throw there would
 *   read as the mutation having been rejected on the merits.
 * - **The mutant and the real module are shown to differ on a named input
 *   first.** A row of zeros and a mutation that never applied look identical.
 * - **The parser's count is asserted before any verdict.** A parser that
 *   silently reads zero criteria makes every violation count vacuously green,
 *   and that is the shape that would make this entire file decorative.
 *
 * The positive control matters as much: a fully populated spec must produce
 * ZERO violations. Without it, "everything is a violation" passes every
 * negative case in the file.
 */

// SPEC-REF: SPEC-AUTHORING-SPEC.md § Success Criteria (SC-2560..SC-2569)

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EVIDENCE_KINDS,
  criterionFingerprint,
  evidenceViolations,
  parseCriteria,
  specDeclaresEvidence,
  type EvidenceViolation,
} from "../lib/spec-evidence.ts";

const MODULE = join(import.meta.dir, "..", "lib", "spec-evidence.ts");
const source = readFileSync(MODULE, "utf-8");

/** Pinned so the expiry case is a fact about the fixture, never about the clock. */
const TODAY = "2026-10-28";

/**
 * The single site the mutation removes.
 *
 * Injecting the short-circuit at the decider's first line means the parser,
 * the scope check and every violation push still EXIST in the mutant — only
 * the answer is suppressed. A mutant that deleted the body instead would be
 * measuring a damaged module rather than an absent refusal.
 */
const ANCHOR = "): EvidenceViolation[] {\n  if (!specDeclaresEvidence(content)) return [];";

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

const scratch = mkdtempSync(join(tmpdir(), "rungate-spec-evidence-mutant-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Build the mutant and import it.
 *
 * THROWS when the anchor is absent. A mutation harness that silently returns
 * an unmutated copy reports green over a mutation that never happened, which
 * is the exact failure this file exists to rule out one level down.
 */
async function loadMutant(): Promise<(c: string, t: string) => EvidenceViolation[]> {
  if (occurrences(source, ANCHOR) !== 1) {
    throw new Error(
      `the mutation anchor occurs ${occurrences(source, ANCHOR)} times in lib/spec-evidence.ts, ` +
        `expected exactly 1. Re-point ANCHOR in test/spec-evidence.test.ts at the decider's ` +
        `first line; a battery that cannot find its target proves nothing.`,
    );
  }
  const mutated = source.replace(
    ANCHOR,
    "): EvidenceViolation[] {\n  if (1 === 1) return [];\n  if (!specDeclaresEvidence(content)) return [];",
  );
  const path = join(scratch, "spec-evidence-mutant.ts");
  writeFileSync(path, mutated);
  const mod = await import(path);
  return mod.evidenceViolations;
}

const mutantViolations = await loadMutant();

/** Frontmatter that opts a fixture in. Everything below depends on it. */
const BOUND = `---
doc-type: spec
status: draft
owner: jason
evidence: required
testable: true
---

# Fixture

## Success Criteria

`;

function codes(violations: EvidenceViolation[]): string[] {
  return violations.map(v => v.code).sort();
}

/**
 * One negative case, observed through both modules.
 *
 * `expectedCodes` is asserted by NAME and not by count: "two violations" is
 * satisfied by any two, and only these two mean what the case claims.
 */
function bothWays(name: string, body: string, expectedCodes: string[]) {
  test(name, async () => {
    const content = BOUND + body;
    const real = evidenceViolations(content, TODAY);
    expect(codes(real), `real module on: ${name}`).toEqual([...expectedCodes].sort());
    expect(
      mutantViolations(content, TODAY),
      `the mutant answered non-empty on: ${name}. The short-circuit did not take ` +
        `effect, so the red above is not evidence the refusal is live.`,
    ).toEqual([]);
  });
}

describe("the decider can fail (mutation battery)", () => {
  test("the module has no relative imports, so the mutant resolves from a temp dir", () => {
    const relative = source.match(/^\s*import .* from ["']\.{1,2}\//gm) ?? [];
    expect(
      relative,
      "a relative import makes the mutant die on module resolution, and a throw there " +
        "reads as the mutation having been rejected on the merits. Keep lib/spec-evidence.ts " +
        "import-free.",
    ).toEqual([]);
  });

  test("the mutant and the real module differ on a named input", async () => {
    const content = `${BOUND}- [x] SC-2560: the gate refuses an unsigned payload.\n      needs: test\n`;
    expect(evidenceViolations(content, TODAY).length).toBeGreaterThan(0);
    expect(mutantViolations(content, TODAY)).toEqual([]);
  });

  // covers SC-2560
  bothWays(
    "SC-2560: a ticked criterion with no proved-by line at all is a violation",
    "- [x] SC-2560: the gate refuses an unsigned payload.\n      needs: test\n",
    ["TICKED_WITHOUT_EVIDENCE"],
  );

  // covers SC-2561
  bothWays(
    "SC-2561: a ticked criterion whose proved-by is BLANK is a violation, not a pass",
    "- [x] SC-2561: the loader throws on malformed JSON.\n      needs: test\n      proved-by:\n",
    ["EVIDENCE_BLANK"],
  );

  // covers SC-2562
  bothWays(
    "SC-2562: a criterion that never says what would prove it is a violation",
    "- [ ] SC-2562: the census names its denominator.\n",
    ["NEEDS_MISSING"],
  );

  // covers SC-2563
  bothWays(
    "SC-2563: an evidence kind outside the closed set is a violation, not a pass",
    "- [ ] SC-2563: the reviewer reads the diff.\n      needs: vibes\n",
    ["NEEDS_UNKNOWN"],
  );

  // covers SC-2564
  bothWays(
    "SC-2564: a waiver with an empty reason is a violation — lobster's hole, closed",
    "- [x] SC-2564: the tag is immutable.\n      needs: review\n      waived-reason:\n" +
      "      waived-by: jason\n      waived-until: 2027-01-01\n",
    ["WAIVER_INCOMPLETE"],
  );

  // covers SC-2565
  bothWays(
    "SC-2565: a waiver with no expiry is a violation",
    "- [x] SC-2565: the tag is immutable.\n      needs: review\n" +
      "      waived-reason: the registry is read-only this quarter\n      waived-by: jason\n",
    ["WAIVER_INCOMPLETE"],
  );

  // covers SC-2566
  bothWays(
    "SC-2566: a waiver whose expiry has passed is a violation again",
    "- [x] SC-2566: the tag is immutable.\n      needs: review\n" +
      "      waived-reason: the registry is read-only this quarter\n      waived-by: jason\n" +
      "      waived-until: 2026-10-27\n",
    ["WAIVER_EXPIRED"],
  );

  // covers SC-2575
  bothWays(
    "SC-2575: a ticked criterion with evidence and no fingerprint is a violation",
    "- [x] SC-2575: the loader throws on malformed JSON.\n      needs: test\n" +
      "      proved-by: test/config-loader.test.ts\n",
    ["FINGERPRINT_MISSING"],
  );

  // covers SC-2567
  bothWays(
    "SC-2567: evidence recorded against a different wording is stale",
    "- [x] SC-2567: the loader throws on malformed JSON.\n      needs: test\n" +
      '      proved-by: test/config-loader.test.ts "refuses malformed"\n' +
      "      fingerprint: deadbeef\n",
    ["EVIDENCE_STALE"],
  );
});

describe("the controls — what must NOT fire", () => {
  test("SC-2568: a fully populated criterion produces zero violations", () => {
    const text = "the loader throws on malformed JSON.";
    const content =
      `${BOUND}- [x] SC-2568: ${text}\n      needs: test\n` +
      '      proved-by: test/config-loader.test.ts "refuses malformed"\n' +
      `      fingerprint: ${criterionFingerprint(text)}\n`;
    expect(
      evidenceViolations(content, TODAY),
      "the positive control is the one that separates a check from a refusal of everything. " +
        "Without it, every negative case above is satisfied by a decider that always refuses.",
    ).toEqual([]);
  });

  test("an unticked criterion that declares its needs is not yet owed evidence", () => {
    const content = `${BOUND}- [ ] SC-2569: the census names its denominator.\n      needs: measurement\n`;
    expect(evidenceViolations(content, TODAY)).toEqual([]);
  });

  test("a complete, unexpired waiver clears", () => {
    const content =
      `${BOUND}- [x] SC-2569: the tag is immutable.\n      needs: review\n` +
      "      waived-reason: the registry is read-only until the Q1 migration lands\n" +
      "      waived-by: jason\n      waived-until: 2027-01-01\n";
    expect(evidenceViolations(content, TODAY)).toEqual([]);
  });

  test("SC-2569: the SAME broken content is clean when the spec has not opted in", () => {
    const broken = "- [x] SC-2569: the gate refuses an unsigned payload.\n";
    const unbound = BOUND.replace("evidence: required\n", "") + broken;
    expect(specDeclaresEvidence(unbound)).toBe(false);
    expect(
      evidenceViolations(unbound, TODAY),
      "grandfathering must be observable, not asserted: this is the identical criterion " +
        "that reddens under `evidence: required` above.",
    ).toEqual([]);
    // And the contrast is one variable. Same bytes, plus the opt-in, must redden —
    // otherwise the clean reading measured the fixture and not the scope rule.
    expect(evidenceViolations(BOUND + broken, TODAY).length).toBeGreaterThan(0);
  });

  test("every live spec in the tree is unaffected until it opts in", () => {
    const { readdirSync } = require("fs") as typeof import("fs");
    const dir = join(import.meta.dir, "..", "specs");
    const bound = readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .filter(f => specDeclaresEvidence(readFileSync(join(dir, f), "utf-8")));
    // The count is allowed to grow — this asserts the MECHANISM, not a ratchet:
    // a spec is bound only by its own frontmatter, so no existing document can be
    // dragged in by a change to this module.
    for (const f of bound) {
      const violations = evidenceViolations(readFileSync(join(dir, f), "utf-8"), TODAY);
      expect(
        violations.map(v => `${v.id}: ${v.message}`),
        `specs/${f} declares \`evidence: required\` and does not satisfy it.`,
      ).toEqual([]);
    }
  });
});

describe("the parser saw what it thinks it saw", () => {
  test("it reads the criteria rather than silently reading zero", () => {
    const content =
      `${BOUND}- [x] SC-2560: one.\n      needs: test\n      proved-by: a\n` +
      "- [ ] CRC-M12: two.\n      needs: measurement\n";
    const parsed = parseCriteria(content);
    expect(parsed.map(c => c.id)).toEqual(["SC-2560", "CRC-M12"]);
    expect(parsed[0].ticked).toBe(true);
    expect(parsed[1].ticked).toBe(false);
    expect(parsed[1].needs).toBe("measurement");
  });

  test("a wrapped criterion hashes as one sentence, so a reflow is not a change", () => {
    const oneLine = "- [ ] SC-2560: the gate refuses an unsigned payload outright.\n      needs: test\n";
    const wrapped =
      "- [ ] SC-2560: the gate refuses an unsigned\n      payload outright.\n      needs: test\n";
    expect(criterionFingerprint(parseCriteria(BOUND + oneLine)[0].text)).toBe(
      criterionFingerprint(parseCriteria(BOUND + wrapped)[0].text),
    );
  });

  test("moving a clause into the wrap still changes the text it hashes", () => {
    const a = parseCriteria(`${BOUND}- [ ] SC-2560: the gate refuses an unsigned payload.\n`)[0];
    const b = parseCriteria(`${BOUND}- [ ] SC-2560: the gate ACCEPTS an unsigned payload.\n`)[0];
    expect(criterionFingerprint(a.text)).not.toBe(criterionFingerprint(b.text));
  });

  test("an audit-specs REVIEW marker does not sever a criterion from its evidence", () => {
    // `audit-specs --fix` writes this line, unindented, between the criterion
    // and its annotations in any spec with `compliance: strict` whose wording
    // matches no registry pattern — which is every criterion in
    // SPEC-AUTHORING-SPEC.md. A parser that stopped here would report the
    // whole document as evidence-free, and the reading would be identical to
    // a document that genuinely recorded none.
    const text = "the loader throws on malformed JSON.";
    const content =
      `${BOUND}- [x] SC-2560: ${text}\n` +
      "<!-- REVIEW: unmatched (no registry pattern was close enough) -->\n" +
      "      needs: test\n      proved-by: test/config-loader.test.ts\n" +
      `      fingerprint: ${criterionFingerprint(text)}\n`;
    const [parsed] = parseCriteria(content);
    expect(parsed.needs).toBe("test");
    expect(parsed.provedBy).toBe("test/config-loader.test.ts");
    expect(evidenceViolations(content, TODAY)).toEqual([]);
  });

  test("the evidence kinds are a closed set and the message names them", () => {
    expect([...EVIDENCE_KINDS]).toEqual(["test", "measurement", "run", "review"]);
    const content = `${BOUND}- [ ] SC-2563: x.\n      needs: guesswork\n`;
    const [v] = evidenceViolations(content, TODAY);
    for (const kind of EVIDENCE_KINDS) expect(v.message).toContain(kind);
  });
});
