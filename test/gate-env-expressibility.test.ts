/**
 * Covers SC-1718..SC-1720 (GATE-CONTRACTS-SPEC.md), #297 SC-5 / #274 AC-6.
 *
 * #274 produced an acceptance criterion whose evidence is a piece of PROSE:
 * record in writing whether one consumer's test-environment-before-production
 * rule is expressible in rungate config, naming its test port, its production
 * port, an explicit verdict token, and the `ship.js` site that writes the
 * production environment record.
 *
 * A written answer is the easiest thing in this repo to ship dead. Nothing
 * executes it, nothing re-reads it, and the tree it describes moves
 * underneath it — which already happened: of the two sites #274 named, one no
 * longer exists and the other is half fixed. An answer written from the issue
 * text rather than from the source would have been wrong on the day it
 * landed, and nothing would have said so.
 *
 * So the three tests below do different jobs on purpose:
 *
 *   SC-1718 — the four elements are present (the literal AC, threshold == 4)
 *   SC-1719 — the two sites the answer DESCRIBES are re-measured from source,
 *             so the prose cannot drift away from the tree in silence
 *   SC-1720 — the gap the answer records is asserted as a fact about the
 *             source, so closing the gap turns this red rather than leaving a
 *             spec section confidently describing a problem somebody fixed
 *
 * SC-1719 and SC-1720 are the ones that matter. Without them this file is a
 * word search over a document, which is a check that passes because of what
 * it never looked at.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { anchorCitations, resolveCitation } from "../lib/source-anchor";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

const SPEC = read("specs/GATE-CONTRACTS-SPEC.md");

/**
 * The #297 section's PROSE, so a match elsewhere in a long spec cannot stand
 * in — and neither can the section's own success criteria.
 *
 * The SC lines are stripped, and that is not tidiness. An SC line quotes the
 * title of the test that claims it, so "the gate checks' own loader is still
 * monolith-only" appears in the criterion whether or not the paragraph above
 * still says it. Measured: deleting the phrase from the prose was **0 red**
 * until these lines came out, because the search was finding the SC line
 * demanding the phrase and reading it as the phrase being present. That is
 * the self-reference trap in `.claude/rules/checks-must-be-able-to-fail.md`,
 * and it has now caught this repo four times.
 */
const ANSWER = (() => {
  const start = SPEC.indexOf("## Is a consumer's test-environment-before-production gate expressible");
  if (start < 0) throw new Error("the #297 written answer is not in GATE-CONTRACTS-SPEC.md");
  const next = SPEC.indexOf("\n## ", start + 1);
  return SPEC.slice(start, next < 0 ? undefined : next)
    .split("\n")
    .filter(l => !/^\s*-\s*\[[ x]\]\s*SC-\d+:/.test(l))
    .join("\n");
})();

describe("#297 SC-5: the written answer, checked rather than trusted", () => {
  test("SC-1718: the written answer names both ports - the verdict token and the record-env site", () => {
    // AC-6's threshold is `== 4` elements. They are counted here rather than
    // asserted in a sentence, because "four things are present" is the
    // criterion and a reader should be able to see the count.
    const elements = {
      "test port": /\b7776\b/.test(ANSWER),
      "production port": /\b7777\b/.test(ANSWER),
      "verdict token": /\b(?:NOT-EXPRESSIBLE|PARTIALLY-EXPRESSIBLE|EXPRESSIBLE)\b/.test(ANSWER),
      // An ANCHOR citation since #514, not `ship.js:N`. AC-6's element is
      // "the answer names the ship.js site", and a citation that names what
      // the site SAYS satisfies it more strongly than one naming where the
      // site happened to sit on the day it was written.
      "record-env site": anchorCitations(ANSWER).some(c => c.path.endsWith("ship.js")),
    };
    const missing = Object.entries(elements).filter(([, present]) => !present).map(([k]) => k);
    expect(missing, `the answer is missing: ${missing.join(", ")}`).toEqual([]);
    expect(Object.values(elements).filter(Boolean).length).toBe(4);

    // The verdict has to be a token, not a paragraph a reader has to
    // interpret. "it depends" is the answer #274 was trying to prevent.
    expect(ANSWER).toContain("PARTIALLY-EXPRESSIBLE");

    // And the consumer is not named. The ports identify a configuration, not
    // a project; `test/anti.test.ts` SC-A1 is the rule and #304 is why.
    expect(ANSWER, "the written answer names a consumer").not.toContain("DailyBriefDashboard");
  });

  test("SC-1719: the answer describes the tree it is about - not the tree it was written from", () => {
    const ship = read("workflows/ship.js");

    // Claim 1: the `prod.rebuild = 'PASS'` site #274 named is GONE. If it
    // ever comes back, the answer's "that site is gone" paragraph becomes a
    // false statement in a spec, and this is the only thing that would say so.
    expect(
      /environments\.prod\.rebuild\s*=\s*'PASS'/.test(ship),
      "ship.js writes prod.rebuild = 'PASS' again — the #297 answer says it does not",
    ).toBe(false);

    // Claim 2: every production-record arm writes SKIP with a reason. A SKIP
    // with no reason is the same silence in a different word.
    //
    // Two spellings, and the first draft of this test only knew one. Two arms
    // assign the property (`…prod.rebuild = 'SKIP'`) and the third builds the
    // whole object (`…prod = {rebuild:'SKIP', …}`), so a regex anchored on
    // `=` counted 2 and would have reported the third arm as having been
    // changed — a detector narrower than what it detects, in a test whose
    // entire job is noticing that the tree moved.
    const skips = [...ship.matchAll(/\brebuild\s*[:=]\s*'SKIP'/g)];
    expect(skips.length, "the production record no longer has three SKIP arms").toBe(3);
    expect(
      [...ship.matchAll(/rebuildSkipReason\s*[:=]\s*'[^']+'/g)].length,
      "a SKIP arm lost its reason",
    ).toBe(3);

    // Claim 3: the sites the answer cites still exist and still say what the
    // answer says they say.
    //
    // By ANCHOR TEXT since #514, not by line number. The line-number form
    // cost three hand edits of five numbers across two PRs, and — measured
    // in #514 — three of this file's four UNGUARDED line citations were
    // already pointing at plausible wrong lines. An anchor that no longer
    // appears is a refusal; so is one that appears twice, because an
    // ambiguous citation is how a stale one lands somewhere believable.
    //
    // The historical site the answer discusses — the `prod.rebuild = 'PASS'`
    // write #274 named — stays prose ("line 4462 of ship.js as it then
    // stood"). A citation to a line that no longer exists is the point of
    // that paragraph, not a defect in it, and `resolveCitation` would
    // rightly refuse it.
    const cited = anchorCitations(ANSWER).filter(c => c.path.endsWith("ship.js"));
    expect(cited.length, "the answer cites no ship.js site at all").toBeGreaterThan(0);
    for (const cite of cited) {
      const r = resolveCitation(ROOT, cite);
      expect(r.ok, r.ok ? "" : `the #297 answer cites ${cite.path}@"${cite.anchor}" — ${r.reason}`).toBe(true);
      if (!r.ok) continue;
      // Resolving is not enough: a unique string somewhere unrelated in
      // ship.js would resolve perfectly and say nothing about the
      // production record. This is a different question from uniqueness and
      // each has an input only it reaches — an unrelated unique line passes
      // the resolver and fails here, and `containerConfig` alone passes here
      // and fails the resolver.
      expect(
        /prod\.rebuild|prod = \{rebuild|containerConfig|rebuildCmd|prod\.smoke/.test(r.text),
        `the #297 answer cites ${cite.path}@"${cite.anchor}", which resolves to line ${r.line} ` +
          `but says nothing about the production record or the container rebuild`,
      ).toBe(true);
    }

    // Claim 4: the loader side of #294 really is closed, which is the half
    // the answer reports as fixed.
    expect(read("lib/config-loader.ts")).toContain("parsed.dev?.testCmd ?? parsed.test?.command");
  });

  test("SC-1720: the gate checks' own loader is still monolith-only - and the suite check returns before asserting", () => {
    // The gap. Asserted as a fact about the source so that CLOSING it turns
    // this red: a spec section describing a problem somebody already fixed is
    // worse than no section, because the next reader plans around it.
    const checks = read("gates/workflow.test.ts");

    expect(
      /function loadProjectHarness[\s\S]{0,400}?"rungate\.json"/.test(checks),
      "gates/workflow.test.ts no longer builds the monolith path by hand — the #297 answer " +
        "records that it does, and needs updating along with .claude/config-access-ratchet.json",
    ).toBe(true);

    // The specific shape: a guard that returns before it can assert anything.
    // `tests-pass` is the check, and on a directory-layout consumer the
    // loader above hands it `null`, so it reports nothing at all.
    expect(checks).toContain("if (!harness?.dev?.testCmd) return;");

    // And the raw key, not the normalised one. If this stops matching, the
    // gate checks have been migrated and the answer's last section is stale.
    expect(
      checks.includes("harness?.dev?.testCmd"),
      "the gate checks read a normalised key now — update the #297 answer",
    ).toBe(true);

    // The answer must still be claiming this, so the two cannot drift apart
    // in the other direction either.
    expect(ANSWER).toContain("loadProjectHarness");
    expect(ANSWER).toContain("monolith-only");
  });
});
