/**
 * Does the Marcus brief cover every AC the state declares? (ADR-009 C2, #700)
 *
 * This is the decision behind `brief-ac-alignment` in `gates/workflow.test.ts`,
 * lifted out so there is ONE binding to mutate and so the two refusals can be
 * driven directly instead of through a spawned gate.
 *
 * ## Why it moved (#700)
 *
 * The check failed on five consecutive pushes to `main` and nobody could say
 * which of its two branches fired. Both refusals were written inline, and
 * neither named the path it had resolved:
 *
 *     expect("marcus-brief.md missing").toBe("brief file required when Marcus spawned (ADR-009 C2)")
 *     expect(missingIds, `brief-ac-alignment: brief missing AC ids: ${...}`).toEqual([])
 *
 * `brief missing AC ids: AC-2` tells a reader WHICH id is absent and not
 * WHERE the check looked — and the path is the whole question here, because
 * it is assembled at call time from `RUNGATE_WORK_DIR`, a `$HOME/.rungate`
 * fallback and the state's slug. A reading that is wrong about its directory
 * and a brief that is genuinely short are the same sentence today.
 *
 * So every refusal names the resolved path. One interpolated string, and it
 * converts "the brief is wrong" into "the brief at <this path> is wrong",
 * which is a claim somebody can check.
 *
 * ## The reading is total, and `NOT_APPLICABLE` is a state
 *
 * The inline version `return`ed in two places — no slug, and an absent brief
 * with Marcus not spawned — which made "the check decided nothing was wrong"
 * and "the check declined to look" the same observation from outside. They
 * are different, so they are different readings. `0`, `{}` and silence are
 * indistinguishable from success (`.claude/rules/config-access.md`).
 */

export type BriefAlignmentReading =
  | "ALIGNED"
  | "BRIEF_ABSENT"
  | "IDS_MISSING"
  | "NOT_APPLICABLE";

export interface BriefAlignment {
  reading: BriefAlignmentReading;
  /** The path the check resolved, always — including when it found nothing there. */
  briefPath: string;
  /** AC ids the brief does not name. Empty under every reading but `IDS_MISSING`. */
  missingIds: string[];
  /** Why this is a refusal, naming the path. `null` when it is not one. */
  refusal: string | null;
  /** Why the check declined to look. `null` unless the reading is `NOT_APPLICABLE`. */
  declined: string | null;
}

export interface BriefAlignmentInput {
  /** The resolved path, composed by the caller so this function reads no env. */
  briefPath: string;
  briefExists: boolean;
  /** The brief's text. Ignored when `briefExists` is false. */
  briefText: string;
  acIds: string[];
  marcusSpawned: boolean;
}

export function briefAcAlignment(input: BriefAlignmentInput): BriefAlignment {
  const { briefPath, briefExists, briefText, acIds, marcusSpawned } = input;
  const base = { briefPath, missingIds: [] as string[], refusal: null, declined: null };

  if (!briefExists) {
    // An absent brief is only a refusal when something was supposed to write
    // one. With Marcus never spawned there is no brief to be missing, and
    // calling that a pass would be the same substitution one level down.
    if (!marcusSpawned) {
      return {
        ...base,
        reading: "NOT_APPLICABLE",
        declined:
          `brief-ac-alignment: no brief at ${briefPath}, and Marcus was not spawned — ` +
          "nothing was expected to write one, so this is UNMEASURED rather than a pass",
      };
    }
    return {
      ...base,
      reading: "BRIEF_ABSENT",
      refusal:
        `brief-ac-alignment: Marcus was spawned but no brief exists at ${briefPath} ` +
        "(ADR-009 C2). The path is resolved from RUNGATE_WORK_DIR, or $HOME/.rungate " +
        "when that is unset, plus the state's slug — so a wrong directory and a " +
        "missing file look the same from here. Check the path before the file.",
    };
  }

  const missingIds = acIds.filter(id => !briefText.includes(id));
  if (missingIds.length === 0) return { ...base, reading: "ALIGNED" };

  return {
    ...base,
    reading: "IDS_MISSING",
    missingIds,
    refusal:
      `brief-ac-alignment: the brief at ${briefPath} does not name ` +
      `${missingIds.join(", ")} (ADR-009 C2). It exists and was read, so this is ` +
      "the brief's content and not the resolved path.",
  };
}
