/**
 * Covers #1120 — `lib/bash-write-guard.ts`.
 *
 * Two populations, and the second is the point. Witnesses prove the guard
 * refuses a write; CONTROLS prove it does not refuse everything, because a
 * check that refuses everything passes every witness ever written for it.
 *
 * The controls are not invented. F1-F4 are REAL commands from real work that
 * the old guard refused:
 *
 *   F1, F2  the session coordinating #1120, twice, trying to read this very
 *           file with `git show … | grep -nE "chmod|chflags"`
 *   F3      a peer staging a comparison copy of a hook under /tmp
 *   F4      `hornjason/pai-config#474` — the ONLY false positive ever
 *           recorded for this hook, recovered verbatim from the 2026-09-10
 *           transcript
 *
 * F5-F8 come from a sweep of 5,060 real commands extracted from this
 * machine's 35,040 transcripts — every Bash command ever run here that names
 * a protected artifact. F5's shape alone occurs 1,390 times.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  bodyTargets,
  decideBashWrite,
  interpreterPrograms,
  isScratchPath,
  programBody,
  segments,
  stripQuoted,
  stripHeredocs,
  dequote,
  commandWord,
  writeTargets,
} from "../lib/bash-write-guard";

const SALT = "." + "gate-" + "salt";
const STATE = "workflow-" + "state.json";

/**
 * A root that is absolute and is not any platform's scratch tree.
 *
 * Every witness below moved here in #1175. They were written under `/tmp`,
 * and `/tmp` is now the one place a protected NAME is not a protected
 * ARTIFACT — so a witness left there would have been asserting the false
 * positive this issue exists to remove. The move is not cosmetic: it is the
 * behaviour change, and `#1175 WITNESS` below holds both halves of it
 * against each other so the pair cannot drift apart.
 *
 * Deliberately not a path on this machine. A witness that only refuses
 * because of where one developer keeps their runs is a witness about a
 * machine.
 */
const LIVE = "/opt/bwprobe";

describe("#1120 WITNESS: a write to a protected artifact is refused", () => {
  const cases: [string, string][] = [
    ["a bare redirect — the control that proves the guard is wired", `echo x > ${LIVE}/${SALT}`],
    ["an allowlisted prefix in front of that redirect", `gh --version; echo x > ${LIVE}/${SALT}`],
    ["an allowlisted prefix in front of a chmod", `gh --version; chmod 777 lib/Foo.hook.ts`],
    ["an allowlisted prefix in front of the Keychain read", `gh --version; security find-generic-password -s pai-gate-salt -w`],
    ["an interpreter one-liner that opens for write", `python3 -c "open('${LIVE}/${SALT}','w').write('x')"`],
    ["the same interpreter reached by an absolute path", `/usr/bin/python3 -c "open('/x/${SALT}','w').write('x')"`],
    ["find -execdir, a plain synonym for -exec", `find . -name '*.json' -execdir rm /x/${STATE} ;`],
    ["sed -i, the ordinary way to edit a file from a shell", `sed -i '' 's/BUILD/DONE/' /Users/jhorn/.rungate/x/${STATE}`],
    ["cp carrying a flag before the destination", `cp -p /tmp/forged.json /Users/jhorn/.rungate/x/${STATE}`],
    ["a redirect whose target is quoted", `echo x > "${LIVE}/${SALT}"`],
    ["chmod whose path is quoted", `chmod 777 "hooks/Foo.hook.ts"`],
    ["rm of the salt", `rm -f /Users/jhorn/Projects/rungate/gates/${SALT}`],
    ["a quoted cp of a hook into a hooks directory", `cp "/a/hooks/X.hook.ts" "/b/hooks/X.hook.ts"`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1120 CONTROL: real read-only work is not refused", () => {
  const cases: [string, string][] = [
    [
      "F1 — reading this file with git show | grep, which was refused twice in real work",
      `git -C /Users/jhorn/Projects/rungate show origin/main:hooks/BashWriteGuard.hook.ts | /usr/bin/grep -nE "READ_ONLY_PREFIXES|chmod|chflags"`,
    ],
    [
      "F2 — the same shape, second sighting",
      `git show origin/main:hooks/BashWriteGuard.hook.ts | grep -n "chflags"`,
    ],
    [
      "F3 — staging a comparison copy of a hook under /tmp",
      `cp -p /Users/jhorn/Projects/rungate/hooks/GateResultProtection.hook.ts /tmp/cmp/old-guard.ts && echo staged`,
    ],
    [
      "F4 — pai-config#474, a gh comment body quoting chflags and a hook filename",
      `gh issue close 473 --repo hornjason/pai-config --comment "$(cat <<'EOF'\n1. **BashWriteGuard.hook.ts** — blocks Bash writes to ${STATE}, ${SALT}, witnesses/, hook files.\n- Run \`chflags uchg\` on hook files for immutable protection (one-time)\nEOF\n)" 2>&1 | tail -1`,
    ],
    [
      "F5 — inspecting gate state with an interpreter; 1,390 real instances",
      `bun -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("/Users/jhorn/.rungate/x/${STATE}","utf8"));console.log(Object.keys(j))'`,
    ],
    [
      "F6 — the same in python; 365 real instances",
      `/usr/bin/python3 -I -c "import json; s=json.load(open('/Users/jhorn/.rungate/x/${STATE}')); print(s['phase'])"`,
    ],
    [
      "F8 — an issue body quoting the Keychain command it proposes to guard",
      `gh issue comment 475 --repo hornjason/pai-config --body "SC-1: security find-generic-password -s 'pai-gate-salt' is reachable"`,
    ],
    ["an ordinary read", "ls -la"],
    ["grep naming a protected file", `grep -n phase ${STATE}`],
    ["plain find, which has no mutating action", `find . -name '*.hook.ts'`],
    ["a harmless interpreter one-liner", `python3 -c "print(1 + 1)"`],
    ["bun test, which names test files and writes nothing", `bun test test/bash-write-guard.test.ts`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

describe("#1120: the code/data split each check depends on", () => {
  test("stripHeredocs removes the document, keeping the command that writes it", () => {
    const cmd = "cat > notes.md <<'EOF'\nchmod 777 evil.hook.ts\nEOF";
    expect(stripHeredocs(cmd)).toContain("cat > notes.md");
    expect(stripHeredocs(cmd)).not.toContain("evil.hook.ts");
  });

  test("a heredoc body is never torn into segments by a pipe inside it", () => {
    // This was the bug that refused prose: a `|` in an issue body split the
    // document into fragments and each fragment was read as a command.
    const cmd = `cat > body.md <<'EOF'\n| col | ${STATE} |\nEOF\nrm -f scratch.txt`;
    expect(segments(cmd).some(s => s.includes("col"))).toBe(false);
  });

  test("stripQuoted removes a VERB that is only quoted text", () => {
    expect(stripQuoted(`grep -nE "chmod|chflags"`)).not.toContain("chmod");
  });

  test("dequote keeps a TARGET that is quoted", () => {
    expect(dequote(`chmod 777 "hooks/X.hook.ts"`)).toContain("hooks/X.hook.ts");
  });

  test("commandWord ignores wrappers, assignments, options and leading paths", () => {
    expect(commandWord("sudo chmod 777 x")).toBe("chmod");
    expect(commandWord("FOO=1 /usr/bin/python3 -c 'x'")).toBe("python3");
    expect(commandWord(`grep -nE "chmod" f`)).toBe("grep");
  });

  test("cp/mv destination is the LAST non-option argument, not the second token", () => {
    // Reading the second token mis-parsed every invocation with a flag, so
    // `cp -p src /x/workflow-state.json` never examined the real destination.
    expect(writeTargets(`cp -p src.json /x/${STATE}`)).toContain(`/x/${STATE}`);
  });

  test("2>&1 is stderr plumbing, not a write target", () => {
    expect(writeTargets("ls -la 2>&1")).toEqual([]);
  });
});

describe("#1120: the cheapest wrong fixes, run rather than described", () => {
  test("a guard that refuses everything passes every witness, and this separates it", () => {
    const refuseEverything = (_cmd: string) => ({ blocked: true, reason: "no" });
    const witness = `gh --version; echo x > ${LIVE}/${SALT}`;
    const control = "ls -la";
    // Both agree on the witness — which is why a witness alone proves nothing.
    expect(refuseEverything(witness).blocked).toBe(decideBashWrite(witness).blocked);
    // They disagree on the control, and that is the whole value of having one.
    expect(refuseEverything(control).blocked).toBe(true);
    expect(decideBashWrite(control).blocked).toBe(false);
  });

  test("the recorded false positive is what deleting the allowlist cost (#1176 keeps it green)", () => {
    // Measured before this rework: emptying READ_ONLY_PREFIXES turned F4 red
    // while STILL allowing the interpreter bypass. The allowlist is gone now
    // for a different reason — the checks became structural, so it had no
    // remaining job — and F4 stays green, which is the proof that removing it
    // this time is not the same act.
    const f4 = `gh issue close 473 --comment "$(cat <<'EOF'\n- Run \`chflags uchg\` on hooks/X.hook.ts\nEOF\n)"`;
    expect(decideBashWrite(f4).blocked).toBe(false);
  });
});

/**
 * Covers #1176 — six parser-differential bypasses shipped in #1145.
 *
 * One class: a check reads a TRANSFORMED view of the command — heredoc
 * stripped, quote stripped, segment split — and the transformation loses or
 * relocates the exact token the check is looking for. Seven were claimed by a
 * background review; six are real and the seventh is locked in below as a
 * NON-defect, because it was reported twice against a revision that no longer
 * exists and will be reported again.
 */
describe("#1176 WITNESS: a write the transformed view used to hide", () => {
  const cases: [string, string][] = [
    // G1. `[\s\S]*?` starts right after the delimiter word, so it ate the rest
    //     of the operator's line — and a redirect lives there.
    ["G1 a heredoc whose operator line also carries the redirect", `cat <<EOF > ${LIVE}/${SALT}\nhello\nEOF`],
    // G2. stripQuoted deletes quoted spans AND contents; the recovery pass
    //     only matched a target that was WHOLLY quoted, so a mid-word quote
    //     fell between the two.
    ["G2 a redirect target quoted in the middle of the word", `echo x > dir/"${STATE}"`],
    // G3. `.match` without /g, one capture group, but `tee` takes many files.
    ["G3 tee writing a protected file as its second operand", `echo x | tee /tmp/a ${LIVE}/${STATE}`],
    // G4. The real invocation quotes the key, and stripQuoted deleted it, so
    //     the arm could not fire on the one shape it exists for.
    ["G4 the Keychain key name in quotes", `security find-generic-password -s 'pai-gate-salt' -w`],
    // G6. The lookbehind excluded `2`, but `2> file` truncates like `> file`.
    ["G6 a stderr redirect, which truncates exactly like stdout", `echo x 2> ${LIVE}/${SALT}`],
    // G7. For a SHELL the `-c` body is shell, but it was matched against
    //     WRITE_INTENT, which enumerates Node and Python idioms only. Arm 1
    //     could not see it either, because stripQuoted deleted the body.
    ["G7 a shell -c body containing a plain redirect", `bash -c 'echo x > ${LIVE}/${SALT}'`],
    ["G7 the same through sh", `sh -c "rm -f ${LIVE}/${STATE}"`],
    // G8. Both of these are REAL commands from the corpus, and both are
    //     genuine writes that the #1176 rework briefly started allowing: an
    //     apostrophe inside a `#` comment opened a quote that stayed open
    //     across the newline and swallowed the redirect on a later line.
    //     Found by the sweep, not by reading. A shell comment is not a quote.
    [
      "G8 an apostrophe in a comment must not hide a later redirect",
      `# First, check if there's a test ${STATE} I can target\nmkdir -p ${LIVE}/rt\necho '{"phase":"BUILD"}' > ${LIVE}/rt/${STATE}`,
    ],
    [
      "G8 the same, hiding a write to a hook file",
      `# they're on main\ngit show HEAD~1:hooks/AutoVerifyGate.hook.ts > ${LIVE}/hooks/AutoVerifyGate.hook.ts`,
    ],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1176 CONTROL: the fixes must not widen the guard", () => {
  const cases: [string, string][] = [
    ["a heredoc writing an ordinary file still passes", `cat <<EOF > /tmp/bw/notes.md\nhello\nEOF`],
    ["tee to ordinary files", `echo x | tee /tmp/a /tmp/b`],
    ["a shell -c body that writes nothing protected", `bash -c 'echo hello > /tmp/bw/ordinary.txt'`],
    ["a shell -c body that only reads", `bash -c 'cat /tmp/bw/${STATE}'`],
    ["the Keychain name merely quoted in prose, command word is gh", `gh issue comment 475 --body "run security find-generic-password -s 'pai-gate-salt'"`],
    ["stderr discarded, the overwhelmingly common form", `grep -n phase ${STATE} 2>/dev/null`],
    ["stderr duplication, which names no path at all", `bun test 2>&1 | tail -5`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

/**
 * Covers #1184 — five more bypasses, one of them introduced by #1176's own
 * heredoc rewrite. H1 and H5 are asserted on `stripHeredocs` DIRECTLY as well
 * as through a decision, because an over-strip and a clean parse produce the
 * same decision and only the first is a bug.
 *
 * #1175 moved every destination in this block from `/tmp/bw` to `LIVE`. None
 * of these cases is about which tree the write lands in — they are about
 * terminators, quoted verbs and letter case — and `/tmp` is now the one tree
 * where a protected name is a fixture, so a witness left there would have
 * been asserting the false positive #1175 removed rather than the bypass it
 * was written for. The CONTROLS below keep their `/tmp` paths: they assert an
 * ALLOW, which is the direction the move cannot fake.
 */
describe("#1184 WITNESS: views, terminators and spellings", () => {
  const cases: [string, string][] = [
    // H1. #1176 replaced a terminator-anchored regex with a line scanner, and
    //     the scanner runs off the end when the terminator never arrives. The
    //     regex failed CLOSED here; the scanner failed open. A regression.
    ["H1 an unterminated heredoc must not delete the lines after it", `cat <<EOF\necho x > ${LIVE}/${SALT}`],
    ["H1b the same, hiding a hook write", `cat <<MARKER\ncp /tmp/evil.ts ${LIVE}/hooks/X.hook.ts`],
    // H5. `<<<` is a herestring. Matching it as a heredoc invents a delimiter
    //     that never terminates, which lands straight in H1.
    ["H5 a herestring is not a heredoc", `grep x <<< "t"\necho y > ${LIVE}/${SALT}`],
    // H3. The mirror of #1176's F2: there the TARGET was read off the
    //     quote-stripped view, here the VERB is.
    ["H3 a quoted command word still runs", `"chmod" 777 ${LIVE}/hooks/X.hook.ts`],
    ["H3b a partly quoted command word", `ch"mod" 777 ${LIVE}/hooks/X.hook.ts`],
    ["H3c a quoted interpreter", `"bash" -c 'echo x > ${LIVE}/${SALT}'`],
    // H4. A directory destination's real sink is join(dest, basename(src)).
    ["H4 cp into a directory, protected source basename", `cp /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`],
    ["H4b mv into a directory", `mv /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`],
    ["H4c cp a hook into a hooks directory", `cp /tmp/evil/X.hook.ts /Users/jhorn/Projects/rungate/hooks/`],
    // H6. Measured: this filesystem is case-insensitive, so these name the
    //     same files as their lowercase spellings.
    ["H6 an uppercase gate artifact", `echo x > ${LIVE}/${STATE.toUpperCase()}`],
    ["H6b an uppercase salt", `echo x > ${LIVE}/${SALT.toUpperCase()}`],
    ["H6c a mixed-case hook", `cp /tmp/evil.ts ${LIVE}/hooks/X.HOOK.TS`],
    // H7. Constructed, not from the corpus — the key reaching `security`
    //     through a variable set in an earlier segment. Measured cost of
    //     matching the key across the whole command: 0 of 125,644.
    ["H7 the keychain key arriving via a variable", `KEY=pai-gate-salt; security find-generic-password -s "$KEY" -w`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

/**
 * Covers #1196 — two regressions #1188 shipped, plus H6.
 *
 * R1 and R2 are mine. Every case is labelled witness or control, because the
 * first fixture written for R2 used an unprotected source basename and
 * measured nothing while looking like a clean result.
 */
describe("#1196 WITNESS: the verb, the filesystem, and the quoted operator", () => {
  const HOOK = LIVE + "/hooks/X.hook" + ".ts";
  const cases: [string, string][] = [
    // R1. #1188 made commandWord read `dequote(...)` then split on
    //     whitespace. That is not tokenisation: a quoted multi-word
    //     assignment VALUE survives the split as separate tokens and only
    //     the first carries the `=` that the skip looks for, so the verb
    //     resolves to a word out of the assignment.
    ["R1 an assignment prefix must not hide cp", `A="1 grep" cp /tmp/forged/${STATE} /x/${STATE}`],
    ["R1b the same for mv", `A="1 grep" mv /tmp/forged/${STATE} /x/${STATE}`],
    ["R1c the same for a hook mode change", `A="1 grep" chmod 777 ${HOOK}`],
    // R2. The destination's existence must not decide. A PreToolUse hook
    //     runs before the whole command, so in `mkdir -p d && cp <p> d` the
    //     directory never exists at decision time.
    ["R2 a directory destination that does not exist yet", `mkdir -p ${LIVE}/bwnope && cp /tmp/forged/${STATE} ${LIVE}/bwnope`],
    // H6. `<<WORD` inside a quoted span is not a heredoc operator. H5 was
    //     the same mistake at the wrong CHARACTER position; this is the
    //     wrong QUOTING position, and both fall into the same body-drop.
    ["H6 a quoted heredoc operator must not eat the next lines", `bun -e 'x = "<<EOF"'\nrm -rf /x/${STATE}\nEOF`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1196 CONTROL: what must keep working", () => {
  const cases: [string, string][] = [
    // A heredoc nested in a command substitution inside double quotes is a
    // REAL heredoc. This is the recorded pai-config#474 false positive and
    // the reason H6 cannot be fixed by a plain "not inside quotes" test.
    [
      "pai-config#474 — a real heredoc inside \"$(…)\"",
      `gh issue close 473 --comment "$(cat <<'EOF'\n- Run \`chflags uchg\` on hooks/X.hook.ts\nEOF\n)"`,
    ],
    ["an ordinary assignment prefix on a harmless command", `FOO=1 ls -la`],
    ["a quoted multi-word assignment on a harmless command", `A="1 grep" ls -la`],
    ["an ordinary read", "ls -la"],
    // R2's cost, measured. The reviewer's simpler repair — push
    // `dest/basename(src)` unconditionally — refuses all four of these, and
    // on the corpus it refuses 19 real commands of exactly this shape while
    // catching no real write the directory oracles miss. The first two are
    // the backup `.claude/rules/checks-must-be-able-to-fail.md` tells an
    // agent to take before mutating a guard.
    ["backing up a hook before a mutation battery", `cp hooks/X.hook.ts /tmp/g239.bak`],
    ["the same with a quoted path", `cp "$W/hooks/X.hook.ts" "$B/hook.ts"`],
    ["staging gate state for a probe", `cp /Users/jhorn/.rungate/x/${STATE} /tmp/ws-254-probe.json`],
    ["copying a hook out with -p", `cp -p /Users/jhorn/Projects/rungate/hooks/X.hook.ts /tmp/cmp/old.ts`],
    // R1's own cost, found by the corpus sweep and not by review. Making the
    // tokeniser quote-aware makes a `--body "…"` ONE word, and the first
    // spelling returned that whole document as the command word — so a
    // continuation line of a `gh issue create` whose body described
    // `chflags uchg` on hook files matched IN_PLACE and was refused. Same
    // family as pai-config#474 above, reached through the verb rather than
    // through the heredoc.
    [
      "gh issue create whose BODY describes chflags on hooks",
      `gh issue create --repo hornjason/pai-config --label "p1-ship-next" \\\n  --title "Production lockdown — Keychain salt migration + hook immutable flags" \\\n  --body "## Goal\nHarden the enforcement stack.\n\n## Steps (human execution)\n4. find ~/.pai/hooks -name '*.hook.ts' -exec chflags uchg {} +\n5. chflags uchg ~/.claude/settings.json" 2>&1`,
    ],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

/**
 * Covers #1196 R3 — an IO number read as an argument.
 *
 * Not relayed with the other three. The corpus sweep run for R2's cost found
 * it: four commands in the newly-blocked list were genuine writes INTO a
 * protected path, which #1188 should already have refused. `2>/dev/null` is
 * the whole bypass, and the head build was catching them only as a side
 * effect of the unconditional-directory rule — a case going green under a
 * fix aimed at something else, which is the fifth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
describe("#1196 R3 WITNESS: a trailing redirect must not demote the destination", () => {
  const cases: [string, string][] = [
    ["cp with 2>/dev/null", `cp /tmp/x.json /r/${STATE} 2>/dev/null`],
    ["cp with 2>&1", `cp /tmp/x.json /r/${STATE} 2>&1`],
    ["cp with >/dev/null 2>&1", `cp /tmp/x.json /r/${STATE} >/dev/null 2>&1`],
    ["mv with 2>/dev/null", `mv /tmp/x.json /r/${STATE} 2>/dev/null`],
    ["a hook, from the corpus", `cp /tmp/x.ts /Users/jhorn/.claude/hooks/Y.hook.ts 2>/dev/null`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("the IO number is dropped, and a real numeric argument is not", () => {
    // `2` is a descriptor here, so the destination is the last word.
    expect(writeTargets(`cp /tmp/x.json /r/${STATE} 2>/dev/null`)).toContain(`/r/${STATE}`);
    // …but a bare `2` that is not followed by a redirect is an argument.
    expect(writeTargets(`cp 2 /r/${STATE}`)).toContain(`/r/${STATE}`);
  });
});

/**
 * Covers #1196 R4 — an assignment prefix whose VALUE is a path.
 *
 * The same defect #1196 names, reached through a different assignment shape.
 * `commandWord` ran `^.*\/` before testing for `=`, so the strip took the
 * `=` away with the directory part and `FOO=/x/grep` was returned spelled
 * `grep` — a fake verb standing in front of the real one. ALLOW on
 * origin/main and ALLOW behind the first spelling of the R1 fix; the same
 * commands with no prefix BLOCK.
 */
describe("#1196 R4 WITNESS: a path-valued assignment must not become the verb", () => {
  const cases: [string, string][] = [
    ["masking a mode change on a hook", `FOO=/x/grep chmod 777 ${LIVE}/h/X.hook.ts`],
    ["masking chflags on a hook", `FOO=/x/grep chflags uchg ${LIVE}/h/X.hook.ts`],
    ["masking cp into a protected path", `FOO=/x/grep cp /tmp/a /r/${STATE}`],
    ["masking an interpreter body", `FOO=/x/grep bun -e 'writeFileSync("/r/${STATE}","")'`],
    ["an array-subscript assignment", `A[0]=/x/grep chmod 777 ${LIVE}/h/X.hook.ts`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("a real path is not mistaken for an assignment", () => {
    // The POSIX shape, not `includes('=')`: this one does not start with an
    // identifier, so it stays a verb.
    expect(commandWord(`/opt/a=b/bin/chmod 777 x`)).toBe("chmod");
    expect(commandWord(`FOO=/x/grep chmod 777 x`)).toBe("chmod");
    // An assignment with no verb after it resolves to nothing, and nothing
    // is what the arms must then find.
    expect(commandWord(`FOO=/x/${STATE}`)).toBe("");
    expect(decideBashWrite(`FOO=/x/${STATE}`).blocked).toBe(false);
  });
});

describe("#1196: the mechanisms, asserted directly", () => {
  test("a quoted multi-word assignment value stays inside its token", () => {
    expect(commandWord(`A="1 grep" cp /tmp/forged/${STATE} /x/${STATE}`)).toBe("cp");
    // …and the #1184 behaviour it must not undo.
    expect(commandWord(`"chmod" 777 x.hook.ts`)).toBe("chmod");
    expect(commandWord(`grep -nE "chmod" f`)).toBe("grep");
  });

  test("a directory destination is settled syntactically before the disk", () => {
    // #1175: a LIVE root, not `/tmp`. The oracles under test are about the
    // DESTINATION being a directory; under `/tmp` the resulting target is a
    // fixture and the row would assert the tree question instead of the one
    // it is named for.
    const d = LIVE + "/bw-no-such-dir-" + process.pid;
    // Oracle 1: a trailing slash. Oracle 2: more than two operands. Oracle 3:
    // a `mkdir` earlier in the same command. None of the three touches the
    // filesystem, and `d` does not exist.
    expect(decideBashWrite(`cp /tmp/forged/${STATE} ${d}/`).blocked).toBe(true);
    expect(decideBashWrite(`cp /tmp/forged/${STATE} /tmp/a.json ${d}`).blocked).toBe(true);
    expect(decideBashWrite(`mkdir -p ${d} && cp /tmp/forged/${STATE} ${d}`).blocked).toBe(true);
    // And with no oracle satisfied it is a plain destination: a read.
    expect(decideBashWrite(`cp /tmp/forged/${STATE} ${d}`).blocked).toBe(false);
  });

  test("a quoted `<<WORD` is not a heredoc operator, but one inside $( ) is", () => {
    // Quoted text: the lines after it must survive.
    expect(stripHeredocs(`bun -e 'x = "<<EOF"'\nrm -rf /x/f\nEOF`)).toContain("rm -rf /x/f");
    // Command substitution resets quoting, so this one IS a heredoc and its
    // body is the document being written.
    expect(stripHeredocs(`gh x --body "$(cat <<'EOF'\nchflags uchg hooks/X.hook.ts\nEOF\n)"`)).not.toContain(
      "chflags uchg",
    );
  });
});

describe("#1184 CONTROL: the fixes must not widen the guard", () => {
  const cases: [string, string][] = [
    ["a terminated heredoc still drops its body", `cat <<EOF > /tmp/bw/notes.md\nchmod 777 evil.hook.ts\nEOF`],
    ["a herestring feeding an ordinary read", `grep -n phase <<< "some text"`],
    ["an unterminated heredoc writing nothing protected", `cat <<EOF\necho hello > /tmp/bw/ordinary.txt`],
    ["copying a protected file OUT to a plain name is a read", `cp /x/${STATE} /tmp/backup.json`],
    ["cp into a directory with an unprotected source", `cp /tmp/notes.md /Users/jhorn/.rungate/x/`],
    ["a quoted grep PATTERN is still not a verb", `git show HEAD:f | grep -nE "chmod|chflags"`],
    ["an ordinary read", "ls -la"],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

describe("#1184: the mechanisms, asserted directly", () => {
  test("an unterminated heredoc leaves the text after it UNCHANGED", () => {
    // The decision-level case cannot tell an over-strip from a clean parse.
    // This can: the bytes must survive.
    const cmd = `cat <<EOF\necho x > /tmp/bw/${SALT}`;
    expect(stripHeredocs(cmd)).toContain(`echo x > /tmp/bw/${SALT}`);
  });

  test("a herestring is not treated as a heredoc", () => {
    expect(stripHeredocs(`grep x <<< "t"\necho y > /tmp/f`)).toContain("echo y > /tmp/f");
  });

  test("commandWord resolves a quoted verb", () => {
    expect(commandWord(`"chmod" 777 x.hook.ts`)).toBe("chmod");
    expect(commandWord(`ch"mod" 777 x.hook.ts`)).toBe("chmod");
    // …and still does not promote a quoted grep PATTERN to a verb.
    expect(commandWord(`grep -nE "chmod" f`)).toBe("grep");
  });

  test("a directory destination resolves to dest/basename for every source", () => {
    expect(writeTargets(`cp /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`).join(" ")).toContain(STATE);
  });

  test("protected names match whatever case the filesystem would fold", () => {
    expect(decideBashWrite(`echo x > ${LIVE}/${STATE.toUpperCase()}`).blocked).toBe(true);
  });
});

describe("#1176: the mechanisms, asserted directly", () => {
  test("stripHeredocs keeps the operator's own line and drops only the body", () => {
    const out = stripHeredocs("cat <<EOF > out.txt\nbody line\nEOF");
    expect(out).toContain("> out.txt");
    expect(out).not.toContain("body line");
  });

  test("writeTargets collects every tee operand, not just the first", () => {
    expect(writeTargets(`tee /tmp/a /tmp/bw/${STATE}`)).toContain(`/tmp/bw/${STATE}`);
  });

  test("a mid-word quoted redirect target survives as a target", () => {
    expect(writeTargets(`echo x > dir/"${STATE}"`).join(" ")).toContain(STATE);
  });

  test("2> is a write sink; 2>&1 and 2>/dev/null are not", () => {
    expect(writeTargets(`echo x 2> /tmp/bw/${SALT}`)).toContain(`/tmp/bw/${SALT}`);
    // The duplication form names a descriptor, not a path. This is the
    // negative control for dropping `2` from the lookbehind — without it the
    // fix would turn every `2>&1` in the corpus into a write.
    expect(writeTargets("ls -la 2>&1")).toEqual([]);
    expect(writeTargets("ls -la 2>/dev/null")).toEqual([]);
  });

  test("G5 is NOT a defect: over-splitting closes &> rather than opening it", () => {
    // Reported twice, and real in the round-1 revision where the whole command
    // hit the `(?<![2&])` lookbehind at once. Segmentation dissolved it: the
    // `&` becomes a separator, so the `>` opening the next segment is no
    // longer preceded by it. Locked in so the next review can be answered with
    // a run instead of an argument.
    expect(segments(`echo x &> ${LIVE}/${SALT}`)).toEqual(["echo x", `> ${LIVE}/${SALT}`]);
    expect(decideBashWrite(`echo x &> ${LIVE}/${SALT}`).blocked).toBe(true);
  });
});

/**
 * Covers #1175 — `PROTECTED_FILES` matched a NAME in any tree.
 *
 * Swept over 5,531 real commands from this machine's 35,261 transcripts, the
 * guard as merged refuses 502. Thirty-seven of those are agents building test
 * fixtures under `/tmp` — several of them fixtures for this very module — and
 * every one is a true positive against the rule and a false positive against
 * intent.
 *
 * The scoping is to the SCRATCH tree and not, as the issue's acceptance asked,
 * to the project root. That is a measurement. Of the 3,240 absolute artifact
 * references in the corpus, 16 are inside a repository tree and 3,141 are not
 * — a live `workflow-state.json` lives in the run store, which is nobody's
 * project root. `the cheapest wrong fixes` below runs the root-relative
 * reading rather than arguing with it.
 */
describe("#1175 WITNESS: the same write is a fixture here and an artifact there", () => {
  const SCRATCH = tmpdir();
  const pairs: [string, (root: string) => string][] = [
    ["a redirect", root => `echo '{}' > ${root}/p/${STATE}`],
    ["a heredoc", root => `cat > ${root}/p/${STATE} <<'EOF'\n{"phase":"BUILD"}\nEOF`],
    ["an interpreter opening for write", root => `python3 -I -c "import json; json.dump({}, open('${root}/p/${STATE}','w'))"`],
    ["a node interpreter", root => `bun -e 'require("fs").writeFileSync("${root}/p/${STATE}","{}")'`],
    ["cp over it", root => `cp -p src.json ${root}/p/${STATE}`],
    ["sed -i on it", root => `sed -i '' 's/BUILD/DONE/' ${root}/p/${STATE}`],
    ["rm of it", root => `rm -f ${root}/p/${STATE}`],
    ["a shell -c body", root => `bash -c 'echo x > ${root}/p/${SALT}'`],
    ["tee", root => `echo x | tee ${root}/p/${STATE}`],
    ["chmod on a hook", root => `chmod 777 ${root}/p/Foo.hook.ts`],
  ];

  test.each(pairs)("%s under a scratch root is a fixture", (_label, build) => {
    const d = decideBashWrite(build(SCRATCH));
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });

  test.each(pairs)("%s under a live root is still refused", (_label, build) => {
    expect(decideBashWrite(build(LIVE)).blocked).toBe(true);
  });

  test("the literal /tmp spelling is scratch as well as the resolved one", () => {
    expect(decideBashWrite(`echo '{}' > /tmp/p/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`echo '{}' > /private/tmp/p/${STATE}`).blocked).toBe(false);
  });
});

describe("#1175 CONTROL: an exemption that cannot be shown refuses", () => {
  // The fail-closed half. A path this module cannot place in a tree is not a
  // fixture by default — it keeps the behaviour it had before #1175. The
  // acceptance asked for an unresolvable ROOT to refuse; there is no root
  // here, and the equivalent is an unresolvable DESTINATION.
  const cases: [string, string][] = [
    ["a bare basename, which is the overwhelmingly common interpreter shape", `bun -e 'require("fs").writeFileSync("${STATE}","{}")'`],
    ["a path assembled by join from a variable", `bun -e 'const p=join(dir,"${STATE}");require("fs").writeFileSync(p,"{}")'`],
    ["a path assembled by concatenation", `bun -e 'require("fs").writeFileSync(dir+"/${STATE}","{}")'`],
    ["a shell variable the command does not define", `echo x > $W/${STATE}`],
    ["a relative path", `echo x > ./run/${STATE}`],
    ["a scratch-looking path that climbs back out", `echo x > /tmp/../opt/run/${STATE}`],
    ["one scratch mention does not exempt a live one in the same command", `cp /tmp/p/${STATE} ${LIVE}/p/${STATE}`],
    ["the run store, which is where the artifact actually lives", `echo x > $HOME/.rungate/slug/${STATE}`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("a symlink out of the scratch tree is not an exemption", () => {
    // Two commands is the whole attack: link a scratch name at the run store,
    // then write through it. `resolve()` cannot see this — it normalises
    // `..` and stops — so the deepest existing ancestor is realpath'd.
    const dir = mkdtempSync(join(tmpdir(), "bw-link-"));
    const link = join(dir, "esc");
    try {
      // Positive control: a plain name in that same scratch directory IS
      // exempt, so a red below is about the link and not about the tree.
      expect(isScratchPath(join(dir, STATE))).toBe(true);
      // `/usr` stands in for the run store: it exists, so realpath resolves,
      // and it is outside every temp root.
      symlinkSync("/usr", link);
      expect(isScratchPath(join(link, STATE))).toBe(false);
      expect(decideBashWrite(`echo x > ${join(link, STATE)}`).blocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1175: the cheapest wrong fixes, run rather than described", () => {
  // A real corpus command: it rewrites every FAIL and PENDING verdict in a
  // live run's state to SKIPPED. This is the thing the guard exists for.
  const FORGE =
    `cat /Users/jhorn/.rungate/ddb-562/${STATE} | python3 -c "\n` +
    `import sys, json\nd = json.load(sys.stdin)\nd['phase'] = 'SKIPPED'\n` +
    `json.dump(d, open('/Users/jhorn/.rungate/ddb-562/${STATE}','w'), indent=2)"`;

  test("the real guard refuses it", () => {
    expect(decideBashWrite(FORGE).blocked).toBe(true);
  });

  test("scoping to the PROJECT ROOT, as the issue asked, allows it", () => {
    // #1175 AC-1 taken literally: protected == inside the project root.
    const root = resolve(process.cwd());
    const insideRoot = (p: string) => p === root || p.startsWith(root + "/");
    const target = `/Users/jhorn/.rungate/ddb-562/${STATE}`;
    expect(FORGE).toContain(target);
    expect(insideRoot(target)).toBe(false); // so the root-relative rule exempts it
    // Swept: this reading newly allows 169 of the 502 the guard refuses, 133
    // of them naming an artifact at a real absolute path.
  });

  test("exempting any command that MENTIONS a scratch directory allows a live write", () => {
    // The cheapest fix of all, and the shape `pai-config#474` was fixed for:
    // a whole-command predicate consulted before anything looks at the
    // destination. Swept: 192 newly allowed, 25 of them naming an artifact at
    // a real absolute path.
    const mentionsScratch = (cmd: string) => /\/tmp\/|\/var\/folders\/|mkdtemp|mktemp/.test(cmd);
    const real = `T=$(mktemp -d /tmp/why-XXXXXX); cp "$T/${STATE}" /Users/jhorn/.rungate/x/${STATE}`;
    expect(mentionsScratch(real)).toBe(true); // so the cheap fix allows it
    expect(decideBashWrite(real).blocked).toBe(true); // and this module does not
  });
});

describe("#1175: isScratchPath, asserted directly", () => {
  test("only an absolute path can be placed in a tree", () => {
    expect(isScratchPath(STATE)).toBe(false);
    expect(isScratchPath(`./${STATE}`)).toBe(false);
    expect(isScratchPath("")).toBe(false);
  });

  test("a sibling of a scratch root is not inside it", () => {
    expect(isScratchPath(`/tmpfoo/${STATE}`)).toBe(false);
    expect(isScratchPath(`/var/foldersx/${STATE}`)).toBe(false);
  });

  test("the platform temp directory is a scratch root whatever it is called", () => {
    expect(isScratchPath(join(tmpdir(), "p", STATE))).toBe(true);
  });

  test("TMPDIR is read at call time, but it can only SELECT a fixed root", () => {
    // This test used to assert that TMPDIR could NAME a new root, which is
    // the defect the review of #1197 found: the writer sets the variable that
    // decides whether their own write is exempt. Reading at call time is
    // still the behaviour — a harness that moves TMPDIR inside /tmp is
    // honoured — but naming a tree outside the fixed set now buys nothing.
    const before = process.env.TMPDIR;
    const inside = mkdtempSync(join("/tmp", "bw-tmpdir-"));
    try {
      process.env.TMPDIR = "/opt/relocated";
      expect(isScratchPath(`/opt/relocated/${STATE}`)).toBe(false);
      process.env.TMPDIR = inside;
      expect(isScratchPath(join(inside, STATE))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      rmSync(inside, { recursive: true, force: true });
    }
  });
});

/**
 * Covers the review of #1197. Six findings were raised; two were real, one
 * would have re-broken #1175, and a seventh defect was found by trying to
 * build the witness for one of the unmeasured ones.
 */
describe("#1175 review: TMPDIR is the writer's variable", () => {
  // The serious one. `scratchRoots()` took `process.env.TMPDIR` as given, so
  // the agent whose write is being judged set the variable that decided
  // whether the write was exempt.
  const RUN = `${process.env.HOME}/.rungate/victim/${STATE}`;

  test("pointing TMPDIR at the run store does not exempt the run store", () => {
    const before = process.env.TMPDIR;
    try {
      expect(isScratchPath(RUN)).toBe(false); // control: refused to begin with
      process.env.TMPDIR = `${process.env.HOME}/.rungate`;
      expect(isScratchPath(RUN)).toBe(false);
      expect(decideBashWrite(`echo x > ${RUN}`).blocked).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  test.each([
    ["the project tree", () => resolve(process.cwd())],
    ["the home directory", () => process.env.HOME ?? "/"],
    ["the run store's parent", () => `${process.env.HOME}/.rungate/..`],
    ["the root of the disk", () => "/"],
  ])("TMPDIR pointed at %s extends nothing", (_label, build) => {
    const before = process.env.TMPDIR;
    try {
      process.env.TMPDIR = build();
      // The invariant: no exemption root may contain a protected tree. Asserted
      // through the only observable that matters — whether a real artifact is
      // exempted — rather than by reading the list back.
      expect(isScratchPath(RUN)).toBe(false);
      expect(isScratchPath(`${LIVE}/${STATE}`)).toBe(false);
      // and the fixed roots still work, so this is not a guard that died.
      expect(isScratchPath(`/tmp/p/${STATE}`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  test("a TMPDIR inside a fixed root is still honoured", () => {
    const before = process.env.TMPDIR;
    const inside = mkdtempSync(join("/tmp", "bw-sel-"));
    try {
      process.env.TMPDIR = inside;
      expect(isScratchPath(join(inside, STATE))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
      rmSync(inside, { recursive: true, force: true });
    }
  });
});

describe("#1175 review: the six spellings of an escape", () => {
  // Five of these were already refused before the review; they are the
  // controls that say the design holds, and they are locked so the next
  // review can be answered with a run. The sixth, `$X`, was the one leak.
  const RUN = `${process.env.HOME}/.rungate/victim`;
  const cases: [string, string][] = [
    ["an unexpanded $X — the one that leaked", `echo x > /tmp/$X/${STATE}`],
    ["the brace form", `echo x > /tmp/\${X}/${STATE}`],
    ["a command substitution with no space in it", `echo x > /tmp/\`id\`/${STATE}`],
    ["the same through $()", `echo x > /tmp/$(id)/${STATE}`],
    ["climbing out with ..", `echo x > /tmp/../${RUN.slice(1)}/${STATE}`],
    ["$HOME, which is not an absolute path until the shell expands it", `echo x > $HOME/.rungate/v/${STATE}`],
    ["a tilde, same reason", `echo x > ~/.rungate/v/${STATE}`],
  ];
  test.each(cases)("%s is refused", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("refusing `$` costs the fixtures nothing", () => {
    // The negative control for the widening: a plain fixture must still clear,
    // or the refusal above is just the guard turning itself off.
    expect(decideBashWrite(`echo x > /tmp/p/${STATE}`).blocked).toBe(false);
  });
});

describe("#1175 review: a link made by the same command voids the exemption", () => {
  // Recorded as unmeasured by the reviewer. Built here, and it is worse than
  // the race that was described: no second actor and no timing window are
  // needed, because the link and the write fit in one command.
  const RUN = `${process.env.HOME}/.rungate/victim`;
  const cases: [string, string][] = [
    ["&& chained", `ln -s ${RUN} /tmp/esc && echo x > /tmp/esc/${STATE}`],
    ["semicolon", `ln -s ${RUN} /tmp/esc; echo x > /tmp/esc/${STATE}`],
    ["a heredoc write after the link", `ln -s ${RUN} /tmp/esc\ncat > /tmp/esc/${STATE} <<'EOF'\n{}\nEOF`],
    ["symlinkSync inside an interpreter body", `bun -e 'symlinkSync("${RUN}","/tmp/esc"); writeFileSync("/tmp/esc/${STATE}","{}")'`],
    ["python's os.symlink", `python3 -c "os.symlink('${RUN}','/tmp/esc'); open('/tmp/esc/${STATE}','w').write('x')"`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("the traversal half is real, not theoretical", () => {
    // Executed rather than asserted: a write through a link lands at the
    // link's target. Proved with a harmless filename, because the live
    // BashWriteGuard refuses the real one — correctly.
    const dir = mkdtempSync(join(tmpdir(), "bw-tgt-"));
    const link = join(mkdtempSync(join(tmpdir(), "bw-src-")), "esc");
    try {
      symlinkSync(dir, link);
      writeFileSync(join(link, "SENTINEL"), "through");
      expect(readFileSync(join(dir, "SENTINEL"), "utf8")).toBe("through");
    } finally {
      rmSync(dirname(link), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: mkdir -p does not void it, which is why `ln` and not creation", () => {
    // A directory cannot point out of its tree. If this went red the voiding
    // would be matching path creation in general, and every fixture would
    // return to being refused.
    expect(decideBashWrite(`mkdir -p /tmp/p && echo x > /tmp/p/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`bun run learn.ts > /tmp/p/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`echo kiln > /tmp/p/${STATE}`).blocked).toBe(false);
  });
});

describe("#1175 review: the hook arm keeps the exemption — REFUSED suggestion", () => {
  /**
   * The review asked for the scratch exemption to be restricted to
   * `PROTECTED_FILES`, leaving `PROTECTED_HOOKS` matching in every tree.
   *
   * Refused, and these are the rows that say why. Every real hook path stays
   * blocked with or without the restriction, so it buys nothing; the ONLY
   * behaviour it changes is refusing a hook file inside a scratch tree, which
   * is the exact false positive #1175 exists to remove — `cp -p
   * <real hook> /tmp/cmp/old-guard.hook.ts` is a recorded one, staging a
   * comparison copy.
   *
   * Locked as a test so it is not raised a third time.
   */
  const REAL = [
    `echo x > ${process.env.HOME}/.claude/hooks/X.hook.ts`,
    `echo x > /tmp/../${(process.env.HOME ?? "").slice(1)}/.claude/hooks/X.hook.ts`,
    `cp evil.ts ${LIVE}/hooks/X.hook.ts`,
    `chmod 777 ${process.env.HOME}/.claude/hooks/X.hook.ts`,
    `echo x > ${LIVE}/hooks/X.hook.ts`,
  ];
  test.each(REAL)("a hook OUTSIDE a scratch tree is still refused: %s", cmd => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  const FIXTURES = [
    `cp -p /Users/x/hooks/Guard.hook.ts /tmp/cmp/old-guard.hook.ts`,
    `echo x > /tmp/bwprobe/hooks/X.hook.ts`,
    `chmod 777 /tmp/bwprobe/X.hook.ts`,
  ];
  test.each(FIXTURES)("a hook INSIDE one is the false positive #1175 removes: %s", cmd => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });
});

describe("#1175 review: a command substitution containing a SPACE — pre-existing, not this change", () => {
  /**
   * Found while building the six-spellings table. `writeTargets` reads an
   * operand as a WORD, and a word ends at whitespace, so
   *
   *     echo x > /tmp/`id -un`/workflow-state.json
   *
   * yields the target `/tmp/\`id` — which names no protected artifact, so arm
   * 1 never fires. The scratch exemption is not involved: `isScratchPath`
   * refuses every one of these spellings.
   *
   * Measured on `origin/main` as well, including at a live run-store path, so
   * it is a pre-existing limit of operand reading and NOT something #1175
   * introduced. Filed separately rather than fixed here — widening `readWord`
   * across whitespace is a change to the arm every other check depends on.
   *
   * What is asserted here is this module's own half, so a future fix to
   * `readWord` lands on a guard that already refuses the path.
   */
  const spellings = [`/tmp/\`id -un\`/${STATE}`, `/tmp/$(id -un)/${STATE}`, `/tmp/\`id\`/${STATE}`, `/tmp/$(id)/${STATE}`];
  test.each(spellings)("isScratchPath refuses %s", p => {
    expect(isScratchPath(p)).toBe(false);
  });
});

describe("#1175 review: the invariant must not switch the exemption off", () => {
  /**
   * Found by sweeping my own fix. The first version of the invariant dropped
   * any scratch root containing a protected tree — and `RUNGATE_WORK_DIR=
   * /tmp/e2e-gate-test` is a real corpus command, a harness deliberately
   * putting the run store in scratch for a test. Under it, `/tmp` contained a
   * protected tree, `/tmp` was dropped, and every fixture on the machine went
   * back to being refused. Measured before the clause was added.
   *
   * A guard that turns itself off under one environment variable is worse
   * than the hole it was closing, so a protected tree that is ITSELF inside a
   * fixed root no longer drops that root.
   */
  const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) before[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("a run store inside /tmp does not drop /tmp", () => {
    withEnv({ RUNGATE_WORK_DIR: "/tmp/e2e-gate-test" }, () => {
      expect(isScratchPath(`/tmp/p/${STATE}`)).toBe(true);
    });
  });

  test("a run store OUTSIDE scratch is still never exempt, however TMPDIR is pointed", () => {
    withEnv({ RUNGATE_WORK_DIR: "/opt/runs", TMPDIR: "/opt/runs" }, () => {
      expect(isScratchPath(`/opt/runs/v/${STATE}`)).toBe(false);
      expect(isScratchPath(`/tmp/p/${STATE}`)).toBe(true); // and the guard is still alive
    });
  });

  test("the fixed roots survive every environment in this block", () => {
    // The negative control for all of the above: if this ever goes red, the
    // invariant has started eating the roots again and the 37 cleared
    // commands are quietly back to being refused.
    for (const env of [
      { TMPDIR: undefined },
      { TMPDIR: `${process.env.HOME}/.rungate` },
      { RUNGATE_WORK_DIR: "/tmp/x" },
      { RUNGATE_WORK_DIR: "/opt/runs", TMPDIR: "/opt/runs" },
    ]) {
      withEnv(env, () => {
        expect(isScratchPath(`/tmp/p/${STATE}`), JSON.stringify(env)).toBe(true);
      });
    }
  });
});

describe("#1175 review round 2: live trees are SUBTRACTED, not approximated", () => {
  /**
   * Round one vetted the ROOT LIST against the run store. Round two subtracts
   * the live trees from the exemption directly, which is the property rather
   * than a proxy for it: it holds for a root nobody has added yet.
   *
   * The two mechanisms are not interchangeable and the difference is
   * measured. Dropping a ROOT that contains a protected tree removes `/tmp`
   * wholesale as soon as `RUNGATE_WORK_DIR` points inside it; subtracting the
   * TREE removes only that subtree. Both rows are below.
   */
  const H = process.env.HOME!;
  const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) before[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const rows: [string, Record<string, string | undefined>, string, boolean][] = [
    ["a plain fixture", {}, `/tmp/p/${STATE}`, true],
    ["the run store", {}, `${H}/.rungate/v/${STATE}`, false],
    ["the run store with TMPDIR aimed at it", { TMPDIR: `${H}/.rungate` }, `${H}/.rungate/v/${STATE}`, false],
    ["…and /tmp is still alive under that TMPDIR", { TMPDIR: `${H}/.rungate` }, `/tmp/p/${STATE}`, true],
    ["a run store relocated INTO /tmp — the subtree is subtracted", { RUNGATE_WORK_DIR: "/tmp/e2e" }, `/tmp/e2e/s/${STATE}`, false],
    ["…and the rest of /tmp survives, which the root-vetting version did not", { RUNGATE_WORK_DIR: "/tmp/e2e" }, `/tmp/p/${STATE}`, true],
    ["the WIRED hook tree, even in a /tmp worktree", { RUNGATE_HOOKS_DIR: "/tmp/wg97/hooks" }, "/tmp/wg97/hooks/X.hook.ts", false],
    ["a /tmp worktree nothing registers is still a fixture", { RUNGATE_HOOKS_DIR: "/tmp/wg97/hooks" }, "/tmp/rv1188/hooks/X.hook.ts", true],
    ["~/.pai/hooks", {}, `${H}/.pai/hooks/X.hook.ts`, false],
    ["~/.claude/hooks", {}, `${H}/.claude/hooks/X.hook.ts`, false],
    ["staging a comparison copy — the recorded false positive", {}, "/tmp/cmp/old-guard.hook.ts", true],
  ];
  test.each(rows)("%s", (_label, env, path, want) => {
    expect(withEnv(env, () => isScratchPath(path))).toBe(want);
  });
});

describe("#1175 review round 2: PROTECTED_HOOKS keeps the exemption, for a measured reason", () => {
  /**
   * The restriction was raised twice. Round one argued a regression and there
   * was none. Round two argued something sharper and TRUE — a `.hook.ts`
   * under `/tmp` is as likely to be a real checkout as a fixture, because
   * worktrees under `/tmp` are routine here.
   *
   * The counter-argument offered for refusing it a second time — that a hook
   * source in a checkout is never the live hook — is FALSE on this machine.
   * Every registration in `~/.claude/settings.json` is spelled
   * `${PAI_HOOKS_DIR}/…` or `${RUNGATE_HOOKS_DIR}/…`, and
   * `lib/hook-target-tree.ts` records `RUNGATE_HOOKS_DIR` resolving to a
   * checkout that was not this one, with fourteen hooks running from it and
   * a merged security fix never reaching the bytes that execute.
   *
   * So neither "refuse the exemption" nor "trust the checkout" is right. The
   * wired tree is subtracted wherever it is; an unwired one stays a fixture.
   * These rows are the ones the restriction would change, and they are the
   * bug #1175 exists to fix.
   */
  const fixtures = [
    `cp -p /Users/x/hooks/Guard.hook.ts /tmp/cmp/old-guard.hook.ts`,
    `rm -f /tmp/713-battery/pai-wrongfix/X.hook.ts`,
    `cp /Users/jhorn/.pai/hooks/DocHygiene.hook.ts /tmp/DocHygiene.hook.ts.bak-299`,
  ];
  test.each(fixtures)("a hook in an unwired scratch tree is a fixture: %s", cmd => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });

  test("the alternative — excluding every git work tree — is a proxy, and these rows say so", () => {
    // Priced on the corpus: it costs 0 of the 37, same as the subtraction, so
    // the corpus does NOT decide between them. It is declined on a ground the
    // corpus cannot see: it answers "is this a checkout", and the property is
    // "is this live". It misses a wired tree that is not a git work tree, and
    // it refuses a fixture built inside a worktree — which is what the agents
    // on this repo do.
    //
    // BUILT, not asserted about the ambient cwd. The first version of this
    // case read `process.cwd()`, which is under /tmp on the machine the
    // branch was written on and under /home/runner on the CI runner: it
    // asserted the environment rather than the code, passed locally and went
    // red on shard 3 only. The difference is removed here rather than the
    // failure.
    // `/tmp` rather than `tmpdir()`: it is a literal fixed root on both
    // platforms, so the row cannot depend on what TMPDIR happens to be on
    // the machine reading it — which is the defect this case just had.
    const tree = mkdtempSync(join("/tmp", "bw-wt-"));
    const plain = mkdtempSync(join("/tmp", "bw-plain-"));
    try {
      mkdirSync(join(tree, ".git"));
      mkdirSync(join(tree, "hooks"));
      const hook = join(tree, "hooks", "X.hook.ts");
      writeFileSync(hook, "// fixture\n");
      const loose = join(plain, "X.hook.ts");
      writeFileSync(loose, "// fixture\n");

      // the proxy, written out so its cost is visible rather than described
      const inGitWorkTree = (p: string): boolean => {
        let d = dirname(p);
        while (d !== "/") {
          if (existsSync(join(d, ".git"))) return true;
          d = dirname(d);
        }
        return false;
      };

      // the row the two rules disagree on: scratch, a work tree, unwired
      expect(inGitWorkTree(hook)).toBe(true); // the proxy refuses it
      expect(isScratchPath(hook)).toBe(true); // the shipped rule exempts it

      // and the control, so the proxy is not simply always true
      expect(inGitWorkTree(loose)).toBe(false);
      expect(isScratchPath(loose)).toBe(true);
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("#1175 review round 2: the expansion predicate stays narrow", () => {
  test("the wide predicate would refuse a real fixture; the narrow one does not", () => {
    // A review proposed /[$`*?~\\]|\$\(|\{/. Priced: 1 of the 37 cleared goes
    // back to refused — a glob cleanup — and 975 corpus commands match it
    // against 211 for the narrow one. The extra breadth buys only cases that
    // were already blocked.
    const glob = `rm -f /tmp/713-battery/pai-wrongfix/*.hook.ts && rmdir /tmp/713-battery/pai-wrongfix`;
    expect(decideBashWrite(glob).blocked).toBe(false);
    expect(/[$`*?~\\]|\$\(|\{/.test("/tmp/713-battery/pai-wrongfix/*.hook.ts")).toBe(true); // the wide one fires
    expect(/[$`]/.test("/tmp/713-battery/pai-wrongfix/*.hook.ts")).toBe(false); // the shipped one does not
    // and the leak the narrow one exists for is still closed
    expect(isScratchPath(`/tmp/$X/${STATE}`)).toBe(false);
  });
});

describe("#1175 review round 3: the verb is resolved, not pattern-matched", () => {
  /**
   * `exemptionIsVoid` tested `/(?:^|[\s;&|(])ln\s/` against the raw command,
   * which needs whitespace or a separator immediately before `ln`. Two
   * spellings the shell resolves identically walked straight past it, and
   * this is the control the entire scratch exemption rests on.
   *
   * The fix is `commandWord` per segment rather than a wider regex: it
   * already strips a leading path and a leading `\`, and already skips the
   * wrappers, because #1120 and #1184 taught it to. One tokeniser, not two.
   */
  const RUN = `${process.env.HOME}/.rungate/victim`;
  const spellings = [
    ["plain", `ln -s ${RUN} /tmp/x`],
    ["sudo wrapper", `sudo ln -s ${RUN} /tmp/x`],
    ["path-qualified — walked past the old regex", `/bin/ln -s ${RUN} /tmp/x`],
    ["backslash-escaped — walked past it too", `\\ln -s ${RUN} /tmp/x`],
    ["env wrapper", `env ln -s ${RUN} /tmp/x`],
    ["xargs wrapper", `xargs ln -s ${RUN} /tmp/x`],
    ["via find -exec, which resolves to `find`", `find . -exec ln -s ${RUN} /tmp/x \;`],
  ];
  test.each(spellings)("%s voids the exemption", (_label, link) => {
    expect(decideBashWrite(`${link} && echo y > /tmp/x/${STATE}`).blocked).toBe(true);
  });

  test("CONTROL: words that merely contain the letters do not void it", () => {
    // If these go red the voiding has become a substring match and every
    // fixture whose path happens to contain `ln` is refused.
    for (const cmd of [
      `echo kiln > /tmp/p/${STATE}`,
      `bun run learn.ts > /tmp/p/${STATE}`,
      `mkdir -p /tmp/p && echo x > /tmp/p/${STATE}`,
    ]) {
      const d = decideBashWrite(cmd);
      expect(d.blocked, `refused: ${cmd} — ${d.reason}`).toBe(false);
    }
  });
});

describe("#1175 review round 3: a glob in a DIRECTORY component", () => {
  /**
   * `echo '{}' > /tmp/sym*​/workflow-state.json` with `/tmp/syma` a symlink
   * into the run store: the literal does not exist, the walk climbs past it
   * to `/tmp`, the path is exempted, and the shell then expands the glob
   * through the link. The same escape as the `ln` case with no `ln` in the
   * command to see.
   *
   * Only the DIRECTORY part is tested, and that is a measurement rather than
   * caution. A basename glob is already safe because the directory above it
   * is exactly what gets realpath'd — the executed proof is below. Refusing
   * it anyway costs a real command, `rm -f /tmp/.../*.hook.ts`, 1 of the 37
   * this branch clears.
   */
  test.each([`/tmp/sym*/${STATE}`, `/tmp/sym?/${STATE}`, `/tmp/[sx]ym/${STATE}`, `/tmp/{a,b}/${STATE}`])(
    "a glob in a directory component is not exempt: %s",
    p => {
      expect(isScratchPath(p)).toBe(false);
    },
  );

  test("a basename glob stays exempt, and the directory above it is still resolved", () => {
    // Both halves executed. The link makes the directory resolve out of
    // scratch, and the basename glob does not prevent that being seen — which
    // is why the refusal is scoped to the directory part.
    const src = mkdtempSync(join(tmpdir(), "bw-glob-"));
    const out = mkdtempSync(join(tmpdir(), "bw-out-"));
    try {
      expect(isScratchPath(join(src, "*.json"))).toBe(true); // a real scratch dir
      symlinkSync("/usr", join(src, "syma")); // now link it out of scratch
      expect(isScratchPath(join(src, "syma", "*.json"))).toBe(false); // caught
      expect(isScratchPath(join(src, "sym*", "x.json"))).toBe(false); // and the glob form
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("the real command a blanket metacharacter class would have cost", () => {
    expect(decideBashWrite(`rm -f /tmp/713-battery/pai-wrongfix/*.hook.ts`).blocked).toBe(false);
  });
});

/**
 * A root that is absolute and is not any platform's scratch tree.
 *
 * Separate from #1197's `LIVE` on purpose: that PR is open against this same
 * file and declares its own constant at the top. A second identifier in a
 * region #1197 does not touch is one merge without a conflict; a second
 * declaration of the same name is a conflict for whoever rebases last.
 *
 * Witnesses below use it rather than `/tmp` because #1197 makes `/tmp` the
 * one place a protected NAME is not a protected ARTIFACT. A witness planted
 * under `/tmp` passes today and flips to ALLOW the moment #1197 lands — it
 * would be asserting the false positive that PR exists to remove.
 */
const LIVE_TREE = "/opt/bwprobe";

/** A backslash-newline, spelled once so the witnesses read as commands. */
const CONT = " \\\n  ";

describe("#1203 WITNESS: a line continuation must not separate a verb from its target", () => {
  // The shell joins `\` + newline into one command BEFORE it does anything
  // else. `segments()` split on the newline instead, so each continuation
  // line became its own "command" and the verb never met its target. All six
  // rows are ALLOW on `origin/main` @ dbf10445 and must be BLOCK.
  const cases: [string, string][] = [
    ["cp, whose destination is on the next line", `cp /tmp/x.json${CONT}${LIVE_TREE}/${STATE}`],
    ["mv, same shape", `mv /tmp/x${CONT}${LIVE_TREE}/${STATE}`],
    ["chmod reached through two continuations", `chmod${CONT}777${CONT}${LIVE}/h/Y.hook.ts`],
    ["rm of the salt, continued", `rm${CONT}${LIVE_TREE}/${SALT}`],
    ["tee, whose file operand is continued", `tee${CONT}${LIVE_TREE}/${STATE}`],
    ["a redirect whose target is on the continuation line", `echo x >${CONT}${LIVE_TREE}/${SALT}`],
    ["a continuation inside an interpreter invocation", `python3 -c${CONT}"open('${LIVE_TREE}/${SALT}','w').write('x')"`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1203 CONTROL: the join is the shell's join, not a blanket one", () => {
  test("a backslash at end of line INSIDE single quotes is literal, not a continuation", () => {
    // The cheapest wrong fix is `cmd.replace(/\\\n/g, ' ')` at the top of
    // segments(). It passes every witness above and fails this row: inside a
    // single quote the backslash is data, and the newline is data too.
    const quoted = "echo 'a \\\nb'";
    expect(segments(quoted)).toEqual([quoted]);
  });

  test("an ESCAPED backslash at end of line does not swallow the newline", () => {
    // `\\` is one literal backslash; the newline after it still separates.
    // A naive scanner that consumes `\` then looks at the next character
    // reads the second `\` as the start of a continuation and joins two
    // genuinely separate commands into one.
    expect(segments("echo x \\\\\nls")).toEqual(["echo x \\\\", "ls"]);
  });

  test("F9: a real continued `git add` of hook sources stays allowed", () => {
    // Recovered from the corpus. Before the join this command's continuation
    // lines were read as commands in their own right, so `commandWord`
    // returned `hooks/GateEnforcement.hook.ts` — a FILENAME as a verb. That
    // mis-reading is the defect; joining must not turn the command into a
    // refusal, because `git add` writes nothing the guard protects.
    const cmd =
      `git -C /Users/jhorn/Projects/rungate add${CONT}lib/gate-enforcement.ts${CONT}` +
      `test/gate-enforcement.test.ts${CONT}hooks/GateEnforcement.hook.ts`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("F10: a real continued `grep -rn` across hook sources stays allowed", () => {
    const cmd =
      `grep -rn 'MEMORY.*WORK'${CONT}~/.claude/hooks/AgentBriefGuard.hook.ts${CONT}` +
      `~/.claude/hooks/GateEnforcement.hook.ts`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("a heredoc body's continuations are the document, not commands", () => {
    // The `pai-config#474` shape: a `gh` body written with a heredoc, whose
    // lines are backslash-continued and whose text quotes a protected name.
    const cmd = `gh issue create --body "$(cat <<'EOF'\nrun it with:\n  cp a \\\n  b/${STATE}\nEOF\n)"`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("MECHANISM: a continued command is ONE segment", () => {
    // The join inserts NOTHING. `CONT` is a space, a backslash, a newline and
    // two spaces; removing the backslash-newline leaves the three spaces that
    // were really there. Every consumer splits on /\s+/ or skips whitespace,
    // so the run is invisible to them — and asserting the exact string is
    // what keeps "joined with nothing" distinguishable from "joined with a
    // space", which the next row shows is a real difference.
    expect(segments(`cp /tmp/x.json${CONT}${LIVE_TREE}/${STATE}`)).toEqual([
      `cp /tmp/x.json   ${LIVE_TREE}/${STATE}`,
    ]);
  });

  test("MECHANISM: a continuation INSIDE a verb rejoins the verb", () => {
    // `ch\<nl>mod 777 x.hook.ts` runs chmod — the shell removes the
    // backslash-newline with no separator, so the two halves are one token.
    // Joining with a SPACE instead resolves the command word to `ch` and the
    // arm-4 test never fires, so this row is what separates the two spellings
    // of the fix. It is also a bypass in its own right.
    expect(commandWord(segments("ch\\\nmod 777 /tmp/h/Y.hook.ts")[0])).toBe("chmod");
    expect(decideBashWrite(`ch\\\nmod 777 ${LIVE}/h/Y.hook.ts`).blocked).toBe(true);
  });
});

describe("#1205 WITNESS: a command substitution containing a space is one word", () => {
  // `readWord` ended the redirect operand at the first space, so a
  // substitution with an argument split the target in half and the surviving
  // fragment named no protected artifact. Arm 1 then never fired at all.
  const cases: [string, string][] = [
    ["a backtick substitution with an argument", "echo x > /tmp/`id -un`/" + STATE],
    ["the $() spelling of the same thing", `echo x > /tmp/$(id -un)/${STATE}`],
    ["the live run-store row — the witness #1205 names", "echo x > ~/.rungate/`id -un`/" + STATE],
    ["a nested substitution", `echo x > $(dirname $(echo /a/b))/${STATE}`],
    ["an UNTERMINATED substitution fails closed", `echo x > /tmp/$(id -un/${STATE}`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("MECHANISM: the operand survives whole rather than as a fragment", () => {
    expect(writeTargets("echo x > /tmp/`id -un`/" + STATE)).toEqual(["/tmp/`id -un`/" + STATE]);
    expect(writeTargets(`echo x > /tmp/$(id -un)/${STATE}`)).toEqual([`/tmp/$(id -un)/${STATE}`]);
  });
});

describe("#1205 CONTROL: carrying the substitution is not refusing every $", () => {
  test("the space-free form stays blocked — it was never the defect", () => {
    expect(decideBashWrite("echo x > /tmp/`id`/" + STATE).blocked).toBe(true);
  });

  test("the already-quoted form stays blocked", () => {
    expect(decideBashWrite(`echo x > "$(dirname /a/b)"/${STATE}`).blocked).toBe(true);
  });

  test("a substitution-built path naming NOTHING protected stays allowed", () => {
    // This is the row that kills the cheapest wrong fix. #1205's acceptance
    // offers "OR the whole operand is refused as unreadable", and refusing
    // every operand containing `$(` or a backtick passes all five witnesses
    // above. It also refuses this, which is ordinary work.
    expect(decideBashWrite("echo x > $(mktemp -d)/out.txt").blocked).toBe(false);
    expect(decideBashWrite("echo x > /tmp/`date +%s`/log.txt").blocked).toBe(false);
  });

  test("an ordinary operand is read exactly as before", () => {
    expect(writeTargets("echo x > /tmp/plain.txt")).toEqual(["/tmp/plain.txt"]);
    expect(writeTargets("ls -la 2>&1")).toEqual([]);
    expect(writeTargets("ls -la 2>/dev/null")).toEqual([]);
  });

  test("a `>` INSIDE a substitution does not end the operand", () => {
    expect(writeTargets(`echo x > $(f > /dev/null; echo d)/${STATE}`)).toEqual([
      `$(f > /dev/null; echo d)/${STATE}`,
    ]);
  });
});

describe("#1146: the two gaps the issue names are already closed — locked, not re-fixed", () => {
  // Re-derived against `origin/main` @ dbf10445 before any code was written.
  // #1120 moved cp/mv destination extraction to the last non-option argument
  // and #1184/#1188 filled IN_PLACE. Every row below is BLOCK on main today.
  // They are regression locks, not new behaviour, and they are the reason
  // this PR adds two verbs rather than the eight the issue lists.
  const verbs: [string, string][] = [
    ["sed -i", `sed -i s/a/b/ ${LIVE_TREE}/${STATE}`],
    ["perl -i", `perl -i -pe s/a/b/ ${LIVE_TREE}/${STATE}`],
    ["dd of=", `dd of=${LIVE_TREE}/${STATE} if=/dev/zero`],
    ["truncate", `truncate -s0 ${LIVE_TREE}/${STATE}`],
    ["rm", `rm ${LIVE_TREE}/${SALT}`],
    ["ln", `ln -sf /tmp/a ${LIVE_TREE}/${STATE}`],
    ["install", `install -m644 /tmp/a ${LIVE_TREE}/${STATE}`],
    ["git checkout", `git checkout ${LIVE_TREE}/${STATE}`],
    ["git restore", `git restore ${LIVE_TREE}/${STATE}`],
    ["cp with a flag before the destination", `cp -p source.json ${LIVE_TREE}/${STATE}`],
    ["mv with a flag before the destination", `mv -f source.json ${LIVE_TREE}/${STATE}`],
    ["rsync with a flag before the destination", `rsync -a src ${LIVE_TREE}/${STATE}`],
  ];
  test.each(verbs)("%s already blocks on main", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });
});

describe("#1146 WITNESS: the two verbs the corpus says are worth adding", () => {
  test("chmod on a NON-hook protected artifact — a real corpus command", () => {
    // Arm 4 fired only on PROTECTED_HOOKS, so a permission change on the
    // gate salt was allowed. Recovered verbatim from the transcript corpus;
    // it is the single command this widening newly blocks in 5,059.
    const cmd = `chmod 600 /Users/jhorn/.claude/.claude/worktrees/agent-abbce86bb83ada9c6/hooks/lib/${SALT}`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("chflags on a protected file", () => {
    expect(decideBashWrite(`chflags uchg ${LIVE_TREE}/${STATE}`).blocked).toBe(true);
  });

  test("xattr -d on a hook — a real corpus command", () => {
    // Also recovered verbatim. Extended attributes are file metadata, and
    // `com.apple.provenance` is what was blocking writes to these hooks, so
    // removing it is a mutation of hook integrity by any reading.
    const cmd = "xattr -d com.apple.provenance /Users/jhorn/.pai/hooks/IssueCloseGuard.hook.ts";
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("xattr -w on a protected file", () => {
    expect(decideBashWrite(`xattr -w k v ${LIVE_TREE}/${STATE}`).blocked).toBe(true);
  });
});

describe("#1146 CONTROL: the verbs that did NOT earn their place", () => {
  test("a bare `xattr` is a READ and stays allowed", () => {
    // Two real corpus commands do exactly this. The broad `/\bxattr\b/`
    // newly blocks 3 commands of which these 2 are reads; the narrow
    // `-d`/`-w`/`-s` form newly blocks 1, and that one is the mutation
    // above. This row is what separates the two patterns.
    expect(decideBashWrite("xattr /Users/jhorn/.pai/hooks/IssueCloseGuard.hook.ts").blocked).toBe(false);
    expect(decideBashWrite("ls -la@ /Users/jhorn/.pai/hooks/IssueCloseGuard.hook.ts").blocked).toBe(false);
  });

  test("F11: chmod is still a COMMAND WORD test, not a substring one", () => {
    // Widening arm 4's TARGET list must not widen its VERB test.
    //
    // The obvious control here — #1120's `git show … | grep -nE
    // "chmod|chflags"` — is VACUOUS for this mutation, and it was written
    // that way first. It names no protected artifact, so the substring
    // reading finds nothing to refuse and the row passes under the wrong fix
    // as readily as under the right one. The separating shape has to carry
    // BOTH halves: the verb as data AND a protected artifact as the target.
    //
    // So this is a real command from the corpus. Seven read-only commands
    // there have that shape; the substring reading newly refuses all seven.
    const cmd =
      'grep -n "uchg\\|chflags\\|nouchg\\|schg" /Users/jhorn/.pai/hooks/BashWriteGuard.hook.ts 2>/dev/null';
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("chmod on an unprotected path stays allowed", () => {
    expect(decideBashWrite("chmod 644 /tmp/notes.md").blocked).toBe(false);
  });

  test("touch, mkdir, mktemp and split were PRICED and left out", () => {
    // Measured on the 5,059 allowed commands naming a protected artifact:
    // touch 0 newly blocked, mkdir 1, mktemp 1, split 9 — and every one of
    // the 11 was read and is a false positive (`split` matches `.split(`
    // inside Python heredoc bodies; `mkdir -p <run store> && bun -e …` is
    // arm 3's business, not a mutation by `mkdir`). A verb that newly blocks
    // real work and catches nothing is a regression, so none shipped.
    expect(decideBashWrite(`touch ${LIVE_TREE}/${STATE}`).blocked).toBe(false);
    expect(decideBashWrite(`mkdir -p /Users/jhorn/.rungate/x && echo hi`).blocked).toBe(false);
  });
});

describe("#1203: an escaped quote outside a quote does not OPEN one", () => {
  // Not predicted, and found by the corpus sweep rather than by reading.
  //
  // Handling `\<newline>` meant deciding what the scanner does with a
  // backslash generally, and the honest answer is the shell's: outside a
  // quote, `\X` escapes X for every X. The scanner used to fall through to
  // `cur += c` and then read the NEXT character normally — so `\'` opened a
  // quote that never closed, the tracker desynchronised, and every separator
  // for the rest of the command was swallowed or invented.
  //
  // `'\''` — close, escaped literal quote, reopen — is THE way to put an
  // apostrophe inside a single-quoted shell string. It is everywhere in this
  // machine's history: inside `sed` scripts, `jq` filters and `--body` text.

  test("MECHANISM: the tracker stays in sync across `\\'`", () => {
    // On `origin/main` this returns ONE segment: the `\'` opened a quote, so
    // the `;` was read as quoted text instead of as a separator.
    expect(segments("echo \\' ; rm /r/x")).toEqual(["echo \\'", "rm /r/x"]);
  });

  test("F12: a real `sed -i` on a real hook, ALLOWED on main", () => {
    // Recovered from the corpus. The desync put `sed -i` and its target in
    // different segments, so arm 2 read a verb with no protected argument.
    const cmd = "sed -i '' 's|x|'\\''y'\\''|g' /Users/jhorn/.pai/hooks/X.hook.ts";
    expect(segments(cmd)).toHaveLength(1);
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("F13: a real `jq … && mv` onto a LIVE run-store artifact, ALLOWED on main", () => {
    // The serious one. A `jq` filter carrying `'\''` tore the command apart,
    // and the `mv` that writes the live gate artifact landed in a fragment
    // of its own with no verb the guard recognised.
    const cmd =
      `jq '.acs[3].evidenceMethod.command = "grep -ch '\\''x()'\\'' a.ts"' ` +
      `/Users/jhorn/.rungate/ddb-1452/${STATE} > /tmp/ws-fix.json && ` +
      `mv /tmp/ws-fix.json /Users/jhorn/.rungate/ddb-1452/${STATE}`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("F14: a literal backslash before a closing SINGLE quote ends the span", () => {
    // Raised by the AI review against the first revision of this PR, and it
    // was right — the first version of this very describe asserted the defect
    // as intended behaviour, in a control that passed vacuously because the
    // string it used contained no separator to swallow.
    //
    // Inside single quotes POSIX sh escapes NOTHING, not even a backslash, so
    // the first `'` always closes. Treating `\'` as an escape there kept the
    // span open past its real end and swallowed the separator AND the verb.
    expect(segments("echo 'a\\' ; rm /r/x")).toEqual(["echo 'a\\'", "rm /r/x"]);
  });

  test("F14 WITNESS: the swallowed segment is a real bypass of the verb-gated arms", () => {
    // Arm 4 requires the COMMAND WORD to be chmod. With the span held open,
    // the whole command is one segment whose command word is `echo`, so the
    // arm never fires. ALLOW on origin/main, BLOCK here. The redirect and
    // in-place arms happened to survive it, which is why this needs the
    // command-word-gated arm to show the hole at all.
    expect(decideBashWrite("echo 'x\\' ; chmod 777 /h/Y.hook.ts").blocked).toBe(true);
  });

  test("CONTROL: inside DOUBLE quotes a backslash IS an escape", () => {
    // The two cases are told apart rather than handled by one rule, so this
    // is the row that stops the fix becoming "a quote always closes".
    expect(segments('echo "a\\" ; rm /r/x"')).toHaveLength(1);
  });

  test("CONTROL: the `'\\''` idiom is unaffected by the single-quote rule", () => {
    // Its backslash sits OUTSIDE the quotes — between the closing quote of
    // one span and the opening quote of the next — so it is the escape branch
    // above that handles it, not this one. Both halves must hold at once.
    expect(decideBashWrite("echo 'a'\\''b' ; rm /r/x").blocked).toBe(false);
    expect(segments("echo 'a'\\''b' ; rm /r/x")).toEqual(["echo 'a'\\''b'", "rm /r/x"]);
  });
});

describe("#1249 WITNESS: an escaped BACKSLASH inside double quotes is a pair", () => {
  // F14's twin in the other quote. Inside double quotes `\\` is an escaped
  // backslash — a complete pair — and the `"` after it is the CLOSING quote.
  // A one-character lookbehind cannot tell that `"` from the escaped `\"` of
  // the control above, so it read the span as still open, swallowed the
  // separator and the verb, and left one segment whose command word is
  // `echo`.
  //
  // The outside-quote branch of the same scanner already consumed the pair,
  // for this exact reason, and says so in its comment. This applies the same
  // rule inside the span.
  //
  // WHY THIS LOOKED UNREAL: the issue's example used `rm`, and `rm` is the
  // one shape that does NOT escape. The in-place arm matches over the
  // segment TEXT, so a merged segment still carries its target; the same is
  // true of the redirect and `tee` arms. Only the arms gated on the COMMAND
  // WORD are bypassable. A battery built from the issue's own example
  // therefore reports BLOCK on every row and the hole stays invisible. The
  // three rows below are the ones that do escape, each measured ALLOW
  // against `origin/main` at 52750f04 before the fix.

  test("MECHANISM: the quote after `\\\\` closes the span", () => {
    // ONE segment on origin/main, where the separator is quoted text.
    expect(segments('echo "x\\\\" ; rm /r/x')).toEqual(['echo "x\\\\"', "rm /r/x"]);
  });

  test("WITNESS: `cp` overwrites the artifact — ALLOW on origin/main", () => {
    // Arm 1 resolves the COPY verb from the command word, so a merged
    // segment beginning `echo` never reaches it.
    expect(
      decideBashWrite(`echo "x\\\\" ; cp /etc/hosts ${LIVE_TREE}/run/${STATE}`).blocked,
    ).toBe(true);
  });

  test("WITNESS: `chmod` on the artifact — ALLOW on origin/main", () => {
    // Arm 4, the same arm F14 used to show the single-quote hole.
    expect(decideBashWrite(`echo "x\\\\" ; chmod 777 ${LIVE_TREE}/run/${STATE}`).blocked).toBe(
      true,
    );
  });

  test("WITNESS: an interpreter writing the artifact — ALLOW on origin/main", () => {
    // Arm 3 fires on an interpreter COMMAND WORD. Hidden by the merge, the
    // program text is never read at all.
    const body = `bun -e 'require("fs").writeFileSync("${LIVE_TREE}/run/${STATE}","{}")'`;
    // The unmerged spelling FIRST. Without it this row cannot tell #1249
    // from arm 3 simply not recognising the write — which is how the first
    // draft of it went red: `open(p,"w")` on its own is ALLOWed on main
    // whether merged or not, because arm 3 reads a list of write verbs and
    // `open` is not on it. That is a pre-existing gap of the same
    // enumeration class as #1269's finding 3, and not what this row is for.
    expect(decideBashWrite(`echo x ; ${body}`).blocked).toBe(true);
    expect(decideBashWrite(`echo "x\\\\" ; ${body}`).blocked).toBe(true);
  });

  test("the shell really runs both commands — the premise, not an assumption", () => {
    // Without this row the three above only assert that two readers of a
    // string disagree. `bash -n` says the spelling parses; this says the
    // second command is reached and has its effect.
    const dir = mkdtempSync(join(tmpdir(), "bw1249-"));
    try {
      const victim = join(dir, "victim.txt");
      // late-env-ok: the child is `echo` and `cp` under bash, which read no
      // RUNGATE variable and no TMPDIR — the destination is an absolute path
      // computed here and passed on the command line. Nothing this file
      // writes to process.env can change what this row measures.
      spawnSync("/bin/bash", ["-c", `echo "x\\\\" ; cp /etc/hosts ${victim}`]);
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("END TO END through the hook — the payload, not the exit code", () => {
    // Every row above reads the library. This one runs the hook the way the
    // tool runner does, because that is where the refusal has to happen.
    const hook = join(import.meta.dir, "..", "hooks", "BashWriteGuard.hook.ts");
    // This child DOES read RUNGATE_WORK_DIR and TMPDIR, so it gets an
    // EXPLICIT env rather than a stated reason (#1096). Earlier tests in
    // this file write both, and relying on Bun dropping a late write to
    // keep them out of the child would make that an accident of the
    // runtime rather than a property of the row.
    const env: Record<string, string | undefined> = { ...process.env, TMPDIR: "/tmp" };
    delete env.RUNGATE_WORK_DIR;
    delete env.PAI_HOOKS_DIR;
    delete env.RUNGATE_HOOKS_DIR;
    const run = (command: string) => {
      const r = spawnSync("bun", ["run", hook], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
        env,
      });
      return { status: r.status, stdout: (r.stdout || "").trim() };
    };
    const refused = run(`echo "x\\\\" ; chmod 777 ${LIVE_TREE}/run/${STATE}`);
    expect(JSON.parse(refused.stdout).decision).toBe("block");
    // The control that makes this row readable rather than decorative: the
    // hook ALWAYS exits 0 and signals a refusal on stdout. A permitted
    // command exits 0 and prints nothing, so the two directions are
    // indistinguishable by status and a test asserting on it cannot fail.
    const permitted = run("echo hello");
    expect(permitted.stdout).toBe("");
    expect(refused.status).toBe(0);
    expect(permitted.status).toBe(0);
  });

  test("CONTROL: a separator INSIDE the double-quoted span still does not split", () => {
    // The fix must close the span at its real end, not widen the splitter.
    expect(segments('echo "a\\\\;b"')).toHaveLength(1);
    expect(segments('echo "a\\"b ; c" ; rm /r/x')).toHaveLength(2);
  });

  test("CONTROL: the single-quote rule is untouched by the pair rule", () => {
    // Inside single quotes nothing is escaped, so the first `'` closes and
    // the pair branch must not run there. Two backslashes, the #1249 shape,
    // in the #1203 quote.
    expect(decideBashWrite(`echo 'x\\\\' ; chmod 777 ${LIVE_TREE}/run/${STATE}`).blocked).toBe(
      true,
    );
  });

  test("CONTROL: a dangling backslash at the end of the string is not an index past it", () => {
    expect(() => segments('echo "x\\')).not.toThrow();
  });
});

describe("#1249: the cheapest wrong fix, run rather than described", () => {
  // Three rules for "where does this double-quoted span close", run against
  // the two inputs that tell them apart rather than argued about. The
  // cheapest fix — delete the escape handling, a quote always closes — gets
  // the new row right and gets the row already in the suite above wrong.
  const closesAt = (s: string, rule: "naive" | "lookbehind" | "pair"): number => {
    for (let i = 1; i < s.length; i++) {
      if (rule === "pair" && s[i] === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (s[i] !== '"') continue;
      if (rule === "lookbehind" && s[i - 1] === "\\") continue;
      return i;
    }
    return -1; // the span never closed
  };
  const ESCAPED_BACKSLASH = '"x\\\\"'; // bytes: "x\\"  — a pair, closes at 4
  const ESCAPED_QUOTE = '"x\\""'; // bytes: "x\""  — an escape, closes at 4

  test("the lookbehind that shipped never closes the escaped-backslash span", () => {
    expect(closesAt(ESCAPED_BACKSLASH, "lookbehind")).toBe(-1);
    expect(closesAt(ESCAPED_QUOTE, "lookbehind")).toBe(4);
  });

  test("`a quote always closes` fixes this row and breaks the escaped quote", () => {
    expect(closesAt(ESCAPED_BACKSLASH, "naive")).toBe(4);
    expect(closesAt(ESCAPED_QUOTE, "naive")).toBe(3); // ends the span early
  });

  test("consuming the PAIR is the only one of the three that gets both", () => {
    expect(closesAt(ESCAPED_BACKSLASH, "pair")).toBe(4);
    expect(closesAt(ESCAPED_QUOTE, "pair")).toBe(4);
  });
});

/**
 * `bash -n` — does this spelling even parse? A guard that lets through a
 * string the shell refuses to run has let through nothing, and this is the
 * only thing that tells a bypass apart from a typo. Used in both directions
 * below: to prove the witnesses are programs, and to prove the fail-open
 * exits the review flagged are unreachable.
 */
function parses(cmd: string): boolean {
  // late-env-ok: this file became a candidate for the #1096 scan when #1175
  // added cases that assign `process.env.TMPDIR`, and the scan is right to
  // ask. The answer is that this child cannot be affected by them: `bash -n`
  // parses the string it is handed and does not execute it, so it reads no
  // variable at all, and `TMPDIR` here is read by `isScratchPath` IN THIS
  // PROCESS. Every assignment is also restored in a `finally` in the same
  // test, so no value outlives the case that set it.
  return spawnSync("/bin/bash", ["-n", "-c", cmd], { encoding: "utf8" }).status === 0;
}

describe("#1205 WITNESS: the $() depth scan must skip quoted spans", () => {
  // Raised by the plugin security review against the pushed branch and
  // confirmed by execution. The depth counter counted a `)` that was INSIDE
  // a string literal, dropped to zero early and ended the word mid
  // substitution. The leftover `"` then had no partner, so `readWord`'s
  // quote branch took `close === -1` and swallowed the rest of the line —
  // including the `>` operator. No operator, no target, ALLOW.
  //
  // It is the same sentence as #1205 itself: the bug is what the scanner
  // cannot see, not the substitution.
  const cases: [string, string][] = [
    ["a paren inside DOUBLE quotes", `echo $(echo "x)") > ${LIVE_TREE}/${SALT}`],
    ["a paren inside SINGLE quotes", `echo $(echo 'x)') > ${LIVE_TREE}/${SALT}`],
    ["the quoted paren in the second of two substitutions", `echo $(date) $(echo "x)") > ${LIVE_TREE}/${SALT}`],
    ["a quoted paren in a tee operand's neighbour", `echo $(echo "x)") | tee ${LIVE_TREE}/${STATE}`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("CONTROL: every witness above is a program bash will run", () => {
    // Without this the witnesses prove nothing — a string the shell refuses
    // is not a bypass. The review's own reproduction wrote a file through
    // the first spelling.
    for (const [, cmd] of cases) expect(parses(cmd)).toBe(true);
  });
});

describe("#1205 CONTROL: skipping quoted spans is not widening the scan", () => {
  test("a balanced substitution with no quotes is unchanged", () => {
    expect(decideBashWrite(`echo $(echo x) > ${LIVE_TREE}/${SALT}`).blocked).toBe(true);
    expect(writeTargets(`echo x > $(dirname /a/b)/${STATE}`)).toEqual([`$(dirname /a/b)/${STATE}`]);
  });

  test("a substitution-built path naming nothing protected stays allowed", () => {
    expect(decideBashWrite("echo x > $(mktemp -d)/out.txt").blocked).toBe(false);
    expect(decideBashWrite('echo $(echo "x)") > /tmp/out.txt').blocked).toBe(false);
  });

  test("the three UNTERMINATED spellings are bash syntax errors, so no refusal path is added", () => {
    // The security review called these fail-open and asked for an
    // `unparseable` flag. They ARE the consume-to-end branch, and the branch
    // is deliberate — but the question is moot: none of them is a program,
    // so there is no write for a refusal to prevent. Machinery guarding an
    // unreachable state costs real commands and protects nothing.
    //
    // Recorded as an assertion rather than as prose so that if any of these
    // ever becomes valid shell, this row goes red and the decision is re-made
    // with evidence instead of being inherited.
    const unterminated = [
      "echo x > `id -un/" + STATE,
      `echo x > /tmp/$(id -un/${STATE}`,
      `echo x > "${LIVE_TREE}/${STATE}`,
      // The spelling that genuinely ALLOWs: an unterminated quote placed
      // BEFORE the operator swallows the `>` itself. Also not a program.
      `echo "x > ${LIVE_TREE}/${STATE}`,
    ];
    for (const cmd of unterminated) expect(parses(cmd)).toBe(false);
  });
});

describe("#1146: xattr's mutating forms are -w, -d and -c, read off the tool", () => {
  // `xattr --help` on macOS:
  //   xattr [-lrsvx] file …                    list      — a READ
  //   xattr -p [-lrsvx] attr file …            print     — a READ
  //   xattr -w [-rsx] attr value file …        set       — MUTATES
  //   xattr -d [-rsv] attr file …              delete    — MUTATES
  //   xattr -c [-rsv] file …                   clear ALL — MUTATES
  //
  // The pattern shipped in the first revision of this PR, `-[dws]`, is wrong
  // in BOTH directions against that: it misses `-c`, which deletes every
  // attribute on the file, and it treats `-s` — "act on the symbolic link
  // itself" — as a mutation. It also reads a single letter, so any cluster
  // hides the verb.
  const mutating: [string, string][] = [
    ["-d, the recorded corpus command", `xattr -d com.apple.provenance /h/X.hook.ts`],
    ["-w", `xattr -w a b /h/X.hook.ts`],
    ["-c, which clears every attribute", `xattr -c /h/X.hook.ts`],
    ["-rc, the mutating letter last in the cluster", `xattr -rc /h/X.hook.ts`],
    ["-cr, the mutating letter FIRST in the cluster", `xattr -cr /h/X.hook.ts`],
    ["-dr, same shape with delete", `xattr -dr a /h/X.hook.ts`],
    ["-sw, a read modifier in front of a write", `xattr -sw a b /h/X.hook.ts`],
  ];
  test.each(mutating)("%s mutates", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  const reads: [string, string][] = [
    ["a bare invocation lists attributes", `xattr /h/X.hook.ts`],
    ["-l is long format", `xattr -l /h/X.hook.ts`],
    ["-p prints one attribute", `xattr -p com.apple.provenance /h/X.hook.ts`],
    ["-lr", `xattr -lr /h/X.hook.ts`],
    ["-x is hex output", `xattr -x /h/X.hook.ts`],
    ["-rsv are all modifiers", `xattr -rsv /h/X.hook.ts`],
    // This one CHANGES with this revision: `-[dws]` refused it. `-s` does not
    // mutate, so refusing it was a false positive — stated rather than
    // quietly dropped.
    ["-s alone acts on the link and reads", `xattr -s /h/X.hook.ts`],
  ];
  test.each(reads)("%s stays allowed", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: the cluster rule still needs a protected target", () => {
    expect(decideBashWrite("xattr -c /tmp/notes.md").blocked).toBe(false);
    expect(decideBashWrite("xattr -cr ~/Projects/x/README.md").blocked).toBe(false);
  });
});

/**
 * #1240: a heredoc fed to an INTERPRETER is a program, not a document.
 *
 * Pre-existing on `origin/main`, not introduced by #1175 — every witness
 * below was measured against `git show origin/main:lib/bash-write-guard.ts`
 * and reads ALLOW there, with no symlink and no `ln` anywhere.
 *
 * `stripHeredocs` deletes the body before every arm, and arm 3a only reads a
 * body back as shell when the segment also carries `-c`/`-e`. A
 * `bash <<'EOF'` segment carries neither, so the guard decided on the single
 * word `bash` while the program underneath wrote whatever it liked.
 *
 * The controls are the load-bearing half. A fix of "stop stripping heredocs"
 * passes every witness and reintroduces the 1,860-command over-blocking that
 * stripping exists to prevent, so a document heredoc, a `gh --body-file -`
 * heredoc and an interpreter heredoc writing a genuine fixture all assert
 * ALLOW.
 */
describe("#1240 WITNESS: a program handed to an interpreter on stdin", () => {
  const VICTIM = `${LIVE}/run/${STATE}`;
  const witnesses: [string, string][] = [
    ["bash", `bash <<'EOF'\necho '{}' > ${VICTIM}\nEOF`],
    ["sh", `sh <<'SH'\necho '{}' > ${VICTIM}\nSH`],
    ["zsh", `zsh <<'Z'\necho '{}' > ${VICTIM}\nZ`],
    ["an unquoted delimiter", `bash <<EOF\necho '{}' > ${VICTIM}\nEOF`],
    ["an indented terminator", `bash <<-'EOF'\n\techo '{}' > ${VICTIM}\n\tEOF`],
    ["a pipe into an interpreter", `cat <<'EOF' | bash\necho '{}' > ${VICTIM}\nEOF`],
    ["a path-spelled interpreter", `/bin/bash <<'EOF'\necho '{}' > ${VICTIM}\nEOF`],
    // Not in the issue's table, measured here: a HERESTRING reaches the same
    // interpreter by a route `heredocDelimiter` deliberately excludes
    // (#1184 — it has no terminator), and is allowed for the other half of
    // the mechanism: the `>` sits in a quoted span the VERB view removes.
    ["a herestring", `bash <<<"echo '{}' > ${VICTIM}"`],
    // A python body is not shell. Reading it as shell finds nothing, which
    // is why it needs arm 3's treatment — a declared write verb near the
    // name — rather than the shell recursion.
    ["python, which is not shell", `python3 <<'PY'\nopen("${VICTIM}", "w").write("{}")\nPY`],
    ["an ln inside the body, the originally reported case", `bash <<'EOF'\nln -s ${LIVE}/run /tmp/bw1240esc\necho '{}' > /tmp/bw1240esc/${STATE}\nEOF`],
  ];
  test.each(witnesses)("a write to a live artifact through %s is refused", (_n, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("CONTROL: a document heredoc keeps its exemption", () => {
    const cmd = `cat > /tmp/bw1240/notes.md <<'EOF'\necho '{}' > ${VICTIM}\nln -s a b\nEOF`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: a gh body heredoc still passes — pai-config#474's shape", () => {
    const cmd = `gh issue comment 1 --body-file - <<'EOF'\nThe guard refuses a write to ${STATE}\nEOF`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: an interpreter heredoc writing a FIXTURE is still allowed", () => {
    const cmd = `bash <<'EOF'\necho '{}' > /tmp/bw1240/${STATE}\nEOF`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: an interpreter heredoc that only READS is still allowed", () => {
    const cmd = `python3 <<'PY'\nimport json\nprint(json.load(open("${VICTIM}"))["phase"])\nPY`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  /**
   * The arm asks for an ABSOLUTE path, and that is measured rather than
   * cautious. Accepting a relative spelling newly refused 23 real commands
   * in the 5,602-command corpus, every one of them an agent building hook
   * FIXTURES in a `/tmp` tree with an assembled path: the only word carrying
   * `.hook.ts` is the relative suffix, which cannot be shown to be scratch,
   * so the fail-closed reading correctly declines to exempt it — and the
   * work #1175 exists to unblock would have been refused by the arm added
   * beside it. With the absolute requirement the same sweep newly blocks 15,
   * and all 15 write a live `workflow-state.json` in the run store.
   */
  test("a relative spelling in a body is not evidence of a protected artifact", () => {
    const assembled = `python3 <<'PY'\nimport os\nopen(os.path.join(dst, n + ".hook.ts"), "w").write("// stand-in")\nPY`;
    expect(decideBashWrite(assembled).blocked).toBe(false);
    // and the absolute spelling of the same write is refused, so the row
    // above is not passing because the arm is dead
    const absolute = `python3 <<'PY'\nopen("${LIVE}/hooks/X.hook.ts", "w").write("// stand-in")\nPY`;
    expect(decideBashWrite(absolute).blocked).toBe(true);
  });

  test("MECHANISM: only an interpreter's heredoc is returned as a program", () => {
    expect(interpreterPrograms(`bash <<'EOF'\nx\nEOF`).map(p => p.program)).toEqual(["x"]);
    expect(interpreterPrograms(`cat > f <<'EOF'\nx\nEOF`)).toEqual([]);
    expect(interpreterPrograms(`cat <<'EOF' | bash\nx\nEOF`).map(p => p.shell)).toEqual([true]);
    expect(interpreterPrograms(`python3 <<'PY'\nx\nPY`).map(p => p.shell)).toEqual([false]);
    // An UNTERMINATED heredoc is already visible to every arm (#1184 emits
    // it unchanged), so returning it here would decide the same bytes twice.
    expect(interpreterPrograms(`bash <<'EOF'\nx`)).toEqual([]);
  });
});

/**
 * #1269: a protected tree is subtracted under BOTH of its spellings.
 *
 * #1175 realpathed the scratch roots and not the protected trees, so a tree
 * named through a symlink — which `/tmp` is, on every macOS install — was
 * subtracted under one spelling and exempted under the other. The run store
 * was reachable by typing `realpath` once.
 *
 * Built against the real filesystem rather than asserted about strings: the
 * directory is created, so `realpathSync` has something to resolve, and the
 * two spellings are the two names of one inode rather than two literals
 * that happen to differ.
 */
describe("#1269 WITNESS: a protected tree is subtracted under both spellings", () => {
  const vars: string[] = ["RUNGATE_WORK_DIR", "RUNGATE_HOOKS_DIR"];
  test.each(vars)("%s named through a symlink is protected by its realpath too", (v: string) => {
    const dir = mkdtempSync(join("/tmp", "bw1269-"));
    const before = process.env[v];
    try {
      mkdirSync(join(dir, "p"), { recursive: true });
      process.env[v] = dir; // the /tmp spelling, which is how anyone types it
      const real = realpathSync(dir); // /private/tmp/... on macOS
      const artifact = v === "RUNGATE_HOOKS_DIR" ? "X.hook.ts" : STATE;

      // The premise: the two spellings really are different names. Without
      // this the case is vacuous on a filesystem where /tmp is not a link.
      if (real === dir) return;

      expect(isScratchPath(`${dir}/p/${artifact}`)).toBe(false);
      expect(isScratchPath(`${real}/p/${artifact}`)).toBe(false);
      expect(decideBashWrite(`echo '{}' > ${real}/p/${artifact}`).blocked).toBe(true);
    } finally {
      if (before === undefined) delete process.env[v];
      else process.env[v] = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a sibling scratch tree nothing points at is still a fixture", () => {
    const dir = mkdtempSync(join("/tmp", "bw1269-live-"));
    const other = mkdtempSync(join("/tmp", "bw1269-fix-"));
    const before = process.env.RUNGATE_WORK_DIR;
    try {
      process.env.RUNGATE_WORK_DIR = dir;
      // Both spellings of the UNRELATED tree stay exempt — the fix subtracts
      // one tree's two names, not every path that realpaths to /private/tmp.
      expect(isScratchPath(`${other}/${STATE}`)).toBe(true);
      expect(isScratchPath(`${realpathSync(other)}/${STATE}`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.RUNGATE_WORK_DIR;
      else process.env.RUNGATE_WORK_DIR = before;
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("CONTROL: a tree that does not exist keeps its resolved spelling", () => {
    const before = process.env.RUNGATE_WORK_DIR;
    try {
      // `realpathSync` throws here. The resolved name must still protect.
      process.env.RUNGATE_WORK_DIR = "/tmp/bw1269-never-created";
      expect(isScratchPath(`/tmp/bw1269-never-created/${STATE}`)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.RUNGATE_WORK_DIR;
      else process.env.RUNGATE_WORK_DIR = before;
    }
  });
});

/**
 * #1269 finding 2: arm 3's exemption asks about the whole body.
 *
 * Arm 3 refuses because an interpreter's program is OPAQUE — what it writes
 * cannot be read off the command line. Deciding the exemption from a single
 * path word contradicted that premise, because a destination can be
 * computed. Measured against the module as merged, one of three computed
 * spellings escaped; the other two happened to normalise back into the run
 * store, which is luck and not coverage.
 *
 * The stopgap this block was written for is GONE (#1277). The rows are kept
 * because the commands are still the right questions and all but one still
 * have the same answer; what decides them now is `bodyTargets`, which asks
 * whether the write target can be shown to be scratch rather than whether
 * every absolute literal is. The one row that moved is labelled REVERSED
 * and carries its own control.
 */
describe("#1269 WITNESS: a computed destination in an interpreter body", () => {
  const RUN = `${process.env.HOME}/.rungate/run`;

  test("a scratch literal rewritten into the run store is refused", () => {
    const cmd = `bun -e 'writeFileSync("/tmp/x/${STATE}".replace("/tmp/x", "${RUN}"), "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("the same shape with a hook file is refused", () => {
    const cmd = `bun -e 'writeFileSync("/tmp/x/X.hook.ts".replace("/tmp/x", "${LIVE}/hooks"), "")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  // The controls. Without these the rule could be "refuse every interpreter
  // body", which is the 1,760-of-5,060 over-blocking arm 3 exists past.
  test("CONTROL: a body naming only scratch paths is still a fixture", () => {
    const d = decideBashWrite(`bun -e 'writeFileSync("/tmp/fix/${STATE}", "{}")'`);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });

  test("CONTROL: two scratch paths are still a fixture", () => {
    const cmd = `python3 -I -c "import shutil; shutil.copy('/tmp/a/${STATE}', '/tmp/b/${STATE}')"`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("CONTROL: a literal run-store path was always refused", () => {
    expect(decideBashWrite(`bun -e 'writeFileSync("${RUN}/${STATE}", "{}")'`).blocked).toBe(true);
  });

  test("MECHANISM: punctuation that looks like a path is not one", () => {
    // `/` and the `//` of a comment are absolute-looking and are not paths.
    // Counting them ended the exemption for two real fixture commands on
    // the strength of a comment marker — 6 newly refused against 4.
    //
    // #1277 retired the reading that made this delicate: the rule no longer
    // asks anything about absolute-looking WORDS, only about complete
    // string literals, and `//` is not one. The row is kept because the
    // command is real and must stay allowed, not because the hazard is.
    const cmd = `bun -e '// build the fixture\nwriteFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  /**
   * REVERSED by #1277, deliberately — and NARROWED again by #1371, which is
   * the correction the first version of this row needed.
   *
   * The #1276 stopgap asked "is EVERY absolute literal in the body scratch",
   * so a `readFileSync` of an unrelated file ended the exemption for a
   * fixture write beside it. That is over-blocking: the second literal is a
   * READ, it carries no protected artifact, and it is not the destination.
   * Asking about the write TARGET instead allows it, and this row is that.
   *
   * What #1277 got wrong, and the push review caught, is WHICH extra literal
   * is harmless. It wrote this row with the extra literal inside the run
   * store, and bounded the widening with the control below — "the moment the
   * extra literal carries a protected artifact it is a target in its own
   * right". That bound runs through `ALL_PROTECTED`, which is a name list,
   * and a name list is the one thing the author of a command gets to choose
   * around. `$HOME/.rungate/run/notes` is in a live tree and spells nothing;
   * the next row writes the same shape and lands a copy in the run store.
   *
   * So the extra literal here is outside every live tree, which is the case
   * the reversal was actually for, and the two controls below bound it in
   * both of the directions it can be walked: by NAME and by TREE.
   */
  test("REVERSED: a non-scratch literal outside every live tree no longer ends the exemption", () => {
    const cmd = `bun -e 'readFileSync("${LIVE}/notes"); writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });

  test("CONTROL: the same shape where the extra literal IS an artifact still refuses", () => {
    const cmd = `bun -e 'readFileSync("${RUN}/${STATE}"); writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("CONTROL #1371: the same shape where the extra literal is in a LIVE TREE refuses", () => {
    // Spells no protected artifact, so the name-list control above cannot
    // see it. `/opt/bwprobe` and `$HOME/.rungate` differ in exactly one
    // property — whether `protectedTrees()` contains them — so this pair and
    // the REVERSED row above isolate that property and nothing else.
    const cmd = `bun -e 'readFileSync("${RUN}/notes"); writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  /**
   * The spellings that DO NOT need this fix, measured rather than assumed.
   * My first draft of this block asserted that a `$HOME`-assembled
   * destination escapes. It does not — the carrying word is
   * `/.rungate/run/workflow-state.json`, which is absolute and not scratch,
   * so the body already failed the all-scratch test. Three of the four
   * computed spellings I tried were refused on `origin/main` too, and only
   * the `.replace` of a scratch literal ever escaped:
   *
   *     env + absolute suffix          main BLOCK   variant BLOCK
   *     env var + absolute suffix      main BLOCK   variant BLOCK
   *     command substitution           main BLOCK   variant BLOCK
   *     replace of a scratch literal   main ALLOW   variant BLOCK   ← this fix
   */
  test("the computed spellings that were already refused stay refused", () => {
    const run = `${process.env.HOME}/.rungate/run`;
    for (const cmd of [
      `bun -e 'writeFileSync(process.env.HOME + "/.rungate/run/${STATE}", "{}")'`,
      `bun -e 'writeFileSync(process.env.RUNGATE_WORK_DIR + "/${STATE}", "{}")'`,
      `bun -e 'writeFileSync("$(echo ${run})/${STATE}", "{}")'`,
    ]) {
      expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
    }
  });

  /**
   * KNOWN LIMITATION, asserted so it is visible and goes red the day it is
   * closed. It is NOT the exemption's doing and resolving the write target
   * would not close it either: when the artifact NAME is assembled from
   * pieces, `pathWordsContaining` finds no word carrying it, so arm 3 never
   * gets a candidate to judge. Pre-existing — `origin/main` allows this row
   * identically. Recorded here because the row next to it could otherwise
   * be read as "computed destinations are handled".
   */
  test("LIMITATION: an assembled artifact NAME is invisible to every arm", () => {
    const cmd = `python3 -c "import os; open(os.environ['RUNGATE_WORK_DIR'] + os.sep + 'workflow' + '-state.json','w').write('{}')"`;
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });
});

/**
 * #1277: the exemption is decided on the resolved write TARGET, not on a
 * path literal somewhere in the command.
 *
 * ## What was broken to make these fail
 *
 * Nothing had to be broken. All four WITNESS rows below were ALLOWED by
 * `origin/main` (`e17bacf6`) and are refused here — run before the fix, with
 * the four CONTROL rows green in the same run, so the reds are the escape
 * and not a module that stopped loading.
 *
 * Two of the four are the spelling #1276's stopgap was written for, reached
 * by routes it does not cover: a heredoc, which had no body gate at all, and
 * a `.replace` whose replacement is not a literal, so the "is every absolute
 * literal scratch" question answers yes and the write still lands in the run
 * store. That is the class #1277 predicted and the reason the stopgap
 * labelled itself one.
 *
 * ## The population, enumerated rather than asserted to be unchanged
 *
 * Swept over this machine's transcripts — 23,905 files, 50,189 unique Bash
 * commands, 1,843 of them naming a protected artifact:
 *
 *     newly blocked   0
 *     newly allowed   2      both real `/tmp` fixture builds; see REVERSED above
 *
 * A `0` in the blocked column is the reading `.claude/rules/
 * checks-must-be-able-to-fail.md` calls an instrument reporting nothing, so
 * here is what the instrument DID see, at the level the change operates on.
 * Of 531 non-shell interpreter segments in that corpus:
 *
 *     exempt before   15        exempt after    7
 *     lost exemption  11        gained          3
 *     a carrying literal consumed by an expression      235
 *     a body that does not read as complete literals     10
 *     no literal carrying a protected artifact          182
 *
 * So the fragment mechanism is exercised 235 times by real commands, and in
 * every one of them `origin/main` already refused for another reason — which
 * is why the command-level column is 0 and why that 0 is not blindness. The
 * four witnesses are synthesised because no agent on this machine has yet
 * written the escape; that is the same position #1270 was in.
 */
describe("#1277 WITNESS: a computed destination that leaves no non-scratch literal", () => {
  const RUN2 = `${process.env.HOME}/.rungate/run`;
  const escapes: [string, string][] = [
    [
      "a heredoc, which had no body gate at all",
      `python3 <<'PY'\nopen("/tmp/x/${STATE}".replace("/tmp/x", "${RUN2}"), "w").write("{}")\nPY`,
    ],
    [
      "a -e body whose replacement is an env var, not a literal",
      `bun -e 'writeFileSync("/tmp/x/${STATE}".replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'`,
    ],
    [
      "a -c body whose replacement is expanduser, so no literal is absolute",
      `python3 -I -c "import os; open('/tmp/x/${STATE}'.replace('/tmp/x', os.path.expanduser('~/.rungate/run')),'w').write('{}')"`,
    ],
    [
      "the witnesses DIRECTORY, where there is no basename to compare",
      `bun -e 'writeFileSync("/tmp/x/witnesses/ac-1.json".replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'`,
    ],
  ];

  test.each(escapes)("%s is refused", (_n, cmd) => {
    expect(decideBashWrite(cmd).blocked, cmd).toBe(true);
  });

  /**
   * The guard's own VIEW of the input, not just its verdict.
   *
   * A verdict-only case cannot tell "refused because the literal is a
   * fragment" from "refused because something upstream mangled the command",
   * and the second is how a detector ends up narrower than its own test.
   */
  test("MECHANISM: the carrying literal is reported as a FRAGMENT, not as a target", () => {
    const body = programBody(
      `bun -e 'writeFileSync("/tmp/x/${STATE}".replace("/tmp/x", process.env.RUNGATE_WORK_DIR), "{}")'`,
    );
    const t = bodyTargets(body);
    // The literal reached the reader intact and un-normalised...
    expect(t.fragments).toEqual([`/tmp/x/${STATE}`]);
    // ...and it is scratch, so the refusal is NOT "the path was elsewhere".
    // It is "this literal is not the destination", which is the whole change.
    expect(isScratchPath(`/tmp/x/${STATE}`)).toBe(true);
    expect(t.targets).toEqual([]);
    expect(t.unreadable).toBe(false);
  });

  test("MECHANISM: a literal nothing transforms is reported as a target", () => {
    const t = bodyTargets(programBody(`bun -e 'writeFileSync("/tmp/fix/${STATE}", "{}")'`));
    expect(t.targets).toEqual([`/tmp/fix/${STATE}`]);
    expect(t.fragments).toEqual([]);
  });

  /**
   * The raw spelling must survive to the guard, or the fixture is lying.
   *
   * `join()` and `resolve()` normalise `.` and `..` away. A case asserting
   * that a climbing path is refused proves nothing if something normalised
   * it before the guard saw it — so this asserts the UNNORMALISED text is
   * what `bodyTargets` reports, and only then that resolution refuses it.
   */
  test("MECHANISM: the reader receives the raw spelling, and resolution is what refuses", () => {
    const raw = `/tmp/../opt/bwprobe/${STATE}`;
    const cmd = `bun -e 'writeFileSync("${raw}", "{}")'`;
    const t = bodyTargets(programBody(cmd));
    expect(t.targets).toEqual([raw]); // the `..` is still there
    expect(t.targets[0]).toContain("/../"); // said twice, because this is the premise
    expect(isScratchPath(raw)).toBe(false); // resolution, not spelling, decides
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  test("MECHANISM: a target under a symlink out of scratch is resolved, not trusted", () => {
    // `/tmp` and not `tmpdir()`, and that is not cosmetic. On this machine
    // `tmpdir()` is a 49-character `/var/folders/…` path, which pushes the
    // body's write VERB more than `writesNear`'s 80-character window away
    // from the artifact name — so the first draft of this case went green
    // for a reason that had nothing to do with symlinks. The window is
    // pre-existing and is reported separately; this row must not depend on
    // it in either direction.
    const dir = mkdtempSync(join("/tmp", "bw1277-"));
    const link = join(dir, "esc");
    try {
      // Positive control first: a plain name in the same directory IS
      // exempt, so a red below is about the link and not about the tree.
      expect(decideBashWrite(`bun -e 'writeFileSync("${join(dir, STATE)}", "{}")'`).blocked).toBe(false);
      symlinkSync("/usr", link); // stands in for the run store: exists, not scratch
      const through = join(link, STATE);
      expect(bodyTargets(programBody(`bun -e 'writeFileSync("${through}", "{}")'`)).targets).toEqual([through]);
      expect(decideBashWrite(`bun -e 'writeFileSync("${through}", "{}")'`).blocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MECHANISM: programBody keeps inner quoting, which dequote destroys", () => {
    const seg = `bun -e 'writeFileSync("/tmp/fix/${STATE}", "{}")'`;
    expect(programBody(seg)).toBe(`writeFileSync("/tmp/fix/${STATE}", "{}")`);
    // The view the exemption used to be decided on. With no quotes in it
    // there is no boundary between a literal and the expression consuming
    // it, which is why the `.replace` spelling was invisible: the carrying
    // WORD is `/tmp/x/workflow-state.json.replace`, and it is scratch.
    expect(dequote(seg)).not.toContain('"');
    expect(isScratchPath(`/tmp/x/${STATE}.replace`)).toBe(true);
  });
});

describe("#1277 CONTROL: the fixture shapes #1175 exists to unblock", () => {
  const ok: [string, string][] = [
    ["a node fixture", `bun -e 'writeFileSync("/tmp/fix/${STATE}","{}")'`],
    ["a python fixture", `python3 -I -c "import json; json.dump({}, open('/tmp/fix/${STATE}','w'))"`],
    ["two scratch paths", `python3 -I -c "import shutil; shutil.copy('/tmp/a/${STATE}', '/tmp/b/${STATE}')"`],
    ["a heredoc fixture", `python3 <<'PY'\nopen("/tmp/fix/${STATE}", "w").write("{}")\nPY`],
  ];
  test.each(ok)("%s stays allowed", (_n, cmd) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, `refused: ${d.reason}`).toBe(false);
  });

  /**
   * The list row, moved out of the table above and made to say what it
   * witnesses, which is no longer the exemption.
   *
   * A list element is an argument of no call, so `inWritePosition` reports
   * it as a fragment and the body is UNPROVEN. The command stays allowed
   * for the same reason the dict row below does — `writesNear` cannot see
   * `open(p,'w')` in the dequoted view — and an `allowed` assertion on its
   * own would certify an exemption that is gone. Sixth shape, twice in one
   * describe, both found by asking the guard what it saw.
   */
  test("COST of #1371: the list row is allowed by a DIFFERENT mechanism too", () => {
    const cmd = `python3 -I -c "for p in ['/tmp/a/${STATE}', '/tmp/b/${STATE}']: open(p,'w')"`;
    const t = bodyTargets(programBody(cmd));
    expect(t.targets).toEqual([]);
    expect(t.fragments).toEqual([`/tmp/a/${STATE}`, `/tmp/b/${STATE}`]);
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  /**
   * The two rows #1371 COSTS, kept and inverted rather than deleted, which
   * is the same treatment #1277 gave the row it reversed.
   *
   * A literal bound to a name was recorded as a write target and nothing
   * followed the name afterwards. `inWritePosition` answers it: a binding
   * at statement level is an argument of no call, so it is not a write
   * position, and a body that binds a scratch path before writing it is
   * UNPROVEN rather than exempt. Measured over the corpus in the #1371
   * block below, and these two rows are the shape of what it costs.
   *
   * An earlier round answered it by dropping `=` and `:` from `ARG_OPENS`.
   * That is reverted: it decided the same question as `inWritePosition`,
   * and keeping both would be two deciders — see `ARG_OPENS` for the
   * measurement that proved they were.
   *
   * They are stated as refusals so the cost is visible in the suite. A
   * quieter repair — delete the rows — would leave the next reader of this
   * block believing the exemption still covers an assignment.
   */
  test("COST of #1371: a scratch path assigned before use is now refused", () => {
    const cmd = `python3 -I -c "p = '/tmp/fix/${STATE}'; open(p,'w').write('{}')"`;
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  /**
   * The dict row is the SIXTH SHAPE in
   * `.claude/rules/checks-must-be-able-to-fail.md` — green on the signal,
   * witnessing the wrong mechanism — and it reads as a survivor until you
   * ask the guard what it saw. It is allowed both before and after #1371,
   * and for different reasons:
   *
   *   before  the literal stood alone, was scratch, and the body was exempt
   *   after   the literal is an entry in a dict, so it is in no write
   *           position and is a FRAGMENT — and the command survives only
   *           because the verb is invisible: `writesNear` reads the
   *           DEQUOTED view, and `WRITE_INTENT`'s `open(…,'w')` alternative
   *           needs the quotes `dequote` has just removed
   *
   * So this row must assert the mechanism, not the verdict. If it asserted
   * only `allowed` it would certify an exemption that no longer exists.
   */
  test("COST of #1371: the dict row is allowed by a DIFFERENT mechanism, not by the exemption", () => {
    const cmd = `python3 -I -c "d = {'dst': '/tmp/fix/${STATE}'}; open(d['dst'],'w')"`;
    const t = bodyTargets(programBody(cmd));
    expect(t.targets).toEqual([]); // the exemption is gone...
    expect(t.fragments).toEqual([`/tmp/fix/${STATE}`]);
    // ...and what allows the command is the verb vanishing with the quotes.
    expect(dequote(cmd)).toContain(`open(d[dst],w)`);
    expect(decideBashWrite(cmd).blocked).toBe(false);
  });

  test("a mutating find keeps the plain exemption — its operands are shell words", () => {
    // `find` has no source literals, so a reader of them would refuse every
    // one. The target question is already asked of its operands directly.
    expect(decideBashWrite(`find /tmp/fix -name '*.json' -exec rm /tmp/fix/${STATE} ;`).blocked).toBe(false);
    expect(decideBashWrite(`find /tmp/fix -name '*.json' -exec rm ${LIVE}/run/${STATE} ;`).blocked).toBe(true);
  });

  test("a shell -c body keeps the plain exemption — arm 3a re-enters it as shell", () => {
    expect(decideBashWrite(`bash -c 'echo x > /tmp/fix/${SALT}'`).blocked).toBe(false);
    expect(decideBashWrite(`bash -c 'echo x > ${LIVE}/run/${SALT}'`).blocked).toBe(true);
  });
});

describe("#1277: the cheapest wrong fixes, run rather than described", () => {
  const RUN3 = `${process.env.HOME}/.rungate/run`;

  test("the stopgap it replaces exempts two of the four witnesses", () => {
    // #1276's rule, re-implemented here rather than described, so the claim
    // that it leaves the class open is executed.
    const stopgap = (bare: string) => {
      const words = bare.split(/[\s'"`,;(){}[\]]+/).filter(w => /^\/[^/]/.test(w));
      return words.length > 0 && words.every(isScratchPath);
    };
    const envVar = `bun -e writeFileSync(/tmp/x/${STATE}.replace(/tmp/x, process.env.RUNGATE_WORK_DIR), {})`;
    const witnessDir = `bun -e writeFileSync(/tmp/x/witnesses/ac-1.json.replace(/tmp/x, process.env.RUNGATE_WORK_DIR), {})`;
    expect(stopgap(envVar)).toBe(true); // exempt under the stopgap
    expect(stopgap(witnessDir)).toBe(true);
    // and the literal the stopgap was built for is caught by it, so the two
    // rows above are the CLASS it left open rather than a misreading of it
    expect(stopgap(`bun -e writeFileSync(/tmp/x/${STATE}.replace(/tmp/x, ${RUN3}), {})`)).toBe(false);
  });

  test("a denylist of transforming operators passes the witness and fails on the next operator", () => {
    // The tempting repair: refuse a literal followed by one of the ways to
    // compute a path. It answers the four witnesses, and it is a detector
    // narrower than what it detects — the fifth spelling walks through.
    const TRANSFORMS = /^\s*(?:\.\w+\s*\(|\+|%)/;
    const after = (body: string, lit: string) => body.slice(body.indexOf(lit) + lit.length + 1);
    const caught = `writeFileSync("/tmp/x/${STATE}".replace("/tmp/x", d), "{}")`;
    expect(TRANSFORMS.test(after(caught, `/tmp/x/${STATE}`))).toBe(true);
    // Python's pathlib. Not a `.replace`, not a `+`, not a `%`.
    const escapes = `open(Path("/tmp/x/${STATE}") .relative_to("/tmp/x") , "w")`;
    expect(TRANSFORMS.test(after(escapes, `/tmp/x/${STATE}`))).toBe(false); // the denylist allows it
    // The closed-world reading does not care which operator it is: the
    // literal is not followed by an argument delimiter, so it is a fragment.
    const t = bodyTargets(escapes);
    expect(t.targets).toEqual([]);
    expect(t.fragments).toEqual([`/tmp/x/${STATE}`]);
  });

  test("an unterminated literal is UNREADABLE, not an empty reading", () => {
    // A body whose quoting does not close gives every boundary after it as a
    // guess. Reporting no targets would read identically to a body with no
    // protected literal in it, and that reading exempts nothing either way —
    // so the flag exists to keep the two states tellable apart.
    const t = bodyTargets(`writeFileSync("/tmp/fix/${STATE}", "{}`);
    expect(t.unreadable).toBe(true);
    expect(decideBashWrite(`bun -e 'writeFileSync("/tmp/fix/${STATE}", "{}'`).blocked).toBe(true);
  });
});

/**
 * #1371: the push security review of #1277, answered over three rounds, and
 * the reason each round needed the next one.
 *
 * ## Why these are written by hand
 *
 * #1277 swept 50,189 unique real commands and reported 0 newly blocked and 2
 * newly allowed. That sweep is sound and it is a REGRESSION control: it
 * proves the change did not break what people do. It is structurally
 * incapable of proving the guard cannot be walked around, because the inputs
 * that walk around it are absent from a historical corpus by construction —
 * an honest caller never writes them, which is exactly who they are worth
 * something to. Every row below is in that gap.
 *
 * ## The rounds, and what each one got wrong
 *
 * **Round 1** found that `targets.every(isScratchPath)` quantified over a set
 * filtered by `ALL_PROTECTED`, so a literal spelling no protected basename
 * was never asked anything. Two of its five witnesses were REGRESSIONS —
 * refused by `origin/main`, allowed by `643e3053`.
 *
 * **Round 2** was the AI review, and it found that `standsAlone` treated a
 * newline as the end of the expression: #1277's own headline witness came
 * back ALLOWED with one line break inserted before the `.replace`. A
 * detector a reformat defeats.
 *
 * **Round 3** found that round 1's repair had reintroduced the defect it was
 * the repair for, one layer in. `literalInProtectedTree` opened with
 * `if (!value.startsWith('/')) return false`, so `~/…`, `$HOME/…` and
 * `${HOME}/…` took a silent skip that the caller read as "not protected"
 * rather than "I could not place this". It also asked for the rebinding
 * question to be answered by POSITION rather than by delimiter.
 *
 * ## What decides it now, and why these five and not more
 *
 *     IN_LIVE_TREE      a literal resolving inside protectedTrees(), through
 *                       no name list, with `~`/`$HOME` expanded first
 *     CANNOT_PLACE      a path-shaped literal with an expansion we cannot
 *                       perform — fail closed, because a false "unplaceable"
 *                       costs a refused exemption and a false "elsewhere"
 *                       costs a bypass
 *     inWritePosition   a target must be a direct argument of a recognised
 *                       write call: a whitelist of POSITIONS, where an
 *                       unanticipated transform fails closed by not being a
 *                       recognised position
 *     standsAlone       nothing adjacent to the literal consumes it
 *
 * A sixth was asked for and is NOT shipped: case-folding the live-tree
 * comparison. The mutation battery refused to witness it — see
 * `placeLiteral` — because the resolution step already canonicalises case.
 *
 * `inWritePosition` subsumed two cheaper repairs that were in the branch and
 * are now gone: dropping `=`/`:` from `ARG_OPENS`, and the proposed drop of
 * `:` from `ARG_CLOSES`. Keeping either beside it would be two deciders
 * answering one question — and the measurement that proves they were is in
 * `ARG_OPENS`'s own docblock: with `inWritePosition` in place, restoring
 * `=` and `:` moves nothing at all.
 *
 * ## The population, re-swept
 *
 * All variants evaluated on ONE corpus, which is the control that makes the
 * comparison mean anything: 32,023 transcript files, 132,196 unique Bash
 * commands, 5,738 naming a protected artifact. That is 2.6x the file count
 * #1277 swept and its columns come out at ~2x #1277's throughout.
 *
 *     e17bacf6 -> 643e3053    newly blocked 0    newly allowed 4
 *     e17bacf6 -> this        newly blocked 0    newly allowed 4
 *     643e3053 -> this        newly blocked 0    newly allowed 0
 *
 *     exempt   e17bacf6 29    643e3053 14    round 2  13    this 12
 *
 * With five refusals stacked, the failure that costs us is no longer a
 * bypass — it is an exemption that silently never applies again, and every
 * refusal row stays green through exactly that. So `exempt > 0` is the
 * reading that matters most, the CONTROL rows below are the load-bearing
 * half of this block, and each new refusal is paired with one.
 *
 * One width was measured and REJECTED, and the number is the argument.
 * Treating a relative path-shaped literal as unplaceable costs 7 real
 * commands and takes the exemption population from 13 segments to 6, because
 * `'hornjason/pai-config'` and `'./lib/x.ts'` are slash-bearing and are not
 * paths. It does not even close the class it was widened for: `'.'` and
 * `'x'` carry no slash. `inWritePosition` is the closure that works, because
 * it asks only about the literals a write actually consumes.
 */
describe("#1371 WITNESS: the exemption granted against a value the write never uses", () => {
  const RUN4 = `${process.env.HOME}/.rungate/run`;
  const CLAUDE = `${process.env.HOME}/.claude/agents`;
  const SHOUTED = `${(process.env.HOME ?? "").toUpperCase()}/.rungate/run`;
  // Whether the SHOUTED spelling names the SAME FILE is the filesystem's
  // answer, not ours, so the row asks the filesystem. `existsSync` on the
  // uppercase HOME is deliberately NOT the call the guard makes — the guard
  // reaches `realpathSync` through `resolveThroughLinks`, and a probe using
  // the guard's own call would agree with it by construction.
  //
  // This row shipped asserting `blocked: true` unconditionally and CI went
  // red: on the Linux runner `/HOME/RUNNER/.rungate/run` does not exist and
  // is not the artifact, so allowing it is correct. The expectation now
  // tracks the volume, which makes the row a differential detector in both
  // directions — a blind `.toLowerCase()` fold reddens it on Linux, and
  // losing the resolution step reddens it on macOS.
  const CASE_FOLDS = process.env.HOME ? existsSync(process.env.HOME.toUpperCase()) : false;
  // Built rather than written: `${HOME}` in a template literal interpolates,
  // which would substitute the fixture away before the guard ever saw it.
  const DOLLAR_HOME = "$" + "{HOME}";

  /**
   * Every spelling this block decides, in one table, so the population
   * assertions range over a set nobody can quietly add to.
   *
   * No fixture reaches a shell. `decideBashWrite` is called with the command
   * as literal bytes, and `join()`/`resolve()` are never applied to a fixture
   * path — a MECHANISM row asserts the raw spelling survives to `bodyTargets`,
   * because a case about path spelling that lets something normalise the path
   * first is asserting nothing.
   */
  /**
   * Every row below carries a REAL fixture write — `open('/tmp/fix/…','w')`
   * — beside the interesting literal, and that is load-bearing rather than
   * decorative (#1411).
   *
   * These were `shutil.copy('/tmp/fix/…', '<the interesting path>')` until
   * the destination-index map landed. A copy's SOURCE is no longer a
   * target, so every one of them became a body with NO proven destination
   * and was refused by `targets.length === 0` — the same verdict, attributed
   * to an arm that has nothing to do with live trees or unplaceable values.
   * The mutation battery said so immediately: `noLive` and `noPlace` both
   * moved nothing, which is the fourth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md` arriving by interaction
   * rather than by design.
   *
   * With a genuine scratch destination present the exemption is live again,
   * so the live-tree and unplaceable readings are the only thing standing
   * between the body and an exemption — and that is also the realistic
   * shape of the attack: a legitimate fixture write with one extra copy
   * tucked beside it.
   */
  const FIXTURE = `open('/tmp/fix/${STATE}','w').write('{}')`;
  const rows: { label: string; cmd: string; blocked: boolean }[] = [
    {
      label: "L1 a copy into the live run-store DIRECTORY, which spells no artifact",
      cmd: `python3 -I -c "import shutil; ${FIXTURE}; shutil.copy(src, '${RUN4}')"`,
      blocked: true,
    },
    {
      label: "L2 the same shape into another live tree",
      cmd: `python3 -I -c "import shutil; ${FIXTURE}; shutil.copy(src, '${CLAUDE}')"`,
      blocked: true,
    },
    {
      label: "L3 the same hole reached through a heredoc",
      cmd: `python3 <<'PY'\nimport shutil\nopen("/tmp/fix/${STATE}", "w").write("{}")\nshutil.copy(src, "${RUN4}")\nPY`,
      blocked: true,
    },
    {
      label: "L4 the tilde spelling, which the absolute-path precondition skipped",
      cmd: `python3 -I -c 'import os, shutil; open("/tmp/fix/${STATE}","w").write("{}"); shutil.copy(src, os.path.expanduser("~/.rungate/run"))'`,
      blocked: true,
    },
    {
      label: "L5 the ${HOME} spelling, same skip",
      cmd: `python3 -I -c 'import os, shutil; open("/tmp/fix/${STATE}","w").write("{}"); shutil.copy(src, os.path.expandvars("${DOLLAR_HOME}/.rungate/run"))'`,
      blocked: true,
    },
    {
      // Held by the RESOLUTION, not by a case fold. The review asked for
      // folding; a fold mutant could not witness it, because
      // `resolveThroughLinks` climbs to `/USERS` and `realpathSync` hands
      // back `/Users`. The fold is not shipped and `placeLiteral` says why.
      // On a case-SENSITIVE volume this is a different path and allowing it
      // is the right answer — see CASE_FOLDS above.
      label: "L6 the same tree SHOUTED, decided by what the VOLUME calls one file",
      cmd: `python3 -I -c "import shutil; ${FIXTURE}; shutil.copy(src, '${SHOUTED}')"`,
      blocked: CASE_FOLDS,
    },
    {
      label: "P1 an expansion the reader cannot perform is UNPLACEABLE, not elsewhere",
      cmd: `python3 -I -c 'import os, shutil; open("/tmp/fix/${STATE}","w").write("{}"); shutil.copy(src, os.path.expandvars("$RG/live"))'`,
      blocked: true,
    },
    {
      label: "P2 the same with the variable INSIDE an otherwise absolute path",
      cmd: `python3 -I -c 'import os, shutil; open("/tmp/fix/${STATE}","w").write("{}"); shutil.copy(src, os.path.expandvars("/tmp/$RG/../live"))'`,
      blocked: true,
    },
    {
      // One line, on purpose. The multi-line spelling of this is held up by
      // the whitespace rule as well, and a row two deciders answer cannot
      // say which one is load-bearing — the fourth shape. The `;` makes the
      // binding the only thing under test, and the equality below is what
      // caught the multi-line version being double-covered.
      label: "W1 a scratch literal bound to a name, then reassigned before the write",
      cmd: `python3 -I -c "import os; p = '/tmp/fix/${STATE}'; p = p.replace('/tmp/fix', os.environ['RG']); open(p,'w').write('{}')"`,
      blocked: true,
    },
    {
      label: "W2 the same reassignment through a dict value",
      cmd: `bun -e 'const d = {dst: "/tmp/fix/${STATE}"}; d.dst = process.env.RG + "/w"; writeFileSync(d.dst, "{}")'`,
      blocked: true,
    },
    {
      label: "W3 a literal that is an inner call's DEFAULT, not the destination",
      cmd: `python3 -I -c "import os; open(os.environ.get('RG', '/tmp/fix/${STATE}'), 'w').write('{}')"`,
      blocked: true,
    },
    {
      label: "N1 the #1277 headline escape with one newline before the .replace",
      cmd: `bun -e 'writeFileSync("/tmp/x/${STATE}"\n  .replace("/tmp/x", process.env.RG), "{}")'`,
      blocked: true,
    },
    {
      label: "N2 the same line break in a python heredoc",
      cmd: `python3 <<'PY'\nimport os\nopen("/tmp/x/${STATE}"\n     .replace("/tmp/x", os.environ["RG"]), "w").write("{}")\nPY`,
      blocked: true,
    },

    // ----- #1411's push review, each run as a witness before it was fixed.
    // All three were real; the verdict each had before the fix is in the
    // commit message and in the arm's own docblock.
    {
      // `:` is an ARG_OPEN, so the FALSE branch read as a complete argument
      // and the walk ran past `?` to `writeFileSync`'s own paren.
      label: "T1 a ternary FALSE branch, where the destination is a name",
      cmd: `bun -e 'writeFileSync(x ? d : "/tmp/fix/${STATE}", "{}")'`,
      blocked: true,
    },
    {
      // The same expression with the branches swapped was ALREADY refused,
      // because `?` is not an ARG_OPEN and the literal fell out as a
      // fragment. One spelling fail-closed by accident, the other not —
      // that asymmetry is what made the hole hard to see.
      label: "T2 the same ternary with the branches swapped, refused before and after",
      cmd: `bun -e 'writeFileSync(x ? "/tmp/fix/${STATE}" : d, "{}")'`,
      blocked: true,
    },
    {
      // P1 with ONE character removed. `"$RG"` carries no slash, so a slash
      // test in front of UNPLACEABLE answered `elsewhere` — placed, and not
      // protected — for a value nothing had placed. The pair is the whole
      // argument for the swap: P1 moves under `noPlace`, this moves under
      // `noPlace` AND `noOrder`, and nothing else separates them.
      label: "U1 the same expansion with NO slash in the variable",
      cmd: `python3 -I -c 'import os, shutil; open("/tmp/fix/${STATE}","w").write("{}"); shutil.copy(src, os.path.expandvars("$RG"))'`,
      blocked: true,
    },
    {
      // Recognising the callee was not enough: the scratch literal is the
      // SOURCE and the destination is a name nothing tracks.
      label: "D1 a scratch literal in shutil.copy's SOURCE slot, destination a name",
      cmd: `python3 -I -c 'import shutil; shutil.copy("/tmp/fix/${STATE}", dest)'`,
      blocked: true,
    },
    {
      // `json.dump` writes to a file object. No argument of it is ever a
      // destination path, so a literal there is data.
      label: "D2 a literal as json.dump's object, which is never a destination",
      cmd: `python3 -I -c 'import json; json.dump("/tmp/fix/${STATE}", f)'`,
      blocked: true,
    },
    {
      // Written as "the COST of T1" and the battery disagreed: it moves
      // under neither `noTernary` nor `noPos`, because the TRUE branch
      // literal is preceded by `?`, which is not an ARG_OPEN, so
      // `standsAlone` refused this shape long before #1411 did. The cost of
      // T1 is therefore ZERO on this row, and the label says what the
      // measurement said rather than what the fix's author expected.
      label: "T3 a ternary with two scratch branches, already refused by standsAlone",
      cmd: `bun -e 'writeFileSync(cond ? "/tmp/a/${STATE}" : "/tmp/b/${STATE}", "{}")'`,
      blocked: true,
    },

    // ----- CONTROLS. With five stacked refusals these are the load-bearing
    // half: an exemption that never applies again passes every witness above.
    { label: "C1 a node fixture", cmd: `bun -e 'writeFileSync("/tmp/fix/${STATE}","{}")'`, blocked: false },
    {
      label: "C2 a python fixture",
      cmd: `python3 -I -c "import json; json.dump({}, open('/tmp/fix/${STATE}','w'))"`,
      blocked: false,
    },
    {
      label: "C3 two scratch paths, the second closing the call",
      cmd: `python3 -I -c "import shutil; shutil.copy('/tmp/a/${STATE}', '/tmp/b/${STATE}')"`,
      blocked: false,
    },
    {
      label: "C4 a heredoc fixture",
      cmd: `python3 <<'PY'\nopen("/tmp/fix/${STATE}", "w").write("{}")\nPY`,
      blocked: false,
    },
    {
      label: "C5 a non-scratch read OUTSIDE every live tree, beside a fixture write",
      cmd: `bun -e 'readFileSync("${LIVE}/notes"); writeFileSync("/tmp/fix/${STATE}", "{}")'`,
      blocked: false,
    },
    {
      label: "C6 the pathlib spelling the denylist wrong-fix lets through",
      cmd: `python3 -I -c "from pathlib import Path; Path('/tmp/x/${STATE}').relative_to('/tmp')"`,
      blocked: false,
    },
    {
      label: "C7 an ordinary multi-line fixture, where the literal opens a line",
      cmd: `bun -e 'writeFileSync(\n  "/tmp/fix/${STATE}",\n  "{}"\n)'`,
      blocked: false,
    },
    {
      // The negative control for the expansion half. Expanding `~` must not
      // mean refusing every `~`, or L4 is passing on a refusal of the
      // character rather than on where it points.
      label: "C8 a tilde path OUTSIDE every live tree, beside a fixture write",
      cmd: `bun -e 'readFileSync("~/Projects/notes"); writeFileSync("/tmp/fix/${STATE}", "{}")'`,
      blocked: false,
    },
    {
      // The negative control for the placement half, and the row that the
      // rejected wide reading turns red. A repo slug is slash-bearing and is
      // not a path.
      label: "C9 a slash-bearing literal that is not a path at all",
      cmd: `python3 -I -c "import json; json.dump({'repo': 'hornjason/pai-harness'}, open('/tmp/fix/${STATE}','w'))"`,
      blocked: false,
    },
    {
      // The negative control for `inWritePosition`. A direct argument of a
      // recognised write call is still a target, through a dotted callee.
      label: "C10 a dotted write callee still yields a target",
      cmd: `bun -e 'const fs = require("fs"); fs.writeFileSync("/tmp/fix/${STATE}", "{}")'`,
      blocked: false,
    },
    {
      // The negative control for U1. Asking UNPLACEABLE first must not mean
      // refusing every short literal: a mode string carries no slash and no
      // `$`, and `open(path, "w")` is the commonest fixture write there is.
      label: "C11 a mode string, which has no slash and is not unplaceable",
      cmd: `python3 -I -c 'open("/tmp/fix/${STATE}", "w").write("{}")'`,
      blocked: false,
    },
    {
      // The negative control for D1 and D2. The index map must pin the
      // destination, not refuse every call that has a source — this is the
      // #1175 fixture shape and three describes assert it.
      label: "C12 a copy whose DESTINATION slot is scratch is still a fixture",
      cmd: `python3 -I -c 'import shutil; shutil.copy(src, "/tmp/b/${STATE}")'`,
      blocked: false,
    },
  ];

  test.each(rows.map(r => [r.label, r.cmd, r.blocked] as const))("%s", (_l, cmd, blocked) => {
    const d = decideBashWrite(cmd);
    expect(d.blocked, d.reason ?? cmd).toBe(blocked);
  });

  test("CONTROL: the exemption still applies to something", () => {
    // The one reading that cannot be satisfied by stacking refusals. If this
    // goes red, every witness above is green for the wrong reason.
    const exempt = rows.filter(r => !r.blocked && r.cmd.includes("/tmp/fix/"));
    expect(exempt.length).toBeGreaterThan(4);
    for (const r of exempt) expect(decideBashWrite(r.cmd).blocked, r.label).toBe(false);
  });

  test("MECHANISM: a live-tree literal is reported whatever it spells, and the filter was the defect", () => {
    const t = bodyTargets(programBody(`python3 -I -c "import shutil; shutil.copy('/tmp/fix/${STATE}', '${RUN4}')"`));
    // The run-store literal is invisible to the name-list halves — which is
    // round 1's finding: `targets.every(isScratchPath)` was `every` over a
    // set the command's author picks the membership of. `${RUN4}` spells no
    // protected basename, so neither list can hold it whatever position it
    // is in, and the scratch SOURCE is now classified `argument` — placed,
    // and placed somewhere that is not the write.
    expect(t.targets).toEqual([]);
    expect(t.fragments).toEqual([]);
    // And it is reported by the reading that goes through no name list.
    expect(t.protectedLiterals).toEqual([RUN4]);
    expect(t.unplaceable).toEqual([]);
  });

  test("MECHANISM: an unplaceable literal is its OWN reading, not folded into the protected one", () => {
    // Round 3's finding: the two were one boolean, and `false` read as "not
    // protected" rather than "I could not place this". Keeping them apart is
    // what makes the reason readable after the refusal.
    const t = bodyTargets(
      programBody(`python3 -I -c 'import os, shutil; shutil.copy("/tmp/fix/${STATE}", os.path.expandvars("$RG/live"))'`),
    );
    expect(t.unplaceable).toEqual(["$RG/live"]);
    expect(t.protectedLiterals).toEqual([]);
  });

  test("MECHANISM: a bound literal is not in a write position, so the body is UNPROVEN", () => {
    const body = programBody(
      `python3 -I -c "import os; p = '/tmp/fix/${STATE}'; p = p.replace('/tmp/fix', os.environ['RG']); open(p,'w').write('{}')"`,
    );
    const t = bodyTargets(body);
    expect(t.targets).toEqual([]);
    expect(t.fragments).toEqual([`/tmp/fix/${STATE}`]);
    // The refusal is "this binding is not shown to be the destination", not
    // "the path was elsewhere" — the literal is itself scratch.
    expect(isScratchPath(`/tmp/fix/${STATE}`)).toBe(true);
    expect(t.protectedLiterals).toEqual([]);
    expect(t.unplaceable).toEqual([]);
  });

  /**
   * The LEADING half of the whitespace rule, asserted as a reading and NOT
   * as a verdict, because no verdict claim was earned.
   *
   * Before round 2 a literal that OPENED a line stood alone whatever preceded
   * the break. No harmful instance of that exists that I could write — the
   * literal would have to be scratch, carry a protected artifact, and be the
   * right operand of a `+`, and a scratch absolute path is not a suffix of
   * anything. The half is kept for symmetry at a measured cost of 0, and this
   * row is the evidence that it does something rather than that it was needed.
   */
  test("MECHANISM: a literal opening a line after an operator is a fragment, not a target", () => {
    const t = bodyTargets(`writeFileSync(process.env.RG +\n  "/tmp/fix/${STATE}", "{}")`);
    expect(t.targets).toEqual([]);
    expect(t.fragments).toEqual([`/tmp/fix/${STATE}`]);
  });

  test("MECHANISM: the raw spelling survives to the reader; nothing normalises it first", () => {
    const raw = `/tmp/../opt/bwprobe/${STATE}`;
    // The raw spelling is the DESTINATION, not the source: since #1411 a
    // source literal is `argument` and reaches neither list, so putting it
    // there would assert the normalisation claim against an empty array.
    const cmd = `python3 -I -c "import shutil; shutil.copy('/tmp/b/${STATE}', '${raw}')"`;
    const t = bodyTargets(programBody(cmd));
    expect(t.targets).toContain(raw);
    expect(t.targets[0]).toContain("/../"); // said twice, because this is the premise
    expect(isScratchPath(raw)).toBe(false);
    expect(decideBashWrite(cmd).blocked).toBe(true);
  });

  /**
   * MUTATION: each decider removed, and the population asserted in BOTH
   * directions against the module with it removed.
   *
   * A battery showing only its new witnesses passing cannot be wrong about
   * what else moved — which is how round 1's findings reached a PR whose
   * author had enumerated the population, and how round 3's reached one
   * whose author had written a mutation battery.
   *
   * One mutant per decider, and the moved SET is asserted for each — an
   * equality, so a row that stops moving reddens it as loudly as a row that
   * starts. It is not free: W1 was written multi-line and came back held up
   * by the whitespace rule as well as by position, and the equality is what
   * said so.
   *
   * Rows are no longer one-to-one with mutants, and pretending otherwise
   * would be the lie (#1411). Three readings of the table:
   *
   *   moves under TWO   `noPos` is the top of the same walk `noTernary` and
   *                     `noIndex` sit inside, so T1/T3/D1/D2 move under it
   *                     as well; `noOrder` is strictly inside `noPlace`.
   *                     Each inner mutant is the one that ATTRIBUTES the
   *                     row — the outer one would move it whatever the
   *                     reason.
   *   moves under NONE  T2 and the C rows. A row refused before and after
   *                     by an arm nothing here mutates is a control, and
   *                     saying so beats inventing a mutant for it.
   *   moves under ONE   everything else, which is the set that carries the
   *                     attribution claims in the docblocks.
   */
  test("MUTATION: removing each decider moves exactly the rows it is responsible for", async () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib", "bash-write-guard.ts"), "utf8");
    const SITES = {
      // The live-tree reading, which is also where `~`/`$HOME` expansion lands.
      noLive: ["const IN_LIVE_TREE: Placement = 'protected';", "const IN_LIVE_TREE: Placement = 'elsewhere';"],
      // The fail-closed half: an unplaceable literal reads as ordinary again.
      noPlace: ["const CANNOT_PLACE: Placement = 'unplaceable';", "const CANNOT_PLACE: Placement = 'elsewhere';"],
      // The write-position whitelist: every position is a write position.
      noPos: [
        "function inWritePosition(body: string, start: number, spans: [number, number][]): Position {",
        "function inWritePosition(body: string, start: number, spans: [number, number][]): Position {\n  return IS_DESTINATION;",
      ],
      // The destination INDEX: any argument of a recognised write callee is
      // the destination again, which is exactly the pre-#1411 reading.
      noIndex: [
        "return index === destIndexOf(callee) ? IS_DESTINATION : 'argument';",
        "return IS_DESTINATION;",
      ],
      // The ternary stop: a branch of a conditional is a destination again.
      noTernary: ["} else if (c === '?') {", "} else if (c === '\\0') {"],
      // Not a mutation of a DECIDER but of the ORDER of two tests inside
      // one, and deliberately WEAKER than `noPlace`: anything it moves,
      // `noPlace` moves too. It is kept because it is the only mutation
      // that witnesses the swap rather than the test — `noPlace` moves the
      // slash-bearing spelling as well, which the old order already refused.
      noOrder: [
        `  if (UNPLACEABLE.test(expanded)) return CANNOT_PLACE;
  // Not path-shaped at all: a mode string, a JSON blob, a module name. The
  // exemption would never apply again if these ended it.
  if (!expanded.includes('/')) return 'elsewhere';`,
        `  if (!expanded.includes('/')) return 'elsewhere';
  if (UNPLACEABLE.test(expanded)) return CANNOT_PLACE;`,
      ],
      // Not "drop `\n` from WHITESPACE" — that mutation is STRICTER than the
      // code, so every row would hold and the battery would report nothing.
      // This restores the pre-round-2 `standsAlone` verbatim; the current
      // body is left in place under a dead name so the braces still close.
      noNL: [
        "function standsAlone(body: string, start: number, end: number): boolean {",
        `function standsAlone(body: string, start: number, end: number): boolean {
  let a = start - 1;
  while (a >= 0 && (body[a] === ' ' || body[a] === '\\t')) a--;
  if (a >= 0 && body[a] !== '\\n' && !ARG_OPENS.has(body[a])) return false;
  let b = end + 1;
  let out = 0;
  for (;;) {
    while (b < body.length && (body[b] === ' ' || body[b] === '\\t')) b++;
    if (b >= body.length) return true;
    const c = body[b];
    if (c === '\\n') { if (out === 0) return true; b++; continue; }
    if (GROUP_CLOSES.has(c)) { out++; b++; continue; }
    return ARG_CLOSES.has(c);
  }
}
function __standsAloneAfter(body: string, start: number, end: number): boolean {`,
      ],
    } as const;

    for (const [name, [site]] of Object.entries(SITES)) {
      expect(src.split(site).length - 1, `${name} must have ONE site to mutate`).toBe(1);
    }
    // The mutant runs from a temp directory, so a relative specifier it
    // cannot resolve would read as a refusal rather than as a module that
    // failed to load. Exactly one is allowed, and it is carried.
    expect([...src.matchAll(/from '(\.[^']*)'/g)].map(m => m[1])).toEqual(["./interpreters"]);

    const dir = mkdtempSync(join(tmpdir(), "bw1371-"));
    try {
      writeFileSync(
        join(dir, "interpreters.ts"),
        readFileSync(join(import.meta.dir, "..", "lib", "interpreters.ts"), "utf8"),
      );
      // EVERY mutant is written before ANY of them is imported. Bun caches
      // the directory listing at the first dynamic import from a directory,
      // so a file created after it is reported `Cannot find module` — a red
      // indistinguishable from the guard behaving differently. Measured:
      // write `a`, import `a`, write `b` — and `b` is gone.
      for (const [name, [site, repl]] of Object.entries(SITES)) {
        writeFileSync(join(dir, `${name}.ts`), src.replace(site, repl));
      }
      const load = async (name: string) => {
        const m = (await import(`file://${join(dir, `${name}.ts`)}`)) as {
          decideBashWrite: (c: string) => { blocked: boolean };
        };
        return m.decideBashWrite;
      };
      const decide: Record<string, (c: string) => { blocked: boolean }> = {};
      for (const name of Object.keys(SITES)) decide[name] = await load(name);

      const moved = (other: (c: string) => { blocked: boolean }) =>
        rows
          .filter(r => other(r.cmd).blocked !== decideBashWrite(r.cmd).blocked)
          .map(r => r.label)
          .sort();

      expect(moved(decide.noLive)).toEqual(
        [
          "L1 a copy into the live run-store DIRECTORY, which spells no artifact",
          "L2 the same shape into another live tree",
          "L3 the same hole reached through a heredoc",
          "L4 the tilde spelling, which the absolute-path precondition skipped",
          "L5 the ${HOME} spelling, same skip",
          // Only a volume that folds case can have this row move: where the
          // SHOUTED path is a different file, the live-tree reading is not
          // what decides it and removing that reading changes nothing.
          ...(CASE_FOLDS ? ["L6 the same tree SHOUTED, decided by what the VOLUME calls one file"] : []),
        ].sort(),
      );
      expect(moved(decide.noPlace)).toEqual(
        [
          "P1 an expansion the reader cannot perform is UNPLACEABLE, not elsewhere",
          "P2 the same with the variable INSIDE an otherwise absolute path",
          "U1 the same expansion with NO slash in the variable",
        ].sort(),
      );
      // Strictly inside `noPlace`'s set, and that is the point: the ONE row
      // the order decides is the one whose value has no slash.
      expect(moved(decide.noOrder)).toEqual(["U1 the same expansion with NO slash in the variable"]);
      expect(moved(decide.noPos)).toEqual(
        [
          "W1 a scratch literal bound to a name, then reassigned before the write",
          "W2 the same reassignment through a dict value",
          "W3 a literal that is an inner call's DEFAULT, not the destination",
          "T1 a ternary FALSE branch, where the destination is a name",
          "D1 a scratch literal in shutil.copy's SOURCE slot, destination a name",
          "D2 a literal as json.dump's object, which is never a destination",
        ].sort(),
      );
      expect(moved(decide.noIndex)).toEqual(
        [
          "D1 a scratch literal in shutil.copy's SOURCE slot, destination a name",
          "D2 a literal as json.dump's object, which is never a destination",
        ].sort(),
      );
      expect(moved(decide.noTernary)).toEqual(["T1 a ternary FALSE branch, where the destination is a name"]);
      expect(moved(decide.noNL)).toEqual(
        [
          "N1 the #1277 headline escape with one newline before the .replace",
          "N2 the same line break in a python heredoc",
        ].sort(),
      );
      // Direction: every row that moved was ALLOWED without its decider.
      // Nothing here is refused only because a decider is absent, so no
      // mutant is holding another's witness up.
      for (const r of rows) {
        for (const d of Object.values(decide)) {
          if (d(r.cmd).blocked !== decideBashWrite(r.cmd).blocked) expect(d(r.cmd).blocked, r.label).toBe(false);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1204: `cp` creates links too, and the exemption did not know it", () => {
  /**
   * `LINK_CREATION` recognised `ln`, `symlinkSync`, `os.symlink` and
   * `symlink(`. GNU `cp -s` creates a symbolic link and spells none of them,
   * so it did not void the scratch-path exemption — the identical escape
   * this function's own docblock describes for `ln -s`, through a different
   * verb.
   *
   * `-l`/`--link` is here for the same reason: a hard link into a scratch
   * tree is a second name for a file outside it, and a write through that
   * name is a write to the outside file. It cannot cross a filesystem and it
   * cannot point at a directory, which makes it narrower than `-s` — not
   * harmless.
   *
   * The rows are hand-written rather than taken from the command corpus. A
   * corpus sweep is a regression control; it can only contain shapes somebody
   * has already typed, and the shape that matters here is the one nobody has.
   */
  const RUN = `${process.env.HOME}/.rungate/victim`;

  const voids = [
    ["the reported spelling", `cp -s ${RUN} /tmp/x`],
    ["long form", `cp --symbolic-link ${RUN} /tmp/x`],
    ["hard link, short", `cp -l ${RUN} /tmp/x`],
    ["hard link, long", `cp --link ${RUN} /tmp/x`],
    ["bundled after a flag that is not one", `cp -rs ${RUN} /tmp/x`],
    ["bundled before one", `cp -sv ${RUN} /tmp/x`],
    ["bundled with archive", `cp -as ${RUN} /tmp/x`],
    ["a separate earlier flag", `cp -v -s ${RUN} /tmp/x`],
    ["two separate earlier flags", `cp -v -f -s ${RUN} /tmp/x`],
    ["sudo wrapper", `sudo cp -s ${RUN} /tmp/x`],
    ["path-qualified", `/bin/cp -s ${RUN} /tmp/x`],
    ["backslash-escaped", `\\cp -s ${RUN} /tmp/x`],
    ["env wrapper", `env cp -s ${RUN} /tmp/x`],
    ["via find -exec, which resolves to `find`", `find . -exec cp -s ${RUN} /tmp/x \\;`],
    ["inside a heredoc body an interpreter will run", `bash <<'EOF'\ncp -s ${RUN} /tmp/x\nEOF`],
  ];
  test.each(voids)("%s voids the exemption", (_label, link) => {
    const d = decideBashWrite(`${link} && echo y > /tmp/x/${STATE}`);
    expect(d.blocked, `allowed: ${link}`).toBe(true);
  });

  test("CONTROL: a `cp` that creates no link does not void it", () => {
    // If these go red the voiding has become "any cp", and every fixture
    // that copies a file into a scratch tree is refused.
    for (const cmd of [
      `cp a.txt /tmp/p/${STATE}`,
      `cp -r src /tmp/p && echo x > /tmp/p/${STATE}`,
      `cp -p a.txt /tmp/p/${STATE}`,
      `cp -f a.txt /tmp/p/${STATE}`,
      `cp --strip-trailing-slashes a.txt /tmp/p/${STATE}`,
      `cp --no-clobber a.txt /tmp/p/${STATE}`,
    ]) {
      const d = decideBashWrite(cmd);
      expect(d.blocked, `refused: ${cmd} — ${d.reason}`).toBe(false);
    }
  });

  test("CONTROL: words merely containing the letters do not void it", () => {
    for (const cmd of [
      `echo cps > /tmp/p/${STATE}`,
      `bun run cp-scan.ts > /tmp/p/${STATE}`,
      `scp a.txt host:/tmp/p && echo x > /tmp/p/${STATE}`,
    ]) {
      const d = decideBashWrite(cmd);
      expect(d.blocked, `refused: ${cmd} — ${d.reason}`).toBe(false);
    }
  });

  /**
   * NOT fixed here, and stated so it is not mistaken for covered: `cp -a`
   * and `cp -d` preserve an EXISTING symlink as a symlink, so copying one
   * that already points out of the tree reproduces the escape with no
   * link-creating flag anywhere in the command. Catching it needs the SOURCE
   * resolved on disk, which this module does not do, and refusing every
   * `cp -a` would refuse a very common fixture. Filed separately.
   */
  test("KNOWN GAP: `cp -a` of an already-existing link is not caught", () => {
    expect(decideBashWrite(`cp -a somelink /tmp/x && echo y > /tmp/x/${STATE}`).blocked).toBe(false);
  });
});
