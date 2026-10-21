/**
 * #880 — a rename is not a deletion, and the body is what says so.
 *
 * ## The run this exists for
 *
 * `wf_99ed276b-cf3` (asaCommandCenter #1792) returned `VERIFY_FAILED` with
 * `deletionVerdict: UNMEASURED` naming eight cases. No test was removed: the
 * repair round RENAMED seven of them, and net coverage over the run went
 * 19 → 27. `deletedCases` compared `Set<string>` of case TITLES between two
 * blobs, and a title that is gone is a deleted passing test, a deleted
 * failing test, a renamed test, or a test somebody moved — the module's own
 * docblock has said so since #659, and the reading could tell apart only the
 * last one.
 *
 * #880 lists three remedies and ranks them itself: hash the normalised body
 * (*"the only one that is actually a measurement"*), pair by title
 * similarity, or say the ambiguity out loud. The second and third are
 * heuristics, and the issue's own warning is the design constraint for this
 * file — *"a heuristic that guesses wrong in the reassuring direction is
 * worse than the current refusal."*
 *
 * ## What the comparison is, stated rather than implied
 *
 * Two cases are the same case when their bodies are IDENTICAL after
 * normalisation, where normalising removes comments and collapses runs of
 * whitespace — the two kinds of difference that carry no behaviour. Nothing
 * fuzzy, no threshold, no score. A changed assertion, a changed value, a
 * changed call: different body, and the case is reported DELETED, which is
 * the pre-#880 answer and the safe direction.
 *
 * **The cheapest wrong fix, named before the repair was written: widen the
 * normalisation until the two bodies agree.** Strip the string literals.
 * Compare only the count of `expect(` calls. Compare identifiers and discard
 * the rest. Every one of those makes the reported symptom go away, and each
 * step toward it pairs cases that are not the same case — which is #880's
 * own "wrong in the reassuring direction", arriving as the fix for #880.
 * `AC-9` is the case that survives it: two cases whose bodies differ in one
 * asserted VALUE and in nothing else must not pair, and it goes red under
 * any normalisation that discards literals.
 *
 * ## The fixture the issue asked for and could not build
 *
 * #880's scope note: *"I have not checked whether the census behaves this way
 * on a file where a rename and a real deletion occur together, which is the
 * case that matters most."* `AC-3` is that file. It has to be constructed
 * deliberately, because every natural example of a rename is an example of
 * the feature working (`.claude/rules/checks-must-be-able-to-fail.md`, the
 * precondition section).
 *
 * ## Why uniqueness is a precondition of pairing
 *
 * Measured on this repository, 2026-10-21: 17 of 483 test files declare the
 * same case title twice, and `deletedCases` has always folded those into a
 * `Set` — so deleting one of two identically-titled cases was invisible
 * before #880 and still is. Bodies collide too: a pair of one-line cases can
 * normalise to the same string. A fingerprint matching more than one
 * disappeared case, or more than one appeared case, pairs NOTHING: an
 * ambiguous pairing that guessed would be the reassuring-direction error in
 * the one place it cannot be noticed. `AC-5` and `AC-6` are the two sides.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import {
  MIN_IDENTIFYING_BODY,
  caseDeclarations,
  normalisedBody,
  renamePairs,
  type CaseDeclaration,
} from "../../lib/test-case-bodies";
import {
  caseChanges,
  caseNames,
  deletedCases,
  deletionArtefact,
  deletionReading,
  deletionSignature,
  type RenamedCase,
} from "../../lib/test-case-deletion";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// ── A two-commit fixture repository ──────────────────────────────────────

const roots: string[] = [];

function fixture(before: string, after: string): { root: string; previous: string; current: string } {
  const root = mkdtempSync(join(tmpdir(), "880-rename-"));
  roots.push(root);
  const git = (args: string[]) => {
    const r = spawnSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      encoding: "utf-8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  mkdirSync(join(root, "test"), { recursive: true });
  const file = join(root, "test", "subject.test.ts");
  git(["init", "-q", "-b", "main"]);
  writeFileSync(file, before);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "build"]);
  const previous = git(["rev-parse", "HEAD"]);
  writeFileSync(file, after);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "repair"]);
  const current = git(["rev-parse", "HEAD"]);
  return { root, previous, current };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const HEAD = `import { expect, test } from "bun:test";\n`;

// ── AC-1..AC-4: rename, deletion, and the two together ───────────────────

describe("AC-1 (#880): a renamed case is a rename, not a deletion", () => {
  const BEFORE =
    HEAD +
    `test("a free port passes", () => {\n  const port = listen(0);\n  expect(port).toBeGreaterThan(0);\n});\n`;
  const AFTER =
    HEAD +
    `test("a free port passes, and the port is OS-assigned rather than a constant", () => {\n` +
    `  const port = listen(0);\n  expect(port).toBeGreaterThan(0);\n});\n`;

  test("the run's own rename is reported as RENAMED and not as a deletion", () => {
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const changes = caseChanges(root, previous, current);
    expect(changes.deleted).toEqual([]);
    expect(changes.renamed).toEqual([
      {
        file: "test/subject.test.ts",
        from: "a free port passes",
        to: "a free port passes, and the port is OS-assigned rather than a constant",
      },
    ]);
  });

  test("the pre-#880 reading of the same pair called it a deletion", () => {
    // The input on which the old binding and the new one differ, named in
    // the file rather than left to the battery: the OLD comparison is title
    // membership, and it is reproduced here rather than described.
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const before = new Set(caseNames(BEFORE));
    const after = new Set(caseNames(AFTER));
    const byTitle = [...before].filter(n => !after.has(n));
    expect(byTitle).toEqual(["a free port passes"]);
    // and the shipped binding does not agree with it
    expect(deletedCases(root, previous, current)).toEqual([]);
  });

  test("the verdict is CLEAN, so a run whose coverage increased is not blocked", () => {
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const changes = caseChanges(root, previous, current);
    const reading = deletionReading(changes.deleted, { status: "UNMEASURED", reason: "no ledger" }, undefined, changes.renamed);
    expect(reading.verdict).toBe("CLEAN");
  });
});

describe("AC-2 (#880): a genuinely deleted case is still a deletion", () => {
  const BEFORE =
    HEAD +
    `test("the gate refuses an empty scan", () => {\n  expect(refuse({files: 0})).toBe(true);\n});\n` +
    `test("the gate allows a full scan", () => {\n  expect(refuse({files: 9})).toBe(false);\n});\n`;
  const AFTER = HEAD + `test("the gate allows a full scan", () => {\n  expect(refuse({files: 9})).toBe(false);\n});\n`;

  test("a case whose body left with it is DELETED", () => {
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const changes = caseChanges(root, previous, current);
    expect(changes.renamed).toEqual([]);
    expect(changes.deleted).toEqual([{ name: "the gate refuses an empty scan", file: "test/subject.test.ts" }]);
  });
});

describe("AC-3 (#880 scope note): a rename and a real deletion in ONE file", () => {
  // The case #880 says it could not check, and the one a similarity
  // threshold is least likely to survive: the deleted case's title is a
  // near-neighbour of the renamed case's NEW title, so title distance pairs
  // the wrong two. The body does not.
  const BEFORE =
    HEAD +
    `test("a free port passes", () => {\n  const port = listen(0);\n  expect(port).toBeGreaterThan(0);\n});\n` +
    `test("a free port passes twice", () => {\n  expect(listen(0)).not.toBe(listen(0));\n});\n`;
  const AFTER =
    HEAD +
    `test("a free port passes, and the port is OS-assigned", () => {\n` +
    `  const port = listen(0);\n  expect(port).toBeGreaterThan(0);\n});\n`;

  test("the rename is reported as a rename and the deletion as a deletion", () => {
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const changes = caseChanges(root, previous, current);
    expect(changes.renamed).toEqual([
      {
        file: "test/subject.test.ts",
        from: "a free port passes",
        to: "a free port passes, and the port is OS-assigned",
      },
    ]);
    expect(changes.deleted).toEqual([{ name: "a free port passes twice", file: "test/subject.test.ts" }]);
  });

  test("the verdict is not CLEAN, because one case really did go", () => {
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const changes = caseChanges(root, previous, current);
    const reading = deletionReading(changes.deleted, { status: "UNMEASURED", reason: "no ledger" }, undefined, changes.renamed);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.cases.map(c => c.name)).toEqual(["a free port passes twice"]);
  });
});

describe("AC-4 (#880): a case renamed AND rewritten is reported as a deletion", () => {
  const BEFORE = HEAD + `test("the old title", () => {\n  expect(compute(2)).toBe(4);\n});\n`;
  const AFTER = HEAD + `test("the new title", () => {\n  expect(compute(3)).toBe(9);\n});\n`;

  test("a body that changed is a case nothing can pair, and the reading says DELETED", () => {
    const { root, previous, current } = fixture(BEFORE, AFTER);
    const changes = caseChanges(root, previous, current);
    expect(changes.renamed).toEqual([]);
    expect(changes.deleted).toEqual([{ name: "the old title", file: "test/subject.test.ts" }]);
  });
});

// ── AC-5, AC-6: an ambiguous pairing pairs nothing ───────────────────────

describe("AC-5/AC-6 (#880): ambiguity pairs nothing, on either side", () => {
  // Substantial on purpose. A body under `MIN_IDENTIFYING_BODY` pairs with
  // nothing whatever its multiplicity, so a short fixture would make every
  // case below pass for the floor's reason rather than for ambiguity's —
  // the assertion holding vacuously, in the cases written to prove a
  // guard. Asserted rather than eyeballed, two cases down.
  const BODY =
    `, () => {\n  const reading = scanner.read(fixtureRoot, { follow: true });\n` +
    `  expect(reading.verdict).toBe("REFUSED");\n}`;

  test("the fixture body really is above the floor, so these cases are about ambiguity", () => {
    expect(normalisedBody(BODY).length).toBeGreaterThanOrEqual(MIN_IDENTIFYING_BODY);
  });

  test("AC-5: two disappeared cases sharing a body do not pair with one survivor", () => {
    const before: CaseDeclaration[] = [
      { name: "alpha", body: BODY },
      { name: "beta", body: BODY },
    ];
    const after: CaseDeclaration[] = [{ name: "gamma", body: BODY }];
    expect(renamePairs(before, after)).toEqual([]);
  });

  test("AC-6: one disappeared case matching two added cases does not pair", () => {
    const before: CaseDeclaration[] = [{ name: "alpha", body: BODY }];
    const after: CaseDeclaration[] = [
      { name: "beta", body: BODY },
      { name: "gamma", body: BODY },
    ];
    expect(renamePairs(before, after)).toEqual([]);
  });

  test("the control: one on each side, same body, DOES pair", () => {
    // Without this the two cases above are satisfied by a `renamePairs`
    // that never pairs anything (`.claude/rules/checks-must-be-able-to-fail.md`,
    // assertions that hold vacuously).
    expect(renamePairs([{ name: "alpha", body: BODY }], [{ name: "beta", body: BODY }])).toEqual([
      { from: "alpha", to: "beta" },
    ]);
  });

  test("a body shared with a case that did NOT move is not evidence either", () => {
    // The whole-file rule. `alpha` is the only disappeared case and `beta`
    // the only appeared one, so a pairing asked of the CHANGED cases alone
    // sees a clean one-to-one match. It is not one: `stayed` carries the
    // same body at both commits, so the body names no case.
    // test/unit/suite-denominator.test.ts is this input, five times over.
    const before: CaseDeclaration[] = [
      { name: "alpha", body: BODY },
      { name: "stayed", body: BODY },
    ];
    const after: CaseDeclaration[] = [
      { name: "beta", body: BODY },
      { name: "stayed", body: BODY },
    ];
    expect(renamePairs(before, after)).toEqual([]);
  });

  test("AC-5b: a body below the floor never pairs, however unique it is", () => {
    // #659's fixture in miniature, and the input that found the floor: a
    // placeholder body is identical in two files, in two repositories and
    // in two unrelated tests, so it is evidence of nothing. Both sides are
    // unique here — only the floor can refuse it.
    const trivial = `, () => { expect(1).toBe(1); }`;
    expect(normalisedBody(trivial).length).toBeLessThan(MIN_IDENTIFYING_BODY);
    expect(renamePairs([{ name: "gone", body: trivial }], [{ name: "arrived", body: trivial }])).toEqual([]);
  });
});

// ── AC-7..AC-9: what normalisation does, and what it must not do ─────────

describe("AC-7/AC-8/AC-9 (#880): the normalisation is trivia only", () => {
  test("AC-7: indentation and line breaks do not make a different case", () => {
    const flat = `() => { expect(x).toBe(1); }`;
    const indented = `() => {\n      expect(x).toBe(1);\n    }`;
    expect(normalisedBody(flat)).toBe(normalisedBody(indented));
  });

  test("AC-8: a comment inside the body does not make a different case", () => {
    const bare = `() => {\n  expect(x).toBe(1);\n}`;
    const noted = `() => {\n  // #880: renamed in the repair round\n  expect(x).toBe(1); /* still one */\n}`;
    expect(normalisedBody(bare)).toBe(normalisedBody(noted));
  });

  test("AC-9: a body differing in ONE asserted value is a DIFFERENT case", () => {
    // The case that survives the cheapest wrong fix. Any normalisation that
    // discards literals — or compares only shape, or counts `expect(` calls
    // — makes these two equal and turns a deleted case into a reassuring
    // "rename". The pair varies exactly one character.
    const one = `() => { expect(compute(2)).toBe(4); }`;
    const two = `() => { expect(compute(2)).toBe(5); }`;
    expect(normalisedBody(one)).not.toBe(normalisedBody(two));
    expect(renamePairs([{ name: "a", body: one }], [{ name: "b", body: two }])).toEqual([]);
  });

  test("a comment is removed, not merely shortened — a comment cannot carry the body", () => {
    // The inverse of AC-8, and the reason it is not enough on its own: a
    // normalisation that left comment TEXT in would pair two cases whose
    // code differs and whose comments happen to match.
    const codeA = `() => { /* x */ expect(a).toBe(1); }`;
    const codeB = `() => { /* x */ expect(b).toBe(1); }`;
    expect(normalisedBody(codeA)).not.toBe(normalisedBody(codeB));
    // The comment's TEXT is gone rather than compressed. Asserted as
    // absence and not as equality with a comment-free body: a removed
    // comment leaves the space it occupied, so `{ }` and `{}` are two
    // different normalised bodies, and widening the normalisation until
    // they agree is a step along the road AC-9 exists to block.
    expect(normalisedBody(`() => { /* anything at all */ }`)).not.toContain("anything");
    expect(normalisedBody(`() => { // trailing\n}`)).not.toContain("trailing");
  });
});

// ── AC-10..AC-12: the body cut reads the file ────────────────────────────

describe("AC-10/AC-11/AC-12 (#880): cutting the body out of real source", () => {
  test("AC-12: parens inside strings, templates, comments and regexes do not end the call", () => {
    const src =
      HEAD +
      "test(\"awkward\", () => {\n" +
      '  const s = ")\\" ) ";\n' +
      "  const t = `) ${ f(\")\") } )`;\n" +
      "  // ) a comment with a paren )\n" +
      "  /* ) and a block one ) */\n" +
      "  expect(s).toMatch(/[)(]\\)/);\n" +
      "});\n" +
      'test("after", () => { expect(1).toBe(1); });\n';
    const decls = caseDeclarations(src);
    expect(decls.map(d => d.name)).toEqual(["awkward", "after"]);
    // The first body stopped at its OWN closing paren: it carries the regex
    // and does NOT carry the second declaration.
    expect(decls[0].body).toContain("toMatch");
    expect(decls[0].body).not.toContain("after");
    expect(decls[1].body).toContain("expect(1).toBe(1)");
  });

  test("AC-11: a call that never closes has no body, and a body-less case never pairs", () => {
    const truncated = HEAD + `test("unterminated", () => {\n  expect(1).toBe(1);\n`;
    const decls = caseDeclarations(truncated);
    expect(decls.map(d => d.name)).toEqual(["unterminated"]);
    expect(decls[0].body).toBeNull();
    expect(renamePairs(decls, [{ name: "renamed", body: null }])).toEqual([]);
  });

  test("AC-10: caseNames is a projection of the same scan, so there is one decider", () => {
    // Asserted over the LIVE tree and not over a fixture: the claim is that
    // the two readings cannot disagree on anything this repository contains.
    const files = testFilesUnder(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    let cases = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      const decls = caseDeclarations(src);
      expect(decls.map(d => d.name)).toEqual(caseNames(src));
      cases += decls.length;
    }
    expect(cases).toBeGreaterThan(5000);
  });

  test("the body cut closes on this repository's own test files", () => {
    // The instrument check, and the reason it is here rather than implied:
    // a cut that silently returned `null` everywhere would make every
    // rename a deletion, and EVERY case above would still pass — each one
    // is about a pairing that does or does not happen on a fixture of its
    // own, and `null` bodies simply never pair. Nothing else in this file
    // can see that failure.
    //
    // A FLOOR and not an equality (#637): the count belongs to the tree,
    // not to this case, and what has to be established is that the cut
    // read something rather than that it read exactly 7,620 somethings.
    //
    // Measured 2026-10-21 over 483 files: 7,631 declarations, 11 with no
    // readable body — 0.144%. All eleven are a `test("…"` sequence sitting
    // inside a STRING LITERAL in the source rather than being a
    // declaration at all (`const GATE_CHECK = 'test("prove-label-…"'` in
    // test/prove-label-gate.test.ts is the clearest), so the call they
    // appear to open was never opened as code and correctly never closes.
    // `caseNames` has counted those as cases since #659 and still does —
    // the declaration pattern reads raw source — and narrowing it is a
    // separate change with its own blast radius, because the census this
    // is compared against counts prose too.
    const files = testFilesUnder(REPO_ROOT);
    let total = 0;
    const unread: string[] = [];
    for (const f of files) {
      for (const d of caseDeclarations(readFileSync(f, "utf-8"))) {
        total++;
        if (d.body === null) unread.push(`${f.slice(REPO_ROOT.length + 1)} :: ${d.name}`);
      }
    }
    expect(total).toBeGreaterThan(5000);
    expect(
      unread.length,
      `${unread.length} of ${total} declarations have no readable body. Over 1% means the ` +
        `scanner in lib/test-case-bodies.ts has stopped closing calls, not that the tree grew ` +
        `string constants — check it before raising this. Unreadable: ${unread.slice(0, 20).join("; ")}`,
    ).toBeLessThan(total / 100);
  });
});

function testFilesUnder(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", "dist", "build", "coverage"]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

// ── AC-13: the rename is EVIDENCE, so it is in the signature ─────────────

describe("AC-13 (#880): a reported rename is covered by the signature", () => {
  const RENAMED: RenamedCase[] = [{ file: "test/a.test.ts", from: "old", to: "new" }];

  test("the artefact carries the renames the reading was given", () => {
    const reading = deletionReading([], { status: "UNMEASURED", reason: "no ledger" }, undefined, RENAMED);
    const artefact = deletionArtefact(reading, "aaaa", "bbbb");
    expect(artefact.verdict).toBe("CLEAN");
    expect(artefact.renamed).toEqual(RENAMED);
  });

  test("a restatement that drops the renames does not reproduce the token", () => {
    const base = { verdict: "CLEAN", cases: [], renamed: RENAMED };
    expect(deletionSignature(base)).not.toBe(deletionSignature({ verdict: "CLEAN", cases: [] }));
  });

  test("the token covers MEMBERSHIP, not the count", () => {
    // #532's trap: a restatement can swap an entry without moving a number.
    const a = deletionSignature({ verdict: "CLEAN", cases: [], renamed: RENAMED });
    const b = deletionSignature({
      verdict: "CLEAN",
      cases: [],
      renamed: [{ file: "test/a.test.ts", from: "old", to: "something else entirely" }],
    });
    expect(a).not.toBe(b);
  });

  test("an artefact with no renames is byte-identical to one that was never given any", () => {
    // The absent/empty distinction, stated: an empty list is not recorded,
    // so a reading from a round with no renames does not acquire a field.
    const none = deletionArtefact(deletionReading([], { status: "UNMEASURED", reason: "x" }), "aaaa", "bbbb");
    const empty = deletionArtefact(
      deletionReading([], { status: "UNMEASURED", reason: "x" }, undefined, []),
      "aaaa",
      "bbbb",
    );
    expect(JSON.stringify(empty)).toBe(JSON.stringify(none));
    expect("renamed" in none).toBe(false);
  });
});
