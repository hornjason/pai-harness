/**
 * Is the promoted container built from the commit under test? (#341)
 *
 * `container-has-fix` in `gates/workflow.test.ts` asked that, and every way
 * of failing to find out returned a pass:
 *
 *     const runtime = exec("command -v podman").ok ? "podman" : "docker";
 *     const inspect = execArgvOf(runtime, ["inspect", "--format=…revision", "--", name]);
 *     if (!inspect.ok || !inspect.output) return;   // container absent, daemon down,
 *     const head = exec("git rev-parse HEAD", root); //  no revision label,
 *     if (!head.ok) return;                          //  neither runtime installed
 *
 * Four separate unmeasurable states, one observable outcome: PASS.
 *
 * Two of them are *more likely* exactly when the check matters. An image that
 * was never rebuilt may not exist under the expected name; a stopped runtime
 * is the normal state on a machine where promotion did not happen. The check
 * was quietest in precisely the situation it exists to catch — shape one in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * The runtime was also chosen by probe rather than by config: absent podman
 * silently fell through to docker, and with neither installed the inspect
 * failed and the check passed. A consumer with no container runtime at all
 * got a green `container-has-fix` on every run, for ever.
 *
 * ## What this does and deliberately does not do
 *
 * It makes the states **distinguishable and recorded** (#341 criteria 2 and 3)
 * and resolves the runtime from config with the probe as a fallback
 * (criterion 4).
 *
 * The criteria are written out longhand rather than as `SC-2`, `SC-4` and so
 * on, because the registry owns those ids: every single-digit `SC-N` is a real
 * entry in `specs/`, and `scripts/sync-sc-status.ts` credits any comment
 * mentioning one as coverage of it. A sentence about this issue's second
 * criterion would certify an unrelated bootstrap criterion as tested.
 *
 * It does **not** decide that an unreadable inspect FAILS the run. That is
 * criterion 1's question — how often each state is taken across real runs on a real
 * consumer — and #341 exists as a separate issue precisely because turning
 * runs red on a consumer whose runtime happens to be down is a behaviour
 * change that needs its blast radius measured rather than guessed. The
 * verdicts below carry `blocking: false` for every unmeasurable state, and
 * the day criterion 1 is answered that is the one field to change.
 *
 * Recording without deciding is normally the failure mode #346 was about —
 * a reading nothing consumes. The difference is that here the reading is the
 * deliverable: criterion 1 cannot be answered without it, and the issue says so.
 */

export type ProvenanceOutcome =
  | "MATCH"
  | "BEHIND"
  | "NO_RUNTIME"
  | "RUNTIME_DOWN"
  | "CONTAINER_ABSENT"
  | "INSPECT_FAILED"
  | "NO_REVISION_LABEL"
  | "HEAD_UNREADABLE";

export interface ProvenanceVerdict {
  outcome: ProvenanceOutcome;
  /** Does this stop the run? Only BEHIND does, pending #341 criterion 1. */
  blocking: boolean;
  /** Was anything actually measured? */
  measured: boolean;
  detail: string;
}

/** The runtimes this knows how to inspect, in probe order. */
export const KNOWN_RUNTIMES = ["podman", "docker"] as const;

export type RuntimeResolution =
  | { kind: "resolved"; runtime: string; source: "config" | "probe" }
  | { kind: "none"; detail: string };

/**
 * Which container runtime to ask, config first.
 *
 * The old line was `exec("command -v podman").ok ? "podman" : "docker"`,
 * which has no way to say "neither" — docker was the answer whether docker
 * was installed or not, and the resulting inspect failure read as a pass.
 */
export function resolveContainerRuntime(
  configured: string | null | undefined,
  available: (name: string) => boolean,
): RuntimeResolution {
  if (typeof configured === "string" && configured.trim() !== "") {
    const name = configured.trim();
    if (available(name)) return { kind: "resolved", runtime: name, source: "config" };
    return {
      kind: "none",
      detail:
        `the project configures \`prod.containerRuntime: "${name}"\` and it is not on PATH, ` +
        `so the container could not be inspected. Nothing was measured.`,
    };
  }
  for (const name of KNOWN_RUNTIMES) {
    if (available(name)) return { kind: "resolved", runtime: name, source: "probe" };
  }
  return {
    kind: "none",
    detail:
      `no container runtime is available (looked for ${KNOWN_RUNTIMES.join(", ")}) and the ` +
      `project configures none, so the container could not be inspected. Nothing was ` +
      `measured — this is UNMEASURED, not a container that matches.`,
  };
}

/**
 * Tell "there is no such container" from "the daemon is not answering".
 *
 * Both used to be one silent return, and they mean opposite things: the
 * first is evidence the promotion never happened, the second is evidence
 * about the machine. Matching on the runtime's own words is a narrow
 * detector, so an unrecognised failure stays `INSPECT_FAILED` and keeps its
 * stderr rather than being filed under whichever branch is closer.
 */
export function classifyInspectFailure(stderr: string): "CONTAINER_ABSENT" | "RUNTIME_DOWN" | "INSPECT_FAILED" {
  const s = stderr.toLowerCase();
  if (/no such (object|container|image)|unable to find|not found/.test(s)) return "CONTAINER_ABSENT";
  if (/cannot connect|connection refused|daemon|is the docker daemon running|dial unix|service not available/.test(s)) {
    return "RUNTIME_DOWN";
  }
  return "INSPECT_FAILED";
}

export interface ProvenanceReading {
  runtime: RuntimeResolution;
  containerName: string;
  /** The inspect result, absent when no runtime resolved. */
  inspect?: { ok: boolean; output: string; stderr: string };
  /** `git rev-parse HEAD` in the tree under test. */
  head?: { ok: boolean; output: string };
  /** The `environments.prod.rebuild` verdict the run recorded. */
  prodRebuild?: unknown;
}

/**
 * One reading in, one named outcome out.
 *
 * Every branch produces a verdict. There is no path that returns nothing,
 * which is the whole change: the previous body had four, and they were
 * indistinguishable from a container that matched.
 */
export function classifyContainerProvenance(r: ProvenanceReading): ProvenanceVerdict {
  if (r.runtime.kind === "none") {
    return { outcome: "NO_RUNTIME", blocking: false, measured: false, detail: r.runtime.detail };
  }
  const runtime = r.runtime.runtime;

  if (!r.inspect) {
    return {
      outcome: "INSPECT_FAILED",
      blocking: false,
      measured: false,
      detail: `${runtime} inspect was never run for ${r.containerName}. Nothing was measured.`,
    };
  }

  if (!r.inspect.ok) {
    const outcome = classifyInspectFailure(r.inspect.stderr);
    const detail =
      outcome === "CONTAINER_ABSENT"
        ? `${runtime} has no container named ${r.containerName}. An image that was never ` +
          `rebuilt does not exist under the expected name, so this is the state the check ` +
          `exists to catch — recorded, not yet blocking (#341 criterion 1).`
        : outcome === "RUNTIME_DOWN"
          ? `${runtime} is installed but not answering, so ${r.containerName} could not be ` +
            `inspected. This says nothing about the container.`
          : `${runtime} inspect of ${r.containerName} failed for a reason this does not ` +
            `recognise: ${r.inspect.stderr.trim().slice(0, 200)}`;
    return { outcome, blocking: false, measured: false, detail };
  }

  const sha = r.inspect.output.replace(/'/g, "").trim();
  if (sha === "") {
    return {
      outcome: "NO_REVISION_LABEL",
      blocking: false,
      measured: false,
      detail:
        `${r.containerName} carries no org.opencontainers.image.revision label, so the ` +
        `commit it was built from is unknown. The image exists; its provenance does not.`,
    };
  }

  if (!r.head?.ok || !r.head.output.trim()) {
    return {
      outcome: "HEAD_UNREADABLE",
      blocking: false,
      measured: false,
      detail:
        `the tree under test did not yield a HEAD commit, so there is nothing to compare ` +
        `${r.containerName}'s revision ${sha.slice(0, 8)} against.`,
    };
  }

  const head = r.head.output.trim();
  if (sha === head) {
    return {
      outcome: "MATCH",
      blocking: false,
      measured: true,
      detail: `${r.containerName} is built from ${head.slice(0, 8)}, the commit under test.`,
    };
  }

  // The one blocking case, unchanged from before: a measured mismatch with
  // no recorded rebuild. Narrowed to `blocking` so #341 criterion 1 has exactly one
  // field to flip when the blast radius of the others is known.
  const rebuilt = r.prodRebuild === "PASS";
  return {
    outcome: "BEHIND",
    blocking: !rebuilt,
    measured: true,
    detail:
      `${r.containerName} is built from ${sha.slice(0, 8)} and the commit under test is ` +
      `${head.slice(0, 8)}` +
      (rebuilt
        ? `, but the run records prod.rebuild PASS, so the promotion is accounted for.`
        : `, and the run records no prod.rebuild PASS. The promoted container does not ` +
          `contain the change being shipped.`),
  };
}

/** The gate's refusal: empty unless something measured and blocking was found. */
export function containerProvenanceViolations(v: ProvenanceVerdict): string[] {
  return v.blocking ? [`container-has-fix: ${v.detail}`] : [];
}
