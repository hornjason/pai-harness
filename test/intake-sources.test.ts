/**
 * intake-sources.test.ts — a source that cannot be read says so, and a source
 * that can never fail to be read cannot be registered (#545).
 *
 * ## The case this file exists for
 *
 * `AC-barren` below drives **every registered source** in an empty directory
 * with no repository and no run store, and requires each to refuse. That is
 * the mechanical form of the decision `lib/intake-sources.ts` is: #545 names
 * four sources, three of them need something a check running in the
 * configuration CI runs it in does not have, and a miner whose input is
 * absent has no failing input and passes vacuously.
 *
 * A scanner added to `INTAKE_SOURCES` that reads nothing reports `MEASURED`
 * over an empty list in that context, and `AC-barren` goes red naming it. So
 * the guard is not advice in a docblock; it is the thing that stops the
 * fourth scanner being added the cheap way.
 *
 * `AC-barren-control` is why that case is not vacuous: in a context that is
 * NOT barren at least one source must report `MEASURED`. Without it, a
 * registry whose every member always refused would satisfy `AC-barren`
 * perfectly and measure nothing at all — *N readers finding nothing is
 * perfect agreement*.
 *
 * ## The fail-open this deliberately does not inherit
 *
 * `lib/gate-enforcement.ts` walks the same `workflow-state.json` files and
 * wraps the walk in `catch { skip }`, so a corrupt store reads as an empty
 * one. `AC-unreadable` asserts the opposite for this reader: a state file
 * that will not parse is `RUN_STORE_UNREADABLE` and the reading is
 * `UNMEASURED`, because "no run ever refused" and "I could not read the runs"
 * are opposite facts about a project's history.
 */

// SPEC-REF: RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  INTAKE_SOURCES,
  NO_RUN_STORE,
  RUN_STORE_UNREADABLE,
  SOURCE_UNAVAILABLE,
  defaultIntakeContext,
  mineGateRefusals,
  mineObservedFailures,
  type IntakeContext,
  type IntakeSource,
} from "../lib/intake-sources";

const ROOT = join(import.meta.dir, "..");

const dirs: string[] = [];
function scratch(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `rungate-intake-${label}-`));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A context with nothing in it: no repository, no store.
 *
 * Built from a fresh `mkdtemp` rather than from a fixed path, so the case
 * cannot be satisfied by whatever happens to be on the machine running it —
 * which is the failure mode it is written to catch in others.
 */
function barren(): IntakeContext {
  const d = scratch("barren");
  return { projectRoot: join(d, "no-project"), workStore: join(d, "no-store") };
}

/** A run store holding one state file with the given gates object. */
function storeWith(label: string, runs: Record<string, unknown>): string {
  const store = scratch(label);
  for (const [slug, state] of Object.entries(runs)) {
    mkdirSync(join(store, slug), { recursive: true });
    writeFileSync(
      join(store, slug, "workflow-state.json"),
      typeof state === "string" ? state : JSON.stringify(state),
    );
  }
  return store;
}

function gateRun(issue: number, failures: Array<{ check: string }>, ts: string) {
  return { issue, gates: { verify: { result: "FAIL", ts, failures } } };
}

// ── The contract ─────────────────────────────────────────────────────────

describe("#545: every intake source declares what it needs and refuses without it", () => {
  test("AC-registry: each source has a unique id, a stated need, and both halves of the contract", () => {
    expect(INTAKE_SOURCES.length, "the registry is empty, so every case below is vacuous")
      .toBeGreaterThan(0);
    const ids = INTAKE_SOURCES.map((s) => s.id);
    expect(new Set(ids).size, `duplicate source ids: ${ids.join(", ")}`).toBe(ids.length);
    for (const s of INTAKE_SOURCES) {
      expect(s.id.length, "a source with no id cannot be named in a reason").toBeGreaterThan(0);
      expect(
        s.needs.length,
        `source '${s.id}' states no need, so its refusal cannot tell a reader what is missing`,
      ).toBeGreaterThan(10);
      expect(typeof s.precondition).toBe("function");
      expect(typeof s.read).toBe("function");
    }
  });

  test("AC-barren: every registered source refuses in a context with nothing in it", () => {
    // THE case. A source that reports MEASURED here is reporting a reading it
    // could not have taken, which is the whole defect #545's three unbuilt
    // sources would have shipped.
    const ctx = barren();
    for (const source of INTAKE_SOURCES) {
      const missing = source.precondition(ctx);
      if (missing !== null) {
        expect(
          missing.length,
          `source '${source.id}' refused with an empty reason`,
        ).toBeGreaterThan(0);
        continue;
      }
      // A satisfied precondition in a barren context is allowed, but then the
      // READING has to refuse — one of the two must.
      const reading = source.read(ctx);
      expect(
        reading.reading,
        `source '${source.id}' reported MEASURED in a context with no repository and no run ` +
          `store. It read nothing and said so was fine, which is the vacuous pass #545's ` +
          `"Checks must be able to fail" section is about. Give it a precondition naming what ` +
          `it needs, or make its reading UNMEASURED when the input is absent — ` +
          `lib/intake-sources.ts.`,
      ).toBe("UNMEASURED");
      expect(reading.unmeasuredReasons.length).toBeGreaterThan(0);
    }
  });

  test("AC-barren-control: at least one source reports MEASURED when its input IS there", () => {
    // Without this, a registry whose members always refuse satisfies AC-barren
    // and measures nothing. Named as the control it is.
    const store = storeWith("control", {
      "proj-1": gateRun(1, [{ check: "some-check: a thing refused" }], "2026-10-19T06:15:45Z"),
    });
    const ctx: IntakeContext = { projectRoot: ROOT, workStore: store };
    const readings = INTAKE_SOURCES.map((s) => ({
      id: s.id,
      missing: s.precondition(ctx),
      reading: s.precondition(ctx) === null ? s.read(ctx).reading : "UNMEASURED",
    }));
    expect(
      readings.filter((r) => r.reading === "MEASURED").map((r) => r.id).length,
      `no source reported MEASURED over a populated input, so AC-barren is comparing two ` +
        `empty sets: ${JSON.stringify(readings)}`,
    ).toBeGreaterThan(0);
  });

  test("AC-aggregate: one unreadable source makes the whole reading UNMEASURED", () => {
    // A reading completed by the sources that happened to work is the Silent
    // Default Substitution the module refuses: zero candidates because there
    // was no store reads exactly like zero because nothing ever refused.
    const store = storeWith("agg", {
      "proj-1": gateRun(1, [{ check: "check-a: refused" }], "2026-10-19T06:15:45Z"),
    });
    const agg = mineObservedFailures({ projectRoot: join(store, "nope"), workStore: store });

    expect(agg.reading).toBe("UNMEASURED");
    if (agg.reading !== "UNMEASURED") throw new Error("narrowed above");
    expect(
      agg.unmeasuredReasons.some((r) => r.startsWith(SOURCE_UNAVAILABLE)),
      `no reason named an unavailable source: ${JSON.stringify(agg.unmeasuredReasons)}`,
    ).toBe(true);
    // And the source that COULD be read still contributed. Withholding its
    // candidates would make a partial reading and an empty one look alike.
    expect(agg.partialCandidates.length).toBeGreaterThan(0);
    expect(agg.bySource["gate-refusals"].reading).toBe("MEASURED");
    expect(agg.bySource["fix-commits"].reading).toBe("UNMEASURED");
  });

  test("AC-count-needs-the-reading: an UNMEASURED aggregate has no `candidates` key to count", () => {
    // The hazard, stated as a number: this repository's development checkout
    // is a shallow clone, so `mineFixCommits` there reports UNMEASURED /
    // SHALLOW_HISTORY and returns 182 candidates anyway. 182 is a reading of
    // the clone's depth, not of the project's history. A consumer writing
    // `agg.candidates.length` gets it without ever seeing the refusal.
    //
    // Adjacency does not fix that — a warning beside a number is read after
    // the number. So the key is ABSENT on the unmeasured variant, and this
    // asserts the runtime half of that (the compile-time half is the union
    // itself, which `bun run typecheck` enforces over every consumer).
    const store = storeWith("count", {
      "proj-1": gateRun(1, [{ check: "check-a: refused" }], "2026-10-19T06:15:45Z"),
    });
    const partial = mineObservedFailures({ projectRoot: join(store, "nope"), workStore: store });
    expect(partial.reading).toBe("UNMEASURED");
    expect(
      (partial as Record<string, unknown>).candidates,
      "an UNMEASURED aggregate still carries a `candidates` key, so `candidates.length` " +
        "returns a plausible number to a reader who never consulted `reading` — " +
        "lib/intake-sources.ts, AggregateIntakeReading.",
    ).toBeUndefined();
    // Reachable, under a name that is a decision. Withholding it outright
    // would make a partial reading and an empty one look alike.
    if (partial.reading !== "UNMEASURED") throw new Error("narrowed above");
    expect(partial.partialCandidates.length).toBeGreaterThan(0);

    // The control: the measured variant carries `candidates` and NOT
    // `partialCandidates`. Without this, a union that simply never emitted
    // `candidates` would satisfy the assertion above.
    const measured = mineObservedFailures(barren(), [
      {
        id: "always-measured",
        needs: "nothing — a fixture, registered only for this case",
        precondition: () => null,
        read: () => ({ reading: "MEASURED", unmeasuredReasons: [], commitsScanned: 1, candidates: [] }),
      },
    ]);
    expect(measured.reading).toBe("MEASURED");
    expect((measured as Record<string, unknown>).candidates).toEqual([]);
    expect(
      (measured as Record<string, unknown>).partialCandidates,
      "a MEASURED aggregate carries `partialCandidates`, so the two variants are not " +
        "distinguishable by shape and narrowing buys nothing",
    ).toBeUndefined();
  });

  test("AC-aggregate-reason-names-the-source", () => {
    const agg = mineObservedFailures(barren());
    for (const source of INTAKE_SOURCES) {
      expect(
        agg.unmeasuredReasons.some((r) => r.includes(source.id)),
        `nothing in the aggregate reading names '${source.id}', so a reader cannot tell which ` +
          `source went unread: ${JSON.stringify(agg.unmeasuredReasons)}`,
      ).toBe(true);
    }
  });
});

// ── The gate-refusal reader ──────────────────────────────────────────────

describe("#545: gate refusals are mined per check, and an unreadable store refuses", () => {
  test("AC-unreadable: a state file that will not parse is UNMEASURED, not an empty store", () => {
    // The fail-open `lib/gate-enforcement.ts` has over the same files, not
    // inherited. Broken to prove it: the fixture's second run is a state file
    // containing `{` and nothing else.
    const store = storeWith("corrupt", {
      "proj-ok": gateRun(1, [{ check: "check-a: refused" }], "2026-10-19T06:15:45Z"),
      "proj-bad": "{",
    });
    const r = mineGateRefusals(store);
    expect(r.reading).toBe("UNMEASURED");
    expect(
      r.unmeasuredReasons.some((x) => x.startsWith(RUN_STORE_UNREADABLE)),
      `a corrupt state file read as an empty store: ${JSON.stringify(r.unmeasuredReasons)}`,
    ).toBe(true);
    // The readable run still contributed — a refusal is not a reason to
    // withhold what was read.
    expect(r.candidates.map((c) => c.rule)).toEqual(["check-a: refused"]);
  });

  test("AC-empty-store: a store directory with no state files is UNMEASURED, not a measured zero", () => {
    const store = scratch("empty");
    mkdirSync(join(store, "a-run-with-no-state"), { recursive: true });
    const r = mineGateRefusals(store);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons).toContain(NO_RUN_STORE);
    expect(r.commitsScanned).toBe(0);
  });

  test("AC-dedup: one candidate per CHECK, carrying the occurrence count and the newest citation", () => {
    // Measured on this machine: 111 refusal entries over 19 distinct checks.
    // One candidate per entry would rank repeats of one check against a
    // promotion budget of 16, so the key is the check and the repetition is
    // evidence.
    const store = storeWith("dedup", {
      "proj-old": gateRun(10, [{ check: "repeated: a check" }], "2026-10-01T00:00:00Z"),
      "proj-new": gateRun(20, [{ check: "repeated: a check" }], "2026-10-20T00:00:00Z"),
      "proj-other": gateRun(30, [{ check: "distinct: another" }], "2026-10-05T00:00:00Z"),
    });
    const r = mineGateRefusals(store);
    expect(r.reading).toBe("MEASURED");
    expect(r.candidates.length, "the two occurrences of one check produced two candidates").toBe(2);

    const repeated = r.candidates.find((c) => c.rule === "repeated: a check")!;
    expect(repeated.evidence.citation, "the citation is not the most recent observation")
      .toBe("proj-new");
    expect(repeated.evidence.date).toBe("2026-10-20T00:00:00Z");
    expect(repeated.evidence.issues).toEqual([20]);
    expect(repeated.context).toContain("2 occurrence(s) across 2 run(s)");
    expect(repeated.evidence.kind).toBe("gate-refusal");
  });

  test("AC-undated: a refusal with no timestamp is dropped rather than dated empty", () => {
    // `CandidateEvidence.date`'s own comment: a candidate without one is not
    // evidence-backed. Admitting it with `date: ""` would put an undated
    // candidate into a population ordered by recency.
    const store = storeWith("undated", {
      "proj-1": { issue: 1, gates: { verify: { failures: [{ check: "undated: a check" }] } } },
    });
    const r = mineGateRefusals(store);
    expect(r.candidates).toEqual([]);
    // Still MEASURED: the store was read, and the entry was understood and
    // rejected. That is different from not having been able to look.
    expect(r.reading).toBe("MEASURED");
    expect(r.commitsScanned).toBe(1);
  });

  test("AC-idempotent: the same store mined twice is byte-identical", () => {
    const store = storeWith("idem", {
      "proj-1": gateRun(1, [{ check: "check-a: refused" }], "2026-10-19T06:15:45Z"),
      "proj-2": gateRun(2, [{ check: "check-b: refused" }], "2026-10-18T06:15:45Z"),
    });
    expect(mineGateRefusals(store)).toEqual(mineGateRefusals(store));
  });

  test("AC-shape: a state file with no gates, or gates with no failures, yields nothing and stays MEASURED", () => {
    // The negative control for the reader's parsing. Without it, a reader that
    // threw on any unexpected shape would look identical to one that found no
    // refusals.
    const store = storeWith("shapes", {
      "no-gates": { issue: 1 },
      "gates-not-object": { issue: 2, gates: 7 },
      "no-failures": { issue: 3, gates: { verify: { result: "PASS", ts: "2026-10-19T00:00:00Z" } } },
      "failure-no-check": {
        issue: 4,
        gates: { verify: { ts: "2026-10-19T00:00:00Z", failures: [{ result: "FAIL" }] } },
      },
    });
    const r = mineGateRefusals(store);
    expect(r.reading).toBe("MEASURED");
    expect(r.candidates).toEqual([]);
    expect(r.commitsScanned).toBe(4);
  });

  test("AC-default-context: the store root comes from lib/paths.ts, not a second spelling", () => {
    // One binding. `lib/gap-scanner.ts` already assembles its own copy of this
    // expression; a third would be the shape `paiHomeDir`'s docstring records
    // going wrong.
    const prior = process.env.RUNGATE_WORK_DIR;
    try {
      process.env.RUNGATE_WORK_DIR = "/tmp/rungate-intake-context-probe";
      expect(defaultIntakeContext(ROOT).workStore).toBe("/tmp/rungate-intake-context-probe");
    } finally {
      if (prior === undefined) delete process.env.RUNGATE_WORK_DIR;
      else process.env.RUNGATE_WORK_DIR = prior;
    }
  });
});

// ── The source a vacuous scanner would be ────────────────────────────────

describe("#545: AC-barren is what stops the fourth scanner being added the cheap way", () => {
  test("AC-vacuous: a source that reads nothing and reports MEASURED is refused by AC-barren", () => {
    // The cheapest wrong fix for #545's three unbuilt sources, written out:
    // a scanner with no precondition that returns an empty MEASURED reading.
    // It is plausible, it is five lines, and every other case in this file is
    // green against it. This asserts AC-barren is not.
    const vacuous: IntakeSource = {
      id: "ci-failures",
      needs: "an authenticated API client",
      precondition: () => null,
      read: () => ({ reading: "MEASURED", unmeasuredReasons: [], commitsScanned: 0, candidates: [] }),
    };

    const ctx = barren();
    // AC-barren's assertion, applied to the vacuous source by hand. It must
    // fail — if this does not throw, AC-barren cannot catch what it is for.
    expect(vacuous.precondition(ctx)).toBeNull();
    expect(
      vacuous.read(ctx).reading,
      "the vacuous source did not report MEASURED, so this case is not modelling the wrong fix",
    ).toBe("MEASURED");

    // And the aggregate inherits the lie: a registry containing it reports
    // MEASURED over a barren machine.
    const agg = mineObservedFailures(ctx, [vacuous]);
    expect(
      agg.reading,
      "a registry of one vacuous source did not report MEASURED, so the aggregate is not " +
        "the thing AC-barren protects",
    ).toBe("MEASURED");
    if (agg.reading !== "MEASURED") throw new Error("narrowed above");
    expect(agg.candidates).toEqual([]);

    // The real registry, same context, does not.
    expect(mineObservedFailures(ctx).reading).toBe("UNMEASURED");
  });
});
