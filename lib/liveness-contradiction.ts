/**
 * A run cannot have collected evidence from a server it never managed to
 * find (#346).
 *
 * #304 relaxed a refusal, correctly. The prove gate used to `process.exit(1)`
 * when `dev.apiBase` was set and the server did not answer — but the health
 * route is now read from config and no consumer sets `dev.healthPath` yet, so
 * reporting DOWN for a server whose route cannot be looked up is a false FAIL
 * on a healthy server. #345 then made the reading durable: `UP` / `DOWN` /
 * `UNMEASURED` per tier, written to `workflow-state.json` and
 * `prove-input.json`.
 *
 * **And nothing read it.** A control replaced by an unread field is still a
 * control removed, which is #213's shape exactly: recorded, never consumed.
 *
 * ## The refusal that is actually correct
 *
 * Not "FAIL if liveness is UNMEASURED" — that reinstates the false FAIL this
 * whole sequence exists to remove, and it would fire on every consumer on
 * their next run.
 *
 * The honest refusal is a **contradiction**: a run must not claim it
 * collected server-dependent OUTCOME evidence while reporting that liveness
 * was never measured. If the evidence really came from a running server then
 * the server was reachable, and the consumer can configure the path. If
 * liveness is UNMEASURED and the evidence is nonetheless marked collected,
 * one of the two statements is untrue — and this check does not need to know
 * which to know that the run should not pass.
 *
 * It cannot false-FAIL a healthy server, because it only fires when evidence
 * is *claimed* without measurement. A project with an unconfigured health
 * path and no server-dependent evidence sails through exactly as it does
 * today; that relaxation has to survive, and a test holds it.
 *
 * ## Deliberately narrow
 *
 * Only `UNMEASURED` fires, not `DOWN`. DOWN is a measurement — the route was
 * configured and the probe ran — and the prod tier records it while only
 * warning, by design. Widening this to DOWN is a bigger behaviour change than
 * #346 asked for and would need its own blast-radius measurement.
 *
 * Likewise, a run with NO liveness entries at all is a project that declares
 * no server, which is a different situation from one that tried to look and
 * could not. This stays silent there.
 */

/**
 * Where a health route is declared, if it is declared anywhere this can see.
 *
 * #346 asked the scaffold to write `dev.healthPath` so the UNMEASURED
 * population shrinks to projects that genuinely have no health endpoint.
 * Writing a conventional default would do that and would be wrong:
 * `DevSchema.healthPath` says "No default. A probe that guesses a path
 * reports DOWN for a server that is up", and a guess the scaffold writes
 * into the consumer's config is still a guess — one the harness can then
 * point at the consumer and blame.
 *
 * So the route is looked for in the source, and the answer is `null` when it
 * is not there. A detector that returns null is not a failure; it is the
 * measurement, and UNMEASURED downstream then means "this project has no
 * health endpoint we could locate" rather than "nobody looked".
 */
export const HEALTH_ROUTE_PATTERNS: readonly RegExp[] = [
  // Express/Hono/Fastify: app.get("/api/health", …)
  /\.(?:get|all)\(\s*["'`](\/[A-Za-z0-9_\-./]*health[A-Za-z0-9_\-./]*)["'`]/i,
  // Route tables / OpenAPI-ish: path: "/healthz"
  /\bpath\s*:\s*["'`](\/[A-Za-z0-9_\-./]*health[A-Za-z0-9_\-./]*)["'`]/i,
  // Next-style file routing emitted as a literal
  /["'`](\/api\/[A-Za-z0-9_\-./]*health[A-Za-z0-9_\-./]*)["'`]/i,
];

/** Evidence methods that cannot produce a result without a running server. */
export const SERVER_DEPENDENT_METHODS = [
  "PLAYWRIGHT",
  "SCREENSHOT",
  "CURL_CHECK",
  "api",
  "screenshot",
] as const;

/** Evidence payload kinds that could only have come off the wire. */
export const SERVER_DEPENDENT_EVIDENCE = ["api-response", "screenshot"] as const;

/** Find a declared health route in one file's text, or null. */
export function healthPathIn(source: string): string | null {
  for (const re of HEALTH_ROUTE_PATTERNS) {
    const m = re.exec(source);
    if (m) return m[1];
  }
  return null;
}

export interface LivenessReading {
  tier: string;
  status: string;
  detail?: string;
}

export interface EvidenceClaim {
  id: string;
  type?: string;
  evidenceMethod?: { type?: string } | null;
  evidence?: { type?: string } | null;
}

/** Did this AC claim it collected something only a live server produces? */
export function claimsServerEvidence(ac: EvidenceClaim): boolean {
  if (ac.type !== "OUTCOME") return false;
  // Evidence must actually be present. An OUTCOME AC that merely DECLARES a
  // playwright method has claimed nothing yet — it is a plan, and planning to
  // use a server you have not found is not a contradiction.
  if (!ac.evidence) return false;
  const method = ac.evidenceMethod?.type;
  const payload = ac.evidence?.type;
  return (
    (method !== undefined && (SERVER_DEPENDENT_METHODS as readonly string[]).includes(method)) ||
    (payload !== undefined && (SERVER_DEPENDENT_EVIDENCE as readonly string[]).includes(payload))
  );
}

/**
 * Every contradiction between the liveness record and the evidence claims.
 *
 * One exported violations-returning function, per
 * `.claude/rules/checks-must-be-able-to-fail.md`: the single binding a test
 * can short-circuit to `return []` and count the red.
 */
export function livenessEvidenceContradictions(
  acs: EvidenceClaim[],
  liveness: LivenessReading[],
): string[] {
  const unmeasured = liveness.filter(l => l.status === "UNMEASURED");
  if (unmeasured.length === 0) return [];
  // A tier that came back UP means a server WAS found, and the evidence has
  // somewhere it could have come from. Only a run that measured nothing
  // anywhere is contradicted by claiming it measured something.
  if (liveness.some(l => l.status === "UP")) return [];

  const claiming = acs.filter(claimsServerEvidence);
  if (claiming.length === 0) return [];

  const tiers = unmeasured.map(l => l.tier).join(", ");
  return claiming.map(
    ac =>
      `${ac.id}: claims collected ${ac.evidence?.type ?? ac.evidenceMethod?.type} evidence, ` +
      `which requires a running server, but liveness is UNMEASURED for ${tiers} — ` +
      `either the evidence did not come from a server or the server was reachable and its health path can be configured`,
  );
}
