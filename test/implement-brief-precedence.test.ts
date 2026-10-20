/**
 * Which instruction an implement agent worked from (#180).
 *
 * Covers SC-1472, SC-1473, SC-1474 (HARNESS-STANDARD.md).
 *
 * `wf_17267830-401` shipped #178. The Workflow runtime prepends the relayed
 * user request to every subagent prompt and calls it "the only user voice in
 * this task"; that run's relayed text was a status question typed in the
 * parent session, and Marcus answered it, changed no files, and reported
 * success. The brief for the same run was correct and complete — 63 lines,
 * five ACs, eight files, a canary. **It lost to text it never saw.**
 *
 * rungate does not write that framing and cannot remove it, so the two things
 * it can change are precedence and reportability. The relay stays (#180 AC-3):
 * "focus on the API half first" should still reach the agent.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  briefPrecedenceNotice,
  taskSourceRefusal,
  TASK_SOURCES,
} from "../lib/brief-precedence";
import { enclosingChain } from "../lib/reachability";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const PRECEDENCE_START = "// ──── BRIEF-PRECEDENCE-START ────";
const PRECEDENCE_END = "// ──── BRIEF-PRECEDENCE-END ────";
const BRIEFED_START = "// ──── BRIEFED-AGENT-START ────";
const BRIEFED_END = "// ──── BRIEFED-AGENT-END ────";
const TIMING_START = "// ──── AGENT-TIMING-START ────";
const TIMING_END = "// ──── AGENT-TIMING-END ────";

function slice(start: string, end: string): string {
  const a = shipSource.indexOf(start);
  const b = shipSource.indexOf(end);
  expect(a, `ship.js is missing ${start}`).toBeGreaterThan(-1);
  expect(b, `ship.js is missing ${end}`).toBeGreaterThan(a);
  expect(shipSource.indexOf(start, a + 1), `${start} appears twice`).toBe(-1);
  return shipSource.slice(a, b);
}

/** The inline copies ship.js actually runs. */
const inline = new Function(
  `${slice(PRECEDENCE_START, PRECEDENCE_END)}\nreturn { briefPrecedenceNotice, taskSourceRefusal, TASK_SOURCES };`,
)() as {
  briefPrecedenceNotice: (briefPath: string) => string;
  taskSourceRefusal: (r: unknown, label: string) => string | null;
  TASK_SOURCES: string[];
};

const IMPLEMENTATIONS: Array<[string, typeof inline]> = [
  [
    "library",
    {
      briefPrecedenceNotice,
      taskSourceRefusal: (r: unknown, label: string) => taskSourceRefusal(r as never, label),
      TASK_SOURCES: [...TASK_SOURCES],
    },
  ],
  ["ship.js inline", inline],
];

// ── SC-1472 ─────────────────────────────────────────────────────────────────

describe("SC-1472: a relayed request does not replace the brief", () => {
  for (const [name, impl] of IMPLEMENTATIONS) {
    test(`${name}: the notice says the brief is the task and names the relay`, () => {
      const notice = impl.briefPrecedenceNotice("/p/.claude/agents/marcus.md");
      expect(notice).toContain("the brief is the task");
      expect(notice).toContain("relayed");
      expect(notice, "the brief's own path is not in the notice")
        .toContain("/p/.claude/agents/marcus.md");
    });

    test(`${name}: the relay is kept useful rather than denounced`, () => {
      // AC-3. A notice that said "ignore anything the user typed" would
      // satisfy every case above and lose "focus on the API half first" —
      // which is the whole reason the channel exists.
      const notice = impl.briefPrecedenceNotice("/b.md");
      expect(notice.toLowerCase()).toMatch(/narrow|prioritis/);
      expect(notice.toLowerCase(), "the notice tells the agent to ignore the relay outright")
        .not.toMatch(/\bignore\b/);
    });

    test(`${name}: the notice asks for the reply field by name`, () => {
      const notice = impl.briefPrecedenceNotice("/b.md");
      for (const source of impl.TASK_SOURCES) expect(notice).toContain(source);
      expect(notice).toContain("taskSource");
    });
  }
});

// ── SC-1473 ─────────────────────────────────────────────────────────────────

describe("SC-1473: taskSource is a value in the reply, not prose nobody parses", () => {
  for (const [name, impl] of IMPLEMENTATIONS) {
    test(`${name}: the regression case — brief present, relay unrelated, source is the brief`, () => {
      // AC-2, as the run actually looked.
      expect(impl.taskSourceRefusal({ success: true, taskSource: "brief" }, "marcus")).toBeNull();
    });

    test(`${name}: working from the relay instead is refused`, () => {
      const refusal = impl.taskSourceRefusal(
        { success: true, filesChanged: [], taskSource: "relayed-request" },
        "marcus",
      );
      expect(refusal).toContain("relayed");
      expect(refusal, "the refusal does not say what the brief carries")
        .toMatch(/acceptance criteria/i);
    });

    test(`${name}: both is accepted, because narrowing a brief is the supported case`, () => {
      // The positive control for the refusal. A check that refused anything
      // other than "brief" would satisfy the case above and break AC-3.
      expect(impl.taskSourceRefusal({ taskSource: "both" }, "marcus")).toBeNull();
    });

    test(`${name}: absent is a refusal, not a pass`, () => {
      // The #218 decision, repeated deliberately: a field the run accepts as
      // missing is a field that stops being written.
      for (const reply of [{}, { taskSource: undefined }, { taskSource: "" }, null, undefined]) {
        expect(impl.taskSourceRefusal(reply as never, "marcus"), JSON.stringify(reply))
          .toContain("no taskSource");
      }
    });

    test(`${name}: a value outside the enum is not a verdict`, () => {
      for (const bad of ["BRIEF", "the brief", 1, true, ["brief"]]) {
        const refusal = impl.taskSourceRefusal({ taskSource: bad }, "marcus");
        expect(refusal, JSON.stringify(bad)).toMatch(/not one of|no taskSource/);
      }
    });

    test(`${name}: the label travels, so a decomposed run names the sub-issue`, () => {
      expect(impl.taskSourceRefusal({}, "marcus-sub-66002")).toContain("marcus-sub-66002");
    });
  }

  test("the schema requires the field and offers exactly the three values", () => {
    const at = shipSource.indexOf("const BUILD_RESULT_SCHEMA");
    expect(at).toBeGreaterThan(-1);
    const schema = shipSource.slice(at, shipSource.indexOf("\n}", at));
    expect(schema, "taskSource is not in the implement schema").toContain("taskSource:");
    for (const v of TASK_SOURCES) expect(schema).toContain(`'${v}'`);
    expect(schema, "an optional field is one the agent may stop writing")
      .toContain("required: ['success', 'taskSource']");
  });
});

// ── SC-1474 ─────────────────────────────────────────────────────────────────

describe("SC-1474: the brief alone still works", () => {
  test("the notice reaches the composed prompt, and after the brief read steps", async () => {
    // Executed over the real briefedAgent, not asserted as text: a prompt
    // string containing the words proves nothing about whether the agent
    // sees them, and the ordering is the point. The relay is prepended by the
    // runtime above everything this file writes, so the counterweight is
    // placed last — nearest the task.
    const block =
      `${shipSource.match(/function shellQuote\(word\)[\s\S]*?\n}/)?.[0] ?? ""}\n` +
      `${slice(PRECEDENCE_START, PRECEDENCE_END)}\n` +
      `${slice(TIMING_START, TIMING_END)}\n` +
      `${slice(BRIEFED_START, BRIEFED_END)}`;

    const calls: Array<{ prompt: string }> = [];
    const briefedAgent = new Function(
      "ROLES", "PROJECT_ROOT", "HARNESS_ROOT", "WORK_DIR", "log", "agent",
      "loadContextPaths", "loadReinforcementRules", "noteWorktrees",
      `${block}\nreturn briefedAgent;`,
    )(
      { marcus: { brief: ".claude/agents/marcus.md" } },
      "/project", "/harness", "/work",
      () => {},
      async (prompt: string) => { calls.push({ prompt }); return { ok: true }; },
      async () => [],
      async () => [],
      () => {},
    ) as (p: string, o: Record<string, unknown>) => Promise<unknown>;

    await briefedAgent("## Task\nImplement AC-1.", { role: "marcus", label: "implement" });
    const prompt = calls[0]!.prompt;

    expect(prompt, "the precedence notice never reached the agent").toContain("the brief is the task");
    const briefAt = prompt.indexOf("/project/.claude/agents/marcus.md");
    const noticeAt = prompt.indexOf("TASK PRECEDENCE");
    const taskAt = prompt.indexOf("## Task");
    expect(briefAt, "the brief read step is gone").toBeGreaterThan(-1);
    expect(noticeAt, "the notice comes before the brief read step").toBeGreaterThan(briefAt);
    expect(taskAt, "the notice is not adjacent to the task it governs").toBeGreaterThan(noticeAt);
  });

  test("a role-less call is left alone", () => {
    // The positive control over the injection: briefedAgent only composes for
    // a briefed role, and a notice bolted onto every agent call would be the
    // prompt-bloat version of the same mistake.
    const block = slice(BRIEFED_START, BRIEFED_END);
    expect(block, "the notice is appended unconditionally").toContain("briefPrecedenceNotice(briefPath)");
    const roleGuardAt = block.indexOf("if (role) {");
    const noticeAt = block.indexOf("briefPrecedenceNotice(briefPath)");
    expect(roleGuardAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(roleGuardAt);
  });

  test("the inline copy and the library agree on every reply shape", () => {
    const MATRIX: unknown[] = [
      { taskSource: "brief" },
      { taskSource: "both" },
      { taskSource: "relayed-request" },
      { taskSource: "BRIEF" },
      { taskSource: "" },
      { taskSource: 3 },
      {},
      null,
      undefined,
    ];
    for (const reply of MATRIX) {
      expect(inline.taskSourceRefusal(reply, "m"), JSON.stringify(reply))
        .toEqual(taskSourceRefusal(reply as never, "m"));
    }
    // The matrix is not all refusals and not all passes.
    const verdicts = MATRIX.map(r => inline.taskSourceRefusal(r, "m"));
    expect(verdicts.filter(v => v === null).length).toBeGreaterThan(0);
    expect(verdicts.filter(v => v !== null).length).toBeGreaterThan(0);
    expect(inline.briefPrecedenceNotice("/b.md")).toBe(briefPrecedenceNotice("/b.md"));
  });

  test("the guard is called on both implement paths", () => {
    const calls = shipSource.match(/taskSourceRefusal\(buildResult, /g) ?? [];
    expect(calls.length, "a path spawns an implement agent and never checks it").toBe(2);
    expect(shipSource.match(/function taskSourceRefusal\b/g) ?? []).toHaveLength(1);
  });

  test("runImplement's branch is a branch, read off the parse and not off a grep", () => {
    // MEASURED: the grep above scored ZERO against `if (false && sourceRefusal)`.
    // A guard that is called and whose answer is discarded is the defect this
    // repo keeps filing, committed by the test for it — so the branch is
    // anchored as exact text (checked unique) and its `return` is located in
    // the tree, the #204 pattern.
    const BRANCH = "  if (sourceRefusal) {";
    const at = shipSource.indexOf(BRANCH);
    expect(at, "runImplement no longer branches on the refusal").toBeGreaterThan(-1);
    expect(shipSource.indexOf(BRANCH, at + 1)).toBe(-1);

    const RETURN = "return { success: false, buildResult: { ...buildResult, success: false, findings: [sourceRefusal] } }";
    const retAt = shipSource.indexOf(RETURN);
    expect(retAt, "the refusal is computed and the run carries on").toBeGreaterThan(-1);
    expect(shipSource.indexOf(RETURN, retAt + 1)).toBe(-1);
    const chain = enclosingChain(shipSource, retAt, retAt + RETURN.length);
    expect(chain).toContain("IfStatement");
    expect(chain, "the refusal's return is not a return").toContain("ReturnStatement");
  });

  test("runImplement ACTS on it — executed, not grepped", async () => {
    const refused = (await loadRunImplement({
      success: true,
      worktreePath: "/p/.claude/worktrees/wf_a-2",
      worktreeRepo: "git@github.com:owner/project.git",
      filesChanged: ["lib/a.ts"],
      taskSource: "relayed-request",
    })()) as { success: boolean; buildResult: { findings?: string[] } };
    expect(refused.success, "a run that answered the relayed message shipped anyway").toBe(false);
    expect(refused.buildResult.findings?.join(" ")).toContain("relayed user request");
  });

  test("the same reply naming the brief gets through", async () => {
    // The positive control over the same path. A guard that refused every
    // implement result satisfies the case above and stops the harness.
    const ok = (await loadRunImplement({
      success: true,
      worktreePath: "/p/.claude/worktrees/wf_a-2",
      worktreeRepo: "git@github.com:owner/project.git",
      filesChanged: ["lib/a.ts"],
      taskSource: "brief",
    })()) as { success: boolean };
    expect(ok.success).toBe(true);
  });

  test("the decomposed path ACTS on it — executed, not grepped", async () => {
    const { run, logs } = loadRunDecomposedShip(async (_p, { label }) => ({
      success: true,
      filesChanged: [`${label}.ts`],
      worktreePath: "/tmp/wt",
      worktreeRepo: "git@github.com:owner/project.git",
      // The second sub-issue answered the relayed message instead.
      taskSource: label.endsWith("2") ? "relayed-request" : "brief",
    }));
    const result = (await run(SUBS)) as { success: boolean; failed: Array<{ title: string }> };
    expect(result.success, "a sub-issue that worked from the relay shipped anyway").toBe(false);
    expect(result.failed.map(f => f.title)).toContain("beta");
    expect(logs.join("\n")).toContain("worked from the relayed user request");
  });

  test("the same batch reporting the brief succeeds", async () => {
    // The positive control. A guard that failed every batch satisfies the
    // case above and breaks decomposed shipping entirely.
    const { run } = loadRunDecomposedShip(async (_p, { label }) => ({
      success: true,
      filesChanged: [`${label}.ts`],
      worktreePath: "/tmp/wt",
      worktreeRepo: "git@github.com:owner/project.git",
      taskSource: "brief",
    }));
    expect(((await run(SUBS)) as { success: boolean }).success).toBe(true);
  });
});

const SUBS = [
  { title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
  { title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
];

/** A whole top-level function out of ship.js, brace-matched from its header. */
function slicedFunction(header: string): string {
  const at = shipSource.indexOf(header);
  expect(at, `ship.js no longer declares ${header}`).toBeGreaterThan(-1);
  let depth = 0;
  let i = shipSource.indexOf("{", at);
  for (; i < shipSource.length; i++) {
    if (shipSource[i] === "{") depth++;
    else if (shipSource[i] === "}" && --depth === 0) break;
  }
  return shipSource.slice(at, i + 1);
}

/**
 * The real `runImplement`, with every guard it reaches for injected from its
 * own markers. Same extraction as `test/ship-remediation-commits.test.ts`'s
 * loader, which is where the pattern comes from.
 */
function loadRunImplement(buildResult: unknown) {
  const guard = (name: string, fn: string) =>
    new Function(`${slice(`// ──── ${name}-START ────`, `// ──── ${name}-END ────`)}\nreturn ${fn};`)();

  return new Function(
    "runCeremonyOnce", "briefedAgent", "log", "WORK_DIR", "testTimeout",
    "BUILD_RESULT_SCHEMA", "implementRefusal", "worktreeIdentity", "REPO", "taskSourceRefusal",
    // #611's element-shape guard, from its own markers for the same reason
    // as the three above.
    "filesChangedShapeRefusal",
    // #676's selected-test command. A resolved STRING, which is the whole
    // reason it is resolved at ship.js's module scope rather than built
    // inside runImplement: a builder here would be four free names and a
    // stub that could disagree with the real one.
    "SELECTED_TESTS_COMMAND",
    `${slicedFunction("async function runImplement()")}\nreturn runImplement`,
  )(
    async () => ({ contextExcerpts: [], acContextFiles: [] }),
    async () => buildResult,
    () => {},
    "/tmp/work",
    300000,
    {},
    guard("IMPLEMENT-RESULT", "implementRefusal"),
    guard("WORKTREE-IDENTITY", "worktreeIdentity"),
    "owner/project",
    guard("BRIEF-PRECEDENCE", "taskSourceRefusal"),
    guard("FILES-CHANGED-SHAPE", "filesChangedShapeRefusal"),
    "bun test $(bun /h/scripts/select-affected-tests.ts --work '/tmp/work/selection'/\"$(basename \"$PWD\")\")",
  ) as () => Promise<unknown>;
}

/**
 * The real `runDecomposedShip`, with every guard it closes over injected from
 * its own markers rather than stubbed — a stub would let the block and the
 * real one disagree and nothing would notice.
 */
function loadRunDecomposedShip(
  briefedAgent: (p: string, o: { label: string }) => Promise<unknown>,
) {
  const block = slice("// ──── DECOMPOSED-SHIP-START ────", "// ──── DECOMPOSED-SHIP-END ────");
  const logs: string[] = [];
  const guard = (name: string, fn: string) =>
    new Function(`${slice(`// ──── ${name}-START ────`, `// ──── ${name}-END ────`)}\nreturn ${fn};`)();

  const run = new Function(
    "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
    "taskSourceRefusal",
    // #420 added three free names to the block. The run ref and the wave
    // commit are faked — this file is about brief precedence — but the
    // predicate comes from its own markers, for the reason the guards above
    // do: a stub would let the two copies disagree and nothing would notice.
    "establishRunRef", "integrateWave", "waveNeedsIntegration",
    "measureLaunchBase",
    // #611 added a free reference too; its block text is evaluated into the
    // scope rather than injected, because ship.js declares it at module
    // scope beside the decomposed block.
    `${slice("// ──── FILES-CHANGED-SHAPE-START ────", "// ──── FILES-CHANGED-SHAPE-END ────")}\n${block}\nreturn runDecomposedShip;`,
  )(
    (m: string) => logs.push(String(m)),
    briefedAgent,
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    "/tmp/work", 180, REPO_ROOT, {},
    async () => ({ success: true, buildResult: {} }),
    guard("IMPLEMENT-RESULT", "implementRefusal"),
    guard("WORKTREE-IDENTITY", "worktreeIdentity"),
    "owner/project",
    guard("BRIEF-PRECEDENCE", "taskSourceRefusal"),
    async () => ({ branch: "rungate/run-180", refusal: null }),
    async () => ({ ok: true, integrated: 0 }),
    guard("RUN-REF", "waveNeedsIntegration"),
    async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
  ) as (subIssues: unknown[]) => Promise<unknown>;

  return { run, logs };
}
