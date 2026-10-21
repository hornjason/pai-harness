/**
 * workflow-drift.ts — the consumer-facing reading of #722's census.
 *
 * #722 built `workflowCensus`, which can tell a generated workflow nobody has
 * touched from one somebody hand-edited, and the stamp it reads has been on
 * disk in consumer repos ever since. Nothing a consumer runs ever asked it
 * (#915). So a hand-edit to a generated `ci.yml`, `gates.yml` or
 * `ai-review.yml` was stamped, mechanically detectable, and undetected: the
 * symptom somebody "fixed" by editing the workflow disappears, the generator
 * keeps shipping the unfixed version, and the next `bunx rungate scaffold .`
 * reverts the edit. Nothing reds at any point in that sequence.
 *
 * This module turns the census into a verdict. `lib/conformity.ts` wraps it
 * as `runWorkflowDriftValidation`; the census itself is unchanged.
 *
 * ## Why a hand-edit is not automatically drift (#839, #917)
 *
 * `ci.workflowOverrides` lets a consumer name top-level keys they have taken
 * back from the generator. `mergeManagedWorkflow` leaves a declined key
 * exactly as they wrote it and writes a notice into the file saying which
 * config key declined it. An edit inside such a key is **not** reverted by a
 * re-scaffold, so reporting it as drift would be reporting the escape hatch
 * as a defect — and a check that reds on the supported way to deviate is a
 * check somebody deletes.
 *
 * The stamp covers the WHOLE body, so it can say the bytes moved and cannot
 * say where. That is the honest limit of this reading and it is why there are
 * three outcomes rather than two:
 *
 *   hand-edited, no key in this file is the consumer's → DRIFTED. Every byte
 *     is the generator's, so the next scaffold reverts the edit.
 *   hand-edited, some key in this file IS the consumer's → UNMEASURED, with
 *     the keys named. The edit may be inside one of them or outside it, and
 *     a whole-body digest cannot tell. Reported loudly rather than waved
 *     through: `.claude/rules/config-access.md` — a silent pass here is
 *     Silent Default Substitution with the file on the consumer's side.
 *   NOT-OWNED → passing, and NAMED (#722 AC-3). A consumer's own workflows
 *     are theirs; "5 unowned workflows" sends nobody anywhere.
 *
 * ## Why zero files is not agreement
 *
 * A census over an empty `.github/workflows/` is MEASURED with no findings,
 * which renders exactly like a repo whose three generated workflows are all
 * untouched. That is #621's shape — N things agreeing vacuously — so a
 * reading with nothing stamped in it to compare is UNMEASURED and says which
 * of the two it is.
 */
import { readFileSync } from "fs";
import { join } from "path";

import { topLevelKeyOrder } from "./managed-workflow";
import { workflowCensus } from "./workflow-census";

export interface WorkflowDriftFinding {
  /** File name within `.github/workflows`, e.g. `ai-review.yml`. */
  name: string;
  /** Why this verdict, in the reading's own words. */
  detail: string;
}

export interface WorkflowDriftReading {
  reading: "MEASURED" | "UNMEASURED";
  /** Named causes. Empty exactly when `reading` is MEASURED. */
  unmeasuredReasons: string[];
  /** Hand-edited, and nothing in the file is the consumer's. The refusal. */
  drifted: WorkflowDriftFinding[];
  /** Hand-edited, and the consumer has declared part of this file theirs. */
  consumerOwned: WorkflowDriftFinding[];
  /** NOT-OWNED names, individually. Passing. */
  notOwned: string[];
  /**
   * How much of the subject was read, and how much of what was read this
   * check is even about. `read < present` is a partial scan; `generated === 0`
   * is a scan with nothing to compare, which is not the same as a clean one.
   */
  coverage: { read: number; present: number; generated: number };
}

/**
 * Read `.github/workflows/` and say whether a generated workflow has moved.
 *
 * `overrides` is `ci.workflowOverrides` as `workflowOverrides()` reads it —
 * passed in rather than loaded here, so the config reader stays the one
 * binding `.claude/rules/config-access.md` requires and this module stays
 * free of a config path of its own.
 *
 * One exported reading, so there is one thing to mutate, and `reading` is
 * derived here and nowhere else.
 */
export function workflowDrift(root: string, overrides: readonly string[] = []): WorkflowDriftReading {
  const dir = join(root, ".github", "workflows");
  const census = workflowCensus(root);
  const reasons = [...census.unmeasuredReasons];

  const generated = census.files.filter(f => f.status !== "NOT-OWNED");
  if (census.coverage.present === 0) {
    reasons.push(
      `NO_WORKFLOW_FILES: ${dir} holds no workflow files — zero files agreeing is not agreement`,
    );
  } else if (generated.length === 0) {
    reasons.push(
      `NO_GENERATED_WORKFLOW: read ${census.coverage.read} file(s) in ${dir} and none carries a ` +
        `harness provenance marker — there is nothing for a drift check to compare. ` +
        `Run \`bunx rungate scaffold .\` if this project is meant to have generated CI`,
    );
  }

  const drifted: WorkflowDriftFinding[] = [];
  const consumerOwned: WorkflowDriftFinding[] = [];

  for (const file of generated) {
    if (file.status !== "generated-and-hand-edited") continue;

    let claimed: string[];
    try {
      claimed = consumerKeysIn(readFileSync(join(dir, file.name), "utf-8"), overrides);
    } catch (e) {
      // The census read this file a moment ago. A failure here is not "no
      // keys are claimed" — that is a claim about bytes nobody read.
      reasons.push(`UNREADABLE_WORKFLOW: ${file.name} — ${(e as Error).message}`);
      continue;
    }

    if (claimed.length === 0) {
      drifted.push({
        name: file.name,
        detail:
          `${file.detail}. No top-level key in this file is declared the consumer's, so ` +
          `\`bunx rungate scaffold .\` will overwrite the edit. Make the change in the ` +
          `generator, or name the key in \`ci.workflowOverrides\` to keep it`,
      });
      continue;
    }

    consumerOwned.push({
      name: file.name,
      detail:
        `${file.detail}, and ${claimed.join(", ")} ${claimed.length === 1 ? "is" : "are"} ` +
        `declared the consumer's through \`ci.workflowOverrides\`. The provenance marker ` +
        `digests the whole file, so it cannot say whether the edit landed inside a declared ` +
        `key or outside one — UNMEASURED, not clean`,
    });
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    drifted,
    consumerOwned,
    notOwned: census.notOwned,
    coverage: { read: census.coverage.read, present: census.coverage.present, generated: generated.length },
  };
}

/**
 * The top-level keys of one workflow that are the consumer's, not the
 * generator's.
 *
 * One source: `ci.workflowOverrides`, intersected with the keys this file
 * actually declares. The config is global and the question is per-file — a
 * project declining `concurrency` has said nothing about a workflow that has
 * no `concurrency:` in it, and treating the decline as covering that file
 * would blind the check to every edit in it.
 *
 * ## Why the file's own override notices are NOT a second source (#958)
 *
 * They were, until #958: the notices `mergeManagedWorkflow` writes were read
 * back and unioned in, with no reference to the config. A notice is a comment
 * anybody can type, so that made the file under inspection the authority on
 * its own exemption — paste one line into a hand-edited workflow and DRIFTED
 * became consumerOwned. #530's shape: the artifact everyone reaches for as
 * ground truth, which always agrees.
 *
 * #928 reasoned the notice source from #722's "ownership travels with the
 * bytes". The analogy does not hold. `generated-sha:` is a digest OF the
 * body — it cannot be written to say something the bytes do not; a notice
 * carries no such binding.
 *
 * Nor does the case it was built for survive inspection. The justification
 * was "a consumer who removed the key from the config but has not
 * re-scaffolded still has a file whose bytes were authored under the
 * decline." That is backwards: if the key is gone from the config the next
 * scaffold RE-MERGES it, so the edit will be reverted — which is precisely
 * what DRIFTED means. The config decides what the next scaffold does, and it
 * is the only authority this reading should have.
 *
 * Hardening the notice branch rather than deleting it — accept a notice key
 * only when the config names it too — is behaviourally identical to this,
 * because the union then collapses to `{config ∩ declared}`. Same verdicts,
 * one less branch, and one less thing a consumer can write.
 */
function consumerKeysIn(text: string, overrides: readonly string[]): string[] {
  const declared = new Set(topLevelKeyOrder(text));
  return overrides.filter(k => declared.has(k));
}

/**
 * Render the reading as report lines.
 *
 * NOT-OWNED files are named one per line rather than counted, and the
 * coverage figure is in the first line, for the reasons `censusReport` gives:
 * `3/12` and `12/12` are the same verdict and no reader can tell them apart
 * from the output.
 */
export function workflowDriftReport(reading: WorkflowDriftReading): string[] {
  const { read, present, generated } = reading.coverage;
  const out: string[] = [
    `WORKFLOW DRIFT: ${reading.reading} — read ${read}/${present} file(s), ${generated} generated`,
  ];
  for (const reason of reading.unmeasuredReasons) out.push(`  UNMEASURED: ${reason}`);
  for (const f of reading.drifted) out.push(`  DRIFTED: ${f.name} — ${f.detail}`);
  for (const f of reading.consumerOwned) out.push(`  UNMEASURED: ${f.name} — ${f.detail}`);
  if (reading.notOwned.length > 0) {
    out.push(`  NOT-OWNED, and not this check's business: ${reading.notOwned.join(", ")}`);
  }
  return out;
}
