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

/** A GFM table's second line — the thing that makes the line above it a header. */
const DELIMITER = /^\s*\|[\s|:-]+\|\s*$/;

/** Leading indentation in columns; a tab is four, as CommonMark counts it. */
function indent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * One line with its `<!-- … -->` regions removed, and the state after it.
 *
 * Positional, not `includes`: a line may close a comment and open another,
 * and it may carry live markdown either side of a comment that opens and
 * closes within it. A text scan that only asks whether a delimiter is
 * PRESENT gets both wrong, and gets them wrong toward reading commented-out
 * content as live.
 *
 * When a comment opens and is still open at end of line, everything before
 * it is dropped too. That loses a row a renderer would have shown — the
 * direction that denies an exemption rather than inventing one.
 */
function uncommented(line: string, inComment: boolean): { text: string; commented: boolean } {
  let rest = line;
  if (inComment) {
    const end = rest.indexOf("-->");
    if (end === -1) return { text: "", commented: true };
    rest = rest.slice(end + 3);
  }
  let text = "";
  for (;;) {
    const open = rest.indexOf("<!--");
    if (open === -1) return { text: text + rest, commented: false };
    const close = rest.indexOf("-->", open + 4);
    if (close === -1) return { text: "", commented: true };
    text += rest.slice(0, open);
    rest = rest.slice(close + 3);
  }
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
 * **A fenced block, an indented block and an HTML comment are not plan
 * content.** An ADR that shows what a plan table should look like, inside a
 * ` ``` ` fence, or that keeps a superseded table commented out, is the
 * normal shape in this repository — `.claude/rules/*.md` are mostly
 * illustrative markdown inside fences. Reading any of them as live would let
 * an EXAMPLE authorise a filing, so the "an agent cannot argue into this"
 * property would hold only for files nobody wrote an example in.
 *
 * ## Agreeing with the renderer is the whole requirement
 *
 * The reviewer of a plan reads what GitHub renders. This function reads the
 * bytes. **Every place the two disagree is a filing a reviewer approved
 * without seeing**, so this is not markdown parsing for its own sake — the
 * differential IS the bypass. Four were found, all in the same direction:
 * rendered inert, parsed live. Each is handled to CommonMark's rule and each
 * has a case below.
 *
 * - A closing fence may not carry an info string. ` ```js ` after an open
 *   ` ```md ` does not close it, so a parser that accepts it treats the rest
 *   of a code block as a plan.
 * - Four or more leading spaces is an indented code block.
 * - A comment nests by position, not by whether the line *contains* a
 *   delimiter: `-->` followed by `<!--` on one line leaves the comment open,
 *   and `includes` cannot see order.
 *
 * Where a reading stays ambiguous it is resolved toward NOT authorising: an
 * unclosed fence makes the rest of the file inert, a table indented under a
 * list item is not counted, a row cut short by a comment opening mid-line is
 * dropped, and a marker run CommonMark would reject as an opener opens one
 * here anyway. Each of those costs somebody a row they have to move and merge
 * again. The other direction costs the cap.
 */
export function plannedTitles(content: string): PlannedTitle[] {
  const lines = content.split("\n");
  const out: PlannedTitle[] = [];
  let column: number | null = null;
  /** The opening run of a fence we are inside — `` ``` `` or `~~~` — or `null`. */
  let fence: string | null = null;
  /** Whether we are inside a `<!-- … -->` that spans lines. */
  let commented = false;
  const opener = /^[ \t]*(`{3,}|~{3,})(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    // Every region below also ENDS the table it interrupts, the same way a
    // line of prose does, so `column` is reset on every one of their lines.

    // **Fence first, and on the RAW line.** A fence and a comment are two
    // states, and neither may be entered from inside the other: inside a
    // fence, `<!--` is literal text a renderer shows, so reading it as a
    // comment opens one that the matching `-->` — also literal, also inside
    // the fence — never closes, and the fence's own closing marker is then
    // eaten as comment content. One unbalanced `<!--` in an illustrative
    // snippet would silently cost every title in the rest of the file.
    // That direction only DENIES, but it denies a plan a reviewer merged and
    // the `why` would not say so. Found by the AI review of this change.
    if (fence !== null) {
      const c = indent(lines[i]) <= 3 ? opener.exec(lines[i]) : null;
      // Only the same marker, at least as long, AND nothing after it. A ```
      // inside a ~~~ block is content; so is ```js inside a ```md block,
      // which is the differential a bare marker test would miss.
      if (
        c !== null &&
        c[1][0] === fence[0] &&
        c[1].length >= fence.length &&
        c[2].trim() === ""
      ) {
        fence = null;
      }
      column = null;
      continue;
    }

    // Then comments, scanned by INDEX. `includes("-->")` cannot see order,
    // so one line closing a comment and opening another reads as closed —
    // and every line after it is live here while a renderer still has it
    // commented out. What survives this is the line's live text. While a
    // comment is open a fence marker inside it is literal, which is the
    // same rule as above with the two states swapped.
    const line = uncommented(lines[i], commented);
    commented = line.commented;
    if (commented || line.text.trim() === "") {
      column = null;
      continue;
    }
    const text = line.text;

    const ind = indent(text);
    const f = ind <= 3 ? opener.exec(text) : null;
    // Any marker run OPENS, info string or not — including the spellings
    // CommonMark would reject as openers. That is deliberate: refusing to
    // open leaves what follows live, and a reading this function is unsure
    // about must not be the one that authorises.
    if (f !== null) {
      fence = f[1];
      column = null;
      continue;
    }
    if (ind >= 4) {
      // An indented code block. A table legitimately indented this far under
      // a list item is not counted either — unindent it, or accept that the
      // strict reading denies rather than grants.
      column = null;
      continue;
    }

    if (!text.trimStart().startsWith("|")) {
      // A non-table line ends the table. Without this a second table's rows
      // are read against the first table's column index.
      column = null;
      continue;
    }
    if (DELIMITER.test(text)) continue;
    const cells = text.split("|").slice(1, -1).map(cell);

    // **A row followed by a delimiter is a HEADER, always.** That is what
    // starts a table in GFM, and keying off it is the only thing that sees a
    // second table beginning on the line after the first one ends. Scanning
    // for an `Outcome` cell only while `column` is unset does not: with no
    // blank line between them the index from table one stays live, and table
    // two's `| Criterion | Files |` is read as a data row — authorising the
    // literal string `Files`, and then every path in that column. Reproduced
    // on 2026-10-29; found by the AI review of this change.
    if (DELIMITER.test(lines[i + 1] ?? "")) {
      const at = cells.indexOf(TITLE_COLUMN);
      column = at === -1 ? null : at;
      continue;
    }
    if (column === null) continue;
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
