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

import { localCalendarDay } from "../lib/local-calendar-day";

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
 * The one timezone every date in this comparison is resolved in (#766).
 *
 * Both sides of the comparison are calendar days, and a calendar day has no
 * meaning without a zone. Before this was declared, the two sides were
 * computed in two DIFFERENT zones and neither was this one:
 *
 *   - the session date is stamped by `scripts/update-project-state.ts`
 *     through `localCalendarDay()` (#600), which uses the PROCESS zone — the
 *     DA's machine;
 *   - the probe took `%cI`.slice(0, 10), and `%cI` renders each commit in
 *     ITS OWN RECORDED OFFSET, which varies commit to commit on one branch.
 *
 * A third frame then arrived for free: the comparison runs in CI, where the
 * process zone is UTC, so the same probe over the same tree could answer
 * differently locally and in CI.
 *
 * This is the zone the stamper runs in. If that ever stops being true, both
 * must move together — which is the argument for there being exactly one
 * place to change, rather than a `slice(0, 10)` at each use site.
 */
export const CURRENCY_ZONE = "America/New_York";

/**
 * The calendar day a commit instant falls on, in the one frame.
 *
 * The INSTANT is zone-free and every spelling of it is equally correct;
 * `new Date()` parses the offset and discards it, which is the whole point.
 * What must not survive into the verdict is the offset the committer's
 * machine happened to record.
 */
export function commitDay(isoInstant: string): string {
  const at = new Date(isoInstant);
  if (Number.isNaN(at.getTime())) {
    // Loud. A day key of "Invalid Date" sorts below every real date, so a
    // commit nobody could parse would silently read as ancient and clear.
    throw new Error(`commitDay: unparseable commit instant ${JSON.stringify(isoInstant)}`);
  }
  return localCalendarDay(at, CURRENCY_ZONE);
}

/**
 * The decision, as one binding over data, so a case can drive it with
 * commits that do not exist.
 *
 * The real path feeds it `git log`; the frame cases feed it a synthetic pair
 * whose real-time order is the reverse of their recorded-offset order. That
 * pair cannot be built out of this repository's history — the property is
 * about a spelling, and the tree has whichever spellings it has.
 */
export function landedAfter(merges: Merge[], sessionDay: string): string[] {
  return merges
    .filter(m => m.pr !== null && commitDay(m.date) > sessionDay)
    .map(m => `${commitDay(m.date)} ${m.sha.slice(0, 8)} ${m.subject.slice(0, 70)}`);
}

/**
 * How far before the session day the git window opens (#766).
 *
 * `--since` is parsed by git in the RUNNER's zone, so handing it the session
 * day makes the WINDOW a third frame on top of the two the comparison
 * already had — and the window silently decides the verdict, because a
 * commit outside it is a commit the filter never sees.
 *
 * Measured on `main` at `7de6c4e6` on 2026-10-19, session day 2026-10-19:
 *
 *     --since=2026-10-19           ->  0 commits   (TZ=America/New_York)
 *     TZ=UTC --since=2026-10-19    -> 53 commits
 *
 * Zero. So `prsLandedAfter(latestDate)` returned `[]` on every local run and
 * the case below passed having read nothing, which is indistinguishable from
 * passing because the state file is current. CI, running in UTC, read 53 and
 * went red — the same probe, the same tree, opposite answers.
 *
 * The fix is to stop asking the window to be exact. It is an optimisation to
 * avoid walking the whole history; the DECISION belongs to `landedAfter`,
 * which resolves one frame. Three days of slack is far more than any zone
 * difference can account for, and the case below asserts the window is not
 * empty, so a window that stopped reading cannot read as a clean result.
 */
const WINDOW_MARGIN_DAYS = 3;

/** The `--since` argument: the session day, less the margin, in UTC. */
export function windowStart(sessionDay: string): string {
  const at = new Date(`${sessionDay}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`windowStart: unparseable session day ${JSON.stringify(sessionDay)}`);
  }
  at.setUTCDate(at.getUTCDate() - WINDOW_MARGIN_DAYS);
  return localCalendarDay(at, "UTC");
}

/**
 * PRs that landed on `main` after `dateStr`, as one-line descriptions.
 * `null` means the log could not be read.
 */
function prsLandedAfter(dateStr: string): string[] | null {
  const r = mergesOnMain(windowStart(dateStr));
  if (!r.ok) return null;
  return landedAfter(r.merges, dateStr);
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
    // The escape hatch keys on the RAW READ, not on the answer (#766).
    //
    // It used to be `isShallow() && stale.length === 0`, and `stale.length
    // === 0` is both of the states this case exists to tell apart: "a shallow
    // clone has no history to compare" and "the comparison stopped
    // comparing". So the guard disabled the control at exactly the moment the
    // control was needed. Measured: `git rev-parse --is-shallow-repository`
    // is TRUE in a worktree of this repo and in CI's `actions/checkout@v4`,
    // so short-circuiting `landedAfter` to `return []` scored 0 red here
    // where 1 was predicted — the case silently returned.
    //
    // Whether commits were READ is a different question from whether any of
    // them are late, and only the first one can honestly excuse the case.
    const r = mergesOnMain(windowStart("2026-10-01"));
    if (!r.ok) return; // reported by the readability case
    if (r.merges.length === 0) {
      console.warn(
        "project-state currency: UNMEASURED — the staleness control read no commits at all. " +
          "A shallow clone with no origin/main history cannot answer this.",
      );
      return;
    }
    expect(
      landedAfter(r.merges, "2026-10-01").length,
      `the window read ${r.merges.length} commits and none of them keyed later than ` +
        `2026-10-01 — either the comparison stopped comparing or this repo has been ` +
        `quiet for the whole window, and the first is far likelier.`,
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

  test("#766: the window the real comparison reads is not empty", () => {
    // The subject, established before the absence is asserted. The main case
    // below asserts an empty list, and an empty list is what a window that
    // read nothing also produces — which is exactly what happened: locally
    // `--since=<session day>` returned 0 commits and the case was green on
    // every run, while CI read 53 and went red.
    const r = mergesOnMain(windowStart(latestDate));
    expect(r.ok, `git log failed: ${r.detail}`).toBe(true);
    if (isShallow() && r.merges.length === 0) return; // reported as UNMEASURED above
    expect(
      r.merges.length,
      `the window opening at ${windowStart(latestDate)} read no commits at all, so the ` +
        `currency comparison below has nothing to decide over and passes vacuously`,
    ).toBeGreaterThan(0);
  });

  test("#766: the window opens strictly before the session day", () => {
    // A margin of zero restores the defect, and a margin computed in the
    // wrong direction is worse than none — it would open the window AFTER
    // the session and read nothing by construction.
    expect(windowStart("2026-10-19")).toBe("2026-10-16");
    expect(windowStart("2026-01-01")).toBe("2025-12-29"); // across a year boundary
    expect(windowStart("2026-03-01")).toBe("2026-02-26"); // across a short month
    expect(windowStart(latestDate) < latestDate).toBe(true);
  });

  test("#766: one instant spelled two ways is one day", () => {
    // The pair varies EXACTLY one thing — the recorded offset — and holds the
    // instant fixed, which is the only way to measure the frame rather than
    // the clock (#585's pair discipline). These two strings are the same
    // moment, and they are not invented: `990688a0` landed at
    // 2026-10-19T20:34:21-04:00 and `7de6c4e6` five minutes later at
    // 2026-10-20T00:39:26Z, and the probe flagged the second and cleared the
    // first.
    const asOffset = "2026-10-19T20:34:21-04:00";
    const asUtc = "2026-10-20T00:34:21Z";

    // Establish that the two spellings really are one instant before
    // asserting anything about how they are collapsed. If they were not, the
    // case below would be comparing two different moments and would pass for
    // a reason that has nothing to do with the frame.
    expect(new Date(asOffset).getTime()).toBe(new Date(asUtc).getTime());

    // And that the naive reading — the defect — genuinely disagrees. Without
    // this the case is green on a tree where `slice(0, 10)` happens to work,
    // and the mutation it exists to catch would be invisible.
    expect(asOffset.slice(0, 10)).not.toBe(asUtc.slice(0, 10));

    expect(commitDay(asOffset)).toBe(commitDay(asUtc));
  });

  test("#766: the day key is monotonic in real time", () => {
    // The consequence that makes the frame bug more than strictness. Day keys
    // derived from per-commit offsets are not ordered by instant, so the
    // probe could refuse an EARLIER commit while clearing a later one.
    //
    // `earlier` is 00:05Z; `later` is 02:00Z the same morning, spelled in the
    // zone its committer was in. On the naive reading `earlier` keys to
    // 2026-10-20 and `later` keys to 2026-10-19 — backwards.
    const earlier = "2026-10-20T00:05:00Z";
    const later = "2026-10-19T22:00:00-04:00";
    expect(new Date(earlier).getTime()).toBeLessThan(new Date(later).getTime());
    expect(earlier.slice(0, 10) > later.slice(0, 10), "the naive keys are already ordered — this pair witnesses nothing").toBe(true);

    expect(commitDay(earlier) <= commitDay(later)).toBe(true);
  });

  test("#766: the verdict does not depend on how a commit spells its offset", () => {
    // Driven through the decision the real path uses, not through the helper
    // alone — a correct `commitDay` beside a `landedAfter` that still slices
    // is the same defect wearing a fix.
    const mk = (date: string, sha: string): Merge =>
      ({ sha, date, subject: `fix(#1): a change (#${sha.slice(0, 2)})`, pr: "1" });

    const sessionDay = "2026-10-19";
    const offsetSpelling = landedAfter([mk("2026-10-19T20:34:21-04:00", "aaaaaaaa")], sessionDay);
    const utcSpelling = landedAfter([mk("2026-10-20T00:34:21Z", "aaaaaaaa")], sessionDay);

    expect(utcSpelling, "a commit at 20:34 local, spelled in UTC, was read as a later day").toEqual([]);
    expect(offsetSpelling).toEqual(utcSpelling);
  });

  test("#766: a commit on a genuinely later day is still flagged", () => {
    // The control against the cheapest wrong fix in the other direction —
    // making the comparison never fire. Satisfying SC-1 by widening the frame
    // until nothing is ever late would turn every case above green.
    //
    // 2026-10-21T12:00Z is midday in every zone on earth, so this is late by
    // two days in any frame the constant could name.
    const late: Merge = {
      sha: "bbbbbbbb", date: "2026-10-21T12:00:00Z",
      subject: "fix(#2): a later change (#2)", pr: "2",
    };
    expect(landedAfter([late], "2026-10-19").length).toBe(1);
  });

  test("#766: an unparseable commit instant refuses rather than reading as ancient", () => {
    // A day key of "Invalid Date" sorts below every real date, so a commit
    // nobody could parse would clear the gate silently. `0`, `{}` and a
    // string that is not a date are all indistinguishable from success.
    expect(() => commitDay("not-a-date")).toThrow(/unparseable/);
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
