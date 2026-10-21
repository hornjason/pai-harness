/**
 * Whether what a consumer can install IS what this tree is (#875).
 *
 * ## The question this asks, and why it is not the one next door
 *
 * `lib/published-artifact.ts` compares the registry tarball against the tree
 * by content and classifies the result. Its refusal — `artifactViolations` —
 * is about a LABEL: `DIVERGED` means one version string is being used for two
 * different trees, and `AHEAD` is waved through because a repository past its
 * last release is what a repository between releases is.
 *
 * That is the right refusal for the question it asks and it is the wrong one
 * for the question #875 was filed about. The harm in the issue is not a label:
 * it is that `bunx rungate` hands a consumer the **pre-#863 tier-2 secret
 * scan**, which reported five property references as credential assignments
 * and turned `gates` red on `hornjason/agentgrit`. That consumer is no better
 * off if `package.json` says `0.7.0`.
 *
 * So this module asks the consumer's question: **is the published artifact the
 * content this tree would publish?** No version string is an input to it.
 *
 * ## Which is also what makes it survive the cheapest wrong fix
 *
 * The 5pm repair for a red distribution check is to bump `package.json`. It
 * works on the label — `artifactStanding` reads `AHEAD` and
 * `artifactViolations` returns `[]` — and it moves nothing a consumer can
 * observe. Measured on this tree 2026-10-21, the reading either side of that
 * bump:
 *
 * | | tree `0.6.0` | tree `0.7.0` |
 * |---|---|---|
 * | `artifactStanding` | `DIVERGED` | `AHEAD` |
 * | `artifactViolations` | 1 violation | **none** |
 * | files differing in bytes | 45 | **45** |
 * | files the artifact lacks | 58 | **58** |
 * | commits since the published tag | 183 | **183** |
 *
 * `currencyRefusal` reads the bottom three rows, so the bump moves it not at
 * all. That is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * — *a case that goes green under the WRONG fix* — answered by choosing inputs
 * the wrong fix does not touch, rather than by hoping nobody reaches for it.
 *
 * ## Two refusals, not one decider wearing two hats
 *
 * `currencyRefusal` and `artifactViolations` are NOT the fourth shape. They
 * are distinguishable, and the distinguishing input is named rather than
 * asserted: a tree at `0.7.0` against a published `0.6.0` whose content
 * differs. `artifactViolations` returns `[]` — no label is lying — and
 * `currencyRefusal` refuses, because a consumer still cannot obtain this tree.
 * A mutation of either is visible on that input alone.
 *
 * ## This is a script's refusal, deliberately, and not the suite's
 *
 * `STALE` is the NORMAL state of this repository between releases, because
 * `preflightRefusal` in `lib/release-preflight.ts` requires the tree's version
 * to be absent from the registry at release time — so the bump happens AT the
 * release and never before it. A gate wired into `bun test` would therefore be
 * red on `main` every day of the repo's life, and `lib/release-preflight.ts`
 * already records what that costs: *a red job over a green release is how a
 * gate teaches people to stop reading it.*
 *
 * So the reading lives behind `scripts/check-distribution-currency.ts`, which
 * exits non-zero. It is a thing you run before cutting a release and a thing
 * that answers "how far behind is npm" in one command — not a thing that
 * blocks an unrelated PR on a condition its author cannot clear.
 */
import {
  contentAgrees,
  type ArtifactStanding,
  type ContentDifference,
} from "./published-artifact";

/**
 * The one non-zero exit in the distribution-currency path.
 *
 * Declared once and exported so a test can build a mutant with it set to `0`
 * and observe the refusal being removed — `.claude/rules/checks-must-be-able-
 * to-fail.md`, *For a script whose job is to exit non-zero*. A later branch
 * that inlines `process.exit(1)` bypasses the mutation and the case goes green
 * having witnessed nothing, so `test/distribution-currency.test.ts` also
 * asserts the constant is the script's only exit code.
 */
export const DISTRIBUTION_STALE_EXIT = 1;

/**
 * `CURRENT` — a consumer installing from npm gets this tree.
 * `STALE` — they do not, whatever the version strings say.
 * `UNMEASURED` — nobody looked. Never a pass.
 */
export type CurrencyReading = "CURRENT" | "STALE" | "UNMEASURED";

export interface DistributionCurrency {
  reading: CurrencyReading;
  /** Published files whose bytes differ from the tree's. */
  staleFiles: string[];
  /** Files the tree would publish that the artifact does not have at all. */
  missingFiles: string[];
  /** Files in the artifact that the tree no longer publishes. */
  removedFiles: string[];
  /** Commits between the published tag and `HEAD`. `null` is a reading nobody took. */
  commitsAhead: number | null;
  /** The version a consumer can install, for the report. Never an input to the verdict. */
  publishedVersion: string | null;
  /** Non-empty exactly when `reading` is `UNMEASURED`. */
  unmeasuredReasons: string[];
}

/**
 * Project an `ArtifactStanding` onto the consumer's question.
 *
 * A projection and not a second measurement: every field here is read off the
 * standing, so this cannot disagree with `lib/published-artifact.ts` about
 * what was observed — only about what the observation means.
 *
 * `reading` is derived from `contentAgrees`, which is the same predicate
 * `artifactStanding` uses to separate `MATCHED` from `DIVERGED`. The version
 * ordering that sends an equal-content tree to `AHEAD` is simply not consulted.
 */
export function distributionCurrency(s: ArtifactStanding): DistributionCurrency {
  const d: ContentDifference | null = s.difference;
  const base = {
    staleFiles: d?.differing ?? [],
    missingFiles: d?.onlyLocal ?? [],
    removedFiles: d?.onlyPublished ?? [],
    commitsAhead: s.commitsAhead,
    publishedVersion: s.publishedVersion,
  };
  if (s.reading === "UNMEASURED" || d === null) {
    return {
      ...base,
      reading: "UNMEASURED",
      unmeasuredReasons:
        s.unmeasuredReasons.length > 0
          ? s.unmeasuredReasons
          : ["the content comparison was not performed"],
    };
  }
  return {
    ...base,
    reading: contentAgrees(d) ? "CURRENT" : "STALE",
    unmeasuredReasons: [],
  };
}

/**
 * The single refusal. `null` allows.
 *
 * One exported binding, so there is one thing to mutate. A second predicate
 * over the same fields would always agree with this one and would survive any
 * mutation of it.
 */
export function currencyRefusal(c: DistributionCurrency): string | null {
  if (c.reading === "UNMEASURED") {
    return (
      `UNMEASURED: nothing was compared — ${c.unmeasuredReasons.join("; ")}. ` +
      `A reading that could not be taken is not one that passed, so this exits ` +
      `non-zero rather than reporting that the distribution is fine.`
    );
  }
  if (c.reading === "STALE") {
    const n = c.staleFiles.length + c.missingFiles.length + c.removedFiles.length;
    return (
      `STALE: a consumer running \`bunx rungate\` today does NOT get this tree. ` +
      `rungate@${c.publishedVersion} on the registry differs from what this tree ` +
      `would publish in ${n} files — ${c.staleFiles.length} whose bytes differ, ` +
      `${c.missingFiles.length} it does not have at all, ${c.removedFiles.length} ` +
      `it still has` +
      (c.commitsAhead === null ? "" : `, across ${c.commitsAhead} commits since the published tag`) +
      `. Bumping package.json does not change one of those numbers. The remedy ` +
      `is a release.`
    );
  }
  return null;
}

/** Every number this reading produced, whether or not it refuses. */
export function currencyReportLines(c: DistributionCurrency): string[] {
  return [
    `distribution currency: ${c.reading}`,
    `  published version        ${c.publishedVersion ?? "UNREAD"}`,
    `  commits since its tag    ${c.commitsAhead ?? "UNREAD"}`,
    `  files differing in bytes ${c.staleFiles.length}`,
    `  files npm does not have  ${c.missingFiles.length}`,
    `  files npm still has      ${c.removedFiles.length}`,
  ];
}
