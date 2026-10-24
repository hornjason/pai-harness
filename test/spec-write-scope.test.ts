/**
 * Scope resolution at a write site (#1566).
 *
 * ## Why this file exists
 *
 * `initialiserOf` in the merged #1552 sweep answered "which binding does this
 * identifier resolve to" with a file-global name scan. The AI review on #1557
 * found it reading the FIRST same-named declaration in the file; the fix taken
 * there — union over ALL same-named declarations — removed the silent false
 * negative and replaced it with a silent false positive. Both are name scans
 * answering a scope-and-position question, and this repository has already
 * paid for that lesson twice (#968, #1555: a token scan wrong five times
 * across four revisions, two shapes still wrong in merged code).
 *
 * So the population below is not "cases that broke". It is an ENUMERATION of
 * the ways an identifier at a write site can resolve, written before the fix,
 * each with a NEGATIVE CONTROL: the same fixture with exactly one feature
 * removed, which must produce the opposite reading. A shape that answers the
 * same either way has told you nothing.
 *
 * **Every fixture names its bindings `p`, `q`, `dest` or `out` — never
 * `specPath`.** An identifier containing "spec" would make `SPEC_TARGET` match
 * the NAME rather than the resolved value, and every row here would pass
 * without the resolver doing anything. That is the vacuous-assertion shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and it is the easiest way to
 * write this file wrong.
 *
 * The before/after reading over the real tree is not in this file, because it
 * is a measurement rather than an invariant: run `bun scripts/spec-write-census.ts`
 * on each side of the change and diff the two. What that produced for #1566 is
 * quoted in the PR, with this command beside it.
 *
 * Covers SC-1566-SCOPE (the eight resolution shapes) and SC-1566-DETECT (the
 * write-site detection shapes).
 */
import { describe, expect, test } from "bun:test";
import { specTargetingOf, writeSitesIn } from "../lib/spec-write-ast";

/** The one write site in a single-site fixture. */
function onlySite(source: string) {
  const sites = writeSitesIn(source);
  expect(sites.length, `expected exactly one write site in:\n${source}`).toBe(1);
  return sites[0]!;
}

/** Does the fixture's single write site read as aiming at a derived document? */
function targets(source: string): boolean {
  return specTargetingOf(onlySite(source));
}

/** Which identifiers at the site could not be resolved, as `name: reason`. */
function unresolved(source: string): string[] {
  return onlySite(source).unresolved;
}

// ── The eight resolution shapes, each with its negative control ──────

describe("SC-1566-SCOPE: an identifier at a write site resolves by scope, not by name", () => {
  test("shape 1 — a module-level const resolves to its initialiser", () => {
    expect(
      targets(`
        const p = join(d, "A-SPEC.md");
        function f() { writeFileSync(p, "x"); }
      `),
    ).toBe(true);

    // NEGATIVE CONTROL: same shape, non-spec initialiser. Flips, which proves
    // the reading came from the VALUE and not from the identifier existing.
    expect(
      targets(`
        const p = join(d, "report.json");
        function f() { writeFileSync(p, "x"); }
      `),
    ).toBe(false);
  });

  test("shape 2 — a function-local binding shadows a module-level one", () => {
    // The DEFECT direction: the local names a spec, the module-level one does
    // not. A first-match name scan reads `report.json` and reports clean on a
    // real spec write. This is the HIGH finding from #1557, as a case.
    expect(
      targets(`
        const p = join(d, "report.json");
        function f() {
          const p = join(d, "A-SPEC.md");
          writeFileSync(p, "x");
        }
      `),
    ).toBe(true);

    // NEGATIVE CONTROL / the other direction: the module-level one names a
    // spec and the local does not. The write cannot reach the module-level
    // binding, so the honest answer is false — and a union over all same-named
    // declarations (the fix taken in #1557) answers true here.
    expect(
      targets(`
        const p = join(d, "A-SPEC.md");
        function f() {
          const p = join(d, "report.json");
          writeFileSync(p, "x");
        }
      `),
    ).toBe(false);
  });

  test("shape 3 — a parameter is UNRESOLVED, not clean", () => {
    expect(unresolved(`function f(p) { writeFileSync(p, "x"); }`)).toEqual(["p: parameter"]);

    // NEGATIVE CONTROL: a local declaration of the same name resolves, so the
    // unresolved list empties. Without this the row cannot distinguish "a
    // parameter is reported" from "everything is reported".
    expect(
      unresolved(`function f(q) { const p = join(d, "A-SPEC.md"); writeFileSync(p, "x"); }`),
    ).toEqual([]);
  });

  test("shape 4 — a block-scoped let in a sibling branch is not in scope", () => {
    // The write is in the ELSE branch and sees only the else branch's binding.
    expect(
      targets(`
        function f(c) {
          if (c) { let p = join(d, "A-SPEC.md"); use(p); }
          else { let p = join(d, "report.json"); writeFileSync(p, "x"); }
        }
      `),
    ).toBe(false);

    // NEGATIVE CONTROL: move the spec into the branch that actually writes.
    expect(
      targets(`
        function f(c) {
          if (c) { let p = join(d, "report.json"); use(p); }
          else { let p = join(d, "A-SPEC.md"); writeFileSync(p, "x"); }
        }
      `),
    ).toBe(true);
  });

  test("shape 5 — a destructured binding is UNRESOLVED", () => {
    expect(unresolved(`const { p } = cfg; writeFileSync(p, "x");`)).toEqual(["p: destructured"]);

    // NEGATIVE CONTROL: the same name bound by a plain declarator resolves.
    expect(unresolved(`const p = cfg.p; writeFileSync(p, "x");`)).toEqual([]);
  });

  test("shape 6 — an imported binding is UNRESOLVED, because the value is in another module", () => {
    expect(
      unresolved(`import { p } from "./paths"; writeFileSync(p, "x");`),
    ).toEqual(["p: import"]);

    // NEGATIVE CONTROL: same identifier, declared locally instead.
    expect(unresolved(`const p = join(d, "A-SPEC.md"); writeFileSync(p, "x");`)).toEqual([]);
  });

  test("shape 7 — a reassignment between declaration and use is read as a union", () => {
    // Over-reporting is the allowed direction: the initialiser alone is
    // `report.json`, so a declaration-only reading reports clean on a write
    // that demonstrably can aim at a spec.
    expect(
      targets(`
        let p = join(d, "report.json");
        p = join(d, "A-SPEC.md");
        writeFileSync(p, "x");
      `),
    ).toBe(true);

    // NEGATIVE CONTROL: remove the reassignment — the one feature — and it
    // flips. Without this the row would also pass if the resolver simply
    // reported every `let` as spec-targeting.
    expect(
      targets(`
        let p = join(d, "report.json");
        writeFileSync(p, "x");
      `),
    ).toBe(false);
  });

  test("shape 7b — a DESTRUCTURING reassignment counts as a reassignment", () => {
    // AI-review finding on #1569, high. The tracker read only `x = …`, so a
    // reassignment through a pattern was silently dropped and the identifier
    // resolved to its initialiser alone — the permissive direction again, in
    // the very mechanism added to stop it.
    expect(
      targets(`
        let p = join(d, "report.json");
        [p] = [join(d, "A-SPEC.md")];
        writeFileSync(p, "x");
      `),
    ).toBe(true);

    expect(
      targets(`
        let p = join(d, "report.json");
        ({ p } = { p: join(d, "A-SPEC.md") });
        writeFileSync(p, "x");
      `),
    ).toBe(true);

    // NEGATIVE CONTROL for each: the same destructuring shape assigning a
    // non-spec value must stay false, or the rows above would pass for a
    // resolver that merely gave up and reported everything.
    expect(
      targets(`
        let p = join(d, "first.json");
        [p] = [join(d, "second.json")];
        writeFileSync(p, "x");
      `),
    ).toBe(false);

    expect(
      targets(`
        let p = join(d, "first.json");
        ({ p } = { p: join(d, "second.json") });
        writeFileSync(p, "x");
      `),
    ).toBe(false);
  });

  test("shape 8 — a nested closure's parameter shadows an outer const", () => {
    expect(
      unresolved(`
        const p = join(d, "A-SPEC.md");
        items.forEach((p) => { writeFileSync(p, "x"); });
      `),
    ).toEqual(["p: parameter"]);

    // NEGATIVE CONTROL: rename the closure parameter — the one feature — and
    // the outer const becomes reachable again.
    expect(
      targets(`
        const p = join(d, "A-SPEC.md");
        items.forEach((q) => { writeFileSync(p, "x"); });
      `),
    ).toBe(true);
  });
});

// ── Write-site DETECTION, which is the same question one level up ────

describe("SC-1566-DETECT: a write site is a call, not a spelling", () => {
  test("a write primitive inside a string literal is not a call site", () => {
    // The merged regex matches this: it reads source text, and the text
    // contains `writeFileSync(`. Two named lines in the review were a sample,
    // not a population — this is the population the AST closes.
    expect(writeSitesIn(`const msg = "call writeFileSync(p, x) instead";`)).toEqual([]);

    // NEGATIVE CONTROL: the same bytes as an actual call.
    expect(writeSitesIn(`writeFileSync(p, "x");`).length).toBe(1);
  });

  test("a write primitive inside a comment is not a call site", () => {
    expect(writeSitesIn(`// never call writeFileSync(p, x) here\nconst a = 1;`)).toEqual([]);
    expect(writeSitesIn(`/* writeFileSync(p, x) */ const a = 1;`)).toEqual([]);
  });

  test("an ALIASED import is a call site — the name scan cannot see this at all", () => {
    const sites = writeSitesIn(
      `import { writeFileSync as wfs } from "fs";\nwfs(join(d, "A-SPEC.md"), "x");`,
    );
    expect(sites.length).toBe(1);
    expect(sites[0]!.primitive).toBe("writeFileSync");
    expect(specTargetingOf(sites[0]!)).toBe(true);

    // NEGATIVE CONTROL: the same local name bound to something that is not a
    // write primitive must NOT be a site.
    expect(writeSitesIn(`import { readFileSync as wfs } from "fs";\nwfs(p);`)).toEqual([]);
  });

  test("a member call is a call site", () => {
    expect(writeSitesIn(`fs.writeFileSync(p, "x");`).length).toBe(1);
    expect(writeSitesIn(`require("fs").writeFileSync(p, "x");`).length).toBe(1);

    // NEGATIVE CONTROL: a same-named method on something that is not fs is
    // still reported — the sweep reads the primitive name on purpose, and the
    // cost of that over-report is one classified line. Stated so the boundary
    // is argued with rather than discovered.
    expect(writeSitesIn(`myLogger.writeFileSync(p, "x");`).length).toBe(1);
  });

  test("a local alias of a write primitive is a call site", () => {
    expect(writeSitesIn(`const w = writeFileSync;\nw(p, "x");`).length).toBe(1);

    // NEGATIVE CONTROL: aliasing something else is not.
    expect(writeSitesIn(`const w = readFileSync;\nw(p);`)).toEqual([]);
  });

  test("Bun.write is a call site and `safeWriteFileSync` is not", () => {
    expect(writeSitesIn(`Bun.write(p, "x");`).length).toBe(1);
    // `e` is an identifier character, so this was already excluded — kept as a
    // row because it is the boundary the lookbehind used to get wrong.
    expect(writeSitesIn(`safeWriteFileSync(p, "x");`)).toEqual([]);
    expect(writeSitesIn(`xwriteFileSync(p, "x");`)).toEqual([]);
  });

  test("renameSync and copyFileSync are read on their SECOND argument", () => {
    expect(targets(`renameSync(join(d, "A-SPEC.md"), join(d, "report.json"));`)).toBe(false);
    expect(targets(`renameSync(join(d, "report.json"), join(d, "A-SPEC.md"));`)).toBe(true);
  });
});

// ── The instrument must refuse rather than report clean ──────────────

describe("SC-1566-DETECT: an unparseable source is UNMEASURED, not empty", () => {
  test("writeSitesIn throws on source that does not parse", () => {
    expect(() => writeSitesIn(`function f( {{{ `)).toThrow(/UNMEASURED/);
  });

  test("a source with no writes parses and returns empty through the normal path", () => {
    expect(writeSitesIn(`export const a = 1;`)).toEqual([]);
  });
});
