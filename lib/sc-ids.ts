/**
 * One owner for what an SC id is, and what a mention of one means
 * (#330, #352, #358).
 *
 * Three files parsed SC ids with three different regexes:
 *
 *   lib/conformity.ts        extractSCs        `SC-\w+`       declarations
 *   scripts/sync-sc-status.ts coverageClaimIds `SC-\d+(?!\d)` mentions
 *   test/spec-sc-ids-unique.ts DECLARATION     `SC-\d+`       duplicates
 *
 * #330 called the divergence the root cause and named two of the three. The
 * consequences are the three issues this module closes:
 *
 * - The uniqueness guard cannot see `SC-A1`, so three specs declare it and
 *   nothing notices.
 * - The coverage lookup cannot see `SC-A1` either, so six anti-criteria are
 *   invisible — but widening it naively is worse, see below.
 * - Every single-digit id is a real registry entry owned by
 *   `specs/bootstrap-data-flow/success-criteria.md`, and issues number their
 *   own criteria from 1. A comment about an issue's first criterion was
 *   credited as covering a behavioural, unimplemented bootstrap criterion.
 *
 * ## The notation, stated rather than assumed
 *
 * `SC-<n>` is a **global** id. The registry owns the number; exactly one spec
 * may declare it.
 *
 * `SC-A<n>` is an **anti-criterion**, and `specs/SPEC-TEMPLATE.md` says what
 * it is for: "anti-criterion — must NOT happen". Every spec numbers its own
 * from A1, so the id is **per-spec by design**. Three specs declaring `SC-A1`
 * is correct; three specs declaring `SC-640` would not be.
 *
 * Issue success criteria are **not** SC ids. The harness numbers them
 * positionally when an issue does not number its own, so `#341 SC-1` and
 * `#194 SC-640` look identical and mean opposite things — the first is this
 * issue's first criterion, the second is a reference to the registry entry
 * the file genuinely covers. Written as `AC-n` or longhand they are
 * distinguishable; written as `SC-n` they are not, and no reader of the text
 * can recover which was meant.
 *
 * ## Why crediting is gated on the registry
 *
 * #330 measured what `SC-\w+` additionally matches across `test/`:
 * `SC-ID`, `SC-NNN`, `SC-TEST`, `SC-X`, `SC-guard`, `SC-numbered`, `SC-to`,
 * `SC-S01`, `SC-S53` — prose fragments and placeholders. Crediting those
 * manufactures coverage out of English, which is the flattering direction.
 *
 * So the pattern widens and the **credit** narrows: an id is creditable only
 * if the registry declares it. `SC-guard` is not a registry id and never
 * becomes one, so the widening cannot reach it. That is a property of the
 * data rather than of the regex, which is the point — a regex narrow enough
 * to exclude prose is also narrow enough to exclude `SC-A1`.
 */

/**
 * How a spec declared an id. Two forms, two different questions (#392).
 *
 * `checkbox` is a TRACKED criterion — `- [ ] SC-N: ...` — and the only form
 * the status flipper can tick.
 *
 * `heading` is `### SC-N: ...`, a documentation subsection. It tracks nothing,
 * but it OWNS the number just as firmly, and ignoring that is what produced
 * ten collisions: GATE-CONTRACTS-SPEC.md headed ten consecutive subsections
 * whose numbers four other specs later reissued as tracked checkboxes. Those
 * headings have since been renumbered into a block nobody else holds, so the
 * example is history rather than live — but the rule it bought is not, and
 * `crossFormCollisions` is what keeps the bank at zero.
 */
export type ScDeclarationForm = "checkbox" | "heading";

export interface ScDeclaration {
  id: string;
  specFile: string;
  checked: boolean;
  statement: string;
  form: ScDeclarationForm;
}

/**
 * The id itself: `SC-`, an optional uppercase class letter, digits.
 *
 * Not `\w+`. A class letter is part of the notation (`A` for anti-criterion);
 * an arbitrary word is a prose fragment. Kept as a source string so the
 * declaration and mention patterns are built from one definition and cannot
 * drift — the drift is what #330 is about.
 */
export const SC_ID_SOURCE = "SC-[A-Z]?\\d+";

/** A declared id: a checklist line opening with one. Not a mention. */
export function scDeclarationPattern(): RegExp {
  return new RegExp(`^- \\[([ xX])\\] (${SC_ID_SOURCE}):\\s*(.+)$`, "gm");
}

/**
 * A declared id in heading form: `### SC-N: what this section is about`.
 *
 * Same anchoring discipline as the checklist pattern — the id must OPEN the
 * heading. A heading that merely mentions one ("### Why SC-640 was wrong") is
 * prose, and crediting it would be the citation-vs-claim trap that
 * `.claude/rules/claiming-sc-coverage.md` exists about.
 */
export function scHeadingDeclarationPattern(): RegExp {
  return new RegExp(`^#{1,6}[ \\t]+(${SC_ID_SOURCE}):\\s*(.+)$`, "gm");
}

/**
 * A mention of an id, anywhere.
 *
 * The trailing boundary is "not a word character and not a hyphen": `SC-1`
 * must not match inside `SC-15` (#148) or inside `SC-1-draft`. The leading
 * `\b` keeps `MISC-1` out.
 */
export function scMentionPattern(): RegExp {
  return new RegExp(`\\b${SC_ID_SOURCE}(?![\\w-])`, "g");
}

/** One specific id, for asking "does this text name THIS criterion". */
export function oneScMentionPattern(id: string): RegExp {
  return new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

/**
 * Anti-criteria are numbered per spec, so the id alone does not identify one.
 * `specs/SPEC-TEMPLATE.md` ships `- [ ] SC-A1: [anti-criterion — must NOT
 * happen]`, which is where every spec's A1 comes from.
 */
export function isAntiCriterion(id: string): boolean {
  return /^SC-[A-Z]\d+$/.test(id);
}

/**
 * Could this id equally be an issue's own criterion?
 *
 * The harness numbers an issue's criteria from 1, so every id a short issue
 * produces is `SC-1`..`SC-9` — and all nine are declared by
 * `specs/bootstrap-data-flow/success-criteria.md`. The overlap is exactly the
 * single-digit numerics; `SC-640` cannot be an issue's 640th criterion.
 */
export function isIssueShaped(id: string): boolean {
  return /^SC-\d$/.test(id);
}

/**
 * Ids at or above this number are reserved for test fixtures and will never
 * be allocated to a real criterion (#399).
 *
 * **The namespace has two halves and only one of them was ever guarded.**
 * `nextSCNumber`, `crossSpecCollisions`, `crossFormCollisions` and
 * `requiresQualification` all reason over `specs/` — correctly, and blind to
 * the other half. A test file that writes `- [ ] SC-9441: AGENTS.md exists`
 * inside a string literal has put a checkbox declaration into the live
 * namespace where no guard can see it, so the allocator proposes 900 as free,
 * every collision detector agrees it is free, and the number collides with a
 * literal the suite depends on. That is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s second shape: a detector
 * narrower than what it detects.
 *
 * **It is not hypothetical.** `test/stale-issue-scanner.test.ts` plants
 * `SC-379` and `SC-380` as fixtures, and
 * `specs/CONFIG-DRIVEN-TESTING-SPEC.md:77-78` declares both as real tracked
 * criteria. The collision #399 was filed to prevent had already landed.
 *
 * 9000 rather than 9900, which is what the issue proposed: the convention the
 * tree already follows is 9000+, measured — 209 fixture mentions sit at
 * 9001..9902 across eight files, against 24 strays below. Picking the floor
 * the repo converged on costs no migrations that were not already needed, and
 * `test/sc-claim-forms.test.ts` argued for the convention first.
 */
export const FIXTURE_SC_FLOOR = 9000;

/**
 * Is this id reserved for fixtures?
 *
 * ONE exported predicate, consulted by the allocator and by the stray guard,
 * so there is a single binding to mutate rather than a convention each caller
 * reimplements — which is what the four spec-only guards above already are.
 */
export function isFixtureScId(id: string): boolean {
  const n = Number(id.replace(/^SC-/, ""));
  return Number.isInteger(n) && n >= FIXTURE_SC_FLOOR;
}

/**
 * The registry: which spec files declare each id.
 *
 * TWO maps, because "may this be ticked" and "does this id name one
 * criterion" are different questions and conflating them is #392 (#330 only
 * ever needed the first, so there was only ever one map).
 *
 *   byId          CHECKBOX declarations only. The flipper's view, and
 *                 `crossSpecCollisions`'s. Unchanged semantics — a heading
 *                 must never become tickable.
 *   declaredById  EVERY form. The namespace as it actually is, which is what
 *                 ambiguity and allocation have to be computed over.
 */
export interface ScRegistry {
  byId: Map<string, string[]>;
  declaredById: Map<string, string[]>;
}

/** The template's ids are placeholders — `isTemplateSpec` already skips it. */
export function isTemplateSpec(specFile: string): boolean {
  return specFile.includes("SPEC-TEMPLATE");
}

/**
 * The TRACKED criteria a spec declares. Checkbox form only.
 *
 * This is `extractSCs` — `lib/conformity.ts:339` returns it verbatim, which
 * is #330's "one owner for what a declaration is" and must stay that way.
 *
 * Headings are deliberately NOT here, and the first version of #392 put them
 * here and was wrong: the conformity engine runs an assertion against every
 * declaration it is handed, so a `### SC-N: gate-executor pass/fail criteria`
 * section title became a criterion to satisfy, and ten of them joined the
 * corpus of things that can fail a gate. A heading owns a NUMBER; it does not
 * state a checkable claim. Two questions, two parsers — see
 * `parseScHeadingDeclarations`.
 */
export function parseScDeclarations(content: string, specFile: string): ScDeclaration[] {
  const out: ScDeclaration[] = [];
  for (const m of content.matchAll(scDeclarationPattern())) {
    out.push({
      id: m[2],
      specFile,
      checked: m[1].toLowerCase() === "x",
      statement: m[3].trim(),
      form: "checkbox",
    });
  }
  return out;
}

/**
 * The ids a spec OWNS without tracking — `### SC-N: ...` subsection titles.
 *
 * Only the registry wants these, and only for the namespace question: is this
 * id ambiguous, and is this number free. Nothing may tick one and nothing may
 * assert against one.
 */
export function parseScHeadingDeclarations(content: string, specFile: string): ScDeclaration[] {
  const out: ScDeclaration[] = [];
  for (const m of content.matchAll(scHeadingDeclarationPattern())) {
    out.push({
      id: m[1],
      specFile,
      // A heading tracks nothing, so it is never "done".
      checked: false,
      statement: m[2].trim(),
      form: "heading",
    });
  }
  return out;
}

export function buildScRegistry(specs: Array<{ file: string; content: string }>): ScRegistry {
  const byId = new Map<string, string[]>();
  const declaredById = new Map<string, string[]>();
  const record = (map: Map<string, string[]>, id: string, file: string) => {
    const seen = map.get(id) ?? [];
    // By FILE, not by declaration: a spec that heads a section with the id it
    // also tracks is one declarer, and counting it twice would make every
    // such spec collide with itself.
    if (!seen.includes(file)) seen.push(file);
    map.set(id, seen);
  };
  for (const { file, content } of specs) {
    if (isTemplateSpec(file)) continue;
    for (const d of parseScDeclarations(content, file)) {
      record(byId, d.id, file);
      record(declaredById, d.id, file);
    }
    // Headings reach `declaredById` ONLY. A heading that became tickable
    // would let the status flipper tick a section title.
    for (const d of parseScHeadingDeclarations(content, file)) {
      record(declaredById, d.id, file);
    }
  }
  return { byId, declaredById };
}

/**
 * A GLOBAL id declared by more than one spec. Anti-criteria are exempt
 * because being per-spec is their definition, not their defect.
 *
 * `test/spec-sc-ids-unique.test.ts` checks each spec against itself and so
 * cannot see this: two specs each declaring `SC-2` once are each internally
 * consistent.
 */
export function crossSpecCollisions(reg: ScRegistry): string[] {
  return [...reg.byId.entries()]
    .filter(([id, specs]) => !isAntiCriterion(id) && specs.length > 1)
    .map(([id, specs]) => `${id} declared by ${specs.join(" and ")}`)
    .sort();
}

/**
 * The same collision, counted over EVERY declaration form (#392).
 *
 * Separate from `crossSpecCollisions` rather than folded into it, and the
 * separation is the decision: widening that function would turn
 * `test/spec-sc-ids-unique.test.ts`'s real-tree assertion red over ten ids,
 * and the remedy it prescribes — "renumber the later claimant" — is a
 * spec-content call about who moves, not something to take while fixing a
 * credit bug.
 *
 * So the tracked-criterion guard stays at zero and this one ships as a
 * counted ratchet, per `.claude/rules/checks-must-be-able-to-fail.md`.
 * Qualification (`ambiguityOf` reads `declaredById`) already stops the known
 * ten doing harm; this stops an eleventh arriving unnoticed.
 */
export function crossFormCollisions(reg: ScRegistry): string[] {
  return [...reg.declaredById.entries()]
    .filter(([id, specs]) => !isAntiCriterion(id) && specs.length > 1)
    .map(([id, specs]) => `${id} declared by ${specs.join(" and ")}`)
    .sort();
}

/**
 * Does a bare mention of this id say which criterion it means?
 *
 * Three ways it does not, and they are different facts:
 *   per-spec    an anti-criterion, numbered from A1 in every spec
 *   multi-spec  a global id two specs both claim — a collision, not a scope
 *   issue-shaped a number an issue's own criteria also use
 */
export type Ambiguity = "none" | "per-spec" | "multi-spec" | "issue-shaped" | "not-a-criterion";

/**
 * `declaredById`, not `byId` (#392). An id is ambiguous when two specs
 * DECLARE it, and a `### SC-N:` heading declares one — the reported case was
 * a number naming both a GATE-CONTRACTS subsection and a
 * SCAFFOLD-DECOMPOSITION criterion, read as unambiguous because only the
 * second form was being counted, so a comment that said
 * "GATE-CONTRACTS-SPEC.md" in as many words ticked the other one. That pair
 * has since been renumbered apart; the rule outlives the example.
 */
export function ambiguityOf(id: string, reg: ScRegistry): Ambiguity {
  const specs = reg.declaredById.get(id);
  if (!specs || specs.length === 0) return "not-a-criterion";
  if (isAntiCriterion(id)) return "per-spec";
  if (specs.length > 1) return "multi-spec";
  if (isIssueShaped(id)) return "issue-shaped";
  return "none";
}

export function requiresQualification(id: string, reg: ScRegistry): boolean {
  const a = ambiguityOf(id, reg);
  return a === "per-spec" || a === "multi-spec" || a === "issue-shaped";
}

/**
 * The tokens that name a spec in prose.
 *
 * `specs/bootstrap-data-flow/success-criteria.md` is cited as
 * "bootstrap-data-flow" far more often than by its filename, so the
 * containing directory counts too. Both are compared case-insensitively
 * because prose capitalises.
 */
export function qualifierTokens(specFile: string): string[] {
  const parts = specFile.replace(/^specs\//, "").split("/");
  const base = parts[parts.length - 1].replace(/\.md$/, "");
  const tokens = [base];
  if (parts.length > 1) tokens.push(parts[parts.length - 2]);
  return tokens;
}

/** How far either side of a mention a qualifier is allowed to sit. */
export const QUALIFIER_WINDOW_BEFORE = 240;
export const QUALIFIER_WINDOW_AFTER = 120;

/**
 * Is the mention at `at` qualified by a token naming `specFile`?
 *
 * A window rather than a sentence, because the mention may be in a `describe`
 * title whose spec is named in the docblock above it — which is the project's
 * most common way of saying which spec a file is about.
 */
export function isQualifiedBy(source: string, at: number, specFile: string): boolean {
  const window = source
    .slice(Math.max(0, at - QUALIFIER_WINDOW_BEFORE), at + QUALIFIER_WINDOW_AFTER)
    .toLowerCase();
  return qualifierTokens(specFile).some(t => window.includes(t.toLowerCase()));
}

// ── The other half of the namespace: ids spelled in source ──

/** Directories whose sources can spell an SC id. */
export const SC_SOURCE_DIRS: readonly string[] = ["test", "lib", "scripts", "gates"];

/** One mention of an SC id in a source file. */
export interface ScMentionInSource {
  id: string;
  file: string;
  /** True when the mention sits in a comment rather than in code. */
  inComment: boolean;
}

/**
 * Every numeric SC id spelled anywhere under `SC_SOURCE_DIRS`.
 *
 * Deliberately NOT restricted to declaring forms. The allocator's question is
 * "could handing out this number break something", and a fixture spelled in
 * any position — a string literal, an array of ids, a `-t` filter — breaks
 * the same way once a spec claims the number. `commentClaimForm` draws the
 * narrower line for CREDIT, and that line is settled and must not move
 * (`.claude/rules/claiming-sc-coverage.md`); this is a different question
 * asked for a different purpose, and widening it here cannot credit anything.
 */
export function scMentionsInSource(root: string): ScMentionInSource[] {
  const { readdirSync, readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const { commentMask } = require("./strip-js-comments") as typeof import("./strip-js-comments");
  const out: ScMentionInSource[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // a source dir this consumer does not have
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".ts") && !e.name.endsWith(".js")) continue;
      const src = readFileSync(p, "utf-8");
      if (!src.includes("SC-")) continue;
      const mask = commentMask(src);
      for (const m of src.matchAll(/SC-(\d+)(?!\d)/g)) {
        out.push({ id: m[0], file: p.slice(root.length + 1), inComment: mask[m.index!] === true });
      }
    }
  };
  for (const d of SC_SOURCE_DIRS) walk(join(root, d));
  return out;
}

/** Ids spelled in source, with the files that spell them. */
export function scIdsSpelledInSource(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const m of scMentionsInSource(root)) {
    const files = found.get(m.id) ?? [];
    if (!files.includes(m.file)) files.push(m.file);
    found.set(m.id, files);
  }
  return found;
}

/**
 * Fixture ids living in the live namespace: spelled in source, declared by
 * no spec, and below `FIXTURE_SC_FLOOR`.
 *
 * "Declared by no spec" is what makes it a fixture rather than a coverage
 * claim. `// covers SC-640` names a real criterion and must not be moved;
 * `{ id: "SC-9441", done: true }` names nothing and is a number the
 * allocator is free to hand out tomorrow. The difference is in the registry,
 * not in the spelling, which is why this takes one.
 *
 * ## What this deliberately does NOT catch, and why
 *
 * A fixture reusing an id a spec ALREADY declares is invisible here, and
 * that case is real — two instances, both found by hand rather than by any
 * guard:
 *
 * - `test/stale-issue-scanner.test.ts` plants `SC-379`/`SC-380`, both
 *   declared in `specs/CONFIG-DRIVEN-TESTING-SPEC.md:77-78`.
 * - `test/sync-sc-status-matching.test.ts` planted `SC-91`/`SC-92`/`SC-93`,
 *   all declared in `specs/bootstrap-data-flow/success-criteria.md`, under a
 *   comment reading "with IDs this repo does not use so the file does not
 *   claim them" — true when written, false by the time it mattered, and
 *   nothing could notice.
 *
 * **Catching those by POSITION was tried and is wrong.** "In a comment it is
 * a citation, in code it is a fixture" reports 338 violations on this tree,
 * because `test("SC-1504: …")` is a test TITLE — a claim form
 * `.claude/rules/claiming-sc-coverage.md` lists as valid and settled. And a
 * planted fixture string containing `test("SC-91: …")` is textually
 * identical to a real title, so no position rule separates them. Widening
 * here would have swapped a guard that misses two cases for one that
 * misreports three hundred, which is the worse trade in the direction this
 * repo has already chosen: toward NOT reporting.
 *
 * The residue is filed rather than hidden. See #399's PR.
 */
export function strayFixtureIds(root: string, reg: ScRegistry): Map<string, string[]> {
  const stray = new Map<string, string[]>();
  for (const [id, files] of scIdsSpelledInSource(root)) {
    if (reg.declaredById.has(id)) continue;
    if (isFixtureScId(id)) continue;
    stray.set(id, files);
  }
  return stray;
}
