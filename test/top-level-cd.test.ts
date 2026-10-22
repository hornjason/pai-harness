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
 * is the thin trigger. The hook is REGISTERED as a hard refusal at project
 * scope — Jason's decision on #992, taken with the measurement in hand. AC-15
 * asserts the four registration positions agree; AC-17 is the battery.
 *
 * The six AC rows below are the issue's own table, verbatim. Everything after
 * them is either an extra witness or a declared gap, and the gaps are asserted
 * as cases rather than written as prose, so a later widening that closes one
 * turns a test red instead of leaving a stale paragraph.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { CD_GUARD_DECISION, topLevelCdRefusal } from "../lib/top-level-cd";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "TopLevelCdGuard.hook.ts");
const DECIDER = join(ROOT, "lib", "top-level-cd.ts");

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
    ["cd as a substring of another command name", "cdate -u"],
    ["cd as a substring of a relative path", "./cd-tool --path /x"],
    ["cd as a substring deep in a path", "ls /usr/local/cdn"],
    // The comment forms. No comment parsing is needed to reach them — `#` is
    // simply not the segment's first token — and that is why they are here:
    // they are three of the eighteen allow-side rows the cheapest wrong fix
    // turns red. See AC-16 for the one comment form that IS refused.
    ["a trailing comment", "ls # cd /tmp"],
    ["a trailing comment after a chain", "make && ls # cd /tmp"],
    ["a whole-line comment", "# cd /x"],
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
    // Not a Bash call at all — `parseHookInput` returns null and the hook has
    // nothing to decide about. Distinct from the case below, where a Bash
    // call arrives and the command cannot be read.
    const r = run("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("a Bash call with NO command is refused and named UNMEASURED", () => {
    // The `|| ''` this replaced turned an absent command into an empty one,
    // and the guard passed over it. `0`, `{}`, `null` and silence are
    // indistinguishable from success (`.claude/rules/config-access.md`), so
    // an input the guard cannot read is a refusal that says so.
    const r = run({ tool_name: "Bash", tool_input: {} });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.decision).toBe(CD_GUARD_DECISION);
    expect(out.reason).toContain("could not read");
    expect(out.reason).toContain("UNMEASURED");
  });

  test("a Bash call whose command is not a string is refused the same way", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: { oops: 1 } } });
    const out = JSON.parse(r.stdout.trim());
    expect(out.decision).toBe(CD_GUARD_DECISION);
    expect(out.reason).toContain("could not read");
  });
});

/**
 * AC-15 — the four registration positions, asserted here as well as in
 * `test/hook-traceability.test.ts`.
 *
 * NOT a second decider for that file. It answers *do all hooks agree across
 * their positions*, over a population of hook files; this answers *is THIS
 * hook registered as a Bash PreToolUse refusal*, which is the one behavioural
 * claim #992's PR makes. A census that goes green because the population
 * moved cannot witness that claim, and a one-sided edit to any position here
 * reddens a case that names which position.
 */
describe("#992 AC-15: the hook is registered, in all four positions", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf-8"));
  const registry = JSON.parse(
    readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8"),
  ) as Array<Record<string, unknown>>;
  const specTable = readFileSync(join(ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md"), "utf-8")
    .split("\n")
    .filter(l => l.startsWith("| ") && l.includes("TopLevelCdGuard.hook.ts"));

  test("position 1: the hook file carries an SC- id", () => {
    expect(readFileSync(HOOK, "utf-8")).toMatch(/SC-\d+/);
  });

  test("position 2: .claude/rungate/hooks.json declares it enabled, PreToolUse, on Bash", () => {
    const entry = registry.find(e => e.name === "TopLevelCdGuard");
    expect(entry, "no TopLevelCdGuard entry in the registry").toBeDefined();
    expect(entry!.enabled).toBe(true);
    expect(entry!.hookFor).toBe("PreToolUse");
    expect(entry!.matcher).toBe("Bash");
    // Project scope, so `reconcile` in test/hook-registration-reconciler.test.ts
    // treats .claude/settings.json as the thing it must agree with — the
    // enforced half. A "user" scope here would make it UNMEASURED and this
    // PR would be asserting nothing about registration.
    expect(entry!.scope).toBe("project");
    expect(String(entry!.command)).toContain("TopLevelCdGuard.hook.ts");
  });

  test("position 3: the spec's current-state table has a row and no longer says unregistered", () => {
    expect(specTable.length, "no TopLevelCdGuard row in the spec table").toBe(1);
    expect(specTable[0]).toMatch(/SC-\d+/);
    expect(
      specTable[0].toLowerCase(),
      "the row still describes the hook as registered nowhere",
    ).not.toContain("registered nowhere");
  });

  test("position 4: .claude/settings.json runs it as a PreToolUse hook on Bash", () => {
    const groups = settings.hooks?.PreToolUse ?? [];
    const matching = groups.filter((g: { matcher?: string; hooks?: Array<{ command?: string }> }) =>
      (g.hooks ?? []).some(h => String(h.command ?? "").includes("TopLevelCdGuard.hook.ts")),
    );
    expect(matching.length, ".claude/settings.json does not run TopLevelCdGuard").toBe(1);
    expect(matching[0].matcher).toBe("Bash");
  });

  test("the hook no longer declares itself unregistered", () => {
    // `test/hook-traceability.test.ts` AC-5 fails on a registered hook that
    // still carries the marker. Asserted here too because the marker is the
    // thing a reader of THIS file would check, and leaving it is the most
    // likely one-sided edit.
    expect(readFileSync(HOOK, "utf-8")).not.toContain("NOT REGISTERED");
  });
});

/**
 * AC-16 — the comment form that IS refused, recorded rather than hidden.
 *
 * `ls # cd /tmp` is allowed (AC-9) because `ls` is the segment's first token.
 * A comment carrying a separator is not: the splitter has no idea it is in a
 * comment, so the tail reads as a top-level `cd`.
 *
 * This is a FALSE REFUSAL and it is the direction this guard is allowed to be
 * wrong in — one retyped command. Stripping comments would close it and open
 * a false-ALLOW path, because a `#` inside `$(…)` comments out the closing
 * paren and unbalances the depth counter; see `lib/top-level-cd.ts`.
 */
describe("#992 AC-16: a known false refusal, asserted so it cannot drift unnoticed", () => {
  test("a comment carrying a separator is refused", () => {
    expect(refuses("make # fails; cd /x is not the fix")).toBe(true);
  });

  test("the same sentence inside quotes is NOT refused — quotes are tracked, comments are not", () => {
    // The control. Without it the case above could be passing because the
    // splitter is broken generally rather than because comments are unparsed.
    expect(refuses('echo "fails; cd /x is not the fix"')).toBe(false);
  });
});

/**
 * AC-17 — the mutation battery.
 *
 * ## The cheapest wrong fix, named
 *
 * `/\bcd\s/.test(command)` — match the word anywhere in the string. It is one
 * line, it passes the headline case (`cd /x && make` is refused), and it is
 * what anyone reaching for "just block cd" writes. It is also the exact
 * failure #992 warns about: it refuses every subshell, every heredoc, every
 * quoted string and every comment, so the guard gets switched off inside a
 * day and then measures nothing.
 *
 * `M1` below IS that implementation, run over the whole corpus. If a case of
 * this file's did not go red under it, this file could not tell a correct
 * guard from one that will be disabled — which is the fifth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, *a case that goes green
 * under the WRONG fix*.
 *
 * ## How to read the rows
 *
 * **Read the baseline row first.** It runs the REAL decider over the corpus
 * and must be 0. A row of zeros under a missing baseline is an instrument
 * that stopped reporting, not a mutation that was rejected on the merits
 * (`.claude/rules/parallel-sessions.md`).
 *
 * Every row carries a `witness` — a corpus id on which mutant and original
 * give different answers — and the case asserts that id is in the measured
 * difference set. A count alone cannot say WHICH input moved.
 *
 * Counts are predicted in the source before they are measured and asserted as
 * equalities, so adding a corpus case reddens the row it changes rather than
 * silently inflating it.
 */

type Verdict = "refuse" | "allow" | "threw";

interface Row {
  id: string;
  why: string;
  cmd: unknown;
  expect: Exclude<Verdict, "threw">;
}

/**
 * The corpus: every input this file has an opinion about, in one list.
 *
 * `R*` must be refused, `A*` must be allowed, `G*` is a declared gap — it
 * moves the session and is allowed anyway, which is a fact about the parser's
 * reach and is asserted so a later widening is visible.
 */
const CORPUS: Row[] = [
  { id: "R1", why: "the headline case", cmd: "cd /x && make", expect: "refuse" },
  { id: "R2", why: "chained after &&", cmd: "foo && cd /x", expect: "refuse" },
  { id: "R3", why: "a ; chain", cmd: "make; cd /x", expect: "refuse" },
  { id: "R4", why: "a newline chain", cmd: "make\ncd /x", expect: "refuse" },
  { id: "R5", why: "bare cd, which goes to $HOME", cmd: "cd", expect: "refuse" },
  { id: "R6", why: "pushd moves the shell too", cmd: "pushd /x", expect: "refuse" },
  { id: "R7", why: "popd", cmd: "popd", expect: "refuse" },
  { id: "R8", why: "a builtin prefix", cmd: "builtin cd /x", expect: "refuse" },
  { id: "R9", why: "a command prefix", cmd: "command cd /x", expect: "refuse" },
  { id: "R10", why: "an absolute path to the binary", cmd: "/usr/bin/cd /x", expect: "refuse" },
  { id: "R11", why: "an inline assignment first", cmd: "FOO=1 cd /x", expect: "refuse" },
  { id: "R12", why: "a then branch", cmd: "if [ -d /x ]; then cd /x; fi", expect: "refuse" },
  { id: "R13", why: "a do body", cmd: "for d in a b; do cd $d; done", expect: "refuse" },
  { id: "R14", why: "a brace group is not a subshell", cmd: "{ cd /x; }", expect: "refuse" },
  { id: "R15", why: "a backslash-escaped name", cmd: "\\cd /x", expect: "refuse" },
  { id: "R16", why: "a quoted command name", cmd: "'cd' /x", expect: "refuse" },
  { id: "R17", why: "a pipeline element", cmd: "cd /x | cat", expect: "refuse" },
  { id: "R18", why: "backgrounded", cmd: "cd /x &", expect: "refuse" },
  { id: "R19", why: "after a subshell that was fine", cmd: "(cd /a && make) && cd /b", expect: "refuse" },
  { id: "R20", why: "a comment carrying a separator — a known false refusal", cmd: "make # fails; cd /x is not the fix", expect: "refuse" },
  { id: "R21", why: "no command at all", cmd: undefined, expect: "refuse" },
  { id: "R22", why: "a null command", cmd: null, expect: "refuse" },
  { id: "R23", why: "a command that is not a string", cmd: { oops: 1 }, expect: "refuse" },
  { id: "R24", why: "an empty command", cmd: "", expect: "refuse" },
  { id: "R25", why: "a whitespace-only command", cmd: "   ", expect: "refuse" },

  { id: "A1", why: "a subshell", cmd: "(cd /x && make)", expect: "allow" },
  { id: "A2", why: "a child interpreter", cmd: "bash -c 'cd /x'", expect: "allow" },
  { id: "A3", why: "a double-quoted string", cmd: 'echo "cd /x"', expect: "allow" },
  { id: "A4", why: "the recommended form", cmd: "git -C /x status", expect: "allow" },
  { id: "A5", why: "a subshell then more work", cmd: "(cd /x && make) && echo done", expect: "allow" },
  { id: "A6", why: "a subshell with a leading space", cmd: "( cd /x && make )", expect: "allow" },
  { id: "A7", why: "not first INSIDE a subshell", cmd: "(git fetch --all && cd /x && make)", expect: "allow" },
  { id: "A8", why: "a command substitution", cmd: "echo $(cd /x && pwd)", expect: "allow" },
  { id: "A9", why: "backticks", cmd: "echo `cd /x`", expect: "allow" },
  { id: "A10", why: "not first inside backticks", cmd: "echo `pwd && cd /x`", expect: "allow" },
  { id: "A11", why: "a separator inside a commit message", cmd: 'git commit -m "build fails; cd /x is not the fix"', expect: "allow" },
  { id: "A12", why: "zsh -c", cmd: "zsh -c 'cd /x && pwd'", expect: "allow" },
  { id: "A13", why: "sh -c with double quotes", cmd: 'sh -c "cd /x && pwd"', expect: "allow" },
  { id: "A14", why: "the word inside a commit message", cmd: 'git commit -m "cd into /x first, then build"', expect: "allow" },
  { id: "A15", why: "the word inside a grep pattern", cmd: "grep -rn 'cd /x' .", expect: "allow" },
  { id: "A16", why: "a heredoc body, which is data", cmd: "cat <<EOF > /tmp/f\ncd /x\nEOF", expect: "allow" },
  { id: "A17", why: "a path merely starting with cd", cmd: "ls /cdrom", expect: "allow" },
  { id: "A18", why: "a command name merely starting with cd", cmd: "cdk deploy", expect: "allow" },
  { id: "A19", why: "the recommended form, chained", cmd: "git -C /x fetch && git -C /x status", expect: "allow" },
  { id: "A20", why: "bun --cwd", cmd: "bun --cwd /x test", expect: "allow" },
  { id: "A21", why: "make -C", cmd: "make -C /x all", expect: "allow" },
  { id: "A22", why: "npm --prefix", cmd: "npm --prefix /x run build", expect: "allow" },
  { id: "A23", why: "a trailing comment", cmd: "ls # cd /tmp", expect: "allow" },
  { id: "A24", why: "a trailing comment after a chain", cmd: "make && ls # cd /tmp", expect: "allow" },
  { id: "A25", why: "a whole-line comment", cmd: "# cd /x", expect: "allow" },
  { id: "A26", why: "cd as a substring of a command name", cmd: "cdate -u", expect: "allow" },
  { id: "A27", why: "cd as a substring of a relative path", cmd: "./cd-tool --path /x", expect: "allow" },
  { id: "A28", why: "cd as a substring deep in a path", cmd: "ls /usr/local/cdn", expect: "allow" },

  { id: "G1", why: "GAP: eval", cmd: 'eval "cd /x"', expect: "allow" },
  { id: "G2", why: "GAP: a $VAR-built command", cmd: "CMD=cd; $CMD /x", expect: "allow" },
  { id: "G3", why: "GAP: a heredoc sourced into this shell", cmd: "source /dev/stdin <<EOF\ncd /x\nEOF", expect: "allow" },
  { id: "G4", why: "GAP: a function defined and called", cmd: 'goto() { cd "$1"; }; goto /x', expect: "allow" },
  { id: "G5", why: "GAP: a zsh alias from the rc", cmd: "cdproj rungate", expect: "allow" },
  { id: "G6", why: "GAP: a sourced script", cmd: ". ./setup.sh", expect: "allow" },
  { id: "G7", why: "GAP: source of a script", cmd: "source ./setup.sh", expect: "allow" },
  { id: "G8", why: "GAP: a trap body", cmd: "trap 'cd /x' EXIT", expect: "allow" },
];

type Decider = (cmd: unknown) => unknown;

function verdictOf(decide: Decider, cmd: unknown): Verdict {
  try {
    return decide(cmd) === null ? "allow" : "refuse";
  } catch {
    // A mutant that throws has diverged too, and a throw must never read as
    // "allowed". Counting it as its own verdict keeps the two apart.
    return "threw";
  }
}

/** Corpus ids on which this decider disagrees with the specified behaviour. */
function differences(decide: Decider): string[] {
  return CORPUS.filter(r => verdictOf(decide, r.cmd) !== r.expect).map(r => r.id);
}

interface Mutation {
  id: string;
  what: string;
  find: string;
  replace: string;
  /** Predicted before the first run. An equality, so a corpus change reddens it. */
  predicted: number;
  /** A corpus id on which mutant and original must differ. */
  witness: string;
}

const MUTATIONS: Mutation[] = [
  {
    id: "M1",
    what: "THE CHEAPEST WRONG FIX: match /\\bcd\\s/ anywhere in the command",
    find: `  if (typeof command !== 'string' || command.trim() === '') {
    return { segment: '<unreadable>', message: unreadableMessage(command) };
  }

  for (const segment of topLevelSegments(stripHeredocBodies(command))) {
    const name = firstCommandName(segment);
    if (name === null) continue;
    if (!SHELL_MOVERS.has(name)) continue;
    const trimmed = segment.trim();
    return { segment: trimmed, message: refusalMessage(trimmed) };
  }
  return null;`,
    replace: `  const naive = String(command);
  if (!/\\bcd\\s/.test(naive)) return null;
  return { segment: naive, message: refusalMessage(naive) };`,
    // 9 refuse-side (R5 R6 R7 R16 R21..R25) + 18 allow-side + 4 gaps.
    predicted: 31,
    witness: "A1",
  },
  {
    id: "M2",
    what: "stop stripping heredoc bodies",
    find: "topLevelSegments(stripHeredocBodies(command))",
    replace: "topLevelSegments(command)",
    predicted: 2,
    witness: "A16",
  },
  {
    id: "M3",
    what: "stop tracking paren depth when splitting",
    find: "if (depth === 0 && !backtick && (ch === '|'",
    replace: "if (!backtick && (ch === '|'",
    predicted: 1,
    witness: "A7",
  },
  {
    id: "M4",
    what: "stop tracking quotes when splitting",
    find: `    if (ch === "'" || ch === '"') {
      quote = ch;`,
    replace: `    if (ch === "'" || ch === '"') {`,
    predicted: 1,
    witness: "A11",
  },
  {
    id: "M5",
    what: "stop tracking backticks when splitting",
    find: "if (depth === 0 && !backtick && (ch === '|' ",
    replace: "if (depth === 0 && (ch === '|' ",
    predicted: 1,
    witness: "A10",
  },
  {
    id: "M6",
    what: "forget that pushd and popd move the shell",
    find: "new Set(['cd', 'pushd', 'popd'])",
    replace: "new Set(['cd'])",
    predicted: 2,
    witness: "R6",
  },
  {
    id: "M7",
    what: "stop normalising the command name — no quotes, escapes or dirname off",
    find: "return t.split('/').pop() || t;",
    replace: "return token;",
    predicted: 3,
    witness: "R10",
  },
  {
    id: "M8",
    what: "forget the wrapper prefixes",
    find: "new Set(['command', 'builtin', 'exec', 'time', 'nohup'])",
    replace: "new Set<string>([])",
    predicted: 2,
    witness: "R8",
  },
  {
    id: "M9",
    what: "restore the fail-open `|| ''` an absent command used to take",
    find: `  if (typeof command !== 'string' || command.trim() === '') {
    return { segment: '<unreadable>', message: unreadableMessage(command) };
  }`,
    replace: "  if (typeof command !== 'string') command = '';",
    predicted: 5,
    witness: "R21",
  },
  {
    id: "M10",
    what: "never refuse a parsed command — the decider goes constant in the allow direction",
    find: "    return { segment: trimmed, message: refusalMessage(trimmed) };",
    replace: "    return null;",
    // R1..R20. R21..R25 survive: they exit through the unreadable branch, which
    // is a DIFFERENT return — which is the point of measuring rather than
    // assuming "a constant decider reddens everything".
    predicted: 20,
    witness: "R1",
  },
  {
    id: "M11",
    what: "always refuse — the decider goes constant in the refuse direction",
    find: "    if (!SHELL_MOVERS.has(name)) continue;",
    replace: "    if (false) continue;",
    predicted: 36,
    witness: "A4",
  },
];

describe("#992 AC-17: the mutation battery — read the baseline row first", () => {
  const scratch: string[] = [];
  const source = readFileSync(DECIDER, "utf-8");

  /**
   * One fresh temp directory per mutant.
   *
   * Measured, not stylistic: writing every mutant into ONE directory makes
   * the first dynamic import succeed and every later one fail with
   * `Cannot find module`, because the resolver caches that directory's
   * listing at the moment of the first lookup. Eleven rows came back as
   * module-resolution deaths — which is exactly what a mutant rejected on
   * the merits also looks like, so the battery would have been reporting
   * nothing while every row was red.
   */
  function loadMutant(id: string, mutated: string): Promise<{ topLevelCdRefusal: Decider }> {
    const dir = mkdtempSync(join(tmpdir(), `cd992-${id}-`));
    scratch.push(dir);
    const path = join(dir, "mutant.ts");
    writeFileSync(path, mutated);
    return import(path) as Promise<{ topLevelCdRefusal: Decider }>;
  }

  test("the corpus is real and covers both directions", () => {
    // Two empty sets are perfectly equal. A battery over an empty corpus
    // returns 0 for every mutation and reads exactly like a battery that
    // rejected every mutation on the merits.
    expect(CORPUS.length).toBeGreaterThan(50);
    expect(CORPUS.filter(r => r.expect === "refuse").length).toBeGreaterThan(10);
    expect(CORPUS.filter(r => r.expect === "allow").length).toBeGreaterThan(10);
    expect(new Set(CORPUS.map(r => r.id)).size, "duplicate corpus ids").toBe(CORPUS.length);
  });

  test("the decider has no imports, so a mutant copy runs from a temp directory", () => {
    // Without this a later `import … from "../x"` makes every mutant die on
    // module resolution, and a mutant that failed to load looks exactly like
    // a mutation the corpus rejected (`.claude/rules/checks-must-be-able-to-fail.md`).
    const specifiers = [...source.matchAll(/^\s*import\b[^\n]*from\s+['"]([^'"]+)['"]/gm)].map(
      m => m[1],
    );
    expect(specifiers, "lib/top-level-cd.ts gained an import — teach the battery to rewrite it").toEqual([]);
  });

  test("BASELINE: the real decider disagrees with the corpus on nothing", () => {
    // Read this before any row below. Zeros under a red baseline mean the
    // instrument stopped reporting.
    expect(differences(topLevelCdRefusal as Decider)).toEqual([]);
  });

  for (const m of MUTATIONS) {
    test(`${m.id}: ${m.what} — predicted ${m.predicted} red`, async () => {
      const hits = source.split(m.find).length - 1;
      expect(
        hits,
        `could not build the mutant ${m.id}: its signature appears ${hits} times in ` +
          `lib/top-level-cd.ts, not once. A signature that moved makes this row a ` +
          `silent no-op, which is the decorative check the rule is about.`,
      ).toBe(1);

      const mutant = await loadMutant(m.id, source.replace(m.find, m.replace));
      expect(typeof mutant.topLevelCdRefusal, `${m.id} did not export the decider`).toBe("function");

      const diff = differences(mutant.topLevelCdRefusal);
      expect(
        diff,
        `${m.id} must differ from the original on ${m.witness} — a count with no named ` +
          `input does not say which case is load-bearing`,
      ).toContain(m.witness);
      expect(
        diff.length,
        `${m.id} reddened ${diff.length} corpus rows (${diff.join(" ")}), predicted ${m.predicted}. ` +
          `A row LOWER than predicted is the fourth shape — something else is holding ` +
          `those cases up. Re-derive before editing the prediction.`,
      ).toBe(m.predicted);
    });
  }

  test("M1's reds are overwhelmingly FALSE REFUSALS — which is why it gets disabled", () => {
    // The count alone does not make the argument. A wrong fix that refused
    // too little would be a bug; one that refuses every subshell, heredoc,
    // quoted string and comment is a hook somebody turns off, and then the
    // rule is prose again. This asserts the DIRECTION of M1's error.
    const m1 = MUTATIONS.find(m => m.id === "M1")!;
    return loadMutant("M1-direction", source.replace(m1.find, m1.replace)).then(mutant => {
      const falseRefusals = CORPUS.filter(
        r => r.expect === "allow" && verdictOf(mutant.topLevelCdRefusal, r.cmd) === "refuse",
      ).map(r => r.id);
      expect(falseRefusals.length).toBe(22); // 18 allow-side + 4 declared gaps
      expect(falseRefusals).toContain("A1"); // a subshell
      expect(falseRefusals).toContain("A16"); // a heredoc body
      expect(falseRefusals).toContain("A3"); // a quoted string
      expect(falseRefusals).toContain("A23"); // a comment
    });
  });

  test("teardown: every scratch directory is removed", () => {
    expect(scratch.length, "no mutant was ever built").toBeGreaterThan(0);
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * AC-18 — the refusal exit, mutated at the hook.
 *
 * `CD_GUARD_DECISION` is the single site the hook emits, so a case that sees
 * `{"decision":"block"}` can be proved to have seen THAT constant rather than
 * a literal somewhere else in the hook. The mutant copy sets it to a value
 * Claude Code does not act on; the real hook blocks, the mutant does not, on
 * one input.
 */
describe("#992 AC-18: the refusal routes through one constant, and the mutation is observed", () => {
  const hookSource = readFileSync(HOOK, "utf-8");

  test("the hook emits no `decision` literal of its own", () => {
    // A second inlined decision would survive the mutation below and the
    // case would go green having witnessed nothing.
    //
    // The hook DOES carry the word `block` once — `mode === 'block'`, the
    // configured rung. That is a different fact from the protocol field the
    // hook emits, which is why only the emitting position is asserted here
    // rather than banning the string. The subprocess mutation below is the
    // real proof; this is the cheap one that names the position.
    expect(hookSource).toContain("decision: CD_GUARD_DECISION");
    expect(hookSource).not.toContain("decision: 'block'");
    expect(hookSource).not.toContain('decision: "block"');
  });

  test("the constant is declared exactly once in the decider", () => {
    const src = readFileSync(DECIDER, "utf-8");
    expect(src.split("export const CD_GUARD_DECISION = 'block';").length - 1).toBe(1);
    expect(CD_GUARD_DECISION).toBe("block");
  });

  test("real hook blocks, mutant hook does not, on the same input", () => {
    const dir = mkdtempSync(join(tmpdir(), "cd992-exit-"));
    const home = mkdtempSync(join(tmpdir(), "cd992-exithome-"));
    try {
      // The mutant copies BOTH files and rewrites every relative specifier to
      // an absolute path, so a module-resolution death cannot be mistaken for
      // the mutation being rejected.
      const deciderSrc = readFileSync(DECIDER, "utf-8").replace(
        "export const CD_GUARD_DECISION = 'block';",
        "export const CD_GUARD_DECISION = 'mutated-not-a-decision';",
      );
      writeFileSync(join(dir, "top-level-cd.ts"), deciderSrc);

      // Every relative specifier EXCEPT the decider is rewritten to an
      // absolute path against the real tree; the decider points at the
      // mutated copy beside it. A specifier the rewriter does not know about
      // kills the mutant on module resolution, which is indistinguishable
      // from the mutation being rejected on the merits — so the leftover
      // check below aborts rather than letting that read as a result.
      const absolute = (rel: string, abs: string) => [rel, JSON.stringify(abs)] as const;
      const rewrites = [
        absolute("'./lib/parseStdin'", join(ROOT, "hooks", "lib", "parseStdin.ts")),
        absolute("'../lib/harness-project'", join(ROOT, "lib", "harness-project.ts")),
      ];
      let hookMutant = hookSource.replace("'../lib/top-level-cd'", "'./top-level-cd'");
      for (const [from, to] of rewrites) hookMutant = hookMutant.replace(from, to);
      const leftover = [...hookMutant.matchAll(/from\s+['"](\.[^'"]*)['"]/g)].map(m => m[1]);
      expect(
        leftover.filter(s => s !== "./top-level-cd"),
        "the hook gained a relative import the mutant builder cannot rewrite",
      ).toEqual([]);
      writeFileSync(join(dir, "TopLevelCdGuard.hook.ts"), hookMutant);

      const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "cd /x && make" } });
      const call = (path: string) =>
        spawnSync("bun", [path], {
          input: payload,
          encoding: "utf-8",
          env: { ...process.env, HOME: home },
          cwd: ROOT,
        });

      const real = call(HOOK);
      const mutant = call(join(dir, "TopLevelCdGuard.hook.ts"));

      expect(real.status, `the real hook failed to run: ${real.stderr}`).toBe(0);
      expect(mutant.status, `the mutant hook failed to run: ${mutant.stderr}`).toBe(0);
      expect(JSON.parse(real.stdout.trim()).decision).toBe("block");
      expect(JSON.parse(mutant.stdout.trim()).decision).toBe("mutated-not-a-decision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
