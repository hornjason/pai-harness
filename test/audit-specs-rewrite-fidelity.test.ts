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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import {
  auditSpecs,
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

  test("SC-1998: the loose file fallback downgrades, and records that it did", () => {
    // Found by running the fixed enricher over the real tree rather than by
    // reading it: two criteria are replaced through the loose fallback, and
    // both keep the filename — so the distinguishing-terms guard passes them
    // while the requirement itself becomes a file-existence check.
    //
    // **This is a downgrade, not a loss, and #586 is about loss.** The
    // fallback reports `ambiguous: true`, which is what writes
    // `<!-- REVIEW: original — … -->` beside the rewritten line, so the
    // statement it replaced is still in the file. #426 kept this path for
    // exactly that reason and pinned it in SC-1587 and SC-1594.
    //
    // The first draft of this case narrowed the fallback to statements whose
    // verb is existence. It turned both of those criteria red — a fix for a
    // defect that is real but is a DIFFERENT defect, filed rather than
    // folded in. What is pinned here instead is the property that makes the
    // downgrade survivable: the marker.
    //
    // **#589 closed the filed defect, and the DECISION half of this case
    // moved with it.** The two criteria below are now KEPT, by
    // `coordinatedClaims` — each coordinates a second claim that
    // `<file> exists` cannot be about — and `test/audit-specs-fallback-scope.test.ts`
    // owns that. What stays here is what this case was always for: the
    // fallback reports `ambiguous: true`, so wherever it DOES rewrite, the
    // statement it replaced is written beside the line. The vacuity control
    // below therefore drives a statement the fallback still acts on.
    const behaviour =
      "Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` " +
      "and it is never re-promoted";
    const closest = closestPatternFor(behaviour);
    expect(closest?.patternName, "the fallback no longer fires on the case it is for")
      .toBe("file-exists");
    expect(
      closest?.ambiguous,
      "a behavioural criterion is replaced by a file-existence one AND the original is " +
        "not written beside it — the rewrite is now unrecoverable",
    ).toBe(true);
    const scanned =
      "Makefile targets, `package.json` scripts and CI workflow files are scanned for " +
      "constraints alongside markdown";
    expect(closestPatternFor(scanned)?.ambiguous).toBe(true);

    // The vacuity control: the fallback must still rewrite SOMETHING, or the
    // `ambiguous` assertions above are about a flag nothing ever reads. This
    // is the statement #426 pinned as having to survive, and #589's own
    // positive control.
    const single = "the generator should emit a tidy CODE-MAP.md for every project";
    const singleClosest = closestPatternFor(single);
    expect(singleClosest?.ambiguous, "the fallback stopped marking its rewrites for review")
      .toBe(true);
    expect(
      decideRewrite(single, singleClosest).kind,
      "nothing is rewritten, so the marker assertions above hold vacuously",
    ).toBe("rewrite");

    // The negative control, because every `ambiguous` in the registry being
    // `true` would satisfy the assertions above while saying nothing. A
    // statement the registry binds EXACTLY is unambiguous — there is nothing
    // to review — so the two flags have to be distinguishable.
    const exact = closestPatternFor("AGENTS.md contains [Hard Constraints]");
    expect(exact?.ambiguous, "every pattern reports ambiguous, so the flag carries no information")
      .toBe(false);
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

/**
 * Covers SC-2001, SC-2002 (CONFIG-DRIVEN-TESTING-SPEC.md), #586 AC-2.
 *
 * Everything above drives `decideRewrite` directly, which is the decision.
 * These two drive the WRITE, because the decision was already right for every
 * criterion below and the file still lost them.
 *
 * Two faults, and they are fixed together because fixing either one alone is
 * worse than fixing neither:
 *
 *  - the marker is suppressed by `modified.includes(marker)`, a test over the
 *    WHOLE FILE. Two criteria declined for the same reason — "no registry
 *    pattern was close enough", which is the commonest reason there is — and
 *    only the first is marked. Measured: four unmatched criteria, one marker.
 *  - the line is edited with `String.replace(re, string)`, so `$'`, `$&` and
 *    `$1` in a criterion are expanded by the regex engine.
 *
 * Un-suppressing the marker without escaping the replacement makes the
 * corruption reach three criteria instead of one, which is why the two cases
 * sit beside each other rather than in separate commits.
 */
describe("SC-2001: the REVIEW marker goes below the criterion, never into it", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "audit-specs-marker");

  /** Four statements the registry cannot bind, so all four are `keep`s. */
  const KEPT: Array<[string, string]> = [
    ["SC-9401", "Baseline rules carry no $' key in frontmatter"],
    ["SC-9402", "Baseline rules carry no $& key in frontmatter"],
    ["SC-9403", "Baseline rules carry no $1 key in frontmatter"],
    ["SC-9404", "Baseline rules carry no `owner:` key in frontmatter"],
  ];
  /** A criterion the rewriter genuinely acts on. The control. */
  const REWRITTEN = ["SC-9405", "the generator should emit a tidy CODE-MAP.md for every project"] as const;

  function plant(): string {
    mkdirSync(join(FIXTURE, "specs"), { recursive: true });
    const path = join(FIXTURE, "specs", "MARKER-SPEC.md");
    writeFileSync(
      path,
      `---\ndoc-type: spec\nstatus: active\ntestable: true\ncompliance: strict\n` +
        `updated: 2026-10-17\ngoverns: the #586 marker fixture\n---\n\n# Marker Spec\n\n` +
        `## Success Criteria\n\n` +
        [...KEPT, REWRITTEN].map(([id, s]) => `- [ ] ${id}: ${s}`).join("\n") +
        `\n`,
    );
    return path;
  }

  beforeEach(() => { if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true }); });
  afterEach(() => { if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true }); });

  test("SC-2001: a declined criterion's line is untouched and the marker is the line after it", () => {
    const path = plant();
    const result = auditSpecs(FIXTURE, { fix: true });
    const lines = readFileSync(path, "utf-8").split("\n");

    // The run has to have DECLINED all four, or the assertions below are
    // about a classification that never happened.
    const kept = (result.rewrites ?? []).filter(r => r.kept);
    expect(kept.map(r => r.scId).sort(), "the fixture no longer produces four declined criteria")
      .toEqual(KEPT.map(([id]) => id));

    for (const [id, statement] of KEPT) {
      const at = lines.indexOf(`- [ ] ${id}: ${statement}`);
      expect(at, `${id}'s line is not in the file verbatim — the fix run rewrote a criterion it kept`)
        .toBeGreaterThan(-1);
      expect(lines[at + 1], `${id} carries no REVIEW marker on the line below it`)
        .toMatch(/^<!-- REVIEW: unmatched \(.+\) -->$/);
    }

    // The control, and it is the half that stops "never write anything" from
    // passing: a criterion the registry CAN bind is still rewritten, and its
    // original is still written beside it.
    const [rid, rstatement] = REWRITTEN;
    const rat = lines.indexOf(`- [ ] ${rid}: CODE-MAP.md exists`);
    expect(rat, "the rewriter stopped rewriting, so the assertions above prove nothing")
      .toBeGreaterThan(-1);
    expect(lines[rat + 1]).toBe(`<!-- REVIEW: original — ${rstatement} -->`);
  });

  test("SC-2002: two criteria declined for the same reason each get a marker", () => {
    // The suppression, stated as a count rather than as a shape. All four
    // declines carry the identical reason, so a file-wide `includes` guard
    // writes exactly one marker and three criteria are recorded as reviewed
    // by a line that is about a different criterion.
    const path = plant();
    const result = auditSpecs(FIXTURE, { fix: true });
    const reasons = new Set((result.rewrites ?? []).filter(r => r.kept).map(r => r.kept));
    expect(reasons.size, "the four declines no longer share one reason, so this measures nothing")
      .toBe(1);

    const markers = readFileSync(path, "utf-8")
      .split("\n")
      .filter(l => l.startsWith("<!-- REVIEW: unmatched"));
    expect(markers.length, "declined criteria are sharing one marker").toBe(KEPT.length);
  });
});
