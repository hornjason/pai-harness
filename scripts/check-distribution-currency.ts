#!/usr/bin/env bun
/**
 * Report whether a consumer installing from npm gets this tree, and refuse
 * when they do not (#875).
 *
 * ```
 * bun scripts/check-distribution-currency.ts [--project-root <dir>]
 * ```
 *
 * Reads only: `npm pack --dry-run --json` against the tree, a GET for the
 * registry's `latest`, a GET for that version's tarball, and `git rev-list`.
 * Nothing here publishes, tags, bumps a version, or writes to the registry —
 * cutting a release is a decision this script reports the need for and never
 * makes.
 *
 * The verdict is `lib/distribution-currency.ts`'s `currencyRefusal`, and the
 * exit code is its `DISTRIBUTION_STALE_EXIT`. Both live there and not here so
 * that `test/distribution-currency.test.ts` has one binding to mutate; this
 * file contains no second opinion about what is acceptable.
 */
import { spawnSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DISTRIBUTION_STALE_EXIT,
  currencyRefusal,
  currencyReportLines,
  distributionCurrency,
} from "../lib/distribution-currency";
import { measureArtifactStanding, type RunCommand } from "../lib/published-artifact";
import { publishedVersion } from "../lib/distribution-standing";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--project-root");
const root =
  rootFlag === -1
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(argv[rootFlag + 1] ?? ".");

const run: RunCommand = (cmd, cwd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const standing = await measureArtifactStanding({
  pkg: "rungate",
  root,
  run,
  latestVersion: publishedVersion,
});
const currency = distributionCurrency(standing);

for (const line of currencyReportLines(currency)) console.log(line);

const refusal = currencyRefusal(currency);
if (refusal !== null) {
  console.error(`\n${refusal}`);
  process.exit(DISTRIBUTION_STALE_EXIT);
}
