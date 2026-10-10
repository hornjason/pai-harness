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
const mockPullsGet = mock(() => Promise.resolve({
  data: { number: 10, node_id: "PR_node_10", draft: true }
}));
const mockGraphql = mock((_q: string, _v?: any) => Promise.resolve({}));

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
      get: mockPullsGet,
      update: mockPullsUpdate,
      list: mockPullsList,
    },
  };
  graphql = mockGraphql;
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
  markPRReady,
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
    mockPullsGet.mockClear();
    mockGraphql.mockClear();
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

        test.each([
          ["http://127.0.0.1:1"],
          ["http://localhost:8080"],
          ["https://127.0.0.1:9"],
        ])("loopback %s is accepted — it cannot leave the machine", base => {
          expect(withBase(base)).not.toThrow();
          expect(lastOctokitOptions?.baseUrl).toBe(base);
        });

        test.each([
          ["plaintext to a remote host", "http://evil.example.com"],
          ["a bare remote IP", "http://203.0.113.9:8080"],
          // The one that matters most, and the one an earlier version of this
          // allowed: https does not make exfiltration safe, it makes it tidy.
          ["https to a remote host", "https://evil.example.com/api/v3"],
          ["a GHES-shaped host, which is a separate decision", "https://ghe.example.com/api/v3"],
          // `127.0.0.1.evil.com` and `localhost.evil.com` resolve remotely.
          ["a hostname that merely starts with a loopback name", "http://127.0.0.1.evil.com"],
          ["a hostname that merely contains localhost", "https://localhost.evil.com"],
          // Userinfo trick: the real host is after the @.
          ["a loopback name in the userinfo", "https://127.0.0.1@evil.com"],
        ])("%s is refused", (_label, base) => {
          expect(withBase(base)).toThrow(/loopback/);
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

    /**
     * Raised by security review of #137 and confirmed by measurement against
     * a loopback server, not by reading the Octokit source:
     *
     *     --repo "owner/.."  ->  GET /repos/issues/7
     *     --repo "../x"      ->  GET /x/issues/7
     *
     * The second escapes `/repos/` entirely, which is arbitrary API-path
     * construction with whatever verb the operation uses. Query strings and
     * fragments were already percent-encoded on the way out, so traversal is
     * the whole of the hole.
     */
    describe("a slug cannot steer the request path (#137)", () => {
      test.each([
        ["a parent segment as the repo", "owner/.."],
        ["a parent segment as the owner", "../x"],
        ["a current-directory segment", "owner/."],
        ["an encoded traversal", "owner/name%2f..%2f.."],
        ["a slash inside, making three parts", "owner/name/extra"],
        ["a space", "owner/na me"],
        ["a query string", "owner/na?x=1"],
        ["an empty owner", "/name"],
        ["an empty repo", "owner/"],
      ])("%s is refused", (_label, slug) => {
        expect(() => parseOwnerRepo(slug)).toThrow(/Invalid repo format/);
      });

      test.each([
        ["hornjason/pai-harness"],
        ["owner/repo.js"],
        ["Owner-1/repo_name"],
        ["a/b"],
      ])("%s is still accepted — real names must keep working", slug => {
        expect(() => parseOwnerRepo(slug)).not.toThrow();
      });
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
        draft: false,
      });
    });

    test("creates a DRAFT when asked (#252)", async () => {
      // Run wf_e105dd33-220 reported SHIP_FAILED and left PR #250 open, not
      // draft, and `mergeable: MERGEABLE` — carrying code that destroyed a
      // consumer's CI. ship.js opens the PR BEFORE the ship gate, the grade
      // check and two staleness refusals, so every one of those can fail after
      // the PR is already reviewable. Opening it draft and marking it ready at
      // the end makes the artefact agree with the verdict by construction,
      // rather than by a cleanup step that itself has to run.
      const client = createGitHubClient();
      await createPR(client, "owner/repo", {
        title: "feat: test PR",
        head: "feature-branch",
        base: "main",
        body: "PR description",
        draft: true,
      });
      expect(mockPullsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true }),
      );
    });
  });

  describe("markPRReady (#252)", () => {
    test("uses the GraphQL mutation, because REST cannot flip draft", async () => {
      // PATCH /pulls/{n} accepts a `draft` field and ignores it. A caller that
      // went through updatePR would get a 200, report success, and leave the
      // PR a draft — the silent fail-open this whole area keeps producing.
      const client = createGitHubClient();
      const out = await markPRReady(client, "owner/repo", 10);
      expect(out).toEqual({ number: 10, isDraft: false });
      expect(mockGraphql).toHaveBeenCalled();
      const [query, vars] = (mockGraphql.mock.calls[0] as any[]);
      expect(query).toContain("markPullRequestReadyForReview");
      expect(vars).toEqual({ id: "PR_node_10" });
      expect(mockPullsUpdate, "the REST path was used and would have no effect").not.toHaveBeenCalled();
    });

    test("a PR with no node_id throws rather than reporting it ready", async () => {
      // The mutation is keyed on the node id. Without one there is nothing to
      // send, and returning `isDraft: false` anyway would make a run claim it
      // had undrafted a PR that is still a draft.
      mockPullsGet.mockImplementationOnce(() => Promise.resolve({ data: { number: 10 } }) as any);
      const client = createGitHubClient();
      await expect(markPRReady(client, "owner/repo", 10)).rejects.toThrow(/node_id/);
      expect(mockGraphql).not.toHaveBeenCalled();
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
