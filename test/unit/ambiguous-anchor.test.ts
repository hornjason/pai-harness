/**
 * #668 — an anchor that names two places.
 *
 * `lib/source-slice.ts` refused four bad cuts by name and returned a
 * CONFIDENT WRONG ONE for the fifth. `structuralCut` used `indexOf`,
 * `structuralCutAround` used `lastIndexOf`, and neither counted — so a
 * duplicated anchor produced a well-formed, non-empty cut about whichever
 * occurrence the direction of the search happened to reach.
 *
 * That is worse than the four it did refuse, because those return nothing
 * and this returns something. It is the failure line numbers already had
 * (#514), arriving in the module written to replace them.
 *
 * `lib/source-anchor.ts` is named in that module's own docblock as its
 * model, and has said *"not found and found-twice are both refusals"*
 * since it was written. This is the sibling catching up.
 *
 * ## The live instances, which the issue said did not exist
 *
 * #668 was filed saying *"Not live — no duplicate anchor among the
 * converted sites."* **Two of the eleven converted sites were live**, found
 * the moment the refusal was switched on, and neither was findable by
 * reading:
 *
 *   - `test/agent-timings-queued.test.ts` cut around `TIMING: ${t.agent}`,
 *     which occurs THREE times in that loop — the orphan line, the
 *     unterminated line and the one with the wait on it. The case is named
 *     "the TIMING log line prints the wait when there was one" and the cut
 *     was anchored on the orphan line.
 *   - `test/ac-coverage.test.ts` used the start anchor `    acs: {`, which
 *     is also a substring of the ten-space-indented
 *     `          acs: { type: 'array', … }` further down `ship.js`.
 *
 * Both were green. Both are now spelled uniquely, and this file holds the
 * population at zero.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

import {
  AmbiguousAnchorError,
  AnchorNotFoundError,
  anchorOccurrences,
  structuralCut,
  structuralCutAround,
} from "../../lib/source-slice";

const REPO = join(import.meta.dir, "..", "..");

/**
 * A document in which `marker` genuinely occurs twice, in two different
 * constructs that a cut would answer differently about.
 *
 * Not two identical blocks: if both occurrences produced the same cut, the
 * fixture would reach its assertion whether or not the feature existed
 * (#500). The second block's body differs, so "which one did you cut" has
 * an observable answer.
 */
const DOUBLED = [
  "function alpha() {",
  "  const marker = 1;",
  "  return 'FIRST_BODY';",
  "}",
  "",
  "function beta() {",
  "  const marker = 1;",
  "  return 'SECOND_BODY';",
  "}",
  "",
].join("\n");

describe("#668: a duplicated anchor is refused, not guessed at", () => {
  test("the premise: the two occurrences really would cut different regions", () => {
    // Without this the refusal could be hiding an ambiguity that does not
    // matter, and no count in this file would show it.
    const first = DOUBLED.indexOf("const marker = 1;");
    const last = DOUBLED.lastIndexOf("const marker = 1;");
    expect(first).not.toBe(last);
    expect(DOUBLED.slice(first).includes("FIRST_BODY")).toBe(true);
    expect(DOUBLED.slice(last).includes("FIRST_BODY")).toBe(false);
  });

  test("structuralCut refuses a doubled subject anchor, with the count", () => {
    let thrown: unknown;
    try {
      structuralCut(DOUBLED, "const marker = 1;", { endAnchor: "\n}" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AmbiguousAnchorError);
    const err = thrown as AmbiguousAnchorError;
    expect(err.occurrences, "the count is the thing a reader would otherwise go and compute").toBe(2);
    expect(err.message).toContain("appears 2 times");
    expect(err.message, "and the anchor itself, or nobody knows which cut refused")
      .toContain("const marker = 1;");
    expect(err.message).toContain("anchor");
  });

  test("structuralCutAround refuses a doubled SUBJECT anchor", () => {
    expect(() =>
      structuralCutAround(DOUBLED, "const marker = 1;", {
        startAnchor: "function alpha() {",
        end: { balanced: "{" },
      }),
    ).toThrow(AmbiguousAnchorError);
  });

  /**
   * The half the cheapest wrong fix leaves out.
   *
   * `structuralCutAround` reached for `lastIndexOf(startAnchor, at)`, which
   * makes a duplicated start anchor look RESOLVED — it picks the nearest
   * preceding occurrence, which is a plausible region and not necessarily
   * the right one. A refusal added only to `structuralCut` would leave this
   * exactly as it was.
   */
  test("structuralCutAround refuses a doubled START anchor, named as the start anchor", () => {
    const doc = ["function wrap() {", DOUBLED, "}", ""].join("\n");
    let thrown: unknown;
    try {
      structuralCutAround(doc, "SECOND_BODY", {
        startAnchor: "const marker = 1;",
        end: { balanced: "{" },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AmbiguousAnchorError);
    expect((thrown as AmbiguousAnchorError).message, "the role tells the caller WHICH argument to fix")
      .toContain("start anchor");
  });

  test("a unique anchor is unaffected — the refusal is about duplication, not about counting", () => {
    expect(structuralCut(DOUBLED, "function beta() {", { balanced: "{" })).toContain("SECOND_BODY");
    expect(structuralCut(DOUBLED, "function beta() {", { balanced: "{" })).not.toContain("FIRST_BODY");
  });

  test("absent is still AnchorNotFoundError, and the two refusals stay distinct", () => {
    // One refusal for both would make "you spelled it wrong" and "you named
    // two places" the same message, and they need different fixes.
    expect(() => structuralCut(DOUBLED, "function gamma() {", { balanced: "{" }))
      .toThrow(AnchorNotFoundError);
    expect(() => structuralCut(DOUBLED, "const marker = 1;", { endAnchor: "\n}" }))
      .not.toThrow(AnchorNotFoundError);
  });

  /**
   * The end anchor is NOT counted, and that is a decision rather than an
   * omission carried forward.
   *
   * An end anchor is a boundary searched FORWARD from a known start, so the
   * nearest one is correct by construction. `"\n}"` closes hundreds of
   * functions in any file worth cutting; refusing it as ambiguous would
   * make the end-anchor form unusable, which is how a refusal becomes one
   * everybody learns to click past.
   */
  test("a repeated END anchor is not ambiguous — the nearest one is the boundary", () => {
    expect(anchorOccurrences(DOUBLED, "\n}"), "the premise: the end anchor really does repeat")
      .toBe(2);
    const cut = structuralCut(DOUBLED, "function alpha() {", { endAnchor: "\n}" });
    expect(cut).toContain("FIRST_BODY");
    expect(cut, "it must stop at the FIRST close, not run to the second").not.toContain("SECOND_BODY");
  });
});

describe("#668: anchorOccurrences is the one binding that counts", () => {
  test("it counts overlapping-free occurrences, and an empty anchor is zero", () => {
    expect(anchorOccurrences("a b a b a", "a")).toBe(3);
    expect(anchorOccurrences("abc", "z")).toBe(0);
    // `"abc".split("")` is three elements, so the naive form reports 2 for
    // an anchor that names nothing — and `indexOf("")` is 0, so without the
    // guard an empty anchor silently cuts from the top of the file.
    expect(anchorOccurrences("abc", ""), "an anchor that names nothing occurs nowhere").toBe(0);
  });

  test("an empty anchor is refused rather than cutting from offset zero", () => {
    expect(() => structuralCut(DOUBLED, "", { balanced: "{" })).toThrow(AnchorNotFoundError);
  });

  test("test/worktree-repo.test.ts no longer counts occurrences by hand", () => {
    // Criterion 2. The mutant builder there wrote
    // `source.split(ELSE_SITE).length - 1` and refused on anything but 1,
    // which is the same question `structuralCut` now asks. Two deciders
    // answering one question are behaviourally one: mutating either leaves
    // the other refusing, and the row measures 0.
    const src = readFileSync(join(REPO, "test", "worktree-repo.test.ts"), "utf-8");
    expect(src).not.toContain("source.split(ELSE_SITE).length - 1");
    expect(src, "and the site is still cut, so the refusal is still reached")
      .toContain("structuralCut(source, ELSE_SITE");
  });
});

/**
 * Criterion 5 — the population, swept rather than listed.
 *
 * A list of the eleven converted sites decays the moment somebody converts
 * a twelfth. This reads every `structuralCut`/`structuralCutAround` call in
 * `test/`, resolves the document each one reads, and counts.
 *
 * It reports how many sites and anchors it checked, because a scan that
 * found nothing to check reports clean — which is indistinguishable from a
 * scan that found nothing wrong (#492).
 */
describe("#668: no converted site passes an anchor that occurs more than once", () => {
  /**
   * Every `structuralCut*` call in `test/`, paired with the IDENTIFIER it
   * reads and the anchors it passes.
   *
   * The first draft of this scan asked a cheaper question — "does this file
   * mention ship.js? then check all its anchors against ship.js" — and
   * reported two offenders that are not offenders: `sc-claim-forms.test.ts`
   * cuts a different document with `"/**"`, and
   * `source-slice-structural.test.ts` passes `TIMING: ${t.agent}` to a
   * SYNTHETIC fixture while also reading ship.js elsewhere. A scan that
   * mis-attributes is worse than no scan, so the document is resolved per
   * call site and anything it cannot resolve is REPORTED rather than
   * skipped — an unresolvable site silently dropped reads as a clean one.
   */
  interface Site {
    file: string;
    doc: string;
    anchors: string[];
  }

  /**
   * A call site whose anchor the scan could not read.
   *
   * ONE shape, because there is one consumer and it asks one question of
   * every entry. The SUBJECT case and the START case differ only in which
   * expression was unreadable, which is what `expr` is for — so neither
   * needs a field the other lacks, and a `kind` nobody branches on would be
   * a second decider of what an entry means (#1078).
   */
  interface Unscannable {
    file: string;
    doc: string;
    expr: string;
  }

  function scanSource(name: string, src: string): { sites: Site[]; unscannable: Unscannable[] } {
    const sites: Site[] = [];
    const unscannable: Unscannable[] = [];

    // A file that only MENTIONS the name — an import, a comment, a
    // population scan like this one — is not a call site and is not
    // unscannable. Only a call whose anchor the scan cannot read is.
    const calls = [...src.matchAll(/structuralCut(Around)?\(\s*([A-Za-z0-9_.]+)\s*,\s*(?:"((?:[^"\\]|\\.)*)"|([^,]+)),/g)];
    for (const c of calls) {
      const [whole, around, doc, literal, computed] = c;
      // The one place an unscannable entry is built. Both cases below go
      // through it, so there is one shape to produce and one to read.
      const report = (expr: string) => unscannable.push({ file: name, doc, expr });

      if (literal === undefined) {
        report(String(computed).trim().slice(0, 40));
        continue;
      }
      const anchors = [literal];
      if (around) {
        // The start anchor belongs to THIS call, so it is taken from the
        // text of this call rather than from the file at large — two
        // Around calls in one file would otherwise cross-contaminate.
        const tail = src.slice(c.index ?? 0, (c.index ?? 0) + whole.length + 600);
        const sa = /startAnchor:\s*(?:"((?:[^"\\]|\\.)*)"|([^,\n}]+))/.exec(tail);
        if (sa?.[1] !== undefined) anchors.push(sa[1]);
        // `startAnchor` is required by the signature, so no match at all is
        // the 600-char window falling short rather than an absent option.
        // Either way the anchor was not read, which is the thing to report.
        else report(sa ? String(sa[2]).trim().slice(0, 40) : "(no startAnchor within 600 chars)");
      }
      sites.push({ file: name, doc, anchors });
    }
    return { sites, unscannable };
  }

  function callSites(): { sites: Site[]; unscannable: Unscannable[] } {
    const sites: Site[] = [];
    const unscannable: Unscannable[] = [];
    for (const name of readdirSync(join(REPO, "test"), { recursive: true }) as string[]) {
      if (!name.endsWith(".ts")) continue;
      const file = join(REPO, "test", name);
      let src: string;
      try {
        src = readFileSync(file, "utf-8");
      } catch {
        continue; // a directory entry, not a file
      }
      if (!src.includes("structuralCut")) continue;
      const scan = scanSource(name, src);
      sites.push(...scan.sites);
      unscannable.push(...scan.unscannable);
    }
    return { sites, unscannable };
  }

  const { sites: SITES, unscannable: UNSCANNABLE } = callSites();

  /** Identifiers a file binds to a read of `workflows/ship.js`. */
  function shipIdentifiers(src: string): Set<string> {
    const ids = new Set<string>();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*([^;]*ship\.js[^;]*);/g)) {
      if (/readFileSync|readFile/.test(m[2])) ids.add(m[1]);
    }
    return ids;
  }

  test("the scan found call sites to check — a scan reading nothing reports clean", () => {
    const total = SITES.reduce((n, s) => n + s.anchors.length, 0);
    expect(SITES.length, "no structuralCut call sites found; the scan is not reading the tree")
      .toBeGreaterThan(8);
    expect(total, "no anchors extracted; the literal pattern has stopped matching")
      .toBeGreaterThan(10);
    console.log(`#668 scan: ${SITES.length} call site(s), ${total} anchor literal(s), ` +
      `${UNSCANNABLE.length} unscannable`);
  });

  /**
   * The scan's own blind spot, bounded by a PROPERTY rather than by a list.
   *
   * Some calls pass a computed anchor — `structuralCut(doc, anchor, …)` in
   * `source-slice-structural.test.ts`, which drives synthetic fixtures
   * through a loop. Those are legitimate and the scan cannot read them, so
   * it contributes zero offenders for them, which is exactly what a clean
   * site contributes.
   *
   * An exemption list naming those files would become evidence they are
   * fine, and would have to be maintained. The bound asserted instead is
   * the one that matters: **a computed anchor is never pointed at
   * `ship.js`.** So the scan is allowed to be blind, and only about
   * documents whose duplicates cannot reach a converted site.
   */
  function unreadableShipAnchors(
    entries: Unscannable[],
    readSource: (file: string) => string,
  ): string[] {
    const offenders: string[] = [];
    for (const { file, doc, expr } of entries) {
      const ids = shipIdentifiers(readSource(file));
      if (ids.has(doc)) offenders.push(`${file}: unreadable anchor ${expr} is cut from ship.js`);
    }
    return offenders;
  }

  /** The reader the suite runs against the tree — the one that threw in #1078. */
  const readTestSource = (file: string) => readFileSync(join(REPO, "test", file), "utf-8");

  test("no UNREADABLE anchor is pointed at ship.js — the scan's blindness is bounded", () => {
    expect(unreadableShipAnchors(UNSCANNABLE, readTestSource)).toEqual([]);
  });

  /**
   * #1078 — the reporting path itself, put through both of its inputs.
   *
   * The scan above reads every `.ts` under `test/`, including this file, so
   * the fixtures below spell the call name as a concatenation: written whole
   * they would be read as real call sites and this file would report itself.
   *
   * The fixtures are attributed to THIS file, derived rather than spelled, so
   * the consumer runs with `readTestSource` — the reader that threw — against
   * a path that exists. The `SHIP` binding the consumer then finds is the
   * `SHIP_BOUND` line below, which is in this file because the fixture is.
   */
  const AROUND = "structuralCut" + "Around";
  const SELF = relative(join(REPO, "test"), import.meta.path);
  const SHIP_BOUND = `const SHIP = readFileSync(join(REPO, "workflows", "ship.js"), "utf-8");`;
  const NON_LITERAL_START = `${SHIP_BOUND}
const START = "function main(";
${AROUND}(SHIP, "needle", { startAnchor: START, end: "}" });
`;
  const SCANNABLE = `${SHIP_BOUND}
${AROUND}(SHIP, "needle", { startAnchor: "function main(", end: "}" });
`;

  test("#1078: a non-literal START anchor is REPORTED, and the consumer reads it", () => {
    const scan = scanSource(SELF, NON_LITERAL_START);
    expect(scan.sites.length, "the subject anchor is still a literal, so the site is scannable")
      .toBe(1);
    expect(scan.unscannable.length, "the unreadable start anchor must produce one entry").toBe(1);
    expect(scan.unscannable[0], "it names the file and the expression, in the one shape")
      .toEqual({ file: SELF, doc: "SHIP", expr: "START" });

    // The clause #1078 is about. Before the fix the entry was a prose
    // sentence, so `split("|")` handed this reader a filename with an error
    // message glued to it and the check died instead of reporting.
    expect(() => unreadableShipAnchors(scan.unscannable, readTestSource)).not.toThrow();

    // And it reports. Read against the fixture's own source — where `SHIP` is
    // bound to a read of ship.js — the entry comes back as an offender.
    const offenders = unreadableShipAnchors(scan.unscannable, () => NON_LITERAL_START);
    expect(offenders.length, "the doc is bound to ship.js, so this entry is an offender").toBe(1);
    expect(offenders[0]).toContain(SELF);
    expect(offenders[0], "the entry must name the expression the scan could not read")
      .toContain("START");
  });

  test("#1078 control: an all-literal call reports nothing — a reporter of everything fails", () => {
    const scan = scanSource(SELF, SCANNABLE);
    expect(scan.sites.length).toBe(1);
    expect(scan.sites[0].anchors, "both anchors are literals and both are read")
      .toEqual(["needle", "function main("]);
    expect(scan.unscannable.length, "nothing here is unreadable").toBe(0);
    expect(unreadableShipAnchors(scan.unscannable, () => SCANNABLE)).toEqual([]);
  });

  test("every anchor against workflows/ship.js occurs at most once", () => {
    const ship = readFileSync(join(REPO, "workflows", "ship.js"), "utf-8");
    const offenders: string[] = [];
    let checked = 0;
    for (const site of SITES) {
      const ids = shipIdentifiers(readFileSync(join(REPO, "test", site.file), "utf-8"));
      if (!ids.has(site.doc)) continue; // this call cuts some other document
      for (const raw of site.anchors) {
        const anchor = JSON.parse(`"${raw}"`) as string;
        checked++;
        const n = anchorOccurrences(ship, anchor);
        if (n > 1) offenders.push(`${site.file}: ${JSON.stringify(anchor)} occurs ${n} times`);
      }
    }
    // The denominator, asserted. Zero offenders out of zero anchors checked
    // is the vacuous pass this whole file is about.
    expect(checked, "no anchor was resolved to ship.js; the identifier scan found nothing")
      .toBeGreaterThan(8);
    expect(offenders).toEqual([]);
  });
});
