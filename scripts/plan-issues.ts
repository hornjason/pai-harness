#!/usr/bin/env bun
/**
 * Apply an approved repair plan to the tracker (#1647).
 *
 * `--repair <plan.md>` reads a table somebody reviewed — today
 * `docs/adr/ADR-005-backlog-criterion-repair.md` — and does the two things
 * `.github/ISSUE_TEMPLATE/spec-work.yml` says in its own footer that a GitHub
 * issue form cannot do: name the criteria an issue serves in a shape every
 * reader can find, and move an issue out of a milestone it does not belong in.
 *
 * ## It reports by default and writes only when told
 *
 * No `--write`, no mutation.
 *
 * ## A demotion removes that issue's edges, and ONLY that issue's
 *
 * `plan-deps` never removes an edge — the rule protects the two hand-authored
 * within-phase dependencies no derivation can reproduce. But an issue leaving
 * its phase orphans every edge it had: on 2026-10-29 #1395 and #1643 each
 * carried 3 blockers and BLOCKED all six Phase 6 issues, so demoting them
 * without removing those 18 edges would leave Phase 6 waiting forever on work
 * that is no longer in the plan — the order silently wrong in the direction
 * nothing can see.
 *
 * A general prune cannot fix that, because nothing distinguishes a
 * hand-authored edge from an orphaned one by inspection. So the removal is
 * **scoped to the demotion that causes it**: this removes the edges of the
 * issues it is itself demoting, and touches no others. The cause and the
 * cleanup are one action.
 */
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { parseArgs } from "util";
import { alreadyAnnotated, annotatedBody, parseRepairPlan } from "../lib/issue-repair";
import type { RepairRow } from "../lib/issue-repair";

/**
 * THE one non-zero exit. One site, so `test/plan-issues.test.ts` can build a
 * mutant with it set to `0` (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

export interface IssueState {
  number: number;
  body: string;
  milestone: string | null;
  /** Issues that block this one. */
  blockedBy: number[];
  /** Issues this one blocks. */
  blocking: number[];
}

export interface PlanIssuesGitHub {
  readIssue: (repo: string, number: number) => Promise<IssueState>;
  setBody: (repo: string, number: number, body: string) => Promise<void>;
  clearMilestone: (repo: string, number: number) => Promise<void>;
  removeBlockedBy: (repo: string, blocked: number, blocker: number) => Promise<void>;
}

function gh(args: readonly string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], { env });
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr).trim().slice(0, 300));
  return new TextDecoder().decode(proc.stdout);
}

const LIVE_GITHUB: PlanIssuesGitHub = {
  readIssue: async (repo, number) => {
    const j = JSON.parse(
      gh(["issue", "view", String(number), "--repo", repo, "--json", "number,body,milestone"]),
    ) as { number: number; body: string | null; milestone: { title: string } | null };
    const dep = (kind: "blocked_by" | "blocking"): number[] => {
      try {
        return (
          JSON.parse(gh(["api", `repos/${repo}/issues/${number}/dependencies/${kind}`])) as {
            number: number;
          }[]
        ).map(d => d.number);
      } catch {
        // A read that failed is not an issue with no edges. Rethrow: a silent
        // [] here would make a demotion skip the cleanup it exists to do.
        throw new Error(`could not read ${kind} for #${number}`);
      }
    };
    return {
      number: j.number,
      body: j.body ?? "",
      milestone: j.milestone?.title ?? null,
      blockedBy: dep("blocked_by"),
      blocking: dep("blocking"),
    };
  },
  setBody: async (repo, number, body) => {
    const f = join("/tmp", `rg-body-${number}-${process.pid}.md`);
    Bun.write(f, body);
    gh(["issue", "edit", String(number), "--repo", repo, "--body-file", f]);
  },
  clearMilestone: async (repo, number) => {
    gh(["issue", "edit", String(number), "--repo", repo, "--remove-milestone"]);
  },
  removeBlockedBy: async (repo, blocked, blocker) => {
    gh(["issue", "edit", String(blocked), "--repo", repo, "--remove-blocked-by", String(blocker)]);
  },
};

const USAGE = `rungate plan-issues --repair <plan.md> --repo <owner/name> [--write] [--json]

  --repair   the approved plan. A table of
             | Issue | Phase | Repair | Criteria | Confidence | Why |
             where Repair is (a) annotate or (b) demote.
  --repo     owner/name. Defaults to $GITHUB_REPOSITORY.
  --write    apply it. Without this nothing is mutated.
  --json     the whole reading.`;

/** What one row would do, resolved against the issue's live state. */
interface Action {
  row: RepairRow;
  kind: "annotate" | "demote" | "unchanged";
  body?: string;
  /** For a demotion: every edge the demotion orphans. */
  edges: { blocked: number; blocker: number }[];
  note: string;
}

export async function main(argv: string[], gh2: PlanIssuesGitHub = LIVE_GITHUB): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repair: { type: "string" },
        repo: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`plan-issues: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const { values } = parsed;
  if (!values.repair) {
    console.error(`plan-issues: --repair <plan.md> is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(`plan-issues: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const root = values["project-root"] ?? process.cwd();
  const planPath = isAbsolute(values.repair) ? values.repair : join(root, values.repair);
  if (!existsSync(planPath)) {
    console.error(`plan-issues: no such plan: ${planPath}`);
    return REFUSAL_EXIT;
  }

  const reading = parseRepairPlan(readFileSync(planPath, "utf-8"));

  // The refusal, decided BEFORE anything is written and read by every path.
  const refuseWrite = reading.reading === "UNMEASURED";

  if (refuseWrite && !values.json) {
    console.error(`plan-issues: UNMEASURED — the repair plan could not be read:`);
    for (const r of reading.unmeasuredReasons) console.error(`  - ${r}`);
    for (const r of reading.rejected) console.error(`  line ${r.line}: ${r.why}\n    ${r.text}`);
    return REFUSAL_EXIT;
  }

  const actions: Action[] = [];
  for (const row of reading.rows) {
    const live = await gh2.readIssue(repo, row.issue);
    if (row.kind === "annotate") {
      if (alreadyAnnotated(live.body, row.criteria)) {
        actions.push({ row, kind: "unchanged", edges: [], note: `already names ${row.criteria.join(", ")}` });
        continue;
      }
      actions.push({
        row,
        kind: "annotate",
        body: annotatedBody(live.body, row.criteria),
        edges: [],
        note: `+ ${row.criteria.join(", ")}`,
      });
      continue;
    }
    if (live.milestone === null) {
      actions.push({ row, kind: "unchanged", edges: [], note: "already carries no milestone" });
      continue;
    }
    actions.push({
      row,
      kind: "demote",
      edges: [
        ...live.blockedBy.map(b => ({ blocked: live.number, blocker: b })),
        ...live.blocking.map(b => ({ blocked: b, blocker: live.number })),
      ],
      note: `drop "${live.milestone}"`,
    });
  }

  if (values.json) {
    const wrote = !values.write ? "not-requested" : refuseWrite ? "refused" : "yes";
    console.log(JSON.stringify({ ...reading, actions, wrote }, null, 2));
    if (values.write && !refuseWrite) await apply(gh2, repo, actions);
    return refuseWrite ? REFUSAL_EXIT : 0;
  }

  const edges = actions.reduce((n, a) => n + a.edges.length, 0);
  console.log(`${values.repair} — ${reading.rows.length} row(s)\n`);
  console.log(`ACTIONS`);
  for (const a of actions) {
    const mark = { annotate: "ANNOTATE", demote: "DEMOTE  ", unchanged: "ok      " }[a.kind];
    console.log(`  ${mark}  #${a.row.issue}  ${a.note}`);
    if (a.edges.length > 0) {
      console.log(`            and remove ${a.edges.length} edge(s) the demotion orphans:`);
      for (const e of a.edges) console.log(`              #${e.blocked} blocked by #${e.blocker}`);
    }
  }
  console.log(
    `\n  ${actions.filter(a => a.kind === "annotate").length} annotate, ` +
      `${actions.filter(a => a.kind === "demote").length} demote, ` +
      `${actions.filter(a => a.kind === "unchanged").length} already correct, ${edges} edge(s) to remove`,
  );

  if (!values.write) {
    console.log(`\nNothing written. Re-run with --write to apply.`);
    return 0;
  }
  console.log(`\nWRITING`);
  for (const line of await apply(gh2, repo, actions)) console.log(`  ${line}`);
  console.log(`\n  Re-run \`rungate plan-deps --repo ${repo}\` — a demotion changes the phase sizes.`);
  return 0;
}

/**
 * The ONE write site, called by both output paths.
 *
 * The edge removal runs BEFORE the milestone is cleared. If it ran after and
 * then failed, the issue would already be out of its phase and nothing — not
 * this command on a re-run, not `plan-deps` — would still know which edges
 * the demotion had orphaned.
 */
async function apply(gh2: PlanIssuesGitHub, repo: string, actions: readonly Action[]): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    try {
      if (a.kind === "annotate") {
        await gh2.setBody(repo, a.row.issue, a.body!);
        done.push(`annotated #${a.row.issue}  ${a.row.criteria.join(", ")}`);
      } else if (a.kind === "demote") {
        for (const e of a.edges) await gh2.removeBlockedBy(repo, e.blocked, e.blocker);
        await gh2.clearMilestone(repo, a.row.issue);
        done.push(`demoted   #${a.row.issue}  and removed ${a.edges.length} edge(s)`);
      }
    } catch (e) {
      done.push(`FAILED    #${a.row.issue}: ${(e as Error).message}`);
    }
  }
  return done;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
