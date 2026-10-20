#!/usr/bin/env bun
/**
 * Read how close a suite run came to its per-test budget (#804).
 *
 * Usage:
 *   bun scripts/suite-timeout-margin.ts [report.xml …] [--within <fraction>]
 *                                       [--project-root <dir>]
 *
 * With no report named it reads the one `bunfig.toml` declares under
 * `[test.reporter] junit`, which is the path every `bun test` run in this
 * project writes. Naming reports explicitly is for a sharded run, where each
 * shard writes its own and the union is the suite.
 *
 * The decision lives in `lib/suite-timeout-margin.ts`; this file resolves
 * paths and prints. `.claude/rules/checks-must-be-able-to-fail.md` asks a
 * script whose job is to exit non-zero to route every refusal through ONE
 * exported constant, so there is a single thing for a test to set to zero —
 * see `REFUSE_EXIT` below and `test/suite-timeout-margin.test.ts`, which
 * builds a mutant with it zeroed and asserts the real script refuses where
 * the mutant does not.
 */
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import {
  describeSuiteMargin,
  suiteMarginReading,
  suiteMarginRefusal,
  DEFAULT_WITHIN,
} from "../lib/suite-timeout-margin";

/** The one non-zero exit. Inlining a second `process.exit(1)` below would let
 * a refusal bypass the mutation and the case would witness nothing. */
export const REFUSE_EXIT = 1;

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 || at === argv.length - 1 ? null : argv[at + 1];
}

const argv = process.argv.slice(2);
const root = flag(argv, "--project-root") ?? process.cwd();
const withinRaw = flag(argv, "--within");
const within = withinRaw === null ? DEFAULT_WITHIN : Number(withinRaw);

const named = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return prev !== "--project-root" && prev !== "--within";
});

const bunfigPath = join(root, "bunfig.toml");
const bunfigSource = existsSync(bunfigPath) ? readFileSync(bunfigPath, "utf-8") : null;

/**
 * The report `bunfig.toml` declares, when the caller named none.
 *
 * Read from the same file the budget comes from rather than restated here: a
 * literal `"junit.xml"` in this script would be a second declaring position
 * for the path, and the two would agree right up until somebody moved it.
 */
function declaredReport(toml: string | null): string | null {
  if (toml === null) return null;
  const m = /^\s*junit\s*=\s*"([^"]+)"/m.exec(toml);
  return m ? m[1] : null;
}

const declared = declaredReport(bunfigSource);
const reports = (named.length > 0 ? named : declared === null ? [] : [declared]).map(p =>
  isAbsolute(p) ? p : join(root, p),
);

if (named.length === 0 && declared === null) {
  // Named rather than folded into the reading's own "no report" reason: a
  // caller who forgot an argument and a project that declares no reporter
  // are different mistakes with different repairs.
  console.error(
    "suite-timeout-margin: no report named and bunfig.toml declares no " +
      '[test.reporter] junit path, so there is nothing to read. Add\n\n' +
      '  [test.reporter]\n  junit = "junit.xml"\n\n' +
      "to bunfig.toml, or name a report on the command line.",
  );
  process.exit(REFUSE_EXIT);
}

const reading = suiteMarginReading({ reports, bunfigSource, withinFraction: within });
console.log(describeSuiteMargin(reading));

const refusal = suiteMarginRefusal(reading);
if (refusal !== null) {
  console.error(`\nsuite-timeout-margin: ${refusal}`);
  process.exit(REFUSE_EXIT);
}
