/**
 * The release pipeline's two gates, as one refusing script (#364).
 *
 * Usage:
 *   bun scripts/release-guard.ts --phase preflight [--tag v0.2.3]
 *   bun scripts/release-guard.ts --phase postflight
 *
 * Prints one line on stdout saying what it read; refusals go to stderr and
 * exit non-zero. The decision itself lives in `lib/release-preflight.ts` so
 * there is one binding to mutate and so it can be exercised without a network
 * — this file is the trigger, nothing more.
 *
 * ONE PROPERTY THIS FILE MUST KEEP, asserted by test/release-guard.test.ts
 * (see .claude/rules/checks-must-be-able-to-fail.md): every non-zero exit
 * travels through REFUSE_EXIT or UNMEASURED_EXIT, each declared exactly once.
 * The test builds a mutant copy with both set to 0 and runs every negative
 * case twice — the real script stops, the mutant does not. An exit written as
 * a literal would slip past the mutation, and the case guarding it would stop
 * being distinguishable from one passing by accident.
 *
 * WHY THERE ARE TWO (#445, SC-6). A refusal is something the guard
 * ESTABLISHED: the version is already published, the tag disagrees with
 * package.json, the registry could not be read at all. UNMEASURED is the
 * postflight running out of budget with the version still absent, where "the
 * publish did not take effect" and "the packument has not propagated" are the
 * same observation. Both stop the job, and that is the recorded decision:
 * GitHub Actions offers a `run:` step no neutral outcome — the only way not
 * to fail is `continue-on-error`, which test/release-guard.test.ts forbids
 * and which would turn this file back into a job that reports a release it
 * never made. So the job still goes red; what changes is that the exit code
 * and the message distinguish "we know this went wrong" from "we could not
 * tell", instead of the second being reported as the first.
 *
 * Unlike `scripts/rook-review-scope.ts` this file DOES import from `lib/`,
 * and the mutant builder rewrites that specifier to an absolute path before
 * running the copy from a temp directory. A specifier it cannot see aborts
 * the build rather than letting the mutant die on module resolution — which
 * exits non-zero, and would read as the mutation having been rejected on the
 * merits.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  awaitRegistryServes,
  NPM_REGISTRY,
  parsePublishReceipt,
  postflightDecision,
  preflightRefusal,
  registryState,
  type PublishReceipt,
} from "../lib/release-preflight";

/** The one exit code every established refusal travels through. */
export const REFUSE_EXIT = 1;

/** The one exit code every could-not-tell travels through. See the note above. */
export const UNMEASURED_EXIT = 2;

const PKG = "rungate";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function refuse(message: string): never {
  console.error(`RELEASE REFUSED: ${message}`);
  process.exit(REFUSE_EXIT);
}

/** Not a refusal. The guard looked and could not tell; it says so and stops. */
function unmeasured(message: string): never {
  console.error(`RELEASE UNCONFIRMED: ${message}`);
  process.exit(UNMEASURED_EXIT);
}

async function main(): Promise<void> {
  const root = arg("root") ?? join(import.meta.dir, "..");
  const phase = arg("phase");
  if (phase !== "preflight" && phase !== "postflight") {
    refuse("--phase must be preflight or postflight");
  }

  let treeVersion: string;
  try {
    treeVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
  } catch (e) {
    refuse(`could not read package.json: ${(e as Error).message}`);
  }
  if (typeof treeVersion! !== "string") refuse("package.json has no version");

  // An unreachable registry throws out of registryState rather than
  // returning an empty reading, and the throw lands here as a refusal. A
  // release gate that cannot see the registry has not measured anything, and
  // "could not measure" must not read as "nothing wrong".
  // `--registry` exists so the test suite can drive every branch below
  // against a local stub rather than npm. It is a CLI flag and not an
  // environment variable on purpose: a knob that redirects where a release
  // gate looks belongs somewhere a reader of the workflow file can see it.
  // test/release-guard.test.ts asserts the workflow passes no `--registry`.
  const base = arg("registry") ?? NPM_REGISTRY;

  if (phase === "preflight") {
    let state;
    try {
      state = await registryState(PKG, fetch, base);
    } catch (e) {
      refuse(`could not read the registry: ${(e as Error).message}`);
    }
    const tag = (arg("tag") ?? "").replace(/^refs\/tags\//, "") || null;
    const no = preflightRefusal(treeVersion!, tag, state!);
    if (no) refuse(no);
    console.log(
      `preflight OK: ${PKG}@${treeVersion!} is not on the registry ` +
        `(${state!.versions.length} published, latest ${state!.latest ?? "none"})`,
    );
    return;
  }

  // Postflight POLLS rather than reading once (#407). v0.3.0 published
  // cleanly and this step still refused, because it read the registry about a
  // second after the publish and the packument was still serving 0.2.1.
  // `--budget-ms` and `--delay-ms` exist so the test suite can drive the
  // exhaustion branch without two minutes of real sleep; the workflow passes
  // neither, which test/release-guard.test.ts asserts.
  const num = (name: string): number | undefined => {
    const raw = arg(name);
    return raw === null ? undefined : Number(raw);
  };
  let reading;
  try {
    reading = await awaitRegistryServes(PKG, treeVersion!, {
      base,
      budgetMs: num("budget-ms"),
      delayMs: num("delay-ms"),
    });
  } catch (e) {
    refuse(`could not read the registry: ${(e as Error).message}`);
  }
  // npm's own receipt for this publish, when the workflow captured it (#472).
  // An ABSENT flag is `null` and means "no receipt was available", which falls
  // back to #445's behaviour. An absent FILE is a refusal: the workflow asked
  // for a reading that could not be taken, and that is not the same as not
  // asking. Distinguishing the two is the whole of `.claude/rules/config-
  // access.md`'s Silent Default Substitution.
  const logPath = arg("publish-log");
  let receipt: PublishReceipt | null = null;
  if (logPath !== null) {
    try {
      receipt = parsePublishReceipt(PKG, readFileSync(logPath, "utf-8"));
    } catch (e) {
      refuse(`--publish-log ${logPath} could not be read: ${(e as Error).message}`);
    }
  }

  const decision = postflightDecision(PKG, treeVersion!, reading!, receipt);
  if (decision.outcome === "refused") refuse(decision.message);
  if (decision.outcome === "unmeasured") unmeasured(decision.message);
  console.log(`postflight OK: ${decision.message}`);
}

await main();
