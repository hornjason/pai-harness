/**
 * Which closed issues were closed without going through the pipeline (#144).
 *
 * `IssueCloseGuard` is a `PreToolUse` hook that receives the TEXT of a Bash
 * command and has to decide whether that command will close a protected
 * issue. Five consecutive security-review rounds on 2026-10-06 each found a
 * real differential between what it believes a command does and what the
 * shell plus `gh` actually do. Each was fixed. Each fix was followed by
 * another round.
 *
 * The class does not close, because the class is "every way to close a
 * GitHub issue from a shell" — `gh api -X PATCH repos/o/n/issues/23 -f
 * state=closed` mentions neither `issue` nor `close`; so does a wrapper
 * script, an `xargs`, a Makefile target, or curl against the REST API. None
 * of that is enumerable from a regex over a command string.
 *
 * **Jason's decision, 2026-10-08: Option C.** The hook stays as fast feedback
 * and stops being a security control. The enforcement moves here, because
 * this asks a question that IS enumerable: not "will this command close an
 * issue" but "which issues are closed, and does each one have a record".
 * An outcome cannot be bypassed by phrasing.
 *
 * ## What counts as a record, and why it is not workflow-state.json
 *
 * The issue says "closed with no `workflow-state.json` record", and that file
 * is the right idea in the wrong place: it lives under `~/.rungate/{slug}/run/`
 * on whichever machine ran the ship, is never committed, and is invisible to
 * the scheduled CI job that has to do the checking. A control that can only
 * run on one laptop is the same fail-open as #140.
 *
 * So the record is the pipeline's own OUTCOME, which the API does hold: a
 * shipped issue is closed by a merged PR whose body says `Closes #N`, and
 * GitHub stamps that close event with the merge `commit_id`. A close typed by
 * a human — the web UI, `gh issue close`, `gh api -X PATCH` — carries no
 * commit. That is a binary discriminator, visible to any token, and it does
 * not care how the close was phrased.
 *
 * ## What this deliberately does NOT catch
 *
 * **A close attributable to the wrong commit.** On 2026-10-08 a commit body
 * reading "not yet fixed: #178" auto-closed #178. That close has a
 * `commit_id`, so this audit passes it. Attribution is not authorization, and
 * pretending otherwise would be the "detector wider than what it detects"
 * shape pointed inward. That defect is #178's own; this one is about closes
 * with no attribution at all.
 *
 * Stated rather than hidden, because an audit whose scope nobody wrote down
 * gets reviewed as though it claimed everything.
 */

/** One closed issue, reduced to what the decision reads. */
export interface ClosedIssue {
  number: number;
  title: string;
  /**
   * What the close is attributable to — `commit <oid>` or `pull request #N` —
   * or `null` for a close GitHub could attribute to nothing, which is what
   * the web UI and every hand-typed close produce alike.
   */
  closedBy: string | null;
  /** GitHub's own `state_reason`: `completed`, `not_planned`, or absent. */
  stateReason: string | null;
  labels: string[];
  /** ISO-8601 close timestamp, used against `AUDIT_EPOCH`. */
  closedAt: string | null;
  /**
   * Numbers of MERGED pull requests that cross-reference this issue (#1279).
   *
   * This is the second reading, and it exists to split one bucket in two. A
   * close with no closer tells you nobody linked the merge to the issue; it
   * does not tell you whether a merge happened. Those are different facts
   * and they need different work — see `classifyClosure`.
   *
   * Unmerged and closed-unmerged pull requests are deliberately absent: a
   * draft that mentions an issue is not evidence the work shipped.
   */
  mergedReferences: number[];
}

/**
 * The GraphQL alias the cross-reference timeline is read under.
 *
 * One declaring position, on purpose. `toClosedIssue` reads this key and
 * `scripts/audit-issue-closures.ts` interpolates this same constant into its
 * query, so a reader and a producer naming different fields is a build-time
 * impossibility rather than a silent `[]` — which is #530's shape exactly:
 * a consumer reading a name nothing writes, with no error anywhere, because
 * an absent key and an empty list are the same reading.
 */
export const CROSS_REFERENCE_FIELD = "crossReferences";

/**
 * The date this control went live. Issues closed before it are not findings.
 *
 * **This is a ratchet, and the number it banks was measured.** Run read-only
 * against `hornjason/pai-harness` on 2026-10-13 with no epoch, the audit
 * reported **19 of the last 100 closed issues**. Spot-checking #344, #343,
 * #152, #274 and #141 found no merge commit, no closing PR and no
 * `## Completion Report` comment on any of them — so they are true positives,
 * not a broken detector. Nothing in this repo has ever written a durable
 * record of a hand-typed close, which is precisely #144's point.
 *
 * Flagging all nineteen on day one would be the behaviour AC-4 warns about:
 * a check that arrives with a backlog of findings nobody asked for gets
 * switched off, and then it is worth nothing. So the control starts from
 * today and ratchets forward. The nineteen are recorded in
 * `specs/HARNESS-STANDARD.md` rather than labelled, which is this repo's
 * convention for a ratchet: bank the number, say what it means.
 *
 * Lowering this date is how someone deliberately audits history. Raising it
 * is how someone hides a finding, so it is a constant in version control and
 * not a flag with a default.
 */
export const AUDIT_EPOCH = "2026-10-13T00:00:00Z";

/**
 * Flatten one GraphQL `issues.nodes[]` entry into the shape above.
 *
 * Lives here and not in the script because the script runs `await main()` at
 * import time, so a test importing it from there would execute the audit.
 *
 * `ClosedEvent.closer` is why the reading is GraphQL and not REST: it
 * resolves to the Commit or the PullRequest responsible, and to `null` when
 * GitHub has nothing to attribute the close to. REST's `state_reason` cannot
 * distinguish those, and the timeline endpoint is one request per issue.
 *
 * The cross-reference timeline is read under its own alias rather than by
 * widening the `CLOSED_EVENT` selection (#1279). Widening it would have put
 * the closer behind `last: N` on a mixed list, so an issue with N later
 * cross-references would lose its `ClosedEvent` and read as a hand-typed
 * close — a false finding manufactured by the instrument that was supposed
 * to classify findings.
 */
export function toClosedIssue(node: any): ClosedIssue {
  const closer = node?.timelineItems?.nodes?.[0]?.closer ?? null;
  let closedBy: string | null = null;
  if (closer?.__typename === "Commit") closedBy = `commit ${closer.oid}`;
  else if (closer?.__typename === "PullRequest") closedBy = `pull request #${closer.number}`;
  const xrefs: number[] = [];
  for (const item of node?.[CROSS_REFERENCE_FIELD]?.nodes ?? []) {
    const source = item?.source;
    // `merged` is the whole discriminator. An open or an abandoned pull
    // request mentioning an issue is not evidence that anything shipped, and
    // counting one would move a genuinely untraceable close into the bucket
    // nobody re-reads.
    if (source?.merged === true && typeof source.number === "number") xrefs.push(source.number);
  }
  return {
    mergedReferences: [...new Set(xrefs)].sort((a, b) => a - b),
    number: node.number,
    title: node.title ?? "",
    // GraphQL shouts its enums. The decision compares against `not_planned`,
    // and a case mismatch here would silently disable the whole exemption —
    // every deliberate close would become a finding, which is how an audit
    // gets switched off.
    stateReason: node.stateReason ? String(node.stateReason).toLowerCase() : null,
    labels: (node.labels?.nodes ?? []).map((l: any) => l.name),
    closedAt: node.closedAt ?? null,
    closedBy,
  };
}

/**
 * Which of the two things a hand-typed close actually is (#1279).
 *
 * Both are findings. Both break
 * `.claude/rules/ship-workflow.md`'s *"Let the PR close the issue. Do not run
 * `gh issue close` yourself."* The split is not about who is at fault, it is
 * about what the remedy costs:
 *
 * - `LINK_LOST` — a merged pull request in this repository references the
 *   issue, so the work is on `main` and only the attribution was dropped. The
 *   remedy is to name the PR. Nobody needs to re-do anything.
 * - `NO_TRACE` — no merged pull request references it at all. Nothing in the
 *   merge history records that this work ever happened, which is the state
 *   the audit exists to surface.
 *
 * Before the split there was one bucket. Measured over this repository's 299
 * issues closed between 2026-10-19 and 2026-10-23, 95 were findings and
 * **79 of them were `LINK_LOST`** — so the 16 rows that are the real signal
 * sat at one in six of a list people had learnt to scroll past. The count is
 * the argument: a check is worth what it can discriminate, not what it can
 * count.
 */
export type FindingKind = "LINK_LOST" | "NO_TRACE";

/** A finding: one issue, which kind it is, and why it was flagged. */
export interface ClosureFinding {
  issue: ClosedIssue;
  kind: FindingKind;
  reason: string;
}

/**
 * GitHub's marker for "closed as not planned" — duplicate, wontfix, obsolete.
 *
 * Honoured because those closes are legitimate and deliberate, and an audit
 * that flags them cries wolf until someone switches it off. That is the
 * failure AC-4 names, and it has happened to checks in this repo before.
 */
export const NOT_PLANNED = "not_planned";

/**
 * The label that exempts an issue, and the label the audit applies.
 *
 * Two different labels on purpose. One is a human saying "I closed this
 * deliberately and I know it did not ship"; the other is the audit saying
 * "nobody has said that about this one". Collapsing them into a single label
 * would let the audit silence itself on its second run — it would apply the
 * mark, then read its own mark as an exemption, and the finding would
 * disappear while the issue stayed closed.
 */
export const EXEMPT_LABEL = "closed-by-hand";
export const FINDING_LABEL = "closed-without-ship";

/**
 * The label a `LINK_LOST` finding gets instead (#1279).
 *
 * A second finding label, not a second exemption. It exists so the split is
 * queryable on the tracker and not only in a job log — `is:closed
 * label:ship-link-lost` is a list of attributions somebody can repair, and
 * `is:closed label:closed-without-ship` stops being 83% of that.
 *
 * Both finding labels suppress re-reporting, for the reason the two-label
 * comment above gives: an audit that reads its own mark as new work reports
 * the same issue every morning until somebody switches it off.
 */
export const LINK_LOST_LABEL = "ship-link-lost";

/** The label each kind is reported under. One row per kind, so a new kind is a build error. */
export const LABEL_FOR_KIND: Record<FindingKind, string> = {
  LINK_LOST: LINK_LOST_LABEL,
  NO_TRACE: FINDING_LABEL,
};

/**
 * The single place that decides which kind a finding is, and the evidence.
 *
 * Returns both together so there is one derivation. `report` and the labeller
 * switch on `kind` and never re-read `mergedReferences` to re-decide — a
 * second comparison of the same facts would survive any mutation of this one
 * and the guard would go green for an unrelated reason
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export function classifyClosure(issue: ClosedIssue): { kind: FindingKind; reason: string } {
  const shipped = issue.mergedReferences ?? [];
  if (shipped.length > 0) {
    return {
      kind: "LINK_LOST",
      reason:
        `closed by hand, but merged ${shipped.map(n => `#${n}`).join(", ")} ` +
        `reference${shipped.length === 1 ? "s" : ""} it — the work is on the default branch ` +
        `and only the closing link was lost. Repair the attribution; do not re-do the work`,
    };
  }
  return {
    kind: "NO_TRACE",
    reason:
      `closed with nothing to attribute it to, no ${NOT_PLANNED} reason, no ` +
      `${EXEMPT_LABEL} label and no merged pull request referencing it — nothing ` +
      `records that this work was ever done`,
  };
}

/**
 * The single place that decides. One exported function, so there is one
 * binding to mutate; a second comparison of the same facts elsewhere would
 * survive any mutation of this one and the guard would go green for an
 * unrelated reason.
 *
 * Takes the whole closed-issue list rather than one issue, because "which
 * issues need attention" is the question the job answers and an empty result
 * is a meaningful answer.
 */
export function closedWithoutRecord(
  issues: ClosedIssue[],
  epoch: string = AUDIT_EPOCH,
): ClosureFinding[] {
  const before = Date.parse(epoch);
  const out: ClosureFinding[] = [];
  for (const issue of issues) {
    // An unparseable or absent close date is NOT treated as old. Skipping it
    // would make a malformed reading the cheapest way past the audit, which
    // is the fail-open shape this whole control replaces.
    const closedAt = issue.closedAt ? Date.parse(issue.closedAt) : NaN;
    if (!Number.isNaN(closedAt) && closedAt < before) continue;
    if (issue.closedBy !== null) continue;
    if (issue.stateReason === NOT_PLANNED) continue;
    if (issue.labels.includes(EXEMPT_LABEL)) continue;
    // Already reported, under either finding label (#1279).
    if (issue.labels.some(l => l === FINDING_LABEL || l === LINK_LOST_LABEL)) continue;
    // Both kinds are findings. The classification says what the remedy is; it
    // never decides whether to report. A `continue` here for LINK_LOST is the
    // cheapest wrong fix for this issue — the list shrinks by 83% and a
    // hand-typed close of an issue somebody else's PR happens to mention
    // becomes invisible.
    out.push({ issue, ...classifyClosure(issue) });
  }
  return out;
}

/**
 * Whether a finding should be reopened as well as labelled.
 *
 * **The default is to label and report, not to reopen.** AC-3 asked for a
 * choice and a justification, and the three reasons are:
 *
 * 1. The audit is new and its false-positive rate is unmeasured. A control
 *    that overrules people before it has earned trust gets switched off,
 *    which is precisely the failure AC-4 warns about.
 * 2. A label is queryable, so the control's own hit rate is measurable over
 *    time — `is:closed label:closed-without-ship` is a number you can watch.
 *    Reopening changes the state that makes the finding findable.
 * 3. Reopening does not restore the gate. It restores the issue. The thing
 *    actually wanted is a human looking at it.
 *
 * `--reopen` exists so that can be revisited from evidence rather than from a
 * rewrite, and it is scoped to the issues the hook itself treats as protected
 * rather than to everything. A flag that reopened all findings would make the
 * cautious default pointless the first time anyone used it.
 */
export const PROTECTED_LABELS = ["p1-ship-next", "p2-this-week"];

export function shouldReopen(finding: ClosureFinding, reopenEnabled: boolean): boolean {
  if (!reopenEnabled) return false;
  return finding.issue.labels.some(l => PROTECTED_LABELS.includes(l));
}

/**
 * The heading each kind is reported under. One row per kind, so a new kind is
 * a build error rather than a silently unsectioned finding.
 */
export const SECTION_FOR_KIND: Record<FindingKind, string> = {
  NO_TRACE: "NO_TRACE — no merged pull request references these, so nothing records that the work happened",
  LINK_LOST: "LINK_LOST — these shipped and the closing link was lost; repair the attribution, do not re-do the work",
};

/**
 * The order the sections print in. `NO_TRACE` leads because it is the signal
 * and `LINK_LOST` is 83% of the volume — a report that interleaves them puts
 * the actionable rows one in six, which is the state #1279 is about.
 */
export const KIND_ORDER: FindingKind[] = ["NO_TRACE", "LINK_LOST"];

/**
 * The job summary, as text. Empty findings say so rather than printing nothing.
 *
 * Sections are keyed off `finding.kind` and nothing else. Re-deriving the kind
 * here from `mergedReferences` would be a second decider for a question
 * `classifyClosure` already answers, and the two would always agree right up
 * until one of them was mutated.
 */
export function report(findings: ClosureFinding[], scanned: number): string {
  if (findings.length === 0) {
    return `Issue closure audit: ${scanned} closed issues scanned, none closed without a record.`;
  }
  const counts = KIND_ORDER.map(k => `${k} ${findings.filter(f => f.kind === k).length}`).join(", ");
  const blocks: string[] = [];
  for (const kind of KIND_ORDER) {
    const of = findings.filter(f => f.kind === kind);
    if (of.length === 0) continue;
    blocks.push(
      `${SECTION_FOR_KIND[kind]}\n` +
        of.map(f => `- #${f.issue.number} ${f.issue.title} — ${f.reason}`).join("\n"),
    );
  }
  return (
    `Issue closure audit: ${findings.length} of ${scanned} closed issues have no ship record ` +
    `(${counts}).\n\n` +
    blocks.join("\n\n")
  );
}
