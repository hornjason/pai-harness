import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

/**
 * #274 SC-6, as a scan rather than a promise.
 *
 * The prohibition, verbatim: "No part of this delegates `make rebuild` to an
 * agent — DailyBriefDashboard's CLAUDE.md forbids it and the Makefile has a
 * worktree guard that exits 1." #274 builds a consumer FIXTURE and touches no
 * DDB container, so what could actually go wrong is not a container being
 * rebuilt — it is a file in this slice quietly acquiring a process execution,
 * or an agent prompt telling someone else to run one.
 *
 * Four properties make this a check and not a line in a report:
 *
 * - **It scans by EXECUTION CONSTRUCT, not by the literal command.** `make
 *   rebuild` already appears as inert text in `test/directive-extractor.test.ts`
 *   and `test/spec-compliance-auto.test.ts`, and the consumer fixture carries
 *   it as a config VALUE on purpose. A string-presence check would be a false
 *   positive here, and — worse — would go green the day the command is renamed.
 * - **It asserts the command IS present.** Zero violations over files that
 *   never mention rebuilding is a vacuous pass, and is also what a discovery
 *   that silently returned nothing looks like.
 * - **It distinguishes an instruction from a value.** `rebuildCommand: "make
 *   rebuild"` is a fact the consumer declared; an imperative naming that
 *   command is someone being told to run it. Both boundaries are tested,
 *   because narrowing a detector is the change most likely to buy green with
 *   blindness (#235) — and this paragraph had to be rewritten once because the
 *   detector correctly flagged the example it originally spelled out.
 * - **Its own positive controls are assembled from fragments**, so the literal
 *   construct-plus-command adjacency never appears in this file's text. That
 *   matters because this file is itself one of the scanned files: a scanner
 *   whose controls made it report itself could only be made green by deleting
 *   the controls, which is how a check loses the ability to fail.
 *
 * The file set is DISCOVERED, not declared, so a file a later slice of #274
 * adds under the same paths is covered without this test being edited.
 */

const REPO_ROOT = join(import.meta.dir, "..");

// ── the files this issue adds ────────────────────────────────

/** Every file under `dir`, recursively. A missing directory contributes nothing. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * The paths #274 adds, discovered from the tree rather than listed here.
 *
 * Three shapes, which between them are everything the parent issue's sub-issues
 * add that could execute anything: the consumer suites, the shared extraction
 * helper, and the on-disk consumer fixture. The Markdown #274 touches is
 * MODIFIED rather than added, and is prose: it cannot execute, and a rule file
 * that must quote the forbidden command in order to forbid it would otherwise
 * be unwritable.
 */
function discoverAddedFiles(root: string): string[] {
  const testDir = join(root, "test");
  const suites = existsSync(testDir)
    ? readdirSync(testDir)
        .filter((f) => f.startsWith("consumer-") && f.endsWith(".test.ts"))
        .map((f) => join(testDir, f))
    : [];
  const helper = join(testDir, "helpers", "consumer-ship-sites.ts");
  const helpers = existsSync(helper) ? [helper] : [];
  const fixture = walk(join(testDir, "fixtures", "consumer-ui-project"));
  return [...suites, ...helpers, ...fixture].sort();
}

const ADDED_FILES = discoverAddedFiles(REPO_ROOT);
const rel = (p: string) => relative(REPO_ROOT, p);

// ── what counts as a violation ───────────────────────────────

/**
 * Process-execution constructs, matched only where the identifier is
 * immediately applied — `execSync(`, not the word `execSync` in a sentence or
 * in this file's own control fragments.
 *
 * Case-sensitive on purpose: the constructs are lowerCamel and the commands
 * are lowercase, so nothing here can be satisfied by prose in capitals.
 */
const EXEC_CONSTRUCTS = ["execSync", "execFileSync", "execFile", "exec", "spawnSync", "spawn"];

const EXEC_CALL = new RegExp(`\\b(${EXEC_CONSTRUCTS.join("|")})\\s*\\(`, "g");

/** `Bun.$` and a tagged `$` take a template literal rather than a call. */
const TAGGED_SHELL = /(?<![\w.$])(Bun\.\$|\$)`/g;

/**
 * How far past a construct the command may sit and still be that construct's
 * argument. Deliberately short. The error direction is over-reporting, which
 * is loud; a window long enough to never miss would quietly start matching the
 * next statement.
 */
const EXEC_WINDOW = 220;

/** The containers this issue must never touch, however they are spelled. */
const FORBIDDEN_COMMAND = /make\s+rebuild|podman|docker/;

/**
 * An INSTRUCTION to rebuild, as opposed to a mention of one.
 *
 * Narrowed deliberately, and the boundary is two tests rather than a comment:
 * `rebuildCommand: "make rebuild"` is a declared value this issue carries
 * inert, while an imperative aimed at a container is someone being told to do
 * it. A detector that could not tell those apart would have to flag the
 * fixture, and a detector narrowed until it flags nothing is the defect
 * `.claude/rules/checks-must-be-able-to-fail.md` is about.
 *
 * The example sentences this comment would naturally spell out live in the
 * controls below instead, assembled from fragments — writing one here makes
 * the scan report this file, correctly.
 */
const REBUILD_INSTRUCTION =
  /rebuild\s+the\s+(\w+\s+){0,2}container|\b(run|execute|invoke|perform)\b[^\n]{0,40}?(make\s+rebuild|podman\s+\w|docker\s+\w)/i;

export type Violation = { kind: "execution" | "rebuild-instruction"; construct: string; snippet: string };

/** Every forbidden execution and every rebuild instruction in `source`. */
export function scanSource(source: string): Violation[] {
  const found: Violation[] = [];

  for (const re of [EXEC_CALL, TAGGED_SHELL]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const window = source.slice(m.index, m.index + EXEC_WINDOW);
      if (FORBIDDEN_COMMAND.test(window)) {
        found.push({ kind: "execution", construct: m[1], snippet: window.slice(0, 100) });
      }
    }
  }

  const instruction = source.match(REBUILD_INSTRUCTION);
  if (instruction) {
    found.push({
      kind: "rebuild-instruction",
      construct: instruction[0].trim(),
      snippet: source.slice(Math.max(0, instruction.index! - 40), instruction.index! + 80),
    });
  }

  return found;
}

const scanFile = (path: string) => scanSource(readFileSync(path, "utf-8"));

// ── the scan over the files this issue adds ──────────────────

describe("#274 SC-6: nothing this issue adds executes or delegates a rebuild", () => {
  test("the discovery found this slice's two suites", () => {
    const names = ADDED_FILES.map(rel);
    expect(names).toContain("test/consumer-tier-gated-subsystems.test.ts");
    expect(names).toContain("test/consumer-no-rebuild-delegation.test.ts");
  });

  test("every discovered file is free of forbidden executions and rebuild instructions", () => {
    const violations = ADDED_FILES.flatMap((p) =>
      scanFile(p).map((v) => `${rel(p)}: ${v.kind} [${v.construct}] — ${v.snippet}`),
    );
    expect(violations).toEqual([]);
  });

  test("the zero is not the command being absent — it is present and inert", () => {
    // The anti-vacuity property. Without it the scan above reports a clean
    // slice for a set of files that never mentioned rebuilding, and keeps
    // reporting one if the discovery silently returns an empty list.
    const carriers = ADDED_FILES.filter((p) => readFileSync(p, "utf-8").includes("make rebuild"));
    expect(carriers.map(rel)).toContain("test/consumer-tier-gated-subsystems.test.ts");
  });

  test("every file carrying the command carries it as a declared value", () => {
    // Wherever the fixture config lives — inline in the suite now, on disk once
    // the fixture file lands — the command sits beside a key, never in an
    // argument list. This file is excluded by name: it carries the command in
    // its controls, which is the point of them.
    const carriers = ADDED_FILES.filter(
      (p) =>
        rel(p) !== "test/consumer-no-rebuild-delegation.test.ts" &&
        readFileSync(p, "utf-8").includes("make rebuild"),
    );
    expect(carriers.length).toBeGreaterThan(0);
    for (const p of carriers) {
      expect(readFileSync(p, "utf-8")).toMatch(/["']?rebuildCommand["']?\s*:\s*["']make rebuild["']/);
    }
  });
});

// ── the scan is shown able to fail ───────────────────────────

/**
 * Control sources, assembled at runtime. The construct name and the command
 * never sit next to each other in this file's own text, which is how a file
 * that scans itself can still hold its positive controls.
 */
const EXEC_SYNC = "exec" + "Sync";
const SPAWN_SYNC = "spawn" + "Sync";
const BUN_SHELL = "Bun." + "$";
const BACKTICK = "`";
const REBUILD_PHRASE = "rebuild the " + "test container";

const EXEC_CONTROL = `${EXEC_SYNC}("cd /srv/ddb && make rebuild");`;
const PODMAN_CONTROL = `${SPAWN_SYNC}("podman", ["build", "-t", "ddb", "."]);`;
const TAGGED_CONTROL = `await ${BUN_SHELL}${BACKTICK}docker compose up -d${BACKTICK};`;
const BENIGN_SPAWN_CONTROL = `${SPAWN_SYNC}("bun", ["test", mutantPath], { cwd: tmp });`;
const DISTANT_MENTION_CONTROL = [
  `${SPAWN_SYNC}("bun", ["test", mutantPath], { cwd: tmp });`,
  ..."x".repeat(10).split("").map((_, i) => `// filler line ${i} keeping the mention out of the window`),
  "// the consumer's own Makefile is the only thing that runs it",
].join("\n");
const INERT_VALUE_CONTROL = 'const container = { rebuildCommand: "make rebuild", port: 7776 };';
const PROSE_CONTROL = "// the consumer declares its own rebuild command; we never run one";
const PROMPT_CONTROL = `await timedAgent('You have ONE task: ${REBUILD_PHRASE}.', { label: 'container-rebuild' })`;

describe("#274 SC-6: the scan catches what it claims to catch", () => {
  test("a direct execution of make rebuild is a violation", () => {
    expect(scanSource(EXEC_CONTROL).map((v) => v.kind)).toEqual(["execution"]);
  });

  test("a raw podman spawn is a violation", () => {
    expect(scanSource(PODMAN_CONTROL).map((v) => v.construct)).toEqual([SPAWN_SYNC]);
  });

  test("a tagged-template docker invocation is a violation", () => {
    // `Bun.$` takes no parentheses, so a call-anchored scan alone would miss
    // it entirely and report clean.
    expect(scanSource(TAGGED_CONTROL).map((v) => v.construct)).toEqual([BUN_SHELL]);
  });

  test("an instruction to rebuild a container is a violation wherever it appears", () => {
    expect(scanSource(PROMPT_CONTROL).map((v) => v.kind)).toEqual(["rebuild-instruction"]);
  });

  test("spawning the test runner is not a violation", () => {
    // A sibling slice of #274 spawns `bun test` to run a mutant suite. A scan
    // that flagged every child process would refuse correct work, and the
    // pressure to loosen it is how detectors stop detecting.
    expect(scanSource(BENIGN_SPAWN_CONTROL)).toEqual([]);
  });

  test("a benign spawn is not tainted by a mention far below it", () => {
    expect(scanSource(DISTANT_MENTION_CONTROL)).toEqual([]);
  });

  test("the command as a declared value is not a violation", () => {
    expect(scanSource(INERT_VALUE_CONTROL)).toEqual([]);
  });

  test("the command named in prose is not a violation", () => {
    expect(scanSource(PROSE_CONTROL)).toEqual([]);
  });
});

// ── the discovery is shown able to see, and to see more ──────

describe("#274 SC-6: the discovery covers files this slice has not written yet", () => {
  const sandbox = join(tmpdir(), `rungate-274-scan-${process.pid}`);

  test("a planted suite, helper and fixture are all discovered and all scanned", () => {
    // Three of the five paths #274 adds belong to sibling slices and do not
    // exist in this worktree. Planting them proves the discovery reaches them
    // when they land, rather than quietly scanning only what happens to be
    // here — which would be a check that shrinks as the issue grows.
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(join(sandbox, "test", "helpers"), { recursive: true });
    mkdirSync(join(sandbox, "test", "fixtures", "consumer-ui-project", ".claude"), { recursive: true });

    writeFileSync(join(sandbox, "test", "consumer-planted.test.ts"), EXEC_CONTROL);
    writeFileSync(join(sandbox, "test", "helpers", "consumer-ship-sites.ts"), PODMAN_CONTROL);
    writeFileSync(
      join(sandbox, "test", "fixtures", "consumer-ui-project", ".claude", "rungate.json"),
      JSON.stringify({ container: { rebuildCommand: "make rebuild" } }),
    );
    writeFileSync(join(sandbox, "test", "unrelated.test.ts"), EXEC_CONTROL);

    const found = discoverAddedFiles(sandbox).map((p) => relative(sandbox, p));
    expect(found).toEqual([
      "test/consumer-planted.test.ts",
      "test/fixtures/consumer-ui-project/.claude/rungate.json",
      "test/helpers/consumer-ship-sites.ts",
    ]);

    const flagged = discoverAddedFiles(sandbox)
      .filter((p) => scanFile(p).length > 0)
      .map((p) => relative(sandbox, p));
    expect(flagged).toEqual(["test/consumer-planted.test.ts", "test/helpers/consumer-ship-sites.ts"]);

    rmSync(sandbox, { recursive: true, force: true });
  });
});

// ── the detector is measured against the real delegation ─────

describe("#274 SC-6: the real rebuild delegation in ship.js is what the scan is tuned to", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("ship.js carries exactly the rebuild instruction this issue must not copy", () => {
    // `workflows/ship.js` is NOT in the scanned set — it is the harness, not a
    // file this issue adds, and its container-rebuild agent prompt is the whole
    // reason the prohibition exists. Running the detector over it proves the
    // detector recognises the genuine article and not only the control above.
    const v = scanSource(shipSource);
    expect(v.map((x) => x.kind)).toEqual(["rebuild-instruction"]);
    expect(v[0].snippet).toContain("You have ONE task");
  });

  test("the harness itself executes no container command", () => {
    expect(scanSource(shipSource).filter((v) => v.kind === "execution")).toEqual([]);
  });

  test("no file this issue adds reaches an agent with that instruction", () => {
    // The instruction half of the scan already covers this; stated separately
    // because it is the sentence SC-6 is written in, and a reader should be
    // able to find it rather than infer it.
    const offenders = ADDED_FILES.filter((p) =>
      scanFile(p).some((v) => v.kind === "rebuild-instruction"),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
});
