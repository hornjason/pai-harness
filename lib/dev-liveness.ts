/**
 * #304 — the dev-server liveness probe had a consumer's route baked into it.
 *
 * `gates/gate-executor.ts` curled a literal:
 *
 *     execSync(`curl -sf ${apiBase}/api/admin/health`, …)
 *
 * `apiBase` came from config. `/api/admin/health` did not — it is one
 * consumer's endpoint, written into the harness. The probe only runs for a
 * project that sets `dev.apiBase` and has a server-dependent OUTCOME AC, and
 * rungate sets no `dev` key at all, so it has never executed on a self-run.
 * The only project that has reached the line is the one whose route it
 * happens to be. (The consumer is named in #304, not here: `test/anti.test.ts`
 * SC-A1 refuses the name anywhere under `lib/`, and it is right to.)
 *
 * The first consumer with a different health route would get:
 *
 *     dev-server-liveness: OUTCOME ACs require running dev server — FAIL
 *     <apiBase> not responding — run 'make dev-all' first
 *
 * on a server that is up. A false FAIL naming the wrong cause is worse than
 * no check, because the stated remedy is to start something already running.
 *
 * ## No default path
 *
 * The temptation is `dev.healthPath ?? "/health"`, and it is the wrong
 * instinct for the same reason the hardcoded route was. A guessed path on a
 * healthy server 404s, `curl -sf` exits non-zero, and the probe reports DOWN.
 * **Unconfigured has to mean UNMEASURED**, which here means "do not probe and
 * say so" — the distinction #185 drew for `mergedIntoBase`, in the direction
 * that matters: reporting DOWN looks fail-closed and is simply wrong, and it
 * blocks a correct run.
 *
 * ## Shape
 *
 * `livenessPlan` is pure: config in, decision out, no network. Every branch
 * — including the ones DDB's config never reaches — is exercisable without a
 * server. `probeLiveness` performs the one it returns.
 */

import { redactSecrets } from "./verified-push";

export type LivenessPlan =
  /** Nothing to probe: no server-dependent OUTCOME AC in this run. */
  | { kind: "not-applicable"; detail: string }
  /** A probe is wanted and the config does not say where to look. */
  | { kind: "unmeasured"; detail: string }
  /** Probe `url`; print and record `safeUrl`, which never carries credentials. */
  | { kind: "probe"; url: string; safeUrl: string; startHint: string };

/** True when any AC's evidence needs a server standing up to produce it. */
export const SERVER_DEPENDENT_EVIDENCE = ["PLAYWRIGHT", "HTTP", "CURL", "SCREENSHOT"] as const;

export function hasServerDependentOutcomeAC(acs: unknown): boolean {
  if (!Array.isArray(acs)) return false;
  return acs.some((ac: any) => {
    const type = ac?.evidenceMethod?.type;
    return ac?.type === "OUTCOME" && typeof type === "string" &&
      (SERVER_DEPENDENT_EVIDENCE as readonly string[]).includes(type.toUpperCase());
  });
}

/**
 * A URL this module is willing to hand to a subprocess.
 *
 * Both halves come out of the consumer's own `rungate.json`, and the old call
 * site interpolated them into a shell string. The invocation is argv-form
 * now, so this is the second defence rather than the only one — but a probe
 * that follows a `file://` or an arbitrary scheme is a different problem from
 * quoting, and this is where it is refused.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function livenessUrl(apiBase: string, healthPath: string): string | null {
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.has(base.protocol)) return null;
  if (!healthPath.startsWith("/")) return null;
  // A `//`-prefixed path is protocol-relative, not a path. Refused by name
  // rather than caught by the origin check below, because the two differ in
  // what they would do with it and only one of them is obvious to a reader.
  if (healthPath.startsWith("//")) return null;

  // Appended to the base's own path, NOT resolved against it.
  //
  // `new URL("/health", "http://host/base/api")` yields `http://host/health`
  // — the base path is silently discarded. A consumer whose API is mounted
  // under a prefix would be probed at the wrong place and reported DOWN on a
  // healthy server, which is the bug this whole module exists to remove,
  // reintroduced by URL resolution semantics. Found by the security review
  // of the first version of this fix, which did resolve.
  const joined = base.pathname.replace(/\/+$/, "") + healthPath;
  let url: URL;
  try {
    url = new URL(joined, base);
  } catch {
    return null;
  }
  // Still checked, because `..` in the path can climb and a stray scheme can
  // appear. Appending removes the protocol-relative case, not every case.
  if (url.origin !== base.origin) return null;
  if (!url.pathname.startsWith(base.pathname.replace(/\/+$/, "") + "/")) return null;
  return url.toString();
}

/**
 * Where to probe a given tier, or why not.
 *
 * This exists because `checkDevServerLiveness` was not the only site. The
 * prove gate curled the same hardcoded route twice more — once against
 * `dev.apiBase` behind a `process.exit(1)`, once against `prod.apiBase`
 * behind a warning — and neither was named in #304. The grep in
 * test/dev-liveness.test.ts found them, which is the whole argument for
 * writing it. Fixing one call site and leaving two would have left the issue
 * closed and the bug shipping.
 *
 * One function so "unconfigured is UNMEASURED, never DOWN" is decided once.
 */
/**
 * Everything that may be printed or recorded goes through this, never through
 * `redactSecrets` alone.
 *
 * Second security round. `redactSecrets` covers userinfo and bare GitHub
 * tokens; it does not touch a query string, and a health route is exactly
 * where a consumer puts `?access_token=…`. Both the probe URL and the
 * "these do not combine" detail quoted `healthPath` verbatim.
 *
 * Every query VALUE is blanked rather than the ones whose key looks secret.
 * A key list is a detector narrower than what it detects — it needs updating
 * for the next consumer's naming, and nothing goes red when it is not. The
 * query is never needed to identify which URL was probed; origin and path
 * are, and they survive.
 */
export function safeForRecord(text: string): string {
  return redactSecrets(text).replace(
    /([?&][A-Za-z0-9_.\[\]%-]+=)[^&\s)'"`]+/g,
    "$1<redacted>",
  );
}

export type ProbeTarget =
  | { kind: "unmeasured"; detail: string }
  | { kind: "probe"; url: string; safeUrl: string };

export function probeTarget(
  tier: string,
  cfg: { apiBase?: string; healthPath?: string } | undefined,
): ProbeTarget {
  const apiBase = cfg?.apiBase;
  const healthPath = cfg?.healthPath;
  if (!apiBase) {
    return {
      kind: "unmeasured",
      detail: `the project sets no \`${tier}.apiBase\`, so liveness was not checked. This is UNMEASURED, not UP.`,
    };
  }
  if (!healthPath) {
    return {
      kind: "unmeasured",
      detail: safeForRecord(
        `the project sets no \`${tier}.healthPath\`, so liveness at ${apiBase} was not ` +
        `checked. No path is guessed on purpose (#304): a guessed route 404s on a healthy ` +
        `server, and reporting DOWN for a server that is up blocks a correct run and names ` +
        `the wrong cause. This is UNMEASURED, not DOWN.`,
      ),
    };
  }
  const url = livenessUrl(apiBase, healthPath);
  if (!url) {
    return {
      kind: "unmeasured",
      detail: safeForRecord(
        `\`${tier}.apiBase\` (${apiBase}) and \`${tier}.healthPath\` (${healthPath}) do not ` +
        `combine into an http(s) URL on the same origin, so liveness was not checked.`,
      ),
    };
  }
  // Two fields on purpose. `url` is what curl is handed and may carry
  // credentials the consumer put in `apiBase` deliberately; `safeUrl` is the
  // only one that may be printed or recorded. The gate's `detail` lands in
  // ship-evidence.json, which is durable and gets attached to issues — the
  // same leak #213 found in push `detail`, and the reason redactSecrets is
  // imported rather than written again here.
  return { kind: "probe", url, safeUrl: safeForRecord(url) };
}

export function livenessPlan(
  acs: unknown,
  dev: { apiBase?: string; healthPath?: string; start?: string } | undefined,
): LivenessPlan {
  if (!hasServerDependentOutcomeAC(acs)) {
    return {
      kind: "not-applicable",
      detail: "no OUTCOME AC needs a running server, so there is nothing to probe.",
    };
  }
  const target = probeTarget("dev", dev);
  if (target.kind === "unmeasured") {
    return {
      kind: "unmeasured",
      detail: `this run has OUTCOME ACs that need a running server and ${target.detail}`,
    };
  }
  return {
    kind: "probe",
    url: target.url,
    safeUrl: target.safeUrl,
    startHint: dev?.start || "the project's dev-server start command",
  };
}
