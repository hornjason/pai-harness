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

interface Merge { sha: string; date: string; subject: string; issue: string | null }

/**
 * Merge commits on `main`, newest first.
 *
 * argv form, and `--no-pager`, because this runs in CI where a pager would
 * hang. A git invocation that fails must be visible rather than returning an
 * empty list — an empty list makes every assertion below pass.
 */
function mergesOnMain(sinceISO: string): { ok: boolean; merges: Merge[]; detail: string } {
  try {
    const out = execFileSync(
      "git",
      ["--no-pager", "log", "origin/main", "--merges", "--first-parent",
       `--since=${sinceISO}`, "--format=%H%x1f%cI%x1f%s"],
      { cwd: ROOT, encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const merges = out.split("\n").filter(Boolean).map(line => {
      const [sha, date, subject] = line.split("\x1f");
      const m = /#(\d+)\)?\s*$/.exec(subject) || /\(#(\d+)\)/.exec(subject) || /#(\d+)/.exec(subject);
      return { sha, date, subject, issue: m ? m[1] : null };
    });
    return { ok: true, merges, detail: "" };
  } catch (e: any) {
    return { ok: false, merges: [], detail: e?.message?.slice(0, 300) ?? String(e) };
  }
}

const state = JSON.parse(readFileSync(STATE, "utf-8"));
const latestDate: string = state.session?.date ?? "";
/** Everything the newest session entry says, as one searchable blob. */
const latestText = JSON.stringify([state.session, (state.sessions || []).slice(-1)]);

describe("project-state currency", () => {
  test("the file names a latest session with a date", () => {
    expect(latestDate, "project-state.json has no session.date — nothing to compare against").toMatch(
      /^\d{4}-\d{2}-\d{2}/,
    );
  });

  test("git is readable — an unreadable log is UNMEASURED, not clean", () => {
    // Without this, a failed git invocation returns zero merges and every
    // assertion below passes for the wrong reason. The defect this whole
    // file exists to catch, in the file that catches it.
    const r = mergesOnMain("2026-01-01");
    expect(r.ok, `git log failed: ${r.detail}`).toBe(true);
    expect(r.merges.length, "no merges found on origin/main at all — the probe is reading nothing")
      .toBeGreaterThan(0);
  });

  test("every merge since the last recorded session is accounted for", () => {
    // The whole point. A merge landing on main that the state file does not
    // mention means PROJECT-STATE.md is telling its reader something false.
    const r = mergesOnMain(latestDate);
    if (!r.ok) return; // reported by the case above
    const unaccounted = r.merges.filter(m => {
      if (!m.issue) return false; // a merge with no issue number is not trackable this way
      return !latestText.includes(`#${m.issue}`);
    });
    expect(
      unaccounted.map(m => `${m.date.slice(0, 10)} ${m.sha.slice(0, 8)} ${m.subject.slice(0, 70)}`),
      `project-state.json's latest session (${latestDate}) does not mention these merges. ` +
        `PROJECT-STATE.md is generated from this file and is what a human reads to find out ` +
        `where the project is, so a merge missing from it is the file lying. Add them to ` +
        `\`session\` and \`sessions\` — the narrative is the point, so write what the change ` +
        `WAS, not that it happened.`,
    ).toEqual([]);
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
