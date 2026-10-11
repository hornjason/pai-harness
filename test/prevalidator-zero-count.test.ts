/**
 * A zero-count grep is a measurement, not a broken command (#271)
 *
 * Run `wf_ea3e428f-64f` (#273) was refused at its verify gate on this. AC-1 was
 * a zero-count criterion — "no phase-ordering assertion is anchored to a
 * comment any more" — with `threshold: == 0` and:
 *
 *     awk '/describe("phase-ordering/,/^});/' test/spec-compliance.test.ts \
 *       | grep -cE 'indexOf\("(PHASE [0-9]|create-pr)'
 *
 * In the worktree, after the fix, it printed `0` — the exact value the
 * threshold requires — and exited 1. The pre-validator treats any non-zero
 * exit as broken, so it reported:
 *
 *     AC-1 classified 'broken' ... 'Command failed with exit code 1'
 *
 * On an unfixed tree the same command prints a positive count and exits 0. So
 * the AC was reported healthy while the bug existed and broken the moment it
 * was fixed — perfectly inverted:
 *
 *     count=1 exit=0  threshold == 0 not satisfied   pre-validator: ok
 *     count=0 exit=1  threshold == 0 SATISFIED       pre-validator: BROKEN
 *
 * Zero-count is the canonical shape for any cleanup or removal issue, which is
 * most of this backlog.
 *
 * ## Why the rule is grep's contract and not `|| true`
 *
 * `grep` documents three outcomes: 0 if a line was selected, 1 if none was,
 * and **greater than 1 if an error occurred**. Exit 1 is a result. Exit 2 is a
 * missing file or a bad pattern, and is a genuinely broken evidence command.
 *
 * The auto-fix this issue was originally filed about wrapped the command in
 * `|| true`, which swallows exit 2 along with exit 1 and turns a real error
 * into a clean verdict — the fail-open the issue named. Reading grep's own
 * convention keeps exit 2 broken, so this fix is strictly narrower than the
 * one it replaces, and the exit-2 case is asserted below rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";

/** A throwaway project with one known file to grep. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pv271-"));
  writeFileSync(join(dir, "subject.txt"), "alpha\nbeta\n");
  return dir;
}

const ac = (command: string, id = "AC-1") => ({
  id,
  statement: "the pattern no longer appears anywhere in the subject",
  threshold: { op: "==", value: 0 },
  evidenceMethod: { type: "GREP_CHECK", command },
});

describe("#271: a grep that matched nothing is a result, not a failure", () => {
  test("the #273 case — a bare grep -c printing 0 is ok, not broken", async () => {
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence([ac("grep -c ABSENT subject.txt")] as any, dir);
      expect(
        r.status,
        `a zero-count grep was classified '${r.status}' — the AC is satisfied exactly when this happens`,
      ).toBe("ok");
      expect(r.needsRewrite).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("piped, which is the shape the auto-fix always refused to touch", async () => {
    // `tryFixGrepExitCode` declined any command containing a pipe, and a
    // count-style grep is normally piped — you filter a region, then count
    // inside it. That exclusion removed the fix from the only case that
    // needed it. This is #273's AC-1 in miniature.
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence([ac("cat subject.txt | grep -cE 'ABSENT'")] as any, dir);
      expect(r.status).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a grep that DOES match is still ok — the fix does not invert the other way", async () => {
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence([ac("grep -c alpha subject.txt")] as any, dir);
      expect(r.status).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a real grep error stays broken — exit 2, not exit 1", async () => {
    // The whole reason this is grep's convention rather than `|| true`. A
    // missing file exits 2 and must not be laundered into a clean verdict;
    // `|| true` would have reported this ok, which is the fail-open #271 was
    // originally filed about.
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence([ac("grep -c alpha no-such-file-7c2b.txt")] as any, dir);
      expect(
        r.status,
        "a grep against a missing file was reported clean — exit 2 is an error, not a zero count",
      ).toBe("broken");
      expect(r.needsRewrite).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-grep command exiting 1 is still broken", async () => {
    // The rule is grep's documented contract, not "exit 1 is fine". Anything
    // else exiting 1 has failed and must keep saying so, or this fix becomes
    // a blanket amnesty.
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence([ac("exit 1")] as any, dir);
      expect(r.status).toBe("broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a grep earlier in a pipe does not excuse a later command's failure", async () => {
    // Only the command whose exit status the shell reports — the LAST stage —
    // gets grep's convention. A pipeline ending in something else that fails
    // is broken however it began, or any command could buy amnesty by
    // mentioning grep.
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence(
        [ac("grep alpha subject.txt | exit 1")] as any,
        dir,
      );
      expect(r.status).toBe("broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plain grep with no matches reports empty, not ok and not broken", async () => {
    // `grep -c` prints "0" — a value. Plain `grep` prints nothing, so there is
    // no value to compare against a threshold. That is neither a working
    // measurement nor a broken command, and `empty` is the status that
    // already exists for it. Collapsing it into `ok` would hand the gate an
    // AC with no evidence, which is #277.
    const dir = fixture();
    try {
      const [r] = await prevalidateEvidence([ac("grep ABSENT subject.txt")] as any, dir);
      expect(r.status).toBe("empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no command is rewritten to one that cannot fail", async () => {
    // The other half of #271. The old auto-fix appended `|| true`, producing a
    // command that exits 0 whatever happens — including on the exit-2 error
    // above. Nothing should now be carrying that suffix.
    const dir = fixture();
    try {
      const results = await prevalidateEvidence(
        [
          ac("grep -c ABSENT subject.txt", "AC-1"),
          ac("cat subject.txt | grep -cE 'ABSENT'", "AC-2"),
          ac("grep -c alpha no-such-file-7c2b.txt", "AC-3"),
        ] as any,
        dir,
      );
      for (const r of results) {
        expect(
          r.fixedCommand ?? "",
          `${r.id} was rewritten to a command that cannot fail: ${r.fixedCommand}`,
        ).not.toContain("|| true");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
