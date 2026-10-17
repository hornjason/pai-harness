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
