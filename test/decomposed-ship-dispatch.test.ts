import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { stripComments } from "./helpers/strip-comments";

/**
 * Regression coverage for issue #66 — SC-411.
 *
 * `runDecomposedShip` computes a pairwise file-overlap check and then takes one
 * of two paths. The disjoint path logged "parallel execution" while running a
 * sequential `for` loop, and discarded completed siblings when a later sub-issue
 * failed.
 *
 * ship.js runs inside the Workflow sandbox and is not importable as a module, so
 * this follows the same marker-extraction pattern as
 * test/workflow-security-integration.ts: pull the delimited block out and
 * evaluate it against injected fakes, giving behavioural coverage rather than
 * grep coverage.
 *
 * ## AC-7a / AC-7c (#627)
 *
 * #627 moves the claim/result pairing out of the two inline
 * `claimedFiles: r.subIssue?.filesToModify` expressions in the block below and
 * into one named binding the wave path calls too. Two things in this file are
 * about that move, and they pull in opposite directions on purpose:
 *
 *   - `loadRunDecomposedShip` must keep loading the block after the binding
 *     leaves it. Every free reference the block makes is already injected by
 *     name, so a binding declared at ship.js module scope would make the block
 *     throw `ReferenceError` the first time a sub-issue completes — the suite
 *     would go red for a reason that has nothing to do with the dispatch it
 *     covers. `resolveFreeReferences` below follows the declaration wherever
 *     it is declared, and ABORTS naming the identifier when it cannot, rather
 *     than letting the block die mid-run.
 *   - the AC-7c cases pin what the staging rows CONTAIN, executed rather than
 *     grepped, so the wave fix cannot be bought by changing the end-of-run
 *     path it is now shared with. Nothing in this file reads the inline
 *     expression as source text; the claim is asserted as a value on the row.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria

const REPO_ROOT = join(import.meta.dir, "..");
/** The run repo, and the remote every fixture worktree reports (#218). */
const RUN_REPO = "owner/project";
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const BLOCK_START = "// ──── DECOMPOSED-SHIP-START ────";
const BLOCK_END = "// ──── DECOMPOSED-SHIP-END ────";

/** The dispatch block, sliced once so the loader and AC-7a read the same text. */
const DECOMPOSED_BLOCK = (() => {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error("ship.js is missing the DECOMPOSED-SHIP-START/END markers");
  }
  return shipSource.slice(start + BLOCK_START.length, end);
})();

type AgentCall = { label: string; start: number; end: number };

type BriefedAgentFake = (
  prompt: string,
  opts: { label: string },
) => Promise<unknown>;

/**
 * Every name ship.js declares at module scope, and the offset it starts at.
 *
 * Column-anchored on purpose: a `function` or `const` indented by even one
 * space is inside something, and slicing it out of its enclosure would produce
 * a fragment that does not parse.
 */
function topLevelDeclarations(source: string): Map<string, number> {
  const at = new Map<string, number>();
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    /^const\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) if (!at.has(m[1]!)) at.set(m[1]!, m.index!);
  }
  return at;
}

/** The one declaration starting at `from`, bounded by the next top-level one. */
function declarationAt(source: string, from: number): string {
  const boundary = /^(?:\/\/ ──── |\/\*\*|(?:async )?function |const |let )/gm;
  boundary.lastIndex = from + 1;
  const next = boundary.exec(source);
  return source.slice(from, next ? next.index : source.length);
}

/**
 * Whether `fragment` reaches `name`.
 *
 * Call syntax for everything, plus a bare mention for SCREAMING_SNAKE names,
 * which is how ship.js spells a module-scope data constant and the only shape
 * a call-only probe cannot see. Deliberately NOT a bare mention for every
 * name: ship.js's agent prompts are template literals carrying shell and JS
 * at column zero, so `^const ` matches things like `s`, `path` and `files`
 * inside them, and a bare probe drags those in as declarations.
 */
/**
 * Whether `fragment` actually USES `name` — asked of code, never of prose.
 *
 * The caller strips comments first, and that is load-bearing rather than
 * tidy. The SCREAMING_CASE arm below matches a BARE word, so for a module
 * const it cannot tell a call from a sentence, and the block it is asked
 * about is heavily commented — #627's own pairing docstring explains the
 * defect by naming `SINGLE_WORKTREE_EXEMPT`, which is exactly the shape of
 * "a comment explaining what must not happen reads like the thing
 * happening". Unstripped, the resolver followed that sentence to module
 * scope and prepended a `const` the block never references.
 *
 * Harmless on that name — it is not injected, so it shadowed no fake — but
 * the general case is not: a comment mentioning any uninjected module-scope
 * SCREAMING_CASE binding silently pulls the REAL definition into a scope
 * built out of fakes, and the suite goes green having tested ship.js's
 * values instead of its own.
 */
function reaches(fragment: string, name: string): boolean {
  if (new RegExp(`\\b${name}\\s*\\(`).test(fragment)) return true;
  return /^[A-Z][A-Z0-9_]*$/.test(name) && new RegExp(`\\b${name}\\b`).test(fragment);
}

/** Every name a fragment declares, at any depth — what it does NOT need. */
function namesDeclaredIn(fragment: string): Set<string> {
  const names = new Set<string>();
  for (const m of fragment.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(m[1]!);
  }
  for (const m of fragment.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]!);
  return names;
}

/**
 * Source text for every binding the block calls and nothing supplies.
 *
 * Transitive, because a binding moved to module scope may itself call one:
 * `filesChangedShapeRefusal` calls `filesChangedShapeRule`, and resolving only
 * the first level produces a slice that parses and throws the moment it runs.
 * Returns the slices to prepend in ship.js declaration order, so a `const`
 * still precedes the binding that closes over it.
 *
 * A name that cannot be sliced into something that parses throws HERE rather
 * than at call time: a loader that silently omits a binding leaves a
 * `ReferenceError` deep inside an async dispatch, which reads as the dispatch
 * being broken rather than as the loader having lost track of a declaration.
 */
function resolveFreeReferences(block: string, provided: Set<string>): string[] {
  const declarations = topLevelDeclarations(shipSource);
  const resolved = new Map<string, { offset: number; source: string }>();
  // Both questions are asked of CODE. `namesDeclaredIn` is stripped for the
  // mirror of `reaches`'s reason: a comment quoting `const x =` would record
  // a declaration the block does not make, and the binding would then be
  // left unresolved rather than wrongly resolved — the same bug, failing the
  // other way, and louder only by luck.
  const satisfied = new Set([...provided, ...namesDeclaredIn(stripComments(block))]);
  let frontier = [stripComments(block)];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const fragment of frontier) {
      for (const [name, offset] of declarations) {
        if (satisfied.has(name) || resolved.has(name)) continue;
        if (!reaches(fragment, name)) continue;
        const source = declarationAt(shipSource, offset);
        try {
          new Function(`${source}\nreturn ${name};`);
        } catch (e) {
          throw new Error(
            `the dispatch block reaches ${name}, which ship.js declares at module scope, ` +
              `and the slice for it does not parse: ${(e as Error).message}`,
          );
        }
        // Stored RAW, because this text is prepended as real code and its
        // comments are part of the file. Scanned STRIPPED, because the next
        // hop is the same question `reaches` just answered.
        resolved.set(name, { offset, source });
        next.push(stripComments(source));
      }
    }
    frontier = next;
  }

  return [...resolved.values()].sort((a, b) => a.offset - b.offset).map(r => r.source);
}

/** The names the factory below supplies, as parameters or as prepended text. */
const INJECTED = new Set([
  "log",
  "briefedAgent",
  "parallel",
  "WORK_DIR",
  "ISSUE",
  "PROJECT_ROOT",
  "BUILD_RESULT_SCHEMA",
  "runImplement",
  "implementRefusal",
  "worktreeIdentity",
  "REPO",
  "taskSourceRefusal",
  "establishRunRef",
  "integrateWave",
  "waveNeedsIntegration",
  "measureLaunchBase",
  // supplied as text, from FILES-CHANGED-SHAPE
  "filesChangedShapeRefusal",
  // #830, supplied as text from the same block. SECURITY-HELPERS is
  // prepended with it, because it calls `pathRefusal` from there — without
  // the name here the resolver follows it to module scope and prepends a
  // second copy of `FILES_CHANGED_SHAPE_RULES`, which does not parse.
  "reportedPathRefusal",
]);

function loadRunDecomposedShip(deps: {
  briefedAgent: BriefedAgentFake;
  runImplement?: () => Promise<unknown>;
}) {
  const block = DECOMPOSED_BLOCK;
  const logs: string[] = [];

  // The real Workflow runtime injects `parallel` as a global that takes an array
  // of thunks and resolves them concurrently — mirrored here exactly.
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((t) => t()));

  // #181 added a per-sub-issue guard that lives outside these markers, so
  // the block now has a free reference. The REAL one is injected, sliced
  // from its own markers — a stub here would let the two blocks disagree
  // about what an empty implement result means, and nothing would notice.
  const guardStart = shipSource.indexOf("// ──── IMPLEMENT-RESULT-START ────");
  const guardEnd = shipSource.indexOf("// ──── IMPLEMENT-RESULT-END ────");
  if (guardStart === -1 || guardEnd === -1) {
    throw new Error("ship.js is missing the IMPLEMENT-RESULT-START/END markers");
  }
  const implementRefusal = new Function(
    `${shipSource.slice(guardStart, guardEnd)}\nreturn implementRefusal;`,
  )();

  // #611 added a second free reference the same way. The block text is
  // evaluated into the factory body below rather than injected, because
  // ship.js declares it at module scope beside the decomposed block.
  const shapeStart = shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-START ────");
  const shapeEnd = shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-END ────");
  if (shapeStart === -1 || shapeEnd === -1) {
    throw new Error("ship.js is missing the FILES-CHANGED-SHAPE-START/END markers");
  }
  // #830 put `reportedPathRefusal` in those same markers, and it reaches
  // into SECURITY-HELPERS for `pathRefusal`. The real table is evaluated
  // beneath the block rather than stubbed, for the reason above — and
  // because a stub would let this suite and ship.js disagree about which
  // paths may be contributed, which is the disagreement #830 is.
  const helpersStart = shipSource.indexOf("// ──── SECURITY-HELPERS-START ────");
  const helpersEnd = shipSource.indexOf("// ──── SECURITY-HELPERS-END ────");
  if (helpersStart === -1 || helpersEnd === -1) {
    throw new Error("ship.js is missing the SECURITY-HELPERS-START/END markers");
  }
  const shapeBlock =
    `${shipSource.slice(helpersStart, helpersEnd)}\n${shipSource.slice(shapeStart, shapeEnd)}`;

  // #218's guard, injected for the same reason as the one above: a stub
  // would let this block and the real one disagree about which repository a
  // worktree belongs to, and nothing would notice.
  const identityStart = shipSource.indexOf("// ──── WORKTREE-IDENTITY-START ────");
  const identityEnd = shipSource.indexOf("// ──── WORKTREE-IDENTITY-END ────");
  if (identityStart === -1 || identityEnd === -1) {
    throw new Error("ship.js is missing the WORKTREE-IDENTITY-START/END markers");
  }
  const worktreeIdentity = new Function(
    `${shipSource.slice(identityStart, identityEnd)}\nreturn worktreeIdentity;`,
  )();

  // #180's guard, injected for the reason the two above are.
  const precStart = shipSource.indexOf("// ──── BRIEF-PRECEDENCE-START ────");
  const precEnd = shipSource.indexOf("// ──── BRIEF-PRECEDENCE-END ────");
  if (precStart === -1 || precEnd === -1) {
    throw new Error("ship.js is missing the BRIEF-PRECEDENCE-START/END markers");
  }
  const taskSourceRefusal = new Function(
    `${shipSource.slice(precStart, precEnd)}\nreturn taskSourceRefusal;`,
  )();

  // #420's predicate, injected for the reason the three above are.
  const refStart = shipSource.indexOf("// ──── RUN-REF-START ────");
  const refEnd = shipSource.indexOf("// ──── RUN-REF-END ────");
  if (refStart === -1 || refEnd === -1) {
    throw new Error("ship.js is missing the RUN-REF-START/END markers");
  }
  const sliced = (_name: string, fn: string) =>
    new Function(`${shipSource.slice(refStart, refEnd)}\nreturn ${fn};`)();

  // #627: anything the block calls that the list below does not supply is
  // followed to its declaration and prepended. Today this is empty — the
  // assertion in "AC-7a" states that, so a binding arriving here is visible
  // rather than silent.
  const followed = resolveFreeReferences(block, INJECTED);

  const factory = new Function(
    "log",
    "briefedAgent",
    "parallel",
    "WORK_DIR",
    "ISSUE",
    "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA",
    "runImplement",
    "implementRefusal",
    "worktreeIdentity",
    "REPO",
    "taskSourceRefusal",
    "establishRunRef",
    "integrateWave",
    "waveNeedsIntegration",
    "measureLaunchBase",
    // #611's element-shape guard, evaluated INTO the block's scope for the
    // same reason the guards above are injected: a stub would let this suite
    // and the real block disagree about what a reported path is.
    `${shapeBlock}\n${followed.join("\n")}\n${block}\nreturn runDecomposedShip;`,
  );

  const runDecomposedShip = factory(
    (m: string) => logs.push(String(m)),
    deps.briefedAgent,
    parallel,
    "/tmp/work",
    66,
    REPO_ROOT,
    {},
    deps.runImplement ?? (async () => ({ success: true, buildResult: {} })),
    implementRefusal,
    worktreeIdentity,
    RUN_REPO,
    // #180 guard, injected from its own markers rather than stubbed — the
    // same reason the two above are.
    taskSourceRefusal,
    async () => ({ branch: "rungate/run-66", refusal: null }),
    async () => ({ ok: true, integrated: 0 }),
    sliced("RUN-REF", "waveNeedsIntegration"),
    async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
  );

  return { runDecomposedShip, logs, followed };
}

/** Records the execution window of each call so overlap can be measured. */
function makeTimingAgent(opts: {
  delayMs: number;
  failOn?: string;
  calls: AgentCall[];
}): BriefedAgentFake {
  return async (_prompt, { label }) => {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, opts.delayMs));
    const end = performance.now();
    opts.calls.push({ label, start, end });
    if (opts.failOn && label.includes(opts.failOn)) {
      return { success: false, findings: ["injected failure"] };
    }
    return { success: true, filesChanged: [`${label}.ts`], worktreePath: "/tmp/wt", worktreeRepo: `git@github.com:${RUN_REPO}.git`, taskSource: "brief" };
  };
}

const DISJOINT_SUB_ISSUES = [
  { title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
  { title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
  { title: "gamma", acs: ["g1"], filesToModify: ["lib/gamma.ts"], size: "S" },
];

const OVERLAPPING_SUB_ISSUES = [
  { title: "alpha", acs: ["a1"], filesToModify: ["lib/shared.ts"], size: "S" },
  { title: "beta", acs: ["b1"], filesToModify: ["lib/shared.ts"], size: "S" },
];

/** True when every call's window intersects at least one other call's window. */
function windowsOverlap(calls: AgentCall[]): boolean {
  return calls.every((a) =>
    calls.some((b) => a !== b && a.start < b.end && b.start < a.end),
  );
}

describe("AC-1: disjoint sub-issues dispatch concurrently (#66, SC-411)", () => {
  test("execution windows of independent sub-issues overlap", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 60, calls }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      success: boolean;
      buildResult: { filesChanged: string[] };
    };

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(3);
    expect(windowsOverlap(calls)).toBe(true);
  });

  test("wall-clock is bounded by the slowest sub-issue, not their sum", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 60, calls }),
    });

    const started = performance.now();
    await runDecomposedShip(DISJOINT_SUB_ISSUES);
    const elapsed = performance.now() - started;

    // Serial would be >=180ms for three 60ms sub-issues.
    expect(elapsed).toBeLessThan(150);
  });

  test("every sub-issue's changed files reach the merged result", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 5, calls }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      buildResult: { filesChanged: string[] };
    };

    expect(result.buildResult.filesChanged).toHaveLength(3);
  });
});

describe("AC-2: a failing sub-issue preserves completed siblings (#66, D-4)", () => {
  test("results from succeeded siblings survive a mid-batch failure", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({
        delayMs: 5,
        failOn: "66002", // the second sub-issue: ISSUE * 1000 + 1 + 1
        calls,
      }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      success: boolean;
      completed?: unknown[];
      failed?: unknown[];
    };

    expect(result.success).toBe(false);
    // D-4: "no work is lost" — the two siblings that succeeded must be reported.
    expect(result.completed).toBeDefined();
    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });
});

describe("AC-3: logging matches the dispatch mechanism actually used", () => {
  test("the disjoint path does not claim batch-ship dispatch", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip, logs } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 1, calls }),
    });

    await runDecomposedShip(DISJOINT_SUB_ISSUES);

    const claimsBatchShip = logs.some((l) => /batch-ship/i.test(l));
    expect(claimsBatchShip).toBe(false);
  });

  test("ship.js does not reference batch-ship without importing it", () => {
    const mentionsBatchShip = /batch-ship/i.test(shipSource);
    const importsBatchShip =
      /import\s[^\n]*batch-ship/.test(shipSource) ||
      /scriptPath:[^\n]*batch-ship/.test(shipSource);
    if (mentionsBatchShip) {
      expect(importsBatchShip).toBe(true);
    }
  });
});

// ── AC-7a / AC-7c (#627): the staging rows, and the loader that reaches them ──

/** The remote every fixture worktree reports, matching RUN_REPO (#218). */
const PAIRED_REMOTE = `git@github.com:${RUN_REPO}.git`;

/**
 * One DISTINCT worktree, file and claim per sub-issue.
 *
 * `makeTimingAgent` reports `/tmp/wt` for all three, which is right for
 * measuring concurrency and useless for measuring a pairing: three rows that
 * agree on every field are satisfied by a binding that shuffles them. Here
 * every field differs per sub-issue, and none of them equals the claim.
 */
function makePairedAgent(opts: { failOn?: string } = {}): BriefedAgentFake {
  return async (_prompt, { label }) => {
    if (opts.failOn && label.includes(opts.failOn)) {
      return { success: false, findings: ["injected failure"] };
    }
    return {
      success: true,
      filesChanged: [`${label}.ts`],
      worktreePath: `/tmp/wt-${label}`,
      worktreeRepo: PAIRED_REMOTE,
      taskSource: "brief",
    };
  };
}

interface StagedRow {
  worktreePath: unknown;
  worktreeRepo: unknown;
  filesChanged: unknown;
  claimedFiles: unknown;
}

/**
 * The four fields #627's binding is responsible for, in a stable order.
 *
 * Projected rather than compared whole, because an added field is not a
 * regression and a DROPPED one is — a `toEqual` over the raw row would refuse
 * the first and the projection below still catches the second.
 */
function stagedRows(buildResult: unknown): StagedRow[] {
  const rows = ((buildResult as { agentResults?: unknown[] })?.agentResults ?? []) as Array<
    Record<string, unknown>
  >;
  return rows
    .map(r => ({
      worktreePath: r.worktreePath,
      worktreeRepo: r.worktreeRepo,
      filesChanged: r.filesChanged,
      claimedFiles: r.claimedFiles,
    }))
    .sort((a, b) => String(a.worktreePath).localeCompare(String(b.worktreePath)));
}

/** What the sub-issue at index `i` of DISJOINT_SUB_ISSUES must stage. */
function expectedRow(i: number): StagedRow {
  const label = `marcus-sub-${66 * 1000 + i + 1}`;
  return {
    worktreePath: `/tmp/wt-${label}`,
    worktreeRepo: PAIRED_REMOTE,
    filesChanged: [`${label}.ts`],
    claimedFiles: DISJOINT_SUB_ISSUES[i]!.filesToModify,
  };
}

describe("AC-7a: the loader follows the pairing binding wherever it is declared (#627)", () => {
  test("every free reference the dispatch block makes is accounted for", () => {
    const { followed } = loadRunDecomposedShip({
      briefedAgent: makePairedAgent(),
    });
    // Empty today: `filesChangedShapeRefusal` is the block's one module-scope
    // call and it is prepended by name. A binding that moves out of the block
    // shows up here as a slice, which is the point — the suite follows it
    // instead of dying on a ReferenceError inside an async dispatch.
    expect(
      followed,
      "a module-scope binding was followed into the block — check it does not shadow an injected fake",
    ).toEqual([]);
  });

  test("a binding named only in a comment is not followed", () => {
    // The regression this file shipped red with. #627's pairing docstring
    // explains the defect by naming `SINGLE_WORKTREE_EXEMPT` in prose; the
    // SCREAMING_CASE arm of `reaches` matches a bare word, so unstripped it
    // followed a sentence and prepended a `const` the block never uses.
    //
    // Asserted as a PAIR derived from one source, so the two halves cannot
    // drift: the same reference, once in a comment and once as code.
    const decl = "const SINGLE_WORKTREE_EXEMPT";
    expect(
      shipSource.split(decl).length - 1,
      "the fixture assumes ship.js declares this exactly once",
    ).toBe(1);

    const inProse = "/* a note about SINGLE_WORKTREE_EXEMPT and nothing else */";
    const asCode = "const x = SINGLE_WORKTREE_EXEMPT";
    expect(resolveFreeReferences(inProse, new Set())).toEqual([]);
    // The control, and the reason the line above is a measurement rather than
    // a resolver that stopped working: the identical name, in code, IS found.
    expect(resolveFreeReferences(asCode, new Set()).join("\n")).toContain(decl);
  });

  test("control: the resolver is not a no-op — withholding one name finds it", () => {
    // Without this, `followed` being empty above is indistinguishable from a
    // resolver that can never find anything, which is the vacuous assertion
    // .claude/rules/checks-must-be-able-to-fail.md names.
    const withheld = new Set(INJECTED);
    withheld.delete("filesChangedShapeRefusal");
    const slices = resolveFreeReferences(DECOMPOSED_BLOCK, withheld);
    expect(slices.join("\n")).toContain("function filesChangedShapeRefusal(");
    // And the slices are a usable binding, not merely text that mentions it.
    // `filesChangedShapeRefusal` calls `filesChangedShapeRule`, so a resolver
    // that stopped at the first level would parse and then throw here — which
    // is exactly what it would do to the dispatch after #627 moves a binding.
    const resolved = new Function(
      `${slices.join("\n")}\nreturn filesChangedShapeRefusal;`,
    )() as (b: unknown, l: string) => unknown;
    expect(typeof resolved).toBe("function");
    expect(resolved({ success: true, filesChanged: ["lib/a.ts (modified)"] }, "marcus")).toBeTruthy();
    expect(resolved({ success: true, filesChanged: ["lib/a.ts"] }, "marcus")).toBeNull();
  });
});

describe("AC-7c: the end-of-run staging rows carry the claim beside its pair (#627)", () => {
  test("every succeeded sub-issue stages its own worktree, remote, files and claim", async () => {
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makePairedAgent(),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      success: boolean;
      buildResult: unknown;
    };

    expect(result.success).toBe(true);
    expect(stagedRows(result.buildResult)).toEqual([
      expectedRow(0),
      expectedRow(1),
      expectedRow(2),
    ]);
  });

  test("the claim is the PLAN, not a copy of what the agent changed", async () => {
    // The cheapest wrong fix for "claimedFiles arrives undefined in the wave
    // path" is `claimedFiles: r.buildResult.filesChanged` — the field is then
    // always present, the collection guard always agrees with itself, and
    // SC-413 is switched off for every run. Every fixture row reports a file
    // its plan does not name, so that repair cannot pass this.
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makePairedAgent(),
    });
    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as { buildResult: unknown };

    const rows = stagedRows(result.buildResult);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Array.isArray(row.claimedFiles), "the claim is absent on a staged row").toBe(true);
      expect(row.claimedFiles, "a staged row carries an empty claim").not.toEqual([]);
      expect(
        row.claimedFiles,
        "the claim is a copy of filesChanged, so the guard can only ever agree with itself",
      ).not.toEqual(row.filesChanged);
    }
  });

  test("a mid-batch failure stages the survivors with their own claims", async () => {
    // The failure branch builds its own `agentResults`. Two staging sites
    // means two chances to lose the claim, and the all-green case above
    // cannot see the second one.
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makePairedAgent({ failOn: "66002" }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      success: boolean;
      buildResult: unknown;
    };

    expect(result.success).toBe(false);
    expect(stagedRows(result.buildResult)).toEqual([expectedRow(0), expectedRow(2)]);
  });
});

describe("overlapping sub-issues still serialize (SC-411, D-2)", () => {
  test("the overlap path delegates to the single-agent implement", async () => {
    const calls: AgentCall[] = [];
    let implementCalled = 0;
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 1, calls }),
      runImplement: async () => {
        implementCalled += 1;
        return { success: true, buildResult: { filesChanged: ["lib/shared.ts"] } };
      },
    });

    const result = (await runDecomposedShip(OVERLAPPING_SUB_ISSUES)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(implementCalled).toBe(1);
    // No per-sub-issue agents on the overlap path.
    expect(calls).toHaveLength(0);
  });
});
