/**
 * Routing a finding to the pull request that is holding the file (#1343).
 *
 * ## The corpus is real and is dated
 *
 * `OPEN_PRS` below is the live open-PR set of `hornjason/pai-harness`,
 * recorded 2026-10-23 with one command:
 *
 *     gh pr list --repo hornjason/pai-harness --state open --limit 100 \
 *       --json number,changedFiles,files
 *
 * It is stored rather than fetched because #1365 is open about exactly this:
 * the arbiter's two tuning tables were measured against a tracker that has
 * since moved, no corpus was kept, and neither constant can be re-derived by
 * anybody — including anybody who disagrees with them. A routing rule tuned
 * against a tracker is the same trap, so the tracker is pinned here. The
 * reading it supports is a reading of 2026-10-23 and says so.
 *
 * It is already stale in the way that matters, and that is the point: #1370
 * was open in the first `gh pr list` of this session and MERGED in the second,
 * thirty seconds later. A finding routed to the tracker about a file somebody
 * is editing is racing exactly that.
 *
 * ## The two exemplars are the ones that motivated the issue
 *
 * Both verified against the tracker before being written down, by reading the
 * blocking payload off the pull request rather than from anyone's description:
 *
 * | PR | its diff | the blocking finding names | lives in |
 * |---|---|---|---|
 * | #1393 | `lib/finding-arbiter.ts` + its test | `high` on `lib/ai-review-rounds.ts` | #1410 |
 * | #1354 | `lib/cli-commands.ts`, `lib/scaffold/ai-review-findings.ts`, a test | `critical` on `lib/bash-write-guard.ts` | #1361 AND #1411 |
 *
 * The second one is not the clean case the issue predicted and it is kept as
 * the exemplar anyway: TWO open pull requests are editing
 * `lib/bash-write-guard.ts`, so there is no single right home and naming both
 * is the only answer that is not a guess. A router that returned one of them
 * would look better and be wrong.
 *
 * ## The battery
 *
 * `MUTANTS` copies `lib/finding-pr-routing.ts` into a temp directory, applies
 * ONE textual mutation, and runs every case above against it. Each mutation
 * declares the case ids it must redden BEFORE the run, and the assertion is on
 * the SET, not the count (`.claude/rules/checks-must-be-able-to-fail.md`,
 * seventh shape). The first row is the status quo this issue replaces — route
 * everything to the tracker — which is the RED baseline this suite was watched
 * against before `routePaths` had a body.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { symptomKeys, type Finding } from "../lib/finding-arbiter";
import {
  citedPathsFromKeys,
  normalisePath,
  pathMatches,
  routePaths,
  routingSummary,
  type OpenPrCorpus,
  type OpenPullRequest,
  type Route,
  type RouteOptions,
  type Routing,
} from "../lib/finding-pr-routing";

const SOURCE = join(import.meta.dir, "..", "lib", "finding-pr-routing.ts");

/** One PR row, with GitHub's own file count so nothing here is truncated. */
function pr(number: number, ...files: string[]): OpenPullRequest {
  return { number, files, declaredFileCount: files.length };
}

/** `hornjason/pai-harness`, open pull requests, 2026-10-23. */
const OPEN_PRS: readonly OpenPullRequest[] = [
  pr(1411, "lib/bash-write-guard.ts", "test/bash-write-guard.test.ts"),
  pr(1410, "lib/ai-review-rounds.ts", "test/ai-review-ledger-read.test.ts"),
  pr(1399, ".github/workflows/ai-review.yml", "lib/scaffold/ai-review-step.ts", "test/ai-review-ledger-step.test.ts"),
  pr(1397, "evals/ai-review-control/baselines/single-adjudicator-variance.json", "evals/ai-review-control/variance-capture.ts", "test/single-adjudicator-variance.test.ts"),
  pr(1393, "lib/finding-arbiter.ts", "test/finding-arbiter.test.ts"),
  pr(1391, ".github/workflows/ai-review.yml", "lib/scaffold/ai-review-step.ts", "lib/scaffold/steps.ts", "test/ai-review-credentialed-job.test.ts", "test/ai-review-route-reading.test.ts", "test/ai-review-untrusted-restore.test.ts", "test/ai-review-workflow.test.ts"),
  pr(1387, ".github/workflows/ai-review.yml", "lib/scaffold/ai-review-step.ts", "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", "test/ai-review-rounds-step.test.ts"),
  pr(1376, ".github/workflows/closing-references.yml", "lib/closing-reference-audit.ts", "scripts/audit-closing-references.ts", "test/audit-closing-references.test.ts", "test/closing-reference-audit.test.ts"),
  pr(1361, "lib/bash-write-guard.ts", "test/bash-write-guard.test.ts"),
  pr(1358, "hooks/GateResultProtection.hook.ts", "hooks/WorkflowStateGuard.hook.ts", "specs/HOOK-ARCHITECTURE-SPEC.md", "test/workflow-state-guard-case.test.ts", "test/workflow-state-write-contract.test.ts"),
  pr(1354, "lib/cli-commands.ts", "lib/scaffold/ai-review-findings.ts", "test/ai-review-finding-scope.test.ts"),
  pr(1336, ".claude/rules/self-referential-tests.md", "scripts/census-routing.ts", "test/census-routing.test.ts"),
];

const LIVE: OpenPrCorpus = { status: "measured", prs: OPEN_PRS };

/** A case the suite and the mutation battery both run. */
interface Case {
  id: string;
  what: string;
  cited: string[];
  options: RouteOptions;
  route: Route;
  prs: number[];
}

const CASES: readonly Case[] = [
  {
    id: "RT-1",
    what: "the #1393 exemplar: a high naming a file the PR never opened goes to the PR that owns it",
    cited: ["lib/ai-review-rounds.ts"],
    options: { corpus: LIVE, thisPr: 1393 },
    route: "OTHER_PR",
    prs: [1410],
  },
  {
    id: "RT-2",
    what: "the #1354 exemplar: two open PRs hold lib/bash-write-guard.ts, so both are named",
    cited: ["lib/bash-write-guard.ts"],
    options: { corpus: LIVE, thisPr: 1354 },
    route: "AMBIGUOUS",
    prs: [1361, 1411],
  },
  {
    id: "RT-3",
    what: "CONTROL: the same finding, arriving on a PR that DOES hold the file, stays there",
    cited: ["lib/bash-write-guard.ts"],
    options: { corpus: LIVE, thisPr: 1411 },
    route: "THIS_PR",
    prs: [1411],
  },
  {
    id: "RT-4",
    what: "a file nobody is editing: the tracker is still the right home",
    cited: ["lib/issue-filing-gate.ts"],
    options: { corpus: LIVE, thisPr: 1393 },
    route: "TRACKER",
    prs: [],
  },
  {
    id: "RT-5",
    what: "a corpus that could not be fetched is not a corpus with no matches",
    cited: ["lib/ai-review-rounds.ts"],
    options: { corpus: { status: "unmeasured", why: "gh pr list exited 1" } },
    route: "UNMEASURED",
    prs: [],
  },
  {
    id: "RT-6",
    what: "a diff listed in part cannot answer either way",
    cited: ["lib/ai-review-rounds.ts"],
    options: {
      corpus: {
        status: "measured",
        prs: [{ number: 900, files: ["lib/other.ts"], declaredFileCount: 140 }],
      },
    },
    route: "UNMEASURED",
    prs: [900],
  },
  {
    id: "RT-7",
    what: "a finding naming no path: this instrument says so rather than saying tracker",
    cited: [],
    options: { corpus: LIVE, thisPr: 1393 },
    route: "NO_CITED_PATH",
    prs: [],
  },
  {
    id: "RT-8",
    what: "a short cited path matches a whole trailing segment, never a bare suffix",
    cited: ["rungate.ts"],
    options: {
      corpus: { status: "measured", prs: [pr(1, "bin/rungate.ts"), pr(2, "lib/my-rungate.ts")] },
    },
    route: "OTHER_PR",
    prs: [1],
  },
  {
    id: "RT-9",
    what: "two matches are not a tie: the PR holding more of the cited paths wins",
    cited: ["lib/a.ts", "lib/b.ts"],
    options: {
      corpus: { status: "measured", prs: [pr(1, "lib/a.ts", "lib/b.ts"), pr(2, "lib/b.ts")] },
    },
    route: "OTHER_PR",
    prs: [1],
  },
  {
    id: "RT-10",
    what: "the PR under review wins over the corpus, and is answered before it is consulted",
    cited: ["lib/finding-arbiter.ts"],
    options: { corpus: LIVE, thisPr: 1393 },
    route: "THIS_PR",
    prs: [1393],
  },
];

describe("#1343: a finding is routed to the open PR that is holding the file", () => {
  test.each(CASES.map(c => [c.id, c] as const))("%s", (_id, c) => {
    const routing = routePaths(c.cited, c.options);
    expect(`${c.id} ${routing.route} ${JSON.stringify(routing.prs)}`).toBe(
      `${c.id} ${c.route} ${JSON.stringify(c.prs)}`,
    );
  });

  test("the reason names the evidence, so a reader need not re-run the lookup", () => {
    const routing = routePaths(["lib/ai-review-rounds.ts"], { corpus: LIVE, thisPr: 1393 });
    expect(routing.reason).toContain("#1410");
    expect(routing.reason).toContain("lib/ai-review-rounds.ts");
    expect(routingSummary(routing)).toStartWith("ROUTE OTHER_PR #1410:");
  });

  test("the instrument reports its population, not only its hit", () => {
    const routing = routePaths(["lib/bash-write-guard.ts", "lib/ai-review-rounds.ts"], {
      corpus: LIVE,
      thisPr: 1354,
    });
    expect(routing.consideredPrs).toBe(OPEN_PRS.length);
    expect(routing.citedPaths).toEqual(["lib/bash-write-guard.ts", "lib/ai-review-rounds.ts"]);
  });

  test("an unreadable corpus carries no population count rather than a zero", () => {
    const routing = routePaths(["lib/x.ts"], { corpus: { status: "unmeasured", why: "no token" } });
    expect(routing.consideredPrs).toBeNull();
    expect(routing.reason).toContain("no token");
  });
});

describe("#1343: the paths come from the arbiter's own symptom keys", () => {
  test("a prose finding yields the file keys the dedupe already uses", () => {
    const finding: Finding = {
      id: "new",
      title: "carryForward reads an empty recorded text as a genuine reading",
      body:
        "`carryForward` in `lib/ai-review-rounds.ts` treats a recorded line-text of `\"\"` as a reading, " +
        "while `buildPersistScript` in `lib/scaffold/ai-review-step.ts` emits that same value when it " +
        "could not determine the text at all.",
    };
    const paths = citedPathsFromKeys(symptomKeys(finding));
    expect(paths).toContain("lib/ai-review-rounds.ts");
    expect(paths).toContain("lib/scaffold/ai-review-step.ts");
  });

  test("that finding, routed, reaches the PR holding the file it is about", () => {
    const finding: Finding = {
      id: "new",
      title: "carryForward reads an empty recorded text as a genuine reading",
      body: "`carryForward` in `lib/ai-review-rounds.ts` treats a recorded line-text of empty as a reading.",
    };
    const routing = routePaths(citedPathsFromKeys(symptomKeys(finding)), { corpus: LIVE, thisPr: 1393 });
    expect(routing.route).toBe("OTHER_PR");
    expect(routing.prs).toEqual([1410]);
  });

  test("a key that is not a path contributes nothing", () => {
    expect(citedPathsFromKeys(["sym:carryForward", "qty:398", "file:LIB/Foo.ts"])).toEqual(["lib/foo.ts"]);
  });

  test("normalisation is one spelling, and matching is segment-wise", () => {
    expect(normalisePath("./Lib/Foo.TS")).toBe("lib/foo.ts");
    expect(pathMatches("lib/foo.ts", "lib/foo.ts")).toBe(true);
    expect(pathMatches("foo.ts", "lib/foo.ts")).toBe(true);
    expect(pathMatches("foo.ts", "lib/my-foo.ts")).toBe(false);
  });
});

/**
 * The CLI contract, spawned rather than called (#1343).
 *
 * `scripts/arbitrate-finding.ts` is the production caller, and its exit
 * status IS the answer — so exit **4** is asserted by running the script, the
 * way AR-12 asserts 0 and 3. A library function with no production caller is
 * not shipped however well tested (#1241), and a test that called `routePaths`
 * directly would leave the wiring unmeasured.
 *
 * The corpus is pinned through `--open-prs`, so the case does not reach the
 * network and cannot change its answer when somebody merges a pull request.
 * The exemplar did exactly that mid-session: #1410, which holds the file the
 * #1393 finding names, merged while this suite was being written.
 */
describe("#1343: the CLI routes, and exit 4 says where", () => {
  const script = join(import.meta.dir, "..", "scripts", "arbitrate-finding.ts");
  let scratch = "";

  const run = (extra: string[]): { code: number; out: string } => {
    const r = Bun.spawnSync(
      ["bun", script,
       "--title", "carryForward reads an empty recorded text as a genuine reading",
       "--body-file", join(scratch, "body.md"),
       "--existing", join(scratch, "empty.json"),
       "--votes", join(scratch, "votes.json"),
       "--project-root", join(import.meta.dir, ".."),
       ...extra],
      { stdout: "pipe", stderr: "pipe" },
    );
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "rg-1343-cli-"));
    writeFileSync(join(scratch, "empty.json"), "[]");
    writeFileSync(join(scratch, "votes.json"), JSON.stringify([
      { verifier: "v1", real: true, reason: "reproduced" },
      { verifier: "v2", real: true, reason: "reproduced" },
      { verifier: "v3", real: false, reason: "could not reproduce" },
    ]));
    writeFileSync(
      join(scratch, "body.md"),
      "`carryForward` in `lib/ai-review-rounds.ts` treats a recorded line-text of \"\" as a genuine " +
        "reading, so an undecidable finding is classified as resolved and dropped instead of carried.",
    );
    writeFileSync(
      join(scratch, "prs.json"),
      JSON.stringify(OPEN_PRS.map(p => ({
        number: p.number,
        changedFiles: p.declaredFileCount,
        files: p.files.map(path => ({ path })),
      }))),
    );
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const pinned = (...extra: string[]) => ["--open-prs", join(scratch, "prs.json"), ...extra];

  test("the exemplar that blocked #1393 exits 4 and names #1410", () => {
    const r = run(pinned("--this-pr", "1393", "--changed-files", "lib/finding-arbiter.ts,test/finding-arbiter.test.ts"));
    expect(`${r.code} ${r.out.includes("ROUTE OTHER_PR #1410")}`).toBe("4 true");
  });

  test("CONTROL: the same finding on the PR that owns the file exits 0 and stays", () => {
    const r = run(pinned("--this-pr", "1410", "--changed-files", "lib/ai-review-rounds.ts,test/ai-review-ledger-read.test.ts"));
    expect(`${r.code} ${r.out.includes("ROUTE THIS_PR")}`).toBe("0 true");
  });

  test("with no corpus the arbiter's own exit stands, and the run says it was not read", () => {
    // The regression this blocks: a routing reading nobody could take turning
    // into a route. `AR-12`'s three exit codes are the population it protects.
    const r = run(["--this-pr", "1393"]);
    expect(`${r.code} ${r.out.includes("ROUTE UNMEASURED")}`).toBe("0 true");
  });

  test("--file is the payload's anchor and replaces the prose keys", () => {
    // Without it the same body routes by every path it names. Run live on
    // 2026-10-23 that was three pull requests holding the second file.
    const r = run(pinned("--this-pr", "1393", "--file", "lib/bash-write-guard.ts"));
    expect(`${r.code} ${r.out.includes("ROUTE AMBIGUOUS #1361,#1411")}`).toBe("0 true");
  });
});

// ── The battery ──────────────────────────────────────────────────────────

/** A one-line textual mutation of the source, and what it must break. */
interface Mutant {
  name: string;
  /** Must appear EXACTLY once in the source, or the row aborts. */
  from: string;
  to: string;
  /** The case ids this mutation must redden. Predicted before running. */
  reddens: string[];
}

const MUTANTS: readonly Mutant[] = [
  {
    name: "the status quo: every finding goes to the tracker",
    from: "export function routePaths(citedPaths: readonly string[], options: RouteOptions): Routing {",
    to:
      "export function routePaths(citedPaths: readonly string[], options: RouteOptions): Routing {\n" +
      '  if (true) return { route: "TRACKER", citedPaths: [], prs: [], matchedPaths: [], consideredPrs: null, reason: "mutant" };',
    reddens: ["RT-1", "RT-2", "RT-3", "RT-5", "RT-6", "RT-7", "RT-8", "RT-9", "RT-10"],
  },
  {
    name: "a bare suffix test instead of a whole trailing segment",
    from: 'return path === cited || path.endsWith("/" + cited);',
    to: "return path.endsWith(cited);",
    reddens: ["RT-8"],
  },
  {
    name: "the PR the finding arrived on is not consulted",
    from: "if (own.length > 0) {",
    to: "if (false) {",
    reddens: ["RT-3", "RT-10"],
  },
  {
    name: "an unreadable corpus falls through as a corpus with no matches",
    from: 'if (corpus.status !== "measured") {',
    to: "if (false) {",
    reddens: ["RT-5"],
  },
  {
    name: "a partly-listed diff is treated as a complete one",
    from: "if (truncated.length > 0) {",
    to: "if (false) {",
    reddens: ["RT-6"],
  },
  {
    name: "the first match wins, so a tie is never seen",
    from: "if (top.length > 1) {",
    to: "if (false) {",
    reddens: ["RT-2"],
  },
];

/** What a case produced, with a throw as its own observable rather than a crash. */
function observe(fn: (cited: string[], options: RouteOptions) => Routing, c: Case): string {
  try {
    const routing = fn(c.cited, c.options);
    return `${routing.route} ${JSON.stringify(routing.prs)}`;
  } catch (error) {
    return `THREW ${error instanceof Error ? error.message.slice(0, 40) : String(error)}`;
  }
}

describe("#1343: the router can fail, and here is what breaks it", () => {
  const source = readFileSync(SOURCE, "utf-8");

  test("the source has no relative import, so a mutant runs from a temp directory", () => {
    // A mutant that dies on module resolution exits non-zero exactly as one
    // rejected on the merits does, which is the reading this rules out.
    expect(source).not.toMatch(/from\s+["']\.\.?\//);
  });

  test.each(MUTANTS.map(m => [m.name, m] as const))("%s", async (_name, mutant) => {
    const occurrences = source.split(mutant.from).length - 1;
    expect(`anchor occurrences: ${occurrences}`).toBe("anchor occurrences: 1");

    const dir = mkdtempSync(join(tmpdir(), "rg-1343-mutant-"));
    try {
      const path = join(dir, "finding-pr-routing.ts");
      writeFileSync(path, source.replace(mutant.from, mutant.to), "utf-8");
      const mutated = (await import(path)) as { routePaths: typeof routePaths };
      expect(typeof mutated.routePaths).toBe("function");

      const observed = CASES.filter(c => observe(mutated.routePaths, c) !== observe(routePaths, c)).map(c => c.id);
      // The SET, predicted in MUTANTS before the run — a matching count over a
      // different membership is the failure this comparison exists to catch.
      expect(observed).toEqual(mutant.reddens);

      // And the mutant is LIVE: some case still returns a route, so the row
      // above is a behavioural difference and not a module that half-loaded.
      expect(CASES.some(c => !observe(mutated.routePaths, c).startsWith("THREW"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
