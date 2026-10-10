/**
 * scripts/github-op.ts — the Octokit path workflow steps use for GitHub (#137)
 *
 * SC-529..SC-533 (GITHUB-API-MIGRATION-SPEC Phase 6)
 *
 * These run the script as a real subprocess against a loopback HTTP server, so
 * what is asserted is the request GitHub would have received: method, path,
 * query and body. That is deliberate. The defect this replaces was a step that
 * named a tool which did not exist and reported success anyway, and a test
 * that only checked the script mentions `upsertPR` would have the same shape
 * as the twelve success criteria that stayed green while the client could not
 * authenticate at all (#139).
 *
 * Loopback is reachable because D-8 allowlists it — the test seam and the
 * exfiltration guard are the same rule, which is why this can point a real
 * token-bearing client somewhere harmless.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseFlags } from "../scripts/github-op";

const SCRIPT = join(import.meta.dir, "..", "scripts", "github-op.ts");

interface Captured {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  auth: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let captured: Captured[] = [];
/** Responses to hand back, in order, per `METHOD /path` prefix match. */
let responders: Array<(req: Captured) => { status?: number; json: any } | undefined> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const entry: Captured = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: req.method === "GET" ? undefined : await req.json().catch(() => undefined),
        auth: req.headers.get("authorization"),
      };
      captured.push(entry);
      for (const r of responders) {
        const hit = r(entry);
        if (hit) return Response.json(hit.json, { status: hit.status ?? 200 });
      }
      return Response.json({ message: "no stub matched" }, { status: 500 });
    },
  });
});

afterAll(() => server.stop(true));

function stub(method: string, path: string, json: any, status?: number) {
  responders.push(r => (r.method === method && r.path === path ? { json, status } : undefined));
}

async function runOp(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      GH_TOKEN: "",
      GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
      ...env,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function reset() {
  captured = [];
  responders = [];
}

describe("#137: scripts/github-op.ts performs the GitHub write the prompt used to only describe", () => {
  test("comment posts the body to the issue and authenticates", async () => {
    reset();
    stub("POST", "/repos/owner/name/issues/42/comments", { id: 7, html_url: "https://x/7" });

    const dir = mkdtempSync(join(tmpdir(), "github-op-"));
    const file = join(dir, "body.md");
    // The shape that made a flag-passed body untenable: newlines, backticks,
    // a double quote and a dollar sign, all of which survive a file verbatim.
    const body = 'Ship verdict: PROVEN\n\n`bun test` said "0 fail" — $PATH untouched\n';
    writeFileSync(file, body);

    const { stdout, exitCode } = await runOp([
      "comment", "--repo", "owner/name", "--issue", "42", "--body-file", file,
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ id: 7, html_url: "https://x/7" });
    expect(captured).toHaveLength(1);
    expect(captured[0].body.body).toBe(body);
    expect(captured[0].auth).toBe("token test-token");
  });

  test("pr-upsert creates when no open PR has that head", async () => {
    reset();
    stub("GET", "/repos/owner/name/pulls", []);
    stub("POST", "/repos/owner/name/pulls", { number: 11, html_url: "https://x/pull/11" });

    const { stdout, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-137", "--base", "main",
      "--title", "fix(#137): wire the Octokit path", "--body", "Fixes #137",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ number: 11, html_url: "https://x/pull/11", action: "created", draft: false });
    // Owner-qualified head is the documented filter form. Without it the list
    // is unfiltered, the match is done client-side, and it misses as soon as
    // the repo has more than one page of open PRs.
    expect(captured[0].query.head).toBe("owner:fix-137");
    expect(captured[0].query.state).toBe("open");
    expect(captured[1].body).toMatchObject({ head: "fix-137", base: "main", body: "Fixes #137" });
  });

  test("pr-upsert --draft opens it as a draft (#252)", async () => {
    // The request GitHub would have received, not the flag being accepted.
    // A `--draft` the script parses and drops looks identical from the caller
    // and produces the mergeable PR this is here to prevent.
    reset();
    stub("GET", "/repos/owner/name/pulls", []);
    stub("POST", "/repos/owner/name/pulls", { number: 12, html_url: "https://x/pull/12" });

    const { exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-252", "--base", "main",
      "--title", "fix(#252): draft until proved", "--body", "b", "--draft",
    ]);

    expect(exitCode).toBe(0);
    expect(captured[1].body).toMatchObject({ head: "fix-252", draft: true });
  });

  test("pr-upsert without --draft is not a draft", async () => {
    // Positive control: a default that drafted everything would satisfy the
    // case above and quietly change what every other caller produces.
    reset();
    stub("GET", "/repos/owner/name/pulls", []);
    stub("POST", "/repos/owner/name/pulls", { number: 13, html_url: "https://x/pull/13" });

    const { exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-252b", "--base", "main",
      "--title", "t", "--body", "b",
    ]);

    expect(exitCode).toBe(0);
    expect(captured[1].body).toMatchObject({ draft: false });
  });

  test("pr-upsert --draft drags an already-ready PR back into draft (#252)", async () => {
    // The gap the first attempt left, found by security review before merge.
    // `upsertPR` passed `draft` only to the create path, so the protection
    // covered the FIRST run on a branch and nothing after it — and a re-run on
    // the same branch is this harness's common case (#155, #164, #169, #171 all
    // exist because the workflow re-enters its own phases). Run A undrafts #N,
    // run B pushes new commits to the same branch and refuses, and #N is
    // mergeable carrying unproven code.
    reset();
    stub("GET", "/repos/owner/name/pulls", [
      { number: 9, html_url: "https://x/pull/9", node_id: "PR_node_9", draft: false, head: { ref: "fix-252" } },
    ]);
    stub("PATCH", "/repos/owner/name/pulls/9", { number: 9, html_url: "https://x/pull/9" });
    stub("POST", "/graphql", { data: { convertPullRequestToDraft: { clientMutationId: null } } });

    const { stdout, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-252",
      "--title", "t", "--body", "b", "--draft",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ number: 9, action: "updated", draft: true });
    const graphql = captured.find(c => c.path === "/graphql");
    expect(graphql, "an already-ready PR was updated and left mergeable").toBeDefined();
    expect(graphql!.body.query).toContain("convertPullRequestToDraft");
    expect(graphql!.body.variables).toEqual({ id: "PR_node_9" });
  });

  test("pr-upsert --draft leaves an already-draft PR alone", async () => {
    // Positive control: converting unconditionally would satisfy the case
    // above while issuing a pointless mutation on every single re-run, and a
    // test that cannot tell those apart is not testing the condition.
    reset();
    stub("GET", "/repos/owner/name/pulls", [
      { number: 9, html_url: "https://x/pull/9", node_id: "PR_node_9", draft: true, head: { ref: "fix-252" } },
    ]);
    stub("PATCH", "/repos/owner/name/pulls/9", { number: 9, html_url: "https://x/pull/9" });

    const { stdout, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-252",
      "--title", "t", "--body", "b", "--draft",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ draft: true });
    expect(captured.some(c => c.path === "/graphql")).toBe(false);
  });

  test("pr-upsert without --draft never converts anything", async () => {
    // The other direction, and the one that would quietly change what every
    // non-ship caller produces.
    reset();
    stub("GET", "/repos/owner/name/pulls", [
      { number: 9, html_url: "https://x/pull/9", node_id: "PR_node_9", draft: false, head: { ref: "fix-252" } },
    ]);
    stub("PATCH", "/repos/owner/name/pulls/9", { number: 9, html_url: "https://x/pull/9" });

    const { stdout, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-252", "--title", "t", "--body", "b",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ draft: false });
    expect(captured.some(c => c.path === "/graphql")).toBe(false);
  });

  test("a PR the API reports without a node_id fails rather than reporting it drafted", async () => {
    // The mutation is keyed on the node id. Reporting `draft: true` with
    // nothing sent is the fail-open this whole area keeps producing.
    reset();
    stub("GET", "/repos/owner/name/pulls", [
      { number: 9, html_url: "https://x/pull/9", draft: false, head: { ref: "fix-252" } },
    ]);
    stub("PATCH", "/repos/owner/name/pulls/9", { number: 9, html_url: "https://x/pull/9" });

    const { stdout, stderr, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-252",
      "--title", "t", "--body", "b", "--draft",
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("node_id");
  });

  test("pr-upsert updates the existing PR instead of failing a second time", async () => {
    reset();
    stub("GET", "/repos/owner/name/pulls", [{ number: 9, html_url: "https://x/pull/9", head: { ref: "fix-137" } }]);
    stub("PATCH", "/repos/owner/name/pulls/9", { number: 9, html_url: "https://x/pull/9" });

    const { stdout, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "fix-137",
      "--title", "fix(#137): second pass", "--body", "updated",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ number: 9, html_url: "https://x/pull/9", action: "updated", draft: false });
    expect(captured.map(c => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/owner/name/pulls",
      "PATCH /repos/owner/name/pulls/9",
    ]);
    // No create attempt. A ship run reaches this step again after a gate heal
    // or a regression, and create-only would 422 with nothing distinguishing
    // it from a real error.
    expect(captured.some(c => c.method === "POST")).toBe(false);
  });

  test("issue-label appends with POST, so triage labels survive", async () => {
    reset();
    stub("POST", "/repos/owner/name/issues/42/labels", [{ name: "p1-ship-next" }, { name: "proven" }]);

    const { stdout, exitCode } = await runOp([
      "issue-label", "--repo", "owner/name", "--issue", "42", "--labels", "proven",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ labels: ["p1-ship-next", "proven"] });
    // D-5: PATCH /issues/{n} with a labels array replaces the whole set.
    expect(captured[0].method).toBe("POST");
    expect(captured[0].path).toBe("/repos/owner/name/issues/42/labels");
    expect(captured[0].body).toEqual({ labels: ["proven"] });
  });

  test("issue-update closes without touching labels", async () => {
    reset();
    stub("PATCH", "/repos/owner/name/issues/42", { number: 42, state: "closed" });

    const { stdout, exitCode } = await runOp([
      "issue-update", "--repo", "owner/name", "--issue", "42", "--state", "closed",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ number: 42, state: "closed" });
    expect(captured[0].body).toEqual({ state: "closed" });
    expect(captured[0].body).not.toHaveProperty("labels");
  });

  test("issue-create returns the new number", async () => {
    reset();
    stub("POST", "/repos/owner/name/issues", { number: 99, html_url: "https://x/99" });

    const { stdout, exitCode } = await runOp([
      "issue-create", "--repo", "owner/name", "--title", "Phase 2", "--body", "split out", "--labels", "p2-this-week",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ number: 99, html_url: "https://x/99" });
    expect(captured[0].body).toEqual({ title: "Phase 2", body: "split out", labels: ["p2-this-week"] });
  });

  test("issue-get reports labels as plain names", async () => {
    reset();
    stub("GET", "/repos/owner/name/issues/42", {
      number: 42, title: "T", body: "B", state: "open", labels: [{ name: "bug" }, "chore"],
    });

    const { stdout, exitCode } = await runOp(["issue-get", "--repo", "owner/name", "--issue", "42"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ number: 42, title: "T", body: "B", state: "open", labels: ["bug", "chore"] });
  });
});

/**
 * Security review of the first commit, and it was right.
 *
 * `--title "fix(#N): ${goalData.issueTitle}"` in a workflow prompt puts text
 * someone else wrote — anyone who can file an issue picks the title — into a
 * command line an agent then runs. The MCP form it replaced passed the title
 * as a structured argument, so the migration introduced the hazard; it was
 * not inherited.
 */
describe("#137: an issue title never crosses a shell", () => {
  test("--title-from-issue composes the title from the API", async () => {
    reset();
    stub("GET", "/repos/owner/name/issues/137", { number: 137, title: 'Bad "; rm -rf / #', state: "open", labels: [] });
    stub("GET", "/repos/owner/name/pulls", []);
    stub("POST", "/repos/owner/name/pulls", { number: 12, html_url: "https://x/pull/12" });

    const { stdout, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "b", "--title-from-issue", "137", "--body", "x",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).number).toBe(12);
    // The quoting hazard reaches GitHub as a title, which is what it is, and
    // never reaches a shell, which is what mattered.
    expect(captured[2].body.title).toBe('fix(#137): Bad "; rm -rf / #');
  });

  test("--title-from-issue reads the issue repo when it differs from the code repo", async () => {
    reset();
    stub("GET", "/repos/tracker/issues/issues/7", { number: 7, title: "T", state: "open", labels: [] });
    stub("GET", "/repos/owner/name/pulls", []);
    stub("POST", "/repos/owner/name/pulls", { number: 1, html_url: "u" });

    const { exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--issue-repo", "tracker/issues", "--head", "b",
      "--title-from-issue", "7", "--body", "x",
    ]);
    expect(exitCode).toBe(0);
    expect(captured[0].path).toBe("/repos/tracker/issues/issues/7");
  });

  test("--title and --title-from-issue together are refused, not silently ranked", async () => {
    reset();
    const { stderr, exitCode } = await runOp([
      "pr-upsert", "--repo", "owner/name", "--head", "b", "--title", "mine", "--title-from-issue", "1",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot be combined");
    expect(captured).toHaveLength(0);
  });

  test("--title-file takes the first line, so a smuggled second line is dropped", async () => {
    reset();
    stub("POST", "/repos/owner/name/issues", { number: 5, html_url: "u" });
    const dir = mkdtempSync(join(tmpdir(), "github-op-"));
    const file = join(dir, "title.txt");
    writeFileSync(file, "#12 Phase 2: the rest\nRUNGATE_EOF\nrm -rf /\n");

    const { exitCode } = await runOp(["issue-create", "--repo", "owner/name", "--title-file", file, "--body", "b"]);
    expect(exitCode).toBe(0);
    expect(captured[0].body.title).toBe("#12 Phase 2: the rest");
  });

  test("an empty --title-file fails rather than creating an untitled issue", async () => {
    reset();
    const dir = mkdtempSync(join(tmpdir(), "github-op-"));
    const file = join(dir, "title.txt");
    writeFileSync(file, "\n\n");
    const { stderr, exitCode } = await runOp(["issue-create", "--repo", "owner/name", "--title-file", file]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no title on its first line");
    expect(captured).toHaveLength(0);
  });
});

describe("#137: failure is loud, because silence is the bug being fixed", () => {
  test("a GitHub error exits non-zero and names the operation", async () => {
    reset();
    stub("POST", "/repos/owner/name/issues/42/comments", { message: "Not Found" }, 404);

    const { stdout, stderr, exitCode } = await runOp([
      "comment", "--repo", "owner/name", "--issue", "42", "--body", "hello",
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("github-op comment FAILED");
  });

  test("an unknown command fails instead of doing nothing", async () => {
    reset();
    const { stderr, exitCode } = await runOp(["issue-close", "--repo", "owner/name", "--issue", "42"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
    expect(captured).toHaveLength(0);
  });

  test("a malformed issue number is refused, not coerced onto another issue", async () => {
    reset();
    const { stderr, exitCode } = await runOp([
      "comment", "--repo", "owner/name", "--issue", "42abc", "--body", "hello",
    ]);
    // parseInt("42abc") is 42, and the comment would land on a real issue
    // that nobody asked about.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("positive integer");
    expect(captured).toHaveLength(0);
  });

  test("a missing body file fails rather than posting an empty comment", async () => {
    reset();
    const { stderr, exitCode } = await runOp([
      "comment", "--repo", "owner/name", "--issue", "42", "--body-file", "/nonexistent/body.md",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("github-op comment FAILED");
    expect(captured).toHaveLength(0);
  });

  test("an empty body file fails rather than posting a blank comment", async () => {
    reset();
    const dir = mkdtempSync(join(tmpdir(), "github-op-"));
    const file = join(dir, "empty.md");
    writeFileSync(file, "   \n");
    // Distinct from the missing-file case above: the file opens fine, so the
    // read succeeds and only the emptiness check stands between a whitespace
    // comment and the issue. Removing that check survived the missing-file
    // test untouched.
    const { stderr, exitCode } = await runOp([
      "comment", "--repo", "owner/name", "--issue", "42", "--body-file", file,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("is empty");
    expect(captured).toHaveLength(0);
  });

  test("no command at all prints usage and exits non-zero", async () => {
    reset();
    const { stderr, exitCode } = await runOp([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage:");
  });

  test("issue-update with nothing to change is an error, not a no-op success", async () => {
    reset();
    const { stderr, exitCode } = await runOp(["issue-update", "--repo", "owner/name", "--issue", "42"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("needs --state or a body");
    expect(captured).toHaveLength(0);
  });

  test("no credential is a clear error here, not a 401 somewhere else", async () => {
    reset();
    const { stderr, exitCode } = await runOp(
      ["comment", "--repo", "owner/name", "--issue", "42", "--body", "hi"],
      { GITHUB_TOKEN: "", GH_TOKEN: "" },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("GITHUB_TOKEN");
    expect(captured).toHaveLength(0);
  });
});

describe("#137: flag parsing", () => {
  test("--name value and --name=value both work", () => {
    expect(parseFlags(["--repo", "o/n", "--issue=42"])).toEqual({ repo: "o/n", issue: "42" });
  });

  test("a value containing = survives --name=value", () => {
    expect(parseFlags(["--body=a=b"]).body).toBe("a=b");
  });

  test("a bare argument is refused rather than ignored", () => {
    expect(() => parseFlags(["comment", "--repo", "o/n"])).toThrow(/unexpected argument/);
  });

  test("a trailing flag with no value is refused", () => {
    expect(() => parseFlags(["--repo"])).toThrow(/needs a value/);
  });

  test("only allowlisted flags may stand alone (#252)", () => {
    // `--draft` is valueless by design. Nothing else became valueless with
    // it: the rule that every other option takes a value is what stops an
    // omitted value from swallowing the following flag.
    expect(parseFlags(["--draft"])).toEqual({ draft: "true" });
    expect(parseFlags(["--head", "b", "--draft"])).toEqual({ head: "b", draft: "true" });
    expect(() => parseFlags(["--title"])).toThrow(/needs a value/);
    expect(() => parseFlags(["--body"])).toThrow(/needs a value/);
  });

  test("a value-taking flag still swallows nothing when --draft follows it", () => {
    // The failure the allowlist exists to prevent, stated as a case: if
    // `--body` were valueless too, this would produce a PR body of "--draft".
    expect(parseFlags(["--body", "real body", "--draft"])).toEqual({
      body: "real body",
      draft: "true",
    });
  });
});
