/**
 * What `SUCCESS.md` claims about the distributed artifact, and whether it is
 * still true (#366).
 *
 * Every mutation count, gate measurement and standing verdict in `SUCCESS.md`
 * was taken against the working tree at `main`. The published artifact is
 * `rungate@0.2.1`, and `main` is several hundred commits past it. **The
 * evidence base and the installable artifact are different software**, and
 * nothing in the file said so.
 *
 * It matters most where the file is weakest. `SUCCESS.md`'s consumer survey
 * of 2026-10-08 returned a verdict of *not ready* — against code no consumer
 * can obtain. That is the one deliberate attempt to assess claim 5, and it
 * is unattributable to any shippable version. The claim-5 row argues, of the
 * distribution path among others, that *"a path nothing has executed is not
 * a path anyone understands."*
 *
 * `SUCCESS.md` is also the measure for filing issues, reviewing PRs and
 * running audits, so a standing table that silently describes unpublished
 * code hands that gap to every decision routed through it.
 *
 * ## Why two numbers and not one
 *
 * The issue named the vacuous form by name: *"An assertion that merely finds
 * **a** version string in the file is the vacuous form and passes over this
 * defect today."* It also named the mutation that has to turn it red —
 * *"bumping `package.json` without publishing must turn it red"* — and that
 * one is only catchable if the file records BOTH versions. Checking the
 * recorded published version against the registry alone stays green through
 * a version bump, because the bump does not move either of those two values.
 */
export interface DistributionStanding {
  /** The version the standing measurements were taken against. */
  tree: string;
  /** The version a consumer can actually install. */
  published: string;
  /** The date the line was written, `YYYY-MM-DD`. */
  measured: string;
}

/**
 * The one line in `SUCCESS.md` that records it, in the form the file writes.
 *
 * Anchored to a list item so prose discussing a version cannot be mistaken
 * for the record — the same reason `.claude/rules/claiming-sc-coverage.md`
 * asks for a declaring position. A file is allowed to talk about 0.2.1 in a
 * sentence without that becoming the standing.
 */
const STANDING_LINE =
  /^-\s+\*\*Distribution standing\s*\((\d{4}-\d{2}-\d{2})\)\*\*\s*—\s*tree `([^`]+)`, published `rungate@([^`]+)`/m;

export function parseDistributionStanding(successMd: string): DistributionStanding | null {
  const m = STANDING_LINE.exec(successMd);
  return m ? { measured: m[1], tree: m[2], published: m[3] } : null;
}

/**
 * What the registry says is installable right now.
 *
 * Deliberately not `npm view`: the registry's own JSON endpoint needs no npm
 * CLI on the path and no lockfile, so the check measures the same thing on a
 * laptop and on CI. A failure here THROWS rather than returning a fallback —
 * an unreachable registry is an unmeasured check, and a check that reports
 * "no problems found" when it could not look is the fail-open shape
 * `.claude/rules/checks-must-be-able-to-fail.md` opens with.
 */
export async function publishedVersion(
  pkg: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`https://registry.npmjs.org/${pkg}/latest`);
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${pkg}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string") {
    throw new Error(`registry returned no version for ${pkg}`);
  }
  return body.version;
}

/**
 * The single place that turns the three readings into a list of violations.
 *
 * One exported function on purpose, so there is one binding to mutate. A
 * second comparison of the same facts elsewhere would survive any mutation
 * of this one and the guard would go green for a reason unrelated to it
 * working.
 */
export function distributionViolations(
  standing: DistributionStanding | null,
  treeVersion: string,
  publishedNow: string,
): string[] {
  if (standing === null) {
    return [
      "SUCCESS.md records no distribution standing — every number in it describes " +
        "a tree, and nothing says which tree a consumer can install",
    ];
  }
  const out: string[] = [];
  if (standing.tree !== treeVersion) {
    out.push(
      `SUCCESS.md says its measurements were taken against ${standing.tree}, ` +
        `package.json says the tree is ${treeVersion} — the standing describes code that moved`,
    );
  }
  if (standing.published !== publishedNow) {
    out.push(
      `SUCCESS.md says rungate@${standing.published} is published, the registry says ` +
        `${publishedNow} — the file's account of what a consumer can install is stale`,
    );
  }
  return out;
}
