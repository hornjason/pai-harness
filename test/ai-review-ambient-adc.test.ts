/**
 * #679 — a self-hosted runner's ambient ADC is a usable Vertex credential,
 * and the auth-detect step used to report the machine as empty.
 *
 * ## Measured, on `origin/main` @ `99d3ee17`
 *
 * The generated script for a consumer with no `ci.vertex`, executed under
 * `bash` on a machine carrying Application Default Credentials:
 *
 * ```
 * ai-review auth mode: none
 * ::warning title=AI review UNMEASURED::No Claude credential is configured
 * (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, a ci.vertex federation provider),
 * so no AI review ran on this pull request. ...
 * ```
 *
 * The script never looked, so there was no reading to be wrong: the sentence
 * was a claim about the world made from a scan of three environment
 * variables. #679 measured ADC alone returning a real completion from the
 * model this job is pinned to, with no service-account key and no
 * `google-github-actions/auth` step. The sentence was false, and a false
 * UNMEASURED is more corrosive than a false PASS — it trains people to ignore
 * the one annotation that is supposed to mean something.
 *
 * ## What is NOT here, named rather than implied
 *
 * **AC-3 is UNMEASURED and nothing below stands in for it.** Resolving a mode
 * that RUNS the review on ambient ADC needs a real self-hosted runner and a
 * project id the generator does not have when `ci.vertex` is absent, and it
 * is a security decision — a repo that configured nothing would be switched
 * onto the machine owner's personal login to review pull-request code. There
 * is no structural assertion in this file pretending to cover it.
 *
 * **AC-2's validating probe is deliberately not shipped.** AC-2 is right that
 * file presence lies; validating ADC means exchanging it for an access token,
 * and this script is executed on developer machines, not only on runners —
 * `aiReviewUnmeasuredViolations` (lib/conformity.ts) runs it on every scan. A
 * validating probe here mints a GCP access token on a laptop.
 *
 * So AC-2 is met by inversion instead: nothing resolves a mode from the
 * reading, so a stale file cannot produce a usable-looking mode. AC-6's
 * mutant — resolve `adc` from the file's existence — reds `the ambient
 * reading is not a mode` and `AC-5 ...` below.
 *
 * ## Why every case builds its own HOME
 *
 * `test/ai-review-scaffold.test.ts` hands the script the real `$HOME`, and
 * the developer this issue came from has an ADC file at the default path.
 * A case that inherited that would be green or red depending on whose
 * machine ran it, which is the local/CI split this repo pays for repeatedly.
 * Every run below gets an empty `HOME` it owns, and the ADC file is planted
 * into it or not.
 *
 * ## Mutation battery
 *
 * Over this file plus `ai-review-scaffold`, `ai-review-workflow`,
 * `ai-review-outcomes-header`, `ai-review-credentialed-job` and
 * `ai-review-security-repairs` — **122 cases**, green unmutated, source
 * restored after each and green again.
 *
 * Counts AND the assertions each row reddens. Cases from THIS file build
 * their own `HOME` and plant or withhold the ADC file in it, so they are
 * machine-independent in both directions; rows that also name cases in
 * `ai-review-scaffold` are marked, because that file hands the script the
 * real `$HOME` and those reds appear only on a machine that carries ADC.
 * Every row has at least one machine-independent red.
 *
 * | mutation | red | the assertions that go red |
 * |---|---|---|
 * | N1 the reading deleted, so `ambient` is always empty | **4 of 122** | the three naming cases + `the ambient reading is reported as its own output` |
 * | N2 `[ -f "${adc_file}" ]` relaxed to `[ -n ... ]` — presence of a PATH rather than of a file, which is #679's own note on AC-2 | **3 of 122** | `AC-5: ...`; `a path that points at nothing is not named`; the output case |
 * | N3 **AC-6's mutant** — the file's existence sets `mode=adc` | **11 of 122** | `the ambient reading is not a mode`; `exactly one UNMEASURED annotation ...`; `the require-variable refusal still fires ...`; the three naming cases; + 5 pre-existing cases (machine-dependent) |
 * | N4 the ambient sentence emitted unconditionally | **2 of 122** | `AC-5: ...`; `a path that points at nothing is not named` |
 * | N5 the reading run regardless of mode | **2 of 122** | both `... the runner is not consulted` cases |
 * | N6 the ambient sentence emitted as a SECOND `::warning` annotation | **6 of 122** | `exactly one UNMEASURED annotation, whatever the runner carries` + the three naming cases; + 2 (machine-dependent). That count is what `aiReviewUnmeasuredViolations` enforces, so the mutant turns every scan on a machine carrying ADC into a violation. |
 * | N7 `CLOUDSDK_CONFIG` ignored and `~/.config/gcloud` hardcoded | **1 of 122** | `CLOUDSDK_CONFIG relocates the default path` |
 * | N8 **the security row** — the annotation rebuilt around a shell variable, which is how this shipped first | **1 of 122** | `AC-8 (#856/F1) ... every annotation that interpolates a shell value goes through it`, in `ai-review-security-repairs` |
 *
 * N3 is the row AC-6 asks for and it is the largest, which is the argument
 * for the design: resolving a mode from an unvalidated file does not fail
 * subtly here, it breaks the mode ladder, the annotation count and the
 * refusal gate at once.
 *
 * N8 is the row review found before CI did. The first draft built the
 * annotation as `unmeasured="..."` and echoed `${unmeasured}`, which is a
 * shell value inside a `::warning`; AC-8 is mechanical and does not ask
 * whether the value is attacker-reachable. Both branches are whole literals
 * now — this script carries no `escape_annotation`, and adding one to call
 * on a constant would have been the larger change.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_ADC_SOURCES,
  AI_REVIEW_AMBIENT_ADC,
  AI_REVIEW_AMBIENT_OUTPUT,
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_MODES,
  AI_REVIEW_MODE_NONE,
  AI_REVIEW_MODE_VERTEX,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  buildAuthDetectScript,
  vertexCiConfig,
} from "../lib/scaffold/ai-review-step";

const VERTEX = {
  project: "fixture-vertex-project",
  workloadIdentityProvider:
    "projects/111122223333/locations/global/workloadIdentityPools/fixture-pool/providers/fixture-provider",
  region: "us-fixture1",
  model: "claude-sonnet-5",
};

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** The script this consumer's config produces, from the real generator. */
const scriptFor = (ci: unknown) => buildAuthDetectScript(vertexCiConfig(ci));

interface Run {
  code: number;
  stdout: string;
  /** `$GITHUB_OUTPUT` as key/value, which is what a downstream step reads. */
  outputs: Record<string, string>;
  /** `::warning` lines naming UNMEASURED — the count conformity enforces. */
  warnings: string[];
}

/**
 * One execution, under an environment built from scratch and a HOME this
 * case owns.
 *
 * `HOME` is the whole point of the isolation and `PATH` is the rest of it:
 * `process.env` carries a developer's real `ANTHROPIC_API_KEY` often enough
 * that inheriting it would resolve a mode for every tree and make the
 * credential-free cases green for a reason unrelated to the code. Nothing
 * here reads or prints a credential value; the ADC fixture is a file with
 * placeholder bytes and is never handed to anything that would try to use
 * it.
 */
function run(script: string, opts: { adc?: "default" | "relocated" | "env" | "dangling"; env?: Record<string, string> } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "ambient-adc-"));
  scratch.push(dir);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GITHUB_OUTPUT: join(dir, "github_output"),
    ...(opts.env ?? {}),
  };

  /** Not a credential. A file at the path Google's libraries consult. */
  const plant = (at: string): void => {
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, '{"type":"authorized_user","placeholder":true}\n');
  };
  const DEFAULT_REL = join(".config", "gcloud", "application_default_credentials.json");

  if (opts.adc === "default") plant(join(home, DEFAULT_REL));
  if (opts.adc === "relocated") {
    const cfg = join(dir, "sdk-config");
    plant(join(cfg, "application_default_credentials.json"));
    env[AI_REVIEW_ADC_SOURCES[1]] = cfg;
  }
  if (opts.adc === "env") {
    const file = join(dir, "sa-adc.json");
    plant(file);
    env[AI_REVIEW_ADC_SOURCES[0]] = file;
  }
  if (opts.adc === "dangling") env[AI_REVIEW_ADC_SOURCES[0]] = join(dir, "does-not-exist.json");

  const sh = join(dir, "auth-detect.sh");
  writeFileSync(sh, script);
  writeFileSync(env.GITHUB_OUTPUT, "");
  const r = spawnSync("bash", ["-e", sh], { encoding: "utf-8", env });
  const stdout = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  const outputs: Record<string, string> = {};
  for (const line of readFileSync(env.GITHUB_OUTPUT, "utf-8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }

  return {
    code: r.status ?? -1,
    stdout,
    outputs,
    warnings: stdout.split("\n").filter(l => l.startsWith("::warning") && l.includes("UNMEASURED")),
  };
}

/** The sentence the fix exists to make appear. Read off the emitted script. */
const NAMES_ADC = "Application Default Credentials";

describe("#679: the UNMEASURED annotation says what the runner was carrying", () => {
  test("an ADC file at the default path is named in the annotation", () => {
    const r = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "default" });

    expect(r.warnings.length, `expected one UNMEASURED annotation\n${r.stdout}`).toBe(1);
    expect(
      r.warnings[0],
      "the runner carried a credential that authenticates to Vertex and the step " +
        "reported the machine as empty — a false UNMEASURED, which is #630 in reverse",
    ).toContain(NAMES_ADC);
  });

  test(`${"GOOGLE_APPLICATION_CREDENTIALS"} pointing at a real file is named`, () => {
    const r = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "env" });

    expect(r.warnings.length, `expected one UNMEASURED annotation\n${r.stdout}`).toBe(1);
    expect(
      r.warnings[0],
      `${AI_REVIEW_ADC_SOURCES[0]} is the first source Google's own libraries consult ` +
        "and the step did not look at it",
    ).toContain(NAMES_ADC);
  });

  test(`${"CLOUDSDK_CONFIG"} relocates the default path`, () => {
    const r = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "relocated" });

    expect(
      r.warnings[0] ?? "",
      `${AI_REVIEW_ADC_SOURCES[1]} moves the gcloud configuration directory, and a reading ` +
        "that hardcodes ~/.config/gcloud misses every runner that sets it",
    ).toContain(NAMES_ADC);
  });

  /**
   * AC-5. The credential-less case still resolves `none` and still says
   * UNMEASURED — the new branch did not swallow it.
   */
  test("AC-5: no secrets and no ADC still resolves none and still says UNMEASURED", () => {
    const r = run(scriptFor({ runner: "ubuntu-latest" }));

    expect(r.outputs.mode, `expected ${AI_REVIEW_MODE_NONE}\n${r.stdout}`).toBe(AI_REVIEW_MODE_NONE);
    expect(r.warnings.length, "the credential-free state stopped annotating").toBe(1);
    expect(
      r.warnings[0],
      "the step named an ambient credential on a machine that has none — the sentence " +
        "is unconditional, which makes it worth exactly as much as the one it replaced",
    ).not.toContain(NAMES_ADC);
    expect(r.code, "a tree that has never configured a credential must not fail").toBe(0);
  });

  /**
   * The shape #679's "Note on AC-2" is about: a path that exists as a STRING
   * says nothing. This is the one reading in the block, and it has to be of
   * the file rather than of the variable.
   */
  test("a path that points at nothing is not named", () => {
    const r = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "dangling" });

    expect(
      r.warnings[0] ?? "",
      `${AI_REVIEW_ADC_SOURCES[0]} was set to a path with no file at it and the step ` +
        "reported a credential anyway — it is reading the variable, not the runner",
    ).not.toContain(NAMES_ADC);
    expect(r.outputs[AI_REVIEW_AMBIENT_OUTPUT], "and the output agrees").toBe("");
  });

  /**
   * AC-6, and AC-2 by inversion. The reading is reported as its own output
   * and is never a mode, so the mutant AC-6 names — resolve `adc` from the
   * file's existence — cannot be reached without reddening this.
   */
  test("the ambient reading is not a mode", () => {
    const r = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "default" });

    expect(
      r.outputs.mode,
      "the step resolved a mode from a file it never validated. Presence is not " +
        "validity: that file may be expired, and a mode resolved from a path that " +
        "exists answers confidently and incorrectly",
    ).toBe(AI_REVIEW_MODE_NONE);
    expect(
      AI_REVIEW_MODES as readonly string[],
      "the declared mode list grew an entry nothing in the ladder resolves",
    ).not.toContain(AI_REVIEW_AMBIENT_ADC);
  });

  test("the ambient reading is reported as its own output", () => {
    const found = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "default" });
    const absent = run(scriptFor({ runner: "ubuntu-latest" }));

    expect(
      found.outputs[AI_REVIEW_AMBIENT_OUTPUT],
      `a downstream step cannot read what the runner carried: ${AI_REVIEW_AMBIENT_OUTPUT} ` +
        "was not written to $GITHUB_OUTPUT",
    ).toBe(AI_REVIEW_AMBIENT_ADC);
    expect(
      absent.outputs[AI_REVIEW_AMBIENT_OUTPUT],
      "the output is unconditional, so it says nothing",
    ).toBe("");
  });

  /**
   * AC-4. A repository that configured a credential is not switched onto a
   * developer's ambient login, and the step does not even look.
   */
  test("AC-4: a configured secret wins and the runner is not consulted", () => {
    const { secret, mode } = AI_REVIEW_AUTH_PRECEDENCE[0];
    const r = run(scriptFor({ runner: "ubuntu-latest" }), {
      adc: "default",
      env: { [secret]: "placeholder-not-a-real-token" },
    });

    expect(r.outputs.mode, `${secret} must still win\n${r.stdout}`).toBe(mode);
    expect(
      r.stdout,
      "a configured review still reported itself unmeasured, which makes the word " +
        "mean nothing",
    ).not.toContain("UNMEASURED");
    expect(
      r.outputs[AI_REVIEW_AMBIENT_OUTPUT],
      "the step went looking at the runner's ambient credentials on a job that had " +
        "its own — a reading with no consumer is a reading nobody audits",
    ).toBe("");
  });

  /** The same for the federation, which is decided when the file is written. */
  test("a declared ci.vertex wins and the runner is not consulted", () => {
    const r = run(scriptFor({ runner: "ubuntu-latest", vertex: VERTEX }), { adc: "default" });

    expect(r.outputs.mode, `ci.vertex must still win\n${r.stdout}`).toBe(AI_REVIEW_MODE_VERTEX);
    expect(r.outputs[AI_REVIEW_AMBIENT_OUTPUT]).toBe("");
  });

  /**
   * The count `aiReviewUnmeasuredViolations` enforces. A second annotation
   * would make every conformity scan run on a machine carrying ADC report a
   * violation — a local/CI split manufactured by the fix.
   */
  test("exactly one UNMEASURED annotation, whatever the runner carries", () => {
    for (const adc of [undefined, "default"] as const) {
      const r = run(scriptFor({ runner: "ubuntu-latest" }), adc ? { adc } : {});
      expect(
        r.warnings.length,
        `${adc ?? "no"} ADC produced ${r.warnings.length} UNMEASURED annotations, expected 1 ` +
          `— the count is what keeps the word meaning something\n${r.stdout}`,
      ).toBe(1);
    }
  });

  /**
   * The gate did not move. Naming the ambient credential is a change to what
   * the annotation SAYS, and it must not change what the check DOES —
   * neither the honest zero exit on a first scaffold nor the refusal a
   * consumer opted into.
   */
  test("the require-variable refusal still fires, and still only when set", () => {
    const relaxed = run(scriptFor({ runner: "ubuntu-latest" }), { adc: "default" });
    expect(relaxed.code, `the default must not fail a first scaffold\n${relaxed.stdout}`).toBe(0);

    const strict = run(scriptFor({ runner: "ubuntu-latest" }), {
      adc: "default",
      env: { [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE },
    });
    expect(
      strict.code,
      `a consumer who set ${AI_REVIEW_REQUIRE_VAR} got a green check for a review that ` +
        `never ran\n${strict.stdout}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });
});
