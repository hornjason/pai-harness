/**
 * The generated AI review authenticates with Workload Identity Federation and
 * NO service-account key (#631, #677 AC-15).
 *
 * ## What these cases read, and why it is not this repository's own files
 *
 * Every case here generates a workflow into a temp directory and reads THAT.
 * None of them opens `.github/workflows/ai-review.yml` or
 * `.github/workflows/claude-review.yml` in this checkout.
 *
 * That is the whole design of the file, and it is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape applied before
 * the repair rather than after it. **The cheapest wrong fix is to put the WIF
 * provider in `claude-review.yml` and stop.** It is the 5pm repair: the one
 * file anybody looks at stops naming a service-account key, the symptom is
 * gone, and `lib/scaffold/ai-review-step.ts` still emits
 * `credentials_json: ${{ … secrets.GCP_SA_KEY … }}` into every consumer's
 * tree. A case pointed at this repo's checked-in YAML goes green under it.
 * A case pointed at the generator's output does not, because the generator is
 * the thing that did not change.
 *
 * ## Three fixtures, because the interesting states are three
 *
 * - `CONFIGURED` — a consumer declaring a complete `ci.vertex` block.
 * - `UNCONFIGURED` — a consumer declaring none. It must get a workflow that
 *   SAYS so and reports UNMEASURED, not one that silently resolves some other
 *   mode and not one that emits an auth step with nothing configured.
 * - `HALF` — a consumer declaring half a block. A half-declared credential is
 *   a refusal with a reason, never a default
 *   (`.claude/rules/config-access.md`: *Silent Default Substitution*).
 *
 * The fixture values are deliberately NOT this repository's. `SC-A1` refuses a
 * consumer's name in the harness and it is right to: `jhorn-pai` and its
 * provider path belong in `.claude/rungate/config.json` and nowhere under
 * `lib/`, `gates/` or `scripts/`. One case below measures exactly that, and it
 * would be defeated by a fixture that reused the real values — so the fixture
 * uses a project nobody owns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { aiReviewAuthScript, aiReviewUnmeasuredViolations } from "../lib/conformity";
import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_AUTH_STEP_ID,
  AI_REVIEW_JOB,
  AI_REVIEW_VERTEX_AUTH_STEP_ID,
  AI_REVIEW_WORKFLOW_FILE,
  modelAliasViolations,
} from "../lib/scaffold/ai-review-step";
import {
  GOOGLE_AUTH_ACTION,
  GOOGLE_AUTH_ACTION_SHA,
  GOOGLE_AUTH_ACTION_VERSION,
} from "../lib/google-auth-action";

/**
 * A project id and a provider path that belong to nobody.
 *
 * Not `jhorn-pai`. The "no consumer name in the harness" case below greps
 * `lib/`, `gates/` and `scripts/` for the real values, and a fixture carrying
 * them would make that case unable to distinguish a clean tree from a tree
 * with the real project hardcoded in the generator.
 */
const FIXTURE_PROJECT = "fixture-vertex-project";
const FIXTURE_PROVIDER =
  "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider";
const FIXTURE_REGION = "us-fixture1";
const FIXTURE_MODEL = "claude-sonnet-5";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function generateInto(ci: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-wif-"));
  scratch.push(dir);
  mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "wif-fixture", ci }, null, 2) + "\n",
  );
  createCiWorkflows(dir, []);
  return dir;
}

const BASE_CI = { runner: "ubuntu-latest", bunVersion: "1.2.0", branches: ["main"] };

let CONFIGURED = "";
let UNCONFIGURED = "";
let HALF = "";

const workflowOf = (root: string) =>
  readFileSync(join(root, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE), "utf-8");

beforeAll(() => {
  CONFIGURED = generateInto({
    ...BASE_CI,
    vertex: {
      project: FIXTURE_PROJECT,
      workloadIdentityProvider: FIXTURE_PROVIDER,
      region: FIXTURE_REGION,
      model: FIXTURE_MODEL,
    },
  });
  UNCONFIGURED = generateInto({ ...BASE_CI });
  HALF = generateInto({ ...BASE_CI, vertex: { project: FIXTURE_PROJECT } });
});

/** The steps of the one job, parsed rather than grepped. */
function stepsOf(text: string): any[] {
  const doc = Bun.YAML.parse(text) as any;
  const steps = doc?.jobs?.[AI_REVIEW_JOB]?.steps;
  expect(Array.isArray(steps), "the generated workflow has no steps to read").toBe(true);
  expect(steps.length, "the generated job is empty, so every case below is vacuous").toBeGreaterThan(0);
  return steps;
}

function authStepOf(text: string): any | undefined {
  return stepsOf(text).find(s => typeof s?.uses === "string" && s.uses.startsWith(`${GOOGLE_AUTH_ACTION}@`));
}

// ── The headline claim ──────────────────────────────────────────────────────

describe("the generated workflow authenticates with no service-account key", () => {
  /**
   * The one assertion the whole issue is about. `credentials_json` is the
   * input that makes `google-github-actions/auth` write a PERMANENT key into
   * the runner workspace, and the review agent reads files in that workspace.
   */
  test("no generated workflow names credentials_json at all", () => {
    for (const [label, root] of [
      ["configured", CONFIGURED],
      ["unconfigured", UNCONFIGURED],
      ["half-configured", HALF],
    ] as const) {
      const dir = join(root, ".github", "workflows");
      for (const file of readdirSync(dir)) {
        expect(
          readFileSync(join(dir, file), "utf-8"),
          `${label}/${file} emits credentials_json — that is a long-lived key in the tree the reviewer reads (#677)`,
        ).not.toContain("credentials_json");
      }
    }
  });

  /**
   * Narrower than the case above and not redundant with it: `credentials_json`
   * could be renamed, and the secret could reach the action by some other
   * input. What must never happen is the VALUE of `GCP_SA_KEY` arriving on the
   * runner at all.
   *
   * `secrets.GCP_SA_KEY != ''` is allowed and is the migration read: it
   * resolves to the literal `true` or `false` before the runner sees it, so
   * the key is never materialised. Any other interpolation of that secret is a
   * refusal.
   */
  test("the only reading of GCP_SA_KEY is a presence test, never its value", () => {
    for (const root of [CONFIGURED, UNCONFIGURED, HALF]) {
      const text = workflowOf(root);
      const readings = [...text.matchAll(/\$\{\{[^}]*GCP_SA_KEY[^}]*\}\}/g)].map(m => m[0]);
      for (const reading of readings) {
        expect(
          reading.replace(/\s+/g, " "),
          "a reading of GCP_SA_KEY that is not `!= ''` puts the key itself on the runner",
        ).toBe("${{ secrets.GCP_SA_KEY != '' }}");
      }
    }
  });

  test("GCP_SA_KEY is not a credential the auth precedence can resolve a mode from", () => {
    expect(
      AI_REVIEW_AUTH_PRECEDENCE.map(c => c.secret),
      "a secret in the precedence list is a secret the step authenticates with",
    ).not.toContain("GCP_SA_KEY");
  });
});

// ── The auth step itself ────────────────────────────────────────────────────

describe("the configured consumer gets a Workload Identity Federation auth step", () => {
  test("the auth step pins the declared action and carries the two WIF inputs", () => {
    const text = workflowOf(CONFIGURED);
    const step = authStepOf(text);
    expect(step, `no step uses ${GOOGLE_AUTH_ACTION}`).toBeDefined();
    // A YAML parse drops the trailing `# vN`, so the pin is read from the
    // parsed value and the comment from the raw text. Both come from
    // `lib/google-auth-action.ts`, which is the point: `actionPinParity`
    // compares every position to that declaration and never to another
    // position, so two files agreeing with each other is not agreement.
    expect(step.uses).toBe(`${GOOGLE_AUTH_ACTION}@${GOOGLE_AUTH_ACTION_SHA}`);
    expect(step.uses, "a tag is a pin the publisher can repoint").not.toMatch(/@v\d/);
    expect(text).toContain(
      `uses: ${GOOGLE_AUTH_ACTION}@${GOOGLE_AUTH_ACTION_SHA} # ${GOOGLE_AUTH_ACTION_VERSION}`,
    );
    expect(step.with?.project_id).toBe(FIXTURE_PROJECT);
    expect(step.with?.workload_identity_provider).toBe(FIXTURE_PROVIDER);
  });

  /**
   * There is no service account in this chain at all: the federated identity
   * holds the Vertex role directly. An `service_account:` input would
   * reintroduce an identity that CAN have a key created for it.
   */
  test("the auth step impersonates no service account", () => {
    const step = authStepOf(workflowOf(CONFIGURED));
    expect(Object.keys(step.with ?? {}).sort()).toEqual(["project_id", "workload_identity_provider"]);
  });

  /** OIDC minting is impossible without it, and it is not implied. */
  test("the configured job requests an OIDC token and the unconfigured one does not", () => {
    const configured = Bun.YAML.parse(workflowOf(CONFIGURED)) as any;
    expect(configured.permissions?.["id-token"], "no id-token: write, so OIDC cannot be minted").toBe("write");

    const unconfigured = Bun.YAML.parse(workflowOf(UNCONFIGURED)) as any;
    expect(
      unconfigured.permissions?.["id-token"],
      "a consumer with no federation configured is handed an OIDC permission nothing uses",
    ).toBeUndefined();
  });

  /**
   * The provider and the project are consumer-specific values that arrive from
   * config. They must reach the workflow as GENERATED LITERALS in `with:` and
   * the script through `env:` — never through a `${{ }}` inside a `run:` body,
   * which is interpolated into the script text before bash sees it.
   */
  test("no run: body in the generated job interpolates an expression", () => {
    for (const root of [CONFIGURED, UNCONFIGURED, HALF]) {
      for (const step of stepsOf(workflowOf(root))) {
        if (typeof step?.run !== "string") continue;
        expect(
          step.run,
          `step \`${step.name}\` interpolates \${{ }} inside run: — that is a value substituted before bash sees it`,
        ).not.toContain("${{");
      }
    }
  });

  test("the model the reviewer runs is an exact identifier, never a family alias", () => {
    for (const root of [CONFIGURED, UNCONFIGURED, HALF]) {
      expect(modelAliasViolations(workflowOf(root))).toEqual([]);
    }
  });
});

// ── The consumer who configured nothing ─────────────────────────────────────

describe("a consumer that declares no ci.vertex is told so, and measures nothing", () => {
  test("no auth step is emitted with nothing to authenticate with", () => {
    expect(
      authStepOf(workflowOf(UNCONFIGURED)),
      `an auth step for ${GOOGLE_AUTH_ACTION} with no provider configured is a step that can only fail`,
    ).toBeUndefined();
  });

  /**
   * `0`, `{}`, `null` and silence are indistinguishable from success. The
   * workflow has to NAME the state, and name the key a consumer would set.
   */
  test("the generated workflow names ci.vertex as the thing that is not configured", () => {
    const text = workflowOf(UNCONFIGURED);
    expect(text, "the generated file says nothing about the federation it does not have").toContain("ci.vertex");
  });

  test("the unconfigured consumer resolves mode none, which is UNMEASURED", async () => {
    const out = await runAuthScript(UNCONFIGURED, {});
    expect(out.mode).toBe("none");
    expect(out.stdout + out.stderr).toContain("UNMEASURED");
  });

  /**
   * The half-declared block. A provider with no project cannot authenticate,
   * so the block is refused as a whole and the refusal NAMES the missing
   * field. Defaulting half of a credential is how a consumer ends up with a
   * job that fails on the runner for a reason nothing in their tree explains.
   */
  test("a half-declared ci.vertex is refused by name, not completed by default", () => {
    const text = workflowOf(HALF);
    expect(authStepOf(text), "half a federation block produced a whole auth step").toBeUndefined();
    expect(text, "the refusal does not name the field that was missing").toContain("workloadIdentityProvider");
  });
});

// ── The migration, which must never authenticate ────────────────────────────

describe("a consumer sitting on GCP_SA_KEY is told to migrate, not silently downgraded", () => {
  test("the secret present and no WIF configured annotates the migration", async () => {
    const out = await runAuthScript(UNCONFIGURED, { GCP_SA_KEY_PRESENT: "true" });
    const all = out.stdout + out.stderr;
    expect(all, "a consumer whose review just stopped running is told nothing").toContain("GCP_SA_KEY");
    expect(all).toContain("ci.vertex");
    expect(out.mode, "the key resolved a credentialed mode, so it was used after all").toBe("none");
  });

  test("the same run with no key present says nothing about a migration", async () => {
    const out = await runAuthScript(UNCONFIGURED, {});
    expect(
      out.stdout + out.stderr,
      "the migration notice fires for every consumer, so it is not about the key",
    ).not.toContain("GCP_SA_KEY");
  });
});

// ── The harness names no consumer ───────────────────────────────────────────

describe("the harness carries no consumer's project or provider", () => {
  /**
   * SC-A1's property, asserted against the two values this change introduces.
   * They live in `.claude/rungate/config.json` — this repository's own
   * consumer config — and must appear nowhere in the shipped code.
   */
  test("neither jhorn-pai nor its provider path appears in lib/, gates/ or scripts/", async () => {
    const { spawnSync } = await import("child_process");
    for (const needle of ["jhorn-pai", "workloadIdentityPools/github/providers"]) {
      const r = spawnSync("git", ["grep", "-l", "-F", needle, "--", "lib", "gates", "scripts"], {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf-8",
      });
      expect(r.status, `git grep failed, so this reading was never taken: ${r.stderr}`).toBeLessThan(2);
      expect(
        r.stdout.trim().split("\n").filter(Boolean),
        `\`${needle}\` is this repository's own value and belongs in .claude/rungate/config.json (SC-A1)`,
      ).toEqual([]);
    }
  });
});

// ── AIREVIEW-1 on a federated consumer ──────────────────────────────────────

describe("AIREVIEW-1 keeps measuring a consumer whose credential is generated", () => {
  /**
   * `aiReviewUnmeasuredViolations` ran the generated script with an EMPTY
   * environment and demanded exactly one UNMEASURED annotation. Every fixture
   * it has ever had takes its credential from a secret, so unsetting the
   * secrets really did produce the credential-free state — and #631 puts a
   * credential in the file itself. `mode=vertex` is decided when the workflow
   * is WRITTEN, no environment can move it, and the check's whole premise
   * became unreachable on the one tree that ships it.
   *
   * That is `.claude/rules/checks-must-be-able-to-fail.md`'s precondition trap
   * (#492): every fixture meets a condition, so the branch on the other side
   * of it is outside the battery's reach rather than merely under-tested.
   *
   * **The cheapest wrong fix, named: let the check accept any resolved mode
   * and return early.** It is one `if`, the red conformity run goes green, and
   * a workflow saying `mode=vertex` with no auth step, no `id-token: write`
   * and nothing to federate WITH is then a passing AIREVIEW-1 for a review
   * that cannot authenticate — which is the exact defect AIREVIEW-1 exists to
   * refuse, wearing the new mode's clothes. The last three cases here are red
   * under that repair.
   */
  test("the configured consumer's own generated workflow satisfies the check", () => {
    const reading = aiReviewAuthScript(CONFIGURED);
    expect(reading.failure, `${reading.failure}`).toBeNull();
    expect(reading.unmeasured, `${reading.unmeasured}`).toBeNull();
    // The evidence is read off the same parse as the script, so a check that
    // ran the script could not be handed a federation reading from elsewhere.
    expect(reading.federation.authStep, "the parse found no vertex auth step").not.toBeNull();
    expect(reading.federation.idTokenWrite).toBe(true);

    const violations = aiReviewUnmeasuredViolations(reading.script!, reading.federation);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("the unconfigured consumer still reaches the UNMEASURED claim", () => {
    // The other side of the branch, varying only `ci.vertex` (#585). Without
    // this half, moving the check could satisfy the federated tree by
    // dropping the credential-free claim entirely.
    const reading = aiReviewAuthScript(UNCONFIGURED);
    expect(reading.federation.authStep, "an unconfigured consumer emitted an auth step").toBeNull();
    expect(reading.federation.idTokenWrite, "an unconfigured consumer was granted id-token: write").toBe(false);
    const violations = aiReviewUnmeasuredViolations(reading.script!, reading.federation);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("a resolved mode with no step that could mint it is REFUSED", () => {
    const reading = aiReviewAuthScript(CONFIGURED);
    const violations = aiReviewUnmeasuredViolations(reading.script!, {
      idTokenWrite: true,
      authStep: null,
    });
    expect(violations.length, "mode=vertex with no auth step was accepted").toBeGreaterThan(0);
    expect(violations.join("\n")).toContain(AI_REVIEW_VERTEX_AUTH_STEP_ID);
  });

  test("a federated mode with no id-token: write is REFUSED", () => {
    // Without the OIDC grant the exchange cannot happen at all, so the job
    // reports a mode it will never hold.
    const reading = aiReviewAuthScript(CONFIGURED);
    const violations = aiReviewUnmeasuredViolations(reading.script!, {
      idTokenWrite: false,
      authStep: reading.federation.authStep,
    });
    expect(violations.length, "a federated job with no OIDC grant was accepted").toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("id-token");
  });

  test("a federated mode whose auth step carries credentials_json is REFUSED", () => {
    // #677 AC-15 from the direction AIREVIEW-1 can see: a step that writes a
    // permanent key into the workspace the reviewer reads is not the
    // credential this mode claims.
    const reading = aiReviewAuthScript(CONFIGURED);
    const keyed = { ...(reading.federation.authStep as any) };
    keyed.with = { ...keyed.with, credentials_json: "${{ secrets.GCP_SA_KEY }}" };
    const violations = aiReviewUnmeasuredViolations(reading.script!, {
      idTokenWrite: true,
      authStep: keyed,
    });
    expect(violations.length, "a service-account key was accepted").toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("credentials_json");
  });
});

// ── running the generated script ────────────────────────────────────────────

/**
 * Run the auth-detect step's script out of the GENERATED workflow.
 *
 * Extracted from the emitted YAML rather than rebuilt from the builder: a case
 * that calls `buildAuthDetectScript()` measures the builder, and the question
 * here is what a consumer's checked-out workflow does.
 */
async function runAuthScript(
  root: string,
  env: Record<string, string>,
): Promise<{ mode: string; stdout: string; stderr: string; code: number }> {
  const { spawnSync } = await import("child_process");
  const doc = Bun.YAML.parse(workflowOf(root)) as any;
  const step = doc.jobs[AI_REVIEW_JOB].steps.find((s: any) => s?.id === AI_REVIEW_AUTH_STEP_ID);
  expect(step, `the generated job has no \`${AI_REVIEW_AUTH_STEP_ID}\` step to run`).toBeDefined();
  expect(typeof step.run, "the auth step carries no run: body").toBe("string");

  const dir = mkdtempSync(join(tmpdir(), "ai-review-wif-run-"));
  scratch.push(dir);
  const script = join(dir, "auth.sh");
  const output = join(dir, "github-output");
  writeFileSync(script, step.run);
  writeFileSync(output, "");

  const r = spawnSync("bash", [script], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, ...env },
  });
  const m = /^mode=(.*)$/m.exec(readFileSync(output, "utf-8"));
  return { mode: m ? m[1] : "", stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}
