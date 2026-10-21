/**
 * top-level-cd.test.ts — #992
 *
 * A top-level `cd` in a Bash tool call moves the SESSION's primary working
 * directory, which kills other concurrent agents' worktree creation hours
 * later with no error pointing back at the cause. The prose rule was broken
 * by four independent actors on 2026-10-21, each with it stated at the top of
 * their instructions — including the author of the rule, and including the
 * agent that wrote this file, three times in its first five Bash calls.
 *
 * `lib/top-level-cd.ts` holds the one decider; `hooks/TopLevelCdGuard.hook.ts`
 * is the thin trigger. The hook is DELIBERATELY NOT REGISTERED — see its
 * header and the PR for #992.
 *
 * The six AC rows below are the issue's own table, verbatim. Everything after
 * them is either an extra witness or a declared gap, and the gaps are asserted
 * as cases rather than written as prose, so a later widening that closes one
 * turns a test red instead of leaving a stale paragraph.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { topLevelCdRefusal } from "../lib/top-level-cd";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "TopLevelCdGuard.hook.ts");

/** Did the one decider refuse? */
const refuses = (cmd: string) => topLevelCdRefusal(cmd) !== null;

describe("#992 AC-1..AC-6: the parse table from the issue", () => {
  test("AC-1: `cd /x && make` is refused, and the refusal names the segment", () => {
    const refusal = topLevelCdRefusal("cd /x && make");
    expect(refusal).not.toBeNull();
    expect(refusal!.segment).toBe("cd /x");
  });

  test("AC-2: `(cd /x && make)` is allowed — a subshell cannot move the session", () => {
    expect(topLevelCdRefusal("(cd /x && make)")).toBeNull();
  });

  test("AC-3: `bash -c 'cd /x'` is allowed — a child process cannot move the session", () => {
    expect(topLevelCdRefusal("bash -c 'cd /x'")).toBeNull();
  });

  test("AC-4: `foo && cd /x` is refused — chained at the top level", () => {
    const refusal = topLevelCdRefusal("foo && cd /x");
    expect(refusal).not.toBeNull();
    expect(refusal!.segment).toBe("cd /x");
  });

  test("AC-5: `echo \"cd /x\"` is allowed — it is a string", () => {
    expect(topLevelCdRefusal('echo "cd /x"')).toBeNull();
  });

  test("AC-6: `git -C /x status` is allowed — it is the recommended form", () => {
    expect(topLevelCdRefusal("git -C /x status")).toBeNull();
  });
});

describe("#992 AC-7: the refusal says what to do instead", () => {
  const refusal = topLevelCdRefusal("cd /x && make");

  test("it names `git -C <path>`", () => {
    expect(refusal!.message).toContain("git -C");
  });

  test("it names the subshell form", () => {
    // The parenthesised form, spelled so a reader can copy it.
    expect(refusal!.message).toContain("(cd ");
    expect(refusal!.message).toContain("&&");
  });

  test("it quotes the offending segment back", () => {
    expect(refusal!.message).toContain("cd /x");
  });
});

describe("#992 AC-8: further forms that ARE refused — err toward refusal", () => {
  const REFUSED: Array<[string, string]> = [
    ["a `;` chain", "make; cd /x"],
    ["a newline chain — a second line is still the top level", "make\ncd /x"],
    ["a bare `cd` with no operand, which goes to $HOME", "cd"],
    ["`pushd`, which moves the shell exactly as `cd` does", "pushd /x"],
    ["`popd`", "popd"],
    ["a `builtin` prefix", "builtin cd /x"],
    ["a `command` prefix", "command cd /x"],
    ["an absolute path to the binary", "/usr/bin/cd /x"],
    ["an inline env assignment before it", "FOO=1 cd /x"],
    ["a `then` branch — it runs in the current shell", "if [ -d /x ]; then cd /x; fi"],
    ["a `do` body", "for d in a b; do cd $d; done"],
    ["a brace group, which is NOT a subshell", "{ cd /x; }"],
    ["a backslash-escaped name", "\\cd /x"],
    ["a quoted command name", "'cd' /x"],
    ["a pipeline element, refused even though bash forks it", "cd /x | cat"],
    ["a backgrounded cd, refused even though bash forks it", "cd /x &"],
    ["a cd after a subshell that was fine", "(cd /a && make) && cd /b"],
  ];

  for (const [why, cmd] of REFUSED) {
    test(`refused: ${why} — ${JSON.stringify(cmd)}`, () => {
      expect(refuses(cmd)).toBe(true);
    });
  }
});

describe("#992 AC-9: further forms that are ALLOWED — the false-refusal edge", () => {
  const ALLOWED: Array<[string, string]> = [
    ["a subshell followed by more work", "(cd /x && make) && echo done"],
    ["a subshell with a leading space", "( cd /x && make )"],
    // Only the paren-depth tracking can reach this one. Without it the `&&`
    // splits and the second segment BEGINS with `cd`, so a splitter that
    // tracks quotes alone refuses a subshell. `(cd …` first is not enough:
    // there the first token is `(cd`, which is not `cd` whatever the depth.
    ["a cd that is not first INSIDE a subshell", "(git fetch --all && cd /x && make)"],
    ["a command substitution — it forks", "echo $(cd /x && pwd)"],
    ["backticks — they fork", "echo `cd /x`"],
    // Only the backtick tracking can reach this one, for the same reason.
    ["a cd that is not first inside backticks", "echo `pwd && cd /x`"],
    // Only the quote tracking can reach this one: the `;` inside the message
    // would otherwise split and leave a segment beginning `cd`.
    ["a separator inside a commit message", 'git commit -m "build fails; cd /x is not the fix"'],
    ["`zsh -c`", "zsh -c 'cd /x && pwd'"],
    ["`sh -c` with double quotes", 'sh -c "cd /x && pwd"'],
    ["the word inside a commit message", 'git commit -m "cd into /x first, then build"'],
    ["the word inside a grep pattern", "grep -rn 'cd /x' ."],
    ["a heredoc BODY, which is data", "cat <<EOF > /tmp/f\ncd /x\nEOF"],
    ["a path component that merely starts with cd", "ls /cdrom"],
    ["a command whose name merely starts with cd", "cdk deploy"],
    ["`git -C` with a chain after it", "git -C /x fetch && git -C /x status"],
    ["`bun --cwd`", "bun --cwd /x test"],
    ["`make -C`", "make -C /x all"],
    ["`npm --prefix`", "npm --prefix /x run build"],
  ];

  for (const [why, cmd] of ALLOWED) {
    test(`allowed: ${why} — ${JSON.stringify(cmd)}`, () => {
      expect(topLevelCdRefusal(cmd)).toBeNull();
    });
  }
});

/**
 * WHAT THIS DOES NOT COVER
 *
 * Each form below moves the session's working directory and is NOT refused.
 * They are asserted as cases, not described in prose, for two reasons: a
 * declared gap that nothing executes is a sentence nobody re-measures, and a
 * later widening that closes one of these must go red here rather than
 * silently changing the hook's behaviour for every session on the machine.
 *
 * Closing them needs a real shell parser plus the shell's own state (what
 * `$CMD` holds, what the user's zsh rc defines), neither of which a PreToolUse
 * hook has. The hook is a habit-former, not a sandbox.
 */
describe("#992 AC-10: WHAT THIS DOES NOT COVER — declared gaps, asserted", () => {
  const GAPS: Array<[string, string]> = [
    ["eval — the command is a string until the shell expands it", 'eval "cd /x"'],
    ["a $VAR-built command — the hook cannot read shell state", "CMD=cd; $CMD /x"],
    ["a heredoc sourced into the CURRENT shell", "source /dev/stdin <<EOF\ncd /x\nEOF"],
    ["a function defined and called in the same call", 'goto() { cd "$1"; }; goto /x'],
    ["a zsh function or alias defined in the user's rc", "cdproj rungate"],
    ["a sourced script that cds", ". ./setup.sh"],
    ["`source` of a script that cds", "source ./setup.sh"],
    ["a trap body — quoted now, run in the current shell later", "trap 'cd /x' EXIT"],
  ];

  for (const [why, cmd] of GAPS) {
    test(`NOT covered: ${why} — ${JSON.stringify(cmd)}`, () => {
      expect(topLevelCdRefusal(cmd)).toBeNull();
    });
  }
});

describe("#992 AC-11: the instrument is not constant", () => {
  test("the decider both refuses and allows — a constant would satisfy half this file", () => {
    expect(refuses("cd /x")).toBe(true);
    expect(refuses("git -C /x status")).toBe(false);
  });
});

/**
 * The live-tree control the issue asks for: "confirm it does not fire on the
 * dozens of legitimate `git -C` calls already in the tree."
 *
 * The population is asserted non-empty first. A scan that found nothing is
 * perfect agreement, and that reads exactly like a clean result.
 */
describe("#992 AC-12: the tree's own `git -C` lines are not refused", () => {
  const scan = spawnSync(
    "/usr/bin/grep",
    [
      "-rhn",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--include=*.ts",
      "--include=*.js",
      "--include=*.md",
      "--include=*.json",
      "git -C ",
      ".",
    ],
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  const lines = (scan.stdout || "")
    .split("\n")
    .map(l => l.replace(/^\d+:/, "").trim())
    .filter(l => l.includes("git -C "));

  test("the scan read something — an empty population is UNMEASURED, not clean", () => {
    expect(lines.length).toBeGreaterThan(20);
  });

  test("no line carrying `git -C ` is refused", () => {
    const refused = lines.filter(refuses);
    expect(
      refused,
      `#992: these lines carry the recommended form and were refused anyway:\n${refused.join("\n")}`,
    ).toEqual([]);
  });
});

describe("#992 AC-13: the hook is a thin trigger over the one decider", () => {
  const source = readFileSync(HOOK, "utf-8");

  test("the hook holds no parse of its own — it calls lib/top-level-cd", () => {
    expect(source).toContain("topLevelCdRefusal");
  });

  test("the hook is under the 150-line limit (SC-371)", () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(150);
  });
});

describe("#992 AC-14: the hook, driven as a real subprocess", () => {
  const run = (payload: unknown, extra: Record<string, string> = {}) => {
    const home = mkdtempSync(join(tmpdir(), "cd992-home-"));
    try {
      return spawnSync("bun", [HOOK], {
        input: JSON.stringify(payload),
        encoding: "utf-8",
        env: { ...process.env, HOME: home, ...extra },
        cwd: ROOT,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test("it blocks a top-level cd and names the alternative, in `block` mode", () => {
    // The mode is now explicit. When this arm was written the hook refused
    // unconditionally; #992's own comments then corrected the cost model that
    // justified that — at 32.7% of 31,577 commands a false refusal costs
    // 10,332 retyped commands, not one — and the endorsed plan became scope,
    // then WARN, then promote on evidence. So the refusal is opt-in and this
    // arm opts in. The ladder itself is `test/cd-guard-mode.test.ts`; the
    // default is checked there (AC-3) rather than restated here.
    const r = run({ tool_name: "Bash", tool_input: { command: "cd /x && make" } }, { RUNGATE_CD_GUARD: "block" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("git -C");
  });

  test("it says nothing about `git -C /x status`", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "git -C /x status" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("it says nothing about a non-Bash tool carrying the same text", () => {
    const r = run({ tool_name: "Write", tool_input: { command: "cd /x && make" } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("it says nothing on empty stdin", () => {
    const r = run("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
