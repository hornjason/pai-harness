/**
 * Covers SC-1604..SC-1611 (HARNESS-STANDARD.md), #437.
 *
 * Jason found 34 hidden directories in the repo root:
 *
 *   .tree-under-test-scratch-<6 chars>   × 23
 *   .tmp-sc-drift-test-<6 chars>         × …
 *
 * All but one were 0 bytes. They are gitignored, so nothing was ever at risk
 * of being committed — this is litter, not corruption.
 *
 * Five suites built them with `mkdtempSync(join(REPO_ROOT, "<prefix>"))` at
 * MODULE SCOPE. Every one of them also had correct `afterAll` cleanup, and
 * that is the whole point: the directory appears when bun imports the file,
 * which is before any lifecycle hook can run and before any hook is
 * guaranteed to run at all. 0 bytes is the fingerprint — created at import,
 * never populated, never cleaned. This repo kills suites often (the DIR-L29
 * guard, Ctrl-C, one jetsam kill), so the leak rate is not theoretical.
 *
 * The directories are deliberately inside the repo root rather than /tmp —
 * `tree-under-test` scans the repo tree and `sc-drift` needs repo-relative
 * paths — so relocating them is not available as a fix.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cleanupScratchDirs, scratchPrefixes, isScratchEntry } from "../lib/scratch-cleanup";
import { uniqueScratchPrefixes, fixedScratchRoots, repoRootIdents } from "../lib/scratch-roots";
import { stripJsComments } from "../lib/strip-js-comments";

const REAL_ROOT = join(import.meta.dir, "..");
let root: string;

/** A fake repo whose test/ plants exactly the prefixes given. */
function plantSuites(prefixes: string[]): void {
  mkdirSync(join(root, "test"), { recursive: true });
  prefixes.forEach((p, i) => {
    writeFileSync(
      join(root, "test", `fixture-${i}.test.ts`),
      `const REPO_ROOT = join(import.meta.dir, "..");\n` +
        `const SCRATCH = mkdtempSync(join(REPO_ROOT, "${p}"));\n`,
    );
  });
}

/** A directory in the repo root, aged so the sweeper will consider it. */
function plantDir(name: string, ageMs = 2 * 60 * 60 * 1000): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rg-437-")); });
afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

describe("SC-1604: the prefix list is derived from the suites, never listed", () => {
  test("a prefix a suite plants is found, and one nobody plants is not", () => {
    plantSuites([".tree-under-test-scratch-", ".tmp-sc-drift-test-"]);
    const found = scratchPrefixes(root);
    expect(found).toEqual([".tmp-sc-drift-test-", ".tree-under-test-scratch-"]);
    expect(found).not.toContain(".gate-vacuous-test-");
  });

  test("SC-1605: the real tree's prefixes are all found, and the fixture file's are not", () => {
    // The live check. A derived list has one failure mode a hand-written list
    // does not: it can silently come back empty, and an empty deletion
    // allowlist sweeps nothing, which looks exactly like nothing having
    // leaked.
    const real = scratchPrefixes(REAL_ROOT);
    expect(real.length, "no prefix was derived from the real tree — the sweeper has no subject")
      .toBeGreaterThanOrEqual(5);
    for (const p of [
      ".tree-under-test-scratch-", ".tmp-sc-drift-test-", ".gate-vacuous-test-",
      ".spec-collection-scratch-", ".scaffold-make-targets-",
    ]) {
      expect(real, `${p} is planted by a live suite but is not in the sweep list`).toContain(p);
    }

    // `.x-` is a STRING LITERAL inside scratch-paths-unique.test.ts, where it
    // exists to prove that file's detector still fires. Deriving from it would
    // put a test fixture into a deletion allowlist — the self-reference trap
    // with a recursive delete on the end. That file is excluded, and this is
    // the assertion that the exclusion is doing something.
    expect(real, "a fixture literal reached the deletion allowlist").not.toContain(".x-");
    expect(uniqueScratchPrefixes(
      readFileSync(join(REAL_ROOT, "test", "scratch-paths-unique.test.ts"), "utf-8"),
    ), "the fixture file does declare .x-, so the exclusion is load-bearing").toContain(".x-");
    // A whole-tree scan, so its cost is a function of how many suites the
    // repository has rather than of anything this case asserts. It died on
    // CI at 5219ms against the 5000ms default in #323's own PR, for no
    // reason but two new test files, and #792 gave it a 60s budget.
    //
    // #793 repaired the cost rather than the budget, so the budget is gone
    // again and this case is back on the default. Measured 2026-10-20 over
    // the same 375 files and 5.69 MB: `scratchPrefixes(REAL_ROOT)` was
    // 3477/3452/3501ms before and is 170/164/168ms after, and
    // `repoRootIdents` over every file went 1698ms -> 31ms. The headroom
    // against the 5000ms default is now ~29x rather than 1.4x, so the next
    // file anybody adds is not an event.
  });

  test("SC-1606: the two readings of a scratch root come from one parse", () => {
    // SC-5. `fixedScratchRoots` (is this path shared?) and
    // `uniqueScratchPrefixes` (what may be swept?) are the same parse asked
    // two ways, and they are exported from one module so there is one thing
    // to mutate. Asserted behaviourally rather than by grepping imports: the
    // same source must be classified by exactly one of them.
    const src =
      `const ROOT = join(import.meta.dir, "..");\n` +
      `const FIXED = join(ROOT, ".shared-scratch");\nmkdirSync(FIXED);\n` +
      `const UNIQ = mkdtempSync(join(ROOT, ".unique-scratch-"));\n`;
    expect(fixedScratchRoots(src)).toEqual(["FIXED = .shared-scratch"]);
    expect(uniqueScratchPrefixes(src)).toEqual([".unique-scratch-"]);
  });

  test("SC-1606: the assignment form is seen, not just the const form", () => {
    // #437's own fix writes `let SCRATCH = ""` at the top and
    // `SCRATCH = mkdtempSync(...)` inside beforeAll. A const-only pattern
    // would stop seeing both readings at once — so the fix for the leak would
    // have opened a hole in the guard against fixed paths, and the hole would
    // be invisible because both functions would simply return nothing.
    const assigned =
      `const ROOT = join(import.meta.dir, "..");\n` +
      `let SCRATCH = "";\nbeforeAll(() => { SCRATCH = mkdtempSync(join(ROOT, ".late-")); });\n`;
    expect(uniqueScratchPrefixes(assigned)).toEqual([".late-"]);

    const assignedFixed =
      `const ROOT = join(import.meta.dir, "..");\n` +
      `let SCRATCH = "";\nbeforeAll(() => { SCRATCH = join(ROOT, ".late-fixed"); mkdirSync(SCRATCH); });\n`;
    expect(fixedScratchRoots(assignedFixed)).toEqual(["SCRATCH = .late-fixed"]);
  });
});

/**
 * #793 — the parse is driven from the identifier, and the parse is unchanged.
 *
 * Both patterns used to open with a FULLY OPTIONAL, NON-CAPTURING keyword
 * group followed by `\s*`. An optional head with nothing required in front of
 * it starts a backtracking attempt at essentially every offset, and measured
 * over this repository's `test/` that head was the whole cost: the same
 * pattern with the entire `join(...)` tail removed still took 1712ms, so the
 * time was never in the tail and never in match volume.
 *
 * The group was optional AND non-capturing, so it contributed to no capture.
 * Deleting it is 1716ms -> 32ms with a byte-identical 400-element ident list
 * over the real tree.
 *
 * The REFERENCE below is `lib/scratch-roots.ts` as it stood before that
 * change, copied verbatim and frozen. Two copies of one parse is normally the
 * defect this module's own docblock warns about — here it is the instrument,
 * because the claim being made is "the fast reading equals the slow one" and
 * that claim needs both readings present to be checkable at all. It is frozen
 * deliberately: nothing in production calls it, and it must never be updated
 * to track the live module, because a reference that follows its subject
 * agrees with it unconditionally.
 */
describe("#793: the scan is driven from the identifier, and reads the same thing", () => {
  const REF_IDENT_SOURCE = String.raw`(?:const|let|var)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\n]+)`;
  const REF_DECL_SOURCE = String.raw`(?:const|let|var\s+)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(mkdtempSync\s*\(\s*)?join\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*"(\.[^"]*)"`;

  function refRepoRootIdents(src: string): Set<string> {
    const idents = new Set<string>();
    for (const m of src.matchAll(new RegExp(REF_IDENT_SOURCE, "g"))) {
      if (/import\.meta\.dir|process\.cwd\(\)/.test(m[2]!)) idents.add(m[1]!);
    }
    return idents;
  }
  function refIsNavigation(literal: string): boolean {
    return literal === "." || literal === ".." || literal.startsWith("../");
  }
  function refFixedScratchRoots(source: string): string[] {
    const src = stripJsComments(source);
    const roots = refRepoRootIdents(src);
    const out: string[] = [];
    for (const m of src.matchAll(new RegExp(REF_DECL_SOURCE, "g"))) {
      const [, name, wrapped, rootIdent, literal] = m;
      if (wrapped) continue;
      if (!roots.has(rootIdent!)) continue;
      if (refIsNavigation(literal!)) continue;
      const mutates = new RegExp(`(?:mkdirSync|rmSync)\\(\\s*(?:join\\(\\s*)?${name}\\b`);
      if (mutates.test(src)) out.push(`${name} = ${literal}`);
    }
    return out;
  }
  /**
   * #1473's delta, as a SECOND frozen reference rather than an edit to the
   * first.
   *
   * The pre-#793 reference above must never be updated to track the live
   * module — its own docblock says so, and a reference that follows its
   * subject agrees with it unconditionally. But #1473 deliberately changed
   * what the live parse sees: a root spelled inline, binding no name.
   *
   * So the equivalence claim is no longer `live == ref`. It is
   * `live == ref + the inline form`, and that is what the case below
   * asserts. This pattern is an independent re-implementation of the delta
   * ONLY — identifier-rooted declarations are not its business — so the two
   * references still cannot agree by construction.
   */
  const REF_INLINE_DECL_SOURCE = String.raw`([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(mkdtempSync\s*\(\s*)?join\(\s*(?:import\.meta\.dir|process\.cwd\(\))\s*,\s*"(\.[^"]*)"`;

  function refInlineFixedScratchRoots(source: string): string[] {
    const src = stripJsComments(source);
    const out: string[] = [];
    for (const m of src.matchAll(new RegExp(REF_INLINE_DECL_SOURCE, "g"))) {
      const [, name, wrapped, literal] = m;
      if (wrapped) continue;
      if (refIsNavigation(literal!)) continue;
      const mutates = new RegExp(`(?:mkdirSync|rmSync)\\(\\s*(?:join\\(\\s*)?${name}\\b`);
      if (mutates.test(src)) out.push(`${name} = ${literal}`);
    }
    return out;
  }
  function refInlineUniqueScratchPrefixes(source: string): string[] {
    const src = stripJsComments(source);
    const out: string[] = [];
    for (const m of src.matchAll(new RegExp(REF_INLINE_DECL_SOURCE, "g"))) {
      const [, , wrapped, literal] = m;
      if (!wrapped) continue;
      if (refIsNavigation(literal!)) continue;
      if (!out.includes(literal!)) out.push(literal!);
    }
    return out;
  }

  function refUniqueScratchPrefixes(source: string): string[] {
    const src = stripJsComments(source);
    const roots = refRepoRootIdents(src);
    const out: string[] = [];
    for (const m of src.matchAll(new RegExp(REF_DECL_SOURCE, "g"))) {
      const [, , wrapped, rootIdent, literal] = m;
      if (!wrapped) continue;
      if (!roots.has(rootIdent!)) continue;
      if (refIsNavigation(literal!)) continue;
      if (!out.includes(literal!)) out.push(literal!);
    }
    return out;
  }

  /** Every `.ts` under test/, read once and shared by the cases below. */
  function treeSources(): { file: string; raw: string; stripped: string }[] {
    return readdirSync(join(REAL_ROOT, "test"))
      .filter(f => f.endsWith(".ts"))
      .sort()
      .map(f => {
        const raw = readFileSync(join(REAL_ROOT, "test", f), "utf-8");
        return { file: f, raw, stripped: stripJsComments(raw) };
      });
  }

  /**
   * The third divergence class, carved out per file (#1286).
   *
   * The comment on the case below predicted this: `#1482` narrowed
   * `repoRootIdents` so that an identifier bound to
   * `mkdtempSync(join(import.meta.dir, ...))` is no longer a repo root — a
   * directory unique by construction is not the shared checkout — and it
   * shipped with ZERO live instances, so the frozen reference and the live
   * parse agreed over the whole tree by accident rather than by design.
   * *"The first file that does write one makes this case red for a CORRECT
   * change."* `test/derived-spec-guard.test.ts` is that file.
   *
   * Keyed by the EXPECTED READINGS, never by filename alone. A carve-out
   * that said only "this file may disagree" would retire the check for that
   * file permanently; this one retires exactly the disagreement #1482
   * predicts, so any other divergence in the same file is still red — and a
   * carve-out the tree stops needing is reported stale rather than lingering.
   */
  const CARVED_IDENT_DIVERGENCES: Record<string, { live: string[]; reference: string[] }> = {
    "derived-spec-guard.test.ts": {
      // `root` and `dir` are each bound to an inline-rooted `mkdtempSync`.
      live: ["REPO"],
      reference: ["REPO", "dir", "root"],
    },
    "spec-template-overwrite.test.ts": {
      // `root`, same shape. #1549 — the second instance, which is the point:
      // the first was predicted to exist and now the pattern is ordinary.
      live: [],
      reference: ["root"],
    },
  };

  function isCarvedIdentDivergence(file: string, live: string[], reference: string[]): boolean {
    const carved = CARVED_IDENT_DIVERGENCES[file];
    if (!carved) return false;
    const same = (a: string[], b: string[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    return same(carved.live, live) && same(carved.reference, reference);
  }

  test("every file in test/ parses to the same idents, roots and prefixes as the frozen reference", () => {
    // NOT a witness of the fix — it is GREEN on the pre-#793 module too, and
    // has to be, because that is the whole claim. It is the equivalence
    // proof, and it is also the skip-direction guard: an optimisation that
    // stopped reading a file the reference reads shows up here as a missing
    // element, in that file, by name. Element by element, never a count — a
    // count is satisfied by any substitution that preserves the total.
    // #1473: the reference the live parse is held against is now
    // `pre-#793 + the inline form`. Both halves are frozen and neither
    // tracks the live module.
    //
    // #1482 DID narrow `repoRootIdents` — an identifier bound to an
    // `mkdtempSync(...)` is no longer a repo root — and the idents comparison
    // is still an exact equality, because MEASURED over 888 files in `test/`,
    // `lib/`, `scripts/`, `gates/`, `hooks/`, `bin/` and `workflows/` the
    // narrowing drops ZERO of the 559 identifiers the reference reads. No
    // file in this tree binds a name to an inline-rooted `mkdtempSync`, which
    // is why #1482 shipped with no live instance and its witnesses are the
    // unit fixtures in `test/scratch-paths-unique.test.ts`. The first file
    // that does write one makes this case red for a CORRECT change — see the
    // third divergence class in the message below.
    const divergences: string[] = [];
    const carvedUsed = new Set<string>();
    let identTotal = 0;
    let prefixTotal = 0;
    let fixedTotal = 0;
    let inlineTotal = 0;
    const sorted = (xs: string[]) => JSON.stringify([...xs].sort());
    for (const { file, raw, stripped } of treeSources()) {
      const liveIdents = [...repoRootIdents(stripped)].sort();
      const refIdents = [...refRepoRootIdents(stripped)].sort();
      identTotal += refIdents.length;
      if (JSON.stringify(liveIdents) !== JSON.stringify(refIdents)) {
        if (isCarvedIdentDivergence(file, liveIdents, refIdents)) {
          carvedUsed.add(file);
        } else {
          divergences.push(`test/${file} idents: live ${JSON.stringify(liveIdents)} vs reference ${JSON.stringify(refIdents)}`);
        }
      }
      const livePrefixes = uniqueScratchPrefixes(raw);
      // Deduped, because `uniqueScratchPrefixes` dedupes and the two halves
      // of the reference can legitimately find the same prefix in different
      // spellings — `test/scratch-paths-unique.test.ts` declares `.x-` both
      // ROOT-rooted and inline, as two separate fixtures. Comparing a
      // deduped list against a raw concatenation reports that as a
      // divergence, which is the comparison being wrong, not the parse.
      const refPrefixes = [
        ...new Set([...refUniqueScratchPrefixes(raw), ...refInlineUniqueScratchPrefixes(raw)]),
      ];
      prefixTotal += refPrefixes.length;
      if (sorted(livePrefixes) !== sorted(refPrefixes)) {
        divergences.push(`test/${file} prefixes: live ${JSON.stringify(livePrefixes)} vs reference ${JSON.stringify(refPrefixes)}`);
      }
      const liveFixed = fixedScratchRoots(raw);
      const refInlineFixed = refInlineFixedScratchRoots(raw);
      const refFixed = [...refFixedScratchRoots(raw), ...refInlineFixed];
      fixedTotal += refFixed.length;
      inlineTotal += refInlineFixed.length;
      if (sorted(liveFixed) !== sorted(refFixed)) {
        divergences.push(`test/${file} fixed roots: live ${JSON.stringify(liveFixed)} vs reference ${JSON.stringify(refFixed)}`);
      }
    }

    // Vacuity controls, read BEFORE the verdict. Two empty lists are equal,
    // so a comparison that found nothing to compare is byte-identical to one
    // that found everything and agreed.
    expect(identTotal, "the reference parse read no root identifiers at all — the comparison is empty, not clean")
      .toBeGreaterThan(300);
    expect(prefixTotal, "the reference parse derived no prefixes at all — the comparison is empty, not clean")
      .toBeGreaterThanOrEqual(5);
    expect(fixedTotal, "the reference parse classified no fixed roots at all — it should see this file's own fixtures")
      .toBeGreaterThan(0);
    // #1473's own vacuity control, and the one that matters most here. The
    // inline half of the reference contributing ZERO would make this case
    // byte-identical to the pre-#1473 one: it would pass by comparing the
    // live parse against a delta that found nothing, and the widening would
    // be unwitnessed at tree level. The fixtures in
    // `test/scratch-paths-unique.test.ts` are what it reads.
    expect(
      inlineTotal,
      "the inline half of the reference matched nothing in test/, so this comparison is the " +
        "pre-#1473 one wearing a new name — the widening is unwitnessed over the real tree",
    ).toBeGreaterThan(0);

    // A carve-out nobody needs is a hole nobody can see. If the frozen
    // reference is ever taught #1482's narrowing, every entry stops firing
    // and must be deleted in that commit rather than left standing.
    expect(
      Object.keys(CARVED_IDENT_DIVERGENCES).filter(f => !carvedUsed.has(f)).sort(),
      "a carved ident divergence no longer occurs — delete the entry from " +
        "CARVED_IDENT_DIVERGENCES rather than leaving the file exempt",
    ).toEqual([]);

    expect(
      divergences,
      "the live parse and the frozen reference disagree over test/. The reference is\n" +
      "`pre-#793 + #1473's inline-root form`, both frozen. Three legal divergence classes:\n" +
      "an identifier literally prefixed by const/let/var at the start of an assignment\n" +
      "(see the two cases below); a root spelled inline as import.meta.dir or\n" +
      "process.cwd(); and an identifier the reference calls a root because its RHS is\n" +
      "`mkdtempSync(join(import.meta.dir, ...))`, which #1482 excludes — a directory\n" +
      "unique by construction is not the shared checkout. If it is any of the three,\n" +
      "the LIVE reading is the correct one and this expectation needs the file carved\n" +
      "out by name, not a reference relaxed:\n" +
      divergences.join("\n"),
    ).toEqual([]);
  }, 60_000);

  test("the fast reading is an order of magnitude cheaper than the frozen reference", () => {
    // A ratio, not a wall clock, so it does not move with the machine: both
    // numbers are taken in the same run over the same strings. The cheapest
    // wrong fix for this case is to lower the ratio; measured 2026-10-20 it
    // is ~26x against a floor of 5x, so a lowering is a visible retreat and
    // not a rounding adjustment.
    const sources = treeSources().map(s => s.stripped);
    let refMs = 0;
    let liveMs = 0;
    // Two interleaved passes, so a slow patch of machine time cannot land on
    // one reading and not the other.
    for (let pass = 0; pass < 2; pass++) {
      let t = Date.now();
      for (const s of sources) refRepoRootIdents(s);
      refMs += Date.now() - t;
      t = Date.now();
      for (const s of sources) repoRootIdents(s);
      liveMs += Date.now() - t;
    }
    expect(refMs, `the reference parse took ${refMs}ms — too fast to be the pattern #793 is about, so this case is measuring something else`)
      .toBeGreaterThan(200);
    expect(
      refMs / Math.max(liveMs, 1),
      `the live scan took ${liveMs}ms against the reference's ${refMs}ms. #793's head group, or something shaped like it, is back.`,
    ).toBeGreaterThan(5);
  }, 60_000);

  test("an identifier that merely starts with a keyword is read whole, and cannot invent a root", () => {
    // The one input on which the live parse and the frozen reference differ,
    // and the reason the equivalence above is a proof rather than an
    // assumption. `letROOT = ...` at the head of an assignment: the reference
    // consumes `let` as the keyword and captures `ROOT`, a variable that was
    // never declared. The live parse captures `letROOT`.
    //
    // This is a WITNESS — red on the pre-#793 module, green after — and the
    // direction matters more than the equality. The reference's truncated
    // `ROOT` is a root identifier nothing in the file ever bound, so an
    // unrelated `join(ROOT, ...)` elsewhere is read as repo-rooted and its
    // prefix reaches a RECURSIVE-DELETE allowlist on the strength of a
    // misparse. The fix narrows the allowlist here; it does not widen it.
    const invented =
      `letROOT = join(import.meta.${"dir"}, "..");\n` +
      `const S = mkdtempSync(join(ROOT, ".invented-"));\n`;
    expect(repoRootIdents(invented), "the whole identifier is the identifier").toContain("letROOT");
    expect(repoRootIdents(invented), "`ROOT` was never bound by this source").not.toContain("ROOT");
    expect(uniqueScratchPrefixes(invented), "a prefix reached the deletion allowlist through an identifier nothing declared")
      .toEqual([]);

    // And the other half of the same misparse: a root the reference could not
    // see, so its scratch directories were never swept.
    const missed =
      `letROOT = join(import.meta.${"dir"}, "..");\n` +
      `const S = mkdtempSync(join(letROOT, ".missed-"));\n`;
    expect(uniqueScratchPrefixes(missed)).toEqual([".missed-"]);
  });

  test("the declaration forms a literal pre-filter would skip are all still read", () => {
    // #793's rejected attempt 2 was a per-file literal pre-filter, and the
    // comment on the issue proposes driving the scan from `join(` instead of
    // the identifier. Either is wrong in the SKIPPING direction the moment it
    // spells a literal more tightly than the pattern does. These are the
    // forms that separate the two, and each is a prefix that must arrive.
    const forms: [string, string][] = [
      ["plain const", `const A = mkdtempSync(join(ROOT, ".f-plain-"));`],
      ["space before join", `const B = mkdtempSync( join(ROOT, ".f-spaced-"));`],
      ["newline before join", `const C = mkdtempSync(\n  join(ROOT, ".f-wrapped-"));`],
      ["bare assignment", `D = mkdtempSync(join(ROOT, ".f-bare-"));`],
      ["var with space", `var E = mkdtempSync(join(ROOT, ".f-var-"));`],
      ["no space around =", `const F=mkdtempSync(join(ROOT,".f-tight-"));`],
      ["column zero", `\nconst G = mkdtempSync(join(ROOT, ".f-col0-"));`],
    ];
    const header = `const ROOT = join(process.${"cwd"}(), "..");\n`;
    for (const [name, form] of forms) {
      const literal = form.match(/"(\.[^"]*)"/)![1]!;
      expect(uniqueScratchPrefixes(header + form + "\n"), `${name}: the parse stopped seeing this form`)
        .toEqual([literal]);
    }
    // Together, too: a pre-filter applied per file has to keep every form in
    // one file, not each one on its own.
    expect(uniqueScratchPrefixes(header + forms.map(f => f[1]).join("\n") + "\n").sort())
      .toEqual(forms.map(f => f[1].match(/"(\.[^"]*)"/)![1]!).sort());
  });

  test("a navigation literal is refused as a scratch name by both readings", () => {
    // The refusal that keeps `join(ROOT, "..")` out of a recursive-delete
    // allowlist. Asserted here because the fast scan reaches the same
    // isNavigation call, and a faster scan that lost it would be strictly
    // worse than the slow one.
    const header = `const ROOT = join(import.meta.${"dir"}, "..");\n`;
    for (const nav of [".", "..", "../", "../.."]) {
      const unique = `const S = mkdtempSync(join(ROOT, "${nav}"));\n`;
      const fixed = `const T = join(ROOT, "${nav}");\nmkdirSync(T);\n`;
      expect(uniqueScratchPrefixes(header + unique), `"${nav}" reached the deletion allowlist`).toEqual([]);
      expect(fixedScratchRoots(header + fixed), `"${nav}" was read as a fixed scratch root`).toEqual([]);
    }
    // Non-vacuity: the same shapes with a real scratch name do come back, so
    // the four empties above are a refusal and not a parse that failed.
    expect(uniqueScratchPrefixes(header + `const S = mkdtempSync(join(ROOT, ".real-"));\n`)).toEqual([".real-"]);
    expect(fixedScratchRoots(header + `const T = join(ROOT, ".realfixed");\nmkdirSync(T);\n`)).toEqual(["T = .realfixed"]);
  });
});

describe("SC-1607: the sweeper removes the leak and nothing else", () => {
  test("a leaked directory goes and an unrelated one stays", () => {
    plantSuites([".tree-under-test-scratch-"]);
    const leaked = plantDir(".tree-under-test-scratch-ab12cd");
    const innocent = plantDir("src");
    const dotted = plantDir(".github");

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(existsSync(leaked), "the leak survived the sweep").toBe(false);
    expect(result.removed).toContain(".tree-under-test-scratch-ab12cd");
    expect(existsSync(innocent)).toBe(true);
    expect(existsSync(dotted)).toBe(true);
    expect(result.refused).toContain("src");
    expect(result.refused).toContain(".github");
  });

  test("SC-1608: a prefix is a deletion allowlist and is refused as one", () => {
    // SC-3. Every near miss, each of which a looser predicate would take.
    plantSuites([".tree-under-test-scratch-"]);
    const nearMisses = [
      // EXACTLY the prefix, nothing appended. `mkdtempSync` cannot produce
      // this, so someone made it deliberately. Predicted 2 red for dropping
      // the suffix requirement and measured 1 — this case was missing, and
      // the branch was guarded only by the unit test below. A behavioural
      // list that omits the case the predicate exists for is the third shape
      // in `.claude/rules/checks-must-be-able-to-fail.md`.
      ".tree-under-test-scratch-",
      ".tree-under-test-scratch",        // the prefix minus its separator
      ".tree-under-test",                // a shorter name the prefix starts with
      "tree-under-test-scratch-ab12cd",  // no leading dot
      // Contains the prefix but does not START with it — the difference
      // between `startsWith` and `includes`, which was also unguarded
      // behaviourally.
      "x.tree-under-test-scratch-ab12",
      // A real mkdtemp name with something appended. Only the closing anchor
      // refuses this one, and without it the row measured 0.
      ".tree-under-test-scratch-ab12cd-copy",
      // The planted prefix EXACTLY, with a suffix that is the wrong length in
      // each direction. `mkdtempSync` appends six characters and only six, so
      // neither of these is a name this repo's tooling wrote. Added after the
      // suffix-relaxation mutation measured 2 against a predicted 3: the list
      // had near misses of the PREFIX and none of the SUFFIX.
      ".tree-under-test-scratch-ab12",
      ".tree-under-test-scratch-ab12cde",
      ".tree_under_test_scratch-ab12",   // underscores, not the planted name
      ".Tree-under-test-scratch-ab12",   // case
    ];
    const paths = nearMisses.map(n => plantDir(n));

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(result.removed, `the sweeper took a path it did not build: ${result.removed.join(", ")}`)
      .toEqual([]);
    for (const p of paths) expect(existsSync(p), `${p} was deleted`).toBe(true);
  });

  test("SC-1608: with no prefixes derived, the sweeper deletes nothing at all", () => {
    // The fail-safe direction. An empty allowlist must mean "sweep nothing",
    // never "sweep anything" — and an empty `prefixes.some(...)` is false,
    // which is the right answer for the right reason, asserted rather than
    // assumed.
    const leaked = plantDir(".tree-under-test-scratch-ab12cd");
    const result = cleanupScratchDirs({ repoRoot: root }); // no test/ planted

    expect(scratchPrefixes(root)).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(existsSync(leaked)).toBe(true);
  });

  test("SC-1609: a scratch directory young enough to be in use is kept", () => {
    // This runs at SessionStart while another session may be three minutes
    // into a suite. The directory is anonymous and holds no lock, so the
    // suite that created it cannot defend it — age is the only signal there
    // is, and the direction to be wrong in is leaving litter.
    plantSuites([".tree-under-test-scratch-"]);
    const fresh = plantDir(".tree-under-test-scratch-fresh1", 30 * 1000);
    const old = plantDir(".tree-under-test-scratch-old111", 2 * 60 * 60 * 1000);

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(existsSync(fresh), "a scratch directory 30s old was swept out from under a live suite").toBe(true);
    expect(result.kept.join("\n")).toContain(".tree-under-test-scratch-fresh1");
    expect(existsSync(old)).toBe(false);
  });

  test("SC-1609: a file matching a prefix is refused — only directories are swept", () => {
    plantSuites([".tree-under-test-scratch-"]);
    writeFileSync(join(root, ".tree-under-test-scratch-notes"), "not a directory\n");
    const result = cleanupScratchDirs({ repoRoot: root });
    expect(result.refused).toContain(".tree-under-test-scratch-notes");
    expect(existsSync(join(root, ".tree-under-test-scratch-notes"))).toBe(true);
  });

  test("SC-1609: a dry run reports what would go and removes nothing", () => {
    plantSuites([".tree-under-test-scratch-"]);
    const leaked = plantDir(".tree-under-test-scratch-ab12cd");
    const result = cleanupScratchDirs({ repoRoot: root, dryRun: true });
    expect(result.removed.join("\n")).toContain(".tree-under-test-scratch-ab12cd");
    expect(existsSync(leaked), "a dry run deleted something").toBe(true);
  });

  test("SC-1612: a short derived prefix cannot reach .claude or .github", () => {
    // BUG-437-A, found by security review of the first push and confirmed by
    // running it: `isScratchEntry(".claude", [".c"])` was TRUE.
    //
    // The prefix list is derived from `test/*.ts`, so a future suite writing
    // `mkdtempSync(join(REPO_ROOT, ".c"))` — a plausible typo, never mind
    // anything hostile — would arm a SessionStart hook to recursively delete
    // `.claude/`. The sweeper's paths were safe (it builds them itself); its
    // ALLOWLIST was not, and the PR said "content must not steer a recursive
    // delete" while content steered the allowlist.
    //
    // The fix is to require the shape `mkdtempSync` actually produces:
    // exactly six characters from [A-Za-z0-9], measured over 200 samples.
    plantSuites([".c", ".g", ".cl"]);
    const precious = [".claude", ".github", ".git", "node_modules", ".vscode"].map(n => plantDir(n));

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(result.removed, `the sweeper reached ${result.removed.join(", ")}`).toEqual([]);
    for (const p of precious) expect(existsSync(p), `${p} was deleted`).toBe(true);
    expect(isScratchEntry(".claude", [".c"]), "a 1-char prefix still reaches .claude").toBe(false);
  });

  test("SC-1612: only the six-character mkdtemp suffix is accepted", () => {
    const P = ".scratch-";
    expect(isScratchEntry(`${P}ab12CD`, [P]), "a real mkdtemp name was refused").toBe(true);
    expect(isScratchEntry(`${P}ab12C`, [P])).toBe(false);   // five
    expect(isScratchEntry(`${P}ab12CDE`, [P])).toBe(false); // seven
    expect(isScratchEntry(`${P}ab-2CD`, [P])).toBe(false);  // not the alphabet
    expect(isScratchEntry(`${P}ab12CD/x`, [P])).toBe(false); // no path separators
  });

  test("the predicate is callable alone, so the allowlist is testable alone", () => {
    expect(isScratchEntry(".a-b12cd9", [".a-"])).toBe(true);
    expect(isScratchEntry(".a-", [".a-"])).toBe(false);       // bare prefix, no suffix
    expect(isScratchEntry(".a-b12cd9", [])).toBe(false);      // empty allowlist
    expect(isScratchEntry("x.a-b12cd9", [".a-"])).toBe(false); // a prefix, not a substring
    // The prefix reaches a RegExp, so it is escaped rather than trusted. An
    // unescaped `.` is "any character", which would let a name differing in
    // its first character through. Found by predicting the escape mutation at
    // 0 before running it.
    expect(isScratchEntry("Xa-b12cd9", [".a-"]), "an unescaped . matched any character").toBe(false);
  });
});

describe("SC-1611: the sweep runs where worktree cleanup already runs", () => {
  test("the SessionStart hook calls both, so the two leaks are reported together", () => {
    // SC-4. 34 scratch directories and 39 stale worktrees (#68) were both
    // found by eye, months apart. A cleaner nobody invokes is a function, not
    // a cleaner — so the assertion is on the call site, in the one hook that
    // already sweeps the other leak of the same family.
    const hook = readFileSync(join(REAL_ROOT, "hooks", "StaleTTLCleanup.hook.ts"), "utf-8");
    expect(hook, "worktree cleanup moved — this test is pointing at the wrong hook")
      .toContain("cleanupWorktrees(");
    expect(hook, "the scratch sweep is not wired into SessionStart").toContain("cleanupScratchDirs(");
    // Counted into the same total the hook prints, not logged and forgotten.
    expect(/deletedCount \+= sr\.removed\.length/.test(hook)).toBe(true);
    // Gated on the directory the allowlist is derived from, the way the
    // worktree block is gated on `.claude/worktrees`. Second security finding
    // on the first push: an ungated sweep in a project with no `test/` runs
    // with an empty allowlist and reports success, which is this repo's
    // recurring shape.
    expect(
      /existsSync\(join\(PROJECT_ROOT, 'test'\)\)/.test(hook),
      "the scratch sweep runs without checking it has anything to derive from",
    ).toBe(true);
  });

  test("the hook stays a thin trigger — SC-371's 150-line budget", () => {
    const lines = readFileSync(join(REAL_ROOT, "hooks", "StaleTTLCleanup.hook.ts"), "utf-8").split("\n").length;
    expect(lines, `the hook is ${lines} lines; logic belongs in lib/`).toBeLessThanOrEqual(150);
  });
});

describe("SC-1610: no suite in test/ creates a filesystem path at module scope", () => {
  /**
   * The source-position half. `mkdtempSync` / `mkdirSync` / `writeFileSync`
   * outside any function body runs at import, which is where the leak comes
   * from. Inside a lifecycle hook or a helper it does not.
   */
  function moduleScopeCreations(src: string): string[] {
    // Comments are stripped FIRST. The first cut did not, and reported this
    // file's own docblock — the sentence describing the defect reads as the
    // defect. That is the self-reference trap, and it is the fourth time this
    // repo has hit it.
    const stripped = stripJsComments(src);
    const roots = repoRootIdents(stripped);
    const out: string[] = [];
    let depth = 0;
    for (const line of stripped.split("\n")) {
      const creates = /\b(mkdtempSync|mkdirSync|writeFileSync|cpSync)\s*\(/.test(line);
      // Scoped to paths rooted at the SHARED CHECKOUT. A module-scope
      // `mkdtempSync(join(tmpdir(), ...))` leaks too, but it leaks into a
      // directory the OS reaps, and #437 is about the repo root filling up.
      const atRepoRoot = [...roots].some(r => new RegExp(`\\b${r}\\b`).test(line));
      // An arrow body opened and closed on the same line is a hook, not
      // module scope — `beforeAll(() => { SCRATCH = mkdtempSync(...); });`
      if (depth === 0 && creates && atRepoRoot && !/=>/.test(line)) out.push(line.trim());
      for (const ch of line) {
        if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth--;
      }
      if (depth < 0) depth = 0;
    }
    return out;
  }

  test("every suite creates its scratch inside a hook, not at import", () => {
    const violations: string[] = [];
    for (const f of readdirSync(join(REAL_ROOT, "test")).filter(f => f.endsWith(".ts"))) {
      for (const hit of moduleScopeCreations(readFileSync(join(REAL_ROOT, "test", f), "utf-8"))) {
        violations.push(`test/${f} — ${hit}`);
      }
    }
    expect(
      violations,
      `these run at import, before any afterAll can be registered (#437):\n${violations.join("\n")}`,
    ).toEqual([]);
    // The same whole-tree scan and the same reasoning as SC-1605 above.
    // Measured at 2801ms on the CI run where its sibling died at 5219ms, so
    // it was the next one over the line rather than a case that was fine.
    // #793 repaired the scan — `repoRootIdents`, which is what this case
    // runs over every file, went 1698ms -> 31ms — so the 60s budget #792
    // gave it is gone and it is back on the default.
  });

  test("the detector sees the form #437 removed and not the form it installed", () => {
    // Without this the test above is satisfied by a detector that stopped
    // matching, which is how a guard goes quiet and gets trusted more for it.
    const before = `const ROOT = join(import.meta.dir, "..");\nconst S = mkdtempSync(join(ROOT, ".x-"));\n`;
    const after = `let S = "";\nbeforeAll(() => { S = mkdtempSync(join(ROOT, ".x-")); });\n`;
    expect(moduleScopeCreations(before)).toHaveLength(1);
    expect(moduleScopeCreations(after)).toEqual([]);
  });

  test("SC-1610: importing the five repaired suites creates nothing", async () => {
    // The executed half, and the one a source-position assertion cannot
    // stand in for. The modules are imported for real in a subprocess, and
    // the repo root is listed either side. A file could create a directory
    // through a helper this detector does not read; nothing reaches past an
    // actual import.
    const SUITES = [
      "test/tree-under-test.test.ts",
      "test/sc-drift.test.ts",
      "test/gate-vacuous-checks.test.ts",
      "test/spec-collection-recursive.test.ts",
      "test/scaffold-make-targets.test.ts",
    ];
    const before = new Set(readdirSync(REAL_ROOT));

    // `bun test <files> -t <pattern matching nothing>` loads every file and
    // registers its hooks, then runs none of them. That is precisely "import
    // without executing", which is the state the leak came from.
    const proc = Bun.spawnSync({
      cmd: ["bun", "test", ...SUITES, "-t", "zz-no-test-has-this-name-zz"],
      cwd: REAL_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();

    // The files must be OBSERVED loading. A run that failed to resolve an
    // import creates nothing either, and would pass this test for the one
    // reason that makes it worthless. bun names the count it skipped, and a
    // skipped test is a registered test, which is a loaded module.
    const skipped = /skipping (\d+) tests?/.exec(out);
    expect(skipped, `the suites were never loaded:\n${out.slice(0, 500)}`).not.toBeNull();
    expect(Number(skipped?.[1] ?? 0)).toBeGreaterThanOrEqual(SUITES.length);

    const appeared = readdirSync(REAL_ROOT).filter(e => !before.has(e));
    expect(
      appeared,
      `importing these suites created ${appeared.join(", ")} in the repo root`,
    ).toEqual([]);
  });
});
