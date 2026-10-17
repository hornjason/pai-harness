/**
 * Covers SC-1815..SC-1821 (GATE-CONTRACTS-SPEC.md), #514.
 *
 * `specs/GATE-CONTRACTS-SPEC.md` cited seven source locations by LINE NUMBER.
 * Three of them sat under `test/gate-env-expressibility.test.ts` SC-1719,
 * which checks them rather than believing them; keeping that green cost three
 * hand edits of five numbers across two PRs, because every insertion into
 * `workflows/ship.js` moves them.
 *
 * The other four had no guard. **Three of those four were already wrong**,
 * measured while fixing this:
 *
 * | cited | pointed at | should have been |
 * |---|---|---|
 * | `gate-executor.ts:1725` | a `parseFloat` | 2109 |
 * | `evidence-prevalidator.ts:208` | a comment | 245 |
 * | `scaffold-rungate-config.ts:66` | an unrelated `existsSync` | 61 |
 *
 * Each pointed at a plausible-looking line in the right file. Nobody had
 * noticed, and nothing could have — which is the argument for the form
 * rather than for more diligence.
 *
 * The three under the guard were correct, and that is the measurement that
 * matters: the only citations that stayed true are the ones something
 * executed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  ANCHOR_CITATION,
  anchorCitations,
  citationFailures,
  resolveCitation,
} from "../lib/source-anchor";

const ROOT = join(import.meta.dir, "..");
const SPEC_PATH = "specs/GATE-CONTRACTS-SPEC.md";
const SPEC = readFileSync(join(ROOT, SPEC_PATH), "utf-8");

// ── the resolver ─────────────────────────────────────────────

describe("#514: a citation resolves to exactly one site, or it refuses", () => {
  test("SC-1815: an anchor that names one line resolves and reports where", () => {
    const r = resolveCitation(ROOT, {
      path: "workflows/ship.js",
      anchor: "const containerConfig = projectConfig.container",
    });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    // The position is REPORTED, not asserted — a number here would be the
    // thing this issue removed, reintroduced in the test.
    expect(r.line).toBeGreaterThan(0);
    expect(r.text).toContain(r.anchor);
  });

  test("SC-1816: an anchor the file no longer contains is a refusal", () => {
    const r = resolveCitation(ROOT, {
      path: "workflows/ship.js",
      anchor: "const thisHasNeverBeenInShipJs = true",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("no longer contains");
  });

  test("SC-1817: an anchor matching twice is a refusal - not the first match", () => {
    // The one that matters more than it looks. Taking the first match would
    // make every ambiguous citation resolve, and "resolves to a plausible
    // line" is exactly what the line numbers did for three citations in this
    // very file. `import { readFileSync` appears in nearly every module;
    // here it is asked of a file that has it more than once.
    const twice = resolveCitation(ROOT, { path: "workflows/ship.js", anchor: "const s = JSON.parse(" });
    expect(twice.ok, "the fixture anchor is no longer ambiguous — pick another").toBe(false);
    if (twice.ok) return;
    expect(twice.reason).toContain("times");
    expect(twice.reason).toContain("ambiguous");
  });

  test("SC-1818: a short anchor is refused before it becomes ambiguous", () => {
    // Unique today, and one unrelated edit from not being. Refusing now is
    // cheaper than refusing on the day it silently starts pointing at two
    // places — and a short anchor that stays unique is indistinguishable
    // from one that does not until it is too late.
    const r = resolveCitation(ROOT, { path: "workflows/ship.js", anchor: "const q =" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("too short");

    // And an empty one, which would otherwise match at position 0 of
    // everything and report line 1 with total confidence.
    const empty = resolveCitation(ROOT, { path: "workflows/ship.js", anchor: "" });
    expect(empty.ok).toBe(false);
  });

  test("SC-1823: a citation cannot read outside the repository", () => {
    // Flagged by the commit security review. The path comes out of a markdown
    // document and this function reads whatever it names; `ANCHOR_CITATION`
    // admits `.` and `/`, so a traversal is a well-formed citation.
    //
    // No live document does that — every citation here is written by someone
    // with commit access — but "the input happens to be trusted today" is not
    // a property of a library, and a spec is exactly the sort of file a
    // consumer generates.
    for (const path of [
      "../../../../etc/passwd",
      "specs/../../etc/passwd",
      "/etc/passwd",
      "/Users/anybody/.ssh/id_rsa",
    ]) {
      const r = resolveCitation(ROOT, { path, anchor: "an anchor long enough to pass the floor" });
      expect(r.ok, `${path} was read`).toBe(false);
      if (r.ok) continue;
      // Refused for LEAVING, not for being absent. "no such file" would be
      // the same verdict reached by luck, and it would flip to a read the
      // day the file exists.
      expect(r.reason, `${path} was refused for the wrong reason: ${r.reason}`)
        .not.toContain("no such file");
    }

    // The control: an ordinary nested path still resolves, or a traversal
    // guard that refused everything would satisfy every row above while
    // making the whole mechanism useless.
    const ok = resolveCitation(ROOT, {
      path: "specs/GATE-CONTRACTS-SPEC.md",
      anchor: "Citing source by what it says, not by where it sits",
    });
    expect(ok.ok, ok.ok ? "" : ok.reason).toBe(true);
  });

  test("SC-1819: a missing file and a multi-line anchor both refuse", () => {
    const gone = resolveCitation(ROOT, { path: "lib/no-such-module.ts", anchor: "anything at all here" });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toContain("no such file");

    // A fragment spanning a newline has no single line to name, and
    // reporting the first is the "near enough" that put three wrong numbers
    // in this spec.
    const spanning = resolveCitation(ROOT, {
      path: "lib/source-anchor.ts",
      anchor: "export interface Citation {\n  path: string;",
    });
    expect(spanning.ok).toBe(false);
    if (!spanning.ok) expect(spanning.reason).toContain("more than one line");
  });
});

// ── the spec that uses it ────────────────────────────────────

describe("#514: every citation in GATE-CONTRACTS-SPEC still names a site", () => {
  test("SC-1820: all of them resolve", () => {
    const cites = anchorCitations(SPEC);
    // Non-vacuous, and the floor is TODAY'S count rather than a comfortable
    // number below it. A regex that stopped matching turns this row green
    // over a document full of broken citations, which is the whole failure
    // mode — and a floor set below the real count means a citation can be
    // deleted without anything saying so. Measured at 9: the seven
    // converted in #514, one of which was a parenthetical naming three
    // sites. Adding one is a one-line bump here.
    expect(cites.length, "anchor citations have gone missing from the spec").toBeGreaterThanOrEqual(9);
    expect(citationFailures(ROOT, SPEC)).toEqual([]);

    // Every one of the seven points into a real file, and more than one file
    // is cited — so a single working citation cannot carry the row.
    expect(new Set(cites.map(c => c.path)).size).toBeGreaterThanOrEqual(4);
  });

  test("SC-1821: the line-number form is gone and does not come back", () => {
    // The ratchet. Converting seven citations is worth nothing if the eighth
    // is written the old way next week, and the old way is what everybody's
    // fingers already know.
    //
    // Scoped to this file deliberately: 134 line citations remain elsewhere
    // in specs/ and docs/adr/, unguarded and unmeasurable, and widening this
    // row to all of them would make it a known-violations ratchet rather
    // than a rule. That population is #514's follow-up, not this row.
    const stale = [...SPEC.matchAll(/`?\b([A-Za-z0-9_./-]+\.(?:ts|js)):(\d+)\b/g)].map(m => m[0]);
    expect(stale, `${SPEC_PATH} has gone back to citing line numbers`).toEqual([]);

    // The pattern can fire, or the row above is a regex that never matches
    // anything and the ratchet is decorative.
    expect(/`?\b([A-Za-z0-9_./-]+\.(?:ts|js)):(\d+)\b/.test("see `workflows/ship.js:5947` for")).toBe(true);
    // And the prose form for a HISTORICAL site is still allowed, because a
    // citation to a line that no longer exists is the point of the paragraph
    // that uses it, not a defect in it.
    expect(/`?\b([A-Za-z0-9_./-]+\.(?:ts|js)):(\d+)\b/.test("line 4462 of ship.js as it then stood")).toBe(false);
    expect(SPEC).toContain("as it then stood");
  });

  test("SC-1822: the citation form itself round-trips", () => {
    // The parser and the written form have to agree, and they are the two
    // halves most likely to drift: a form the parser cannot see is a
    // citation nothing checks, which reads exactly like a citation that
    // passes.
    const sample = 'see `lib/x.ts@"some anchor text here"` and `a/b.js@"another one entirely"` ok';
    expect(anchorCitations(sample)).toEqual([
      { path: "lib/x.ts", anchor: "some anchor text here" },
      { path: "a/b.js", anchor: "another one entirely" },
    ]);
    // A bare path in a code span is NOT a citation. The spec is full of
    // them, and treating them as citations would refuse the document for
    // mentioning a filename.
    expect(anchorCitations("`lib/x.ts` is the owner")).toEqual([]);
    ANCHOR_CITATION.lastIndex = 0;
  });
});
