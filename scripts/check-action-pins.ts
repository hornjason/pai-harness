#!/usr/bin/env bun
/**
 * Is each declared action pin still the commit its tag points at? (#377, #789)
 *
 * A SCRIPT and not a test, deliberately. Staleness is a network fact, and a
 * suite that asks GitHub a question fails when GitHub is slow, when a runner
 * has no egress, and on an aeroplane — which is how a check becomes a thing
 * people switch off. A refusal keyed to a date instead would go red on a day
 * nobody changed anything, which is the same problem wearing a calendar.
 *
 * #377 left it there, and "run deliberately" turned out to mean never:
 * nothing in the repository invoked it. `.github/workflows/action-pins.yml`
 * runs it weekly and on demand (#789). That workflow is this repository's
 * and is not generated into consumers.
 *
 * So the division is: the SUITE holds the structure — one declaration, every
 * position agreeing with it, every SHA pin a full commit carrying its version
 * and the date it was read — and THIS holds the freshness, run deliberately.
 *
 * `0`, `{}` and silence are indistinguishable from success, so a tag that
 * could not be resolved is reported `UNMEASURED` and exits non-zero rather
 * than reading as current.
 *
 *     bun scripts/check-action-pins.ts
 *
 * Exit 0: every SHA pin matches its tag. Exit 1: one is stale, or one could
 * not be read.
 */
import { BUMP_PROCEDURE, PINNING, type ActionPin } from "../lib/workflow-actions";

/** The one non-zero exit, so a test can prove a refusal is what it observed. */
export const REFUSE_EXIT = 1;

export type PinReading =
  | { action: string; state: "current"; sha: string }
  | { action: string; state: "stale"; declared: string; actual: string; version: string }
  | { action: string; state: "UNMEASURED"; why: string };

/**
 * Resolve one tag to a commit.
 *
 * `gh api repos/O/R/commits/<tag>` dereferences an ANNOTATED tag for you;
 * `git/ref/tags/<tag>` does not, and returns a tag object whose sha cannot be
 * a `uses:` pin at all. #689 made exactly that error and concluded from it
 * that a correctly pinned SHA was wrong. One endpoint, the one that answers
 * the question asked.
 */
export async function resolveTag(
  action: string,
  version: string,
  run: (cmd: string[]) => Promise<{ ok: boolean; out: string }>,
): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
  const r = await run(["gh", "api", `repos/${action}/commits/${version}`, "--jq", ".sha"]);
  if (!r.ok) return { ok: false, why: `could not resolve ${action}@${version}: ${r.out.trim().slice(0, 200)}` };
  const sha = r.out.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, why: `${action}@${version} resolved to ${JSON.stringify(sha)}, which is not a commit sha` };
  }
  return { ok: true, sha };
}

export async function readPins(
  pins: readonly ActionPin[],
  run: (cmd: string[]) => Promise<{ ok: boolean; out: string }>,
): Promise<PinReading[]> {
  const out: PinReading[] = [];
  for (const p of pins) {
    if (p.style !== "sha") continue;
    const r = await resolveTag(p.action, p.version, run);
    if (!r.ok) { out.push({ action: p.action, state: "UNMEASURED", why: r.why }); continue; }
    if (r.sha === p.sha) { out.push({ action: p.action, state: "current", sha: r.sha }); continue; }
    out.push({
      action: p.action, state: "stale",
      declared: p.sha!, actual: r.sha, version: p.version,
    });
  }
  return out;
}

async function shell(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: code === 0 ? out : err || out };
}

if (import.meta.main) {
  const readings = await readPins(PINNING, shell);
  const sha = PINNING.filter(p => p.style === "sha");

  if (sha.length === 0) {
    console.error("UNMEASURED: no action is declared SHA-pinned, so there is nothing to age.");
    process.exit(REFUSE_EXIT);
  }

  let bad = 0;
  for (const r of readings) {
    if (r.state === "current") { console.log(`current: ${r.action}@${r.sha}`); continue; }
    bad++;
    if (r.state === "stale") {
      // The procedure is NOT spelled here. One declaring position, so a
      // reader of this refusal and a reader of the module are told the same
      // thing (#789).
      console.error(
        `STALE: ${r.action} is pinned to ${r.declared}, but ${r.version} now points at ` +
          `${r.actual}. ${BUMP_PROCEDURE}`,
      );
    } else {
      console.error(`UNMEASURED: ${r.why}. This is not "the pin is current"; nobody looked.`);
    }
  }

  if (bad > 0) process.exit(REFUSE_EXIT);
  console.log(`${readings.length} pin(s) current.`);
}
