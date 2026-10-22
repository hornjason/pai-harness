/**
 * #1056: an agent-reported path reaches a `workflows/*.js` template literal
 * only through `shellQuote`.
 *
 * ## Why this exists, and why it is a count rather than a reading
 *
 * The #1056 rewrite replaced every `cd <path> && <cmd>` in these prompts with
 * `git -C <path> <cmd>` or `bun --cwd <path> <args>`. That removes the
 * session-moving hazard and moves the path from a `cd` argument to a flag
 * argument — same string, same `bash -c`, one more interpolation site each.
 *
 * The first draft of that rewrite quoted ten of them and not the other
 * sixteen, and a half-quoted file is worse than an unquoted one: the ten that
 * are right make the file read as handled. Nothing in the suite could see the
 * difference, which is the actual defect this file closes. A review caught
 * it; a review is not a check.
 *
 * ## Why these names
 *
 * `TAINTED` is the set of bindings whose value originates in an AGENT's
 * reply, so a hostile value is reachable without a hostile user. The
 * canonical path: an implement agent reports `buildResult.worktreePath`,
 * `marcusWorktreePath` takes it verbatim, `commitDir` takes that, and
 * `commitDir` is interpolated into a shell command roughly twenty times.
 * `ship.js`'s own `collectDestination` docblock records the same value
 * arriving with `$(...)` in it and executing.
 *
 * Workflow-supplied roots — `PROJECT_ROOT`, `HARNESS_ROOT`, `WORK_DIR` — are
 * NOT in this list. They come from the run's arguments and resolved config,
 * no agent can move them, and holding every one of their several hundred
 * interpolations to this rule is a different change. They are quoted on the
 * lines #1056 touched because the quoter was already there, not because this
 * check asks for it.
 *
 * ## The one rule, and its three exceptions
 *
 * A tainted name reaches a template literal only as `${shellQuote(name)}` —
 * in prompt prose as well as in commands, because "this line is prose" is a
 * judgement a checker cannot make and a prompt line is one edit away from
 * being a command. `git -C '/path/to/wt' <subcommand>` is also better advice
 * than the unquoted form.
 *
 * Three exceptions, all values that never reach a shell: a JavaScript
 * comment, and an interpolation inside a `log(` or `refuse(` call, both of
 * which write to the run's own output. Each is asserted to be load-bearing
 * below, because an exception nothing exercises is an exception nobody can
 * show is narrow.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { remedyMessage } from "../lib/check-remedy";

const REPO_ROOT = join(import.meta.dir, "..");
const WORKFLOW_DIR = join(REPO_ROOT, "workflows");

/**
 * Bindings whose value originates in an agent's reply.
 *
 * Each carries the path it arrives by, because the next person adding a name
 * needs to know what makes one belong here — and the next person REMOVING a
 * name should have to delete a sentence that says why it was dangerous.
 */
const TAINTED: ReadonlyArray<{ name: string; from: string }> = [
  { name: "commitDir", from: "marcusWorktreePath, or collectInto; the directory git commits from" },
  { name: "marcusWorktreePath", from: "implementResult.buildResult?.worktreePath — the implement agent's reply" },
  { name: "gateCwd", from: "gateOpts.cwd, which every call site sets to commitDir" },
  { name: "dest", from: "collectDestination(intoDir) — a path an agent reported as its worktree" },
  { name: "collectInto", from: "collectTarget(distinctWorktrees, marcusWorktreePath) — agent-reported worktrees" },
  { name: "intoDir", from: "the collect destination before validation" },
];

/** A JavaScript comment line — never a prompt, never a shell string. */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/**
 * `<file>:<line> — ${name}` for every bare interpolation of a tainted name.
 *
 * Exported so the cases below can run it over planted sources as well as over
 * the live tree. The live tree is empty by construction after the fix, so a
 * scan that silently matched nothing would return the right answer today and
 * nothing on the day it mattered.
 */
export function bareTaintedInterpolations(relPath: string, source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (isComment(line)) return;
    for (const { name } of TAINTED) {
      const token = "${" + name + "}";
      let at = line.indexOf(token);
      while (at !== -1) {
        const before = line.slice(0, at);
        // Reaches the run's log, not a shell.
        if (!/\b(log|refuse)\(/.test(before)) {
          found.push(`${relPath}:${i + 1} — ${token}`);
        }
        at = line.indexOf(token, at + token.length);
      }
    }
  });
  return found;
}

/** `${shellQuote(<tainted>)}` occurrences — the positive control. */
function quotedTaintedInterpolations(source: string): number {
  return TAINTED.reduce(
    (n, { name }) => n + (source.split("${shellQuote(" + name + ")}").length - 1),
    0,
  );
}

const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR).filter(f => f.endsWith(".js")).sort();
const sourceOf = (f: string) => readFileSync(join(WORKFLOW_DIR, f), "utf-8");

describe("#1056: every agent-reported path reaching a shell is shell-quoted", () => {
  test("the names are still in the tree — otherwise every case below scans for nothing", () => {
    // A rename of `commitDir` would make the sweeps pass over an absent
    // symbol, which is the way this check dies silently. Measured at 29 when
    // written; asserted as a floor so the fix cannot be half-reverted.
    const quoted = WORKFLOW_FILES.reduce((n, f) => n + quotedTaintedInterpolations(sourceOf(f)), 0);
    expect(
      quoted,
      "no ${shellQuote(<tainted>)} interpolation was found in any workflow — either the fix was " +
        "reverted or a binding in TAINTED was renamed and this file was not updated with it",
    ).toBeGreaterThan(20);
  });

  for (const file of WORKFLOW_FILES) {
    test(`workflows/${file}`, () => {
      const rel = `workflows/${file}`;
      const bare = bareTaintedInterpolations(rel, sourceOf(file));
      expect(
        bare,
        remedyMessage({
          root: REPO_ROOT,
          check: "SHELL-QUOTE-1",
          violations: bare,
          fix:
            "this value originates in an agent's reply and is interpolated into a template " +
            "literal unquoted. Wrap it: ${shellQuote(<name>)}. Do this in prompt PROSE as well " +
            "as in commands — a prompt line is one edit away from being a command, and " +
            "`git -C '/path' <subcommand>` is the better advice anyway. If the value genuinely " +
            "never reaches a shell, it belongs in a log( ) or refuse( ) call, which this check " +
            "already skips; if it is a new binding that is NOT agent-reported, say so by not " +
            "adding it to TAINTED in this file rather than by leaving a real one bare.",
        }),
      ).toEqual([]);
    });
  }
});

describe("#1056: the quoting check can fail, and its exceptions are narrow", () => {
  test("a bare tainted interpolation in a command IS found", () => {
    const planted = "git -C ${commitDir} rev-parse HEAD";
    expect(bareTaintedInterpolations("planted.js", planted)).toEqual([
      "planted.js:1 — ${commitDir}",
    ]);
  });

  test("the quoted form is NOT found, or the check forbids its own remedy", () => {
    expect(
      bareTaintedInterpolations("planted.js", "git -C ${shellQuote(commitDir)} rev-parse HEAD"),
    ).toEqual([]);
  });

  test("two on one line are two violations, not one", () => {
    // `${commitDir}/.github/workflows/*.yml ${commitDir}/.github/workflows/*.yaml`
    // is a real line from the file this fixed, and a scanner using indexOf
    // once per line would have reported half of it.
    const planted = "x=$(ls ${commitDir}/a ${commitDir}/b)";
    expect(bareTaintedInterpolations("planted.js", planted)).toHaveLength(2);
  });

  test("a comment is skipped — and that exception is load-bearing", () => {
    // The mutant/original pair: identical text, one prefixed with `//`.
    const code = " const x = `cd ${commitDir}`";
    expect(bareTaintedInterpolations("p.js", code)).toHaveLength(1);
    expect(bareTaintedInterpolations("p.js", ` // the commit still ran \`cd \${commitDir}\``)).toEqual([]);
  });

  test("log() and refuse() are skipped — and only up to the call", () => {
    expect(bareTaintedInterpolations("p.js", "  log(`staged files into ${collectInto}`)")).toEqual([]);
    expect(bareTaintedInterpolations("p.js", "  return refuse(`cannot collect into ${intoDir}`)")).toEqual([]);
    // Not a blanket pass for the line: a command BEFORE the log call is still
    // a command. Without this, `git -C ${commitDir} x; log(...)` would be
    // exempt because the word `log(` appears somewhere to its right.
    expect(
      bareTaintedInterpolations("p.js", "  const c = `git -C ${commitDir} add -A`; log(`done`)"),
    ).toHaveLength(1);
  });
});
