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
 * Does `version` satisfy a `^x.y.z` range, by npm's rules? (#364)
 *
 * Exists because the scaffold pins consumers to a caret floored at the
 * harness's own minor, and whether that range can ever resolve decided
 * whether a release could be cut at all. A tree carrying an unpublished
 * minor emits a range nothing satisfies — `0.3.0` emits `^0.3.0` while the
 * registry's newest is `0.2.1` — and `release.yml` runs the suite before
 * publishing, so a check wanting the tree's version already on npm cannot
 * pass on the run that would put it there.
 *
 * The caret's 0.x behaviour is the whole point and is the part hand-rolled
 * comparisons get wrong: below 1.0.0 a caret is pinned to the MINOR, not the
 * major, so `^0.3.0` excludes `0.4.0`. Getting that backwards would make
 * this answer `true` for every bump and the guard would certify nothing.
 *
 * Deliberately narrow: `harnessDevDepRange` only ever emits `^x.y.0`, so
 * this handles carets and refuses anything else rather than pretending to be
 * a semver range parser.
 */
export function satisfiesCaret(version: string, range: string): boolean {
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!r || !v) return false;
  const [rMaj, rMin, rPat] = r.slice(1, 4).map(Number);
  const [vMaj, vMin, vPat] = v.slice(1, 4).map(Number);

  // Lower bound: the version must be at or above the floor.
  const atOrAbove =
    vMaj > rMaj ||
    (vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPat >= rPat)));
  if (!atOrAbove) return false;

  // Upper bound, and the 0.x special case is the reason this function exists.
  if (rMaj > 0) return vMaj === rMaj;
  if (rMin > 0) return vMaj === 0 && vMin === rMin;
  return vMaj === 0 && vMin === 0 && vPat === rPat;
}

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

/** What a postflight poll saw, and how hard it had to look (#407). */
export interface PostflightReading {
  /** The `latest` dist-tag on the final read. */
  latest: string | null;
  /** Reads performed. 1 means the registry had it immediately. */
  attempts: number;
  /** Time spent sleeping between reads, in ms. */
  waitedMs: number;
  /** The refusal, or `null` to allow. */
  refusal: string | null;
}

/** Defaults sized for npm's observed read-after-write lag: up to ~30s. */
export const POSTFLIGHT_ATTEMPTS = 10;
export const POSTFLIGHT_DELAY_MS = 3_000;

/**
 * Poll the registry until it serves `treeVersion`, or give up and refuse (#407).
 *
 * `v0.3.0` published cleanly and the release job still went red: the
 * postflight read `registry.npmjs.org/rungate` about a second after `npm
 * publish` returned, and that document is CDN-fronted and eventually
 * consistent, so it was still serving `0.2.1`. The publish was fine. The check
 * was wrong.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` is about checks that cannot
 * fail. This is the inverse and it costs the same thing, because the message
 * is wrong either way — and a red job over a green release is how a gate
 * teaches people to stop reading it.
 *
 * ## The bound is the point
 *
 * Retrying until it goes green would turn this into the defect in the other
 * direction. The loop is bounded, a publish that never lands still refuses,
 * and the refusal says how long it waited — otherwise "it refused" and "it
 * did not wait long enough" are indistinguishable to whoever reads the log.
 *
 * ## Why an intermediate throw retries and the last one does not
 *
 * A transient network error is exactly what polling is for, so a read that
 * throws with attempts remaining is retried. The FINAL one rethrows, because
 * `registryState` throws rather than returning an empty state precisely so
 * that "could not measure" cannot read as "nothing wrong" — and swallowing
 * the last throw here would put that fail-open back.
 *
 * `sleep` is injectable so the exhaustion case can be driven in a test without
 * spending 30 seconds of wall clock on it.
 */
export async function awaitRegistryServes(
  pkg: string,
  treeVersion: string,
  opts: {
    fetchImpl?: typeof fetch;
    base?: string;
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<PostflightReading> {
  const attempts = opts.attempts ?? POSTFLIGHT_ATTEMPTS;
  const delayMs = opts.delayMs ?? POSTFLIGHT_DELAY_MS;
  // A zero-attempt poll reads nothing and would fall out of the loop with no
  // refusal — a check that never runs, reported as a check that passed.
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`postflight needs at least one attempt, got ${opts.attempts}`);
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));

  let waitedMs = 0;
  let latest: string | null = null;
  let refusal: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const last = attempt === attempts;
    try {
      const state = await registryState(pkg, opts.fetchImpl ?? fetch, opts.base);
      latest = state.latest;
      refusal = postflightRefusal(treeVersion, latest);
    } catch (e) {
      if (last) throw e;
      refusal = `could not read the registry: ${(e as Error).message}`;
    }

    if (refusal === null) return { latest, attempts: attempt, waitedMs, refusal: null };
    if (last) {
      return {
        latest,
        attempts: attempt,
        waitedMs,
        refusal:
          `${refusal} — read ${attempt} times over ${Math.round(waitedMs / 1000)}s, ` +
          `which is long enough that this is not the registry catching up`,
      };
    }
    await sleep(delayMs);
    waitedMs += delayMs;
  }

  /* c8 ignore next */
  throw new Error("unreachable: the loop returns on its last attempt");
}
