/**
 * Covers SC-825, SC-826, SC-827 (HOOK-ARCHITECTURE-SPEC.md).
 *
 * #365 — `hooks/VerifyPhaseLock.hook.ts` decided whether to allow an issue
 * with:
 *
 *     if (cmd.includes('--label') && cmd.includes('follow-up'))
 *
 * which is a test that the string `follow-up` appears anywhere in the
 * command. The issue named the case that passes today and must not:
 *
 *   > `--label bug --title "Fix the follow-up handler"` → **must refuse**.
 *   > This passes today.
 *   >
 *   > Per the mutation standard: reverting the matcher to
 *   > `cmd.includes('follow-up')` must turn the first case red. If it stays
 *   > green the test is asserting on something other than the matcher.
 *
 * So the table below is driven against `verifyPhaseRefusal`, the one
 * exported decision, and the last describe SPAWNS the hook over stdin — a
 * decision that is correct in `lib/` and not reached by the hook is the
 * defect this repo keeps finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OVERRIDE_LABELS,
  clauses,
  createsIssue,
  labelValues,
  tokenize,
  verifyPhaseRefusal,
} from "../lib/issue-create-override";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "VerifyPhaseLock.hook.ts");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** [command, allowed, why]. `allowed === false` means the lock must refuse. */
const TABLE: Array<[string, boolean, string]> = [
  // The four the issue asked for, in its order.
  [`gh issue create --label bug --title "Fix the follow-up handler"`, false,
    "the override word is in the TITLE — this is the bypass #365 is about"],
  ["gh issue create --label follow-up --title 'x'", true, "the documented override"],
  ["gh issue create --label external-audit --title 'x'", true, "the origin #362/#363/#364 actually had"],
  ["gh issue create --label bug --title 'x'", false, "a label, but not an override"],

  // Argument forms gh accepts. Each would have been missed by a matcher that
  // only knows the spaced long form.
  ["gh issue create --label=follow-up", true, "the = form"],
  ["gh issue create -l follow-up", true, "the short form"],
  ["gh issue create -l=external-audit", true, "the short = form"],
  ["gh issue create --label bug,follow-up", true, "gh takes a comma list in one flag"],
  ["gh issue create --label 'follow up'", false, "a space is not a hyphen"],

  // Shapes the old substring form got wrong in the other direction.
  ["gh issue create --label --title follow-up", false,
    "`--label` with no value, and the word appears as a positional"],
  ["gh issue comment 7 --body 'see follow-up'", true, "not a create at all"],
  ["gh issue list --label follow-up", true, "not a create at all"],
  ["gh issue comment 7 --body x && gh issue create --label bug", false,
    "the comment clause must not excuse the create clause"],
  ["gh issue create --label follow-up && gh issue create --label bug", false,
    "every create in the command needs its own override"],
  ["gh issue create --label follow-up && gh issue create --label external-audit", true,
    "both creates carry one"],
  ["echo 'gh issue create --label bug'", true,
    "a quoted command inside another is an argument, not a create"],

  // Found by the commit security review of the FIRST version of this file,
  // which split on whitespace alone. Every one of these was allowed. They
  // are the same defect as the substring matcher, one layer in: a parser
  // that disagrees with the shell about where a command begins.
  ["foo;gh issue create --label bug", false,
    "a separator with no space before `gh` — the token was `foo;gh`"],
  ["gh issue comment 1&&gh issue create --label bug", false,
    "`&&` glued to its neighbours — the token was `1&&gh`"],
  ["gh issue create --label follow-up\ngh issue create --label bug", false,
    "a newline is a separator; without it one override covered both creates"],
  ["(gh issue create --label bug)", false, "a subshell — the token was `(gh`"],
  ["bash -c \"gh issue create --label bug\"", false,
    "a shell's -c argument is a command, not data"],
  ["sh -c \"gh issue create --label follow-up\"", true,
    "...and the override still works through one"],
  ["bash -c \"bash -c \\\"gh issue create --label bug\\\"\"", false,
    "nesting does not shake the guard off"],
  ["GH_TOKEN=x gh issue create --label bug", false, "an env prefix is not the program"],
  ["GH_TOKEN=x bash -c 'gh issue create --label bug'", false,
    "an env prefix in front of the SHELL — the program name is the second token"],
  [`python3 -c "print('gh issue create --label bug')"`, true,
    "-c is code for an interpreter that is not a shell; descending into it is a false refusal"],

  // Found by the SECOND commit security review, of the fix for the first.
  // Every one was allowed.
  ["`gh issue create --label bug`", false, "backticks — the token was '`gh'"],
  ["$(gh issue create --label bug)", false, "command substitution"],
  ["/usr/bin/gh issue create --label bug", false, "a path-qualified binary is the same binary"],
  ["./gh issue create --label bug", false, "...and so is a relative one"],
  ["sh -lc 'gh issue create --label bug'", false,
    "short flags combine; only the last letter takes the argument"],
  ["bash -ic 'gh issue create --label bug'", false, "the same, interactively"],
  ["eval 'gh issue create --label bug'", false, "eval's argument is a command"],
  ["`gh issue create --label follow-up`", true, "and the override survives all of it"],
  ["/usr/bin/gh issue create --label external-audit", true, "...both of them"],

  // Found by the THIRD commit security review. Both were allowed, and both
  // are shapes someone types on purpose rather than to evade: a long command
  // wrapped across lines, and a note after one.
  ["gh issue \\\n  create --label bug", false,
    "a backslash-newline joins; it was landing a literal newline inside the token"],
  ["gh issue \\\n  create --label follow-up", true, "...and the override still works through one"],
  ["gh issue create --label bug # --label follow-up", false,
    "a commented-out override is not an override"],
  ["gh issue create --label follow-up # a note", true, "a real override with a note after it"],
  ["echo hi # gh issue create --label bug", true, "a create inside a comment creates nothing"],
  ["gh issue create --label bug --title '#5 regression'", false,
    "`#` inside a quoted argument is not a comment"],
  ["gh issue create --label follow-up --body 'a#b'", true,
    "`#` mid-word is not a comment either — the shell's rule is word-start"],

  // Found by the THIRD review's second pass: #365's own defect, reintroduced
  // by the parser that fixed it. A flag-shaped VALUE was read as a flag.
  [`gh issue create --label bug --title "--label=follow-up"`, false,
    "the override is the TITLE again — #365 with one more layer of quoting"],
  ["gh issue create --label bug --title '--label=external-audit'", false, "either override"],
  [`gh issue create --label bug --body "--label=follow-up"`, false, "any value-taking flag"],
  [`gh issue create --label bug --title "-l=follow-up"`, false, "the short form too"],
  ["gh issue create --label bug --title --label=follow-up", false,
    "unquoted is the same command — the shell strips the quotes either way"],
  // ...and the forms that must keep working, because a guard that refuses a
  // real override teaches people to work around it.
  [`gh issue create --label="follow-up"`, true, "a partially quoted value is still a flag"],
  [`gh issue create "--label=follow-up"`, true, "...and so is a fully quoted one"],
  ["gh issue create -lfollow-up", true, "pflag lets a short flag carry its value attached"],
  ["gh issue create --web --label follow-up", true,
    "a BOOLEAN flag eats nothing — assuming it did would refuse a real override"],

  // Documented as out of scope, asserted so the boundary is a measurement
  // rather than a claim. See the module docblock.
  ["GH=gh; $GH issue create --label bug", true,
    "variable indirection — resolving it is the shell interpreter this is not"],
  ["bash <<< 'gh issue create --label bug'", true,
    "a here-string is not a shape anyone types to file an issue"],
];

describe("#365 SC-825: the override is a label argument, not a word in the command", () => {
  for (const [cmd, allowed, why] of TABLE) {
    test(`${allowed ? "allows" : "refuses"}: ${cmd}`, () => {
      const refusal = verifyPhaseRefusal(cmd);
      if (allowed) expect(refusal, why).toBeNull();
      else expect(refusal, why).not.toBeNull();
    });
  }

  test("the table exercises both outcomes", () => {
    // A positive control on the table itself. Every case above is satisfied
    // by a matcher that always allows, or always refuses, unless both
    // outcomes are present — and `test.each`-style loops report zero
    // failures over an empty or one-sided table, not zero tests.
    const allows = TABLE.filter(([, a]) => a).length;
    expect(allows).toBeGreaterThan(2);
    expect(TABLE.length - allows).toBeGreaterThan(2);
  });
});

describe("#365 SC-826: the parts the decision is built from", () => {
  test("a quoted argument is one token, flags inside it are not flags", () => {
    expect(tokenize(`gh issue create --title "a --label follow-up b"`)).toEqual([
      "gh", "issue", "create", "--title", "a --label follow-up b",
    ]);
  });

  test("an unterminated quote does not split into things that look like flags", () => {
    // The direction this is allowed to be wrong in. A malformed command
    // yielding a stray `--label` token would be an override nobody wrote.
    expect(tokenize(`gh issue create --title "oops --label follow-up`)).toEqual([
      "gh", "issue", "create", "--title", "oops --label follow-up",
    ]);
  });

  test("clauses split on shell separators, spaced or not", () => {
    expect(clauses("a && b ; c | d").map(c => c[0])).toEqual(["a", "b", "c", "d"]);
    expect(clauses("a&&b;c|d").map(c => c[0]), "operators glued to words").toEqual([
      "a", "b", "c", "d",
    ]);
    expect(clauses("a\nb").map(c => c[0]), "a newline ends a command").toEqual(["a", "b"]);
  });

  test("an operator is a token even inside a word, but not inside quotes", () => {
    expect(tokenize("1&&gh")).toEqual(["1", "&&", "gh"]);
    expect(tokenize(`--title "a && b"`)).toEqual(["--title", "a && b"]);
  });

  test("a -c argument is parsed as a command; anything else is data", () => {
    // Refusing `echo` too would be the safer direction and the wrong one —
    // a guard that refuses commands creating nothing is a guard people
    // learn to work around. `-c` is the whole condition: an allowlist of
    // shell names was removed because no input could distinguish it.
    expect(clauses(`bash -c "gh issue create"`).some(createsIssue)).toBe(true);
    expect(clauses(`echo "gh issue create"`).some(createsIssue)).toBe(false);
  });

  test("a backslash-newline joins rather than landing a newline in the token", () => {
    // It was producing `\ncreate`, so `createsIssue` never saw three
    // adjacent words. Mid-token too: the shell joins there as well.
    expect(tokenize("gh issue \\\n  create")).toEqual(["gh", "issue", "create"]);
    expect(tokenize("gh is\\\nsue create")).toEqual(["gh", "issue", "create"]);
  });

  test("`#` starts a comment only at the start of a word", () => {
    expect(tokenize("gh issue create # --label follow-up")).toEqual(["gh", "issue", "create"]);
    expect(tokenize("--title a#b"), "mid-word is not a comment").toEqual(["--title", "a#b"]);
    expect(tokenize(`--title "#5"`), "nor is one inside quotes").toEqual(["--title", "#5"]);
    expect(tokenize("a # b\nc"), "a comment ends at the newline, which still separates").toEqual([
      "a", "\n", "c",
    ]);
  });

  test("the out-of-scope boundary is written down where the next reviewer reads it", () => {
    // Two rounds of security review walked this parser inward and a third
    // would too. The answer to "what about `curl`?" is a documented scope,
    // not another branch — a guard that refuses commands creating nothing
    // teaches people to work around it. If this assertion is failing,
    // someone deleted the paragraph, not the boundary.
    const src = readFileSync(join(ROOT, "lib", "issue-create-override.ts"), "utf-8");
    expect(src, "the scope boundary is undocumented").toContain("It is not a sandbox");
    for (const outOfScope of ["curl", "ssh host", "MCP", "Variable indirection"]) {
      expect(src).toContain(outOfScope);
    }
  });

  test("the recursion is bounded", () => {
    // Four levels, then it stops looking. Not a correctness property —
    // a wrapper chain that deep is not an accident — but an unbounded
    // recursion over attacker-shaped input is its own problem.
    const deep = Array.from({ length: 12 }).reduce<string>(
      acc => `bash -c "${acc.replace(/"/g, '\\"')}"`,
      "gh issue create --label bug",
    );
    expect(() => clauses(deep)).not.toThrow();
  });

  test("createsIssue needs the three words adjacent", () => {
    expect(createsIssue(["gh", "issue", "create"])).toBe(true);
    expect(createsIssue(["gh", "issue", "list"])).toBe(false);
    expect(createsIssue(["gh", "create", "issue"])).toBe(false);
    expect(createsIssue(["create"])).toBe(false);
  });

  test("labelValues reads every form and nothing else", () => {
    expect(labelValues(tokenize("x --label a -l b --label=c -l=d --title --label"))).toEqual([
      "a", "b", "c", "d",
    ]);
    expect(labelValues(tokenize("x -le")), "a short flag's attached value").toEqual(["e"]);
  });

  test("a flag's value is data, even when it is shaped like a flag", () => {
    // The whole of #365, reintroduced by the parser that fixed it: scanning
    // for `--label=` anywhere let a TITLE carry the override again.
    expect(
      labelValues(tokenize(`gh issue create --label bug --title "--label=follow-up"`)),
      "the title was read as a label",
    ).toEqual(["bug"]);
    // ...and the direction this is allowed to be wrong in. An unknown flag
    // is assumed to take a value, so a `--label` hidden behind one is missed
    // — which refuses, rather than allows.
    expect(labelValues(tokenize("x --unknown --label follow-up"))).toEqual([]);
    // A boolean flag eats nothing, or every override after one would vanish.
    expect(labelValues(tokenize("x --web --label follow-up"))).toEqual(["follow-up"]);
  });

  test("both overrides are documented where the refusal reads them", () => {
    // The refusal text is generated from the same map the decision uses, so
    // a third override cannot be accepted while the message still names two.
    const refusal = verifyPhaseRefusal("gh issue create --label bug")!;
    for (const name of Object.keys(OVERRIDE_LABELS)) expect(refusal).toContain(`--label ${name}`);
    expect(Object.keys(OVERRIDE_LABELS)).toContain("external-audit");
  });
});

describe("#365 SC-827: the hook reaches the decision", () => {
  /**
   * Spawn the real hook with a real VERIFY workflow state.
   *
   * A decision that is correct in `lib/` and never consulted is the
   * decorative check `.claude/rules/checks-must-be-able-to-fail.md` is
   * about, and the unreachable `gh issue comment` branch this change
   * deleted is what that looks like when it ships.
   */
  function runHook(cmd: string, phase: string): string {
    const work = mkdtempSync(join(tmpdir(), "rungate-vpl-"));
    scratch.push(work);
    mkdirSync(join(work, "run"), { recursive: true });
    writeFileSync(join(work, "run", "workflow-state.json"), JSON.stringify({ phase }));
    const r = spawnSync("bun", [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, RUNGATE_WORK_DIR: work },
    });
    return r.stdout;
  }

  test("the title bypass is blocked by the hook, not just by the library", () => {
    const out = runHook(`gh issue create --label bug --title "Fix the follow-up handler"`, "VERIFY");
    expect(out, "the hook allowed the command #365 is about").toContain('"decision":"block"');
  }, 120_000);

  test("an override label passes the hook", () => {
    expect(runHook("gh issue create --label external-audit --title 'x'", "VERIFY")).toBe("");
  }, 120_000);

  test("outside VERIFY the hook does not block", () => {
    // The control. A hook that blocked everything would satisfy the first
    // case, and this is the phase gate it must still respect.
    const out = runHook(`gh issue create --label bug --title "Fix the follow-up handler"`, "EXECUTION");
    expect(out, "the lock fired outside the phase it locks").toBe("");
  }, 120_000);
});
