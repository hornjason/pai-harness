import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
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

/** The same scan HYGIENE-11 performs, so the comparison covers its real inputs. */
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
  return out.filter(f => !f.startsWith("reference/") && !f.includes("/reference/"));
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

      const fast = lastCommitDates(ROOT, DOC_DIRS);
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
    const fast = lastCommitDates(ROOT, DOC_DIRS);
    expect(fast.has("specs/this-file-has-never-existed-9f3a.md")).toBe(false);
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
