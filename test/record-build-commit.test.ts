import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { assertMarkedBlockReachable, enclosingChain } from "../lib/reachability";
import {
  PRESERVED_VERDICTS,
  PRESERVE_MEASURED_ENVIRONMENTS,
  REFUSE_EXIT,
  buildLocalEnvironment,
  buildMarcusRecord,
} from "../scripts/record-build-commit";

/**
 * scripts/record-build-commit.ts — the commit step's state write stops being
 * an unobserved side effect (#166).
 *
 * `workflows/ship.js` told the commit agent, as step 3 of 3, to run a `bun -e`
 * one-liner setting `buildCommit` and `agents`. The schema it answered with
 * asked only for `{branch, commitSha, pushed}`. So an agent could commit,
 * push, answer correctly, and never run step 3 — and the workflow read that as
 * a fully successful commit. On `wf_b5f65252-24f` it did exactly that, and the
 * ship gate refused the run six agents later with "neither buildCommit nor
 * agents.marcus.branch present". Two earlier runs had the fields, so the
 * failure is intermittent, which is worse than always-broken.
 *
 * The second defect was in the one-liner itself: `s.agents = {marcus, quinn}`
 * is an assignment. It is safe today only because it runs before rook does.
 * #161 made `agents.rook` the record of whether security ran, so anything
 * re-running that write after the Verify phase erases it and the run reaches
 * the PR step with no security record.
 *
 * Executed against real files rather than asserted on source text: every
 * mutation that survived a first pass in session 34 was a source-text
 * assertion.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-build-commit.ts");
const SHA = "dd242a62aea9371d788abb58f3d26922d5dd6cbc";

let DIR = "";
let STATE = "";
let MUTANT = "";
/** Every mutant copy written into scripts/ by this file, cleaned in afterEach. */
let MUTANTS: string[] = [];

/**
 * A copy of the real script in scripts/ with one line changed, or a thrown
 * error if that line is no longer there.
 *
 * The same harness `MUTANT` uses, generalised for #173. Each negative property
 * below is asserted twice — once that the real script has it, once that a
 * script differing only in the line that implements it does NOT. Without the
 * second half, "quinn's FAIL is still FAIL" is satisfied by a script that
 * writes nothing at all (.claude/rules/checks-must-be-able-to-fail.md).
 *
 * It lives beside the real script, not in a temp dir, because this script
 * imports `../gates/orchestrator`.
 */
function makeMutant(label: string, find: RegExp, replace: string): string {
  const source = readFileSync(SCRIPT, "utf-8");
  const mutated = source.replace(find, replace);
  if (mutated === source) {
    throw new Error(
      `could not build the "${label}" mutant: ${find} no longer matches ` +
        `scripts/record-build-commit.ts, so this test proves nothing`,
    );
  }
  const path = join(REPO_ROOT, "scripts", `.record-build-commit.${label}.mutant.ts`);
  writeFileSync(path, mutated);
  MUTANTS.push(path);
  return path;
}

/** The smallest workflow-state.json that writeWorkflowState will accept. */
function baseState(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    issue: 166,
    slug: "pai-harness-166",
    phase: "BUILD",
    issueGoal: "the commit step's state write is observed",
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "buildCommit is present in workflow-state.json after the commit step",
        threshold: { op: "==", value: 0, unit: "exit code" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "record-build-commit-"));
  STATE = join(DIR, "workflow-state.json");
  writeFileSync(STATE, JSON.stringify(baseState(), null, 2));

  // The mutant: the same script with its one refusal exit code set to 0.
  // Every refusal case below runs against both, and asserts the real script
  // refuses while the mutant does not — so a case that starts passing for an
  // unrelated reason cannot be mistaken for a case that is genuinely caught
  // (.claude/rules/checks-must-be-able-to-fail.md).
  //
  // It lives in scripts/, not in the temp dir, because this script imports
  // `../gates/orchestrator`. From a temp directory that import does not
  // resolve, bun exits 1, and every mutant run reads as "the refusal was
  // rejected on the merits" — the precise false pass the rule warns about,
  // observed while writing this. Removed in afterEach, and
  // `no mutant is left behind` asserts it.
  const source = readFileSync(SCRIPT, "utf-8");
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/record-build-commit.ts");
  }
  MUTANT = join(REPO_ROOT, "scripts", ".record-build-commit.mutant.ts");
  writeFileSync(MUTANT, mutated);
  MUTANTS = [MUTANT];
});

afterEach(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
  for (const m of MUTANTS) rmSync(m, { force: true });
  MUTANTS = [];
});

function run(args: string[], script = SCRIPT) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function readState() {
  return JSON.parse(readFileSync(STATE, "utf-8"));
}

const OK = ["--state", "", "--sha", SHA, "--branch", "ship-166", "--quinn", "SKIP"];
function okArgs(state = STATE) {
  const a = [...OK];
  a[1] = state;
  return a;
}

describe("the commit reaches workflow-state.json", () => {
  test("buildCommit and agents.marcus are written", () => {
    const r = run(okArgs());
    expect(r.code, r.err).toBe(0);
    const s = readState();
    expect(s.buildCommit).toBe(SHA);
    expect(s.agents.marcus.branch).toBe("ship-166");
    expect(s.agents.marcus.commitSha).toBe(SHA);
    expect(s.agents.marcus.spawned).toBe(true);
  });

  test("the receipt names what it wrote", () => {
    const r = run(okArgs());
    const receipt = JSON.parse(r.out.trim().split("\n").pop()!);
    expect(receipt.ok).toBe(true);
    expect(receipt.buildCommit).toBe(SHA);
  });

  test("quinn's verdict comes from the caller, not from a guess", () => {
    const a = okArgs();
    a[a.indexOf("--quinn") + 1] = "PASS";
    expect(run(a).code).toBe(0);
    expect(readState().agents.quinn).toEqual({ spawned: true, verdict: "PASS" });

    writeFileSync(STATE, JSON.stringify(baseState(), null, 2));
    expect(run(okArgs()).code).toBe(0);
    expect(readState().agents.quinn).toEqual({ spawned: false, verdict: "SKIP" });
  });
});

describe("#166: the write merges, it does not replace", () => {
  // The latent half. `s.agents = {marcus, quinn}` erases everything else in
  // `agents`, and since #161 the thing it erases is the record of whether the
  // security review ran at all.
  test("an existing agents.rook survives", () => {
    const rook = {
      spawned: true,
      verdict: "FAIL",
      failures: ["HIGH: guard bypass"],
      testedSha: SHA,
      testedPaths: ["workflows/ship.js"],
    };
    writeFileSync(STATE, JSON.stringify(baseState({ agents: { rook } }), null, 2));

    expect(run(okArgs()).code).toBe(0);
    const s = readState();
    expect(s.agents.rook, "the security record was erased by the commit step").toEqual(rook);
    expect(s.agents.marcus.branch).toBe("ship-166");
  });

  test("buildMarcusRecord leaves other agents alone", () => {
    const before = { rook: { spawned: true, verdict: "PASS" } };
    const after = buildMarcusRecord(before, SHA, "ship-166", "SKIP");
    expect(after.rook).toEqual(before.rook);
    expect(after.marcus).toBeDefined();
    // The input is not mutated — a caller holding the old object must not see
    // it change under them.
    expect(before).toEqual({ rook: { spawned: true, verdict: "PASS" } });
  });
});

/**
 * #173 — SC-587, SC-588, SC-589, SC-590.
 *
 * The recorder does not only record a commit. It also writes `agents.quinn`
 * and the whole of `environments.local`, and two of the values it wrote were
 * constants rather than measurements: `environments.local.tests` was the
 * literal string `PASS`, and quinn's verdict reached it from ship.js as
 * `ceremonyTier !== 'LIGHT' ? 'PASS' : 'SKIP'` — the tier, not the agent.
 *
 * `environments.local` was an assignment, so a measured `tests: "FAIL"` was
 * replaced by the constant, and the `tests-pass` check in gates/workflow.test.ts
 * reads exactly that field. #169 adds two call sites that run AFTER quinn, so
 * both overwrites stop being latent.
 */
describe("#173: the recorder records measurements, it does not invent them", () => {
  test("tests verdict is not invented", () => {
    // SC-587. A real test result is in the file before the commit step runs;
    // the commit step has not run any tests and must not say that it did.
    writeFileSync(
      STATE,
      JSON.stringify(baseState({ environments: { local: { tests: "FAIL", api: "SKIP", ui: "SKIP" } } }), null, 2),
    );
    expect(run(okArgs()).code).toBe(0);
    expect(
      readState().environments.local.tests,
      "a measured test failure was overwritten by the commit step",
    ).toBe("FAIL");

    // And with nothing measured, the field stays absent rather than becoming
    // a PASS nobody earned. `tests-pass` treats absent as "not set" and says
    // so; it treats PASS as a green suite.
    writeFileSync(STATE, JSON.stringify(baseState(), null, 2));
    expect(run(okArgs()).code).toBe(0);
    expect(readState().environments.local.tests).toBeUndefined();

    // The mutation, run on every suite rather than described in a PR: put the
    // constant back and the first assertion above stops holding.
    const mutant = makeMutant("tests-constant", /\/\/ #173-NO-TESTS-VERDICT\b/, 'tests: "PASS",');
    writeFileSync(
      STATE,
      JSON.stringify(baseState({ environments: { local: { tests: "FAIL", api: "SKIP", ui: "SKIP" } } }), null, 2),
    );
    expect(run(okArgs(), mutant).code).toBe(0);
    expect(
      readState().environments.local.tests,
      "the mutant that re-adds the hardcoded verdict did NOT overwrite the measurement — " +
        "the test above passes for some other reason",
    ).toBe("PASS");
  });

  test("the rest of environments.local merges rather than being replaced", () => {
    // SC-588. Same shape as agents: an assignment erases whatever the Verify
    // phase measured and this script was never told about.
    writeFileSync(
      STATE,
      JSON.stringify(
        baseState({ environments: { local: { tests: "PASS", quinn: { port: 4321 } }, prod: { smoke: "PASS" } } }),
        null,
        2,
      ),
    );
    expect(run(okArgs()).code).toBe(0);
    const s = readState();
    expect(s.environments.local.quinn).toEqual({ port: 4321 });
    expect(s.environments.prod).toEqual({ smoke: "PASS" });
    // #176: `api` used to default to "SKIP" here. A caller that said nothing
    // about the API now leaves the field untouched, the same way `tests` is
    // left untouched — see the #176 block below.
    expect(s.environments.local.api).toBeUndefined();
  });

  test("quinn FAIL survives", () => {
    // SC-588. The overwrite #169 makes live: quinn measured FAIL, and a later
    // record-build-commit call hands this script the verdict it was given by
    // its caller. A FAIL already in the file is a measurement, and nothing
    // whose job is to record a commit may replace it with a pass.
    const quinn = { spawned: true, verdict: "FAIL", findings: "AC-2: the row never renders", port: 4321 };
    writeFileSync(STATE, JSON.stringify(baseState({ agents: { quinn } }), null, 2));

    const a = okArgs();
    a[a.indexOf("--quinn") + 1] = "PASS";
    expect(run(a).code).toBe(0);
    expect(
      readState().agents.quinn,
      "a measured Quinn FAIL was overwritten by the commit step",
    ).toEqual(quinn);

    // The mutation: empty the preserve list and the overwrite comes back.
    const mutant = makeMutant("quinn-overwrite", /PRESERVED_VERDICTS = new Set\(\["FAIL"\]\)/, "PRESERVED_VERDICTS = new Set([])");
    writeFileSync(STATE, JSON.stringify(baseState({ agents: { quinn } }), null, 2));
    expect(run(a, mutant).code).toBe(0);
    expect(
      readState().agents.quinn.verdict,
      "the mutant with an empty preserve list did NOT overwrite the FAIL — " +
        "the assertion above is not what is holding the line",
    ).toBe("PASS");
  });

  test("quinn's other fields merge instead of being dropped", () => {
    // A PASS over a PASS still has to keep the evidence attached to it.
    const quinn = { spawned: true, verdict: "PASS", port: 4321, screenshots: ["page-load.png"] };
    writeFileSync(STATE, JSON.stringify(baseState({ agents: { quinn } }), null, 2));
    const a = okArgs();
    a[a.indexOf("--quinn") + 1] = "PASS";
    expect(run(a).code).toBe(0);
    expect(readState().agents.quinn).toEqual(quinn);
  });

  test("buildMarcusRecord keeps a recorded FAIL and does not mutate its input", () => {
    const before = { quinn: { spawned: true, verdict: "FAIL", findings: "AC-2 failed" } };
    const after = buildMarcusRecord(before, SHA, "ship-173", "PASS");
    expect(after.quinn).toEqual(before.quinn);
    expect(before.quinn.verdict).toBe("FAIL");
    expect(PRESERVED_VERDICTS.has("FAIL")).toBe(true);
  });
});

describe("#173: ship.js reports the verdict Quinn returned, not the one its tier implies", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("the ceremony tier no longer stands in for a Quinn verdict", () => {
    // SC-589. The literal that was there: `ceremonyTier !== 'LIGHT' ? 'PASS'`.
    expect(shipSource).not.toMatch(/ceremonyTier\s*!==\s*'LIGHT'\s*\?\s*'PASS'/);
  });

  /** The verdict chooser, extracted from its markers and executed. */
  function loadQuinnVerdict(): (ran: boolean, result: unknown) => string {
    const start = shipSource.indexOf("// ──── QUINN-VERDICT-START ────");
    const end = shipSource.indexOf("// ──── QUINN-VERDICT-END ────");
    expect(start, "ship.js is missing the QUINN-VERDICT markers").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(`${shipSource.slice(start, end)}\nreturn quinnVerdictFor`)();
  }

  test("a Quinn that never ran is SKIP, and one that ran reports what it said", () => {
    const quinnVerdictFor = loadQuinnVerdict();
    expect(quinnVerdictFor(false, { result: "PASS" })).toBe("SKIP");
    expect(quinnVerdictFor(true, { result: "PASS" })).toBe("PASS");
    expect(quinnVerdictFor(true, { result: "FAIL" })).toBe("FAIL");
    expect(quinnVerdictFor(true, { result: "SKIP" })).toBe("SKIP");
  });

  test("a Quinn that ran but said nothing usable is not a pass", () => {
    // The positive control for the case above: returning 'PASS' for everything
    // satisfies two of its four assertions.
    const quinnVerdictFor = loadQuinnVerdict();
    for (const reply of [undefined, null, {}, { result: "MAYBE" }, "PASS"]) {
      expect(quinnVerdictFor(true, reply), `${JSON.stringify(reply)} was read as a verdict`).toBe("FAIL");
    }
  });

  test("the commit step passes the chooser's answer to the recorder", () => {
    // A function nothing calls is the shape #162's round one shipped.
    const start = shipSource.indexOf("const commitResult = await agent(`");
    const end = shipSource.indexOf("if (!commitResult?.commitSha)", start);
    expect(start).toBeGreaterThan(-1);
    const step = shipSource.slice(start, end);
    expect(step).toContain("--quinn ${shellQuote(quinnLocalVerdict)}");
    expect(shipSource).toMatch(/const quinnLocalVerdict = quinnVerdictFor\(quinnLocalRan, quinnLocalResult\)/);
  });
});

/**
 * #169 — AC-5 and AC-6.
 *
 * The commit step records `buildCommit`. The two remediation rounds that run
 * after it — recommit-verify and recommit-ship — move the branch and recorded
 * nothing, so on the #164 run `buildCommit` named a commit three rounds behind
 * the tip the PR was opened from. Both now re-record through the same script,
 * and both must say so in a REQUIRED reply field, because an instruction an
 * agent can skip without the reply changing is not a step (#166).
 *
 * AC-6 is the half #173 is about: every one of those call sites hands the
 * recorder a Quinn verdict, and a verdict chosen by the ceremony tier is the
 * tier talking. PR #172 was closed unmerged for exactly this — its two new
 * call sites passed a hardcoded PASS over a measured verdict.
 */
describe("#169 recommit: both remediation rounds re-record the commit", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  /** One agent step, sliced from its prompt open to the close of its options. */
  function step(label: string): string {
    const at = shipSource.indexOf(`label: '${label}'`);
    expect(at, `ship.js has no ${label} step`).toBeGreaterThan(-1);
    const start = shipSource.lastIndexOf("await agent(`", at);
    expect(start, `${label} is not an agent() call — this slicer is stale`).toBeGreaterThan(-1);
    const end = shipSource.indexOf("\n", at);
    return shipSource.slice(start, end === -1 ? shipSource.length : end);
  }

  for (const label of ["recommit-verify", "recommit-ship"]) {
    test(`${label} runs the recorder`, () => {
      expect(step(label), `${label} moves the branch and records nothing`).toContain(
        "record-build-commit.ts",
      );
    });

    test(`${label} requires stateRecorded in its reply`, () => {
      // Not merely present: REQUIRED. An optional field is one the agent can
      // omit, and then the workflow cannot tell a skipped step from a done one.
      const s = step(label);
      expect(s).toContain("stateRecorded");
      const required = s.match(/required:\s*\[([^\]]*)\]/)?.[1] ?? "";
      expect(required, `${label} required fields were: ${required}`).toContain("stateRecorded");
    });

    test(`${label} records the commit it just made, not the one before it`, () => {
      // The whole point: `--sha` must be the post-commit HEAD. Recording
      // parentSha would leave buildCommit exactly as stale as it was.
      const s = step(label);
      expect(s).toMatch(/--sha "\$(commitSha|sha)"/);
      expect(s, `${label} records its parent commit`).not.toMatch(/--sha "\$parentSha"/);
    });
  }

  test("every recorder call site reports its receipt", () => {
    // The commit step plus the two remediation rounds. A fourth call site that
    // skipped the receipt would be the #166 defect returning, so the count is
    // asserted rather than the three names.
    // Matched on the invocation, not the name: the name also appears in three
    // comments and in the COMMIT_STATE_NOT_RECORDED message, and counting
    // those would make this number move whenever someone edits prose.
    const callSites = shipSource.split("scripts/record-build-commit.ts`)}").length - 1;
    expect(callSites, "a record-build-commit call site was added or removed").toBe(3);
  });
});

describe("#169 measured verdict: no call site reports a verdict the tier implied", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  /** Both verdict choosers, extracted from the QUINN-VERDICT markers. */
  function loadChoosers(): {
    quinnVerdictFor: (ran: boolean, result: unknown) => string;
    quinnShipVerdict: (ran: boolean, result: unknown, local: string) => string;
  } {
    const start = shipSource.indexOf("// ──── QUINN-VERDICT-START ────");
    const end = shipSource.indexOf("// ──── QUINN-VERDICT-END ────");
    expect(start, "ship.js is missing the QUINN-VERDICT markers").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(
      `${shipSource.slice(start, end)}\nreturn { quinnVerdictFor, quinnShipVerdict }`,
    )();
  }

  test("the ship-phase chooser reports what container Quinn said", () => {
    const { quinnShipVerdict } = loadChoosers();
    expect(quinnShipVerdict(true, { result: "FAIL" }, "PASS")).toBe("FAIL");
    expect(quinnShipVerdict(true, { result: "PASS" }, "SKIP")).toBe("PASS");
    expect(quinnShipVerdict(true, { result: "SKIP" }, "PASS")).toBe("SKIP");
  });

  test("a container Quinn that said nothing usable is not a pass", () => {
    // The positive control for the case above: returning the local verdict for
    // everything satisfies two of its three assertions.
    const { quinnShipVerdict } = loadChoosers();
    for (const reply of [undefined, null, {}, { result: "MAYBE" }, "PASS"]) {
      expect(quinnShipVerdict(true, reply, "PASS"), `${JSON.stringify(reply)} read as a verdict`).toBe(
        "FAIL",
      );
    }
  });

  test("a container Quinn that never ran falls back to the local measurement", () => {
    // Not SKIP. The local verdict is still a measurement taken at or before
    // this point, and reporting SKIP over it would downgrade a real Quinn PASS
    // in the artefact — which is #173 one project over.
    const { quinnShipVerdict } = loadChoosers();
    expect(quinnShipVerdict(false, null, "PASS")).toBe("PASS");
    expect(quinnShipVerdict(false, { result: "PASS" }, "FAIL")).toBe("FAIL");
    expect(quinnShipVerdict(false, null, "SKIP")).toBe("SKIP");
  });

  test("no --quinn argument anywhere in ship.js is derived from the ceremony tier", () => {
    // AC-6, over every call site rather than the ones this change added. The
    // literal PR #172 shipped was `--quinn ${shellQuote('PASS')}`; the one #173
    // removed was `ceremonyTier !== 'LIGHT' ? 'PASS' : 'SKIP'`.
    const args = shipSource.match(/--quinn \$\{([^}]*)\}/g) || [];
    expect(args.length, "ship.js passes no --quinn at all").toBe(3);
    for (const a of args) {
      expect(a, `${a} chooses a verdict from the tier`).not.toContain("ceremonyTier");
      expect(a, `${a} hardcodes a verdict`).not.toMatch(/'(PASS|FAIL)'/);
      expect(a, `${a} does not name a measured verdict variable`).toMatch(/quinn\w*Verdict/i);
    }
  });

  test("container Quinn's reply is captured rather than discarded", () => {
    // It cannot be reported if nothing holds it. Before #169 the
    // `quinn-container` briefedAgent call was awaited and its result dropped
    // on the floor.
    const at = shipSource.indexOf("label: 'quinn-container'");
    expect(at, "ship.js no longer spawns quinn-container").toBeGreaterThan(-1);
    const spawn = shipSource.lastIndexOf("briefedAgent(`", at);
    expect(spawn).toBeGreaterThan(-1);
    // The line the call is on, not the prompt body: the assignment sits to the
    // LEFT of `briefedAgent(`, so slicing forward from it would always miss.
    const callLine = shipSource.slice(shipSource.lastIndexOf("\n", spawn) + 1, spawn);
    expect(callLine, "quinn-container's verdict is still discarded").toContain("quinnContainerResult =");
    expect(shipSource).toContain("quinnContainerRan = true");
  });

  test("the ship-phase chooser is called, not merely defined", () => {
    // A function nothing calls is the shape #162's round one shipped.
    expect(shipSource).toMatch(
      /const quinnShipVerdictValue = quinnShipVerdict\(quinnContainerRan, quinnContainerResult, quinnLocalVerdict\)/,
    );
    expect(shipSource).toContain("--quinn ${shellQuote(quinnShipVerdictValue)}");
    expect(shipSource).toContain("--quinn ${shellQuote(quinnLocalVerdict)}");
  });
});

describe("#166: refusals, each shown against a mutant that does not refuse", () => {
  const CASES: Array<[string, string[]]> = [
    ["no --state", ["--sha", SHA, "--branch", "b", "--quinn", "SKIP"]],
    ["no --sha", ["--state", "", "--branch", "b", "--quinn", "SKIP"]],
    ["no --branch", ["--state", "", "--sha", SHA, "--quinn", "SKIP"]],
    ["a ref name instead of a SHA", ["--state", "", "--sha", "HEAD", "--branch", "b", "--quinn", "SKIP"]],
    ["a SHA with a command in it", ["--state", "", "--sha", "dd242a6; rm -rf /", "--branch", "b", "--quinn", "SKIP"]],
    ["a branch name that is not one", ["--state", "", "--sha", SHA, "--branch", "a b; c", "--quinn", "SKIP"]],
    ["a quinn verdict nobody recognises", ["--state", "", "--sha", SHA, "--branch", "b", "--quinn", "MAYBE"]],
    ["an unknown flag", ["--state", "", "--sha", SHA, "--branch", "b", "--quinn", "SKIP", "--force", "1"]],
  ];

  for (const [label, args] of CASES) {
    test(`refuses ${label}`, () => {
      const filled = args.map(a => (a === "" ? STATE : a));
      const real = run(filled);
      expect(real.code, `the real script accepted ${label}`).toBe(REFUSE_EXIT);

      const mutant = run(filled, MUTANT);
      expect(
        mutant.code,
        `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for ${label} — ` +
          `the refusal does not run through REFUSE_EXIT, so zeroing it proves nothing`,
      ).toBe(0);
    });
  }

  test("the positive control: a well-formed call is accepted", () => {
    // Without this, refusing everything satisfies every assertion above.
    expect(run(okArgs()).code).toBe(0);
  });

  test("no mutant is left behind in scripts/", () => {
    // The mutant is written into the repo so its relative import resolves.
    // A leftover copy would be a second, silently weaker version of a refusal
    // script sitting in the tree, so its removal is asserted rather than
    // trusted to afterEach.
    for (const m of MUTANTS) rmSync(m, { force: true });
    MUTANTS = [];
    expect(existsSync(MUTANT)).toBe(false);
    // #173 added more of them, so the check is now "none of this shape",
    // not "not the one I happen to be holding".
    const strays = readdirSync(join(REPO_ROOT, "scripts")).filter(f => f.endsWith(".mutant.ts"));
    expect(strays, "a mutant copy of a refusal script was left in scripts/").toEqual([]);
  });

  test("REFUSE_EXIT is assigned exactly once", () => {
    const decls = (readFileSync(SCRIPT, "utf-8").match(/REFUSE_EXIT\s*=/g) || []).length;
    expect(decls, "more than one assignment — the mutant would neutralise only one").toBe(1);
  });

  test("every process.exit goes through REFUSE_EXIT", () => {
    const exits = readFileSync(SCRIPT, "utf-8").match(/process\.exit\([^)]*\)/g) || [];
    for (const e of exits) {
      expect(e, `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it`).toBe(
        "process.exit(REFUSE_EXIT)",
      );
    }
  });
});

describe("#166: ship.js asks for the receipt rather than hoping for the side effect", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  /** The `commit` agent call, sliced from its label to the close of its options. */
  function commitStep(): string {
    const start = shipSource.indexOf("const commitResult = await agent(`");
    expect(start, "ship.js no longer has a `commitResult = await agent(` step").toBeGreaterThan(-1);
    const end = shipSource.indexOf("if (!commitResult?.commitSha)", start);
    expect(end, "the commit step's guard moved — this slicer is stale").toBeGreaterThan(start);
    return shipSource.slice(start, end);
  }

  test("the commit step calls the recorder", () => {
    expect(commitStep()).toContain("record-build-commit.ts");
  });

  test("the state write is a required field of the reply, not an instruction", () => {
    // The whole defect: an instruction an agent can skip without the reply
    // changing is not a step. If `stateRecorded` is not REQUIRED, the agent
    // can omit it and ship.js cannot tell.
    const step = commitStep();
    expect(step).toContain("stateRecorded");
    const required = step.match(/required:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(required, `commit step required fields were: ${required}`).toContain("stateRecorded");
  });

  test("ship.js no longer sets agents by assignment", () => {
    // `s.agents = {marcus: …}` is the line that erases agents.rook.
    expect(shipSource).not.toContain("s.agents = {marcus");
  });

  /**
   * The guard, extracted from its markers and executed.
   *
   * The first version of this test asserted `shipSource.toContain(
   * "COMMIT_STATE_NOT_RECORDED")`, and reducing the branch to `if (false)`
   * left all 21 tests green. Executing it is the difference between checking
   * that a string is in the file and checking that the run stops.
   */
  function loadGuard(): (reply: unknown) => string | null {
    const start = shipSource.indexOf("// ──── COMMIT-STATE-GUARD-START ────");
    const end = shipSource.indexOf("// ──── COMMIT-STATE-GUARD-END ────");
    expect(start, "ship.js is missing the COMMIT-STATE-GUARD markers").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(`${shipSource.slice(start, end)}\nreturn commitStateRefusal`)();
  }

  test("a reply that does not confirm the state write stops the run", () => {
    const guard = loadGuard();
    for (const reply of [
      { commitSha: "dd242a62", branch: "b", pushed: true },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: false },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: "true" },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: null },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: 1 },
      undefined,
      null,
      "ok",
    ]) {
      expect(
        guard(reply),
        `${JSON.stringify(reply)} was accepted as a recorded commit`,
      ).toBeTruthy();
    }
  });

  test("a reply that confirms it does not stop the run", () => {
    // The positive control: refusing everything satisfies the case above.
    expect(loadGuard()({ commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: true })).toBeNull();
  });

  test("the refusal names the commit it is refusing", () => {
    const reason = loadGuard()({ commitSha: "dd242a62", stateRecorded: false });
    expect(reason).toContain("dd242a62");
    expect(reason).toContain("COMMIT_STATE_NOT_RECORDED");
  });

  /**
   * #201 — this test used to be two call-site TEXT assertions, and text is
   * exactly what the mutation that matters leaves alone.
   *
   * Wrapping the COMMIT-STATE-GUARD region in `if (false)`, with the wrapper
   * placed OUTSIDE the marker comments so `loadGuard`'s slice stays
   * byte-identical, kills the guard: the declaration never binds and the call
   * below it reaches for a name that was never created. Measured on
   * 2026-10-08, that mutation left this file at 52 pass / 0 fail — the
   * `toContain` and the `toMatch` below were both still true of the source,
   * because wrapping a region does not change the characters inside it.
   *
   * "Wired into the run" now has both halves read off the PARSE. The guard's
   * marked region must be a statement of the module body — `["Program"]`,
   * which workflows/ship.js executes top to bottom — and the call that uses
   * it must be a top-level `const`. A conditional owner of either one (`if`,
   * loop, `catch`, function) appears in the chain under its own node type and
   * fails the comparison.
   *
   * A function nothing calls is the shape #162's round one shipped: a
   * 270-line script, fully tested, that the workflow never executed.
   */
  test("the guard is wired into the run, not merely defined", () => {
    expect(assertMarkedBlockReachable(shipSource, "COMMIT-STATE-GUARD")).toEqual(["Program"]);

    const CALL = "const stateRefusal = commitStateRefusal(commitResult)";
    const at = shipSource.indexOf(CALL);
    expect(at, "the call site text moved — this test would check nothing").toBeGreaterThan(-1);
    expect(
      shipSource.indexOf(CALL, at + 1),
      "the call site appears more than once — which one is being checked?",
    ).toBe(-1);
    expect(enclosingChain(shipSource, at, at + CALL.length)).toEqual([
      "Program",
      "VariableDeclaration",
    ]);
    expect(shipSource).toMatch(/if \(stateRefusal\) \{[\s\S]{0,400}status: 'COMMIT_FAILED'/);
  });
});

/**
 * #176: the commit step does not get a vote on the api or the ui either.
 *
 * `environments.local.api` and `.ui` were assigned unconditionally from flags
 * `workflows/ship.js` derived from rungate.json — `--api PASS` whenever
 * `projectConfig.apiUrl` was merely truthy, `--ui PASS` whenever a `pages`
 * entry existed. Quinn runs during Validate and this script runs after it, so
 * a measured FAIL was replaced by a restatement of the config file, and the
 * `local-api-validated` / `local-ui-validated` checks in gates/workflow.test.ts
 * read exactly those two fields. Same defect as `tests` in #173, one field
 * over.
 */
describe("#176: api and ui verdicts belong to whoever measured them", () => {
  test("a measured api FAIL survives a commit that was handed PASS", () => {
    writeFileSync(
      STATE,
      JSON.stringify(baseState({ environments: { local: { api: "FAIL", ui: "FAIL" } } }), null, 2),
    );
    const a = [...okArgs(), "--api", "PASS", "--ui", "PASS"];
    expect(run(a).code).toBe(0);
    const local = readState().environments.local;
    expect(local.api, "a measured api FAIL was overwritten by the commit step").toBe("FAIL");
    expect(local.ui, "a measured ui FAIL was overwritten by the commit step").toBe("FAIL");

    // The mutation, run rather than described: turn the preserve off and the
    // overwrite comes back. Without this, "the FAIL survived" is also
    // satisfied by a script that stopped writing the fields at all.
    const mutant = makeMutant(
      "env-overwrite",
      /PRESERVE_MEASURED_ENVIRONMENTS = true\b/,
      "PRESERVE_MEASURED_ENVIRONMENTS = false",
    );
    writeFileSync(
      STATE,
      JSON.stringify(baseState({ environments: { local: { api: "FAIL", ui: "FAIL" } } }), null, 2),
    );
    expect(run(a, mutant).code).toBe(0);
    const mutated = readState().environments.local;
    expect(
      [mutated.api, mutated.ui],
      "the mutant with preservation disabled did NOT overwrite the measurements — " +
        "the assertions above are not what is holding the line",
    ).toEqual(["PASS", "PASS"]);
  });

  test("an unmeasured field is filled in, not skipped", () => {
    // The positive control for the case above: preserving everything would
    // make this script incapable of recording a verdict it was legitimately
    // given by a caller that did measure.
    writeFileSync(STATE, JSON.stringify(baseState(), null, 2));
    expect(run([...okArgs(), "--api", "FAIL", "--ui", "SKIP", "--ui-skip-reason", "no pages"]).code).toBe(0);
    const local = readState().environments.local;
    expect(local.api).toBe("FAIL");
    expect(local.ui).toBe("SKIP");
    expect(local.uiSkipReason).toBe("no pages");
  });

  test("omitting the flags writes nothing rather than defaulting to SKIP", () => {
    // `SKIP` is a verdict: it says the check was considered and waived. A
    // commit step that was told nothing has not considered anything, and
    // `local-api-validated` accepts SKIP — so the default was the thing
    // keeping that check from ever going red on a configured project.
    writeFileSync(STATE, JSON.stringify(baseState(), null, 2));
    expect(run(okArgs()).code).toBe(0);
    const local = readState().environments.local;
    expect(local.api).toBeUndefined();
    expect(local.ui).toBeUndefined();
    expect(local.uiSkipReason).toBeUndefined();
  });

  test("buildLocalEnvironment keeps measurements and does not mutate its input", () => {
    const before = { api: "FAIL", tests: "PASS" };
    const after = buildLocalEnvironment(before, { api: "PASS", ui: "PASS" });
    expect(after.api).toBe("FAIL");
    expect(after.ui).toBe("PASS");
    expect(after.tests).toBe("PASS");
    expect(before).toEqual({ api: "FAIL", tests: "PASS" });
    expect(PRESERVE_MEASURED_ENVIRONMENTS).toBe(true);
  });

  test("a non-verdict sitting in the field is not treated as a measurement", () => {
    // `api: ""` and `api: "pending"` are not verdicts. Reading them as
    // measurements would let one bad write freeze the field forever.
    expect(buildLocalEnvironment({ api: "" }, { api: "PASS" }).api).toBe("PASS");
    expect(buildLocalEnvironment({ api: "pending" }, { api: "PASS" }).api).toBe("PASS");
    expect(buildLocalEnvironment({ api: "SKIP" }, { api: "PASS" }).api).toBe("SKIP");
  });

  test("ship.js does not turn configuration presence into a verdict", () => {
    const ship = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    expect(
      ship.match(/(apiUrl|hasUI)\s*\?\s*'PASS'/g) || [],
      "ship.js is deriving an environment verdict from rungate.json again",
    ).toEqual([]);
    expect(ship.match(/--api \$\{shellQuote\(projectConfig/g) || []).toEqual([]);
  });
});
