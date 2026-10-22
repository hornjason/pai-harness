/**
 * lib/github.ts — Shared Octokit-based GitHub client
 *
 * SC-489: exports [createGitHubClient, getIssue, addComment, addLabels]
 * SC-490: exports [createPR, updatePR, listPRs, closeIssue]
 * SC-491: contains [GITHUB_TOKEN, Octokit, issues.addLabels]
 * SC-493: POST additive label strategy documented
 *
 * Design decisions (from GITHUB-API-MIGRATION-SPEC):
 * - D-2: @octokit/rest as the TypeScript SDK
 * - D-3: Auth via GITHUB_TOKEN environment variable
 * - D-4: Single auth point, reusable across hooks/gates/lib, mockable for tests
 * - D-5: POST /issues/{n}/labels for label append (additive by design, not PUT/replace)
 * - D-7: MCP fallback to Octokit when MCP server not connected
 *
 * Label operations use POST (additive) — never PUT (replace-all).
 * The POST endpoint appends labels without removing existing ones,
 * eliminating the read-merge-write race condition that PUT would require.
 */

import { Octokit } from "@octokit/rest";

// ── Types ──────────────────────────────────────────────────────────────────

export interface GitHubClient {
  rest: {
    issues: {
      get: (params: { owner: string; repo: string; issue_number: number }) => Promise<{ data: any }>;
      create: (params: { owner: string; repo: string; title: string; body?: string; labels?: string[] }) => Promise<{ data: any }>;
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{ data: any }>;
      addLabels: (params: { owner: string; repo: string; issue_number: number; labels: string[] }) => Promise<{ data: any }>;
      update: (params: { owner: string; repo: string; issue_number: number; state?: string; [key: string]: any }) => Promise<{ data: any }>;
      /**
       * Issues for one repository — **and its pull requests**, which this
       * endpoint returns as issues carrying a `pull_request` key. Callers go
       * through `listIssues`, which drops them; see its header for why that
       * is not optional.
       */
      listForRepo: (params: { owner: string; repo: string; state?: string; per_page?: number; [key: string]: any }) => Promise<{ data: any[] }>;
    };
    pulls: {
      create: (params: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }) => Promise<{ data: any }>;
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{ data: any }>;
      update: (params: { owner: string; repo: string; pull_number: number; [key: string]: any }) => Promise<{ data: any }>;
      list: (params: { owner: string; repo: string; [key: string]: any }) => Promise<{ data: any[] }>;
    };
    repos: {
      /** Repository metadata. `owner.type` and `default_branch` are what PROTECT-1 reads (#909). */
      get: (params: { owner: string; repo: string }) => Promise<{ data: any }>;
      /**
       * One branch. Carries `protected`, and needs only read access (#909).
       *
       * Asked BEFORE `getBranchProtection`, which needs admin: a 404 from the
       * protection endpoint means "unprotected" or "you are not an admin"
       * with no way to tell which, and conflating those would let a token
       * without admin report every repo clean.
       */
      getBranch: (params: { owner: string; repo: string; branch: string }) => Promise<{ data: any }>;
      /** Branch protection. Requires admin on the repo; 403 for everyone else. */
      getBranchProtection: (params: { owner: string; repo: string; branch: string }) => Promise<{ data: any }>;
    };
    checks: {
      /**
       * Check runs for one ref (#46).
       *
       * `ref` is passed a commit SHA and never a branch name. The endpoint
       * accepts both, and the branch form is the whole defect this gate would
       * otherwise introduce — see `readCi`.
       */
      listForRef: (params: { owner: string; repo: string; ref: string; per_page?: number }) => Promise<{ data: { total_count: number; check_runs: any[] } }>;
    };
  };
  /**
   * The GraphQL endpoint, for the handful of operations REST does not expose.
   *
   * `markPullRequestReadyForReview` is the only one today (#252): PATCH
   * /pulls/{n} silently ignores a `draft` field, so a run that tried to
   * undraft over REST would report success and leave the PR a draft.
   */
  graphql: (query: string, variables?: Record<string, unknown>) => Promise<any>;
}

export interface CreatePROptions {
  title: string;
  head: string;
  base: string;
  body?: string;
  /**
   * Open the PR as a draft (#252).
   *
   * ship.js opens its PR before the ship gate, the blocking-grade check and
   * two staleness refusals, so all of those can fail with a reviewable PR
   * already on the branch. Run `wf_e105dd33-220` did exactly that: it returned
   * SHIP_FAILED and left #250 open and `mergeable: MERGEABLE`, carrying code
   * that destroyed a consumer's CI. Defaults false, because a human opening a
   * PR means it.
   */
  draft?: boolean;
}

export interface UpdatePROptions {
  title?: string;
  body?: string;
  state?: string;
}

export interface ListPRsOptions {
  state?: "open" | "closed" | "all";
  head?: string;
  base?: string;
  sort?: string;
  direction?: "asc" | "desc";
  per_page?: number;
}

// ── Client factory ─────────────────────────────────────────────────────────

/**
 * Create a GitHub client authenticated via GITHUB_TOKEN env var.
 * Client is created once per call — callers should cache the instance
 * (D-4: single auth point, created once per process).
 */
export function createGitHubClient(): GitHubClient {
  const token = resolveGitHubToken();
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN environment variable is not set — required for GitHub API access " +
        "(GH_TOKEN is also accepted)",
    );
  }
  const baseUrl = resolveApiBaseUrl();
  return new Octokit(baseUrl ? { auth: token, baseUrl } : { auth: token }) as unknown as GitHubClient;
}

/**
 * The API base from `GITHUB_API_URL` (D-8), or undefined for Octokit's default.
 *
 * `GITHUB_API_URL` is the conventional companion to the token variables — gh
 * CLI and GitHub Actions both set it — and honouring it makes GitHub
 * Enterprise usable and lets tests point the client somewhere harmless
 * instead of at the real API.
 *
 * **Allowlisted hosts only: GitHub itself, or loopback.** This variable
 * redirects an endpoint that carries a bearer token, so it is an
 * exfiltration primitive for anyone who can set it. An earlier version
 * allowed any `https` host, reasoning that whoever controls the environment
 * can usually read the token anyway. Security review flagged it twice and
 * was right the second time: "usually" is not "always".
 *
 * The allowlist is not loopback-only, though, and CI is what taught me that:
 * **GitHub Actions sets `GITHUB_API_URL=https://api.github.com` on every
 * run.** A loopback-only rule therefore refused the genuine GitHub API and
 * broke the whole suite in CI while passing locally, where the variable is
 * unset. The differential was the fix's bug, not the test's.
 *
 * So the token can reach GitHub, or a port on this machine, and nowhere else.
 * Hostname is compared exactly, so `api.github.com.evil.com` and a loopback
 * name hidden in the userinfo (`https://127.0.0.1@evil.com`) are both
 * refused. GitHub Enterprise needs a host outside this list and stays a
 * separate, deliberate decision rather than a side effect of a test seam.
 */
const ALLOWED_API_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

export function resolveApiBaseUrl(): string | undefined {
  const raw = process.env.GITHUB_API_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GITHUB_API_URL is not a valid URL: ${raw}`);
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname)) {
    throw new Error(
      `GITHUB_API_URL may only point at GitHub or loopback — refusing to send a token to ${url.hostname}`,
    );
  }
  return raw;
}

/**
 * The GitHub credential, under either of the two conventional names.
 *
 * #139: this read `GITHUB_TOKEN` alone, and nothing sets it. `gh auth status`
 * on Jason's machine reports the account is authenticated via `GH_TOKEN`, so
 * every Octokit call in the repo threw at construction — the prove gate said
 * so loudly, `gates/orchestrator.ts` dropped the `shipped` label into a
 * `.catch(() => {})`, and `hooks/IssueCloseGuard.hook.ts` stopped guarding
 * (#140).
 *
 * D-3 of GITHUB-API-MIGRATION-SPEC chose the single name on the grounds that
 * it was "already set by `gh` CLI auth". It is not: `gh` reads `GH_TOKEN` and
 * exports nothing. Accepting both is what makes D-7's "Octokit always works"
 * true in an environment authenticated the ordinary way.
 *
 * `GITHUB_TOKEN` wins when both are present, so a deliberately scoped token
 * can override a broader ambient one. Empty strings count as absent — an
 * exported-but-unset variable must produce the clear error here rather than
 * an unauthenticated client that 401s somewhere less obvious.
 */
export function resolveGitHubToken(): string | undefined {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = process.env[name];
    // Trimmed, not just tested: `GH_TOKEN=$(cat token)` carries a trailing
    // newline, and Octokit sends it in the Authorization header, where it
    // 401s with nothing pointing at the whitespace as the cause.
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse "owner/repo" into { owner, repo }, rejecting anything that is not one.
 *
 * The shape check alone was not enough, and the measurement is unambiguous.
 * Octokit interpolates these into the request path, and the URL layer
 * resolves `..` segments before the request goes out:
 *
 *     --repo "owner/.."   ->  GET /repos/issues/7
 *     --repo "../x"       ->  GET /x/issues/7       <- out of /repos entirely
 *
 * The second one is arbitrary API-path construction with whatever verb the
 * caller's operation uses. Query strings and fragments were already safe —
 * `owner/na?x=1` arrives percent-encoded — so traversal is the whole of it.
 *
 * It mattered more once #137 made a repo slug a command-line argument, but it
 * was always reachable: `gates/orchestrator.ts` and `lib/branch-cleanup.ts`
 * pass slugs through here too. GitHub owner and repository names are
 * `[A-Za-z0-9._-]` only, so requiring exactly that rejects nothing real.
 */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseOwnerRepo(repoSlug: string): { owner: string; repo: string } {
  const parts = repoSlug.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid repo format: "${repoSlug}" — expected "owner/repo"`);
  }
  for (const part of parts) {
    if (!REPO_SEGMENT.test(part) || part === "." || part === "..") {
      throw new Error(
        `Invalid repo format: "${repoSlug}" — "${part}" is not a GitHub owner or repository name`,
      );
    }
  }
  return { owner: parts[0], repo: parts[1] };
}

// ── Issue operations ───────────────────────────────────────────────────────

/**
 * Get issue details by number.
 */
export async function getIssue(client: GitHubClient, repoSlug: string, issueNumber: number): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return response.data;
}

/**
 * An issue's label names (#395).
 *
 * Exists because `gates/workflow.test.ts` read labels by shelling out to the
 * GitHub CLI — a synchronous exec of `issue view --json labels`, with the
 * issue number and repo slug interpolated into the command string.
 *
 * That call is NOT reproduced here, and the omission is deliberate rather
 * than stylistic. `test/ticked-sc-cover.test.ts` scans `lib/`, `hooks/` and
 * `gates/` for exactly that spelling, and a docblock quoting it verbatim
 * would be a violation sitting inside the module written to remove one.
 * Today the scan's pattern happens not to match across a ` * ` comment
 * prefix, which is luck and not design — the same kind of luck that let the
 * original survive. Describe it; do not spell it.
 *
 * Two things were wrong with it beyond the architecture GITHUB-API-
 * MIGRATION-SPEC.md lays down. It needed `gh` installed and authenticated in
 * whatever environment the gate ran in — often CI or a worktree. And it
 * interpolated two values out of workflow state into a SHELL STRING; this
 * takes arguments, and Octokit puts them in a URL path and a query, so there
 * is no command line for them to be part of.
 *
 * Worth recording how it survived: SC-502 forbids exactly this and was
 * ticked over it for the criterion's whole life, because the call puts
 * `execSync(` on one line and the command on the next and every grep for it
 * was line-oriented. A text search cannot see across a line break, which is
 * the "detector narrower than what it detects" shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * The shape is defensive because the API's is: `labels` is a list whose
 * entries are either a string or an object carrying `name`.
 */
export async function getIssueLabels(
  client: GitHubClient,
  repoSlug: string,
  issueNumber: number,
): Promise<string[]> {
  const issue = await getIssue(client, repoSlug, issueNumber);
  const raw = Array.isArray(issue?.labels) ? issue.labels : [];
  return raw
    .map((l: unknown) => (typeof l === "string" ? l : (l as { name?: unknown })?.name))
    .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);
}

/**
 * Add a comment to an issue.
 */
export async function addComment(client: GitHubClient, repoSlug: string, issueNumber: number, body: string): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return response.data;
}

/**
 * Add labels to an issue using POST (additive, not replace).
 *
 * Uses issues.addLabels which maps to POST /repos/{owner}/{repo}/issues/{issue_number}/labels.
 * POST is additive by design — it appends labels without removing existing ones.
 * This eliminates the read-merge-write race condition that PUT would require.
 *
 * D-5: POST /issues/{n}/labels for label append (not PUT)
 */
export async function addLabels(client: GitHubClient, repoSlug: string, issueNumber: number, labels: string[]): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels,
  });
  return response.data;
}

/**
 * Create a new issue.
 *
 * Used by ship.js when Discovery rescopes a large issue into phases: phase 1
 * stays on the parent, the rest become sub-issues.
 */
export async function createIssue(
  client: GitHubClient,
  repoSlug: string,
  opts: { title: string; body?: string; labels?: string[] },
): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.create({
    owner,
    repo,
    title: opts.title,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.labels?.length ? { labels: opts.labels } : {}),
  });
  return response.data;
}

/**
 * Update an issue's body and/or state.
 *
 * Labels are deliberately NOT part of this call. `PATCH /issues/{n}` with a
 * `labels` array REPLACES the whole set, which is the read-merge-write race
 * D-5 exists to avoid. Callers that want to add a label use `addLabels`.
 */
export async function updateIssue(
  client: GitHubClient,
  repoSlug: string,
  issueNumber: number,
  opts: { body?: string; title?: string; state?: "open" | "closed" },
): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    ...opts,
  });
  return response.data;
}

/**
 * Close an issue by setting state to "closed".
 */
export async function closeIssue(client: GitHubClient, repoSlug: string, issueNumber: number): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: "closed",
  });
  return response.data;
}

// ── Pull request operations ────────────────────────────────────────────────

/**
 * Create a new pull request.
 */
export async function createPR(client: GitHubClient, repoSlug: string, opts: CreatePROptions): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.pulls.create({
    owner,
    repo,
    title: opts.title,
    head: opts.head,
    base: opts.base,
    body: opts.body,
    draft: opts.draft === true,
  });
  return response.data;
}

/**
 * Take a draft PR out of draft (#252).
 *
 * Separate from `updatePR` because the REST PATCH endpoint does not flip
 * `draft` — it is a GraphQL mutation — and a caller that set `draft: false`
 * through `updatePR` would get a silent no-op, which is the fail-open shape
 * this whole area keeps producing. Throwing on an unavailable client is
 * deliberate: a run that cannot mark its PR ready must say so, not ship a
 * draft nobody notices is a draft.
 */
export async function markPRReady(
  client: GitHubClient,
  repoSlug: string,
  prNumber: number,
): Promise<{ number: number; isDraft: boolean }> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const pr = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const nodeId = pr.data.node_id;
  if (!nodeId) {
    throw new Error(`markPRReady: PR #${prNumber} has no node_id, so it cannot be marked ready`);
  }
  await client.graphql(
    `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }`,
    { id: nodeId },
  );
  return { number: prNumber, isDraft: false };
}

/**
 * Update an existing pull request.
 */
export async function updatePR(client: GitHubClient, repoSlug: string, prNumber: number, opts: UpdatePROptions): Promise<any> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    ...opts,
  });
  return response.data;
}

/**
 * Create the PR for `head`, or update the one that already exists.
 *
 * A ship run can reach this step more than once — a gate heals and re-runs,
 * or a regression sends it back through implement — so "create" alone fails
 * the second time with a 422 the caller has no way to distinguish from a real
 * error. Upsert is the operation the workflow actually wants.
 *
 * The lookup filters server-side on `owner:branch`, the form the REST API
 * documents for the `head` parameter. Listing every open PR and filtering here
 * would silently miss a match once the repo has more than one page of them.
 */
export async function upsertPR(
  client: GitHubClient,
  repoSlug: string,
  opts: CreatePROptions,
): Promise<{ number: number; html_url: string; action: "created" | "updated"; draft: boolean }> {
  const { owner } = parseOwnerRepo(repoSlug);
  const existing = await listPRs(client, repoSlug, {
    state: "open",
    head: `${owner}:${opts.head}`,
  });
  if (existing.length > 0) {
    const pr = existing[0];
    const updated = await updatePR(client, repoSlug, pr.number, {
      title: opts.title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
    // An existing PR IS dragged back into draft when the caller asks for one,
    // and the first version of this got that wrong (#252, found by security
    // review before merge). The comment it carried — "a PR a human already
    // marked ready is theirs" — does not survive contact with how this harness
    // runs: a re-ship pushes new commits to the SAME branch, so run A undrafts
    // #N, run B updates it and then refuses, and #N is mergeable carrying
    // run B's unproven code. Whatever the human approved is not what is on the
    // branch any more, which is exactly why their ready-mark cannot stand.
    //
    // Protecting the first run on a branch and nothing after it is no
    // protection at all here: #155, #164, #169 and #171 all exist because this
    // workflow re-enters its own phases.
    const draft = opts.draft === true
      ? await convertPRToDraft(client, repoSlug, pr.number, pr)
      : pr.draft === true;
    return { number: pr.number, html_url: updated.html_url ?? pr.html_url, action: "updated", draft };
  }
  const created = await createPR(client, repoSlug, opts);
  // Reported from the response rather than echoed from the request: the caller
  // records this as the state of the artefact, and a field it asked for is not
  // a field it observed.
  return {
    number: created.number,
    html_url: created.html_url,
    action: "created",
    draft: created.draft === true,
  };
}

/**
 * Put a PR back into draft, and report what it is now (#252).
 *
 * Already-draft is a no-op rather than a redundant mutation — a re-ship hits
 * this on every round, and a convert that fired unconditionally would be
 * indistinguishable in a test from one that fired for the right reason.
 *
 * Throws when the PR has no node id, because the mutation is keyed on it and
 * returning `true` with nothing sent would be the fail-open this whole area
 * keeps producing: a refusal artefact claiming the PR is unmergeable while it
 * sits there mergeable.
 */
async function convertPRToDraft(
  client: GitHubClient,
  repoSlug: string,
  prNumber: number,
  pr: { node_id?: string; draft?: boolean },
): Promise<boolean> {
  if (pr.draft === true) return true;
  const nodeId = pr.node_id;
  if (!nodeId) {
    throw new Error(
      `upsertPR: PR #${prNumber} has no node_id, so it cannot be converted to a draft — ` +
        "refusing rather than reporting a draft that was never made",
    );
  }
  await client.graphql(
    `mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { clientMutationId } }`,
    { id: nodeId },
  );
  return true;
}

/**
 * List issues, **pull requests excluded**.
 *
 * The REST issues endpoint returns pull requests as issues — every PR carries
 * a `pull_request` key and is otherwise shaped like one. `gh issue list`
 * filters them, so anything replacing a `gh issue list` subprocess has to
 * filter them too (SC-893). Without it the open-issue corpus silently gains
 * every open PR title, which for `lib/finding-gate.ts` means a finding can be
 * refused as a duplicate of a pull request.
 *
 * `per_page` is capped at 100 by the API. A caller that needs a complete
 * population must treat a full page as possibly truncated rather than
 * complete; this function does not paginate and does not pretend to.
 */
export async function listIssues(
  client: GitHubClient,
  repoSlug: string,
  opts?: { state?: "open" | "closed" | "all"; per_page?: number },
): Promise<any[]> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.issues.listForRepo({ owner, repo, ...opts });
  return (response.data as any[]).filter(i => i.pull_request === undefined);
}

/**
 * List pull requests with optional filters.
 */
export async function listPRs(client: GitHubClient, repoSlug: string, opts?: ListPRsOptions): Promise<any[]> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.pulls.list({
    owner,
    repo,
    ...opts,
  });
  return response.data;
}

// ── CI verification (#46) ────────────────────────────────────

/**
 * One check run, reduced to the four fields a verdict depends on.
 *
 * `headSha` is carried even though the query is already keyed on a SHA. It is
 * the field `readCi` re-checks, and re-checking it is the point: see below.
 */
export interface CheckRunSummary {
  name: string;
  /** `queued` | `in_progress` | `completed`, per the checks API. */
  status: string;
  /** `null` until the run completes. Never treat null as success. */
  conclusion: string | null;
  headSha: string;
  url?: string;
}

export interface CiReading {
  verdict: "PASS" | "FAIL" | "UNMEASURED";
  /** The commit the verdict is ABOUT. A reading without this is not a reading. */
  sha: string;
  /** A sentence naming why, in every branch including PASS. */
  reason: string;
  checks: CheckRunSummary[];
  failed: string[];
  pending: string[];
  /** Checks that completed without concluding either way — skipped, neutral. */
  inconclusive: string[];
}

/**
 * Conclusions that mean the check ran and said no.
 *
 * `cancelled` is in here deliberately. A cancelled run measured nothing, so
 * the tempting reading is UNMEASURED — but on this repo's CI a cancellation is
 * almost always `concurrency: cancel-in-progress` superseding the run, and
 * calling that "unmeasured" lets a superseded commit's gate pass on a reading
 * about a commit nobody is shipping. FAIL is the direction that costs a re-run
 * rather than a bad merge.
 */
const CI_FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

/**
 * Conclusions that completed without answering the question.
 *
 * `skipped` is the one that matters. A skipped check is the single most
 * convincing-looking way for this gate to certify nothing: the run exists, it
 * completed, it did not fail, and a verdict computed as "no failures" calls it
 * PASS. It measured nothing, so the reading is UNMEASURED.
 */
const CI_INCONCLUSIVE_CONCLUSIONS = new Set(["skipped", "neutral"]);

/**
 * The verdict for one commit, from the checks recorded against it.
 *
 * Pure, and separate from the fetching, because every interesting decision
 * here is a classification rather than a network call — and the classification
 * is the part that has to be wrong-proof.
 *
 * **There is no branch that arrives at PASS by not finding a failure.** PASS
 * requires at least one check, every check belonging to this exact commit,
 * every check `completed`, and every conclusion `success`. Absence, pending,
 * skipped and null all land elsewhere. That is the whole design: the natural
 * implementation of "did CI pass" is `!checks.some(failed)`, which returns
 * true for a commit CI has never heard of.
 *
 * **A check whose `headSha` differs is discarded, not counted.** The checks
 * API accepts a branch name as `ref` and will happily answer about whatever
 * commit that branch pointed at when CI last ran — so a gate keyed on the
 * branch certifies the previous push. Filtering here means that even a caller
 * who passes a branch name gets UNMEASURED rather than a stale PASS.
 */
export function readCi(sha: string, checks: CheckRunSummary[]): CiReading {
  const base = { sha, checks, failed: [] as string[], pending: [] as string[], inconclusive: [] as string[] };

  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ...base, verdict: "UNMEASURED", reason: `"${sha}" is not a commit SHA, so there is nothing to ask CI about — a ref that is not a SHA would be answered about whatever commit it last pointed at` };
  }

  const mine = checks.filter(c => c.headSha === sha);
  const foreign = checks.filter(c => c.headSha !== sha);
  if (mine.length === 0) {
    return {
      ...base,
      verdict: "UNMEASURED",
      reason: foreign.length > 0
        ? `every check found belongs to a different commit (${[...new Set(foreign.map(c => c.headSha))].join(", ")}), not ${sha} — this is the stale reading, not a pass`
        : `no check has been recorded for ${sha} — CI has not reported on this commit, which is not the same as reporting success`,
    };
  }

  const failed = mine.filter(c => c.conclusion !== null && CI_FAILURE_CONCLUSIONS.has(c.conclusion)).map(c => c.name);
  const pending = mine.filter(c => c.status !== "completed").map(c => c.name);
  const inconclusive = mine
    .filter(c => c.status === "completed" && (c.conclusion === null || CI_INCONCLUSIVE_CONCLUSIONS.has(c.conclusion)))
    .map(c => c.name);
  const full = { ...base, checks: mine, failed, pending, inconclusive };

  // A failure first, even with others still running. More waiting cannot
  // un-fail a check, and reporting UNMEASURED here would turn a known red into
  // "we did not find out".
  if (failed.length > 0) {
    return { ...full, verdict: "FAIL", reason: `CI failed on ${sha}: ${failed.join(", ")}` };
  }
  if (pending.length > 0) {
    return { ...full, verdict: "UNMEASURED", reason: `CI has not finished on ${sha} — still running: ${pending.join(", ")}` };
  }
  if (inconclusive.length > 0) {
    return { ...full, verdict: "UNMEASURED", reason: `CI completed on ${sha} without measuring: ${inconclusive.join(", ")} neither passed nor failed` };
  }
  return { ...full, verdict: "PASS", reason: `all ${mine.length} check${mine.length === 1 ? "" : "s"} passed on ${sha}: ${mine.map(c => c.name).join(", ")}` };
}

/** The check runs GitHub has recorded against one commit. */
export async function listCheckRuns(client: GitHubClient, repoSlug: string, sha: string): Promise<CheckRunSummary[]> {
  const { owner, repo } = parseOwnerRepo(repoSlug);
  const response = await client.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 });
  return (response.data?.check_runs ?? []).map((c: any) => ({
    name: String(c.name ?? "<unnamed>"),
    status: String(c.status ?? "unknown"),
    conclusion: c.conclusion === undefined ? null : c.conclusion,
    headSha: String(c.head_sha ?? ""),
    url: typeof c.html_url === "string" ? c.html_url : undefined,
  }));
}

export interface WaitForCiOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Injected so a test can run the loop without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll until CI has an answer for this commit, or until the wait runs out.
 *
 * Polling, and not a webhook, because a local harness has no inbound endpoint
 * for a webhook to arrive at — the choice is not whether to poll but who does
 * and whether the wait is bounded. `gh run watch` polls too, and blocks
 * without a bound.
 *
 * **A timeout returns the last reading, which is UNMEASURED.** It never
 * upgrades to PASS, and it never degrades to FAIL either: running out of
 * patience is not evidence about the code. The returned reason names what was
 * still pending, so the operator can see what it was waiting for.
 */
export async function waitForCi(
  client: GitHubClient,
  repoSlug: string,
  sha: string,
  opts: WaitForCiOptions,
): Promise<CiReading> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + Math.max(0, opts.timeoutMs);
  let reading = readCi(sha, await listCheckRuns(client, repoSlug, sha));

  // Only a pending or absent reading is worth waiting on. A FAIL will not
  // improve, a PASS will not get better, and an inconclusive check has already
  // finished — polling those is time spent to reach the same answer.
  const worthWaiting = (r: CiReading) => r.verdict === "UNMEASURED" && (r.pending.length > 0 || r.checks.length === 0);

  while (worthWaiting(reading) && now() < deadline) {
    await sleep(Math.min(opts.intervalMs, Math.max(0, deadline - now())));
    reading = readCi(sha, await listCheckRuns(client, repoSlug, sha));
  }
  if (worthWaiting(reading)) {
    const waited = Math.round(opts.timeoutMs / 1000);
    return {
      ...reading,
      reason: `${reading.reason} — gave up after ${waited}s, which is a statement about the wait and not about the code`,
    };
  }
  return reading;
}
