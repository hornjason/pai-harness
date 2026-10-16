/**
 * `contextDocs` — the one binding that decides what a declared doc becomes (#439).
 *
 * Reported from a consumer project's session as "a dead config key". It is
 * not dead: `gates/brief-assembler.ts` consumes it. What was wrong is worse
 * than inert, because the key looked like it worked — three defects stacked in
 * one twenty-line region:
 *
 *   1. Every entry starting with `/` or containing `..` was filtered out with
 *      no warning and no difference in the brief. The use case that prompted
 *      the report was declaring docs in another project, which is an absolute
 *      path. Refusing was indistinguishable from there being nothing to
 *      refuse — `.claude/rules/config-access.md`'s *Silent Default
 *      Substitution*.
 *   2. The config was read straight from `.claude/rungate.json`, so a project
 *      on the directory layout got nothing regardless of the filter.
 *   3. A `catch { return null }` turned a trailing comma into "no docs".
 *
 * This module owns (1) and (3)'s successor; the loader owns (2).
 *
 * ## The decision about paths outside the project root
 *
 * They are ALLOWED, and the brief says so.
 *
 * The filter's instinct was right — an unvalidated path from config into an
 * agent brief is worth thinking about — but the thing being protected is not
 * what it looked like. A brief NAMES files; it does not read them. The config
 * is written by the operator whose session the agent runs in, so a path they
 * declared is not an escalation of anything: they could have put the file in
 * the repo, or pointed the agent at it in a sentence.
 *
 * What is worth protecting is a reader's ability to SEE that a brief reaches
 * outside the repository. So an external doc is included and labelled
 * `(external to this project)`, and a missing one is included and labelled
 * rather than dropped. Nothing declared disappears without a line saying what
 * happened to it — which is the property the old filter did not have and the
 * only one this file is really about.
 */

import { existsSync } from "fs";
import { isAbsolute, relative, resolve } from "path";

/**
 * Characters a path must not carry into a brief (BUG-439-A).
 *
 * A brief is an agent instruction and a path is rendered into it inline, so
 * an entry containing a newline writes whatever follows as its own line, in a
 * document whose whole purpose is to be obeyed. The old filter did not stop
 * this: a relative path with no leading `/` and no `..` passed it and could
 * still contain `\n`. This is not a control #439 removed — it is one neither
 * version had, found by security review of the first push.
 *
 * `\u2028` and `\u2029` are in the class because they are line terminators
 * that `\n`-shaped thinking misses.
 */
const BRIEF_UNSAFE = /[\u0000-\u001f\u007f\u2028\u2029]/;

/**
 * One predicate, two callers: `contextDocs` here and the AC `contextFiles`
 * rendered by `gates/brief-assembler.ts`. `contextFiles` had no filtering of
 * any kind, which is also why the old `contextDocs` filter was never a path
 * control — it covered one of two doors.
 */
export function hasBriefUnsafeChars(value: string): boolean {
  return BRIEF_UNSAFE.test(value);
}

export type ContextDocVerdict =
  | {
      kind: "included";
      /** Exactly as written in the config, for error messages that can be traced back. */
      declared: string;
      /** Absolute, after resolving against the project root. */
      resolved: string;
      /** Outside the project root — reported, not refused. */
      external: boolean;
      /** Declared but not on disk when the brief was assembled. */
      missing: boolean;
    }
  | { kind: "rejected"; declared: string; reason: string };

/**
 * Classify ONE declared entry. The single binding, so there is one thing to
 * mutate and each arm is separately observable in the assembled brief.
 */
export function classifyContextDoc(projectRoot: string, declared: unknown): ContextDocVerdict {
  if (typeof declared !== "string") {
    return { kind: "rejected", declared: JSON.stringify(declared) ?? String(declared), reason: "not a string" };
  }
  const trimmed = declared.trim();
  if (trimmed === "") {
    return { kind: "rejected", declared, reason: "empty" };
  }
  if (hasBriefUnsafeChars(trimmed)) {
    return {
      kind: "rejected",
      declared: JSON.stringify(trimmed),
      reason: "contains a newline or control character, which would write its own lines into the brief",
    };
  }

  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
  // `relative` rather than `startsWith`: `/repo-backup` starts with `/repo`
  // and is a different directory. One comparison, computed the way the
  // filesystem means it.
  const rel = relative(resolve(projectRoot), resolved);
  const external = rel === "" || rel.startsWith("..") || isAbsolute(rel);

  return { kind: "included", declared: trimmed, resolved, external, missing: !existsSync(resolved) };
}

/**
 * Both authored shapes: an array of paths, or an object whose values are paths.
 *
 * A present-but-unusable `contextDocs` — a string, a number, `null` — is ONE
 * rejection rather than silence, because a config that declares the key and
 * gets nothing is exactly the case this issue is about.
 */
export function classifyContextDocs(projectRoot: string, raw: unknown): ContextDocVerdict[] {
  if (raw === undefined || raw === null) return [];
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [{ __unusable: raw }];
  if (entries.length === 1 && typeof entries[0] === "object" && entries[0] !== null && "__unusable" in (entries[0] as object)) {
    return [{
      kind: "rejected",
      declared: JSON.stringify(raw),
      reason: `contextDocs must be an array or an object, got ${typeof raw}`,
    }];
  }
  return entries.map(e => classifyContextDoc(projectRoot, e));
}

/** The numbered brief lines, one per included doc, labelled where it matters. */
export function contextDocLines(verdicts: ContextDocVerdict[], startIndex: number): string[] {
  const lines: string[] = [];
  let idx = startIndex;
  for (const v of verdicts) {
    if (v.kind !== "included") continue;
    const notes = [
      v.external ? "external to this project" : null,
      v.missing ? "declared in contextDocs but not present at assembly time" : null,
    ].filter(Boolean);
    lines.push(`${idx}. ${v.resolved}${notes.length ? ` (${notes.join("; ")})` : ""}`);
    idx++;
  }
  return lines;
}

/**
 * The report. Empty when nothing was declared, which is the one case that may
 * be silent — and NOT empty when entries were declared and could not be used,
 * which is the case the old filter made indistinguishable from it.
 */
export function contextDocNotes(verdicts: ContextDocVerdict[]): string[] {
  // There is no `if (verdicts.length === 0) return []` here, and the absence
  // is deliberate. It was in the first draft, and it was a second decider
  // agreeing with the guard below: an empty list has no rejected, missing or
  // external entries either, so both returned `[]` on exactly the same
  // inputs. Mutating the guard below measured 1 of 54 against a predicted 4
  // because the early return was quietly holding three of the cases up. See
  // `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape.
  const rejected = verdicts.filter(v => v.kind === "rejected");
  const included = verdicts.filter(v => v.kind === "included");
  const missing = included.filter(v => v.kind === "included" && v.missing);
  const external = included.filter(v => v.kind === "included" && v.external);
  if (rejected.length === 0 && missing.length === 0 && external.length === 0) return [];

  const notes = [`> contextDocs: ${verdicts.length} declared, ${included.length} usable.`];
  for (const v of rejected) {
    if (v.kind === "rejected") notes.push(`>   - REJECTED ${v.declared}: ${v.reason}`);
  }
  for (const v of missing) {
    if (v.kind === "included") notes.push(`>   - MISSING ${v.declared}: nothing at ${v.resolved}`);
  }
  for (const v of external) {
    if (v.kind === "included") notes.push(`>   - EXTERNAL ${v.declared}: resolves to ${v.resolved}, outside this project`);
  }
  return notes;
}
