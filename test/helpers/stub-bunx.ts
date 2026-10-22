/**
 * A `bunx` on PATH that answers for the findings adjudicator (#1013).
 *
 * Since #1013 the generated verdict step's success branch runs
 * `bunx rungate@<generating version> ai-review-findings <payload>` and exits on
 * what comes back. Every case that drives that branch would otherwise reach
 * **the npm registry**, and three things would be wrong with that — the same
 * three `test/helpers/stub-gh.ts` records for the live GitHub API:
 *
 * - the suite could not run offline;
 * - it would assert against whatever npm served that day, and this tree's
 *   version is routinely ahead of the registry **by design** (see
 *   `AI_REVIEW_ADJUDICATOR_PACKAGE`), so the same code is green or red
 *   depending on when a release landed;
 * - it would make a network call per case, on every run.
 *
 * Stubbing the binary rather than giving the generated script an override
 * variable keeps the seam out of the artefact GitHub runs. An override would
 * be a switch for turning every adjudication green, in the one step whose
 * whole job is to refuse one.
 *
 * Two states are offered because the step has to tell them apart, and that
 * distinction is the subject of #1013: an adjudicator that RAN and said
 * something, and one that could not run at all. Only the first prints
 * `AI_REVIEW_OUTCOME_LINE`, and only the first may decide the job's exit code.
 */

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * A PATH whose `bunx` runs `body` as `/bin/sh`.
 *
 * The directory is prepended, so this `bunx` wins over any real one, and the
 * rest of the inherited PATH is kept — the script also needs `grep` and
 * `find`, and a case that lost those would fail for a reason that is not its
 * subject.
 *
 * The caller owns nothing: the directory is under the OS temp root and is left
 * for the OS, like every other `mkdtemp` in a test that does not install an
 * `afterAll`.
 */
export function stubBunx(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-stub-bunx-"));
  writeFileSync(join(dir, "bunx"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

/**
 * The state almost every pre-#1013 case was written against: nothing
 * adjudicates, so the step warns and follows `RUNGATE_REQUIRE_AI_REVIEW`.
 *
 * `127` is what a shell reports for a command it cannot find, which is one of
 * the two real routes here — the other being a `bunx` that found no such
 * version. Neither prints an outcome line, and that, rather than the code, is
 * what the step reads.
 *
 * Computed once: the content never varies, and a fresh `mkdtemp` per call
 * leaves one directory per case behind for no gain.
 */
let absent: string | undefined;
export function stubBunxAbsent(): string {
  if (absent === undefined) absent = stubBunx("exit 127");
  return absent;
}
