#!/usr/bin/env bun
/**
 * ai-review-control/run.ts — stage a control subject for a reviewer, and
 * score what the reviewer wrote (#1169).
 *
 * A scorer with no way to produce a payload is half an instrument, so this
 * is the other half:
 *
 *   bun evals/ai-review-control/run.ts list
 *   bun evals/ai-review-control/run.ts stage suite-lock-redirect/planted /tmp/subj
 *   bun evals/ai-review-control/run.ts score suite-lock-redirect/planted \
 *       /tmp/findings.json --reviewer rungate@0.8.0
 *
 * `stage` builds a one-commit git repository holding the BASELINE at the
 * subject's review path, then writes the candidate over it and leaves it
 * uncommitted. So `git diff` in that directory is the diff a reviewer reads,
 * and the subject arrives as ordinary code: nothing in the staged tree says
 * which of the two candidates it is, or that it is a control subject at all.
 * That is deliberate. A banner reading "planted defect below" turns a recall
 * measurement into a reading-comprehension one.
 *
 * Which reviewer to point at it is the operator's call and deliberately not
 * wired in here. The one in CI is `claude_args` on the `ai-review` job, and
 * invoking it from this script would make the control depend on a workflow
 * that cannot run locally. What the control needs back is a findings payload
 * in the contract's shape, from whatever produced it — and `--reviewer` is
 * required rather than defaulted, because CI adjudicates with a pinned
 * published package while the tree runs ahead of it, and a reading that
 * cannot say which it watched is a number about nothing.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import {
  REVIEW_CONTROL_SUBJECTS_DIR,
  loadReviewControlSubjects,
  readReviewControl,
  summariseReviewControl,
  type ReviewControlSubject,
} from "./control";

/** Non-zero for every refusal, through one constant. */
const REFUSED = 1;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
}

function find(subjects: ReviewControlSubject[], id: string): ReviewControlSubject {
  const found = subjects.find(s => s.id === id);
  if (found === undefined) {
    throw new Error(`no subject ${id}. Known: ${subjects.map(s => s.id).join(", ")}`);
  }
  return found;
}

/**
 * Write the baseline, commit it, then write the candidate over the top.
 *
 * Refuses to stage into an existing checkout for the reason `evals/
 * scaffold.sh` already carries: the identity writes below are repo-scoped,
 * and running them in a real repo rewrites that repo's author.
 */
function stage(subject: ReviewControlSubject, dir: string): void {
  if (existsSync(join(dir, ".git"))) {
    throw new Error(`refusing to stage into an existing checkout: ${dir}`);
  }
  const target = join(dir, subject.file);
  mkdirSync(dirname(target), { recursive: true });

  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "control@test");
  git(dir, "config", "user.name", "Review control");

  writeFileSync(target, readFileSync(subject.baselinePath, "utf-8"));
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "baseline");

  writeFileSync(target, readFileSync(subject.candidatePath, "utf-8"));

  process.stdout.write(
    `staged ${subject.id} in ${dir}\n` +
      `  the diff a reviewer reads: git -C ${dir} diff -- ${subject.file}\n` +
      `  score the payload with:    bun ${import.meta.file} score ${subject.id} ` +
      `<findings.json> --reviewer <id>\n`,
  );
}

function score(subject: ReviewControlSubject, payloadPath: string, reviewer: string): number {
  // An absent file is read as "the reviewer wrote nothing", which is the
  // #1180 shape and a reading rather than a crash. The payload reader already
  // distinguishes absent from unreadable, so neither is decided here.
  const raw = existsSync(payloadPath) ? readFileSync(payloadPath, "utf-8") : null;
  const reading = readReviewControl(subject, raw, reviewer);
  const run = summariseReviewControl([reading]);

  process.stdout.write(
    `${reading.subject} (${reading.kind}): ${reading.outcome} — reviewer ` +
      `${reading.reviewer ?? "(unnamed)"}\n`,
  );
  for (const line of reading.detail) process.stdout.write(`  ${line}\n`);
  if (reading.payloadReasons.length > 0) {
    process.stdout.write(`  payload: ${reading.payloadReasons.join(", ")}\n`);
  }
  // A single-subject run can never satisfy the coverage clause, so the
  // subject's own reading is what decides here — `run` is printed for the
  // counts, never consulted for the verdict.
  process.stdout.write(
    `  blocking=${reading.blockingCount ?? "-"} advisory=${reading.advisoryCount ?? "-"} ` +
      `plantHits=${reading.plantHits} contradictions=${run.contradictions}\n`,
  );
  return reading.passed ? 0 : REFUSED;
}

export function main(argv: string[]): number {
  const subjects = loadReviewControlSubjects(REVIEW_CONTROL_SUBJECTS_DIR);
  const [command, ...rest] = argv;

  if (command === "list") {
    for (const s of subjects) process.stdout.write(`${s.kind.padEnd(8)}${s.id}\n`);
    return 0;
  }

  if (command === "stage") {
    const [id, dir] = rest;
    if (id === undefined || dir === undefined) {
      process.stderr.write("usage: run.ts stage <subject-id> <empty-dir>\n");
      return REFUSED;
    }
    mkdirSync(dir, { recursive: true });
    stage(find(subjects, id), dir);
    return 0;
  }

  if (command === "score") {
    const [id, payloadPath] = rest;
    const at = rest.indexOf("--reviewer");
    const reviewer = at === -1 ? "" : (rest[at + 1] ?? "");
    if (id === undefined || payloadPath === undefined) {
      process.stderr.write("usage: run.ts score <subject-id> <findings.json> --reviewer <id>\n");
      return REFUSED;
    }
    return score(find(subjects, id), payloadPath, reviewer);
  }

  process.stderr.write("usage: run.ts list | stage <id> <dir> | score <id> <payload> --reviewer <id>\n");
  return REFUSED;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
