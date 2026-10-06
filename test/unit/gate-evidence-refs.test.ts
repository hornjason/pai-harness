/**
 * Evidence commands are ref-normalized at the point they EXECUTE (#118).
 *
 * `lib/evidence-prevalidator.ts` already rewrites bare `main` at Scope. That is
 * not a chokepoint: the verify-gate re-implementation path authors NEW ACs
 * after Scope has run, so a command can reach `autoPopulateACs` having never
 * been prevalidated. Normalizing only at Scope would repair the commands that
 * were already least likely to be wrong, and miss the ones written during a
 * retry — which is the exact path #103 died on.
 *
 * These tests drive `autoPopulateACs` directly with throwaway state. They are
 * about ref rewriting only; verdict logic is covered elsewhere.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { autoPopulateACs, remoteRefsIn, __refResolutionCache } from "../../gates/gate-executor";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function stateWith(command: string) {
  return {
    projectRoot: REPO_ROOT,
    acs: [
      {
        id: "AC-1",
        verdict: "PENDING",
        threshold: { op: "==", value: "0" },
        evidenceMethod: { type: "COMMAND", command },
      },
    ],
  } as Record<string, any>;
}

function run(state: Record<string, any>) {
  const dir = mkdtempSync(join(tmpdir(), "gate-ev-"));
  const sf = join(dir, "state.json");
  writeFileSync(sf, JSON.stringify(state));
  try {
    autoPopulateACs(state, sf);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return state.acs[0];
}

describe("#118: the executing command is the corrected one", () => {
  // The cache is process-wide by design. Without this, one test's seeded
  // resolution silently answers another test's lookup — which it did, turning
  // the path-lookalike test green for the wrong reason.
  beforeEach(() => __refResolutionCache.clear());

  test("a bare main ref is rewritten onto the AC", () => {
    // Written BACK onto the AC, not just used locally: a human reading the
    // failure has to see the command that actually ran, and the persisted
    // state is what the next phase reads.
    const ac = run(stateWith("git rev-parse main >/dev/null 2>&1; echo $?"));
    expect(ac.evidenceMethod.command).toBe("git rev-parse origin/main >/dev/null 2>&1; echo $?");
  });

  test("the exact #103 command is corrected at execution time", () => {
    const ac = run(stateWith(
      "git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?",
    ));
    expect(ac.evidenceMethod.command).toContain("origin/main");
    expect(ac.evidenceMethod.command).not.toMatch(/--exit-code main\b/);
  });

  test("and that command no longer produces a false FAIL", () => {
    // The payoff, asserted against the real repository rather than a fixture.
    // `hooks/TestSuiteGuard.hook.ts` is identical to origin/main; against the
    // local `main` ref it may not be. This is the AC that produced a confident,
    // detailed, wrong FAIL and spawned a second Marcus to "fix" a correct file.
    //
    // PASS where origin/main is reachable. Where it is not — CI checks out the
    // PR merge ref and may have no refs/remotes/origin/main — the gate still
    // blocks, but it must block as "I could not measure this", never as a
    // verdict on the file. That distinction is the whole of #118: a bare PASS
    // assertion stated an accident of the local clone, and the "PASS or SKIP"
    // version it was replaced with let unmeasured ACs advance (see below).
    const ac = run(stateWith(
      "git diff --exit-code main -- hooks/TestSuiteGuard.hook.ts >/dev/null 2>&1; echo $?",
    ));
    const context = `evidence ran: ${ac.evidenceMethod.command}`;
    if (ac.verdict !== "PASS") {
      expect(ac.evidence?.type, `scored a code verdict on unfetched evidence — ${context}`)
        .toBe("unmeasured");
    }
  });

  test("an unresolvable ref blocks, and says it is an environment fault", () => {
    // The environment-fault path, forced deterministically.
    //
    // This asserted SKIP in its first version, which security review correctly
    // called a gate bypass: gates/orchestrator.test.ts:214 is "allows advance
    // when all ACs are PASS or SKIP", so an unmeasurable AC would have
    // advanced unverified. Anything that can make a ref unresolvable — a typo,
    // a network blip, a crafted ref name — would have turned a blocking
    // verdict into a passing run.
    //
    // So it blocks. The thing #118 is actually about is not "never FAIL", it
    // is "never fabricate a specific finding you did not measure". The #103
    // damage was a confident report of a 5-line diff at named line numbers
    // that a second agent then acted on. An honest "the ref is unreachable" is
    // the opposite of that, and it is safe to act on.
    const ac = run(stateWith(
      "git diff --exit-code origin/branch-that-does-not-exist-9f3a -- README.md; echo $?",
    ));
    expect(ac.verdict, "an unmeasurable AC was allowed to advance").toBe("FAIL");
    expect(ac.evidence.type).toBe("unmeasured");
    expect(ac.evidence.content).toContain("environment fault");
    expect(ac.evidence.content, "the failure must not read as a code defect")
      .toContain("origin/branch-that-does-not-exist-9f3a");
  });

  test("a ref is resolved once per run, not once per AC", () => {
    // resource-exhaustion, from the same review. Every AC referencing
    // origin/main would otherwise attempt its own fetch; twenty ACs against an
    // unreachable remote is twenty 60s timeouts in series before any verdict
    // exists.
    //
    // Counted rather than timed. The timed version of this asserted "under
    // 20s" and would have passed uncached — the whole file runs in under a
    // second, because a fetch of a nonexistent ref fails fast locally. It was
    // an assertion that could not fail, which is the thing this repo keeps
    // shipping; see .claude/rules/checks-must-be-able-to-fail.md.
    // Proven by pre-seeding, not by counting. Counting cache entries only
    // showed that something was written, which stayed true with the lookup
    // deleted — the mutation ran green. Seeding a verdict the real resolver
    // could never produce (this ref does not exist anywhere) means the AC can
    // only avoid blocking if the lookup is consulted.
    __refResolutionCache.clear();
    __refResolutionCache.set(`${REPO_ROOT}\u0000origin/nope-7c2b`, true);
    const state = {
      projectRoot: REPO_ROOT,
      acs: ["AC-1", "AC-2", "AC-3"].map(id => ({
        id, verdict: "PENDING",
        threshold: { op: "==", value: "0" },
        evidenceMethod: { type: "COMMAND", command: `git rev-parse --verify origin/nope-7c2b >/dev/null 2>&1; echo 0` },
      })),
    } as Record<string, any>;
    run(state);
    for (const ac of state.acs) {
      expect(ac.evidence?.type, "the cached resolution was ignored and re-resolved per AC")
        .not.toBe("unmeasured");
    }
    expect(__refResolutionCache.size, "a second entry means a second resolution").toBe(1);
  });

  test("a real ref and a path-shaped lookalike are told apart", () => {
    // The end-to-end shape of the parser-differential finding: one command,
    // one genuine ref, one path that merely contains `origin/`.
    const ac = run(stateWith(
      "git diff --exit-code origin/nope-7c2b -- docs/origin/nope-7c2b.md; echo $?",
    ));
    expect(ac.evidence?.type).toBe("unmeasured");
    expect(ac.verdict).toBe("FAIL");
  });
});

/**
 * The scan itself, driven directly.
 *
 * Going through `autoPopulateACs` could not prove this. Each example was
 * protected by a different one of the three defenses — the git-invocation
 * restriction, the `--` pathspec split, the path-character lookbehind — so
 * removing any single defense still left every test green. Four separate
 * mutations ran clean before this table existed, which is exactly the
 * "assertions that hold vacuously" shape in
 * .claude/rules/checks-must-be-able-to-fail.md.
 *
 * Each row below is positioned so that one defense, and only that defense, is
 * what keeps it correct.
 */
describe("#118: remoteRefsIn reads refs, not paths", () => {
  test.each([
    // Needs the git-invocation restriction: ref position, no path characters.
    ["grep -rn origin/main docs/", []],
    ["echo origin/main", []],
    // Needs the `--` pathspec split: inside git, bare, but after the separator.
    ["git log --oneline -- origin/main", []],
    ["git diff origin/main -- origin/release", ["origin/main"]],
    // Needs the lookbehind: inside git, before any separator, path-shaped.
    ["git log --oneline docs/origin/main", []],
    ["git diff build/upstream/main", []],
    // Plainly refs.
    ["git diff --exit-code origin/main; echo $?", ["origin/main"]],
    ["git merge-base origin/main HEAD", ["origin/main"]],
    ["git rev-list upstream/release-2.1..HEAD", ["upstream/release-2.1"]],
    // Repeated refs collapse — one fetch, not one per mention.
    ["git diff origin/main origin/main", ["origin/main"]],
    // Nothing to find.
    ["bun test", []],
  ])("%s", (command, expected) => {
    expect(remoteRefsIn(command).sort()).toEqual([...expected].sort());
  });

  test("a command with no bare ref is left byte-identical", () => {
    const cmd = "echo 0";
    const ac = run(stateWith(cmd));
    expect(ac.evidenceMethod.command).toBe(cmd);
  });

  test("an already-qualified ref is not double-qualified", () => {
    const cmd = "git rev-parse origin/main >/dev/null 2>&1; echo $?";
    const ac = run(stateWith(cmd));
    expect(ac.evidenceMethod.command).toBe(cmd);
  });

  test("a path that merely contains 'main' is untouched", () => {
    // Over-rewriting would manufacture failures instead of removing them.
    const cmd = "test -f lib/main-loop.ts; echo $?";
    const ac = run(stateWith(cmd));
    expect(ac.evidenceMethod.command).toBe(cmd);
  });
});
