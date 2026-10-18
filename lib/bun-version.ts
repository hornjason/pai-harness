/**
 * The one declared Bun version for a project (#622).
 *
 * Covers SC-2064 (HARNESS-STANDARD.md).
 *
 * Nothing in this repository pinned Bun, and the versions in play had
 * already diverged by a full minor. `createCiWorkflows` emitted
 * `harness?.ci?.bunVersion || "latest"` into the generated `test` and
 * `gates` jobs, this project's own config declared no `ci` block, and
 * `release.yml` — the one file a human pinned by hand — said `1.3.14`. So
 * the job that publishes the package ran a different runtime from the job
 * that tested it, and the difference was invisible because no document
 * named both.
 *
 * `latest` is the shape of the defect rather than an unlucky value. It
 * agrees with itself across every file, so a check that only compares
 * spellings reports a tree with no pin at all as perfectly consistent, and
 * a suite that passed this morning can fail this afternoon over a runtime
 * nobody in the repository chose.
 *
 * ## Why this is a module and not a `||` chain in the generator
 *
 * Because the version has three consumers that must not answer the
 * question separately:
 *
 * | Consumer | What it needs |
 * |---|---|
 * | `createCiWorkflows` | the string to write into both generated workflows |
 * | `scripts/test-clean-env.ts` | the version to COMPARE the running bun against |
 * | `test/bun-version-agreement.test.ts` | the declaration every document is checked against |
 *
 * Two sites that agree today are one decider too many: only a mutation of a
 * SHARED binding can show the agreement is load-bearing rather than
 * coincidental (`.claude/rules/checks-must-be-able-to-fail.md`, fourth
 * shape). This is #488's fix for the test command and #87's for the type
 * check, applied to the step beside them.
 *
 * ## The rungs, and what each one is not
 *
 * 1. **`ci.bunVersion` from the rungate config.** The operator said so, in
 *    the field the generator already documents in the header of every file
 *    it writes.
 * 2. **Nothing.** `version` is `null` and `source` is `undeclared` — which
 *    is NOT a version, and callers must not be able to mistake it for one.
 *
 * There is deliberately no inference rung. A `packageManager` field or a
 * `.bun-version` file would be a SECOND declaration, and a module whose job
 * is to make one declaration authoritative cannot have two.
 *
 * ## What this does NOT cover
 *
 * - **The bun a developer actually runs.** Nothing here installs or
 *   switches a runtime; the local tooling REPORTS the comparison and leaves
 *   the choice to the human. A version manager is a different issue.
 * - **`.github/workflows/release.yml` and `issue-audit.yml`.** They are
 *   caller-owned (`.claude/rules/harness-managed.md`) and the scaffold does
 *   not write them, so the generator fix cannot reach them. They are held
 *   to the declaration by `test/bun-version-agreement.test.ts` instead,
 *   which is a check rather than a generator and says so.
 * - **What the registry can resolve.** A declared version that does not
 *   exist is emitted verbatim and fails loudly in CI. Silently substituting
 *   `latest` for an unresolvable pin would turn a typo into a moving target,
 *   which is the state this module exists to leave.
 */
import { tryLoadRungateConfig } from "./config-loader";

/** The field, spelled once. Prose, messages and tests all read it from here. */
export const BUN_VERSION_FIELD = "ci.bunVersion";

/**
 * What a generated workflow says when the project declares nothing.
 *
 * Unchanged from the pre-#622 behaviour on purpose: a consumer who has
 * never configured a version must not have their pipeline changed by taking
 * a rungate update. What changes is that the substitution is now RECORDED
 * in the file that carries it — `0`, `{}`, `null` and a silent default are
 * indistinguishable from a decision (`.claude/rules/config-access.md`).
 */
export const UNDECLARED_WORKFLOW_VERSION = "latest";

export type BunVersionSource = "config" | "undeclared";

export interface BunVersionDecision {
  /** The declared version, verbatim. `null` when nothing declares one. */
  version: string | null;
  source: BunVersionSource;
  /** Where the declaration lives — or would live, when there is none. */
  where: string;
  /** Why this version and not another. */
  reason: string;
}

export function bunVersionDecision(root: string): BunVersionDecision {
  // Through the loader, never a constructed path to `.claude/rungate*`
  // (`.claude/rules/config-access.md`). Both layouts are honoured, and a
  // malformed config THROWS rather than reading as an absent one — a
  // corrupt config is never a missing config, and `catch {}` here is the
  // conversion that rule exists to forbid.
  const config = tryLoadRungateConfig(root) as { ci?: { bunVersion?: unknown } } | null;
  const declared = config?.ci?.bunVersion;
  if (typeof declared === "string" && declared.trim() !== "") {
    return {
      version: declared.trim(),
      source: "config",
      where: `\`${BUN_VERSION_FIELD}\` in the rungate config`,
      reason: `the project declares \`${BUN_VERSION_FIELD}\``,
    };
  }

  return {
    version: null,
    source: "undeclared",
    where: `\`${BUN_VERSION_FIELD}\` in the rungate config`,
    reason: `the project declares no \`${BUN_VERSION_FIELD}\``,
  };
}

/** The string a `setup-bun` step should carry for this project. */
export function workflowBunVersion(decision: BunVersionDecision): string {
  return decision.version ?? UNDECLARED_WORKFLOW_VERSION;
}

/**
 * The `setup-bun` step, emitted from one place.
 *
 * Both generated workflows call this rather than interpolating a version of
 * their own: two emissions of one decision are two things to drift, and the
 * drift is what #622 is.
 */
export function setupBunStep(decision: BunVersionDecision, indent = "      "): string {
  const inner = `${indent}  `;
  const note =
    decision.source === "undeclared"
      ? `${inner}  # UNDECLARED: this project sets no \`${BUN_VERSION_FIELD}\`, so CI resolves whatever\n` +
        `${inner}  # \`${UNDECLARED_WORKFLOW_VERSION}\` is at the moment the job runs. Set the field to pin it.\n`
      : "";
  return (
    `${indent}- uses: oven-sh/setup-bun@v2\n` +
    `${inner}with:\n` +
    note +
    `${inner}  bun-version: "${workflowBunVersion(decision)}"`
  );
}

export type BunVersionAgreementVerdict = "match" | "mismatch" | "undeclared";

export interface BunVersionReading {
  agreement: BunVersionAgreementVerdict;
  /** The version this process is running under. */
  running: string;
  /** The declared version, or null. */
  declared: string | null;
  /** One line, for a log a human reads. */
  line: string;
}

/**
 * Compare a running Bun against the declared one, and say so in one line.
 *
 * Both versions are PARAMETERS rather than read in here, so a test can
 * drive every branch with fabricated values. A comparison that read
 * `Bun.version` itself could only ever be exercised in the `match` state on
 * a correctly configured machine, and the branch that matters — the warning
 * — would be unreachable from any test (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * `undeclared` is its own verdict and NOT a match. A tree with no
 * declaration has not been checked against one; reporting agreement there
 * would make the warning satisfiable by deleting the declaration, which is
 * the cheapest wrong fix available to anyone it ever annoys.
 *
 * Every line opens with `bun <running>` and spells the running version
 * exactly once, because `scripts/test-clean-env.ts`'s provenance line is
 * counted: a mismatch line naming the running version twice would report
 * two provenance lines for one run.
 */
export function bunVersionReading(opts: {
  running: string;
  declared: string | null;
  where: string;
}): BunVersionReading {
  const { running, declared, where } = opts;
  const head = `bun ${running}`;

  if (declared === null) {
    return {
      agreement: "undeclared",
      running,
      declared,
      line:
        `${head} — UNDECLARED: nothing sets ${where}, so CI resolves ` +
        `\`${UNDECLARED_WORKFLOW_VERSION}\` at job time and this run is UNMEASURED against it`,
    };
  }
  if (declared === running) {
    return {
      agreement: "match",
      running,
      declared,
      line: `${head} — matches the version declared in ${where}`,
    };
  }
  return {
    agreement: "mismatch",
    running,
    declared,
    line:
      `${head} — MISMATCH: ${where} declares ${declared}, so CI runs a different Bun ` +
      `than this did and a green result here is not a green result there`,
  };
}
