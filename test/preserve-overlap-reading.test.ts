/**
 * #892: the refusal says WHETHER the copies it is refusing are the same file.
 *
 * `auditWorktreeClaims` refuses an unclaimed file modification and is right to
 * (#178, SC-413) — the other agents' edits exist and are not this collection's
 * to discard. What it could not say is whether the copies differ at all. On
 * `wf_161c4e96-f01` three worktrees produced a superset chain with identical
 * overlaps, the run died at the barrier, and 35 minutes went on establishing by
 * hand something git already knew.
 *
 * **Nothing here changes a decision.** The refusal fires exactly when it fired
 * before. That is the whole reason this reading is allowed to be computed at
 * all: the two alternatives on #892 both put the BYTES into the refuse-or-not
 * path — option A through an agent's self-reported digest, which is tier F
 * evidence inside a correctness guard, and option B by moving the decision into
 * the collect script, which leaves the audit still needing to refuse when the
 * script never ran. A reading that only composes a message can be wrong without
 * discarding anybody's work.
 *
 * It is computed in `scripts/preserve-worktree-work.ts` and not in `ship.js`,
 * because ship.js has no filesystem access in the sandbox (#69). The script is
 * a real program that already holds the preserved shas; the agent between them
 * relays JSON verbatim and decides nothing.
 *
 * ## The cheapest wrong fix, named
 *
 * **Compare file SIZE instead of content.** It is the one-line version, it
 * needs no git, and it is right about almost every real input. `AC-2`'s two
 * files are the same length and differ by one character, so the case survives
 * it: a size comparison reports IDENTICAL over a genuine divergence, which is
 * the direction that silently discards work.
 *
 * **And the second one: `new Set(blobs).size <= 1`.** It is what you write
 * first and it reads correctly. Zero blobs and one blob both satisfy it, so a
 * path nobody could read and a path only one worktree has would both print
 * IDENTICAL — zero strings are perfect agreement (#621). `AC-3` and `AC-4` are
 * the two halves of that, and they are red under the `<= 1` spelling.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  overlapLines,
  overlapReadings,
  type PreserveEntry,
} from "../scripts/preserve-worktree-work";

const ROOT = mkdtempSync(join(tmpdir(), "rg892-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * One repository with N linked worktrees, which is the shape a ship run has:
 * every preserved sha lives in one object store, so any worktree can resolve
 * any other's commit. A fixture of N unrelated repositories would make every
 * cross-read fail and the UNMEASURED cases would pass for the wrong reason.
 */
const REPO = join(ROOT, "origin");
mkdirSync(REPO);
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "t@example.com");
git(REPO, "config", "user.name", "t");
writeFileSync(join(REPO, "seed.txt"), "seed\n");
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "seed");

/** A linked worktree carrying `files`, committed, returned as a PreserveEntry. */
function worktree(name: string, files: Record<string, string>): PreserveEntry {
  const dir = join(ROOT, name);
  git(REPO, "worktree", "add", "-q", "-b", name, dir, "main");
  for (const [rel, body] of Object.entries(files)) {
    const at = join(dir, rel);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `work in ${name}`);
  return { worktreePath: dir, branch: name, sha: git(dir, "rev-parse", "HEAD"), status: "committed" };
}

// `shared.ts` is byte-identical in alpha and beta. `edited.ts` differs between
// them by ONE CHARACTER at the SAME LENGTH, which is what makes AC-2 a test of
// the digest rather than of the file size.
const SAME_A = "export const rate = 100\n";
const SAME_B = "export const rate = 200\n";
expect(SAME_A.length).toBe(SAME_B.length);

const alpha = worktree("alpha", { "shared.ts": "export const x = 1\n", "edited.ts": SAME_A, "only-alpha.ts": "a\n" });
const beta = worktree("beta", { "shared.ts": "export const x = 1\n", "edited.ts": SAME_B });
const gamma = worktree("gamma", { "shared.ts": "export const x = 1\n" });

describe("#892 AC-1: worktrees holding the same bytes read IDENTICAL, with coverage", () => {
  test("two worktrees agreeing about a path", () => {
    const [o] = overlapReadings([alpha, beta], ["shared.ts"]);
    expect(o.reading).toBe("IDENTICAL");
    expect(o.read).toBe(2);
    expect(o.of).toBe(2);
    expect(new Set(o.readings.map(r => r.blob)).size).toBe(1);
  });

  test("a third worktree that does not have the path is NAMED, not silently dropped", () => {
    // read 2/3 and read 3/3 are otherwise the same IDENTICAL, and no reader
    // can tell them apart from the output.
    const [o] = overlapReadings([alpha, beta, gamma], ["only-alpha.ts"]);
    expect(o.read).toBe(1);
    expect(o.of).toBe(3);
    const absent = o.readings.filter(r => r.blob === null);
    expect(absent).toHaveLength(2);
    for (const r of absent) expect(r.reason).toBe("the path is not in that commit");
  });

  test("coverage is reported even when the verdict is reached", () => {
    const [o] = overlapReadings([alpha, beta, gamma], ["edited.ts"]);
    expect(o.reading).toBe("DIFFERS");
    expect(`${o.read}/${o.of}`).toBe("2/3");
  });
});

describe("#892 AC-2: a one-character difference at identical length reads DIFFERS", () => {
  test("the two blobs are not equal", () => {
    const [o] = overlapReadings([alpha, beta], ["edited.ts"]);
    expect(o.reading).toBe("DIFFERS");
    expect(o.read).toBe(2);
    const [a, b] = o.readings.map(r => r.blob);
    expect(a).not.toBe(b);
  });

  test("a SIZE comparison would have called these identical — the cheap fix, measured", () => {
    // #906. This case used to be these two lines ALONE:
    //
    //     expect(SAME_A.length).toBe(SAME_B.length);
    //     expect(SAME_A).not.toBe(SAME_B);
    //
    // Both are about two local constants, and neither calls the subject. The
    // case is titled "measured" and reads as the witness that a size-comparing
    // implementation is caught, and it was green under every mutation of the
    // comparison — including a real size-comparing mutant, `git cat-file -s`
    // in place of `git rev-parse <sha>:<path>`, measured 3 of 21 with this
    // case among the 18 green. A case with no demonstrated failing input is
    // not coverage, whatever its name says.
    //
    // The fixture half is kept, because it is a real instrument control: a
    // later edit that made the two files different lengths would stop the rest
    // of AC-2 defeating the cheap fix, and this says so rather than letting it
    // happen quietly.
    expect(SAME_A.length, "the AC-2 fixture no longer defeats a size comparison").toBe(SAME_B.length);
    expect(SAME_A, "the AC-2 fixture no longer holds a divergence to find").not.toBe(SAME_B);

    // The witness half. BOTH readings are taken, over the same two commits,
    // and the case asserts they disagree — so the cheap fix has an input that
    // reds this, which is the only thing that makes the title true.
    const sizes = [alpha, beta].map(e => git(e.worktreePath, "cat-file", "-s", `${e.sha}:edited.ts`));
    expect(new Set(sizes).size, "the size reading does not even reach the wrong answer here").toBe(1);

    const [o] = overlapReadings([alpha, beta], ["edited.ts"]);
    expect(
      o.reading,
      "the shipped reading agrees with a size comparison on a fixture built to make them disagree",
    ).toBe("DIFFERS");
  });
});

describe("#892 AC-3: ONE readable blob is UNMEASURED, not agreement", () => {
  test("a path only one worktree has cannot be compared with anything", () => {
    const [o] = overlapReadings([alpha, beta], ["only-alpha.ts"]);
    expect(o.reading).toBe("UNMEASURED");
    expect(o.read).toBe(1);
    // The naive spelling. Kept as an executed comparison so the distinction
    // this case exists for is visible in the file rather than argued in prose.
    const blobs = o.readings.map(r => r.blob).filter(Boolean);
    expect(new Set(blobs).size <= 1).toBe(true);
    expect(o.reading).not.toBe("IDENTICAL");
  });
});

describe("#892 AC-4: ZERO readable blobs is UNMEASURED, not agreement", () => {
  test("a path no worktree has", () => {
    const [o] = overlapReadings([alpha, beta, gamma], ["nobody/has/this.ts"]);
    expect(o.reading).toBe("UNMEASURED");
    expect(o.read).toBe(0);
    expect(o.of).toBe(3);
    expect(new Set([]).size <= 1).toBe(true); // what the naive spelling answers
  });

  test("no usable entries at all is UNMEASURED and reports of=0, not IDENTICAL", () => {
    const failed: PreserveEntry = { worktreePath: "/nope", branch: null, sha: null, status: "failed", detail: "x" };
    const [o] = overlapReadings([failed], ["shared.ts"]);
    expect(o.reading).toBe("UNMEASURED");
    expect(o.of).toBe(0);
  });
});

describe("#892 AC-5: the line carries the WHOLE set, every branch, every time", () => {
  const overlaps = overlapReadings([alpha, beta, gamma], ["shared.ts", "edited.ts", "only-alpha.ts"]);
  const lines = overlapLines(overlaps);

  test("one line per refused path, in input order", () => {
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("shared.ts:")).toBe(true);
    expect(lines[1].startsWith("edited.ts:")).toBe(true);
    expect(lines[2].startsWith("only-alpha.ts:")).toBe(true);
  });

  test("every branch is named on every line — not a count, not a diff against the line above", () => {
    // A week of this output has to be re-analysable when the question changes,
    // which a summary or a delta against the previous line cannot support.
    for (const line of lines) {
      for (const branch of ["alpha", "beta", "gamma"]) expect(line).toContain(branch);
    }
  });

  test("each line dates itself with the sha beside the branch", () => {
    for (const e of [alpha, beta, gamma]) {
      expect(lines[0]).toContain(e.sha!.slice(0, 8));
    }
  });

  test("an unreadable position prints its reason, not a blank", () => {
    expect(lines[2]).toContain("UNREAD(the path is not in that commit)");
    expect(lines[2]).toContain("UNMEASURED");
  });

  test("the verdict and its coverage are both on the line", () => {
    expect(lines[0]).toContain("IDENTICAL (read 3/3)");
    expect(lines[1]).toContain("DIFFERS (read 2/3)");
  });
});

/**
 * The ship.js half. Source-text assertions, which are the weaker instrument
 * and are used here because `workflows/ship.js` cannot be imported (#69) —
 * stated rather than left for a reader to infer from their absence elsewhere.
 * What they can establish is that the three positions #892 depends on exist
 * and name each other; the BEHAVIOUR of the reading is the sixteen cases
 * above, which execute it.
 */
describe("#892 AC-7: ship.js relays the reading rather than re-deriving it", () => {
  const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");
  const block = (name: string) => {
    const s = shipSource.indexOf(`// ──── ${name}-START ────`);
    const e = shipSource.indexOf(`// ──── ${name}-END ────`);
    if (s < 0 || e < 0) throw new Error(`${name} markers not found in ship.js`);
    return shipSource.slice(s, e);
  };
  const preserve = block("PRESERVE-REFUSED");
  const collect = block("COLLECT-AGENT-WORK");

  test("the cuts found their sections", () => {
    expect(preserve.length).toBeGreaterThan(500);
    expect(collect.length).toBeGreaterThan(500);
  });

  test("the schema DECLARES overlapLines, or the relay silently drops it", () => {
    // A structured-output schema is a filter on the reply, not a description
    // of it (#646). An undeclared field is removed on the way back with no
    // error and no shorter output, and the refusal would print nothing while
    // every test over the script stayed green.
    expect(preserve).toContain("overlapLines:");
  });

  test("the refusal funnel is handed the audit's own paths", () => {
    // Not a second list derived from the results rows: the paths reported must
    // be the paths refused, or the comparison answers a question nobody asked.
    expect(collect).toContain("audit.violations.map(v => v.path)");
  });

  test("ship.js does not re-render the lines — it joins what the script sent", () => {
    // One formatter. A second rendering here would agree with
    // `overlapLines()` today and drift the first time either is edited, which
    // is two deciders for one question.
    expect(preserve).toContain("out.overlapLines");
    expect(preserve).not.toContain("UNREAD(");
    expect(preserve).not.toContain("(read ");
  });

  test("asked-and-silent is UNMEASURED, not an omitted clause", () => {
    // A refusal that simply left the reading out would be byte-identical to
    // one taken before #892 existed, and silence reads as "nothing to say
    // about the bytes" rather than "the comparison did not happen".
    expect(preserve).toContain("UNMEASURED");
  });
});

describe("#892 AC-6: the reading refuses to invent inputs", () => {
  test("no refused paths asked for means no readings produced", () => {
    expect(overlapReadings([alpha, beta], [])).toEqual([]);
  });

  test("duplicate and blank paths collapse rather than producing duplicate lines", () => {
    const o = overlapReadings([alpha], ["shared.ts", "shared.ts", "  ", ""]);
    expect(o).toHaveLength(1);
    expect(o[0].path).toBe("shared.ts");
  });

  test("a failed preserve entry contributes no reading at all", () => {
    const failed: PreserveEntry = { worktreePath: alpha.worktreePath, branch: "x", sha: null, status: "failed" };
    const [o] = overlapReadings([alpha, failed], ["shared.ts"]);
    expect(o.of).toBe(1);
    expect(o.reading).toBe("UNMEASURED");
  });
});
