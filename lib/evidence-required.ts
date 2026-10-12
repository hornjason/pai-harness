/**
 * #277 — the verify gate's evidence-existence rule, as a library.
 *
 * Extracted from `gates/workflow.test.ts` rather than left beside the checks
 * that call it. That file only executes when a gate spawns it with
 * `TEST_WORK_DIR`; importing it from an ordinary test to reach one function
 * drags sixteen of its gate checks into the normal suite, where `sf()` reads
 * nothing and every one of them passes vacuously — sixteen checks that cannot
 * fail, added by a test written to close a hole of exactly that shape.
 */

/**
 * #277 — the evidence chain had no mandatory link for eleven of thirteen types.
 *
 * `evidence-method-executed` opened with `if (t !== "COMMAND" && t !== "command")
 * return false`, so every other `EVIDENCE_METHOD_TYPES` member exited before
 * anything was looked at. `threshold-crosscheck` opened with
 * `if (!ac.threshold || !ac.evidence) continue`, so an AC with no evidence was
 * the one case it had no opinion about — and that is precisely the state an AC
 * is in when nobody recorded any. `EvidenceSchema` is `.nullable().optional()`,
 * so absent is schema-valid.
 *
 * An AC declaring `BUN_TEST` and `threshold: >= 5`, with nothing ever run and
 * nothing ever recorded, passed both checks. So did `PLAYWRIGHT`, `SCREENSHOT`
 * and `GREP_CHECK`. The lower-case aliases do not rescue it; `grep` is a
 * distinct enum member from `command`, so they widen the hole.
 *
 * Two independent links now, so neither going quiet reopens it: this function
 * requires the evidence to EXIST, `thresholdCrosscheckViolations` requires its
 * value to clear the bar.
 */
export const EVIDENCE_EXEMPT_TYPES: ReadonlyMap<string, string> = new Map([
  [
    "MANUAL",
    "a human attests; there is no command to produce a value, so demanding a " +
      "recorded one would refuse every honest manual AC. The attestation is the " +
      "evidence, and evidence-tier is what grades it.",
  ],
  ["manual", "lower-case alias of MANUAL, carried by states written before the enum was cased."],
]);

/**
 * Enumerated, not fallen through (#277 SC-2). An exemption produced by a type
 * comparison missing a branch is indistinguishable from one somebody decided
 * on, which is how eleven types came to be exempt without anyone choosing it.
 */
export function evidenceExemption(ac: any): string | null {
  const t = ac?.evidenceMethod?.type;
  if (typeof t === "string" && EVIDENCE_EXEMPT_TYPES.has(t)) {
    return `evidenceMethod.type=${t}: ${EVIDENCE_EXEMPT_TYPES.get(t)}`;
  }
  if (ac?.verdict === "SKIP") {
    return "verdict=SKIP: the AC declares it was not evaluated, which is a statement rather than a silence.";
  }
  return null;
}

/** True when the AC carries something a reader could inspect. */
function hasRecordedEvidence(ac: any): boolean {
  const e = ac?.evidence;
  if (!e) return false;
  if (typeof e !== "object") return true;
  return Boolean(e.content) || e.value != null || Boolean(e.url);
}

export function missingEvidenceViolations(acs: unknown): string[] {
  if (!Array.isArray(acs)) {
    // UNMEASURED, not PASS. `sf("acs")` returning a non-array means the state
    // is not the shape this check reads, and a check that cannot find its
    // subject has not cleared it.
    return [
      `evidence-method-executed: acs is ${acs === undefined ? "absent" : typeof acs}, not an array — ` +
        `nothing could be checked. This is UNMEASURED, not PASS.`,
    ];
  }
  const out: string[] = [];
  for (const ac of acs) {
    const id = ac?.id ?? "(unnamed AC)";
    const t = ac?.evidenceMethod?.type;

    // The original rule, kept intact rather than folded in: a COMMAND AC needs
    // evidence CONTENT specifically, which is stricter than "something was
    // recorded" and must not be loosened by widening the check around it.
    if (t === "COMMAND" || t === "command") {
      if (!ac?.evidence || (typeof ac.evidence === "object" && !ac.evidence.content)) {
        out.push(`${id}: evidenceMethod.type=${t} and no evidence content was recorded`);
        continue;
      }
    }

    // An AC with no threshold has no bar to clear; ACSchema already refuses
    // one at the schema layer, so this is not where that is enforced.
    if (!ac?.threshold) continue;

    const exempt = evidenceExemption(ac);
    if (exempt) continue;
    if (hasRecordedEvidence(ac)) continue;

    out.push(
      `${id}: threshold ${ac.threshold.op} ${ac.threshold.value} with NO evidence recorded ` +
        `(evidenceMethod.type=${t ?? "unset"}). An AC that was never measured is not an AC ` +
        `that passed — this check covered only COMMAND before #277, so eleven of thirteen ` +
        `evidence types reached the verdict with nothing behind them.`,
    );
  }
  return out;
}

/**
 * #277 SC-6 — each skip here is now a decision rather than a gap.
 *
 * `!ac.evidence` used to be the widest hole in the gate: the one state it
 * declined to have an opinion about was the one that mattered. It is still a
 * skip, because refusing here as well would report the same AC twice with two
 * different explanations, but it is only safe because
 * `missingEvidenceViolations` refuses it first. The two are a pair; neither is
 * sufficient alone, which is why both are exported and both are mutated.
 */
export function thresholdCrosscheckViolations(acs: unknown): string[] {
  if (!Array.isArray(acs)) {
    return [`threshold-crosscheck: acs is not an array — nothing could be checked. UNMEASURED, not PASS.`];
  }
  const violations: string[] = [];
  for (const ac of acs) {
    // No bar, or nothing recorded. The second is caught by
    // missingEvidenceViolations, which runs as its own check.
    if (!ac?.threshold || !ac?.evidence) continue;
    const val = typeof ac.evidence === "object" ? ac.evidence.value : null;
    // A non-numeric evidence shape — a screenshot, a file citation — cannot be
    // compared to a numeric bar. Skipped on purpose, and visible because the
    // AC had to get past the existence check to arrive here.
    if (val == null) continue;
    const exp = parseFloat(String(ac.threshold.value));
    // `contains` and `exists` are legitimate non-numeric operators in
    // THRESHOLD_OPS; parseFloat on their value is NaN and comparing it would
    // be meaningless, not lenient.
    if (isNaN(exp) || isNaN(val)) continue;
    let pass = true;
    switch (ac.threshold.op) {
      case ">=": pass = val >= exp; break;
      case "<=": pass = val <= exp; break;
      case ">": pass = val > exp; break;
      case "<": pass = val < exp; break;
      case "==": pass = val === exp; break;
      case "!=": pass = val !== exp; break;
    }
    if (!pass) violations.push(`${ac.id}: ${val} ${ac.threshold.op} ${exp} = false`);
  }
  return violations;
}
