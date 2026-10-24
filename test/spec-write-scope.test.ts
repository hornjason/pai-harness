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
    //
    // `d` is DECLARED here, and that is load-bearing since #1584. This
    // fixture used to leave it free, which made the chain hole-free only
    // because the resolver stopped recording holes below depth 0 — the
    // control was passing on the defect it exists to rule out.
    expect(
      unresolved(
        `const d = "/tmp";\nfunction f(q) { const p = join(d, "A-SPEC.md"); writeFileSync(p, "x"); }`,
      ),
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
    // `cfg` is declared, because a free `cfg` is itself a hole (#1584).
    expect(
      unresolved(`const cfg = { p: "out.txt" };\nconst p = cfg.p;\nwriteFileSync(p, "x");`),
    ).toEqual([]);
  });

  test("shape 6 — an imported binding is UNRESOLVED, because the value is in another module", () => {
    expect(
      unresolved(`import { p } from "./paths"; writeFileSync(p, "x");`),
    ).toEqual(["p: import"]);

    // NEGATIVE CONTROL: same identifier, declared locally instead.
    expect(
      unresolved(`const d = "/tmp";\nconst p = join(d, "A-SPEC.md");\nwriteFileSync(p, "x");`),
    ).toEqual([]);
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

// ── The property that makes the assignment enumeration stop mattering ──

describe("SC-1566-SCOPE: a reassignable binding makes a target undetermined", () => {
  /** The spellings a widened assignment tracker still misses. */
  const MISSED_BY_ENUMERATION: [string, string][] = [
    ["a default inside a pattern", '[p = join(d, "A-SPEC.md")] = [];'],
    ["for ([p] of …)", 'for ([p] of [[join(d, "A-SPEC.md")]]) { }'],
    ["for (p of …)", 'for (p of [join(d, "A-SPEC.md")]) { }'],
  ];

  test("every spelling the tracker misses comes out UNDETERMINED, not clean", () => {
    // This is the whole point of deciding eligibility by binding kind. Each
    // of these assigns a spec path in a form the tracker does not read, so
    // under a spelling-based reading the site says "not a spec" — the
    // permissive direction. `let` is untrusted by the language's own rule, so
    // all three say "cannot tell" instead, and so does a fourth spelling
    // nobody has thought of.
    const clean: string[] = [];
    for (const [name, assignment] of MISSED_BY_ENUMERATION) {
      const site = onlySite(
        `let p = join(d, "report.json");\n${assignment}\nwriteFileSync(p, "x");`,
      );
      if (!site.opaque && !specTargetingOf(site)) clean.push(name);
      expect(site.reassignable, `${name}: p is a let and must be flagged`).toBe(true);
    }
    expect(
      clean,
      "these spellings assigned a spec path and the sweep reported the site as clean",
    ).toEqual([]);
  });

  test("NEGATIVE CONTROL: the same shapes on a const are determined", () => {
    // Without this the row above would pass for a resolver that called
    // everything undetermined, which is the louder-not-better failure.
    // `d` is declared, because since #1584 a free `d` is a hole of its own
    // and would make this control pass for the wrong reason.
    const site = onlySite('const d = "/tmp";\nconst p = join(d, "report.json");\nwriteFileSync(p, "x");');
    expect(site.reassignable).toBe(false);
    expect(site.opaque).toBe(false);
    expect(specTargetingOf(site)).toBe(false);

    const spec = onlySite('const d = "/tmp";\nconst p = join(d, "A-SPEC.md");\nwriteFileSync(p, "x");');
    expect(spec.reassignable).toBe(false);
    expect(specTargetingOf(spec)).toBe(true);
  });

  test("the flag propagates through the expansion, not just the outer binding", () => {
    // Six of this tree's declared entries are locally `const` and land in the
    // population because an identifier INSIDE the target is a let. A reading
    // that only checked the outermost binding would clear all of them.
    const site = onlySite(
      'let base = outDir;\nconst p = join(base, "f.json");\nwriteFileSync(p, "x");',
    );
    expect(site.reassignable, "p is const but base is not").toBe(true);

    // NEGATIVE CONTROL: make the inner binding const and it clears.
    const fixed = onlySite(
      'const base = outDir;\nconst p = join(base, "f.json");\nwriteFileSync(p, "x");',
    );
    expect(fixed.reassignable).toBe(false);
  });
});

// ── Shape 9, found by the AI review on #1569 round 3 ─────────────────

describe("SC-1566-SCOPE: the expansion dedup is per BINDING, not per name", () => {
  /**
   * Two distinct bindings named `d` on one expansion chain. The local one is
   * reached first, so a dedup keyed on the NAME marks `d` done and the
   * module-level one — the link that actually holds the spec path — is never
   * expanded. Same defect class as `initialiserOf`: a name standing in for a
   * binding, one level further in.
   *
   * Written as `const` throughout on purpose. A `let` anywhere would make the
   * site `opaque` and the row would pass on the undetermined reading instead
   * of on the resolution, which is the vacuous direction.
   */
  const COLLIDING = `
    const d = join(root, "A-SPEC.md");
    const q = join(d, "x");
    function f() {
      const d = "safe";
      const p = join(q, d);
      writeFileSync(p, "y");
    }
  `;

  test("a shadowed name later in the chain is still expanded", () => {
    expect(targets(COLLIDING)).toBe(true);
  });

  test("PREMISE CONTROL: with no name collision the same chain already resolved", () => {
    // Rename the local — the one feature — and the chain has no repeat. If
    // this row were red the fixture would be failing for some other reason
    // (depth budget, the literal being unreachable) and the row above would
    // prove nothing about the dedup.
    expect(targets(COLLIDING.replace(/\bd = "safe"/, 'e = "safe"').replace(/, d\)/, ", e)"))).toBe(
      true,
    );
  });

  test("NEGATIVE CONTROL: the same collision with no spec at the end stays false", () => {
    // Otherwise the fix could be "keep expanding until something matches".
    expect(targets(COLLIDING.replace("A-SPEC.md", "report.json"))).toBe(false);
  });

  test("the dedup still fires — one binding named twice is resolved once", () => {
    // Removing the dedup entirely also makes the row above pass. This is what
    // separates "key it by binding" from "stop deduping".
    const site = onlySite(`const p = join(a, "x");\nwriteFileSync(join(p, p), "y");`);
    expect(
      site.view.match(/join\(a, "x"\)/g),
      "the single binding `p` was expanded once per occurrence",
    ).toHaveLength(1);
  });
});

// ── The four "cannot tell" states, each able to go red ──────────────

describe("SC-1566-SCOPE: each cannot-tell state fails if the resolver starts claiming it", () => {
  // Three of the four — parameter, destructured, import — are asserted in
  // shapes 3, 5 and 6 as an EQUALITY on `unresolved`, so a resolver that
  // started producing a value for one of them empties the list and reddens
  // the row. `opaque` had no such case until this block: it was only ever
  // asserted false, which is the direction a resolver drifts towards.

  test("opaque is TRUE when the target shows no literal and nothing resolves", () => {
    const site = onlySite(`function f(p) { writeFileSync(p, "x"); }`);
    expect(site.opaque, "a bare parameter target is entirely invisible").toBe(true);
    expect(specTargetingOf(site)).toBe(false);
  });

  test("NEGATIVE CONTROL: a target with no hole in it is not opaque", () => {
    // Without this the row above passes for a resolver that calls everything
    // opaque.
    //
    // This control used to be `function f(p) { writeFileSync(join(p,
    // "report.json"), "x"); }` asserting `opaque === false`, and that
    // assertion WAS the defect #1584 closed: a readable filename clearing a
    // target whose directory nobody can see. It is now pointed at a chain
    // with no hole at all, which is the job it was always doing — the old
    // fixture was doing it by certifying a permissive reading.
    const site = onlySite(`const d = "/tmp";\nwriteFileSync(join(d, "report.json"), "x");`);
    expect(site.unresolved, "nothing in this target is invisible").toEqual([]);
    expect(site.opaque).toBe(false);
    expect(specTargetingOf(site)).toBe(false);
  });

  test("opaque survives a visible literal when a binding is reassignable", () => {
    // The two inputs disagree: there IS a literal, and the path is still not
    // establishable. `reassignable` has to win, or the `let` property is
    // decorative on every target that happens to name a file.
    const src = (kind: string): string =>
      `const tmp = "/tmp";\n${kind} d = tmp;\nwriteFileSync(join(d, "report.json"), "x");`;
    const site = onlySite(src("let"));
    expect(site.opaque).toBe(true);
    expect(site.reassignable).toBe(true);

    // NEGATIVE CONTROL: same bytes, const. `tmp` is declared in both, so the
    // only difference between the two readings is the binding kind.
    const fixed = onlySite(src("const"));
    expect(fixed.opaque).toBe(false);
  });
});

// ── Shape 12, from the security review on #1584 ──────────────────────

describe("SC-1566-SCOPE: an invisible path component is recorded at every depth", () => {
  /**
   * `unresolved` was pushed only under `depth === 0`, so an identifier reached
   * by FOLLOWING a chain left no trace at all. The site reported an empty
   * unresolved list — byte-identical to a fully resolved reading, which is
   * worse than being unflagged.
   *
   * The depth restriction existed to keep the list readable, and the fix keeps
   * that intent: a nested one is recorded under its own reason rather than
   * being dropped, so a reader can still tell the two apart.
   */
  const NESTED: [string, string][] = [
    ["a parameter below depth 0", `function f(z) { const p = join(z, "report.json"); writeFileSync(p, "x"); }`],
    ["an import below depth 0", `import { z } from "./x";\nconst p = join(z, "report.json");\nwriteFileSync(p, "x");`],
    [
      "a destructured binding below depth 0",
      `const { z } = cfg;\nconst p = join(z, "report.json");\nwriteFileSync(p, "x");`,
    ],
  ];

  test("a component the resolver cannot follow is never reported as resolved", () => {
    const silent: string[] = [];
    for (const [name, src] of NESTED) {
      const site = onlySite(src);
      if (site.unresolved.length === 0) silent.push(name);
    }
    expect(
      silent,
      "these targets have an unknowable directory and reported an EMPTY " +
        "unresolved list, which reads exactly like a complete resolution",
    ).toEqual([]);
  });

  test("a nested unresolvable is distinguishable from a top-level one", () => {
    // The depth restriction was readability, not correctness. Recording the
    // nested one under the SAME reason would lose that, so the fix must keep
    // the two tellable apart or it has traded one loss for another.
    //
    // SAME NAME and SAME REASON on both sides, so the only thing that can
    // separate the two readings is the depth marker. An earlier version of
    // this row compared `p` against `z`, and the names alone made it pass —
    // MEASURED: deleting the marker from the source left it green (M3).
    const top = onlySite(`function f(p) { writeFileSync(p, "x"); }`).unresolved;
    const nested = onlySite(
      `function f(p) { const q = join(p, "report.json"); writeFileSync(q, "x"); }`,
    ).unresolved;
    expect(top).toEqual(["p: parameter"]);
    expect(nested).toEqual(["p: parameter (nested)"]);
    expect(nested).not.toEqual(top);
  });

  test("NEGATIVE CONTROL: a fully resolvable chain still reports nothing", () => {
    // Without this the rows above pass for a resolver that reports every
    // identifier it ever walked past. Two links deep, so it exercises the
    // depth the rows above are about rather than only depth 0.
    expect(
      unresolved(
        `const root = "/tmp";\nconst z = join(root, "out");\nconst p = join(z, "report.json");\nwriteFileSync(p, "x");`,
      ),
    ).toEqual([]);
  });

  test("a nested NOT-FOUND is a hole too, and says so", () => {
    // The sibling of the three rows above: an identifier with no binding
    // anywhere is as invisible as a parameter, and dropping the depth gate
    // has to reach it as well or the fix covers one of two symmetric inputs
    // again. `root` here is free — the fixture the control above repairs.
    expect(
      unresolved(`const z = join(root, "out");\nconst p = join(z, "report.json");\nwriteFileSync(p, "x");`),
    ).toEqual(["root: not-found (nested)"]);
  });
});

describe("SC-1566-SCOPE: a visible literal does not clear an invisible component", () => {
  /**
   * `opaque` was `reassignable || (!sawLiteral && unresolved.length > 0)`, so
   * one readable filename cleared a target whose DIRECTORY nobody can see.
   * `join(<unknown>, "report.json")` is not a path the sweep has read; it is a
   * filename plus a hole.
   */
  const MASKED: [string, string][] = [
    ["a parameter directory", `function f(p) { writeFileSync(join(p, "report.json"), "x"); }`],
    ["an imported directory", `import { p } from "./x";\nwriteFileSync(join(p, "r.json"), "x");`],
    ["a destructured directory", `const { p } = cfg;\nwriteFileSync(join(p, "r.json"), "x");`],
  ];

  test("a literal beside an unresolved identifier leaves the site opaque", () => {
    const cleared: string[] = [];
    for (const [name, src] of MASKED) {
      const site = onlySite(src);
      expect(site.unresolved.length, `${name}: the hole is recorded`).toBeGreaterThan(0);
      if (!site.opaque) cleared.push(name);
    }
    expect(cleared, "a readable filename cleared a target with an unreadable directory").toEqual(
      [],
    );
  });

  test("NEGATIVE CONTROL: a target with no holes is not opaque", () => {
    // The population must not become uniformly opaque — that is louder, not
    // more accurate, and it would make the row above pass vacuously.
    const site = onlySite(
      `const root = "/tmp";\nconst p = join(root, "report.json");\nwriteFileSync(p, "x");`,
    );
    expect(site.opaque).toBe(false);
    expect(site.unresolved).toEqual([]);
    expect(specTargetingOf(site)).toBe(false);
  });

  test("NEGATIVE CONTROL: opaque does not make a visible spec path stop reading as one", () => {
    // Over-reporting opacity must not cost the sweep its positive reading.
    const site = onlySite(`function f(p) { writeFileSync(join(p, "A-SPEC.md"), "x"); }`);
    expect(site.opaque).toBe(true);
    expect(specTargetingOf(site)).toBe(true);
  });
});

// ── Shape 11, found by a #1569 review round that landed after the merge ──

describe("SC-1566-SCOPE: the expansion follows reassignments, not only initialisers", () => {
  /**
   * The frontier was fed from `binding.init` alone. A binding's `assigned`
   * values were appended to `view` as TEXT and their identifiers were never
   * expanded, so a target reassigned to another identifier holding a spec
   * path did not resolve — `view` read `… q` and never `A-SPEC.md`.
   *
   * One of two symmetric inputs reached the frontier, which is the fifth time
   * in this module that a correct mechanism was applied to half its inputs.
   * The controls below are what separate that from "follow more edges".
   */
  test("a reassignment to another identifier resolves through it", () => {
    expect(
      targets(`
        let p = join(d, "report.json");
        const q = join(root, "A-SPEC.md");
        p = q;
        writeFileSync(p, "x");
      `),
    ).toBe(true);

    // The same shape where the reassigned binding is a parameter, because
    // `let` and `param` reach this code by different routes.
    expect(
      targets(`
        function f(p) {
          const q = join(root, "A-SPEC.md");
          p = q;
          writeFileSync(p, "x");
        }
      `),
    ).toBe(true);
  });

  test("NEGATIVE CONTROL: the same indirection with no spec at the end stays false", () => {
    // Otherwise the fix is "expand until something matches".
    expect(
      targets(`
        let p = join(d, "first.json");
        const q = join(root, "second.json");
        p = q;
        writeFileSync(p, "x");
      `),
    ).toBe(false);
  });

  test("PREMISE CONTROL: both halves of the asymmetry were already working", () => {
    // Without these two the row above could pass for a resolver that had
    // broken something else and happened to be fixed by the same edit. The
    // reassignment WAS read when it named a literal directly, and an
    // INITIALISER chain through an identifier already followed — so the
    // defect was specifically the missing edge and nothing wider.
    expect(
      targets(`
        let p = join(d, "report.json");
        p = join(root, "A-SPEC.md");
        writeFileSync(p, "x");
      `),
    ).toBe(true);
    expect(
      targets(`
        const q = join(root, "A-SPEC.md");
        const p = q;
        writeFileSync(p, "x");
      `),
    ).toBe(true);
  });

  test("following more edges does not defeat the per-binding dedup", () => {
    // #1569 round 3 keyed `seen` on the binding. A new frontier edge must not
    // reintroduce an unbounded walk: a binding reassigned to itself resolves
    // once and terminates rather than expanding forever.
    const site = onlySite(`
      let p = join(a, "x");
      p = p;
      writeFileSync(p, "y");
    `);
    expect(site.view.match(/join\(a, "x"\)/g), "`p` was expanded once").toHaveLength(1);
  });
});

// ── Shape 10, found by the AI review on #1569 round 4 ────────────────

describe("SC-1566-SCOPE: an assignment never completes a value set it did not start", () => {
  /**
   * The round-3 fix asked the wrong question. `reassignable` keyed on the
   * binding KIND being `let`/`var`, which is a statement about how the name
   * was introduced, not about whether the sweep can see every value it can
   * hold. A `param`, a `catch` binding and a destructured one are all
   * assignable too — and worse, an assignment to one *removed* its
   * `unresolved` reason, because the reason was only recorded when the value
   * list came out empty. One conditional assignment and a binding whose
   * incoming value is wholly unknowable read as fully determined.
   *
   * The property: a value set is complete only when the DECLARATION
   * establishes it and nothing can change it afterwards — `const` with an
   * initialiser. Everything else is a lower bound, and an assignment adds to
   * a lower bound rather than closing it.
   */
  const SHAPES: [string, string][] = [
    [
      "a parameter",
      `function f(p, c) {
         if (c) p = join(d, "report.json");
         writeFileSync(p, "x");
       }`,
    ],
    [
      "a destructured binding",
      `let { p } = cfg;
       p = join(d, "report.json");
       writeFileSync(p, "x");`,
    ],
    [
      "a catch binding",
      `try { g(); } catch (p) {
         p = join(d, "report.json");
         writeFileSync(p, "x");
       }`,
    ],
  ];

  test("an assignment does not erase the reason the declaration gave no value", () => {
    const claimed: string[] = [];
    for (const [name, src] of SHAPES) {
      const site = onlySite(src);
      if (site.unresolved.length === 0) claimed.push(name);
    }
    expect(
      claimed,
      "these bindings carry an unknowable incoming value and the sweep reported " +
        "them as fully resolved, because one assignment supplied a value",
    ).toEqual([]);
  });

  test("each of them is UNDETERMINED even though a literal is visible", () => {
    const determined: string[] = [];
    for (const [name, src] of SHAPES) {
      const site = onlySite(src);
      if (!site.reassignable) determined.push(name);
      expect(site.opaque, `${name}: the path at the write is not establishable`).toBe(true);
    }
    expect(determined, "the value set is a lower bound, not a complete reading").toEqual([]);
  });

  test("NEGATIVE CONTROL: a const with an initialiser is still determined", () => {
    // The whole population must not become undetermined — that is louder, not
    // more accurate, and it would make every row above pass vacuously. `d` is
    // declared: since #1584 a free identifier is a hole in its own right, and
    // leaving it free would make this control assert the old permissive
    // reading rather than the const property it is here for.
    const site = onlySite('const d = "/tmp";\nconst p = join(d, "report.json");\nwriteFileSync(p, "x");');
    expect(site.reassignable).toBe(false);
    expect(site.opaque).toBe(false);
    expect(site.unresolved).toEqual([]);
    expect(specTargetingOf(site)).toBe(false);
  });

  test("NEGATIVE CONTROL: the assignment is still READ, over-reporting not dropped", () => {
    // Marking the site undetermined must not stop the sweep seeing the spec
    // path the assignment names. Both readings, or the fix trades one silent
    // miss for another.
    const site = onlySite(
      `function f(p, c) {
         if (c) p = join(d, "A-SPEC.md");
         writeFileSync(p, "x");
       }`,
    );
    expect(specTargetingOf(site)).toBe(true);
    expect(site.reassignable).toBe(true);
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
