/**
 * #195 — the blocking-grade check can no longer be satisfied by absence.
 *
 * #188 gave workflows/ship.js a consumer for its compliance grades. Two
 * independent security reviews then said the same thing about its INPUTS, and
 * this file is the executable version of those three findings:
 *
 *  1. EMPTY READS AS CLEAN. The shape check was
 *     `!gradeResult || !Array.isArray(gradeResult.grades)`, and `[]` IS an
 *     array. A run whose grading found nothing fell straight through
 *     `blockingGradeViolations([])` and shipped. The grading prompt literally
 *     instructed the agent to return `{"grades": []}` when no transcripts were
 *     found, so a FAILED MEASUREMENT reported as a CLEAN RUN.
 *  2. MODEL IN THE DATA PATH. `gradeResult` is `await agent(...)` — the
 *     deterministic work is scripts/grade-deterministic.ts, but what reached
 *     the decision was the agent's prose summary of it, unchecked.
 *  3. PARSER DIFFERENTIAL. `String(entry).split(':')[0].trim()` ran against
 *     text the agent wrote. A flagged entry phrased differently silently
 *     failed to match, and a check that cannot see a violation is a check that
 *     passes.
 *
 * All three are the shape .claude/rules/checks-must-be-able-to-fail.md names
 * first: "a parse failure defaulting to an empty violation list".
 *
 * #69: ship.js is not importable — the Workflow sandbox has no module loading
 * — so the marked block is sliced out and EXECUTED with `new Function` over a
 * Proxy scope, the same way test/blocking-grades.test.ts,
 * test/security-verdict-blocks.test.ts and test/ship-collect-destination.test.ts
 * do it. Grepping ship.js for `expectedGradeRoles` would stay true after the
 * refusal was reduced to a log line, which is the failure mode this file
 * exists to rule out.
 *
 * ship.js is resolved from this file's own directory, never from HARNESS_ROOT:
 * under worktree isolation that variable can point at a different checkout
 * than the one being graded (#190).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const BLOCK_START = "// ──── BLOCKING-GRADES-START ────";
const BLOCK_END = "// ──── BLOCKING-GRADES-END ────";

/**
 * Module scope on purpose: if the markers go missing this throws while the
 * file is loading and every test in it fails, rather than each test quietly
 * skipping.
 */
const BLOCK = (() => {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("workflows/ship.js is missing the BLOCKING-GRADES-START / BLOCKING-GRADES-END markers");
  }
  return shipSource.slice(start + BLOCK_START.length, end);
})();

interface Outcome {
  result: Record<string, any> | undefined;
  logs: string[];
}

/**
 * Run one copy of the block over a sandbox.
 *
 * `with` over a Proxy rather than a parameter list: the block declares names
 * with `const`, and a parameter list of the same name is a SyntaxError. Names
 * the sandbox does not carry fall through to the real globals, so `String`,
 * `Array`, `JSON` and friends still resolve.
 *
 * The tail `return` is how a run that is ALLOWED to ship is observed. A
 * refusal returns `{ status: 'SHIP_FAILED', ... }` before ever reaching it.
 */
async function runBlock(scope: Record<string, unknown> = {}): Promise<Outcome> {
  const logs: string[] = [];
  const full: Record<string, unknown> = {
    log: (m: unknown) => logs.push(String(m)),
    SKIP_GRADE: false,
    ISSUE: 195,
    SLUG: "pai-harness-195",
    WORK_DIR: "/tmp/pai-harness-195",
    SPAWNED_ROLES: new Set(["marcus"]),
    gradeResult: null,
    ...scope,
  };
  const sandbox = new Proxy(full, {
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
    `return (async function () { with (__scope__) {
${BLOCK}
return { __shipped: true, blockingSet: typeof BLOCKING_GRADE_VIOLATIONS === 'undefined' ? null : BLOCKING_GRADE_VIOLATIONS }
} })()`,
  );
  const result = (await factory(sandbox)) as Record<string, any> | undefined;
  return { result, logs };
}

const shipped = (o: Outcome) => o.result?.__shipped === true;
const refused = (o: Outcome) => o.result?.status === "SHIP_FAILED";
const reasonOf = (o: Outcome) => String(o.result?.reason ?? "");

// ── Fixtures ────────────────────────────────────────────────────────────

interface RawGrade {
  role: string;
  total: number;
  followed: number;
  flagged?: string[];
}

/** The id prefix grade-deterministic.ts writes: `${id}: ${evidence}`. */
const idOf = (entry: string) => (entry.includes(":") ? entry.slice(0, entry.indexOf(":")) : entry).trim();

/**
 * A WELL-FORMED grading result: the agent's summary plus the grading script's
 * own stdout, and the two agree.
 *
 * Built from one list so the raw output cannot drift away from the summary by
 * accident — a disagreement in these tests has to be introduced DELIBERATELY,
 * which is what makes the disagreement cases mean something.
 */
function wellFormed(grades: RawGrade[]) {
  return {
    grades: grades.map(g => ({
      role: g.role,
      total: g.total,
      followed: g.followed,
      flagged: g.flagged ?? [],
      violationIds: (g.flagged ?? []).map(idOf),
    })),
    rawGradeOutput: JSON.stringify(
      { grades: grades.map(g => ({ role: g.role, total: g.total, followed: g.followed, flagged: g.flagged ?? [] })), timing: [] },
      null,
      2,
    ),
  };
}

const CLEAN_MARCUS: RawGrade[] = [{ role: "marcus", total: 12, followed: 12, flagged: [] }];

// ── AC-5 positive control: written first, and load-bearing ──────────────
//
// A guard that refuses EVERY run satisfies every "it refused" case below for
// free. This is the case that separates a working check from a broken one, so
// it is first in the file and first in the order it was written.

describe("AC-5 positive control: a clean, fully-populated run still ships", () => {
  test("every role the run spawned is graded, the raw output agrees, and it ships", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: wellFormed(CLEAN_MARCUS),
    });
    expect(refused(outcome)).toBe(false);
    expect(shipped(outcome)).toBe(true);
  });

  test("a multi-role run with advisory-only violations still ships", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus", "quinn", "rook"]),
      gradeResult: wellFormed([
        { role: "marcus", total: 12, followed: 10, flagged: ["COMP-9: Tool call budget", "COMP-2: Full test suite run limit"] },
        { role: "quinn", total: 6, followed: 5, flagged: ["DIR-L29: Run full suite at most twice"] },
        { role: "rook", total: 2, followed: 2, flagged: [] },
      ]),
    });
    expect(reasonOf(outcome)).toBe("");
    expect(shipped(outcome)).toBe(true);
  });

  test("SPAWNED_ROLES as a plain array works the same as a Set", async () => {
    // The block must not care which shape the spawn ledger has; a check that
    // only understands one of them is a check that stops firing after a
    // refactor nobody thought touched it.
    const outcome = await runBlock({ SPAWNED_ROLES: ["marcus"], gradeResult: wellFormed(CLEAN_MARCUS) });
    expect(shipped(outcome)).toBe(true);
  });

  test("the blocking set is still declared and still narrow", async () => {
    const outcome = await runBlock({ gradeResult: wellFormed(CLEAN_MARCUS) });
    expect(outcome.result?.blockingSet).toContain("TDD_SEQUENCE_VIOLATED");
    expect(outcome.result?.blockingSet).not.toContain("COMP-9");
  });
});

// ── AC-1: an empty or incomplete grade set is a failed measurement ──────

describe("AC-1: absence stops reading as compliance", () => {
  test("an empty grades array is refused, not read as clean", async () => {
    // `[]` IS an array, so the #188 shape check passed it through. This is the
    // exact input the old grading prompt told the agent to produce.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: { grades: [], rawGradeOutput: JSON.stringify({ grades: [], timing: [] }) },
    });
    expect(refused(outcome)).toBe(true);
    expect(shipped(outcome)).toBe(false);
    expect(reasonOf(outcome)).toContain("no grade for marcus");
  });

  test("a grades array missing the marcus role is refused and the role is named", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus", "quinn"]),
      gradeResult: wellFormed([{ role: "quinn", total: 6, followed: 6, flagged: [] }]),
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("no grade for marcus");
    expect(reasonOf(outcome)).not.toContain("no grade for quinn");
    expect(outcome.logs.join("\n")).toContain("no grade for marcus");
  });

  test("every ungraded role is named, not just the first", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus", "quinn", "rook"]),
      gradeResult: wellFormed([{ role: "marcus", total: 12, followed: 12, flagged: [] }]),
    });
    expect(reasonOf(outcome)).toContain("no grade for quinn");
    expect(reasonOf(outcome)).toContain("no grade for rook");
  });

  test("a run that recorded no spawned roles at all is refused, not waved through", async () => {
    // Without this branch an empty ledger makes the coverage check vacuous,
    // and a vacuous check is indistinguishable from a satisfied one.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(),
      gradeResult: { grades: [], rawGradeOutput: JSON.stringify({ grades: [] }) },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_ROLES_UNKNOWN");
  });

  test("a grade whose role is blank does not count as covering a spawned role", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: wellFormed([{ role: "", total: 1, followed: 1, flagged: [] }]),
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("no grade for marcus");
  });

  test("the #188 refusals survive: a missing grades array still refuses", async () => {
    const outcome = await runBlock({ gradeResult: null });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_MISSING");
  });
});

// ── AC-2: violation ids are read structurally, and unreadable ids refuse ──

describe("AC-2: the parser differential is closed", () => {
  test("a violation id the parser cannot extract refuses instead of failing to match", async () => {
    // Prose, not `${id}: ${evidence}`. Under #188 this produced the "id"
    // "marcus never ran the suite after his last edit" which matched nothing
    // in the blocking set, so the run shipped.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: wellFormed([
        { role: "marcus", total: 12, followed: 11, flagged: ["marcus never ran the suite after his last edit"] },
      ]),
    });
    expect(refused(outcome)).toBe(true);
    expect(shipped(outcome)).toBe(false);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_ID_UNREADABLE");
  });

  test("a flagged entry with no structured violationIds beside it refuses", async () => {
    // Deliberately an ADVISORY id. If this used TDD_SEQUENCE_VIOLATED the
    // refusal would come from the #188 blocking decision and this case would
    // prove nothing about the schema requirement it exists to check.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: {
        grades: [{ role: "marcus", total: 12, followed: 11, flagged: ["COMP-9: Tool call budget"] }],
        rawGradeOutput: JSON.stringify({
          grades: [{ role: "marcus", total: 12, followed: 11, flagged: ["COMP-9: Tool call budget"] }],
        }),
      },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_ID_UNREADABLE");
  });

  test("violationIds that omit a flagged entry's id refuses rather than under-reporting", async () => {
    // The hiding move: keep the prose evidence, drop the id that blocks.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: {
        grades: [{
          role: "marcus",
          total: 12,
          followed: 11,
          flagged: ["TDD_SEQUENCE_VIOLATED: no test run after writing source (missing green phase)"],
          violationIds: [],
        }],
        rawGradeOutput: JSON.stringify({
          grades: [{ role: "marcus", total: 12, followed: 11, flagged: ["TDD_SEQUENCE_VIOLATED: no test run after writing source (missing green phase)"] }],
        }),
      },
    });
    expect(refused(outcome)).toBe(true);
    expect(shipped(outcome)).toBe(false);
  });

  test("a structured violationIds entry that is not an id refuses", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: {
        grades: [{ role: "marcus", total: 12, followed: 12, flagged: [], violationIds: ["looks fine to me"] }],
        rawGradeOutput: JSON.stringify({ grades: [{ role: "marcus", total: 12, followed: 12, flagged: [] }] }),
      },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_ID_UNREADABLE");
  });

  test("the blocking decision still fires on a well-formed TDD violation", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: wellFormed([
        { role: "marcus", total: 12, followed: 9, flagged: ["TDD_SEQUENCE_VIOLATED: no test run after writing source (missing green phase)"] },
      ]),
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("TDD_SEQUENCE_VIOLATED");
    expect(reasonOf(outcome)).toContain("marcus");
  });
});

// ── AC-3: the agent's summary is corroborated, not believed ─────────────

describe("AC-3: the summary is checked against the grading script's own stdout", () => {
  test("a summary that disagrees with the raw output refuses", async () => {
    // The summary says clean; the script said TDD_SEQUENCE_VIOLATED.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: {
        grades: [{ role: "marcus", total: 12, followed: 12, flagged: [], violationIds: [] }],
        rawGradeOutput: JSON.stringify({
          grades: [{ role: "marcus", total: 12, followed: 9, flagged: ["TDD_SEQUENCE_VIOLATED: missing green phase"] }],
        }),
      },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_SUMMARY_DISAGREES");
  });

  test("a summary that invents a role the raw output does not carry refuses", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: {
        grades: [{ role: "marcus", total: 12, followed: 12, flagged: [], violationIds: [] }],
        rawGradeOutput: JSON.stringify({ grades: [] }),
      },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_SUMMARY_DISAGREES");
  });

  test("a missing rawGradeOutput refuses — an uncorroborated summary is not evidence", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: { grades: [{ role: "marcus", total: 12, followed: 12, flagged: [], violationIds: [] }] },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_RAW_UNREADABLE");
  });

  test("the grading script's no-transcripts stdout refuses rather than reading as clean", async () => {
    // scripts/grade-deterministic.ts:338 prints exactly this and exits 0 when
    // it finds no transcripts. It is not JSON, so it cannot corroborate
    // anything — and that is the measurement failure #195 is about.
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: { grades: [], rawGradeOutput: "Wrote empty compliance-grade.json (no transcripts found)\n" },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_RAW_UNREADABLE");
  });

  test("rawGradeOutput that is JSON but carries no grades array refuses", async () => {
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: { grades: [], rawGradeOutput: JSON.stringify({ ok: true }) },
    });
    expect(refused(outcome)).toBe(true);
    expect(reasonOf(outcome)).toContain("BLOCKING_GRADE_RAW_UNREADABLE");
  });

  test("stderr noise around the script's JSON does not defeat corroboration", async () => {
    // The real command is run through a shell and the agent may hand back the
    // surrounding progress lines. Refusing those would make the check so
    // brittle it gets switched off.
    const clean = wellFormed(CLEAN_MARCUS);
    const outcome = await runBlock({
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: { ...clean, rawGradeOutput: `Found 1 transcript(s)\n${clean.rawGradeOutput}\nWrote compliance-grade.json\n` },
    });
    expect(shipped(outcome)).toBe(true);
  });
});

// ── AC-3 / process rule 6: skipGrade stays an authorised opt-out ────────

describe("skipGrade is not collapsed into the new refusals", () => {
  test("skipGrade=true ships and still records that no blocking-grade check ran", async () => {
    const outcome = await runBlock({ SKIP_GRADE: true, gradeResult: null, SPAWNED_ROLES: new Set(["marcus"]) });
    expect(shipped(outcome)).toBe(true);
    expect(outcome.logs.join("\n")).toContain("GRADE BLOCK");
    expect(outcome.logs.join("\n")).toContain("NO blocking-grade check ran");
  });
});

// ── AC-5: the refusals are proven able to fail ──────────────────────────

/**
 * The mutation, performed and observed.
 *
 * Every new refusal routes through one enumerated array, GRADE_TRUST_REFUSALS,
 * and gradeTrustProblem() records nothing whose id is absent from it. Emptying
 * that array therefore REMOVES the refusals — and each negative case then runs
 * twice: the real block, which must refuse, and the mutant, which must not.
 * Without the second assertion, "the block refused" and "the block refuses
 * everything for an unrelated reason" are indistinguishable, and so is "the
 * block was deleted and the assertion now reads a stale fixture".
 *
 * Two properties are asserted rather than assumed: the array is declared
 * exactly once, so no refusal can bypass the mutation by pushing its own
 * reason directly, and the mutation actually changes the source — an
 * already-empty set aborts the file instead of passing quietly.
 */
const TRUST_REFUSAL_DECL = /const\s+GRADE_TRUST_REFUSALS\s*=\s*\[[^\]]*\]/g;

function mutantBlock(): string {
  const found = BLOCK.match(TRUST_REFUSAL_DECL) || [];
  if (found.length !== 1) {
    throw new Error(
      `could not build the mutant — expected exactly one GRADE_TRUST_REFUSALS array literal in the marked block, found ${found.length}`,
    );
  }
  const mutated = BLOCK.replace(TRUST_REFUSAL_DECL, "const GRADE_TRUST_REFUSALS = []");
  if (mutated === BLOCK) {
    throw new Error("could not build the mutant — the refusal set is already empty, so there is nothing to remove");
  }
  return mutated;
}

async function runMutant(scope: Record<string, unknown>): Promise<Outcome> {
  const logs: string[] = [];
  const full: Record<string, unknown> = {
    log: (m: unknown) => logs.push(String(m)),
    SKIP_GRADE: false,
    ISSUE: 195,
    SLUG: "pai-harness-195",
    WORK_DIR: "/tmp/pai-harness-195",
    SPAWNED_ROLES: new Set(["marcus"]),
    gradeResult: null,
    ...scope,
  };
  const sandbox = new Proxy(full, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      return key in target ? target[key as string] : (globalThis as unknown as Record<string, unknown>)[key as string];
    },
  });
  const factory = new Function(
    "__scope__",
    `return (async function () { with (__scope__) {
${mutantBlock()}
return { __shipped: true }
} })()`,
  );
  return { result: (await factory(sandbox)) as Record<string, any> | undefined, logs };
}

describe("AC-5: the mutant ships what the real block refuses", () => {
  test("the mutant can be built at all", () => {
    expect(mutantBlock()).not.toBe(BLOCK);
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["an empty grades array", {
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: { grades: [], rawGradeOutput: JSON.stringify({ grades: [] }) },
    }],
    ["a grades array missing marcus", {
      SPAWNED_ROLES: new Set(["marcus", "quinn"]),
      gradeResult: wellFormed([{ role: "quinn", total: 6, followed: 6, flagged: [] }]),
    }],
    ["an unreadable violation id", {
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: wellFormed([{ role: "marcus", total: 12, followed: 11, flagged: ["marcus never ran the suite"] }]),
    }],
    ["a summary that disagrees with the raw output", {
      SPAWNED_ROLES: new Set(["marcus"]),
      gradeResult: {
        grades: [{ role: "marcus", total: 12, followed: 12, flagged: [], violationIds: [] }],
        rawGradeOutput: JSON.stringify({ grades: [{ role: "marcus", total: 12, followed: 9, flagged: ["TDD_SEQUENCE_VIOLATED: x"] }] }),
      },
    }],
  ];

  for (const [name, scope] of cases) {
    test(`real block refuses ${name}, mutant ships it`, async () => {
      const real = await runBlock(scope);
      const mutant = await runMutant(scope);
      expect(refused(real)).toBe(true);
      expect(mutant.result?.__shipped).toBe(true);
    });
  }

  test("the mutant is not a no-op elsewhere: it still ships a clean run", async () => {
    // Guards the inverse mistake — a mutant that ships everything for a reason
    // unrelated to the mutation would make every comparison above pass wrongly.
    const mutant = await runMutant({ gradeResult: wellFormed(CLEAN_MARCUS) });
    expect(mutant.result?.__shipped).toBe(true);
  });
});

// ── AC-4: the grading prompt no longer asks for an empty result ─────────

describe("AC-4: the grading prompt does not instruct an empty result", () => {
  test("the no-transcripts-return-empty instruction is gone", () => {
    expect(shipSource).not.toContain("If no transcripts found, return");
    expect(shipSource).not.toContain('{"grades": [], "efficiency": null, "timing": []}');
  });

  test("the prompt asks for the grading script's own stdout and requires the roles", () => {
    expect(shipSource).toContain("rawGradeOutput");
    expect(shipSource).toContain("violationIds");
  });
});

// ── the block still sits where it can stop a PR ─────────────────────────

describe("placement", () => {
  test("the marked block precedes the record-env-and-pr step and the ship gate", () => {
    const block = shipSource.indexOf(BLOCK_START);
    expect(block).toBeGreaterThan(-1);
    expect(shipSource.indexOf("record-env-and-pr")).toBeGreaterThan(block);
    expect(shipSource.indexOf("phase('Ship')")).toBeGreaterThan(block);
  });

  test("every role-bearing agent spawn records itself in the ledger the block reads", () => {
    // The ledger is only as good as its coverage: a spawn site that forgets to
    // record makes that role invisible to the coverage check, which is the
    // fail-open this issue closes. Counted against the source rather than
    // assumed.
    const roleSpawns = shipSource.match(/role:[^,\n]*(?:marcus|quinn|rook)[^,\n]*/g) || [];
    expect(roleSpawns.length).toBeGreaterThan(0);
    const unrecorded = roleSpawns.filter(site => !site.includes("recordSpawnedRole("));
    expect(unrecorded).toEqual([]);
  });
});
