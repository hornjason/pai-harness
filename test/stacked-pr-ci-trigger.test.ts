/**
 * stacked-pr-ci-trigger.test.ts — a PR runs CI regardless of its base (#1136).
 *
 * THE DEFECT. Every generated workflow emitted the SAME `branchList` under
 * `on.push` and under `on.pull_request`. A pull request whose base is a
 * feature branch therefore matched no entry and triggered nothing: no `test`,
 * no shards, no `gates`, no `ai-review`. Measured on `hornjason/pai-harness`
 * before this change — `gh run list --commit <full 40-char head sha>`:
 *
 * | row     | PR    | base                            | runs |
 * |---------|-------|---------------------------------|------|
 * | witness | #1128 | feat/713-migrate-product-hooks  | 0    |
 * | witness | #1133 | feat/713-migrate-product-hooks  | 0    |
 * | control | #1125 | main                            | 3    |
 * | control | #1134 | main                            | 3    |
 *
 * The only input that differs between the rows is the base branch. Both
 * witnesses merged anyway: with no workflow triggered there is no required
 * check to sit pending, so the merge box reports a PR that measured nothing
 * the same way it reports a green one.
 *
 * WHY `push` KEEPS ITS FILTER, AND WHY THAT IS THE CONTROL HERE. The cheapest
 * wrong fix is to delete `branchList` wherever it appears. It makes the four
 * witness cases below pass, and it is wrong: `on.push` would then fire a full
 * CI run for every push to every feature branch, on top of the `pull_request`
 * run that already covers the same commit. Sampled over 25 recent merged PRs
 * in this repo: 44 commits, mean 1.76 pushes per PR. Against the 72 push-event
 * runs observed in the last 300, that trade is roughly an order of magnitude
 * of duplicated runner time bought for no new coverage. `branches` on `push`
 * answers "which branches get CI on their own"; the `pull_request` filter was
 * answering "which bases may be merged into", which was never the question.
 * The two `push` cases below are the CONTROL that stays red for that fix.
 *
 * WHY NOT ENUMERATE THE NAMESPACES. Adding `feat/**` and `fix/**` to the
 * filter would have covered all 6 of the non-`main`-based PRs in the last 200
 * — history does not falsify it. The prospective count does: of those same 200
 * PRs, 24 head branches sit outside both namespaces (`chore/`, `rg/`, `wt/`,
 * `docs/`, `revert/`, and bare names). Any one of them can become a base
 * tomorrow and would be silently ungated, which is the failure mode this
 * issue already is.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { AI_REVIEW_WORKFLOW_FILE } from "../lib/scaffold/ai-review-step";

const REPO_ROOT = join(import.meta.dir, "..");

/** Four patterns including a bare `*`, so an unquoted emission is a parse error. */
const BRANCHES = ["main", "*", "*-dev", "release/**"];

/** YAML 1.1 folds a bare `on` key to boolean true; accept either spelling. */
function triggersOf(doc: any): any {
  return doc.on ?? doc[true as unknown as string];
}

/**
 * A scaffolded project with the given `ci` config, returning its workflow
 * directory. `shards` drives the ternary in `createCiWorkflows`: the sharded
 * and unsharded CI bodies are two separate template literals, and #765 landed
 * a trigger in one of them only, so both are exercised here.
 */
function scaffold(shards: number): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-1136-"));
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify(
      { project: "stacked-pr-fixture", ci: { runner: "ubuntu-latest", bunVersion: "1.2.0", branches: BRANCHES, shards } },
      null,
      2,
    ) + "\n",
  );
  createCiWorkflows(root, []);
  return root;
}

function parseFrom(root: string, file: string): any {
  return Bun.YAML.parse(readFileSync(join(root, ".github", "workflows", file), "utf-8"));
}

/** Each generated body, named by the shape it is. */
const GENERATED: Array<{ label: string; shards: number; file: string }> = [
  { label: "ci.yml (sharded body)", shards: 4, file: "ci.yml" },
  { label: "ci.yml (unsharded body)", shards: 1, file: "ci.yml" },
  { label: "gates.yml", shards: 4, file: "gates.yml" },
  { label: `${AI_REVIEW_WORKFLOW_FILE}`, shards: 4, file: AI_REVIEW_WORKFLOW_FILE },
];

describe("#1136 witness: a generated pull_request trigger does not filter by base", () => {
  for (const { label, shards, file } of GENERATED) {
    test(`${label} carries no branches: under on.pull_request`, () => {
      const root = scaffold(shards);
      try {
        const pr = triggersOf(parseFrom(root, file)).pull_request;
        expect(pr, `${label} has no pull_request trigger at all`).toBeDefined();
        // `null` is the YAML reading of a bare `pull_request:` key — the shape
        // wanted. A `branches` key under it is the defect, whatever it lists.
        expect(
          pr === null ? [] : Object.keys(pr),
          `${label} still restricts pull_request by base branch`,
        ).not.toContain("branches");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("#1136 control: on.push keeps the configured branch filter", () => {
  for (const file of ["ci.yml", "gates.yml"]) {
    test(`${file} still restricts push to the configured branches`, () => {
      const root = scaffold(4);
      try {
        expect(triggersOf(parseFrom(root, file)).push.branches).toEqual(BRANCHES);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("#1136 witness: this repository's own committed workflows", () => {
  for (const file of ["ci.yml", "gates.yml", AI_REVIEW_WORKFLOW_FILE]) {
    test(`.github/workflows/${file} carries no branches: under on.pull_request`, () => {
      const pr = triggersOf(parseFrom(REPO_ROOT, file)).pull_request;
      expect(pr, `${file} has no pull_request trigger at all`).toBeDefined();
      expect(
        pr === null ? [] : Object.keys(pr),
        `${file} on disk still restricts pull_request by base — regenerate it`,
      ).not.toContain("branches");
    });
  }
});
