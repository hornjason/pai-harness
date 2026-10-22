/**
 * shell-path-interpolation.ts — the decision behind the quoting half of the
 * `cd` rewrite (#1086)
 *
 * One question: does this source line hand a shell a DIRECTORY it built by
 * interpolation, without quoting it?
 *
 * ## What actually breaks, stated as the thing it is
 *
 * Not injection. Every value that reaches these positions in this repo's
 * workflows is a CLI argument or something derived from a repo slug and an
 * issue NUMBER — `PROJECT_ROOT`, `HARNESS_ROOT`, `WORK_DIR`, `commitDir`,
 * `marcusWorktreePath`. No issue title and no agent-reported text reaches
 * them, and #1086 traced each one to its origin before filing.
 *
 * What breaks is a consumer who checks out into `/Users/x/My Projects/thing`.
 * The prompt renders
 *
 *     git -C /Users/x/My Projects/thing status
 *
 * and git reads `-C /Users/x/My` with two stray arguments after it. The
 * agent told to run that command gets an error naming a directory nobody
 * typed. `test/workflow-prompt-top-level-cd.test.ts` runs exactly that
 * against a real shell and a real git rather than asserting it here.
 *
 * ## Why #1077 made the count go UP, and why that was still the right fix
 *
 * #1056 replaced `cd <dir> && git …` with `git -C <dir> …` throughout the
 * workflow prompts. The old form interpolated the path bare and so does the
 * new one, so a rewrite that fixed the `cd` carried the unquoted path to
 * every site it touched. The directory was always unquoted; #1077 only made
 * there be more places where it is.
 *
 * ## The reason this is a module and not a grep
 *
 * `workflows/ship.js` already defines `shellQuote` and already calls it 65
 * times. A reader who greps the file finds those 65 and concludes the file
 * handles quoting. Partial application reads as full application, which is
 * why the 64 sites measured on `91386f0f` survived every review of the file
 * they are in. A decider makes the unquoted ones enumerable instead of
 * inferable.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward REFUSAL, same as `lib/top-level-cd.ts`. A false refusal costs one
 * `shellQuote(…)`; a false allow costs a consumer a pipeline that fails in a
 * prompt they cannot edit.
 *
 * So `grep -C ${n}` (context lines, not a directory) would be refused if it
 * ever appeared with an interpolated count, and `-C` is matched without
 * asking which program precedes it.
 *
 * ## Double quotes are REFUSED, and that is the point of the exercise
 *
 * `git -C "${PROJECT_ROOT}"` survives a space and is still refused here. It
 * is the cheapest wrong fix for #1086: it answers the failure that was filed
 * and leaves `$(…)` and backticks expanding inside the quotes. That is not
 * hypothetical in this file — `gitDerivedStaging` in `workflows/ship.js`
 * carries a comment about a security review that caught exactly this shape,
 * where a `worktreePath` of `/tmp/$(touch pwned)` executed inside a
 * double-quoted echo while the `git` command beside it was safe.
 *
 * Single quotes are the only shell quoting with no interior expansion at
 * all, which is why `shellQuote` emits them and why nothing else is accepted.
 *
 * ## KNOWN GAPS — declared, not discovered later
 *
 * - **Only flag-position and `cd`-position arguments are examined.** A path
 *   interpolated somewhere a human reads as a path but a parser cannot —
 *   `mkdir -p ${WORK_DIR}`, `> ${WORK_DIR}/issue.json`, prose naming a
 *   directory — is NOT refused. Widening to every `${…}` on a command line
 *   would refuse most of the prompt text in these files, which is English.
 * - **The quoter is recognised by NAME.** `QUOTER_NAMES` below is a fixed
 *   list, so a future `q` that is not a quoter would be accepted. Two of the
 *   three spellings exist because the block they live in is extracted by
 *   marker and executed standalone by its own test, so it cannot reference
 *   anything outside itself; new code should use `shellQuote`.
 * - **A quoted value reaching the site through a variable** is accepted via
 *   `quotedBindings`, which is a file-wide name scan with no scope analysis.
 *   A later `const d = somethingElse()` in another function of the same file
 *   would launder the name.
 *
 * Issue: #1086. Related: #1056 (the `cd` rewrite), #992 (the guard it serves).
 */

import { stripJsComments } from "./strip-js-comments";

/**
 * Argument positions that name a DIRECTORY on every command this repo's
 * workflow prompts use.
 *
 * This is the same ladder `lib/top-level-cd.ts` tells callers to climb when
 * it refuses their `cd` — `git -C`, `bun --cwd`, `npm --prefix`, and a
 * `--project` flag. Refusing a `cd` into one of these and then interpolating
 * the path bare is the half-done rewrite #1086 is about, so the two lists
 * being the same list is deliberate.
 */
export const PATH_FLAGS = ["-C", "--cwd", "--prefix", "--project"] as const;

/**
 * Names this project binds to a single-quoting function.
 *
 * `shellQuote` is the one to use. The other three exist because the blocks
 * they live in are extracted by marker and executed standalone by their own
 * tests, so a reference to the module-level `shellQuote` is a test that
 * cannot run: `quote` is a PARAMETER of `suiteCaptureCommand`
 * (`test/recorder-command-executed.test.ts`), `q` is a local arrow in the
 * rook-review-scope block (`test/security-verdict-blocks.test.ts`), and
 * `shellSingleQuote` is declared inside the phase-2 decomposition block
 * (`test/evidence-command-roundtrip.test.ts`). See the gap declared above:
 * this is a name list, not a proof that the name quotes.
 */
export const QUOTER_NAMES = ["shellQuote", "shellSingleQuote", "quote", "q"] as const;

export interface BarePathInterpolation {
  /** The argument position that takes the path: a flag, or `cd`. */
  form: string;
  /** The interpolation exactly as written, e.g. `${PROJECT_ROOT}`. */
  expression: string;
  /**
   * `double` when the site is written `"${…}"`. Refused like `none`, and
   * distinguished because the remedy sentence is a different one: the author
   * reached for a fix and reached for the one that stops at spaces.
   */
  quoting: "none" | "double";
}

/** `${…}` content that is a call to a known quoter, spanning the whole thing. */
function isQuoterCall(expression: string): boolean {
  const m = expression.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (!m || !(QUOTER_NAMES as readonly string[]).includes(m[1])) return false;
  // The call must cover the entire expression. `shellQuote(a) + b` does not:
  // the concatenated tail reaches the shell unquoted.
  return matchingParen(expression, expression.indexOf("(")) === expression.length - 1;
}

/** Index of the `)` closing the `(` at `open`, or -1. Quote-aware. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Index just past the `}` closing the `${` whose `{` is at `open`, or -1.
 *
 * Brace-counting rather than a regex because the expressions nest:
 * `${shellQuote(`${HARNESS_ROOT}/scripts/x.ts`)}` has three levels and
 * `${PROJECT_ROOT || '.'}` carries a quoted brace-free string that a lazy
 * `[^}]*` happens to survive and a greedy one does not.
 */
function endOfInterpolation(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Names bound in this source to a quoter call, so `${d}` three lines below
 * `const d = shellQuote(dir)` is not refused.
 *
 * This is how `gitDerivedStaging` in `workflows/ship.js` is written, and it
 * is written that way on purpose — the quoted value is used four times and
 * one of them is inside a double-quoted `echo`, where re-quoting at the site
 * would be wrong. The exemplar predates this check; the check accommodates
 * it rather than the other way round.
 */
export function quotedBindings(source: string): Set<string> {
  const names = new Set<string>();
  const re = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${QUOTER_NAMES.join("|")})\\s*\\(`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.add(m[1]);
  return names;
}

/**
 * Every unquoted directory interpolation on this line.
 *
 * THE decider: the conformity scan, and anything later that wants the same
 * question answered, calls this and nothing else. A second spelling of the
 * parse somewhere else would be the two-deciders-that-agree defect
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape) — mutate
 * this one and the other would keep its caller green.
 *
 * Takes a LINE rather than a file because the unit a report has to name is a
 * line, and because these sources are 10,000-line template-literal soup
 * where no larger unit has a boundary worth finding.
 */
export function barePathInterpolations(
  line: string,
  quotedNames: ReadonlySet<string> = new Set(),
): BarePathInterpolation[] {
  const found: BarePathInterpolation[] = [];

  // `-C`/`--cwd`/`--prefix`/`--project` followed by its value, and the `cd`
  // builtin followed by its target. `cd` is here as well as in
  // `lib/top-level-cd.ts` because the two ask different questions about it:
  // that one asks whether the shell moves, this one asks whether the path
  // survives a space. A subshell `( cd ${X} && … )` passes the first and
  // fails the second.
  const anchor = new RegExp(
    `(?:^|[\\s"'\`(;&|])(${PATH_FLAGS.map(f => f.replace(/[-]/g, "\\-")).join("|")}|cd)(?:=|\\s+)`,
    "g",
  );

  let m: RegExpExecArray | null;
  while ((m = anchor.exec(line))) {
    const form = m[1];
    let at = m.index + m[0].length;

    const doubleQuoted = line[at] === '"';
    if (doubleQuoted) at++;
    if (line.slice(at, at + 2) !== "${") continue; // a literal path is not ours

    const end = endOfInterpolation(line, at + 1);
    if (end === -1) continue; // unbalanced: the line is not what it looks like

    const expression = line.slice(at, end);
    const inner = expression.slice(2, -1).trim();

    if (isQuoterCall(inner)) continue;
    if (quotedNames.has(inner)) continue;

    found.push({
      form,
      expression: doubleQuoted ? `"${expression}"` : expression,
      quoting: doubleQuoted ? "double" : "none",
    });
  }

  return found;
}

/** A refusal, located. */
export interface LocatedBarePath extends BarePathInterpolation {
  /** 1-based line number in the ORIGINAL source. */
  line: number;
}

/**
 * Every unquoted directory interpolation in a whole source file.
 *
 * ## Comments are stripped, and that is a decision with a measurement
 *
 * `stripJsComments` blanks comment text while preserving every byte offset,
 * so the line numbers reported here are the source's own. Without it,
 * `workflows/ship.js` is refused at the docblock above `gitAddForCommit`,
 * which reads *"the commit still ran `cd ${commitDir}`, so nothing was
 * staged"* — prose ABOUT a defect, counted as the defect. That was one of the
 * seven hits the first run of this scan produced and the only false one.
 *
 * It is also the right view for the opposite reason: a quoting fix applied
 * inside a comment changes nothing a shell ever sees, so a check that could
 * be satisfied by editing a comment is a check that can be satisfied without
 * fixing anything.
 *
 * The stripper is template-literal aware, which matters here more than
 * anywhere else in the tree — these files are mostly prompt text, and a `//`
 * inside a prompt is a URL, not a comment.
 */
export function barePathInterpolationsIn(source: string): LocatedBarePath[] {
  const code = stripJsComments(source);
  // Over the STRIPPED copy, so a `const d = shellQuote(x)` written in a
  // comment cannot launder the name `d` for real code elsewhere.
  const quoted = quotedBindings(code);
  const found: LocatedBarePath[] = [];
  code
    .split("\n")
    .forEach((line, i) => {
      for (const b of barePathInterpolations(line, quoted)) {
        found.push({ ...b, line: i + 1 });
      }
    });
  return found;
}

/**
 * What a caller is told, naming the one accepted remedy and refusing the
 * cheap one by name.
 *
 * Spelled here rather than at the call site so the refusal and the advice
 * cannot drift, the same reason `refusalMessage` lives inside
 * `lib/top-level-cd.ts`.
 */
export const BARE_PATH_REMEDY =
  "#1086: a directory is interpolated into a shell command unquoted, so a " +
  "consumer whose checkout is at `/Users/x/My Projects/thing` gets " +
  "`git -C /Users/x/My Projects/thing status` and an error naming a " +
  "directory nobody typed. Wrap the interpolation in `shellQuote(…)` at the " +
  "site, or bind it once (`const d = shellQuote(dir)`) and interpolate the " +
  "bound name. Do NOT write `\"${…}\"` instead: double quotes stop at the " +
  "space and leave `$(…)` and backticks expanding, which is the shape a " +
  "security review already caught once in `gitDerivedStaging`. Workflow " +
  "files cannot import (#69), so each one carries its own copy of " +
  "`shellQuote`; `lib/workflow-security.ts` is the source of truth and " +
  "`test/workflow-prompt-top-level-cd.test.ts` fails on any divergence.";
