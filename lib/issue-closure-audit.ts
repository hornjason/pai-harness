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
}

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
 */
export function toClosedIssue(node: any): ClosedIssue {
  const closer = node?.timelineItems?.nodes?.[0]?.closer ?? null;
  let closedBy: string | null = null;
  if (closer?.__typename === "Commit") closedBy = `commit ${closer.oid}`;
  else if (closer?.__typename === "PullRequest") closedBy = `pull request #${closer.number}`;
  return {
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

/** A finding: one issue, and why it was flagged. */
export interface ClosureFinding {
  issue: ClosedIssue;
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
    if (issue.labels.includes(FINDING_LABEL)) continue; // already reported
    out.push({
      issue,
      reason:
        `closed with nothing to attribute it to, no ${NOT_PLANNED} reason and no ` +
        `${EXEMPT_LABEL} label — nothing records that it went through the ship pipeline`,
    });
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

/** The job summary, as text. Empty findings say so rather than printing nothing. */
export function report(findings: ClosureFinding[], scanned: number): string {
  if (findings.length === 0) {
    return `Issue closure audit: ${scanned} closed issues scanned, none closed without a record.`;
  }
  const lines = findings.map(
    f => `- #${f.issue.number} ${f.issue.title} — ${f.reason}`,
  );
  return (
    `Issue closure audit: ${findings.length} of ${scanned} closed issues have no ship record.\n\n` +
    lines.join("\n")
  );
}
