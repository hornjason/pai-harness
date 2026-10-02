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
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set — required for GitHub API access");
  }
  return new Octokit({ auth: token }) as unknown as GitHubClient;
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
