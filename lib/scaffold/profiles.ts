/**
 * Scaffold profiles — how much of the harness a project opted into.
 *
 * `full` is everything, and is the default: no existing consumer changes
 * behaviour by upgrading. `minimal` produces the AI-friendly repo — AGENTS.md,
 * the CLAUDE.md bridge, `.claude/rules/`, `specs/` and `docs/` layout,
 * project-state, and the conformity test — and leaves out the parts that only
 * mean something to a project running the ship harness.
 *
 * Why this exists: before #449 there was no way to get the structure without
 * the harness. A consumer repo was hand-built around the gap, which put it
 * outside the thing that keeps projects conformant — the drift it will develop
 * is exactly what the scaffold exists to prevent.
 *
 * **Both maps carry a reason per entry, deliberately.** An exclusion with no
 * stated reason is indistinguishable from an oversight, and the next reader
 * cannot tell whether deleting it is safe. `STEPS_NOT_REHEARSED` in
 * `./rehearsal.ts` is the pattern and the same rename protection applies:
 * `test/scaffold-profile.test.ts` asserts every named step and rule still
 * exists, so a rename cannot silently empty a map and re-enable the step.
 */

export type ScaffoldProfile = "full" | "minimal";

export const SCAFFOLD_PROFILES: readonly ScaffoldProfile[] = ["full", "minimal"] as const;

export const DEFAULT_PROFILE: ScaffoldProfile = "full";

/**
 * Write steps `minimal` does not run, by the exported symbol each is called
 * through in `./write-steps.ts`.
 */
export const STEPS_NOT_MINIMAL: ReadonlyMap<string, string> = new Map([
  [
    // The path is described rather than spelled out because this reason is a
    // STRING, and CONFIG-1 counts a config path literal in a string as a
    // direct access site. `scanConfigAccess` strips comments before matching,
    // so a doc comment naming the path is fine — a map value is not. That
    // distinction is deliberate: CONFIG-2 exists because ship.js hid eleven
    // real config reads inside template literals. Spelling it out here cost
    // two red tests on the first run of this file.
    "generateOrAuditProjectHarness",
    "writes the harness config directory, which configures a ship pipeline this project does not run",
  ],
  [
    "generateAgentBriefsStep",
    "writes marcus.md and quinn.md, briefs for agents only the ship workflow spawns",
  ],
  [
    "createCiWorkflows",
    "writes ci.yml and gates.yml, which invoke harness gates the project has not opted into",
  ],
]);

/**
 * Scoped rules `minimal` does not write, by filename in `.claude/rules/`.
 *
 * A rule is instructions to an agent. Shipping one that points at machinery
 * the project does not have is worse than shipping nothing — the agent follows
 * it, the command is absent, and the failure looks like the agent's fault.
 */
export const RULES_NOT_MINIMAL: ReadonlyMap<string, string> = new Map([
  [
    "ship-workflow.md",
    'instructs an agent to route all work through Skill("ship"), which has no harness here to route into',
  ],
  [
    "harness-managed.md",
    "lists harness-owned files as do-not-edit, most of which this profile never writes",
  ],
]);

export function isStepIncluded(step: string, profile: ScaffoldProfile): boolean {
  return profile === "full" || !STEPS_NOT_MINIMAL.has(step);
}

export function isRuleIncluded(filename: string, profile: ScaffoldProfile): boolean {
  return profile === "full" || !RULES_NOT_MINIMAL.has(filename);
}

/**
 * Throws on an unrecognised value rather than falling back to the default.
 * A typo'd `--profile=minimial` that silently scaffolded the full harness
 * would be the Silent Default Substitution anti-pattern in
 * `.claude/rules/config-access.md`: the run looks like it honoured the flag
 * and the output says otherwise.
 */
export function parseProfile(raw: string | null | undefined): ScaffoldProfile {
  if (raw === null || raw === undefined) return DEFAULT_PROFILE;
  if ((SCAFFOLD_PROFILES as readonly string[]).includes(raw)) return raw as ScaffoldProfile;
  throw new Error(
    `Invalid --profile value: ${raw}. Valid values: ${SCAFFOLD_PROFILES.join(", ")}`,
  );
}
