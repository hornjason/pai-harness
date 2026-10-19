#!/usr/bin/env bun
/**
 * Print the test files a run needs, or print nothing and mean "run everything".
 *
 * The subprocess half of #676. `workflows/ship.js` cannot import (#69), so
 * the reading crosses the boundary the way `scripts/resolve-config.ts` and
 * `phase2AcsCommand` already do: this script writes the whole reading into
 * the run's work directory, and the generated command consumes what it
 * prints. There is one selection implementation and this is its only caller.
 *
 * **Printing nothing is the safe answer, and it is load-bearing.** The
 * generated command is `<testCommand> $(this script)`, so empty output runs
 * the full suite — the same thing the run did before #676. Every path that
 * cannot establish a trustworthy selection takes it:
 *
 *   - the graph returned UNMEASURED (a non-module changed, no tests found,
 *     nothing changed)
 *   - the graph returned MEASURED but selected nothing. Running zero tests
 *     would leave the recorder with no summary to read, which is #469, and
 *     "no test is affected" is not a claim worth betting a merge on when the
 *     cost of being wrong is a regression and the cost of being right is one
 *     suite that will essentially never run
 *   - git could not name the changed files
 *
 * All three are recorded in the artefact by name. A run that selected a
 * subset and a run that fell back must never be byte-identical in the
 * record — that is the whole reporting-position defect this repo keeps
 * finding, and here it would hide a saving that silently became a skip.
 */
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { affectedTests } from "../lib/affected-tests";

/**
 * The shape a selected path is allowed to have.
 *
 * The caller interpolates this script's stdout into a shell command
 * unquoted, because word-splitting is how a list becomes arguments. Rather
 * than trust that every path a tree walk produced is inert, anything outside
 * this alphabet refuses the whole selection and falls back to the full
 * suite. The injection surface is removed by construction rather than by
 * assuming the walk is well-behaved.
 */
const SAFE_TEST_PATH = /^[A-Za-z0-9._/-]+\.test\.tsx?$/;

export interface SelectionArtifact {
  mode: "SELECTED" | "FULL_SUITE";
  /** Why the full suite is being run. Empty when SELECTED. */
  fellBackBecause: string[];
  tests: string[];
  changed: string[];
  testFilesSeen: number;
  selected: number;
  sweeps: number;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Committed changes against the base, plus anything not yet committed. */
export function changedFiles(root: string, base?: string): string[] {
  const ref =
    base ??
    git(root, ["merge-base", "HEAD", "origin/main"]).trim();
  const committed = git(root, ["diff", "--name-only", `${ref}...HEAD`]).split("\n");
  const working = git(root, ["status", "--porcelain"])
    .split("\n")
    .map(l => l.slice(3).trim())
    .filter(Boolean);
  return [...new Set([...committed, ...working].map(s => s.trim()).filter(Boolean))];
}

export function selectionFor(root: string, base?: string): SelectionArtifact {
  let changed: string[];
  try {
    changed = changedFiles(root, base);
  } catch (e) {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: [`git could not name the changed files: ${(e as Error).message.split("\n")[0]}`],
      tests: [],
      changed: [],
      testFilesSeen: 0,
      selected: 0,
      sweeps: 0,
    };
  }

  const r = affectedTests(root, changed);
  const base_ = {
    changed,
    testFilesSeen: r.testFilesSeen,
    selected: r.selected,
    sweeps: r.sweeps.length,
  };

  if (r.reading === "UNMEASURED") {
    return { mode: "FULL_SUITE", fellBackBecause: r.unmeasuredReasons, tests: [], ...base_ };
  }
  if (r.tests.length === 0) {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: [
        "the graph selected no test file at all. That is a measurement, not an error, but a run " +
          "with no tests leaves the recorder no summary to read (#469), so the full suite runs",
      ],
      tests: [],
      ...base_,
    };
  }

  const unsafe = r.tests.filter(t => !SAFE_TEST_PATH.test(t));
  if (unsafe.length > 0) {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: [
        `${unsafe.length} selected path(s) are not plain test paths and will not be interpolated ` +
          `into a shell command: ${unsafe.slice(0, 3).join(", ")}`,
      ],
      tests: [],
      ...base_,
    };
  }

  return { mode: "SELECTED", fellBackBecause: [], tests: r.tests, ...base_ };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = arg(argv, "root") ?? process.cwd();
  const work = arg(argv, "work");
  const result = selectionFor(root, arg(argv, "base"));

  if (work) {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "affected-tests.json"), `${JSON.stringify(result, null, 2)}\n`);
  }

  // stderr, so it reaches the operator without becoming a test argument.
  if (result.mode === "SELECTED") {
    console.error(
      `affected-tests: ${result.selected} of ${result.testFilesSeen} files ` +
        `(${result.sweeps} sweeps), from ${result.changed.length} changed`,
    );
    console.log(result.tests.join(" "));
  } else {
    console.error(`affected-tests: FULL SUITE — ${result.fellBackBecause[0]}`);
  }
}
