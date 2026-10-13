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

export interface ScDeclaration {
  id: string;
  specFile: string;
  checked: boolean;
  statement: string;
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

/** The registry: which spec files declare each id. */
export interface ScRegistry {
  byId: Map<string, string[]>;
}

/** The template's ids are placeholders — `isTemplateSpec` already skips it. */
export function isTemplateSpec(specFile: string): boolean {
  return specFile.includes("SPEC-TEMPLATE");
}

export function parseScDeclarations(content: string, specFile: string): ScDeclaration[] {
  const out: ScDeclaration[] = [];
  for (const m of content.matchAll(scDeclarationPattern())) {
    out.push({
      id: m[2],
      specFile,
      checked: m[1].toLowerCase() === "x",
      statement: m[3].trim(),
    });
  }
  return out;
}

export function buildScRegistry(specs: Array<{ file: string; content: string }>): ScRegistry {
  const byId = new Map<string, string[]>();
  for (const { file, content } of specs) {
    if (isTemplateSpec(file)) continue;
    for (const d of parseScDeclarations(content, file)) {
      const specs = byId.get(d.id) ?? [];
      if (!specs.includes(file)) specs.push(file);
      byId.set(d.id, specs);
    }
  }
  return { byId };
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
 * Does a bare mention of this id say which criterion it means?
 *
 * Three ways it does not, and they are different facts:
 *   per-spec    an anti-criterion, numbered from A1 in every spec
 *   multi-spec  a global id two specs both claim — a collision, not a scope
 *   issue-shaped a number an issue's own criteria also use
 */
export type Ambiguity = "none" | "per-spec" | "multi-spec" | "issue-shaped" | "not-a-criterion";

export function ambiguityOf(id: string, reg: ScRegistry): Ambiguity {
  const specs = reg.byId.get(id);
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
