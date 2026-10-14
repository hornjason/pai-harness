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
 * ten collisions: GATE-CONTRACTS-SPEC.md heads SC-379..SC-388, every one of
 * which four other specs later reissued as a tracked checkbox.
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
 * declaration it is handed, so `### SC-388: gate-executor pass/fail criteria`
 * became a criterion to satisfy, and ten section titles joined the corpus of
 * things that can fail a gate. A heading owns a NUMBER; it does not state a
 * checkable claim. Two questions, two parsers — see
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
 * DECLARE it, and a `### SC-N:` heading declares one — SC-388 named a
 * GATE-CONTRACTS subsection and a SCAFFOLD-DECOMPOSITION criterion, read as
 * unambiguous because only the second form was being counted, and a comment
 * that said "GATE-CONTRACTS-SPEC.md" in as many words ticked the other one.
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
