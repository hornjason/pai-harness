/**
 * Every agent call site is timed, and no record overwrites another (#227).
 *
 * SC-607..SC-610 (HARNESS-STANDARD.md)
 *
 * The grade step used to derive "how long did each agent take" from the
 * birth and modification times of `agent-*.jsonl` transcript files. Three
 * things were wrong with that and all three were silent:
 *
 *   - `stat -f '%B'` is BSD and `stat -c '%W'` is GNU; on a filesystem that
 *     does not record a birth time `%W` prints `0`, so the elapsed time came
 *     out as the whole Unix epoch and nothing said so.
 *   - A transcript file is named after the agent's id, not the call site, so
 *     the number could never be attributed to a `label` — the only thing in
 *     ship.js that distinguishes `quinn-local-1` from `quinn-local-2`.
 *   - Both `stat` invocations are `2>/dev/null || `-chained, so on a platform
 *     where neither flag works the loop prints nothing and the step reports
 *     `"timing": []` — a measurement that cannot fail, which is the defect
 *     .claude/rules/checks-must-be-able-to-fail.md is about.
 *
 * The replacement is this recorder. What matters about it is the thing the
 * old approach could not do at all: two records for the SAME label — a retry
 * attempt — must both survive. A recorder keyed by label that assigns rather
 * than appends looks correct on every single-attempt run and loses exactly
 * the runs anyone would want the timings for.
 *
 * What was broken to prove these tests fail, run and counted rather than
 * asserted: changing `applyStart` to replace an existing record for the label
 * instead of appending turns 3 tests red (both re-entrancy cases and the
 * cross-process retry); making `applyEnd` close the FIRST open record rather
 * than the last turns 1 red (the interleaved second-start case). Both
 * mutations were run and reverted; neither is left in the tree.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  REFUSE_EXIT,
  TIMING_FILENAME,
  applyEnd,
  applyStart,
  emptyDoc,
  formatReport,
  isUsableLabel,
  timingArtifactPath,
  type TimingDoc,
} from "../scripts/record-agent-timings";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-agent-timings.ts");

let DIR = "";
let ARTIFACT = "";
let MUTANT = "";

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "record-agent-timings-"));
  ARTIFACT = join(DIR, TIMING_FILENAME);

  // The mutant: this script with its one refusal exit code set to 0. Every
  // refusal below runs against both and asserts the real script refuses while
  // the mutant does not, so a case that starts exiting non-zero for an
  // unrelated reason stops being indistinguishable from a case that is
  // genuinely caught (.claude/rules/checks-must-be-able-to-fail.md).
  //
  // It can live in the temp dir — unlike scripts/record-build-commit.ts this
  // script has no relative imports, and `no relative import` below is what
  // keeps that true. Without that guard a later `from "../lib/..."` would make
  // every mutant die on module resolution, exiting non-zero, which reads as
  // the mutation having been rejected on the merits.
  const source = readFileSync(SCRIPT, "utf-8");
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/record-agent-timings.ts");
  }
  MUTANT = join(DIR, "mutant-record-agent-timings.ts");
  writeFileSync(MUTANT, mutated);
});

afterEach(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
});

function run(args: string[], script = SCRIPT) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function readArtifact(): TimingDoc {
  return JSON.parse(readFileSync(ARTIFACT, "utf-8"));
}

function labelsOf(doc: TimingDoc) {
  return doc.records.map(r => r.label);
}

// ── The artifact path is a documented, derivable location ────────────────

describe("#227: where the artifact lives", () => {
  test("it is a fixed filename under the run's WORK_DIR", () => {
    expect(TIMING_FILENAME).toBe("agent-timings.json");
    expect(timingArtifactPath("/Users/dev/.rungate/pai-harness-227")).toBe(
      "/Users/dev/.rungate/pai-harness-227/agent-timings.json",
    );
  });

  test("the spec documents that path, the record shape, and the labelling rule", () => {
    const spec = readFileSync(join(REPO_ROOT, "specs", "HARNESS-STANDARD.md"), "utf-8");
    expect(spec).toContain("agent-timings.json");
    for (const key of ["label", "startedAt", "endedAt", "durationSeconds"]) {
      expect(spec).toContain(key);
    }
    // The rule AC-5 asks for, stated rather than implied.
    expect(spec).toContain("every agent call site must be labelled");
  });
});

// ── Accumulation: distinct labels in one run ─────────────────────────────

describe("#227: a run accumulates one record per call site", () => {
  test("three distinct labels all survive, in call order", () => {
    let doc = emptyDoc();
    doc = applyStart(doc, "read-issue", "2026-10-09T10:00:00.000Z");
    doc = applyEnd(doc, "read-issue", "2026-10-09T10:00:12.000Z");
    doc = applyStart(doc, "discovery", "2026-10-09T10:00:13.000Z");
    doc = applyEnd(doc, "discovery", "2026-10-09T10:01:13.000Z");
    doc = applyStart(doc, "marcus", "2026-10-09T10:01:14.000Z");
    doc = applyEnd(doc, "marcus", "2026-10-09T10:11:14.000Z");

    expect(labelsOf(doc)).toEqual(["read-issue", "discovery", "marcus"]);
    expect(doc.records.map(r => r.durationSeconds)).toEqual([12, 60, 600]);
  });

  test("a later label does not disturb an earlier one's timestamps", () => {
    let doc = emptyDoc();
    doc = applyStart(doc, "setup", "2026-10-09T10:00:00.000Z");
    doc = applyEnd(doc, "setup", "2026-10-09T10:00:05.000Z");
    const setupBefore = { ...doc.records[0] };

    doc = applyStart(doc, "commit", "2026-10-09T10:00:06.000Z");
    doc = applyEnd(doc, "commit", "2026-10-09T10:00:09.500Z");

    expect(doc.records[0]).toEqual(setupBefore);
    expect(doc.records[1].durationSeconds).toBe(3.5);
  });

  test("records interleave correctly when two labels are open at once", () => {
    // parallel() means two call sites can be in flight simultaneously.
    let doc = emptyDoc();
    doc = applyStart(doc, "a", "2026-10-09T10:00:00.000Z");
    doc = applyStart(doc, "b", "2026-10-09T10:00:01.000Z");
    doc = applyEnd(doc, "b", "2026-10-09T10:00:04.000Z");
    doc = applyEnd(doc, "a", "2026-10-09T10:00:10.000Z");

    expect(doc.records.find(r => r.label === "a")!.durationSeconds).toBe(10);
    expect(doc.records.find(r => r.label === "b")!.durationSeconds).toBe(3);
  });
});

// ── Re-entrancy: the same label twice in one run ─────────────────────────

describe("#227: a re-entrant label does not overwrite its earlier record", () => {
  test("a retry of the same call site produces a second record", () => {
    let doc = emptyDoc();
    doc = applyStart(doc, "marcus", "2026-10-09T10:00:00.000Z");
    doc = applyEnd(doc, "marcus", "2026-10-09T10:05:00.000Z");
    doc = applyStart(doc, "marcus", "2026-10-09T10:06:00.000Z");
    doc = applyEnd(doc, "marcus", "2026-10-09T10:09:00.000Z");

    expect(labelsOf(doc)).toEqual(["marcus", "marcus"]);
    expect(doc.records[0].startedAt).toBe("2026-10-09T10:00:00.000Z");
    expect(doc.records[0].endedAt).toBe("2026-10-09T10:05:00.000Z");
    expect(doc.records[0].durationSeconds).toBe(300);
    expect(doc.records[1].durationSeconds).toBe(180);
  });

  test("a second start before the first end opens a second record, not a reset", () => {
    let doc = emptyDoc();
    doc = applyStart(doc, "quinn", "2026-10-09T10:00:00.000Z");
    doc = applyStart(doc, "quinn", "2026-10-09T10:00:30.000Z");

    expect(doc.records).toHaveLength(2);
    expect(doc.records[0].startedAt).toBe("2026-10-09T10:00:00.000Z");
    expect(doc.records[0].endedAt).toBeNull();

    // The LAST open record closes first — the inner call returns first.
    doc = applyEnd(doc, "quinn", "2026-10-09T10:00:40.000Z");
    expect(doc.records[1].durationSeconds).toBe(10);
    expect(doc.records[0].endedAt).toBeNull();
  });

  test("an end with no open record is kept as an orphan, never written onto a closed one", () => {
    let doc = emptyDoc();
    doc = applyStart(doc, "grade", "2026-10-09T10:00:00.000Z");
    doc = applyEnd(doc, "grade", "2026-10-09T10:00:20.000Z");
    const closed = { ...doc.records[0] };

    doc = applyEnd(doc, "grade", "2026-10-09T10:00:45.000Z");

    expect(doc.records[0]).toEqual(closed);
    expect(doc.records).toHaveLength(2);
    expect(doc.records[1]).toEqual({
      label: "grade",
      startedAt: null,
      endedAt: "2026-10-09T10:00:45.000Z",
      durationSeconds: null,
    });
  });
});

// ── An unstamped agent is visible, not absent ────────────────────────────

describe("#227: a missing end stamp is reported, not dropped", () => {
  test("an unclosed record keeps a null duration and is named in the report", () => {
    let doc = emptyDoc();
    doc = applyStart(doc, "rook", "2026-10-09T10:00:00.000Z");
    doc = applyEnd(doc, "rook", "2026-10-09T10:00:30.000Z");
    doc = applyStart(doc, "prove", "2026-10-09T10:01:00.000Z");

    const report = formatReport(doc);
    expect(report).toContain("rook: 30");
    expect(report).toContain("prove: UNCLOSED");
  });

  test("the report says so when nothing was recorded at all", () => {
    // The old stat loop answered "no timings" and "the platform has no birth
    // time" with the same empty array. These must not look alike.
    expect(formatReport(emptyDoc())).toContain("NO RECORDS");
  });
});

// ── The CLI merges across processes ──────────────────────────────────────

describe("#227: the CLI merges into an existing artifact", () => {
  test("two separate invocations both end up in the file", () => {
    expect(run(["--work-dir", DIR, "--label", "setup", "--start", "--at", "2026-10-09T10:00:00.000Z"]).code).toBe(0);
    expect(run(["--work-dir", DIR, "--label", "setup", "--end", "--at", "2026-10-09T10:00:04.000Z"]).code).toBe(0);
    expect(run(["--work-dir", DIR, "--label", "commit", "--start", "--at", "2026-10-09T10:00:05.000Z"]).code).toBe(0);
    expect(run(["--work-dir", DIR, "--label", "commit", "--end", "--at", "2026-10-09T10:00:11.000Z"]).code).toBe(0);

    const doc = readArtifact();
    expect(labelsOf(doc)).toEqual(["setup", "commit"]);
    expect(doc.records[0].durationSeconds).toBe(4);
    expect(doc.records[1].durationSeconds).toBe(6);
  });

  test("a retry label written by a separate process keeps both records", () => {
    run(["--work-dir", DIR, "--label", "marcus-fix-1", "--start", "--at", "2026-10-09T10:00:00.000Z"]);
    run(["--work-dir", DIR, "--label", "marcus-fix-1", "--end", "--at", "2026-10-09T10:00:10.000Z"]);
    run(["--work-dir", DIR, "--label", "marcus-fix-1", "--start", "--at", "2026-10-09T10:00:20.000Z"]);
    run(["--work-dir", DIR, "--label", "marcus-fix-1", "--end", "--at", "2026-10-09T10:00:50.000Z"]);

    const doc = readArtifact();
    expect(doc.records).toHaveLength(2);
    expect(doc.records.map(r => r.durationSeconds)).toEqual([10, 30]);
  });

  test("--report prints a line per record and exits 0", () => {
    run(["--work-dir", DIR, "--label", "a", "--start", "--at", "2026-10-09T10:00:00.000Z"]);
    run(["--work-dir", DIR, "--label", "a", "--end", "--at", "2026-10-09T10:00:02.000Z"]);
    const r = run(["--work-dir", DIR, "--report"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("a: 2");
  });

  test("--file names the artifact directly", () => {
    const explicit = join(DIR, "nested", "timings.json");
    expect(run(["--file", explicit, "--label", "x", "--start", "--at", "2026-10-09T10:00:00.000Z"]).code).toBe(0);
    expect(existsSync(explicit)).toBe(true);
  });

  test("a corrupt artifact is refused, not silently replaced", () => {
    // Overwriting would erase every record written before the corruption and
    // report success — the clobber this whole file exists to rule out.
    writeFileSync(ARTIFACT, "{not json");
    const r = run(["--work-dir", DIR, "--label", "x", "--start"]);
    expect(r.code).toBe(REFUSE_EXIT);
    expect(readFileSync(ARTIFACT, "utf-8")).toBe("{not json");
  });
});

// ── Refusals, each proven against the mutant ─────────────────────────────

describe("#227: what the recorder refuses", () => {
  const cases: [string, string[]][] = [
    ["no label", ["--start"]],
    ["no edge", ["--label", "x"]],
    ["both edges at once", ["--label", "x", "--start", "--end"]],
    ["an empty label", ["--label", "", "--start"]],
    ["a label carrying a newline", ["--label", "a\nb", "--start"]],
    ["an --at that is not a timestamp", ["--label", "x", "--start", "--at", "yesterday"]],
    ["no destination", ["--label", "x", "--start", "--no-dir"]],
  ];

  for (const [name, extra] of cases) {
    test(name, () => {
      const args = extra.includes("--no-dir")
        ? extra.filter(a => a !== "--no-dir")
        : ["--work-dir", DIR, ...extra];

      const real = run(args);
      expect(real.code, `the real script accepted ${name}`).toBe(REFUSE_EXIT);

      const mutant = run(args, MUTANT);
      expect(
        mutant.code,
        `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for ${name} — ` +
          `the refusal does not run through REFUSE_EXIT, so zeroing it proves nothing`,
      ).toBe(0);
    });
  }

  test("a NUL in a label is rejected by the validator", () => {
    // Not a CLI case: child_process refuses to spawn with a NUL in argv at
    // all, so the real and mutant runs would both die before main() ran and
    // the pair would prove nothing.
    expect(isUsableLabel("a\0b")).toBe(false);
    expect(isUsableLabel("a\rb")).toBe(false);
    expect(isUsableLabel("")).toBe(false);
    expect(isUsableLabel("marcus-sub-12")).toBe(true);
  });

  test("REFUSE_EXIT is assigned exactly once", () => {
    const decls = (readFileSync(SCRIPT, "utf-8").match(/REFUSE_EXIT\s*=/g) || []).length;
    expect(decls, "more than one assignment means the mutant may miss one").toBe(1);
  });

  test("every process.exit goes through REFUSE_EXIT", () => {
    const exits = readFileSync(SCRIPT, "utf-8").match(/process\.exit\([^)]*\)/g) || [];
    for (const e of exits) {
      expect(e, `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it`).toBe(
        "process.exit(REFUSE_EXIT)",
      );
    }
  });

  test("no relative import, so the mutant runs from a temp directory", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\.?\//);
  });
});

// ── ship.js: the call sites and the grade step ───────────────────────────

describe("#227: ship.js times every agent call site by label", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("the grade step no longer derives durations from file timestamps", () => {
    expect(shipSource).not.toContain("stat -f '%B'");
    expect(shipSource).not.toContain("stat -c '%W'");
    expect(shipSource).toContain("record-agent-timings.ts");
    expect(shipSource).toContain("--report");
  });

  test("no raw `await agent(` call site remains outside the timing wrapper", () => {
    // `timedAgent` is the one place a timing instruction can be attached, so a
    // call site that bypasses it is a call site with no record — and nothing
    // else would notice, because a missing label simply produces a shorter
    // report.
    const raw = shipSource
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\bawait agent\(/.test(line));
    expect(raw.map(([n]) => n)).toEqual([]);
  });

  test("the wrapper is reachable and stamps both edges under the call site's label", () => {
    const start = shipSource.indexOf("// ──── AGENT-TIMING-START ────");
    const end = shipSource.indexOf("// ──── AGENT-TIMING-END ────");
    expect(start, "AGENT-TIMING markers not found in ship.js").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = shipSource.slice(start, end);

    const calls: Array<{ prompt: string; opts: any }> = [];
    const harness = new Function(
      "WORK_DIR",
      "HARNESS_ROOT",
      "shellQuote",
      "agent",
      `${body}\nreturn { timedAgent, timingPreamble, TIMING_ARTIFACT }`,
    )(
      "/work/dir",
      "/harness",
      (w: string) => `'${String(w).replace(/'/g, `'\\''`)}'`,
      async (prompt: string, opts: any) => {
        calls.push({ prompt, opts });
        return { ok: true };
      },
    );

    expect(harness.TIMING_ARTIFACT).toBe(`/work/dir/${TIMING_FILENAME}`);

    return harness.timedAgent("do the thing", { label: "marcus-sub-12" }).then((r: any) => {
      expect(r).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      const prompt = calls[0].prompt;
      expect(prompt).toContain("do the thing");
      expect(prompt).toContain("--label 'marcus-sub-12' --start");
      expect(prompt).toContain("--label 'marcus-sub-12' --end");
      expect(prompt).toContain(`/work/dir/${TIMING_FILENAME}`);
      // Keyed by the call site's label, not by the role (AC-1).
      expect(calls[0].opts.label).toBe("marcus-sub-12");
    });
  });

  test("an unlabelled call site is refused rather than timed as `undefined`", () => {
    const start = shipSource.indexOf("// ──── AGENT-TIMING-START ────");
    const end = shipSource.indexOf("// ──── AGENT-TIMING-END ────");
    const body = shipSource.slice(start, end);
    const { timedAgent } = new Function(
      "WORK_DIR",
      "HARNESS_ROOT",
      "shellQuote",
      "agent",
      `${body}\nreturn { timedAgent }`,
    )("/work/dir", "/harness", (w: string) => `'${w}'`, async () => ({}));

    return timedAgent("x", {}).then(
      () => {
        throw new Error("an unlabelled call site was accepted");
      },
      (err: Error) => {
        expect(err.message).toContain("label");
      },
    );
  });
});
