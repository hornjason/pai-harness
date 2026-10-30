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
import {
  CRITERIA_HEADING,
  alreadyAnnotated,
  annotatedBody,
  multiplyAnnotated,
  parseRepairPlan,
} from "../lib/issue-repair";
import type { RepairRow } from "../lib/issue-repair";
import { parseDecompositionPlan, planDecomposition } from "../lib/issue-decomposition";

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

/**
 * `gh`, with `GH_TOKEN` unset and an optional stdin payload.
 *
 * `stdin` exists so a body never touches the filesystem. The first version
 * wrote it to `join("/tmp", "rg-body-<n>-<pid>.md")` and handed `gh` the
 * path, which was wrong twice over and the security review caught both:
 *
 * - **A predictable name in a world-writable directory.** Anyone on the box
 *   can pre-create that path as a symlink and the write follows it. The pid
 *   is not a secret and the issue number is public.
 * - **`Bun.write` returns a promise and nothing awaited it**, while
 *   `Bun.spawnSync` read the file immediately. The content reaching `gh` was
 *   whatever had landed by then. It happened to be complete for all nine
 *   live issues — verified byte lengths afterwards, 2,593 to 5,733 — but
 *   that is luck, and a truncated body would have silently destroyed the
 *   measurements the repair exists to preserve.
 *
 * `--body-file -` reads standard input, so there is no file, no path to
 * race, and nothing to clean up.
 */
function gh(args: readonly string[], stdin?: string): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.GH_TOKEN;
  const proc = Bun.spawnSync(["gh", ...args], {
    env,
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
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
    gh(["issue", "edit", String(number), "--repo", repo, "--body-file", "-"], body);
  },
  clearMilestone: async (repo, number) => {
    gh(["issue", "edit", String(number), "--repo", repo, "--remove-milestone"]);
  },
  removeBlockedBy: async (repo, blocked, blocker) => {
    gh(["issue", "edit", String(blocked), "--repo", repo, "--remove-blocked-by", String(blocker)]);
  },
};

const USAGE = `rungate plan-issues (--repair | --decompose) <plan.md> --repo <owner/name> [--write] [--json]

  --repair     an approved repair plan. A table of
               | Issue | Phase | Repair | Criteria | Confidence | Why |
               where Repair is (a) annotate or (b) demote.
  --decompose  a decomposition plan — step 4 of ADR-003. A table of
               | Criterion | Outcome | Files | Milestone | Blocked by |
               where one row is one issue proving one criterion.
  --repo       owner/name. Defaults to $GITHUB_REPOSITORY.
  --write      apply it. Without this nothing is mutated.
  --json       the whole reading.`;

/** What creating issues from a plan needs. Injected so a test never shells out. */
export interface DecomposeGitHub {
  /** Title → number for every OPEN issue. The idempotence key. */
  openTitles: (repo: string) => Promise<Map<string, number>>;
  /** Milestone titles that exist. `plan-spec` makes them; this never does. */
  milestones: (repo: string) => Promise<Set<string>>;
  create: (
    repo: string,
    issue: { title: string; body: string; milestone: string | null },
  ) => Promise<number>;
  addBlockedBy: (repo: string, blocked: number, blocker: number) => Promise<void>;
}

const LIVE_DECOMPOSE: DecomposeGitHub = {
  /**
   * Every open issue, PAGINATED.
   *
   * `gh issue list --limit 1000` stops at a thousand and says nothing about
   * it, and this map is the idempotence key: a title past the cutoff reads as
   * "not created yet", so `--write` files a duplicate of an issue that
   * already exists. That is the module's own "a shorter list looks like a
   * clean plan" failure, arriving on the tracker-read side instead of the
   * plan-read side. Found by the AI review of this change.
   *
   * `--paginate` walks every page, and the REST issues endpoint returns pull
   * requests too, so anything carrying `pull_request` is dropped — a PR whose
   * title matched a row would otherwise read as the issue already existing
   * and skip creating it.
   */
  openTitles: async repo => {
    const out = gh([
      "api",
      "--paginate",
      `repos/${repo}/issues?state=open&per_page=100`,
      "--jq",
      ".[] | select(.pull_request == null) | [.number, .title] | @json",
    ]);
    const map = new Map<string, number>();
    for (const line of out.split("\n")) {
      if (line.trim() === "") continue;
      const [number, title] = JSON.parse(line) as [number, string];
      map.set(title, number);
    }
    return map;
  },
  milestones: async repo => {
    const rows = JSON.parse(gh(["api", `repos/${repo}/milestones?state=all&per_page=100`])) as {
      title: string;
    }[];
    return new Set(rows.map(m => m.title));
  },
  create: async (repo, issue) => {
    const args = ["issue", "create", "--repo", repo, "--title", issue.title, "--body-file", "-"];
    if (issue.milestone !== null) args.push("--milestone", issue.milestone);
    const url = gh(args, issue.body).trim();
    const n = Number(url.split("/").pop());
    // A URL whose last segment is not a number means `gh` printed something
    // else — a warning, a prompt — and treating NaN as an issue number would
    // wire every edge to nothing and report success.
    if (!Number.isInteger(n) || n <= 0) throw new Error(`created, but could not read a number from: ${url}`);
    return n;
  },
  addBlockedBy: async (repo, blocked, blocker) => {
    gh(["issue", "edit", String(blocked), "--repo", repo, "--add-blocked-by", String(blocker)]);
  },
};

/**
 * Step 4: create the issues a reviewed plan names, then wire their order.
 *
 * Two passes, and the order is the point: a row may be blocked by another row
 * in the same plan, which has no number until it exists. Creating and wiring
 * in one pass would silently drop every forward reference — AGENTS.md rule 4
 * says ordering is data, and an edge that was never written is not data.
 */
async function decompose(
  planPath: string,
  repo: string,
  write: boolean,
  json: boolean,
  api: DecomposeGitHub,
): Promise<number> {
  const reading = parseDecompositionPlan(readFileSync(planPath, "utf-8"));
  if (reading.reading === "UNMEASURED") {
    console.error(`plan-issues: UNMEASURED — the decomposition plan could not be read:`);
    for (const r of reading.unmeasuredReasons) console.error(`  - ${r}`);
    for (const r of reading.rejected) console.error(`  line ${r.line}: ${r.why}\n    ${r.text}`);
    return REFUSAL_EXIT;
  }

  const live = { openTitles: await api.openTitles(repo), milestones: await api.milestones(repo) };
  const planned = planDecomposition(reading.rows, live, planPath, CRITERIA_HEADING);
  if (planned.reading === "UNMEASURED") {
    console.error(`plan-issues: UNMEASURED — the plan does not fit the tracker:`);
    for (const r of planned.unmeasuredReasons) console.error(`  - ${r}`);
    return REFUSAL_EXIT;
  }

  /** Outcome → number, grown as issues are created, so pass two can resolve. */
  const numbers = new Map<string, number>();
  for (const a of planned.actions) if (a.kind === "exists") numbers.set(a.row.outcome, a.number);

  const created: { title: string; number: number }[] = [];
  const failed: string[] = [];
  if (write) {
    for (const a of planned.actions) {
      if (a.kind !== "create") continue;
      try {
        const n = await api.create(repo, { title: a.title, body: a.body, milestone: a.row.milestone });
        numbers.set(a.row.outcome, n);
        created.push({ title: a.title, number: n });
      } catch (e) {
        failed.push(`${a.title}: ${(e as Error).message}`);
      }
    }
  }

  const edges: string[] = [];
  if (write) {
    for (const e of planned.edges) {
      const blocked = numbers.get(e.blocked);
      const blocker = /^#(\d+)$/.exec(e.blocker) ? Number(e.blocker.slice(1)) : numbers.get(e.blocker);
      if (blocked === undefined || blocker === undefined) {
        // One end was never created, because its creation failed above. Say
        // so: a missing edge that nothing reports is an order silently lost.
        failed.push(`edge "${e.blocked}" blocked by "${e.blocker}": one end does not exist`);
        continue;
      }
      try {
        await api.addBlockedBy(repo, blocked, blocker);
        edges.push(`#${blocked} blocked by #${blocker}`);
      } catch (err) {
        failed.push(`edge #${blocked} blocked by #${blocker}: ${(err as Error).message}`);
      }
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          reading: "MEASURED",
          plan: planPath,
          wouldCreate: planned.actions.filter(a => a.kind === "create").length,
          alreadyOpen: planned.actions.filter(a => a.kind === "exists").length,
          wrote: write,
          created,
          edges,
          failed,
        },
        null,
        2,
      ),
    );
    return failed.length > 0 ? REFUSAL_EXIT : 0;
  }

  for (const a of planned.actions) {
    if (a.kind === "exists") console.log(`  open    #${a.number}  ${a.row.outcome}`);
    else console.log(`  create  ${a.row.criterion.padEnd(8)}  ${a.title}`);
  }
  for (const e of planned.edges) console.log(`  order   "${e.blocked}" blocked by "${e.blocker}"`);
  if (!write) {
    console.log(`\nNothing written. Re-run with --write to apply.`);
    return 0;
  }
  console.log(`\nCreated ${created.length}, wired ${edges.length} edge(s).`);
  for (const f of failed) console.error(`  FAILED: ${f}`);
  return failed.length > 0 ? REFUSAL_EXIT : 0;
}

/** What one row would do, resolved against the issue's live state. */
interface Action {
  row: RepairRow;
  kind: "annotate" | "demote" | "unchanged" | "refused";
  body?: string;
  /** For a demotion: every edge the demotion orphans. */
  edges: { blocked: number; blocker: number }[];
  note: string;
}

export async function main(
  argv: string[],
  gh2: PlanIssuesGitHub = LIVE_GITHUB,
  gh3: DecomposeGitHub = LIVE_DECOMPOSE,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repair: { type: "string" },
        decompose: { type: "string" },
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
  // Both would mean two plans in one run, and the second would be applied
  // against a tracker the first had already moved. One or the other.
  if (values.repair && values.decompose) {
    console.error(`plan-issues: --repair and --decompose are two different plans — pass one\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const given = values.repair ?? values.decompose;
  if (!given) {
    console.error(`plan-issues: --repair <plan.md> or --decompose <plan.md> is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(`plan-issues: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const root = values["project-root"] ?? process.cwd();
  const planPath = isAbsolute(given) ? given : join(root, given);
  if (!existsSync(planPath)) {
    console.error(`plan-issues: no such plan: ${planPath}`);
    return REFUSAL_EXIT;
  }
  if (values.decompose) {
    return await decompose(planPath, repo, values.write, values.json, gh3);
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
      // Two sections means editing the first is a guess, and the second keeps
      // whatever stale ids it holds. Refuse the row by name.
      if (multiplyAnnotated(live.body)) {
        actions.push({
          row,
          kind: "refused",
          edges: [],
          note: `body carries "${CRITERIA_HEADING}" more than once — resolve it by hand`,
        });
        continue;
      }
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
    // Apply FIRST, then report what happened. The first version printed
    // `"wrote": "yes"` and only then called apply(), whose per-action catch
    // swallowed every failure into a string nothing read — so a run that
    // failed on all eleven rows emitted "yes" and exited 0. Fail-open status
    // reporting, caught by the security review of this PR.
    const results = values.write && !refuseWrite ? await apply(gh2, repo, actions) : [];
    const failures = results.filter(r => r.startsWith("FAILED"));
    const refusedRows = actions.filter(a => a.kind === "refused");
    const wrote = !values.write
      ? "not-requested"
      : refuseWrite
        ? "refused"
        : failures.length > 0 || refusedRows.length > 0
          ? "partial"
          : "yes";
    console.log(JSON.stringify({ ...reading, actions, results, wrote }, null, 2));
    return refuseWrite || failures.length > 0 || refusedRows.length > 0 ? REFUSAL_EXIT : 0;
  }

  const edges = actions.reduce((n, a) => n + a.edges.length, 0);
  console.log(`${values.repair} — ${reading.rows.length} row(s)\n`);
  console.log(`ACTIONS`);
  for (const a of actions) {
    const mark = { annotate: "ANNOTATE", demote: "DEMOTE  ", unchanged: "ok      ", refused: "REFUSED " }[a.kind];
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
  const applied = await apply(gh2, repo, actions);
  for (const line of applied) console.log(`  ${line}`);
  const failed = applied.filter(r => r.startsWith("FAILED"));
  const refusedRows = actions.filter(a => a.kind === "refused");
  console.log(
    `\n  Then re-run both, in this order — a demotion changes the phase sizes and\n` +
      `  the board column is a mirror of the body, not a second source:\n` +
      `    rungate plan-deps --repo ${repo} --write\n` +
      `    rungate board-mirror --project <id> --spec <spec> --ready --write`,
  );
  if (failed.length > 0 || refusedRows.length > 0) {
    console.error(
      `\nplan-issues: ${failed.length} action(s) FAILED and ${refusedRows.length} row(s) were refused.`,
    );
    return REFUSAL_EXIT;
  }
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
