/**
 * workflow-census.ts — what is in `.github/workflows/`, and who wrote it.
 *
 * The harness owns the `test` job in `ci.yml` and the `gates` job in
 * `gates.yml`. It has never owned a workflow FILE, and the owned-path list in
 * `.claude/rules/harness-managed.md` is a list of files the generator writes —
 * so a file the generator did not write could not be added to it without the
 * generator then producing it, and was therefore invisible (#722). A consumer
 * with rungate scaffolded into it ran five gh-aw workflows that cost money,
 * failed on quota and emailed its owner, and every scaffold run reported clean.
 *
 * Ownership here is a property of the BYTES, not of a list in another file.
 * `.claude/rules/*.md` have worked this way since #370: the generator stamps a
 * digest of what it wrote, and the next run asks the file itself. The marker
 * is a YAML comment, so it is invisible to anything that parses the workflow
 * and visible to anything that reads the text.
 *
 *   marker present, digest matches the body  → generated-and-unchanged
 *   marker present, digest does not match    → generated-and-hand-edited
 *   no marker                                → NOT-OWNED
 *
 * ## Why `reading` is a field
 *
 * A directory that could not be read yields zero NOT-OWNED files. So does a
 * directory in which every file is owned. Those are the same output and
 * opposite facts, and a caller inferring "clean" from an empty array gets the
 * #646 failure: the answer and the absence of an answer are byte-identical.
 * `0`, `{}`, `null` and silence are indistinguishable from success;
 * `UNMEASURED` is not.
 *
 * ## Why the coverage figure is rendered, not just returned
 *
 * `36/426` and `426/426` are the same PASS today — #492. A verdict that does
 * not state how much of its subject it read cannot be told from a complete
 * one by anybody downstream, so `read/present` goes in the line itself.
 *
 * This module REPORTS. It does not delete, rewrite or refuse anything in a
 * consumer tree: what a consumer does with a NOT-OWNED workflow is theirs.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { lineCommentProvenance } from "./owned-files";

// ── The marker ──────────────────────────────────────────

const YAML_COMMENT = lineCommentProvenance("#");

/** Stamp a generated workflow so the next run can recognise its own output. */
export const stampWorkflow = YAML_COMMENT.stamp;

/** The digest a workflow file declares, or null if it carries no marker. */
export const workflowMarker = YAML_COMMENT.declared;

/** The digest the file's body actually hashes to. */
export const workflowBodySha = YAML_COMMENT.sha;

/**
 * The workflow without its provenance marker (#767).
 *
 * The marker is harness bookkeeping, and `resolveManagedWrite` treats every
 * line outside a job as the consumer's. Those two facts met in #722 and the
 * merge began refusing its own first line — *"1 line(s) the harness did not
 * author would be dropped from content outside any job"* — so a generator
 * change could not land on any workflow holding a preserved job.
 */
export const workflowBody = YAML_COMMENT.body;

// ── The reading ─────────────────────────────────────────

export type WorkflowStatus =
  /** The harness wrote it and nobody has touched it since. */
  | "generated-and-unchanged"
  /** The harness wrote it and the bytes have moved. Preserved, not rewritten. */
  | "generated-and-hand-edited"
  /** No marker: the harness did not write this and does not manage it. */
  | "NOT-OWNED";

export interface WorkflowFinding {
  /** File name within `.github/workflows`, e.g. `issue-triage.lock.yml`. */
  name: string;
  status: WorkflowStatus;
  /** Why this status, in the census's own words. */
  detail: string;
}

export interface WorkflowCensus {
  reading: "MEASURED" | "UNMEASURED";
  /** Named causes. Empty exactly when `reading` is MEASURED. */
  unmeasuredReasons: string[];
  files: WorkflowFinding[];
  /** Projection of `files` — NOT-OWNED names, individually (AC-3). */
  notOwned: string[];
  /** How much of the subject was read. `read < present` is a partial scan. */
  coverage: { read: number; present: number };
}

const WORKFLOW_EXT = /\.ya?ml$/i;

/**
 * Read `.github/workflows/` and classify every file in it.
 *
 * One exported function, so there is one binding to mutate, and `reading` is
 * derived here and nowhere else — a second boolean beside it would always
 * agree with it, and two deciders that agree are behaviourally one.
 */
export function workflowCensus(root: string): WorkflowCensus {
  const dir = join(root, ".github", "workflows");
  const reasons: string[] = [];

  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) {
      return census([`WORKFLOWS_DIR_ABSENT: ${dir} is not a directory`], [], 0);
    }
    entries = readdirSync(dir).filter(n => WORKFLOW_EXT.test(n)).sort();
  } catch (e) {
    // An absent directory is deliberately UNMEASURED rather than a measured
    // zero. Every scaffolded project has one — the generator creates it — so
    // its absence means this scan is looking somewhere the workflows are not,
    // which is exactly the reading #646 was about.
    const why = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? `WORKFLOWS_DIR_ABSENT: ${dir}`
      : `WORKFLOWS_DIR_UNREADABLE: ${dir} — ${(e as Error).message}`;
    return census([why], [], 0);
  }

  const files: WorkflowFinding[] = [];
  for (const name of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch (e) {
      // Not owned and not unowned: both are claims about bytes nobody read.
      reasons.push(`UNREADABLE_WORKFLOW: ${name} — ${(e as Error).message}`);
      continue;
    }
    files.push(classify(name, text));
  }

  return census(reasons, files, entries.length);
}

/**
 * The only place a `WorkflowCensus` is constructed.
 *
 * `reading`, `notOwned` and `coverage.read` are all PROJECTIONS of the two
 * inputs, derived here and nowhere else. The first draft of this module set
 * `reading` literally on the early-return path and computed it on the main
 * path — two deciders answering one question, which no behavioural test can
 * tell apart because they always agree
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). One
 * binding, so there is one thing to mutate.
 */
function census(reasons: string[], files: WorkflowFinding[], present: number): WorkflowCensus {
  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    files,
    notOwned: files.filter(f => f.status === "NOT-OWNED").map(f => f.name),
    coverage: { read: files.length, present },
  };
}

function classify(name: string, text: string): WorkflowFinding {
  const declared = workflowMarker(text);
  if (declared === null) {
    return {
      name,
      status: "NOT-OWNED",
      detail: "no harness provenance marker — rungate did not write this file",
    };
  }
  const actual = workflowBodySha(text);
  if (declared === actual) {
    return { name, status: "generated-and-unchanged", detail: "harness-written and untouched since" };
  }
  return {
    name,
    status: "generated-and-hand-edited",
    detail: `hand-edited since the harness wrote it (declared ${declared}, body ${actual})`,
  };
}

// ── The report ──────────────────────────────────────────

/**
 * Render the census as scaffold `actions[]` lines.
 *
 * NOT-OWNED files are named one per line rather than counted. "5 unowned
 * workflows" sends nobody anywhere; the five that cost a consumer money each
 * have a name, and the name is the whole of what makes the line actionable.
 */
export function censusReport(census: WorkflowCensus): string[] {
  const { read, present } = census.coverage;
  const out: string[] = [
    `WORKFLOWS: ${census.reading} — read ${read}/${present} file(s) in .github/workflows`,
  ];

  for (const reason of census.unmeasuredReasons) {
    out.push(`  UNMEASURED: ${reason}`);
  }

  for (const f of census.files) {
    if (f.status === "generated-and-unchanged") continue;
    out.push(`  ${f.status}: ${f.name} — ${f.detail}`);
  }

  if (census.notOwned.length > 0) {
    out.push(
      `  NOT-OWNED workflows run in this repo's CI and rungate does not manage them. ` +
        `Reported, not touched — what happens to them is yours: ${census.notOwned.join(", ")}`,
    );
  }

  return out;
}
