#!/usr/bin/env bun
/**
 * Take the containment reading against a REAL old harness root (#921).
 *
 * `test/structure.test.ts` asserts the same reading against fixture trees it
 * builds, because the verdict of the suite that gates this repository must
 * not be set by what a developer happens to have installed. This is the
 * other half: the reading pointed at the machine, run by the person who can
 * actually act on what it finds.
 *
 *   bun scripts/check-containment.ts [--root <path>]
 *
 * Default root is `~/.claude`, the location the harness was moved out of.
 *
 * Exit codes, the same three-state vocabulary as
 * `scripts/check-unit-suite.sh`:
 *
 *   0  CLEAN       every watched location was read and held nothing
 *   1  STRAY       a harness-pattern file is in a location it was moved out of
 *   2  UNMEASURED  a location could not be read. Nothing was measured there,
 *                  which is not the same as finding nothing
 *
 * A stray is NOT something this script deletes. The file may belong to
 * another running process — on the machine where #921 was found it did — so
 * it names the file and stops.
 */

import { homedir } from "os";
import { join, resolve } from "path";

import {
  containmentExitCode,
  containmentRemedy,
  containmentVerdict,
  readContainment,
} from "../lib/containment";

function rootFromArgv(argv: string[]): string {
  const at = argv.indexOf("--root");
  if (at === -1) return join(homedir(), ".claude");
  const value = argv[at + 1];
  if (!value) throw new Error("--root was given with no path");
  return resolve(value);
}

const root = rootFromArgv(process.argv.slice(2));
const readings = readContainment(root);
const verdict = containmentVerdict(readings);

console.log(`containment reading of ${root}`);
for (const r of readings) {
  console.log(`  ${r.state.padEnd(10)} ${r.subject} — ${r.note}`);
}
console.log(`verdict: ${verdict}`);

if (verdict !== "CLEAN") {
  console.log(containmentRemedy(resolve(import.meta.dir, ".."), readings));
}

process.exit(containmentExitCode(verdict));
