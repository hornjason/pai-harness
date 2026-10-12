import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lastCommitDates } from "../lib/conformity";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #323 — HYGIENE-11 spawned one `git log` per markdown file.
 *
 * 60 serial subprocesses against the same repository, each with a 5-second
 * timeout. Nothing was wrong with any single call: the test was load-sensitive
 * by construction, and if one spawn was slow — another suite holding the
 * index, a busy machine, a cold cache — it hit the timeout and the test went
 * red. Measured at 1 failure in 3 identical runs, always at ~5007 ms. It got
 * worse on its own as the repo grew, because more docs meant more dice rolls.
 *
 * That matters more than an ordinary flake. The full suite is the evidence
 * every PR in this stretch cites, and a suite that fails for reasons
 * unrelated to correctness trains everyone to re-run until green — which is
 * indistinguishable from not checking.
 *
 * `lastCommitDates` replaces the loop with one subprocess. The risk in that
 * trade is the obvious one: a detector that got faster by finding LESS would
 * pass every timing test and none of the ones that matter. So the test that
 * counts here is not the speed — it is that the single call still agrees with
 * git, file for file.
 */

const ROOT = join(import.meta.dir, "..");
const DOC_DIRS = ["specs", "docs", "docs/adr", "docs/research", "docs/council", "docs/guides"];

/**
 * The same scan HYGIENE-11 performs, so the comparison covers its real inputs.
 *
 * The root-level sweep is the half that matters here, and it is why the first
 * version of this file proved nothing about six files. It mirrored only the
 * DOC_DIRS loop, agreed with the oracle 59 out of 59, and was green over a map
 * that contained no entry for AGENTS.md, CLAUDE.md, SUCCESS.md, HARNESS.md,
 * CODE-MAP.md or PROJECT-STATE.md. An equivalence test is only as wide as the
 * input set it builds: a helper that mirrors half the production scan reports
 * perfect agreement about the half it copied.
 */
function docFiles(): string[] {
  const out: string[] = [];
  for (const rel of DOC_DIRS) {
    const dir = join(ROOT, rel);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
      try {
        if (statSync(join(dir, f)).isFile()) out.push(`${rel}/${f}`);
      } catch {}
    }
  }
  for (const f of readdirSync(ROOT).filter(f => f.endsWith(".md"))) out.push(f);
  return out.filter(f => !f.startsWith("reference/") && !f.includes("/reference/"));
}

/** Root-level markdown alone — the set the first cut of the fix could not see. */
function rootDocs(): string[] {
  return readdirSync(ROOT).filter(f => f.endsWith(".md"));
}

describe("#323: HYGIENE-11's date lookup is one git call and still agrees with git", () => {
  test(
    "the single call returns the same date as a per-file `git log -1` for every doc",
    () => {
      // The equivalence proof, and the whole point of the file. The old
      // implementation is re-run here as the oracle — not a recorded snapshot,
      // which would go stale the moment anyone commits.
      const files = docFiles();
      expect(files.length, "no docs scanned — this comparison would be vacuous").toBeGreaterThan(20);

      const fast = lastCommitDates(ROOT, files);
      const disagreements: string[] = [];
      let compared = 0;

      for (const rel of files) {
        const r = spawnSync("git", ["-C", ROOT, "log", "-1", "--format=%ci", "--", rel], {
          timeout: 20_000,
        });
        const expected = r.stdout.toString().trim().split(" ")[0];
        if (!expected) continue; // untracked: the fast path omits it too, by design
        compared++;
        const actual = fast.get(rel);
        if (actual !== expected) disagreements.push(`${rel}: git says ${expected}, single-call says ${actual}`);
      }

      expect(compared, "every doc was untracked — nothing was actually compared").toBeGreaterThan(20);
      expect(
        disagreements,
        `the single git call disagrees with git itself:\n${disagreements.join("\n")}`,
      ).toEqual([]);
    },
    180_000,
  );

  test("an untracked file gets no date, rather than a wrong one", () => {
    // The boundary the loop handled with `if (!dateStr) continue`. A path with
    // no commit is newly added, which is the opposite of stale — returning a
    // date for it would make the newest file in the repo look like the oldest.
    const fast = lastCommitDates(ROOT, docFiles());
    expect(fast.has("specs/this-file-has-never-existed-9f3a.md")).toBe(false);
  });

  test("root-level markdown is covered, not just the doc directories", () => {
    // The defect a security review caught in the first cut of this fix, kept
    // as its own case because the equivalence test above cannot express it:
    // if the lookup set shrinks, the oracle shrinks with it and both sides
    // agree about nothing. This one names the files directly.
    const roots = rootDocs();
    expect(roots.length, "no root-level markdown found — this case would be vacuous").toBeGreaterThan(3);

    const fast = lastCommitDates(ROOT, docFiles());
    const uncovered = roots.filter(f => {
      const r = spawnSync("git", ["-C", ROOT, "log", "-1", "--format=%ci", "--", f], { timeout: 20_000 });
      return r.stdout.toString().trim() !== "" && !fast.has(f);
    });
    expect(
      uncovered,
      `git knows a commit date for these root-level docs and the single call does not: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  test("passing directories instead of the lookup set is what loses them", () => {
    // The mutation, performed rather than described: the exact argument the
    // first cut passed, showing the hole it opened. This is the case that
    // would have caught the defect before it was pushed.
    const byDirectory = lastCommitDates(ROOT, DOC_DIRS);
    const tracked = rootDocs().filter(f => {
      const r = spawnSync("git", ["-C", ROOT, "log", "-1", "--format=%ci", "--", f], { timeout: 20_000 });
      return r.stdout.toString().trim() !== "";
    });
    expect(tracked.length, "no tracked root-level docs — nothing to lose").toBeGreaterThan(3);
    expect(
      tracked.every(f => !byDirectory.has(f)),
      "passing DOC_DIRS no longer drops root-level docs; if the scan changed, " +
        "this case is stale and the one above is the real guard",
    ).toBe(true);
  });

  test("a git failure throws rather than reporting an empty history", () => {
    // Fail-closed. spawnSync does not throw on a non-zero exit, so the
    // original `catch {}` turned any broken invocation into an empty map —
    // every file reading as newly added, which is indistinguishable from a
    // clean run. An unreadable repo must be loud.
    // A `.git` that is not a repository: the existsSync guard lets it through,
    // git refuses it, and the question is whether the refusal is reported or
    // swallowed. Note the argument must NOT be a bogus flag — everything the
    // function passes sits after `--`, so git reads it as a pathspec and exits
    // 0 with no matches, which is a clean empty result rather than a failure.
    const brokenRepo = mkdtempSync(join(tmpdir(), "rg-badgit-"));
    writeFileSync(join(brokenRepo, ".git"), "not a gitdir pointer\n");
    expect(() => lastCommitDates(brokenRepo, ["x.md"])).toThrow(/git log exited/);
  });

  test("a directory with no .git returns empty without throwing", () => {
    // The converse, and the reason the throw above is guarded: scaffolded
    // projects are not repositories, and "nothing is tracked" is a real
    // answer there rather than a failure.
    const notARepo = mkdtempSync(join(tmpdir(), "rg-nogit-"));
    expect(existsSync(join(notARepo, ".git")), "the fixture is a repo, so this proves nothing").toBe(false);
    expect(lastCommitDates(notARepo, ["x.md"]).size).toBe(0);
  });

  test("HYGIENE-11 makes one git call, not one per file", () => {
    // What keeps it fixed. The equivalence test above passes just as well
    // against a reintroduced loop, so without this the next refactor can put
    // the flake straight back.
    // Comments stripped first. The docblock on the fix NAMES the call it
    // removed, so a detector reading prose reports the very defect the fix
    // deleted. That is the third time this trap has fired in this codebase
    // today; lib/strip-js-comments.ts is the standing answer to it.
    const source = stripJsComments(readFileSync(join(ROOT, "lib", "conformity.ts"), "utf-8"));
    const start = source.indexOf('test("HYGIENE-11:');
    expect(start, "HYGIENE-11 is not where this test expects it").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n    });", start));

    const spawns = body.match(/spawnSync\s*\(/g) || [];
    expect(
      spawns.length,
      `HYGIENE-11 spawns ${spawns.length} subprocesses inline; it must call ` +
        `lastCommitDates() once instead (#323)`,
    ).toBe(0);
    expect(body, "HYGIENE-11 no longer uses the shared single-call lookup").toContain(
      "lastCommitDates(",
    );

    // The argument, not just the call. "It calls the shared lookup" was true
    // of the version that passed `docDirs` and silently lost every root-level
    // doc. The pathspec has to be the same list the loop below looks up, and
    // the only way to say that mechanically is to name it.
    const call = /lastCommitDates\(\s*root\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(body);
    expect(call, "HYGIENE-11's call to lastCommitDates is not in the expected shape").not.toBeNull();
    expect(
      call?.[1],
      `HYGIENE-11 passes '${call?.[1]}' as the pathspec; it must pass the set it ` +
        `then looks up ('filtered'), or files outside those directories get no ` +
        `date and read as newly added (#323)`,
    ).toBe("filtered");
  });

  test("the guard would catch the defect it was written for", () => {
    // The mutation, as a literal rather than a file edit: the source check
    // above is satisfied by a regex that matches nothing, and the two
    // assertions in it are satisfied by a body that is empty.
    const reintroduced =
      'for (const rel of filtered) {\n  const result = spawnSync("git", ["-C", root, "log", "-1"]);\n}';
    expect((reintroduced.match(/spawnSync\s*\(/g) || []).length).toBe(1);
    expect(reintroduced).not.toContain("lastCommitDates(");
  });
});
