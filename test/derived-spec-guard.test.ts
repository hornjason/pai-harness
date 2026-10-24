/**
 * #1286 — `audit-specs --fix` must not write a spec a generator produces.
 *
 * On 2026-10-22 `--fix` injected 39 `<!-- REVIEW: unmatched (...) -->` lines
 * into a consumer's `specs/POV-SPEC.md`, which is produced by that
 * consumer's `scripts/sync-spec.ts` and hash-pinned by its
 * `test/spec-drift.test.ts`. The edit broke the recorded hash and would have
 * been discarded by the next regeneration: destructive and futile at once.
 * The file declared itself derived, in English, above the fold.
 *
 * ## What this battery mutates, and why there is exactly one thing to mutate
 *
 * `mayWrite` in `lib/derived-spec.ts` is the only place the three readings
 * become a yes or a no, and the case below asserts that — the comparison is
 * required to appear exactly once in the source, so a mutant cannot be held
 * up by a surviving second decider (the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The mutant is a copy of `lib/derived-spec.ts` with that comparison replaced
 * by `return true` — "every file is authored", which is both the pre-#1286
 * behaviour and the shape of the regression somebody would plausibly
 * reintroduce. A copy of `scripts/audit-specs.ts` sits beside it with its
 * other relative imports rewritten to absolute paths, so `../lib/derived-spec`
 * is the ONE specifier that resolves into the mutant tree. `config/` is
 * copied too, because `loadRegistry()` resolves the matcher registry through
 * `import.meta.url` and a mutant that died looking for it would read as a
 * guard that held.
 *
 * Three properties keep the count honest, each its own assertion:
 *
 *   - **The baseline is read first.** The real run is asserted before any
 *     mutant run, because an instrument that stopped reporting takes the
 *     baseline down with it and that is the row nobody checks.
 *   - **A positive control the mutation cannot reach.** The hand-authored
 *     fixture is rewritten by the real run AND by the mutant. A mutant that
 *     failed to load, or one that refused everything, fails that row — so a
 *     "the derived file got written" result cannot come from a broken mutant.
 *   - **Green and red are compared by name**, never as "2 of 3".
 *
 * ## What #1552 deleted from this file, and why
 *
 * The per-FILE classification sweep that used to close this file — every
 * read-then-write candidate had to appear on `IN_PLACE_SPEC_WRITERS`,
 * `GUARDED_UPSTREAM` or `NOT_SPEC_WRITERS` — is gone. It answered "has
 * somebody classified this file", and `test/spec-write-chokepoint.test.ts`
 * now answers the strictly stronger "does a raw write primitive aim at a spec
 * path", per CALL SITE rather than per file. Two mechanisms answering one
 * question are the fourth shape one level up: no behavioural test can tell
 * them apart, and the weaker one goes on reading as covered.
 *
 * Exactly one property did not transfer — `GUARDED_UPSTREAM`, which asserts
 * that `hooks/DocHygiene.hook.ts` can only write through `lib/frontmatter.ts`.
 * The sweep cannot see that target, so silence about it would be blindness
 * rather than safety. It moved to the new file as a declared list of its own.
 *
 * What stays here: the mutation battery over `audit-specs --fix`, and the
 * corpus control on the prose detector. Both test `mayWrite` and
 * `readDerivedDeclaration` — a different question from "did the write go
 * through the chokepoint".
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync } from "fs";
import { join } from "path";
import {
  DERIVED_KEY,
  mayWrite,
  readDerivedDeclaration,
  skipLine,
} from "../lib/derived-spec";
import { collectSpecFiles } from "../lib/spec-files";
import { auditSpecs } from "../scripts/audit-specs";

const REPO = join(import.meta.dir, "..");
const GUARD_SOURCE = join(REPO, "lib", "derived-spec.ts");
const AUDIT_SOURCE = join(REPO, "scripts", "audit-specs.ts");
/**
 * #1552 put `lib/write-spec.ts` between `audit-specs.ts` and the guard. It has
 * to be carried into the mutant tree, or `../lib/write-spec` resolves to the
 * REAL chokepoint, which imports the REAL guard — and the mutant rows below go
 * green having mutated nothing. A test case asserts the binding rather than
 * trusting this comment.
 */
const CHOKEPOINT_SOURCE = join(REPO, "lib", "write-spec.ts");

/** The one line the write decision is made on, and the single site mutated. */
const DECISION = 'return reading.status === "authored";';

/** Always-writable: the pre-#1286 behaviour, and the shape of the regression. */
const ALWAYS_WRITABLE = "return true;";

/** The specifiers the mutant must keep relative, so they bind inside the mutant tree. */
const GUARD_SPECIFIER = "../lib/derived-spec";
const CHOKEPOINT_SPECIFIER = "../lib/write-spec";
const MUTANT_RELATIVE = [GUARD_SPECIFIER, CHOKEPOINT_SPECIFIER];

// ── Fixtures ──────────────────────────────────────────────────

/** Two criteria no registry pattern binds, so `--fix` always has work to do. */
const UNBINDABLE = [
  "- [ ] SC-9810: the widget frobnicates the doohickey in a way nothing matches",
  "- [ ] SC-9811: some other unbindable prose about reticulating splines",
].join("\n");

function spec(head: string): string {
  return `---
doc-type: spec
testable: true
compliance: strict
governs: a fixture
---
${head}
# Fixture

## Success Criteria

${UNBINDABLE}
`;
}

/** Declares a generator in frontmatter — the protection this issue adds. */
const DERIVED = `---
doc-type: spec
testable: true
compliance: strict
governs: a fixture
${DERIVED_KEY}: scripts/sync-spec.ts
---

# Fixture

## Success Criteria

${UNBINDABLE}
`;

/** The consumer's actual marker: English, in an HTML comment, above the fold. */
const PROSE_ONLY = spec(`
<!-- DERIVED FILE — do not edit here.

The canonical spec lives in ../canonical/spec.md. It is regenerated by
\`bun scripts/sync-spec.ts\`, and any edit made here is discarded.
-->
`);

/** Hand-authored. The negative control: this one MUST still be rewritten. */
const AUTHORED = spec("");

const FILES: Record<string, string> = {
  "DERIVED.md": DERIVED,
  "PROSE.md": PROSE_ONLY,
  "AUTHORED.md": AUTHORED,
};

function plantSpecs(): string {
  const root = mkdtempSync(join(import.meta.dir, ".derived-guard-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  for (const [name, body] of Object.entries(FILES)) {
    writeFileSync(join(root, "specs", name), body);
  }
  return root;
}

/** Which planted specs came back with their bytes changed. */
function movedFiles(root: string): string[] {
  return Object.keys(FILES)
    .filter((n) => readFileSync(join(root, "specs", n), "utf-8") !== FILES[n])
    .sort();
}

// ── Mutant construction ───────────────────────────────────────

export function buildMutantGuard(source: string): string {
  const occurrences = source.split(DECISION).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the write decision appears ${occurrences} times in ` +
        `lib/derived-spec.ts. At 0 it has moved and the mutant would be a copy of the ` +
        `original; above 1 the surviving copy holds every case up and the reds mean nothing.`,
    );
  }
  return source.replace(DECISION, ALWAYS_WRITABLE);
}

/**
 * Point a copy of `audit-specs.ts` at the mutant guard and at the real
 * everything-else. Only `../lib/derived-spec` stays relative; every other
 * relative specifier becomes absolute, or the copy dies on module resolution
 * and a dead mutant reads as a guard that held.
 */
export function retargetImports(source: string): string {
  return source.replace(/from "(\.\.\/[^"]+)"/g, (whole, spec: string) =>
    MUTANT_RELATIVE.includes(spec) ? whole : `from "${join(REPO, spec.slice(3))}"`,
  );
}

function buildMutantTree(): string {
  const dir = mkdtempSync(join(import.meta.dir, ".derived-mutant-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "lib", "derived-spec.ts"),
    buildMutantGuard(readFileSync(GUARD_SOURCE, "utf-8")),
  );
  // #1552: copied verbatim. Its one relative import, `./derived-spec`, now
  // resolves to the mutant guard beside it.
  writeFileSync(join(dir, "lib", "write-spec.ts"), readFileSync(CHOKEPOINT_SOURCE, "utf-8"));
  writeFileSync(
    join(dir, "scripts", "audit-specs.ts"),
    retargetImports(readFileSync(AUDIT_SOURCE, "utf-8")),
  );
  // `loadRegistry()` resolves this through `import.meta.url`.
  cpSync(join(REPO, "config"), join(dir, "config"), { recursive: true });
  return dir;
}

// ── The battery ───────────────────────────────────────────────

let mutantDir: string;
let mutantAudit: typeof auditSpecs;
const roots: string[] = [];

beforeAll(async () => {
  mutantDir = buildMutantTree();
  mutantAudit = (await import(join(mutantDir, "scripts", "audit-specs.ts"))).auditSpecs;
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
});

function runReal() {
  const root = plantSpecs();
  roots.push(root);
  return { root, result: auditSpecs(root, { fix: true }) };
}

function runMutant() {
  const root = plantSpecs();
  roots.push(root);
  return { root, result: mutantAudit(root, { fix: true }) };
}

describe("#1286: a spec a generator owns is not written by --fix", () => {
  // ── Baseline, read before any mutation row ──────────────────

  test("BASELINE: the real guard rewrites only the hand-authored spec", () => {
    const { root, result } = runReal();
    expect(result.specs.length, "all three fixtures were discovered").toBe(3);
    expect(movedFiles(root)).toEqual(["AUTHORED.md"]);
  });

  test("a frontmatter generator declaration holds the write, naming the generator", () => {
    const { result } = runReal();
    const skip = result.skipped.find((s) => s.specFile === "DERIVED.md");
    expect(skip, "DERIVED.md was reported as skipped").toBeDefined();
    expect(skip!.reading.status).toBe("derived");
    expect(skip!.reading.generator).toBe("scripts/sync-spec.ts");
    expect(skip!.message).toContain("scripts/sync-spec.ts");
    expect(skip!.wouldHaveEdited).toBe(2);
  });

  test("a prose-only marker holds the write and is reported UNPROTECTED", () => {
    const { result } = runReal();
    const skip = result.skipped.find((s) => s.specFile === "PROSE.md");
    expect(skip, "PROSE.md was reported as skipped").toBeDefined();
    expect(skip!.reading.status).toBe("unprotected");
    // Loud, and actionable: it must say what to add, not merely that it
    // declined. A silent skip is the same defect as a silent write.
    expect(skip!.message).toContain("UNPROTECTED");
    expect(skip!.message).toContain(DERIVED_KEY);
  });

  test("NEGATIVE CONTROL: an ordinary authored spec is still rewritten", () => {
    // Without this row the guard is satisfied by refusing everything.
    const { root, result } = runReal();
    const after = readFileSync(join(root, "specs", "AUTHORED.md"), "utf-8");
    expect(after).not.toBe(AUTHORED);
    expect(after).toContain("<!-- REVIEW: unmatched");
    expect(result.skipped.map((s) => s.specFile)).not.toContain("AUTHORED.md");
  });

  test("a skipped spec contributes no rewrite entries", () => {
    // The scaffold turns a RewriteEntry into `UPDATED: specs/<file>` and
    // stages the path. Recording one for a file nobody wrote reports an edit
    // that did not happen and dirties a clean tree.
    const { result } = runReal();
    const files = new Set((result.rewrites ?? []).map((r) => r.specFile));
    expect([...files].sort()).toEqual(["AUTHORED.md"]);
  });

  // ── Mutation rows ───────────────────────────────────────────

  test("MUTANT: removing the write decision writes all three, authored included", () => {
    const { root, result } = runMutant();
    // Observed running, before any claim about what it did: a mutant that
    // failed to load and one that refused everything both report nothing.
    expect(result.specs.length, "the mutant discovered all three fixtures").toBe(3);
    // The positive control the mutation cannot reach. If this row were red,
    // "the derived file got written" would be unattributable.
    expect(movedFiles(root)).toEqual(["AUTHORED.md", "DERIVED.md", "PROSE.md"]);
    expect(result.skipped).toEqual([]);
  });

  test("MUTANT: the real run refuses exactly the two the mutant writes", () => {
    const real = runReal();
    const mutant = runMutant();
    const extra = movedFiles(mutant.root).filter((f) => !movedFiles(real.root).includes(f));
    // By name, not by count — "2 more" is satisfied by any two.
    expect(extra).toEqual(["DERIVED.md", "PROSE.md"]);
  });

  // ── Properties that make the mutation mean something ────────

  test("the write decision appears exactly once in lib/derived-spec.ts", () => {
    const src = readFileSync(GUARD_SOURCE, "utf-8");
    expect(
      src.split(DECISION).length - 1,
      `exactly one site may turn a reading into a write, or a mutation of it ` +
        `leaves a second decider holding the cases up`,
    ).toBe(1);
  });

  test("lib/derived-spec.ts has no relative imports, so the mutant can load", () => {
    const src = readFileSync(GUARD_SOURCE, "utf-8");
    expect([...src.matchAll(/from "(\.[^"]*)"/g)].map((m) => m[1])).toEqual([]);
  });

  test("the mutant audit-specs keeps only the in-tree specifiers relative", () => {
    const mutated = readFileSync(join(mutantDir, "scripts", "audit-specs.ts"), "utf-8");
    expect([...mutated.matchAll(/from "(\.[^"]*)"/g)].map((m) => m[1]).sort()).toEqual(
      [...MUTANT_RELATIVE].sort(),
    );
  });

  test("the mutant chokepoint binds to the mutant guard, not the real one", () => {
    // #1552. Without the copy, `../lib/write-spec` is rewritten absolute and
    // the mutant imports the REAL chokepoint, which imports the REAL guard —
    // and every mutation row above passes while mutating nothing. That is the
    // dead-mutant shape, so it is asserted rather than assumed.
    const copied = readFileSync(join(mutantDir, "lib", "write-spec.ts"), "utf-8");
    expect([...copied.matchAll(/from "(\.[^"]*)"/g)].map((m) => m[1])).toEqual(["./derived-spec"]);
    expect(readFileSync(join(mutantDir, "lib", "derived-spec.ts"), "utf-8")).toContain(
      ALWAYS_WRITABLE,
    );
  });

  test("the mutant guard differs from the real one", () => {
    expect(readFileSync(join(mutantDir, "lib", "derived-spec.ts"), "utf-8")).not.toBe(
      readFileSync(GUARD_SOURCE, "utf-8"),
    );
  });
});

describe("#1286: the prose detector is too narrow to eat an authored spec", () => {
  test("CORPUS CONTROL: every spec in this repository reads as authored", () => {
    // The real population, not a fixture. Two members are the traps a loose
    // `do not edit` grep falls into: `bootstrap-data-flow/consumer-requirements.md`
    // quotes `# Managed by rungate — do not edit.` inside fenced code, and
    // `SPEC-TEMPLATE.md` carries `<!-- BEGIN GENERATED PATTERNS -->`, which
    // delimits a region rather than describing the file.
    const specsDir = join(REPO, "specs");
    const files = collectSpecFiles(specsDir);
    expect(files.length, "the corpus is non-empty, so this row can fail").toBeGreaterThan(10);
    const misread = files.filter(
      (f) => readDerivedDeclaration(readFileSync(join(specsDir, f), "utf-8")).status !== "authored",
    );
    expect(
      misread,
      "these authored specs would silently stop being fixable — narrow the detector",
    ).toEqual([]);
  });

  test("a marker below the first heading describes a section, not the file", () => {
    const sectioned = spec("") .replace(
      "## Success Criteria",
      "<!-- BEGIN GENERATED PATTERNS -->\n\n## Success Criteria",
    );
    expect(readDerivedDeclaration(sectioned).status).toBe("authored");
  });

  test("a do-not-edit line inside a fenced block is an example, not a declaration", () => {
    // The real shape: `specs/bootstrap-data-flow/consumer-requirements.md`
    // quotes exactly this, twice.
    const fenced = spec("\n```yaml\n# Managed by rungate — do not edit.\n```\n");
    expect(readDerivedDeclaration(fenced).status).toBe("authored");
  });

  test("a fenced HTML-comment marker is an example, so the fence must be stripped", () => {
    // The row above is green even with no fence handling at all — the `# ` in
    // it is an ATX heading, so a head boundary found in the raw body simply
    // stops before the fence. This one is not: the marker carries no `#`, so
    // it sits inside the head and only `stripFences` can remove it.
    const quoted = spec("\n```markdown\n<!-- DERIVED FILE — do not edit here. -->\n```\n");
    expect(readDerivedDeclaration(quoted).status).toBe("authored");
  });

  test("a fenced '#' comment does not hide a real marker below it", () => {
    // The blocking AI-review finding on this PR. `# Managed by …` inside a
    // fence is an ATX heading to a line-by-line scan, so searching the RAW
    // body ends the head inside the fence and the declaration underneath is
    // never read — the file reads authored and `--fix` writes it. Fences come
    // out before the boundary is looked for.
    const hidden = spec(
      "\n```yaml\n# Managed by rungate — do not edit.\n```\n\n" +
        "<!-- DERIVED FILE — do not edit here. Regenerated by `bun scripts/sync-spec.ts`. -->\n",
    );
    expect(readDerivedDeclaration(hidden).status).toBe("unprotected");
  });

  test("the declared key outranks prose, so the generator is named", () => {
    const both = DERIVED.replace("# Fixture", "<!-- DERIVED FILE — do not edit here. -->\n\n# Fixture");
    const reading = readDerivedDeclaration(both);
    expect(reading.status).toBe("derived");
    expect(reading.generator).toBe("scripts/sync-spec.ts");
  });

  test("a declared key with no value still refuses, and says it was unnamed", () => {
    const unnamed = DERIVED.replace(`${DERIVED_KEY}: scripts/sync-spec.ts`, `${DERIVED_KEY}:`);
    const reading = readDerivedDeclaration(unnamed);
    expect(mayWrite(reading)).toBe(false);
    expect(skipLine("X.md", reading)).toContain("unnamed");
  });

  test("mayWrite permits an authored reading and refuses the other two", () => {
    expect(mayWrite({ status: "authored" })).toBe(true);
    expect(mayWrite({ status: "derived", generator: "g" })).toBe(false);
    expect(mayWrite({ status: "unprotected", evidence: "e" })).toBe(false);
  });
});

