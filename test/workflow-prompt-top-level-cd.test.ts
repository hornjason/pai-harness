/**
 * #1056: no command written into a `workflows/*.js` agent prompt is one the
 * registered guard refuses.
 *
 * ## Why this is a property of the repository and not of a unit
 *
 * `hooks/TopLevelCdGuard.hook.ts` is registered at project scope and fires on
 * every `Bash` tool call made by any agent working in this repo. Prompt text
 * handed to an agent BECOMES that agent's Bash call, so a `cd` written into a
 * prompt here is a command the harness will refuse when it reaches the agent
 * that was told to run it. At the time this was filed, 50 such commands were
 * sitting in these files, dormant only because the three largest workflows had
 * been disabled since 2026-10-19 under direct-ship mode. The first run after a
 * mode switch would have hit all of them at once, in a pipeline nobody had
 * touched in the interim.
 *
 * Fixing the 50 does nothing about the 51st. This is the half that lasts.
 *
 * ## One decider, not two
 *
 * The decision is `topLevelCdRefusal` — the same binding the hook calls, not a
 * second regex that agrees with it. A second spelling here would be the
 * two-deciders-that-agree defect (`.claude/rules/checks-must-be-able-to-fail.md`,
 * the fourth shape) living inside the test for the first one: mutate the hook's
 * parser and this file would stay green over it.
 *
 * What this file DOES own is the extraction — turning a JavaScript source file
 * into the list of command strings to ask about. `candidateCommands` is
 * deliberately generous and strips only WRAPPERS, never content: indentation,
 * a markdown list marker, a `return`/`const x =`/`+` that begins a JS line, an
 * opening backtick, a `Run:` lead-in. Every one of those forms has actually
 * appeared in front of a `cd` in these files. Being generous is the safe
 * direction here for the same reason the guard itself over-refuses: a
 * candidate that is not really a command costs one rewrite, and a command the
 * extractor never built costs a refused pipeline nobody can attribute.
 *
 * ## The cheapest wrong fix, named
 *
 * `RUNGATE_CD_GUARD=off` in the workflow environment. The refusals vanish, the
 * commands stay, and the guard is disabled in exactly the pipeline that spawns
 * the most concurrent worktree-holding agents. A case that passes with the
 * guard disabled witnesses nothing — so the last test below runs the scan with
 * that variable set and shows the planted violation is still found. The mode
 * switch lives in the hook; `topLevelCdRefusal` has no mode and cannot be
 * turned off, which is why this check survives that fix for real rather than
 * vacuously.
 *
 * ## The second half, added by #1086
 *
 * The rewrite above removed the `cd` and kept the path bare. `cd ${X} && git`
 * and `git -C ${X}` interpolate the directory the same way, so a fix that
 * touched 50 commands carried an unquoted path to every one of them —
 * measured on `91386f0f`, 64 directory arguments across four workflow files,
 * in a tree where `shellQuote` already existed and was already called 65
 * times. The second describe block below asks the other question about the
 * same lines: not "does this move the session" but "does this survive a
 * directory name with a space in it".
 *
 * They are deliberately in one file. A reader sent here by either failure
 * should see that both are properties of the same rewrite, and the second
 * one is the half that a search for `shellQuote` in `workflows/ship.js`
 * actively hides — 65 hits read as a file that handles quoting.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { remedyMessage } from "../lib/check-remedy";
import {
  BARE_PATH_REMEDY,
  barePathInterpolations,
  barePathInterpolationsIn,
} from "../lib/shell-path-interpolation";
import { CD_GUARD_MODE_VAR, topLevelCdRefusal } from "../lib/top-level-cd";
import { shellQuote } from "../lib/workflow-security";

const REPO_ROOT = join(import.meta.dir, "..");
const WORKFLOW_DIR = join(REPO_ROOT, "workflows");

/**
 * The command strings one source line could become once an agent reads it.
 *
 * More than one, because the wrappers nest: `   1. Run: \`cd /x && make\`` is a
 * list marker, a lead-in and a backtick deep. Each successive strip is offered
 * to the decider, and the first refusal wins.
 */
function candidateCommands(line: string): string[] {
  const out: string[] = [];
  const bare = line.replace(/^[\s>]*/, "");
  out.push(bare);

  const unlisted = bare.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  if (unlisted !== bare) out.push(unlisted);

  let s = unlisted;
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/^(?:return|const\s+[A-Za-z_$][\w$]*\s*=|\+)\s*/, "")
      .replace(/^`/, "")
      .replace(/^(?:Run|Then|Command)\s*:?\s+/i, "")
      .trimStart();
    if (next === s) break;
    s = next;
    out.push(s);
  }
  return out.filter(c => c.trim() !== "");
}

/** `<file>:<line> — <segment>` for every refusable command in a source. */
export function refusedCommands(relPath: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    for (const candidate of candidateCommands(line)) {
      const refusal = topLevelCdRefusal(candidate);
      if (!refusal) continue;
      found.push(`${relPath}:${i + 1} — ${refusal.segment.slice(0, 120)}`);
      return;
    }
  });
  return found;
}

const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith(".js"))
  .sort();

describe("#1056: workflow prompts carry no command the registered guard refuses", () => {
  test("the scan has a population to be about", () => {
    // Without this, every assertion below is satisfied by a `workflows/`
    // directory the glob stopped matching.
    expect(WORKFLOW_FILES.length, "no workflow sources were scanned").toBeGreaterThan(3);
  });

  for (const file of WORKFLOW_FILES) {
    test(`workflows/${file}`, () => {
      const rel = `workflows/${file}`;
      const refused = refusedCommands(rel, readFileSync(join(WORKFLOW_DIR, file), "utf-8"));
      expect(
        refused,
        remedyMessage({
          root: REPO_ROOT,
          check: "CD-GUARD-1",
          violations: refused,
          fix:
            "a prompt command here is one hooks/TopLevelCdGuard.hook.ts refuses, so the agent " +
            "told to run it will be refused. Rewrite it, in this order of preference: " +
            "`git -C <path> <subcommand>` for anything git; an explicit path flag the command " +
            "already takes (`--project`, `--cwd`, `--prefix`, `-C`); `bun --cwd <path> <args>` " +
            "for a bun script; and only then a subshell `( cd <path> && <command> )`, which " +
            "keeps the directory dependency the other three remove. Do NOT set " +
            `${CD_GUARD_MODE_VAR}=off and do NOT widen the guard — the guard's default is ` +
            "`block` by the owner's decision in #992, made with the measurement in hand.",
        }),
      ).toEqual([]);
    });
  }
});

describe("#1056: the scan can fail, and fails on the right input", () => {
  // The population above is empty by construction after the fix, so on its own
  // it is indistinguishable from an extractor that builds no candidates and a
  // decider that never refuses. These are the inputs that separate the two.

  const PLANTED_VIOLATION = [
    "const step = await agent(`",
    "Run exactly this and report what it prints:",
    "",
    "cd ${PROJECT_ROOT} && git rev-parse HEAD",
    "`)",
  ].join("\n");

  test("a top-level cd written into a prompt IS found", () => {
    const found = refusedCommands("planted.js", PLANTED_VIOLATION);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("planted.js:4");
  });

  test("the forms the fix uses are NOT found, or the check forbids its own remedy", () => {
    // The mutant/original pair for the extraction: these four lines and the
    // planted line above differ only in HOW the directory is named, and that
    // difference is the entire property. A scan that flagged these would have
    // sent the next agent back to `cd`.
    const clean = [
      "git -C ${PROJECT_ROOT} rev-parse HEAD",
      "bun --cwd ${HARNESS_ROOT} scripts/github-op.ts issue-get --repo ${REPO}",
      "( cd ${PROJECT_ROOT} && ${testCommand} ) 2>&1 | tail -20",
      "This step used to cd into the worktree; it does not any more.",
    ].join("\n");
    expect(refusedCommands("clean.js", clean)).toEqual([]);
  });

  test("the wrappers are stripped, so a cd inside a numbered step is still a cd", () => {
    // The naive extractor — `line.startsWith("cd ")` — misses every one of
    // these, and all three shapes are real lines from the files this fixed.
    const wrapped = [
      "   1. Run: cd ${PROJECT_ROOT} && bun test",
      "  return `cd ${quote(projectRoot)} && ${testCommand}`",
      "- cd ${commitDir} && git push",
    ].join("\n");
    expect(refusedCommands("wrapped.js", wrapped)).toHaveLength(3);
  });

  test(`${CD_GUARD_MODE_VAR}=off does not make this check pass`, () => {
    // The cheapest wrong fix, run. The mode is read by the HOOK; the decider
    // this check calls has none, so disabling the guard in the pipeline leaves
    // the violation visible here. Really, not vacuously: the variable is set
    // for the duration of the scan and the planted input is unchanged.
    const previous = process.env[CD_GUARD_MODE_VAR];
    process.env[CD_GUARD_MODE_VAR] = "off";
    try {
      expect(
        refusedCommands("planted.js", PLANTED_VIOLATION),
        "turning the guard off hid the violation from the check that exists to find it",
      ).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env[CD_GUARD_MODE_VAR];
      else process.env[CD_GUARD_MODE_VAR] = previous;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// #1086: the same lines, quoted
// ═══════════════════════════════════════════════════════════════════════

const SHELL_QUOTE_START = "// ──── SHELL-QUOTE-START ────";
const SHELL_QUOTE_END = "// ──── SHELL-QUOTE-END ────";

/** The inline `shellQuote` block a workflow carries, markers included. */
function shellQuoteBlock(source: string, rel: string): string {
  const a = source.indexOf(SHELL_QUOTE_START);
  const b = source.indexOf(SHELL_QUOTE_END);
  if (a === -1 || b === -1) {
    throw new Error(
      `${rel} builds shell commands but carries no ${SHELL_QUOTE_START} block. ` +
        BARE_PATH_REMEDY,
    );
  }
  return source.slice(a, b + SHELL_QUOTE_END.length);
}

/** The copy as a callable, so a case can compare behaviour and not text. */
function loadCopy(block: string): (word: unknown) => string {
  return new Function(`${block}\nreturn shellQuote`)() as (word: unknown) => string;
}

/** Workflow files that actually build a shell command, so carry a copy. */
const QUOTING_WORKFLOWS = WORKFLOW_FILES.filter(f =>
  readFileSync(join(WORKFLOW_DIR, f), "utf-8").includes(SHELL_QUOTE_START),
);

describe("#1086: no workflow prompt hands a shell an unquoted directory", () => {
  test("the scan has a population to be about", () => {
    // Same control as the `cd` scan above, and for the same reason: every
    // assertion below is otherwise satisfied by a glob that stopped matching.
    expect(WORKFLOW_FILES.length, "no workflow sources were scanned").toBeGreaterThan(3);
  });

  for (const file of WORKFLOW_FILES) {
    test(`workflows/${file}`, () => {
      const rel = `workflows/${file}`;
      const violations = barePathInterpolationsIn(
        readFileSync(join(WORKFLOW_DIR, file), "utf-8"),
      ).map(v => `${rel}:${v.line} — ${v.form} ${v.expression}`);
      expect(
        violations,
        remedyMessage({
          root: REPO_ROOT,
          check: "SHELL-QUOTE-1",
          violations,
          fix: BARE_PATH_REMEDY,
        }),
      ).toEqual([]);
    });
  }
});

describe("#1086: the scan can fail, and fails on the right input", () => {
  // The population above is empty by construction after the fix. These are
  // the inputs that separate a working scan from one that builds no
  // candidates and a decider that never refuses.

  test("a bare directory interpolation IS found", () => {
    expect(barePathInterpolations("git -C ${PROJECT_ROOT} status")).toHaveLength(1);
    expect(barePathInterpolations("bun --cwd ${HARNESS_ROOT} scripts/x.ts")).toHaveLength(1);
    expect(barePathInterpolations("( cd ${PROJECT_ROOT} && make )")).toHaveLength(1);
    expect(barePathInterpolations("x.ts --project ${PROJECT_ROOT}")).toHaveLength(1);
  });

  test("the forms the fix uses are NOT found, or the check forbids its own remedy", () => {
    // The mutant/original pair for the decider: these lines and the ones
    // above differ only in HOW the directory is quoted, and that difference
    // is the entire property. A scan that flagged these would have sent the
    // next agent back to the bare form.
    const clean = [
      "git -C ${shellQuote(PROJECT_ROOT)} status",
      "git -C ${shellQuote(PROJECT_ROOT || '.')} status",
      "bun --cwd ${shellQuote(`${HARNESS_ROOT}/x`)} y.ts",
      "git -C /Users/x/thing status",
      "--project ${q(projectRoot)}",
    ];
    for (const line of clean) {
      expect(barePathInterpolations(line), line).toEqual([]);
    }
  });

  test("a path quoted once into a variable is NOT found, which is how ship.js writes it", () => {
    // `gitDerivedStaging` in workflows/ship.js binds the quoted value because
    // one of its four uses is inside a double-quoted `echo`, where re-quoting
    // at the site would be wrong. The exemplar predates this check.
    const source = [
      "function gitDerivedStaging(dir) {",
      "  const d = shellQuote(dir)",
      "  return `git -C ${d} add -A`",
      "}",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toEqual([]);

    // And the laundering is a BINDING, not a name: rename the quoter away and
    // the same `${d}` is refused. Without this the case above is satisfied by
    // a decider that accepts any single-letter name.
    expect(barePathInterpolationsIn(source.replace("shellQuote(dir)", "String(dir)"))).toHaveLength(1);
  });

  // ── #1106: the exemption is a binding in scope, not a name ──────────────

  test("#1106: a second binding of the same name does NOT inherit the quoter's exemption", () => {
    // THE case. A security review measured this against `workflows/ship.js`,
    // which binds `d` four times and quotes only one of them: injecting
    // `git -C ${d}` beside any of the other three produced 0 refusals, while
    // the same line with `${zz}` produced 1. The decider laundered an
    // unquoted interpolation because the name matched a quoter elsewhere.
    const source = [
      "function quoted(dir) {",
      "  const d = shellQuote(dir)",
      "  return `git -C ${d} add -A`",
      "}",
      "function notQuoted(dir) {",
      "  const d = String(dir == null ? '' : dir)",
      "  return `git -C ${d} status`",
      "}",
    ].join("\n");

    const found = barePathInterpolationsIn(source);
    expect(
      found.map(f => `${f.line}: ${f.form} ${f.expression}`),
      "the `${d}` under `const d = String(...)` was accepted because another function " +
        "in the same file binds `d` to a quoter — lib/shell-path-interpolation.ts, " +
        "launderedQuoterSites.",
    ).toEqual(["7: -C ${d}"]);
  });

  test("#1106: and the quoter's OWN uses are still laundered — the exemplar is not collateral", () => {
    // The control for the case above. Without it, a decider that simply
    // stopped laundering anything would satisfy it perfectly while breaking
    // `gitDerivedStaging`, which is the shape this check was built around.
    const source = [
      "function quoted(dir) {",
      "  const d = shellQuote(dir)",
      "  return [`git -C ${d} add -A`, `git -C ${d} status`].join('')",
      "}",
      "function notQuoted(dir) {",
      "  const d = String(dir)",
      "  return `echo ${d}`",
      "}",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toEqual([]);
  });

  test("#1106: 'bound exactly once in the file' is NOT the fix, and this is the case that says so", () => {
    // The cheapest repair for the hole above is to launder only names with a
    // single declaration. It is two lines, it closes the measured injection,
    // and it is wrong: `ship.js` declares `d` four times, so under it the two
    // REAL `git -C ${d}` uses inside `gitDerivedStaging` — correctly quoted —
    // become refusals. Measured on the live tree: 0 refusals becomes 2 false
    // ones.
    //
    // This case is that shape in miniature. It goes green under the correct
    // fix and red under the cheap one, which is the only way the two can be
    // told apart by a test rather than by a paragraph.
    const source = [
      "function a(dir) { const d = shellQuote(dir); return `git -C ${d} x` }",
      "function b(p) { const d = collect(p); return d.length }",
      "function c(w) { const d = ok(w); return d }",
      "function e(v) { const d = String(v); return d }",
    ].join("\n");
    expect(
      barePathInterpolationsIn(source),
      "a correctly-quoted use was refused because its name is declared more than once " +
        "elsewhere in the file — that is the 'bound exactly once' fix, which this case exists " +
        "to refuse.",
    ).toEqual([]);
  });

  test("#1106: a parameter shadows an outer quoter, which no declaration count can see", () => {
    // `const NAME =` is the only form a name scan recognises. A parameter
    // introduces a binding and is spelled nothing like that, so under any
    // count-the-declarations rule this file has exactly ONE `d` and the
    // parameter's `${d}` is laundered. Scope resolution is what refuses it.
    const source = [
      "const d = shellQuote(root)",
      "function inner(d) {",
      "  return `git -C ${d} status`",
      "}",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toHaveLength(1);
  });

  test("#1106: a source that will not parse launders nothing, rather than everything", () => {
    // Fail CLOSED. The opposite default would make a syntax error the most
    // effective way to switch this check off, and an unparseable file is
    // exactly where a reader is least able to notice.
    const broken = [
      "function quoted(dir) {",
      "  const d = shellQuote(dir)",
      "  return `git -C ${d} add -A`",
      // no closing brace, and a stray token the parser cannot place
      "  ) ) )",
    ].join("\n");
    expect(barePathInterpolationsIn(broken)).toHaveLength(1);
  });

  // ── #1131: the exemption is a SITE, not a line ─────────────────────────

  test("#1131: two uses of one name on ONE line resolve independently", () => {
    // #1106 moved the exemption from file-wide to per-line. A line is still
    // coarser than the thing being decided: these sources are 10,000-line
    // template-literal soup where two functions routinely share a line, and
    // the laundering was handed to the line as a SET OF NAMES — so the
    // quoter's own `${d}` exempted every other `${d}` beside it.
    //
    // Both orderings, because a decider that keeps the first site's answer
    // and one that keeps the last are both wrong and only one of them is
    // visible from a single ordering.
    const quotedFirst =
      "function a(dir) { const d = shellQuote(dir); return `git -C ${d} x` }" +
      " function b(dir) { const d = String(dir); return `bun --cwd ${d} y` }";
    expect(
      barePathInterpolationsIn(quotedFirst),
      "the `${d}` under `const d = String(...)` was accepted because another binding " +
        "ON THE SAME LINE is a quoter — lib/shell-path-interpolation.ts, launderedQuoterSites.",
    ).toEqual([{ form: "--cwd", expression: "${d}", quoting: "none", line: 1 }]);

    const quotedSecond =
      "function b(dir) { const d = String(dir); return `bun --cwd ${d} y` }" +
      " function a(dir) { const d = shellQuote(dir); return `git -C ${d} x` }";
    expect(barePathInterpolationsIn(quotedSecond), "ordering changed the answer").toEqual([
      { form: "--cwd", expression: "${d}", quoting: "none", line: 1 },
    ]);
  });

  test("#1131: `${ d }` is the same site — the offset is the identifier's, not the `$`'s", () => {
    // The offset handed down has to be the one acorn gave the Identifier.
    // Deriving it from the `${` is right for `${d}` and one character short
    // for every interpolation written with a space, which launders nothing
    // and refuses a correctly-quoted path. No other case here spells an
    // interpolation with interior spaces, so without this the arithmetic is
    // only ever exercised at its easy value.
    const source = [
      "function a(dir) {",
      "  const d = shellQuote(dir)",
      "  return `git -C ${ d } add -A`",
      "}",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toEqual([]);
  });

  test("#1131: a quoter-bound name that is REASSIGNED stops being laundered", () => {
    // Pass 1 records what a name is bound to at its declaration. An
    // assignment afterwards replaces the value and the declaration still
    // says `shellQuote`, so the exemption outlives the thing that earned it.
    // Clearing on any assignment to the binding fails toward refusal.
    const source = [
      "let d = shellQuote(root)",
      "d = String(other)",
      "const cmd = `git -C ${d} status`",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toHaveLength(1);
  });

  test("#1131: ... and an UpdateExpression on it clears the exemption too", () => {
    // `d++` on a quoted string is nonsense; it is also an assignment to the
    // binding, spelled so that an `AssignmentExpression` walk never sees it.
    // Without this case that half of the walk is unwitnessed.
    const source = [
      "let d = shellQuote(root)",
      "d++",
      "const cmd = `git -C ${d} status`",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toHaveLength(1);
  });

  test("#1131: the control — without the reassignment the same source launders", () => {
    // Both cases above are satisfied by a decider that stopped laundering
    // `let` bindings, or stopped laundering anything. This is the input that
    // separates those from one that saw the assignment.
    const source = [
      "let d = shellQuote(root)",
      "const cmd = `git -C ${d} status`",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toEqual([]);
  });

  test("the cheapest wrong fix IS found: double quotes are not accepted", () => {
    const found = barePathInterpolations('git -C "${PROJECT_ROOT}" status');
    expect(found).toHaveLength(1);
    expect(found[0].quoting).toBe("double");
  });

  test("prose about a bare path is NOT found, because a comment reaches no shell", () => {
    // Taken from the docblock above `gitAddForCommit` in workflows/ship.js,
    // which recounts a defect: "the commit still ran `cd ${commitDir}`, so
    // nothing was staged". It was the only false hit of the first run of this
    // scan, and a quoting fix applied inside a comment changes nothing a
    // shell ever sees.
    const source = [
      "/**",
      " * a remediation round runs a new agent and the commit still ran",
      " * `cd ${commitDir}`, so nothing was staged.",
      " */",
      "const x = 1",
    ].join("\n");
    expect(barePathInterpolationsIn(source)).toEqual([]);

    // The control: the same text as CODE is refused, so the case above
    // witnesses the stripping rather than a decider that found nothing.
    expect(barePathInterpolationsIn("const c = `( cd ${commitDir} && make )`")).toHaveLength(1);
  });
});

describe("#1086: the failure is real, against a real shell and a real git", () => {
  // Everything above is a claim about source text. This is the claim the
  // issue actually makes — that a consumer at `/Users/x/My Projects/thing`
  // gets an error naming a directory nobody typed — rendered and run.

  const scratch = mkdtempSync(join(tmpdir(), "rg-1086-"));
  const sh = (command: string) =>
    spawnSync("/bin/sh", ["-c", command], { encoding: "utf-8" });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("a space in the checkout path breaks the bare form and not the quoted one", () => {
    const repo = join(scratch, "My Projects", "thing");
    mkdirSync(repo, { recursive: true });
    expect(spawnSync("git", ["init", "-q", repo]).status, "git init failed").toBe(0);

    // The two renderings of the SAME prompt line, differing only in the fix.
    const bare = sh(`git -C ${repo} rev-parse --show-toplevel`);
    const quoted = sh(`git -C ${shellQuote(repo)} rev-parse --show-toplevel`);

    expect(bare.status, `bare form unexpectedly succeeded: ${bare.stdout}`).not.toBe(0);
    expect(bare.stderr).toContain("My");
    expect(quoted.status, quoted.stderr).toBe(0);
    expect(quoted.stdout.trim().endsWith("thing")).toBe(true);
  });

  test("double quotes survive the space and still expand, which is why they are refused", () => {
    // Not an attacker: `PROJECT_ROOT` is a CLI argument and no issue title
    // reaches it (#1086 traced each value). This is an operator whose
    // directory name contains a `$`, and it is the reason the accepted
    // remedy is single quotes rather than the fix that answers the filed
    // symptom. workflows/ship.js carries a comment about the security review
    // that caught this exact shape inside `gitDerivedStaging`.
    const marker = join(scratch, "EXPANDED");
    const odd = join(scratch, `$(touch ${marker})`);
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, "INSIDE"), "");

    // Double quotes: the directory is not found AND the substitution runs.
    expect(sh(`test -f "${odd}/INSIDE"`).status, "double quotes found the file").not.toBe(0);
    expect(existsSync(marker), "the substitution inside double quotes did not run").toBe(true);

    rmSync(marker);
    expect(sh(`test -f ${shellQuote(join(odd, "INSIDE"))}`).status, "single quotes lost the file").toBe(0);
    expect(existsSync(marker), "single quotes expanded something").toBe(false);
  });
});

describe("#1086: every inline shellQuote is the one in lib/workflow-security.ts", () => {
  // `workflows/*.js` cannot import (#69), so each file that builds a shell
  // command carries its own copy. Four unanchored copies is how two of them
  // end up disagreeing about a backslash a year from now.

  test("the population is the files that build shell commands", () => {
    expect(QUOTING_WORKFLOWS.length, "no workflow carries an inline quoter").toBeGreaterThan(3);
  });

  test("the marked blocks are byte-identical", () => {
    const blocks = QUOTING_WORKFLOWS.map(f => ({
      file: f,
      block: shellQuoteBlock(readFileSync(join(WORKFLOW_DIR, f), "utf-8"), `workflows/${f}`),
    }));
    const diverged = blocks.filter(b => b.block !== blocks[0].block).map(b => `workflows/${b.file}`);
    expect(
      diverged,
      remedyMessage({
        root: REPO_ROOT,
        check: "SHELL-QUOTE-2",
        violations: diverged,
        fix:
          `the ${SHELL_QUOTE_START} block must be identical in every workflow that ` +
          `carries one, and must match \`shellQuote\` in lib/workflow-security.ts. ` +
          BARE_PATH_REMEDY,
      }),
    ).toEqual([]);
  });

  test("each copy agrees with lib/workflow-security.ts on every input", () => {
    // Behaviour, not text: identical blocks could still be identically wrong,
    // and the lib export is what `test/workflow-security-integration.test.ts`
    // and every TypeScript caller use.
    const inputs: unknown[] = [
      "/Users/x/My Projects/thing",
      "it's here",
      "/tmp/$(touch pwned)",
      "back`tick`",
      "a\\b",
      "line\nbreak",
      "",
      42,
      null,
    ];
    for (const file of QUOTING_WORKFLOWS) {
      const copy = loadCopy(
        shellQuoteBlock(readFileSync(join(WORKFLOW_DIR, file), "utf-8"), `workflows/${file}`),
      );
      for (const input of inputs) {
        expect(copy(input), `workflows/${file} diverged on ${JSON.stringify(input)}`)
          .toBe(shellQuote(input));
      }
    }
  });

  test("the agreement can fail, so the case above is not two spellings of the same value", () => {
    // The mutation: a copy that escapes nothing. If `loadCopy` were returning
    // the lib function — the obvious way for this battery to pass while
    // measuring nothing — this row would be green too.
    const broken = loadCopy(
      "function shellQuote(word) { return `'${String(word)}'` }",
    );
    expect(broken("it's here")).not.toBe(shellQuote("it's here"));
  });
});
