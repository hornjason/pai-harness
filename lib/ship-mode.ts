/**
 * Whether this project ships through the harness, and the rule that says so (#911).
 *
 * `.claude/rules/ship-workflow.md` is generated, and until this module existed
 * its text was a constant: *"All implementation work must go through the ship
 * workflow — never spawn agents directly."* Jason decided on 2026-10-19,
 * reconfirmed on 2026-10-21, to bypass the harness until RunGate is stable —
 * so every agent working under that decision read a repo rule contradicting
 * its instructions, and had no way to tell a live policy from a stale one.
 * One did exactly the right thing: it shipped as instructed and closed its
 * report flagging the conflict, because nothing in the tree could resolve it.
 *
 * Editing the consumer's copy is not a fix. The file carries a
 * `generated-sha` and `decideRuleWrite` rewrites it on the next re-scaffold,
 * so the decision has to be declared where the generator reads it.
 *
 * ## Why the refusal lives here and not in the zod schema
 *
 * The obvious place to reject `"mode": "dierct"` is `ProjectHarnessSchema`,
 * as `z.enum(["harness", "direct"])`. That is the wrong place, and the reason
 * is the one `.claude/rules/config-access.md` names: `lib/scanner.ts`'s
 * `loadHarnessConfig` wraps its read in `catch {}` and returns `null`. A zod
 * throw from a typo'd mode would be swallowed there and read as *no config*,
 * which resolves to `"harness"` — **a typo that silently reinstates the
 * harness is precisely the failure #911 exists to stop.** So `ShipSchema`
 * takes `mode` as a plain string and this module is the single decider, with
 * a message that names the offending value and the modes that exist.
 */

import { RUNGATE_CONFIG_RELATIVE_PATH } from "./config-loader";

/** The declared ship modes. There is no third, and no silent fallback. */
export const SHIP_MODES = ["harness", "direct"] as const;

export type ShipMode = (typeof SHIP_MODES)[number];

/**
 * What a project with no `ship` block gets.
 *
 * Absent means `"harness"` so every consumer scaffolded before #911 is
 * byte-identical after it. That is asserted, not asserted-by-comment — see
 * `test/ship-mode.test.ts`.
 */
export const DEFAULT_SHIP_MODE: ShipMode = "harness";

export interface ShipPolicy {
  mode: ShipMode;
  /** The day the project went direct, `YYYY-MM-DD`. Present iff `direct`. */
  since?: string;
  /** Why, in the project's own words. Present iff `direct`. */
  reason?: string;
}

/** Thrown rather than defaulted. A config that says something unreadable is not a config that says nothing. */
export class ShipModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipModeError";
  }
}

/**
 * The config file NAMED, never read — every refusal and the generated rule
 * tell the reader where to go and fix it. Taken from `lib/config-loader.ts`
 * rather than written as a literal, per `.claude/rules/config-access.md`:
 * that constant is exported for exactly this, and a literal here is a
 * CONFIG-1 violation whether or not anything opens the file.
 */
const CONFIG_PATH = RUNGATE_CONFIG_RELATIVE_PATH;
const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function refuse(detail: string): never {
  throw new ShipModeError(`REFUSED: ${CONFIG_PATH} declares an unusable \`ship\` block — ${detail}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the project's ship policy from its loaded harness config.
 *
 * Takes the already-loaded config rather than a project root, because
 * `.claude/rules/config-access.md` puts every read of the config file behind
 * `lib/config-loader.ts` and the scan has already done it.
 *
 * A `ship` block that is present and unreadable REFUSES. Absent is the only
 * thing that defaults, and it defaults to the behaviour that existed before
 * this module.
 */
export function resolveShipPolicy(harnessConfig: Record<string, unknown> | null | undefined): ShipPolicy {
  const raw = harnessConfig?.ship;
  if (raw === undefined || raw === null) return { mode: DEFAULT_SHIP_MODE };

  if (typeof raw !== "object" || Array.isArray(raw)) {
    refuse(`\`ship\` must be an object, got ${Array.isArray(raw) ? "an array" : typeof raw}`);
  }

  const block = raw as Record<string, unknown>;
  const mode = block.mode;

  if (mode === undefined) {
    refuse(
      `it declares no \`mode\`. Write one of ${SHIP_MODES.map(m => `"${m}"`).join(", ")}, ` +
        `or delete the block to get "${DEFAULT_SHIP_MODE}"`,
    );
  }

  if (!(SHIP_MODES as readonly unknown[]).includes(mode)) {
    refuse(
      `\`ship.mode\` is ${JSON.stringify(mode)}, which is not a ship mode. ` +
        `Valid modes: ${SHIP_MODES.map(m => `"${m}"`).join(", ")}. ` +
        `This is NOT defaulted to "${DEFAULT_SHIP_MODE}" on purpose — a typo that silently ` +
        `reinstates the harness is the defect #911 exists to stop`,
    );
  }

  if (mode === "harness") return { mode: "harness" };

  // "direct" without a date and a reason is the bare permission #911 says the
  // next agent re-litigates. The whole defect being fixed is an agent unable
  // to tell a current decision from a stale one, so the two facts that make
  // it current are required rather than optional.
  const { since, reason } = block;
  if (!nonEmptyString(since)) {
    refuse(
      `\`ship.mode\` is "direct" but \`ship.since\` is ${JSON.stringify(since ?? null)}. ` +
        `A direct-ship declaration must say when it was taken, as "YYYY-MM-DD" — ` +
        `a rule with no date reads as sloppiness and gets re-litigated`,
    );
  }
  if (!SINCE_FORMAT.test(since)) {
    refuse(`\`ship.since\` is ${JSON.stringify(since)}, which is not a "YYYY-MM-DD" date`);
  }
  if (!nonEmptyString(reason)) {
    refuse(
      `\`ship.mode\` is "direct" but \`ship.reason\` is ${JSON.stringify(reason ?? null)}. ` +
        `A direct-ship declaration must say why, so the next agent can tell a current ` +
        `decision from a stale one`,
    );
  }

  return { mode: "direct", since, reason };
}

/**
 * The generated body of `.claude/rules/ship-workflow.md`.
 *
 * One binding, so there is one thing to mutate and the two modes cannot drift
 * into two renderers. The `"harness"` arm is byte-identical to what the
 * generator emitted before #911 — `test/ship-mode.test.ts` asserts that
 * against the file in this repository rather than against a copy of the
 * string, so a reformat here is caught.
 */
export function shipWorkflowRule(policy: ShipPolicy): string {
  if (policy.mode === "harness") {
    return `---
description: All implementation work must go through the ship workflow — never spawn agents directly
---

## Ship Workflow Required

When shipping an issue or implementing code changes, use the ship workflow:

\`\`\`
Skill("ship")  →  Workflow({ scriptPath: "workflows/ship.js" })
\`\`\`

**NEVER spawn Marcus, Quinn, or Rook directly with the Agent tool.** The ship workflow captures transcripts, runs compliance grading, and enforces gates. Spawning agents directly bypasses all measurement.

If Skill("harness") or Skill("goal") fails, fall back to Skill("ship") with the issue number.
`;
  }

  return `---
description: This project ships DIRECTLY as of ${policy.since} — do not route work through the ship workflow
---

## Direct-ship mode, since ${policy.since}

**This project is in direct-ship mode as of ${policy.since}: ${policy.reason}.**

Shipping an issue without the ship workflow is the current, declared policy of
this project. Do not call \`Skill("ship")\` and do not invoke
\`Workflow({ scriptPath: "workflows/ship.js" })\`. If another document tells you
to, that document is out of date and this one is not: the mode is declared in
\`${CONFIG_PATH}\` under \`ship\`, and this file is generated from it, so a
re-scaffold restates it rather than reverting it.

You do not need to escalate to ask whether the bypass is legitimate. The date
and the reason above are the answer.

## What to do instead

"Do not use the harness" is not an instruction you can follow. This is:

1. **Claim the issue on the tracker first** — \`gh issue edit <N> --add-assignee @me\`.
   An unclaimed issue is indistinguishable from an unstarted one.
2. **Work from a worktree cut off \`origin/main\`**, never from the project's
   primary checkout — another session is usually in it.
3. **Write the regression test first, and prove it can fail** before writing
   the fix. See \`.claude/rules/checks-must-be-able-to-fail.md\`.
4. **Run targeted tests**, not the whole suite — name the files your change
   touches.
5. **Open a PR and enable auto-merge.** Review happens there, where it is
   durable and where CI already runs.

## This is temporary, and reversible in one line

Set \`ship.mode\` back to \`"harness"\` in \`${CONFIG_PATH}\` and re-scaffold.
Nothing about the harness has been removed — \`Skill("ship")\` and
\`workflows/ship.js\` are unchanged and still work.
`;
}
