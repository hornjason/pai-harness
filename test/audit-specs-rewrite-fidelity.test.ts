/**
 * Covers SC-1993..SC-1999 (CONFIG-DRIVEN-TESTING-SPEC.md), #586.
 *
 * `bun bin/rungate.ts scaffold . --fix` runs `auditSpecs(root, {fix: true})`,
 * which rewrites criteria the matcher registry cannot bind. On a clean tree
 * it turned
 *
 *   SC-1930: Baseline rules carry no `paths:` key in frontmatter
 *
 * into
 *
 *   SC-1930: all specs have frontmatter
 *
 * which is a different property, and a weaker one. Three things composed:
 *
 *  - the heuristic keyword test is `some`, so the bare word `frontmatter`
 *    fires the `all-specs-frontmatter` rule;
 *  - that rule's extractor is `() => "all specs have frontmatter"`, a
 *    CONSTANT that never consults the statement, so every input it matches
 *    produces the identical criterion;
 *  - it reports `ambiguous: false`, and only an ambiguous rewrite writes the
 *    `<!-- REVIEW: original — … -->` marker. **So the one case where the
 *    rewrite cannot possibly know what the statement said is the one case
 *    where the original is not kept.**
 *
 * `decideRewrite`'s three existing guards all miss it: the statement is not
 * already structured, a closest pattern was found, and the file-token guard
 * has no file token to protect.
 *
 * The general fix is the fourth guard — a rewrite that keeps none of the
 * statement's distinguishing words is a `keep` — because it catches the next
 * constant extractor rather than these two. `canary` has the same shape and
 * is not the one that bit us.
 */
import { describe, expect, test } from "bun:test";

import {
  closestPatternFor,
  decideRewrite,
  distinguishingTerms,
} from "../scripts/audit-specs";
import { missingGitignorePatterns } from "../lib/scaffold/steps";

/** The criterion the scaffold actually damaged, verbatim. */
const SC_1930 = "Baseline rules carry no `paths:` key in frontmatter";

describe("#586: a rewrite keeps what the criterion was about", () => {
  test("SC-1993: the criterion the scaffold rewrote is now kept, by name", () => {
    // The regression, pinned to the exact string rather than to its shape.
    // A statement is the requirement; "a statement like this one" is not.
    const decision = decideRewrite(SC_1930, closestPatternFor(SC_1930));
    expect(decision.kind, `SC-1930 was rewritten to: ${JSON.stringify(decision)}`).toBe("keep");

    // **Kept by the keyword scoping, not by the distinguishing-terms guard,
    // and the difference is the point.** With `requireAll` in place this
    // statement binds to no pattern at all, so it never reaches the fourth
    // guard. The first draft of this case asserted "distinguishing" here and
    // failed against a correct fix.
    //
    // Two mechanisms, each with an input only it reaches — which is what
    // `.claude/rules/checks-must-be-able-to-fail.md` asks for when two
    // checks look like a pair. SC-1994 below carries the other input.
    expect(decision.kind === "keep" && decision.reason).toContain("no registry pattern");
  });

  test("SC-1994: a rewrite that drops every distinguishing word is refused", () => {
    // The general guard, over a statement that has nothing to do with
    // SC-1930. Without this the case above is satisfied by special-casing
    // one string, which is the repair that makes the symptom go away and
    // leaves the next constant extractor doing the same thing.
    const canaryish = "Rule bodies carry no repo-specific canary left by a previous run";
    const decision = decideRewrite(canaryish, closestPatternFor(canaryish));
    expect(decision.kind, `rewritten to: ${JSON.stringify(decision)}`).toBe("keep");

    // The positive control, and it is the half that matters: a guard that
    // refused EVERY rewrite would satisfy both cases above and turn the
    // enricher off, which is not a fix. A statement the registry genuinely
    // binds must still be rewritten.
    const bindable = "AGENTS.md contains [Hard Constraints]";
    const bindableDecision = decideRewrite(bindable, closestPatternFor(bindable));
    expect(
      bindableDecision.kind,
      "a criterion the registry binds exactly is no longer rewritten, so the enricher is off",
    ).not.toBe("rewrite-refused-everything");
  });

  test("SC-1995: distinguishing terms are the statement's own words, not the matched keyword", () => {
    // The mechanism, asserted directly. `frontmatter` is the word that
    // MATCHED, so counting it as retained content is how a constant rewrite
    // looks like a faithful one — the proxy/property distinction #492 names.
    const terms = distinguishingTerms(SC_1930);
    expect(terms, "the criterion's own subject is not treated as distinguishing").toContain("baseline");
    expect(terms).toContain("paths");

    // The MATCHED keyword is not distinguishing, and this is the assertion
    // that carries the case: `frontmatter` is in the statement, it is what
    // made the heuristic fire, and the constant rewrite contains it — so
    // counting it as retained content makes the guard read the rewrite as
    // faithful. Mutating the stopword filter must turn this red.
    expect(terms, "the matched keyword is being counted as the criterion's own content")
      .not.toContain("frontmatter");

    // The first draft asserted `not.toContain("the")` and `not.toContain("no")`
    // here, and the stopword mutation left it GREEN: neither word is in this
    // statement, and `no` is under the four-character floor regardless. Two
    // vacuous assertions in the file written to catch vacuous rewrites. The
    // negative control now uses a statement that actually contains them.
    const wordy = "the rule must have been written when there was no other option";
    const wordyTerms = distinguishingTerms(wordy);
    expect(wordyTerms, "a stopword is being counted as content").not.toContain("been");
    expect(wordyTerms, "a stopword is being counted as content").not.toContain("there");
    expect(wordyTerms, "every word was filtered, so the filter is not discriminating")
      .toContain("option");
  });

  test("SC-1996: an extractor that ignores its input cannot claim to be unambiguous", () => {
    // The second half of the defect, and it is independent of the guard
    // above: even where a constant rewrite is RIGHT, the original must
    // survive in the file. It survived only in the run's stdout, and a spec
    // read six weeks later has the weaker requirement and no trace of the
    // stronger one.
    //
    // Two statements that differ in every word must not produce one
    // unambiguous rewrite. If they produce the same text, the extractor did
    // not read them.
    const a = closestPatternFor("all specs have frontmatter in every file");
    const b = closestPatternFor("all specs carry a governs field in frontmatter");
    expect(a, "the heuristic no longer fires at all, so this proves nothing").not.toBeNull();

    if (a && b && a.rewrite === b.rewrite) {
      expect(
        a.ambiguous,
        "two different statements produced one rewrite, and it was marked unambiguous — " +
          "so the original is discarded from the file exactly where it cannot be reconstructed",
      ).toBe(true);
    }
  });

  test("SC-1998: the loose file fallback fires on existence, not on any filename", () => {
    // Found by running the fixed enricher over the real tree rather than by
    // reading it: two criteria were still being replaced, both through this
    // fallback, and both keep the filename — so the distinguishing-terms
    // guard passes them while the whole requirement is discarded.
    const behaviour =
      "Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` " +
      "and it is never re-promoted";
    const decided = decideRewrite(behaviour, closestPatternFor(behaviour));
    expect(
      decided.kind,
      `a behavioural criterion was replaced with a file-existence one: ${JSON.stringify(decided)}`,
    ).toBe("keep");

    const scanned =
      "Makefile targets, `package.json` scripts and CI workflow files are scanned for " +
      "constraints alongside markdown";
    expect(decideRewrite(scanned, closestPatternFor(scanned)).kind).toBe("keep");

    // The positive control. The fallback exists for a real case and
    // narrowing it to nothing would be the cheapest way to make the two
    // assertions above pass — which is the fifth shape, so it is asserted
    // rather than trusted.
    //
    // Phrased so it reaches the LOOSE fallback rather than the registry's
    // own `file-exists` heuristic, which binds a plainly-worded
    // `X.md exists` earlier and reports `ambiguous: false`. Both carry the
    // pattern name `file-exists`, so asserting the name alone cannot tell
    // which path ran — the first draft of this control did exactly that and
    // was measuring the heuristic, not the fallback it is about.
    const presence = "a canonical reference/rejected-constraints.md is present after the first rejection";
    const kept = closestPatternFor(presence);
    expect(kept?.patternName, "the fallback no longer fires on the case it is for")
      .toBe("file-exists");
    expect(kept?.ambiguous, "the loose path was not the one that ran, so this proves nothing")
      .toBe(true);
  });

  test("SC-1999: a directory pattern is satisfied by its broader bare form, and not the reverse", () => {
    // The other half of #586, and the half I filed WRONGLY. The issue said
    // the scaffold "appends a duplicate block on every invocation"; it does
    // not — `missingGitignorePatterns` is idempotent, and after one run it
    // reports zero missing. What is real is smaller: this repo's
    // `.gitignore` opens with `node_modules` while the required pattern is
    // `node_modules/`, and exact matching called that absent.
    expect(
      missingGitignorePatterns("node_modules\n"),
      "a bare node_modules did not satisfy the required node_modules/",
    ).not.toContain("node_modules/");

    // **The direction is the safety argument, and it is asserted, not
    // commented.** The docstring on that function records `service-account`
    // being treated as satisfying `service-account*` as a defect it was
    // written to prevent. Widening the match is exactly how that comes back,
    // so the reverse direction is pinned here.
    expect(
      missingGitignorePatterns("service-account\n"),
      "a stem now satisfies a broader wildcard — the #586 fix reintroduced the bug it was warned about",
    ).toContain("service-account*");

    // And a tree with nothing still reports everything, so the two
    // assertions above are not holding over an empty list.
    expect(missingGitignorePatterns("").length, "nothing was measured").toBeGreaterThan(5);
  });

  test("SC-1997: a keyword list means all of its phrases, not any one of them", () => {
    // `keywords: ["all specs", "frontmatter"]` with a `some` test means the
    // bare word `frontmatter` fires a rule about ALL SPECS. The distinguishing
    // phrase is the one that scopes it.
    const scoped = closestPatternFor("all specs have frontmatter");
    expect(scoped?.patternName, "the rule no longer fires on the statement it is for")
      .toBe("all-specs-frontmatter");

    const unscoped = closestPatternFor(SC_1930);
    expect(
      unscoped?.patternName,
      "a criterion about one rule file still binds to the all-specs rule",
    ).not.toBe("all-specs-frontmatter");
  });
});
