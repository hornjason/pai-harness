/**
 * The refusal in `scripts/audit-closing-references.ts` is observed, not assumed (#1362).
 *
 * Every negative case runs twice — the real script, and a mutant whose
 * `REFUSE_EXIT` is zeroed — and asserts the real one refuses while the mutant
 * does not. That second assertion is the removal of the non-zero exit,
 * performed and watched, so a case that later passes for an unrelated reason
 * stops being indistinguishable from one that is genuinely caught
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The script has one relative import, so the mutant cannot simply be dropped
 * in a temp directory — it would die on module resolution and a non-zero exit
 * would read as the refusal firing. The mutant therefore rewrites that
 * specifier to an absolute path, and the rewrite is asserted to have applied:
 * an unapplied mutation and a working guard produce the same colour.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "audit-closing-references.ts");
const LIB = join(import.meta.dir, "..", "lib", "closing-reference-audit.ts");
const SRC = readFileSync(SCRIPT, "utf-8");

/**
 * Read the exit code out of the source rather than importing it.
 *
 * The script runs `await main()` at import time — the same property
 * `scripts/audit-issue-closures.ts` documents — so importing the constant
 * executes the audit, reads stdin and calls `process.exit`, which kills the
 * test runner before any case runs. That is not a hypothetical: it is what
 * this file did on its first run.
 */
const REFUSE_EXIT = (() => {
  const m = SRC.match(/^export const REFUSE_EXIT = (\d+);$/m);
  if (!m) throw new Error("REFUSE_EXIT is not declared on its own line; the mutation would be untrustworthy");
  return Number.parseInt(m[1]!, 10);
})();

const scratch = mkdtempSync(join(tmpdir(), "closing-ref-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The real script's source, with the exit constant zeroed. */
function buildMutant(): string {
  const decl = `export const REFUSE_EXIT = ${REFUSE_EXIT};`;
  if (SRC.split(decl).length - 1 !== 1) {
    throw new Error("could not build the mutant: the exit constant is not declared exactly once");
  }
  const spec = `"../lib/closing-reference-audit"`;
  if (SRC.split(spec).length - 1 !== 1) {
    throw new Error("could not build the mutant: the lib specifier is not written exactly once");
  }
  const out = SRC.replace(decl, "export const REFUSE_EXIT = 0;").replace(spec, JSON.stringify(LIB));
  if (out.includes(decl) || out.includes(spec)) {
    throw new Error("could not build the mutant: a substitution did not apply");
  }
  const path = join(scratch, "mutant.ts");
  writeFileSync(path, out);
  return path;
}

function run(script: string, payload: string): { code: number; err: string; out: string } {
  const file = join(scratch, "payload.json");
  writeFileSync(file, payload);
  try {
    const out = execFileSync(process.execPath, [script, "--fixture", file], { encoding: "utf-8" });
    return { code: 0, err: "", out };
  } catch (e: any) {
    return { code: e.status ?? -1, err: String(e.stderr ?? ""), out: String(e.stdout ?? "") };
  }
}

// PR #1208's real shape: the keyword and the number inside a code span, and
// GitHub recording no link at all.
const BACKTICKED = "Fixes #1157".replace(/^/, "`").replace(/$/, "`");
const DEFECTIVE = JSON.stringify({ number: 1208, body: `${BACKTICKED}\n`, closingIssuesReferences: [] });

// The same contradiction one issue over, and the state the script used to
// pass clean: a live link to #1362 AND a suppressed closing keyword for a
// DIFFERENT issue. #777 never closes, so it becomes an open issue carrying a
// merged pull request — the exact population this script was written to find.
// The early return on `linked.length > 0` meant the body was never read.
const LINKED_PLUS_INERT = JSON.stringify({
  number: 1376,
  body: `Fixes #1362\n\n${"Fixes #777".replace(/^/, "`").replace(/$/, "`")}\n`,
  closingIssuesReferences: [{ number: 1362 }],
});

describe("the refusal is observed, against a mutant that cannot refuse", () => {
  test("the exit constant is declared exactly once, or no mutation is trustworthy", () => {
    expect(SRC.split(`export const REFUSE_EXIT = ${REFUSE_EXIT};`).length - 1).toBe(1);
    // No other literal exit can bypass it.
    expect(SRC).not.toMatch(/process\.exit\(\s*[1-9]/);
  });

  for (const [name, payload] of [
    ["an inert closing reference", DEFECTIVE],
    ["a linked pull request carrying an inert reference to ANOTHER issue", LINKED_PLUS_INERT],
    ["a payload with no closingIssuesReferences key", JSON.stringify({ number: 1, body: "x" })],
    ["a payload that is not JSON", "not json at all"],
    ["an empty payload", ""],
  ] as const) {
    test(`${name} refuses, and the mutant does not`, () => {
      const real = run(SCRIPT, payload);
      expect(real.code, `real script should refuse on: ${name}`).toBe(REFUSE_EXIT);
      expect(real.err).toContain("CLOSING-REFERENCE REFUSED");
      const mutant = run(buildMutant(), payload);
      expect(mutant.code, `mutant should NOT refuse on: ${name}`).toBe(0);
    });
  }
});

describe("what it deliberately lets through", () => {
  test("a pull request that links an issue passes", () => {
    const r = run(SCRIPT, JSON.stringify({ number: 2, body: "Fixes #9", closingIssuesReferences: [{ number: 9 }] }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("links 1 issue");
  });

  test("a pull request that mentions an issue without closing it passes", () => {
    // The 23-of-24 case. A check that fired here would be wrong far more
    // often than it was right on the only corpus available.
    const body = "This is the same class as #1204, and #1286 is open about the writer.\n";
    const r = run(SCRIPT, JSON.stringify({ number: 3, body, closingIssuesReferences: [] }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("claims none");
  });

  test("an inert reference to an issue that IS linked passes", () => {
    // The row that keeps the widened check narrow. #9 closes on the live
    // reference whatever the code span says, so firing here would be a
    // false positive — and it is the one the cheapest version of this fix
    // produces, because "scan the body whenever there are inert refs" and
    // "scan the body for inert refs NOT already linked" differ only here.
    const body = "Fixes #9\n\nsee also `Fixes #9` in the old description.\n";
    const r = run(SCRIPT, JSON.stringify({ number: 5, body, closingIssuesReferences: [{ number: 9 }] }));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("links 1 issue");
  });

  test("a negation passes", () => {
    const body = "Fixes nothing on its own — leaving #713 open deliberately.\n";
    const r = run(SCRIPT, JSON.stringify({ number: 4, body, closingIssuesReferences: [] }));
    expect(r.code).toBe(0);
  });
});
