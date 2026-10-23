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

/**
 * A current-PR number that is in no fixture corpus here.
 *
 * Several cases below are about path matching, truncation or corpus status
 * and do not care which pull request is asking — they used to say nothing,
 * and since #1427 saying nothing is a refusal. This names the thing they
 * always meant: routing on behalf of a pull request the corpus does not
 * contain. Step 3 finds no row for it and step 6 excludes nothing, so every
 * one of those cases keeps the exact behaviour it had.
 *
 * It must stay absent from every corpus in this file, or those cases quietly
 * start testing the own-PR exclusion instead of what they are named for.
 */
const ABSENT_PR = 999_999;

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
    options: { corpus: { status: "unmeasured", why: "gh pr list exited 1" }, thisPr: ABSENT_PR },
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
      thisPr: ABSENT_PR,
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
      thisPr: ABSENT_PR,
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
      thisPr: ABSENT_PR,
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
  // ── #1427: an unknown current-PR identity is not "there is no current PR" ──
  {
    id: "RT-11",
    what: "neither --this-pr nor changed files: the router does not know which PR it is on, so it refuses",
    // RED before #1427. `ownFiles` was undefined so step 3 never ran, and
    // `filter(p => p.number !== undefined)` excluded nothing — so the PR being
    // arbitrated stayed in its own candidate corpus and was returned as the
    // OTHER pull request to route to. `scripts/arbitrate-finding.ts` turns
    // OTHER_PR into exit 4, which SUPPRESSES the filing. The finding about
    // #1393 was routed away from #1393, to #1393.
    cited: ["lib/finding-arbiter.ts"],
    options: { corpus: LIVE },
    route: "UNMEASURED",
    prs: [],
  },
  {
    id: "RT-12",
    what: "changed files alone are enough to answer, with no --this-pr",
    // The discrimination. A fix that refused whenever `thisPr` was absent
    // would pass RT-11 and break the caller that supplies a diff instead of a
    // number — the absence of a NUMBER is not the absence of a READING.
    cited: ["lib/finding-arbiter.ts"],
    options: { corpus: LIVE, changedFiles: ["lib/finding-arbiter.ts"] },
    route: "THIS_PR",
    prs: [],
  },
  {
    id: "RT-13",
    what: "changed files that do not hold the cited path still answer, and route onward",
    // The other half of RT-12: having a reading is what lifts the refusal,
    // not the reading saying THIS_PR. Without this row a fix could return
    // UNMEASURED on every non-matching diff and still look right.
    cited: ["lib/ai-review-rounds.ts"],
    options: { corpus: LIVE, changedFiles: ["lib/finding-arbiter.ts"] },
    route: "OTHER_PR",
    prs: [1410],
  },
  {
    id: "RT-14",
    what: "an EMPTY changed-files list with no --this-pr is not a reading either",
    // Found by the review on PR #1446. `scripts/arbitrate-finding.ts` builds
    // the list with `.split(",").filter(Boolean)`, so `--changed-files ""`
    // arrives as `[]` and not as absent — `[]` standing for "I looked and
    // there was nothing" when nobody looked. The same fail-open one layer in.
    cited: ["lib/finding-arbiter.ts"],
    options: { corpus: LIVE, changedFiles: [] },
    route: "UNMEASURED",
    prs: [],
  },
  {
    id: "RT-15",
    what: "an empty changed-files list WITH --this-pr still answers",
    // The discrimination. Only the combination cannot answer: with a number
    // the corpus supplies the diff and step 6 has something to exclude on.
    // Without this row, refusing on every empty list would pass RT-14.
    cited: ["lib/finding-arbiter.ts"],
    options: { corpus: LIVE, thisPr: 1393, changedFiles: [] },
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
    const routing = routePaths(["lib/x.ts"], {
      corpus: { status: "unmeasured", why: "no token" },
      thisPr: ABSENT_PR,
    });
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
      {
        stdout: "pipe",
        stderr: "pipe",
        // #1467: see the note on `runTwo` below.
        env: { ...process.env, RUNGATE_FINDING_LEDGER: join(scratch, "finding-ledger.jsonl") },
      },
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

  /**
   * #1427 — the arbiter must survive the agent it is arbitrating.
   *
   * `--file` is supplied by the agent whose finding is being adjudicated, and
   * it used to REPLACE the finding's own cited paths with no check. Exit 4
   * suppresses the filing, so one flag naming another open pull request's
   * files bought silence. The body here cites `lib/ai-review-rounds.ts` and
   * nothing else; `lib/cli-commands.ts` is held by exactly one open pull
   * request (#1354) and is named nowhere in the finding.
   */
  test("an anchor the finding does not cite cannot suppress the filing", () => {
    // RED before #1427: exit 4, ROUTE OTHER_PR #1354 — a legitimate THIS_PR
    // filing silenced by an invented anchor. The pull request here OWNS the
    // cited file, so without the anchor this is the CONTROL case above.
    const r = run(pinned(
      "--this-pr", "1410",
      "--changed-files", "lib/ai-review-rounds.ts,test/ai-review-ledger-read.test.ts",
      "--file", "lib/cli-commands.ts",
    ));
    expect(`${r.code} ${r.out.includes("ROUTE THIS_PR")}`, r.out).toBe("0 true");
    expect(r.out, "the unverified anchor still steered the routing").not.toContain("#1354");
  });

  // The "a cited anchor is still honoured" controls live in the nested
  // describe below, not here. Against THIS body they would be vacuous: it
  // cites one path, so honouring the anchor and discarding it give the same
  // answer and the row cannot tell a fix from its over-correction. Measured
  // — mutating `anchorOrCited` to `return [...cited]` left both green, which
  // is why they were moved rather than kept as reassurance.

  test("no --this-pr and no --changed-files refuses rather than routing to the asker", () => {
    // RED before #1427: exit 4. With neither input the router did not know
    // which pull request was asking, its own-PR exclusion removed nothing,
    // and it returned a pull request from a corpus that still contained the
    // asker. UNMEASURED leaves the arbiter's disposition standing.
    const r = run(pinned());
    expect(r.code, r.out).not.toBe(4);
    expect(r.out).toContain("UNMEASURED");
  });

  test.each(["abc", "0", "-3", "1393.5", "${{ github.event.number }}", ""])(
    "--this-pr %p is a usage error, not an absent identity",
    bad => {
      // A NaN was the worst of the three states: `thisPr !== undefined` so the
      // refusal did not fire, and `p.number !== NaN` is true of every row so
      // the own-PR exclusion removed nothing. The same fail-open, reached by
      // a typo instead of an omission — and `${{ … }}` is how an unexpanded
      // workflow expression actually arrives.
      const r = run(pinned("--this-pr", bad));
      expect(r.code, r.out).toBe(2);
    },
  );

  test("with no corpus the arbiter's own exit stands, and the run says it was not read", () => {
    // The regression this blocks: a routing reading nobody could take turning
    // into a route. `AR-12`'s three exit codes are the population it protects.
    const r = run(["--this-pr", "1393"]);
    expect(`${r.code} ${r.out.includes("ROUTE UNMEASURED")}`).toBe("0 true");
  });

  /**
   * `--file` selects ONE of the paths the finding cites, and that is what
   * makes it worth having.
   *
   * This pair used to be a single row anchored on `lib/bash-write-guard.ts`,
   * a path the body never named — so it asserted the REPLACE behaviour by
   * exercising precisely the unverified case #1427 is about. The property is
   * real and is kept; it is now demonstrated the way the #1343 exemplar
   * actually looks, with a body that cites the reader it is about AND the
   * writer it blames, and an anchor that is one of the two.
   */
  describe("#1343: the anchor narrows to one of the cited paths", () => {
    const twoFileBody = () => join(scratch, "two-files.md");

    beforeAll(() => {
      writeFileSync(
        twoFileBody(),
        "`carryForward` in `lib/ai-review-rounds.ts` treats a recorded line-text of \"\" as a genuine " +
          "reading. The empty text is written by the quoting pass in `lib/bash-write-guard.ts`, " +
          "which emits \"\" rather than refusing when it cannot resolve the line.",
      );
    });

    const runTwo = (extra: string[]) => {
      const r = Bun.spawnSync(
        ["bun", script,
         "--title", "carryForward reads an empty recorded text as a genuine reading",
         "--body-file", twoFileBody(),
         "--existing", join(scratch, "empty.json"),
         "--votes", join(scratch, "votes.json"),
         "--project-root", join(import.meta.dir, ".."),
         "--open-prs", join(scratch, "prs.json"),
         ...extra],
        {
          stdout: "pipe",
          stderr: "pipe",
          // #1467: the script now appends to `ledgerPath()`. Keep the real
          // `~/.rungate/finding-ledger.jsonl` out of a test's reach.
          env: { ...process.env, RUNGATE_FINDING_LEDGER: join(scratch, "finding-ledger.jsonl") },
        },
      );
      return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
    };

    test("without an anchor, both cited paths route and the answer is AMBIGUOUS", () => {
      // The baseline the anchor exists to improve on. Three pull requests
      // hold one of the two files each, so nothing can be picked.
      const r = runTwo(["--this-pr", "1393"]);
      expect(`${r.code} ${r.out.includes("ROUTE AMBIGUOUS")}`, r.out).toBe("0 true");
    });

    test("with a CITED anchor, the one pull request holding it is named", () => {
      // The #1343 property, measured on an anchor the finding actually
      // cites — so it does not depend on the arbiter trusting its input.
      const r = runTwo(["--this-pr", "1393", "--file", "lib/ai-review-rounds.ts"]);
      expect(`${r.code} ${r.out.includes("ROUTE OTHER_PR #1410")}`, r.out).toBe("4 true");
    });

    test("a cited anchor is matched through normalisation, not by spelling", () => {
      // `./lib/ai-review-rounds.ts` is the same path. A verification that
      // compared raw strings would discard this anchor as uncited, fall back
      // to both paths, and answer AMBIGUOUS — so an agent defeats the check
      // with a leading `./`, and the honoured-anchor row above stays green.
      const r = runTwo(["--this-pr", "1393", "--file", "./lib/ai-review-rounds.ts"]);
      expect(`${r.code} ${r.out.includes("ROUTE OTHER_PR #1410")}`, r.out).toBe("4 true");
    });

    test("with an UNCITED anchor, the finding's own paths are used instead", () => {
      // #1427. The agent names a file the finding does not, pointing at a
      // single-holder pull request to buy an exit 4. It gets the baseline.
      const r = runTwo(["--this-pr", "1393", "--file", "lib/cli-commands.ts"]);
      expect(`${r.code} ${r.out.includes("ROUTE AMBIGUOUS")}`, r.out).toBe("0 true");
      expect(r.out, "the invented anchor still steered the routing").not.toContain("#1354");
    });
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
    reddens: ["RT-1", "RT-2", "RT-3", "RT-5", "RT-6", "RT-7", "RT-8", "RT-9", "RT-10", "RT-11", "RT-12", "RT-13", "RT-14", "RT-15"] as const,
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
    reddens: ["RT-3", "RT-10", "RT-12", "RT-15"],
  },
  {
    // #1427's defect, restored. Without the refusal the router carries on
    // with no idea which pull request is asking, and step 6's
    // `p.number !== undefined` excludes nothing — so the asker is returned
    // as the pull request to route TO, and the caller turns that into exit 4.
    name: "the asker's identity is not required, so the asker can be routed to",
    from: "  if (!hasReading) {",
    to: "if (false) {",
    reddens: ["RT-11", "RT-14"],
  },
  {
    // The empty-list door the review on #1446 found. `[]` is not absent, and
    // `scripts/arbitrate-finding.ts` produces `[]` from `--changed-files ""`.
    name: "an empty changed-file list counts as a reading",
    from: "    (options.changedFiles !== undefined && options.changedFiles.length > 0);",
    to: "    options.changedFiles !== undefined;",
    reddens: ["RT-14"],
  },
  {
    // And the same confusion at the `ownFiles` pick: an empty explicit list
    // shadowing the corpus row loses the diff GitHub already reported.
    name: "an empty explicit list shadows the corpus row",
    from: `    options.changedFiles !== undefined && options.changedFiles.length > 0
      ? options.changedFiles
      : ownRow?.files;`,
    to: "    options.changedFiles ?? ownRow?.files;",
    reddens: ["RT-15"],
  },
  {
    // The other direction, and the one a careless fix reaches for: demanding
    // the NUMBER rather than a reading. A caller holding the diff has better
    // evidence than a caller holding an integer.
    name: "a changed-file list is not accepted in place of the PR number",
    from: "  if (!hasReading) {",
    to: "if (options.thisPr === undefined) {",
    reddens: ["RT-12", "RT-13"],
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
