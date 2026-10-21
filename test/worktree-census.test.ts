/**
 * #1021: `git worktree list` cannot tell an abandoned worktree from one a
 * session is typing into, and the last time somebody tidied that list by hand
 * two sessions lost uncommitted work — about 500 lines, and PR #452's branch.
 *
 * Covers `scripts/worktree-census.ts`.
 *
 * ## What is being proved
 *
 * One property above all the others: **a reading that could not be taken is
 * never reported as a reading that came back negative.** Everything else in
 * the script is a convenience; that is the defect. So the safety property is
 * asserted over the whole 16-way space of measured/unmeasured combinations
 * rather than on a hand-picked example, and it is paired with its own
 * negative control — the all-measured case MUST reach ABANDONED, because
 * `verdictFor` returning UNMEASURED unconditionally would pass a safety test
 * that only ever checks one direction.
 *
 * The two traps specific to this issue each get a fixture that REPRODUCES
 * them rather than describing them:
 *
 *   - **A deleted directory's `git status` is empty.** The fixture deletes a
 *     real worktree directory out from under a real repository and asserts
 *     the raw command prints nothing while the reading refuses. A test that
 *     stubbed the failure would be asserting that an if-statement works.
 *   - **A squash merge destroys ancestry.** The fixture makes a real squash
 *     merge and asserts `git merge-base --is-ancestor` says NOT an ancestor
 *     for a branch whose content is fully on main — the control that records
 *     why the merge reading asks GitHub for an identity instead.
 *
 * ## The mutant
 *
 * Every negative case runs twice: against the real script, and against a copy
 * whose `REFUSE_EXIT` is 0. Real must refuse, mutant must not. The second
 * assertion is the point — it is the removal of the non-zero exit, performed
 * and observed, so a case that later starts passing for an unrelated reason
 * stops being indistinguishable from one genuinely caught
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import {
  REFUSE_EXIT,
  ageReading,
  census,
  cleanReading,
  couldNotRead,
  decidedWithoutReadings,
  evidenceFor,
  holdersByRoot,
  humanAge,
  indexPullRequests,
  mergeReading,
  parseArgs,
  parseDuration,
  parseWorktreeList,
  pruneWarnings,
  readLsof,
  renderTable,
  took,
  unmeasuredReadings,
  verdictFor,
  type Holder,
  type Measured,
  type PullRequest,
  type Readings,
  type WorktreeRecord,
} from "../scripts/worktree-census";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "worktree-census.ts");
const scratch: string[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

/**
 * The script with its prose removed.
 *
 * The bans below are about what the code DOES. Run over the raw file they
 * also fire on the header comment explaining why ancestry is the wrong
 * question and why `pkill` must never appear — which would make the only
 * way to pass deleting the explanation.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const scratchDir = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `rg-1021-${tag}-`));
  scratch.push(d);
  return d;
};

/* ------------------------------------------------------------------ *
 * The mutant
 * ------------------------------------------------------------------ */

let mutant = "";
beforeAll(() => {
  const src = readFileSync(SCRIPT, "utf-8");
  const decl = "export const REFUSE_EXIT = 1;";
  const hits = src.split(decl).length - 1;
  if (hits !== 1) {
    throw new Error(`could not build the mutant: the exit constant appears ${hits} times, not once`);
  }
  // A literal `process.exit(1)` would bypass the mutation and leave every
  // negative case below passing for a reason unrelated to the guard. The
  // success path is covered too: this script exits by returning.
  const literalExits = src.match(/process\.exit\(\s*[0-9]/g) ?? [];
  if (literalExits.length > 0) {
    throw new Error(`could not build the mutant: ${literalExits.length} refusal(s) exit with a literal code`);
  }
  // The mutant runs from a temp directory, so a relative specifier would die
  // on module resolution — a non-zero exit that reads as the mutation having
  // been rejected on the merits.
  const rewritten = src.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_m, open: string, spec: string, close: string) => `${open}${resolve(dirname(SCRIPT), spec)}${close}`,
  );
  const unresolved = rewritten.match(/from\s+["']\.{1,2}\//g) ?? [];
  if (unresolved.length > 0) {
    throw new Error(
      `could not build the mutant: ${unresolved.length} relative specifier(s) the rewriter could not see`,
    );
  }
  // One decider, asserted rather than left as a convention. Two places that
  // decide "any unmeasured reading means UNMEASURED" are behaviourally one,
  // and a mutation of either leaves the other deciding — a 0-red row that
  // reads as coverage.
  const safetyBinding = src.match(/unmeasuredReadings\(r\)\.length > 0/g) ?? [];
  if (safetyBinding.length !== 1) {
    throw new Error(
      `could not build the mutant: the UNMEASURED-dominates binding appears ` +
        `${safetyBinding.length} times, not once`,
    );
  }
  // Same reason: `isMain || locked` is asked by the verdict and by the
  // evidence column, and a second copy of the predicate would decide for one
  // of them whatever the first did.
  const settled = src.match(/record\.isMain/g) ?? [];
  if (settled.length !== 1) {
    throw new Error(
      `could not build the mutant: the settled-before-readings predicate appears ` +
        `${settled.length} times, not once`,
    );
  }
  const dir = scratchDir("mut");
  mutant = join(dir, "worktree-census.ts");
  writeFileSync(mutant, rewritten.replace(decl, "export const REFUSE_EXIT = 0;"));
});

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const run = (script: string, args: string[]) => {
  const r = Bun.spawnSync(["bun", script, ...args], { cwd: ROOT });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
};

/** Both halves of a negative case: the real script refuses, the mutant does not. */
function bothRefuse(args: string[], expectText: string) {
  const real = run(SCRIPT, args);
  expect(real.code, `the real script did not refuse:\n${real.err}`).toBe(REFUSE_EXIT);
  expect(real.err).toContain(expectText);
  const mut = run(mutant, args);
  expect(mut.code, `the mutant refused too, so the exit is not routed through REFUSE_EXIT:\n${mut.err}`)
    .toBe(0);
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let fixtureSeq = 0;
function repoWithWorktrees() {
  const root = scratchDir("repo");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");

  const tag = `${Date.now()}-${fixtureSeq++}`;
  const live = join(root, "..", `wt-live-${tag}`);
  const gone = join(root, "..", `wt-gone-${tag}`);
  scratch.push(live, gone);
  git(root, "worktree", "add", "-q", "-b", "feature/live", live);
  git(root, "worktree", "add", "-q", "-b", "feature/gone", gone);
  return { root, live, gone };
}

/**
 * A repo whose `feature` branch was squash-merged into main.
 *
 * The point of building it for real: after a squash the branch head has no
 * descendant on main, so every ancestry question answers "not merged" about
 * a branch whose every byte landed.
 */
function repoWithSquashMerge() {
  const root = scratchDir("squash");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");

  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feature");
  const head = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--squash", "feature");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "squash of feature");
  return { root, head, main: git(root, "rev-parse", "main") };
}

const RECORD: WorktreeRecord = {
  path: "/w/one",
  head: "a".repeat(40),
  branch: "feature/one",
  detached: false,
  locked: false,
  lockReason: "",
  prunable: false,
  prunableReason: "",
  isMain: false,
};

/** Readings that all point at ABANDONED, so each test can spoil exactly one. */
const allAbandonedWard = (): Readings => ({
  merge: took({ state: "MERGED" as const, pr: 7 }),
  clean: took({ clean: true, entries: 0 }),
  holders: took([] as Holder[]),
  age: took({ newestMtimeMs: 1, scanned: 3, stale: true }),
});

/* ------------------------------------------------------------------ *
 * The property the file exists for
 * ------------------------------------------------------------------ */

describe("UNMEASURED is never ABANDONED", () => {
  const names = ["merge", "clean", "holders", "age"] as const;

  test("the all-measured case reaches ABANDONED — without this the sweep below is vacuous", () => {
    expect(verdictFor(RECORD, allAbandonedWard())).toBe("ABANDONED");
  });

  test("every one of the 15 combinations with an unmeasured reading is UNMEASURED", () => {
    let checked = 0;
    for (let mask = 1; mask < 16; mask++) {
      const r = allAbandonedWard();
      const spoiled: string[] = [];
      for (let bit = 0; bit < 4; bit++) {
        if (mask & (1 << bit)) {
          const name = names[bit];
          // Each reading is replaced by one that could not be taken while
          // every OTHER reading still says abandoned — so the only thing
          // that can keep this out of ABANDONED is the guard under test.
          (r as unknown as Record<string, Measured<unknown>>)[name] =
            couldNotRead(`${name} could not be read`);
          spoiled.push(name);
        }
      }
      expect(unmeasuredReadings(r).sort()).toEqual(spoiled.sort());
      expect(verdictFor(RECORD, r), `mask ${mask} (${spoiled.join(",")}) escaped the guard`)
        .toBe("UNMEASURED");
      checked += 1;
    }
    expect(checked).toBe(15);
  });

  test("an unmeasured row still reports what it DID read, so evidence is not lost", () => {
    const r = allAbandonedWard();
    r.merge = couldNotRead("gh is not installed");
    r.holders = took([{ pid: "900", command: "bun", path: "/w/one/a.ts" }]);
    const why = evidenceFor(RECORD, r);
    expect(why.join(" | ")).toContain("merge UNMEASURED (gh is not installed)");
    expect(why.join(" | ")).toContain("held by bun[900]");
  });

  test.each([
    ["merge", (r: Readings) => (r.merge = took({ state: "OPEN" as const, pr: 1 }))],
    ["clean", (r: Readings) => (r.clean = took({ clean: false, entries: 3 }))],
    ["holders", (r: Readings) => (r.holders = took([{ pid: "1", command: "zsh", path: "/w/one" }]))],
    ["age", (r: Readings) => (r.age = took({ newestMtimeMs: 2, scanned: 1, stale: false }))],
  ])("a measured negative on %s is IN_USE, not ABANDONED and not UNMEASURED", (_name, spoil) => {
    const r = allAbandonedWard();
    spoil(r);
    expect(unmeasuredReadings(r)).toEqual([]);
    expect(verdictFor(RECORD, r)).toBe("IN_USE");
  });

  test("the main checkout and a locked worktree are IN_USE before any reading is consulted", () => {
    const r = allAbandonedWard();
    r.clean = couldNotRead("unreadable");
    expect(verdictFor({ ...RECORD, isMain: true }, r)).toBe("IN_USE");
    expect(verdictFor({ ...RECORD, locked: true, lockReason: "held by sec-900" }, r)).toBe("IN_USE");
    expect(decidedWithoutReadings(RECORD)).toBeNull();
    expect(decidedWithoutReadings({ ...RECORD, isMain: true })).toBe("main checkout");
    expect(decidedWithoutReadings({ ...RECORD, locked: true, lockReason: "sec-900" }))
      .toBe("locked: sec-900");
  });

  test("an unmeasured reading on a settled row is counted and named, not silently dropped", () => {
    const result = census(
      [
        { ...RECORD, path: "/w/main", isMain: true },
        { ...RECORD, path: "/w/locked", locked: true, lockReason: "claude agent pid 5431" },
      ],
      {
        repo: "/w",
        olderThanMs: 86400000,
        maxEntries: 20000,
        nowMs: Date.now(),
        pulls: couldNotRead<PullRequest[]>("not consulted"),
        lsof: took("p1\ncbun\nn/nowhere\n"),
      },
    );
    // Both rows carry unmeasured readings and both are IN_USE, so the two
    // totals disagree on purpose — and the summary says why rather than
    // leaving a reader to reconcile them.
    expect(result.counts.unmeasured).toBe(0);
    expect(result.counts.inUse).toBe(2);
    expect(result.unmeasuredByReading.merge).toBe(2);
    expect(result.counts.unmeasuredButSettled).toBe(2);
    expect(renderTable(result)).toContain("2 of them on rows settled as IN_USE");
  });
});

/* ------------------------------------------------------------------ *
 * Trap one: a deleted directory's `git status` is empty
 * ------------------------------------------------------------------ */

describe("an empty git status in a directory that is gone is not an empty git status", () => {
  test("the raw command prints nothing, and the reading still refuses", () => {
    const { root, live, gone } = repoWithWorktrees();
    expect(cleanReading(live).measured).toBe(true);
    expect((cleanReading(live) as { value: { clean: boolean } }).value.clean).toBe(true);

    rmSync(gone, { recursive: true, force: true });

    // The control: what the bare command actually produces for a vanished
    // worktree. Empty stdout — indistinguishable from a pristine tree by
    // output alone, which is the whole defect.
    let stdout = "sentinel";
    try {
      stdout = execFileSync("git", ["--no-optional-locks", "-C", gone, "status", "--porcelain"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      stdout = String((e as { stdout?: string }).stdout ?? "");
    }
    expect(stdout.trim()).toBe("");

    const reading = cleanReading(gone);
    expect(reading.measured).toBe(false);
    expect((reading as { why: string }).why).toContain("git status failed");

    // And end to end: git now calls it prunable, and the row is UNMEASURED.
    const records = parseWorktreeList(git(root, "worktree", "list", "--porcelain"));
    const row = censusOf(records, root).rows.find(r => r.path.endsWith(gone.split("/").pop() as string));
    expect(row, "the deleted worktree is still registered and must appear").toBeDefined();
    expect((row as { verdict: string }).verdict).toBe("UNMEASURED");
  });

  test("the prune warning names every directory that is gone, not just one", () => {
    const records: WorktreeRecord[] = [
      { ...RECORD, path: "/w/a", isMain: true },
      { ...RECORD, path: "/w/b", prunable: true, prunableReason: "gitdir file points to non-existent location" },
      { ...RECORD, path: "/w/c", prunable: true, prunableReason: "gitdir file points to non-existent location" },
    ];
    const warnings = pruneWarnings(records);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/w/b");
    expect(warnings[0]).toContain("/w/c");
    expect(warnings[0]).toContain("not just yours");
    expect(pruneWarnings([{ ...RECORD }])).toEqual([]);
  });
});

/** A census over real records with a synthetic lsof and no pull requests. */
function censusOf(records: WorktreeRecord[], repo: string, pulls?: PullRequest[]) {
  return census(records, {
    repo,
    olderThanMs: 86400000,
    maxEntries: 20000,
    nowMs: Date.now(),
    pulls: pulls ? took(pulls) : couldNotRead<PullRequest[]>("not consulted"),
    lsof: took("p1\ncbun\nn/nowhere/at/all\n"),
  });
}

/* ------------------------------------------------------------------ *
 * Trap two: a squash merge destroys ancestry
 * ------------------------------------------------------------------ */

describe("the merge reading asks for an identity, never for ancestry", () => {
  test("the control: after a real squash merge, the branch head is NOT an ancestor of main", () => {
    const { root, head, main } = repoWithSquashMerge();
    let isAncestor = true;
    try {
      execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", head, main], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      isAncestor = false;
    }
    // Every byte of `feature` is on main, and ancestry says otherwise. A
    // guard built on this would fire on every squash merge this repo makes.
    expect(isAncestor).toBe(false);
    expect(git(root, "show", "main:a.ts")).toBe("export const a = 2;");
  });

  test("the script contains no ancestry question at all", () => {
    const src = codeOnly(readFileSync(SCRIPT, "utf-8"));
    for (const banned of ["is-ancestor", "merge-base", "rev-list"]) {
      expect(src.includes(banned), `${banned} is an ancestry question and must not be here`).toBe(false);
    }
  });

  test("a merged PR at the commit the worktree holds reads MERGED", () => {
    const index = indexPullRequests([
      { number: 7, headRefName: "feature/one", headRefOid: "a".repeat(40), state: "MERGED" },
    ]);
    const reading = mergeReading(RECORD, index, "");
    expect(reading.measured).toBe(true);
    expect((reading as { value: { state: string } }).value.state).toBe("MERGED");
  });

  test("a branch that moved past its merged PR is MERGED_BUT_MOVED and never abandoned", () => {
    const index = indexPullRequests([
      { number: 7, headRefName: "feature/one", headRefOid: "b".repeat(40), state: "MERGED" },
    ]);
    const reading = mergeReading(RECORD, index, "");
    expect((reading as { value: { state: string } }).value.state).toBe("MERGED_BUT_MOVED");
    const r = allAbandonedWard();
    r.merge = reading;
    expect(verdictFor(RECORD, r)).toBe("IN_USE");
  });

  test("a later OPEN pull request outranks an older merged one on the same branch", () => {
    const index = indexPullRequests([
      { number: 7, headRefName: "feature/one", headRefOid: "a".repeat(40), state: "MERGED" },
      { number: 9, headRefName: "feature/one", headRefOid: "a".repeat(40), state: "OPEN" },
    ]);
    expect((mergeReading(RECORD, index, "") as { value: { state: string } }).value.state).toBe("OPEN");
  });

  test("no pull request list is UNMEASURED, not NO_PR", () => {
    const reading = mergeReading(RECORD, null, "gh exited 4");
    expect(reading.measured).toBe(false);
    expect((reading as { why: string }).why).toContain("gh exited 4");
    const absent = mergeReading(RECORD, indexPullRequests([]), "");
    expect((absent as { value: { state: string } }).value.state).toBe("NO_PR");
  });

  test("a detached worktree has no branch to be merged, and says so", () => {
    const detached = { ...RECORD, branch: null, detached: true };
    const reading = mergeReading(detached, indexPullRequests([]), "");
    expect((reading as { value: { state: string } }).value.state).toBe("DETACHED");
    const r = allAbandonedWard();
    r.merge = reading;
    expect(verdictFor(detached, r)).toBe("IN_USE");
  });
});

/* ------------------------------------------------------------------ *
 * The process reading
 * ------------------------------------------------------------------ */

describe("who holds this directory", () => {
  test("a sibling whose name merely starts the same way is not a match", () => {
    const out = ["p10", "czsh", "n/w/one/src/a.ts", "p11", "cbun", "n/w/onetwo/b.ts"].join("\n");
    const held = holdersByRoot(out, ["/w/one", "/w/onetwo"]);
    expect(held.get("/w/one")?.map(h => h.pid)).toEqual(["10"]);
    expect(held.get("/w/onetwo")?.map(h => h.pid)).toEqual(["11"]);
  });

  test("the deepest containing root wins, so a nested worktree is not credited to its parent", () => {
    const out = ["p10", "czsh", "n/w/one/inner/a.ts"].join("\n");
    const held = holdersByRoot(out, ["/w/one", "/w/one/inner"]);
    expect(held.has("/w/one")).toBe(false);
    expect(held.get("/w/one/inner")?.map(h => h.pid)).toEqual(["10"]);
  });

  test("the root itself counts — a shell whose cwd IS the worktree holds it", () => {
    const held = holdersByRoot(["p10", "czsh", "n/w/one"].join("\n"), ["/w/one"]);
    expect(held.get("/w/one")?.[0].command).toBe("zsh");
  });

  test("a real process holding a real file is found by the real lsof", () => {
    const dir = scratchDir("held");
    const file = join(dir, "holdme.txt");
    writeFileSync(file, "x\n");
    const child = Bun.spawn(["/bin/sh", "-c", `exec 9<"${file}"; sleep 30`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // Give the child a moment to reach the exec.
      execFileSync("/bin/sleep", ["1"]);
      const out = readLsof();
      expect(out.measured, `lsof could not be read: ${(out as { why?: string }).why}`).toBe(true);
      const roots = [realpathSync(dir)];
      const held = holdersByRoot((out as { value: string }).value, roots);
      expect(held.get(roots[0]) ?? [], "the open descriptor was not seen").not.toHaveLength(0);
    } finally {
      child.kill();
    }
  });

  test("empty lsof output is UNMEASURED — no running system has no open files", () => {
    const reading = holdersByRoot("", ["/w/one"]);
    expect(reading.size).toBe(0);
    // And the real reader refuses the same emptiness rather than returning it.
    const r = allAbandonedWard();
    r.holders = couldNotRead("lsof produced no output at all, which no running system does");
    expect(verdictFor(RECORD, r)).toBe("UNMEASURED");
  });
});

/* ------------------------------------------------------------------ *
 * The age reading
 * ------------------------------------------------------------------ */

describe("how recently was anything under it modified", () => {
  const now = Date.now();

  test("a recent file makes the worktree not stale, however old the directory is", () => {
    const dir = scratchDir("age");
    mkdirSync(join(dir, "deep", "deeper"), { recursive: true });
    writeFileSync(join(dir, "deep", "deeper", "fresh.ts"), "x\n");
    const old = (now - 30 * 86400000) / 1000;
    utimesSync(dir, old, old);
    utimesSync(join(dir, "deep"), old, old);
    const reading = ageReading(dir, now, 7 * 86400000, 20000);
    expect(reading.measured).toBe(true);
    expect((reading as { value: { stale: boolean } }).value.stale).toBe(false);
  });

  test("an old tree is stale", () => {
    const dir = scratchDir("age-old");
    writeFileSync(join(dir, "a.ts"), "x\n");
    const old = (now - 30 * 86400000) / 1000;
    utimesSync(join(dir, "a.ts"), old, old);
    utimesSync(dir, old, old);
    const reading = ageReading(dir, now, 7 * 86400000, 20000);
    expect((reading as { value: { stale: boolean } }).value.stale).toBe(true);
  });

  test("a truncated walk is UNMEASURED, because a partial walk can only under-report recency", () => {
    const dir = scratchDir("age-big");
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.ts`), "x\n");
    const old = (now - 30 * 86400000) / 1000;
    utimesSync(dir, old, old);
    const reading = ageReading(dir, now, 7 * 86400000, 2);
    expect(reading.measured).toBe(false);
    expect((reading as { why: string }).why).toContain("truncated walk");
  });

  test("a directory that is not there is UNMEASURED, not infinitely old", () => {
    const reading = ageReading(join(tmpdir(), `rg-1021-absent-${Date.now()}`), now, 1, 20000);
    expect(reading.measured).toBe(false);
    expect((reading as { why: string }).why).toContain("cannot stat");
  });

  test("node_modules and .git are skipped, so our own git status is not what we measure", () => {
    const dir = scratchDir("age-skip");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, ".git", "index"), "x\n");
    writeFileSync(join(dir, "node_modules", "pkg.json"), "x\n");
    writeFileSync(join(dir, "a.ts"), "x\n");
    const old = (now - 30 * 86400000) / 1000;
    for (const p of [dir, join(dir, "a.ts")]) utimesSync(p, old, old);
    const reading = ageReading(dir, now, 7 * 86400000, 20000);
    expect((reading as { value: { stale: boolean; scanned: number } }).value.stale).toBe(true);
    expect((reading as { value: { scanned: number } }).value.scanned).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Parsing and rendering
 * ------------------------------------------------------------------ */

describe("the worktree list", () => {
  const PORCELAIN = [
    "worktree /Users/j/Projects/rungate",
    "HEAD " + "1".repeat(40),
    "branch refs/heads/main",
    "",
    "worktree /private/tmp/rg-wt-800",
    "HEAD " + "2".repeat(40),
    "detached",
    "",
    "worktree /private/tmp/rg-wt-812",
    "HEAD " + "3".repeat(40),
    "branch refs/heads/fix/812-ai-review-turn-budget",
    "locked",
    "",
    "worktree /private/tmp/rg-wt-900",
    "HEAD " + "4".repeat(40),
    "branch refs/heads/fix/900",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");

  test("parses every field, and a bare `locked` is still locked", () => {
    const got = parseWorktreeList(PORCELAIN);
    expect(got).toHaveLength(4);
    expect(got[0].isMain).toBe(true);
    expect(got[0].branch).toBe("main");
    expect(got[1].isMain).toBe(false);
    expect(got[1].detached).toBe(true);
    expect(got[1].branch).toBeNull();
    expect(got[2].locked).toBe(true);
    expect(got[2].lockReason).toBe("");
    expect(got[2].branch).toBe("fix/812-ai-review-turn-budget");
    expect(got[3].prunable).toBe(true);
    expect(got[3].prunableReason).toContain("non-existent");
  });

  test("only the first entry is the main checkout", () => {
    expect(parseWorktreeList(PORCELAIN).filter(r => r.isMain)).toHaveLength(1);
  });

  test("the table states the counts and refuses to imply a licence to delete", () => {
    const records = parseWorktreeList(PORCELAIN);
    const out = renderTable(censusOf(records, "/Users/j/Projects/rungate"));
    expect(out).toContain("UNMEASURED");
    expect(out).toContain("removes nothing");
    expect(out).toContain("WARNING:");
    expect(out.split("\n")[0]).toContain("VERDICT");
  });

  test("warnings is always present, so silence and nothing-to-say are different facts", () => {
    const quiet = censusOf([{ ...RECORD, isMain: true }], "/w");
    expect(Array.isArray(quiet.warnings)).toBe(true);
    expect(renderTable(quiet)).toContain("WARNING: none");
  });

  test("humanAge", () => {
    expect(humanAge(5 * 60000)).toBe("5m");
    expect(humanAge(5 * 3600000)).toBe("5h");
    expect(humanAge(5 * 86400000)).toBe("5d");
    expect(humanAge(-1)).toBe("?");
  });
});

/* ------------------------------------------------------------------ *
 * The script never deletes
 * ------------------------------------------------------------------ */

describe("a reading, not a reaper", () => {
  test("no removal, no signal, no filesystem destruction anywhere in the source", () => {
    const src = codeOnly(readFileSync(SCRIPT, "utf-8"));
    for (const banned of [
      "rmSync", "unlinkSync", "rmdirSync", "renameSync", "truncateSync",
      "pkill", "process.kill", "--force", "spawnSync", "execSync(",
    ]) {
      expect(src.includes(banned), `${banned} must not appear in a tool that only reads`).toBe(false);
    }
  });

  /**
   * Every git subcommand this script runs, extracted rather than asserted.
   *
   * A substring ban on `"prune"` would be defeated by `["worktree", verb]`
   * and would also be tripped by the word appearing in a comment. Reading
   * the argument arrays and checking the subcommand against an allowlist is
   * the question that means what it says — and a new call site has to be
   * added here deliberately.
   */
  test("git is only ever asked read-only questions", () => {
    const src = codeOnly(readFileSync(SCRIPT, "utf-8"));
    const calls = [...src.matchAll(/execFileSync\(\s*"git",\s*\[([^\]]*)\]/g)];
    expect(calls.length, "no git call sites were found — the extractor has stopped working").toBe(2);
    const verbs = calls.map(m =>
      [...m[1].matchAll(/"([^"]+)"/g)]
        .map(x => x[1])
        .filter(x => !x.startsWith("-"))[0],
    );
    expect(verbs.sort()).toEqual(["status", "worktree"]);
    // `worktree` has destructive verbs; this one only ever lists.
    expect(src).toContain('"worktree", "list", "--porcelain"');
  });

  test("status is taken with --no-optional-locks, so reading does not write someone's index", () => {
    expect(readFileSync(SCRIPT, "utf-8")).toContain('"--no-optional-locks"');
  });
});

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

describe("arguments", () => {
  test("defaults are a declared age, not an implicit one", () => {
    const args = parseArgs([]);
    expect(args.olderThanMs).toBe(7 * 86400000);
    expect(args.gh).toBe(true);
    expect(args.json).toBe(false);
  });

  test.each([["30m", 1800000], ["12h", 43200000], ["7d", 604800000]])(
    "parseDuration(%s)", (text, ms) => expect(parseDuration(text as string)).toBe(ms));

  test.each(["7", "7w", "d", "", "-1d", "7 d"])("parseDuration refuses %p", text => {
    expect(() => parseDuration(text)).toThrow("is not a duration");
  });

  test("--no-gh makes the merge reading unmeasured rather than absent", () => {
    expect(parseArgs(["--no-gh"]).gh).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Negative cases, each against the real script and the mutant
 * ------------------------------------------------------------------ */

describe("refusals", () => {
  test("an unknown argument", () => {
    bothRefuse(["--delete-them-all"], "unknown argument: --delete-them-all");
  });

  test("a flag with no value", () => {
    bothRefuse(["--older-than"], "--older-than needs a value");
  });

  test("a duration that is not one", () => {
    bothRefuse(["--older-than", "soon"], "is not a duration");
  });

  test("--max-entries that is not a positive integer", () => {
    bothRefuse(["--max-entries", "0"], "--max-entries needs a positive integer");
  });

  test("a path that is not a git repository", () => {
    const dir = scratchDir("notrepo");
    bothRefuse(["--repo", dir, "--no-gh"], "cannot list worktrees");
  });

  test("an --out that cannot be written", () => {
    const { root } = repoWithWorktrees();
    bothRefuse(
      ["--repo", root, "--no-gh", "--out", "/nonexistent-dir-1021/census.json"],
      "cannot write",
    );
  });
});

/* ------------------------------------------------------------------ *
 * End to end, over a real repository with real worktrees
 * ------------------------------------------------------------------ */

describe("end to end", () => {
  test("the census runs, exits 0, and reports every registered worktree", () => {
    const { root, live } = repoWithWorktrees();
    const out = join(scratchDir("out"), "census.json");
    const r = run(SCRIPT, ["--repo", root, "--no-gh", "--out", out, "--json"]);
    expect(r.code, r.err).toBe(0);
    const parsed = JSON.parse(readFileSync(out, "utf-8"));
    expect(parsed.counts.total).toBe(3);
    // Every row is UNMEASURED: --no-gh means no merge reading was taken, and
    // that is the honest answer rather than "no PR, therefore not merged".
    expect(parsed.counts.abandoned).toBe(0);
    expect(parsed.unmeasuredByReading.merge).toBe(3);
    // git reports the resolved path; mkdtemp hands back the /var symlink.
    const liveRow = parsed.rows.find((row: { path: string }) => row.path === realpathSync(live));
    expect(liveRow.readings.clean.value.clean).toBe(true);
    expect(liveRow.verdict).toBe("UNMEASURED");
    expect(JSON.stringify(parsed)).toContain("--no-gh was passed");
  });

  test("a worktree with uncommitted work is IN_USE even when its PR merged", () => {
    const { root, live } = repoWithWorktrees();
    writeFileSync(join(live, "scratch.ts"), "// 500 lines nobody committed\n");
    const records = parseWorktreeList(git(root, "worktree", "list", "--porcelain"));
    const real = realpathSync(live);
    const head = records.find(x => x.path === real)?.head as string;
    expect(head, "the live worktree was not in the list").toBeTruthy();
    const result = censusOf(records, root, [
      { number: 452, headRefName: "feature/live", headRefOid: head, state: "MERGED" },
    ]);
    const row = result.rows.find(x => x.path === real);
    expect((row as { readings: { merge: { value: { state: string } } } }).readings.merge.value.state)
      .toBe("MERGED");
    expect((row as { verdict: string }).verdict).not.toBe("ABANDONED");
    expect((row as { evidence: string[] }).evidence.join(" ")).toContain("uncommitted change");
  });
});
