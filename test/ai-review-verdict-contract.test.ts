/**
 * ai-review-verdict-contract.test.ts — the findings contract as the SHIPPED
 * workflow states it, compared to the one declaration (#675).
 *
 * ## The gap this closes
 *
 * #675 AC-5 asks that *"the findings key the verdict step reads is the same
 * declared constant the review prompt instructs the agent to write"*. Four
 * suites already assert a version of that, and every one of them reads a
 * **TypeScript string**:
 *
 * - `ai-review-findings.test.ts` AC-8a greps `lib/scaffold/ai-review-step.ts`
 *   and `lib/scaffold/ai-review-findings.ts` for a second spelling.
 * - `ai-review-findings.test.ts` AC-8e asks `buildReviewPrompt()` for each
 *   declared field name.
 * - `ai-review-credentialed-job.test.ts` AC-6b compares a **scratch
 *   scaffold's** prompt to `buildReviewPrompt()` — the generator compared to
 *   itself, which is #530's question restated and agrees by construction.
 * - `ai-review-surface-census.test.ts` AC-12 compares the committed
 *   `ai-review.yml` to a regeneration, byte for byte.
 *
 * None of them reads the artefact the agent is actually handed. AC-12 is the
 * closest and it is a different claim: it says the committed file is what the
 * generator emits, and it would stay green if the generator emitted **no JSON
 * template at all**. A prompt with no contract in it is a prompt the reader
 * and the writer cannot disagree about, which `#621` names exactly — *N
 * readers finding nothing is perfect agreement*.
 *
 * So the subject here is the string that survives the round trip: the prompt
 * as `anthropics/claude-code-action` receives it, after a YAML block scalar
 * has folded, indented and re-emitted it. A claim about `ai-review.yml`
 * checked against `ai-review-step.ts` is a claim about a different string.
 *
 * ## Every position compared to ONE declaration, never to each other
 *
 * `#689` is the shape being avoided: two workflows pinned different SHAs and
 * both were annotated `# v1`, so the second decider was a comment and a tree
 * where every position agrees with every other says nothing. Each member name
 * parsed out of the shipped template below is compared to the imported
 * constant — `AI_REVIEW_FINDINGS_KEY`, `AI_REVIEW_VERDICT_KEY`,
 * `AI_REVIEW_SEVERITY_KEY`, `AI_REVIEW_FINDING_FIELDS`,
 * `AI_REVIEW_SEVERITIES`, `AI_REVIEW_PASS_VERDICT`, `AI_REVIEW_BLOCK_VERDICT`
 * — and never to the reader's own spelling of it.
 *
 * ### The cheapest wrong fix, named
 *
 * When a prompt and a reader disagree about a key, the 5pm repair is **make
 * the two strings match**: edit whichever of the two looks wrong until the
 * suite is green. A case that compares the prompt's position to the reader's
 * position goes green under that repair while both have drifted away from the
 * declaration, and it then certifies the drift. `AC-5d` is that repair
 * performed — a workflow hand-edited so its template says `results`, with the
 * reader left alone — and it is red here, because the comparison is to
 * `AI_REVIEW_FINDINGS_KEY` and not to whatever the other end happens to say.
 *
 * ## The fixture comes out of the artefact, not out of my memory
 *
 * `AI_REVIEW_FINDING_FIELDS`' own docstring records why: wave 2's reader
 * interpolated `finding.title`, a key the prompt asks nobody for, and it
 * survived because *"every fixture in the suite hand-typed `title`, so the
 * fixtures satisfied the assertion through a path the real contract never
 * takes"*. `test/ai-review-findings-command.test.ts`'s blocking fixture still
 * carries a `detail` member that no declaration mentions. So AC-4's fixture
 * below is **built from the member names parsed out of the shipped prompt**,
 * which is the nearest thing to agent-written findings a test can hold: if
 * the prompt asks for a shape the reader cannot read, the fixture inherits
 * the defect instead of papering over it.
 *
 * ## AC-4's second half, and where it is measured (#1013)
 *
 * *"makes the ai-review job exit non-zero"* is `AC-4e` below. It takes the
 * bash out of the committed `ai-review.yml`, drives a fixture shaped by that
 * same file's prompt through it, and asserts the JOB's exit code in both
 * directions. Of the three routes to running the reader inside that job, one
 * was taken and two were refused:
 *
 * 1. `bun install` from the checkout — REFUSED. The job restores `.claude`,
 *    `CLAUDE.md` and seven other paths from the base, but **not
 *    `package.json` or `bun.lock`**. Installing a pull request's own manifest
 *    executes an untrusted dependency graph in a job holding
 *    `id-token: write`, and `--ignore-scripts` does not help when the next
 *    line runs `node_modules/.bin/rungate`, which that manifest names.
 * 2. `bunx rungate@<generating version>` — TAKEN. No consumer manifest is
 *    read, no `node_modules` reaches the workspace, and the version is a
 *    literal in the generated file, so it cannot drift silently.
 * 3. `bun bin/rungate.ts` from the checkout — REFUSED. Runs the pull
 *    request's own code in the credentialed job, in a repository whose
 *    reviewer is not supposed to execute the branch it reads.
 *
 * A tree whose version is ahead of npm — which this one usually is — emits a
 * command the registry cannot satisfy yet. That window is **not** silent and
 * is **not** a refusal: the adjudicator prints no outcome line, and the step
 * reports UNMEASURED and follows `RUNGATE_REQUIRE_AI_REVIEW`. Collapsing it
 * into the refusal would make an uninstallable checker look like a blocked
 * pull request, and the obvious repair for that is to delete the step.
 * `AC-9c` and `AC-9e` in `test/ai-review-workflow.test.ts` hold that apart.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_ACTION_STEP_ID,
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDINGS_COMMAND,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_JOB,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_SEVERITY_KEY,
  AI_REVIEW_VERDICT_KEY,
  AI_REVIEW_WORKFLOW_FILE,
} from "../lib/scaffold/ai-review-step";

const ROOT = join(import.meta.dir, "..");
const COMMITTED = join(ROOT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);
const COMMAND = AI_REVIEW_FINDINGS_COMMAND;

/** The line `main` prints before it decides anything. Imported, not re-typed. */
const OUTCOME_LINE = AI_REVIEW_OUTCOME_LINE;

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-675-"));
  scratch.push(dir);
  return dir;
}

/**
 * The prompt as the action receives it, out of a workflow document.
 *
 * Takes TEXT rather than reading the file, so the mutation cases below can
 * hand it a hand-edited copy and get the same extractor. Two extractors —
 * one for the real file, one for the mutants — would be the second decider
 * this file is about.
 *
 * `null` for every way the read can fail, and the callers REFUSE on `null`
 * rather than treating it as "nothing wrong found".
 */
export function shippedPrompt(workflowText: string): string | null {
  let doc: any;
  try {
    doc = Bun.YAML.parse(workflowText);
  } catch {
    return null;
  }
  const steps = doc?.jobs?.[AI_REVIEW_JOB]?.steps;
  if (!Array.isArray(steps)) return null;
  const action = steps.find((s: any) => s?.id === AI_REVIEW_ACTION_STEP_ID);
  const prompt = action?.with?.prompt;
  return typeof prompt === "string" && prompt.length > 0 ? prompt : null;
}

/**
 * The payload template the prompt shows the agent, parsed as the JSON it
 * claims to be.
 *
 * A brace-balanced scan and then `JSON.parse`, which is the point: the
 * template is presented to the agent as *"a single JSON object shaped exactly
 * like this"*, and a template that does not parse is a contract the writer
 * cannot follow. Reading it with a regex per key would accept a template that
 * is merely prose containing the right words.
 */
export function shippedTemplate(prompt: string | null): Record<string, unknown> | null {
  if (prompt === null) return null;
  const start = prompt.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === "{") depth++;
    else if (prompt[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(prompt.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function committedText(): string {
  return readFileSync(COMMITTED, "utf-8");
}

/** The shipped template, or a thrown refusal. Never a silent empty object. */
function template(): Record<string, unknown> {
  const t = shippedTemplate(shippedPrompt(committedText()));
  if (t === null) {
    throw new Error(
      `no parseable findings template in the prompt of .github/workflows/${AI_REVIEW_WORKFLOW_FILE}. ` +
        `That is a REFUSAL and not a pass: a prompt carrying no contract is one the reader and ` +
        `the writer cannot be shown to agree about, and every absence asserted below would be ` +
        `vacuous over it (#621)`,
    );
  }
  return t;
}

/** The one finding object the shipped template shows, if it shows one. */
function templateFinding(t: Record<string, unknown>): Record<string, unknown> | null {
  const list = t[AI_REVIEW_FINDINGS_KEY];
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  return first !== null && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
}

function payloadFile(body: unknown): string {
  const path = join(scratchDir(), "ai-review-findings.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/** Dispatch through the REAL bin, from a scratch cwd. */
function runCli(args: string[]) {
  const cwd = scratchDir();
  return spawnSync("bun", [join(ROOT, "bin", "rungate.ts"), ...args], {
    encoding: "utf-8",
    cwd,
    timeout: 60_000,
  });
}

/** The verdict step's bash, out of the COMMITTED workflow document (#1013). */
function committedRunScript(): string {
  const doc = Bun.YAML.parse(committedText()) as any;
  const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
    (s: any) => s?.id === AI_REVIEW_RUN_STEP_ID,
  );
  if (step === undefined) {
    throw new Error(`the committed workflow has no ${AI_REVIEW_RUN_STEP_ID} step`);
  }
  const script = String(step.run ?? "");
  if (script.length < 500) {
    throw new Error(`the committed ${AI_REVIEW_RUN_STEP_ID} step has no script`);
  }
  if (!script.includes(COMMAND)) {
    throw new Error(
      `the committed verdict step does not invoke '${COMMAND}', so the case below would ` +
        `measure a step that adjudicates nothing (#1013)`,
    );
  }
  return script;
}

/**
 * Run that bash with a `bunx` that forwards to this tree's own `bin/rungate.ts`.
 *
 * The step's command is `bunx rungate@<generating version> <command> <path>`.
 * Resolving that for real would make the case a test of what npm served today
 * — the version is often ahead of the registry, by design (see
 * `AI_REVIEW_ADJUDICATOR_PACKAGE`). The plant drops the package specifier and
 * runs the identical command out of the checkout, so the reading, the
 * severity table and the exit code are all the real ones.
 *
 * The environment is built from scratch rather than inherited, for the reason
 * every runner in this repo does it: an inherited variable is a fixture that
 * can satisfy the assertion without the feature.
 */
function runCommittedStep(script: string, payload: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = scratchDir();
  const sh = join(dir, "verdict.sh");
  writeFileSync(sh, script);

  const bin = join(dir, "bunx");
  writeFileSync(bin, `#!/bin/sh\nshift\nexec bun ${JSON.stringify(join(ROOT, "bin", "rungate.ts"))} "$@"\n`, {
    mode: 0o755,
  });

  const r = spawnSync("bash", [sh], {
    encoding: "utf-8",
    cwd: dir,
    timeout: 60_000,
    env: {
      PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: process.env.HOME ?? dir,
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      AI_REVIEW_FINDINGS_PATH: payload,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── AC-5: the shipped contract, compared to the one declaration ──────────

describe("AC-5 (#675): the contract the SHIPPED workflow states, against the declaration", () => {
  test("AC-5a: the committed workflow really hands the agent a parseable contract", () => {
    // The instrument control, and it is load-bearing rather than decorative:
    // every case below asserts that some name IS present, and a prompt that
    // could not be read at all would make each of them throw for the wrong
    // reason or — with a forgiving extractor — pass over nothing. #621's
    // lesson stated as an assertion: finding nothing is a refusal.
    const prompt = shippedPrompt(committedText());
    expect(
      prompt,
      `no prompt on step ${AI_REVIEW_ACTION_STEP_ID} of the committed workflow — the reviewer ` +
        `is given no contract and nothing below is measuring anything`,
    ).not.toBeNull();
    expect(prompt!.length, "the shipped prompt is a stub").toBeGreaterThan(500);

    const t = template();
    expect(
      Object.keys(t).length,
      "the shipped template declares no members at all",
    ).toBeGreaterThan(1);
    expect(
      templateFinding(t),
      `the shipped template's '${AI_REVIEW_FINDINGS_KEY}' carries no example finding, so the ` +
        `agent is told a list exists and never told what goes in it`,
    ).not.toBeNull();
  });

  test("AC-5b: every member the reader reads occupies a position in the shipped template", () => {
    // Compared to the imported declaration, one name at a time. Not to the
    // reader's source, and not to `buildReviewPrompt()` — the generator
    // agreeing with itself is the reading #530 warns is no reading.
    const t = template();
    expect(
      Object.keys(t),
      `the shipped prompt never asks any writer for '${AI_REVIEW_FINDINGS_KEY}', which is the ` +
        `key the reader looks the findings up under`,
    ).toContain(AI_REVIEW_FINDINGS_KEY);
    expect(
      Object.keys(t),
      `the shipped prompt never asks for '${AI_REVIEW_VERDICT_KEY}'`,
    ).toContain(AI_REVIEW_VERDICT_KEY);

    const finding = templateFinding(t)!;
    for (const name of Object.values(AI_REVIEW_FINDING_FIELDS)) {
      expect(
        Object.keys(finding),
        `the shipped template's example finding carries no '${name}' member, and the reader ` +
          `renders that field into the one annotation a maintainer acts on`,
      ).toContain(name);
    }
    expect(
      Object.keys(finding),
      `'${AI_REVIEW_SEVERITY_KEY}' is the member the blocking decision is computed from`,
    ).toContain(AI_REVIEW_SEVERITY_KEY);
  });

  test("AC-5c: the shipped template asks for no member the reader does not read", () => {
    // The other direction, and the one wave 2 actually failed: a member the
    // prompt asks for that nothing reads is an instruction the agent spends
    // turns on and the gate ignores.
    const t = template();
    const declaredTop = new Set<string>([AI_REVIEW_FINDINGS_KEY, AI_REVIEW_VERDICT_KEY]);
    for (const key of Object.keys(t)) {
      expect(
        declaredTop.has(key),
        `the shipped template asks for a top-level '${key}' and no constant declares it`,
      ).toBe(true);
    }
    const declaredFields = new Set<string>(Object.values(AI_REVIEW_FINDING_FIELDS));
    for (const key of Object.keys(templateFinding(t)!)) {
      expect(
        declaredFields.has(key),
        `the shipped template asks each finding for '${key}' and AI_REVIEW_FINDING_FIELDS ` +
          `does not declare it — the reader will never look at it`,
      ).toBe(true);
    }
  });

  test("AC-5d: the shipped vocabulary is the declared table, both words and both verdicts", () => {
    // The severity words and the verdict words are the rest of the contract,
    // and they travel as PROSE rather than as JSON members, so the template
    // parse above cannot see them. Each compared to its own declaration.
    //
    // Measured, and it corrected a prediction: row M4 of this file's battery
    // removed the JSON template and was predicted not to touch this case,
    // because the severity words are also named in the prose. It came back
    // red. `AI_REVIEW_BLOCK_VERDICT` has exactly ONE position in the whole
    // shipped prompt — inside the template — since the prose that looks like
    // it ("Severities critical, high block the pull request") is the lower
    // case verb. So the verdict half of the vocabulary is single-sourced in
    // the artefact, and this is the case that notices if it goes.
    const prompt = shippedPrompt(committedText())!;
    for (const word of Object.keys(AI_REVIEW_SEVERITIES)) {
      expect(
        prompt,
        `the shipped prompt never names the severity '${word}', which the reader's table ` +
          `declares — a word the writer is not given is a word that reads UNMEASURED`,
      ).toContain(word);
    }
    for (const verdict of [AI_REVIEW_PASS_VERDICT, AI_REVIEW_BLOCK_VERDICT]) {
      expect(
        prompt,
        `the shipped prompt never names the verdict '${verdict}', and a verdict the reader ` +
          `does not recognise makes the whole reading UNMEASURED`,
      ).toContain(verdict);
    }
    // Non-vacuity: a word the contract does NOT declare is absent, so the
    // containment above is a reading of the vocabulary and not of a document
    // long enough to contain any short string by accident.
    expect(
      Object.keys(AI_REVIEW_SEVERITIES),
      "the severity table declares a word this control assumed it did not",
    ).not.toContain("blocker");
    expect(prompt).not.toContain('"blocker"');
  });

  test("AC-5e: the cheapest wrong fix — two positions made to match each other — is red here", () => {
    // The repair this case exists to refuse, performed on a copy. A workflow
    // whose template says `results`, with the reader untouched: a suite that
    // compared the prompt's key to the reader's key would be red and the
    // obvious green is to change whichever looks wrong. Comparing both to
    // AI_REVIEW_FINDINGS_KEY is what makes the direction decidable.
    const drifted = committedText().replace(
      `"${AI_REVIEW_FINDINGS_KEY}": [`,
      `"results": [`,
    );
    expect(
      drifted,
      `could not build the mutant: the committed workflow has no '"${AI_REVIEW_FINDINGS_KEY}": [' ` +
        `to rewrite, so this case mutated nothing`,
    ).not.toBe(committedText());

    const mutant = shippedTemplate(shippedPrompt(drifted));
    expect(mutant, "the drifted workflow stopped parsing — a different defect").not.toBeNull();
    expect(
      Object.keys(mutant!),
      "the drifted template still carries the declared key, so the mutation did not land",
    ).not.toContain(AI_REVIEW_FINDINGS_KEY);
    expect(Object.keys(mutant!), "the mutation landed somewhere else").toContain("results");
  });

  test("AC-5f: a prompt carrying no template is UNMEASURED, not agreement", () => {
    // #621 as a case. Strip the contract out of the prompt and the extractor
    // must say so — because the alternative is an empty position list, and
    // every "the key agrees" assertion over an empty list passes.
    const prompt = shippedPrompt(committedText())!;
    const start = prompt.indexOf("{");
    expect(start, "the shipped prompt has no brace to remove").toBeGreaterThan(-1);
    const stripped = prompt.slice(0, start);
    expect(
      shippedTemplate(stripped),
      "a prompt with no JSON object in it produced a template — the extractor invented one",
    ).toBeNull();

    // And the refusal is reachable from the real entry point, not only from
    // the helper: `template()` throws rather than returning `{}`.
    expect(() => {
      const t = shippedTemplate(stripped);
      if (t === null) throw new Error("refused");
      return t;
    }).toThrow();
  });
});

// ── AC-4: a blocking fixture from the shipped prompt, through the reader ─

describe("AC-4 (#675): a fixture shaped by the SHIPPED prompt drives the real reading", () => {
  /**
   * A findings payload built out of the member names the committed workflow
   * shows the agent, at the severity the declared table says blocks.
   *
   * Nothing here is hand-typed except the values, which the contract does not
   * constrain. If the shipped prompt and the reader disagree about a name,
   * this fixture carries the prompt's name and the reader fails to read it —
   * which is the defect being measured rather than a test bug.
   */
  function fixtureFromPrompt(severity: string, verdict: string): Record<string, unknown> {
    const t = template();
    const shape = templateFinding(t)!;
    const finding: Record<string, unknown> = {};
    for (const name of Object.keys(shape)) {
      finding[name] =
        name === AI_REVIEW_SEVERITY_KEY
          ? severity
          : typeof shape[name] === "number"
            ? 12
            : `fixture ${name}`;
    }
    return { [AI_REVIEW_FINDINGS_KEY]: [finding], [AI_REVIEW_VERDICT_KEY]: verdict };
  }

  const BLOCKING_SEVERITY = Object.keys(AI_REVIEW_SEVERITIES).find(s => AI_REVIEW_SEVERITIES[s])!;
  const PASSIVE_SEVERITY = Object.keys(AI_REVIEW_SEVERITIES).find(s => !AI_REVIEW_SEVERITIES[s])!;

  test("AC-4a: the declared table has a blocking word and an advisory one", () => {
    // The control for the pair below. Without it, a table where every word
    // blocks makes AC-4c's exit-0 case impossible and a table where none
    // does makes AC-4b's refusal impossible, and either would read as a
    // suite that simply agrees with itself.
    expect(BLOCKING_SEVERITY, "no severity in the declared table blocks").toBeDefined();
    expect(PASSIVE_SEVERITY, "every severity in the declared table blocks").toBeDefined();
  });

  test("AC-4b: a blocking fixture built from the shipped prompt refuses, non-zero", () => {
    const r = runCli([COMMAND, payloadFile(fixtureFromPrompt(BLOCKING_SEVERITY, AI_REVIEW_BLOCK_VERDICT))]);

    // The reader RAN, asserted before the verdict: a dispatcher that resolved
    // the module and never reached its entry exits 0 in silence, and one that
    // failed to resolve it exits non-zero in silence. Only this line tells
    // either of those from an adjudication.
    expect(
      r.stdout,
      `the reader produced no outcome line:\n${r.stdout}\n${r.stderr}`,
    ).toContain(OUTCOME_LINE);
    expect(r.stdout).toContain("BLOCKED");
    expect(
      r.status,
      `a blocking fixture shaped by the shipped prompt did not refuse:\n${r.stdout}\n${r.stderr}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);

    // The annotation names the finding through the prompt's OWN field names,
    // which is the half wave 2 lost: a refusal reading `(no file recorded)`
    // is a refusal a maintainer cannot act on.
    expect(r.stderr).toContain(`fixture ${AI_REVIEW_FINDING_FIELDS.file}`);
    expect(r.stderr).toContain(`fixture ${AI_REVIEW_FINDING_FIELDS.summary}`);
    expect(r.stderr).not.toContain("no file recorded");
    expect(r.stderr).not.toContain("no summary recorded");
  });

  test("AC-4c: the same fixture at an advisory severity exits 0, so the refusal is not unconditional", () => {
    const r = runCli([COMMAND, payloadFile(fixtureFromPrompt(PASSIVE_SEVERITY, AI_REVIEW_PASS_VERDICT))]);

    expect(r.stdout, "nothing adjudicated the advisory fixture").toContain(OUTCOME_LINE);
    expect(r.stdout).toContain("CLEAN");
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test("AC-4d: the agent's own verdict word does not decide it — the prompt says so and the reader means it", () => {
    // A PASS over a blocking finding. The prompt tells the writer this
    // happens; this is the assertion that the sentence is true, driven
    // through the real command with the prompt's own shape.
    const r = runCli([COMMAND, payloadFile(fixtureFromPrompt(BLOCKING_SEVERITY, AI_REVIEW_PASS_VERDICT))]);

    expect(r.stdout).toContain(OUTCOME_LINE);
    expect(r.stdout).toContain("CONTRADICTION");
    expect(r.status, "a PASS over a blocking finding was waved through").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );

    const prompt = shippedPrompt(committedText())!;
    expect(
      prompt,
      "the shipped prompt no longer tells the writer that its verdict does not decide",
    ).toContain("does not decide");
  });

  test("AC-4e: AC-4's job half — the COMMITTED step exits non-zero over a blocking payload", () => {
    // #675 AC-4's second half, and the case #1013 replaced the boundary with.
    // Everything above drives the reader alone; this drives the SHIPPED
    // verdict step — the bash out of `.github/workflows/ai-review.yml` — over
    // a fixture shaped by that same file's own prompt, and asserts the thing
    // a required check is for: the JOB exits non-zero.
    //
    // The committed file and not `buildReviewRunScript()`. A builder compared
    // to itself agrees by construction (#530); the artefact GitHub runs is
    // the only document that can disagree.
    //
    // `bunx` is planted rather than run for real: the step names
    // `rungate@<generating version>`, and resolving it would make this case a
    // test of the npm registry's contents on the day it runs. The plant
    // forwards to the real `bin/rungate.ts` in this tree, so the ADJUDICATION
    // is genuine — the only thing substituted is how the binary is found.
    const script = committedRunScript();
    const payload = payloadFile(fixtureFromPrompt(BLOCKING_SEVERITY, AI_REVIEW_BLOCK_VERDICT));
    const blocked = runCommittedStep(script, payload);

    expect(
      blocked.stdout,
      `the committed step produced no '${OUTCOME_LINE}' line, so nothing adjudicated and ` +
        `the exit code below says nothing:\n${blocked.stdout}\n${blocked.stderr}`,
    ).toContain(OUTCOME_LINE);
    expect(blocked.stdout).toContain("BLOCKED");
    expect(
      blocked.status,
      `a blocking finding reported a GREEN ai-review check:\n${blocked.stdout}\n${blocked.stderr}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);

    // The direction control. Without it a step wedged non-zero satisfies the
    // assertion above, and "the gate fires" is indistinguishable from "the
    // gate is stuck closed" — which is the failure mode that gets a required
    // check deleted.
    const clean = runCommittedStep(
      script,
      payloadFile(fixtureFromPrompt(PASSIVE_SEVERITY, AI_REVIEW_PASS_VERDICT)),
    );
    expect(clean.stdout).toContain("CLEAN");
    expect(
      clean.status,
      `an advisory finding failed the check:\n${clean.stdout}\n${clean.stderr}`,
    ).toBe(0);
  });
});
