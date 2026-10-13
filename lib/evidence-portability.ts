/**
 * Can this AC's evidence be reproduced anywhere but the machine that wrote it?
 * (#338)
 *
 * `evidence-target-valid` was a gate check that asserted nothing:
 *
 *     const paths = harness?.codeCommittedPaths || [];
 *     if (paths.length === 0) return;      // nothing authors this key
 *     const outside = fileRefs.filter(…);  // computed and DISCARDED
 *     // Informational — outside refs are common (test fixtures, config)
 *
 * Two independent reasons it could not fail, and #315 removed it rather than
 * leave a name in `config/ceremony-profiles.json` reporting coverage it did
 * not provide. #338 is the rebuild, and it required a measurement first.
 *
 * ## The measurement, and what it killed
 *
 * Over the 82 completed runs in `~/.rungate` — 456 ACs, 452 with an evidence
 * command, 593 file references between them:
 *
 *   test              309   52.1%
 *   source            156   26.3%
 *   other              74   12.5%
 *   spec / config      34    5.8%
 *   docs / artifacts   20    3.4%
 *
 * Checked against each AC's own declared `contextFiles`: **264 inside, 278
 * outside**, 51 with no context declared. The largest outside category is
 * `test`, 158 of the 278 — which is not a defect but the normal shape of an
 * AC: the evidence command runs the test that proves it, and the test file is
 * not among the source files the AC is *about*.
 *
 * So "evidence commands target files within scope" is not a property real
 * runs have. Any threshold near zero would be red on every run and switched
 * off within a week, which is exactly what #338 said would happen if the rule
 * were invented rather than measured. **The check cannot be rebuilt under its
 * original name, and this says so rather than shipping a weaker version of
 * it.**
 *
 * ## What the measurement did find
 *
 * 50 of 452 evidence commands — **11.1%, across 11 of 82 runs** — contain an
 * absolute path into a developer's home directory. 55 of the 56 references
 * point at the harness checkout itself and 1 at a consumer's; the per-root
 * breakdown is in `specs/GATE-CONTRACTS-SPEC.md`, because SC-A1 of
 * `specs/bootstrap-data-flow/success-criteria.md` says the harness must not
 * name one of its consumers in its own source.
 *
 * Those commands cannot run in CI or on anyone else's machine. Evidence that
 * only reproduces where it was written is not evidence, and this is the gate
 * whose job is to say so.
 *
 * The rate is the reason this is the right threshold: ~1 run in 7. A check
 * that fires on everything gets disabled; a check that fires on nothing is
 * the one being replaced.
 *
 * ## Why zero tolerance here is not the mistake above
 *
 * Because the correct form already exists and costs one token. Evidence
 * commands run with `cwd: projectRoot` (`lib/evidence-prevalidator.ts:208`),
 * so the project's own files need no prefix at all, and the harness root has
 * had `$HARNESS_ROOT` since `gates/run-gate.ts` — which is what all 55 of
 * those references spell out longhand.
 */

export interface EvidenceAc {
  id?: unknown;
  evidenceMethod?: { type?: unknown; command?: unknown } | null;
}

/**
 * A path rooted in somebody's home directory.
 *
 * `/Users/<name>/…` and `/home/<name>/…` only. Not every absolute path:
 * `/tmp` is reproducible by construction and 9 commands use it legitimately,
 * and `/usr/bin/env` is not a machine-specific reference. Narrow on purpose
 * — a detector that also flagged those would be arguing with correct
 * commands, and arguing checks get switched off.
 */
export const MACHINE_PATH = /\/(?:Users|home)\/[A-Za-z0-9_.-]+\/[^\s"'`)]*/g;

/** What to write instead, in the order a command should prefer them. */
export const PORTABLE_FORMS = [
  "a path relative to the project root — evidence commands already run with cwd set to it",
  "$HARNESS_ROOT for a file in the harness, which gates/run-gate.ts resolves",
] as const;

export function machinePathsIn(command: string): string[] {
  return [...new Set(command.match(MACHINE_PATH) ?? [])];
}

/**
 * The gate's refusal. One exported function, so the mutation is a
 * measurement rather than a claim in a PR (#338 SC-3).
 *
 * Returns [] when nothing was measured — an AC with no command, or a state
 * with no ACs. That is not a fail-open: `all-acs-have-evidence` is the check
 * that refuses a missing command, and duplicating its judgement here would
 * mean two checks disagreeing about one fact.
 */
export function evidencePortabilityViolations(acs: unknown): string[] {
  if (!Array.isArray(acs)) return [];
  const out: string[] = [];
  for (const raw of acs) {
    const ac = raw as EvidenceAc;
    const command = ac?.evidenceMethod?.command;
    // No `command.trim() === ""` branch: a mutation removing it scored 0 red,
    // because an empty command yields no paths anyway. A branch no input can
    // distinguish is a branch no test can cover, and keeping it would mean
    // one line of this function was permanently unverifiable.
    if (typeof command !== "string") continue;
    const found = machinePathsIn(command);
    if (found.length === 0) continue;
    const id = typeof ac?.id === "string" ? ac.id : "an AC";
    out.push(
      `${id}: the evidence command hardcodes ${found.length === 1 ? "a path" : "paths"} into ` +
        `a developer's home directory — ${found.join(", ")}. It cannot run in CI or on ` +
        `another machine, so the evidence reproduces nowhere but here. Use ` +
        `${PORTABLE_FORMS.join(", or ")}.`,
    );
  }
  return out;
}
