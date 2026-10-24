/**
 * Which ROWS of a preserved rule file no longer match the generator (#1287).
 *
 * ## The defect this reports
 *
 * `.claude/rules/*.md` is preserved whole when a human has edited it (#370),
 * and that is correct — the alternative truncated
 * `checks-must-be-able-to-fail.md` from 262 lines to 65 and exited 0. But
 * **preservation is per-file and staleness is per-row.** One hand-edited row
 * freezes every other row in the file at whatever the generator emitted when
 * it was first written, so a consumer who upgrades specifically to receive a
 * correction does not receive it, and nothing says so.
 *
 * Measured on `pov-plugin`, 0.5.0 → 0.8.1, 2026-10-22. #781 replaced a
 * hardcoded falsehood in `key-files.md` — the `PROJECT-STATE.md` row asserting
 * *"generated from project-state.json — don't edit directly"* — with a real
 * reading of the consumer's tree (`projectStateDerivation`). That consumer's
 * reading is `NO_GENERATOR`: there is no generator, and `PROJECT-STATE.md` is
 * the only copy of the session handoff. The upgrade shipped, the file was
 * preserved, the false sentence survived, and a session that reads the row
 * believes the file regenerates and leaves the handoff stale — the exact harm
 * #781 existed to remove. The run said `PRESERVED (hand-edited since the
 * harness wrote it)` and named no row.
 *
 * ## Why #1148's discriminator does not extend
 *
 * #1148 fixed this class for workflows: a `generated-sha` that VERIFIES proves
 * the bytes on disk are the harness's own output, so preserving them against a
 * newer generator protects no consumer intent, and the harness may overwrite.
 *
 * That discriminator answers the right question about the wrong unit, and it
 * gets this case wrong in both halves:
 *
 * 1. **It is per-file and binary.** On the consumer above the file IS
 *    genuinely hand-edited — two rows were removed deliberately, with the
 *    reasons written into the file — so the sha does not verify, preservation
 *    is the *correct* per-file answer, and the stale row still ships. There is
 *    no setting of a whole-file bit that both keeps the hand edit and refreshes
 *    the row beside it.
 * 2. **Workflows had a container; markdown does not.** #1148 could preserve
 *    per-unit because YAML hands it named, parseable, addressable blocks —
 *    `jobs:` keys. Markdown prose has no such container, which is exactly why
 *    rule files took the whole-file path in the first place.
 *
 * ## The unit, and what it is allowed to do
 *
 * A **markdown table row, addressed by its first cell.** That is the one
 * construct in these files with a stable identity: every generated rule table
 * leads with a file path, a command name, a spec filename or a strategy name,
 * and rows can be reordered without changing it. It is checkable, and it is
 * the granularity the harm actually has.
 *
 * It is used to REPORT and never to REWRITE, and the reason is a byte cost.
 * Rewriting one row requires knowing whether the consumer authored its current
 * text, and the whole-file sha cannot answer that — a row's provenance has to
 * be *emitted into the file*. Measured on this repo at a 24-byte marker per
 * row (`<!--g:0123456789abcdef-->`): 42 rows across the three un-scoped table
 * rules is **1,008 bytes at launch**, and `harness-managed.md`'s 23 more take
 * it to **1,560 at peak** — against 4,644 bytes of headroom at 93% of
 * `SURFACE_BUDGET_BYTES`. A third of the remaining budget, paid by every agent
 * on every run, to carry data only the scaffold reads. Reporting needs no
 * provenance and costs **zero** bytes, because the address is the first cell,
 * which is already in the file.
 *
 * So this reports a row that does not match current generator output. It does
 * **not** claim to know which side changed it — it cannot, and saying so is
 * the point. A row the consumer edited and a row the consumer never received
 * are the same bytes from here, and a report that pretended otherwise would be
 * a detector narrower than what it detects
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * ## The asymmetry is deliberate
 *
 * Rows the generator emits are compared. Rows only the file has are **not**
 * reported: the generator has no opinion about content a consumer added, and
 * reporting it would make every hand-edited file noisy on every run — which is
 * "report everything", and a fix that scores by reporting everything is not a
 * fix.
 */

/** One generated row the preserved file does not reproduce. */
export interface RowDriftReading {
  /** Keys present on both sides whose remaining cells differ. */
  changed: string[];
  /** Keys the generator emits that the preserved file has no row for. */
  missing: string[];
  /**
   * How many addressable rows the generator's output has.
   *
   * Zero is not "clean" — it is UNMEASURED at this granularity, and the report
   * says so rather than implying a prose rule file was checked row by row. A
   * reading that could not be taken is not one that passed
   * (`.claude/rules/config-access.md`).
   */
  generatedRows: number;
}

const ROW = /^\s*\|(.*)\|\s*$/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;

function cells(line: string): string[] | null {
  const m = ROW.exec(line);
  if (!m) return null;
  const parts = m[1].split("|").map(c => c.trim());
  if (parts.length < 2) return null;
  // `|---|---|` is punctuation, not a row. Its first cell would otherwise
  // become a key that every table in every file shares.
  if (parts.every(c => SEPARATOR_CELL.test(c))) return null;
  return parts;
}

/**
 * The address of a row.
 *
 * Emphasis is stripped because a hand-edit that only backticks or bolds the
 * key must not read as the generator's row vanishing and an unrelated one
 * appearing — that would report two findings for zero changes in meaning, and
 * both would be wrong.
 */
export function rowKey(cell: string): string {
  return cell.replace(/[`*_]/g, "").trim();
}

/** Rows keyed by first cell. A key may repeat, so the value is a list. */
export function tableRows(text: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const c = cells(line);
    if (c === null) continue;
    const key = rowKey(c[0]);
    if (key === "") continue;
    const value = c.slice(1).join(" | ");
    const bucket = rows.get(key);
    if (bucket) bucket.push(value);
    else rows.set(key, [value]);
  }
  return rows;
}

/**
 * The single binding that decides which rows drifted.
 *
 * One exported predicate, for the reason `lib/rule-provenance.ts` gives about
 * `decideRuleWrite`: a second site answering the same question would survive
 * any mutation of this one and hold the case up for a reason unrelated to the
 * mechanism working.
 */
export function ruleRowDrift(existing: string, generated: string): RowDriftReading {
  const have = tableRows(existing);
  const want = tableRows(generated);

  const changed: string[] = [];
  const missing: string[] = [];
  let generatedRows = 0;

  for (const [key, wantValues] of want) {
    generatedRows += wantValues.length;
    const haveValues = have.get(key);
    if (haveValues === undefined) {
      missing.push(key);
      continue;
    }
    // Multiset comparison rather than a single value: a duplicated key
    // collapsing into one entry would silently drop a row from the reading.
    const a = [...wantValues].sort();
    const b = [...haveValues].sort();
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) changed.push(key);
  }

  return { changed, missing, generatedRows };
}

/**
 * The clause the scaffold report appends to a `PRESERVED:` line.
 *
 * Separate from the reading so the wording can be asserted without the parser,
 * and so there is one place that turns a reading into prose.
 */
export function rowDriftClause(reading: RowDriftReading): string {
  const { changed, missing, generatedRows } = reading;
  if (generatedRows === 0) {
    return "no table rows to compare, so no row-level reading was taken";
  }
  if (changed.length === 0 && missing.length === 0) {
    return `all ${generatedRows} generated rows match`;
  }
  const parts: string[] = [];
  if (changed.length > 0) {
    parts.push(
      `${changed.length} of ${generatedRows} generated rows do not match: ${changed.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    parts.push(`${missing.length} generated rows are not in the file: ${missing.join(", ")}`);
  }
  // Which side changed a row is not knowable from here, and the clause says so
  // rather than letting the reader assume the harness decided.
  return `${parts.join("; ")} (your edit, or a correction this file never received)`;
}
