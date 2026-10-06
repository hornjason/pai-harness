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
    };
    pulls: {
      create: (params: { owner: string; repo: string; title: string; head: string; base: string; body?: string }) => Promise<{ data: any }>;
      update: (params: { owner: string; repo: string; pull_number: number; [key: string]: any }) => Promise<{ data: any }>;
      list: (params: { owner: string; repo: string; [key: string]: any }) => Promise<{ data: any[] }>;
    };
  };
}

export interface CreatePROptions {
  title: string;
  head: string;
  base: string;
  body?: string;
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
 * Parse "owner/repo" string into { owner, repo } components.
 */
export function parseOwnerRepo(repoSlug: string): { owner: string; repo: string } {
  const parts = repoSlug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${repoSlug}" — expected "owner/repo"`);
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
  });
  return response.data;
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
): Promise<{ number: number; html_url: string; action: "created" | "updated" }> {
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
    return { number: pr.number, html_url: updated.html_url ?? pr.html_url, action: "updated" };
  }
  const created = await createPR(client, repoSlug, opts);
  return { number: created.number, html_url: created.html_url, action: "created" };
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
