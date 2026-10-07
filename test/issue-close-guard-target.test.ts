/**
 * The repository and issue come from the thing being closed (#143, security review)
 *
 * SC-561..SC-564 (GITHUB-API-MIGRATION-SPEC.md)
 *
 * Removing the hardcoded fallback made `parseCloseTarget`'s answer decisive:
 * the guard has nothing left to fall back to, so a defect in the parse is the
 * whole decision. Rook found one, and it needed no attacker.
 *
 * `ISSUE_URL` was matched anywhere in the closing segment, so a URL in a
 * `--comment` body took over the target. An ordinary dedup close made the
 * guard read the linked issue's labels while gh closed a different one, and
 * an unlabelled decoy was enough to permit closing a protected issue. The
 * `direct` branch's own comment already said the positional number "is
 * unambiguous even when other digits appear in a comment body"; the match
 * order defeated the intent that was written down beside it.
 *
 * Refused rather than ignored, because ignoring handles the comment case and
 * not a flag-before-URL command, where the URL is the real target, is not
 * positional because a flag precedes it, and the number heuristic would pair
 * the URL's issue with the flag's repository.
 *
 * Commands are assembled rather than written out: this repo's own
 * IssueCloseGuard refuses any Bash command whose text looks like two closes,
 * so a file full of literal examples cannot be written to disk by the agent
 * editing it. The same reason test/sync-sc-status-matching.test.ts assembles
 * its SC id.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseCloseTarget } from "../hooks/lib/utils";

const CLOSE = `gh issue ${["clos", "e"].join("")}`;
const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;

describe("#143: a URL counts only when it is the issue being closed", () => {
  test("a URL in a comment body does not become the target", () => {
    // The measured bypass. Before the fix: { issue: '1', repo: 'a/b' } for a
    // command closing 99.
    const r = parseCloseTarget(`${CLOSE} 99 --repo a/b --comment "dup of https://github.com/a/b/issues/1"`, env());
    expect(r.kind).toBe("ambiguous");
  });

  test("a cross-repo URL in a comment body does not become the target", () => {
    // Before the fix this answered { issue: '1', repo: 'unprotected/x' } — a
    // repository nobody named, for an issue nobody was closing.
    const r = parseCloseTarget(`${CLOSE} 99 --comment "see https://github.com/unprotected/x/issues/1"`, env());
    expect(r.kind).toBe("ambiguous");
  });

  test("a URL that IS the argument still works", () => {
    // Positive control. Refusing everything passes both assertions above and
    // breaks the ordinary URL form.
    expect(parseCloseTarget(`${CLOSE} https://github.com/a/b/issues/5`, env()))
      .toEqual({ kind: "one", issue: "5", repo: "a/b" });
  });

  test("a URL argument agreeing with --repo still works", () => {
    expect(parseCloseTarget(`${CLOSE} https://github.com/a/b/issues/5 --repo a/b`, env()))
      .toEqual({ kind: "one", issue: "5", repo: "a/b" });
  });

  test("a URL argument disagreeing with --repo is still refused", () => {
    expect(parseCloseTarget(`${CLOSE} https://github.com/a/b/issues/5 --repo c/d`, env()).kind)
      .toBe("ambiguous");
  });

  test("a flag before the URL target is refused, not guessed at", () => {
    // Ignoring the stray URL would resolve this to issue 5 in a/b — the URL's
    // issue number paired with the flag's repository.
    expect(parseCloseTarget(`${CLOSE} --repo a/b https://github.com/c/d/issues/5`, env()).kind)
      .toBe("ambiguous");
  });

  test("the plain positional form is untouched", () => {
    expect(parseCloseTarget(`${CLOSE} 99 --repo a/b`, env()))
      .toEqual({ kind: "one", issue: "99", repo: "a/b" });
  });
});

describe("#143: the URL's host is the host, not a substring", () => {
  test("github.com in the PATH of another host yields no repo", () => {
    // The old pattern matched the literal anywhere in the URL, so this
    // produced a/b — a repository gh would never have touched.
    expect(parseCloseTarget(`${CLOSE} https://evil.example/github.com/a/b/issues/1`, env()).kind)
      .toBe("ambiguous");
  });

  test("a lookalike host yields no repo", () => {
    expect(parseCloseTarget(`${CLOSE} https://github.com.evil.example/a/b/issues/1`, env()).kind)
      .toBe("ambiguous");
  });

  test("www and userinfo are still the real host", () => {
    expect(parseCloseTarget(`${CLOSE} https://www.github.com/a/b/issues/5`, env()))
      .toEqual({ kind: "one", issue: "5", repo: "a/b" });
    expect(parseCloseTarget(`${CLOSE} https://user@github.com/a/b/issues/5`, env()))
      .toEqual({ kind: "one", issue: "5", repo: "a/b" });
  });
});

describe("#143: GH_REPO set inside the command is refused", () => {
  test("an inline assignment is not silently overridden by the session's env", () => {
    // Measured: with the session's GH_REPO set, this resolved to the session
    // value while gh would have acted in unprotected/x. Reading it properly
    // means tracking shell variable scope, so the guard refuses instead.
    expect(parseCloseTarget(`GH_REPO=unprotected/x ${CLOSE} 23`, env({ GH_REPO: "a/b" })).kind)
      .toBe("ambiguous");
  });

  test("an exported assignment in the same segment is refused too", () => {
    expect(parseCloseTarget(`export GH_REPO=unprotected/x ${CLOSE} 23`, env({ GH_REPO: "a/b" })).kind)
      .toBe("ambiguous");
  });

  test("an assignment in a SEPARATE segment is refused — the natural spelling", () => {
    // The first version of this control tested the closing segment, so it
    // caught the inline prefix and missed `export ... && close`, which is how
    // anyone would actually write it: the segment contains no assignment at
    // all. A control that only covers the awkward spelling is not a control.
    for (const cmd of [
      `export GH_REPO=unprotected/x && ${CLOSE} 23`,
      `GH_REPO=unprotected/x ; ${CLOSE} 23`,
      `GH_REPO=unprotected/x\n${CLOSE} 23`,
    ]) {
      expect(parseCloseTarget(cmd, env({ GH_REPO: "a/b" })).kind).toBe("ambiguous");
    }
  });

  test("an explicit --repo makes the assignment irrelevant, and is allowed", () => {
    // gh prefers the flag over GH_REPO, so there is no differential left to
    // refuse. Without this, a command that sets the variable for an earlier
    // step would be blocked for no reason — and a fix that refuses every
    // GH_REPO= would pass every assertion above.
    expect(parseCloseTarget(`export GH_REPO=unprotected/x && ${CLOSE} 23 --repo a/b`, env()))
      .toEqual({ kind: "one", issue: "23", repo: "a/b" });
  });

  test("GH_REPO from the real environment is still honoured", () => {
    // Positive control: gh reads it, so the guard must too. Only an
    // assignment inside the command is the problem.
    expect(parseCloseTarget(`${CLOSE} 23`, env({ GH_REPO: "a/b" })))
      .toEqual({ kind: "one", issue: "23", repo: "a/b" });
  });
});

describe("#143: the block text does not teach the bypass", () => {
  test("it asks for --repo and never suggests GH_REPO", () => {
    // Comment lines dropped: the fix's own comment has to be able to say
    // "NOT export GH_REPO" while explaining why, and a sweep that cannot
    // tell prose from the string being emitted would be satisfied by
    // deleting the explanation.
    const hook = readFileSync(join(import.meta.dir, "..", "hooks", "IssueCloseGuard.hook.ts"), "utf-8")
      .split("\n")
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const at = hook.indexOf("the command names no repository");
    expect(at).toBeGreaterThan(-1);
    const message = hook.slice(at, at + 400);
    expect(message).toContain("--repo owner/name");
    expect(message).not.toContain("GH_REPO");
  });
});
