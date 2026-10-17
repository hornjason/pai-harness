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
 * ## The decision about paths outside the project root (#439, revised by #497)
 *
 * #439 allowed them, on two premises:
 *
 * > A brief NAMES files; it does not read them. The config is written by the
 * > operator whose session the agent runs in, so a path they declared is not
 * > an escalation of anything.
 *
 * The first is true of the brief and beside the point: the brief exists to be
 * obeyed by an agent holding a Read tool, so "named" and "read" are one step
 * apart and the step is the document's purpose. The second is true when the
 * operator scaffolded the project. Rungate is a harness pointed at a
 * `projectRoot`, and the config lives INSIDE that tree — so for any repo the
 * operator cloned rather than authored, `contextDocs: ["/Users/<them>/.ssh/id_rsa"]`
 * is a line in a checked-in file that puts an arbitrary host path into an
 * agent instruction.
 *
 * That is a true sentence derived from the cases that were measured —
 * operator-authored config — and then applied to a population it does not
 * cover. `.claude/rules/checks-must-be-able-to-fail.md` has the shape under
 * *"This cannot be checked" is a claim, and it is checkable*.
 *
 * So an external path is now REJECTED rather than included, unless its root
 * is trusted — and the trust comes from `RUNGATE_TRUSTED_DOC_ROOTS` in the
 * environment, never from the repository under test. **An allowlist inside
 * the config it is allowing is not one**, which is the whole reason this is a
 * revision rather than a revert.
 *
 * #439's real property is untouched and is still the thing this file is
 * about: nothing declared disappears without a line saying what happened to
 * it. A rejected external path is named in the notes with its reason, exactly
 * as a missing or malformed one is. The old filter dropped it in silence; the
 * difference between that and this is the only difference that matters.
 *
 * ## Symlinks
 *
 * The comparison is on the REAL path. `relative(resolve(root), resolved)` is
 * symlink-blind: a link inside the repo pointing at `/Users/<them>/.ssh`
 * resolves to a path under the root and reads as internal, which makes the
 * control satisfiable by the cheapest possible bypass.
 */

import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

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

/**
 * The environment variable that names roots outside a project whose docs may
 * still be reached.
 *
 * Deliberately NOT a config key. The threat is a `contextDocs` line in a
 * repository the operator cloned rather than wrote; an allowlist read from
 * that same repository would be authored by whoever authored the entry it is
 * supposed to authorise. It is also deliberately not a rungate config read,
 * so `.claude/rules/config-access.md` does not apply — this is not project
 * config, and routing it through the loader would put it back inside the tree
 * it exists to be outside of.
 */
export const TRUSTED_ROOTS_ENV = "RUNGATE_TRUSTED_DOC_ROOTS";

/**
 * The trusted roots, absolute and real. `PATH`-style separator, because an
 * operator setting this is already thinking in terms of a path list.
 */
export function trustedDocRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[TRUSTED_ROOTS_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(":")
    .map(p => p.trim())
    .filter(p => p !== "" && isAbsolute(p))
    .map(p => realPathish(p));
}

/**
 * `realpathSync` where it can answer, and the real path of the nearest
 * existing ancestor with the remainder appended where it cannot.
 *
 * A declared doc need not exist — `missing` is a first-class verdict here —
 * and a plain `resolve()` fallback would make a path through a symlinked
 * directory to a file that is not there yet read as internal. The ancestor
 * walk is what keeps the missing case and the symlink case from being
 * mutually exclusive.
 */
export function realPathish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      // `/` is its own parent: nothing below it existed, so there is nothing
      // to resolve and the lexical answer is the honest one.
      if (parent === head) return resolve(p);
      tail.unshift(head.slice(parent.length === 1 ? 1 : parent.length + 1));
      head = parent;
    }
  }
}

export type ContextDocVerdict =
  | {
      kind: "included";
      /** Exactly as written in the config, for error messages that can be traced back. */
      declared: string;
      /** Absolute, after resolving against the project root. */
      resolved: string;
      /** Outside the project root. Only reachable here when a trusted root allows it. */
      external: boolean;
      /** The trusted root that allowed an external path, or null. */
      trustedBy: string | null;
      /** Declared but not on disk when the brief was assembled. */
      missing: boolean;
    }
  | { kind: "rejected"; declared: string; reason: string };

/**
 * Classify ONE declared entry. The single binding, so there is one thing to
 * mutate and each arm is separately observable in the assembled brief.
 */
export function classifyContextDoc(
  projectRoot: string,
  declared: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ContextDocVerdict {
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

  // The REAL path, on both sides. A link inside the repo pointing outside it
  // resolves under the root lexically, and comparing the lexical answers is a
  // control anyone can walk past with `ln -s`.
  const resolved = realPathish(isAbsolute(trimmed) ? trimmed : join(projectRoot, trimmed));
  // `relative` rather than `startsWith`: `/repo-backup` starts with `/repo`
  // and is a different directory. One comparison, computed the way the
  // filesystem means it.
  const rel = relative(realPathish(projectRoot), resolved);
  const external = rel === "" || rel.startsWith("..") || isAbsolute(rel);

  const trustedBy = external ? (trustedDocRoots(env).find(root => isWithin(root, resolved)) ?? null) : null;
  if (external && trustedBy === null) {
    return {
      kind: "rejected",
      declared: trimmed,
      reason: `resolves to ${resolved}, outside this project; add its root to ${TRUSTED_ROOTS_ENV} in the environment to allow it`,
    };
  }

  return {
    kind: "included",
    declared: trimmed,
    resolved,
    external,
    trustedBy,
    missing: !existsSync(resolved),
  };
}

/** Is `path` the root itself or under it? Same `relative` comparison, one place. */
function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Both authored shapes: an array of paths, or an object whose values are paths.
 *
 * A present-but-unusable `contextDocs` — a string, a number, `null` — is ONE
 * rejection rather than silence, because a config that declares the key and
 * gets nothing is exactly the case this issue is about.
 */
export function classifyContextDocs(
  projectRoot: string,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ContextDocVerdict[] {
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
  return entries.map(e => classifyContextDoc(projectRoot, e, env));
}

/** The numbered brief lines, one per included doc, labelled where it matters. */
export function contextDocLines(verdicts: ContextDocVerdict[], startIndex: number): string[] {
  const lines: string[] = [];
  let idx = startIndex;
  for (const v of verdicts) {
    if (v.kind !== "included") continue;
    const notes = [
      v.external ? `external to this project, allowed by ${TRUSTED_ROOTS_ENV}` : null,
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
    if (v.kind === "included") {
      notes.push(`>   - EXTERNAL ${v.declared}: resolves to ${v.resolved}, outside this project, trusted via ${v.trustedBy}`);
    }
  }
  return notes;
}
