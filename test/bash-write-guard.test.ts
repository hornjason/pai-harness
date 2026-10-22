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
import {
  decideBashWrite,
  segments,
  stripQuoted,
  stripHeredocs,
  dequote,
  commandWord,
  writeTargets,
} from "../lib/bash-write-guard";

const SALT = "." + "gate-" + "salt";
const STATE = "workflow-" + "state.json";

describe("#1120 WITNESS: a write to a protected artifact is refused", () => {
  const cases: [string, string][] = [
    ["a bare redirect — the control that proves the guard is wired", `echo x > /tmp/bwprobe/${SALT}`],
    ["an allowlisted prefix in front of that redirect", `gh --version; echo x > /tmp/bwprobe/${SALT}`],
    ["an allowlisted prefix in front of a chmod", `gh --version; chmod 777 lib/Foo.hook.ts`],
    ["an allowlisted prefix in front of the Keychain read", `gh --version; security find-generic-password -s pai-gate-salt -w`],
    ["an interpreter one-liner that opens for write", `python3 -c "open('/tmp/p/${SALT}','w').write('x')"`],
    ["the same interpreter reached by an absolute path", `/usr/bin/python3 -c "open('/x/${SALT}','w').write('x')"`],
    ["find -execdir, a plain synonym for -exec", `find . -name '*.json' -execdir rm /x/${STATE} ;`],
    ["sed -i, the ordinary way to edit a file from a shell", `sed -i '' 's/BUILD/DONE/' /Users/jhorn/.rungate/x/${STATE}`],
    ["cp carrying a flag before the destination", `cp -p /tmp/forged.json /Users/jhorn/.rungate/x/${STATE}`],
    ["a redirect whose target is quoted", `echo x > "/tmp/bwprobe/${SALT}"`],
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
    const witness = `gh --version; echo x > /tmp/p/${SALT}`;
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
    ["G1 a heredoc whose operator line also carries the redirect", `cat <<EOF > /tmp/bw/${SALT}\nhello\nEOF`],
    // G2. stripQuoted deletes quoted spans AND contents; the recovery pass
    //     only matched a target that was WHOLLY quoted, so a mid-word quote
    //     fell between the two.
    ["G2 a redirect target quoted in the middle of the word", `echo x > dir/"${STATE}"`],
    // G3. `.match` without /g, one capture group, but `tee` takes many files.
    ["G3 tee writing a protected file as its second operand", `echo x | tee /tmp/a /tmp/bw/${STATE}`],
    // G4. The real invocation quotes the key, and stripQuoted deleted it, so
    //     the arm could not fire on the one shape it exists for.
    ["G4 the Keychain key name in quotes", `security find-generic-password -s 'pai-gate-salt' -w`],
    // G6. The lookbehind excluded `2`, but `2> file` truncates like `> file`.
    ["G6 a stderr redirect, which truncates exactly like stdout", `echo x 2> /tmp/bw/${SALT}`],
    // G7. For a SHELL the `-c` body is shell, but it was matched against
    //     WRITE_INTENT, which enumerates Node and Python idioms only. Arm 1
    //     could not see it either, because stripQuoted deleted the body.
    ["G7 a shell -c body containing a plain redirect", `bash -c 'echo x > /tmp/bw/${SALT}'`],
    ["G7 the same through sh", `sh -c "rm -f /tmp/bw/${STATE}"`],
    // G8. Both of these are REAL commands from the corpus, and both are
    //     genuine writes that the #1176 rework briefly started allowing: an
    //     apostrophe inside a `#` comment opened a quote that stayed open
    //     across the newline and swallowed the redirect on a later line.
    //     Found by the sweep, not by reading. A shell comment is not a quote.
    [
      "G8 an apostrophe in a comment must not hide a later redirect",
      `# First, check if there's a test ${STATE} I can target\nmkdir -p /tmp/bw/rt\necho '{"phase":"BUILD"}' > /tmp/bw/rt/${STATE}`,
    ],
    [
      "G8 the same, hiding a write to a hook file",
      `# they're on main\ngit show HEAD~1:hooks/AutoVerifyGate.hook.ts > /tmp/bw/hooks/AutoVerifyGate.hook.ts`,
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
 */
describe("#1184 WITNESS: views, terminators and spellings", () => {
  const cases: [string, string][] = [
    // H1. #1176 replaced a terminator-anchored regex with a line scanner, and
    //     the scanner runs off the end when the terminator never arrives. The
    //     regex failed CLOSED here; the scanner failed open. A regression.
    ["H1 an unterminated heredoc must not delete the lines after it", `cat <<EOF\necho x > /tmp/bw/${SALT}`],
    ["H1b the same, hiding a hook write", `cat <<MARKER\ncp /tmp/evil.ts /tmp/bw/hooks/X.hook.ts`],
    // H5. `<<<` is a herestring. Matching it as a heredoc invents a delimiter
    //     that never terminates, which lands straight in H1.
    ["H5 a herestring is not a heredoc", `grep x <<< "t"\necho y > /tmp/bw/${SALT}`],
    // H3. The mirror of #1176's F2: there the TARGET was read off the
    //     quote-stripped view, here the VERB is.
    ["H3 a quoted command word still runs", `"chmod" 777 /tmp/bw/hooks/X.hook.ts`],
    ["H3b a partly quoted command word", `ch"mod" 777 /tmp/bw/hooks/X.hook.ts`],
    ["H3c a quoted interpreter", `"bash" -c 'echo x > /tmp/bw/${SALT}'`],
    // H4. A directory destination's real sink is join(dest, basename(src)).
    ["H4 cp into a directory, protected source basename", `cp /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`],
    ["H4b mv into a directory", `mv /tmp/forged/${STATE} /Users/jhorn/.rungate/x/`],
    ["H4c cp a hook into a hooks directory", `cp /tmp/evil/X.hook.ts /Users/jhorn/Projects/rungate/hooks/`],
    // H6. Measured: this filesystem is case-insensitive, so these name the
    //     same files as their lowercase spellings.
    ["H6 an uppercase gate artifact", `echo x > /tmp/bw/${STATE.toUpperCase()}`],
    ["H6b an uppercase salt", `echo x > /tmp/bw/${SALT.toUpperCase()}`],
    ["H6c a mixed-case hook", `cp /tmp/evil.ts /tmp/bw/hooks/X.HOOK.TS`],
    // H7. Constructed, not from the corpus — the key reaching `security`
    //     through a variable set in an earlier segment. Measured cost of
    //     matching the key across the whole command: 0 of 125,644.
    ["H7 the keychain key arriving via a variable", `KEY=pai-gate-salt; security find-generic-password -s "$KEY" -w`],
  ];
  test.each(cases)("%s", (_label, cmd) => {
    expect(decideBashWrite(cmd).blocked).toBe(true);
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
    expect(decideBashWrite(`echo x > /tmp/bw/${STATE.toUpperCase()}`).blocked).toBe(true);
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
    expect(segments(`echo x &> /tmp/bw/${SALT}`)).toEqual(["echo x", `> /tmp/bw/${SALT}`]);
    expect(decideBashWrite(`echo x &> /tmp/bw/${SALT}`).blocked).toBe(true);
  });
});
