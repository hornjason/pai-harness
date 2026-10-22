/**
 * A ticked criterion that names a function nobody wrote (#1161).
 *
 * `specs/INSTRUCTION-COMPLIANCE-SPEC.md` said both of these, 167 lines apart:
 *
 * ```
 * :86   **Implementation:** `lib/compliance.ts → runBehavioralCompliance(root)` (to be built)
 * :253  - [x] SC-453: runBehavioralCompliance spawns fresh agent + auditor
 * ```
 *
 * No declaration, no export, no caller, no test. The only occurrence of the
 * name in executable source was a docblock in `lib/compliance.ts` describing
 * it as future work. A tick is read as evidence — by agents and by people,
 * and specifically by a session checking whether something is already done —
 * so one tick with nothing behind it means the list cannot be used without
 * re-verifying every entry, which is the opposite of what it is for.
 *
 * ## What this binding decides
 *
 * One question, in one place: **does a ticked criterion name a camelCase
 * identifier that occurs nowhere in this tree's executable source or
 * structured data?** That is the narrowest mechanically-checkable reading of
 * the defect, and narrow is deliberate — the limits below are the honest
 * statement of what a green run here does NOT mean.
 *
 * ## The limits, stated rather than implied
 *
 * - **A criterion naming a BEHAVIOUR is not covered, and most do.** "Auditor
 *   after every agent" names no symbol, so nothing here can tell whether it
 *   is true. Measured on the tree at the time of writing: 1,450 ticked
 *   criteria, 398 of them naming any symbol at all. This check is a floor on
 *   honesty, not a measure of it, and the 1,052 it cannot see are the reason
 *   it must not be cited as "the SC list is verified".
 * - **camelCase only.** Every symbol this repository writes has an interior
 *   capital, and demanding one is what keeps the scan off English prose. A
 *   lowercase-only or snake_case name would be missed.
 * - **An identifier is "present" if it occurs anywhere in comment-stripped
 *   source or in a JSON/YAML file**, including inside a string literal. That
 *   is wider than "declared", and wider in the safe direction: a criterion is
 *   flagged only when the name appears nowhere at all. Markdown is excluded
 *   everywhere, because markdown is where claims are made, not where they are
 *   satisfied — indexing `specs/` would let every criterion clear itself.
 * - **Comments are stripped first**, and that is the whole reason the
 *   original instance is detectable. `runBehavioralCompliance` DID occur in
 *   `lib/compliance.ts`; a detector reading raw text would have cleared it.
 *   `test/ticked-sc-absent-symbol.test.ts` plants that exact case in both
 *   directions rather than trusting this paragraph.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import { isSuperseded } from "./sc-cover";
import { parseScDeclarations, isTemplateSpec } from "./sc-ids";
import { collectSpecFiles } from "./spec-files";
import { stripJsComments } from "./strip-js-comments";

/**
 * Where a symbol can be said to exist.
 *
 * `specs/`, `docs/` and `reference/` are deliberately absent: a name occurring
 * only in prose is the condition being detected, not a refutation of it.
 */
export const SYMBOL_SEARCH_DIRS = [
  ".claude",
  ".github",
  "bin",
  "config",
  "gates",
  "hooks",
  "lib",
  "prompts",
  "scripts",
  "templates",
  "test",
  "workflows",
] as const;

/** The bank of known rows, relative to the project root. */
export const ABSENT_SYMBOL_RATCHET = ".claude/ticked-sc-absent-symbol-ratchet.json";

/** The suite that drives this binding, relative to the project root. */
export const ABSENT_SYMBOL_TEST = "test/ticked-sc-absent-symbol.test.ts";

/**
 * The two files that would answer their own question, excluded from the index.
 *
 * Both are inside `SYMBOL_SEARCH_DIRS` and both name, in indexable positions,
 * the identifiers this scan is looking for:
 *
 *  - the ratchet is a `.json` under `.claude/` listing every banked symbol,
 *    so indexing it makes every row it holds "present" and the scan returns
 *    zero. An allowlist naming the exempt things becomes evidence they exist.
 *  - the test spells `runBehavioralCompliance` in a string literal, which is
 *    code and survives comment-stripping. Measured: with the test indexed,
 *    restoring the original ticked criterion to
 *    `specs/INSTRUCTION-COMPLIANCE-SPEC.md` scored ZERO red — the suite
 *    certified a tree carrying the exact defect it was written for.
 *
 * It is a constant here rather than an argument because a caller who forgets
 * it gets a clean report, which is the failure mode that is hardest to see.
 */
export const SELF_REFERENTIAL_FILES: readonly string[] = [
  ABSENT_SYMBOL_RATCHET,
  ABSENT_SYMBOL_TEST,
];

/** Executable source: comments are stripped before indexing. */
const CODE_EXTENSION = /\.(ts|tsx|js|mjs|cjs)$/;

/** Structured data: indexed verbatim — a JSON key is a thing that exists. */
const DATA_EXTENSION = /\.(json|ya?ml)$/;

/**
 * A camelCase identifier: lowercase start, at least one interior capital.
 *
 * The interior capital is the whole of the prose filter. Without it the scan
 * reports every English word in 1,450 criteria; with it, the only false
 * positives measured on this tree were metavariables inside a quoted code
 * sample, and those are banked by name in the ratchet rather than excused by
 * widening this pattern.
 */
const CAMEL_CASE = /\b[a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g;

/** The camelCase symbols a criterion names. */
export function symbolsNamedBy(statement: string): string[] {
  return [...new Set([...statement.matchAll(CAMEL_CASE)].map(m => m[0]))].sort();
}

/**
 * Every identifier occurring in executable source or structured data.
 *
 * Returned as a bare set rather than a per-file index on purpose: the question
 * is existence, and a caller handed file positions would be tempted to report
 * "declared in X", which an identifier scan cannot honestly say.
 */
export function codeIdentifiers(
  root: string,
  dirs: readonly string[] = SYMBOL_SEARCH_DIRS,
  exclude: readonly string[] = SELF_REFERENTIAL_FILES,
): Set<string> {
  const skip = new Set(exclude);
  const ids = new Set<string>();
  for (const d of dirs) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, encoding: "utf-8" })) {
      if (typeof entry !== "string") continue;
      if (skip.has(`${d}/${entry}`)) continue;
      const isCode = CODE_EXTENSION.test(entry);
      if (!isCode && !DATA_EXTENSION.test(entry)) continue;
      const raw = readFileSync(join(dir, entry), "utf-8");
      const text = isCode ? stripJsComments(raw) : raw;
      for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) ids.add(m[0]);
    }
  }
  return ids;
}

export interface AbsentSymbol {
  id: string;
  specFile: string;
  statement: string;
  /** The identifier the criterion names and the tree does not contain. */
  symbol: string;
  /** `<spec>::<id>::<symbol>` — the row the ratchet banks. */
  key: string;
}

export interface AbsentSymbolScan {
  /** Ticked criteria naming a symbol the tree does not have, one row per symbol. */
  violations: AbsentSymbol[];
  /** Ticked criteria read, so a clean result can be told from a dead scan. */
  tickedScanned: number;
  /** Ticked criteria naming any symbol at all — the population actually at risk. */
  tickedNamingSymbols: number;
  /** Identifiers indexed out of source and data. */
  identifiersIndexed: number;
}

export function absentSymbolKey(specFile: string, id: string, symbol: string): string {
  return `${specFile}::${id}::${symbol}`;
}

/**
 * Scan a tree for ticked criteria naming an absent symbol.
 *
 * The three counts come back whether or not anything was found, because an
 * empty violation list and a scan that read nothing produce identical output
 * otherwise — the third shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function scanTickedScSymbols(opts: {
  specsDir: string;
  projectRoot: string;
  dirs?: readonly string[];
  exclude?: readonly string[];
}): AbsentSymbolScan {
  const ids = codeIdentifiers(opts.projectRoot, opts.dirs, opts.exclude);
  const violations: AbsentSymbol[] = [];
  let tickedScanned = 0;
  let tickedNamingSymbols = 0;

  for (const rel of collectSpecFiles(opts.specsDir)) {
    if (isTemplateSpec(rel)) continue;
    const content = readFileSync(join(opts.specsDir, rel), "utf-8");
    for (const sc of parseScDeclarations(content, rel)) {
      if (!sc.checked) continue;
      // A SUPERSEDED line records what a criterion USED to claim, so its
      // symbol is expected to be gone. Demanding the dead name still resolve
      // would push specs to delete their own history —
      // `test/ticked-sc-cover.test.ts` makes the same exemption for the same
      // reason.
      if (isSuperseded(sc.statement)) continue;
      tickedScanned++;
      const named = symbolsNamedBy(sc.statement);
      if (named.length > 0) tickedNamingSymbols++;
      for (const symbol of named) {
        if (ids.has(symbol)) continue;
        violations.push({
          id: sc.id,
          specFile: rel,
          statement: sc.statement,
          symbol,
          key: absentSymbolKey(rel, sc.id, symbol),
        });
      }
    }
  }

  violations.sort((a, b) => a.key.localeCompare(b.key));
  return {
    violations,
    tickedScanned,
    tickedNamingSymbols,
    identifiersIndexed: ids.size,
  };
}
