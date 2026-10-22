/**
 * Covers SC-823, SC-824 (HARNESS-STANDARD.md) — the publish window, and the
 * three states a naive check collapses into one.
 *
 * #1237 — every publish reddened `main` until a human edited `SUCCESS.md`.
 * #1226 — the same release, the other side of the publish, reported as a
 * repo-wide merge block.
 *
 * Both are the same reading taken by two checks with two tolerances, and
 * neither check could tell these apart:
 *
 *   1. the tree declares a version the registry does not have YET — a release
 *      is in flight, and the only honest answer is to wait;
 *   2. somebody bumped the version and never published — a real defect that
 *      must stay red, because `main` is claiming a version no consumer can
 *      obtain and nothing is going to fix that on its own;
 *   3. the registry HAS the version and its `latest` dist-tag has not caught
 *      up — a propagation artefact of the read, not a fact about the tree.
 *
 * State 3 is decided WITHOUT a clock, from the versions list — the same
 * reading `release.yml`'s postflight trusts and for the same reason (#445): a
 * dist-tag is a pointer that moves on its own schedule, and three consecutive
 * successful releases were reported as failures by reading it.
 *
 * States 1 and 2 are the same instant observed through different futures, so
 * nothing but elapsed time separates them. The separator is the release tag:
 * a release is triggered by pushing `v<version>`, so a tree carrying a version
 * with no such tag was never released at all, and a tag older than the window
 * is a release that was triggered and did not land.
 */
import { describe, expect, test } from "bun:test";
import {
  PUBLISH_WINDOW_MS,
  previousPublished,
  publishState,
  readPackument,
  type Packument,
} from "../lib/publish-window";

/**
 * The real shape, trimmed. `time` carries one entry per version plus
 * `created`/`modified`, which are NOT versions and must not be read as any.
 */
const REGISTRY: Packument = {
  latest: "0.8.1",
  versions: ["0.7.0", "0.8.0", "0.8.1"],
  time: {
    created: "2026-09-19T18:59:54.974Z",
    modified: "2026-10-22T19:04:38.113Z",
    "0.7.0": "2026-10-22T01:30:57.128Z",
    "0.8.0": "2026-10-22T15:15:23.092Z",
    "0.8.1": "2026-10-22T19:04:37.788Z",
  },
};

/** The tag `v0.8.1` was pushed at this time; the registry served it at 19:04:37Z. */
const TAG_PUSHED = "2026-10-22T18:48:45Z";
const at = (iso: string) => new Date(iso);

describe("#1226 the three states a version question actually has", () => {
  test("the registry serves the tree's version and says so — PUBLISHED", () => {
    expect(
      publishState({
        treeVersion: "0.8.1",
        packument: REGISTRY,
        releaseTagAt: TAG_PUSHED,
        now: at("2026-10-22T20:00:00Z"),
      }),
    ).toBe("PUBLISHED");
  });

  test("the registry HAS the version and latest lags — TAG_LAG, not a defect", () => {
    // The CDN edge the brief names. `dist-tags.latest` can report the old
    // version for a while after a successful publish from another vantage
    // point. The versions list cannot: a version is in it or it is not.
    // Decided with no clock at all, so a long propagation delay cannot age
    // into NEVER_PUBLISHED.
    expect(
      publishState({
        treeVersion: "0.8.1",
        packument: { ...REGISTRY, latest: "0.8.0" },
        releaseTagAt: TAG_PUSHED,
        now: at("2027-06-01T00:00:00Z"),
      }),
    ).toBe("TAG_LAG");
  });

  test("absent from the registry, tag pushed inside the window — PUBLISH_PENDING", () => {
    // 0.8.2 is not on the registry and `v0.8.2` was pushed eleven minutes
    // ago. Measured on the 0.8.1 release: tag at 18:48:45Z, registry served
    // it at 19:04:37Z — sixteen minutes, almost all of it the full suite the
    // release runs against the tag before publishing.
    expect(
      publishState({
        treeVersion: "0.8.2",
        packument: REGISTRY,
        releaseTagAt: "2026-10-23T10:00:00Z",
        now: at("2026-10-23T10:11:00Z"),
      }),
    ).toBe("PUBLISH_PENDING");
  });

  test("absent from the registry and NO release tag — NEVER_PUBLISHED", () => {
    // This is the negative control the whole tolerance stands on. It is the
    // state that MUST stay red, and it differs from the row above in exactly
    // one input: whether a release was ever triggered for this version.
    expect(
      publishState({
        treeVersion: "0.8.2",
        packument: REGISTRY,
        releaseTagAt: null,
        now: at("2026-10-23T10:11:00Z"),
      }),
    ).toBe("NEVER_PUBLISHED");
  });

  test("a release tag older than the window — NEVER_PUBLISHED, not pending forever", () => {
    // A triggered release that did not land. Without this the tolerance is an
    // off switch: push a tag, fail the publish, and the tree claims a version
    // nobody can install for the rest of the repository's life while every
    // check reports it as "publishing now".
    expect(
      publishState({
        treeVersion: "0.8.2",
        packument: REGISTRY,
        releaseTagAt: "2026-10-23T10:00:00Z",
        now: at(new Date(Date.parse("2026-10-23T10:00:00Z") + PUBLISH_WINDOW_MS + 1000).toISOString()),
      }),
    ).toBe("NEVER_PUBLISHED");
  });

  test("the window boundary is inclusive, and it is the only thing separating the two", () => {
    const base = {
      treeVersion: "0.8.2",
      packument: REGISTRY,
      releaseTagAt: "2026-10-23T10:00:00Z",
    } as const;
    const edge = Date.parse("2026-10-23T10:00:00Z") + PUBLISH_WINDOW_MS;
    expect(publishState({ ...base, now: new Date(edge) })).toBe("PUBLISH_PENDING");
    expect(publishState({ ...base, now: new Date(edge + 1) })).toBe("NEVER_PUBLISHED");
  });

  test("a tag in the future is not a window that has not opened — NEVER_PUBLISHED", () => {
    // Clock skew between a runner and the tagger must not buy an unbounded
    // tolerance. A negative elapsed time is a reading nobody can act on.
    expect(
      publishState({
        treeVersion: "0.8.2",
        packument: REGISTRY,
        releaseTagAt: "2026-10-23T12:00:00Z",
        now: at("2026-10-23T10:00:00Z"),
      }),
    ).toBe("NEVER_PUBLISHED");
  });

  test("an unreadable registry is UNMEASURED, never a pass", () => {
    expect(
      publishState({
        treeVersion: "0.8.1",
        packument: null,
        releaseTagAt: TAG_PUSHED,
        now: at("2026-10-22T20:00:00Z"),
      }),
    ).toBe("UNMEASURED");
  });

  test("a packument with no latest is UNMEASURED even when the version is listed", () => {
    // `versions` answers "does it exist"; `latest` answers "is it what a
    // consumer gets". A missing second reading is not a third state, and
    // defaulting it to the first would make PUBLISHED and TAG_LAG the same
    // row — two deciders that agree.
    expect(
      publishState({
        treeVersion: "0.8.1",
        packument: { ...REGISTRY, latest: null },
        releaseTagAt: TAG_PUSHED,
        now: at("2026-10-22T20:00:00Z"),
      }),
    ).toBe("UNMEASURED");
  });
});

describe("#1237 the release immediately before the current one", () => {
  test("ordered by publish TIME, not by version string", () => {
    expect(previousPublished(REGISTRY)).toBe("0.8.0");
  });

  test("a patch released after a later minor is still the previous one", () => {
    // Version order and publish order genuinely disagree: 0.7.1 can be cut
    // from a maintenance branch after 0.8.0 ships. The question this answers
    // is "what did a consumer get before now", which is a time question.
    const p: Packument = {
      latest: "0.7.1",
      versions: ["0.7.0", "0.8.0", "0.7.1"],
      time: {
        created: "2026-09-19T18:59:54.974Z",
        modified: "2026-10-23T00:00:00.000Z",
        "0.7.0": "2026-10-22T01:30:57.128Z",
        "0.8.0": "2026-10-22T15:15:23.092Z",
        "0.7.1": "2026-10-23T00:00:00.000Z",
      },
    };
    expect(previousPublished(p)).toBe("0.8.0");
  });

  test("`created` and `modified` are not versions", () => {
    // They sit in the same map and sort alongside real entries. A reader that
    // takes the second-newest key returns `created` on a single-release
    // package, and every downstream comparison then holds vacuously.
    const only: Packument = {
      latest: "0.2.0",
      versions: ["0.2.0"],
      time: {
        created: "2026-09-19T18:59:54.974Z",
        modified: "2026-09-19T18:59:55.200Z",
        "0.2.0": "2026-09-19T18:59:55.156Z",
      },
    };
    expect(previousPublished(only)).toBeNull();
  });

  test("a version with no time entry is not ordered ahead of one that has", () => {
    const p: Packument = {
      latest: "0.8.1",
      versions: ["0.7.0", "0.9.9", "0.8.0", "0.8.1"],
      time: { ...REGISTRY.time },
    };
    expect(previousPublished(p)).toBe("0.8.0");
  });
});

describe("#1237 the registry read is real and refuses rather than falling back", () => {
  test("an unreachable registry throws", () => {
    const dead = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(readPackument("rungate", dead)).rejects.toThrow("503");
  });

  test("a reply with no versions map throws", () => {
    const empty = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ "dist-tags": { latest: "1.0.0" } }),
    })) as unknown as typeof fetch;
    expect(readPackument("rungate", empty)).rejects.toThrow("no versions");
  });

  test("it resolves the package this repo publishes", async () => {
    // The positive control on the network call. Every case above would pass
    // against a stubbed constant; agreement with what `bun add -d rungate`
    // would fetch is the one thing that cannot be stubbed.
    const p = await readPackument("rungate");
    expect(p.latest, "the registry returned nothing usable for rungate").toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(p.versions).toContain(p.latest!);
    expect(p.time[p.latest!]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
