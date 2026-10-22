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
 *
 * ## Why the published half stopped being an equality (#1237)
 *
 * It was `standing.published === registryLatest`, and that equality cannot be
 * true across a release. `package.json` is moved by the bump commit, the
 * registry is moved by `npm publish`, and the standing line is moved by
 * somebody remembering — three legs, two with a mechanism. So **every publish
 * reddened `main`**, and the repair was always a human retyping a markdown
 * file: `b7281397` and `803e1e66`, both on 2026-10-22, both one line.
 *
 * `SUCCESS.md` is DA-owned (#296), so the agents who hit the failure were
 * precisely the agents forbidden to clear it. That is what made it structural
 * rather than a slip, and it is why the fix is in the check and not in the
 * file.
 *
 * The replacement is a BOUND, not a removal: the line may name `latest` or
 * the release immediately before it, and nothing else. One release of lag is
 * the most a publish can open up, and the next bump commit closes it — so a
 * line two releases behind is still stale, a line naming a version the
 * registry never served is still refused, and an absent line is still a
 * violation.
 *
 * The tree half keeps its equality, deliberately. It is the one leg that IS
 * maintainable atomically: whoever bumps `package.json` can edit this line in
 * the same diff, and that pull request's own CI tells them before it merges.
 *
 * ## And the state none of this could see
 *
 * A bump commit that updates both halves of the standing line satisfies every
 * equality the old check made — including when the release never happens. So
 * *bumped and never published* was invisible here, and `main` could claim a
 * version no consumer could install indefinitely. `lib/publish-window.ts`
 * classifies that case and this module refuses it.
 */
import type { PublishState } from "./publish-window";
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
  registry: RegistryReading,
): string[] {
  if (standing === null) {
    return [
      "SUCCESS.md records no distribution standing — every number in it describes " +
        "a tree, and nothing says which tree a consumer can install",
    ];
  }
  if (registry.state === "UNMEASURED") {
    return [
      "the registry was not read, so nothing here was compared — UNMEASURED. A " +
        "reading nobody took is not a reading that passed, and reporting the " +
        "distribution as fine on it is the fail-open this check exists to avoid",
    ];
  }
  const out: string[] = [];
  if (standing.tree !== treeVersion) {
    out.push(
      `SUCCESS.md says its measurements were taken against ${standing.tree}, ` +
        `package.json says the tree is ${treeVersion} — the standing describes code that moved`,
    );
  }
  if (registry.state === "NEVER_PUBLISHED") {
    out.push(
      `package.json declares ${treeVersion} and the registry does not serve it, with no ` +
        `release tag for it inside the publish window — no consumer can install what main ` +
        `says this tree is. Cut the release, or revert the bump`,
    );
  }
  // The bound, and the whole of #1237: `latest` moves on `npm publish` and
  // this line moves when a human edits a file, so one release of lag is the
  // honest tolerance. Two is staleness, and a version in neither slot was
  // never a reading of anything.
  const allowed = [registry.latest, registry.previous].filter((v): v is string => v !== null);
  if (!allowed.includes(standing.published)) {
    out.push(
      `SUCCESS.md says rungate@${standing.published} is published; the registry serves ` +
        `${registry.latest ?? "nothing readable"} and served ${registry.previous ?? "nothing"} ` +
        `before it — the file's account of what a consumer can install is stale. The line may ` +
        `lag by one release, which is what a publish opens up; this is further behind than that`,
    );
  }
  return out;
}

/**
 * The registry side of the comparison, taken once by the caller.
 *
 * `state` comes from `publishState` in `lib/publish-window.ts` and is the
 * same classification `.github/workflows/ai-review.yml`'s pin reads, so the
 * two checks cannot disagree about which state a release is in — only about
 * what to do with it. Before #1226 they disagreed about both.
 */
export interface RegistryReading {
  state: PublishState;
  /** The `latest` dist-tag. */
  latest: string | null;
  /** The release immediately before it, by publish time. */
  previous: string | null;
}
