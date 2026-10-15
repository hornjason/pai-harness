/**
 * The Phase 2 issue carries the ACs it was given (#79).
 *
 * Covers SC-1484, SC-1485, SC-1486, SC-1487, SC-1488 (HARNESS-STANDARD.md).
 *
 * The failure this exists for: on #70 the decompose step's structured AC list
 * and the prose body it wrote for #75 disagreed completely. The body
 * described AC-7/8/9 as doc-path cleanup — a restatement of AC-5, already in
 * Phase 1 — while the ACs the issue actually carried were about `roles.json`
 * and `hooks.json` being written empty for every greenfield consumer. Both
 * halves were internally plausible: the ids lined up, the spec cited was
 * real, the line numbers were real. Whoever picked up #75 would have re-fixed
 * Phase 1's work and closed the parent, losing the defect that opened it.
 *
 * So the id check alone is not the test — #75 would have passed it. The
 * statement comparison is the load-bearing half, and the #75 body is used
 * here verbatim as the case that must be caught.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  acListBlock,
  acsForGroup,
  decompositionRefusal,
  phase2AcsCommand,
  phase2BodyViolations,
  shellSingleQuote,
  SC_HEADING,
  type DecomposedAc,
} from "../lib/phase2-decomposition";
import { verifyPhase2, readPlan, readSplitPlan, REFUSE_EXIT } from "../scripts/verify-phase2-bodies";
import { enclosingChain } from "../lib/reachability";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "verify-phase2-bodies.ts");

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "rg-phase2-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** #70's real ACs, as discovery produced them. */
const AC7: DecomposedAc = {
  id: "AC-7",
  statement: "A greenfield scaffold writes a `roles.json` with at least three agent role entries that survive a read-back",
  specElement: "SC-484",
};
const AC8: DecomposedAc = {
  id: "AC-8",
  statement: "Hook registrations stored in `hooks.json` drive consumer hook deployment under the directory layout",
  specElement: "SC-485",
};
const PHASE1: DecomposedAc[] = [
  { id: "AC-1", statement: "the loader reads both layouts" },
  { id: "AC-5", statement: "`.claude/rules/harness-managed.md` points at `.claude/rungate/config.json`" },
];
const ALL = [...PHASE1, AC7, AC8];

/** A body that carries its ACs. */
function goodBody(acs: DecomposedAc[]): string {
  return [
    "Parent: #70",
    "Spec: specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md — Phase 2",
    "",
    "Greenfield consumers get an empty roles.json and hooks.json.",
    "",
    SC_HEADING,
    "",
    ...acs.map(a => `- [ ] ${a.id}: ${a.statement}`),
    "",
    "## Dependencies",
    "Requires Phase 1 (#70).",
  ].join("\n");
}

/** The body #75 actually got — the defect, reproduced. */
const BODY_75 = [
  "Parent: #70",
  "Spec: specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md — Phase 2",
  "",
  "Deferred scope — stale `.claude/rungate.json` customization path cleanup, the last Phase 2 item",
  "of CONFIG-DIRECTORY-STRUCTURE-SPEC (SC-484..SC-487 follow-through)",
  "",
  SC_HEADING,
  "",
  "- [ ] AC-7: `.claude/rules/harness-managed.md` points at `.claude/rungate/config.json`",
  "- [ ] AC-8: The generated workflow headers stop carrying the stale path",
  "",
  "## Dependencies",
  "Requires Phase 1 (#70).",
].join("\n");

// ── SC-1484 ─────────────────────────────────────────────────────────────────

describe("SC-1484: the structured decomposition is refused when it loses or duplicates an AC", () => {
  test("a sound split is accepted", () => {
    expect(decompositionRefusal(ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-7", "AC-8"] }])).toEqual([]);
  });

  test("an AC in Phase 1 AND deferred is flagged — #79 AC-3", () => {
    const out = decompositionRefusal(ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-5", "AC-7", "AC-8"] }]);
    expect(out.join(" | ")).toContain("AC-5 is in Phase 1 AND deferred to #75");
  });

  test("an AC in neither is flagged, which is the silent half", () => {
    // Every count the run prints still adds up when this happens.
    const out = decompositionRefusal(ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-7"] }]);
    expect(out.join(" | ")).toContain("AC-8 was neither kept nor deferred");
  });

  test("two groups claiming one AC is flagged", () => {
    const out = decompositionRefusal(ALL, ["AC-1", "AC-5"], [
      { number: 75, acIds: ["AC-7", "AC-8"] },
      { number: 76, acIds: ["AC-8"] },
    ]);
    expect(out.join(" | ")).toContain("AC-8 is claimed by #75 and #76");
  });

  test("an id nothing produced is flagged from either side", () => {
    expect(decompositionRefusal(ALL, ["AC-99"], [{ number: 75, acIds: ["AC-7", "AC-8"] }]).join(" | "))
      .toContain("Phase 1 keeps AC-99, which discovery never produced");
    expect(decompositionRefusal(ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-7", "AC-8", "AC-99"] }]).join(" | "))
      .toContain("#75 claims AC-99");
  });

  test("deferring everything is a refusal, not a decomposition", () => {
    const out = decompositionRefusal(ALL, [], [{ number: 75, acIds: ["AC-1", "AC-5", "AC-7", "AC-8"] }]);
    expect(out.join(" | ")).toContain("no AC was kept for Phase 1");
  });

  test("a group created carrying nothing is flagged", () => {
    const out = decompositionRefusal(ALL, ["AC-1", "AC-5", "AC-7", "AC-8"], [{ number: 75, acIds: [] }]);
    expect(out.join(" | ")).toContain("#75 was created carrying no ACs");
  });

  test("an AC matched by specElement counts as placed", () => {
    // The control for the "neither kept nor deferred" case. The decompose
    // agent returns either format, and treating an SC id as unplaced would
    // refuse every sound split that used one.
    expect(decompositionRefusal(ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["SC-484", "SC-485"] }])).toEqual([]);
  });

  test("every problem is reported, not the first", () => {
    const out = decompositionRefusal(ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-5"] }]);
    expect(out.length, "a second round would discover what the first did not report").toBeGreaterThan(1);
  });
});

// ── SC-1485 ─────────────────────────────────────────────────────────────────

describe("SC-1485: a body is compared to the ACs it carries, statement by statement", () => {
  test("a body carrying its ACs verbatim passes", () => {
    expect(phase2BodyViolations(goodBody([AC7, AC8]), [AC7, AC8])).toEqual([]);
  });

  test("#75's real body is caught", () => {
    // The whole issue. Its ids are right and its work is different.
    const out = phase2BodyViolations(BODY_75, [AC7, AC8]);
    expect(out.length).toBe(2);
    expect(out.join(" | ")).toContain("AC-7's statement is not carried verbatim");
    expect(out.join(" | ")).toContain("AC-8's statement is not carried verbatim");
  });

  test("the id check ALONE would have passed #75", () => {
    // Stated as a test because it is the reason the statement comparison
    // exists. A fix that only checked ids would read as complete.
    const flat = BODY_75.replace(/\s+/g, " ");
    expect(flat).toContain("AC-7");
    expect(flat).toContain("AC-8");
  });

  test("a missing AC is caught", () => {
    expect(phase2BodyViolations(goodBody([AC7]), [AC7, AC8]).join(" | "))
      .toContain("AC-8 is in the deferred list and not in the body");
  });

  test("an AC the body adds is caught", () => {
    expect(phase2BodyViolations(goodBody([AC7, AC8, PHASE1[1]!]), [AC7, AC8]).join(" | "))
      .toContain("lists AC-5, which was not deferred to this issue");
  });

  test("a wrapped statement is the same statement", () => {
    // The control for the comparison being too strict. Markdown wraps; a
    // check that called a line break a mismatch would be rewritten looser by
    // the first person it blocked.
    const wrapped = goodBody([AC7]).replace(AC7.statement, AC7.statement.replace(" with at least", "\n  with at least"));
    expect(phase2BodyViolations(wrapped, [AC7])).toEqual([]);
  });

  test("a paraphrase is NOT the same statement", () => {
    const soft = goodBody([AC7]).replace("at least three", "at least 3");
    expect(phase2BodyViolations(soft, [AC7]).join(" | ")).toContain("not carried verbatim");
  });

  test("only the Success Criteria section counts", () => {
    // An AC quoted in passing elsewhere must not satisfy the check — that is
    // how a body about different work keeps its ids.
    const body = [
      "Parent: #70",
      "",
      `Prose mentioning AC-7: ${AC7.statement}`,
      "",
      SC_HEADING,
      "",
      "- [ ] AC-7: something else entirely",
      "",
      "## Dependencies",
    ].join("\n");
    expect(phase2BodyViolations(body, [AC7]).join(" | ")).toContain("not carried verbatim");
  });

  test("an absent section, an empty body and no ACs each refuse rather than pass", () => {
    expect(phase2BodyViolations("no headings here", [AC7]).join(" | ")).toContain("no \"## Success Criteria\" section");
    expect(phase2BodyViolations("   ", [AC7]).join(" | ")).toContain("the issue body is empty");
    expect(phase2BodyViolations(goodBody([AC7]), []).join(" | ")).toContain("no ACs were supplied");
  });

  test("acsForGroup resolves by id or by specElement, and nothing else", () => {
    expect(acsForGroup(ALL, { acIds: ["AC-7"] })).toEqual([AC7]);
    expect(acsForGroup(ALL, { acIds: ["SC-485"] })).toEqual([AC8]);
    expect(acsForGroup(ALL, { acIds: [] })).toEqual([]);
  });
});

// ── SC-1486 ─────────────────────────────────────────────────────────────────

describe("SC-1486: the verifier reads the issue back rather than trusting the report", () => {
  const plan = {
    phase1AcIds: ["AC-1", "AC-5"],
    acs: ALL,
    subIssues: [{ number: 75, phase: "Phase 2", acIds: ["AC-7", "AC-8"] }],
  };

  test("a good issue passes and is counted as checked", async () => {
    const v = await verifyPhase2(plan, async () => goodBody([AC7, AC8]));
    expect(v.ok).toBe(true);
    expect(v.checked, "a verdict over zero issues is not a pass").toBe(1);
  });

  test("#75's body refuses", async () => {
    const v = await verifyPhase2(plan, async () => BODY_75);
    expect(v.ok).toBe(false);
    expect(v.violations.join(" | ")).toContain("#75: AC-7's statement is not carried verbatim");
  });

  test("an unreadable issue is a violation, not a pass", async () => {
    const v = await verifyPhase2(plan, async () => { throw new Error("404"); });
    expect(v.ok).toBe(false);
    expect(v.checked, "an issue that could not be read was not checked").toBe(0);
    expect(v.violations.join(" | ")).toContain("could not be read back");
  });

  test("a group with no number is a sub-issue that was never created", async () => {
    const v = await verifyPhase2({ ...plan, subIssues: [{ phase: "Phase 2", acIds: ["AC-7", "AC-8"] }] }, async () => goodBody([AC7, AC8]));
    expect(v.violations.join(" | ")).toContain("has no issue number — it was never created");
  });

  test("the structural refusals run too, so one call covers both halves", async () => {
    const v = await verifyPhase2(
      { ...plan, subIssues: [{ number: 75, acIds: ["AC-5", "AC-7", "AC-8"] }] },
      async () => goodBody([PHASE1[1]!, AC7, AC8]),
    );
    expect(v.violations.join(" | ")).toContain("AC-5 is in Phase 1 AND deferred");
  });

  test("readPlan refuses a malformed plan rather than verifying nothing", () => {
    const bad = join(scratch, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => readPlan(bad)).toThrow(/not valid JSON/);
  });
});

// ── SC-1486 (continued): the split-file form and the prompt ─────────────────

describe("SC-1486: the reference copy of the ACs does not pass through the model", () => {
  test("readSplitPlan takes the ACs from one file and the grouping from the other", () => {
    const acsPath = join(scratch, "acs.json");
    const groupingPath = join(scratch, "grouping.json");
    writeFileSync(acsPath, JSON.stringify([AC7, AC8]));
    writeFileSync(groupingPath, JSON.stringify({ phase1AcIds: ["AC-1"], subIssues: [{ number: 75, acIds: ["AC-7"] }] }));
    const plan = readSplitPlan(acsPath, groupingPath);
    expect(plan.acs).toEqual([AC7, AC8]);
    expect(plan.subIssues).toEqual([{ number: 75, acIds: ["AC-7"] }]);
  });

  test("an ACs file that is not an array refuses", () => {
    const acsPath = join(scratch, "acs-bad.json");
    const groupingPath = join(scratch, "grouping2.json");
    writeFileSync(acsPath, JSON.stringify({ id: "AC-7" }));
    writeFileSync(groupingPath, JSON.stringify({ phase1AcIds: [], subIssues: [] }));
    expect(() => readSplitPlan(acsPath, groupingPath)).toThrow(/not an array of ACs/);
  });

  test("the write command survives a statement full of shell metacharacters", () => {
    // AC statements routinely carry backticks and `$`. If the quoting breaks,
    // the reference file is wrong or absent and the comparison measures
    // nothing — the failure mode this whole module exists to prevent.
    const nasty: DecomposedAc = {
      id: "AC-9",
      statement: "`bunx tsc --noEmit` exits 0 and $PATH isn't \"touched\" — it's fine",
    };
    const cmd = phase2AcsCommand(ROOT, scratch, [nasty]);
    const r = spawnSync("sh", ["-c", cmd], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    const written = JSON.parse(readFileSync(join(scratch, "phase2-acs.json"), "utf-8"));
    expect(written[0].statement).toBe(nasty.statement);
  });

  test("shellSingleQuote closes, escapes and reopens on an apostrophe", () => {
    expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("acListBlock is the form the body is asked to copy", () => {
    expect(acListBlock([AC7])).toBe(`- [ ] ${AC7.id}: ${AC7.statement}`);
    // And a body built straight from it passes, which is the point of
    // giving the agent the exact shape rather than a description of it.
    const body = [SC_HEADING, "", acListBlock([AC7, AC8])].join("\n");
    expect(phase2BodyViolations(body, [AC7, AC8])).toEqual([]);
  });
});

// ── SC-1487: ship.js's inline copy matches the library ──────────────────────

const SHIP = join(ROOT, "workflows", "ship.js");
const BLOCK_START = "// ──── PHASE2-DECOMPOSITION-START ────";
const BLOCK_END = "// ──── PHASE2-DECOMPOSITION-END ────";

function inlineBlock(): Record<string, Function> {
  const src = readFileSync(SHIP, "utf-8");
  const a = src.indexOf(BLOCK_START);
  const b = src.indexOf(BLOCK_END);
  if (a < 0 || b < 0 || b < a) throw new Error("the PHASE2-DECOMPOSITION block is not in workflows/ship.js");
  const body = src.slice(a + BLOCK_START.length, b);
  return new Function(`${body}; return { acsForGroup, decompositionRefusal, shellSingleQuote, acListBlock, phase2AcsCommand }`)();
}

describe("SC-1487: ship.js's inline copy and the library agree", () => {
  const inline = inlineBlock();

  const MATRIX: Array<[string, readonly DecomposedAc[], string[], any[]]> = [
    ["a sound split", ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-7", "AC-8"] }]],
    ["duplicated into Phase 2", ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-5", "AC-7", "AC-8"] }]],
    ["one dropped", ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-7"] }]],
    ["two groups, one AC", ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["AC-7", "AC-8"] }, { number: 76, acIds: ["AC-8"] }]],
    ["unknown id", ALL, ["AC-99"], [{ number: 75, acIds: ["AC-7", "AC-8"] }]],
    ["nothing kept", ALL, [], [{ number: 75, acIds: ["AC-1", "AC-5", "AC-7", "AC-8"] }]],
    ["empty group", ALL, ["AC-1", "AC-5", "AC-7", "AC-8"], [{ number: 75, acIds: [] }]],
    ["by specElement", ALL, ["AC-1", "AC-5"], [{ number: 75, acIds: ["SC-484", "SC-485"] }]],
    ["no ACs at all", [], ["AC-1"], [{ number: 75, acIds: ["AC-7"] }]],
    ["no groups at all", ALL, ["AC-1", "AC-5", "AC-7", "AC-8"], []],
  ];

  for (const [name, acs, phase1, groups] of MATRIX) {
    test(`decompositionRefusal agrees: ${name}`, () => {
      expect(inline.decompositionRefusal!(acs, phase1, groups)).toEqual(decompositionRefusal(acs, phase1, groups));
    });
  }

  test("acsForGroup agrees", () => {
    expect(inline.acsForGroup!(ALL, { acIds: ["SC-485"] })).toEqual(acsForGroup(ALL, { acIds: ["SC-485"] }));
  });

  test("the quoting agrees, which is the half a wrong copy would break silently", () => {
    const s = "it's `backticked` and \"quoted\" with $VAR";
    expect(inline.shellSingleQuote!(s)).toBe(shellSingleQuote(s));
    expect(inline.acListBlock!([AC7])).toBe(acListBlock([AC7]));
    expect(inline.phase2AcsCommand!("/h", "/w", [AC7])).toBe(phase2AcsCommand("/h", "/w", [AC7]));
  });

  test("the decompose prompt lists the ACs and runs the verifier", () => {
    const src = readFileSync(SHIP, "utf-8");
    expect(src, "the prompt never showed the agent the statements it was asked to carry")
      .toContain("${acListBlock(discovery.acs)}");
    expect(src).toContain("bun scripts/verify-phase2-bodies.ts --repo ${ISSUE_REPO}");
    expect(src, "the structural refusal is not wired into the run").toContain("DECOMPOSITION_REFUSED");
  });

  test("the run refuses on a bad split rather than logging it", () => {
    // MEASURED: the first version of this grepped the 1200 characters after
    // the call site for `discoveryRefusal = shipFailed(` and `return false`.
    // Prefixing the assignment with `if (false) ` leaves BOTH strings in
    // place, so the mutation scored ZERO — a detector narrower than what it
    // detects, which is the second shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`. The decision is read
    // off the parse now (#204): the refusal and the `return` must be DIRECT
    // statements of the `splitViolations.length > 0` block, so nothing can
    // be nested under another condition without changing the chain.
    const src = readFileSync(SHIP, "utf-8");
    const anchor = "const splitViolations = decompositionRefusal(";
    expect(src.split(anchor).length - 1, "the call site is gone or duplicated").toBe(1);

    const assignAt = src.indexOf("discoveryRefusal = shipFailed(", src.indexOf(anchor));
    expect(assignAt, "the refusal assignment is gone").toBeGreaterThan(0);
    const assignChain = enclosingChain(src, assignAt, assignAt + "discoveryRefusal = shipFailed(".length);

    const guardAt = src.indexOf("if (splitViolations.length > 0) {");
    expect(guardAt, "the guard is gone").toBeGreaterThan(0);
    const guardChain = enclosingChain(src, guardAt, guardAt + 10);

    // Exactly ONE conditional deeper than the guard's own nesting — the
    // guard itself. `if (false) <assignment>` adds a second, which is the
    // mutation a text grep could not see.
    const ifs = (chain: string[]) => chain.filter(t => t === "IfStatement").length;
    expect(assignChain.slice(0, guardChain.length)).toEqual(guardChain);
    expect(
      ifs(assignChain),
      `the refusal is nested under a condition the guard does not have — chain ${assignChain.join(" > ")}`,
    ).toBe(ifs(guardChain) + 1);

    const returnAt = src.indexOf("return false", assignAt);
    const returnChain = enclosingChain(src, returnAt, returnAt + "return false".length);
    expect(returnChain.slice(0, guardChain.length)).toEqual(guardChain);
    expect(ifs(returnChain), `the return is conditional — chain ${returnChain.join(" > ")}`)
      .toBe(ifs(guardChain) + 1);
  });
});

// ── SC-1488 ─────────────────────────────────────────────────────────────────

/**
 * The script's refusal is proved by removing it, per
 * `.claude/rules/checks-must-be-able-to-fail.md`: every negative case runs
 * twice — the real script and a mutant whose `REFUSE_EXIT` is 0 — and
 * asserts the real one refuses while the mutant does not.
 */
const SIGNATURE = "export const REFUSE_EXIT = 1;";

function buildMutant(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const count = src.split(SIGNATURE).length - 1;
  if (count !== 1) {
    throw new Error(`could not build the mutant: the exit-code signature appears ${count} times`);
  }
  // Relative imports would not resolve from a temp directory, and a mutant
  // that dies on module resolution exits non-zero — which reads as the
  // mutation having been rejected on the merits.
  const rewritten = src
    .replace(SIGNATURE, "export const REFUSE_EXIT = 0;")
    .replace(/from "\.\.\/(lib|scripts)\//g, `from "${join(ROOT)}/$1/`);
  const unresolved = rewritten.match(/from "\.{1,2}\//g);
  if (unresolved) {
    throw new Error(`could not build the mutant: ${unresolved.length} relative import(s) left`);
  }
  const path = join(scratch, "mutant-verify.ts");
  writeFileSync(path, rewritten);
  return path;
}

function runScript(script: string, planPath: string): { status: number | null; out: string } {
  const r = spawnSync("bun", [script, "--repo", "o/n", "--plan", planPath], {
    cwd: scratch,
    encoding: "utf-8",
    env: { ...process.env, GH_TOKEN: "" },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("SC-1488: the script's refusal is removable, and removing it is observed", () => {
  test("the exit-code constant appears exactly once", () => {
    expect(readFileSync(SCRIPT, "utf-8").split(SIGNATURE).length - 1).toBe(1);
  });

  test("a malformed plan refuses in the real script and not in the mutant", () => {
    const planPath = join(scratch, "malformed.json");
    writeFileSync(planPath, "{ not json");

    const real = runScript(SCRIPT, planPath);
    expect(real.status, "the real script accepted a plan it could not parse").toBe(REFUSE_EXIT);
    expect(real.out).toContain("not valid JSON");

    const mutant = runScript(buildMutant(), planPath);
    expect(mutant.status, "zeroing REFUSE_EXIT changed nothing — the refusal was not routed through it").toBe(0);
  });

  test("missing flags exit 2, which is not the refusal path", () => {
    // A usage error and a violation must not be the same signal: a caller
    // that typoed a flag would otherwise read as a clean verification.
    const r = spawnSync("bun", [SCRIPT], { cwd: scratch, encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("usage:");
  });

  test("the script prints a receipt on stdout even when it refuses", () => {
    const planPath = join(scratch, "malformed2.json");
    writeFileSync(planPath, "nope");
    const real = runScript(SCRIPT, planPath);
    const line = real.out.split("\n").find(l => l.trim().startsWith("{"));
    expect(line, "a refusal with no receipt cannot be read by the caller").toBeDefined();
    expect(JSON.parse(line!).ok).toBe(false);
  });
});
