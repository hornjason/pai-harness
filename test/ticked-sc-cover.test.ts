/**
 * A tick is a claim that something was proven (#327).
 *
 * Covers SC-891, SC-892, SC-893, SC-894 (HARNESS-STANDARD.md).
 *
 * #149 replaced "a test file mentions the id" with "a test file DECLARES the
 * id" and eight criteria lost their only coverage claim without losing their
 * tick. Three spot-checked then were certified by, in order, a line of
 * unrelated fixture text, a key-formatting test, and a duplicate-detection
 * record. None asserted anything about the criterion it certified.
 *
 * Classifying the eight found 161 more behind them: ticked, with no
 * declaring claim, no passing conformity assertion, no behavioural
 * exemption and no supersession. Four of the eight are unticked in this
 * change; the rest of the backlog is banked per spec and cannot grow.
 *
 * `lib/sc-cover.ts` is the single binding that decides what cover is, so
 * these cases can short-circuit it and watch the ratchet stop refusing.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import {
  isSuperseded,
  ratchetViolations,
  uncoveredBySpec,
  uncoveredTickedScs,
} from "../lib/sc-cover";
import { claimedScKeys, scopedKey } from "../scripts/sync-sc-status";

const REPO = join(import.meta.dir, "..");
const SPECS = join(REPO, "specs");

/**
 * What the tree currently owes, banked (#327 SC-5).
 *
 * SC-5 asks for zero. It cannot be zero today without writing 157 tests or
 * withdrawing 157 ticks, and a guard written to pass over a backlog it
 * cannot see is the defect this issue is about. Lowering these is the work;
 * the list ratchets both ways so a spec that improves must say so here.
 */
const BANKED: Record<string, number> = {
  // 120 -> 118 on 2026-10-22 (#1217). SC-108, SC-135 and SC-237 were
  // unticked: the first two each claim a `workflow-state.json` field that
  // #317 deleted from the schema as an orphan declaration, and the third
  // claims a JSON schema for `.rungate/navigability-score.json`, which
  // nothing in the tree writes. Two of the three were in this census.
  // Down by withdrawal, not by anybody proving a criterion.
  "bootstrap-data-flow/success-criteria.md": 118,
  // 12 -> 11 on 2026-10-22 (#1161). SC-453 — "runBehavioralCompliance
  // spawns fresh agent + auditor" — was ticked while no declaration, export,
  // caller or test for that function existed, 167 lines below the same
  // spec's own "(to be built)". It is now a SUPERSEDED pointer to SC-242 of
  // bootstrap-data-flow/success-criteria.md, which tracks the same criterion
  // and is correctly unticked, so it leaves this census as a pointer rather
  // than as a criterion anybody proved. The honest way down, by withdrawal.
  "INSTRUCTION-COMPLIANCE-SPEC.md": 11,
  "AGENTS-MD-TEMPLATE-SPEC.md": 10,
  "CONFIG-DRIVEN-TESTING-SPEC.md": 8,
  "AGENT-BRIEF-TEMPLATE-SPEC.md": 2,
  "DA-COMPLIANCE-SPEC.md": 2,
  "HOOK-ARCHITECTURE-SPEC.md": 1,
};

function uncovered() {
  // `claimedScKeys` is the one owner of the credit rule (#441). This was
  // written out longhand here, and #441 needed the same set in a second
  // place — two implementations of the credit rule is how this class of bug
  // arrives, and it is why `uncoveredTickedScs` takes `claimed` rather than
  // computing it.
  return uncoveredTickedScs({
    specsDir: SPECS,
    projectRoot: REPO,
    claimed: claimedScKeys(SPECS),
    scopedKey,
  });
}

describe("SC-891: no ticked criterion is uncovered beyond what is banked", () => {
  test("the census is non-empty, so the ratchet below is not vacuous", () => {
    // Cover-everything satisfies every case in this file. The backlog is
    // real and large; if this ever reaches zero the ratchet comes out.
    expect(uncovered().length, "nothing was measured at all").toBeGreaterThan(50);
  });

  test("every spec is within its banked number, and none is below it", () => {
    const violations = ratchetViolations(uncoveredBySpec(uncovered()), BANKED);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("a spec OVER its number is refused, naming the ids", () => {
    // Proven able to fail, over a planted census rather than the tree.
    const over = new Map([["A-SPEC.md", ["SC-1", "SC-2", "SC-3"]]]);
    const out = ratchetViolations(over, { "A-SPEC.md": 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("3 ticked criteria have no cover");
    expect(out[0], "the new id is not named, so nobody can act on it").toContain("SC-3");
  });

  test("a spec UNDER its number is refused too", () => {
    // Ratchets both ways. An entry that has stopped being a violation is an
    // entry nobody will ever remove, and the list rots into one more
    // artefact that certifies nothing.
    const out = ratchetViolations(new Map([["A-SPEC.md", ["SC-1"]]]), { "A-SPEC.md": 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("banked at 2 but only 1 remain");
  });

  test("a spec not banked at all is allowed nothing", () => {
    const out = ratchetViolations(new Map([["NEW-SPEC.md", ["SC-1"]]]), {});
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("0 allowed");
  });
});

describe("SC-892: the four kinds of cover are distinguished, not conflated", () => {
  test("a superseded tick is a pointer, and is read as one", () => {
    // GITHUB-API-MIGRATION-SPEC.md does this three times in a row — SC-499,
    // SC-500, SC-501. The line records what the criterion USED to say and
    // why it was wrong; demanding a test for a criterion that explicitly no
    // longer applies would push the spec to delete its own history.
    expect(isSuperseded("SUPERSEDED by SC-531/SC-534 (#137) — was \"…\"")).toBe(true);
    expect(isSuperseded("  SUPERSEDED by SC-9 ")).toBe(true);
  });

  test("merely mentioning supersession is not being superseded", () => {
    // The citation-vs-claim boundary again. A criterion ABOUT supersession
    // is still a criterion, and reading it as exempt would let any spec
    // excuse a tick by discussing the idea.
    expect(isSuperseded("the gate refuses a SUPERSEDED criterion that is still ticked")).toBe(false);
    expect(isSuperseded("not SUPERSEDED by anything")).toBe(false);
  });

  test("a matcher that FAILS is not cover, only one that passes is", () => {
    // `sync-sc-status` reports matched, failing and unmatchable as three
    // states precisely because conflating the first two certifies a broken
    // assertion. Driven over a planted spec whose assertion cannot pass.
    const out = uncoveredTickedScs({
      specsDir: SPECS,
      projectRoot: "/nonexistent-root-for-sc-cover",
      claimed: new Set(),
      scopedKey,
    });
    const all = uncoveredTickedScs({
      specsDir: SPECS,
      projectRoot: REPO,
      claimed: new Set(),
      scopedKey,
    });
    // Against a root where no file exists, every file-shaped assertion fails,
    // so strictly more criteria are uncovered than against the real tree.
    expect(out.length, "the project root was never consulted").toBeGreaterThan(all.length);
  });

  test("a claim removes a criterion from the census", () => {
    const withoutClaims = uncoveredTickedScs({
      specsDir: SPECS, projectRoot: REPO, claimed: new Set(), scopedKey,
    });
    const withClaims = uncovered();
    expect(withClaims.length, "the claim set was never consulted")
      .toBeLessThan(withoutClaims.length);
  });
});

describe("SC-893 of GITHUB-API-MIGRATION-SPEC.md: gh never reaches a subprocess", () => {
  /**
   * SC-502, given the test its tick always implied.
   *
   * Its statement — "No `execSync.*gh ` or `Bun.spawnSync.*gh` patterns in
   * lib/, hooks/, gates/" — is a mechanical absence check wearing a
   * `(behavioral)` tag, and that tag exempted it from every check. The
   * criterion is satisfied; it simply had nothing that would notice if it
   * stopped being.
   *
   * Absence checks are the easiest thing in a codebase to write vacuously,
   * so the scan is asserted to have READ something before it is asserted to
   * have found nothing.
   */
  const DIRS = ["lib", "hooks", "gates"];

  function sourceFiles(): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    for (const d of DIRS) {
      const dir = join(REPO, d);
      for (const f of readdirSync(dir, { recursive: true, encoding: "utf-8" })) {
        if (typeof f !== "string" || !/\.(ts|js)$/.test(f)) continue;
        out.push({ path: `${d}/${f}`, text: readFileSync(join(dir, f), "utf-8") });
      }
    }
    return out;
  }

  // `gh` reached as a subprocess. Not `github`, not `gh-pages`, not a word
  // ending in gh — the boundary is what makes the scan narrow enough to be
  // worth running and is asserted below rather than trusted.
  const GH_SPAWN =
    /(?:execSync|execFileSync|spawnSync|spawn|exec)\s*\(\s*[`"'][^`"']*\bgh(?:\s|[`"'])/;

  test("the scan reads a substantial corpus, so finding nothing means something", () => {
    const files = sourceFiles();
    expect(files.length, "the walk found no source at all").toBeGreaterThan(40);
    expect(
      files.reduce((n, f) => n + f.text.length, 0),
      "the walk found files but read nothing out of them",
    ).toBeGreaterThan(100_000);
  });

  /**
   * Empty, as of #395.
   *
   * It was banked at one. SC-502 had been classified "satisfied, needs a
   * test" off a grep, and the grep was wrong: `gates/workflow.test.ts`
   * reached the GitHub CLI with the exec on one line and the command on the
   * next, so a line-oriented search saw nothing. The criterion had been
   * ticked over a live violation for its whole life, and #327 unticked it.
   *
   * #395 removed the call — the gate reads labels through `getIssueLabels`
   * in `lib/github.ts` now, with the issue number and repo slug as
   * arguments rather than interpolated into a command string — so the list
   * goes empty and SC-502 is ticked again, with its `(behavioral)` tag
   * removed because the criterion is mechanically checkable and that tag is
   * what exempted it from every check.
   *
   * The list ratchets both ways, so this cannot quietly refill.
   */
  const KNOWN_GH_SUBPROCESS: string[] = [];

  test("no gh subprocess in lib/, hooks/ or gates/ beyond the one known", () => {
    const offenders = sourceFiles()
      .filter(f => GH_SPAWN.test(f.text))
      .map(f => f.path)
      .sort();
    expect(
      offenders,
      "gh is reached as a subprocess. Infrastructure uses Octokit; agent prompts " +
        "use the MCP tools. See GITHUB-API-MIGRATION-SPEC.md. If one was REMOVED, " +
        "delete it from KNOWN_GH_SUBPROCESS in the same commit.",
    ).toEqual([...KNOWN_GH_SUBPROCESS].sort());
  });

  test("the detector finds a gh subprocess when there is one", () => {
    // Proven able to fail on every run rather than once in a PR body.
    expect(GH_SPAWN.test(`execSync("gh issue list --limit 200")`)).toBe(true);
    expect(GH_SPAWN.test(`spawnSync("gh", ["pr", "view"])`)).toBe(true);
    expect(GH_SPAWN.test("execSync(`gh pr merge ${n}`)")).toBe(true);
    expect(GH_SPAWN.test(`Bun.spawnSync("gh pr list")`)).toBe(true);
  });

  test("the detector does not fire on a word that merely ends in gh", () => {
    // The positive control. A pattern wide enough to catch `through` would
    // make the case above pass for a reason unrelated to the criterion, and
    // the first thing anyone would do is weaken it until it went quiet.
    expect(GH_SPAWN.test(`execSync("ghost --version")`)).toBe(false);
    expect(GH_SPAWN.test(`execSync("git push")`)).toBe(false);
    expect(GH_SPAWN.test(`execSync("bun run high-throughput")`)).toBe(false);

    // The cases the leading `\b` actually decides, and the only ones that
    // do. Measured: with the three above alone, removing `\b` from the
    // pattern scored ZERO red — "ghost" fails on the character AFTER `gh`
    // and "high-throughput" does too, so neither ever reached the boundary.
    // A command ENDING in `gh`, before a space or the closing quote, is
    // where the two readings differ.
    expect(GH_SPAWN.test(`execSync("make dough ")`)).toBe(false);
    expect(GH_SPAWN.test(`execSync("bun run sigh")`)).toBe(false);
    expect(GH_SPAWN.test("execSync(`plough ${target}`)")).toBe(false);
  });
});
