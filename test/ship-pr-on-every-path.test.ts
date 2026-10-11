import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable, enclosingChain } from "../lib/reachability";

/**
 * #254 — every run that reaches the Ship phase opens a PR.
 *
 * `pr-upsert` used to appear exactly once in `workflows/ship.js`, inside the
 * `else` arm of `if (containerConfig)`. A consumer that configures a container
 * therefore got the container probe and no PR at all, while the run went on to
 * report a shipped status: `prReadiness` returned `NO_PR`, which is accurate
 * and says nothing, and the ship gate cannot tell the two arms apart because
 * `rebuild: 'SKIP'` short-circuits `local-before-prod` either way. Recorded as
 * a known constraint beside SC-631..SC-637 rather than fixed; this is the fix.
 *
 * Two kinds of evidence, because either alone is a check that cannot fail:
 *
 * - **Executed.** The marked regions of ship.js are sliced and run over a
 *   sandbox that records which agents were spawned, under both arms. The
 *   mutant — the PR step put back as the last statement of the `else` arm — is
 *   built from the same bytes and run against the same input, and the
 *   container path then spawns no PR step. That is #254, reproduced and
 *   observed, not described.
 * - **Positional.** Executing the slice proves which arm the spawn sits in and
 *   says nothing about whether the region runs at all: wrapping it in
 *   `if (false)` outside the marker comments leaves the slice byte-identical.
 *   `assertMarkedBlockReachable` reads the block's position in the parse
 *   instead. Run wf_c71f950f-c88 DELETED this guard to heal an unrelated gate
 *   failure and was refused by security review for it — it is restored here,
 *   and `test/reachability-refusals.test.ts` carries PR-UPSERT in both of its
 *   marker lists so the refusal itself is proven able to fail.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

/**
 * The OUTER pair spans both arms and the PR step; the inner pair wraps the PR
 * step alone. One region, executed as written, because slicing the arms and
 * the PR step apart and concatenating them rebuilds a correct program no
 * matter where the PR step really sits — measured, not feared: the first draft
 * of this file did exactly that, and with the PR step moved back inside the
 * `else` arm it still reported the container path opening a PR.
 */
const REGION_START = "// ──── SHIP-PR-PATHS-START ────";
const REGION_END = "// ──── SHIP-PR-PATHS-END ────";
const PR_START = "// ──── PR-UPSERT-START ────";
const PR_END = "// ──── PR-UPSERT-END ────";

/**
 * Module scope on purpose: a missing marker throws while this file is loading,
 * so every test below fails to run. Resolving it lazily and skipping when
 * absent would turn "ship.js lost its top-level PR step" into a quiet green
 * run, which is the shape .claude/rules/checks-must-be-able-to-fail.md counts.
 */
function sliceBlock(start: string, end: string): string {
  const a = shipSource.indexOf(start);
  const b = shipSource.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`workflows/ship.js is missing the ${start} / ${end} markers`);
  }
  if (shipSource.indexOf(start, a + 1) !== -1 || shipSource.indexOf(end, b + 1) !== -1) {
    throw new Error(`${start} / ${end} appears more than once — the slice is ambiguous`);
  }
  return shipSource.slice(a + start.length, b);
}

/** The Ship phase's env arms AND its PR step, exactly as ship.js orders them. */
const REGION = sliceBlock(REGION_START, REGION_END);
/** The PR step alone, markers included, so it can be relocated verbatim. */
const PR_SUBREGION = (() => {
  const a = REGION.indexOf(PR_START);
  const b = REGION.indexOf(PR_END);
  if (a === -1 || b < a) {
    throw new Error(
      "the PR-UPSERT pair is not inside the SHIP-PR-PATHS region — the outer " +
        "region no longer contains the step this file is about",
    );
  }
  return REGION.slice(a, b + PR_END.length);
})();

/** The label of the step that opens or updates the PR. */
const PR_LABEL = "create-pr";
/** The label of the container arm's own environment recording. */
const CONTAINER_ENV_LABEL = "record-env";
/** The label of the no-container arm's environment recording. */
const SKIP_ENV_LABEL = "record-env-skip";

/**
 * The last statement of the `else` arm, and so the insertion point for the
 * mutant. Anchoring on the label rather than a brace means a rename aborts the
 * file with "could not build the mutant" instead of quietly building a mutant
 * that changes nothing.
 */
const ELSE_ARM_TAIL = `{ label: '${SKIP_ENV_LABEL}', phase: 'Ship' })`;

type Spawn = { label: string; prompt: string };

/**
 * Execute ship.js's Ship-phase env + PR regions over a sandbox.
 *
 * `with` over a Proxy, the same shape test/security-verdict-blocks.ts uses and
 * for the same reason: which module-scope names the region reads is an
 * implementation detail that moves, and a name nothing supplies resolves to
 * `undefined` — which throws where it is used rather than passing quietly.
 */
async function runShipRegion(
  program: string,
  containerConfig: unknown,
): Promise<{ spawns: Spawn[]; prStep: unknown }> {
  const spawns: Spawn[] = [];
  const scope: Record<string, unknown> = {
    containerConfig,
    HARNESS_ROOT: "/harness",
    WORK_DIR: "/tmp/work",
    ISSUE: 254,
    ISSUE_REPO: "hornjason/pai-harness",
    REPO: "hornjason/pai-harness",
    shipBranch: "254-deep-modules",
    log: () => {},
    timedAgent: async (prompt: string, opts: { label: string }) => {
      spawns.push({ label: opts.label, prompt });
      return opts.label === PR_LABEL
        ? { ok: true, prNumber: 254, prUrl: "https://x/pull/254", prDraft: true }
        : {};
    },
  };
  const sandbox = new Proxy(scope, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      return key in target
        ? target[key as string]
        : (globalThis as unknown as Record<string, unknown>)[key as string];
    },
  });
  const factory = new Function(
    "__scope__",
    `return (async function () { with (__scope__) {\n${program}\nreturn { prStep }\n} })()`,
  );
  const out = (await factory(sandbox)) as { prStep: unknown };
  return { spawns, prStep: out.prStep };
}

/** The real file's region, run as written. */
const REAL_PROGRAM = REGION;

/**
 * #254, reintroduced: the PR step LIFTED OUT of the module body and put back
 * as the last statement of the `else` arm, so it runs only when no container
 * is configured. Lifted out, not copied — a mutant that leaves the top-level
 * copy in place is the defect plus the fix, and runs a PR step either way.
 */
function buildMutantProgram(): string {
  if (!REGION.includes(ELSE_ARM_TAIL)) {
    throw new Error(
      `could not build the mutant: ${JSON.stringify(ELSE_ARM_TAIL)} appears 0 times in the ` +
        "region — the no-container arm's agent step was renamed",
    );
  }
  const lifted = REGION.replace(PR_SUBREGION, "");
  if (lifted === REGION) {
    throw new Error("could not build the mutant: the PR step could not be lifted out");
  }
  if (lifted.includes("github-op.ts pr-upsert")) {
    throw new Error(
      "could not build the mutant: a pr-upsert survives outside the PR block, so " +
        "relocating the block would not move the step",
    );
  }
  const mutant = lifted.replace(ELSE_ARM_TAIL, `${ELSE_ARM_TAIL}\n${PR_SUBREGION}`);
  if (mutant === lifted) {
    throw new Error("could not build the mutant: the substitution changed nothing");
  }
  return mutant;
}

const CONTAINER = { hosts: ["localhost"], port: 3000, healthPath: "/health" };

const labels = (spawns: Spawn[]) => spawns.map((s) => s.label);

// ── AC-1: the PR step is not owned by one arm ───────────────────────────

describe("#254: every path through the Ship phase opens a PR", () => {
  test("the container arm reaches the PR step", async () => {
    const run = await runShipRegion(REAL_PROGRAM, CONTAINER);
    expect(
      labels(run.spawns),
      "a consumer that configures a container still gets no PR — this is #254",
    ).toEqual([CONTAINER_ENV_LABEL, PR_LABEL]);
    expect((run.prStep as { ok?: boolean })?.ok).toBe(true);
  });

  test("the no-container arm reaches the same PR step", async () => {
    const run = await runShipRegion(REAL_PROGRAM, null);
    expect(labels(run.spawns)).toEqual([SKIP_ENV_LABEL, PR_LABEL]);
    expect((run.prStep as { prNumber?: number })?.prNumber).toBe(254);
  });

  test("there is exactly one PR step in the file, so neither arm has its own", () => {
    expect(shipSource.match(/github-op\.ts pr-upsert/g) || []).toHaveLength(1);
    expect(shipSource.match(/label: 'create-pr'/g) || []).toHaveLength(1);
    expect(PR_SUBREGION, "the marked PR block is not the one that runs pr-upsert").toContain(
      "github-op.ts pr-upsert",
    );
  });

  test("the spawn's ancestors in the parse contain no conditional", () => {
    const start = shipSource.indexOf(PR_START) + PR_START.length;
    const end = shipSource.indexOf(PR_END);
    expect(enclosingChain(shipSource, start, end)).toEqual(["Program"]);
  });
});

// ── AC-2: the fix can be undone, and the test notices ───────────────────

describe("#254: the mutant puts the PR step back inside the else arm", () => {
  test("the mutant's container path spawns no PR step, on the same input the real one does", async () => {
    const mutant = buildMutantProgram();
    const real = await runShipRegion(REAL_PROGRAM, CONTAINER);
    const broken = await runShipRegion(mutant, CONTAINER);

    expect(labels(real.spawns)).toEqual([CONTAINER_ENV_LABEL, PR_LABEL]);
    expect(
      labels(broken.spawns),
      "the mutant still opened a PR on the container path — this case is not " +
        "measuring what it claims to",
    ).toEqual([CONTAINER_ENV_LABEL]);
    expect(broken.prStep ?? null).toBeNull();
  });

  test("the mutant is a relocation of the real bytes, not a hand-written fixture", () => {
    const mutant = buildMutantProgram();
    expect(mutant).not.toBe(REGION);
    // Same bytes, one newline longer: the step was moved, not rewritten, so
    // the mutant cannot differ from the real region in anything but position.
    expect(mutant).toContain(PR_SUBREGION);
    expect(mutant.length).toBe(REGION.length + 1);
    expect(mutant.match(/github-op\.ts pr-upsert/g) || []).toHaveLength(1);
  });

  test("the no-container path is unaffected by the mutation — the container arm is the defect", async () => {
    const broken = await runShipRegion(buildMutantProgram(), null);
    expect(labels(broken.spawns)).toEqual([SKIP_ENV_LABEL, PR_LABEL]);
  });
});

// ── AC-3: the container arm keeps its own environment recording ─────────

describe("#254: environment recording stays with the arm that measured it", () => {
  test("the container arm records prod rebuild, smoke and quinn itself", async () => {
    const run = await runShipRegion(REAL_PROGRAM, CONTAINER);
    const env = run.spawns.find((s) => s.label === CONTAINER_ENV_LABEL);
    expect(env, "the container arm no longer records the environment").toBeDefined();
    for (const field of ["rebuild", "smoke", "quinn"]) {
      expect(
        env!.prompt,
        `the container arm's recording no longer sets environments.prod.${field}`,
      ).toContain(`environments.prod.${field}`);
    }
    expect(env!.prompt, "the container probe lost its health check").toContain("localhost:3000/health");
  });

  test("the no-container arm records prod as SKIP itself", async () => {
    const run = await runShipRegion(REAL_PROGRAM, null);
    const env = run.spawns.find((s) => s.label === SKIP_ENV_LABEL);
    expect(env).toBeDefined();
    for (const field of ["rebuild", "smoke", "quinn"]) {
      expect(env!.prompt).toContain(`${field}:'SKIP'`);
    }
  });

  test("the recording is not folded into the PR step", async () => {
    const container = await runShipRegion(REAL_PROGRAM, CONTAINER);
    const none = await runShipRegion(REAL_PROGRAM, null);
    for (const run of [container, none]) {
      const pr = run.spawns.find((s) => s.label === PR_LABEL)!;
      expect(
        pr.prompt,
        "the PR step writes environments.prod, so the two arms' recordings are " +
          "no longer distinguishable",
      ).not.toContain("environments.prod");
      expect(pr.prompt).not.toContain("writeWorkflowState");
    }
  });
});

// ── AC-4: the region is proven to RUN, not merely to be well-placed ─────

describe("#254: the PR block is reachable", () => {
  /**
   * Restored after wf_c71f950f-c88 deleted it. The three executed cases above
   * are all blind to this: `if (false)` placed outside the marker comments
   * leaves the region byte-identical, every slice still executes, and the file
   * stays green over a workflow that opens no PRs at all.
   */
  test("it sits at module top level, not inside a conditional", () => {
    expect(assertMarkedBlockReachable(shipSource, "PR-UPSERT")).toEqual(["Program"]);
  });

  test("the whole executed region is top level too", () => {
    expect(assertMarkedBlockReachable(shipSource, "SHIP-PR-PATHS")).toEqual(["Program"]);
  });
});

// ── The positional claims #252 made must still hold ─────────────────────

describe("#254 does not undo #252: the PR is still opened as a draft, before every refusal", () => {
  test("the pr-upsert command still passes --draft", () => {
    const upsert = PR_SUBREGION.match(/github-op\.ts pr-upsert[\s\S]{0,400}?\n\n/);
    expect(upsert, "the marked PR block no longer contains a complete pr-upsert command").not.toBeNull();
    expect(upsert![0], "the PR is opened without --draft, so a refusal leaves it mergeable").toContain(
      "--draft",
    );
  });

  test("the PR step still runs before the ship gate and the undraft step", () => {
    const upsertAt = shipSource.indexOf("github-op.ts pr-upsert");
    const shipGateAt = shipSource.indexOf("log('Running ship gate')");
    const readyAt = shipSource.indexOf("github-op.ts pr-ready");
    expect(upsertAt).toBeGreaterThan(-1);
    expect(shipGateAt).toBeGreaterThan(upsertAt);
    expect(readyAt).toBeGreaterThan(shipGateAt);
  });

  test("moving the step did not move it past the blocking-grade refusal", () => {
    const grades = shipSource.indexOf("// ──── BLOCKING-GRADES-END ────");
    expect(grades, "the blocking-grade block was removed").toBeGreaterThan(-1);
    expect(grades).toBeLessThan(shipSource.indexOf(PR_START));
  });
});
