/**
 * Whether a release may be cut, and whether one actually was (#364).
 *
 * `rungate` has been published twice ever — `0.2.0` and `0.2.1`. `main` is
 * 741 commits past the second. A consumer installing from npm receives a
 * harness without any of the gate, collector or claim-audit work that
 * `SUCCESS.md` cites as evidence, which is why #366 made the file say so and
 * why this file exists to stop it drifting again.
 *
 * ## The failure this is built around
 *
 * The issue named it, and it is the shape `.claude/rules/checks-must-be-able-
 * to-fail.md` opens with:
 *
 *   > A publish job that exits 0 because npm rejected a duplicate version is
 *   > exactly the "could not measure reads as nothing wrong" shape, and it is
 *   > the most likely way this fix ships broken.
 *
 * A release pipeline has an unusually quiet way of doing nothing. The publish
 * step can be skipped by an `if:` that stopped matching, swallowed by a
 * `continue-on-error`, or rejected by the registry as a duplicate — and in
 * every case the job is green and the tag exists. Nothing downstream can tell
 * "we shipped 0.2.3" from "we tagged 0.2.3 and shipped nothing".
 *
 * ## Two readings, before and after
 *
 * So the guard is not one check but two, taken at different times, and
 * neither is sufficient alone:
 *
 * - **Preflight** — the tree's version must NOT be on the registry yet. This
 *   is what makes a duplicate publish a red run rather than a no-op.
 * - **Postflight** — after the publish step, the registry's `latest` must BE
 *   the tree's version. This is what makes a *skipped* publish a red run.
 *
 * Preflight alone passes a pipeline whose publish step never ran. Postflight
 * alone passes a pipeline that republished nothing because the version was
 * already there from last month. The pair is the same "two numbers, not one"
 * argument `lib/distribution-standing.ts` makes about `SUCCESS.md`, applied
 * to the act rather than to the record.
 */

/** What the registry currently holds for a package. */
export interface RegistryState {
  /** Every published version, in no particular order. */
  versions: string[];
  /** The `latest` dist-tag, or `null` for a package that has never shipped. */
  latest: string | null;
}

/**
 * Read the registry.
 *
 * The packument, not `/latest`: "has 0.2.2 ever been published" cannot be
 * answered by a dist-tag, because `latest` moves on and leaves older versions
 * installable behind it. `distributionViolations` asks a different question
 * and is right to use `/latest`; this one needs the whole list.
 *
 * Deliberately not the `npm` CLI — the registry's JSON endpoint needs no npm
 * on the path and no lockfile, so it measures the same thing on a laptop and
 * on CI.
 *
 * A 404 is a real answer: the package has never been published, so every
 * version is available. Any other failure THROWS rather than returning an
 * empty state, because an unreachable registry would otherwise read as "no
 * version conflicts" and wave a duplicate straight through.
 */
export const NPM_REGISTRY = "https://registry.npmjs.org";

export async function registryState(
  pkg: string,
  fetchImpl: typeof fetch = fetch,
  base: string = NPM_REGISTRY,
): Promise<RegistryState> {
  const res = await fetchImpl(`${base}/${pkg}`);
  if (res.status === 404) return { versions: [], latest: null };
  if (!res.ok) throw new Error(`registry returned ${res.status} for ${pkg}`);
  const body = (await res.json()) as {
    versions?: Record<string, unknown>;
    "dist-tags"?: { latest?: unknown };
  };
  const versions = body.versions ? Object.keys(body.versions) : [];
  const latest = body["dist-tags"]?.latest;
  return { versions, latest: typeof latest === "string" ? latest : null };
}

/** `1.2.3`, `1.2.3-rc.1`, `1.2.3+build` — npm's shape, not a full semver parser. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The single place that decides whether a release may be cut. `null` allows.
 *
 * One exported function so there is one binding to mutate. `tag` is the git
 * ref the workflow fired on, with any `refs/tags/` prefix already stripped;
 * pass `null` for a run that is not tag-triggered.
 *
 * The tag comparison is here and not left to the workflow because a tag that
 * disagrees with `package.json` publishes the version in `package.json` while
 * every human reads the tag. That is not a release, it is two releases with
 * one set of notes.
 */
export function preflightRefusal(
  treeVersion: string,
  tag: string | null,
  state: RegistryState,
): string | null {
  if (!SEMVER.test(treeVersion)) {
    return `package.json version ${JSON.stringify(treeVersion)} is not a version npm will accept`;
  }
  if (tag !== null && tag !== `v${treeVersion}`) {
    return (
      `tag ${tag} does not name the version being published — package.json says ` +
      `${treeVersion}, so the tag would describe a release that is not the one cut`
    );
  }
  if (state.versions.includes(treeVersion)) {
    return (
      `rungate@${treeVersion} is already on the registry — publishing it again is ` +
      `rejected by npm, and a job that treats that rejection as success reports a ` +
      `release nobody can install. Bump package.json.`
    );
  }
  return null;
}

/**
 * The single place that decides whether a release actually happened. `null`
 * allows.
 *
 * Run AFTER the publish step, against a freshly read registry. This is the
 * half that cannot be satisfied by doing nothing: a skipped, swallowed or
 * silently-failed publish leaves `latest` where it was.
 */
export function postflightRefusal(treeVersion: string, latestAfter: string | null): string | null {
  if (latestAfter === null) {
    return (
      `the registry has no latest version for rungate after the publish step — ` +
      `the release did not happen, whatever the job's exit code says`
    );
  }
  if (latestAfter !== treeVersion) {
    return (
      `the registry's latest is ${latestAfter}, not the ${treeVersion} this run was ` +
      `cutting — the publish step did not take effect`
    );
  }
  return null;
}
