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

/** The one env var that can supply the labels instead of GitHub. */
export const LABEL_FIXTURE_ENV = "RUNGATE_PROVE_LABEL_FIXTURE";

/**
 * Labels planted by a test, or `null` to read GitHub (#405).
 *
 * The contract test in `test/contract.test.ts` runs the ship gate over a
 * synthetic project whose `issueRepo` is `test/repo`. Before #405 the check
 * swallowed the resulting 404 and the contract was green — the fixture did
 * not satisfy prove-label, it was merely unreadable by it, which is the same
 * thing that had been true of `code-pushed` until that fixture was made a
 * real pushed repository. With the fail-open gone the contract goes red
 * locally (a token is present, so the 404 is a refusal) and green in CI (no
 * token, so it is UNMEASURED). A check whose verdict depends on which machine
 * runs it is worse than either answer.
 *
 * So the fixture supplies the INPUT and never the verdict. What is planted is
 * a label list, and `proveLabelViolation` still judges it — planting
 * `["needs-prove"]` refuses exactly as a live read of that issue would. There
 * is no value of this variable that buys a pass the real labels would not.
 *
 * Every use is announced, and `test/prove-label-gate.test.ts` asserts that
 * nothing under `lib/`, `gates/`, `scripts/` or `workflows/` sets it — a
 * fixture seam a shipping path can reach is a bypass, not a seam.
 *
 * Throws on unparseable content rather than falling back to the live read: a
 * typo'd fixture that silently became a network call is the fail-open this
 * whole issue is about, one level up.
 */
export function plantedLabelRead(env: Record<string, string | undefined>): LabelRead | null {
  const raw = env[LABEL_FIXTURE_ENV];
  if (raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${LABEL_FIXTURE_ENV} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((l) => typeof l !== "string")) {
    throw new Error(`${LABEL_FIXTURE_ENV} must be a JSON array of label strings, got: ${raw}`);
  }
  return { labels: parsed as string[], tokenPresent: true };
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
