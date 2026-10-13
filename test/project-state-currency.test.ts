/**
 * PROJECT-STATE.md is how a human finds out where the project is. Nothing
 * made it go red when it stopped being true.
 *
 * `.git/hooks/pre-commit` runs `scripts/update-project-state.ts` on every
 * commit and printed `✅ Updated PROJECT-STATE.md` every time. That script
 * only RE-RENDERS the markdown from `project-state.json`; writing session
 * content is the DA's job (CLAUDE.md: "PROJECT-STATE.md at milestones, and
 * the DA writes it"). On 2026-10-12 eight commits and four merges went by
 * reporting success while the latest recorded session stayed at 38, dated
 * the previous day.
 *
 * So the state file was stale, the tool said it was fine, and the only thing
 * that would have caught it was somebody remembering. This is that, made
 * mechanical.
 *
 * ## What is and is not automated here
 *
 * The NARRATIVE cannot be generated — which four defects were the same class,
 * what the lesson was, what policy changed. That is the content worth having
 * and a machine cannot write it.
 *
 * Noticing it is MISSING is pure mechanism: compare the merges on `main`
 * against what the latest session entry accounts for. So this refuses rather
 * than auto-writes, which is the same choice every other guard here makes —
 * a generated placeholder would satisfy the check and tell the reader
 * nothing, which is strictly worse than the staleness it replaced.
 *
 * Covers SC-751, SC-752 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const STATE = join(ROOT, "project-state.json");

interface Merge { sha: string; date: string; subject: string; pr: string | null }

/**
 * Landed PRs on `main`, newest first.
 *
 * NOT `--merges`. This repo squash-merges, so a landed PR is an ordinary
 * first-parent commit whose subject GitHub suffixes with `(#N)`. The first
 * version of this probe asked for `--merges` and passed locally on old true
 * merges while being blind to every squash — which is to say blind to how
 * every recent PR actually lands. A detector narrower than what it detects,
 * in the file written to catch exactly that.
 *
 * argv form, and `--no-pager`, because this runs in CI where a pager would
 * hang. A git invocation that fails must be visible rather than returning an
 * empty list — an empty list makes every assertion below pass.
 */
function logArgs(sinceISO: string, extra: string[] = []): string[] {
  return ["--no-pager", "log", "origin/main", "--first-parent", ...extra,
          `--since=${sinceISO}`, "--format=%H%x1f%cI%x1f%s"];
}

function mergesOnMain(sinceISO: string, extra: string[] = []): { ok: boolean; merges: Merge[]; detail: string } {
  try {
    const out = execFileSync(
      "git",
      logArgs(sinceISO, extra),
      { cwd: ROOT, encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const merges = out.split("\n").filter(Boolean).map(line => {
      const [sha, date, subject] = line.split("\x1f");
      // The trailing `(#N)` GitHub appends on squash, or `Merge pull request #N`.
      const m = /\(#(\d+)\)\s*$/.exec(subject) || /^Merge pull request #(\d+)/.exec(subject);
      return { sha, date, subject, pr: m ? m[1] : null };
    });
    return { ok: true, merges, detail: "" };
  } catch (e: any) {
    return { ok: false, merges: [], detail: e?.message?.slice(0, 300) ?? String(e) };
  }
}

/**
 * A shallow clone can produce an empty log for a reason that has nothing to do
 * with the project state. CI fetches the comparison base, so this should be
 * false there — and if it ever goes true, the readability case says UNMEASURED
 * out loud rather than letting the comparison report clean.
 */
function isShallow(): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-shallow-repository"],
      { cwd: ROOT, encoding: "utf-8", timeout: 10_000 }).trim() === "true";
  } catch { return false; }
}

const state = JSON.parse(readFileSync(STATE, "utf-8"));
const latestDate: string = state.session?.date ?? "";

/**
 * PRs that landed on `main` after `dateStr`, as one-line descriptions.
 * `null` means the log could not be read.
 */
function prsLandedAfter(dateStr: string): string[] | null {
  const r = mergesOnMain(dateStr);
  if (!r.ok) return null;
  return r.merges
    .filter(m => m.pr !== null && m.date.slice(0, 10) > dateStr)
    .map(m => `${m.date.slice(0, 10)} ${m.sha.slice(0, 8)} ${m.subject.slice(0, 70)}`);
}

describe("project-state currency", () => {
  test("the file names a latest session with a date", () => {
    expect(latestDate, "project-state.json has no session.date — nothing to compare against").toMatch(
      /^\d{4}-\d{2}-\d{2}/,
    );
  });

  test("git is readable — an unreadable log is UNMEASURED, not clean", () => {
    // Without this, a failed git invocation returns zero commits and every
    // assertion below passes for the wrong reason. The defect this whole
    // file exists to catch, in the file that catches it.
    const r = mergesOnMain("2026-01-01");
    expect(r.ok, `git log failed: ${r.detail}`).toBe(true);
    if (isShallow() && r.merges.length === 0) {
      // Say it rather than pass quietly. A shallow clone with no base fetched
      // cannot answer the question; the generated CI job fetches `origin/main`
      // precisely so it can.
      console.warn(
        "project-state currency: UNMEASURED — shallow clone with no origin/main history. " +
          "The currency comparison below has nothing to read.",
      );
      return;
    }
    expect(r.merges.length, "no landed PRs found on origin/main at all — the probe is reading nothing")
      .toBeGreaterThan(0);
  });

  test("the probe sees squashes, which is how PRs actually land here", () => {
    // SC-754. The first version asked git for `--merges` and was green: there
    // are old true merges in this history, so the readability case passed,
    // and no merge commit had landed since the last session so the comparison
    // passed too. Reverting the fix scored 0 red — the distinction was
    // unmeasured, in the file written to catch exactly this.
    //
    // Empirical rather than a source grep, and no fixed sha: run the probe
    // both ways over the same window and assert the restricted one sees
    // strictly less. The filter is composed rather than written as a literal,
    // so this assertion is not itself the evidence for it.
    const MERGES_ONLY = `--${"merges"}`;
    const WINDOW = "2026-09-17"; // the repo's first commit
    const all = mergesOnMain(WINDOW);
    const mergeCommitsOnly = mergesOnMain(WINDOW, [MERGES_ONLY]);
    if (!all.ok || !mergeCommitsOnly.ok) return; // reported by the readability case
    if (isShallow() && all.merges.length === 0) return;

    const landed = all.merges.filter(m => m.pr !== null).length;
    const asMergeCommits = mergeCommitsOnly.merges.filter(m => m.pr !== null).length;
    expect(
      landed,
      `the probe found ${landed} landed PRs and ${asMergeCommits} merge commits. ` +
        `If those are equal, either the repo stopped squash-merging or the probe ` +
        `went back to asking only for merge commits — and the second is a probe ` +
        `blind to every PR that lands here.`,
    ).toBeGreaterThan(asMergeCommits);
    expect(logArgs("x"), "the default probe must not restrict to merge commits")
      .not.toContain(MERGES_ONLY);
  });

  test("no PR has landed since the last recorded session", () => {
    // The whole point, and narrower than the first version of it.
    //
    // That version demanded every landed PR be mentioned BY NUMBER somewhere
    // in the state file, and CI — the first run that could see any history —
    // produced twenty-four. The premise was wrong: project-state.json is a
    // narrative of what changed and why, not an index of issue numbers, and
    // sessions 36 through 38 are correct without enumerating theirs. A check
    // that demands enumeration would turn the file into a changelog nobody
    // reads, which is what it is explicitly not.
    //
    // What actually went wrong on 2026-10-12 was staleness of the DATE:
    // eight commits and four merges landed while the newest entry still read
    // session 38, dated the day before. So that is what this measures. One
    // day of granularity, and CLAUDE.md already requires the DA to update
    // after every merge.
    const after = prsLandedAfter(latestDate);
    if (after === null) return; // reported by the readability case
    expect(
      after,
      `project-state.json's newest session is dated ${latestDate} and these PRs landed after it. ` +
        `PROJECT-STATE.md is generated from this file and is what a human reads to find out ` +
        `where the project is, so a date behind the tree is the file lying. Add a session entry ` +
        `— the narrative is the point, so write what the change WAS, not that it happened.`,
    ).toEqual([]);
  });

  test("the staleness comparison fires on a date that IS stale", () => {
    // The case above passes when nothing has landed today, which is also what
    // it looks like when the comparison stops comparing. Neutralising the
    // date test scored 0 red without this.
    const stale = prsLandedAfter("2026-10-01");
    if (stale === null) return; // reported by the readability case
    if (isShallow() && stale.length === 0) return; // no history to compare against
    expect(
      stale.length,
      "no PR has landed since 2026-10-01 — either the probe stopped reading or this " +
        "repo has been quiet for the whole window, and the first is far likelier.",
    ).toBeGreaterThan(0);
  });

  test("the generated markdown matches the json it is generated from", () => {
    // The two drifting is the other way this misleads: a correct json and a
    // markdown rendered from an older one.
    const md = readFileSync(join(ROOT, "PROJECT-STATE.md"), "utf-8");
    expect(existsSync(join(ROOT, "PROJECT-STATE.md"))).toBe(true);
    expect(
      md.includes(latestDate),
      `PROJECT-STATE.md does not mention ${latestDate}, the latest session in project-state.json. ` +
        `Run \`bun scripts/update-project-state.ts\` — the markdown is generated, never hand-edited.`,
    ).toBe(true);
  });

  test("the renderer reports what it changed, not that it ran", () => {
    // It printed a green "✅ Updated PROJECT-STATE.md (25/25 SCs done)" on
    // every commit regardless, which is why eight commits of staleness went
    // unnoticed. The count was Phase 0+1's, complete for weeks and unable to
    // move.
    const src = readFileSync(join(ROOT, "scripts", "update-project-state.ts"), "utf-8");
    expect(src, "the unconditional success message is back").not.toMatch(
      /console\.log\(`✅ Updated PROJECT-STATE\.md \(\$\{state\.phases/,
    );
    expect(src).toContain("This script re-renders; it does not write session content.");
  });
});
