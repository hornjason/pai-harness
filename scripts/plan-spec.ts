#!/usr/bin/env bun
/**
 * Turn a spec's *Phase placement* table into the repository's milestones (#1647).
 *
 * Step 2 of `docs/adr/ADR-003-spec-to-tracker-mapping.md`, made executable.
 * The ADR's three steps have one decider each: step 1 is the table in the
 * spec, step 3 is the issue body naming its criteria, and step 2 — the
 * milestones — was eight `gh` commands typed by hand on 2026-10-28. Two of
 * those eight already disagree with the heading they were copied from. This
 * command derives them instead, so a phase heading edited in the spec is a
 * rename here rather than a drift nobody can see.
 *
 * ## It reports by default and writes only when told
 *
 * No `--write`, no mutation. The reading is the product: which criteria the
 * table fails to place, which milestones are missing or misnamed, and which
 * of a phase's criteria no open issue names. All three are things somebody
 * has to act on, and two of them are judgement.
 *
 * ## It does NOT create issues, and that is a decision
 *
 * Which criteria belong together in one issue is judgement — a criterion
 * needs several issues and an issue serves several criteria (ADR-003,
 * *Cardinality*). A tool that guessed would file against rule 7's
 * opened-to-closed ratio, which a swarm once ran at three to one. The
 * uncovered list below is the INPUT to that decision and the command stops
 * there.
 *
 * ## Why the coverage column says NAMES and not SERVES
 *
 * Whether an issue genuinely advances a criterion is an adjudication. A
 * column holding an adjudication is a human-settable boolean, which is the
 * exact category this change exists to escape, rebuilt one level up. The
 * tick-versus-issue sweep on 2026-10-28 put the signal-to-noise of a
 * name-match at 2 to 3 real of 12 raw, so the mechanical reading is
 * generous about coverage and never invents it. The adjudication is
 * recorded separately and dated.
 */
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { parseArgs } from "util";
import {
  createGitHubClient,
  createMilestone,
  listMilestones,
  listOpenIssues,
  renameMilestone,
} from "../lib/github";
import {
  milestoneBody,
  milestonePlan,
  placementReading,
  uncoveredByMilestone,
} from "../lib/spec-placement";

/**
 * THE one non-zero exit. One site, so `test/plan-spec.test.ts` can build a
 * mutant with it set to `0` and prove each refusal is what the case observed
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSAL_EXIT = 1;

/**
 * The GitHub calls, injected so a test can watch whether any of them happened.
 *
 * **The point is the negative case.** This command's refusal on an unsound
 * placement table used to be a non-zero exit computed AFTER the milestones
 * were created and renamed — the writes went out and the exit code then said
 * the run had been refused. Nothing that reads only an exit code can tell
 * that apart from a refusal that stopped anything, so the case that matters
 * asserts on the CALLS, and there has to be a seam to count them at.
 */
export interface PlanSpecGitHub {
  createClient: typeof createGitHubClient;
  listMilestones: typeof listMilestones;
  listOpenIssues: typeof listOpenIssues;
  createMilestone: typeof createMilestone;
  renameMilestone: typeof renameMilestone;
}

const LIVE_GITHUB: PlanSpecGitHub = {
  createClient: createGitHubClient,
  listMilestones,
  listOpenIssues,
  createMilestone,
  renameMilestone,
};

const USAGE = `rungate plan-spec <spec.md> --repo <owner/name> --prefix <name> [--write] [--json]

  --repo     owner/name. Defaults to $GITHUB_REPOSITORY.
  --prefix   the milestone name prefix, e.g. "Convergence" gives
             "Convergence Phase 1 — stop the repeats". Required: deriving it
             from the filename would call the live milestones something else.
  --write    create and rename milestones. Without it, nothing is mutated.
  --json     the whole reading, for something other than a person.`;

export async function main(argv: string[], gh: PlanSpecGitHub = LIVE_GITHUB): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        prefix: { type: "string" },
        write: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "project-root": { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    console.error(`plan-spec: ${(e as Error).message}\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const { values, positionals } = parsed;
  const specArg = positionals[0];
  if (!specArg) {
    console.error(`plan-spec: no spec given\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const prefix = values.prefix;
  if (!prefix) {
    console.error(`plan-spec: --prefix is required\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error(`plan-spec: --repo is required (or set GITHUB_REPOSITORY)\n\n${USAGE}`);
    return REFUSAL_EXIT;
  }

  const root = values["project-root"] ?? process.cwd();
  const specPath = isAbsolute(specArg) ? specArg : join(root, specArg);
  if (!existsSync(specPath)) {
    console.error(`plan-spec: no such spec: ${specPath}`);
    return REFUSAL_EXIT;
  }
  const content = readFileSync(specPath, "utf-8");

  // ── Step 1: is the spec's own table sound? ───────────────────────────────
  const reading = placementReading(content);
  if (reading.reading === "UNMEASURED") {
    console.error(`plan-spec: UNMEASURED — the placement table could not be read:`);
    for (const r of reading.unmeasuredReasons) console.error(`  - ${r}`);
    console.error(`\nSee docs/adr/ADR-003-spec-to-tracker-mapping.md § 1.`);
    return REFUSAL_EXIT;
  }

  const problems: string[] = [];
  if (reading.unplaced.length > 0) {
    problems.push(
      `${reading.unplaced.length} criteria are in no row — a criterion in no placement is ` +
        `unreadable as anything, because "nobody has reached it", "it cannot start" and ` +
        `"it is finished" all render as absence:\n    ${reading.unplaced.join(", ")}`,
    );
  }
  for (const d of reading.doubled) {
    problems.push(`${d.id} is placed twice: ${d.placements.join(" and ")}`);
  }
  if (reading.unknown.length > 0) {
    problems.push(`placed but stated nowhere in the spec: ${reading.unknown.join(", ")}`);
  }
  if (reading.unrecognised.length > 0) {
    problems.push(
      `placement values outside the closed set: ${reading.unrecognised.join(", ")}. ` +
        `Add one to NON_PHASE_PLACEMENTS in lib/spec-placement.ts deliberately, or fix the row.`,
    );
  }

  // ── The write refusal, decided BEFORE anything is read from the network ──
  //
  // One expression, read by every path below, because this used to be three
  // readings of `problems.length > 0` with the write between two of them: the
  // `--json` return, the no-`--write` return, and a final return that ran
  // AFTER `createMilestone` and `renameMilestone` had been called. That last
  // one is the defect the AI review of PR #1647 named. A command that creates
  // eight milestones and then exits non-zero has not refused anything, and the
  // exit code is the only thing a caller sees — so the reading that says "do
  // not write" has to happen before the loop, not after it.
  //
  // It is deliberately the WHOLE of `problems`, not a chosen subset. Every
  // member means the table cannot be trusted to say which criteria a phase
  // holds, and `milestoneBody` writes exactly that list into the description.
  const refuseWrite = problems.length > 0;

  // ── Step 2: what the milestones should be ────────────────────────────────
  const client = gh.createClient();
  const live = await gh.listMilestones(client, repo);
  const { actions, unmanaged } = milestonePlan(content, live, prefix);

  // ── Step 3, reported not enforced: what no open issue names ──────────────
  const open = await gh.listOpenIssues(client, repo, 100);
  const bodies = open.issues.map(i => ({ number: i.number, text: `${i.title}\n${i.body ?? ""}` }));
  const coverage = uncoveredByMilestone(actions, bodies);
  // 100 is the API's per-page ceiling and `listOpenIssues` takes one page. A
  // full page means there may be more, and the ones not read would each read
  // as a criterion NOBODY names — the coverage report would be wrong in the
  // direction that invents work. Say so rather than print a number.
  const truncated = open.issues.length + open.droppedRows.length >= 100;

  if (values.json) {
    // `wrote` says which of the three states this run was in, because
    // `--json --write` printed the same object whether it had written eight
    // milestones or none and a consumer had no way to ask.
    const wrote = !values.write ? "not-requested" : refuseWrite ? "refused" : "yes";
    console.log(JSON.stringify({ reading, actions, unmanaged, coverage, problems, wrote }, null, 2));
    if (values.write && !refuseWrite) await applyMilestones(gh, client, repo, actions);
    return refuseWrite ? REFUSAL_EXIT : 0;
  }

  console.log(`${specArg} — ${reading.criteria.length} criteria, ${reading.rows.length} placements\n`);

  if (problems.length > 0) {
    console.log(`PLACEMENT PROBLEMS — fix these in the spec before the milestones mean anything\n`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log("");
  }

  console.log(`MILESTONES`);
  for (const a of actions) {
    const mark = {
      create: "CREATE  ",
      rename: "RENAME  ",
      update: "UPDATE  ",
      unchanged: "ok      ",
    }[a.action];
    console.log(`  ${mark}${a.title}  (${a.criteria.length} criteria)`);
    if (a.action === "rename") console.log(`            was: ${a.existing!.title}  (#${a.existing!.number})`);
    if (a.action === "update")
      console.log(`            #${a.existing!.number}, same name — its criteria list moved`);
  }
  if (unmanaged.length > 0) {
    console.log(`\n  Not derived from this spec, left alone:`);
    for (const m of unmanaged) console.log(`    #${m.number} ${m.title}`);
  }

  console.log(`\nCRITERIA NO OPEN ISSUE NAMES   (read ${open.issues.length} open issues)`);
  if (truncated) {
    console.log(
      `  UNMEASURED: the issue page came back full, so there are open issues this did\n` +
        `  not read. Every criterion only they name is listed below as uncovered.`,
    );
  }
  for (const c of coverage) {
    if (c.uncovered.length === 0) {
      console.log(`  ${c.title}\n    all ${c.covered.length} named`);
      continue;
    }
    console.log(`  ${c.title}\n    ${c.covered.length} named, ${c.uncovered.length} not: ${c.uncovered.join(", ")}`);
  }
  console.log(
    `\n  "Named" is a word-boundary match in an open issue's title or body. It is` +
      `\n  mechanical on purpose — whether an issue SERVES a criterion is a judgement,` +
      `\n  and a column holding a judgement is the thing this replaces.`,
  );

  if (!values.write) {
    const todo = actions.filter(a => a.action !== "unchanged").length;
    console.log(
      todo > 0
        ? `\nNothing written. Re-run with --write to apply ${todo} milestone change(s).`
        : `\nNothing written, and nothing to write — the milestones already match.`,
    );
    return refuseWrite ? REFUSAL_EXIT : 0;
  }

  if (refuseWrite) {
    console.error(
      `\nREFUSING TO WRITE — ${problems.length} placement problem(s) above, and NOTHING was\n` +
        `  created or renamed. A milestone's description is the phase's criteria list, so a\n` +
        `  table that does not place every criterion exactly once cannot say what to write.\n` +
        `  Fix the table in the spec, re-run without --write to confirm the reading, then write.`,
    );
    return REFUSAL_EXIT;
  }

  console.log(`\nWRITING`);
  for (const line of await applyMilestones(gh, client, repo, actions)) console.log(`  ${line}`);
  return 0;
}

/**
 * Create, rename and update, and say what happened — the ONE write site.
 *
 * Both output paths call it, so `--json --write` cannot silently do nothing
 * the way it did when the write lived below the `--json` return.
 */
async function applyMilestones(
  gh: PlanSpecGitHub,
  client: ReturnType<typeof createGitHubClient>,
  repo: string,
  actions: Awaited<ReturnType<typeof milestonePlan>>["actions"],
): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    const description = milestoneBody(a.criteria);
    if (a.action === "create") {
      const m = await gh.createMilestone(client, repo, { title: a.title, description });
      done.push(`created  #${m.number} ${a.title}`);
    } else if (a.action === "rename" || a.action === "update") {
      await gh.renameMilestone(client, repo, a.existing!.number, { title: a.title, description });
      done.push(
        a.action === "rename"
          ? `renamed  #${a.existing!.number} -> ${a.title}`
          : `updated  #${a.existing!.number} ${a.title} — criteria list refreshed`,
      );
    }
  }
  return done;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
