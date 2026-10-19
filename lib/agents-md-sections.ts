/**
 * The one section of AGENTS.md the harness does not own (#568).
 *
 * `specs/bootstrap-data-flow/problem-statement.md` makes exactly one promise
 * about user content surviving a scaffold run:
 *
 *   > Everything is regenerable. All harness-managed files can be rebuilt
 *   > from scratch by re-running scaffold. **The only user-owned content
 *   > that survives regeneration is Hard Constraints in AGENTS.md**
 *   > (preserved between markers).
 *
 * Nothing implemented it. `lib/scaffold/write-steps.ts` built the file from
 * a template and called `writeFileSync`, so the section and both extraction
 * markers went with it. Measured on a consumer: 37 constraint lines removed
 * by one run, reported as `REGENERATED: AGENTS.md`, exit 0.
 *
 * The cost is not the file. Those lines are the project's non-inferable
 * rules — which port is destructive, which endpoint is permanently off,
 * what the deploy sequence is — and an agent cannot recover them by reading
 * the code, which is the entire reason the section exists. Four weeks after
 * that run, an agent on that project removed a flag another issue had
 * deliberately set, because nothing in the repo said why.
 *
 * ## Why a heading and not a marker pair
 *
 * The spec says "preserved between markers", and the extractor
 * (`scripts/extract-constraints.ts`) does write between
 * `<!-- BEGIN AUTO-EXTRACTED -->` and `<!-- END AUTO-EXTRACTED -->`. But on
 * the consumer that lost them, most of the section was OUTSIDE the markers:
 * eight extracted lines between them and twenty-nine hand-written ones
 * after. Preserving only the marked block would have rescued the lines a
 * machine can regenerate and dropped the ones only a human holds — the
 * section's most valuable content, defined by the mechanism that was easiest
 * to anchor on.
 *
 * So the unit is the **section**: the heading, and everything up to the next
 * one. The markers are ordinary lines inside it and are preserved by being
 * inside it, which is also what makes a project that has never run the
 * extractor work the same way.
 *
 * ## The post-condition is the check, not the merge
 *
 * `preserveSections` could be wrong in a dozen ways — an anchor that is not
 * there, a heading at EOF, a generated template that one day grows its own
 * Hard Constraints section. Rather than reason about each, it compares
 * the lines it found against the lines it produced and reports what is
 * missing. A merge that silently drops something is the defect; a merge that
 * names what it dropped is a refusal the caller can act on.
 */

/**
 * ## One merge, two files (#655)
 *
 * `.claude/agents/*.md` has the same problem AGENTS.md had, for the same
 * reason: a rule mined from a project's own compliance history is
 * non-inferable by construction — it is derived from what THIS repo's agents
 * got wrong — and until #655 the only surfaces that could hold one were
 * regenerated from harness-wide inputs. `templates/agent-briefs/_shared.md`
 * resolves under `scan.harnessTemplatesDir`, so a project rule written there
 * reaches every consumer.
 *
 * What differs between the two files is a heading and a list of anchors.
 * What must NOT differ is the merge, the loss check, or the refusal — so
 * those stay in one function and the vocabulary travels as data. Two copies
 * of `preserveSections` with different constants would be two deciders
 * answering one question, and a mutation of either would leave the other
 * holding every case up (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export interface SectionSpec {
  /** How the file names the preserved section, for a refusal a human reads. */
  label: string;
  /** The heading that opens it. Case-sensitive, at the start of a line. */
  heading: RegExp;
  /**
   * Where the section is re-inserted, in order of preference. An anchor that
   * is not in the generated output is not an error — appending is.
   */
  anchors: RegExp[];
}

/** AGENTS.md's user-owned section (#568). */
export const HARD_CONSTRAINTS_SECTION: SectionSpec = {
  label: "## Hard Constraints",
  heading: /^##[ \t]+Hard Constraints\b[^\n]*$/m,
  // `## Rules` first, because constraints are rules and a reader scanning for
  // one should not have to pass the Commands table to find the other. The
  // fallbacks exist because a profile can omit sections.
  anchors: [/^##[ \t]+Rules$/m, /^##[ \t]+Commands$/m, /^##[ \t]+Workflow$/m],
};

/**
 * An agent brief's project-owned section (#655).
 *
 * A different heading from AGENTS.md's on purpose. The two sections hold
 * different things — AGENTS.md's constraints are read by every agent, a
 * brief's are scoped to one role — and one spelling for both would make a
 * rule written in the wrong file look like it was in the right one.
 *
 * The anchors are the three headings every generated brief in this
 * repository carries at least one of; `## Reference (read when needed)` is
 * last in each template, so the section lands above it rather than after a
 * table of file paths.
 */
export const BRIEF_CONSTRAINTS_SECTION: SectionSpec = {
  label: "## Project Constraints",
  heading: /^##[ \t]+Project Constraints\b[^\n]*$/m,
  anchors: [
    /^##[ \t]+Reference \(read when needed\)$/m,
    /^##[ \t]+Workflow$/m,
    /^##[ \t]+Reference$/m,
  ],
};

/** Any other `##` heading — where the preserved section ends. */
const NEXT_H2 = /^##[ \t]+/m;

export interface SectionReading {
  /** The section verbatim — heading line through the last line before the next `##`. */
  text: string;
  /** Its non-blank lines, heading included. The unit the loss check counts. */
  lines: string[];
}

export interface PreserveResult {
  /** The bytes to write. Equal to `generated` when there was nothing to preserve. */
  content: string;
  /** The section carried over, or null when the existing file had none. */
  preserved: SectionReading | null;
  /**
   * Lines that were in the existing section and are not in `content`.
   *
   * Always empty on the paths this module controls. It is non-empty only
   * when the merge itself failed, which is the case a caller must refuse on
   * rather than write.
   */
  lost: string[];
}

/**
 * Read the Hard Constraints section out of an AGENTS.md, or null.
 *
 * Returns null for "no such heading" AND for a heading with nothing under
 * it — the second is a section somebody emptied, and carrying an empty
 * heading forward would make a run that preserved nothing look identical to
 * a run that preserved something.
 */
export function readPreservedSection(
  content: string | null,
  spec: SectionSpec = HARD_CONSTRAINTS_SECTION,
): SectionReading | null {
  if (content === null) return null;
  const open = spec.heading.exec(content);
  if (open === null) return null;

  const start = open.index;
  const rest = content.slice(start + open[0].length);
  const next = NEXT_H2.exec(rest);
  const text = (next === null ? content.slice(start) : content.slice(start, start + open[0].length + next.index)).replace(/\s+$/, "");

  const lines = text.split("\n").map(l => l.trim()).filter(l => l !== "");
  // The heading alone is not a section. One line means nothing survived the
  // last edit, and there is no content to promise anybody.
  if (lines.length < 2) return null;
  return { text, lines };
}

/**
 * AGENTS.md's reading, by name. The existing callers ask this question and
 * only this one; the spec'd form above is what a second file uses.
 */
export function readHardConstraints(content: string | null): SectionReading | null {
  return readPreservedSection(content, HARD_CONSTRAINTS_SECTION);
}

/**
 * Graft the existing file's Hard Constraints section into freshly generated
 * content, and report anything the graft dropped.
 *
 * Idempotent by construction: the section is re-inserted at the same anchor
 * every run, so the second run over its own output is byte-identical, which
 * is what SC-364 asks of every generator here.
 */
export function preserveSections(
  existing: string | null,
  generated: string,
  spec: SectionSpec = HARD_CONSTRAINTS_SECTION,
): PreserveResult {
  const preserved = readPreservedSection(existing, spec);
  if (preserved === null) return { content: generated, preserved: null, lost: [] };

  // A generated template that already carries the section is not a case
  // today, and writing it off as impossible is how the next person finds a
  // duplicate heading in a consumer's AGENTS.md. Its own section wins, and
  // the post-condition below reports whatever that costs.
  let content: string;
  const own = readPreservedSection(generated, spec);
  if (own !== null) {
    content = generated;
  } else {
    const anchor = spec.anchors.map(a => a.exec(generated)).find(m => m !== null) ?? null;
    content =
      anchor === null
        ? `${generated.replace(/\s+$/, "")}\n\n${preserved.text}\n`
        : `${generated.slice(0, anchor.index)}${preserved.text}\n\n${generated.slice(anchor.index)}`;
  }

  const have = new Set(content.split("\n").map(l => l.trim()));
  return { content, preserved, lost: preserved.lines.filter(l => !have.has(l)) };
}
