/**
 * Tests for lib/github.ts — Octokit-based GitHub client
 *
 * SC-492: test/github-client.test.ts contains [createGitHubClient, addLabels, updatePR, mock]
 *
 * All tests mock HTTP calls — never hit real GitHub API (spec constraint).
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock Octokit before importing the module
const mockIssuesGet = mock(() => Promise.resolve({
  data: { number: 1, title: "Test issue", body: "body", labels: [{ name: "bug" }], state: "open" }
}));
const mockIssuesCreateComment = mock(() => Promise.resolve({
  data: { id: 1, body: "comment" }
}));
const mockIssuesAddLabels = mock(() => Promise.resolve({
  data: [{ name: "shipped" }]
}));
const mockIssuesUpdate = mock(() => Promise.resolve({
  data: { number: 1, state: "closed" }
}));
const mockPullsCreate = mock(() => Promise.resolve({
  data: { number: 10, html_url: "https://github.com/owner/repo/pull/10" }
}));
const mockPullsUpdate = mock(() => Promise.resolve({
  data: { number: 10, html_url: "https://github.com/owner/repo/pull/10" }
}));
const mockPullsList = mock(() => Promise.resolve({
  data: [{ number: 10, head: { ref: "feature-branch" }, title: "PR title" }]
}));

class MockOctokit {
  rest = {
    issues: {
      get: mockIssuesGet,
      createComment: mockIssuesCreateComment,
      addLabels: mockIssuesAddLabels,
      update: mockIssuesUpdate,
    },
    pulls: {
      create: mockPullsCreate,
      update: mockPullsUpdate,
      list: mockPullsList,
    },
  };
  constructor(_opts?: any) {}
}

// We need to mock the module
mock.module("@octokit/rest", () => ({
  Octokit: MockOctokit,
}));

// Now import the module under test
const {
  createGitHubClient,
  getIssue,
  addComment,
  addLabels,
  createPR,
  updatePR,
  listPRs,
  closeIssue,
  parseOwnerRepo,
} = await import("../lib/github");

describe("lib/github.ts", () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    // Set a fake token so createGitHubClient() doesn't throw
    process.env.GITHUB_TOKEN = "test-token-for-mocked-octokit";
    mockIssuesGet.mockClear();
    mockIssuesCreateComment.mockClear();
    mockIssuesAddLabels.mockClear();
    mockIssuesUpdate.mockClear();
    mockPullsCreate.mockClear();
    mockPullsUpdate.mockClear();
    mockPullsList.mockClear();
  });

  describe("createGitHubClient", () => {
    test("creates Octokit instance with GITHUB_TOKEN", () => {
      // beforeEach sets GITHUB_TOKEN
      const client = createGitHubClient();
      expect(client).toBeDefined();
      expect(client.rest).toBeDefined();
    });

    test("throws if GITHUB_TOKEN is not set", () => {
      const saved = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      try {
        expect(() => createGitHubClient()).toThrow("GITHUB_TOKEN");
      } finally {
        process.env.GITHUB_TOKEN = saved || "test-token-for-mocked-octokit";
      }
    });
  });

  describe("parseOwnerRepo", () => {
    test("parses owner/repo format", () => {
      const result = parseOwnerRepo("hornjason/pai-harness");
      expect(result).toEqual({ owner: "hornjason", repo: "pai-harness" });
    });

    test("throws on invalid format", () => {
      expect(() => parseOwnerRepo("invalid")).toThrow();
    });
  });

  describe("getIssue", () => {
    test("fetches issue by number", async () => {
      const client = createGitHubClient();
      const issue = await getIssue(client, "owner/repo", 1);
      expect(issue.number).toBe(1);
      expect(issue.title).toBe("Test issue");
      expect(mockIssuesGet).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issue_number: 1,
      });
    });
  });

  describe("addComment", () => {
    test("posts comment to issue", async () => {
      const client = createGitHubClient();
      await addComment(client, "owner/repo", 1, "Test comment");
      expect(mockIssuesCreateComment).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issue_number: 1,
        body: "Test comment",
      });
    });
  });

  describe("addLabels", () => {
    test("adds labels to issue using POST (additive, not replace)", async () => {
      const client = createGitHubClient();
      await addLabels(client, "owner/repo", 1, ["shipped", "verified"]);
      // SC-493: Uses POST additive label strategy — issues.addLabels is POST by design
      expect(mockIssuesAddLabels).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issue_number: 1,
        labels: ["shipped", "verified"],
      });
    });

    test("works with single label", async () => {
      const client = createGitHubClient();
      await addLabels(client, "owner/repo", 42, ["proven"]);
      expect(mockIssuesAddLabels).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issue_number: 42,
        labels: ["proven"],
      });
    });
  });

  describe("closeIssue", () => {
    test("closes issue by setting state to closed", async () => {
      const client = createGitHubClient();
      await closeIssue(client, "owner/repo", 1);
      expect(mockIssuesUpdate).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issue_number: 1,
        state: "closed",
      });
    });
  });

  describe("createPR", () => {
    test("creates pull request", async () => {
      const client = createGitHubClient();
      const pr = await createPR(client, "owner/repo", {
        title: "feat: test PR",
        head: "feature-branch",
        base: "main",
        body: "PR description",
      });
      expect(pr.number).toBe(10);
      expect(mockPullsCreate).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        title: "feat: test PR",
        head: "feature-branch",
        base: "main",
        body: "PR description",
      });
    });
  });

  describe("updatePR", () => {
    test("updates existing pull request", async () => {
      const client = createGitHubClient();
      await updatePR(client, "owner/repo", 10, {
        title: "updated title",
        body: "updated body",
      });
      expect(mockPullsUpdate).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        pull_number: 10,
        title: "updated title",
        body: "updated body",
      });
    });
  });

  describe("listPRs", () => {
    test("lists pull requests with filters", async () => {
      const client = createGitHubClient();
      const prs = await listPRs(client, "owner/repo", { state: "open", head: "feature-branch" });
      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(10);
      expect(mockPullsList).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "owner",
          repo: "repo",
          state: "open",
          head: "feature-branch",
        })
      );
    });

    test("lists pull requests without filters", async () => {
      const client = createGitHubClient();
      await listPRs(client, "owner/repo");
      expect(mockPullsList).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "owner",
          repo: "repo",
        })
      );
    });
  });
});
