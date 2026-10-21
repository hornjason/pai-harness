/**
 * #254 — the PR step runs on EVERY path that reaches the Ship phase.
 *
 * `workflows/ship.js` had exactly one `pr-upsert` call site and it lived inside
 * the ELSE arm of `if (containerConfig)`, batched together with that arm's
 * `environments.prod` write. A consumer that configures a container therefore
 * took the other arm, `prStep` stayed null, no PR was ever opened, and the run
 * went on to report a shipped status over a pushed branch nobody could review.
 * #252's entire draft lifecycle — `--draft`, `pr-ready`, `prReadiness` — is
 * unreachable from that arm, so the defect also silently disabled the fix that
 * exists to stop an unearned PR looking mergeable.
 *
 * DailyBriefDashboard's hard "7776 before 7777" rule REQUIRES container config,
 * so this is not a latent path: it is the path the next consumer takes.
 *
 * ## Why this file brace-matches instead of grepping
 *
 * "ship.js contains pr-upsert" stays true for every arrangement of the file,
 * including the broken one — the question is WHERE the call site sits relative
 * to a conditional, and that is a structural question. #273 is the other half:
 * five of the eight anchors the phase-ordering checks used occur only inside
 * comments, so a comment mentioning `pr-upsert` must neither satisfy nor defeat
 * anything here. Both are handled by reading two offset-preserving views of the
 * same source, produced by `lib/strip-js-comments.ts`:
 *
 *  - `stripJsComments(src)` — comments blanked, literals intact. The call site
 *    lives inside a template literal (it is a prompt), so this is the view that
 *    can SEE it while a comment cannot forge it.
 *  - `stripJsComments(src, { blankLiterals: true })` — comments AND literal
 *    contents blanked. Braces inside a prompt (`${WORK_DIR}`, `{rebuild:'SKIP'}`)
 *    are not braces, so this is the only view a brace matcher may count over.
 *
 * Offsets are preserved by both, which is what makes an index from one view
 * comparable to a range from the other. `test/strip-js-comments.test.ts` pins
 * that property.
 *
 * ## WHAT WAS BROKEN TO PROVE THIS FAILS
 * (.claude/rules/checks-must-be-able-to-fail.md)
 *
 * The `MUTANT-` cases build a copy of the real `workflows/ship.js` with the PR
 * step moved back inside the container conditional's else arm and run the SAME
 * checker over it — real source clean, mutant refused, one check. The builder
 * throws when its anchor moves or its substitution changes nothing, so a rename
 * aborts this file rather than passing it quietly. `PR-EVERY-PATH-4` is the
 * other direction: a synthetic source whose prompt carries unbalanced-looking
 * braces, which a matcher run over the raw text would close the conditional on.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { ReachabilityRefusal, assertMarkedBlockReachable } from "../lib/reachability";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * ship.js is resolved from this file's own directory, never from HARNESS_ROOT:
 * under worktree isolation that variable points at a different checkout than
 * the one being graded (#190), and the subject here is the tree under test.
 */
const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

/** The Ship phase marker — the search for the conditional starts here. */
const SHIP_PHASE = "phase('Ship')";
/**
 * The conditional whose arms the PR step must not be trapped in.
 *
 * Three arms since #312, not two: `unmeasured` (a container is declared and
 * the config says nowhere to reach it) was split out of the container arm,
 * because folding it in was what made a container nothing had contacted
 * record as one that had been probed and found down. The checker below reads
 * `else if` chains of any length, so the count is asserted rather than
 * assumed — a fourth arm must be looked at, not absorbed.
 */
const CONTAINER_IF = "if (containerUnmeasured) {";
/** The same shape, spelled the way the synthetic sources below spell it. */
const SYNTHETIC_IF = "if (containerConfig) {";
/** The command the PR step actually runs. Not `create-pr`, which is a comment. */
const PR_CALL = "pr-upsert";
/** The hoisted PR step, start and end, as literals so a rename aborts the build. */
const STEP_SIGNATURE = "prStep = await timedAgent(`";
const STEP_TERMINATOR = "\n} })\n";

// ── structure ──────────────────────────────────────────────────────────────

interface Arm {
  /** `if` for the container arm, `else` for the one after it. */
  kind: string;
  /** Offset of the arm's opening brace. */
  start: number;
  /** Offset of the arm's closing brace. */
  end: number;
}

interface ShipStructure {
  /** The whole `if … else …` statement, opening brace to final closing brace. */
  conditional: { start: number; end: number };
  arms: Arm[];
  /** Every `pr-upsert` occurrence that is CODE (a comment one is not here). */
  prCallSites: number[];
}

/**
 * The index of the `}` closing the `{` at `openIdx`.
 *
 * Only ever run over a literals-blanked view. Over raw source a `}` inside a
 * prompt closes the conditional early, which is the failure `PR-EVERY-PATH-4`
 * reproduces on purpose.
 */
function matchBrace(skeleton: string, openIdx: number): number {
  if (skeleton[openIdx] !== "{") {
    throw new Error(`matchBrace was pointed at '${skeleton[openIdx]}' rather than a '{' at ${openIdx}`);
  }
  let depth = 0;
  for (let i = openIdx; i < skeleton.length; i++) {
    const c = skeleton[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error(`the block opening at ${openIdx} is never closed`);
}

/**
 * Locate the Ship phase's container conditional, its arms, and every PR call
 * site, as offsets into the ORIGINAL source.
 *
 * Throws rather than returning a verdict: a source this cannot read is a source
 * nothing below can say anything true about, and `prPlacementViolations` turns
 * the throw into a violation that names itself a STRUCTURE failure — so a
 * mutant that merely stopped parsing can never be mistaken for one that was
 * caught on the merits.
 */
function shipPhaseStructure(src: string): ShipStructure {
  const code = stripJsComments(src);
  const skeleton = stripJsComments(src, { blankLiterals: true });

  // Anchors are located in `code` and braces are counted in `skeleton`. That
  // split is the whole technique: `phase('Ship')` carries a string, so the
  // skeleton cannot see it, and a prompt carries braces, so the code view
  // cannot count them. Offsets are identical in both, which is what lets an
  // index from one be used as a start in the other.
  const shipIdx = code.indexOf(SHIP_PHASE);
  if (shipIdx < 0) throw new Error(`could not locate ${SHIP_PHASE} in the source`);

  // Either spelling: the real file opens the chain on the probe kind (#312),
  // the synthetic sources below open it on `containerConfig`. Whichever is
  // present, what follows is the same `if … else …` chain.
  const head = [CONTAINER_IF, SYNTHETIC_IF]
    .map(lit => ({ lit, at: code.indexOf(lit, shipIdx) }))
    .filter(h => h.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (!head) throw new Error(`could not locate "${CONTAINER_IF}" after the Ship phase`);

  const arms: Arm[] = [];
  let open = head.at + head.lit.length - 1;
  let close = matchBrace(skeleton, open);
  arms.push({ kind: "if", start: open, end: close });

  // `else`, `else if`, as many as there are. The `{` is found over the skeleton
  // so a brace inside the condition's own string literal cannot be mistaken for
  // the arm's opening brace.
  for (;;) {
    const rest = skeleton.slice(close + 1);
    const m = /^\s*else\b/.exec(rest);
    if (!m) break;
    const from = close + 1 + m[0].length;
    const next = skeleton.indexOf("{", from);
    if (next < 0) throw new Error("an else arm with no block — this checker only reads braced arms");
    open = next;
    close = matchBrace(skeleton, open);
    arms.push({ kind: "else", start: open, end: close });
  }

  const prCallSites: number[] = [];
  for (let i = code.indexOf(PR_CALL); i >= 0; i = code.indexOf(PR_CALL, i + 1)) prCallSites.push(i);

  return { conditional: { start: arms[0].start, end: arms[arms.length - 1].end }, arms, prCallSites };
}

/**
 * The check, as one function over one source, so the real file and a mutant are
 * answered by the same code rather than by two assertions that agree by habit.
 */
function prPlacementViolations(src: string): string[] {
  let s: ShipStructure;
  try {
    s = shipPhaseStructure(src);
  } catch (e) {
    return [`STRUCTURE: ${e instanceof Error ? e.message : String(e)}`];
  }

  const violations: string[] = [];
  if (s.prCallSites.length === 0) {
    violations.push(`PLACEMENT: no executable ${PR_CALL} call site exists at all`);
  }
  for (const at of s.prCallSites) {
    const arm = s.arms.find(a => at > a.start && at < a.end);
    if (arm) {
      violations.push(
        `PLACEMENT: the ${PR_CALL} call site at offset ${at} sits inside the ${arm.kind} ` +
          `arm of the container conditional, so a run taking the other arm opens no PR`,
      );
    }
  }
  return violations;
}

/** The raw text of the hoisted PR step, from its signature to its terminator. */
function prStepSource(src: string): string {
  const occurrences = src.split(STEP_SIGNATURE).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `the PR step signature appears ${occurrences} times, expected exactly 1 — ` +
        "either it was renamed, or a second copy exists and one of them is unreviewed",
    );
  }
  const start = src.indexOf(STEP_SIGNATURE);
  const end = src.indexOf(STEP_TERMINATOR, start);
  if (end < 0) throw new Error("the PR step's terminator was not found after its signature");
  return src.slice(start, end + STEP_TERMINATOR.length);
}

// ── PR-EVERY-PATH ──────────────────────────────────────────────────────────

describe("PR-EVERY-PATH: the pr-upsert call site is outside the container conditional", () => {
  test("PR-EVERY-PATH-1: the real ship.js places it on a path every run reaches", () => {
    expect(prPlacementViolations(shipSource)).toEqual([]);
  });

  test("PR-EVERY-PATH-2: the conditional really has three arms and the call site sits after all of them", () => {
    // Without this the check above is satisfiable by a file with no conditional
    // at all, which is the vacuous shape .claude/rules/checks-must-be-able-to-fail.md
    // names: a pass earned by what the detector never looked at.
    //
    // Three since #312. The count is asserted and not inferred, because the
    // way this check fails quietly is a new arm appearing and the PR step
    // ending up inside it.
    const s = shipPhaseStructure(shipSource);
    expect(s.arms.map(a => a.kind)).toEqual(["if", "else", "else"]);
    for (const [i, arm] of s.arms.entries()) {
      expect(arm.end - arm.start, `arm ${i} is too small to be a real record-env step`)
        .toBeGreaterThan(200);
    }
    expect(s.prCallSites.length).toBe(1);
    expect(s.prCallSites[0]).toBeGreaterThan(s.conditional.end);
  });

  test("PR-EVERY-PATH-3: a comment naming the call site neither satisfies nor defeats the check", () => {
    // Both directions, because #273 was exactly one of them. A comment inside an
    // arm must not read as a call site, and the real call site must not stop
    // being found because a comment mentions it.
    const s = shipPhaseStructure(shipSource);
    const planted =
      shipSource.slice(0, s.arms[0].start + 1) +
      `\n  // a comment mentioning ${PR_CALL} is not a call site\n` +
      shipSource.slice(s.arms[0].start + 1);
    expect(planted).not.toBe(shipSource);
    expect(planted.split(PR_CALL).length - 1).toBe(2);
    expect(prPlacementViolations(planted)).toEqual([]);
  });

  test("PR-EVERY-PATH-4: braces inside a prompt cannot close the conditional early", () => {
    // The positive control for the literals-blanked view. Over raw text the `}`
    // in this prompt closes the `if` arm at the wrong place, the call site then
    // measures as outside, and the check passes over a file with the defect.
    const trap = [
      "phase('Ship')",
      "let prStep = null",
      "if (containerConfig) {",
      "  await timedAgent(`record env: s.environments.prod = {rebuild:'SKIP'}",
      "  a stray } and a stray { in prose`, { label: 'record-env' })",
      "} else {",
      "  prStep = await timedAgent(`run: bun scripts/github-op.ts pr-upsert --draft`, { label: 'open-pr' })",
      "}",
      "",
    ].join("\n");
    const naive = matchBrace(stripJsComments(trap), trap.indexOf(SYNTHETIC_IF) + SYNTHETIC_IF.length - 1);
    const sound = matchBrace(stripJsComments(trap, { blankLiterals: true }), trap.indexOf(SYNTHETIC_IF) + SYNTHETIC_IF.length - 1);
    expect(naive).toBeLessThan(sound);
    expect(prPlacementViolations(trap).join("\n")).toContain("sits inside the else arm");
  });

  test("PR-EVERY-PATH-5: the same synthetic source passes once the step is hoisted out", () => {
    // The negative half of the case above, so "it refuses" is not satisfied by a
    // checker that refuses everything.
    const fixed = [
      "phase('Ship')",
      "let prStep = null",
      "if (containerConfig) {",
      "  await timedAgent(`record env: s.environments.prod = {rebuild:'PASS'}",
      "  a stray } and a stray { in prose`, { label: 'record-env' })",
      "} else {",
      "  await timedAgent(`record env: s.environments.prod = {rebuild:'SKIP'}`, { label: 'record-env' })",
      "}",
      "prStep = await timedAgent(`run: bun scripts/github-op.ts pr-upsert --draft`, { label: 'open-pr' })",
      "",
    ].join("\n");
    expect(prPlacementViolations(fixed)).toEqual([]);
  });

  test("PR-EVERY-PATH-6: no file under workflows or test names the batched step label", () => {
    // Composed from parts on purpose: spelled out, this file would itself be a
    // hit, and a scan that finds its own search string is the self-reference
    // trap .claude/rules/checks-must-be-able-to-fail.md records.
    const batchedLabel = ["record", "env", "and", "pr"].join("-");
    const hits: string[] = [];
    for (const dir of ["workflows", "test"]) {
      const root = join(REPO_ROOT, dir);
      for (const entry of readdirSync(root)) {
        const path = join(root, entry);
        if (!statSync(path).isFile()) continue;
        const text = readFileSync(path, "utf-8");
        text.split("\n").forEach((line, i) => {
          if (line.includes(batchedLabel)) hits.push(`${dir}/${entry}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
    // The scan is real: it finds the label this file's own subject DOES use.
    expect(readFileSync(SHIP_PATH, "utf-8")).toContain("label: 'open-pr'");
  });
});

// ── MUTANT ─────────────────────────────────────────────────────────────────

/**
 * Put the PR step back where #254 found it: inside the else arm of the
 * container conditional. Structurally neutral otherwise — the step text is
 * moved verbatim, nothing is reworded.
 */
function prStepBackInsideArmMutant(src: string): string {
  const step = prStepSource(src);
  const without = src.slice(0, src.indexOf(step)) + src.slice(src.indexOf(step) + step.length);
  if (without === src) throw new Error("could not build the mutant: removing the PR step changed nothing");
  const s = shipPhaseStructure(without);
  const elseArm = s.arms.find(a => a.kind === "else");
  if (!elseArm) {
    throw new Error("could not build the mutant: the container conditional has no else arm to hide the step in");
  }
  const mutant = `${without.slice(0, elseArm.start + 1)}\n${step}${without.slice(elseArm.start + 1)}`;
  if (mutant === src) throw new Error("could not build the mutant: the relocation changed nothing");
  return mutant;
}

describe("MUTANT: the check refuses the arrangement #254 was filed about", () => {
  test("MUTANT-1: the step moved back inside the else arm is refused, the real source is not", () => {
    const mutant = prStepBackInsideArmMutant(shipSource);
    const refusal = prPlacementViolations(mutant);
    // Named, not merely non-empty: a mutant that stopped parsing refuses too,
    // and that refusal says nothing about placement.
    expect(refusal.join("\n")).toContain("sits inside the else arm");
    expect(refusal.filter(v => v.startsWith("STRUCTURE:"))).toEqual([]);
    // The real-source half, in the same test and over the same checker — this
    // is the pairing that separates a check from a line in a report.
    expect(prPlacementViolations(shipSource)).toEqual([]);
  });

  test("MUTANT-2: the mutation is a move, not a deletion", () => {
    const mutant = prStepBackInsideArmMutant(shipSource);
    // Same call sites, same length — so the refusal above is about WHERE the
    // step is, not about the step having been gutted.
    expect(mutant.split(PR_CALL).length - 1).toBe(shipSource.split(PR_CALL).length - 1);
    expect(mutant.length).toBe(shipSource.length + 1);
  });

  test("MUTANT-3: a renamed step aborts the build rather than reading as caught", () => {
    const renamed = shipSource.replace(STEP_SIGNATURE, "pullRequestStep = await timedAgent(`");
    expect(renamed).not.toBe(shipSource);
    expect(() => prStepBackInsideArmMutant(renamed)).toThrow(/appears 0 times/);
  });
});

// ── ENV ────────────────────────────────────────────────────────────────────

describe("ENV: both arms keep their own environments write, the PR step has none", () => {
  // Over EVERY arm, not over two named ones. #312 added a third and the two
  // named lookups would have skipped it silently — the shape this file was
  // written to refuse, one level up.
  const arms = () =>
    shipPhaseStructure(shipSource).arms.map((a, i) => ({
      i,
      kind: a.kind,
      text: shipSource.slice(a.start, a.end + 1),
    }));

  test("ENV-1: every arm records environments.prod through its own record-env step", () => {
    // gates/SCHEMA-GUIDE.md: the ship gate refuses on missing environments
    // fields, so no arm may rely on the PR step to write them.
    const all = arms();
    expect(all.length).toBe(3);
    for (const arm of all) {
      expect(arm.text, `arm ${arm.i} writes no environments`).toContain("s.environments.prod");
      expect(arm.text, `arm ${arm.i} does not persist`).toContain("writeWorkflowState");
      expect(arm.text, `arm ${arm.i} is not a record-env step`).toContain("label: 'record-env'");
    }
  });

  test("ENV-2: every arm records a rebuild and a smoke verdict, and says which", () => {
    // The three differ in WHAT they record, which is the point of there being
    // three: a probe that came back, a probe that could not be built, and no
    // container at all. What they may not differ in is recording something.
    for (const arm of arms()) {
      expect(arm.text, `arm ${arm.i} records no rebuild verdict`).toMatch(/rebuild\s*[:=]\s*'(PASS|FAIL|SKIP)'/);
      expect(arm.text, `arm ${arm.i} records no smoke verdict`).toMatch(/smoke\s*[:=]\s*'(PASS|FAIL|SKIP)'/);
    }
    // And exactly one of them refuses: the arm for a container the config
    // gave nowhere to reach (#312). Were that zero, every arm would again be
    // reporting a clean result for a run that measured nothing.
    expect(arms().filter(a => /smoke\s*[:=]\s*'FAIL'/.test(a.text)).length).toBe(1);
  });

  test("ENV-3: no arm opens a PR", () => {
    for (const arm of arms()) {
      expect(arm.text, `arm ${arm.i} opens its own PR`).not.toContain(PR_CALL);
    }
  });

  test("ENV-4: the hoisted PR step writes no environments of its own", () => {
    const step = prStepSource(shipSource);
    expect(step).toContain(PR_CALL);
    expect(step).not.toContain("environments");
    expect(step).not.toContain("writeWorkflowState");
  });

  test("ENV-5: the hoisted step still reports what happened to the PR", () => {
    // #137 and #252: a run that opened no PR must not look like one that did,
    // and the draft state must be REPORTED rather than assumed.
    const step = prStepSource(shipSource);
    expect(step).toContain("--draft");
    expect(step).toContain("--title-from-issue");
    expect(step).toMatch(/required: \['ok'\]/);
    expect(step).toContain("prDraft");
  });
});

// ── REACH ──────────────────────────────────────────────────────────────────

/**
 * #266: the shape brace-matching cannot see.
 *
 * Everything above answers "is the call site outside the container
 * conditional" — a question about ONE conditional, asked by finding its
 * braces. It is the right question and it is not the whole one. A wrapper
 * placed anywhere else, with the PR step still textually below the container
 * `if`, satisfies every check in this file: `prPlacementViolations` finds the
 * call outside both arms and returns clean, `prStepSource` extracts the same
 * bytes, and the step never runs.
 *
 * Measured on 2026-10-08 against three other marked blocks, wrapping the
 * marked region in `if (false)` with the wrapper OUTSIDE the marker comments:
 * BLOCKING-GRADES 19 pass / 0 fail, SECURITY-DECISION 113 pass / 0 fail,
 * COMMIT-STATE-GUARD 52 pass / 0 fail. Three suites, 184 tests, nothing red.
 *
 * `assertMarkedBlockReachable` reads the block's position in the PARSED
 * program rather than its text, which is why it sees a wrapper that leaves the
 * extracted bytes byte-identical. The refusal side of it — real refuses,
 * mutant does not — lives in test/reachability-refusals.test.ts, which drives
 * the same marker through both its groups.
 */
describe("REACH: the PR step is reachable, not merely well-placed", () => {
  test("REACH-1: the marker pair exists and the step is inside it", () => {
    // Without this, the chain assertion below is about an empty region, which
    // `assertMarkedBlockReachable` would happily report as Program-level.
    const start = shipSource.indexOf("PR-UPSERT-CALL-START");
    const end = shipSource.indexOf("PR-UPSERT-CALL-END");
    expect(start, "the PR-UPSERT-CALL markers are gone").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const between = shipSource.slice(start, end);
    expect(between, "the markers no longer wrap the PR step").toContain(PR_CALL);
    expect(between).toContain(STEP_SIGNATURE);
  });

  test("REACH-2: its enclosing chain is exactly Program", () => {
    // Exactly, not `chain[0] === "Program"`: every one of the wrappers this
    // guards against leaves Program at the head of the chain and adds to it.
    expect(assertMarkedBlockReachable(shipSource, "PR-UPSERT-CALL")).toEqual(["Program"]);
  });

  test("REACH-3: a wrapper outside the markers is refused, and the text check is not", () => {
    // Both halves in one test, over one input, because the pairing is the
    // point: the text check going green on the mutant is the measurement that
    // says why REACH-2 had to exist, and on its own "the reachability check
    // refused" could be a parse error.
    const lines = shipSource.split("\n");
    const first = lines.findIndex(l => l.includes("PR-UPSERT-CALL-START"));
    const last = lines.findIndex(l => l.includes("PR-UPSERT-CALL-END"));
    expect(last).toBeGreaterThan(first);
    lines.splice(last + 1, 0, "}");
    lines.splice(first, 0, "if (false) {");
    const mutant = lines.join("\n");

    expect(
      mutant.slice(mutant.indexOf("PR-UPSERT-CALL-START"), mutant.indexOf("PR-UPSERT-CALL-END")),
      "the wrapper landed inside the markers, so this measures the wrong thing",
    ).toBe(shipSource.slice(shipSource.indexOf("PR-UPSERT-CALL-START"), shipSource.indexOf("PR-UPSERT-CALL-END")));

    expect(
      prPlacementViolations(mutant),
      "the placement check caught the wrapper — then the reachability guard is redundant and this file is overstating its case",
    ).toEqual([]);

    expect(() => assertMarkedBlockReachable(mutant, "PR-UPSERT-CALL")).toThrow(/IfStatement/);
    expect(assertMarkedBlockReachable(shipSource, "PR-UPSERT-CALL")).toEqual(["Program"]);
  });

  test("REACH-4: moving the step into an uncalled function is refused too", () => {
    // `if (false)` is the case that was measured; it is not the only shape.
    // A relocation into a function nobody invokes leaves the chain's head as
    // Program for the FUNCTION, which is why the check reads the whole chain.
    const lines = shipSource.split("\n");
    const first = lines.findIndex(l => l.includes("PR-UPSERT-CALL-START"));
    const last = lines.findIndex(l => l.includes("PR-UPSERT-CALL-END"));
    lines.splice(last + 1, 0, "}");
    lines.splice(first, 0, "async function neverCalled() {");
    expect(() => assertMarkedBlockReachable(lines.join("\n"), "PR-UPSERT-CALL")).toThrow(
      ReachabilityRefusal,
    );
  });
});
