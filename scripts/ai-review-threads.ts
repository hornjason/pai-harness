#!/usr/bin/env bun
/**
 * Post an AI review's findings onto the pull request's diff (#1612).
 *
 * Usage:
 *   bunx rungate ai-review-threads <findings.json> --repo owner/name --pr 12 --commit <sha>
 *   bun bin/rungate.ts ai-review-threads <path> --repo owner/name --pr 12 --commit <sha>
 *
 * Optional: `--changed-files <path>` — the pull request's changed-path list,
 * one per line. Supplying it is what lets a finding naming a file this pull
 * request does not touch be held back rather than sent and refused.
 *
 * ## Why this is a separate command from `ai-review-findings`
 *
 * The adjudicator EXITS NON-ZERO on a blocking finding. That is its whole
 * contract. A poster sharing that entry point would inherit the refusal and
 * could never run on the review it most needs to run on — the one that found
 * something. So the reading is taken twice, by the same reader, in two
 * processes with two different jobs.
 *
 * The exit code is `lib/ai-review-threads.ts`'s, routed through
 * `AI_REVIEW_THREADS_REFUSAL`, for the reason `scripts/ai-review-findings.ts`
 * gives at length: a `process.exit(1)` written here would be a second
 * non-zero exit that a mutation of the constant cannot reach.
 *
 * ## It does not adjudicate, and must not
 *
 * A blocking finding is the adjudicator's to refuse. If this file also
 * refused, the two would be a pair of deciders that always agree — the
 * fourth shape in `.claude/rules/checks-must-be-able-to-fail.md` — and no
 * behavioural test could tell which of them was holding the gate up.
 */
import { createGitHubClient } from "../lib/github";
import {
  aiReviewThreadsExitCode,
  postReviewThreads,
  type AiReviewThreadPoster,
  type AiReviewThreadResponse,
} from "../lib/ai-review-threads";
import {
  readAiReviewChangedFiles,
  readAiReviewFindingsFile,
} from "../lib/scaffold/ai-review-findings";

const COMMAND = "ai-review-threads";

/** Every `--name value` pair this command takes. Anything else is positional. */
const FLAGS = ["repo", "pr", "commit", "changed-files"] as const;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * The positionals, walked rather than filtered.
 *
 * A `argv.filter(a => !a.startsWith("--"))` reads a flag's VALUE as a
 * positional — `--repo owner/name` would hand back `owner/name` as the
 * findings path, and the run would go looking for a payload at a repository
 * slug. Pairs are consumed explicitly instead.
 */
function positionals(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (FLAGS.includes(a.slice(2) as (typeof FLAGS)[number])) i += 1;
      continue;
    }
    rest.push(a);
  }
  return rest;
}

/** Everything the run needs, or the sentence saying what was missing. */
function parse(argv: string[]):
  | { ok: true; findings: string; owner: string; repo: string; pr: number; commit: string; changed: string | undefined }
  | { ok: false; error: string } {
  const rest = positionals(argv);
  if (rest.length === 0) return { ok: false, error: "no findings payload given" };
  if (rest.length > 1) {
    return { ok: false, error: `expected one findings payload, got ${rest.length}: ${rest.join(" ")}` };
  }
  const findings = rest[0]!;

  const slug = flag(argv, "repo");
  if (slug === undefined || !slug.includes("/")) {
    return { ok: false, error: "--repo <owner/name> is required" };
  }
  const [owner, repo] = slug.split("/", 2) as [string, string];

  const prRaw = flag(argv, "pr");
  const pr = Number(prRaw);
  if (prRaw === undefined || !Number.isInteger(pr) || pr <= 0) {
    return { ok: false, error: "--pr <number> is required" };
  }

  const commit = flag(argv, "commit");
  if (commit === undefined || commit === "") {
    return { ok: false, error: "--commit <sha> is required — a review comment is anchored to one" };
  }

  return { ok: true, findings, owner, repo, pr, commit, changed: flag(argv, "changed-files") };
}

const parsed = parse(process.argv.slice(2));
if (!parsed.ok) {
  // UNMEASURED, not a refusal. A step invoked wrongly has not discovered that
  // a review produced no threads; it has not looked. Exiting non-zero here
  // would red the job for a reason that says nothing about the review.
  console.log(`::warning title=AI review threads::${COMMAND}: ${parsed.error} — UNMEASURED, nothing was posted`);
  process.exit(0);
}

const reading = readAiReviewFindingsFile(parsed.findings, readAiReviewChangedFiles(parsed.changed));

const client = createGitHubClient();
const post: AiReviewThreadPoster = async request => {
  try {
    await client.rest.pulls.createReviewComment({
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.pr,
      commit_id: parsed.commit,
      path: request.path,
      body: request.body,
      // `line` is omitted entirely rather than sent as null — the API
      // documents it as "Required unless using subject_type:file", and the
      // two spellings are not interchangeable.
      ...(request.line === null ? { subject_type: "file" as const } : { line: request.line }),
    });
    return { ok: true };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return {
      ok: false,
      status: typeof err.status === "number" ? err.status : null,
      message: err.message ?? String(e),
    } satisfies AiReviewThreadResponse;
  }
};

const result = await postReviewThreads(reading, post);
for (const line of result.detail) console.log(`${COMMAND}: ${line}`);
console.log(
  `${COMMAND}: ${result.outcome} — attempted ${result.attempted}, posted ${result.posted}, ` +
    `demoted ${result.demoted}`,
);

// The outcome reaches the run summary as an annotation only when it is worth
// a reader's attention. A POSTED round already shows up as comments on the
// diff, which is a louder channel than an annotation and the entire point.
if (result.outcome === "FAILED") {
  console.log(
    `::error title=AI review threads::The review found something and this job could not put it on ` +
      `the diff. ${result.posted} of ${result.attempted} posted.`,
  );
} else if (result.outcome === "DEGRADED_NO_WRITE") {
  console.log(
    `::warning title=AI review threads::No review threads were created: this token cannot write ` +
      `pull-request comments. A pull_request run from a fork is handed a read-only token whatever ` +
      `the workflow declares. The findings are in this run's annotations.`,
  );
} else if (result.outcome === "UNMEASURED") {
  console.log(
    `::warning title=AI review threads::UNMEASURED — there was no usable reading to post from. ` +
      `This is not a review that found nothing.`,
  );
}

process.exit(aiReviewThreadsExitCode(result));
