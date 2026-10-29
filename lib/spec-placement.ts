/**
 * A spec's *Phase placement* table, and the milestones derived from it (#1647).
 *
 * `docs/adr/ADR-003-spec-to-tracker-mapping.md` decides the model: a criterion
 * is placed in the spec, a milestone is DERIVED from that placement, and an
 * issue carries the milestone and names its criteria. This file is step 2 of
 * that ADR made executable — until it existed, step 2 was eight milestones
 * created by hand with `gh`.
 *
 * ## Why derived rather than typed, measured on the eight that were typed
 *
 * The convergence milestones were created by hand on 2026-10-28 from the same
 * phase headings this function reads, and **two of the eight already disagree
 * with their heading**: `### Phase 0 — three settings, no engineering` became
 * *Convergence Phase 0 — three settings*, and `### Phase 4 — findings get
 * answered, and repeats get fixed at the source` became *Convergence Phase 4 —
 * findings get answered*. Nothing was wrong at the time and nothing noticed
 * since; a name typed from a heading is a copy, and a copy drifts. That is the
 * same defect as a spec listing issue numbers, one artefact over.
 *
 * ## The phase NUMBER is the identity, not the title
 *
 * {@link milestonePlan} matches an existing milestone on its phase number and
 * reports a title that no longer matches as a RENAME, never as a milestone to
 * create. Matching on the title would have produced eight duplicates against
 * the live repository on the first run, and a duplicate milestone silently
 * splits a phase's issues into two lanes that each look complete.
 *
 * ## What this does NOT decide
 *
 * Which criteria belong in one ISSUE. That is judgement — a criterion needs
 * several issues and an issue serves several criteria (ADR-003, *Cardinality*)
 * — and a tool that guessed it would file issues nobody asked for against rule
 * 7's opened-to-closed ratio. {@link uncoveredByMilestone} reports the input
 * to that decision and stops there.
 */
import { oneScMentionPattern } from "./sc-ids";
import { parseCriteria } from "./spec-evidence";

/** The heading a spec puts its placement table under. One spelling, by fiat. */
export const PLACEMENT_HEADING = "### Phase placement";

/**
 * Placement values that are NOT phases, and so get no milestone.
 *
 * Closed on purpose. A placement outside this set and not matching
 * {@link PHASE_VALUE} is a refusal rather than a row quietly skipped — ADR-003
 * records that forcing unstartable work into a numbered phase "states a plan
 * that is a lie", and silently dropping an unrecognised row does the same
 * thing by omission.
 */
export const NON_PHASE_PLACEMENTS = [
  "Blocked",
  "Done",
  "Not adopted — deliberate",
  "Not observable here",
] as const;

/** `Phase 0`, `Phase 11`. The capture is the number. */
export const PHASE_VALUE = /^Phase (\d+)$/;

export interface PlacementRow {
  /** The first cell, asterisks stripped: `Phase 3`, `Done`, `Blocked — …`. */
  placement: string;
  /** Every criterion id in the second cell, in document order. */
  ids: string[];
  /** 1-indexed line of the row, for a message somebody can act on. */
  line: number;
}

export interface PhaseHeading {
  number: number;
  /** The text after `Phase N — `, or `""` when the heading carries none. */
  title: string;
  /** The whole heading minus the `### `, which is what a milestone is named from. */
  heading: string;
  line: number;
}

/**
 * Every row of the placement table.
 *
 * Returns `[]` when the section is absent, which callers must distinguish from
 * a present-but-empty table: {@link placementReading} does, by reporting
 * `UNMEASURED` with the reason, because an empty violation list from a section
 * that was never found reads exactly like a spec in perfect order
 * (`.claude/rules/config-access.md`).
 */
export function parsePlacementRows(content: string): PlacementRow[] {
  const lines = content.split("\n");
  const start = lines.findIndex(l => l.startsWith(PLACEMENT_HEADING));
  if (start === -1) return [];

  const out: PlacementRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Any heading at `###` or shallower ends the section. A `####` inside it
    // is still inside it.
    if (/^#{1,3} /.test(line)) break;
    if (!line.startsWith("| ") || line.startsWith("|---") || line.startsWith("| Placement")) continue;
    const cells = line.split("|");
    out.push({
      placement: (cells[1] ?? "").replaceAll("*", "").trim(),
      ids: [...(cells[2] ?? "").matchAll(/\b[A-Z]+(?:-[A-Z]?\d+)+\b/g)].map(m => m[0]),
      line: i + 1,
    });
  }
  return out;
}

/** Every `### Phase N — …` heading, in document order. */
export function parsePhaseHeadings(content: string): PhaseHeading[] {
  const out: PhaseHeading[] = [];
  content.split("\n").forEach((line, i) => {
    const m = line.match(/^#{2,4} (Phase (\d+)(?:\s*[—–-]\s*(.*))?)\s*$/);
    if (!m) return;
    out.push({ number: Number(m[2]), title: (m[3] ?? "").trim(), heading: m[1].trim(), line: i + 1 });
  });
  return out;
}

export interface PlacementReading {
  /** UNMEASURED FAILS. An empty violation list from an absent table is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  rows: PlacementRow[];
  /** Criteria the spec states and the table does not place. */
  unplaced: string[];
  /** Criteria placed more than once, with where. */
  doubled: { id: string; placements: string[] }[];
  /** Ids in the table that the spec states nowhere. */
  unknown: string[];
  /** Placement values matching neither `Phase N` nor a `NON_PHASE_PLACEMENTS` prefix. */
  unrecognised: string[];
  /** Every criterion id the spec states. */
  criteria: string[];
}

export function placementReading(content: string): PlacementReading {
  const criteria = parseCriteria(content).map(c => c.id);
  const rows = parsePlacementRows(content);
  const reasons: string[] = [];

  if (!content.includes(PLACEMENT_HEADING)) {
    reasons.push(
      `no \`${PLACEMENT_HEADING}\` section — every criterion is unplaced for an instrument ` +
        `reason, which reads the same as a spec nobody has started`,
    );
  } else if (rows.length === 0) {
    reasons.push(`the \`${PLACEMENT_HEADING}\` section has no table rows`);
  }
  if (criteria.length === 0) {
    reasons.push("the spec states no criteria — nothing to place, which is not the same as placed");
  }

  const where = new Map<string, string[]>();
  for (const r of rows) for (const id of r.ids) where.set(id, [...(where.get(id) ?? []), r.placement]);

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    rows,
    criteria,
    unplaced: criteria.filter(id => !where.has(id)),
    doubled: [...where].filter(([, p]) => p.length > 1).map(([id, placements]) => ({ id, placements })),
    unknown: [...where.keys()].filter(id => !criteria.includes(id)),
    unrecognised: rows
      .map(r => r.placement)
      .filter(p => !PHASE_VALUE.test(p) && !NON_PHASE_PLACEMENTS.some(v => p.startsWith(v))),
  };
}

export interface MilestoneAction {
  /** What the milestone should be called. Derived, never typed. */
  title: string;
  phase: number;
  /** How many criteria the table places in this phase. */
  criteria: string[];
  action: "create" | "rename" | "unchanged";
  /** Set for `rename` and `unchanged`: the live milestone this matched. */
  existing?: { number: number; title: string };
}

export interface LiveMilestone {
  number: number;
  title: string;
}

/**
 * What to do to the repository's milestones so they match the spec's phases.
 *
 * `prefix` is the spec's short name — `Convergence` gives *Convergence Phase 1
 * — stop the repeats*. It is an argument rather than derived from the filename
 * because `CODE-REVIEW-CONVERGENCE-SPEC.md` would derive *Code Review
 * Convergence*, which is not what the eight live milestones are called, and a
 * renaming migration is a worse first run than typing one word.
 *
 * A live milestone whose title carries no `Phase N` for this prefix is left
 * alone and reported by the caller, not deleted. `Convergence Machinery` is
 * the live instance: real, in use, and derived from nothing here.
 */
export function milestonePlan(
  content: string,
  live: LiveMilestone[],
  prefix: string,
): { actions: MilestoneAction[]; unmanaged: LiveMilestone[] } {
  const headings = new Map(parsePhaseHeadings(content).map(h => [h.number, h]));
  const rows = parsePlacementRows(content);
  const byPhase = new Map<number, string[]>();
  for (const r of rows) {
    const m = r.placement.match(PHASE_VALUE);
    if (m) byPhase.set(Number(m[1]), r.ids);
  }

  const phaseOf = (title: string): number | null => {
    const m = title.match(new RegExp(String.raw`^${escapeRe(prefix)} Phase (\d+)\b`));
    return m ? Number(m[1]) : null;
  };
  const liveByPhase = new Map<number, LiveMilestone>();
  for (const l of live) {
    const n = phaseOf(l.title);
    if (n !== null) liveByPhase.set(n, l);
  }

  const actions = [...byPhase.keys()]
    .sort((a, b) => a - b)
    .map((phase): MilestoneAction => {
      const heading = headings.get(phase);
      const title = `${prefix} ${heading ? heading.heading : `Phase ${phase}`}`;
      const existing = liveByPhase.get(phase);
      if (!existing) return { title, phase, criteria: byPhase.get(phase) ?? [], action: "create" };
      return {
        title,
        phase,
        criteria: byPhase.get(phase) ?? [],
        action: existing.title === title ? "unchanged" : "rename",
        existing,
      };
    });

  return { actions, unmanaged: live.filter(l => phaseOf(l.title) === null) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which of a phase's criteria no open issue names, per milestone.
 *
 * **The reading is NAMES, not SERVES.** Whether an issue genuinely advances a
 * criterion is a judgement, and a column holding a judgement is the
 * human-settable boolean this whole change exists to escape, rebuilt one level
 * up. A word-boundary name match is mechanical and re-derivable by anyone, and
 * its error rate is known and bad in the safe direction: the tick-versus-issue
 * sweep on 2026-10-28 returned 12 raw hits of which 2 to 3 were real, so this
 * OVER-reports coverage's absence being fixed and never invents it.
 *
 * ## `oneScMentionPattern`, not a pattern of its own
 *
 * The first version built its own `(?<!…)id(?!…)` regex. That was a SECOND
 * DECIDER for a question `scripts/criterion-inventory.ts` has answered since
 * it was written, via `oneScMentionPattern`. The two were free to disagree
 * about exactly the input that matters — an id that is a prefix of another,
 * `CRC-M1` inside `CRC-M15` — with each side's tests green, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s *two deciders that agree*.
 * They did already differ: this one excluded a trailing `-` and
 * `oneScMentionPattern`'s `(?![\w-])` excludes a trailing `_` as well.
 *
 * Caught by Jason asking whether a tool for this already existed, two hours
 * after the duplicate was committed. It did, and it is the better one.
 */
export function uncoveredByMilestone(
  actions: MilestoneAction[],
  issueBodies: { number: number; text: string }[],
): { title: string; phase: number; covered: string[]; uncovered: string[] }[] {
  const names = (id: string): boolean =>
    issueBodies.some(i => oneScMentionPattern(id).test(i.text));
  return actions.map(a => ({
    title: a.title,
    phase: a.phase,
    covered: a.criteria.filter(names),
    uncovered: a.criteria.filter(id => !names(id)),
  }));
}
