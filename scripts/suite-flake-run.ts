#!/usr/bin/env bun
/**
 * #323 SC-5 — run the suite N consecutive times on one tree and read the
 * series.
 *
 * This script EXECUTES and KEEPS. It decides nothing: `lib/suite-run-reading.ts`
 * reads each run and `lib/suite-flake.ts` turns the series into a verdict, so
 * there is one binding to mutate for each question.
 *
 * Three things it does that a shell loop does not, and they are the reason
 * it exists rather than a `for` loop in the workflow:
 *
 *  1. **Every log is kept, named, and reported even when the run was
 *     clean.** The 2026-10-11 failure this issue is about was lost to a
 *     scrollback, and a failure that is not kept did not happen as far as
 *     anyone after you is concerned.
 *  2. **The tree is signed before every run.** "Ten clean runs on an
 *     unchanged tree" is two claims, and the second one is the one nobody
 *     checks. Several suites in this repository write scratch directories
 *     under the project root, which is SC-6's hypothesis — a run that
 *     dirties the tree it is measuring has changed the input to the next run
 *     without moving HEAD.
 *  3. **The test command comes from the project's declaring positions**, via
 *     `testCommandAgreement` (#621). A hard-coded `bun test` here would be a
 *     fourth position, and a series measured with a command the project does
 *     not use is a measurement of something else.
 *
 * Consecutive on ONE machine, deliberately, rather than a matrix of N
 * parallel jobs. The suspected causes are shared scratch paths and lock
 * contention, which are same-machine phenomena; N independent runners cannot
 * observe them at all, and would report a clean series over exactly the
 * defect being looked for.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { describeFlakeReading, flakeReading, type FlakeRun, type TreeSignature } from "../lib/suite-flake";
import { readSuiteRun } from "../lib/suite-run-reading";
import { NoTestCommandError, testCommandAgreement } from "../lib/test-command-positions";

/**
 * The one non-zero exit, so a test can build a mutant with it set to 0 and
 * prove the refusal is what a case observed
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export const REFUSE_EXIT = 1;

/** The fewest runs that can say anything. One run cannot disagree with itself. */
export const MINIMUM_RUNS = 2;

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || at + 1 >= process.argv.length ? null : process.argv[at + 1];
}

/** HEAD plus every path `git status --porcelain` reports, for one run. */
function signTree(root: string): TreeSignature {
  const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf-8" });
  const head = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain");
  if (head.status !== 0 || status.status !== 0) {
    // Not a throw: an unsignable tree is a reading, and the series will
    // refuse on it because every run then carries a different signature than
    // a signable one would. Naming it here is what makes that legible.
    return { head: "UNSIGNABLE", dirty: [`git could not read ${root}: ${(head.stderr || status.stderr || "").trim()}`] };
  }
  return {
    head: head.stdout.trim(),
    dirty: status.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== ""),
  };
}

function main(): number {
  const root = resolve(arg("project") ?? process.cwd());
  const out = arg("out");
  const runsRaw = arg("runs");

  // Required rather than defaulted, both of them. A default run count makes
  // the quiet path a measurement nobody chose the size of, and a default
  // output directory makes it possible to run this and keep nothing, which
  // is the defect.
  if (out === null || runsRaw === null) {
    console.error("usage: bun scripts/suite-flake-run.ts --runs <N> --out <dir> [--project <dir>]");
    return REFUSE_EXIT;
  }
  const runs = Number(runsRaw);
  if (!Number.isInteger(runs) || runs < MINIMUM_RUNS) {
    console.error(
      `--runs must be an integer of at least ${MINIMUM_RUNS}, not ${JSON.stringify(runsRaw)} — ` +
        "a single run cannot disagree with itself, so it measures nothing about consistency (#323 SC-5)",
    );
    return REFUSE_EXIT;
  }

  let command: string;
  try {
    const agreement = testCommandAgreement(root);
    if (agreement.violations.length > 0) {
      console.error(
        `the project's declaring positions do not agree on a test command, so there is no one thing ` +
          `to run ten times: ${agreement.violations.join("; ")} (#621)`,
      );
      return REFUSE_EXIT;
    }
    command = agreement.commands[0].command;
  } catch (e) {
    if (!(e instanceof NoTestCommandError)) throw e;
    console.error(`${e.message} — refusing rather than guessing at \`bun test\` (#621)`);
    return REFUSE_EXIT;
  }

  const outDir = resolve(out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  console.log(`#323 SC-5: ${runs} consecutive run(s) of \`${command}\` in ${root}`);
  console.log(`logs: ${outDir}\n`);

  const series: FlakeRun[] = [];
  for (let i = 1; i <= runs; i++) {
    const signature = signTree(root);
    const started = Date.now();
    const r = spawnSync(command, { cwd: root, encoding: "utf-8", shell: true, timeout: 3_600_000 });
    const seconds = Math.round((Date.now() - started) / 1000);
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // Written BEFORE the reading, so a parser that throws still leaves the
    // artefact behind. A log kept only on the happy path is the defect.
    const log = join(outDir, `run-${String(i).padStart(2, "0")}.log`);
    writeFileSync(log, output);

    const run = readSuiteRun(output);
    series.push({ index: i, signature, run, log, seconds });
    const line =
      run.status === "MEASURED"
        ? `${run.pass} pass, ${run.fail} fail, ${run.expectCalls ?? "?"} expect() calls`
        : `UNMEASURED — ${run.reason}`;
    console.log(`run ${i}/${runs} [${seconds}s] exit ${r.status}: ${line}`);
  }

  const reading = flakeReading(series, runs);
  const artefact = join(outDir, "flake.json");
  writeFileSync(
    artefact,
    JSON.stringify(
      {
        command,
        requested: runs,
        reading,
        series: series.map(s => ({
          index: s.index,
          seconds: s.seconds,
          log: s.log,
          signature: s.signature,
          run: s.run,
        })),
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`\n${describeFlakeReading(reading)}`);
  console.log(`\nartefact: ${artefact}`);
  return reading.verdict === "CONSISTENT" ? 0 : REFUSE_EXIT;
}

if (import.meta.main) process.exit(main());
