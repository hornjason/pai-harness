/**
 * Covers SC-1678..SC-1680 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #307 SC-A11.
 *
 * The scope gate's heal prompt told an agent:
 *
 *     For local-api-validated: read ${PROJECT_ROOT}/.claude/rungate.json for
 *     apiUrl. If no apiUrl configured, write environments.local.api = "SKIP".
 *
 * Two defects in one sentence, and they compound.
 *
 * The file is named. A consumer on the documented `.claude/rungate/` layout
 * does not have it, so the agent finds nothing — and the sentence tells it
 * what to do about finding nothing: write SKIP. A project serving a live API
 * records "this check does not apply", and a skip for "no server here" and a
 * skip for "I could not locate the config" are the same two letters in the
 * state file.
 *
 * And the decision is the AGENT's. The workflow already knows the answer: it
 * resolves the config through `scripts/resolve-config.ts` before any prompt is
 * written, and interpolates `${testCommand}` from it three lines above. The
 * URL was the one value left for the agent to go and find.
 *
 * So the clause is built by the workflow and the agent is handed a conclusion,
 * not a lookup. When a URL resolved, SKIP is not offered at all — an agent
 * that cannot complete the curl has found a FAIL, which is the asymmetry this
 * whole gate exists for.
 *
 * The clause is EXECUTED here, out of its marker block, rather than asserted
 * as source text: a prompt test that greps for a URL passes against a prompt
 * that mentions the URL and still says SKIP.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { stripJsComments } from "../lib/strip-js-comments";

const SHIP = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

/** The text between a START/END marker pair. */
function markedBlock(name: string): string {
  const start = SHIP.indexOf(`// ──── ${name}-START ────`);
  const end = SHIP.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return SHIP.slice(start, end);
}

/**
 * ship.js's own `shellQuote`, sliced rather than re-spelled here (#1103).
 *
 * The clause quotes the URL now — it is a word in a `curl` the agent runs —
 * so the block needs the quoter to execute. A copy written in this file would
 * be two deciders that agree, and the rows below would then be measuring a
 * quoter this test invented.
 */
const SHELL_QUOTE_SOURCE = (() => {
  const start = SHIP.indexOf("function shellQuote(word) {");
  if (start < 0) throw new Error("ship.js no longer declares shellQuote");
  const end = SHIP.indexOf("\n}", start);
  if (end < 0) throw new Error("ship.js's shellQuote has no closing brace");
  return SHIP.slice(start, end + 2);
})();

type Clause = (field: "api" | "ui", url: string | null, configKey: string) => string;

const localEnvClause: Clause = new Function(
  `${SHELL_QUOTE_SOURCE}\n${markedBlock("LOCAL-ENV-CLAUSE")}\nreturn localEnvClause`,
)() as Clause;

describe("#307: the heal prompt carries the URL, not a lookup", () => {
  test("SC-1678: a resolved URL reaches the prompt and no file is named", () => {
    const clause = localEnvClause("api", "http://localhost:7778", "dev.apiBase");

    expect(clause).toContain("http://localhost:7778");
    // The two things the old sentence did that this one must not. Naming the
    // monolith is the half that breaks a migrated consumer; naming any config
    // file at all is the half CONFIG-2 refuses.
    expect(clause, "the clause still names the config file").not.toContain("rungate.json");
    expect(clause, "the clause still sends the agent to the config").not.toContain(".claude");
  });

  test("SC-1679: SKIP is not offered when a URL resolved", () => {
    // The self-skip. An agent handed both a URL and the word SKIP has been
    // given a way out of the check, and the state file cannot tell a project
    // with no server from an agent that took it.
    const api = localEnvClause("api", "http://localhost:7778", "dev.apiBase");
    const ui = localEnvClause("ui", "http://localhost:5173", "dev.uiBase");

    for (const [name, clause] of [["api", api], ["ui", ui]] as const) {
      expect(clause, `${name}: SKIP is still on offer beside a resolved URL`).toContain(
        "SKIP is NOT available",
      );
      // ...and it says what to do instead, because "not SKIP" with no second
      // option is an instruction an agent resolves by picking one anyway.
      expect(clause, `${name}: the clause does not say what replaces SKIP`).toContain("FAIL");
    }
  });

  test("SC-1680: a project with no URL still skips - and says which key it looked for", () => {
    // The positive control for both cases above, and the branch that must
    // stay reachable: rungate itself sets no `dev.apiBase`, so a clause that
    // had stopped being able to skip would turn every self-run red.
    const clause = localEnvClause("api", null, "dev.apiBase");

    expect(clause).toContain('environments.local.api = "SKIP"');
    expect(clause).toContain("skipReason");
    // Named, because "no API configured" sends an operator looking for a key
    // they already did not set.
    expect(clause).toContain("dev.apiBase");
    // And the agent is told not to go hunting — the absence is the
    // workflow's finding, not an invitation to re-check it.
    expect(clause).toContain("Do not go looking");
  });

  test("the two fields produce different clauses - the field is not decorative", () => {
    // A clause that ignored its `field` argument would satisfy every
    // assertion above while writing the API verdict into both slots.
    const api = localEnvClause("api", null, "dev.apiBase");
    const ui = localEnvClause("ui", null, "dev.uiBase");

    expect(api).toContain("environments.local.api");
    expect(ui).toContain("environments.local.ui");
    expect(api).not.toContain("environments.local.ui");
    expect(ui).not.toContain("environments.local.api");
  });

  test("the shipped prompt uses the clause, and the old sentence is gone", () => {
    // The clause being right is worth nothing if the prompt still hardcodes
    // the old text beside it. This is the one source-text assertion here, and
    // it is about the CALL rather than about the content.
    expect(SHIP).toContain("For local-api-validated: ${localApiClause}");
    expect(SHIP).toContain("For local-ui-validated: ${localUiClause}");
    // Searched over the whole file but REPORTED as a line list, because the
    // failure message for a whole-file `toContain` is the whole file.
    const offenders = SHIP.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("rungate.json for apiUrl"))
      .map(([n, line]) => `${n}: ${line.trim()}`);
    expect(
      offenders,
      `the heal prompt still sends an agent to the config for a URL:\n${offenders.join("\n")}`,
    ).toEqual([]);
    // One block, so there is one binding to mutate.
    expect(SHIP.split("LOCAL-ENV-CLAUSE-START").length - 1).toBe(1);
  });
});

// ═══ #530: a clause nothing runs is not a producer ═══════════════════════

/**
 * Covers SC-1849..SC-1853 (HARNESS-STANDARD.md), #530.
 *
 * Everything above is about what the clauses SAY. #530 is about when they
 * run, and they did not: the only interpolation of them was in the SCOPE
 * gate's heal prompt, which runs only when the scope gate fails. On every
 * run where scope passed, `environments.local` stayed `{}` and three gates
 * refused finished work for want of a field nothing had ever written.
 *
 * So the subject here is PLACEMENT, and it is checked structurally rather
 * than by grep. A `toContain("record-local-env")` passes against a step
 * buried in an arm nothing takes, which is the arrangement #530 describes.
 */

/** The step's own opts object, as a literal, so a rename aborts the build. */
const STEP_CALL = "{ label: 'record-local-env', phase: 'Verify' },";
const VERIFY_PHASE = "phase('Verify')";
/** The gate that reads what the step writes. */
const VERIFY_GATE = "runGateWithHeal('verify', 'Verify',";

/**
 * The check, as ONE function over one source, so the real file and a mutant
 * go through the same code (.claude/rules/checks-must-be-able-to-fail.md).
 *
 * Anchors are found in a comments-blanked view and braces are counted in a
 * literals-blanked one. The split is load-bearing both ways: `phase('Verify')`
 * carries a string the skeleton cannot see, and the step's prompt carries
 * `${...}` braces the code view would count.
 *
 * A source this cannot read returns a violation that names itself STRUCTURE,
 * so a mutant that merely stopped parsing can never read as one caught on
 * the merits.
 */
function localEnvPlacementViolations(src: string): string[] {
  const code = stripJsComments(src);
  const skeleton = stripJsComments(src, { blankLiterals: true });

  const phases = code.split(VERIFY_PHASE).length - 1;
  if (phases !== 1) return [`STRUCTURE: ${VERIFY_PHASE} appears ${phases} times, expected exactly 1`];
  const steps = code.split(STEP_CALL).length - 1;
  if (steps !== 1) return [`STRUCTURE: the record-local-env call site appears ${steps} times, expected exactly 1`];

  const phaseAt = code.indexOf(VERIFY_PHASE);
  const stepAt = code.indexOf(STEP_CALL);
  const gateAt = code.indexOf(VERIFY_GATE, phaseAt);
  if (gateAt < 0) return ["STRUCTURE: the verify gate call was not found after the Verify phase"];

  let depth = 0;
  for (let i = 0; i < stepAt; i++) {
    const c = skeleton[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }

  const out: string[] = [];
  if (depth !== 0) {
    out.push(
      `the record-local-env step sits ${depth} block(s) deep — a step that only some paths reach ` +
        "is the arrangement #530 was filed about, and it reads exactly like one that always runs",
    );
  }
  if (stepAt < phaseAt) out.push("the record-local-env step runs before the Verify phase opens");
  if (stepAt > gateAt) out.push("the record-local-env step runs AFTER the gate that reads what it writes");
  return out;
}

type Prompt = (o: Record<string, string | number>) => string;

const recordLocalEnvPrompt: Prompt = new Function(
  `${markedBlock("RECORD-LOCAL-ENV")}\nreturn recordLocalEnvPrompt`,
)() as Prompt;

/** The arguments the real call site supplies, with each value made findable. */
function samplePrompt(): string {
  return recordLocalEnvPrompt({
    harnessRoot: "/h",
    workDir: "/w",
    testTimeout: 120000,
    suiteCapture: "CAPTURE-COMMAND",
    recorder: "RECORDER-COMMAND",
    apiClause: "API-CLAUSE",
    uiClause: "UI-CLAUSE",
  });
}

describe("#530: the local environment has a step that always runs", () => {
  test("SC-1849: the step is on a path every Verify reaches, and runs before the gate", () => {
    expect(localEnvPlacementViolations(SHIP)).toEqual([]);
  });

  test("SC-1850: the same check refuses the step put back inside a conditional", () => {
    // The mutation, performed rather than argued. Without it SC-1849 is
    // satisfied by a function that returns [] for every input.
    const lines = SHIP.split("\n");
    const at = lines.findIndex(l => l.includes(STEP_CALL));
    expect(at, "the call site line was not found — the literal moved").toBeGreaterThan(-1);
    // Walk back to the `await timedAgent(` that opens the call.
    let open = at;
    while (open > 0 && !lines[open].includes("await timedAgent(")) open--;
    expect(lines[open], "the step's opening call was not found above its opts").toContain("await timedAgent(");

    const mutant = [
      ...lines.slice(0, open),
      "if (hasUI) {",
      ...lines.slice(open, at + 1),
      "}",
      ...lines.slice(at + 1),
    ].join("\n");

    const violations = localEnvPlacementViolations(mutant);
    expect(violations.length, `the buried step was accepted:\n${violations.join("\n")}`).toBe(1);
    expect(violations[0], "refused, but as a parse failure rather than on the merits")
      .not.toContain("STRUCTURE:");
    expect(violations[0]).toContain("block(s) deep");
  });

  test("SC-1851: the prompt carries both commands and forbids a typed verdict", () => {
    const prompt = samplePrompt();

    // Both halves of the chain, from the one producer that builds them.
    expect(prompt, "the suite is never captured").toContain("CAPTURE-COMMAND");
    expect(prompt, "the recorder is never run").toContain("RECORDER-COMMAND");
    // The flags the recorder refuses by name must not appear in a sentence —
    // SC-1717's finding is that an agent reading a flag in prose types it.
    expect(prompt).not.toContain("--failures");
    expect(prompt).not.toContain("--result");
    expect(prompt).not.toContain("--sha");
    // And the field the recorder owns is named as off-limits to the agent,
    // because the second write is the thing the gate cross-check refuses.
    expect(prompt).toContain("do NOT edit environments.local.tests by hand");
  });

  test("SC-1852: the api and ui clauses reach it, and it restates neither", () => {
    const prompt = samplePrompt();
    expect(prompt, "the api clause never reaches the step").toContain("API-CLAUSE");
    expect(prompt, "the ui clause never reaches the step").toContain("UI-CLAUSE");
    // One producer. A prompt that re-derived the instruction would still
    // contain both markers if it also interpolated them, so the test is that
    // it does not send the agent to a config file for the URL.
    expect(prompt).not.toContain("rungate.json");
    expect(prompt).not.toContain(".claude");
  });

  test("SC-1853: the call site measures the worktree, not main", () => {
    // PROJECT_ROOT is main. A suite measured there is a measurement of
    // somebody else's commit, and the recorder would stamp main's SHA onto
    // this branch's verdict — which `suiteCurrency` then compares against the
    // branch tip and refuses, for the wrong reason.
    const code = stripJsComments(SHIP);
    const at = code.indexOf(STEP_CALL);
    const callSite = code.slice(code.lastIndexOf("await timedAgent(", at), at);

    expect(callSite, "the suite is captured somewhere other than the worktree")
      .toContain("suiteCaptureCommand(marcusWorktreePath,");
    expect(callSite, "the recorder reads its commit from somewhere other than the worktree")
      .toContain("recorderCommand(HARNESS_ROOT, WORK_DIR, marcusWorktreePath,");
    expect(callSite, "the step still points at main").not.toContain("PROJECT_ROOT");

    // One block, so there is one binding to mutate.
    expect(SHIP.split("RECORD-LOCAL-ENV-START").length - 1).toBe(1);
  });
});
