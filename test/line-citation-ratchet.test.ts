/**
 * Covers SC-2230..SC-2245 (DOC-HYGIENE-ARCHITECTURE-SPEC.md), #541.
 *
 * #514 converted one document's seven line citations to the anchor form and
 * measured, while doing it, that **three of the four unguarded ones were
 * already wrong**. Each pointed at a plausible-looking line in the right
 * file. The only ones that stayed true were the three something executed.
 *
 * The rest of the tree was left as it was: 231 line citations across 22
 * markdown documents on this branch's base, and nothing read any of them.
 * This file is the guard, and two readings are what it is built around.
 *
 * **A line citation is never VALID.** `LineReading` has two arms and neither
 * says "correct": a citation that resolves is `UNMEASURED`, because whether
 * line 1637 is still the line the sentence is about cannot be decided
 * mechanically and a 75% staleness rate says the optimistic default is the
 * wrong one. Reporting "ok" would be the number a gate did not take.
 *
 * **A citation that cannot be resolved is its own named cause.** A path that
 * names no file, a bare basename, a basename matching two files, a line past
 * the end — each is a different repair, so each is a different reading.
 * Folding them into one boolean is how a spec ends up confidently citing a
 * file that moved.
 *
 * And the third thing, which is this file's own failure mode rather than the
 * subject's: **a checker that finds zero citations in every document is in
 * perfect agreement.** Zero strings are trivially all fine. So the census
 * REFUSES — by throwing, not by returning an empty list — when a document the
 * ratchet says carries citations yields none (#621).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  LINE_CITATION,
  NoLineCitationsError,
  citationRatchetViolations,
  documentCensus,
  lineCitations,
  markdownDocuments,
  readCitationRatchet,
  readLineCitation,
  repoFileIndex,
} from "../lib/line-citation";

const ROOT = join(import.meta.dir, "..");

// ── fixtures ─────────────────────────────────────────────────

/** A throwaway tree. Every path is written relative to its root. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-cite-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

function withTree(files: Record<string, string>, fn: (root: string, index: string[]) => void): void {
  const root = tree(files);
  try {
    fn(root, repoFileIndex(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const RATCHET_MEANING_REQUIRED = [
  "unmeasured",
  "broken",
  "anchors",
];

// ── the readings ─────────────────────────────────────────────

describe("#541: a line citation is classified, and never called valid", () => {
  test("SC-2230: a path naming no file in the tree is BROKEN for not existing", () => {
    withTree({ "lib/real.ts": "a\nb\nc\n" }, (root, index) => {
      const r = readLineCitation(root, index, { path: "src/api/auth.ts", line: 23, raw: "src/api/auth.ts:23" });
      expect(r.reading).toBe("BROKEN");
      if (r.reading !== "BROKEN") return;
      expect(r.cause).toBe("NO_SUCH_FILE");
      // Named, not merely refused. "something is wrong with this citation"
      // and "this file is not in the repository" are different repairs.
      expect(r.detail).toContain("src/api/auth.ts");
    });
  });

  test("SC-2231: a bare basename is BROKEN even when exactly one file matches", () => {
    // The tempting case to wave through, and the one that cost the most.
    // `ship.js:1637` is not a path in this repository; it is a guess that
    // resolves today because there happens to be one `ship.js`. The day a
    // second one lands the citation silently starts meaning something else,
    // which is the whole failure mode in miniature.
    withTree({ "workflows/ship.js": "x\n".repeat(50) }, (root, index) => {
      const r = readLineCitation(root, index, { path: "ship.js", line: 7, raw: "ship.js:7" });
      expect(r.reading).toBe("BROKEN");
      if (r.reading !== "BROKEN") return;
      expect(r.cause).toBe("UNQUALIFIED_PATH");
      // The detail names the one file it probably means, because the repair
      // is to write that path down and a reading that does not say which
      // file it found is a reading nobody can act on.
      expect(r.detail).toContain("workflows/ship.js");
    });
  });

  test("SC-2232: a basename matching two files is AMBIGUOUS, a different cause", () => {
    // `steps.ts:43` is the real instance from #541's own ADRs. The live tree
    // has no surviving example — it cannot witness this — so the fixture is
    // the only thing holding the distinction, and the distinction matters
    // because the repairs differ: one is "qualify the path", the other is
    // "say which of these two you meant".
    withTree(
      { "lib/scaffold/steps.ts": "x\n".repeat(99), "pkg/other/steps.ts": "y\n".repeat(99) },
      (root, index) => {
        const r = readLineCitation(root, index, { path: "steps.ts", line: 43, raw: "steps.ts:43" });
        expect(r.reading).toBe("BROKEN");
        if (r.reading !== "BROKEN") return;
        expect(r.cause).toBe("AMBIGUOUS_PATH");
        expect(r.detail).toContain("2");
      },
    );
  });

  test("SC-2233: a line past the end of the file is BROKEN", () => {
    withTree({ "lib/short.ts": "one\ntwo\nthree\n" }, (root, index) => {
      const past = readLineCitation(root, index, { path: "lib/short.ts", line: 400, raw: "lib/short.ts:400" });
      expect(past.reading).toBe("BROKEN");
      if (past.reading !== "BROKEN") return;
      expect(past.cause).toBe("PAST_END_OF_FILE");

      // The control, in the same tree: a line inside the file is not broken,
      // or a guard that refused every resolvable citation would satisfy the
      // row above while saying nothing about the end of the file.
      const inside = readLineCitation(root, index, { path: "lib/short.ts", line: 2, raw: "lib/short.ts:2" });
      expect(inside.reading).toBe("UNMEASURED");
    });
  });

  test("SC-2234: a citation that leaves the repository is refused for leaving", () => {
    withTree({ "lib/real.ts": "a\nb\n" }, (root, index) => {
      for (const path of ["../../../../etc/passwd", "lib/../../etc/passwd", "/etc/passwd"]) {
        const r = readLineCitation(root, index, { path, line: 1, raw: `${path}:1` });
        expect(r.reading, `${path} was not refused`).toBe("BROKEN");
        if (r.reading !== "BROKEN") continue;
        // Refused for LEAVING, not for being absent. "no such file" is the
        // same verdict reached by luck, and it flips to a read the day the
        // file exists.
        expect(r.cause, `${path}: ${r.detail}`).toBe("OUTSIDE_REPOSITORY");
      }
    });

    // The input the lexical check genuinely cannot reach: a link INSIDE the
    // tree whose target is outside it. The target is reachable ONLY through
    // the link, so the case cannot be satisfied by a route that bypasses the
    // feature (#500).
    const base = mkdtempSync(join(tmpdir(), "rungate-cite-link-"));
    try {
      const root = join(base, "repo");
      mkdirSync(root);
      writeFileSync(join(base, "secret.ts"), "TOKEN\n".repeat(80));
      symlinkSync(join(base, "secret.ts"), join(root, "innocent.ts"));
      const r = readLineCitation(root, ["innocent.ts"], { path: "innocent.ts", line: 3, raw: "innocent.ts:3" });
      expect(r.reading).toBe("BROKEN");
      if (r.reading !== "BROKEN") return;
      expect(r.cause).toBe("OUTSIDE_REPOSITORY");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("SC-2235: a citation that resolves reads UNMEASURED, and there is no third reading", () => {
    withTree({ "lib/real.ts": "one\ntwo\nthree\nfour\n" }, (root, index) => {
      const r = readLineCitation(root, index, { path: "lib/real.ts", line: 3, raw: "lib/real.ts:3" });
      // NOT "ok", NOT "valid". The file exists and the line exists; whether
      // it is the line the sentence describes is undecidable from here, and
      // `0`, `null` and "fine" are indistinguishable from a correct answer.
      expect(r.reading).toBe("UNMEASURED");
      expect(r.detail).toContain("cannot be decided");
    });

    // Exhaustive over the live tree: every citation in this repository is one
    // of the two readings. A third arm appearing — "VALID", "OK", "SKIP" —
    // would be the silent default this whole mechanism exists to refuse.
    const index = repoFileIndex(ROOT);
    const readings = new Set<string>();
    for (const doc of markdownDocuments(ROOT)) {
      const text = readFileSync(join(ROOT, doc), "utf-8");
      for (const c of lineCitations(text)) readings.add(readLineCitation(ROOT, index, c).reading);
    }
    expect([...readings].sort()).toEqual(["BROKEN", "UNMEASURED"]);
  });
});

// ── the extractor, and its refusal ───────────────────────────

describe("#541: the census refuses rather than agreeing with nothing", () => {
  test("SC-2236: a document the ratchet says has citations and has none THROWS", () => {
    // #621's shape. Finding nothing in every document is perfect agreement —
    // zero strings are trivially all fine — so a pattern that stops matching
    // converts this entire guard into a ceremony without changing a line of
    // it. The refusal has to ESCAPE: folded into the violation list it is
    // one more sentence in a report nobody reads, and an empty violation
    // list is what a clean tree looks like.
    withTree({ "doc.md": "no citations here at all, just prose about ship.js\n" }, (root, index) => {
      expect(() => documentCensus(root, index, "doc.md", true)).toThrow(NoLineCitationsError);

      // And the other direction: told not to expect any, it returns a census.
      const census = documentCensus(root, index, "doc.md", false);
      expect(census.broken).toBe(0);
      expect(census.unmeasured).toBe(0);
    });
  });

  test("SC-2237: the refusal escapes citationRatchetViolations rather than folding in", () => {
    withTree(
      {
        "doc.md": "all converted away, nothing left\n",
        ".claude/line-citation-ratchet.json": JSON.stringify({
          meaning: RATCHET_MEANING_REQUIRED,
          documents: { "doc.md": { broken: 0, unmeasured: 3, anchors: 0 } },
        }),
      },
      (root, index) => {
        const ratchet = readCitationRatchet(root);
        let threw: unknown = null;
        try {
          citationRatchetViolations(root, index, ["doc.md"], ratchet);
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(NoLineCitationsError);
        // The message has to say what to do, or the next person deletes the
        // guard instead of the entry.
        expect(String(threw)).toContain("doc.md");
      },
    );
  });

  test("SC-2238: the pattern reads a citation and does not read the historical prose form", () => {
    // Both halves. A pattern matching nothing passes every row above it, and
    // a pattern matching prose refuses a paragraph whose whole point is that
    // the line no longer exists ("line 4462 of ship.js as it then stood").
    expect(lineCitations("see `workflows/ship.js:5947` for the arm").map(c => c.path)).toEqual([
      "workflows/ship.js",
    ]);
    expect(lineCitations("line 4462 of ship.js as it then stood")).toEqual([]);
    expect(lineCitations("`lib/x.ts` is the owner")).toEqual([]);
    expect(lineCitations("`lib/x.ts@\"a long enough anchor here\"` is the owner")).toEqual([]);
    // An anchor whose TEXT quotes the old form. The anchor is the good form
    // and must not be counted as an instance of the bad one — otherwise
    // converting a citation whose line happens to mention another one makes
    // the banked count go up, and the ratchet punishes the repair.
    expect(lineCitations("`lib/x.ts@\"see also a/b.ts:412 in the old form\"`")).toEqual([]);
    // The line number is carried as a number, because `parseInt` failing
    // silently to NaN would make every end-of-file comparison false.
    expect(lineCitations("`a/b.ts:412`")[0].line).toBe(412);
    LINE_CITATION.lastIndex = 0;
  });
});

// ── the ratchet ──────────────────────────────────────────────

describe("#541: the ratchet refuses in both directions", () => {
  const DOC = "specs/x.md";
  const body = (n: number) =>
    "prose\n" + Array.from({ length: n }, (_, i) => `see \`lib/real.ts:${i + 1}\``).join("\n") + "\n";

  function fixture(banked: { broken: number; unmeasured: number; anchors: number }, n: number) {
    return {
      "lib/real.ts": "x\n".repeat(50),
      [DOC]: body(n),
      ".claude/line-citation-ratchet.json": JSON.stringify({
        meaning: RATCHET_MEANING_REQUIRED,
        documents: { [DOC]: banked },
      }),
    };
  }

  test("SC-2239: over the banked number fails, and so does under it", () => {
    withTree(fixture({ broken: 0, unmeasured: 3, anchors: 0 }, 3), (root, index) => {
      expect(citationRatchetViolations(root, index, [DOC], readCitationRatchet(root))).toEqual([]);
    });
    withTree(fixture({ broken: 0, unmeasured: 3, anchors: 0 }, 4), (root, index) => {
      const v = citationRatchetViolations(root, index, [DOC], readCitationRatchet(root));
      expect(v.length).toBe(1);
      expect(v[0]).toContain("4");
    });
    // The direction people forget. An entry that has stopped being true is
    // an entry nobody will ever remove, and the file rots into a number
    // nobody lowers — so a stale entry is itself a failure.
    withTree(fixture({ broken: 0, unmeasured: 3, anchors: 0 }, 2), (root, index) => {
      const v = citationRatchetViolations(root, index, [DOC], readCitationRatchet(root));
      expect(v.length).toBe(1);
      expect(v[0]).toContain("delete");
    });
  });

  test("SC-2240: a document absent from the ratchet is allowed no citations at all", () => {
    // The migration window is exactly when the next line citation is most
    // likely to be written, so the total being above zero cannot be a licence
    // to add one somewhere new.
    withTree(
      {
        "lib/real.ts": "x\n".repeat(50),
        "specs/new.md": "see `lib/real.ts:4`\n",
        ".claude/line-citation-ratchet.json": JSON.stringify({ meaning: RATCHET_MEANING_REQUIRED, documents: {} }),
      },
      (root, index) => {
        const v = citationRatchetViolations(root, index, ["specs/new.md"], readCitationRatchet(root));
        expect(v.length).toBe(1);
        expect(v[0]).toContain("specs/new.md");
      },
    );
  });

  test("SC-2241: broken and unmeasured are banked apart, so qualifying a path is progress", () => {
    // The reason this is not one number. `ship.js:1637` qualified to
    // `workflows/ship.js:1637` deletes nothing and adds nothing — a single
    // total cannot see it happen, and a ratchet that cannot record progress
    // is a ratchet nobody lowers.
    const broken = {
      "workflows/ship.js": "x\n".repeat(50),
      [DOC]: "see `ship.js:7`\n",
      ".claude/line-citation-ratchet.json": JSON.stringify({
        meaning: RATCHET_MEANING_REQUIRED,
        documents: { [DOC]: { broken: 1, unmeasured: 0, anchors: 0 } },
      }),
    };
    withTree(broken, (root, index) => {
      expect(citationRatchetViolations(root, index, [DOC], readCitationRatchet(root))).toEqual([]);
    });
    // Same document, same citation count, path qualified. The banked entry
    // must move, in both of its numbers.
    withTree({ ...broken, [DOC]: "see `workflows/ship.js:7`\n" }, (root, index) => {
      const v = citationRatchetViolations(root, index, [DOC], readCitationRatchet(root));
      expect(v.length).toBe(2);
      expect(v.join(" ")).toContain("broken");
      expect(v.join(" ")).toContain("unmeasured");
    });
  });

  test("SC-2242: an anchor citation is banked too, so a conversion is legible", () => {
    // Converting a line citation to the anchor form LOWERS `unmeasured` and
    // RAISES `anchors`. Deleting it lowers `unmeasured` and raises nothing.
    // Both are allowed by the arithmetic; only one of them is progress, and
    // the three numbers moving in the diff is what lets a reviewer tell them
    // apart. The ratchet makes a deletion visible, not impossible.
    withTree(
      {
        "lib/real.ts": "x\nthe anchor text lives on this line\ny\n",
        [DOC]: 'see `lib/real.ts@"the anchor text lives on this line"`\n',
        ".claude/line-citation-ratchet.json": JSON.stringify({
          meaning: RATCHET_MEANING_REQUIRED,
          documents: { [DOC]: { broken: 0, unmeasured: 0, anchors: 1 } },
        }),
      },
      (root, index) => {
        expect(citationRatchetViolations(root, index, [DOC], readCitationRatchet(root))).toEqual([]);
        // An anchor count that is banked and absent is a failure like any
        // other — otherwise the one document already converted could lose
        // its citations with nothing saying so.
        const stale = readCitationRatchet(root);
        stale.documents[DOC] = { broken: 0, unmeasured: 0, anchors: 2 };
        expect(citationRatchetViolations(root, index, [DOC], stale).length).toBe(1);
      },
    );
  });

  test("SC-2243: an anchor that no longer resolves is a hard failure, not a banked one", () => {
    // The half the repository OWNS. An anchor carries its own text, so
    // whether it still names a site is decidable — there is nothing to
    // ratchet and no reason to tolerate one. Enforce the half you can decide
    // and report the other half as UNMEASURED; a single policy over both
    // would have to be the weaker one.
    withTree(
      {
        "lib/real.ts": "x\ny\n",
        [DOC]: 'see `lib/real.ts@"this text was deleted from the file"`\n',
        ".claude/line-citation-ratchet.json": JSON.stringify({
          meaning: RATCHET_MEANING_REQUIRED,
          documents: { [DOC]: { broken: 0, unmeasured: 0, anchors: 1 } },
        }),
      },
      (root, index) => {
        const v = citationRatchetViolations(root, index, [DOC], readCitationRatchet(root));
        expect(v.length).toBe(1);
        expect(v[0]).toContain("no longer contains");
      },
    );
  });

  test("SC-2244: a banked document that no longer exists is a failure", () => {
    withTree(
      {
        "lib/real.ts": "x\n",
        ".claude/line-citation-ratchet.json": JSON.stringify({
          meaning: RATCHET_MEANING_REQUIRED,
          documents: { "specs/gone.md": { broken: 0, unmeasured: 2, anchors: 0 } },
        }),
      },
      (root, index) => {
        const v = citationRatchetViolations(root, index, [], readCitationRatchet(root));
        expect(v.length).toBe(1);
        expect(v[0]).toContain("specs/gone.md");
      },
    );
  });
});

// ── the live tree ────────────────────────────────────────────

describe("#541: this repository's own citations, counted", () => {
  test("SC-2245: the whole tree agrees with the ratchet, and the census is not empty", () => {
    const index = repoFileIndex(ROOT);
    const docs = markdownDocuments(ROOT);
    const ratchet = readCitationRatchet(ROOT);

    // The control first, and it is not optional. An empty search over a
    // store you did not write reads exactly like a clean result, and the
    // only thing that separates them is a string that MUST be present if
    // the store holds anything at all (#657). Here: this repository has
    // hundreds of line citations and ten anchors, and a walk that found no
    // documents, or a pattern that matched nothing, would satisfy every
    // comparison below by finding nothing to compare.
    expect(docs.length, "the markdown walk found nothing").toBeGreaterThan(100);
    expect(docs).toContain("specs/HARNESS-STANDARD.md");
    const total = docs.reduce(
      (n, d) => n + lineCitations(readFileSync(join(ROOT, d), "utf-8")).length,
      0,
    );
    expect(total, "the line-citation pattern matched nothing in this tree").toBeGreaterThan(100);

    expect(citationRatchetViolations(ROOT, index, docs, ratchet)).toEqual([]);

    // Banked totals are a reading in their own right, and the one a reader
    // of the PR will quote. Non-vacuous by construction: a ratchet emptied
    // of entries would pass every row above and fail this one.
    const banked = Object.values(ratchet.documents);
    expect(banked.length).toBeGreaterThan(15);
    expect(banked.reduce((n, e) => n + e.broken + e.unmeasured, 0)).toBe(total);
    expect(banked.reduce((n, e) => n + e.anchors, 0)).toBeGreaterThan(0);
  });

  test("SC-2246: the ratchet says what an entry means and what clears one", () => {
    // A ratchet nobody can interpret becomes a number nobody lowers. The
    // meaning travels in the file rather than in a commit message, because
    // the file is what the next person opens.
    const ratchet = readCitationRatchet(ROOT);
    const prose = ratchet.meaning.join("\n").toLowerCase();
    for (const word of RATCHET_MEANING_REQUIRED) {
      expect(prose, `the ratchet does not explain "${word}"`).toContain(word);
    }
    // And the one instruction that is not inferable from the numbers: a
    // count lowered by deleting the citation is not progress.
    expect(prose).toContain("delet");
    expect(ratchet.meaning.length).toBeGreaterThan(4);
  });
});
