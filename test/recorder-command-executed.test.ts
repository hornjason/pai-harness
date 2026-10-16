/**
 * Covers SC-1706..SC-1711 (CONFIG-DIRECTORY-STRUCTURE-SPEC.md), #312 SC-A12,
 * SC-A13 and SC-A14. Fixes #285.
 *
 * On main the heal prompt and the recorder contradicted each other outright.
 * The prompt emitted:
 *
 *     --state <…> --result PASS|FAIL --project <…>
 *
 * and `scripts/record-suite-measurement.ts` declared
 * `OPTIONS = {state, sha, failures}`, so the FIRST flag was refused as an
 * unexpected argument and the command could never record anything. The suite
 * result would then be missing at the verify gate, in a run whose whole
 * purpose was to supply it.
 *
 * Four tests covered that step and all four were green, because every one of
 * them asserted on prompt TEXT. `test/suite-measurement-parity.test.ts:287`
 * even asserted the prompt must not pass `--sha` while the recorder required
 * it — the contradiction was pinned from both ends by tests that agreed with
 * each other and with neither side of the real contract.
 *
 * So this file does the one thing none of those did: it takes the command the
 * workflow actually builds and RUNS it, against the real recorder, in a real
 * temp git repository. A flag the recorder rejects turns this red.
 *
 * The builder is extracted from its marker block and executed rather than
 * grepped. Grepping ship.js for `--failures` would pass against a prompt that
 * mentions the flag in prose and emits something else.
 */
import { describe, test, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HARNESS_ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(HARNESS_ROOT, "workflows", "ship.js"), "utf-8");

/** The text between a START/END marker pair. */
function markedBlock(source: string, name: string): string {
  const start = source.indexOf(`// ──── ${name}-START ────`);
  const end = source.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return source.slice(start, end);
}

type Builder = (
  harnessRoot: string,
  workDir: string,
  projectRoot: string,
  quote: (w: string) => string,
) => string;

function builderFrom(source: string): Builder {
  return new Function(
    `${markedBlock(source, "RECORDER-COMMAND")}\nreturn recorderCommand`,
  )() as Builder;
}

const recorderCommand = builderFrom(SHIP);
const quote = (w: string) => `'${String(w).replace(/'/g, "'\\''")}'`;

/** A git repo with one commit, and a workflow-state.json beside it. */
function scenario(): { root: string; workDir: string; state: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-312-"));
  const project = join(root, "project");
  const workDir = join(root, "work");
  mkdirSync(project, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const git = (...a: string[]) =>
    execFileSync("git", ["-C", project, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  writeFileSync(join(project, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");

  const state = join(workDir, "workflow-state.json");
  writeFileSync(
    state,
    JSON.stringify({
      schemaVersion: 2,
      slug: "t",
      issue: 1,
      phase: "BUILD",
      issueGoal: "g",
      acs: [],
      createdTs: "2026-01-01T00:00:00Z",
      updatedTs: "2026-01-01T00:00:00Z",
      changelog: [],
    }),
  );
  return { root, workDir, state, head: git("rev-parse", "HEAD").trim() };
}

/** Run the built command through a shell, with the agent's placeholder filled. */
function runBuilt(built: string, cwd: string, failures: string): { code: number; err: string } {
  const command = built
    .replace(/\\\n\s*/g, " ")
    .replace("<number of failing tests the suite printed>", failures)
    .replace("PASS|FAIL", "PASS");
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf-8" });
  return { code: r.status ?? -1, err: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("#312: the heal command is run, not described", () => {
  test("SC-1706: the command the prompt emits is accepted by the real recorder", () => {
    const s = scenario();
    try {
      const built = recorderCommand(HARNESS_ROOT, s.workDir, join(s.root, "project"), quote);
      const { code, err } = runBuilt(built, s.root, "0");

      expect(code, `the recorder refused the prompt's own command:\n${err}`).toBe(0);

      const state = JSON.parse(readFileSync(s.state, "utf-8"));
      expect(state.suiteMeasurement?.verdict).toBe("PASS");
      expect(state.suiteMeasurement?.failures).toBe(0);
      // The point of the whole exercise: the record carries the commit, and
      // the commit came from the tree rather than from the command line.
      expect(state.suiteMeasurement?.measuredSha).toBe(s.head);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1707: a failing suite records FAIL - through the same command", () => {
    // Without this the happy path alone would be satisfied by a recorder that
    // writes PASS unconditionally — and a verdict that cannot say FAIL is
    // #224 with extra steps.
    const s = scenario();
    try {
      const built = recorderCommand(HARNESS_ROOT, s.workDir, join(s.root, "project"), quote);
      expect(runBuilt(built, s.root, "3").code).toBe(0);

      const state = JSON.parse(readFileSync(s.state, "utf-8"));
      expect(state.suiteMeasurement?.verdict).toBe("FAIL");
      expect(state.suiteMeasurement?.failures).toBe(3);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1708: reintroducing --result into the prompt turns this red", () => {
    // SC-A14, performed rather than promised. This is the text that was on
    // main, built by a mutated copy of the same marker block and run against
    // the same recorder. If it passed, the extraction above would not be
    // reaching the command and SC-1706 would be a test of string formatting.
    const mutated = SHIP.replace(
      "`    --failures <number of failing tests the suite printed>`",
      "`    --result PASS|FAIL`",
    );
    expect(mutated, "the mutation did not apply — the builder's text moved").not.toBe(SHIP);

    const s = scenario();
    try {
      const built = builderFrom(mutated)(HARNESS_ROOT, s.workDir, join(s.root, "project"), quote);
      const { code, err } = runBuilt(built, s.root, "0");

      expect(code, "the recorder accepted a caller-supplied verdict").not.toBe(0);
      expect(err).toContain("--result is not a flag");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1709: a caller-supplied SHA is refused by name", () => {
    // `--sha` was in the documented usage for this script's whole life, so
    // "unexpected argument" would read as a typo rather than as a contract
    // change. The refusal has to say what replaced it.
    const s = scenario();
    try {
      const r = spawnSync(
        "bun",
        [
          join(HARNESS_ROOT, "scripts", "record-suite-measurement.ts"),
          "--state", s.state,
          "--sha", s.head,
          "--failures", "0",
        ],
        { encoding: "utf-8" },
      );
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("read from --project");

      // And nothing was written. A refusal that still records is not a refusal.
      expect(JSON.parse(readFileSync(s.state, "utf-8")).suiteMeasurement).toBeUndefined();
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1710: a project with no commit is refused - not recorded as HEAD", () => {
    // `git rev-parse HEAD` prints the string `HEAD` back for a repo with no
    // commits. Recording that would be a measurement whose provenance field
    // says "whatever the checkout happens to be", which is exactly the hole
    // #224 opened this script to close.
    const s = scenario();
    const empty = join(s.root, "empty");
    mkdirSync(empty, { recursive: true });
    execFileSync("git", ["-C", empty, "init", "-q", "-b", "main"], { stdio: "ignore" });
    try {
      const built = recorderCommand(HARNESS_ROOT, s.workDir, empty, quote);
      const { code, err } = runBuilt(built, s.root, "0");

      expect(code).not.toBe(0);
      expect(err).toMatch(/no commit to measure against|could not read a commit/);
      expect(JSON.parse(readFileSync(s.state, "utf-8")).suiteMeasurement).toBeUndefined();

      // A directory that is not a repository at all fails the same way, and
      // separately: the two reach the refusal by different routes (git exits
      // non-zero here, prints a non-SHA above) and only one of them is
      // covered by either case alone.
      const notARepo = join(s.root, "plain");
      mkdirSync(notARepo, { recursive: true });
      const second = runBuilt(
        recorderCommand(HARNESS_ROOT, s.workDir, notARepo, quote),
        s.root,
        "0",
      );
      expect(second.code).not.toBe(0);
      expect(second.err).toContain("could not read a commit");
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("SC-1711: the step in the prompt is the command this file ran", () => {
    // The cheap half, kept: everything above proves the BUILDER is sound, and
    // none of it would notice the prompt calling a different builder, or
    // inlining the old text beside this one. One assertion ties the executed
    // function to the step an agent is actually handed.
    const at = SHIP.indexOf("For tests-pass:");
    expect(at, "ship.js has no tests-pass remediation step").toBeGreaterThan(-1);
    const step = SHIP.slice(at, at + 1200);

    expect(step).toContain("recorderCommand(HARNESS_ROOT, WORK_DIR, PROJECT_ROOT, shellQuote)");
    // The retired flags are gone from the step, including from its prose —
    // an agent reading `--result` in a sentence will type it.
    expect(step).not.toContain("--result");
    expect(step).not.toMatch(/record-suite-measurement\.ts[\s\S]{0,400}--sha/);
  });
});
