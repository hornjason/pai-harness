/**
 * ai-review-creds-relocate.test.ts — the cloud credential leaves the
 * directory the reviewer can read (#843 finding 3).
 *
 * ## The finding, read rather than inferred
 *
 * `google-github-actions/auth` at the pinned
 * `c200f3691d83b41bf9bbd8638997a462592937ed` writes its credentials file into
 * `$GITHUB_WORKSPACE`, and the reviewer's grant is
 * `--allowedTools Read,Grep,Glob,Write` with no path scope. The credential is
 * in the directory the agent is pointed at.
 *
 * Three facts from the action's own source, because the fix is wrong if any
 * of them is different:
 *
 * - **There is no path input.** The README says the file "is exported into
 *   `$GITHUB_WORKSPACE`"; the only path-shaped item in the interface is an
 *   OUTPUT. So "configure it elsewhere" is unavailable and the fix has to
 *   move the file after the fact.
 * - **It is exactly ONE file.** `createCredentialsFile` in
 *   `src/client/workload_identity_federation.ts` has a single
 *   `writeSecureFile`, and the document it writes uses `credential_source.url`
 *   — there is no `file` key and no sidecar holding the OIDC token. Moving one
 *   file is therefore a complete fix; had it been `credential_source.file`,
 *   this whole approach would have been a half-measure.
 * - **It is a live credential, not a pointer.** That `credential_source`
 *   carries an `Authorization: Bearer` header built from
 *   `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, so anything that reads the bytes can
 *   mint OIDC tokens for this job.
 *
 * ## Why the cleanup redirect is part of the fix and not a detail
 *
 * `src/post.ts` reads `process.env['GOOGLE_GHA_CREDS_PATH']` and force-removes
 * whatever it names; an unset variable is an explicit early return
 * ("Skipping credential cleanup"). So a move that does not rewrite that
 * variable **leaves the credential on disk when the job ends** — on a
 * self-hosted runner, into the next job, which is the exposure this issue
 * opens with. The move and the rewrite are one change.
 *
 * Three variables are exported together, and all three are rewritten:
 * `GOOGLE_GHA_CREDS_PATH` (the cleanup), `GOOGLE_APPLICATION_CREDENTIALS` and
 * `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` (the consumers). Rewriting one and
 * not the others points a downstream step at a path that no longer exists,
 * and the failure would land in the reviewer step rather than in the step
 * that caused it.
 *
 * ## The cheapest wrong fix, named
 *
 * **`rm` the credential instead of moving it.** One word, the exposure is
 * gone, and the reviewer can no longer authenticate — so the review does not
 * happen, which is #824's shape exactly: a job that exits green having
 * measured nothing. `AC-3` asserts the credential's CONTENT is readable at
 * the new path, so that repair is red rather than green.
 *
 * ## Everything that can be executed is executed
 *
 * The subject is a shell script, so every behavioural case runs it as bash
 * against a real directory. Asserting that the builder's output contains an
 * `mv` would assert that a template literal contains what it contains, and
 * would not notice a quoting mistake — which is the failure mode closest to
 * this one, given that every path here comes out of the environment.
 *
 * `EXPORTED_VARS` below is a hand-written copy of the module's
 * `AI_REVIEW_CREDS_EXPORTED_VARS`, deliberately. Importing it would compare
 * the mutant to itself: the M4 row would be 1 instead of 2, and dropping a
 * variable from the product would stop being visible in the pair case.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file + `test/ai-review-workflow.test.ts` +
 * `test/ai-review-wif.test.ts` (90 tests). Every count was predicted before
 * the battery ran, in `/tmp/843f3/predictions.md`, and the **baseline row was
 * read first**.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 0 fail | **90 pass, 0 fail** |
 * | M1 **the cheapest wrong fix**: `rm -f` the credential instead of `mv` | 3 | **3 of 90** |
 * | M2 the whole `GITHUB_ENV` export block removed | 6 | **6 of 90** |
 * | M3 only `GOOGLE_GHA_CREDS_PATH` dropped — the CLEANUP one | 6 | **6 of 90** |
 * | M4 only `GOOGLE_APPLICATION_CREDENTIALS` dropped — a CONSUMER one | 1 | **2 of 90** — see below |
 * | M5 the `[ ! -f src ]` refusal removed | 1 | **1 of 90** |
 * | M6 the leftover-credential `find` refusal removed | 1 | **1 of 90** |
 * | M7 the relocate step deleted from the committed workflow | 2 | **2 of 90** |
 * | M8 an `if:` added to the relocate step | 1 | **1 of 90** |
 * | M9 the pre-fix stub builder, symbols kept, step not emitted | 11 | **11 of 90** |
 *
 * **M1 is the row that matters.** `AC-1` — "the workspace no longer holds
 * it" — stays GREEN under `rm`, which is why `AC-1` alone is not the
 * protection. The three reds are `AC-3`, `AC-4`'s cleanup case and `AC-6`'s
 * control, all of which ask whether the credential is still usable.
 *
 * **M2 and M3 are not distinguishable by this suite**, recorded rather than
 * papered over: every case reads `exported.GOOGLE_GHA_CREDS_PATH` as the
 * destination, so dropping that one variable looks like dropping all three.
 * M4 is the row that separates a partial drop from a total one.
 *
 * **M4 came back high, and the extra red is the real kind.** The prediction
 * covered the all-three case; the second is the pair case, which compares the
 * exported names to this file's own list — squarely the mutated behaviour,
 * mutant not broken, 88 still pass. It also disproved a sentence in the
 * module's docblock, which has been corrected there.
 *
 * **M5 would be 0 if `AC-5` read the exit code.** Delete the existence check
 * and `mv` fails on a missing source, so the step still exits 1 — with the
 * wrong sentence. The #843 finding-2 battery one step below paid for that
 * lesson with a zero row; here the case asserts WHICH refusal fired from the
 * start, in both directions.
 *
 * **M9 is the real pre-fix row and it was run as a genuine TDD red**, before
 * a line of the implementation existed: 11 of 11 in this file. That first run
 * also caught a vacuous case — with nothing exported, `AC-4`'s loop compared
 * `undefined` to `undefined` and was the one green of eleven. It now
 * establishes presence before comparing.
 *
 * None of the nine mutations is left in the tree; all were restored from a
 * `cp` backup — never `git checkout --` — and `lib/scaffold/ai-review-step.ts`
 * and `.github/workflows/ai-review.yml` were confirmed byte-identical
 * afterwards by sha256.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import {
  AI_REVIEW_BASELINE_STEP_ID,
  AI_REVIEW_CREDS_DENY_OUTPUT,
  AI_REVIEW_CREDS_DIR_PREFIX,
  AI_REVIEW_CREDS_RELOCATE_STEP_ID,
  AI_REVIEW_CREDS_TITLE,
  AI_REVIEW_FINDINGS_DIR_SUFFIX,
  AI_REVIEW_JOB,
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_VERTEX_AUTH_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  aiReviewClaudeArgs,
  buildCredsRelocateScript,
  vertexCiConfig,
  type VertexCiDecision,
} from "../lib/scaffold/ai-review-step";
import { unknownAgainstRecord } from "../lib/claude-tool-vocabulary";

/** The two decisions `aiReviewClaudeArgs` branches on (#893 AC-3d/AC-3e). */
const VERTEX_FIXTURE: VertexCiDecision = vertexCiConfig({
  runner: "ubuntu-latest",
  bunVersion: "1.2.0",
  vertex: {
    project: "fixture-vertex-project",
    workloadIdentityProvider:
      "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider",
  },
});
const NO_VERTEX_FIXTURE: VertexCiDecision = vertexCiConfig({
  runner: "ubuntu-latest",
  bunVersion: "1.2.0",
});

/** What the action actually writes, shortened. The bearer token is the point. */
const CREDENTIAL = JSON.stringify({
  type: "external_account",
  audience: "//iam.googleapis.com/projects/939083080179/locations/global/workloadIdentityPools/github/providers/github-actions",
  credential_source: {
    url: "https://token.actions.githubusercontent.com/...",
    headers: { Authorization: "Bearer THE-OIDC-REQUEST-TOKEN" },
    format: { type: "json", subject_token_field_name: "value" },
  },
});

/**
 * The four refusals, which must never report each other's fact.
 *
 * Every one of them exits 1, so the exit code cannot tell them apart and a
 * case that reads only the code is measuring that bash ran.
 */
const MISSING = "names a file that is not there";
const MOVE_FAILED = "could not be moved out of the workspace";
const NO_TEMP = "RUNNER_TEMP is not set";

const EXPORTED_VARS = [
  "GOOGLE_GHA_CREDS_PATH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
] as const;

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The variables the step asked GitHub to export, parsed from GITHUB_ENV. */
  exported: Record<string, string>;
  /** The step outputs, parsed from GITHUB_OUTPUT (#893). */
  outputs: Record<string, string>;
  workspace: string;
  runnerTemp: string;
}

/**
 * Run the real relocate step.
 *
 * `creds` is the CONTENT to plant in the workspace, or `null` for a workspace
 * with no credential in it. `names` overrides what GOOGLE_GHA_CREDS_PATH says,
 * so a case can point the variable at a file that is not there.
 */
function run(
  opts: {
    creds?: string | null;
    names?: string | null;
    noRunnerTemp?: boolean;
    /** A second `gha-creds-*` file nobody named, planted in the workspace. */
    stray?: string;
    /** #893: the runner always sets GITHUB_OUTPUT; this drops it. */
    noOutput?: boolean;
    /** #893: point GITHUB_OUTPUT somewhere the append fails or is lost. */
    outputTo?: string;
    /** #893: pre-create the credential directory this run will derive. */
    leftover?: (path: string) => void;
    /** #893: replace a tool on PATH, to measure a reading that cannot fail. */
    shims?: Record<string, string>;
  } = {},
): Run {
  const workspace = scratchDir("ai-review-creds-ws-");
  const runnerTemp = scratchDir("ai-review-creds-temp-");
  const envFile = join(runnerTemp, "github-env");
  writeFileSync(envFile, "");
  const outputFile = join(runnerTemp, "github-output");
  writeFileSync(outputFile, "");
  if (opts.leftover) {
    opts.leftover(join(runnerTemp, `${AI_REVIEW_CREDS_DIR_PREFIX}-39525691857-1${AI_REVIEW_FINDINGS_DIR_SUFFIX}`));
  }

  const planted = join(workspace, "gha-creds-0123456789abcdef.json");
  if (opts.creds !== null && opts.creds !== undefined) writeFileSync(planted, opts.creds);
  if (opts.stray) writeFileSync(join(workspace, opts.stray), CREDENTIAL);

  const scriptDir = scratchDir("ai-review-creds-script-");
  const scriptPath = join(scriptDir, "step.sh");
  writeFileSync(scriptPath, buildCredsRelocateScript());

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GITHUB_WORKSPACE: workspace,
    GITHUB_ENV: envFile,
    GITHUB_RUN_ID: "39525691857",
    GITHUB_RUN_ATTEMPT: "1",
  };
  // The runner always sets this; the fixture did not, which is why #893's
  // output had nowhere to go the first time it was added.
  if (!opts.noOutput) env.GITHUB_OUTPUT = opts.outputTo ?? outputFile;
  if (opts.shims) {
    const bin = scratchDir("ai-review-creds-shim-");
    for (const [name, body] of Object.entries(opts.shims)) {
      const sp = join(bin, name);
      writeFileSync(sp, `#!/bin/sh\n${body}\n`);
      chmodSync(sp, 0o755);
    }
    env.PATH = `${bin}:${env.PATH}`;
  }
  if (!opts.noRunnerTemp) env.RUNNER_TEMP = runnerTemp;
  const named = opts.names === undefined ? planted : opts.names;
  if (named !== null) env.GOOGLE_GHA_CREDS_PATH = named;

  const r = Bun.spawnSync(["bash", "-e", scriptPath], { cwd: workspace, env });
  const exported: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line);
    if (m) exported[m[1]] = m[2];
  }
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, "utf-8").split("\n")) {
    const m = /^([a-zA-Z_][a-zA-Z_0-9]*)=(.*)$/.exec(line);
    if (m) outputs[m[1]] = m[2];
  }
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
    exported,
    outputs,
    workspace,
    runnerTemp,
  };
}

/** Every `gha-creds-*` entry still sitting in the workspace. */
function credsLeftInWorkspace(workspace: string): string[] {
  return readdirSync(workspace).filter(n => n.startsWith("gha-creds-"));
}

// ── AC-1 / AC-2: the file leaves the workspace, intact ───────────────────

describe("AC-1 (#843/3): the credential is moved out of the workspace", () => {
  test("the workspace no longer holds it", () => {
    const r = run({ creds: CREDENTIAL });
    expect(r.code, `the step refused:\n${r.stderr}`).toBe(0);
    expect(
      credsLeftInWorkspace(r.workspace),
      "the credential is still in the directory the reviewer reads",
    ).toEqual([]);
  });

  test("AC-2: the destination is outside the workspace, and is RUNNER_TEMP", () => {
    // Asserted as a path RELATIONSHIP, not by matching a basename. A
    // destination that merely looked like a temp path — `<workspace>/tmp/…` —
    // would satisfy a name check and change nothing about who can read it.
    const r = run({ creds: CREDENTIAL });
    const dest = r.exported.GOOGLE_GHA_CREDS_PATH;
    expect(dest, "the step exported no credential path at all").toBeTruthy();
    const fromWorkspace = relative(r.workspace, dest);
    expect(
      fromWorkspace.startsWith(".."),
      `the destination ${dest} is INSIDE the workspace ${r.workspace}`,
    ).toBe(true);
    expect(relative(r.runnerTemp, dest).startsWith("..")).toBe(false);
  });

  test("AC-3: the credential is READABLE at the new path, byte for byte", () => {
    // The cheapest wrong fix is `rm`: the exposure goes away and the reviewer
    // silently cannot authenticate, which is a job that exits green having
    // measured nothing. This case is what makes that repair red.
    const r = run({ creds: CREDENTIAL });
    const dest = r.exported.GOOGLE_GHA_CREDS_PATH;
    expect(existsSync(dest), "the credential was deleted rather than moved").toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe(CREDENTIAL);
  });
});

// ── AC-4: the cleanup and the consumers both follow the file ─────────────

describe("AC-4 (#843/3): every exported variable follows the credential", () => {
  test("all three name the new path, and none still names the old one", () => {
    const r = run({ creds: CREDENTIAL });
    const dest = r.exported.GOOGLE_GHA_CREDS_PATH;
    // Presence BEFORE comparison. Measured against a stub that exported
    // nothing, the loop below was green: every variable was `undefined` and
    // `dest` was `undefined` too, so three assertions held vacuously — the
    // third shape in `.claude/rules/checks-must-be-able-to-fail.md`, and the
    // only case of the eleven that survived the pre-fix row.
    expect(dest, "nothing was exported, so the agreement below means nothing").toBeTruthy();
    for (const name of EXPORTED_VARS) {
      expect(r.exported[name], `${name} was not rewritten`).toBe(dest);
    }
    const old = join(r.workspace, "gha-creds-0123456789abcdef.json");
    for (const [name, value] of Object.entries(r.exported)) {
      expect(value, `${name} still points into the workspace`).not.toBe(old);
    }
  });

  test("GOOGLE_GHA_CREDS_PATH specifically, because it is the CLEANUP", () => {
    // Called out as its own case rather than folded into the loop above.
    // `src/post.ts` early-returns on an unset variable, so dropping this one
    // leaves the credential on disk at the end of the job — a worse state
    // than the one being fixed, and the opposite of what the other two do.
    const r = run({ creds: CREDENTIAL });
    expect(
      Object.keys(r.exported),
      "the cleanup variable was dropped, so the post step will skip",
    ).toContain("GOOGLE_GHA_CREDS_PATH");
    expect(existsSync(r.exported.GOOGLE_GHA_CREDS_PATH)).toBe(true);
  });

  test("the PAIR: one thing varies — whether a credential was there", () => {
    const withCred = run({ creds: CREDENTIAL });
    const without = run({ creds: null, names: null });
    expect(withCred.code).toBe(0);
    expect(without.code, `a workspace with no credential was refused:\n${without.stderr}`).toBe(0);
    expect(Object.keys(withCred.exported).sort()).toEqual([...EXPORTED_VARS].sort());
    expect(
      Object.keys(without.exported),
      "a run that moved nothing still rewrote the environment",
    ).toEqual([]);
  });
});

// ── AC-5 / AC-6: the states that are not a clean move ────────────────────

describe("AC-5 (#843/3): a reading that could not be taken is not a pass", () => {
  test("the variable names a file that is not there: refuse", () => {
    // Not silence. The variable is set, so the auth step ran and created a
    // file; it not being there means something else moved or removed it, and
    // nobody can say where the credential is. `0`, `{}` and silence are all
    // indistinguishable from success.
    const r = run({ creds: null, names: "/nonexistent/gha-creds-deadbeef.json" });
    expect(r.code, "a credential nobody can find was treated as handled").not.toBe(0);
    expect(r.stderr).toContain(`::error title=${AI_REVIEW_CREDS_TITLE}`);
    // WHICH refusal, not merely that one happened. Delete the existence
    // check and `mv` fails anyway, so the exit code is 1 either way and a
    // case reading the code alone measures nothing. The same shape cost a
    // zero row in the #843 finding-2 battery one step below; applied here in
    // advance rather than re-discovered.
    expect(r.stderr, "the refusal does not say the file is missing").toContain(MISSING);
    expect(r.stderr, "a missing file is being reported as a failed move").not.toContain(
      MOVE_FAILED,
    );
  });

  test("RUNNER_TEMP unset: refuse rather than leave it in the workspace", () => {
    const r = run({ creds: CREDENTIAL, noRunnerTemp: true });
    expect(r.code, "with nowhere to move it, the step carried on anyway").not.toBe(0);
    expect(r.stderr).toContain(`::error title=${AI_REVIEW_CREDS_TITLE}`);
    expect(r.stderr).toContain(NO_TEMP);
    expect(r.stderr).not.toContain(MOVE_FAILED);
    // And it did not half-move it: the credential is still readable where the
    // auth step left it, which is a state an operator can recover from.
    expect(credsLeftInWorkspace(r.workspace)).toEqual(["gha-creds-0123456789abcdef.json"]);
  });

  test("AC-6: a credential nobody named, left in the workspace, is refused", () => {
    // What makes the move a READING rather than a belief. The action writes
    // one file today — measured, in this file's header — and the step is
    // correct only for as long as that stays true. A second one appearing
    // would otherwise be moved past in silence, which is the state this
    // whole issue is about.
    const r = run({ creds: CREDENTIAL, stray: "gha-creds-fedcba9876543210.json" });
    expect(r.code, "a credential left in the workspace was not noticed").not.toBe(0);
    expect(r.stderr).toContain(`::error title=${AI_REVIEW_CREDS_TITLE}`);
    expect(r.stderr, "the refusal does not name the file it found").toContain(
      "gha-creds-fedcba9876543210.json",
    );
    // The control, so this is not satisfied by a step that refuses whenever
    // it looks: the NAMED one still moved. Without this, deleting the move
    // entirely would leave the case green.
    expect(r.exported.GOOGLE_GHA_CREDS_PATH).toBeTruthy();
    expect(existsSync(r.exported.GOOGLE_GHA_CREDS_PATH)).toBe(true);
  });
});

// ── AC-7: the step is in the job, in the one position that works ─────────

describe("AC-7 (#843/3): the committed workflow runs it between auth and the agent", () => {
  const committed = () =>
    Bun.YAML.parse(
      readFileSync(join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
    ) as any;

  test("the step exists, and carries no `if:`", () => {
    const steps = committed()?.jobs?.["ai-review"]?.steps ?? [];
    expect(steps.length, "the committed job has no steps — this read is vacuous").toBeGreaterThan(3);
    const step = steps.find((s: any) => s?.id === AI_REVIEW_CREDS_RELOCATE_STEP_ID);
    expect(step, "the committed workflow never moves the credential").toBeDefined();
    // Nothing in this job may have an `if:` — a skipped step reports
    // `skipped`, and a skipped required check can be treated as satisfied.
    expect(step.if, "the relocate step can be skipped").toBeUndefined();
  });

  test("AFTER the auth step and BEFORE the agent reads anything", () => {
    // The ORDER is the property, not the presence. Run after the reviewer and
    // the credential has already been readable for the whole review; run
    // before the auth step and there is nothing to move.
    const ids = (committed()?.jobs?.["ai-review"]?.steps ?? []).map((s: any) => s?.id);
    const auth = ids.indexOf(AI_REVIEW_VERTEX_AUTH_STEP_ID);
    const relocate = ids.indexOf(AI_REVIEW_CREDS_RELOCATE_STEP_ID);
    const baseline = ids.indexOf(AI_REVIEW_BASELINE_STEP_ID);
    expect(auth, "no auth step — the position claim is vacuous").toBeGreaterThan(-1);
    expect(relocate).toBeGreaterThan(auth);
    expect(baseline, "no baseline step — the position claim is vacuous").toBeGreaterThan(-1);
    expect(relocate).toBeLessThan(baseline);
  });
});

/**
 * #893: the credential was moved into the directory the reviewer reads.
 *
 * #852 moved it out of the CHECKOUT, which was the finding at the time and
 * was right. The destination it chose was `RUNNER_TEMP`'s root — the job's
 * scratch, the directory both drift passes subtract, and, until #824, the
 * directory holding the findings payload the reviewer is told to write. The
 * step's own opening refusal already named the hazard in terms: *"Refusing
 * rather than running the reviewer with a live bearer token in the directory
 * it reads."* It then put the token there.
 *
 * ## What does NOT fix it, and why the issue's preferred option is not enough
 *
 * The issue prefers option 1 — two directories, one of them "a second one
 * for the credential that the agent is never told about". Measured against
 * the rest of the generated file, that alone buys almost nothing:
 *
 * - **Unix modes are not a barrier.** The reviewer runs as the same user as
 *   the job. 0600 stops another user, and the reviewer is not another user.
 * - **An unguessable name is not a barrier.** `AI_REVIEW_ALLOWED_TOOLS`
 *   grants `Glob` unscoped, so a `mktemp`-named directory is one call away
 *   from being listed. The old name was worse — derivable from `RUNNER_TEMP`
 *   and the run id, both in the agent's own environment — but the
 *   difference is between one call and none.
 * - **Deleting the credential before the review is not available.** The
 *   review step is what spends it.
 * - **#824 already separated the two directories.** The payload moved into
 *   its own per-run subdirectory, so the issue's headline — *"the findings
 *   payload and the cloud credential are in the same directory"* — is
 *   already false on this branch. Shipping option 1 and closing would have
 *   been a change whose entire effect had already happened.
 *
 * ## What does
 *
 * The agent's own permission system, in the one spelling that is consulted
 * for reads. Claude Code's documentation, quoted in full at
 * `AI_REVIEW_WORKSPACE_WRITE_DENY`: *"Claude Code checks file permissions
 * against `Edit(path)` and `Read(path)` rules only."* So the credential gets
 * a directory whose purpose is to be a region a `Read(...)` rule can name —
 * holding the credential and nothing else — and the rule is emitted into
 * `--disallowedTools` beside `Edit(./**)`.
 *
 * ## The direction an unresolved expression fails in, chosen deliberately
 *
 * The rule text is built in BASH and travels whole through a step output,
 * comma included. The alternative — assembling it in the generator around
 * `${{ steps.x.outputs.dir }}` — renders `Read(/**)` if the expression ever
 * resolves empty, which denies EVERY read: the reviewer would read nothing,
 * find nothing, and "found nothing" is the output of a clean review. A
 * fail-shut arriving as a green check. This form renders the empty string
 * instead, leaving the deny list as it is today. `AC-3d` is the case on it,
 * and the step refuses outright when `GITHUB_OUTPUT` is absent so the
 * fail-open has somewhere to be caught before the review runs.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A real review on a real runner.** The deny rules themselves ARE
 *   measured — see the table on `AI_REVIEW_CREDS_DIR_PREFIX`, taken the way
 *   #836 took its, against the real CLI at the recorded version. What that
 *   measurement used was a hand-built checkout and sibling directory, not
 *   an `ai-review` job. The cases in THIS file assert the rule text the
 *   step emits; they do not re-run the CLI, and re-running it per test
 *   would put a network call and a model in a unit suite.
 *
 *   The measurement is also version-bound. It was taken at `2.1.306`,
 *   which is the version `lib/claude-tool-vocabulary.ts` records and NOT
 *   the version CI runs (`2.1.303`). `ai-review-deny-vocabulary.test.ts`
 *   reports that gap as UNMEASURED on every run and this does not close
 *   it.
 *
 * - **Every future content-returning tool.** A denylist over a live
 *   credential file is a standing commitment to enumerate them. Three are
 *   granted today and all three are denied; a fourth added to
 *   `AI_REVIEW_ALLOWED_TOOLS` tomorrow is an open door and nothing here
 *   notices. The durable fix is to not have the file — a short-lived
 *   access token in the review step's `env:`, deleted before the agent
 *   starts — which changes the auth flow and depends on whether the pinned
 *   action accepts a bare Vertex access token. Unmeasured, filed
 *   separately, and this is the containment rather than the cure.
 * - **Detection.** Both drift passes subtract `RUNNER_TEMP`, so a reviewer
 *   that read the credential and copied it anywhere under `RUNNER_TEMP` is
 *   outside every detector in the generated file. That is the issue's
 *   second half and it is NOT fixed here: it would mean editing the
 *   subtraction lists, which #904 owns.
 * - **A leftover owned by another local user.** The refusal is "ANY
 *   pre-existing path", which does not consult the owner, so ownership is
 *   not a thing this can be wrong about. What remains uncovered is a race
 *   between the `-e` test and the `mkdir` on a `RUNNER_TEMP` another user
 *   can write; `mkdir` without `-p` turns that into a refusal rather than
 *   an adoption, which is the best this shape does without a lock.
 * - **Non-Vertex credentials.** `CLAUDE_CODE_OAUTH_TOKEN` and
 *   `ANTHROPIC_API_KEY` reach the action through `with:` and never touch
 *   the disk, so there is no file for a rule to name. The deny rule is
 *   emitted only when `ci.vertex` resolved, which `AC-3e` asserts.
 */
describe("#893: the cloud credential gets its own directory, and a rule the reviewer is denied by", () => {
  const CRED_DIR = (r: Run) =>
    join(r.runnerTemp, `${AI_REVIEW_CREDS_DIR_PREFIX}-39525691857-1${AI_REVIEW_FINDINGS_DIR_SUFFIX}`);

  test("AC-3a: the credential lands in a 0700 directory of its own, not in the temp root", () => {
    const r = run({ creds: CREDENTIAL });
    expect(r.code, `the relocate step refused a healthy runner:\n${r.stderr}`).toBe(0);

    const dir = CRED_DIR(r);
    // Reds on the tree this was written against, which moved the credential
    // to `${RUNNER_TEMP}/ai-review-gcp-creds-<nonce>.json` — the temp root.
    expect(existsSync(dir), "no credential directory was created").toBe(true);
    expect(statSync(dir).mode & 0o777, "the credential directory is not 0700").toBe(0o700);

    const dest = r.exported.GOOGLE_APPLICATION_CREDENTIALS ?? "";
    expect(dest, "the exported credential path is not inside the new directory").toStartWith(dir + "/");
    expect(readFileSync(dest, "utf-8"), "the credential did not arrive").toBe(CREDENTIAL);
    expect(statSync(dest).mode & 0o777, "the credential file is not 0600").toBe(0o600);

    // And the directory holds the credential and NOTHING else, which is the
    // whole reason a directory exists rather than a filename: the rule
    // denies a region, so anything else in it is denied with it. Reds on a
    // fix that points the deny at `RUNNER_TEMP`, which would take the
    // findings payload and the drift baseline with it.
    expect(readdirSync(dir), "the credential directory holds more than the credential").toEqual([
      dest.slice(dir.length + 1),
    ]);
  });

  test("AC-3b: the step emits a Read deny naming exactly that directory", () => {
    const r = run({ creds: CREDENTIAL });
    const rule = r.outputs[AI_REVIEW_CREDS_DENY_OUTPUT] ?? "";

    // Reds on the tree this was written against: no such output existed.
    expect(rule, `the step emitted no ${AI_REVIEW_CREDS_DENY_OUTPUT} output`).not.toBe("");
    expect(rule, "the leading comma is missing, so the rule would fuse to the one before it").toStartWith(
      ",",
    );
    // The MEASURED contract, every character of it. See the table on
    // `AI_REVIEW_CREDS_DIR_PREFIX`: taken against the real CLI at the
    // version `lib/claude-tool-vocabulary.ts` records.
    //
    // Reds in three separate ways, each a spelling that was shipped or
    // nearly shipped here:
    //   - one leading slash, which the CLI accepts IN SILENCE and never
    //     fires. That is what the first version of this fix emitted.
    //   - `Read` alone, which leaves `Grep` — and `Grep` returns MATCHING
    //     LINES, so it returns the credential itself, not a hint of it.
    //
    // `Glob` is measured to bind and is deliberately absent: it returns
    // paths, and this path is RUNNER_TEMP plus the run id plus the
    // attempt, all already in the agent's environment. Asserted as absent
    // rather than left unsaid, so a later author adding it has to read
    // why it was left out.
    const dir = CRED_DIR(r);
    expect(rule, "the deny does not match the spelling that was measured to fire").toBe(
      `,Read(/${dir}/**),Grep(/${dir}/**)`,
    );
    expect(
      rule,
      "Glob is denied: it protects a path the agent can compute, and costs an exception " +
        "in ai-review-write-scope's inert-path-rule scan",
    ).not.toContain("Glob(");
    // Stated separately from the equality above, so the reason survives a
    // future edit to the expected string: the absolute form needs TWO
    // leading slashes and one is inert.
    for (const tool of ["Read", "Grep"]) {
      expect(rule, `${tool} is not denied, so it is an open door to the credential`).toContain(
        `${tool}(//`,
      );
    }
    // No whitespace: `claude_args` is emitted unquoted and split by the
    // action, so a rule containing a space arrives in pieces.
    expect(rule, "the rule carries whitespace and would split").not.toMatch(/\s/);

    // `ai-review-deny-vocabulary.test.ts` asserts every emitted deny rule
    // names a tool the CLI knows, over the STATIC list. This rule is built
    // at run time and is structurally invisible to that suite, so the same
    // decider is CALLED here rather than restated — a rule the CLI cannot
    // resolve warns at startup and denies nothing, which is a barrier that
    // reads as present and is worth nothing. Reds on `,Nope(<dir>/**)`.
    expect(
      unknownAgainstRecord([rule.slice(1)]),
      "the credential deny names a tool the recorded CLI vocabulary does not know",
    ).toEqual([]);
  });

  test("AC-3c: a credential directory the runner could not provide REFUSES", () => {
    // Each of these ends with a live bearer token in a directory no rule
    // covers. The chmod cases replace the TOOL, because a filesystem that
    // ignores modes has no other input a unit test can supply — the same
    // instrument `ai-review-write-scope.test.ts` uses, and `AC-3f` below is
    // the control that shimming does not itself cause a refusal.
    const cases: Array<[string, Parameters<typeof run>[0], string]> = [
      [
        "a leftover that is not a directory",
        { creds: CREDENTIAL, leftover: p => writeFileSync(p, "someone else's\n") },
        "already exists",
      ],
      ["chmod failing", { creds: CREDENTIAL, shims: { chmod: "exit 1" } }, "mode 0700"],
      [
        "chmod reporting success without the mode taking",
        { creds: CREDENTIAL, shims: { chmod: "exit 0", stat: "echo 755" } },
        "Mode read back",
      ],
      [
        "a mode that cannot be read back at all",
        { creds: CREDENTIAL, shims: { chmod: "exit 0", stat: "exit 1" } },
        "UNMEASURED",
      ],
      ["GITHUB_OUTPUT absent", { creds: CREDENTIAL, noOutput: true }, "GITHUB_OUTPUT is not set"],
      [
        // The transport for the control is a thing that can fail. An
        // unchecked `>>` leaves the review running with no rule published
        // and the step reporting success — the control's own fail-open,
        // one layer below the control. Input: a GITHUB_OUTPUT pointing at
        // a path that cannot be appended to.
        "the deny rule could not be written to GITHUB_OUTPUT",
        { creds: CREDENTIAL, outputTo: "/nonexistent-dir-rg893/github-output" },
        "could not be written",
      ],
      [
        // And a write that returns 0 and lands nowhere. `/dev/null`
        // accepts every append and holds none of them, which is exactly
        // what the read-back exists to tell apart from a successful write.
        "the deny rule did not land when read back",
        { creds: CREDENTIAL, outputTo: "/dev/null" },
        "not there when read back",
      ],
      [
        // `-e`, `-d` and `-O` all dereference, so a link an earlier job on
        // this runner left behind would decide where a live bearer token
        // gets written. Reds on a `-L` test placed after any of them.
        "a symlink at the credential directory path",
        { creds: CREDENTIAL, leftover: p => symlinkSync(mkdtempSync(join(tmpdir(), "rg-893-t-")), p) },
        "SYMLINK",
      ],
    ];
    expect(cases.length, "the table is empty, so this case measured nothing").toBe(8);

    for (const [label, opts, says] of cases) {
      const r = run(opts);
      expect(r.code, `${label} was accepted:\n${r.stdout}${r.stderr}`).toBe(AI_REVIEW_REQUIRED_EXIT);
      expect(r.stderr, `${label} refused without an annotation`).toContain(
        `::error title=${AI_REVIEW_CREDS_TITLE}`,
      );
      expect(r.stderr, `${label} refused for a reason it did not name`).toContain(says);
      // The half that makes it a refusal: no deny rule is published from a
      // step that failed, so nothing downstream reads a stale one.
      expect(r.outputs[AI_REVIEW_CREDS_DENY_OUTPUT] ?? "", `${label} still published a deny rule`).toBe(
        "",
      );
    }
  });

  test("AC-3c2: the leftover is refused, not deleted", () => {
    // On a machine running sixteen self-hosted runners, `rm -rf` on an
    // interpolated path is a new risk class in a file that has none: an
    // empty or relocated `${dir}` removes something nobody intended and
    // there is no reading afterwards that would show it. Reds on that
    // repair, which is the obvious one.
    const r = run({ creds: CREDENTIAL, leftover: p => writeFileSync(p, "someone else's\n") });
    expect(r.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      readFileSync(CRED_DIR(r), "utf-8"),
      "the step DELETED a path it did not create, on a shared runner",
    ).toBe("someone else's\n");
  });

  test("AC-3d: an unresolved expression renders empty, never Read(/**)", () => {
    // The direction this fails in, asserted on the shape rather than
    // described in a comment. `--disallowedTools …,Read(${{ … }}/**)` with
    // an unresolved expression is `Read(/**)` — every read denied, the
    // reviewer finds nothing, and "found nothing" is a clean review. Reds
    // on moving the glob or the comma out of the step output and into the
    // generator.
    const args = aiReviewClaudeArgs(VERTEX_FIXTURE);
    const expr = `\${{ steps.${AI_REVIEW_CREDS_RELOCATE_STEP_ID}.outputs.${AI_REVIEW_CREDS_DENY_OUTPUT} }}`;
    expect(args, "the credential deny is not wired into the args").toContain(expr);
    // Nothing of the rule may live outside the expression.
    expect(args.slice(args.indexOf(expr) + expr.length), "text trails the expression").toBe("");
    expect(args, "the glob is assembled in the generator, so an empty output denies everything").not.toContain(
      `${expr}/**`,
    );
    expect(args, "a comma precedes the expression, so an empty output leaves a trailing comma").not.toContain(
      `,${expr}`,
    );

    // Non-vacuity: the catastrophic form is one this scan can see.
    const bad = `--disallowedTools A,Read(${expr}/**)`;
    expect(bad).toContain(`${expr}/**`);
  });

  test("AC-3e: the deny is emitted only where a credential file exists, and resolves", () => {
    // No Vertex means no auth step, no relocate step, and no step for the
    // expression to read — emitting it anyway would be a rule written down
    // that cannot hold. Reds on wiring it unconditionally.
    expect(
      aiReviewClaudeArgs(NO_VERTEX_FIXTURE),
      "a deny naming a step this job does not have",
    ).not.toContain(AI_REVIEW_CREDS_RELOCATE_STEP_ID);

    // And where it IS emitted, the step it names exists and runs first —
    // the same escape `AC-1e` covers for `--add-dir`, and the only one that
    // turns this into the fail-open above rather than a working rule.
    const doc = Bun.YAML.parse(
      readFileSync(join(import.meta.dir, "..", ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8"),
    ) as any;
    const steps = doc.jobs[AI_REVIEW_JOB].steps as any[];
    const ids = steps.map(s => s?.id);
    const relocateAt = ids.indexOf(AI_REVIEW_CREDS_RELOCATE_STEP_ID);
    const reviewAt = ids.indexOf(AI_REVIEW_ACTION_STEP_ID);
    expect(relocateAt, `no step has id ${AI_REVIEW_CREDS_RELOCATE_STEP_ID}`).toBeGreaterThan(-1);
    expect(relocateAt, "the credential is relocated AFTER the reviewer runs").toBeLessThan(reviewAt);

    const named =
      /--disallowedTools\s+\S*?\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/.exec(
        String(steps[reviewAt]?.with?.claude_args ?? ""),
      );
    expect(named, "the committed workflow carries no credential deny expression").not.toBeNull();
    expect(named![1]).toBe(AI_REVIEW_CREDS_RELOCATE_STEP_ID);
    expect(named![2]).toBe(AI_REVIEW_CREDS_DENY_OUTPUT);
    expect(
      buildCredsRelocateScript(),
      `the step never writes a \`${named![2]}=\` line to GITHUB_OUTPUT`,
    ).toContain(`${named![2]}=`);
  });

  test("AC-3f instrument control: passthrough shims do not themselves refuse", () => {
    // Without this, every shimmed row in AC-3c is satisfied by a script
    // that refuses whenever PATH has an extra entry.
    const r = run({
      creds: CREDENTIAL,
      shims: { chmod: 'exec /bin/chmod "$@"', stat: 'exec /usr/bin/stat "$@" 2>/dev/null || exec /bin/stat "$@"' },
    });
    expect(r.code, `passthrough shims refused a healthy runner:\n${r.stderr}`).toBe(0);
    expect(r.outputs[AI_REVIEW_CREDS_DENY_OUTPUT] ?? "", "the passthrough run published no rule").not.toBe(
      "",
    );
  });
});
