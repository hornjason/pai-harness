/**
 * The real #664 AC set, replayed against the four #669 checks (SC-2101..SC-2105).
 *
 * Wave 1 shipped the four checks and proved each one fires on the AC it was
 * written for. That is six separate observations in five files, and it leaves
 * the question this file exists for unanswered: **replayed as a SET, which
 * cells fire, which stay silent, and which of them are witnesses rather than
 * company.** A reader who counts "four checks, all proven" is reading four
 * numbers that were never added up.
 *
 * Three properties, each because of a shape named in
 * `.claude/rules/checks-must-be-able-to-fail.md`:
 *
 *  - **The AC set is the committed fixture, never `~/.rungate`.** The run
 *    directory is deleted between runs, and a scan over an absent AC set finds
 *    no defects — which is indistinguishable from a clean AC set.
 *
 *  - **A cell is attributed by an INPUT, not by reading the refusal's prose.**
 *    `satisfiabilityRefusal` returns one joined string, so the tempting
 *    attribution is a regex table over the sentences it renders. That is the
 *    `classifySkip` trap from `.claude/rules/config-access.md`: a second
 *    decider re-deriving a decision the producing code already took, agreeing
 *    with it, and surviving any mutation of it. Here each check is isolated by
 *    varying exactly ONE input and diffing the refusal — the tree reader for
 *    the literal clause, the threshold's `unit` for the unit clause, the
 *    `--grep` token for the flag clause — so every fired cell comes with the
 *    input on which the two readings differ. The attribution is then
 *    cross-checked for TOTALITY against the number of reasons the real
 *    refusal actually carries, which is a different question asked of a
 *    different reading: an unattributed reason fails the case by name rather
 *    than being silently dropped.
 *
 *  - **The silent cells are stated, not implied.** Fifteen of the
 *    twenty-four cells stay silent and must, including every cell of a
 *    correct AC whose threshold is simply not met yet — the #659 shape, the
 *    run whose FAIL verdict was right about the work. A check that fired
 *    there would make every unfinished criterion look like a broken
 *    instrument.
 *
 * The cheapest wrong fix #669 names — widen #664 AC-7's threshold from
 * `== 1` to `>= 1` and leave the unit mismatch alone — is APPLIED to a copy of
 * the fixture on disk, measured through the same code the gate runs, and
 * reverted. The sharpest thing it measures is not in the issue: on the tree as
 * delivered the widening buys **nothing**, because the command keys on a
 * heading the tree does not hold and `awk` prints no range, so `0` fails
 * `>= 1` exactly as it failed `== 1`. The widening only produces a PASS once
 * the LITERAL defect is also repaired — which is to say the wrong fix cannot
 * even reach its own symptom until the real fix is in.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  acBaseline,
  baselineUnmeasuredReason,
  grepNoMatchIsResult,
  thresholdSatisfiedBy,
} from "../lib/evidence-prevalidator";
import {
  satisfiabilityRefusal,
  type SatisfiabilityContext,
} from "../lib/evidence-satisfiability";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_PATH = join(REPO_ROOT, "test", "fixtures", "ac-set-664.json");
const SPEC_PATH = join(REPO_ROOT, "specs", "HARNESS-STANDARD.md");

interface FixtureAc {
  id: string;
  threshold?: { op?: string; value?: string | number; unit?: string };
  evidenceMethod?: { type?: string; command?: string };
  recordedEvidence?: { type?: string; content?: string };
  recordedVerdict?: string;
}

const FIXTURE: { acs: FixtureAc[] } = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

/** The six ids the run `wf_448af2c4-6c1` actually carried. */
const REPLAYED_IDS = ["AC-1", "AC-2", "AC-4", "AC-5", "AC-6", "AC-7"];

const ac664 = (id: string): FixtureAc => {
  const found = FIXTURE.acs.find((a) => a.id === id);
  if (!found) throw new Error(`the #664 fixture no longer carries ${id}`);
  return found;
};

// ── The tree as it stood at run start ────────────────────────────────────

/**
 * A real reader over a real tree.
 *
 * It must NOT be this repository. `test/evidence-literal-interface.test.ts`
 * declares the invented heading as a constant, so the live tree HOLDS the
 * literal #664's gate bet on and the clause would correctly go silent — a
 * check certified by the file written to check it, which is the self-reference
 * trap this repo has caught in prose four times. The tree below is the shape
 * #664 ran against: the spec file exists, that heading does not.
 */
function treeReader(root: string): (literal: string) => boolean {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  return (literal: string) =>
    files.some(
      (f) => f.slice(root.length + 1).includes(literal) || readFileSync(f, "utf-8").includes(literal),
    );
}

function runStartTree(): { root: string; context: SatisfiabilityContext } {
  const root = mkdtempSync(join(tmpdir(), "rungate-669-replay-"));
  mkdirSync(join(root, "specs"));
  writeFileSync(
    join(root, "specs", "HARNESS-STANDARD.md"),
    "# Harness standard\n\n## A section that existed before #664\n\nprose\n",
  );
  return { root, context: { treeContains: treeReader(root) } };
}

const TREE = runStartTree();

// ── The four checks, isolated by an input each ───────────────────────────

const CHECKS = ["unit", "literal", "flag", "banner"] as const;
type Check = (typeof CHECKS)[number];

/** How a refusal string decomposes into the reasons the decider pushed. */
function reasons(refusal: string | null): string[] {
  return refusal === null ? [] : refusal.split("; ");
}

/** The unit clause's input: the threshold's own `unit`, emptied. */
const withoutUnit = (ac: FixtureAc): FixtureAc => ({
  ...ac,
  threshold: { ...(ac.threshold ?? {}), unit: "" },
});

/** The flag clause's input: `--grep` spelled the way bun spells it. */
const withoutFlag = (ac: FixtureAc): FixtureAc => ({
  ...ac,
  evidenceMethod: {
    ...(ac.evidenceMethod ?? {}),
    command: (ac.evidenceMethod?.command ?? "").split("--grep").join("--test-name-pattern"),
  },
});

interface Cell {
  ac: string;
  check: Check;
  fired: boolean;
  /** The input on which the varied reading and the original differ. "" when silent. */
  input: string;
}

/**
 * One AC's four cells.
 *
 * `banner` is not a clause of `satisfiabilityRefusal` at all — it reads the
 * evidence the run RECORDED, which is the only one of the four that can see a
 * command that ran, exited zero and observed nothing. Keeping it in the same
 * matrix is the point: all four are reasons a verdict was about the
 * instrument.
 */
function cellsFor(ac: FixtureAc): Cell[] {
  const full = satisfiabilityRefusal(ac, TREE.context);
  const noTree = satisfiabilityRefusal(ac);
  const noUnit = satisfiabilityRefusal(withoutUnit(ac), TREE.context);
  const noFlag = satisfiabilityRefusal(withoutFlag(ac), TREE.context);
  const bannerReason = baselineUnmeasuredReason(ac.recordedEvidence?.content ?? null);
  return [
    {
      ac: ac.id,
      check: "unit",
      fired: noUnit !== full,
      input: noUnit === full ? "" : `the threshold's unit emptied: "${ac.threshold?.unit ?? ""}"`,
    },
    {
      ac: ac.id,
      check: "literal",
      fired: noTree !== full,
      input: noTree === full ? "" : "no tree reader in hand, so the clause can refuse nothing",
    },
    {
      ac: ac.id,
      check: "flag",
      fired: noFlag !== full,
      input: noFlag === full ? "" : "`--grep` rewritten to `--test-name-pattern`",
    },
    {
      ac: ac.id,
      check: "banner",
      fired: bannerReason !== null,
      input: bannerReason === null ? "" : `the recorded evidence: "${ac.recordedEvidence?.content}"`,
    },
  ];
}

const MATRIX: Cell[] = REPLAYED_IDS.flatMap((id) => cellsFor(ac664(id)));
const fired = (check: Check): Cell[] => MATRIX.filter((c) => c.check === check && c.fired);
const FIRING = MATRIX.filter((c) => c.fired);

// ── Running an evidence command for real ─────────────────────────────────

interface Reading {
  output: string;
  exitCode: number;
}

/**
 * Run an evidence command the way the pre-validator does, against this
 * repository.
 *
 * grep's exit 1 is a RESULT, not a failure (#271), and this is the path where
 * that matters: every count in the wrong-fix rows below is produced by a grep
 * that may legitimately select nothing.
 */
function runEvidence(command: string): Reading {
  try {
    const output = execSync(command, { cwd: REPO_ROOT, encoding: "utf-8", stdio: "pipe" });
    return { output: output.trim(), exitCode: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { output: String(err.stdout ?? "").trim(), exitCode: err.status ?? 1 };
  }
}

/**
 * The same command with the heading it bet on replaced by the heading the
 * implementer actually wrote.
 *
 * DERIVED from the spec rather than typed, so the repaired half cannot carry a
 * second difference the pair was not meant to vary (#585). The terminator
 * class travels with it: `/^## [^T]/` is only a terminator for a heading
 * starting with T.
 */
function realHeadingPrefix(): string {
  const line = readFileSync(SPEC_PATH, "utf-8")
    .split("\n")
    .find((l) => /^## .*guards cut a character count/.test(l));
  if (!line) throw new Error("the spec no longer carries the #664 section heading");
  return line.split(",")[0];
}

function repaired(command: string): string {
  const heading = realHeadingPrefix();
  const initial = heading.slice(3, 4);
  return command
    .split("## Ten guards that cut a character count")
    .join(heading)
    .split("^## [^T]")
    .join(`^## [^${initial}]`);
}

// ── SC-2101 ──────────────────────────────────────────────────────────────

describe("SC-2101: the replay reads the committed fixture and never ~/.rungate", () => {
  test("the AC set comes from a tracked file inside the repository", () => {
    const tracked = execSync("git ls-files test/fixtures/ac-set-664.json", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    expect(tracked, "the #664 AC set is not a committed file").toBe(
      "test/fixtures/ac-set-664.json",
    );
  });

  test("this file names no run directory", () => {
    const self = readFileSync(join(import.meta.dir, "evidence-664-replay.test.ts"), "utf-8");
    // Said in prose above; what must not exist is a READ of it.
    expect(self).not.toMatch(/readFileSync\([^)]*\.rungate/);
    expect(self).not.toMatch(/\$\{?HOME\}?\/\.rungate/);
  });

  test("the fixture is the whole run, and every id is replayed", () => {
    expect(FIXTURE.acs.map((a) => a.id).sort()).toEqual([...REPLAYED_IDS].sort());
    expect(MATRIX).toHaveLength(REPLAYED_IDS.length * CHECKS.length);
  });

  test("the fixture still carries AC-7's ORIGINAL threshold, so the wrong fix is not in the tree", () => {
    // The last line of the revert. A copy is mutated below; this is the
    // assertion that nothing was left behind in the committed one.
    expect(ac664("AC-7").threshold).toMatchObject({ op: "==", value: 1 });
  });
});

// ── SC-2102 ──────────────────────────────────────────────────────────────

describe("SC-2102: each of the four checks fires, attributed by an input difference", () => {
  test("the matrix is 24 cells and 9 of them fire", () => {
    expect(MATRIX).toHaveLength(24);
    expect(FIRING).toHaveLength(9);
  });

  for (const check of CHECKS) {
    test(`the ${check} check fires on at least one replayed AC`, () => {
      expect(fired(check).length, `the ${check} check fired on nothing`).toBeGreaterThan(0);
    });
  }

  test("the composition, named rather than counted", () => {
    const byCheck = Object.fromEntries(
      CHECKS.map((c) => [c, fired(c).map((cell) => cell.ac)]),
    );
    expect(byCheck).toEqual({
      unit: ["AC-6"],
      literal: ["AC-6", "AC-7"],
      flag: ["AC-2", "AC-5"],
      banner: ["AC-1", "AC-2", "AC-4", "AC-5"],
    });
  });

  test("every fired cell names the input on which the two readings differ", () => {
    for (const cell of FIRING) {
      expect(cell.input, `${cell.ac}/${cell.check} fired with no distinguishing input`).not.toBe("");
    }
  });

  test("the attribution is total: no reason the decider produced is unattributed", () => {
    // Two different readings of one question. The left side counts the reasons
    // `satisfiabilityRefusal` actually pushed; the right side is the
    // input-differencing above. A clause this file cannot isolate shows up
    // here as a mismatch instead of vanishing.
    for (const id of REPLAYED_IDS) {
      const produced = reasons(satisfiabilityRefusal(ac664(id), TREE.context)).length;
      const attributed = MATRIX.filter(
        (c) => c.ac === id && c.check !== "banner" && c.fired,
      ).length;
      expect(attributed, `${id}: ${produced} reasons produced, ${attributed} attributed`).toBe(
        produced,
      );
    }
  });

  test("each neutralised input removes exactly its own reason and leaves the rest", () => {
    // Guards the instrument, not the code: a neutraliser that happened to
    // silence a second clause would still produce a difference, and the cell
    // would read as attributed when it is only disturbed.
    for (const id of REPLAYED_IDS) {
      const ac = ac664(id);
      const full = reasons(satisfiabilityRefusal(ac, TREE.context));
      const variants: Array<[Check, string[]]> = [
        ["unit", reasons(satisfiabilityRefusal(withoutUnit(ac), TREE.context))],
        ["literal", reasons(satisfiabilityRefusal(ac))],
        ["flag", reasons(satisfiabilityRefusal(withoutFlag(ac), TREE.context))],
      ];
      for (const [check, after] of variants) {
        const cell = MATRIX.find((c) => c.ac === id && c.check === check);
        expect(after.every((r) => full.includes(r)), `${id}/${check} invented a reason`).toBe(true);
        expect(full.length - after.length, `${id}/${check} moved more than its own reason`).toBe(
          cell?.fired ? 1 : 0,
        );
      }
    }
  });

  test("the instrument-broken cells are distinguished from a threshold merely unmet", () => {
    // AC-7 is the cell that makes the distinction visible, because it is both
    // at once: its literal clause fires (the instrument cannot observe the
    // work) AND its recorded `0` is a real reading that simply misses `== 1`.
    // Collapsing the two is how #664's repair cycle was aimed at correct code.
    const ac7 = ac664("AC-7");
    expect(MATRIX.find((c) => c.ac === "AC-7" && c.check === "literal")?.fired).toBe(true);
    const baseline = acBaseline(ac7.recordedEvidence?.content ?? null, ac7.threshold);
    expect(baseline.verdict).toBe("MEASURED");
    expect(baseline.reason).toBeNull();
    expect(baseline.satisfiesThreshold).toBe(false);
  });

  test("the banner cells are the opposite case: nothing was observed at all", () => {
    for (const id of ["AC-1", "AC-2", "AC-4", "AC-5"]) {
      const ac = ac664(id);
      const baseline = acBaseline(ac.recordedEvidence?.content ?? null, ac.threshold);
      expect(baseline.verdict, `${id} was read as a measurement`).toBe("UNMEASURED");
      expect(baseline.satisfiesThreshold, `${id} was reduced to a comparison`).toBeNull();
      expect(baseline.reason).toContain("version banner");
    }
  });
});

// ── SC-2103 ──────────────────────────────────────────────────────────────

/**
 * The #659 shape: a correct criterion, a correct instrument, and a number
 * that does not clear the bar because the work is not done.
 *
 * #659 is the counter-example #669 names — the run whose FAIL verdict was
 * right about the code. The command is real and is RUN below rather than
 * described, because a fabricated `"0"` would be the fixture asserting the
 * value the case wants.
 */
const AC_659_SHAPE: FixtureAc = {
  id: "AC-659-shape",
  threshold: { op: ">=", value: 1, unit: "matching lines in lib/trajectory.ts" },
  evidenceMethod: { type: "COMMAND", command: "grep -c deletedCaseNames lib/trajectory.ts" },
};

describe("SC-2103: a correct AC whose threshold is merely unmet is silent on all four", () => {
  test("the command runs, selects nothing, and its exit 1 is a result", () => {
    const reading = runEvidence(AC_659_SHAPE.evidenceMethod?.command ?? "");
    expect(reading.output).toBe("0");
    expect(reading.exitCode).toBe(1);
    expect(
      grepNoMatchIsResult(AC_659_SHAPE.evidenceMethod?.command ?? "", reading.exitCode),
      "grep's no-match exit was read as a broken command",
    ).toBe(true);
  });

  test("all four checks stay silent, and the threshold is simply not met", () => {
    const cells = cellsFor({ ...AC_659_SHAPE, recordedEvidence: { content: "0" } });
    expect(
      cells.filter((c) => c.fired).map((c) => c.check),
      "a check fired on a correct AC whose only problem is unfinished work",
    ).toEqual([]);
    const baseline = acBaseline("0", AC_659_SHAPE.threshold);
    expect(baseline.verdict).toBe("MEASURED");
    expect(baseline.satisfiesThreshold).toBe(false);
  });

  test("the silent cells are the majority, and they are controls rather than coverage", () => {
    const silent = MATRIX.filter((c) => !c.fired);
    expect(silent).toHaveLength(15);
    // The two #664 ACs no satisfiability clause touches. Their instruments are
    // sound; AC-1 and AC-4 are red on the delivered tree for the ordinary
    // reason that the file they run did not exist yet.
    for (const id of ["AC-1", "AC-4"]) {
      expect(satisfiabilityRefusal(ac664(id), TREE.context), `${id} was refused`).toBeNull();
    }
  });
});

// ── SC-2104 ──────────────────────────────────────────────────────────────

/**
 * Apply the cheapest wrong fix to a COPY of the fixture on disk, and hand back
 * the AC as re-read from that file.
 *
 * On disk and re-read, because an object literal with `op: ">="` typed into
 * the case would be the case asserting its own premise. The copy is deleted by
 * the caller; the committed fixture is asserted untouched in SC-2101.
 */
function applyCheapestWrongFix(): { dir: string; ac7: FixtureAc } {
  const dir = mkdtempSync(join(tmpdir(), "rungate-669-wrongfix-"));
  const path = join(dir, "ac-set-664.json");
  copyFileSync(FIXTURE_PATH, path);
  const widened = JSON.parse(readFileSync(path, "utf-8")) as { acs: FixtureAc[] };
  const target = widened.acs.find((a) => a.id === "AC-7");
  if (!target?.threshold) throw new Error("the fixture no longer carries AC-7's threshold");
  target.threshold.op = ">=";
  writeFileSync(path, JSON.stringify(widened, null, 2));
  const reread = (JSON.parse(readFileSync(path, "utf-8")) as { acs: FixtureAc[] }).acs.find(
    (a) => a.id === "AC-7",
  );
  if (!reread) throw new Error("the widened copy lost AC-7");
  return { dir, ac7: reread };
}

describe("SC-2104: the cheapest wrong fix is applied, measured and reverted", () => {
  test("the widening is really applied — the mutant and the original differ on a named input", () => {
    const { dir, ac7 } = applyCheapestWrongFix();
    try {
      expect(ac7.threshold?.op).toBe(">=");
      expect(ac664("AC-7").threshold?.op).toBe("==");
      // #485: before believing any zero below, name an input on which the two
      // behave differently. `3` is what the repaired command prints.
      expect(thresholdSatisfiedBy("3", ac664("AC-7").threshold)).toBe(false);
      expect(thresholdSatisfiedBy("3", ac7.threshold)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the widening moves none of the four checks", () => {
    const { dir, ac7 } = applyCheapestWrongFix();
    try {
      const before = cellsFor(ac664("AC-7"));
      const after = cellsFor({ ...ac7, recordedEvidence: ac664("AC-7").recordedEvidence });
      expect(after.map((c) => c.fired)).toEqual(before.map((c) => c.fired));
      expect(satisfiabilityRefusal(ac7, TREE.context)).toBe(
        satisfiabilityRefusal(ac664("AC-7"), TREE.context),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on the tree as delivered the widening buys nothing, because awk prints no range", () => {
    const { dir, ac7 } = applyCheapestWrongFix();
    try {
      const command = ac664("AC-7").evidenceMethod?.command ?? "";
      const reading = runEvidence(command);
      expect(reading.output, "the invented heading suddenly resolves").toBe("0");
      expect(thresholdSatisfiedBy(reading.output, ac664("AC-7").threshold)).toBe(false);
      expect(
        thresholdSatisfiedBy(reading.output, ac7.threshold),
        "the widened threshold passed over a range that printed nothing",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with the heading repaired the widening does buy a PASS, and that is the wrong fix working", () => {
    const { dir, ac7 } = applyCheapestWrongFix();
    try {
      const command = repaired(ac664("AC-7").evidenceMethod?.command ?? "");
      expect(command, "the repair did not change the command").not.toBe(
        ac664("AC-7").evidenceMethod?.command,
      );
      const reading = runEvidence(command);
      expect(reading.output).toBe("3");
      expect(thresholdSatisfiedBy(reading.output, ac664("AC-7").threshold)).toBe(false);
      expect(thresholdSatisfiedBy(reading.output, ac7.threshold)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-6 is untouched by it: still refused, and still failing with the heading repaired", () => {
    const reading = runEvidence(repaired(ac664("AC-6").evidenceMethod?.command ?? ""));
    expect(reading.output).toBe("4");
    expect(thresholdSatisfiedBy(reading.output, ac664("AC-6").threshold)).toBe(false);
    expect(satisfiabilityRefusal(ac664("AC-6"), TREE.context)).toContain(
      "declares a count of test cases",
    );
  });
});

// ── SC-2105 ──────────────────────────────────────────────────────────────

const ROW_RE = /^\|\s*\*\*EVIDENCE-CHECK-669-(\d+)([^|]*)\|([^|]*)\|([^|]*)\|/;

interface RecordRow {
  index: number;
  predicted: number[];
  measured: number[];
}

/** The recorded rows, parsed out of the spec as data. */
function recordedRows(): RecordRow[] {
  const numbers = (cell: string): number[] =>
    [...cell.matchAll(/\d+/g)].map((m) => Number(m[0]));
  const out: RecordRow[] = [];
  for (const line of readFileSync(SPEC_PATH, "utf-8").split("\n")) {
    const m = line.match(ROW_RE);
    if (!m) continue;
    out.push({ index: Number(m[1]), predicted: numbers(m[3]), measured: numbers(m[4]) });
  }
  return out;
}

describe("SC-2105: the five EVIDENCE-CHECK-669 rows agree with the live measurement", () => {
  const rows = recordedRows();

  test("there are exactly five rows, numbered 1 to 5", () => {
    // An empty table is perfect agreement with anything (#621), so the count
    // is asserted before any row is read.
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  test("every row's predicted column equals its measured column", () => {
    for (const row of rows) {
      expect(row.predicted.length, `row ${row.index} records no predicted number`).toBeGreaterThan(
        0,
      );
      expect(row.measured, `row ${row.index}: predicted and measured disagree`).toEqual(
        row.predicted,
      );
    }
  });

  test("the baseline row is row 1, and it is this run's own numbers", () => {
    const baseline = rows[0];
    expect(baseline.index).toBe(1);
    expect(baseline.measured).toEqual([
      FIRING.length,
      MATRIX.length,
      fired("unit").length,
      fired("literal").length,
      fired("flag").length,
      fired("banner").length,
    ]);
  });

  test("every zero row names the input on which mutant and original differ", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    for (const row of rows.filter((r) => r.measured[0] === 0)) {
      const named = spec
        .split("\n")
        .some(
          (l) =>
            l.includes(`EVIDENCE-CHECK-669-${row.index}`) &&
            l.includes("the input on which mutant and original differ"),
        );
      expect(named, `row ${row.index} records a zero with no distinguishing input`).toBe(true);
    }
  });

  test("the record says which cells are witnesses and which are controls", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    const witnesses = Number(spec.match(/\*\*(\d+)\*\* are witnesses/)?.[1]);
    const controls = Number(spec.match(/\*\*(\d+)\*\* are controls/)?.[1]);
    expect(witnesses).toBe(FIRING.length);
    expect(controls).toBe(MATRIX.length - FIRING.length);
    expect(witnesses + controls).toBe(MATRIX.length);
  });

  test("the recorded wrong-fix verdicts are the ones the commands print", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    const verbatim = runEvidence(ac664("AC-7").evidenceMethod?.command ?? "").output;
    const fixed = runEvidence(repaired(ac664("AC-7").evidenceMethod?.command ?? "")).output;
    const ac6 = runEvidence(repaired(ac664("AC-6").evidenceMethod?.command ?? "")).output;
    const sentence = `verbatim command prints \`${verbatim}\`, the repaired one prints \`${fixed}\`, and AC-6's prints \`${ac6}\``;
    // `expect(spec).toContain(…)` over a 10,000-line document prints the
    // whole document on failure, which buries the one line that matters.
    expect(spec.includes(sentence), `the record does not say: ${sentence}`).toBe(true);
  });
});
