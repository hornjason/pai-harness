/**
 * ai-review-runner-shell-parity.test.ts — every runner that drives a generated
 * step drives it under the shell GitHub supplies (#1116).
 *
 * ## The gap this closes
 *
 * GitHub executes every `run:` step as `/usr/bin/bash -e {0}`. Twenty-six
 * runner call sites across twenty-one `ai-review-*` suites extracted a step's
 * script and ran it as plain `bash`. For every one of them the suite and the
 * runner were running different languages, and the difference is exactly the
 * class of defect `-e` produces: a statement whose non-zero exit is meant to
 * be read as data instead terminates the script before anything downstream
 * runs.
 *
 * #1110 was one instance. It survived seven weeks as a required check
 * reporting red with no output, and no case in the suite could have caught it,
 * because no runner used the shell GitHub uses. PR #1115 fixed the statement
 * and switched the one runner that drives it. This file is the residual: the
 * other twenty-five sites, and the check that keeps them switched.
 *
 * ## Measured, not assumed
 *
 * The sweep was run as an instrument before it was made a change. Against
 * `origin/main`, all twenty-one suites under plain `bash`: 433 pass, 0 fail.
 * The same twenty-one with `-e`: 419 pass, 14 fail, every one of the fourteen
 * tracing to a single statement — the `ai-review-run` adjudication assignment
 * that #1110 is about and #1115 repairs. With #1115's diff applied on top, all
 * fourteen go green and the count returns to 433.
 *
 * So the three categories the issue asks for, named and counted:
 *
 * - **a real defect in the script** — 14 cases, 6 suites, ONE statement, which
 *   is #1110 and is already fixed in #1115. They are not fourteen findings;
 *   they are fourteen witnesses to one, and they become its regression
 *   coverage once both land.
 * - **a test artefact** — **one**, and it arrived after the count was taken.
 *   The sweep measured zero: not one case in any suite then present
 *   deliberately drove a script into a failing state to read an intermediate
 *   value, and that outcome is what made the sweep safe. #1115 then landed
 *   `ai-review-shell-semantics.test.ts`, whose entire subject IS the `-e`
 *   difference, so it drives both shells on purpose — `RUNNER_SHELL_FLAGS`
 *   for its real assertions and a literal `[]` at three control sites. The
 *   count is corrected here rather than left standing, because a stale number
 *   in a document is a claim, and this one would be false by exactly the
 *   mechanism this file is about.
 * - **a no-op** — 15 of the 21 suites. Their steps DO contain exposed
 *   statements (11 of them), but none returns non-zero in any state the suites
 *   drive.
 *
 * ## Why a count of exposed statements is the durable half
 *
 * Switching the runners fixes today's blind spot. `AC-2` is what stops the
 * next one: it re-derives, from the committed workflow, the statements on
 * which `-e` would abort, and fails on the shape #1110 had — an assignment
 * taking its value from a command substitution whose status nothing consumes.
 *
 * That check reads the COMMITTED workflow, not the builder. A builder compared
 * to itself agrees by construction (#530); the file GitHub executes is the only
 * document that can disagree with the generator.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { AI_REVIEW_JOB, AI_REVIEW_WORKFLOW_FILE } from "../lib/scaffold/ai-review-step";

const ROOT = join(import.meta.dir, "..");
const COMMITTED = join(ROOT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);

/** The shell GitHub supplies for a `run:` step, spelled once. */
const RUNNER_FLAG = "-e";

/**
 * The suites this polices — every `ai-review-*` file EXCEPT this one.
 *
 * Excluded because this file quotes the unswitched call it is looking for,
 * in its control and in the prose above: a scanner that reads itself reports
 * its own example as a violation, and the obvious repair — rewording until
 * the match goes away — makes the check hostage to its own comments. This
 * file drives no generated step, so there is nothing here to police.
 */
const SELF = "ai-review-runner-shell-parity.test.ts";

function aiReviewSuites(): string[] {
  return readdirSync(join(ROOT, "test"))
    .filter((f) => f.startsWith("ai-review-") && f.endsWith(".test.ts") && f !== SELF)
    .sort();
}

/**
 * Every call site in a suite that hands a script to bash.
 *
 * Both spellings are present in the tree — `Bun.spawnSync(["bash", path])` and
 * `spawnSync("bash", [path])` — so matching one of them would report a clean
 * sweep over the half it cannot see.
 */
const BASH_CALL = /(?:Bun\.)?spawnSync\(\s*(?:\[\s*)?"bash"\s*,\s*(?:\[\s*)?([^\n)]*)/g;

/**
 * A flag list that SPREADS an identifier, rather than spelling its flags.
 *
 * `spawnSync("bash", [...flags, sh])` does not say which shell it drives;
 * the caller does, per call. The call site cannot answer the question, so
 * reading it as an unswitched runner is wrong — see `PARAMETERISED` below.
 */
const SPREAD_ID = /\.\.\.([A-Za-z_$][\w$]*)/;

/**
 * A declared array of runner flags opening with the flag GitHub supplies —
 * `const RUNNER_SHELL_FLAGS = ["-e"];` and anything of that shape.
 */
const DECLARED_RUNNER_FLAGS = new RegExp(`=\\s*\\[\\s*"${RUNNER_FLAG}"\\s*[,\\]]`);

/**
 * PARAMETERISED RUNNERS, and why this is narrower than an exemption.
 *
 * #1115 landed a suite whose subject is the `-e` difference itself, so it
 * drives both shells deliberately through one helper taking `flags` as a
 * parameter. Matching call-site syntax reads that single site as a single
 * unswitched runner, which is a false positive — and it is a false positive
 * on the one suite in this repository you would least want this check
 * switched off for.
 *
 * The repair is NOT a list of exempt files. An allowlist naming a file
 * becomes evidence that file was considered, it justifies itself on the next
 * reading, and it blinds the check to everything else in the file for all
 * time.
 *
 * Instead: a spread identifier is recognised as a PARAMETER, and the file
 * must still PROVE it carries the flag — it has to declare a runner-flag
 * array containing `-e` somewhere. A suite that drives plain bash and only
 * plain bash declares no such array and is still reported. So this is the
 * check gaining precision, not losing coverage, and
 * `the control for the parameterised arm` below is what holds that line: a
 * spread whose file declares flags WITHOUT `-e` must still be an offender,
 * or this is an exemption with extra steps.
 */
function offenders(src: string, label: string): { sites: number; found: string[] } {
  const found: string[] = [];
  let sites = 0;
  for (const m of src.matchAll(BASH_CALL)) {
    sites++;
    // Only the argv array, not the options object that follows it. A `-e`
    // after the `]` is not a flag, and `env: { ...GIT_ENV }` is not a
    // parameterised flag list — reading the whole tail for either one
    // reports both where neither is true.
    const argv = m[1].split("]")[0] ?? "";
    // The literal is asked FIRST, so every site that passes today keeps the
    // answer it has today and the parameterised arm can only ever acquit a
    // site the old reading had already condemned.
    const switched =
      argv.includes(`"${RUNNER_FLAG}"`) ||
      (SPREAD_ID.test(argv) && DECLARED_RUNNER_FLAGS.test(src));
    if (!switched) found.push(`${label}: ${m[0].slice(0, 80)}`);
  }
  return { sites, found };
}

describe("AC-1 (#1116): every ai-review runner uses the shell GitHub uses", () => {
  test("no suite drives a generated step as plain bash", () => {
    const all: string[] = [];
    let sites = 0;
    for (const f of aiReviewSuites()) {
      const r = offenders(readFileSync(join(ROOT, "test", f), "utf-8"), f);
      sites += r.sites;
      all.push(...r.found);
    }
    // The scan must have found the population it is policing. A regex that
    // matches nothing reports a perfect sweep, which is the same output as a
    // real one (#1110's lesson, one layer up).
    expect(sites).toBeGreaterThanOrEqual(26);
    expect(all).toEqual([]);
  });

  test("the control: the scan reports a runner that lacks the flag", () => {
    const planted = `const r = Bun.spawnSync(["bash", path], { cwd, env });`;
    expect(offenders(planted, "planted").found).toHaveLength(1);
  });

  test("the control for the parameterised arm: a spread whose flags lack the runner flag is still reported", () => {
    // Same call-site syntax as the real parameterised runner. The ONLY
    // difference is what the file declares, which is the whole of what the
    // parameterised arm reads — so if this went green, the arm would be
    // trusting the spread rather than the declaration.
    const planted = `const FLAGS = ["-u"];\nconst r = spawnSync("bash", [...FLAGS, sh], { cwd });`;
    expect(offenders(planted, "planted").found).toHaveLength(1);
  });

  test("the control for the declaration form: the flag mentioned but not DECLARED is still reported", () => {
    // Without this case the parameterised arm would be indistinguishable from
    // `src.includes('"-e"')`, and a suite could acquit itself with a comment.
    // The real file declares the flag exactly once, so the mutation that
    // reddens it removes the only occurrence and cannot tell the two apart —
    // which is why this one is planted rather than measured.
    const planted = `// drives it without "-e" on purpose\nconst r = spawnSync("bash", [...flags, sh], { cwd });`;
    expect(offenders(planted, "planted").found).toHaveLength(1);
  });

  test("the pair: the same spread IS accepted once the file declares the runner flag", () => {
    const planted = `const FLAGS = ["-e"];\nconst r = spawnSync("bash", [...FLAGS, sh], { cwd });`;
    const r = offenders(planted, "planted");
    expect(r.sites).toBe(1);
    expect(r.found).toEqual([]);
  });
});

/**
 * Statements of the committed step, joined across continuations, heredoc
 * bodies and comments dropped. `-e` acts on logical statements, so a reader
 * that works line-wise reports a guard on the wrong line: every multi-line
 * `$(…)` in the drift step carries its `|| true` on its LAST physical line.
 */
function statements(src: string): { n: number; text: string }[] {
  const lines = src.split("\n");
  const out: { n: number; text: string }[] = [];
  let buf = "";
  let start = 0;
  let heredoc: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (heredoc !== null) {
      if (t === heredoc) heredoc = null;
      continue;
    }
    if (t === "" || t.startsWith("#")) continue;
    if (buf === "") start = i + 1;
    buf += (buf ? " " : "") + t;
    const hd = raw.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/);
    const unclosed =
      (buf.match(/\$\(|\(/g) ?? []).length > (buf.match(/\)/g) ?? []).length;
    if (/(\\|&&|\|\||\|)$/.test(t) || unclosed) {
      if (hd) heredoc = hd[1];
      continue;
    }
    if (hd) heredoc = hd[1];
    out.push({ n: start, text: buf });
    buf = "";
  }
  if (buf) out.push({ n: start, text: buf });
  return out;
}

/**
 * An assignment whose value comes from a command substitution NOTHING
 * consumes — #1110's exact shape.
 *
 * The status of `VAR=$(…)` is the substitution's last command's status. A
 * trailing `|| true` INSIDE the substitution consumes it; an `&&` inside it
 * does not, which is why #1110's `adjudication=$(cd … && bunx …)` aborted.
 */
function unconsumedSubstitution(t: string): boolean {
  const asg = t.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s);
  if (asg === null) return false;
  const rhs = asg[1];
  if (!/\$\((?!\()|`/.test(rhs)) return false;
  // A guard OUTSIDE the substitution consumes it too — the reader throughout
  // the tree reader is `h=$(… hash-object …) || h=unreadable`. Blank the
  // substitutions out so only TOP-LEVEL operators are visible; an `&&` or
  // `||` inside `$(…)` says nothing about who reads the assignment's status.
  let top = "";
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "$" && t[i + 1] === "(") {
      depth++;
      i++;
      continue;
    }
    if (depth > 0 && t[i] === "(") depth++;
    else if (depth > 0 && t[i] === ")") depth--;
    else if (depth === 0) top += t[i];
  }
  if (/\|\|/.test(top.replace(/`[^`]*`/g, ""))) return false;
  return !/\|\|\s*(?:true|:)\s*\)?\s*$/.test(rhs);
}

describe("AC-2 (#1116): no generated step repeats #1110's shape", () => {
  const doc = Bun.YAML.parse(readFileSync(COMMITTED, "utf-8")) as any;
  const steps = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).filter(
    (s: any) => s?.run !== undefined,
  );

  test("the committed workflow has the run steps this reads", () => {
    expect(steps.length).toBeGreaterThanOrEqual(7);
    for (const s of steps) {
      // No step may opt out of `-e` to dodge this check: that would change
      // production to match a test, which is the fix this issue forbids.
      expect(s.shell).toBeUndefined();
    }
  });

  test("no step assigns from a command substitution nothing consumes", () => {
    const found: string[] = [];
    for (const s of steps) {
      for (const st of statements(String(s.run))) {
        if (unconsumedSubstitution(st.text)) {
          found.push(`${s.id} line ${st.n}: ${st.text.slice(0, 90)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("the control: the detector fires on #1110's statement as it was", () => {
    // Verbatim shape of the pre-#1115 adjudication, which `-e` aborted on.
    expect(
      unconsumedSubstitution(`adjudication=$(cd "$(dirname "\${P}")" && bunx rungate@0.7.0 x "\${P}" 2>&1)`),
    ).toBe(true);
    // And does NOT fire on the guarded form the drift step uses throughout.
    expect(
      unconsumedSubstitution(`added=$(printf '%s\\n' "\${after}" | grep -F -x -v -f "\${B}" || true)`),
    ).toBe(false);
  });
});
