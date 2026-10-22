/**
 * #1129 — the roots reach `workflows/ship.js` unresolved, so a containment
 * check compares a symlink against a realpath.
 *
 * ## The bug, exhibited rather than described
 *
 * `collectDestination` in `workflows/ship.js` decides whether a directory is
 * one this run may write to, by `startsWith` against `PROJECT_ROOT` and
 * `HARNESS_ROOT`. It compares STRINGS, and it has no alternative:
 * `workflows/*.js` runs in a sandbox with no `require`, no `import()`, no
 * `process` and no `Bun` (#69, enforced by `scripts/validate-workflow.ts`),
 * so `realpathSync` is not reachable from that file at all.
 *
 * A string compare and a realpath compare agree on every path that is
 * already canonical, and disagree the moment one side is reached through a
 * symlink. This repository is reachable under two names and the symlinked
 * one is the name a person types, so the disagreement is not hypothetical.
 *
 * ## Two different bugs wearing one name
 *
 * Measured on `origin/main` against ONE physical directory spelled two ways:
 *
 *   roots = symlinked, target = canonical  -> refused   (witness A)
 *   roots = canonical, target = canonical  -> allowed   (control)
 *   roots = canonical, target = symlinked  -> refused   (witness B)
 *
 * Canonicalising the ROOTS fixes witness A. It does **not** fix witness B —
 * the target there is an agent-reported path reaching an already-canonical
 * root, and nothing outside the sandbox ever sees that string. The cases
 * below assert both, including the one that stays refused, so the coverage
 * boundary is in the suite rather than in a sentence somebody has to
 * remember.
 *
 * ## The symlink is built here, not borrowed from the platform
 *
 * CI runs Linux, where `tmpdir()` is `/tmp` and is not a symlink. macOS
 * gives `/var/folders/...`, which IS a symlink to `/private/var`. A test
 * that leaned on the platform's own link would pass on one and fail on the
 * other while appearing to test the same thing, so every case below calls
 * `symlinkSync` itself and `realpathSync`es the temp root first to take the
 * platform's link out of the comparison entirely.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { canonicalRoot, harnessRootFor } from "../../lib/paths";
import { launchBaseReading, launchBaseRefusal } from "../../lib/launch-base";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const made: string[] = [];

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/**
 * One physical git repository reachable under two names.
 *
 * `realpathSync` on the `mkdtemp` result first: on macOS that result is
 * already behind `/var -> /private/var`, and leaving it in place would mean
 * the "canonical" arm of every case below was itself non-canonical — the
 * test would then measure the platform's link and not the one it built.
 */
function twoNamedRepo(): { canonical: string; linked: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rg1129-")));
  made.push(base);
  const canonical = join(base, "canonical-name");
  mkdirSync(canonical, { recursive: true });
  execFileSync("git", ["-C", canonical, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", canonical, "remote", "add", "origin", "https://example.invalid/o/r.git"]);
  writeFileSync(join(canonical, "f.txt"), "x\n");
  execFileSync("git", ["-C", canonical, "add", "f.txt"]);
  execFileSync("git", [
    "-C", canonical,
    "-c", "user.email=t@example.invalid",
    "-c", "user.name=t",
    "commit", "-qm", "init",
  ]);

  const linked = join(base, "linked-name");
  symlinkSync(canonical, linked); // explicitly ours, never the platform's
  return { canonical, linked };
}

/** `collectDestination`, pulled out of ship.js and EXECUTED (#155's pattern). */
function loadCollectDestination(): (d: unknown, p?: string, h?: string) => string | null {
  const src = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
  const a = src.indexOf("// ──── COLLECT-DESTINATION-START ────");
  const b = src.indexOf("// ──── COLLECT-DESTINATION-END ────");
  if (a < 0 || b < 0) throw new Error("COLLECT-DESTINATION markers not found in ship.js");
  return new Function("PROJECT_ROOT", "HARNESS_ROOT", `${src.slice(a, b)}\nreturn collectDestination`)(
    "/unused",
    "/unused",
  );
}

describe("#1129: canonicalRoot is the one place a root is resolved", () => {
  test("it follows a symlink, which resolve() does not", () => {
    const { canonical, linked } = twoNamedRepo();
    // The premise, asserted rather than assumed: two spellings, one directory.
    expect(linked).not.toBe(canonical);
    expect(realpathSync(linked)).toBe(canonical);

    expect(canonicalRoot(linked)).toBe(canonical);
  });

  test("a canonical root is returned unchanged — the control", () => {
    const { canonical } = twoNamedRepo();
    expect(canonicalRoot(canonical)).toBe(canonical);
  });

  test("it normalises traversal and relative segments, as resolve() did", () => {
    const { canonical } = twoNamedRepo();
    expect(canonicalRoot(`${canonical}/./sub/..`)).toBe(canonical);
  });

  test("a root that cannot be resolved refuses — it is never passed through as-is", () => {
    const { canonical } = twoNamedRepo();
    const missing = join(canonical, "no-such-directory");
    // Passing the unresolvable string through would be the silent failure
    // the acceptance names: the caller would get a root that resolves to
    // nothing and compare against it happily.
    expect(() => canonicalRoot(missing)).toThrow(/cannot be resolved/i);
    expect(() => canonicalRoot("")).toThrow();
  });
});

describe("#1129: harnessRootFor canonicalises, and stays total where it must", () => {
  test("a symlinked harness root resolves — the seat the issue names", () => {
    const { canonical, linked } = twoNamedRepo();
    expect(harnessRootFor(linked)).toBe(canonical);
  });

  test("a root that does not exist is still normalised, not thrown on", () => {
    // The asymmetry with canonicalRoot(), asserted so it cannot be
    // "tidied up" into a throw. Callers name trees that are not on this
    // disk — scripts/sync-spec-tests.ts takes one from argv[2] and
    // gates/run-gate.ts from HARNESS_ROOT — and both have cases that do.
    // The refusal belongs at the launch gate, where it is, not in a path
    // helper used in the middle of unrelated work.
    expect(harnessRootFor("/no/such/tree/./here/..")).toBe("/no/such/tree");
  });

  test("an empty root still throws — there is no tree to fall back to", () => {
    expect(() => harnessRootFor("")).toThrow();
  });
});

describe("#1129: launchBaseReading can report a non-canonical root", () => {
  test("a symlinked projectRoot reads NON_CANONICAL_ROOT, not SAME_CHECKOUT", () => {
    const { canonical, linked } = twoNamedRepo();
    // `git rev-parse --show-toplevel` RESOLVES symlinks, so both spellings
    // produce one toplevel and the existing comparison cannot see the
    // difference. That is the structural blindness #1129 names: the check
    // that could notice agrees, then hands the unresolved string onward.
    const reading = launchBaseReading(canonical, linked);
    expect(reading.reading).toBe("NON_CANONICAL_ROOT");
  });

  test("the refusal names the canonical spelling to relaunch with", () => {
    const { canonical, linked } = twoNamedRepo();
    const refusal = launchBaseRefusal(canonical, linked);
    expect(refusal).not.toBeNull();
    // Actionable in one step, or it is just a louder version of the silence.
    expect(refusal).toContain(canonical);
  });

  test("a canonical projectRoot still clears — the control", () => {
    const { canonical } = twoNamedRepo();
    expect(launchBaseReading(canonical, canonical).reading).toBe("SAME_CHECKOUT");
    expect(launchBaseRefusal(canonical, canonical)).toBeNull();
  });

  test("a symlinked HARNESS root is caught too, with projectRoot clean", () => {
    const { canonical, linked } = twoNamedRepo();
    // The issue's title names both roots, and `harnessRootFor()` is not the
    // only producer — a hand-typed `--harness-root` never goes through it.
    // So the gate takes the value rather than trusting the producer.
    const r = launchBaseReading(canonical, canonical, linked);
    expect(r.reading).toBe("NON_CANONICAL_ROOT");
    expect(launchBaseRefusal(canonical, canonical, linked)).toContain("harnessRoot");
  });

  test("an omitted harnessRoot is skipped, not treated as canonical", () => {
    const { canonical } = twoNamedRepo();
    expect(launchBaseReading(canonical, canonical, undefined).reading).toBe("SAME_CHECKOUT");
  });

  test("an unresolvable root is UNMEASURED, and that is not NON_CANONICAL_ROOT", () => {
    const { canonical } = twoNamedRepo();
    // Kept apart on purpose: "this root has two names" is fixed by
    // relaunching with the other one, and "this root does not exist" is
    // not. Collapsing them would hand the operator a remedy that cannot work.
    const r = launchBaseReading(canonical, canonical, join(canonical, "absent"));
    expect(r.reading).toBe("UNMEASURED");
  });
});

describe("#1129: what canonical roots do and do not fix in ship.js", () => {
  const collectDestination = loadCollectDestination();

  test("witness A: a canonical worktree under a SYMLINKED root was refused, and canonical roots fix it", () => {
    const { canonical, linked } = twoNamedRepo();
    const worktree = `${canonical}/.claude/worktrees/wf_a-1`;

    // Before: the root is the name a person types, the worktree path is what
    // `git worktree list` reports — git resolves, the operator does not.
    expect(collectDestination(worktree, linked, linked)).toBeNull();

    // After: the roots are canonicalised at the caller, so the sandboxed
    // string compare only ever sees one spelling.
    const root = canonicalRoot(linked);
    expect(collectDestination(worktree, root, root)).toBe(worktree);
  });

  test("witness B: a SYMLINKED target under canonical roots stays refused — the boundary, asserted", () => {
    const { canonical, linked } = twoNamedRepo();
    const linkedWorktree = `${linked}/.claude/worktrees/wf_a-1`;
    const root = canonicalRoot(canonical);

    // Canonicalising the roots cannot reach this one: the target string is
    // reported by an agent (#155) and is never seen outside the sandbox,
    // which has no filesystem to resolve it with. Asserted so the PR cannot
    // quietly imply a coverage it does not have — this is what the
    // SYMLINK-HINT refusal in ship.js still covers.
    expect(collectDestination(linkedWorktree, root, root)).toBeNull();
  });

  test("the control: canonical root, canonical target, unchanged", () => {
    const { canonical } = twoNamedRepo();
    const worktree = `${canonical}/.claude/worktrees/wf_a-1`;
    const root = canonicalRoot(canonical);
    expect(collectDestination(worktree, root, root)).toBe(worktree);
  });
});

describe("#1129: the sandbox constraint is unchanged", () => {
  test("no workflow gains a filesystem call", () => {
    // Acceptance 4. The fix is at the caller precisely BECAUSE it cannot be
    // here; a later edit that "simplifies" it back into the workflow would
    // not run in the sandbox at all (#69).
    const src = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    const block = src.slice(
      src.indexOf("// ──── COLLECT-DESTINATION-START ────"),
      src.indexOf("// ──── COLLECT-DESTINATION-END ────"),
    );
    expect(block).not.toContain("realpathSync");
    expect(block).not.toContain("require(");
  });
});
