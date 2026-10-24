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
  for (const m of src.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\n]+)/g)) {
    if (/import\.meta\.dir|process\.cwd\(\)/.test(m[2]!)) idents.add(m[1]!);
  }
  return idents;
}

/**
 * The declaration forms a scratch root can arrive in.
 *
 * The keyword is not matched AT ALL, and that is #437's requirement rather
 * than tidiness. Moving creation out of module scope means writing
 * `let SCRATCH = ""` at the top and `SCRATCH = mkdtempSync(...)` inside
 * `beforeAll`, and a `const`-only pattern stops seeing both forms at once —
 * so the fix for the leak would have opened a hole in the guard against
 * fixed paths. Measured: it is 3 red if the keyword is required.
 *
 * It used to be matched OPTIONALLY — `(?:const|let|var\s+)?\s*` in front of
 * the identifier — which satisfies #437 and is what #793 is about. An
 * optional group with nothing required before it starts a backtracking
 * attempt at essentially every offset: 1716ms over this repository's `test/`,
 * and still 1712ms with the whole `join(...)` tail deleted, so the cost was
 * never in the tail. The group was optional AND non-capturing, so it fed no
 * capture and deleting it changes no output that is not a misparse: 32ms,
 * with a byte-identical 400-element ident list over the real tree.
 *
 * The one input on which the two readings differ is an identifier literally
 * beginning with a keyword — `letROOT = join(import.meta.dir, "..")`. The old
 * pattern consumed `let` and captured `ROOT`, a variable nothing declared,
 * and a root identifier nothing declared puts an unrelated `join(ROOT, ...)`
 * prefix into a recursive-delete allowlist. Reading the identifier whole
 * narrows that allowlist. See the #793 cases in `test/scratch-cleanup.test.ts`,
 * which hold the equivalence element by element against a frozen copy of the
 * old parse.
 */
/**
 * The root spellings that ARE the shared checkout, with no name in between
 * (#1473).
 *
 * `repoRootIdents` finds names BOUND to one of these. It cannot find a use
 * that never bound a name:
 *
 *     const tmpDir = join(import.meta.dir, ".tmp-scan-test");   // invisible
 *     const ROOT = join(import.meta.dir, "..");                 // seen
 *     const tmpDir = join(ROOT, ".tmp-scan-test");              // via ROOT
 *
 * The two are the same directory and the same collision. The first escaped
 * for as long as the parse required `join`'s first argument to be an
 * identifier — `test/scan-stale-issues.test.ts` sat in the tree writing a
 * fixed `.tmp-scan-test` under `test/`, and `fixedScratchRoots` returned
 * `[]` for it. Measured over 531 files, the inline form appears three times
 * and that was the only mutating one.
 *
 * Kept as a named constant rather than inlined into `DECL` because
 * `isInlineRoot` has to recognise exactly the same set: an alternation that
 * matched a spelling the predicate then failed to classify would drop the
 * declaration on the floor, which is the quiet direction.
 */
const INLINE_ROOTS = ["import\\.meta\\.dir", "process\\.cwd\\(\\)"] as const;

/**
 * Is this capture an inline root spelling rather than an identifier?
 *
 * A root spelled inline needs no `repoRootIdents` lookup — it does not name
 * the checkout, it IS the checkout. Deriving the test from `INLINE_ROOTS`
 * means the matcher and the classifier cannot disagree about the set.
 */
function isInlineRoot(captured: string): boolean {
  return INLINE_ROOTS.some(r => new RegExp(`^${r}$`).test(captured));
}

const DECL = new RegExp(
  String.raw`([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(mkdtempSync\s*\(\s*)?join\(\s*` +
    // The inline spellings first. `import` would otherwise be consumed by the
    // identifier branch, which then fails on the `.` and backtracks — correct
    // but only by accident, and it costs an attempt at every `import` in the
    // file.
    `(${INLINE_ROOTS.join("|")}|[A-Za-z_][A-Za-z0-9_]*)` +
    String.raw`\s*,\s*"(\.[^"]*)"`,
  "g",
);

/**
 * The same pattern, un-anchored and non-global, used only to decide whether
 * the expensive path is worth entering.
 *
 * DERIVED FROM `DECL`, never written out a second time. A hand-copied probe
 * that drifts from the real pattern is how a guard goes quiet: it would skip
 * the file the real regex was about to match on, report `[]`, and read as a
 * clean scan. Building it from `DECL.source` means the two cannot disagree.
 *
 * Non-global on purpose — `.test()` on a `/g` regex advances `lastIndex` and
 * returns a different answer on the next call with the same input.
 *
 * Sound because `stripJsComments` only ever REMOVES text: if the raw source
 * cannot match, the stripped source cannot match either. The converse is not
 * true — a match inside a comment enters the slow path and is then discarded
 * there, which costs time and never costs correctness.
 */
const DECL_PROBE = new RegExp(DECL.source);

/** Navigation, not a scratch name. */
function isNavigation(literal: string): boolean {
  return literal === "." || literal === ".." || literal.startsWith("../");
}

/** Scratch roots declared at a fixed path under the shared checkout. */
export function fixedScratchRoots(source: string): string[] {
  // 379 test files, 5.8MB, and 75 of them can possibly match. Stripping
  // comments from the other 304 cost 3.5s of the 5s budget and found nothing
  // — enough that this test timed out on a Mini running five CI jobs while
  // passing in milliseconds on an idle laptop. Skipping them is 906ms.
  //
  // A timeout bump was the other option and is the wrong one: it makes the
  // red slower to arrive without making the scan any more able to finish.
  if (!DECL_PROBE.test(source)) return [];
  const src = stripJsComments(source);
  const roots = repoRootIdents(src);
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(DECL.source, "g"))) {
    const [, name, wrapped, rootIdent, literal] = m;
    if (wrapped) continue; // mkdtempSync — unique per run, which is the fix
    // An inline root IS the checkout and binds no name, so there is nothing
    // for `repoRootIdents` to have found (#1473).
    if (!isInlineRoot(rootIdent!) && !roots.has(rootIdent!)) continue; // already under a unique root
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
    // #1473, and this is the direction that needs justifying: widening a
    // parse that feeds a DELETION allowlist. It adds a prefix only for a
    // genuine `mkdtempSync(join(import.meta.dir, "<prefix>"))`, which is a
    // directory this tree really does plant and really should sweep. Measured
    // over test/ at the time of the change: zero such declarations, so the
    // allowlist is byte-identical. `test/scratch-cleanup.test.ts` holds that
    // against the frozen pre-#793 reference, element by element.
    if (!isInlineRoot(rootIdent!) && !roots.has(rootIdent!)) continue;
    if (isNavigation(literal!)) continue;
    if (!out.includes(literal!)) out.push(literal!);
  }
  return out;
}
