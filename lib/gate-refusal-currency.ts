/**
 * Which recorded refusals are still true at the end of the run (#532).
 *
 * The ship gate RE-RUNS the verify checks. `runGateTests` spawns
 * `bun test gates/ --test-name-pattern "schema|scope|verify|ship|B1|B2"` for
 * the ship gate, so every `verify checks > …` name is measured a second
 * time, later, against a tree the heal rounds have since changed.
 *
 * Measured on run `wf_e230fddc-a71`:
 *
 * | Check | `gates.verify.failures` | `gates.ship.failures` |
 * |---|---|---|
 * | `verify checks > tests-pass` | FAIL | FAIL |
 * | `verify checks > evidence-prevalidation` | **FAIL** | **absent** |
 * | `verify checks > tsc-pass` | FAIL | FAIL |
 *
 * `state.evidencePrevalidation` in that same file reads
 * `{"verdict":"PASS", acs: [… all "ok" …]}`. The refusal was round one, a
 * heal fixed it, the ship gate re-ran it and it passed — and the terminal
 * report listed it anyway, because the report is the UNION of every gate's
 * list rather than the latest reading of each check.
 *
 * The run returned 19 refusals. Several were already resolved, so the real
 * count was smaller, and the one that actually blocked the run — a
 * `SECURITY_REVIEW_STALE` — was buried among them. A report with false
 * entries in it is a report nobody reads twice.
 *
 * ## Absence is not a pass
 *
 * The whole thing turns on one distinction, and getting it wrong is worse
 * than the bug it fixes: a check missing from a later gate's FAILURES means
 * either *it passed there* or *that gate never ran it*. Those are opposite
 * facts and a failure list cannot tell them apart. Retiring on absence
 * would silently drop every refusal a later gate's narrower pattern skipped.
 *
 * So retirement requires a positive witness — `checksRun`, the names the
 * later gate reported a verdict for, recorded by `gates/orchestrator.ts`
 * from the same `results` array the failures come from. A gate with no
 * `checksRun` retires NOTHING. `null` and `[]` are different answers here
 * and only one of them is a measurement
 * (.claude/rules/config-access.md, Silent Default Substitution).
 *
 * ## Why this is duplicated into ship.js
 *
 * `workflows/ship.js` runs in a sandbox with no module loading (#69), so it
 * cannot import this. It carries an inlined copy inside
 * `REFUSAL-CURRENCY` markers, and `test/gate-refusal-currency.test.ts`
 * extracts that copy, executes it, and runs both over one input matrix —
 * the same technique `test/suite-measurement-parity.test.ts` uses for
 * `suiteCurrency`, and for the same reason: two copies of a rule is a
 * defect waiting for one of them to drift, and the drift is silent.
 */

/** What a gate run reported back: the names it measured and the ones it failed. */
export interface GateReport {
  checksRun?: unknown;
  failedChecks?: unknown;
}

/** One recorded refusal. `check` is absent for refusals no gate produced. */
export interface RefusalEntry {
  check?: unknown;
  [k: string]: unknown;
}

/**
 * The checks a gate ran and did NOT fail — the only thing that can retire an
 * earlier refusal.
 *
 * `null` when the gate reported no `checksRun`, and that is the
 * load-bearing return rather than an empty array: a caller has to be able
 * to tell "this gate said nothing about what it ran" from "this gate ran
 * nothing".
 */
export function resolvedCheckNames(report: GateReport | null | undefined): string[] | null {
  if (!report || !Array.isArray(report.checksRun)) return null;
  const failed = new Set(
    (Array.isArray(report.failedChecks) ? report.failedChecks : []).filter(
      (c: unknown): c is string => typeof c === "string" && c !== "",
    ),
  );
  return report.checksRun.filter(
    (c: unknown): c is string => typeof c === "string" && c !== "" && !failed.has(c),
  );
}

/**
 * Remove, IN PLACE, every earlier refusal about a check this gate re-ran and
 * did not reproduce. Returns the entries it removed.
 *
 * In place because the ledger is one array the whole run appends to, and
 * returning a copy would leave the original to be reported by whichever
 * reader got there first. The removed entries are returned rather than
 * discarded: a refusal that was retired is a thing an operator may want to
 * see, and silently shortening a list is how a report stops being checkable.
 */
export function retireSupersededRefusals(
  entries: RefusalEntry[],
  report: GateReport | null | undefined,
): RefusalEntry[] {
  const resolved = resolvedCheckNames(report);
  if (resolved === null || resolved.length === 0) return [];
  const names = new Set(resolved);
  const dropped: RefusalEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const check = entries[i]?.check;
    if (typeof check === "string" && check !== "" && names.has(check)) {
      dropped.unshift(entries.splice(i, 1)[0]);
    }
  }
  return dropped;
}
