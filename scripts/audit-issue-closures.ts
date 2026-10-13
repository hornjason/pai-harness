/**
 * The outcome check that replaces IssueCloseGuard as the control (#144).
 *
 * Usage:
 *   bun scripts/audit-issue-closures.ts --repo owner/name [--limit 100]
 *   bun scripts/audit-issue-closures.ts --repo owner/name --apply
 *   bun scripts/audit-issue-closures.ts --repo owner/name --apply --reopen
 *   bun scripts/audit-issue-closures.ts --fixture <file.json>   # offline
 *
 * The hook predicts, from a command string, whether a close will happen.
 * Five security-review rounds proved that is an unwinnable differential. This
 * reads what actually happened, which does not care how it was phrased —
 * including the form the issue names, `gh api -X PATCH repos/o/n/issues/N -f
 * state=closed`, which mentions neither of the words the hook looks for.
 *
 * The decision lives in `lib/issue-closure-audit.ts` so there is one binding
 * to mutate and so both fixtures run without a network. This file fetches,
 * calls it, and acts.
 *
 * DEFAULT IS READ-ONLY. `--apply` is required to label anything and
 * `--reopen` to reopen anything, because a scheduled job that writes by
 * default is one bad predicate away from editing the whole tracker.
 *
 * ONE PROPERTY THIS FILE MUST KEEP, asserted by
 * test/audit-issue-closures.test.ts: every refusal exits through
 * REFUSE_EXIT, declared exactly once. The test builds a mutant copy with it
 * zeroed and runs each negative case twice.
 */

import { readFileSync } from "fs";
import {
  AUDIT_EPOCH,
  closedWithoutRecord,
  report,
  shouldReopen,
  toClosedIssue,
  EXEMPT_LABEL,
  FINDING_LABEL,
  type ClosedIssue,
} from "../lib/issue-closure-audit";
import { addLabels, createGitHubClient, parseOwnerRepo, updateIssue } from "../lib/github";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function refuse(message: string): never {
  console.error(`AUDIT REFUSED: ${message}`);
  process.exit(REFUSE_EXIT);
}

/**
 * `ClosedEvent.closer` is the whole reason this is GraphQL and not REST.
 *
 * It resolves to the Commit or the PullRequest responsible, and to `null`
 * when GitHub has nothing to attribute the close to — which is every
 * hand-typed close, whatever tool typed it. REST's `state_reason` cannot
 * distinguish those, and one timeline call per issue is a request per issue.
 */
const QUERY = `
query($owner: String!, $name: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    issues(states: CLOSED, first: $limit, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        stateReason
        closedAt
        labels(first: 30) { nodes { name } }
        timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
          nodes {
            ... on ClosedEvent {
              closer {
                __typename
                ... on Commit { oid }
                ... on PullRequest { number }
              }
            }
          }
        }
      }
    }
  }
}`;

async function main(): Promise<void> {
  const fixture = arg("fixture");
  const repo = arg("repo");
  if (!fixture && !repo) refuse("--repo owner/name is required (or --fixture for an offline run)");

  let issues: ClosedIssue[];
  if (fixture) {
    try {
      issues = JSON.parse(readFileSync(fixture, "utf-8")).map(toClosedIssue);
    } catch (e) {
      refuse(`could not read the fixture: ${(e as Error).message}`);
    }
  } else {
    const limit = Number(arg("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      refuse("--limit must be an integer between 1 and 100");
    }
    // A failure to READ is not a clean reading. #140 is in this repo's
    // history precisely because a swallowed API error read as permission.
    try {
      const { owner, repo: name } = parseOwnerRepo(repo!);
      const client = createGitHubClient();
      const data = await client.graphql(QUERY, { owner, name, limit });
      issues = (data?.repository?.issues?.nodes ?? []).map(toClosedIssue);
    } catch (e) {
      refuse(`could not read closed issues: ${(e as Error).message}`);
    }
  }

  // `--epoch` lets someone deliberately audit history. It has no default of
  // its own: omitting it uses the constant, so there is no way to raise the
  // bar by forgetting a flag.
  const epoch = arg("epoch") ?? AUDIT_EPOCH;
  if (Number.isNaN(Date.parse(epoch))) refuse(`--epoch ${epoch} is not a date`);

  const findings = closedWithoutRecord(issues!, epoch);
  console.log(report(findings, issues!.length));

  if (findings.length === 0) return;

  // `--apply` governs whether anything is WRITTEN. It does not govern
  // whether the run is red: the scheduled job runs read-only, so letting a
  // read-only run exit 0 would leave it green in exactly the case it exists
  // for. That was the first version of this file, and the test caught it.
  if (flag("apply")) {
    const client = createGitHubClient();
    const reopenEnabled = flag("reopen");
    for (const finding of findings) {
      const n = finding.issue.number;
      await addLabels(client, repo!, n, [FINDING_LABEL]);
      if (shouldReopen(finding, reopenEnabled)) {
        await updateIssue(client, repo!, n, { state: "open" });
        console.log(`#${n}: labelled and REOPENED (carries a ship-priority label)`);
      } else {
        console.log(`#${n}: labelled ${FINDING_LABEL}`);
      }
    }
  } else {
    console.log(
      `\n(read-only: re-run with --apply to label them ${FINDING_LABEL}; ` +
        `add ${EXEMPT_LABEL} to any that were closed deliberately)`,
    );
  }

  // Non-zero so the scheduled job is visibly red rather than a green run
  // nobody opens. A control whose findings are only in the log is a control
  // that reports itself to nobody.
  refuse(`${findings.length} issue(s) closed without a ship record`);
}

await main();
