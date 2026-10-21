/**
 * Whether `fallow` can be run without reaching the network (#581).
 *
 * `fallow` is an optional external tool and is NOT a declared dependency —
 * not in `package.json`, not in `node_modules/.bin`, not on `PATH`, on this
 * machine or on CI. So every bare `npx fallow` is a registry fetch.
 *
 * `lib/conformity.ts` learned that in its own words:
 *
 *   > When it is absent, `npx fallow` does a registry fetch on every
 *   > invocation — four tests x one fetch each, each outliving bun's
 *   > per-test timeout. … Resolve it locally instead, with no network path.
 *
 * and then kept the fix to itself. `scripts/generate-code-map.ts` — the
 * caller on the **scaffold** path, which runs once per consumer forever
 * rather than four times in a suite — still spawned `npx fallow`
 * unconditionally. So the fix landed in the cheap caller and not in the
 * expensive one, and the cost of that is not a slow test: a consumer
 * scaffolding behind a proxy, in an air-gapped CI, or on a bad connection
 * gets a 30-second stall and then a silently degraded CODE-MAP, with nothing
 * in the output saying a network call was attempted.
 *
 * It also made the suite non-deterministic. PR #580 — three state files, no
 * code — went red on `SC-1665`, which asserts that `.fallow/cache.bin` was
 * produced by both of two scaffold runs; when the fetch fails it is produced
 * by neither. Reproduced with no repo change at all:
 *
 *     npm_config_registry=http://127.0.0.1:1/ bun test test/scaffold-relative-root.test.ts
 *     error: .fallow/cache.bin is excluded but was not produced by both runs
 *
 * ## One binding
 *
 * This module exists rather than an export from `lib/conformity.ts` because
 * conformity imports `bun:test` at module scope and so cannot be imported by
 * a CLI. Same arrangement as `lib/git-dates.ts` (#508) and
 * `lib/harness-identity.ts` (#380): one implementation, re-exported, because
 * two answers to one question are behaviourally one and no test can tell
 * them apart.
 */

import { existsSync } from "fs";
import { join } from "path";

/**
 * Memoised PER ROOT.
 *
 * `runFallowCheck` is exported and consumer projects call it with their own
 * root, so a single process can ask about several. A root-independent cache
 * would answer for the wrong directory.
 */
const FALLOW_AVAILABLE = new Map<string, boolean>();

export function fallowAvailable(root: string): boolean {
  const cached = FALLOW_AVAILABLE.get(root);
  if (cached !== undefined) return cached;
  const available = existsSync(join(root, "node_modules", ".bin", "fallow")) || Bun.which("fallow") !== null;
  FALLOW_AVAILABLE.set(root, available);
  return available;
}

/** Test seam: drop the memo so a case can change the answer. */
export function resetFallowAvailability(): void {
  FALLOW_AVAILABLE.clear();
}

/**
 * Why a fallow-derived reading is missing, or null when it is not missing.
 *
 * Three outcomes, not two. `null` from the old `runFallow()` meant "not
 * installed", "the spawn failed", "the output did not parse" and "it ran and
 * found nothing" all at once, and a CODE-MAP written from it was
 * byte-identical in every case — which is
 * `.claude/rules/config-access.md`'s *Silent Default Substitution* with a
 * document as the victim.
 */
export type FallowUnavailable =
  | { kind: "not-installed"; reason: string }
  | { kind: "timed-out"; reason: string }
  | { kind: "run-failed"; reason: string };

export function fallowNotInstalled(): FallowUnavailable {
  return {
    kind: "not-installed",
    reason:
      "fallow is not installed (it is an optional tool, not a declared dependency) — " +
      "no static analysis was run, and no registry fetch was attempted",
  };
}

/**
 * A tool's output, made safe to put in a document an agent reads.
 *
 * The `run-failed` reason quotes what fallow printed, and that string ends
 * up inside CODE-MAP.md — which `.claude/rules/key-files.md` tells every
 * agent to read to understand the codebase. So it is untrusted text on its
 * way into a trusted document, and fallow's error text can quote the repo's
 * own file names and contents.
 *
 * One line, an allowlist, and a cap. Not an escape routine: a denylist of
 * markdown syntax is a detector narrower than what it detects, and the
 * useful content of a tool error survives an allowlist intact.
 */
export function safeToolDetail(raw: string): string {
  const firstLine = raw.split("\n")[0] ?? "";
  // A RUN of disallowed characters collapses to one `?`, rather than one
  // `?` each. Both are safe; the difference is whether a detail that was
  // entirely unprintable comes back as `????????` — which carries no
  // information and is indistinguishable from a tool that said something.
  const cleaned = firstLine.replace(/[^A-Za-z0-9 .,:;()/'"=+-]+/g, "?").slice(0, 120).trim();
  return /^[?\s]*$/.test(cleaned) ? "(no printable detail)" : cleaned;
}

export function fallowRunFailed(detail: string): FallowUnavailable {
  return {
    kind: "run-failed",
    reason: `fallow is installed but the run did not produce a reading: ${safeToolDetail(detail)}`,
  };
}

/**
 * The budget, and there is exactly one of it (#935).
 *
 * It is BOTH the spawn's `timeout` and the per-test timeout every FALLOW
 * registration is given, because the defect this constant exists to prevent
 * is the two disagreeing. `lib/conformity.ts` spawned with `timeout: 30_000`
 * inside a `test()` that passed no timeout at all — so bun killed the body at
 * its 5000ms default and the 30s was unreachable, a budget nothing could
 * spend. Measured on `hornjason/agentgrit` PR #310: FALLOW-1 died at 5010ms
 * on a commit that changed two markdown files, four times in one day.
 *
 * A second literal anywhere is the whole bug returning, so
 * `test/fallow-budget-reading.test.ts` holds the population of other budget
 * spellings at zero rather than trusting this comment.
 */
export const FALLOW_BUDGET_MS = 30_000;

/**
 * A run the clock killed.
 *
 * Its own kind, and NOT a flavour of `run-failed`, because the two send an
 * operator to different places: one says go and look at the tool, this one
 * says the tool was still working when we stopped it. It carries the budget
 * because that is the number the reader would change, and the elapsed time
 * because a run killed at the budget and a run killed by something else at
 * 200ms are different facts.
 */
export function fallowTimedOut(budgetMs: number, elapsedMs: number): FallowUnavailable {
  return {
    kind: "timed-out",
    reason:
      `fallow is installed and was still running when the ${budgetMs}ms budget expired ` +
      `(killed after ${elapsedMs}ms) — no static analysis reading was produced. This is ` +
      `UNMEASURED, not a clean result: raise the budget, or warm the index before the run`,
  };
}

/** Only the fields the classifier is allowed to read, so a test can plant one. */
export interface FallowSpawnResult {
  stdout: { toString(): string };
  stderr?: { toString(): string };
  exitCode: number | null;
  exitedDueToTimeout?: boolean;
}

export type FallowReading<T> = { data: T } | { unavailable: FallowUnavailable };

/**
 * The ONE place in the tree that spawns fallow (#935, #621).
 *
 * There were two — `lib/conformity.ts` and `scripts/generate-code-map.ts` —
 * each with its own `timeout: 30_000` literal and only one of them
 * classifying anything. Two positions answering one question with nothing
 * comparing them: mutate either and the other carries on spawning, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape.
 *
 * **The classification ORDER is the fix, not the `timed-out` arm.** A killed
 * process writes nothing, so a run that exceeded the budget satisfies the
 * empty-stdout branch too — and whichever is tested first decides what the
 * operator is told. Reading `exitedDueToTimeout` second is how a 30-second
 * hang got reported as `fallow is not installed (not a declared dependency)`
 * on a tree where fallow is exactly pinned. An operator acting on that goes
 * and declares a dependency that is already there.
 *
 * `available` and `spawn` are injected rather than reached for, so a case can
 * force a timeout without waiting for one and can prove the absent-tool arm
 * never spawns at all. Both default to the real thing.
 */
export function runFallowJson<T>(
  root: string,
  args: string[],
  opts?: {
    budgetMs?: number;
    available?: (root: string) => boolean;
    spawn?: (argv: string[], options: Record<string, unknown>) => FallowSpawnResult;
  },
): FallowReading<T> {
  const budgetMs = opts?.budgetMs ?? FALLOW_BUDGET_MS;
  const isAvailable = opts?.available ?? fallowAvailable;
  if (!isAvailable(root)) return { unavailable: fallowNotInstalled() };

  const spawn =
    opts?.spawn ??
    ((argv: string[], options: Record<string, unknown>) =>
      Bun.spawnSync(argv, options as Parameters<typeof Bun.spawnSync>[1]) as FallowSpawnResult);

  const startedAt = Date.now();
  const result = spawn(["npx", "fallow", ...args, "--format", "json", "--quiet"], {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: budgetMs,
  });
  const elapsedMs = Date.now() - startedAt;

  // FIRST, and the order is the whole point — see the docstring above.
  if (result.exitedDueToTimeout) return { unavailable: fallowTimedOut(budgetMs, elapsedMs) };

  const stdout = result.stdout.toString().trim();
  if (!stdout) {
    const stderr = result.stderr?.toString().trim() ?? "";
    return {
      unavailable: fallowRunFailed(stderr || `exit ${result.exitCode}, no output`),
    };
  }
  // fallow's own error envelope. It is well-formed JSON, so it would parse
  // and be returned as a reading of zero issues.
  if (stdout.startsWith('{"error"')) return { unavailable: fallowRunFailed(stdout) };
  try {
    return { data: JSON.parse(stdout) as T };
  } catch (e) {
    return {
      unavailable: fallowRunFailed(`output did not parse as JSON (${(e as Error).name})`),
    };
  }
}

/**
 * Pay the cold index build once, before anyone is being timed for it.
 *
 * fallow builds an index on first use: ~1.5s cold against ~455ms warm,
 * measured. Four checks run in sequence and the FIRST one pays it, which is
 * why FALLOW-1 looked slow and the three after it looked fast. It was never
 * FALLOW-1 — it is whichever check runs first, and moving the checks around
 * would move the symptom without touching the cause.
 *
 * Failures are deliberately swallowed: this is a warm-up, and every caller
 * takes its own reading immediately afterwards and reports its own outcome.
 * A warm-up that could fail a suite would be a second decider for whether
 * fallow works.
 *
 * It takes the same seam `runFallowJson` does, and that is not symmetry for
 * its own sake. Without it the only assertable property is WHERE the call
 * sits in the source, and a warm-up short-circuited to `return` is invisible
 * to a position check — measured, as row M7 of this change's battery, which
 * came back 0 of 14. Worse, fallow is not installed on this machine or on
 * CI, so `fallowAvailable` is false and the real function returns without
 * spawning too: there was no input anywhere in this repository on which the
 * no-op and the original behaved differently. That is not a check that is
 * blind, it is a row that could not be run
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *before you believe a 0*).
 */
export function warmFallow(
  root: string,
  opts?: Parameters<typeof runFallowJson>[2],
): void {
  // No availability check of its own, deliberately. It had one, and
  // `runFallowJson` opens with the same question — two deciders answering it
  // about the same root, which is behaviourally one and which no test can
  // tell apart. The battery said so before any of this was argued: deleting
  // the guard here was 0 of 15, because the one below it still refused
  // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). There is
  // no input only this copy could reach, so the honest fix is to collapse
  // rather than to invent a case for it.
  runFallowJson(root, ["dead-code"], opts);
}

/**
 * The line a generated document carries in place of a section it could not
 * produce.
 *
 * UNMEASURED by name. An omitted section and a section reporting nothing
 * wrong are the same absence to a reader, and the reader of a CODE-MAP is an
 * agent deciding whether this project has dead code.
 */
export function fallowUnmeasuredNotice(u: FallowUnavailable): string {
  return `## Code Health (fallow)\n\n**UNMEASURED** — ${u.reason}.`;
}
