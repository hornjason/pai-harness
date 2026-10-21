/**
 * Evidence that a hook fired, and what it decided (#910).
 *
 * ## Why this exists
 *
 * #910's registration claim was wrong and was corrected by parsing the
 * settings. Its execution claim could not be corrected, because there was
 * nothing to correct it against: neither `TestSuiteRelease.hook.ts` nor
 * `ProjectStateSync.hook.ts` wrote anything anywhere, so no search could ask
 * whether either had ever run.
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s #646 shape with the
 * store removed entirely. The rule there is *"before believing an empty search
 * over a store you did not write, name a string that must be PRESENT if the
 * store has anything in it at all"*. For these two hooks there was no such
 * string, and so no reading of their execution was available to anyone —
 * including whoever picks up the issue next.
 *
 * ## The distinction a record has to preserve
 *
 * A hook that fired and deliberately declined, and a hook that never fired,
 * are the same observation when nothing is written. They have different fixes,
 * so they must look different:
 *
 * | outcome | means |
 * |---|---|
 * | no record at all | the call was out of the hook's population, or the hook did not run |
 * | `declined-*` | it ran, reached the decision, and chose not to act |
 * | the acting outcome | it ran and did the thing |
 *
 * **Only in-population calls are recorded.** Both hooks are attached to tool
 * events that fire on every Bash call and every Write and Edit in every
 * session, so recording every invocation would produce a file nobody can read
 * — and the question is about full-suite commands and `project-state.json`
 * writes, not about every tool call. The hook headers say which population
 * each one records.
 *
 * ## Never throw
 *
 * A `PostToolUse` hook that throws fails the tool call it is attached to. So
 * `appendEvidence` returns `false` rather than raising — and returns it rather
 * than swallowing it, because a write that did not happen is not a write that
 * happened, and a caller that wants to know can ask.
 */

import { createHash } from "crypto";
import { appendFileSync, chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const HOOK_EVIDENCE_FILE = "hook-firings.jsonl";

/**
 * The evidence file holds no raw command and no raw error text.
 *
 * A Bash tool call routinely carries leading environment assignments —
 * `SOME_TOKEN=... bun test` — and an exception message routinely quotes the
 * path or argv that produced it. Writing either verbatim turns an append-only
 * log into a credential store that nothing rotates, in a file whose whole
 * purpose is to be read later by somebody who was not there.
 *
 * So a record carries a non-reversible DISCRIMINATOR plus a classification
 * drawn from a fixed vocabulary. That keeps every question the evidence
 * exists to answer — did it fire, what did it decide, was it the same command
 * as last time — and answers none of the questions a secret would.
 *
 * Raised by the security review of PR #970, findings 1 and 2.
 */
export function digest(value: string): string {
  // 16 hex characters: enough to correlate two runs of the same command,
  // far too little to invert, and short enough that nobody is tempted to
  // paste it anywhere as though it were the original.
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * The runner words a command contains, drawn from a FIXED vocabulary.
 *
 * Allowlisted rather than extracted, which is the property that matters: the
 * output is a subset of this list, so no input can push an unexpected
 * substring of the command into the record. A classification cannot leak;
 * a pass-through can.
 */
const SUITE_VOCABULARY = [
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "test",
  "vitest",
  "jest",
  "--parallel",
  "--no-isolate",
  "--coverage",
] as const;

export function suiteTokens(command: string): string[] {
  const seen = new Set(command.split(/\s+/).map(t => t.replace(/^['"]+|['"]+$/g, "")));
  return SUITE_VOCABULARY.filter(word => seen.has(word));
}

/**
 * A command reduced to what the evidence actually needs.
 *
 * One binding, so every hook records the same shape and there is one place to
 * mutate when asking whether redaction is load-bearing.
 */
export function commandDigestFacts(command: string): {
  commandDigest: string;
  suiteTokens: string[];
} {
  return { commandDigest: digest(command), suiteTokens: suiteTokens(command) };
}

/** An error reduced to a class name and a digest — never its message. */
export function errorFacts(e: unknown): { errorClass: string; errorDigest: string } {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const name = e instanceof Error ? e.name : typeof e;
  return {
    // Constructor names are identifiers. Anything else is refused rather
    // than passed through, because `e.name` is writable.
    errorClass: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "UNCLASSIFIED",
    errorDigest: digest(raw),
  };
}

export interface HookFiring {
  /** ISO-8601, so a record can be compared against a run. */
  at: string;
  hook: string;
  /** What the hook decided. `declined-*` for a deliberate no-op. */
  outcome: string;
  detail?: Record<string, unknown>;
}

/**
 * Where the evidence lives, from an environment and a home directory.
 *
 * Both are parameters rather than reads of `process.env` and `homedir()`, so
 * a case can drive this without touching the machine's real work directory.
 * `RUNGATE_WORK_DIR` is the same override every other hook in this tree
 * honours (`hooks/StaleTTLCleanup.hook.ts`, `hooks/lib/paths.ts`).
 */
export function hookEvidencePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(env.RUNGATE_WORK_DIR || join(home, ".rungate"), HOOK_EVIDENCE_FILE);
}

/**
 * One record, rendered.
 *
 * Pure, and the single place the on-disk shape is decided, so a case can
 * assert the shape without a filesystem and the writer cannot disagree with
 * the reader about it.
 */
export function firingLine(
  hook: string,
  outcome: string,
  detail: Record<string, unknown>,
  at: Date,
): string {
  const record: HookFiring = { at: at.toISOString(), hook, outcome };
  if (Object.keys(detail).length > 0) record.detail = detail;
  // JSONL: the trailing newline terminates THIS record. Without it a crash
  // mid-append leaves two records concatenated into one unparseable line, and
  // the reader below would refuse the whole file over it.
  return `${JSON.stringify(record)}\n`;
}

/**
 * Read records back.
 *
 * A line that does not parse is DROPPED rather than throwing, and this is the
 * one place in this tree where that is the right call: the file is appended to
 * concurrently by hooks in unrelated sessions, so a torn final line is an
 * expected state of a log and not a corrupt config. The distinction
 * `.claude/rules/config-access.md` protects is about a document whose absence
 * and whose corruption mean different things; here both mean "no record", and
 * a reader that threw would make the evidence unreadable exactly when it is
 * most wanted.
 */
export function parseFirings(text: string): HookFiring[] {
  const out: HookFiring[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HookFiring);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Append one rendered line, creating the directory.
 *
 * Returns `false` on any failure and NEVER throws — see the module docblock.
 */
export function appendEvidence(path: string, line: string): boolean {
  try {
    // 0o700 / 0o600. The file records which suites ran, when, and from which
    // worktree, for every session on the machine — a shape worth keeping to
    // the owning user even with the redaction above. `mode` applies only on
    // creation, so an existing file is corrected explicitly; a chmod failure
    // must not lose the record, which is why it is caught separately.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* the record is written; its mode is a hardening, not the evidence */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The one call a hook makes.
 *
 * One binding, so there is one thing to mutate and one site to grep for when
 * asking which hooks are observable at all.
 */
export function recordHookFiring(
  hook: string,
  outcome: string,
  detail: Record<string, unknown> = {},
): boolean {
  return appendEvidence(hookEvidencePath(), firingLine(hook, outcome, detail, new Date()));
}
