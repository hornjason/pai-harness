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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import {
  AI_REVIEW_BASELINE_STEP_ID,
  AI_REVIEW_CREDS_RELOCATE_STEP_ID,
  AI_REVIEW_CREDS_TITLE,
  AI_REVIEW_VERTEX_AUTH_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  buildCredsRelocateScript,
} from "../lib/scaffold/ai-review-step";

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
  } = {},
): Run {
  const workspace = scratchDir("ai-review-creds-ws-");
  const runnerTemp = scratchDir("ai-review-creds-temp-");
  const envFile = join(runnerTemp, "github-env");
  writeFileSync(envFile, "");

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
  if (!opts.noRunnerTemp) env.RUNNER_TEMP = runnerTemp;
  const named = opts.names === undefined ? planted : opts.names;
  if (named !== null) env.GOOGLE_GHA_CREDS_PATH = named;

  const r = Bun.spawnSync(["bash", scriptPath], { cwd: workspace, env });
  const exported: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line);
    if (m) exported[m[1]] = m[2];
  }
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
    exported,
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
