/**
 * ai-review-baseline-seal.test.ts — the drift baseline cannot be forged
 * (#843 finding 2).
 *
 * ## The finding
 *
 * `buildBaselineScript` writes the pre-review reading of the tree to
 * `${RUNNER_TEMP}/ai-review-tree-before-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.txt`
 * and hands the drift step its path. Every component of that name is a value
 * the reviewer can read, and the drift step's whole verdict is
 * `after` minus the contents of that file. So a reviewer that can write under
 * `RUNNER_TEMP` can append its own additions to the baseline and the
 * difference goes empty: the subject holds the pen on the record it is about
 * to be judged against.
 *
 * ## Why it is worth fixing BEFORE it can happen
 *
 * Measured on run `39518336224`: the reviewer was given no `--add-dir`, so
 * at that run it could not write under `RUNNER_TEMP` at all — which is also
 * why the findings payload never arrived, and is what #824 was open about.
 * **The obvious repair for #824 is `--add-dir "$RUNNER_TEMP"`**, and that
 * single flag hands the reviewer the baseline in the same stroke as the
 * payload. The seal is what makes that repair safe to make, so it went
 * first.
 *
 * #824 has since landed and it did NOT take that repair: the grant names a
 * per-run subdirectory holding the payload and nothing else, and this
 * baseline is a sibling of it rather than a child. So the reviewer still
 * cannot write to this file. The seal has not become redundant — it is the
 * second of two independent things that would have to fail, and the one that
 * does not depend on anybody re-deriving which directory was granted.
 *
 * ## The seal, and why it is a step OUTPUT
 *
 * The baseline step emits the file's SHA-256 as its own step output. A step's
 * outputs are captured when the step ends, so nothing a later step does can
 * change what a consumer of that output reads — the file stays writable and
 * forging it stops being silent.
 *
 * **The cheapest wrong fix, named: write the checksum to
 * `<baseline>.sha256` beside the baseline.** It reads like a seal, it is one
 * line, and it is worth nothing: an agent that can rewrite the first file can
 * rewrite the second in the same loop. `AC-6` asserts the sha travels through
 * `GITHUB_OUTPUT` and is red under that repair.
 *
 * ## The direction an unsealable run fails in
 *
 * A runner with neither `sha256sum` nor `shasum` cannot produce the seal.
 * That is UNMEASURED and is annotated as such rather than refused: the drift
 * COMPARISON is unaffected and still catches an honest reviewer's writes, and
 * refusing the whole job over a missing coreutil would be a gate consumers
 * delete. A seal that was produced and then cannot be recomputed is the
 * opposite case and refuses — a reading that could be taken at the start of
 * the job and cannot be taken at the end is not a reading that passed.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file + `test/ai-review-untrusted-restore.test.ts`
 * + `test/ai-review-workflow.test.ts` (82 tests). Every count was predicted
 * before the battery ran, in `/tmp/843-seal-battery/predictions.md`, and the
 * **baseline row was read first** — an instrument that has stopped reporting
 * takes the baseline down with it, and that is the row nobody mutates
 * anything to produce.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 0 fail | **82 pass, 0 fail** |
 * | M1 the seal-emission block deleted from `buildBaselineScript` | 7 | **7 of 82** |
 * | M2 **the cheapest wrong fix**: the seal written to `<baseline>.sha256` instead of `GITHUB_OUTPUT` | 6 | **6 of 82** |
 * | M3 the mismatch refusal neutered (`if false`) | 2 | **2 of 82** |
 * | M4 the unrecomputable-seal refusal removed | 1 | **0, then 1 of 82** — see below |
 * | M5 the empty-seal UNMEASURED warning removed from the drift step | 1 | **1 of 82** |
 * | M6 the env line deleted from the committed `ai-review.yml` | 1 | **1 of 82** |
 * | M7 the `[ -z expected ]` branch removed, so an absent seal compares as a mismatch | 2 | **15 of 82** — see below |
 * | M8 the pre-#843 module from `origin/main` | 11 | **a load-time `SyntaxError`; 0 of 11 run** |
 * | M9 every behavioural part reverted, symbols kept | 9 | **9 of 82**, naming the predicted nine |
 *
 * **M4 came back 0 first, and that was the finding.** Naming the input on
 * which mutant and original differ — a sealed baseline plus a `PATH` that
 * shadows both checksum tools — showed they differ only in the SENTENCE: with
 * the refusal gone, `actual` is empty and the mismatch branch one line below
 * refuses it as a forgery. Exit 1 either way, and `AC-4` was reading the exit
 * code. A runner missing a coreutil was being reported as a tampered
 * baseline. `AC-4` now asserts which of the two refusals fired, in both
 * directions, and the row is 1.
 *
 * **M7 came back high, and the extra reds are the real kind.** Thirteen of
 * the fifteen are pre-existing cases in the other two files, whose own
 * `runDrift` helpers supply no seal at all — squarely the behaviour M7
 * mutates, and the mutant is not broken (67 cases still pass). The fact it
 * records: the unsealed branch is what keeps every drift case written before
 * this change from refusing, so it is load-bearing for thirteen cases and not
 * for the two predicted.
 *
 * **M8 is the substitute for a TDD red that was not watched.** The cases were
 * written before the implementation and run after it, so there is no recorded
 * red from before the fix; a pre-change tree measures the same thing and is
 * reproducible, which a transient red is not. M8 aborts at import rather than
 * measuring anything, which is the loud behaviour a missing export should
 * have — M9 is the row that answers the question, by reverting the behaviour
 * while keeping the symbols.
 *
 * The one seal case green in M9 is `AC-2`'s *"real drift is still caught"*.
 * It is a **control**, not a witness: it is green on both sides by
 * construction, and it exists so that a seal which refused everything could
 * not read as a seal that caught something.
 *
 * None of the nine mutations is left in the tree; all were run and reverted
 * from a `cp` backup — never `git checkout --` — and
 * `lib/scaffold/ai-review-step.ts` and `.github/workflows/ai-review.yml` were
 * confirmed byte-identical afterwards by sha256.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_BASELINE_STEP_ID,
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_WORKFLOW_FILE,
  buildBaselineScript,
  buildDriftScript,
} from "../lib/scaffold/ai-review-step";

/**
 * The sentence an ordinary drift refusal carries.
 *
 * Spelled in full because `AI_REVIEW_DRIFT_TITLE` is "AI review modified the
 * tree" — so the phrase "modified the tree" is in EVERY refusal this step
 * emits, including the forgery one, and a case matching on it would be
 * measuring the title.
 */
const HONEST_DRIFT = "The reviewer modified the tree it was reviewing";

/** The two seal refusals, which must never report each other's fact. */
const FORGED = "does not match the checksum the baseline step emitted";
const CANNOT_RECOMPUTE = "neither sha256sum nor shasum";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const GIT_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  // A scratch HOME, not the developer's. #843 finding 1 added a
  // `find "$HOME"` to the drift step, and a suite pointed at a real home
  // directory walks it on every case — non-hermetic, and slow in proportion
  // to something no test controls. `test/ai-review-outside-reading.test.ts`
  // is where that reading is exercised, against a home it builds itself.
  HOME: scratchDir("ai-review-seal-home-"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function sh(script: string, cwd: string, env: Record<string, string>): Run {
  const dir = scratchDir("ai-review-seal-script-");
  const path = join(dir, "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", "-e", path], { cwd, env: { ...GIT_ENV(), ...env } });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

/** A committed tree with one tracked file. */
function checkout(): string {
  const work = scratchDir("ai-review-seal-work-");
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", work, ...args], { env: GIT_ENV() });
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "tracked.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return work;
}

/** Run the real baseline step and read back BOTH of its outputs. */
function runBaseline(work: string, extraEnv: Record<string, string> = {}) {
  const runnerTemp = scratchDir("ai-review-seal-temp-");
  const out = join(runnerTemp, "github-output");
  writeFileSync(out, "");
  const run = sh(buildBaselineScript(), work, {
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: out,
    ...extraEnv,
  });
  const text = readFileSync(out, "utf-8");
  return {
    run,
    path: /^path=(.*)$/m.exec(text)?.[1] ?? "",
    sha: /^sha256=(.*)$/m.exec(text)?.[1] ?? "",
    outputs: text,
  };
}

function runDrift(work: string, before: string, sha: string, extraEnv: Record<string, string> = {}): Run {
  return sh(buildDriftScript(), work, {
    AI_REVIEW_MODE: "vertex",
    [AI_REVIEW_TREE_BEFORE_VAR]: before,
    [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
    ...extraEnv,
  });
}

/** A PATH whose first entry shadows both checksum tools with failures. */
function pathWithoutChecksumTools(): string {
  const bin = scratchDir("ai-review-seal-nosha-");
  for (const name of ["sha256sum", "shasum", "openssl"]) {
    const p = join(bin, name);
    writeFileSync(p, "#!/bin/sh\nexit 127\n");
    chmodSync(p, 0o755);
  }
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

// ── AC-1: the seal is produced, and it is the file's own checksum ────────

describe("AC-1 (#843/2): the baseline step seals what it wrote", () => {
  test("it emits a sha256 output alongside the path", () => {
    const work = checkout();
    const { run, path, sha } = runBaseline(work);
    expect(run.code, `the baseline step refused:\n${run.stderr}`).toBe(0);
    expect(path, "the baseline wrote no path output").not.toBe("");
    expect(sha, "the baseline wrote no sha256 output").toMatch(/^[0-9a-f]{64}$/);
  });

  test("the seal is the checksum of the file, not of something else", () => {
    // Recomputed here with a different implementation than the shell used.
    // Comparing the script's number to the script's own number would be the
    // question restated.
    const work = checkout();
    writeFileSync(join(work, "untracked.ts"), "export const b = 2;\n");
    const { path, sha } = runBaseline(work);
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
    expect(sha).toBe(digest);
  });
});

// ── AC-2: a forged baseline is refused ───────────────────────────────────

describe("AC-2 (#843/2): a baseline edited after it was sealed is refused", () => {
  test("the attack the finding describes: hide a write by adding it to the baseline", () => {
    const work = checkout();
    const { path, sha } = runBaseline(work);

    // The reviewer writes a file it was told not to write...
    writeFileSync(join(work, "evil.ts"), "export const owned = true;\n");
    // ...and appends its own line to the baseline so the difference is empty.
    // The line is produced the way the reader produces one (#853: content,
    // then path) and the hash is taken from git rather than written down, so
    // the forgery keeps matching if the fixture's bytes ever change.
    const blob = Bun.spawnSync(["git", "-C", work, "hash-object", "--", "evil.ts"], {
      env: GIT_ENV(),
    });
    const hash = new TextDecoder().decode(blob.stdout).trim();
    expect(hash, "could not hash the planted file, so the forgery is not a forgery").toMatch(
      /^[0-9a-f]{40}$/,
    );
    appendFileSync(path, `${hash} evil.ts\n`);

    // Without the seal this is exit 0: the comparison is `after` minus the
    // baseline's lines, and the baseline now contains the line.
    const unsealed = runDrift(work, path, "");
    expect(
      unsealed.code,
      "the forgery does not actually hide the drift, so this case witnesses nothing",
    ).toBe(0);

    const sealed = runDrift(work, path, sha);
    expect(sealed.code, "a forged baseline was accepted").not.toBe(0);
    expect(sealed.stderr).toContain(`::error title=${AI_REVIEW_DRIFT_TITLE}`);
    expect(sealed.stderr, "the refusal does not say the baseline is the problem").toMatch(
      /baseline/i,
    );
    // Not the ordinary drift sentence. Asserted against the full sentence and
    // not the phrase "modified the tree", which is inside AI_REVIEW_DRIFT_TITLE
    // and so is in every refusal this step emits.
    expect(
      sealed.stderr,
      "a forgery is being reported as if the diff had simply come back non-empty",
    ).not.toContain(HONEST_DRIFT);
  });

  test("the PAIR: one thing varies — whether the baseline was edited", () => {
    const work = checkout();
    const { path, sha } = runBaseline(work);
    const clean = runDrift(work, path, sha);
    expect(clean.code, `a tree nobody touched was refused:\n${clean.stderr}`).toBe(0);

    appendFileSync(path, "?? nothing-happened.ts\n");
    const forged = runDrift(work, path, sha);
    expect(forged.code, "the seal does not see an edit that changed no verdict").not.toBe(0);
  });

  test("real drift is still caught, and is NOT reported as a forgery", () => {
    // The control the refusal needs: a seal that refused everything would
    // read exactly like a seal that caught a forgery.
    const work = checkout();
    const { path, sha } = runBaseline(work);
    writeFileSync(join(work, "evil.ts"), "export const owned = true;\n");
    const r = runDrift(work, path, sha);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("evil.ts");
    expect(r.stderr, "honest drift is being reported as baseline tampering").toContain(
      HONEST_DRIFT,
    );
  });
});

// ── AC-3 / AC-4: the unsealable run, and the unrecomputable one ──────────

describe("AC-3 (#843/2): a run that could not seal says so and still compares", () => {
  test("no checksum tool at baseline time: the step succeeds and annotates", () => {
    const work = checkout();
    const { run, path, sha } = runBaseline(work, { PATH: pathWithoutChecksumTools() });
    expect(run.code, `a missing coreutil failed the whole job:\n${run.stderr}`).toBe(0);
    expect(path, "the baseline stopped writing its path as well").not.toBe("");
    expect(sha, "a seal was reported on a runner that cannot compute one").toBe("");
    expect(run.stdout + run.stderr).toContain("UNMEASURED");
  });

  test("an empty seal warns, and the comparison still refuses real drift", () => {
    const work = checkout();
    const { path } = runBaseline(work);
    const cleanRun = runDrift(work, path, "");
    expect(cleanRun.code, "an unsealed clean tree was refused").toBe(0);
    expect(
      cleanRun.stdout + cleanRun.stderr,
      "an unsealed baseline passes in silence, which is the state this file is against",
    ).toContain("UNMEASURED");

    writeFileSync(join(work, "evil.ts"), "x\n");
    const drifted = runDrift(work, path, "");
    expect(drifted.code, "an unsealed run stopped checking drift at all").not.toBe(0);
    expect(drifted.stderr).toContain("evil.ts");
  });

  test("AC-4: a seal that cannot be RECOMPUTED refuses, unlike one never taken", () => {
    // Opposite direction from the case above, and deliberately so: the seal
    // exists, so the tool existed when the job started. A reading that could
    // be taken at the start and cannot be taken at the end is not a pass.
    const work = checkout();
    const { path, sha } = runBaseline(work);
    expect(sha).not.toBe("");
    const r = runDrift(work, path, sha, { PATH: pathWithoutChecksumTools() });
    expect(r.code, "a seal nobody could verify was treated as verified").not.toBe(0);
    expect(r.stderr).toContain(`::error title=${AI_REVIEW_DRIFT_TITLE}`);

    // The exit code alone is NOT the reading, and this is measured rather
    // than asserted: deleting the recompute refusal leaves `actual` empty,
    // which the mismatch branch one line below then refuses as a forgery.
    // Exit 1 either way, and the run reports a tampered baseline over a
    // runner that is merely missing a coreutil. The battery row for that
    // mutation was 0 until this assertion existed.
    expect(r.stderr, "the refusal does not say the seal could not be checked").toContain(
      CANNOT_RECOMPUTE,
    );
    expect(
      r.stderr,
      "a missing checksum tool is being reported as baseline tampering",
    ).not.toContain(FORGED);

    // And the pair, so the two refusals cannot collapse into one sentence
    // later: same tree, same baseline, one input varies — whether the
    // checksum can be recomputed or merely disagrees.
    appendFileSync(path, "?? nothing-happened.ts\n");
    const tampered = runDrift(work, path, sha);
    expect(tampered.code).not.toBe(0);
    expect(tampered.stderr).toContain(FORGED);
    expect(tampered.stderr).not.toContain(CANNOT_RECOMPUTE);
  });
});

// ── AC-5 / AC-6: the seal travels where the agent cannot reach it ────────

describe("AC-5 (#843/2): the seal is wired, and it is a step output", () => {
  test("AC-5: the committed workflow hands the drift step the baseline's sha", () => {
    const path = join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);
    const doc = Bun.YAML.parse(readFileSync(path, "utf-8")) as any;
    const steps = doc?.jobs?.["ai-review"]?.steps ?? [];
    expect(steps.length, "the committed ai-review job has no steps — this read is vacuous").toBeGreaterThan(3);
    const drift = steps.find((s: any) => s?.id === "ai-review-drift");
    expect(drift, "the committed workflow has no drift step").toBeDefined();
    expect(drift.env?.[AI_REVIEW_TREE_BEFORE_SHA_VAR]).toBe(
      `\${{ steps.${AI_REVIEW_BASELINE_STEP_ID}.outputs.sha256 }}`,
    );
  });

  test("AC-6: the seal goes to GITHUB_OUTPUT and never to a file beside the baseline", () => {
    // The cheapest wrong fix: `<baseline>.sha256`. It looks like a seal and
    // an agent that can rewrite the baseline can rewrite it too, in the same
    // loop. Asserted over the generated script rather than left as prose,
    // because the difference between the two is invisible in a diff.
    const script = buildBaselineScript();
    expect(script, "the seal is not written to the step's outputs").toMatch(
      /sha256=.*>>\s*"?\$\{GITHUB_OUTPUT\}"?/,
    );
    expect(script, "the seal is being written to a sidecar file the reviewer can also rewrite").not.toMatch(
      /\.sha256"?\s*$|>\s*"?\$\{?before\}?\.sha256/m,
    );

    // And behaviourally: after a real baseline run, no sidecar exists.
    const work = checkout();
    const { path } = runBaseline(work);
    expect(
      Bun.file(`${path}.sha256`).size,
      "a sidecar seal was written next to the baseline",
    ).toBe(0);
  });
});
