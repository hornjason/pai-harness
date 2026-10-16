/**
 * The single owner of "what does a scratch root in this repo look like" (#437).
 *
 * Two questions are asked about the same source text, and they are asked from
 * two different places:
 *
 *   - `test/scratch-paths-unique.test.ts` asks which scratch roots are FIXED,
 *     because a fixed path under the shared checkout is a shared mutable
 *     resource (#323 SC-6).
 *   - `lib/scratch-cleanup.ts` asks which PREFIXES the unique ones use,
 *     because a sweeper needs to know what it is allowed to delete.
 *
 * They are the same parse. Two copies of it would be two deciders that agree —
 * the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md` — and
 * worse than usual here, because the second decider's output is a deletion
 * allowlist. A parser that quietly stopped seeing a prefix would not go red;
 * it would stop sweeping, which is indistinguishable from nothing having
 * leaked.
 */

import { stripJsComments } from "./strip-js-comments";

/**
 * Identifiers bound to the repository root, per file.
 *
 * `join(tmpDir, ".claude")` is a fixed name under an ALREADY-UNIQUE root —
 * the suffix is on the parent, which is just as good. Only a path rooted at
 * the shared checkout can collide, so the root is the thing to look at.
 */
export function repoRootIdents(src: string): Set<string> {
  const idents = new Set<string>();
  for (const m of src.matchAll(/(?:const|let|var)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\n]+)/g)) {
    if (/import\.meta\.dir|process\.cwd\(\)/.test(m[2]!)) idents.add(m[1]!);
  }
  return idents;
}

/**
 * The declaration forms a scratch root can arrive in.
 *
 * `const` is matched optionally, and that is #437's doing rather than
 * tidiness. Moving creation out of module scope means writing
 * `let SCRATCH = ""` at the top and `SCRATCH = mkdtempSync(...)` inside
 * `beforeAll`, and a `const`-only pattern stops seeing both forms at once —
 * so the fix for the leak would have opened a hole in the guard against
 * fixed paths. Measured: it is 3 red without the relaxation.
 */
const DECL = /(?:const|let|var\s+)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(mkdtempSync\s*\(\s*)?join\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*"(\.[^"]*)"/g;

/** Navigation, not a scratch name. */
function isNavigation(literal: string): boolean {
  return literal === "." || literal === ".." || literal.startsWith("../");
}

/** Scratch roots declared at a fixed path under the shared checkout. */
export function fixedScratchRoots(source: string): string[] {
  const src = stripJsComments(source);
  const roots = repoRootIdents(src);
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(DECL.source, "g"))) {
    const [, name, wrapped, rootIdent, literal] = m;
    if (wrapped) continue; // mkdtempSync — unique per run, which is the fix
    if (!roots.has(rootIdent!)) continue; // already under a unique root
    if (isNavigation(literal!)) continue;
    // Only a directory this suite CREATES or DELETES is scratch. One it merely
    // reads is configuration, and renaming it per run would break the read.
    const mutates = new RegExp(`(?:mkdirSync|rmSync)\\(\\s*(?:join\\(\\s*)?${name}\\b`);
    if (mutates.test(src)) out.push(`${name} = ${literal}`);
  }
  return out;
}

/**
 * The `mkdtempSync` prefixes a file plants under the repo root.
 *
 * This is the other half of the same parse, and it is what the sweeper's
 * allowlist is built from. It deliberately returns the prefix EXACTLY as
 * written — including the trailing `-` that `mkdtempSync` appends its random
 * suffix to — because a prefix widened by even one character is a wider
 * deletion allowlist.
 */
export function uniqueScratchPrefixes(source: string): string[] {
  const src = stripJsComments(source);
  const roots = repoRootIdents(src);
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(DECL.source, "g"))) {
    const [, , wrapped, rootIdent, literal] = m;
    if (!wrapped) continue; // a fixed path is the other function's subject
    if (!roots.has(rootIdent!)) continue;
    if (isNavigation(literal!)) continue;
    if (!out.includes(literal!)) out.push(literal!);
  }
  return out;
}
