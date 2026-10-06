/**
 * Tests for lib/github.ts — Octokit-based GitHub client
 *
 * SC-492: test/github-client.test.ts contains [createGitHubClient, addLabels, updatePR, mock]
 *
 * All tests mock HTTP calls — never hit real GitHub API (spec constraint).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

/**
 * The options the most recent Octokit construction received. #139 is about
 * which token reaches the client, so the tests need to see the value, not
 * just whether the constructor was reached.
 */
let lastOctokitOptions: any = null;

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
  constructor(opts?: any) {
    lastOctokitOptions = opts ?? null;
  }
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

    test("throws if no token is set under any name", () => {
      // Both names, deliberately. This used to clear GITHUB_TOKEN only, which
      // made the test's meaning depend on whether the developer's shell
      // happened to export GH_TOKEN — green here, red on Jason's machine,
      // for a reason the diff would not explain.
      const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      try {
        expect(() => createGitHubClient()).toThrow("GITHUB_TOKEN");
      } finally {
        process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN || "test-token-for-mocked-octokit";
        if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = saved.GH_TOKEN;
      }
    });

    /**
     * #139: the client authenticated from GITHUB_TOKEN alone, and nothing sets
     * it. `gh auth status` on this machine reports the account is authenticated
     * via GH_TOKEN, so every Octokit call in the repo threw at construction —
     * silently in `gates/orchestrator.ts` and `hooks/IssueCloseGuard.hook.ts`,
     * loudly in the prove gate.
     *
     * D-3 of GITHUB-API-MIGRATION-SPEC justified the single name with "Already
     * set by `gh` CLI auth". It is not. The design decision rested on an
     * unchecked premise, which is why no test caught it.
     */
    describe("#139: token resolution across both conventional names", () => {
      const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

      const setEnv = (vars: Record<string, string | undefined>) => {
        for (const [k, v] of Object.entries(vars)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      };

      afterEach(() => setEnv(saved));

      test("GH_TOKEN alone is sufficient — the real environment today", () => {
        setEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: "gh-token-value" });
        expect(() => createGitHubClient()).not.toThrow();
      });

      test("GITHUB_TOKEN alone is still sufficient", () => {
        setEnv({ GITHUB_TOKEN: "github-token-value", GH_TOKEN: undefined });
        expect(() => createGitHubClient()).not.toThrow();
      });

      test("GITHUB_TOKEN wins when both are set", () => {
        // Order matters for anyone who exports a scoped GITHUB_TOKEN to
        // override a broader ambient GH_TOKEN. Assert the auth value itself,
        // not merely that construction succeeded — "it did not throw" is true
        // for either precedence and would pass whichever one we picked.
        setEnv({ GITHUB_TOKEN: "specific", GH_TOKEN: "ambient" });
        createGitHubClient();
        expect(lastOctokitOptions?.auth).toBe("specific");
      });

      test("an empty token is treated as absent, not as a credential", () => {
        // `GH_TOKEN=""` is what an unset-but-exported variable looks like.
        setEnv({ GITHUB_TOKEN: "", GH_TOKEN: "" });
        expect(() => createGitHubClient()).toThrow("GITHUB_TOKEN");
      });

      test("a whitespace-only token is treated as absent too", () => {
        // This is the case that actually exercises the trim. The empty-string
        // test above does not: `""` is falsy, so it throws on the plain
        // truthiness check whether or not the value is trimmed, and a
        // mutation removing the trim survived it. `"  "` is truthy, so
        // without the trim it reaches Octokit as a credential and the
        // request 401s somewhere far from the cause.
        setEnv({ GITHUB_TOKEN: "   ", GH_TOKEN: "\t\n" });
        expect(() => createGitHubClient()).toThrow("GITHUB_TOKEN");
      });

      /**
       * D-8 is an endpoint redirect that carries a bearer token, so it is
       * constrained rather than taken at face value. Raised by security
       * review of this change: plaintext to a remote host puts the
       * credential on the wire in the clear.
       *
       * Not a full allowlist, and not pretending to be one — anyone who can
       * set this variable can usually read the token out of the same
       * environment. The aim is to stop accidental and passive exposure.
       */
      describe("D-8: GITHUB_API_URL cannot redirect the token into plaintext", () => {
        const withBase = (base: string | undefined) => {
          setEnv({ GITHUB_TOKEN: "t", GH_TOKEN: undefined, GITHUB_API_URL: base });
          return () => createGitHubClient();
        };

        afterEach(() => setEnv({ ...saved, GITHUB_API_URL: undefined }));

        test("https to any host is accepted", () => {
          expect(withBase("https://ghe.example.com/api/v3")).not.toThrow();
          expect(lastOctokitOptions?.baseUrl).toBe("https://ghe.example.com/api/v3");
        });

        test("http on loopback is accepted — it cannot leave the machine", () => {
          expect(withBase("http://127.0.0.1:1")).not.toThrow();
          expect(lastOctokitOptions?.baseUrl).toBe("http://127.0.0.1:1");
        });

        test.each([
          ["a remote host over plaintext", "http://evil.example.com"],
          ["a bare IP over plaintext", "http://203.0.113.9:8080"],
        ])("%s is refused", (_label, base) => {
          expect(withBase(base)).toThrow(/https/);
        });

        test("a malformed value is refused rather than silently ignored", () => {
          // Ignoring it would quietly fall back to the real API, which is the
          // opposite of what someone setting this variable intended.
          expect(withBase("not a url")).toThrow(/not a valid URL/);
        });

        test("unset means Octokit's own default, with no baseUrl forced", () => {
          expect(withBase(undefined)).not.toThrow();
          expect(lastOctokitOptions?.baseUrl).toBeUndefined();
        });
      });

      test("surrounding whitespace is stripped from the credential", () => {
        // `GH_TOKEN=$(cat token)` keeps the file's trailing newline, which
        // Octokit puts straight into the Authorization header. The result is
        // a 401 with nothing in it pointing at whitespace, so strip it here
        // where the cause is still visible.
        setEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: "  gho_realtoken\n" });
        createGitHubClient();
        expect(lastOctokitOptions?.auth).toBe("gho_realtoken");
      });
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
