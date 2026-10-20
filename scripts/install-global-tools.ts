#!/usr/bin/env bun
/**
 * Install the global tools this project's config pins, at runtime (#323).
 *
 * The generated `.github/workflows/ci.yml` carries these as a literal
 * `npm install -g` line, rendered from `ci.globalTools` by
 * `globalToolInstallStep`. `.github/workflows/suite-flake.yml` is NOT
 * generated — it is this repository's own instrument — so it needs the same
 * installation without becoming a second place the versions are written
 * down. `test/ci-global-tools.test.ts` refuses a second declaring position
 * and is right to; a pinned version repeated in a hand-written workflow is
 * #689's shape, two copies of one fact with nothing comparing them.
 *
 * So this reads the SAME config through the SAME validated binding and
 * executes what it resolves. No version string appears here.
 *
 * Why it matters for the series it was written for: a suite run with the
 * compliance tools absent is not the suite CI runs. `lib/compliance.ts`
 * reports UNMEASURED and withholds its quality score when a tool is missing
 * (#597), which is correct behaviour and a different code path — and a
 * flake living in the path CI takes would be unobservable in a series that
 * never takes it.
 */
import { spawnSync } from "child_process";

import { tryLoadRungateConfig } from "../lib/config-loader";
import { globalToolInstallStep } from "../lib/scaffold/steps";

export const REFUSE_EXIT = 1;

function main(): number {
  const root = process.cwd();
  const config = tryLoadRungateConfig(root);
  if (config === null) {
    // An absent config is a reading, and it is reported rather than treated
    // as "no tools to install" — those are different facts, and silence
    // reads as the second (`.claude/rules/config-access.md`).
    console.error(`UNMEASURED: no rungate config under ${root}, so no ci.globalTools declaration was read`);
    return REFUSE_EXIT;
  }

  const decision = globalToolInstallStep((config as { ci?: unknown }).ci);
  for (const r of decision.rejected) console.error(`refused, and so NOT installed: ${r}`);
  if (decision.pins.length === 0) {
    console.error(`UNMEASURED: ${decision.reason} — nothing was installed, and nothing says it should have been`);
    return REFUSE_EXIT;
  }

  const specs = decision.pins.map(p => `${p.package}@${p.version}`);
  console.log(`installing ${specs.join(", ")} (${decision.reason})`);
  // argv, not a shell string: the package names and versions are validated
  // by `globalToolInstallStep`, and an array keeps that the only thing
  // standing between config and a command line.
  const r = spawnSync("npm", ["install", "-g", ...specs], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`npm install -g exited ${r.status}`);
    return REFUSE_EXIT;
  }
  return 0;
}

if (import.meta.main) process.exit(main());
