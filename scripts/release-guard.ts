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
 * (see .claude/rules/checks-must-be-able-to-fail.md): every refusal exits
 * through REFUSE_EXIT, declared exactly once. The test builds a mutant copy
 * with that constant set to 0 and runs every negative case twice — the real
 * script refuses, the mutant does not. An exit written as a literal would
 * slip past the mutation, and the case guarding it would stop being
 * distinguishable from one passing by accident.
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
  preflightRefusal,
  registryState,
} from "../lib/release-preflight";

/** The one exit code every refusal travels through. See the note above. */
export const REFUSE_EXIT = 1;

const PKG = "rungate";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function refuse(message: string): never {
  console.error(`RELEASE REFUSED: ${message}`);
  process.exit(REFUSE_EXIT);
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
  // `--attempts` and `--delay-ms` exist so the test suite can drive the
  // exhaustion branch without 30 seconds of real sleep; the workflow passes
  // neither, which test/release-guard.test.ts asserts.
  const num = (name: string): number | undefined => {
    const raw = arg(name);
    return raw === null ? undefined : Number(raw);
  };
  let reading;
  try {
    reading = await awaitRegistryServes(PKG, treeVersion!, {
      base,
      attempts: num("attempts"),
      delayMs: num("delay-ms"),
    });
  } catch (e) {
    refuse(`could not read the registry: ${(e as Error).message}`);
  }
  if (reading!.refusal) refuse(reading!.refusal);
  console.log(
    `postflight OK: the registry serves ${PKG}@${treeVersion!} ` +
      `(read ${reading!.attempts} time${reading!.attempts === 1 ? "" : "s"}, ` +
      `waited ${Math.round(reading!.waitedMs / 1000)}s)`,
  );
}

await main();
