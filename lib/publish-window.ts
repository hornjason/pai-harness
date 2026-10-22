/**
 * Where a tree is, relative to the registry, while a release is happening
 * (#1237, #1226).
 *
 * ## One reading, two checks, two tolerances
 *
 * Two checks in this repository ask the same question — *does the registry
 * serve the version this tree declares?* — and answered it with different
 * tolerances, so a single release produced two opposite failures:
 *
 * - `distributionViolations` compares `SUCCESS.md`'s standing line to
 *   `package.json` and to the registry independently, which tolerates the
 *   pre-publish window (#1049) and reddens `main` for the post-publish one.
 *   Until this module, clearing that red meant a human editing a markdown
 *   file — and `SUCCESS.md` is DA-owned (#296), so the only agents who hit
 *   the failure were the only ones forbidden to fix it. Twice on 2026-10-22:
 *   `b7281397` and `803e1e66`, each a one-line hand edit over a red `main`.
 * - the adjudicator pin in `.github/workflows/ai-review.yml` has no tolerance
 *   at all, so the pre-publish window turns a required check into a repo-wide
 *   merge block.
 *
 * This module is the one place that classifies the reading, so the two checks
 * can disagree about what to DO with a state without disagreeing about which
 * state it is.
 *
 * ## A tolerance is not an off switch
 *
 * The state that must stay red is **bumped and never published**: `main`
 * declaring a version no consumer can obtain, with nothing in flight that
 * will change that. It is observationally identical, at the instant you look,
 * to a release that is publishing right now. Nothing but elapsed time
 * separates them, so the separator has to be an event with a time on it.
 *
 * The release tag is that event. `release.yml` triggers on `push: tags: v*`,
 * so a tree carrying a version with no `v<version>` tag was never released,
 * and a tag older than the window is a release that was triggered and did not
 * land. Both are NEVER_PUBLISHED. Only "tagged, and recently" is tolerated.
 *
 * ## The CDN edge is a third state, and it is decided without a clock
 *
 * `dist-tags.latest` is a pointer that propagates on its own schedule, and
 * reading it to answer *did the publish take effect* reported three
 * consecutive successful releases as failures (#445, #472) — 0.4.1 missed a
 * 120-second budget by 48 seconds. So a version's EXISTENCE is read from the
 * versions list, which is the same reading `release.yml`'s postflight trusts,
 * and `latest` is consulted only to tell PUBLISHED from TAG_LAG. A
 * propagation delay therefore cannot age into NEVER_PUBLISHED however long it
 * lasts: no clock is involved in that branch.
 */
import { execFileSync } from "child_process";

/**
 * The registry's account of a package, as the two readings that answer
 * different questions.
 *
 * `versions` answers *does this exist*. `latest` answers *is it what a
 * consumer gets*. Keeping them apart is the whole of #445; collapsing them
 * would make PUBLISHED and TAG_LAG the same row, which is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — two deciders that agree.
 */
export interface Packument {
  /** The `latest` dist-tag. `null` when the registry did not report one. */
  latest: string | null;
  /** Every version the registry serves. */
  versions: string[];
  /** Publish time per version, plus `created` and `modified`, which are not versions. */
  time: Record<string, string>;
}

/**
 * How long after its release tag a version may be absent from the registry
 * before that stops being a release and starts being a defect.
 *
 * Derived, not chosen: the 0.8.1 release pushed `v0.8.1` at 18:48:45Z and the
 * registry served it at 19:04:37Z — **sixteen minutes**, nearly all of it the
 * full suite `release.yml` runs against the tag before publishing. Ninety
 * minutes is five times that, which leaves room for a slow runner and a
 * queued job without leaving room for a release that failed in the morning to
 * still read as "publishing now" in the afternoon.
 *
 * Raising it trades detection latency for tolerance of a slower pipeline.
 * Lowering it below the longest real release makes every release red again,
 * which is the defect this module exists to remove.
 */
export const PUBLISH_WINDOW_MS = 90 * 60 * 1000;

/**
 * `PUBLISHED` — the registry serves this version and points `latest` at it.
 * `TAG_LAG` — the registry HAS it; `latest` has not caught up. Not a defect.
 * `PUBLISH_PENDING` — absent, and its release tag is inside the window.
 * `NEVER_PUBLISHED` — absent, with no release in flight. A defect.
 * `UNMEASURED` — the registry was not read. Never a pass.
 */
export type PublishState =
  | "PUBLISHED"
  | "TAG_LAG"
  | "PUBLISH_PENDING"
  | "NEVER_PUBLISHED"
  | "UNMEASURED";

export interface PublishWindowReading {
  /** `package.json` `version`. */
  treeVersion: string;
  /** `null` when the registry could not be read. */
  packument: Packument | null;
  /** ISO time of the `v<treeVersion>` tag; `null` when there is no such tag. */
  releaseTagAt: string | null;
  now: Date;
}

/**
 * The single classifier. One exported binding, so there is one thing to
 * mutate and no second predicate over the same fields to hold a case up.
 */
export function publishState(r: PublishWindowReading): PublishState {
  const p = r.packument;
  if (p === null || p.latest === null) return "UNMEASURED";
  if (p.versions.includes(r.treeVersion)) {
    return p.latest === r.treeVersion ? "PUBLISHED" : "TAG_LAG";
  }
  if (r.releaseTagAt === null) return "NEVER_PUBLISHED";
  const tagged = Date.parse(r.releaseTagAt);
  if (Number.isNaN(tagged)) return "NEVER_PUBLISHED";
  const elapsed = r.now.getTime() - tagged;
  // A negative elapsed time is clock skew, not a window that has not opened
  // yet. Treating it as pending would hand an unbounded tolerance to any
  // runner whose clock is behind the tagger's.
  if (elapsed < 0 || elapsed > PUBLISH_WINDOW_MS) return "NEVER_PUBLISHED";
  return "PUBLISH_PENDING";
}

/** `true` for the two states in which a consumer can obtain the tree's version. */
export function registryHasTreeVersion(s: PublishState): boolean {
  return s === "PUBLISHED" || s === "TAG_LAG";
}

/**
 * The release a consumer had immediately before the current `latest`.
 *
 * Ordered by PUBLISH TIME and not by version string, because the question is
 * "what did a consumer get before now" and those genuinely disagree: a patch
 * cut from a maintenance branch after a later minor shipped is newer in time
 * and older in semver.
 *
 * `created` and `modified` sit in the same map and sort alongside real
 * entries, so the keys are filtered against `versions` rather than taken from
 * `time` directly. A reader that skipped that returns `created` on a
 * single-release package and every comparison downstream holds vacuously.
 */
export function previousPublished(p: Packument): string | null {
  const dated = p.versions
    .filter(v => typeof p.time[v] === "string")
    .map(v => ({ v, t: Date.parse(p.time[v]!) }))
    .filter(x => !Number.isNaN(x.t))
    .sort((a, b) => b.t - a.t);
  return dated.length >= 2 ? dated[1]!.v : null;
}

/**
 * What the registry says, from its own JSON endpoint.
 *
 * Deliberately not `npm view`: no npm CLI on the path and no lockfile, so the
 * reading is the same on a laptop and on CI. A failure THROWS rather than
 * returning a fallback — an unreachable registry is an unmeasured check, and
 * a check reporting "no problems found" when it could not look is the
 * fail-open shape `.claude/rules/checks-must-be-able-to-fail.md` opens with.
 */
export async function readPackument(
  pkg: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Packument> {
  const res = await fetchImpl(`https://registry.npmjs.org/${pkg}`);
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${pkg}`);
  const body = (await res.json()) as {
    "dist-tags"?: { latest?: unknown };
    versions?: unknown;
    time?: unknown;
  };
  const versions = body.versions;
  if (typeof versions !== "object" || versions === null) {
    throw new Error(`registry returned no versions for ${pkg}`);
  }
  const latest = body["dist-tags"]?.latest;
  const time = (typeof body.time === "object" && body.time !== null ? body.time : {}) as Record<
    string,
    string
  >;
  return {
    latest: typeof latest === "string" ? latest : null,
    versions: Object.keys(versions),
    time,
  };
}

/**
 * A version, and nothing that is also a git option, a pathspec or a revision.
 *
 * Checked before any git runs, and `null` on a miss. A string that is not a
 * version can never be a release tag, so refusing it costs nothing and closes
 * the door on `--all`, `HEAD`, `""` and anything else that would be read as
 * something other than a name.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * When `v<version>` was tagged **on the remote**, or `null`.
 *
 * ## Why the remote, and not this checkout
 *
 * This reading is the entire separator between *the registry does not have it
 * YET* and *somebody bumped the version and never published*. Those states are
 * observationally identical at the instant you look, so whatever tells them
 * apart decides whether the tolerance is honest.
 *
 * As first shipped it was `git log -1 --format=%cI v<version>` against the
 * local checkout, and that is **evidence produced by the party being
 * measured**. `release.yml` fires on tag PUSH. An unpushed local tag proves
 * nothing was ever triggered, and it bought a full `PUBLISH_WINDOW_MS` of
 * tolerance for exactly the state that has to stay red — so the exemption was
 * mintable by anyone who could run `git tag`.
 *
 * Three things changed, and they are separate defects:
 *
 * - `v${version}` was an unqualified **revision-or-pathspec**: a local BRANCH
 *   named `v1.2.3` resolved it as readily as a tag, and so could a path. It is
 *   now `refs/tags/v<version>` read through `for-each-ref`, which cannot match
 *   a branch or a path.
 * - `%cI` is the **committer date of the commit the tag points at** — when the
 *   code was written, not when the release was cut. It is now
 *   `%(creatordate:iso-strict)` off the ref itself.
 * - existence is confirmed with `ls-remote` against `origin`, so the evidence
 *   comes from the remote rather than from the working copy.
 *
 * The local date is pinned to the remote's object id. A local tag shadowing a
 * pushed one with a fresher date would otherwise extend its own window.
 *
 * ## This is the weaker of the two available designs, deliberately
 *
 * The stronger one asks the Actions API whether a release run exists for the
 * tag, so the separator is produced by a party other than the thing being
 * gated. That is the right principle and it is filed rather than built: it
 * puts a networked call to a rate-limited API on a path a unit test takes, and
 * this repository already carries one open flake of exactly that shape. The
 * remote ref is weaker evidence — a pushed tag is not proof a run started —
 * but it is produced outside the checkout, which is the property that was
 * missing.
 *
 * ## The bare catch falls CLOSED, and that is the point
 *
 * `.claude/rules/config-access.md` bans the fail-OPEN version of this pattern,
 * where a catch turns a failed read into "no problems found". This one falls
 * the other way: every failure path returns `null`, `null` means no release is
 * in flight, and no release in flight means `NEVER_PUBLISHED` — the red state.
 * An unreachable remote, a checkout with no tags fetched and a version nobody
 * released all land on the refusal. Do not "fix" this into a throw or a
 * fallback without reading which direction it falls in.
 */
export function releaseTagTime(root: string, version: string): string | null {
  if (!SEMVER.test(version)) return null;
  const ref = `refs/tags/v${version}`;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    // Existence, from the remote. `--exit-code` makes "no such tag" a non-zero
    // exit rather than empty output, so an absent ref and a failed command do
    // not have to be told apart here — both are the refusal.
    const remote = git("ls-remote", "--tags", "--exit-code", "origin", ref);
    const line = remote.split("\n").find(l => l.endsWith(`\t${ref}`));
    if (line === undefined) return null;
    const remoteOid = line.split("\t")[0]!.trim();
    if (remoteOid === "") return null;

    // The date, from the ref itself rather than from the commit under it, and
    // only if the local ref is the object the remote is serving.
    const local = git("for-each-ref", "--format=%(objectname) %(creatordate:iso-strict)", ref).trim();
    if (local === "") return null;
    const [localOid, ...rest] = local.split(" ");
    if (localOid !== remoteOid) return null;
    const when = rest.join(" ").trim();
    return when === "" ? null : when;
  } catch {
    return null;
  }
}
