/**
 * The stale sweep must not delete another runner's state (#904).
 *
 * ## What this is pointed at
 *
 * `archiveAndPurge` walks every top-level directory under the harness work
 * root and renames it into `.archive` on `mtime` and `phase` alone. Ten
 * runner processes on asaCommandCenter's pool share `/home/gharunner`, so
 * they share `$HOME/.rungate`, so a SessionStart on one of them archives a
 * sibling's live run directory. The sibling then fails in a step that did
 * nothing wrong, which reads as a flaky test rather than as contention.
 *
 * ## The measurement trap these cases are built around
 *
 * `scripts/test-clean-env.ts` runs suites with `HOME` at an empty `mkdtemp`.
 * An empty work root archives nothing whether the sweep checks ownership or
 * not, so this bug is invisible to the suites that look most rigorous.
 * `AC-5` below asserts that directly: over a root holding no run directories,
 * the refused sweep and the permitted sweep return the SAME counts, and only
 * the `refused` field tells them apart. Every other case here therefore uses
 * a POPULATED root — that is the input on which isolated and shared differ.
 *
 * ## The cheapest wrong fix, and whether these cases survive it
 *
 * `HOME: ${{ runner.temp }}/home` in the workflow YAML. The symptom goes away
 * for CI and the harness keeps its unguarded `$HOME` assumption for every
 * consumer who runs the same jobs without that line. Nothing here reads a
 * workflow file, so that edit changes no verdict below and the ownership-blind
 * sweep stays red — which is the relationship a behavioural case needs. A case
 * that went green under it would be testing the YAML.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { archiveAndPurge, cleanStaleFiles } from "../lib/stale-cleanup";
import {
  WORK_ROOT_OWNER_FILE,
  WORK_ROOT_REFUSED_SHARED,
  WORK_ROOT_REFUSED_UNATTRIBUTED,
  WORK_ROOT_REFUSED_UNNAMABLE,
  claimWorkRoot,
  runnerId,
  workRootOwnership,
} from "../lib/runner-home";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-home-904-"));
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

/** A finished run directory, old enough that the sweep wants to archive it. */
function plantStaleRun(slug: string): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const state = join(dir, "workflow-state.json");
  writeFileSync(state, JSON.stringify({ phase: "DONE" }));
  writeFileSync(join(dir, "PRD.md"), "# PRD\n");
  const old = (Date.now() - 5 * 60 * 60 * 1000) / 1000;
  utimesSync(state, old, old);
  utimesSync(dir, old, old);
  return dir;
}

function markOwner(owner: string): void {
  writeFileSync(join(root, WORK_ROOT_OWNER_FILE), `${owner}\n`);
}

const onRunner = (name: string): NodeJS.ProcessEnv => ({ RUNNER_NAME: name });
const offRunner: NodeJS.ProcessEnv = {};

describe("#904: the stale sweep is ownership-aware", () => {
  // AC-1 control. Off a runner nothing changes, which is what makes this
  // change inert on a developer's machine and in every pre-existing test.
  test("AC-1: off a runner the sweep behaves exactly as before", () => {
    plantStaleRun("some-run");

    const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, offRunner);

    expect(result.refused).toBe(false);
    expect(result.archived).toBe(1);
    expect(existsSync(join(root, "some-run"))).toBe(false);
    expect(existsSync(join(root, ".archive", "some-run"))).toBe(true);
  });

  // AC-2 is the pair, and it varies EXACTLY ONE thing: the value of
  // RUNNER_NAME. Same fixture, same marker, same TTLs. A pair that also
  // varied the marker or the fixture would not be a measurement of ownership.
  describe("AC-2: a populated root, varying only which runner is sweeping", () => {
    test("the owning runner archives its own stale run", () => {
      plantStaleRun("run-of-runner-4");
      markOwner("runner-4");

      const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-4"));

      expect(result.refused).toBe(false);
      expect(result.archived).toBe(1);
      expect(existsSync(join(root, "run-of-runner-4"))).toBe(false);
    });

    test("a sibling runner refuses, and the directory survives", () => {
      plantStaleRun("run-of-runner-4");
      markOwner("runner-4");

      const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-5"));

      expect(result.refused).toBe(true);
      expect(result.archived).toBe(0);
      // The harm itself: runner-4's directory is still where runner-4 left it.
      expect(existsSync(join(root, "run-of-runner-4"))).toBe(true);
      expect(existsSync(join(root, ".archive", "run-of-runner-4"))).toBe(false);
    });

    test("the refusal names both runners and routes through the one constant", () => {
      plantStaleRun("run-of-runner-4");
      markOwner("runner-4");

      const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-5"));

      expect(result.logs).toHaveLength(1);
      const line = result.logs[0]!;
      // "Observable rather than mysterious": a refusal that named neither
      // party would be as unactionable as the silent delete it replaces.
      expect(line).toContain("runner=runner-5");
      expect(line).toContain("owner=runner-4");
      expect(line).toContain(root);
      expect(line).toContain(WORK_ROOT_REFUSED_SHARED);
    });
  });

  // AC-3. The state the pool is in TODAY: a shared home with run directories
  // in it and nothing recording whose they are.
  test("AC-3: an occupied root with no owner recorded is refused, not claimed", () => {
    plantStaleRun("somebody-elses-run");

    const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-5"));

    expect(result.refused).toBe(true);
    expect(result.archived).toBe(0);
    expect(existsSync(join(root, "somebody-elses-run"))).toBe(true);
    expect(result.logs[0]).toContain(WORK_ROOT_REFUSED_UNATTRIBUTED);
    // Claiming an occupied root would be the original bug with a marker file
    // on top: whoever booted first would own everybody's work.
    expect(existsSync(join(root, WORK_ROOT_OWNER_FILE))).toBe(false);
  });

  // AC-4. The state the pool is in once each runner has its own HOME. This is
  // what makes the guard self-bootstrapping rather than permanently refusing.
  test("AC-4: a vacant root is claimed, and the claim persists", () => {
    const verdict = workRootOwnership(root, onRunner("runner-5"));

    expect(verdict.sweep).toBe(true);
    expect(verdict.state).toBe("claimed");
    expect(readFileSync(join(root, WORK_ROOT_OWNER_FILE), "utf-8").trim()).toBe("runner-5");

    // And a later stale run of its own is swept normally.
    plantStaleRun("my-own-run");
    const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-5"));
    expect(result.refused).toBe(false);
    expect(result.archived).toBe(1);
  });

  // AC-5 is the measurement trap, asserted rather than described. This is the
  // case that says why every other case above plants a run directory.
  test("AC-5: over an unpopulated root the counts agree and only `refused` differs", () => {
    markOwner("runner-4");

    const sibling = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-5"));
    const owner = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-4"));

    // Every count is identical, so a suite running under an empty HOME cannot
    // tell an ownership-aware sweep from an ownership-blind one.
    expect(sibling.archived).toBe(owner.archived);
    expect(sibling.purged).toBe(owner.purged);
    expect(sibling.skipped).toBe(owner.skipped);
    // `0` is not success. The reading is the only discriminator there is.
    expect(sibling.refused).toBe(true);
    expect(owner.refused).toBe(false);
  });

  // AC-6. `cleanStaleFiles` deletes `.ship-active` files before it ever calls
  // archiveAndPurge, so guarding only the archive pass would leave half the
  // destruction unguarded.
  test("AC-6: a sibling's .ship-active survives the refused sweep", () => {
    const dir = plantStaleRun("run-of-runner-4");
    const ship = join(dir, ".ship-active");
    writeFileSync(ship, "");
    const old = (Date.now() - 5 * 60 * 60 * 1000) / 1000;
    utimesSync(ship, old, old);
    markOwner("runner-4");

    const result = cleanStaleFiles(root, FOUR_HOURS, 7 * 24 * 60 * 60 * 1000, onRunner("runner-5"));

    expect(result.refused).toBe(true);
    expect(result.deleted).toBe(0);
    expect(existsSync(ship)).toBe(true);

    // The owning runner deletes it, over the identical fixture.
    const owned = cleanStaleFiles(root, FOUR_HOURS, 7 * 24 * 60 * 60 * 1000, onRunner("runner-4"));
    expect(owned.refused).toBe(false);
    expect(owned.deleted).toBe(1);
    expect(existsSync(ship)).toBe(false);
  });

  // AC-7. RUNNER_NAME set to something unusable must refuse, not fall through
  // to the unscoped branch — a fail-open there would restore the whole bug for
  // any pool whose runner names are punctuation.
  test("AC-7: an unnamable runner refuses rather than sweeping unscoped", () => {
    plantStaleRun("somebody-elses-run");

    const result = archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("///"));

    expect(result.refused).toBe(true);
    expect(result.logs[0]).toContain(WORK_ROOT_REFUSED_UNNAMABLE);
    expect(existsSync(join(root, "somebody-elses-run"))).toBe(true);
  });

  // AC-7b. Found by the battery, not by reading: emptying the `.archive`
  // read's catch was 0 red, so nothing reached the branch. A root whose
  // `.archive` cannot be listed is a root this process knows nothing about,
  // and "I could not tell" must not read as "nothing here to protect".
  // `.archive` is planted as a FILE rather than chmod 000 so the case means
  // the same thing when the suite runs as root.
  test("AC-7b: a root whose .archive cannot be listed is not treated as vacant", () => {
    writeFileSync(join(root, ".archive"), "not a directory");

    const verdict = workRootOwnership(root, onRunner("runner-5"));

    expect(verdict.sweep).toBe(false);
    expect(verdict.state).toBe("unattributed");
    expect(existsSync(join(root, WORK_ROOT_OWNER_FILE))).toBe(false);
  });

  // AC-8. One discriminator, asserted across every state the verdict can
  // reach, so a later state cannot arrive carrying a reason and a green sweep.
  test("AC-8: `sweep` is false exactly when a reason was given", () => {
    const seen = new Set<string>();

    const cases: Array<[string, () => void, NodeJS.ProcessEnv]> = [
      ["unscoped", () => {}, offRunner],
      ["unnamable", () => {}, onRunner("...")],
      ["claimed", () => {}, onRunner("runner-5")],
      ["owned", () => markOwner("runner-5"), onRunner("runner-5")],
      ["shared", () => markOwner("runner-4"), onRunner("runner-5")],
      ["unattributed", () => { plantStaleRun("x"); }, onRunner("runner-5")],
    ];

    for (const [expected, setup, env] of cases) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      setup();

      const verdict = workRootOwnership(root, env);
      expect(verdict.state).toBe(expected as never);
      expect(verdict.sweep).toBe(verdict.reason === null);
      seen.add(verdict.state);
    }

    // Vacuity guard: the loop above must really have reached six states, or
    // the invariant is being asserted about nothing.
    expect(seen.size).toBe(6);
  });

  // AC-9. #904's fourth success criterion read from the other side: isolation
  // must not be achieved by making the reading blind. A refused sweep leaves
  // the tree untouched, so a write into another runner's tree is still there
  // to be found by the ai-review outside reading.
  test("AC-9: refusing leaves the sibling tree intact rather than hiding it", () => {
    plantStaleRun("run-of-runner-4");
    markOwner("runner-4");
    const before = readdirSync(root).sort();

    archiveAndPurge(root, FOUR_HOURS, THIRTY_DAYS, onRunner("runner-5"));

    expect(readdirSync(root).sort()).toEqual(before);
  });
});

describe("#904: runner identity", () => {
  test("a hosted runner name is slugged into a usable owner id", () => {
    // GitHub Actions names hosted runners with spaces in them.
    expect(runnerId({ RUNNER_NAME: "GitHub Actions 2" })).toBe("github-actions-2");
    expect(runnerId({ RUNNER_NAME: "  runner-4  " })).toBe("runner-4");
  });

  test("absent and unusable names both read as no runner id", () => {
    expect(runnerId({})).toBeNull();
    expect(runnerId({ RUNNER_NAME: "" })).toBeNull();
    expect(runnerId({ RUNNER_NAME: "///" })).toBeNull();
  });

  test("two differently-named runners never share an owner id", () => {
    expect(runnerId({ RUNNER_NAME: "runner-4" })).not.toBe(runnerId({ RUNNER_NAME: "runner-5" }));
  });

  // Without this the attribution assertions above are satisfiable by emptying
  // every constant: `expect(line).toContain("")` is true of any string.
  test("the refusal constants are distinct and non-empty", () => {
    const all = [WORK_ROOT_REFUSED_SHARED, WORK_ROOT_REFUSED_UNATTRIBUTED, WORK_ROOT_REFUSED_UNNAMABLE];
    for (const constant of all) expect(constant.length).toBeGreaterThan(40);
    expect(new Set(all).size).toBe(3);
  });

  test("claiming is idempotent and readable back as ownership", () => {
    expect(claimWorkRoot(root, "runner-5")).toBe(true);
    expect(claimWorkRoot(root, "runner-5")).toBe(true);
    expect(workRootOwnership(root, onRunner("runner-5")).state).toBe("owned");
  });
});
