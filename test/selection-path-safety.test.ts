/**
 * Every producer of a `bun test …` selection applies the SAME path guard.
 *
 * ## The defect
 *
 * `scripts/select-affected-tests.ts` has refused to print a path outside
 * `SAFE_TEST_PATH` since it was written, because the generated command is
 * `<testCommand> $(that script)` and word-splitting is how a list becomes
 * arguments. #1054 added a SECOND producer, `scripts/text-dependents.ts`,
 * documenting the same composition in its own docblock, and it printed
 * `r.tests.join(" ")` with no guard at all.
 *
 * Nothing was exploitable: both lists come from a walk of this repository's
 * own tree. **The asymmetry is the finding.** `SAFE_TEST_PATH` exists
 * because somebody already decided this output gets reparsed and that the
 * decision needed enforcing; a guard that one of two producers applies is a
 * guard with a hole, and from inside either file the hole is invisible.
 *
 * The shape is worth naming because it is the shape of the issue that
 * introduced it. #1054 is about *a dependency expressed in a syntax the
 * checker does not know*. This is the same thing one level up: *a
 * validation expressed in one of two producers*.
 *
 * ## What is a witness here and what is a control
 *
 *   WITNESS  "an unsafe path refuses the whole selection" — the behaviour
 *            the new producer did not have.
 *   WITNESS  "the refusal prints nothing on stdout" — in a `$(…)`
 *            composition, empty stdout means the full suite. A partial
 *            selection with the odd entry filtered out is the dangerous
 *            answer: it is the selection missing exactly the file that was
 *            unusual, wearing the look of a result.
 *   WITNESS  "no producer copy-pastes the pattern" — the population check.
 *            A third producer added next year is the whole risk, and it is
 *            the only case here that a future author cannot avoid tripping.
 *            **Read the next section before trusting its name.**
 *   CONTROL  "an ordinary selection is not refused" — a guard that refuses
 *            everything passes every witness above and is useless.
 *   CONTROL  "the two producers hold the SAME binding" — two copies that
 *            happen to agree pass a behavioural test and diverge the first
 *            time one is edited.
 *
 * ## What the population scan does NOT catch
 *
 * It catches the COPY-PASTE, not the paraphrase, and the three gaps were
 * measured against the shipped pattern rather than reasoned about:
 *
 * | written as | caught |
 * |---|---|
 * | `const P = /^[A-Za-z0-9._\/-]+\.test\.tsx?$/` | **yes** |
 * | `const P = /^(?:[A-Za-z0-9._\/-]+)\.test\.tsx?$/` — one group deeper | no |
 * | `const P = new RegExp("^[A-Za-z0-9._/-]+\\.test\\.tsx?$")` | no |
 *
 * The pattern requires the character class immediately after the anchor, so
 * a group between them hides it, and no `new RegExp(…)` form is a regex
 * literal at all. It also reads **`scripts/` only, one level deep**: both
 * producers live there today, but "the producer nobody has written yet" is
 * not bound to that directory, and one under `lib/`, `bin/` or
 * `scripts/<subdir>/` is invisible. `scripts/` currently holds 79 `.ts`
 * files and no subdirectory containing one, so the depth limit costs
 * nothing today and would cost silently.
 *
 * **Widening the regex is not the fix and was declined deliberately.** A
 * text scan for a semantic property has no closed form; a looser pattern
 * buys false positives on every file that mentions a test path, and a
 * check that cries wolf is uninstalled by the third person it stops. The
 * honest statement is that this case raises the cost of the copy and does
 * not make it impossible, and that is written here rather than implied by
 * a test name — which is the only reason the gaps are discoverable at all.
 *
 * ## The cheapest wrong fix, named
 *
 * Copy `const SAFE_TEST_PATH = /…/` into the second script. Every
 * behavioural case below goes green under it. The two that do not are the
 * identity case and the population scan — which is exactly why a
 * behaviour-only version of this file would have been worth very little.
 *
 * ## What was broken to prove it, run and counted
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 6 pass, 0 fail | **6 pass, 0 fail** | — |
 * | `refuseUnsafePaths` returns `{ ok: true, unsafe: [] }` always — the pre-fix producer | 3 | **3 of 6** | the list `["test/odd name.test.ts"]`: the original refuses, the mutant prints it into a shell command |
 * | refuse changed to filter — drop the unsafe entries and print the rest | 2 | **1 of 6** | a fixture whose only selected reader is `test/odd name.test.ts`: the original prints nothing, the mutant prints a selection with that file quietly missing |
 * | the pattern copied into `scripts/text-dependents.ts` instead of imported | 2 | **2 of 6** | no runtime input at all — the identity case and the population scan are the only things that can see it, which is the point |
 *
 * The second row came in one under its prediction, and the miss is
 * instructive rather than cosmetic: filtering instead of refusing is a
 * change to the CLI and not to `refuseUnsafePaths`, so the three
 * function-level cases are structurally unable to see it. **Only the
 * end-to-end case can**, which is the whole reason it is here and the
 * reason a version of this file written entirely against the exported
 * function would have been worth very little.
 *
 * None is left in the tree; all were run and reverted, and
 * `scripts/text-dependents.ts` was confirmed byte-identical afterwards by
 * sha256 (`741edeac43908522…`).
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { SAFE_TEST_PATH } from "../lib/affected-tests";
import { refuseUnsafePaths } from "../scripts/text-dependents";

const REPO = join(import.meta.dir, "..");

describe("one guard, every producer of a bun test selection", () => {
  // WITNESS.
  test("a path outside the alphabet refuses the whole selection", () => {
    const r = refuseUnsafePaths(["test/a.test.ts", "test/odd name.test.ts"]);
    expect(r.ok, "a path with a space was accepted into a shell command").toBe(false);
    expect(r.unsafe).toEqual(["test/odd name.test.ts"]);
  });

  // WITNESS. Refuse, do not filter.
  test("the refusal names the whole selection, not the surviving part", () => {
    const r = refuseUnsafePaths(["test/a.test.ts", "test/b$(touch pwned).test.ts"]);
    expect(r.ok).toBe(false);
    // The caller prints nothing on a refusal, so the only thing this
    // function may not do is report a trimmed list as usable.
    expect(r.unsafe, "the safe entries were reported as the answer").not.toContain(
      "test/a.test.ts",
    );
  });

  // CONTROL. A guard that refuses everything satisfies both witnesses.
  test("an ordinary selection is not refused", () => {
    const r = refuseUnsafePaths([
      "test/a.test.ts",
      "test/unit/b.test.tsx",
      "test/helpers-dir/c-d_e.test.ts",
    ]);
    expect(r.ok, `an ordinary path was refused: ${r.unsafe.join(", ")}`).toBe(true);
    expect(r.unsafe).toEqual([]);
  });

  // CONTROL. Two copies that agree pass every behavioural case above and
  // diverge the first time either is edited.
  test("both producers hold the same binding, not two equal copies", () => {
    const script = readFileSync(join(REPO, "scripts/text-dependents.ts"), "utf-8");
    const sibling = readFileSync(join(REPO, "scripts/select-affected-tests.ts"), "utf-8");

    for (const [name, src] of [
      ["scripts/text-dependents.ts", script],
      ["scripts/select-affected-tests.ts", sibling],
    ] as const) {
      expect(src, `${name} does not import SAFE_TEST_PATH`).toContain("SAFE_TEST_PATH");
      expect(
        /SAFE_TEST_PATH\s*=/.test(src),
        `${name} declares its own SAFE_TEST_PATH — two deciders that agree until one is edited`,
      ).toBe(false);
    }
    expect(SAFE_TEST_PATH.source).toBe("^[A-Za-z0-9._/-]+\\.test\\.tsx?$");
  });

  // WITNESS for the class. The risk is the producer nobody has written
  // yet, and this is the only case here that a future author cannot avoid.
  //
  // The name says "copy-pastes" and "directly under" because both are
  // true and the shorter name was not: a group between the anchor and the
  // character class hides the pattern, `new RegExp(…)` is not a regex
  // literal, and this reads one directory one level deep. The docblock's
  // "What the population scan does NOT catch" has the measured table.
  test("no file directly under scripts/ copy-pastes the test-path safety pattern", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(REPO, "scripts"))) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(join(REPO, "scripts", name), "utf-8");
      // A local regex that both admits a test path and is anchored is a
      // second copy of this decision whatever its author called it.
      if (/=\s*\/\^?\[[^\]]*\]\+?\\?\.test\\?\./.test(src)) offenders.push(`scripts/${name}`);
    }
    expect(
      offenders,
      `${offenders.join(", ")} declares a local test-path pattern. Import SAFE_TEST_PATH from ` +
        "lib/affected-tests.ts instead — two producers emitting into one shell composition need " +
        "one decider, and a copy diverges the first time either is edited. This scan catches " +
        "the copy-paste, not the paraphrase; see this file's docblock for what it misses.",
    ).toEqual([]);
  });

  // End to end, because the two halves above are about a function and a
  // file's text, and neither can show that the process exits non-zero with
  // an empty stdout — which is the property the `$(…)` composition rests on.
  test("the CLI prints nothing and exits non-zero when it cannot trust a path", () => {
    const root = mkdtempSync(join(tmpdir(), "selection-path-safety-"));
    try {
      const put = (rel: string, body: string): void => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
      };
      const git = (...args: string[]): string =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: "pipe" });

      // A subject, and a reader whose FILENAME carries a space. The reader
      // anchors into the subject, so the router selects it and the
      // selection becomes unprintable.
      put("workflows/subject.js", "// ──── A-REGION-START ────\nconst x = 1\n// ──── A-REGION-END ────\n");
      put(
        "test/odd name.test.ts",
        'import { readFileSync } from "fs";\n' +
          'const S = readFileSync("workflows/subject.js", "utf-8");\n' +
          'export const a = S.indexOf("// ──── A-REGION-START ────");\n' +
          'export const b = S.indexOf("// ──── A-REGION-END ────");\n',
      );
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD").trim();
      put("workflows/subject.js", "// ──── A-REGION-START ────\nconst x = 2\n// ──── A-REGION-END ────\n");

      const run = Bun.spawnSync({
        cmd: ["bun", join(REPO, "scripts/text-dependents.ts"), "--root", root, "--base", base],
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(run.stdout);
      const err = new TextDecoder().decode(run.stderr);

      expect(
        run.exitCode,
        `the CLI accepted an unprintable selection. stdout=${JSON.stringify(out)}`,
      ).not.toBe(0);
      expect(out.trim(), "a refusal still printed arguments for bun test").toBe("");
      expect(err).toContain("REFUSED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
