/**
 * Whether an issue's labels say the close gate must stop (#1390, #395).
 *
 * `needs-prove` marks an issue whose fix has not been demonstrated against a
 * reproducer. `proven` is what `/prove` adds once it has been. An issue
 * carrying the first without the second is one about to be closed on the
 * strength of a passing suite, which is the thing the prove step exists to
 * stop.
 *
 * ## Why this is a function and not four lines in the gate
 *
 * It was four lines in `gates/workflow.test.ts`, and the decision was
 * entangled with the transport that fetched the labels — a GitHub CLI
 * subprocess. Nothing could exercise the rule without a network, a `gh`
 * binary and an authenticated environment, so nothing did. The criterion
 * forbidding that subprocess (SC-502) was ticked over it for its whole life.
 *
 * One exported predicate over a plain string list means the rule can be
 * driven directly, and means there is a single binding to mutate — the
 * property `.claude/rules/checks-must-be-able-to-fail.md` asks for. The
 * transport is `getIssueLabels` in `lib/github.ts` and is now a separate
 * question, which is the point: a decision tangled with its transport is a
 * decision nobody tests.
 *
 * Returns the refusal text, or `null` to allow.
 */
export function proveLabelViolation(labels: readonly string[]): string | null {
  const has = (name: string) => labels.includes(name);
  if (!has("needs-prove")) return null;
  if (has("proven")) return null;
  return (
    "Close gate blocked: the issue carries `needs-prove` and not `proven`. " +
    "Run /prove to demonstrate the fix against a reproducer before closing (#1390)."
  );
}

/**
 * What the gate does when the label read itself fails (#405).
 *
 * The read used to be wrapped in `catch { return }`, so a missing token, a
 * rate limit, a network blip and a typo'd repo slug all landed in the same
 * place and the gate reported clean. "No blocking label" and "could not find
 * out" were the same outcome, which is shape one in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * ## The token-less decision, and why
 *
 * #405 left this open: "whether a token-less local run should refuse or skip.
 * A gate that refuses every local invocation is a gate people will comment
 * out." Three outcomes rather than two, decided on what the environment can
 * actually answer:
 *
 * | token | read | verdict |
 * |---|---|---|
 * | — | n/a | `UNMEASURED` — the environment was never able to answer |
 * | present | threw | `REFUSE` — something that should have worked did not |
 * | present | ok | `ALLOW` or `REFUSE` by `proveLabelViolation` |
 *
 * A token-less run does NOT refuse, because every local `bun test gates/`
 * would block and the gate would be deleted within a week. It does not
 * silently pass either: the verdict is `UNMEASURED` and carries its reason,
 * which is the distinction `.claude/rules/config-access.md` names — `SKIP` is
 * indistinguishable from success and `UNMEASURED` is not.
 *
 * That is safe where it matters because of where the gate actually runs, which
 * was checked rather than assumed:
 *
 * - It is guarded by `isShipPlus()` — `gates/workflow.test.ts:229`, true only
 *   when workflow state says `SHIP` or `DONE`. It is reached from
 *   `gates/gate-executor.ts`, which spawns `bun test gates/` in the ship
 *   pipeline's own process environment, where a token is present.
 * - CI runs `gates/workflow.test.ts` too (`ci.yml` runs a bare `bun test`) and
 *   has NO token. It never reaches this code: there is no workflow state in a
 *   CI checkout, so `isShipPlus()` is false and the test returns first. The
 *   `gates` job does not run this file at all — only the conformity suite and
 *   the secret scan.
 *
 * So the authenticated-and-still-failing case is the one real invocations hit,
 * and it is the one that now blocks.
 *
 * `tokenPresent` comes from `resolveGitHubToken` at the call site rather than
 * from a second `process.env` read here — two deciders of one fact survive
 * any mutation of either.
 */
export type ProveLabelVerdict = "ALLOW" | "REFUSE" | "UNMEASURED";

export interface LabelRead {
  /** Set when the read succeeded. */
  labels?: readonly string[];
  /** Set when it threw. */
  error?: unknown;
  /** Whether the environment had a token at all. */
  tokenPresent: boolean;
}

export interface ProveLabelOutcome {
  verdict: ProveLabelVerdict;
  /** Why, in the words the gate prints. `null` only when allowed. */
  message: string | null;
}

export function proveLabelGateVerdict(read: LabelRead): ProveLabelOutcome {
  if (read.labels !== undefined) {
    const refusal = proveLabelViolation(read.labels);
    return refusal ? { verdict: "REFUSE", message: refusal } : { verdict: "ALLOW", message: null };
  }

  const detail = read.error instanceof Error ? read.error.message : String(read.error ?? "no error reported");

  if (!read.tokenPresent) {
    return {
      verdict: "UNMEASURED",
      message:
        "prove-label was NOT checked: no GITHUB_TOKEN or GH_TOKEN in this environment, so the " +
        `issue's labels could not be read (${detail}). This is UNMEASURED, not clean — an issue ` +
        "carrying `needs-prove` would look the same from here.",
    };
  }

  return {
    verdict: "REFUSE",
    message:
      "Close gate blocked: a token was present and the issue's labels still could not be read " +
      `(${detail}). "No blocking label" and "could not find out" are different facts, and this ` +
      "is the second one — re-run once GitHub is reachable rather than closing on a read that " +
      "never happened (#405).",
  };
}
