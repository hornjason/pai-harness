/**
 * #983 — the validator's measured sandbox-globals list governed nothing.
 *
 * `scripts/validate-workflow.ts` declared `WORKFLOW_GLOBALS` under a comment
 * announcing an "undeclared globals check". There was no such check. Measured
 * on `origin/main` at 78a94f63: one declaration, two prose mentions, no
 * reader anywhere in the tree, and no corresponding line in the validator's
 * output — the numbering went 1, 2, 3b, 4.
 *
 * THE DECISION, recorded on the issue before any of this was written. The
 * undeclared-globals REFUSAL is not wanted, and the reason is a property of
 * the list rather than of the effort it would take: every entry is a
 * `typeof <name>` reading that a name IS provided, over a candidate set
 * somebody chose, so the list's COMPLEMENT is UNMEASURED and not ABSENT.
 * Refusing a name for being missing from a list of positive readings converts
 * UNMEASURED into FAIL — `.claude/rules/config-access.md`'s Silent Default
 * Substitution, pointed the other way. The deny lists have no such problem:
 * every entry in them is something somebody watched throw.
 *
 * SO THE LIST KEEPS ITS PROVENANCE AND ACQUIRES THE READER IT SHOULD HAVE
 * HAD. The claim it is load-bearing for was already written down one docstring
 * below it, in prose, executed by nothing — *"`Date` and `Math` are both in
 * `WORKFLOW_GLOBALS` and both really are there, so a name-shaped detector is
 * structurally incapable of seeing `Date.now()`"*. Check 3 executes it, and
 * refuses in two directions:
 *
 *   - a name in BOTH the measured list and `FORBIDDEN_SANDBOX_GLOBALS`. That
 *     is the pre-#69 defect verbatim — the list claimed require, process,
 *     Buffer and eval were available, which is what let ship.js ship a
 *     top-level `require()` that killed every run.
 *   - a capability form whose base global is not measured-present. A member
 *     pattern only makes sense for a global that IS there; if the whole name
 *     is unavailable the entry belongs in `FORBIDDEN_SANDBOX_GLOBALS`, where
 *     it catches every member instead of the one spelling somebody thought of.
 *
 * WHAT THESE CASES ASSERT. That the list is read by CODE and not only by
 * prose (the issue's own `grep -c` measurement, turned into a check, with
 * comments and string literals blanked so a mention cannot satisfy it); that
 * each refusal fires on a planted contradiction; that lists with nothing in
 * them report UNMEASURED rather than perfect agreement (#621 — zero strings
 * are trivially all equal); and — via a mutant validator whose `REFUSE_EXIT`
 * is 0 — that the refusal is what produces the non-zero exit rather than a
 * crash or a module-resolution failure.
 *
 * THE CHEAPEST WRONG FIX, named: delete the four lines of header comment and
 * leave the list sitting there unread. The issue's complaint stops being
 * true, it costs one edit, and the measured record is exactly as inert as
 * before. The AC-1 cases survive it non-vacuously — they read the list's
 * occurrences in blanked-out CODE, so a tree where only prose changed still
 * reports one occurrence and no reader.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commentMask, stripJsComments } from "../lib/strip-js-comments";

const REPO_ROOT = join(import.meta.dir, "..");
const VALIDATOR = join(REPO_ROOT, "scripts", "validate-workflow.ts");
const validatorSource = readFileSync(VALIDATOR, "utf-8");

const REFUSE_EXIT_DECL = "export const REFUSE_EXIT = 1;";
const LIST_OPEN = "const WORKFLOW_GLOBALS = new Set([";
const CAPABILITIES_OPEN =
  "const FORBIDDEN_SANDBOX_CAPABILITIES: { label: string; base: string | null; pattern: RegExp; reason: string }[] = [";

let DIR = "";
/** The validator with its one exit-code constant set to 0. */
let EXIT_ZERO = "";

/**
 * Exactly the comment text of a source, with every offset preserved — the
 * inverse of `stripJsComments`, built from the same binding so the two
 * cannot disagree about where a comment is.
 */
function commentsOnly(src: string): string {
  const mask = commentMask(src);
  return Array.from(src, (ch, i) => (mask[i] ? ch : " ")).join("");
}

/** The source with comments AND literal contents blanked — code only. */
function codeOnly(src: string): string {
  return stripJsComments(src, { blankLiterals: true });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Locate `anchor` exactly once, or abort the file rather than measure nothing. */
function once(src: string, anchor: string): number {
  const hits = occurrences(src, anchor);
  if (hits !== 1) {
    throw new Error(`could not build the mutant: \`${anchor.slice(0, 48)}…\` appears ${hits} times`);
  }
  return src.indexOf(anchor);
}

/** Write a mutant validator into the scratch dir and return its path. */
function mutant(name: string, source: string): string {
  const p = join(DIR, `validate-workflow-${name}.ts`);
  writeFileSync(p, source);
  return p;
}

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "sandbox-lists-983-"));

  once(validatorSource, REFUSE_EXIT_DECL);
  const inlined = validatorSource.match(/process\.exit\(\s*[1-9]/g) || [];
  if (inlined.length > 0) {
    throw new Error(`could not build the mutant: ${inlined.length} inlined non-zero exit(s)`);
  }
  // Every mutant runs from a temp directory, so a relative import would make
  // it die on module resolution — a non-zero exit that reads as the mutation
  // having been rejected on the merits.
  const relative = validatorSource.match(/from\s+["']\.\.?\//g) || [];
  if (relative.length > 0) {
    throw new Error(`could not build the mutant: the validator gained ${relative.length} relative import(s)`);
  }

  EXIT_ZERO = validatorSource.replace(REFUSE_EXIT_DECL, "export const REFUSE_EXIT = 0;");
});

afterAll(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

function run(target: string, validator = VALIDATOR) {
  const r = spawnSync("bun", [validator, target], { encoding: "utf-8", cwd: REPO_ROOT });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** A syntactically valid, sandbox-legal workflow script. The check under test
 *  does not read the target at all, so the target must be clean: a fixture
 *  that trips another check would make every exit code here ambiguous. */
let CLEAN = "";
beforeAll(() => {
  CLEAN = join(DIR, "clean-workflow.js");
  writeFileSync(
    CLEAN,
    "export const meta = { name: 'clean', description: 'fixture for #983' }\nlog('ok')\n",
  );
});

describe("#983 / AC-1: the measured list is read by code, not only by prose", () => {
  test("the control: the blanking ran, and prose does mention the list", () => {
    // Without this, a `codeOnly` that returned "" would make the case below
    // fail for the wrong reason and a `codeOnly` that returned the raw source
    // would make it pass for the wrong one. Both are ruled out by comparing.
    const raw = occurrences(validatorSource, "WORKFLOW_GLOBALS");
    const code = occurrences(codeOnly(validatorSource), "WORKFLOW_GLOBALS");
    expect(raw).toBeGreaterThan(code);
    expect(codeOnly(validatorSource).length).toBe(validatorSource.length);
  });

  test("WORKFLOW_GLOBALS is referenced by executable code, not only mentioned", () => {
    const code = codeOnly(validatorSource);
    expect(
      occurrences(code, "WORKFLOW_GLOBALS"),
      "the measured sandbox-globals list has no reader: it is declared and " +
        "never read, which is #983. Give it a reader or delete it — a comment " +
        "describing a check is not a check " +
        "(.claude/rules/checks-must-be-able-to-fail.md).",
    ).toBeGreaterThan(1);
  });

  test("the validator reports the comparison it made, pass or fail", () => {
    const r = run(CLEAN);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(
      /✓ Sandbox lists agree: \d+ unavailable name\(s\) and \d+ capability form\(s\) checked against the \d+ measured global\(s\)/,
    );
  });
});

describe("#983 / AC-2: a name claimed available AND unavailable is refused", () => {
  /**
   * The pre-#69 defect, reintroduced by hand: the list used to claim
   * `require`, `process`, `Buffer` and `eval` were available while the deny
   * list said they are not. Nothing has stopped that recurring since the day
   * it was fixed.
   */
  const withEval = (src: string) =>
    src.slice(0, once(src, LIST_OPEN) + LIST_OPEN.length) +
    '\n  "eval",' +
    src.slice(once(src, LIST_OPEN) + LIST_OPEN.length);

  test("the contradiction is refused, naming the name and both lists", () => {
    const r = run(CLEAN, mutant("claims-eval", withEval(validatorSource)));
    expect(r.out).toMatch(/✗ Sandbox lists disagree/);
    expect(r.out).toMatch(/`eval`/);
    expect(r.code).not.toBe(0);
  });

  test("the refusal, not a crash, is what makes the exit non-zero", () => {
    expect(run(CLEAN, mutant("claims-eval-2", withEval(validatorSource))).code).not.toBe(0);
    expect(run(CLEAN, mutant("claims-eval-exit0", withEval(EXIT_ZERO))).code).toBe(0);
  });
});

describe("#983 / AC-3: a capability form whose base global is not measured is refused", () => {
  /**
   * `Date.now()` is a legitimate capability entry because `Date` is measured
   * present — that is the whole argument for the capability list existing
   * beside the name list. An entry on a base nobody has measured is either a
   * name that belongs in `FORBIDDEN_SANDBOX_GLOBALS`, where banning the name
   * catches every member, or a base that needs probing. Either way it is not
   * this list's job, and the refusal says so.
   */
  const withForeignBase = (src: string) => {
    const at = once(src, CAPABILITIES_OPEN) + CAPABILITIES_OPEN.length;
    return (
      src.slice(0, at) +
      `\n  {\n    label: "crypto.randomUUID()",\n    base: "crypto",\n` +
      `    pattern: /(?<![.\\w$])crypto\\s*\\.\\s*randomUUID\\s*\\(/g,\n` +
      `    reason: "fixture for #983",\n  },` +
      src.slice(at)
    );
  };

  test("the entry is refused, naming the base and where it belongs instead", () => {
    const r = run(CLEAN, mutant("foreign-base", withForeignBase(validatorSource)));
    expect(r.out).toMatch(/✗ Sandbox lists disagree/);
    expect(r.out).toMatch(/crypto/);
    expect(r.out).toMatch(/FORBIDDEN_SANDBOX_GLOBALS/);
    expect(r.code).not.toBe(0);
  });

  test("the refusal, not a crash, is what makes the exit non-zero", () => {
    expect(run(CLEAN, mutant("foreign-base-2", withForeignBase(validatorSource))).code).not.toBe(0);
    expect(run(CLEAN, mutant("foreign-base-exit0", withForeignBase(EXIT_ZERO))).code).toBe(0);
  });

  test("every capability form in the real list declares its base", () => {
    // A comparison that silently has nothing to compare is the #621 shape.
    // `import()` is syntax rather than a member access and declares `null`,
    // which is a reading; a missing field is not.
    const at = once(validatorSource, CAPABILITIES_OPEN);
    const end = validatorSource.indexOf("\n];", at);
    expect(end).toBeGreaterThan(at);
    const block = validatorSource.slice(at, end);
    const labels = occurrences(block, "label:");
    const bases = occurrences(block, "base:");
    expect(labels).toBeGreaterThan(0);
    expect(bases).toBe(labels);
  });
});

describe("#983 / AC-4: nothing to compare is UNMEASURED, not agreement", () => {
  /**
   * #621: a check that reads N positions and compares what it found dies by
   * finding nothing in all of them, because zero strings are trivially all
   * equal. Emptying the measured list is the input that produces it here.
   */
  const emptied = (src: string) => {
    const at = once(src, LIST_OPEN);
    const close = src.indexOf("]);", at);
    if (close < 0) throw new Error("could not build the mutant: the list does not close");
    return src.slice(0, at) + "const WORKFLOW_GLOBALS = new Set<string>([" + src.slice(close);
  };

  test("an empty measured list refuses rather than agreeing with everything", () => {
    const r = run(CLEAN, mutant("empty-list", emptied(validatorSource)));
    expect(r.out).toMatch(/UNMEASURED/);
    expect(r.code).not.toBe(0);
  });

  test("the refusal, not a crash, is what makes the exit non-zero", () => {
    expect(run(CLEAN, mutant("empty-list-2", emptied(validatorSource))).code).not.toBe(0);
    expect(run(CLEAN, mutant("empty-list-exit0", emptied(EXIT_ZERO))).code).toBe(0);
  });
});

describe("#983 / AC-5: the real tree", () => {
  const SCRIPTS = readdirSync(join(REPO_ROOT, "workflows")).filter(f => f.endsWith(".js"));

  test("there are workflow scripts to check — an empty list passes over anything", () => {
    expect(SCRIPTS.length).toBeGreaterThan(0);
  });

  for (const name of SCRIPTS) {
    test(`workflows/${name} validates with the sandbox lists agreeing`, () => {
      const r = run(join(REPO_ROOT, "workflows", name));
      expect(r.out, r.out).not.toMatch(/Sandbox lists disagree/);
      expect(r.out, r.out).not.toMatch(/Sandbox list consistency: UNMEASURED/);
    });
  }
});

describe("#983 / AC-6: no comment claims a check that does not exist", () => {
  test("the control: the comment text was extracted and is the validator's", () => {
    const comments = commentsOnly(validatorSource);
    expect(comments.length).toBe(validatorSource.length);
    // A sentence that is in the file, so an extractor returning nothing — on
    // which the case below passes vacuously — fails here instead.
    expect(comments).toMatch(/MEASURED, not assumed/);
    // …and one that is code rather than comment, so an extractor returning
    // the whole source fails here.
    expect(comments).not.toMatch(/new Set\(\[/);
  });

  test("the validator's comments announce no undeclared-globals check", () => {
    expect(
      commentsOnly(validatorSource),
      "a comment describing a check the validator does not run reads as " +
        "documentation of behaviour, which is #983. Either build the check " +
        "or do not describe one.",
    ).not.toMatch(/[Uu]ndeclared globals? check/);
  });
});
