/**
 * The PR step runs on every path that reaches the Ship phase (#254)
 *
 * ## The defect
 *
 * `workflows/ship.js` had exactly one `pr-upsert` call site and it sat inside
 * the `else` arm of `if (containerConfig)`, batched into the same agent as the
 * `environments.prod` reading "for agent-count reasons". So a consumer who
 * configures a test container got a run that implemented, tested, committed
 * and pushed a branch, recorded a shipped status — and opened nothing. `prStep`
 * stayed `null`, the ship gate's heal text said "NO PR was opened for this
 * run", and the whole of #252's draft lifecycle (`--draft`, `prReadiness`,
 * `pr-ready`) was unreachable on that path because there was no PR to be a
 * draft of.
 *
 * That is not a latent defect on a path nobody takes. DDB's hard
 * 7776-before-7777 rule REQUIRES container config, so adding it is what flips
 * `ship.js` to the arm that opens no PR.
 *
 * ## What this file asserts, and why it is not a grep
 *
 * "The call site is not inside the conditional" is a question about brace
 * extent, not about text. A `grep` for `pr-upsert` is satisfied by the broken
 * file; so is "`pr-upsert` appears after `if (containerConfig)`", because the
 * broken call site appears after it too. So the position check brace-matches
 * the real conditional — `if (containerConfig) { … } else { … }` — and asks
 * whether each `pr-upsert` occurrence falls inside that span.
 *
 * Two offset-preserving views of the same bytes make that answerable:
 *
 *  - `stripJsComments(src)` blanks comments and keeps literals. `pr-upsert`
 *    lives inside a template literal (an agent prompt), so this is the view
 *    that can find it, and a comment that merely mentions the command cannot
 *    satisfy the check. That is #273's lesson, applied.
 *  - `stripJsComments(src, { literals: "blank" })` blanks literals too, so the
 *    brace counter never sees the braces inside `bun -e "… = {rebuild:'SKIP'}"`
 *    or inside an agent prompt. Those happen to be balanced today; a detector
 *    that depends on prompt prose staying balanced is one prompt edit away
 *    from silently measuring the wrong span.
 *
 * Offsets survive both, so an index taken from one view is directly comparable
 * to a span taken from the other.
 *
 * ## WHAT WAS BROKEN TO PROVE THESE FAIL
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`. The mutants below are built
 * from the real `workflows/ship.js` on every run, never checked in, and every
 * builder throws `could not build the mutant` if its substitution changed
 * nothing — so renaming the thing it targets aborts this file rather than
 * quietly passing it. Five construction sites, not one, because a single
 * surviving mutation is a single anecdote:
 *
 *  - `prStepMovedIntoElseArmMutant` — the defect itself, reconstructed.
 *  - `prStepMovedIntoIfArmMutant` — the other arm, which the issue text does
 *    not mention and which a check written only against `else` would miss.
 *  - `prStepDeletedMutant` — no call site at all, its comment left behind.
 *  - `recordEnvStrippedFromContainerArmMutant` — the hoist done carelessly, by
 *    folding the container reading into the PR step (AC-4's subject).
 *  - `containerDownReadingStrippedMutant` — only one of the two readings left,
 *    which is the half a "does the arm mention record-env" check cannot see.
 *
 * Every mutation case also asserts the UNMUTATED source passes the same check.
 * Without that half, a case that later goes green for an unrelated reason is
 * indistinguishable from one that is genuinely caught.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { stripJsComments } from "../lib/strip-js-comments";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const SHIP_SRC = readFileSync(SHIP_PATH, "utf-8");
const SELF_PATH = join(import.meta.dir, "ship-pr-on-every-path.test.ts");

/** The command the PR step actually runs. Not a label, not a comment. */
const PR_CALL = "pr-upsert";
/** The Ship phase's opening statement. */
const SHIP_PHASE = "phase('Ship')";
/** The log line the ship gate announces itself with — the phase's far edge. */
const SHIP_GATE_LOG = "log('Running ship gate')";
/** The conditional whose extent the PR step must sit outside of. */
const CONTAINER_IF = "if (containerConfig) {";
/** The step's signature and terminator, as literals: a rename aborts the file. */
const PR_STEP_START = "prStep = await timedAgent(`";
const PR_STEP_END = "\n} })\n";
/** The per-arm environments reading that must survive the hoist. */
const RECORD_ENV_LABEL = "label: 'record-env'";
/** The PR step's own label, which must NOT claim to record anything. */
const PR_STEP_LABEL = "label: 'open-pr'";

// ── the two views ───────────────────────────────────────────────────────────

/** Comments blanked, literals kept. The view that can see inside a prompt. */
function codeView(src: string): string {
  return stripJsComments(src);
}

/** Comments AND literals blanked. The only view a brace counter may read. */
function braceView(src: string): string {
  return stripJsComments(src, { literals: "blank" });
}

/**
 * The index of `{`'s partner, counting over text with no literals left in it.
 * `-1` when it is never closed — never 0, which a caller could read as "found".
 */
function matchBrace(masked: string, openIndex: number): number {
  if (masked[openIndex] !== "{") return -1;
  let depth = 0;
  for (let k = openIndex; k < masked.length; k++) {
    if (masked[k] === "{") depth++;
    else if (masked[k] === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

export interface Extent {
  /** Offset of `if` in `if (containerConfig) {`. */
  start: number;
  /** Offset one past the `}` that closes the last arm. */
  end: number;
  /** The `if` arm's body, braces included. */
  ifArm: Extent0;
  /** The `else` arm's body, braces included. Absent when there is no else. */
  elseArm: Extent0 | null;
}
interface Extent0 { start: number; end: number }

/**
 * Brace-match the Ship phase's container conditional.
 *
 * Throws rather than returning a sentinel: every reachable failure here means
 * the thing being measured has moved, and a function that answered "no
 * violations" in that case would be the fail-open this whole file is about.
 */
export function containerArmExtent(src: string): Extent {
  const code = codeView(src);
  const masked = braceView(src);

  const phaseAt = code.indexOf(SHIP_PHASE);
  if (phaseAt < 0) throw new Error(`workflows/ship.js has no executable ${SHIP_PHASE}`);

  const ifAt = code.indexOf(CONTAINER_IF, phaseAt);
  if (ifAt < 0) throw new Error(`the Ship phase has no executable \`${CONTAINER_IF}\``);

  const ifOpen = masked.indexOf("{", ifAt);
  if (ifOpen < 0) throw new Error("the container conditional has no opening brace");
  const ifClose = matchBrace(masked, ifOpen);
  if (ifClose < 0) throw new Error("the container conditional's opening brace is never closed");

  let elseArm: Extent0 | null = null;
  let end = ifClose + 1;
  const tail = /^\s*else\s*\{/.exec(masked.slice(ifClose + 1));
  if (tail) {
    const elseOpen = ifClose + tail[0].length;
    const elseClose = matchBrace(masked, elseOpen);
    if (elseClose < 0) throw new Error("the container conditional's else brace is never closed");
    elseArm = { start: elseOpen, end: elseClose + 1 };
    end = elseClose + 1;
  }

  return { start: ifAt, end, ifArm: { start: ifOpen, end: ifClose + 1 }, elseArm };
}

/** Every offset at which `needle` occurs in `haystack`. */
function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

// ── AC-1 / AC-2: the position check ─────────────────────────────────────────

/**
 * Why the PR step's position is wrong, or `[]`.
 *
 * Exported and total: the mutation cases below call it on sources that are
 * deliberately broken, and a thrown error would read as a refusal it never
 * made. Anything that would have thrown becomes a violation instead.
 */
export function prPositionViolations(src: string): string[] {
  const v: string[] = [];
  const code = codeView(src);

  let extent: Extent;
  try {
    extent = containerArmExtent(src);
  } catch (e) {
    return [`the container conditional could not be located: ${(e as Error).message}`];
  }

  const calls = allIndexes(code, PR_CALL);
  if (calls.length === 0) {
    v.push(`no executable \`${PR_CALL}\` call site exists — a comment naming it is not a step`);
  }
  for (const at of calls) {
    if (at >= extent.start && at < extent.end) {
      const arm = extent.elseArm && at >= extent.elseArm.start ? "else" : "if";
      v.push(`a \`${PR_CALL}\` call site sits inside the container conditional's \`${arm}\` arm at offset ${at}`);
    }
  }

  const assign = code.indexOf(PR_STEP_START);
  if (assign < 0) {
    v.push(`the PR step's signature \`${PR_STEP_START}\` is not at the top level of the file`);
  } else if (assign >= extent.start && assign < extent.end) {
    v.push(`the PR step is assigned inside the container conditional at offset ${assign}`);
  }

  // Outside the conditional is necessary and not sufficient: outside it and
  // also outside the phase would be a different bug wearing the same green.
  const gate = code.indexOf(SHIP_GATE_LOG);
  for (const at of calls) {
    if (at < extent.end) continue;
    if (gate >= 0 && at > gate) v.push(`a \`${PR_CALL}\` call site sits after the ship gate at offset ${at}`);
  }

  return v;
}

// ── AC-4: the container arm keeps its own reading ───────────────────────────

/** The two readings the container arm has to be able to record. */
const CONTAINER_UP_READING = "s.environments.prod.rebuild = 'PASS'";
const CONTAINER_DOWN_READING = "s.environments.prod.rebuild = 'SKIP'";

/**
 * Why the container arm's `environments.prod` reading is no longer intact,
 * or `[]`. Same totality contract as `prPositionViolations`.
 */
export function containerArmRecordEnvViolations(src: string): string[] {
  const v: string[] = [];
  let extent: Extent;
  try {
    extent = containerArmExtent(src);
  } catch (e) {
    return [`the container conditional could not be located: ${(e as Error).message}`];
  }

  const code = codeView(src);
  const ifArm = code.slice(extent.ifArm.start, extent.ifArm.end);

  if (!ifArm.includes(RECORD_ENV_LABEL)) {
    v.push(`the container arm no longer spawns its own \`${RECORD_ENV_LABEL}\` step`);
  }
  if (!ifArm.includes(CONTAINER_UP_READING)) {
    v.push("the container arm no longer records the container-up reading");
  }
  if (!ifArm.includes(CONTAINER_DOWN_READING)) {
    v.push("the container arm no longer records the container-down reading");
  }
  if (ifArm.includes(PR_CALL)) {
    v.push(`the container arm has a \`${PR_CALL}\` command folded back into it`);
  }

  if (!extent.elseArm) {
    v.push("the no-container arm is gone, so nothing records environments.prod when there is no container");
  } else {
    const elseArm = code.slice(extent.elseArm.start, extent.elseArm.end);
    if (!elseArm.includes(RECORD_ENV_LABEL)) {
      v.push(`the no-container arm no longer spawns its own \`${RECORD_ENV_LABEL}\` step`);
    }
    if (elseArm.includes(PR_CALL)) {
      v.push(`the no-container arm has a \`${PR_CALL}\` command folded back into it — this is #254`);
    }
  }

  return v;
}

// ── the mutants ─────────────────────────────────────────────────────────────

/** The PR step's extent in the RAW source, asserted to be a single site. */
function prStepExtent(src: string): Extent0 {
  const occurrences = src.split(PR_STEP_START).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the PR step signature appears ${occurrences} times, expected exactly 1. ` +
        "Either it was renamed, or a second copy exists and moving one would leave the other on every path.",
    );
  }
  const start = src.indexOf(PR_STEP_START);
  const end = src.indexOf(PR_STEP_END, start);
  if (end < 0) throw new Error("could not build the mutant: the PR step's terminator was not found after its signature");
  return { start, end: end + PR_STEP_END.length };
}

function moveStepInto(src: string, arm: "if" | "else"): string {
  const step = prStepExtent(src);
  const text = src.slice(step.start, step.end);
  const without = `${src.slice(0, step.start)}${src.slice(step.end)}`;
  const extent = containerArmExtent(without);
  const target = arm === "if" ? extent.ifArm : extent.elseArm;
  if (!target) throw new Error(`could not build the mutant: there is no ${arm} arm to move the PR step into`);
  const insertAt = target.end - 1;
  const mutant = `${without.slice(0, insertAt)}  ${text}${without.slice(insertAt)}`;
  if (mutant === src) throw new Error(`could not build the mutant: moving the PR step into the ${arm} arm changed nothing`);
  return mutant;
}

/** The defect itself: the PR step back inside `else`, exactly where it was. */
export function prStepMovedIntoElseArmMutant(src: string): string {
  return moveStepInto(src, "else");
}

/** The arm the issue text never mentions. A check written only against
 *  `else` passes this one, which is why it is here. */
export function prStepMovedIntoIfArmMutant(src: string): string {
  return moveStepInto(src, "if");
}

/** No call site at all, its explanatory comment left behind. */
export function prStepDeletedMutant(src: string): string {
  const step = prStepExtent(src);
  const mutant = `${src.slice(0, step.start)}prStep = null // MUTANT: the step is gone, the comment above it is not\n${src.slice(step.end)}`;
  if (codeView(mutant).includes(PR_CALL)) {
    throw new Error(`could not build the mutant: an executable ${PR_CALL} survived the deletion`);
  }
  return mutant;
}

/** The hoist done carelessly: the container arm's whole spawn folded away,
 *  so the PR step is the only thing left on that path. */
export function recordEnvStrippedFromContainerArmMutant(src: string): string {
  const extent = containerArmExtent(src);
  const arm = src.slice(extent.ifArm.start, extent.ifArm.end);
  if (!arm.includes(RECORD_ENV_LABEL)) {
    throw new Error(`could not build the mutant: the container arm has no ${RECORD_ENV_LABEL} to strip`);
  }
  const gutted = arm.replace(RECORD_ENV_LABEL, "label: 'noop'");
  return `${src.slice(0, extent.ifArm.start)}${gutted}${src.slice(extent.ifArm.end)}`;
}

/** Only the container-up reading left. The half a label check cannot see. */
export function containerDownReadingStrippedMutant(src: string): string {
  if (!src.includes(CONTAINER_DOWN_READING)) {
    throw new Error(`could not build the mutant: ${CONTAINER_DOWN_READING} appears 0 times`);
  }
  return src.replace(CONTAINER_DOWN_READING, "s.environments.prod.rebuild = 'PASS'");
}

// ── the cases ───────────────────────────────────────────────────────────────

describe("#254 AC-1: the PR step sits outside the container conditional", () => {
  test("the real workflows/ship.js has no position violations", () => {
    expect(prPositionViolations(SHIP_SRC)).toEqual([]);
  });

  test("the conditional's brace extent is measured, not assumed", () => {
    const extent = containerArmExtent(SHIP_SRC);
    expect(extent.end).toBeGreaterThan(extent.start);
    expect(extent.elseArm, "the no-container arm vanished").not.toBeNull();
    // The braces matched belong to the conditional, not to something a
    // literal smuggled in: the masked view's extent must begin and end on
    // real punctuation.
    const masked = braceView(SHIP_SRC);
    expect(masked[extent.ifArm.start]).toBe("{");
    expect(masked[extent.end - 1]).toBe("}");
  });

  test("the executable call site is inside the Ship phase and ahead of the ship gate", () => {
    const code = codeView(SHIP_SRC);
    const call = code.indexOf(PR_CALL);
    expect(call, `no executable ${PR_CALL} in ship.js`).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(code.indexOf(SHIP_PHASE));
    expect(code.indexOf(SHIP_GATE_LOG)).toBeGreaterThan(call);
    expect(call).toBeGreaterThan(containerArmExtent(SHIP_SRC).end);
  });

  test("the step's label does not claim to record an environment any more", () => {
    expect(codeView(SHIP_SRC)).toContain(PR_STEP_LABEL);
    expect(codeView(SHIP_SRC)).not.toContain("record-env-and-pr");
  });
});

describe("#254 AC-2: the position check refuses every mutant that puts it back", () => {
  test("mutant: the PR step moved back into the else arm is refused", () => {
    expect(prPositionViolations(SHIP_SRC), "the real source must pass, or this proves nothing").toEqual([]);
    const mutant = prStepMovedIntoElseArmMutant(SHIP_SRC);
    const v = prPositionViolations(mutant);
    expect(v.join(" | ")).toContain("inside the container conditional's `else` arm");
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  test("mutant: the PR step moved into the if arm is refused too", () => {
    expect(prPositionViolations(SHIP_SRC)).toEqual([]);
    const mutant = prStepMovedIntoIfArmMutant(SHIP_SRC);
    expect(prPositionViolations(mutant).join(" | ")).toContain("inside the container conditional's `if` arm");
  });

  test("mutant: deleting the step leaves the comment, and the comment does not count", () => {
    expect(prPositionViolations(SHIP_SRC)).toEqual([]);
    const mutant = prStepDeletedMutant(SHIP_SRC);
    // The mutation, asserted rather than assumed: zero executable call sites,
    // and the prose that used to stand in for one still present.
    expect(codeView(mutant).includes(PR_CALL)).toBe(false);
    expect(mutant).toContain("create-pr");
    expect(prPositionViolations(mutant).join(" | ")).toContain("no executable");
  });

  test("mutant: a brace counter reading literals would mis-measure, so one is not used", () => {
    // The braces inside the agent prompts and `bun -e "…"` strings are visible
    // to the default view and invisible to the masked one. If they ever stop
    // being equal in count, a naive counter silently measures a different span
    // — this records the difference rather than trusting it stays zero.
    const naive = (s: string) => (s.split("{").length - 1) - (s.split("}").length - 1);
    expect(naive(braceView(SHIP_SRC))).toBe(0);
    const extent = containerArmExtent(SHIP_SRC);
    const literalBraces = codeView(SHIP_SRC).slice(extent.start, extent.end).split("{").length
      - braceView(SHIP_SRC).slice(extent.start, extent.end).split("{").length;
    expect(literalBraces, "literals inside the conditional carry braces the masked view correctly hides")
      .toBeGreaterThan(0);
  });
});

describe("#254 AC-3: the proof rests on more than one mutant", () => {
  test("the file declares at least three distinct mutant-construction sites", () => {
    const self = readFileSync(SELF_PATH, "utf-8");
    const builders = [...self.matchAll(/^export function (\w*Mutant)\(/gm)].map(m => m[1]);
    expect(new Set(builders).size).toBeGreaterThanOrEqual(3);
    // Named, so a reader can see which five and a diff can see one go missing.
    expect(builders.sort()).toEqual([
      "containerDownReadingStrippedMutant",
      "prStepDeletedMutant",
      "prStepMovedIntoElseArmMutant",
      "prStepMovedIntoIfArmMutant",
      "recordEnvStrippedFromContainerArmMutant",
    ]);
  });

  test("every mutant builder aborts rather than silently changing nothing", () => {
    // A harness that no-ops when its target moves is the decorative check
    // .claude/rules/checks-must-be-able-to-fail.md is about. Feed each builder
    // a source its target is absent from and require a throw.
    const builders = [
      prStepMovedIntoElseArmMutant,
      prStepMovedIntoIfArmMutant,
      prStepDeletedMutant,
      recordEnvStrippedFromContainerArmMutant,
      containerDownReadingStrippedMutant,
    ];
    const renamed = SHIP_SRC
      .split(PR_STEP_START).join("prStep = await someOtherSpawn(`")
      .split(RECORD_ENV_LABEL).join("label: 'renamed'")
      .split(CONTAINER_DOWN_READING).join("s.environments.prod.teardown = 'SKIP'");
    for (const build of builders) {
      expect(() => build(renamed), `${build.name} did not abort on a renamed source`).toThrow();
    }
  });
});

describe("#254 AC-4: the container arm keeps its own record-env step", () => {
  test("the real workflows/ship.js has no record-env violations", () => {
    expect(containerArmRecordEnvViolations(SHIP_SRC)).toEqual([]);
  });

  test("both arms spawn their own record-env step and neither opens a PR", () => {
    const extent = containerArmExtent(SHIP_SRC);
    const code = codeView(SHIP_SRC);
    const ifArm = code.slice(extent.ifArm.start, extent.ifArm.end);
    const elseArm = code.slice(extent.elseArm!.start, extent.elseArm!.end);
    for (const [name, arm] of [["if", ifArm], ["else", elseArm]] as const) {
      expect(arm, `${name} arm lost its record-env spawn`).toContain(RECORD_ENV_LABEL);
      expect(arm.includes(PR_CALL), `${name} arm opens a PR`).toBe(false);
    }
    expect(ifArm).toContain(CONTAINER_UP_READING);
    expect(ifArm).toContain(CONTAINER_DOWN_READING);
    expect(elseArm).toContain("rebuildSkipReason:'no container'");
  });

  test("mutant: folding the container arm's record-env step away is refused", () => {
    expect(containerArmRecordEnvViolations(SHIP_SRC)).toEqual([]);
    const mutant = recordEnvStrippedFromContainerArmMutant(SHIP_SRC);
    expect(containerArmRecordEnvViolations(mutant).join(" | "))
      .toContain("no longer spawns its own");
  });

  test("mutant: dropping the container-down record-env reading is refused", () => {
    expect(containerArmRecordEnvViolations(SHIP_SRC)).toEqual([]);
    const mutant = containerDownReadingStrippedMutant(SHIP_SRC);
    expect(containerArmRecordEnvViolations(mutant))
      .toEqual(["the container arm no longer records the container-down reading"]);
  });

  test("mutant: a PR command folded into the container arm is refused by the record-env check as well", () => {
    const mutant = prStepMovedIntoIfArmMutant(SHIP_SRC);
    expect(containerArmRecordEnvViolations(mutant).join(" | ")).toContain("folded back into it");
  });
});
