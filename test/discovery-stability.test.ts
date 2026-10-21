/**
 * #523 — model-output determinism across real dry-runs.
 *
 * WHAT IS UNDER TEST HERE, AND WHAT IS NOT.
 *
 * Not the model. Nothing in this file makes a model call, so nothing in it can
 * red on a model-day. What is under test is the COMPARATOR: whether
 * `compareDiscoveryRuns` can tell a real variance from a vacuous pass. The
 * model measurement itself is a dated report produced by
 * `scripts/measure-discovery-stability.ts`, and deliberately not a gate — a
 * rerun next week measures a different model-day, so a red row there cannot be
 * distinguished from drift (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * THE VACUITY THIS FILE EXISTS TO CLOSE.
 *
 * A comparator over k states has three ways to report "stable" having measured
 * nothing — k<2, a series that is not one input, and a projection whose paths
 * resolve to `undefined` everywhere. All three are REFUSED, and each refusal
 * has its own case below. The third is the one that bites hardest, because a
 * single typo in a declared path turns a measured field into an unobservable
 * one, and an unobservable field is perfectly stable.
 *
 * WHERE THE FIXTURES COME FROM.
 *
 * The path-validity case reads `gates/schema.ts` — the zod objects that EMIT
 * the state — and never `STABLE_DISCOVERY_FIELDS`. Sourcing the fixture from
 * the list being checked is the shape that lets a list agree with itself
 * forever; here the schema is an independent witness, so renaming
 * `ceremonyTier` reddens this file instead of silently making the field
 * unobservable.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ACSchema, WorkflowStateSchema } from "../gates/schema";
import {
  compareDiscoveryRuns,
  formatStabilityReport,
  NOT_ASSERTED,
  readPath,
  seriesInputIdentity,
  STABLE_DISCOVERY_FIELDS,
  type RunState,
  type StableField,
} from "../lib/discovery-stability";

/* ───────────────────────── zod path resolution ──────────────────────────── */

/** Peel the wrappers that do not change a field's name. */
function unwrap(t: any): any {
  for (let i = 0; i < 20; i++) {
    const name = t?._def?.typeName;
    if (name === "ZodOptional" || name === "ZodNullable" || name === "ZodDefault") {
      t = t._def.innerType;
    } else if (name === "ZodEffects") {
      t = t._def.schema;
    } else if (name === "ZodBranded" || name === "ZodReadonly") {
      t = t._def.type ?? t._def.innerType;
    } else {
      return t;
    }
  }
  return t;
}

/**
 * Resolve a declared dotted path against a zod schema, returning the reason it
 * does not resolve or `null` when it does.
 */
function resolveInSchema(root: any, path: string): string | null {
  let node = unwrap(root);
  for (const rawSeg of path.split(".")) {
    const isArray = rawSeg.endsWith("[]");
    const seg = isArray ? rawSeg.slice(0, -2) : rawSeg;
    const alternatives = seg.split("??");

    const def = unwrap(node)?._def;
    if (def?.typeName !== "ZodObject") {
      return `"${rawSeg}" is read off a ${def?.typeName ?? "non-schema"}, not an object`;
    }
    const shape = def.shape();
    const present = alternatives.filter(a => shape[a] !== undefined);
    if (present.length === 0) {
      return `none of [${alternatives.join(", ")}] is a field of this object`;
    }
    let next = unwrap(shape[present[0]]);
    if (isArray) {
      if (unwrap(next)?._def?.typeName !== "ZodArray") {
        return `"${seg}" is declared with [] but the schema says it is a ${unwrap(next)?._def?.typeName}`;
      }
      next = unwrap(unwrap(next)._def.type);
    }
    node = next;
  }
  return null;
}

describe("#523: every declared stable field exists in the schema that emits it", () => {
  /**
   * `acs` holds `ACSchema`, which is a `ZodEffects` (it has a `superRefine`).
   * Resolving through it is the reason `unwrap` handles that wrapper, and this
   * assertion is what notices if the schema stops being reachable that way.
   */
  test("ACSchema is reachable through the state schema's `acs` array", () => {
    expect(resolveInSchema(WorkflowStateSchema, "acs[].id")).toBeNull();
    expect(unwrap(ACSchema)._def.typeName).toBe("ZodObject");
  });

  test("no declared path is unresolvable — an unresolvable path is stable because it is absent", () => {
    const broken = STABLE_DISCOVERY_FIELDS.map(f => ({
      path: f.path,
      why: resolveInSchema(WorkflowStateSchema, f.path),
    })).filter(r => r.why !== null);

    expect(
      broken,
      "a declared stable field that the schema does not have reads `undefined` in every run, " +
        "which the comparator cannot distinguish from a field that never changes. " +
        "Fix the path or remove the entry.",
    ).toEqual([]);
  });

  test("the resolver can actually fail — a path the schema does not have is reported", () => {
    // Negative control. Without this, a resolver that returns null for
    // everything would make the case above pass over any list at all.
    expect(resolveInSchema(WorkflowStateSchema, "sizing.ceremonyTeir")).toMatch(/none of/);
    expect(resolveInSchema(WorkflowStateSchema, "acs[].id[]")).toMatch(/declared with \[\]/);
    expect(resolveInSchema(WorkflowStateSchema, "slug.nope")).toMatch(/not an object/);
  });

  test("the declared set is non-empty and every entry names the consumer that branches on it", () => {
    expect(STABLE_DISCOVERY_FIELDS.length).toBeGreaterThan(0);
    const unjustified = STABLE_DISCOVERY_FIELDS.filter(
      f => !f.branchedOnBy || f.branchedOnBy.trim().length < 20,
    );
    expect(
      unjustified.map(f => f.path),
      "a field is required stable exactly when something downstream BRANCHES on it. " +
        "An entry with no named consumer is asserting stability on prose.",
    ).toEqual([]);
  });

  test("NOT_ASSERTED is stated rather than left implicit, and does not overlap the stable set", () => {
    expect(NOT_ASSERTED.length).toBeGreaterThan(0);
    const stable = new Set(STABLE_DISCOVERY_FIELDS.map(f => f.path));
    expect(NOT_ASSERTED.filter(n => stable.has(n.path)).map(n => n.path)).toEqual([]);
  });
});

/* ────────────────────────────── fixtures ────────────────────────────────── */

/**
 * A minimal discovery state. Built from the field NAMES the schema declares —
 * the test above is what keeps those names honest — rather than copied from a
 * recorded run, so a case here states exactly the one thing it varies.
 */
function stateWith(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    issue: 523,
    slug: "pai-harness-523",
    phase: "DISCOVERY",
    issueGoal: "the same fixed issue body for every run in the series",
    sizing: { predicted: "M", ceremonyTier: "STANDARD" },
    governingSpec: { path: "specs/SHIP.md" },
    sourceSpecs: [{ path: "docs/adr/ADR-002.md", citedInDiscovery: true }],
    acs: [
      {
        id: "AC-1",
        statement: "the first criterion says something of at least five words",
        evidenceMethod: { type: "command", authoredCommand: "bun test test/a.test.ts" },
      },
      {
        id: "AC-2",
        statement: "the second criterion says something of at least five words",
        evidenceMethod: { type: "command", authoredCommand: "bun test test/b.test.ts" },
      },
    ],
    ...over,
  };
}

const runs = (...states: Record<string, unknown>[]): RunState[] =>
  states.map((state, i) => ({ label: `run-${i + 1}`, state }));

/* ───────────────────────────── refusals ─────────────────────────────────── */

describe("#523: the comparator refuses rather than reporting a vacuous pass", () => {
  test("k < 2 is REFUSED, not stable", () => {
    const r = compareDiscoveryRuns(runs(stateWith()));
    expect(r.verdict).toBe("REFUSED");
    expect(r.verdict === "REFUSED" && r.reason).toMatch(/k must be at least 2/);
  });

  test("k = 0 is REFUSED", () => {
    expect(compareDiscoveryRuns([]).verdict).toBe("REFUSED");
  });

  test("runs that do not share an input are REFUSED — they measure the prompt", () => {
    const r = compareDiscoveryRuns(
      runs(stateWith(), stateWith({ issueGoal: "START FROM THE EXISTING BRANCH, AC1-AC5 are done" })),
    );
    expect(r.verdict).toBe("REFUSED");
    expect(r.verdict === "REFUSED" && r.reason).toMatch(/do not share an input/);
    // The refusal has to say WHICH run differs, or it sends the reader back to
    // the files to find out.
    expect(r.verdict === "REFUSED" && r.reason).toMatch(/run-1: issue=523 goal=[0-9a-f]{16}/);
  });

  test("a differing issue number is also not one input, even with identical goal text", () => {
    const r = compareDiscoveryRuns(runs(stateWith(), stateWith({ issue: 524 })));
    expect(r.verdict).toBe("REFUSED");
  });

  test("a projection that reads nothing is REFUSED, because absent is identical everywhere", () => {
    const empty = { schemaVersion: 2, issue: 523, issueGoal: "same", phase: "DISCOVERY" };
    const scalarsOnly = STABLE_DISCOVERY_FIELDS;
    const r = compareDiscoveryRuns(runs(empty, { ...empty }), scalarsOnly);
    expect(r.verdict).toBe("REFUSED");
    expect(r.verdict === "REFUSED" && r.reason).toMatch(/not one of the \d+ declared fields produced a value/);
  });

  test("an empty declared set is REFUSED — zero fields are stable over anything", () => {
    const r = compareDiscoveryRuns(runs(stateWith(), stateWith()), []);
    expect(r.verdict).toBe("REFUSED");
    expect(r.verdict === "REFUSED" && r.reason).toMatch(/zero fields/);
  });
});

/* ─────────────────────────── real comparisons ───────────────────────────── */

describe("#523: what the comparator calls stable and what it calls varied", () => {
  test("two identical runs are MEASURED and stable, with nothing unobserved", () => {
    const r = compareDiscoveryRuns(runs(stateWith(), stateWith()));
    expect(r.verdict).toBe("MEASURED");
    if (r.verdict !== "MEASURED") throw new Error("unreachable");
    expect(r.varied).toEqual([]);
    expect(r.unobserved.map(f => f.path)).toEqual([]);
  });

  test("a different ceremonyTier is a finding — it is two different pipelines", () => {
    const r = compareDiscoveryRuns(
      runs(stateWith(), stateWith({ sizing: { predicted: "M", ceremonyTier: "THOROUGH" } })),
    );
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied.map(f => f.path)).toEqual(["sizing.ceremonyTier"]);
  });

  test("a different AC COUNT is a finding — a varying definition of done", () => {
    const three = stateWith();
    (three.acs as unknown[]).push({
      id: "AC-3",
      statement: "a third criterion of at least five words here",
      evidenceMethod: { type: "command", authoredCommand: "bun test test/c.test.ts" },
    });
    const r = compareDiscoveryRuns(runs(stateWith(), three));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied.map(f => f.path)).toContain("acs[]");
    expect(r.varied.map(f => f.path)).toContain("acs[].id");
  });

  test("REORDERED ACs are stable — discovery promises no ordering", () => {
    const reordered = stateWith({ acs: [...(stateWith().acs as unknown[])].reverse() });
    const r = compareDiscoveryRuns(runs(stateWith(), reordered));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied).toEqual([]);
  });

  test("REWORDED statements are stable — prose is what a model is for", () => {
    const reworded = stateWith();
    (reworded.acs as Record<string, unknown>[])[0].statement =
      "entirely different wording for the very same first criterion";
    const r = compareDiscoveryRuns(runs(stateWith(), reworded));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied).toEqual([]);
  });

  test("an evidence command reflowed across lines is stable — whitespace is noise", () => {
    const reflowed = stateWith();
    (reflowed.acs as Record<string, any>[])[0].evidenceMethod.authoredCommand =
      "bun test\n   test/a.test.ts";
    const r = compareDiscoveryRuns(runs(stateWith(), reflowed));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied).toEqual([]);
  });

  test("a DIFFERENT evidence command is a finding — the scope gate dry-runs it", () => {
    const changed = stateWith();
    (changed.acs as Record<string, any>[])[0].evidenceMethod.authoredCommand =
      "bun test test/SOMETHING-ELSE.test.ts";
    const r = compareDiscoveryRuns(runs(stateWith(), changed));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied.map(f => f.path)).toEqual(["acs[].evidenceMethod.authoredCommand??command"]);
  });

  test("a harness REWRITE of `command` is not attributed to the model (#614)", () => {
    // `authoredCommand` is what the model wrote; `command` is what three
    // deterministic normalisers left behind. Reading `command` would report
    // the normaliser's output as model variance.
    const rewritten = stateWith();
    (rewritten.acs as Record<string, any>[])[0].evidenceMethod.command =
      "bun test /abs/path/test/a.test.ts";
    const r = compareDiscoveryRuns(runs(stateWith(), rewritten));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied).toEqual([]);
  });

  test("`command` IS read when the model's authored form was never recorded", () => {
    const authoredOnly = stateWith();
    const commandOnly = stateWith();
    for (const s of [authoredOnly, commandOnly]) {
      for (const ac of s.acs as Record<string, any>[]) {
        ac.evidenceMethod = { type: "command", command: ac.evidenceMethod.authoredCommand };
      }
    }
    (commandOnly.acs as Record<string, any>[])[0].evidenceMethod.command = "bun test test/z.test.ts";
    const r = compareDiscoveryRuns(runs(authoredOnly, commandOnly));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied.map(f => f.path)).toEqual(["acs[].evidenceMethod.authoredCommand??command"]);
  });

  test("one absent scalar among present ones is VARIED, not quietly skipped", () => {
    const r = compareDiscoveryRuns(runs(stateWith(), stateWith({ governingSpec: undefined })));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied.map(f => f.path)).toEqual(["governingSpec.path"]);
    expect(r.varied[0].readings.map(x => x.value)).toEqual(["specs/SHIP.md", "«absent»"]);
  });

  test("a field absent from EVERY run is reported UNOBSERVED, never as stable", () => {
    const noSpec = () => stateWith({ governingSpec: undefined });
    const r = compareDiscoveryRuns(runs(noSpec(), noSpec()));
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.unobserved.map(f => f.path)).toEqual(["governingSpec.path"]);
    expect(r.varied).toEqual([]);
    // The distinction has to survive into the printed report, or a reader
    // counts an unobserved field as evidence of stability.
    const text = formatStabilityReport(r, "2026-10-21");
    expect(text).toMatch(/UNOBSERVED governingSpec\.path/);
    expect(text).toMatch(/An UNOBSERVED field is not a stable one/);
  });

  test("a scalar path pointed at an array reports AMBIGUOUS rather than picking one", () => {
    const f: StableField[] = [{ path: "acs[].id", equality: "exact", branchedOnBy: "deliberately wrong, to prove the reading is reported" }];
    const r = compareDiscoveryRuns(runs(stateWith(), stateWith()), f);
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.fields[0].readings[0].value).toMatch(/^AMBIGUOUS\(2\)/);
  });

  test("k = 3 reports every run's reading, not just the first disagreement", () => {
    const r = compareDiscoveryRuns(
      runs(
        stateWith(),
        stateWith({ sizing: { predicted: "XS", ceremonyTier: "STANDARD" } }),
        stateWith({ sizing: { predicted: "S", ceremonyTier: "STANDARD" } }),
      ),
    );
    if (r.verdict !== "MEASURED") throw new Error(`expected MEASURED, got ${r.reason}`);
    expect(r.varied.map(f => f.path)).toEqual(["sizing.predicted"]);
    expect(r.varied[0].readings.map(x => x.value)).toEqual(["M", "XS", "S"]);
  });
});

describe("#523: readPath and seriesInputIdentity on their own", () => {
  test("readPath follows `[]` into every element", () => {
    expect(readPath(stateWith(), "acs[].id")).toEqual(["AC-1", "AC-2"]);
  });

  test("readPath returns nothing for a path that is not there", () => {
    expect(readPath(stateWith(), "sizing.nope")).toEqual([]);
    expect(readPath(stateWith(), "nope.nope")).toEqual([]);
  });

  test("readPath's `??` prefers the first alternative that is present", () => {
    const s = { a: { x: "first", y: "second" } };
    expect(readPath(s, "a.x??y")).toEqual(["first"]);
    expect(readPath({ a: { y: "second" } }, "a.x??y")).toEqual(["second"]);
  });

  test("an empty string reads as absent, not as a value both runs share", () => {
    expect(readPath({ a: "   " }, "a")).toEqual([]);
  });

  test("seriesInputIdentity separates two different goals and joins two identical ones", () => {
    const same = seriesInputIdentity(runs(stateWith(), stateWith()));
    expect(same.identical).toBe(true);
    const diff = seriesInputIdentity(runs(stateWith(), stateWith({ issueGoal: "other" })));
    expect(diff.identical).toBe(false);
    expect(diff.fingerprints[0].goalDigest).not.toBe(diff.fingerprints[1].goalDigest);
  });

  test("the digest is 16 hex characters for any input, including empty", () => {
    const f = seriesInputIdentity(runs(stateWith({ issueGoal: undefined }), stateWith())).fingerprints;
    for (const x of f) expect(x.goalDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});

/* ───────────────── the dispatcher, in CI's configuration ───────────────── */

/**
 * `scripts/measure-discovery-stability.ts` reads the run corpus from
 * `RUNGATE_WORK_DIR`, then `$HOME/.rungate`. On a CI runner neither exists,
 * which is the condition under which a check has no failing input and passes
 * vacuously — and the green then gets read as evidence.
 *
 * Every case here runs the script with `HOME` pointed at a fresh empty
 * `mkdtemp` and `RUNGATE_WORK_DIR` cleared, so it is measured in the
 * configuration CI would run it in rather than against the 44 real runs that
 * happen to be on this laptop.
 */
describe("#523: the measurement script in a CI-shaped environment", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "measure-discovery-stability.ts");

  function runScript(home: string, extra: string[] = []) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    delete env.RUNGATE_WORK_DIR;
    return spawnSync("bun", [SCRIPT, "--date", "2026-01-01", ...extra], {
      encoding: "utf-8",
      env,
    });
  }

  test("an absent corpus is UNMEASURED, and says so in those words", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-nohome-"));
    try {
      const r = runScript(home);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/UNMEASURED/);
      expect(r.stdout).toMatch(/no run work directory/);
      // The thing that must NOT happen: a clean-looking report.
      expect(r.stdout).not.toMatch(/\d+ field\(s\) observed/);
      expect(r.stdout).toMatch(/This is not a clean result/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corpus where every issue ran once is UNMEASURED — k = 1 shows nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-k1-"));
    try {
      for (const [slug, issue] of [["p-1", 1], ["p-2", 2]] as const) {
        mkdirSync(join(home, ".rungate", slug), { recursive: true });
        writeFileSync(
          join(home, ".rungate", slug, "workflow-state.json"),
          JSON.stringify({ schemaVersion: 2, issue, issueGoal: "g", acs: [] }),
        );
      }
      const r = runScript(home);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/2 recorded run state\(s\)/);
      expect(r.stdout).toMatch(/0 with k >= 2/);
      expect(r.stdout).toMatch(/UNMEASURED/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a real k=2 series on one input is MEASURED and names the field that varied", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-k2-"));
    try {
      const base = stateWith();
      const drifted = stateWith({ sizing: { predicted: "M", ceremonyTier: "LIGHT" } });
      for (const [slug, s] of [["p-7a", base], ["p-7b", drifted]] as const) {
        mkdirSync(join(home, ".rungate", slug), { recursive: true });
        writeFileSync(join(home, ".rungate", slug, "workflow-state.json"), JSON.stringify({ ...s, issue: 7 }));
      }
      const r = runScript(home);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/1 with k >= 2/);
      expect(r.stdout).toMatch(/VARIED\s+sizing\.ceremonyTier/);
      expect(r.stdout).toMatch(/p-7a: STANDARD/);
      expect(r.stdout).toMatch(/p-7b: LIGHT/);
      // A finding is not a gate failure. #523 is explicit that a red row here
      // cannot be told apart from model drift, so this must never exit non-zero.
      expect(r.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a series of re-dispatched runs is REFUSED rather than reported as variance", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-reprompt-"));
    try {
      const a = { ...stateWith(), issue: 9 };
      const b = { ...stateWith({ issueGoal: "START FROM THE EXISTING BRANCH; AC1-AC5 are done" }), issue: 9 };
      for (const [slug, s] of [["p-9", a], ["p-9b", b]] as const) {
        mkdirSync(join(home, ".rungate", slug), { recursive: true });
        writeFileSync(join(home, ".rungate", slug, "workflow-state.json"), JSON.stringify(s));
      }
      const r = runScript(home);
      expect(r.stdout).toMatch(/UNMEASURED — these runs do not share an input/);
      expect(r.stdout).not.toMatch(/VARIED/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unreadable state file is counted and reported, not silently dropped", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-bad-"));
    try {
      mkdirSync(join(home, ".rungate", "p-bad"), { recursive: true });
      writeFileSync(join(home, ".rungate", "p-bad", "workflow-state.json"), "{ not json");
      const r = runScript(home);
      expect(r.stdout).toMatch(/1 unreadable \(reported, not skipped silently\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
