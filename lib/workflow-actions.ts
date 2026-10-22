/**
 * Every action the scaffold's generated workflows reference, and how each is
 * pinned (#377).
 *
 * In the shape `lib/bun-version.ts` (#622) and `lib/claude-code-action.ts`
 * (#689) established: one declaration, so there is one thing to mutate and
 * every position is CHECKED against it rather than agreeing with it by
 * coincidence.
 *
 * It imports two per-action declaration modules and nothing else, and that is
 * the point rather than an exception (#631). `lib/claude-code-action.ts` and
 * `lib/google-auth-action.ts` each carry their own SHA, the date it was
 * resolved and the trap in resolving it, and `actionPinParity` compares every
 * position in the tree to them. Re-typing either value here would make this
 * file a second position — #689's defect reinstated inside the registry that
 * exists to prevent it. So this list says WHICH actions the generator may
 * emit and HOW each is pinned; the two modules say WHAT the pin is.
 *
 * **This reaches every consumer.** `createCiWorkflows` writes `ci.yml` and
 * `gates.yml` into every scaffolded project, so an unpinned action here is an
 * unpinned action in every project rungate touches. That is the whole of why
 * #377 was filed separately from #364 rather than fixed alongside it.
 *
 * ## The decision, made rather than left as an omission
 *
 * #377 named three options and asked for one to be chosen out loud. **Option
 * 2: third-party actions are pinned to a full commit SHA; first-party
 * `actions/*` stay on a major tag.**
 *
 * The argument for the split:
 *
 * - **`actions/*` is GitHub's own namespace, running on GitHub's own
 *   runner.** The tag is how security patches reach a consumer who is not
 *   watching — pinning it converts an automatic fix into a manual one, across
 *   every scaffolded project, with nothing in any of them refreshing it.
 * - **A third party has a smaller security team and a different release
 *   discipline**, and `oven-sh/setup-bun` executes arbitrary setup code in
 *   the job. That is the exposure worth paying maintenance for, and it is
 *   one action rather than a class.
 *
 * **The counter-argument, recorded because it is real and this file is where
 * someone will come to reverse the decision.** GitHub's own hardening guide
 * says pin *all* actions to a SHA, and "first-party" is a trust assumption
 * that can fail short of a platform compromise: a malicious commit to
 * `actions/checkout` would run in every consumer's job without GitHub's
 * infrastructure being owned. The split above trades that residual risk for
 * a maintenance contract this project can actually honour. If that trade
 * stops being worth it, change `PINNING` below — every position follows in
 * the same commit, which is the point of the declaration.
 *
 * ## What this does NOT do
 *
 * It does not keep itself fresh, and neither does the suite. Staleness is a
 * network fact: nothing readable from this tree can tell a current SHA from
 * one that is three releases behind. A refusal keyed to a date would be a
 * test that goes red on a day nobody changed anything, which is a test people
 * switch off.
 *
 * `scripts/check-action-pins.ts` is the network check. What the suite can and
 * does hold is the structure: one declaration, every position agreeing with
 * it, every third-party pin a full SHA carrying its version and the date it
 * was read. `resolvedOn` dates a reading; it does not certify it.
 *
 * ## When the check runs, and how a pin gets bumped (#789)
 *
 * #377 shipped that script and left it *"run deliberately"*, which is the
 * same sentence as "never": nothing in this repository invoked it, and a
 * rule nothing executes is not a rule (`.claude/rules/config-access.md` says
 * this about ADRs; it was true of this line too).
 *
 * `.github/workflows/action-pins.yml` runs it weekly and on demand. It is
 * **this repository's workflow and is not generated into consumers**, on
 * purpose: a consumer's pin comes from the rungate version they installed,
 * not from a question they ask GitHub themselves, and a scheduled job in
 * every scaffolded project would hand each of them a red workflow they
 * cannot fix. `test/action-pin-freshness-schedule.test.ts` asserts it is
 * absent from the generator's output, so adding it to the templates is a
 * scope change rather than a tightening.
 *
 * `workflow_dispatch` as well as `schedule`, because GitHub disables a
 * schedule after 60 days of repository inactivity and a check you cannot
 * trigger by hand fails silently on exactly the week nobody pushed.
 */
import {
  CLAUDE_CODE_ACTION,
  CLAUDE_CODE_ACTION_RESOLVED_ON,
  CLAUDE_CODE_ACTION_SHA,
  CLAUDE_CODE_ACTION_VERSION,
} from "./claude-code-action";
import {
  GOOGLE_AUTH_ACTION,
  GOOGLE_AUTH_ACTION_RESOLVED_ON,
  GOOGLE_AUTH_ACTION_SHA,
  GOOGLE_AUTH_ACTION_VERSION,
} from "./google-auth-action";

/**
 * What to do when the freshness check says a pin is stale.
 *
 * ONE declaring position. The script prints this and no sentence of its own
 * — two near-identical procedures is the shape where somebody updates the
 * copy an operator does not read. It names the three fields together because
 * bumping `sha` without `resolvedOn` leaves a reading dated to a commit it
 * was not taken against, which is worse than no date at all.
 */
export const BUMP_PROCEDURE =
  "Update lib/workflow-actions.ts — sha, version and resolvedOn together, in one edit — then " +
  "re-run the scaffold so every generated position follows in the same commit. Consumers bump " +
  "by upgrading rungate; they do not carry this check themselves (#789).";

/** How one action is referenced, and why. */
export type PinStyle =
  /** A full 40-character commit SHA — the only form a publisher cannot repoint. */
  | "sha"
  /** A major tag, so upstream security patches reach consumers unattended. */
  | "tag";

export interface ActionPin {
  /** The action, by the name a `uses:` line spells. */
  action: string;
  style: PinStyle;
  /** The tag this is, or is pinned as. Rendered as the trailing comment on a SHA pin. */
  version: string;
  /** The commit the tag dereferenced to. REQUIRED when `style` is `sha`. */
  sha?: string;
  /** The day the tag was dereferenced. REQUIRED when `style` is `sha`. */
  resolvedOn?: string;
  /** Why this style, in one sentence, for the reader deciding whether to change it. */
  why: string;
}

/**
 * The declared set.
 *
 * `test/generated-workflow-pins.test.ts` asserts every `uses:` the generator
 * emits is declared here, so adding an action to a template without adding it
 * to this list fails — which is the "detector narrower than what it detects"
 * shape #377 warned about, closed by construction rather than by a list of
 * the three actions that happen to be in use today.
 */
export const PINNING: readonly ActionPin[] = [
  {
    action: "actions/checkout",
    style: "tag",
    version: "v4",
    why: "GitHub's own namespace on GitHub's own runner; the tag is how a security patch reaches a consumer who is not watching",
  },
  // #1190. The shard aggregate's evidence channel. These are the two actions
  // that let a shard prove it EXECUTED without the aggregate asking the
  // Actions API: `gh` is only on GitHub's own runner images and `actions:
  // read` is a scope a job has to be granted, whereas the artifact service
  // is reached by the runner itself for the run it is already in. Same
  // first-party reasoning as `actions/checkout` above.
  {
    action: "actions/upload-artifact",
    style: "tag",
    version: "v4",
    why: "GitHub's own namespace on GitHub's own runner; the tag is how a security patch reaches a consumer who is not watching",
  },
  {
    action: "actions/download-artifact",
    style: "tag",
    version: "v4",
    why: "GitHub's own namespace on GitHub's own runner; the tag is how a security patch reaches a consumer who is not watching",
  },
  {
    action: "oven-sh/setup-bun",
    style: "sha",
    version: "v2",
    // `refs/tags/v2` is a LIGHTWEIGHT tag here — `object.type` is `commit`,
    // so `.object.sha` IS the commit and no dereference is needed. Both
    // routes were run and agreed:
    //   gh api repos/oven-sh/setup-bun/git/ref/tags/v2 --jq .object.sha
    //   gh api repos/oven-sh/setup-bun/commits/v2      --jq .sha
    // Recorded because #689's pin is an ANNOTATED tag, where reading
    // `.object.sha` and stopping gives a tag object that cannot be a `uses:`
    // pin at all — and that error was made there. Which kind a tag is, is
    // not something to assume.
    sha: "0c5077e51419868618aeaa5fe8019c62421857d6",
    resolvedOn: "2026-10-19",
    why: "third-party, executes setup code in the job, and one action is a maintenance cost this project can honour",
  },
  // The two actions the ai-review job runs (#631). Their SHAs are IMPORTED,
  // never re-typed: `lib/claude-code-action.ts` and `lib/google-auth-action.ts`
  // are each the one declaration for their action, and `actionPinParity`
  // compares every position in the tree to them. A literal here would be a
  // second position, which is #689's defect reinstated inside the registry
  // that exists to prevent it. What this list adds is the OTHER property —
  // that an action the generator emits is an action somebody decided on, and
  // that the weekly freshness check in `scripts/check-action-pins.ts` asks
  // GitHub about it without anyone remembering to add it.
  {
    action: CLAUDE_CODE_ACTION,
    style: "sha",
    version: CLAUDE_CODE_ACTION_VERSION,
    sha: CLAUDE_CODE_ACTION_SHA,
    resolvedOn: CLAUDE_CODE_ACTION_RESOLVED_ON,
    why: "third-party, runs an autonomous agent over pull-request content, and a repointable tag would change what reviews a consumer's code without a commit saying so (#689)",
  },
  {
    action: GOOGLE_AUTH_ACTION,
    style: "sha",
    version: GOOGLE_AUTH_ACTION_VERSION,
    sha: GOOGLE_AUTH_ACTION_SHA,
    resolvedOn: GOOGLE_AUTH_ACTION_RESOLVED_ON,
    why: "third-party, and it is the step that mints the federated credential — a repointable tag on the one action holding the token is the pin that matters most (#631)",
  },
] as const;

/** A full commit SHA, which is the only `uses:` form a publisher cannot repoint. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

export function actionPin(action: string): ActionPin | null {
  return PINNING.find(p => p.action === action) ?? null;
}

/**
 * The exact text a `uses:` value must carry for one action.
 *
 * Pin and comment in ONE rendering, so there is no way to update half of a
 * SHA pin and leave the version comment describing the other half — #689's
 * defect, where the comment was the only thing a reader checked and it
 * agreed with itself across two different commits.
 */
export function actionRef(action: string): string {
  const pin = actionPin(action);
  if (!pin) {
    throw new Error(
      `${action} is not declared in lib/workflow-actions.ts. Every action a generated ` +
        `workflow references must be declared there with a pin style and a reason, or ` +
        `consumers inherit a reference nobody decided on (#377).`,
    );
  }
  if (pin.style === "tag") return `${pin.action}@${pin.version}`;
  if (!pin.sha || !FULL_SHA.test(pin.sha)) {
    throw new Error(
      `${action} declares style 'sha' and carries ${pin.sha ? `'${pin.sha}'` : "no sha"}. ` +
        `A short sha or a tag is repointable, which is the thing the style exists to prevent.`,
    );
  }
  return `${pin.action}@${pin.sha} # ${pin.version}`;
}

/** Every `uses:` reference in a workflow document, as `{ action, ref, line }`. */
export function usesReferences(text: string): { action: string; ref: string; line: number }[] {
  const out: { action: string; ref: string; line: number }[] = [];
  text.split("\n").forEach((raw, i) => {
    // Anchored on `uses:` so a sentence in a header comment is prose and not
    // a position (#235). A commented-out step is excluded for the same
    // reason: it references nothing at run time.
    const m = /^\s*(?:-\s+)?uses:\s*([A-Za-z0-9._\/-]+)@(\S+)/.exec(raw);
    if (!m) return;
    out.push({ action: m[1], ref: m[2], line: i + 1 });
  });
  return out;
}

/**
 * Every way a workflow document disagrees with the declaration.
 *
 * Returns the offending POSITIONS, named. "2 violations" does not send
 * anybody to a line.
 */
export function pinViolations(text: string, file: string): string[] {
  const out: string[] = [];
  for (const u of usesReferences(text)) {
    const pin = actionPin(u.action);
    if (!pin) {
      out.push(`${file}:${u.line} uses ${u.action}, which lib/workflow-actions.ts does not declare`);
      continue;
    }
    const expected = actionRef(u.action).split("@")[1].split(" ")[0];
    if (u.ref !== expected) {
      out.push(
        `${file}:${u.line} pins ${u.action}@${u.ref}; the declaration says ${expected}` +
          (pin.style === "sha" ? ` (${pin.version}, read ${pin.resolvedOn})` : ""),
      );
    }
  }
  return out;
}
