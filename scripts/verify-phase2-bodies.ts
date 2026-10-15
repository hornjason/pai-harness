#!/usr/bin/env bun
/**
 * Check that every Phase 2 issue a decompose step created carries the ACs it
 * was given (#79).
 *
 * The decompose agent returns a structured `{number, phase, acIds}` list and
 * separately writes each sub-issue's prose body. On #70 the two disagreed
 * completely and the disagreement deleted the defect that caused the original
 * bug report: #75's body described AC-7/8/9 as doc-path cleanup — a
 * restatement of AC-5, already in Phase 1 — while the ACs it actually carried
 * were about `roles.json` and `hooks.json` being written empty for every
 * greenfield consumer. Both halves were plausible. Nothing compared them.
 *
 * So this reads the issue back FROM GITHUB rather than trusting what the
 * agent reported writing. A body the agent says it wrote and a body the issue
 * has are different facts, and the one that matters is the one the next agent
 * will read.
 *
 * Usage:
 *   bun scripts/verify-phase2-bodies.ts --repo owner/name --plan <file.json>
 *
 * The plan file is written by the harness, not composed by the model:
 *   { "phase1AcIds": ["AC-1"],
 *     "acs": [{ "id": "AC-7", "statement": "…", "specElement": "SC-12" }],
 *     "subIssues": [{ "number": 75, "phase": "Phase 2", "acIds": ["AC-7"] }] }
 *
 * stdout carries one machine-readable receipt line; everything human goes to
 * stderr. Exits non-zero on any violation.
 */

import { readFileSync } from "fs";

import {
  acsForGroup,
  decompositionRefusal,
  phase2BodyViolations,
  type DecomposedAc,
  type SubIssuePlan,
} from "../lib/phase2-decomposition";
import { createGitHubClient, getIssue } from "../lib/github";

/**
 * The ONE exit code every refusal routes through.
 *
 * Declared once and asserted to appear once, so the mutation that proves this
 * script can fail — setting it to 0 — cannot be bypassed by an inlined
 * `process.exit(1)` somewhere else. See
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export const REFUSE_EXIT = 1;

export interface Phase2Plan {
  phase1AcIds?: string[];
  acs?: DecomposedAc[];
  subIssues?: SubIssuePlan[];
}

export interface Phase2Verdict {
  ok: boolean;
  checked: number;
  violations: string[];
}

/** Fetch one issue body. Injected so the comparison is testable without a network. */
export type BodyReader = (issue: number) => Promise<string | null>;

export async function verifyPhase2(plan: Phase2Plan, readBody: BodyReader): Promise<Phase2Verdict> {
  const acs = plan.acs ?? [];
  const subIssues = plan.subIssues ?? [];
  const violations = [...decompositionRefusal(acs, plan.phase1AcIds ?? [], subIssues)];

  let checked = 0;
  for (const group of subIssues) {
    if (typeof group?.number !== "number") {
      // A group with no number is a sub-issue that was never created. Silence
      // here would be the #79 defect with the body omitted entirely.
      violations.push(`${group?.phase || "a group"} has no issue number — it was never created`);
      continue;
    }
    let body: string | null;
    try {
      body = await readBody(group.number);
    } catch (e) {
      // NOT a pass. An unreadable issue is unmeasured, and unmeasured is not
      // clean — the whole point of reading the artifact back.
      violations.push(`#${group.number} could not be read back: ${(e as Error).message}`);
      continue;
    }
    checked++;
    for (const v of phase2BodyViolations(body, acsForGroup(acs, group))) {
      violations.push(`#${group.number}: ${v}`);
    }
  }

  return { ok: violations.length === 0, checked, violations };
}

function readJson(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`${path} is not an object`);
  return parsed;
}

export function readPlan(path: string): Phase2Plan {
  return readJson(path) as Phase2Plan;
}

/**
 * The two-file form the workflow uses.
 *
 * The ACs and the grouping come from DIFFERENT authors and are kept in
 * different files for that reason: the harness writes `acs` from its own
 * validated discovery output, and the agent writes `grouping` because the
 * grouping is the judgement it was asked for. Merging them into one file the
 * agent writes would put the comparison's reference side through the model,
 * and a model that reworded both the body and the thing it is compared
 * against would pass.
 */
export function readSplitPlan(acsPath: string, groupingPath: string): Phase2Plan {
  const acs = readJson(acsPath);
  if (!Array.isArray(acs)) throw new Error(`${acsPath} is not an array of ACs`);
  const grouping = readJson(groupingPath) as Phase2Plan;
  return {
    acs: acs as DecomposedAc[],
    phase1AcIds: grouping.phase1AcIds ?? [],
    subIssues: grouping.subIssues ?? [],
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = flag("repo");
  const planPath = flag("plan");
  const acsPath = flag("acs");
  const groupingPath = flag("grouping");
  if (!repo || !(planPath || (acsPath && groupingPath))) {
    console.error(
      "usage: bun scripts/verify-phase2-bodies.ts --repo owner/name " +
        "(--plan <file.json> | --acs <file.json> --grouping <file.json>)",
    );
    process.exit(2);
  }

  let verdict: Phase2Verdict;
  try {
    // The plan is read BEFORE the client is built. A malformed plan is a
    // refusal this script can reach with no credentials at all, and ordering
    // it after the token check made every plan error report as a missing
    // token — the wrong cause, and one a caller would try to fix by exporting
    // a secret.
    const plan = planPath ? readPlan(planPath) : readSplitPlan(acsPath!, groupingPath!);
    const client = createGitHubClient();
    verdict = await verifyPhase2(plan, async (issue) => {
      const data = await getIssue(client, repo, issue);
      return data.body ?? null;
    });
  } catch (e) {
    console.error(`verify-phase2-bodies: ${(e as Error).message}`);
    console.log(JSON.stringify({ ok: false, checked: 0, violations: [(e as Error).message] }));
    process.exit(REFUSE_EXIT);
  }

  for (const v of verdict.violations) console.error(`PHASE2_BODY_MISMATCH: ${v}`);
  console.log(JSON.stringify(verdict));
  if (!verdict.ok) {
    console.error(
      `\nverify-phase2-bodies: ${verdict.violations.length} violation(s) across ${verdict.checked} issue(s). ` +
        `A deferral whose body describes different work than the ACs it carries is scope loss that looks ` +
        `complete — fix the issue body, do not re-run (#79).`,
    );
    process.exit(REFUSE_EXIT);
  }
  console.error(`verify-phase2-bodies: ${verdict.checked} issue(s) carry their ACs verbatim`);
}
