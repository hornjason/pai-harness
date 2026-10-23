import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  type GitResult,
  type GitRunner,
  type SpawnGit,
  currencyReportLines,
  directoryCurrency,
  readRegistrationCurrency,
  registrationCurrency,
  spawnGitRunner,
} from "../../lib/hook-tree-currency";
import { GIT_ISOLATION_CONFIG, GIT_ISOLATION_ENV } from "../../lib/git-isolation";
import type { TargetTreeCensus, TargetReading } from "../../lib/hook-target-tree";

/**
 * #1216 — a hook registration resolves to a working tree N commits behind
 * main, and nothing on disk says which main.
 *
 * `lib/hook-target-tree.ts` answers which DIRECTORY a registration names.
 * Until this file there was nothing that answered which COMMIT that
 * directory is on, and the two failures are indistinguishable from outside:
 * a hook that is absent and a hook that is fourteen commits old both look
 * like the code running and finding nothing.
 *
 * Measured 2026-10-23, the live instance this was written against: the
 * finding arbiter merged as #1282 and adjudicated nothing for hours because
 * `RUNGATE_HOOKS_DIR`'s tree was 14 commits behind and did not contain it.
 *
 * ## What separates pass from fail here
 *
 * The counting case is the one that can go green for the wrong reason, so it
 * is built as a fixture that is **behind by 3 and ahead by 1**. The cheapest
 * wrong spelling of the measurement — `base..HEAD` instead of `HEAD..base` —
 * returns 1 on that fixture, not 0, so the case separates by MEMBERSHIP and
 * not merely by non-zero. A fixture only behind would pass under the
 * transposition reading 0 vs 3 only because one of them is falsy, and a
 * later refactor that lost the direction would still have to be caught by
 * the number.
 *
 * Both halves are driven: a fake `GitRunner` for the branchy refusals, where
 * planting a real repository that cannot resolve its own base is more
 * machinery than the case is worth — and REAL git for everything the fake
 * could agree with me about. A fake keyed on argument arrays answers
 * whatever this file says it answers, so every argument spelling, every
 * `rev-parse` form and the `--porcelain` pathspec are pinned by the real-git
 * cases only.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BASE = "origin/main";

let FIX = "";
beforeAll(() => {
  FIX = mkdtempSync(join(tmpdir(), "hook-tree-currency-"));
});
afterAll(() => {
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/**
 * The runner the production hook supplies, byte for byte — so every case
 * below runs the isolated argv and env the hook runs, and an isolation flag
 * that broke an ordinary reading would redden the whole file rather than
 * only HC-19.
 */
const realGit: GitRunner = spawnGitRunner(spawnSync);

function commit(dir: string, name: string): void {
  writeFileSync(join(dir, name), name);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", name]);
}

/**
 * An upstream with `main`, and a clone that has fetched it.
 *
 * `behind` commits are added upstream after the clone; `ahead` are added
 * locally. The clone fetches once at the end so its `origin/main` is real
 * rather than configured — the module reads the TARGET tree's own
 * remote-tracking ref and never fetches, and a fixture that faked the ref
 * would not be exercising that.
 */
function pair(name: string, behind: number, ahead: number): string {
  const up = join(FIX, `${name}-upstream`);
  const clone = join(FIX, name);
  mkdirSync(up, { recursive: true });
  git(up, ["init", "-q", "-b", "main"]);
  commit(up, "base.txt");
  execFileSync("git", ["clone", "-q", up, clone], { encoding: "utf-8" });
  for (let i = 0; i < ahead; i++) commit(clone, `local-${i}.txt`);
  for (let i = 0; i < behind; i++) commit(up, `upstream-${i}.txt`);
  git(clone, ["fetch", "-q", "origin", "main"]);
  git(clone, ["update-ref", "refs/remotes/origin/main", git(clone, ["rev-parse", "FETCH_HEAD"])]);
  mkdirSync(join(clone, "hooks"), { recursive: true });
  return clone;
}

/** A census carrying exactly these resolved paths, with nothing else to say. */
function census(resolved: string[], extra: Partial<TargetTreeCensus> = {}): TargetTreeCensus {
  const reading = (path: string): TargetReading => ({
    hook: "X",
    scope: "user-settings",
    command: `bun ${path}`,
    spelling: "RUNGATE_HOOKS_DIR",
    target: "foreign",
    resolved: path,
    detail: "",
  });
  return {
    reading: "MEASURED",
    unmeasuredReasons: [],
    examined: resolved.length,
    inRepo: [],
    foreign: resolved.map(reading),
    unresolved: [],
    ...extra,
  };
}

/** A runner that answers from a table, for the refusals real git cannot cheaply stage. */
function fakeGit(table: Record<string, GitResult>): GitRunner {
  return (dir, args) => table[`${dir} ${args.join(" ")}`] ?? { status: 128, stdout: "" };
}

// ── The reading itself ───────────────────────────────────────────────────

describe("#1216: a resolved hook directory reports its currency", () => {
  test("HC-1: a tree behind the base reads BEHIND N, naming N and the base it measured", () => {
    // Behind 3 AND ahead 1. `origin/main..HEAD` returns 1 here, so neither
    // the count nor the pass/fail can survive a transposed range.
    const dir = join(pair("behind-and-ahead", 3, 1), "hooks");
    const r = directoryCurrency(dir, BASE, realGit, 7);

    expect(r.state).toBe("behind");
    expect(r.behind, "the count is not the number of commits the base holds and HEAD does not").toBe(
      3,
    );
    expect(r.base).toBe(BASE);
    expect(r.baseSha, "the reading does not name the main it was taken against").not.toBeNull();
    expect(r.headSha).not.toBe(r.baseSha);
    expect(r.registrations).toBe(7);
    expect(r.detail).toContain("3 commit(s) behind origin/main");
    expect(r.detail, "the base SHA is absent, so two rows cannot be compared").toContain(
      r.baseSha!.slice(0, 8),
    );
  });

  test("HC-2: a tree holding every commit on the base reads current", () => {
    const dir = join(pair("current", 0, 0), "hooks");
    const r = directoryCurrency(dir, BASE, realGit);
    expect(r.state).toBe("current");
    expect(r.behind).toBe(0);
    expect(r.headSha).toBe(r.baseSha);
  });

  test("HC-3: local commits on top of the base are still current, not a fourth state", () => {
    // Every merged commit reaches it, which is the question this asks.
    const dir = join(pair("ahead-only", 0, 2), "hooks");
    const r = directoryCurrency(dir, BASE, realGit);
    expect(r.state).toBe("current");
    expect(r.headSha).not.toBe(r.baseSha);
  });

  test("HC-4: a directory that is not a working tree is UNMEASURED, never current", () => {
    const loose = join(FIX, "not-a-repo", "hooks");
    mkdirSync(loose, { recursive: true });
    const r = directoryCurrency(loose, BASE, realGit);
    expect(r.state).toBe("unmeasured");
    expect(r.behind, "an unmeasured row carried a count somebody could read").toBeNull();
    expect(r.baseSha).toBeNull();
    expect(r.detail).toContain("not inside a git working tree");
  });

  test("HC-5: an absent directory is UNMEASURED, and says so rather than throwing", () => {
    const r = directoryCurrency(join(FIX, "nothing-here", "hooks"), BASE, realGit);
    expect(r.state).toBe("unmeasured");
    expect(r.detail).toContain("not inside a git working tree");
  });

  test("HC-6: a tree with no such base ref is UNMEASURED — this reading never fetches", () => {
    const dir = join(FIX, "no-remote");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    commit(dir, "only.txt");

    const r = directoryCurrency(dir, BASE, realGit);
    expect(r.state).toBe("unmeasured");
    expect(r.detail).toContain("is not a ref in that tree");

    // And the refusal is distinct from HC-4's: two causes, two repairs.
    expect(r.detail).not.toContain("not inside a git working tree");
  });

  test("HC-7: uncommitted bytes under the directory are UNMEASURED, not current", () => {
    const repo = pair("dirty-current", 0, 0);
    const dir = join(repo, "hooks");
    const clean = directoryCurrency(dir, BASE, realGit);
    expect(clean.state, "the control is not current, so the next row proves nothing").toBe(
      "current",
    );

    writeFileSync(join(dir, "Edited.hook.ts"), "hand-edited\n");
    const r = directoryCurrency(dir, BASE, realGit);
    expect(r.state).toBe("unmeasured");
    expect(r.detail).toContain("uncommitted");
  });

  test("HC-8: dirty never MASKS a behind reading — it only blocks a current one", () => {
    const repo = pair("dirty-behind", 4, 0);
    const dir = join(repo, "hooks");
    writeFileSync(join(dir, "Edited.hook.ts"), "hand-edited\n");
    const r = directoryCurrency(dir, BASE, realGit);
    expect(r.state).toBe("behind");
    expect(r.behind).toBe(4);
  });
});

// ── Rolling the rows up ──────────────────────────────────────────────────

describe("#1216: the census becomes a currency reading", () => {
  test("HC-9: one row per distinct directory, counting the registrations in it", () => {
    const a = join(pair("rollup-a", 2, 0), "hooks");
    const b = join(pair("rollup-b", 0, 0), "hooks");
    const r = registrationCurrency(
      census([`${a}/One.hook.ts`, `${a}/Two.hook.ts`, `${b}/Three.hook.ts`]),
      BASE,
      realGit,
    );

    expect(r.directories.map(d => d.dir).sort()).toEqual([a, b].sort());
    expect(r.directories.find(d => d.dir === a)!.registrations).toBe(2);
    expect(r.directories.find(d => d.dir === b)!.registrations).toBe(1);
    expect(r.directories[0]!.state, "a behind row did not sort above a current one").toBe("behind");
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("2 commit(s) behind");
  });

  test("HC-10: zero directories is UNMEASURED — it is not every directory being current", () => {
    const r = registrationCurrency(census([]), BASE, fakeGit({}));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.directories).toEqual([]);
    expect(r.unmeasuredReasons.join(" ")).toContain("Zero directories compared is not agreement");
    expect(currencyReportLines(r)[0]).toStartWith("Hook tree currency UNMEASURED:");
  });

  test("HC-11: a census that was itself UNMEASURED cannot be laundered into a clean reading", () => {
    const dir = join(pair("laundering", 0, 0), "hooks");
    const r = registrationCurrency(
      census([`${dir}/One.hook.ts`], {
        reading: "UNMEASURED",
        unmeasuredReasons: ["user-settings env: not on this machine"],
      }),
      BASE,
      realGit,
    );
    expect(r.directories[0]!.state).toBe("current");
    expect(r.reading, "every directory was current, so the census's own refusal was dropped").toBe(
      "UNMEASURED",
    );
    expect(r.unmeasuredReasons.join(" ")).toContain("not on this machine");
  });

  test("HC-12: registrations that resolved to nothing are carried, not dropped", () => {
    const dir = join(pair("unresolved-carried", 0, 0), "hooks");
    const r = registrationCurrency(
      census([`${dir}/One.hook.ts`], {
        unresolved: [
          {
            hook: "Y",
            scope: "user-settings",
            command: "bun ${NOPE}/Y.hook.ts",
            spelling: "NOPE",
            target: "unresolved",
            resolved: null,
            detail: "NOPE is not defined by any scope this run could read",
          },
        ],
      }),
      BASE,
      realGit,
    );
    expect(r.unresolved).toBe(1);
    expect(currencyReportLines(r).join("\n")).toContain("resolves to no directory");
  });
});

// ── What a reader actually sees ──────────────────────────────────────────

describe("#1216: the reading reaches a reader", () => {
  test("HC-13: the headline carries all three counts, so neither state hides the other", () => {
    const behind = join(pair("report-behind", 5, 0), "hooks");
    const current = join(pair("report-current", 0, 0), "hooks");
    const loose = join(FIX, "report-loose", "hooks");
    mkdirSync(loose, { recursive: true });

    const lines = currencyReportLines(
      registrationCurrency(
        census([`${behind}/A.hook.ts`, `${current}/B.hook.ts`, `${loose}/C.hook.ts`]),
        BASE,
        realGit,
      ),
    );

    expect(lines[0]).toBe(
      "Hook tree currency: 1 current, 1 BEHIND, 1 UNMEASURED — of 3 director(ies) hook " +
        "registrations execute from",
    );
    const body = lines.slice(1).join("\n");
    expect(body).toContain("BEHIND 5");
    expect(body).toContain(behind);
    expect(body).toContain(loose);
    expect(body, "a current directory got a row, which is the noise that stops it being read").not.toContain(
      current,
    );
  });

  test("HC-14: an all-current reading says so in one line and names the base", () => {
    const dir = join(pair("report-all-current", 0, 0), "hooks");
    const lines = currencyReportLines(
      registrationCurrency(census([`${dir}/A.hook.ts`]), BASE, realGit),
    );
    expect(lines).toEqual(["Hook tree currency: 1 director(ies) current with origin/main"]);
  });
});

// ── It is wired, and it is wired to real git ─────────────────────────────

describe("#1216: the mechanism has a production caller", () => {
  test("HC-15: the SessionStart hook imports it, so this is not a library nobody calls", () => {
    // `registeredTreeCensus` shipped under #1006 and `git grep` outside its
    // own test file returned nothing for a month. A library function with no
    // production caller is not shipped, however well tested.
    const hook = readFileSync(join(REPO_ROOT, "hooks", "HookCurrency.hook.ts"), "utf-8");
    expect(hook).toContain("hook-tree-currency");
    expect(hook).toContain("currencyReportLines");
    expect(hook).toContain("readRegistrationCurrency");

    // And it builds its runner through the one isolated binding. An inline
    // `spawnSync('git', …)` here is how the unisolated version shipped in
    // the first place, and HC-18 cannot see it: HC-18 drives the runner it
    // is handed, so a second runner built beside it is invisible to the
    // population it measures.
    expect(hook).toContain("spawnGitRunner(spawnSync)");
    expect(
      [...hook.matchAll(/spawnSync\(\s*['"]git['"]/g)].length,
      "the hook spawns git directly instead of going through spawnGitRunner, so a directory " +
        "nobody supervises gets to run its own .git/config at SessionStart",
    ).toBe(0);
  });

  test("HC-16: it never fetches, merges or writes — every git call is a query", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "hook-tree-currency.ts"), "utf-8");
    const calls = [...src.matchAll(/git\(\s*dir\s*,\s*\[([^\]]*)\]/g)].map(m =>
      m[1]!.split(",")[0]!.trim().replace(/['"]/g, ""),
    );
    expect(calls.length, "no git invocation was found, so this asserts nothing").toBeGreaterThan(3);
    expect(
      calls.filter(c => !["rev-parse", "rev-list", "status"].includes(c)),
      "a git subcommand that is not a query reached a directory somebody is executing from. " +
        "#1216 is explicit that this must REPORT staleness, never repair it",
    ).toEqual([]);
  });

  test("HC-18: EVERY invocation carries both halves of the isolation, and a timeout", () => {
    // A subcommand allowlist alone is a detector narrower than what it
    // detects (`.claude/rules/checks-must-be-able-to-fail.md`, shape two):
    // "we only ran rev-list" stays green against an unisolated call for
    // ever. This asserts the POPULATION of invocations, not a string in the
    // source — the recorder runs a whole multi-directory reading and every
    // call it saw has to carry the flags.
    const seen: { args: string[]; env: NodeJS.ProcessEnv; timeout: number }[] = [];
    const recorder: SpawnGit = (_cmd, args, opts) => {
      seen.push({ args, env: opts.env, timeout: opts.timeout });
      // Drive the reading down the longest path: a resolvable base, a HEAD,
      // a count of zero, and therefore a `status` call too.
      const last = args[args.length - 1] ?? "";
      if (args.includes("rev-list")) return { status: 0, stdout: "0\n" };
      if (args.includes("status")) return { status: 0, stdout: "" };
      if (last.startsWith("--show-toplevel")) return { status: 0, stdout: "/x\n" };
      return { status: 0, stdout: `${"a".repeat(40)}\n` };
    };

    registrationCurrency(census(["/x/hooks/A.hook.ts", "/y/hooks/B.hook.ts"]), BASE, spawnGitRunner(recorder));

    expect(seen.length, "no invocation was recorded, so this asserts nothing").toBeGreaterThan(6);

    for (const [k, v] of GIT_ISOLATION_CONFIG) {
      const missing = seen.filter(c => {
        const at = c.args.indexOf("-c");
        return !c.args.some((a, i) => a === "-c" && c.args[i + 1] === `${k}=${v}` && at >= 0);
      });
      expect(
        missing.length,
        `${missing.length} of ${seen.length} invocations reached a directory we do not own ` +
          `without -c ${k}=${v}. git executes its own config; the checkout's .git/config is ` +
          `reachable only by command scope`,
      ).toBe(0);
    }

    for (const [k, v] of Object.entries(GIT_ISOLATION_ENV)) {
      const missing = seen.filter(c => c.env[k] !== v);
      expect(
        missing.length,
        `${missing.length} of ${seen.length} invocations ran without ${k}=${v}, so ~/.gitconfig ` +
          `was live. The -c flags do not cover whole config FILES`,
      ).toBe(0);
    }

    expect(
      seen.filter(c => !(c.timeout > 0)).length,
      "an invocation had no timeout, so a poisoned fsmonitor on a wedged directory hangs " +
        "SessionStart instead of reading UNMEASURED",
    ).toBe(0);
  });

  test("HC-19: a poisoned .git/config cannot make a hand-edited tree read `current`", () => {
    // The negative control, with real git. Not "the flags are in the argv" —
    // the exploit, performed, through this module's own decision.
    //
    // Measured 2026-10-23 before the fix: `core.excludesFile` set in the
    // TARGET's own `.git/config` hides the uncommitted hook from
    // `git status`, so the reading that exists to catch bytes matching no
    // commit certifies them as current. The same planting also runs
    // `core.fsmonitor` as a program — arbitrary execution at SessionStart,
    // out of the unsupervised directory this whole feature is about.
    const repo = pair("poisoned-config", 0, 0);
    const dir = join(repo, "hooks");
    writeFileSync(join(dir, "Edited.hook.ts"), "hand-edited\n");

    const unisolated: GitRunner = (d, args) => {
      const r = spawnSync("git", ["-C", d, ...args], { encoding: "utf-8" });
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    };
    const isolated = spawnGitRunner(spawnSync);

    // Control first: with nothing planted, BOTH runners see the edit. So the
    // rows below separate on the poisoning and on nothing else.
    expect(directoryCurrency(dir, BASE, unisolated).state).toBe("unmeasured");
    expect(directoryCurrency(dir, BASE, isolated).state).toBe("unmeasured");

    const ignore = join(repo, "ignore-list");
    writeFileSync(ignore, "Edited.hook.ts\n");
    git(repo, ["config", "core.excludesFile", ignore]);

    expect(
      directoryCurrency(dir, BASE, unisolated).state,
      "the unisolated runner no longer reproduces the defect, so the row below proves nothing " +
        "about isolation — re-derive what git honours before trusting it",
    ).toBe("current");

    expect(
      directoryCurrency(dir, BASE, isolated).state,
      "a directory poisoned its own reading: the hand-edited hook was certified as matching a " +
        "merged commit, which is the exact failure #1216 exists to catch",
    ).toBe("unmeasured");
  });

  test("HC-17: the live reading on this machine, through the assembled entry point", () => {
    // Machine state, and the case that makes CI witness the subject rather
    // than skip it. On a runner `~/.claude/settings.json` does not exist and
    // the reading is UNMEASURED; the refusal is what is asserted there.
    const readIfPresent = (p: string): string | null =>
      existsSync(p) ? readFileSync(p, "utf-8") : null;
    const registry = JSON.parse(
      readFileSync(join(REPO_ROOT, ".claude", "rungate", "hooks.json"), "utf-8"),
    ) as { command?: string }[];
    // Read off the tree, the way the hook reads it. A hand-written short
    // list was MEASURED WRONG here: with two names it reached only the
    // directory `RUNGATE_HOOKS_DIR` resolves to, so the `unmeasured` branch
    // below was never taken and the case stayed green under a mutant that
    // reported every refusal as `current`.
    const owned = readdirSync(join(REPO_ROOT, "hooks"))
      .filter(n => n.endsWith(".hook.ts"))
      .map(n => n.replace(/\.hook\.ts$/, ""));

    const r = readRegistrationCurrency({
      repoRoot: REPO_ROOT,
      home: homedir(),
      base: BASE,
      readFile: readIfPresent,
      ownedHooks: owned,
      registryCommands: registry.map(h => String(h?.command ?? h)),
      git: realGit,
    });

    expect(r.examined, "no registration of an owned hook was examined").toBeGreaterThan(0);

    if (r.reading === "UNMEASURED") {
      expect(
        r.unmeasuredReasons.length,
        "the reading is UNMEASURED and says nothing about why, which nobody can act on",
      ).toBeGreaterThan(0);
    }

    // Whatever the verdict, no row may claim currency without the evidence
    // for it. This is the property the whole issue is about.
    for (const d of r.directories) {
      if (d.state === "current") {
        expect(d.baseSha, `${d.dir} reads current with no base SHA behind it`).not.toBeNull();
        expect(d.headSha).not.toBeNull();
        expect(d.behind).toBe(0);
      } else {
        expect(d.detail.length, `${d.dir} is ${d.state} with no reason given`).toBeGreaterThan(20);
      }
    }
  });
});
