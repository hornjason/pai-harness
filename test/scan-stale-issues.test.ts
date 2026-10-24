import { afterEach, describe, test, expect } from "bun:test";
import { join } from "path";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { scanStaleIssues } from "../scripts/scan-stale-issues";

/**
 * #1473. Three things were wrong here and only one of them was the slow test.
 *
 * **1. A fixed in-repo scratch root.** All four cases wrote
 * `join(import.meta.dir, ".tmp-scan-test")` — one directory, shared by every
 * concurrent run of this file, with a recursive delete on the end of each
 * case. `.claude/rules/self-referential-tests.md` has a Tier 2 row for
 * exactly this and `test/scratch-paths-unique.test.ts` did not catch it,
 * because the parse required `join`'s first argument to be an IDENTIFIER and
 * this file never bound one. That blind spot is fixed in
 * `lib/scratch-roots.ts`; this file is the instance it was blind to.
 *
 * **2. Cleanup inside each case, wrapped in `try { … } catch {}`.** A case
 * that failed before reaching `cleanup()` left the directory for the next
 * one, so the first failure could poison the rest of the file. `afterEach`
 * runs whether the case passed or threw.
 *
 * **3. The reason it was slow, which is not the reason the issue gives.**
 * `dryRun: true` does not suppress `checkIssueOpen`, so every case spawned
 * `gh issue view` once per scanned issue, each with a 15s timeout. MEASURED
 * with a fake `gh` first on a child's PATH: `scanned: 2` produced exactly two
 * invocations,
 *
 *     gh issue view 550 --repo test/repo --json state --jq .state
 *     gh issue view 552 --repo test/repo --json state --jq .state
 *
 * which is why the four durations tracked `scanned` rather than file order —
 * 0 scanned took 0.36ms and 2 scanned took 8319ms against a 5000ms budget.
 * It is NOT the cold `require`: that sat in the `describe` body, which runs
 * at collection time and is not covered by any per-test timeout at all.
 *
 * The cases now inject the reading. Every one of them injects, including the
 * ones that scan nothing, so no case can quietly reacquire the subprocess.
 */

const ROOT = join(import.meta.dir, "..");

/** Every issue is open. The production default is a `gh` subprocess. */
const ALL_OPEN = () => true;

describe("scan-stale-issues", () => {
  let tmpDir = "";

  /**
   * Every directory `setup` has ever made, so the last case can check the
   * earlier ones were really removed. Without this, deleting the `afterEach`
   * below reddens NOTHING in this file: each case creates its own directory
   * and never looks at anybody else's, so a cleanup that stopped running
   * would leak silently and every assertion would still hold.
   */
  const created: string[] = [];

  afterEach(() => {
    // Not in a try/catch. A cleanup that swallows its own failure leaves the
    // directory behind and reports success, which is how one case's fixture
    // becomes the next case's input.
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  function setup(phases: unknown[]): string {
    tmpDir = mkdtempSync(join(ROOT, ".tmp-scan-test-"));
    created.push(tmpDir);
    writeFileSync(join(tmpDir, "project-state.json"), JSON.stringify({ phases }));
    return tmpDir;
  }

  test("extracts issue numbers from phase names", () => {
    const root = setup([
      { name: "Phase F (#550-#552)", scs: [{ id: "SC-1", done: true }] },
      { name: "Brief Compliance (#558)", scs: [{ id: "SC-2", done: false }] },
    ]);
    const result = scanStaleIssues({ projectRoot: root, dryRun: true, repo: "test/repo", isIssueOpen: ALL_OPEN });
    expect(result.scanned).toBe(2);
  });

  test("skips phases with incomplete SCs", () => {
    const root = setup([
      { name: "Done (#100)", scs: [{ id: "SC-1", done: true }] },
      { name: "Partial (#200)", scs: [{ id: "SC-2", done: true }, { id: "SC-3", done: false }] },
    ]);
    const result = scanStaleIssues({ projectRoot: root, dryRun: true, repo: "test/repo", isIssueOpen: ALL_OPEN });
    expect(result.scanned).toBe(1);
  });

  test("skips phases with no SCs", () => {
    const root = setup([{ name: "Empty (#300)", scs: [] }]);
    const result = scanStaleIssues({ projectRoot: root, dryRun: true, repo: "test/repo", isIssueOpen: ALL_OPEN });
    expect(result.scanned).toBe(0);
  });

  test("respects exclude list", () => {
    const root = setup([
      { name: "Done (#100)", scs: [{ id: "SC-1", done: true }] },
      { name: "Also Done (#200)", scs: [{ id: "SC-2", done: true }] },
    ]);
    const result = scanStaleIssues({
      projectRoot: root, dryRun: true, repo: "test/repo", exclude: [100], isIssueOpen: ALL_OPEN,
    });
    expect(result.scanned).toBe(1);
  });

  /**
   * #1473: the seam, asserted rather than assumed.
   *
   * Every case above passes `isIssueOpen`, so none of them can tell you the
   * parameter is consulted — they would all read the same if the default ran
   * instead. This one counts the calls and names the issues, so a refactor
   * that drops the seam and goes back to `checkIssueOpen` turns it red.
   */
  test("#1473: the open-check is injected, and it is what dryRun does NOT suppress", () => {
    const asked: number[] = [];
    const root = setup([
      { name: "Phase F (#550-#552)", scs: [{ id: "SC-1", done: true }] },
    ]);
    const result = scanStaleIssues({
      projectRoot: root,
      dryRun: true,
      repo: "test/repo",
      isIssueOpen: n => {
        asked.push(n);
        return true;
      },
    });
    expect(asked, "the injected reading was never consulted — the default gh subprocess ran instead")
      .toEqual([550, 552]);
    // dryRun suppresses the WRITE, not the reading. An issue reported as
    // would-be-closed is one the reading said was open.
    expect(result.closed).toEqual([550, 552]);
    expect(result.dryRun).toBe(true);
  });

  /**
   * #1473: a closed issue is not a stale one, and this is the case that makes
   * the reading's RESULT matter. Without it, `isIssueOpen` could return a
   * constant and every assertion above would hold.
   */
  test("#1473: an issue the reading calls closed is scanned but not reported", () => {
    const root = setup([{ name: "Phase F (#550-#552)", scs: [{ id: "SC-1", done: true }] }]);
    const result = scanStaleIssues({
      projectRoot: root, dryRun: true, repo: "test/repo", isIssueOpen: n => n === 550,
    });
    expect(result.scanned).toBe(2);
    expect(result.closed).toEqual([550]);
  });

  /**
   * #1473: the scratch root is unique per run AND is really removed.
   *
   * `test/scratch-paths-unique.test.ts` reads this file's SOURCE and would be
   * satisfied by the `mkdtempSync` spelling alone. This reads the
   * FILESYSTEM, so a cleanup that silently stopped running is visible here
   * and nowhere else.
   */
  test("#1473: each run gets its own scratch root, and afterEach removes it", () => {
    const a = setup([]);
    const b = setup([]);
    expect(a, "two setups in one case produced the same directory").not.toBe(b);
    expect(a.startsWith(join(ROOT, ".tmp-scan-test-"))).toBe(true);
    // `a` is leaked on purpose — `setup` overwrote the handle, which is the
    // one shape afterEach cannot clean. Remove it here rather than leave it
    // for the sweeper, and assert it was there to remove.
    expect(existsSync(a), "the first scratch root was never created").toBe(true);
    rmSync(a, { recursive: true, force: true });
  });

  /**
   * #1473: the cleanup is WITNESSED, not merely written.
   *
   * Runs last, and reads the filesystem for every directory the cases above
   * made, excluding the one belonging to this case — `afterEach` has not run
   * for it yet. Deleting the `afterEach` turns this red and names the leaks.
   *
   * The vacuity control is read first and it is the whole reason this is not
   * a decorative case: an empty `created` list satisfies "nothing leaked"
   * perfectly, and would do so if `setup` were never called at all.
   */
  test("#1473: afterEach really removed every earlier scratch root", () => {
    const earlier = created.filter(d => d !== tmpDir);
    expect(
      earlier.length,
      "no scratch root was recorded, so this case compared two empty lists",
    ).toBeGreaterThanOrEqual(5);
    expect(
      earlier.filter(existsSync),
      "scratch roots survived their case — the afterEach cleanup is not running",
    ).toEqual([]);
  });
});
