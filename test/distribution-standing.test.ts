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

const ROOT = join(import.meta.dir, "..");
const SUCCESS = readFileSync(join(ROOT, "SUCCESS.md"), "utf-8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/** Resolved once; every case below reads the same answer. */
const published = await publishedVersion("rungate");

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

  test("the published version in SUCCESS.md is the registry's", () => {
    const s = parseDistributionStanding(SUCCESS)!;
    expect(
      s.published,
      `SUCCESS.md says ${s.published} is published; the npm registry says ${published}`,
    ).toBe(published);
  });

  test("the live tree has no distribution violations", () => {
    expect(distributionViolations(parseDistributionStanding(SUCCESS), PKG.version, published)).toEqual(
      [],
    );
  });
});

describe("#366 SC-824: the check the issue asked for can fail", () => {
  const recorded: DistributionStanding = { measured: "2026-10-13", tree: "0.2.2", published: "0.2.1" };

  test("bumping package.json without publishing is a violation", () => {
    // The mutation named in the issue, performed. This is the case the
    // obvious implementation misses: comparing only the recorded published
    // version to the registry stays green through a bump, because a bump
    // moves neither of those two numbers.
    const v = distributionViolations(recorded, "0.3.0", "0.2.1");
    expect(v.length, "a version bump with no publish went unnoticed").toBe(1);
    expect(v[0]).toContain("0.3.0");
  });

  test("publishing without updating SUCCESS.md is a violation", () => {
    const v = distributionViolations(recorded, "0.2.2", "0.2.2");
    expect(v.length).toBe(1);
    expect(v[0]).toContain("stale");
  });

  test("both drifting at once is reported as two findings, not one", () => {
    // A check that short-circuits on the first problem hides the second,
    // and the two have different remedies — one is a publish, one is an
    // edit to this file.
    expect(distributionViolations(recorded, "0.3.0", "0.2.9")).toHaveLength(2);
  });

  test("an absent standing line is a violation, not an absence of findings", () => {
    // Deleting the line must not read as "nothing wrong here" — the shape
    // .claude/rules/checks-must-be-able-to-fail.md opens with.
    const v = distributionViolations(null, "0.2.2", "0.2.1");
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("no distribution standing");
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
