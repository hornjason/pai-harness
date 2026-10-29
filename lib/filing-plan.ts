/**
 * Whether a filing was planned — the cap's second route.
 *
 * `FILINGS_PER_RUN` is 1 per checkout per day and it is deliberately not
 * configurable: a cap read from config is a cap an agent raises. That number
 * was calibrated against one population, a REVIEW FINDING filed mid-change —
 * Cloudflare's 1.2 findings per review, and this machine's 0.23 filings per
 * run per day across 284 worktrees.
 *
 * Decomposing a spec criterion into issues is a different population. It is
 * the thing the backlog is supposed to fill with, it is authored before
 * anything is created, and by design it produces SEVERAL issues in one run. A
 * cap of 1 does not slow that down, it forbids it — so a tool whose whole job
 * is step 4 of ADR-003 could not exist under the cap, and the version of it
 * that did exist would be the one that never asked.
 *
 * ## Why this is a count and not a judgement
 *
 * The gate's own record says a BAR gets argued into: on 2026-10-24 three of
 * three filings cleared *"it makes a green check lie"*, each on an
 * individually sound argument. So the exemption here is not "this filing is
 * planned work" — an agent can say that about anything. It is:
 *
 *   the title appears, verbatim, in a plan file that is committed on
 *   `origin/main`
 *
 * which an agent cannot argue into. It has to get a plan reviewed and merged
 * first — and that merged plan is exactly the human reading the cap stands in
 * for. The plan file is the reservation, in the same sense
 * `specs/sc-reservations.json` is.
 *
 * ## Four properties, each the opposite of a way this could be beaten
 *
 * - **Read from `origin/main`, never the working tree.** A plan file sitting
 *   uncommitted beside the filing is not a reviewed plan, and a stale tree
 *   and a missing file look identical from inside one. `git show
 *   origin/main:<path>` is the whole of the difference.
 * - **The filer does not choose the plan.** No path argument. The directory
 *   is `PLAN_DIR`, fixed here. A `--plan` flag would let an agent nominate
 *   its own exemption, which is the cap with extra steps.
 * - **Exact equality, never a substring.** `lib/issue-create-override.ts`
 *   records what the other spelling cost: `cmd.includes('follow-up')` passed
 *   any command with the word anywhere in it, including inside a title. A
 *   substring match here would exempt every filing whose title contains a
 *   planned one.
 * - **Fail CLOSED.** Every failure to read — no git, no such ref, no such
 *   directory, an unparseable file — returns `planned: false`. This is the
 *   opposite direction from the dedupe's fail-open, and deliberately: a
 *   dedupe that cannot run costs a duplicate, and an exemption that cannot be
 *   read would cost the cap itself.
 */
import { spawnSync } from "child_process";

/**
 * Where a reviewed plan lives.
 *
 * `docs/adr/` rather than a new directory, because it is already where this
 * repository keeps them: ADR-004 is an issue plan by its own title and
 * ADR-005 is the repair plan `plan-issues --repair` reads. A second home for
 * the same kind of document would be a second place to look.
 */
export const PLAN_DIR = "docs/adr";

/** The column whose cells are issue titles. The header spelling is the contract. */
export const TITLE_COLUMN = "Outcome";

/** How long `git show` may take before the reading is abandoned (and so refused). */
export const GIT_TIMEOUT_MS = 10_000;

export type PlanReading =
  /** The title is named by a plan on `origin/main`. */
  | { planned: true; plan: string; line: number }
  /**
   * It is not — or could not be shown to be, which is the same answer here
   * and a different `why`. Both deny the exemption; only one is a bug.
   */
  | { planned: false; why: string };

/** One authorised title, and where it was declared. */
export interface PlannedTitle {
  title: string;
  line: number;
}

/** Strip the decoration a markdown cell may carry, so `` `x` `` and `x` agree. */
function cell(text: string): string {
  return text.trim().replace(/^\*\*|\*\*$/g, "").replace(/^`|`$/g, "").trim();
}

/**
 * Every title a plan file authorises.
 *
 * A table qualifies when one of its header cells is exactly `TITLE_COLUMN`;
 * the titles are that column's cells in the rows beneath it. A file may hold
 * several such tables and none of them has to be the first table in the file,
 * because a plan that opens with a summary table is the normal shape.
 *
 * An empty cell is not a title. Without that, a table with a blank Outcome
 * authorises a filing whose title is the empty string — and `gh` will not
 * create one, but `createIssue` through Octokit would.
 *
 * **A fenced block and an HTML comment are not plan content.** An ADR that
 * shows what a plan table should look like, inside a ` ``` ` fence, or that
 * keeps a superseded table commented out, is the normal shape in this
 * repository — `.claude/rules/*.md` are mostly illustrative markdown inside
 * fences. Reading either as live would let an EXAMPLE authorise a filing, so
 * the "an agent cannot argue into this" property would hold only for files
 * nobody wrote an example in. Found by the AI review of this change.
 */
export function plannedTitles(content: string): PlannedTitle[] {
  const lines = content.split("\n");
  const out: PlannedTitle[] = [];
  let column: number | null = null;
  /** The opening run of a fence we are inside — `` ``` `` or `~~~` — or `null`. */
  let fence: string | null = null;
  /** Whether we are inside a `<!-- … -->` that spans lines. */
  let commented = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Both regions below also END the table they interrupt, the same way a
    // line of prose does, so `column` is reset on every one of their lines.
    if (commented) {
      if (line.includes("-->")) commented = false;
      column = null;
      continue;
    }
    const run = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      // Only the SAME marker, at least as long, closes it: a ``` inside a
      // ~~~ block is content. An unclosed fence swallows the rest of the
      // file, which is the fail-closed direction and the one we want.
      if (run !== undefined && run[0] === fence[0] && run.length >= fence.length) fence = null;
      column = null;
      continue;
    }
    if (run !== undefined) {
      fence = run;
      column = null;
      continue;
    }
    if (line.includes("<!--") && !line.includes("-->")) {
      commented = true;
      column = null;
      continue;
    }

    if (!line.trimStart().startsWith("|")) {
      // A non-table line ends the table. Without this a second table's rows
      // are read against the first table's column index.
      column = null;
      continue;
    }
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(cell);
    if (column === null) {
      const at = cells.indexOf(TITLE_COLUMN);
      if (at !== -1) column = at;
      continue;
    }
    const title = cells[column];
    if (title !== undefined && title !== "") out.push({ title, line: i + 1 });
  }
  return out;
}

/** What a reading of one ref needs. Injected so a test never shells out. */
export interface PlanSource {
  /** Paths under `PLAN_DIR` on the ref, or `null` when they could not be listed. */
  list: () => string[] | null;
  /** A path's content on the ref, or `null` when it could not be read. */
  show: (path: string) => string | null;
}

/** `git`, reading `origin/main` and never the working tree. */
export function gitSource(root: string, ref: string = "origin/main"): PlanSource {
  const git = (args: string[]): string | null => {
    const r = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
    });
    // A non-zero exit, a signal, or a timeout are all "could not read". None
    // of them is an empty plan directory, and the caller must not treat them
    // as one — hence `null` rather than `""`.
    if (r.error !== undefined || r.status !== 0) return null;
    return r.stdout;
  };
  return {
    /**
     * **`:(top)` and `--full-name`, and neither is optional.**
     *
     * `root` is the gate's `projectRoot`, which is a session's cwd and need
     * not be the checkout's top level — `runIdFor` says so in as many words,
     * that `/wt/x` and `/wt/x/lib` are one run. A bare `docs/adr/` pathspec
     * is resolved relative to the `-C` directory, so from `/wt/x/lib` git
     * looks for `/wt/x/lib/docs/adr/` on the ref, finds nothing, and
     * **exits 0 with empty output** — which is not a read failure and so is
     * not `null`. The exemption would then be denied for every filing in
     * every session not rooted exactly at the top level, silently, and the
     * `why` would say the repository has no plans.
     *
     * `:(top)` makes the pathspec root-relative and finds them. On its own
     * it is not enough: the paths it PRINTS are still relative to the cwd
     * (`../../docs/adr/a.md` from two levels down), and `show` would then be
     * handed `origin/main:../../docs/adr/a.md`. `--full-name` prints them
     * from the root, which is the form `<ref>:<path>` wants. Measured both
     * ways on 2026-10-29; found by the AI review of this change.
     */
    list: () => {
      const out = git([
        "ls-tree", "-r", "--full-name", "--name-only", ref, "--", `:(top)${PLAN_DIR}/`,
      ]);
      if (out === null) return null;
      return out.split("\n").map(s => s.trim()).filter(s => s.endsWith(".md"));
    },
    show: path => git(["show", `${ref}:${path}`]),
  };
}

/**
 * Whether a merged plan names this exact title.
 *
 * The reading is over every plan file on the ref, so a filing is planned when
 * ANY of them names it. That is wider than naming one plan and is still not
 * gameable: every one of those files had to be merged.
 */
export function plannedFiling(title: string, source: PlanSource): PlanReading {
  const wanted = title.trim();
  // An empty title matching an empty cell would exempt the degenerate filing,
  // and `plannedTitles` already drops empty cells — this is the second half of
  // the same property, stated where the comparison happens.
  if (wanted === "") return { planned: false, why: "the filing has no title" };

  const paths = source.list();
  if (paths === null) {
    return {
      planned: false,
      why:
        `the plans on the merged ref could not be listed, so nothing can say whether ` +
        `this title was planned — an unreadable plan denies the exemption rather than granting it`,
    };
  }
  if (paths.length === 0) {
    return { planned: false, why: `no plan files under ${PLAN_DIR}/ on the merged ref` };
  }

  for (const path of paths) {
    const content = source.show(path);
    if (content === null) continue; // Unreadable file: contributes no titles, denies nothing else.
    for (const t of plannedTitles(content)) {
      if (t.title === wanted) return { planned: true, plan: path, line: t.line };
    }
  }
  return {
    planned: false,
    why:
      `no plan on the merged ref names "${wanted.slice(0, 80)}" in an \`${TITLE_COLUMN}\` ` +
      `column — add the row, merge it, then file`,
  };
}
