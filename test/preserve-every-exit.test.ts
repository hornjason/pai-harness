/**
 * Covers SC-878, SC-879, SC-880 (HARNESS-STANDARD.md).
 *
 * #232 — preservation covered one exit, not the class.
 *
 * #228 routed every *collect* refusal through one helper, which was correct
 * and incomplete: it was scoped to the symptom that had been observed.
 *
 * Measured: run `wf_89689f50-2e4` on #227 returned `IMPLEMENT_FAILED`, not a
 * collect refusal. Both worktrees were left entirely uncommitted at
 * `73c056ab` — 13 files in one, 3 in the other. Both agents had reported
 * `success: true`, with five mutation proofs between them and a green suite,
 * and the work included the complete instrumentation that became PR #231.
 * `preserveRefusedWork` never ran, because the run never reached a collect
 * refusal. Both were recovered by hand. Second time in one session that a run
 * produced correct work and left it reachable from nothing.
 *
 * ## Why "add preservation to IMPLEMENT_FAILED too" is the wrong fix
 *
 * That is the same mistake a third time. The property wanted is not "these
 * particular exits preserve" but **no exit path discards an uncommitted
 * worktree** — and only the second is testable as a class. `IMPLEMENT_FAILED`
 * is just the exit that happened to fire that day; nothing structurally
 * prevented the next one from being added without preservation, which is
 * exactly how this one came to exist.
 *
 * So the test below enumerates the terminal statuses out of the source and
 * requires each to come from one of two funnels. A status added later
 * without one is named by the failure message.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanupWorktrees, unpushedCommitCount, unpushedKeepReason } from "../lib/worktree-cleanup";

const SHIP = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

/**
 * Every `status: 'X'` literal in ship.js whose name reads as a terminal
 * failure, with where it sits.
 *
 * Derived from the source rather than listed here on purpose. A hand-kept
 * list is a second place to forget the thing this test exists to catch.
 */
function terminalStatuses(source: string): Array<{ status: string; index: number }> {
  const out: Array<{ status: string; index: number }> = [];
  // Both spellings. A status moved into a `terminalFailure(...)` call is
  // still a status this check has to see — an enumeration that only reads
  // the literal form would go quiet the moment the fix landed, which is the
  // vacuous shape `.claude/rules/checks-must-be-able-to-fail.md` names.
  const re = /(?:status:\s*|terminalFailure\(\s*)'([A-Z][A-Z0-9_]*(?:FAILED|ERROR|ABORTED))'/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    out.push({ status: m[1], index: m.index });
  }
  return out;
}

/**
 * The body of a named function declaration, by brace matching.
 *
 * The opening brace is found after the parameter list closes, not as the
 * first `{` following the name. Every function this file slices has an
 * `extra = {}` default, and the naive version matched THAT — so the body it
 * returned was two characters long and every assertion over it passed
 * vacuously.
 */
function functionBody(source: string, decl: string): { start: number; end: number } {
  const start = source.indexOf(decl);
  if (start < 0) throw new Error(`could not find ${decl} in ship.js`);

  // Walk the parameter list to its matching `)`, counting nested parens and
  // braces, then take the next `{`.
  let parens = 0;
  let i = start + decl.length - 1;
  for (; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) break;
  }
  const open = source.indexOf("{", i);
  if (open < 0) throw new Error(`no body brace after ${decl}`);

  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && --depth === 0) return { start, end: j + 1 };
  }
  throw new Error(`unbalanced braces after ${decl}`);
}

describe("#232 SC-878: every terminal failure status comes from a preserving funnel", () => {
  const found = terminalStatuses(SHIP);

  test("the body slicer returns a real body, not a default parameter", () => {
    // Its first version took the first `{` after the function name, which is
    // the `extra = {}` default on all three functions it slices. Every body
    // came back two characters long and every assertion over one passed
    // vacuously — including the two below, which is how this was found.
    for (const decl of [
      "async function shipFailed(",
      "async function terminalFailure(",
      "async function timedAgent(",
      "function noteWorktrees(",
    ]) {
      const { start, end } = functionBody(SHIP, decl);
      expect(end - start, `${decl} sliced to nothing`).toBeGreaterThan(200);
      expect(SHIP.slice(start, end).split("\n").length, `${decl} is one line`).toBeGreaterThan(3);
    }
  });

  test("the enumeration is not vacuous", () => {
    // A regex that stops matching turns this whole file green. The count is
    // the only thing standing between "every exit preserves" and "no exit
    // was looked at".
    expect(found.length, "no terminal statuses were found in ship.js at all")
      .toBeGreaterThanOrEqual(12);
  });

  test("every one is produced by shipFailed or terminalFailure", () => {
    const shipFailedBody = functionBody(SHIP, "async function shipFailed(");
    const terminalBody = functionBody(SHIP, "async function terminalFailure(");

    // The statuses that can be returned before any agent has run, and so
    // before a worktree can exist. Argument validation, nothing else.
    const PRE_AGENT = new Set(["ARGS_ERROR"]);

    const orphans = found.filter(({ status, index }) => {
      if (PRE_AGENT.has(status)) return false;
      if (index >= shipFailedBody.start && index < shipFailedBody.end) return false;
      if (index >= terminalBody.start && index < terminalBody.end) return false;
      // Produced by a call: `terminalFailure('X_FAILED'` on the same line.
      const line = SHIP.slice(SHIP.lastIndexOf("\n", index) + 1, SHIP.indexOf("\n", index));
      return !line.includes("terminalFailure(");
    });

    expect(
      orphans.map(o => `${o.status} at offset ${o.index}`),
      "these terminal statuses are returned without preserving the worktrees first — " +
        "route them through terminalFailure() or shipFailed()",
    ).toEqual([]);
  });

  test("the PRE_AGENT allowlist really is before any agent runs", () => {
    // An allowlist is how this check gets quietly widened until it checks
    // nothing. ARGS_ERROR is exempt because no worktree can exist yet; that
    // claim is measured, not asserted.
    const firstAgent = SHIP.indexOf("await timedAgent(");
    expect(firstAgent).toBeGreaterThan(-1);
    for (const { status, index } of terminalStatuses(SHIP)) {
      if (status !== "ARGS_ERROR") continue;
      expect(index, `ARGS_ERROR is returned after an agent has run, so it may have worktrees`)
        .toBeLessThan(firstAgent);
    }
  });

  test("both funnels actually preserve — the names are not enough", () => {
    for (const decl of ["async function shipFailed(", "async function terminalFailure("]) {
      const { start, end } = functionBody(SHIP, decl);
      expect(SHIP.slice(start, end), `${decl} does not preserve anything`)
        .toContain("preserveSeenWorktrees(");
    }
  });

  test("each funnel is declared exactly once", () => {
    for (const name of ["shipFailed", "terminalFailure", "preserveSeenWorktrees", "noteWorktrees"]) {
      expect(
        (SHIP.match(new RegExp(`function ${name}\\b`, "g")) ?? []).length,
        `${name} is declared more than once, so there is no single binding to mutate`,
      ).toBe(1);
    }
  });
});

describe("#232 SC-879: worktrees are recorded where every agent reply passes", () => {
  /**
   * `noteWorktrees`, sliced out of ship.js and EXECUTED.
   *
   * ship.js runs in a sandbox with no module loading, so the function cannot
   * be imported. Asserting on its source text instead would prove it was
   * written, not that it works — the distinction this whole issue is about.
   */
  function noter(): { note: (v: unknown) => void; seen: Set<string> } {
    const { start, end } = functionBody(SHIP, "function noteWorktrees(");
    const seen = new Set<string>();
    const note = new Function(
      "PROJECT_ROOT", "WORKTREES_SEEN", "collectDestination",
      `${SHIP.slice(start, end)}; return noteWorktrees;`,
    )("/repo", seen, () => true) as (v: unknown) => void;
    return { note, seen };
  }

  /** `timedAgent`, sliced out of ship.js and run against a stub `agent`. */
  function timed(): { call: (p: string, o?: Record<string, unknown>) => Promise<unknown>; seen: string[] } {
    const { start, end } = functionBody(SHIP, "async function timedAgent(");
    const seen: string[] = [];
    const call = new Function(
      "agent", "log", "SPAWNED_ROLES", "timingInstruction", "noteWorktrees",
      `${SHIP.slice(start, end)}; return timedAgent;`,
    )(
      async (_p: string, o: Record<string, unknown>) => (o as any).__reply ?? { ok: true },
      () => {},
      new Set(),
      () => "",
      (v: unknown) => { const w = (v as any)?.worktreePath; if (typeof w === "string") seen.push(w); },
    ) as (p: string, o?: Record<string, unknown>) => Promise<unknown>;
    return { call, seen };
  }

  test("timedAgent records on BOTH its paths — labelled and unlabelled", async () => {
    // Recording at each place a buildResult is built would be the instance
    // fix again: four sites today, and the fifth is the one that strands the
    // work. Every agent call in this workflow goes through timedAgent.
    //
    // Executed, not grepped. The first version of this asserted the text
    // `noteWorktrees(` appeared in the body, and stayed green when the
    // labelled path's call was deleted — because the unlabelled path still
    // had one. A text check cannot tell two call sites apart.
    const a = timed();
    await a.call("p", { label: "marcus", __reply: { worktreePath: "/wt/a" } });
    expect(a.seen, "the labelled path did not record the reply").toEqual(["/wt/a"]);

    const b = timed();
    await b.call("p", { __reply: { worktreePath: "/wt/b" } });
    expect(b.seen, "the unlabelled path did not record the reply").toEqual(["/wt/b"]);
  });

  test("the reply still reaches the caller unchanged", () => {
    // timedAgent went from `return agent(...)` to awaiting it. A wrapper that
    // records and then returns the wrong thing breaks every caller.
    const a = timed();
    return a.call("p", { label: "x", __reply: { ok: true, n: 7 } })
      .then(r => expect(r).toEqual({ ok: true, n: 7 }));
  });

  test("preserveSeenWorktrees hands the registry to the preserver", async () => {
    // Zero red on "it passes an empty list" without this: nothing executed
    // the function, so only its text was ever checked.
    const { start, end } = functionBody(SHIP, "async function preserveSeenWorktrees(");
    const handed: unknown[] = [];
    const registry = new Set(["/wt/a", "/wt/b"]);
    const fn = new Function(
      "WORKTREES_SEEN", "preserveRefusedWork",
      `${SHIP.slice(start, end)}; return preserveSeenWorktrees;`,
    )(registry, async (results: unknown) => { handed.push(results); return { preserved: [], detail: " — kept" }; });

    const out = await fn("Implement", "lbl");
    expect(handed[0], "the worktrees this run saw did not reach the preserver")
      .toEqual([{ worktreePath: "/wt/a" }, { worktreePath: "/wt/b" }]);
    expect(out.detail).toBe(" — kept");

    // And nothing is spawned when there is nothing to preserve.
    const empty = new Function(
      "WORKTREES_SEEN", "preserveRefusedWork",
      `${SHIP.slice(start, end)}; return preserveSeenWorktrees;`,
    )(new Set(), () => { throw new Error("spawned a preserve step with no worktrees"); });
    expect(await empty("Implement", "lbl")).toEqual({ preserved: [], detail: "" });
  });

  test("it finds a path at the top level, nested, and in an array", () => {
    const { note, seen } = noter();

    note({ worktreePath: "/wt/a" });
    note({ buildResult: { worktreePath: "/wt/b" } });
    note({ results: [{ worktreePath: "/wt/c" }, { buildResult: { worktreePath: "/wt/d" } }] });
    expect([...seen].sort()).toEqual(["/wt/a", "/wt/b", "/wt/c", "/wt/d"]);
  });

  test("the project root is never recorded as a worktree", () => {
    // `preserveRefusedWork` commits whatever it finds. `git add -A` in the
    // project root would sweep up unrelated working-tree state and commit it
    // under a preserve message.
    const { note, seen } = noter();

    note({ worktreePath: "/repo" });
    note({ worktreePath: "/repo/" });
    expect([...seen]).toEqual([]);
  });

  test("junk replies do not throw — it runs on every agent reply there is", () => {
    const { note, seen } = noter();

    for (const junk of [undefined, null, 0, "", "str", [], {}, { worktreePath: 7 }, { worktreePath: "" }]) {
      expect(() => note(junk)).not.toThrow();
    }
    expect([...seen]).toEqual([]);
  });

  test("the walk is depth-bounded, so a pathological reply cannot hang it", () => {
    // The bound, not the cycle guard, is what makes this terminate — the
    // guard is belt-and-braces over it, and removing the guard alone scores
    // zero because of that. Asserted on the bound directly.
    const { note, seen } = noter();
    let deep: Record<string, unknown> = { worktreePath: "/wt/too-deep" };
    for (let i = 0; i < 9; i++) deep = { nested: deep };
    note(deep);
    expect(seen.size, "a reply nested nine deep was walked to the bottom").toBe(0);

    const shallow = { a: { b: { c: { worktreePath: "/wt/ok" } } } };
    const two = noter();
    two.note(shallow);
    expect([...two.seen]).toEqual(["/wt/ok"]);
  });

  test("a cycle in a reply does not hang the run", () => {
    const { note, seen } = noter();

    const cyclic: Record<string, unknown> = { worktreePath: "/wt/a" };
    cyclic.self = cyclic;
    expect(() => note(cyclic)).not.toThrow();
    expect([...seen]).toEqual(["/wt/a"]);
  });
});

describe("#232 SC-880: cleanup will not remove work that exists only here", () => {
  function repo(): { root: string; remote: string; git: (...a: string[]) => string } {
    const base = mkdtempSync(join(tmpdir(), "rungate-232-"));
    const remote = join(base, "remote.git");
    const root = join(base, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["clone", "-q", remote, root]);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf-8" });
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("push", "-q", "origin", "main");
    mkdirSync(join(root, ".claude", "worktrees"), { recursive: true });
    return { root, remote, git };
  }

  function worktree(r: ReturnType<typeof repo>, name: string, branch: string): string {
    const path = join(r.root, ".claude", "worktrees", name);
    r.git("worktree", "add", "-q", "-b", branch, path, "main");
    return path;
  }

  test("a branch merged into main AND on origin is removed", () => {
    // The control. Without it a guard that keeps everything passes every
    // other case in this block, and cleanup silently stops working — which
    // is how #68 accumulated 36 worktrees and 243 MB.
    const r = repo();
    const path = worktree(r, "done", "feat-done");
    writeFileSync(join(path, "b.txt"), "work\n");
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: path });
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-edit", "feat-done");
    r.git("push", "-q", "origin", "main");

    return cleanupWorktrees({ projectRoot: r.root }).then(out => {
      expect(out.removed).toEqual(["done"]);
    });
  });

  test("the measured case: merged locally but never pushed is KEPT", async () => {
    // The commits exist in exactly one place on earth. `git worktree remove
    // --force` is the command that ends them, and a SessionStart hook runs
    // this unattended.
    const r = repo();
    const path = worktree(r, "local", "feat-local");
    writeFileSync(join(path, "b.txt"), "work\n");
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync("git", ["commit", "-q", "-m", "work"], { cwd: path });
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-edit", "feat-local");
    // Deliberately NOT pushed.

    const out = await cleanupWorktrees({ projectRoot: r.root });
    expect(out.removed, "work that exists only in this clone was deleted").toEqual([]);
    expect(out.kept.join(" ")).toContain("not on origin");
  });

  test("a preserved branch — the #228 output — is kept", async () => {
    // The whole point of preservation is that the branch outlives the run.
    // Cleanup removing it the next morning would close the loop the wrong
    // way round.
    const r = repo();
    const path = worktree(r, "preserved", "rungate-preserved-x");
    writeFileSync(join(path, "b.txt"), "rescued\n");
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync("git", ["commit", "-q", "-m", "preserved: NOT reviewed"], { cwd: path });

    const out = await cleanupWorktrees({ projectRoot: r.root });
    expect(out.removed).toEqual([]);
  });

  test("a repo with no origin at all still cleans up", async () => {
    // Otherwise the guard stops cleanup dead in any local-only checkout,
    // which is the regression that gets a safety check reverted.
    const base = mkdtempSync(join(tmpdir(), "rungate-232-noremote-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: base, encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(base, "a.txt"), "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    mkdirSync(join(base, ".claude", "worktrees"), { recursive: true });
    const path = join(base, ".claude", "worktrees", "done");
    git("worktree", "add", "-q", "-b", "feat", path, "main");
    writeFileSync(join(path, "b.txt"), "w\n");
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync("git", ["commit", "-q", "-m", "w"], { cwd: path });
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-edit", "feat");

    const out = await cleanupWorktrees({ projectRoot: base });
    expect(out.removed, "cleanup stopped working in a repo with no remote").toEqual(["done"]);
  });

  test("an unanswerable origin check KEEPS the worktree", () => {
    // The arm no fixture can reach: it needs git to fail between the branch
    // read and the rev-list — real, a branch deleted in that window, but not
    // stageable. Inline in cleanupWorktrees, removing it scored zero red.
    expect(unpushedKeepReason("wt", "b", null)).toContain("could not tell");
    expect(unpushedKeepReason("wt", "b", 3)).toContain("3 commit(s)");
    // And the control: a measured zero is the only thing that proceeds.
    expect(unpushedKeepReason("wt", "b", 0)).toBeNull();
  });

  test("a question git could not answer is null, never 'all pushed'", () => {
    // `0` is the claim "every commit here is also on origin" and the caller
    // deletes the worktree on it. A rev-list that could not run has made no
    // claim — a branch deleted between the two git calls reaches exactly
    // this. Scored zero red before it existed, because no fixture could
    // make the rev-list fail on its own.
    const r = repo();
    expect(unpushedCommitCount(r.root, "no-such-branch")).toBeNull();
    expect(unpushedCommitCount("/nonexistent/path/surely", "main")).toBeNull();
    // The control, on the same repo: a real branch does get a number.
    expect(unpushedCommitCount(r.root, "main")).toBe(0);
  });

  test("uncommitted changes are still kept — nothing regressed", async () => {
    const r = repo();
    const path = worktree(r, "dirty", "feat-dirty");
    writeFileSync(join(path, "b.txt"), "uncommitted\n");
    const out = await cleanupWorktrees({ projectRoot: r.root });
    expect(out.removed).toEqual([]);
    expect(out.kept.join(" ")).toContain("uncommitted");
  });
});
