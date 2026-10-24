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
 *
 * ## Two routers, because one question has two shapes (#1004)
 *
 * `affectedTests` routes by what a change IMPORTS. A census test imports
 * none of the things that move it — it walks a directory, and the shape of
 * the tree is not an edge. Measured on this repository with one spec file
 * changed and nothing else, the graph alone returns MEASURED with 114 of 388
 * files, reaches `ticked-sc-cover` only because it happens to trip a sweep
 * pattern, and misses `sc-binding-split` and `behavioral-sc-ratchet`
 * outright. MEASURED means no fallback, so those two were simply not run.
 *
 * `censusTestsFor` routes by what a change DID — a tick is not an edit, and
 * the two are the same path. Its result is UNIONED into a SELECTED
 * selection here, and nowhere else, so there is still one decider per
 * question and one place that answers "what does this run execute".
 *
 * Three properties of the union are deliberate:
 *
 *   - **FULL_SUITE is left alone.** A fallback already runs everything; a
 *     census union on top of it would be a no-op that made the artefact
 *     look like a selection.
 *   - **`graphTests` and `censusTests` are recorded separately**, for the
 *     same reason `fellBackBecause` exists. A run that took a subset and a
 *     run that took a subset plus three census files are different events,
 *     and an artefact that cannot tell them apart cannot be used to find
 *     out which one happened.
 *   - **A routed census test absent from the tree is recorded, not
 *     appended.** The census table names this repository's own paths, and
 *     this script also runs in scaffolded projects that have none of them.
 *     Handing `bun test` a path that matches nothing is a run whose
 *     denominator nobody can explain, so absence goes to `censusAbsent`
 *     where a reader can see it. In this repository absence is red
 *     independently — `test/census-routing.test.ts` asserts every routed
 *     path exists — so the filter cannot quietly become the thing that
 *     hides a rename.
 *
 * ## Three routers, because the question has a third shape (#1054)
 *
 * `textDependents` routes by what a change's TEXT IS READ BY. A file that
 * lifts a marker-delimited region out of `workflows/ship.js` and executes it
 * imports nothing and walks nothing; it names an anchor. Measured on PR
 * #1034's first commit, the graph's basename rule did reach all five files
 * that went red — inside a selection of 226 of 538, with no statement of
 * why any of them was there. The text router names 13 readers for the same
 * change, each with the anchor and the `ship.js` line span that put it
 * there, and `scripts/text-dependents.ts` prints that before a push.
 *
 * Its union here is ADDITIVE and narrow, which is sound for the opposite
 * reason the graph's over-selection is: this contributor can only add to a
 * selection two other routers already made, so being too tight costs
 * nothing the graph was not already covering, while being too loose costs
 * the saving the whole mechanism exists for. An UNMEASURED reading from it
 * still falls the run back to the full suite — "could not look" is not
 * "found nothing", and that distinction is the reason this file exists.
 *
 * All three routers now read ONE git invocation, `changesFor`. They previously
 * asked git different questions — names only here, added and removed lines
 * there — and a name list is definitionally unable to tell a tick from an
 * edit, which is the whole of #990.
 */
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { affectedTests, SAFE_TEST_PATH } from "../lib/affected-tests";
import { textDependents } from "../lib/text-dependents";

import { censusTestsFor, changesFor, onDisk, type Change } from "./census-routing";

/** One census row that fired, and the changed paths that fired it. */
export interface CensusAttribution {
  id: string;
  event: string;
  because: string[];
}

/** One file that lifts a region of a changed file, and the anchor it uses. */
export interface TextAttribution {
  reader: string;
  target: string;
  anchor: string;
  from: number;
  to: number;
}

export interface SelectionArtifact {
  mode: "SELECTED" | "FULL_SUITE";
  /** Why the full suite is being run. Empty when SELECTED. */
  fellBackBecause: string[];
  /** What the run executes: `graphTests` then `censusTests`. Empty under FULL_SUITE. */
  tests: string[];
  /** Reached from a changed file by an import, a resolvable read, or a sweep. */
  graphTests: string[];
  /**
   * ADDED to `tests` by the census router — routed, present on disk, and not
   * already reached by the graph. Empty whenever `tests` is, so a fallback
   * never looks like a selection that gained files.
   */
  censusTests: string[];
  /**
   * Routed by the census router and absent from this tree, so not appended.
   * Normal in a scaffolded project, red here (`test/census-routing.test.ts`).
   */
  censusAbsent: string[];
  /** The router's reading, recorded even under FULL_SUITE. */
  censusFired: CensusAttribution[];
  /**
   * ADDED to `tests` by the text-dependency router (#1054): files that lift
   * a region of a changed file out of its text, present on disk, and not
   * already reached by the graph or the census.
   */
  textTests: string[];
  /** Why each one is there. The attribution IS the product, so it is kept. */
  textFired: TextAttribution[];
  /**
   * `UNMEASURED` means that router could not look and the run fell back. It
   * is recorded separately from the graph's reading because a FULL_SUITE
   * caused by the text router and one caused by the graph are different
   * events, and an artefact that cannot tell them apart cannot be used to
   * find out which happened.
   */
  textReading: "MEASURED" | "UNMEASURED";
  /** Readers the router found that are not test files, so cannot be run. */
  textHelpers: string[];
  /** Coverage (#492): candidate readers read, of candidate readers seen. */
  textFilesRead: number;
  textFilesSeen: number;
  changed: string[];
  testFilesSeen: number;
  /** The GRAPH's count, against `testFilesSeen`. `tests.length` is the run. */
  selected: number;
  sweeps: number;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function selectionFor(root: string, base?: string): SelectionArtifact {
  let changes: Change[];
  try {
    changes = changesFor(root, base);
  } catch (e) {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: [`git could not name the changed files: ${(e as Error).message.split("\n")[0]}`],
      tests: [],
      graphTests: [],
      censusTests: [],
      censusAbsent: [],
      censusFired: [],
      textTests: [],
      textFired: [],
      textReading: "UNMEASURED",
      textHelpers: [],
      textFilesRead: 0,
      textFilesSeen: 0,
      changed: [],
      testFilesSeen: 0,
      selected: 0,
      sweeps: 0,
    };
  }

  const changed = [...new Set(changes.map(c => c.path))];
  // `onDisk(root)`, not the default: a derived census row resolves against
  // the tree being selected for, and the default reads the repository this
  // module was imported from (#1442).
  const routing = censusTestsFor(changes, onDisk(root));
  const routed = routing.tests;

  const text = textDependents(
    root,
    changes.map(c => ({ path: c.path, hunks: c.hunks })),
  );

  const r = affectedTests(root, changed);
  const base_ = {
    changed,
    censusFired: routing.fired.map(f => ({
      id: f.trigger.id,
      event: f.trigger.event,
      because: f.because,
    })),
    censusAbsent: routed.filter(t => !existsSync(join(root, t))),
    textReading: text.reading,
    textHelpers: text.helpers,
    textFired: text.edges
      .filter(e => e.direct)
      .map(e => ({ reader: e.reader, target: e.target, anchor: e.anchor, from: e.from, to: e.to })),
    textFilesRead: text.filesRead,
    textFilesSeen: text.filesSeen,
    testFilesSeen: r.testFilesSeen,
    selected: r.selected,
    sweeps: r.sweeps.length,
  };
  const fallback = { tests: [], graphTests: [], censusTests: [], textTests: [], ...base_ };

  if (r.reading === "UNMEASURED") {
    return { mode: "FULL_SUITE", fellBackBecause: r.unmeasuredReasons, ...fallback };
  }
  // A router that could not look is not a router that found nothing (#1054).
  // The graph's own UNMEASURED is checked first so the artefact attributes
  // the fallback to one cause rather than two, and both reasons survive.
  if (text.reading === "UNMEASURED") {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: text.unmeasuredReasons.map(
        w => `the text-dependency router could not take a reading: ${w}`,
      ),
      ...fallback,
    };
  }
  if (r.tests.length === 0) {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: [
        "the graph selected no test file at all. That is a measurement, not an error, but a run " +
          "with no tests leaves the recorder no summary to read (#469), so the full suite runs",
      ],
      ...fallback,
    };
  }

  const graphTests = r.tests;
  const censusTests = routed.filter(t => !graphTests.includes(t) && existsSync(join(root, t)));
  // Third, and additive like the second: a file that lifts a region of a
  // changed file out of its text has a dependency the graph expresses no
  // edge for and no census row is about. Attributed separately for the
  // reason the other two are — three contributors with one total is a
  // number nobody can decompose when a file turns out to be missing.
  const textTests = text.tests.filter(
    t => !graphTests.includes(t) && !censusTests.includes(t) && existsSync(join(root, t)),
  );
  const tests = [...graphTests, ...censusTests, ...textTests];

  const unsafe = tests.filter(t => !SAFE_TEST_PATH.test(t));
  if (unsafe.length > 0) {
    return {
      mode: "FULL_SUITE",
      fellBackBecause: [
        `${unsafe.length} selected path(s) are not plain test paths and will not be interpolated ` +
          `into a shell command: ${unsafe.slice(0, 3).join(", ")}`,
      ],
      ...fallback,
    };
  }

  return {
    mode: "SELECTED",
    fellBackBecause: [],
    tests,
    graphTests,
    censusTests,
    textTests,
    ...base_,
  };
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
    // The two halves are reported separately because they answer different
    // questions, and a single total hides the one that is new.
    const census =
      result.censusTests.length > 0
        ? ` + ${result.censusTests.length} census (${result.censusFired.map(f => f.id).join(", ")})`
        : "";
    const text =
      result.textTests.length > 0
        ? ` + ${result.textTests.length} text (${
            new Set(result.textFired.map(f => f.target)).size
          } file(s) lifted)`
        : "";
    console.error(
      `affected-tests: ${result.selected} of ${result.testFilesSeen} files ` +
        `(${result.sweeps} sweeps), from ${result.changed.length} changed${census}${text}`,
    );
    // Coverage, unconditionally: `36/426` and `426/426` are the same PASS
    // when only the verdict is printed (#492).
    console.error(
      `affected-tests: the text router read ${result.textFilesRead} of ` +
        `${result.textFilesSeen} candidate readers`,
    );
    if (result.censusAbsent.length > 0) {
      console.error(
        `affected-tests: ${result.censusAbsent.length} routed census test(s) are not in this ` +
          `tree and were not run: ${result.censusAbsent.slice(0, 3).join(", ")}`,
      );
    }
    console.log(result.tests.join(" "));
  } else {
    console.error(`affected-tests: FULL SUITE — ${result.fellBackBecause[0]}`);
  }
}
