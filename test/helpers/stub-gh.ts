/**
 * A `gh` on PATH that answers from a fixture instead of from GitHub.
 *
 * Issue #71. Six CI failures were `HTTP 401: Bad credentials` — the suite was
 * calling the live GitHub API. `test/precompute-goal.test.ts` and
 * `test/context-preload-parity.test.ts` run `scripts/precompute-goal.ts`, which
 * shells out to `gh issue view 48` at scripts/precompute-goal.ts:32. On Jason's
 * machine that silently succeeded against his credentials; on a runner it 401s.
 *
 * Three things were wrong with it, and only the first one was visible in CI:
 * the suite could not run offline, it asserted on issue #48's *live* body (so
 * anyone editing that issue could turn the suite red), and it made real API
 * calls on every single run.
 *
 * Stubbing the binary rather than adding an `--offline` flag to the script
 * keeps the seam out of production code and still exercises the real argument
 * construction and JSON parsing — the script cannot tell the difference, which
 * is the point. A fixture-injection flag would route the test around the code
 * path it is supposed to be covering.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface StubbedGh {
  /** Prepend to PATH so this `gh` wins over any real one. */
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** Single-quote for /bin/sh, closing and reopening around embedded quotes. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param fixturePath JSON file to emit for `gh issue view <issue> --json ...`.
 * @param issue issue number the fixture represents.
 */
export function stubGh(fixturePath: string, issue = "48"): StubbedGh {
  const dir = mkdtempSync(join(tmpdir(), "rungate-stub-gh-"));
  const bin = join(dir, "gh");

  // Only `issue view <issue>` is answered. Anything else exits non-zero rather
  // than returning empty output: a stub that silently succeeds for calls it
  // does not understand lets a test pass against a command it never really ran.
  // The issue number is matched too — without it the stub hands issue 48's body
  // to a request for any issue, and a cross-issue assertion would pass wrongly.
  //
  // shQuote, not JSON.stringify: JSON escaping handles `"` and `\` but leaves
  // `$` and backtick live inside the double quotes of a /bin/sh script, so a
  // checkout under a path containing either would read the wrong file or run a
  // command substitution.
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$3" = ${shQuote(issue)} ]; then
  cat ${shQuote(fixturePath)}
  exit 0
fi
echo "stub-gh: unstubbed command: $*" >&2
exit 1
`,
  );
  chmodSync(bin, 0o755);

  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
