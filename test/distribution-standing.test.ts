/**
 * Covers SC-822, SC-823, SC-824 (HARNESS-STANDARD.md).
 *
 * #366 — every mutation count, gate measurement and standing verdict in
 * `SUCCESS.md` was taken against the working tree at `main`, while the
 * artifact a consumer can install is `rungate@0.2.1`. The evidence base and
 * the installable software are different, and nothing in the file said so.
 *
 * The issue named the vacuous version by name:
 *
 *   > Assert that the version recorded in `SUCCESS.md`'s standing section
 *   > matches `npm view rungate version`. Bumping `package.json` without
 *   > publishing must turn it red. An assertion that merely finds *a*
 *   > version string in the file is the vacuous form and passes over this
 *   > defect today.
 *
 * Both halves are here. The registry is REACHED — over the network, from the
 * same endpoint `bun add` resolves against — and the second mutation is the
 * one the issue asked for: a bump with no publish.
 *
 * ## What #1237 changed, and what it deliberately did not
 *
 * The published half of the standing line was compared to the registry's
 * `latest` for equality, and that equality **cannot be true across a
 * release**: the registry moves when `npm publish` lands and the line moves
 * when a human edits it. So every publish reddened `main` until somebody
 * retyped a markdown file, and `SUCCESS.md` is DA-owned (#296) — the agents
 * who hit the failure were the only ones forbidden to clear it. It happened
 * twice on 2026-10-22 (`b7281397`, `803e1e66`), each a one-line hand edit
 * over a red `main`.
 *
 * The line may now lag the registry by **exactly one release** and no
 * further, so a publish no longer reddens `main` and a line two releases
 * stale still does. What did NOT change is the tree half: `standing.tree`
 * must equal `package.json`, because that one IS maintainable atomically —
 * the commit that bumps the version can set both, and CI on that pull
 * request says so before it merges.
 *
 * The state nobody could see before is now its own case:
 * **bumped and never published**. `distributionViolations` refuses it, and
 * `test/publish-window.test.ts` holds the classifier that tells it from a
 * release in flight.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  distributionViolations,
  parseDistributionStanding,
  publishedVersion,
  type DistributionStanding,
} from "../lib/distribution-standing";
import {
  previousPublished,
  publishState,
  readPackument,
  releaseTagTime,
  type PublishState,
} from "../lib/publish-window";

const ROOT = join(import.meta.dir, "..");
const SUCCESS = readFileSync(join(ROOT, "SUCCESS.md"), "utf-8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/** Resolved once; every case below reads the same answer. */
const published = await publishedVersion("rungate");
const packument = await readPackument("rungate");

/** The live reading, taken the way `distributionViolations`'s caller takes it. */
const live = {
  state: publishState({
    treeVersion: PKG.version,
    packument,
    releaseTagAt: releaseTagTime(ROOT, PKG.version),
    now: new Date(),
  }),
  latest: packument.latest,
  previous: previousPublished(packument),
};

/** A registry reading for the cases that plant one. */
const registry = (state: PublishState, latest: string | null, previous: string | null) => ({
  state,
  latest,
  previous,
});

describe("#366 SC-822: SUCCESS.md says which software its numbers describe", () => {
  test("the standing line is there and parses", () => {
    const s = parseDistributionStanding(SUCCESS);
    expect(s, "SUCCESS.md records no distribution standing at all").not.toBeNull();
    expect(s!.tree).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s!.published).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s!.measured).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("prose mentioning a version is not the standing", () => {
    // The declaring-position rule, for the same reason
    // .claude/rules/claiming-sc-coverage.md gives it: this file discusses
    // 0.2.1 in sentences, and a looser reader would take whichever came
    // first as the record.
    const prose =
      "The published artifact is `rungate@0.2.1` and the tree is `0.2.2`, which is the gap.\n";
    expect(parseDistributionStanding(prose)).toBeNull();
  });
});

describe("#366 SC-823: the recorded versions are checked, not just present", () => {
  test("the tree version in SUCCESS.md is package.json's", () => {
    const s = parseDistributionStanding(SUCCESS)!;
    expect(
      s.tree,
      "SUCCESS.md's standing describes a version the tree no longer carries",
    ).toBe(PKG.version);
  });

  test("the published version in SUCCESS.md is one the registry serves", () => {
    // Was an equality against `latest`. An equality here is the #1237 defect:
    // the registry moves on `npm publish` and this line moves when a human
    // edits a markdown file, so the two cannot both be current across a
    // release and `main` went red on every one of them.
    const s = parseDistributionStanding(SUCCESS)!;
    expect(
      [live.latest, live.previous],
      `SUCCESS.md says ${s.published} is published; the registry serves ${live.latest} ` +
        `and served ${live.previous} before it — a line two releases behind is not a lag, it is stale`,
    ).toContain(s.published);
  });

  test("the live tree has no distribution violations", () => {
    expect(distributionViolations(parseDistributionStanding(SUCCESS), PKG.version, live)).toEqual([]);
  });

  test("the live tree's version is one a consumer can obtain, or is being published now", () => {
    // The state that used to be invisible here: `main` declaring a version
    // the registry does not have, with no release in flight. The old check
    // could not see it, because a bump commit that updates both halves of
    // the standing line satisfies every equality it made.
    expect(
      live.state,
      `package.json says ${PKG.version}; the registry serves ${live.latest} and there is ` +
        `no release tag for ${PKG.version} inside the publish window. Cut the release, or ` +
        `revert the bump — main is claiming a version nobody can install.`,
    ).not.toBe("NEVER_PUBLISHED");
    expect(live.state, "the registry was not read; a reading nobody took is not one that passed").not.toBe(
      "UNMEASURED",
    );
  });
});

describe("#366 SC-824: the check the issue asked for can fail", () => {
  const recorded: DistributionStanding = { measured: "2026-10-13", tree: "0.2.2", published: "0.2.1" };

  test("bumping package.json without updating the line is a violation", () => {
    // The mutation named in the issue, performed. The tree half is the leg
    // that IS maintainable atomically: the commit that bumps the version can
    // set this line in the same diff, and that pull request's own CI says so
    // before it merges. That is why this one keeps its equality.
    const v = distributionViolations(recorded, "0.3.0", registry("PUBLISHED", "0.2.1", "0.2.0"));
    expect(v.length, "a version bump with no standing update went unnoticed").toBe(1);
    expect(v[0]).toContain("0.3.0");
  });

  test("bumped and never published is a violation — the state nothing could see", () => {
    // #1237's second acceptance row: corrupt the persisted reading and main
    // goes red. `main` declaring a version no consumer can install, with no
    // release in flight, is a real defect and the one the tolerances below
    // must not swallow. The OLD check could not see it at all: a bump commit
    // that sets both halves of the standing line satisfies every equality it
    // made.
    const v = distributionViolations(
      { measured: "2026-10-13", tree: "0.3.0", published: "0.2.1" },
      "0.3.0",
      registry("NEVER_PUBLISHED", "0.2.1", "0.2.0"),
    );
    expect(v.length, "a version nobody published read as fine").toBe(1);
    expect(v[0]).toContain("no consumer can install");
  });

  test("publishing without updating SUCCESS.md is NOT a violation — #1237", () => {
    // The regression. Publish 0.2.2, do not touch SUCCESS.md, main stays
    // green. The line still names 0.2.1, which is the release immediately
    // before the current one and a version the registry genuinely serves.
    expect(
      distributionViolations(recorded, "0.2.2", registry("PUBLISHED", "0.2.2", "0.2.1")),
      "a publish still reddens main, which is the whole of #1237",
    ).toEqual([]);
  });

  test("a release in flight is NOT a violation — the pre-publish window", () => {
    // #1049 built this tolerance on the standing line and #1226 is about the
    // adjudicator pin not having it. Both now read the same classifier.
    expect(
      distributionViolations(
        { measured: "2026-10-13", tree: "0.2.2", published: "0.2.1" },
        "0.2.2",
        registry("PUBLISH_PENDING", "0.2.1", "0.2.0"),
      ),
    ).toEqual([]);
  });

  test("a dist-tag that has not propagated is NOT a violation — the CDN edge", () => {
    expect(
      distributionViolations(
        { measured: "2026-10-13", tree: "0.2.2", published: "0.2.1" },
        "0.2.2",
        registry("TAG_LAG", "0.2.1", "0.2.0"),
      ),
    ).toEqual([]);
  });

  test("the tolerance is one release deep, not unbounded", () => {
    // Without this the fix is an off switch: any version the registry ever
    // served would satisfy the line forever. `recorded.published` is 0.2.1
    // and the registry has moved two releases past it.
    const v = distributionViolations(recorded, "0.2.2", registry("PUBLISHED", "0.3.0", "0.2.9"));
    expect(v.length, "a standing line two releases behind read as a lag").toBe(1);
    expect(v[0]).toContain("stale");
  });

  test("a published version the registry never served is a violation", () => {
    // A typo, or a number somebody invented. It is neither `latest` nor the
    // release before it, so it is refused — which is what keeps the
    // tolerance from being satisfiable by writing anything at all.
    const v = distributionViolations(
      { measured: "2026-10-13", tree: "0.2.2", published: "9.9.9" },
      "0.2.2",
      registry("PUBLISHED", "0.2.2", "0.2.1"),
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("9.9.9");
  });

  test("both drifting at once is reported as two findings, not one", () => {
    // A check that short-circuits on the first problem hides the second,
    // and the two have different remedies — one is a publish, one is an
    // edit to this file.
    expect(
      distributionViolations(recorded, "0.3.0", registry("PUBLISHED", "0.2.9", "0.2.8")),
    ).toHaveLength(2);
  });

  test("an absent standing line is a violation, not an absence of findings", () => {
    // Deleting the line must not read as "nothing wrong here" — the shape
    // .claude/rules/checks-must-be-able-to-fail.md opens with.
    const v = distributionViolations(null, "0.2.2", registry("PUBLISHED", "0.2.1", "0.2.0"));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("no distribution standing");
  });

  test("an unread registry is a violation, not a tolerated state", () => {
    // UNMEASURED must FAIL, never pass quietly. The three tolerated states
    // all rest on a reading that was taken; this one rests on none.
    const v = distributionViolations(recorded, "0.2.2", registry("UNMEASURED", null, null));
    expect(v.length).toBe(1);
    expect(v[0]).toContain("UNMEASURED");
  });

  test("an unreachable registry throws rather than reporting agreement", () => {
    // The fail-open this check could most easily have had. A registry read
    // that fell back to the recorded value would make the whole file agree
    // with itself whenever the network was down.
    const dead = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(publishedVersion("rungate", dead)).rejects.toThrow("503");
  });

  test("a registry reply with no version throws", () => {
    const empty = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    expect(publishedVersion("rungate", empty)).rejects.toThrow("no version");
  });

  test("the registry read is real — it resolves the package this repo publishes", () => {
    // A positive control on the network call. Every case above would also
    // pass against a stubbed constant, and the one thing that cannot be
    // stubbed is agreement with what `bun add -d rungate` would fetch.
    expect(published, "the registry returned nothing usable for rungate").toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
});
