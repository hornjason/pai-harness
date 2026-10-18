/**
 * Covers SC-2020..SC-2025 (SCAFFOLD-DECOMPOSITION-SPEC.md), #589.
 *
 * `findClosestPattern`'s last resort in `scripts/audit-specs.ts` matches any
 * filename-like token ANYWHERE in a sentence and renders the whole criterion
 * as `<that file> exists`. Measured over the corpus `scaffold . --fix`
 * actually edits — the unchecked, unmatched criteria of the testable specs in
 * `specs/` — two criteria went through it:
 *
 *   SC-1940  Rejecting a promoted rule writes its hash to
 *            `reference/rejected-constraints.md` and it is never re-promoted
 *              -> reference/rejected-constraints.md exists
 *
 *   SC-1943  Makefile targets, `package.json` scripts and CI workflow files
 *            are scanned for constraints alongside markdown
 *              -> package.json exists
 *
 * Both replacements hold vacuously against a file that obviously exists, and
 * neither is about what the criterion claims. #586 looked at this, decided it
 * was a DOWNGRADE rather than a LOSS — the fallback reports `ambiguous: true`,
 * so the original is written into a `REVIEW` comment on the next line — and
 * filed it rather than folding it in. This is that issue.
 *
 * ## The property that separates the two classes
 *
 * **The fallback may only fire on a criterion that makes ONE claim.**
 *
 * SC-1940 coordinates two: a hash is written, AND the rule never resurfaces.
 * SC-1943 coordinates a three-item subject — Makefile targets, `package.json`
 * scripts, CI workflow files — of which the filename is one. `<file> exists`
 * can be about at most one of those, so the rewrite is guaranteed to be about
 * something other than what the criterion claims. The criterion that is still
 * rewritten — "the generator should emit a tidy CODE-MAP.md for every
 * project" — makes a single claim about the single file it names.
 *
 * ## The cheapest wrong fix, named in advance
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape asks what
 * somebody would do at 5pm to make the symptom go away. Here it is **narrow
 * the fallback to statements whose verb is existence** — `exists`, `is
 * present`, `must exist`. Both criteria above lose their rewrite under it and
 * the issue closes.
 *
 * It is the wrong fix because it switches the fallback off for the whole
 * population: the one criterion #426 pinned as having to survive — SC-1587's
 * `UNSTRUCTURED`, whose verb is *emit* — goes with it, and `--fix` stops
 * rewriting anything at all. So every case below that asserts a criterion is
 * KEPT sits beside one asserting that non-existence-verb statement is still
 * rewritten, and the mutant case asserts both directions in one run.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  auditSpecs,
  closestPatternFor,
  coordinatedClaims,
  decideRewrite,
  type RewriteEntry,
} from "../scripts/audit-specs";

const ROOT = join(import.meta.dir, "..");
const AUDIT_SPECS = join(ROOT, "scripts", "audit-specs.ts");
const SCRIPTS_DIR = join(ROOT, "scripts");

/**
 * The two criteria the fallback rewrote, verbatim from the tree.
 *
 * Pinned as strings AND asserted to still be in the spec (SC-2020). A fixture
 * that quietly stops matching the tree it is about is #507's shape: it keeps
 * passing and stops being a witness.
 */
const NAMED_SPEC = join(ROOT, "specs", "RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md");
const SC_1940 =
  "Rejecting a promoted rule writes its hash to `reference/rejected-constraints.md` " +
  "and it is never re-promoted";
const SC_1943 =
  "Makefile targets, `package.json` scripts and CI workflow files are scanned for " +
  "constraints alongside markdown";

/**
 * The control, and it is the same string #426 pinned in SC-1587 and #586
 * pinned in SC-2001. Its verb is *emit*, so a fix that required an existence
 * verb would take it with them.
 */
const SINGLE_CLAIM = "the generator should emit a tidy CODE-MAP.md for every project";
const SINGLE_CLAIM_REWRITE = "CODE-MAP.md exists";

// ── A temp project whose specs/ is a copy of this repo's ──────

function writeSpec(root: string, name: string, body: string): string {
  mkdirSync(join(root, "specs"), { recursive: true });
  const path = join(root, "specs", name);
  writeFileSync(
    path,
    `---\ndoc-type: spec\nstatus: active\ntestable: true\ncompliance: strict\n` +
      `updated: 2026-10-18\ngoverns: the #589 fixture\n---\n\n# Fixture\n\n` +
      `## Success Criteria\n\n${body}\n`,
  );
  return path;
}

/** Entries the LAST-RESORT file-token match produced, by asking the real predicate. */
function fallbackRewrites(rewrites: RewriteEntry[]): RewriteEntry[] {
  return rewrites.filter(r => !r.kept && closestPatternFor(r.before)?.fallback === true);
}

/** Entries the fallback reached and the decision declined. */
function fallbackKeeps(rewrites: RewriteEntry[]): RewriteEntry[] {
  return rewrites.filter(r => !!r.kept && closestPatternFor(r.before)?.fallback === true);
}

// ── AC-1 ──────────────────────────────────────────────────────

describe("SC-2020: a filename a criterion mentions is not what the criterion is about", () => {
  test("neither named criterion is rewritten, and each says which claim the rewrite would drop", () => {
    // The fixture is still the tree's. Asserted first, because the two
    // strings below are the whole subject of this file and a reworded spec
    // would leave every case green over a statement nothing declares.
    const spec = readFileSync(NAMED_SPEC, "utf-8");
    expect(spec, "SC-1940 no longer reads as this file assumes").toContain(`- [ ] SC-1940: ${SC_1940}`);
    expect(spec, "SC-1943 no longer reads as this file assumes").toContain(`- [ ] SC-1943: ${SC_1943}`);

    for (const [id, statement, dropped] of [
      ["SC-1940", SC_1940, "it is never re-promoted"],
      ["SC-1943", SC_1943, "CI workflow files are scanned for constraints alongside markdown"],
    ] as const) {
      const closest = closestPatternFor(statement);

      // The fallback is still what reaches this statement — not a matcher
      // that started binding it for an unrelated reason. "Kept because the
      // guard refused" and "kept because nothing proposed a rewrite" are
      // different states and only one of them is this fix.
      expect(closest?.fallback, `${id} no longer reaches the last-resort match`).toBe(true);

      const decision = decideRewrite(statement, closest);
      expect(decision.kind, `${id} was rewritten to ${JSON.stringify(decision)}`).toBe("keep");
      const reason = decision.kind === "keep" ? decision.reason : "";
      expect(reason, `${id} is kept with no reason naming the claim that would be dropped`)
        .toContain(dropped);
      expect(reason).toContain("the file is mentioned, not what the criterion is about");
    }
  });

  test("the control: a single-claim criterion naming a file is still rewritten", () => {
    // AC-2's other half, in the same describe as the keeps so a fix that
    // simply switched the fallback off cannot satisfy the block.
    const closest = closestPatternFor(SINGLE_CLAIM);
    expect(closest?.fallback, "the control no longer goes through the fallback").toBe(true);
    const decision = decideRewrite(SINGLE_CLAIM, closest);
    expect(decision.kind, "the fallback rewrites nothing at all — it has been switched off")
      .toBe("rewrite");
    expect(decision.kind === "rewrite" && decision.statement).toBe(SINGLE_CLAIM_REWRITE);
  });
});

// ── AC-2: the write, not just the decision ────────────────────

describe("SC-2021: the rewritten line still carries the original beside it", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fallback-scope-write-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("--fix leaves both named criteria byte-identical and rewrites the single-claim one", () => {
    const path = writeSpec(
      dir,
      "FALLBACK-SPEC.md",
      [
        `- [ ] SC-9601: ${SC_1940}`,
        `- [ ] SC-9602: ${SC_1943}`,
        `- [ ] SC-9603: ${SINGLE_CLAIM}`,
      ].join("\n"),
    );
    const before = readFileSync(path, "utf-8");
    auditSpecs(dir, { fix: true });
    const after = readFileSync(path, "utf-8");

    expect(after, "SC-9601 was rewritten into a file-existence check")
      .toContain(`- [ ] SC-9601: ${SC_1940}`);
    expect(after, "SC-9602 was rewritten into a file-existence check")
      .toContain(`- [ ] SC-9602: ${SC_1943}`);

    // The positive control, and the reason it is in THIS test: a `--fix`
    // that had become a no-op would satisfy both assertions above.
    expect(after, "--fix changed nothing at all").not.toBe(before);
    expect(after).not.toContain(`- [ ] SC-9603: ${SINGLE_CLAIM}\n`);
    expect(after).toContain(`- [ ] SC-9603: ${SINGLE_CLAIM_REWRITE}`);
    // #426's reason for keeping this path alive: the statement it replaced is
    // written into the next line, so nothing leaves the file.
    expect(after, "the rewrite dropped the statement it replaced")
      .toContain(`<!-- REVIEW: original — ${SINGLE_CLAIM} -->`);

    // And the declined lines are MARKED rather than silently skipped, which
    // is the coverage gap #586 made visible and this must not undo.
    for (const id of ["SC-9601", "SC-9602"]) {
      const lines = after.split("\n");
      const at = lines.findIndex(l => l.startsWith(`- [ ] ${id}: `));
      expect(lines[at + 1], `${id} carries no REVIEW marker`).toMatch(/^<!-- REVIEW: unmatched \(.+\) -->$/);
    }
  });
});

// ── AC-3: the population, over the corpus --fix actually edits ─

describe("SC-2022: the fallback rewrite population across specs/ is zero", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fallback-scope-pop-"));
    // A COPY, because the measurement is `--fix` executed rather than
    // described, and `--fix` writes. The repo's own specs/ is never touched.
    cpSync(join(ROOT, "specs"), join(dir, "specs"), { recursive: true });
  });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("the measured population is 0, down from the 2 criteria the fallback rewrote", () => {
    const result = auditSpecs(dir, { fix: true });
    const rewrites = result.rewrites ?? [];

    // The coverage controls FIRST. An empty population is also what a run
    // that read nothing produces, and a clean sweep over zero criteria is
    // this repo's commonest vacuous assertion.
    expect(result.specs.length, "the audit processed no spec files").toBeGreaterThan(10);
    // 19 on the tree at the time of #589. The floor is a coverage control,
    // not a ratchet: it exists so that a zero below cannot come from a run
    // that classified nothing.
    expect(result.totalUnmatched, "the audit classified no unmatched criteria")
      .toBeGreaterThan(10);
    expect(rewrites.length, "the fix run reached no criterion at all").toBeGreaterThan(10);

    // The fallback is still REACHED over this corpus — it is the guard that
    // declines, not an upstream matcher that stopped proposing. Without this
    // the zero below is satisfied by a fallback nothing arrives at.
    //
    // Asserted by REASON and not merely by id. Other criteria reach the
    // fallback and are declined by the guards #426 and #586 added —
    // SC-1944's leading token is backticked, so the drop-the-file guard
    // catches it — and an id-only assertion would be satisfied by those.
    const reached = new Map(fallbackKeeps(rewrites).map(r => [r.scId, r.kept!]));
    for (const id of ["SC-1940", "SC-1943"]) {
      expect(
        reached.get(id),
        `${id} no longer reaches the last-resort match, so the count below measures nothing`,
      ).toContain("the file is mentioned, not what the criterion is about");
    }

    expect(
      fallbackRewrites(rewrites).map(r => `${r.specFile} ${r.scId}: ${r.before} -> ${r.after}`),
      "a criterion was still replaced by a bare file-existence check",
    ).toEqual([]);
  });

  test("the population measurement can see a fallback rewrite when there is one", () => {
    // The counting half's own positive control, executed rather than
    // asserted: the identical measurement over the identical corpus plus one
    // single-claim criterion reports exactly one.
    writeSpec(dir, "ZZ-SINGLE-CLAIM-SPEC.md", `- [ ] SC-9604: ${SINGLE_CLAIM}`);
    const result = auditSpecs(dir, { fix: true });
    expect(
      fallbackRewrites(result.rewrites ?? []).map(r => `${r.scId}: ${r.after}`),
      "the measurement cannot see a fallback rewrite, so its zero means nothing",
    ).toEqual([`SC-9604: ${SINGLE_CLAIM_REWRITE}`]);
  });
});

// ── The predicate itself ──────────────────────────────────────

describe("SC-2023: the distinction answers both ways", () => {
  test("coordination is found where it is, and not where it is not", () => {
    expect(coordinatedClaims(SC_1940)).toEqual(["it is never re-promoted"]);
    expect(coordinatedClaims(SC_1943))
      .toEqual(["CI workflow files are scanned for constraints alongside markdown"]);
    expect(coordinatedClaims("the file is created or the run refuses"))
      .toEqual(["the run refuses"]);

    // The negative half. A predicate that answered true for everything would
    // satisfy every "is kept" case in this file and turn `--fix` off, which
    // is the most-caught mutation in #426's own battery.
    expect(coordinatedClaims(SINGLE_CLAIM)).toEqual([]);
    expect(coordinatedClaims("AGENTS.md exists")).toEqual([]);
    // `and` inside a word is not a coordinator, and a trailing one joins
    // nothing — both are shapes a criterion reaches.
    expect(coordinatedClaims("the command standardises every brand name")).toEqual([]);
    expect(coordinatedClaims("CODE-MAP.md is generated and ")).toEqual([]);
  });

  test("the guard is scoped to the fallback — a bound pattern with coordination still rewrites", () => {
    // #492: every fixture in a battery meets the feature's precondition, so
    // the branch where it does not hold is outside the battery's reach. Here
    // the precondition is `closest.fallback`, and this is the one input on
    // the other side of it: a coordinated statement the `file-exists`
    // HEURISTIC binds, which must be unaffected by this change.
    const bound = "AGENTS.md must exist and the scan must be current";
    const closest = closestPatternFor(bound);
    expect(closest?.patternName).toBe("file-exists");
    expect(closest?.fallback, "the heuristic stopped binding it, so this measures the fallback again")
      .toBeFalsy();
    expect(coordinatedClaims(bound).length, "the fixture carries no coordination to be scoped out")
      .toBeGreaterThan(0);
    expect(decideRewrite(bound, closest).kind, "the guard leaked out of the fallback path")
      .toBe("rewrite");
  });
});

// ── AC-4: the mutant ──────────────────────────────────────────

/**
 * The one line the mutant rewrites. Declared here so a rename aborts loudly
 * rather than leaving a mutant that is byte-identical to the real source.
 */
const BINDING = "export function coordinatedClaims(statement: string): string[] {";

export function buildMutantSource(src: string, signature = BINDING): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding signature appears ${occurrences} times, ` +
        `expected exactly 1. Either it was renamed, or a second copy decides the same ` +
        `question and removing one would leave the other refusing.`,
    );
  }
  const shortCircuited = src.replace(
    signature,
    `${signature}\n  return []; // MUTANT: the #589 distinction removed`,
  );
  // The mutant runs from a temp directory, so every relative specifier has to
  // become absolute. One left behind kills it on module resolution, and a
  // mutant that cannot load is not a mutant.
  const relocated = shortCircuited.replace(
    /from "(\.\.?\/[A-Za-z0-9._\-/]+)"/g,
    (_m, spec: string) => `from "${resolve(SCRIPTS_DIR, spec)}"`,
  );
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten`,
    );
  }
  return relocated;
}

describe("SC-2024: a mutant with the distinction removed rewrites both named criteria", () => {
  let dir = "";
  let mutant: {
    closestPatternFor: typeof closestPatternFor;
    decideRewrite: typeof decideRewrite;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fallback-scope-mutant-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "config"), { recursive: true });
    // `loadRegistry` resolves `../config/matcher-registry.json` from the
    // module's own location, so the mutant needs one beside it. Without this
    // it throws on first use, and a throw is not a measurement.
    cpSync(
      join(ROOT, "config", "matcher-registry.json"),
      join(dir, "config", "matcher-registry.json"),
    );
    const path = join(dir, "scripts", "audit-specs.ts");
    writeFileSync(path, buildMutantSource(readFileSync(AUDIT_SPECS, "utf-8")));
    mutant = (await import(path)) as typeof mutant;
  });

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("the mutant rewrites what the real source keeps, over the two named criteria", () => {
    // The mutant is proved FUNCTIONAL first. A mutant that failed to load its
    // registry, or that was never really mutated, declines everything — which
    // reads exactly like the mutation having been rejected on the merits.
    const control = mutant.decideRewrite(SINGLE_CLAIM, mutant.closestPatternFor(SINGLE_CLAIM));
    expect(control.kind, "the mutant rewrites nothing, so it is broken rather than mutated")
      .toBe("rewrite");
    expect(control.kind === "rewrite" && control.statement).toBe(SINGLE_CLAIM_REWRITE);

    // The named input on which mutant and original differ, run rather than
    // assumed — `.claude/rules/checks-must-be-able-to-fail.md` refuses a 0
    // without one.
    for (const [id, statement, rewrite] of [
      ["SC-1940", SC_1940, "reference/rejected-constraints.md exists"],
      ["SC-1943", SC_1943, "package.json exists"],
    ] as const) {
      const mutated = mutant.decideRewrite(statement, mutant.closestPatternFor(statement));
      expect(mutated.kind, `the mutant kept ${id}, so the mutation was never applied`)
        .toBe("rewrite");
      expect(mutated.kind === "rewrite" && mutated.statement).toBe(rewrite);

      expect(decideRewrite(statement, closestPatternFor(statement)).kind, `the real source rewrote ${id}`)
        .toBe("keep");
    }
  });

  test("the mutant builder aborts when the binding moves", () => {
    // The harness's own failure mode: a mutation whose target was renamed
    // silently no-ops and every case above goes green over an unmutated copy.
    expect(() => buildMutantSource(readFileSync(AUDIT_SPECS, "utf-8"), "export function notAThing(): void {"))
      .toThrow(/the binding signature appears 0 times/);
  });
});

// ── AC-5: the spec records it ─────────────────────────────────

describe("SC-2025: the spec records the population counts and the property", () => {
  test("the #589 section names both rewritten criteria and the before and after counts", () => {
    const spec = readFileSync(join(ROOT, "specs", "SCAFFOLD-DECOMPOSITION-SPEC.md"), "utf-8");
    const at = spec.indexOf("## #589");
    expect(at, "the spec carries no #589 section").toBeGreaterThan(-1);
    const section = spec.slice(at);
    // Search the SLICE, not the document (#297): the ids and phrases below
    // appear elsewhere in a 1,200-line spec, so a whole-file search would be
    // satisfied by #586's section.
    expect(section.length, "the #589 section is empty").toBeGreaterThan(400);

    expect(section, "the spec does not name the criteria the fallback rewrote")
      .toContain("rejected-constraints.md");
    expect(section).toContain("package.json");
    expect(section, "the spec does not record the property that separates the two classes")
      .toMatch(/\bone claim\b/i);
    expect(section, "the spec does not record the before and after population")
      .toMatch(/fallback rewrote (?:two|2)\b/i);
  });
});
