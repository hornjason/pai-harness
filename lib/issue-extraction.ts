/**
 * Reading a goal and its acceptance criteria out of an issue body (#210, #202).
 *
 * `scripts/precompute-goal.ts` replaces two ceremony agents with two regexes
 * run over the raw markdown of a GitHub issue. Both were wrong in the same
 * way, and the shared cause is worth stating before either case:
 *
 *   **The extractor had no model of the document it was reading.** It matched
 *   lines. A line inside a fenced code block, a line under a "Scope" heading,
 *   and a line the harness itself wrote into the issue are all just lines.
 *
 * Two measured instances:
 *
 *  - **#210.** Shipping #209, the criteria list came back as exactly one AC:
 *    ``SC-N: `workflows/ship.js` executes [MARKER-NAME]``. That is an
 *    illustration inside a fenced block showing the SYNTAX of a proposed SC.
 *    Marcus was about to be briefed with one acceptance criterion made
 *    entirely of placeholders, and nothing downstream would have asked.
 *  - **#202.** When a run rescopes an issue for the 6-AC limit it PREPENDS a
 *    blockquote banner, which then becomes the first paragraph and therefore
 *    the goal. Measured on #200: 414 characters describing the split, none
 *    describing the defect. The harness degraded its own input, and only on
 *    the LARGE issues where the goal statement matters most.
 *
 * ## Why this is a module and not twenty lines in the script
 *
 * It was twenty lines in the script, at module top level, so none of it was
 * reachable from a test — which is why both defects were found by reading
 * pipeline output by hand rather than by the suite. The functions here take a
 * string and return a value; every case below is a fixture.
 *
 * ## The direction these are allowed to be wrong in
 *
 * Toward extracting LESS and saying so. A criterion missed costs Discovery
 * writing one, which is the designed path. A criterion invented out of
 * documentation is briefed to an agent as a thing to build.
 */

/**
 * Markers that identify a blockquote as harness-authored metadata rather than
 * the author's prose.
 *
 * Exported and asserted against `workflows/ship.js`'s decompose prompt by
 * `test/issue-extraction.test.ts`, which is the "fails loudly" half: the
 * banner is written by an agent told to use this wording, so a change to the
 * instruction and no change here turns the suite red instead of silently
 * handing the banner back as a goal (#202).
 *
 * A leading blockquote carrying NONE of these is kept. That is the positive
 * control, and it is the whole difficulty of the case: a parser that
 * discarded every leading blockquote would pass the banner cases for free and
 * lose the goal of any issue whose author opens with a quote.
 */
export const HARNESS_BANNER_MARKERS = [
  "Rescoped to Phase",
  "Sub-issues:",
] as const;

/**
 * Line prefixes that make a leading paragraph harness-written front matter.
 *
 * Found by this change rather than reported: `test/fixtures/github/issue-48.json`
 * is a sub-issue, sub-issue bodies open with `Parent: #47`, and the old regex
 * took the first paragraph. So **every decomposed run has briefed its agent
 * with the goal "Parent: #N"** — eleven characters of cross-reference. Same
 * defect as #202's banner, one producer earlier and far more frequent: the
 * banner fires only on a rescope, this fires on every sub-issue.
 *
 * `workflows/ship.js`'s decompose step is told to write both lines, and
 * `test/issue-extraction.test.ts` asserts they are still in that prompt.
 *
 * A paragraph is skipped only when EVERY line in it is one of these and short.
 * An author writing a sentence that begins "Spec: the contract says…" keeps
 * their goal.
 */
export const HARNESS_PREAMBLE_MARKERS = [
  "Parent: #",
  "Spec: ",
] as const;

/** Above this, a line is prose that happens to start with a marker. */
const MAX_PREAMBLE_LINE_CHARS = 120;

/** A goal shorter than this is a failed extraction, not a terse author. */
export const MIN_GOAL_CHARS = 40;

/**
 * The one exit code every refusal in `scripts/precompute-goal.ts` routes
 * through, per `.claude/rules/checks-must-be-able-to-fail.md`. Declared once
 * so the test can build a mutant copy of the script with it set to `0` and
 * watch the refusals stop refusing.
 *
 * Not `1`: `1` is the usage error the script already exits with for missing
 * arguments, and a caller that cannot tell "you called me wrong" from "this
 * issue cannot be read" learns nothing from either.
 */
export const GOAL_REFUSE_EXIT = 3;

export interface GoalReading {
  /** The goal paragraph, or null when nothing usable was left. */
  goal: string | null;
  /** Non-null when the body yielded no goal a brief could be written from. */
  refusal: string | null;
  /** True when a harness banner was recognised and stepped over. */
  skippedBanner: boolean;
}

export interface CriteriaReading {
  criteria: string[];
  /** Where they came from, so "none found" can say which question it answered. */
  source: "success-criteria-section" | "none";
  /** Non-null when what was found cannot be briefed — see `isPlaceholder`. */
  refusal: string | null;
}

/**
 * Blank out code so a line inside it cannot be read as content.
 *
 * Lines are REPLACED with empty lines rather than removed: every caller below
 * reasons about headings and ordering, and silently renumbering the document
 * would make a section boundary land somewhere else than the author put it.
 *
 * Indented code is only recognised outside a list. Four-space indentation is
 * also how a nested checkbox is written, and `- [ ] SC-2` nested under a
 * bullet is an acceptance criterion in every issue in this repo — treating it
 * as code would delete real criteria to catch a rare fake one, which is the
 * wrong direction for this module to be wrong in.
 */
export function stripCodeBlocks(body: string): string {
  const lines = String(body ?? "").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let inList = false;

  for (const line of lines) {
    if (fence !== null) {
      // A closing fence is the same character, at least as long, alone on its
      // line. Anything else is content.
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      out.push("");
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null;
      continue;
    }

    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1]!;
      out.push("");
      continue;
    }

    if (line.trim() === "") {
      inList = false;
      out.push(line);
      continue;
    }

    // Indentation is checked BEFORE the list marker, and only outside a list.
    // An indented bullet is a nested list item when a list is open and an
    // indented code block when one is not, and the two are the same bytes —
    // the only thing that tells them apart is what came before.
    if (!inList && /^(?: {4,}|\t)/.test(line)) {
      out.push("");
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) {
      inList = true;
      out.push(line);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

/** `## Heading` → its level, or 0 for a line that is not a heading. */
function headingLevel(line: string): number {
  const m = line.match(/^(#{1,6})\s+\S/);
  return m ? m[1]!.length : 0;
}

/**
 * The lines under the Success Criteria heading, or null when there is none.
 *
 * Ends at the next heading of the SAME OR HIGHER level, so a `### Phase 2`
 * subsection inside the criteria is kept and the next `## Acceptance` is not.
 */
export function successCriteriaSection(body: string): string | null {
  const lines = String(body ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const level = headingLevel(lines[i]!);
    if (!level) continue;
    if (!/^#{1,6}\s+success\s+criteria\b/i.test(lines[i]!)) continue;
    const taken: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const nextLevel = headingLevel(lines[j]!);
      if (nextLevel > 0 && nextLevel <= level) break;
      taken.push(lines[j]!);
    }
    return taken.join("\n");
  }
  return null;
}

/**
 * Is this criterion made of placeholders rather than of a requirement?
 *
 * `SC-N`, `[MARKER-NAME]` and `<thing>` are how this repo writes a TEMPLATE.
 * An AC list consisting of them is the #210 reading exactly, and it reached
 * the point of being briefed.
 */
export function isPlaceholder(text: string): boolean {
  const s = String(text ?? "").trim();
  if (!s) return true;
  // SC- followed by anything that is not a digit: SC-N, SC-X, SC-NNN.
  if (/\bSC-(?![0-9])[A-Za-z]/.test(s) && !/\bSC-A\d/.test(s)) return true;
  // A bracketed ALL-CAPS slug, which is this repo's template notation.
  if (/\[[A-Z][A-Z0-9_-]{2,}\]/.test(s)) return true;
  // An angle-bracketed placeholder that is not an HTML tag or an email.
  if (/<[a-z][a-z0-9 _-]*>/i.test(s) && !/<\/|@/.test(s)) return true;
  if (/\b(?:TBD|TODO|FIXME|XXX)\b/.test(s)) return true;
  return false;
}

/**
 * Acceptance criteria, from the Success Criteria section only.
 *
 * **Section-scoped, not body-scoped.** The ship skill's own contract says
 * "all lines matching `- [ ] SC-` … under '## Success Criteria'"; the regex
 * it replaced ignored the heading and matched the whole document, so a
 * checklist under "Scope" or "Open questions" was silently promoted to an
 * acceptance criterion (#210).
 *
 * **No section is `[]`, not a refusal.** Most issues in this repo have none,
 * and Discovery authoring the ACs is the designed path. The refusal is for
 * criteria that were found and cannot be briefed.
 */
export function extractSuccessCriteria(body: string): CriteriaReading {
  const section = successCriteriaSection(stripCodeBlocks(body));
  if (section === null) {
    return { criteria: [], source: "none", refusal: null };
  }

  const criteria: string[] = [];
  // `SC-` is required, not decorative. The old pattern's `|.+` branch made
  // every `- [ ]` line qualify, so the prefix tested nothing.
  const line = /^\s*-\s*\[[ xX]\]\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = line.exec(section)) !== null) {
    const text = m[1]!.trim();
    if (text) criteria.push(text);
  }

  if (criteria.length === 0) {
    return { criteria, source: "success-criteria-section", refusal: null };
  }

  const fake = criteria.filter(isPlaceholder);
  if (fake.length === criteria.length) {
    return {
      criteria: [],
      source: "success-criteria-section",
      refusal:
        `every acceptance criterion read from this issue is a placeholder — ` +
        `${JSON.stringify(fake)}. Briefing an agent with a criterion made of ` +
        `placeholders is worse than briefing it with none, because Discovery ` +
        `writes criteria when there are none and accepts these when there are (#210).`,
    };
  }

  return { criteria, source: "success-criteria-section", refusal: null };
}

/** Does this blockquote carry a marker that makes it harness metadata? */
function isHarnessBanner(block: string): boolean {
  return HARNESS_BANNER_MARKERS.some(marker => block.includes(marker));
}

/**
 * The goal paragraph: the first prose paragraph the author wrote.
 *
 * Steps over a leading blockquote ONLY when it carries a harness banner
 * marker, so an author who opens with a quote keeps their goal (#202 AC-3 —
 * the parser has to be correct for prose it did not write, because consumer
 * repos have their own conventions).
 */
export function extractGoal(body: string, title: string): GoalReading {
  const stripped = stripCodeBlocks(body);
  const lines = stripped.split("\n");
  let i = 0;
  let skippedBanner = false;

  const skipBanner = () => {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length || !/^\s*>/.test(lines[i]!)) return false;
    const start = i;
    while (i < lines.length && (/^\s*>/.test(lines[i]!) || lines[i]!.trim() === "")) {
      // A blank line ends the quote unless the next line resumes it.
      if (lines[i]!.trim() === "" && !/^\s*>/.test(lines[i + 1] ?? "")) break;
      i++;
    }
    const block = lines.slice(start, i).join("\n");
    if (isHarnessBanner(block)) return true;
    i = start; // the author's own quote — keep it
    return false;
  };

  if (skipBanner()) skippedBanner = true;

  /** The next paragraph's lines, without consuming them. */
  const peekParagraph = (from: number): { lines: string[]; next: number } => {
    let k = from;
    while (k < lines.length && lines[k]!.trim() === "") k++;
    const taken: string[] = [];
    for (; k < lines.length; k++) {
      if (lines[k]!.trim() === "") break;
      if (headingLevel(lines[k]!) > 0) break;
      taken.push(lines[k]!);
    }
    return { lines: taken, next: k };
  };

  // Step over harness front matter the same way, and for the same reason. A
  // paragraph counts only if EVERY line is a short marker line, so prose that
  // opens with one of the words is kept.
  for (;;) {
    const { lines: para, next } = peekParagraph(i);
    if (para.length === 0) break;
    const allMetadata = para.every(
      l =>
        l.trim().length <= MAX_PREAMBLE_LINE_CHARS &&
        HARNESS_PREAMBLE_MARKERS.some(marker => l.trim().startsWith(marker)),
    );
    if (!allMetadata) break;
    skippedBanner = true;
    i = next;
  }

  const paragraph = peekParagraph(i).lines;
  const goal = paragraph.join("\n").trim();

  if (!goal) {
    return {
      goal: null,
      skippedBanner,
      refusal:
        `this issue body yielded no goal paragraph${skippedBanner ? " after its harness banner" : ""} — ` +
        `the title alone is not a problem statement, and a brief written from it would ` +
        `describe the work by its name rather than by what is wrong (#202).`,
    };
  }

  if (goal.length < MIN_GOAL_CHARS) {
    return {
      goal: null,
      skippedBanner,
      refusal:
        `the goal paragraph read from this issue is ${goal.length} characters, under the ` +
        `${MIN_GOAL_CHARS} a problem statement needs — ${JSON.stringify(goal)}. A short goal and a ` +
        `missing goal are not the same state, and neither is a goal (#202).`,
    };
  }

  return { goal, refusal: null, skippedBanner };
}
