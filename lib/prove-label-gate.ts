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
