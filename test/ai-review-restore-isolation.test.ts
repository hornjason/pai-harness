/**
 * ai-review-restore-isolation.test.ts — the restore step's own git calls (#967).
 *
 * ## What #965 left open
 *
 * PR #965 put `AI_REVIEW_GIT_ISOLATED` in front of the two git calls in
 * `AI_REVIEW_TREE_READER` and said so in its own `## Scope` paragraph:
 * `buildRestoreScript` runs four more — `fetch`, `rm`, `cat-file`, `checkout`
 * — and all four were left bare, because the `fetch` is a NETWORK call and the
 * same env vars would discard a proxy, a CA bundle or an `insteadOf` rewrite.
 * Different trade-off, deliberately deferred. #967 is that decision.
 *
 * The exposure is the reader's: the reviewer runs as the same user on a pool
 * where `$HOME` persists between jobs, so a prior job's reviewer can leave a
 * `~/.gitconfig` that this step reads. The step running BEFORE the reviewer
 * does not help — the poison does not have to come from this job.
 *
 * ## Re-landed on its own (#1002, #1008)
 *
 * This shipped once inside PR #1002 beside #969's `--ignored=matching`. That
 * flag enumerated the action's own `.claude-pr/` scratch and turned every pull
 * request in the repository red; the revert in #1008 was a clean revert of the
 * whole commit, so it took this hardening with it, having never caused
 * anything. The cases below are the #967 half of that file, lifted unchanged
 * apart from the header you are reading. #969's half re-lands separately, with
 * the scratch case the first attempt did not have.
 *
 * ## Everything below is executed
 *
 * #952 shipped 17 green cases over a fix that did not work, because every one
 * asserted that the repaired string appeared in the emitted YAML. So every
 * behavioural case here poisons a real `~/.gitconfig` or a real `.git/config`
 * and runs the real emitted bash twice — hardened, and with the mechanism
 * stripped back out MECHANICALLY from `AI_REVIEW_GIT_KEYS_ONLY`, the single
 * constant that carries it. A hand-written copy of the old command would stay
 * green while the shipped constant was gutted; this collapses onto the
 * hardened variant the moment the constant stops carrying anything, which is
 * what makes the FIRED halves real.
 *
 * ## The measured battery, and WHICH assertion each row reddens
 *
 * Run over this file alone (10 cases), except M6 which is counted over this
 * file plus `test/ai-review-git-config-isolation.test.ts` (26) because the key
 * list it mutates is shared with that file's subject.
 * `lib/scaffold/ai-review-step.ts` was restored from a `cp` backup after every
 * row — never `git checkout --` — and confirmed byte-identical by sha256
 * afterwards. **The baseline row was read before any mutation row.** Every
 * count was predicted before the battery ran; the `Predicted` column is that
 * prediction, kept rather than quietly corrected, because a row that MOVED is
 * the finding.
 *
 * **Which assertion each row reddens is named, not just how many: a count that
 * is right about the wrong assertion is not coverage.**
 *
 * | Row | Mutation | Predicted | Measured | Which assertions |
 * |---|---|---|---|---|
 * | **baseline** | unmutated | 10 pass, 0 fail | **10 pass, 0 fail** | — |
 * | **M2** | `AI_REVIEW_GIT_KEYS_ONLY` = `"git"` — the pre-#967 restore step | 5 | **5 of 10** | AC-7 ×2, AC-8, AC-10/bare-git, AC-10/no-env |
 * | **M3** | `AI_REVIEW_GIT_KEYS_ONLY` = `AI_REVIEW_GIT_ISOLATED` — the shape #967 rejects | 2 | **2 of 10** | AC-9/insteadOf, AC-10/no-env |
 * | **M6** | `-c core.fsmonitor=` dropped from the shared key list | 5 | **5 of 26** | AC-7 ×2, AC-10/one-key-list, and the #960 file's AC-3 local and AC-7/fragments |
 *
 * The row numbering is #1002's, kept rather than renumbered, so these counts
 * can be compared against the ones that file recorded. M1, M4 and M5 mutate
 * #969's flag and belong to #969's file. Every row reproduced #1002's measured
 * count and reddened the same assertions, on a tree 183 commits further on.
 *
 * **M6's two reds in the #960 file are both the LOCAL scope, and that is the
 * row's own control.** `core.fsmonitor` set in `~/.gitconfig` is still caught
 * without the flag, because the reader's prefix keeps the env vars that
 * discard the whole global file; the flag is the only thing covering the
 * checkout's own `.git/config`. The restore step has no env-var half at all,
 * which is why AC-7's `~/.gitconfig` half reds here and its counterpart over
 * there does not.
 *
 * **Before believing any row, the input on which mutant and original differ,
 * named and run rather than assumed.** M2 and M6: a `~/.gitconfig` naming a
 * marker-writing `core.fsmonitor` — the marker exists after the mutant's
 * restore step and not after the original's. M3: an `origin` of
 * `rungate-test://upstream` with only a `~/.gitconfig` `insteadOf` to resolve
 * it — the original fetches (exit 0), the mutant exits 128 with
 * `'remote-rungate-test' is not a git command`.
 *
 * **M2 came back LOW against #1002's prediction and it is recorded rather than
 * smoothed.** It was predicted to red AC-12/2 as well; it does not. With the
 * prefix set to a bare `git`, `unprefix` becomes the identity and AC-12/2's
 * two assertions are both satisfied by the pre-#967 script. **AC-12/2 is
 * therefore a vacuity guard against a stripper that fails to strip, not a
 * witness of M2** — its witnesses are AC-7, AC-8 and AC-10.
 *
 * **M3 is the row that argues the deliverable.** #967's real decision is the
 * SHAPE, not the hardening: dropping #965's full prefix in front of a network
 * call discards a proxy, a CA bundle or an `insteadOf` rewrite that a
 * self-hosted runner legitimately keeps in `~/.gitconfig`. AC-9 measures that
 * directly rather than arguing it — the restore step fetches through an
 * `insteadOf` rewrite under the shipped prefix and exits 128 under #965's.
 *
 * ## The cheapest wrong fixes, named, each with a case pointed at it
 *
 * - **Paste #965's prefix in front of the restore step.** One line, and it
 *   closes both measured execution vectors. It also breaks the fetch on the
 *   runners the hardening exists for. **AC-9 is red under it** (M3).
 * - **Harden `rm`/`checkout` and leave the `fetch` alone**, since the fetch is
 *   the one with the network trade-off. The `fetch` is the ONLY call that
 *   fires the `reference-transaction` hook. **AC-8 is red under it.**
 *
 * ## UNMEASURED, said out loud
 *
 * **The env-var half of the restore step's prefix does not exist**, by choice.
 * A `~/.gitconfig` key outside the three in `AI_REVIEW_GIT_NEUTRALISED_KEYS`
 * that makes `fetch`, `rm`, `cat-file` or `checkout` execute something is
 * still read by the restore step. No case here witnesses a key the env vars
 * would catch and the `-c` flags miss — #965 looked for one over the reader
 * and found none, and that search is not repeated here.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_GIT_ISOLATED,
  AI_REVIEW_GIT_KEYS_ONLY,
  AI_REVIEW_GIT_NEUTRALISED_KEYS,
  buildRestoreScript,
} from "../lib/scaffold/ai-review-step";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

/**
 * #1140: these cases are built on real `git` subprocesses and inherit bun's
 * 5000ms default, which was never derived from what they cost. The budget is
 * calibrated on the machine running the suite — see `helpers/git-fixture-budget.ts`
 * for the measurements and the headroom.
 */
setDefaultTimeout(gitFixtureTestTimeout());

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

type Variant = "hardened" | "unhardened";

/** Strip #967's mechanism back out, from the one constant that carries it. */
function unprefix(script: string): string {
  return script.split(AI_REVIEW_GIT_KEYS_ONLY).join("git");
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment a runner step actually has: a `HOME` git will read, and no
 * `GIT_CONFIG_*` of our own. The house helper used by every other ai-review
 * test sets `GIT_CONFIG_GLOBAL=/dev/null`, which is part of the isolation
 * under test — a case written with it would be green before the fix and
 * after it. AC-11 asserts this one has not quietly re-isolated.
 */
function stepEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    ...extra,
  };
}

function sh(script: string, cwd: string, env: Record<string, string>): Run {
  const path = join(scratchDir("ai-review-ri-script-"), "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", "-e", path], { cwd, env });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

interface Fixture {
  /** A `HOME` the fixture owns and may poison. */
  home: string;
  /** The checkout, inside `home`, the way a runner workspace is. */
  work: string;
  /** Somewhere a hook can leave a marker WITHOUT tripping the outside walk. */
  marker: string;
  /** The bare repository `origin` points at, for the restore step's fetch. */
  origin: string;
  git: (...a: string[]) => void;
}

/**
 * A committed repository with one tracked file and an `origin` the restore
 * step can fetch from.
 *
 * The fixture's OWN git calls are isolated through the environment — the
 * subject under test is the emitted bash, not this scaffolding, and a fixture
 * that read the poisoned `~/.gitconfig` it just wrote would be building the
 * repository with the attack applied to itself.
 */
function checkout(): Fixture {
  const home = scratchDir("ai-review-ri-home-");
  const work = join(home, "work", "repo");
  const marker = scratchDir("ai-review-ri-marker-");
  const origin = scratchDir("ai-review-ri-origin-");
  mkdirSync(work, { recursive: true });

  const fixtureEnv = () =>
    stepEnv(home, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", work, ...a], { env: fixtureEnv() });
    if (r.exitCode !== 0) {
      throw new Error(`git ${a.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  };

  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "tracked.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  // `-b main` on the bare repo too. Without it the initial branch comes from
  // whatever default the host's git carries — `main` from the system gitconfig
  // Apple's CommandLineTools ships, `master` on an ubuntu runner — and a
  // fixture that reads a setting CI does not have is green here and red there.
  // Measured under #989, where the same omission cost a CI round trip.
  const bare = Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", origin], {
    env: fixtureEnv(),
  });
  if (bare.exitCode !== 0) {
    throw new Error(`git init --bare failed: ${new TextDecoder().decode(bare.stderr)}`);
  }
  git("remote", "add", "origin", `file://${origin}`);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("update-ref", "-d", "refs/remotes/origin/main");

  return { home, work, marker, origin, git };
}

/** A script that records that git executed it, outside `HOME`. */
function markerScript(f: Fixture, name: string, extra = ""): string {
  const p = join(f.marker, name);
  writeFileSync(p, `#!/bin/sh\n: > "${join(f.marker, `${name}.fired`)}"\n${extra}`);
  chmodSync(p, 0o755);
  return p;
}

function fired(f: Fixture, name: string): boolean {
  try {
    readFileSync(join(f.marker, `${name}.fired`));
    return true;
  } catch {
    return false;
  }
}

function clearMarker(f: Fixture, name: string): void {
  rmSync(join(f.marker, `${name}.fired`), { force: true });
}

/**
 * The environment the restore step requires, beyond the base ref.
 *
 * `GITHUB_OUTPUT` is not decoration: #989 made the step publish the base ref
 * it restored from and REFUSE when it has nowhere to publish it, because the
 * drift step needs that ref to tell the review action's own second restore
 * from a reviewer write. A fixture without one refuses before reaching any
 * git call, which is a green `fired()` assertion for the wrong reason.
 */
function stepOutputs(): Record<string, string> {
  const out = join(scratchDir("ai-review-ri-out-"), "github-output");
  writeFileSync(out, "");
  return { GITHUB_OUTPUT: out };
}

function runRestore(f: Fixture, v: Variant, extraEnv: Record<string, string> = {}): Run {
  const script = v === "hardened" ? buildRestoreScript() : unprefix(buildRestoreScript());
  return sh(
    script,
    f.work,
    stepEnv(f.home, { [AI_REVIEW_BASE_REF_VAR]: "main", ...stepOutputs(), ...extraEnv }),
  );
}

type Scope = "~/.gitconfig" | "the checkout's .git/config";

function poison(f: Fixture, scope: Scope, key: string, value: string): void {
  if (scope === "~/.gitconfig") writeFileSync(join(f.home, ".gitconfig"), `[core]\n\t${key} = ${value}\n`);
  else f.git("config", `core.${key}`, value);
}

// ── AC-7: core.fsmonitor, in both scopes the reviewer can reach ───────────

describe("AC-7 (#967): the restore step does not execute a reviewer-named fsmonitor", () => {
  for (const scope of ["~/.gitconfig", "the checkout's .git/config"] as const) {
    test(`set in ${scope}: it runs pre-#967 and does not run now`, () => {
      const f = checkout();
      // The fsmonitor protocol wants a NUL-terminated path list on stdout;
      // `/` means "assume everything changed", which keeps the step correct
      // while proving the process ran.
      poison(f, scope, "fsmonitor", markerScript(f, "fsmonitor", `printf '/\\0'\n`));

      const before = runRestore(f, "unhardened");
      expect(before.code, `the pre-#967 restore step refused outright:\n${before.stderr}`).toBe(0);
      expect(
        fired(f, "fsmonitor"),
        `git did not execute a core.fsmonitor set in ${scope} during the restore step, so this ` +
          `case is not measuring the vector it claims`,
      ).toBe(true);

      clearMarker(f, "fsmonitor");
      const after = runRestore(f, "hardened");
      expect(after.code, `the hardened restore step refused outright:\n${after.stderr}`).toBe(0);
      expect(
        fired(f, "fsmonitor"),
        `the restore step still executes a command named by core.fsmonitor in ${scope} — the step ` +
          `whose job is to replace reviewer-influenced files runs the reviewer's code`,
      ).toBe(false);
    });
  }
});

// ── AC-8: the reference-transaction hook, which ONLY the fetch fires ──────

describe("AC-8 (#967): the restore step's fetch does not fire reviewer-relocated hooks", () => {
  test("a reference-transaction hook fires pre-#967 and does not fire now", () => {
    const f = checkout();
    const hooks = scratchDir("ai-review-ri-hooks-");
    const hook = join(hooks, "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\n: > "${join(f.marker, "reftx.fired")}"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(f.home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);

    // The fixture deletes `refs/remotes/origin/main` after pushing, so the
    // restore step's fetch really does create a ref — a fetch with nothing to
    // update opens no reference transaction and fires nothing, which would
    // make this case green for a reason unrelated to the fix.
    const before = runRestore(f, "unhardened");
    expect(before.code, `the pre-#967 restore step refused outright:\n${before.stderr}`).toBe(0);
    expect(
      fired(f, "reftx"),
      "the fetch fired no reference-transaction hook, so this case is not measuring the vector " +
        "it claims — check that the fixture's fetch actually updates a ref",
    ).toBe(true);

    clearMarker(f, "reftx");
    f.git("update-ref", "-d", "refs/remotes/origin/main");
    const after = runRestore(f, "hardened");
    expect(after.code, `the hardened restore step refused outright:\n${after.stderr}`).toBe(0);
    expect(
      fired(f, "reftx"),
      "the restore step's fetch still fires hooks from a directory core.hooksPath names",
    ).toBe(false);
  });
});

// ── AC-9: the control that decides the SHAPE, which is the deliverable ────

describe("AC-9 (#967): the restore step keeps the runner's network configuration", () => {
  test("a ~/.gitconfig insteadOf rewrite still resolves, and #965's prefix would break it", () => {
    const f = checkout();
    // A self-hosted runner legitimately keeps `http.proxy`, `http.sslCAInfo`
    // and `url.<base>.insteadOf` here. `insteadOf` is the one of the three
    // whose effect is observable without a network: point `origin` at a
    // scheme git has no helper for, and the fetch succeeds only if the global
    // file was read.
    f.git("remote", "set-url", "origin", "rungate-test://upstream");
    writeFileSync(
      join(f.home, ".gitconfig"),
      `[url "file://${f.origin}"]\n\tinsteadOf = rungate-test://upstream\n`,
    );

    const shipped = runRestore(f, "hardened");
    expect(
      shipped.code,
      "the restore step took the runner's own url.insteadOf rewrite with it, so every fetch on a " +
        `runner that needs a proxy, a CA bundle or a rewrite now refuses UNMEASURED:\n${shipped.stderr}`,
    ).toBe(0);

    // The rejected shape, applied: #965's full prefix in front of the same
    // step. Without this half the case above is satisfied by a fixture whose
    // remote never needed the rewrite.
    const f2 = checkout();
    f2.git("remote", "set-url", "origin", "rungate-test://upstream");
    writeFileSync(
      join(f2.home, ".gitconfig"),
      `[url "file://${f2.origin}"]\n\tinsteadOf = rungate-test://upstream\n`,
    );
    const envNeutralised = sh(
      buildRestoreScript().split(AI_REVIEW_GIT_KEYS_ONLY).join(AI_REVIEW_GIT_ISOLATED),
      f2.work,
      stepEnv(f2.home, { [AI_REVIEW_BASE_REF_VAR]: "main", ...stepOutputs() }),
    );
    expect(
      envNeutralised.code,
      "neutralising the global config file did NOT break the rewrite, so the shape argument in " +
        "AI_REVIEW_GIT_KEYS_ONLY's docblock is unwitnessed and the env vars could simply be added",
    ).not.toBe(0);
  });

  test("control: the hardened restore step still restores, with no poison at all", () => {
    const f = checkout();
    const run = runRestore(f, "hardened");
    expect(run.code, `the hardened restore step refused a clean fixture:\n${run.stderr}`).toBe(0);
    expect(run.stdout, "the step reported no restore").toContain("ai-review restored from");
  });
});

// ── AC-10: every git call in the step, not just the two measured ones ─────

describe("AC-10 (#967): no git invocation in the restore step runs unprefixed", () => {
  test("the EMITTED bash has no bare git in command position", () => {
    const script = buildRestoreScript();
    const stripped = script.split(AI_REVIEW_GIT_KEYS_ONLY).join("<prefixed>");
    const bare = stripped
      .split("\n")
      .filter(l => !l.trimStart().startsWith("#"))
      .filter(l => /(?:^|[|&;(]|\$\()[ \t]*git[ \t]/.test(l));
    expect(
      bare,
      `the restore step runs git without the prefix, so the reviewer's ~/.gitconfig still names ` +
        `commands it executes:\n${bare.join("\n")}`,
    ).toEqual([]);
    expect(
      (stripped.match(/<prefixed>/g) ?? []).length,
      "the restore step prefixes a different number of git calls than its four",
    ).toBe(4);
  });

  test("the prefix carries the -c keys and deliberately NOT the env vars", () => {
    expect(
      AI_REVIEW_GIT_KEYS_ONLY,
      "the restore prefix does not carry the shared key list, so it can drift from the reader's",
    ).toContain(AI_REVIEW_GIT_NEUTRALISED_KEYS);
    for (const absent of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "safe.directory"]) {
      expect(
        AI_REVIEW_GIT_KEYS_ONLY,
        `the restore prefix carries ${absent}. The env vars discard the whole global file, and ` +
          `the fetch is a NETWORK call — see AC-9. safe.directory is then unnecessary too, ` +
          `because actions/checkout's own entry is still being read`,
      ).not.toContain(absent);
    }
  });

  test("both prefixes are built from ONE key list, so neither can drift", () => {
    expect(
      AI_REVIEW_GIT_ISOLATED,
      "the reader's prefix spells its -c keys itself, so a key added to one prefix would " +
        "silently not reach the other",
    ).toContain(AI_REVIEW_GIT_NEUTRALISED_KEYS);
    expect(AI_REVIEW_GIT_NEUTRALISED_KEYS).toContain("-c core.fsmonitor=");
    expect(AI_REVIEW_GIT_NEUTRALISED_KEYS).toContain("-c core.hooksPath=/dev/null");
    expect(AI_REVIEW_GIT_NEUTRALISED_KEYS).toContain("-c core.excludesFile=/dev/null");
  });
});

// ── AC-11 / AC-12: the harness and the mutants are honest ─────────────────

describe("AC-11: this file's own environment can still be poisoned", () => {
  test("stepEnv sets no GIT_CONFIG_* of its own", () => {
    const env = stepEnv("/tmp/anywhere");
    for (const k of Object.keys(env)) {
      expect(
        k.startsWith("GIT_CONFIG_"),
        `${k} is set by the harness, which is part of the isolation under test — every case in ` +
          `this file would then be green before the fix and after it`,
      ).toBe(false);
    }
    expect(env.HOME, "the cases have no HOME to poison").toBe("/tmp/anywhere");
  });
});

describe("AC-12: the stripped variant really is the pre-fix script", () => {
  test("#967: the stripped restore step runs git with no prefix", () => {
    const stripped = unprefix(buildRestoreScript());
    expect(
      stripped,
      "the stripped restore step still neutralises keys, so every FIRED assertion is vacuous",
    ).not.toContain("-c core.fsmonitor=");
    expect(stripped).toContain("git rm -rfq --ignore-unmatch");
    expect(stripped).toContain("fetch --no-tags --depth=1");
  });
});
