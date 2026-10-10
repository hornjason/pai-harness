/**
 * The Verify fan-out records why it did not run (#126) — producing side
 *
 * The consumer half lives in `test/gate-vacuous-checks.test.ts` and
 * `test/suite-binding-mutation.test.ts`: an absent `gates.verify.adversary`
 * is now a refusal rather than a `console.warn` and an early `return`.
 *
 * That half alone is not enough, and #235 is where this repo learned why:
 *
 * > **Mutate both ends of the binding, not just the reader.** The producing
 * > function is a third mutation, and it is the one a reader-only proof
 * > cannot catch.
 *
 * Measured, not assumed: with only the consumer tested, neutralising the
 * producer's recording — deleting the two `{ skipped: reason }` assignments in
 * `gates/gate-executor.ts` — left 42 of 42 tests green. A refusal that nothing
 * can satisfy is as broken as one nothing can trigger; without this file the
 * fix could have made every legitimate skip into a hard failure, or stopped
 * recording altogether, and the suite would not have noticed either way.
 *
 * So this runs the REAL gate executor — `bun run gates/run-gate.ts --gate
 * verify` against a planted work dir, the same way test/contract-negative.ts
 * does — and reads what it actually wrote to workflow-state.json. No agents
 * are spawned: every case here is one of the paths on which the fan-out is
 * deliberately skipped, which is the whole subject.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { fanoutSkipReason } from "../gates/gate-executor";

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_RUNNER = join(REPO_ROOT, "gates", "run-gate.ts");
const GOVERNING_SPEC = join(REPO_ROOT, "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md");
const BASE_DIR = "/tmp/harness-fanout-recording";

beforeEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
  mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

/**
 * A verify-phase state with the fan-out slots ABSENT, which is the state the
 * executor is handed before it decides whether to run them.
 *
 * `gates.verify` carries a result because the executor rewrites it; what
 * matters for this file is only that neither `adversary` nor
 * `evidenceValidator` is present on the way in, so anything found on the way
 * out was written by the run.
 */
function plant(slug: string, extra: Record<string, unknown> = {}): string {
  const dir = join(BASE_DIR, slug);
  mkdirSync(dir, { recursive: true });
  const state = {
    schemaVersion: 2,
    issue: 126,
    slug,
    repo: "test/repo",
    issueRepo: "test/repo",
    projectRoot: "/tmp/test",
    phase: "VERIFY",
    issueGoal: "the verify fan-out records why it did not run",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "a skipped fan-out records its reason",
        threshold: { op: "==", value: 0, unit: "failures" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    gates: { scope: { result: "PASS", attempt: 1, failures: [] } },
    environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
    agents: { marcus: { spawned: true, verdict: "PASS" } },
    buildCommit: "abc1234",
    changelog: [],
    bootstrappedFrom: "ship-workflow",
    ...extra,
  };
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(state, null, 2));
  return dir;
}

function runVerify(slug: string, env: Record<string, string> = {}): Record<string, any> {
  const prefix = Object.entries({ RUNGATE_WORK_DIR: BASE_DIR, ...env })
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  try {
    execSync(`${prefix} bun run ${GATE_RUNNER} --gate verify --slug ${slug} --issue 126 2>&1`, {
      encoding: "utf-8",
      timeout: 120000,
    });
  } catch {
    // A failing verify gate exits non-zero. That is the subject of half these
    // cases, not an error — what matters is what it wrote before exiting.
  }
  return JSON.parse(readFileSync(join(BASE_DIR, slug, "workflow-state.json"), "utf-8"));
}

/** Both slots, because a fix applied to one of them is the obvious half-fix. */
const SLOTS = ["adversary", "evidenceValidator"] as const;

describe("#126 producing side: a skipped fan-out writes down why", () => {
  test("both slots carry a non-empty reason, not merely a key", () => {
    plant("skip-agents");
    const out = runVerify("skip-agents", { RUNGATE_SKIP_AGENTS: "1" });

    for (const slot of SLOTS) {
      const rec = out.gates?.verify?.[slot];
      expect(rec, `gates.verify.${slot} was not written at all`).toBeDefined();
      expect(typeof rec.skipped, `gates.verify.${slot}.skipped is not a string`).toBe("string");
      expect(rec.skipped.trim().length, `gates.verify.${slot} recorded an empty reason`)
        .toBeGreaterThan(0);
    }
    // Both slots agree, because one run has one reason. Divergence would mean
    // the two assignments had drifted apart, which is what a single binding
    // exists to prevent.
    expect(out.gates.verify.adversary.skipped).toBe(out.gates.verify.evidenceValidator.skipped);
  });

  test("a verify gate that already failed records THAT as the reason", () => {
    // The run wf_e105dd33-220 case, reproduced. The gate had failures, so the
    // fan-out was skipped, so the slots stayed empty — and the output then
    // said "B2 agent may not have run", which is true and reads like the
    // cause when it is the consequence. The reason is now the real one.
    plant("already-failed");
    const out = runVerify("already-failed");

    const reasons = SLOTS.map(s => out.gates?.verify?.[s]?.skipped);
    for (const [i, reason] of reasons.entries()) {
      expect(reason, `gates.verify.${SLOTS[i]} recorded no skip reason`).toBeTruthy();
    }
    // Either of the two pre-agent conditions is a legitimate answer here — the
    // fixture's projectRoot does not exist, so the test command cannot run and
    // the gate has failures. What is NOT acceptable is silence, or a reason
    // that points at the agents rather than at what stopped them.
    expect(
      reasons.join(" "),
      `the recorded reason blames the agent instead of naming what skipped it: ${reasons.join(" | ")}`,
    ).toMatch(/failing check|test command exited/);
    expect(reasons.join(" ")).not.toMatch(/may not have run/);
  });

  test("the gate does not refuse its own recorded skip", () => {
    // The two ends, joined. A producer that records something the consumer
    // still refuses would turn every legitimate skip into a hard failure —
    // the opposite fail direction, and the one a reader-only proof cannot
    // see. Measured on the gate's own failures list, from the same run.
    plant("round-trip");
    const out = runVerify("round-trip", { RUNGATE_SKIP_AGENTS: "1" });

    const failures: string[] = out.gates?.verify?.failures || [];
    const refusedOwnSkip = failures.filter(f => /not recorded|skip with no reason/.test(f));
    expect(
      refusedOwnSkip,
      `the gate refused a skip it had just written: ${refusedOwnSkip.join("; ")}`,
    ).toEqual([]);
  });

  test("the executor never leaves a verify run with both slots missing", () => {
    // The property underneath all of the above, stated once: whatever path the
    // executor takes at the verify gate, it does not leave silence behind.
    plant("no-silence");
    const out = runVerify("no-silence", { RUNGATE_SKIP_AGENTS: "1" });
    const written = SLOTS.filter(s => out.gates?.verify?.[s] !== undefined);
    expect(written, "a verify run finished with an unexplained empty fan-out").toEqual([...SLOTS]);
  });
});

/**
 * The branches, driven directly.
 *
 * The executed cases above prove the call site writes what this returns; these
 * prove it returns the right thing for each condition, which a fixture cannot
 * isolate — a planted project with a failing gate is also a project whose test
 * command did not run, so the executed run can only ever exercise whichever
 * condition comes first.
 */
describe("#126 fanoutSkipReason: null means RUN, and every skip has a reason", () => {
  test("a clean gate with agents enabled returns null — the only path that spawns", () => {
    expect(fanoutSkipReason(0, 0, undefined)).toBeNull();
    expect(fanoutSkipReason(0, 0, "")).toBeNull();
  });

  test.each([
    ["a failing check", 3, 0, undefined, /3 failing check/],
    ["a single failing check", 1, 0, undefined, /1 failing check/],
    ["a non-zero test exit", 0, 1, undefined, /test command exited 1/],
    ["the env override", 0, 0, "1", /RUNGATE_SKIP_AGENTS/],
    ["the env override set to anything", 0, 0, "yes", /RUNGATE_SKIP_AGENTS/],
  ])("%s produces a reason that names it", (_label, fails, exit, env, pattern) => {
    const reason = fanoutSkipReason(fails as number, exit as number, env);
    expect(reason, "a skip condition produced no reason").toBeTruthy();
    expect(reason!).toMatch(pattern as RegExp);
  });

  test("a failing gate outranks the env var, so the real cause is reported", () => {
    // Both true at once is the common case — a run with RUNGATE_SKIP_AGENTS
    // set has usually also failed something — and reporting the env var would
    // bury the reason the run is actually in trouble.
    expect(fanoutSkipReason(2, 0, "1")).toMatch(/2 failing check/);
  });

  test("no reason is ever the empty string, which the gate check refuses", () => {
    // The producer and the consumer share one rule: a skip with no readable
    // reason is an absence with extra steps. A reason of "" here would be
    // written into the slot and then refused by the gate, turning a
    // legitimate skip into a hard failure.
    for (const args of [[1, 0, undefined], [0, 1, undefined], [0, 0, "1"]] as const) {
      const reason = fanoutSkipReason(args[0], args[1], args[2]);
      expect(reason!.trim().length).toBeGreaterThan(0);
    }
  });
});
