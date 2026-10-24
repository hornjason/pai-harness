/**
 * rule-row-drift.test.ts — #1287.
 *
 * A preserved rule file is skipped whole (#370), so one hand-edited row
 * freezes every OTHER row in that file at whatever the generator emitted when
 * it was first written. The run says `PRESERVED (hand-edited since the harness
 * wrote it)` and names no row, so a consumer who upgrades specifically to
 * receive a correction does not receive it and has no way to find out.
 *
 * ## The baseline, measured before any of this was written
 *
 * Fixture below, run against `origin/main` at `f6eb7d50`:
 *
 *   --- run 1 ---
 *   GENERATED: .claude/rules/key-files.md
 *   --- run 2 (the upgrade) ---
 *   PRESERVED: .claude/rules/key-files.md (hand-edited since the harness
 *     wrote it) — generator output withheld; delete the file and re-run to
 *     accept it
 *   on disk: | PROJECT-STATE.md | …the stale sentence… |
 *   hand edit survived: true
 *
 * Green and broken: the file is correctly preserved, the hand edit correctly
 * survives, and the row the generator would now write differently is not
 * mentioned by anything.
 *
 * ## What was broken to make the new case fail
 *
 * The row-level reading is removed from a copy of `lib/scaffold/steps.ts` —
 * `MUTATED_BINDING` below replaces the one call that takes it with a constant
 * string, which is exactly the pre-#1287 bare skip — and the same planted
 * fixture is run through both. The real source must name `PROJECT-STATE.md`;
 * the mutant must not. Without that second half, a case asserting "the report
 * mentions the row" could pass off any report that happened to contain the
 * string.
 *
 * Two properties make the mutation sound and both are asserted, not assumed:
 * the binding appears exactly once in `steps.ts`, so no second reading can
 * hold the case up; and the mutant has no relative imports left, so it cannot
 * die on module resolution and have that read as a refusal.
 *
 * | Mutation | Red |
 * |---|---|
 * | `ruleRowDrift` call in `steps.ts` replaced by a constant | 2 of 8 — the real-source half of the mutant case, and the end-to-end naming case |
 * | `ruleRowDrift` returns `{changed:[],missing:[],generatedRows:0}` | 4 of 8 |
 * | `rowDriftClause` always returns the "all rows match" branch | 3 of 8 |
 *
 * The issue's own criteria, in its numbering: criterion 1 is
 * `names the row`, criterion 2 is the mutant case, criterion 3 is the
 * negative control, criterion 4 is `an untouched file still takes the
 * overwrite path`, criterion 5 is the consumer reading, reproduced here as a
 * fixture because a consumer checkout is read-only to this repo and its name
 * must not appear in harness code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  PROJECT_STATE_DERIVED,
  PROJECT_STATE_UNDERIVED,
} from "../lib/project-state-derivation";
import { rowDriftClause, rowKey, ruleRowDrift, tableRows } from "../lib/rule-row-drift";
import { generateAgentsMdContent } from "../lib/scaffold/steps";

const REPO_ROOT = join(import.meta.dir, "..");
const STEPS = join(REPO_ROOT, "lib", "scaffold", "steps.ts");
const STEPS_DIR = dirname(STEPS);

/**
 * Declared as a literal rather than regex-built: renaming or re-indenting the
 * call must abort this file rather than quietly mutate nothing.
 */
const BINDING_SIGNATURE =
  "      const rows = rowDriftClause(ruleRowDrift(existing!, rule.content));";

/** The pre-#1287 behaviour: a skip that reads no rows. */
const MUTATED_BINDING =
  '      const rows = "generator output withheld"; // MUTANT: row-level reading removed';

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A file naming both halves of the relationship, which is what the scan reads. */
const GENERATOR_SRC = 'read("project-state.json"); write("PROJECT-STATE.md");\n';

/** A consumer project whose PROJECT-STATE.md row currently reads DERIVED. */
function consumerWithGenerator(): { root: string; rulePath: string } {
  const root = tmp("rule-row-drift-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer" }, null, 2) + "\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "gen.ts"), GENERATOR_SRC);
  generateAgentsMdContent(root, "code", []);
  return { root, rulePath: join(root, ".claude", "rules", "key-files.md") };
}

/**
 * The #370 edit: a row the consumer deliberately annotated.
 *
 * It is a DIFFERENT row from the one that goes stale. That separation is the
 * whole case — a fixture whose hand edit and whose stale row are the same row
 * cannot tell preservation from refreshment.
 */
function handEditAnUnrelatedRow(rulePath: string): string {
  const before = readFileSync(rulePath, "utf-8");
  const after = before.replace(
    /^\| project-state\.json \| ([^|]*)\|/m,
    "| project-state.json | $1— **DA-owned, never written from an agent worktree** (#296) |",
  );
  if (after === before) {
    throw new Error("the hand edit did not apply — the fixture would be vacuous");
  }
  writeFileSync(rulePath, after);
  return after;
}

/** Take the generator's reading away, the way an upgrade changes what it emits. */
function removeGenerator(root: string): void {
  rmSync(join(root, "src", "gen.ts"));
}

function preservedLine(actions: string[]): string {
  const line = actions.find(a => a.startsWith("PRESERVED: .claude/rules/key-files.md"));
  if (line === undefined) {
    throw new Error(
      `key-files.md was not preserved, so this case measured nothing. Actions:\n${actions.join("\n")}`,
    );
  }
  return line;
}

// ── the unit ──────────────────────────────────────────────────────

describe("#1287: a markdown table row is addressable by its first cell", () => {
  test("rows are keyed by first cell, and the separator row is not one", () => {
    const rows = tableRows("| File | What |\n|------|------|\n| a.md | one |\n| b.md | two |\n");
    expect([...rows.keys()].sort()).toEqual(["File", "a.md", "b.md"]);
    expect(rows.get("a.md")).toEqual(["one"]);
  });

  test("reordering rows is not drift — the key is the address, not the position", () => {
    const a = "| x | 1 |\n| y | 2 |\n";
    const b = "| y | 2 |\n| x | 1 |\n";
    expect(ruleRowDrift(a, b)).toEqual({ changed: [], missing: [], generatedRows: 2 });
  });

  test("emphasis on the key is not a vanished row plus a new one", () => {
    expect(rowKey("`CODE-MAP.md`")).toBe("CODE-MAP.md");
    const drift = ruleRowDrift("| `x` | 1 |\n", "| x | 1 |\n");
    expect(drift.changed).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  test("a changed value on a shared key is reported, by key", () => {
    const drift = ruleRowDrift("| x | old |\n", "| x | new |\n");
    expect(drift.changed).toEqual(["x"]);
    expect(drift.missing).toEqual([]);
  });

  test("a row only the FILE has is not reported — consumer content is not drift", () => {
    const drift = ruleRowDrift("| x | 1 |\n| mine | 2 |\n", "| x | 1 |\n");
    expect(drift.changed).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  test("prose is UNMEASURED at this granularity, and does not read as clean", () => {
    const reading = ruleRowDrift("# a\n\nsome prose\n", "# a\n\nother prose\n");
    expect(reading.generatedRows).toBe(0);
    // The clause must not claim the file was checked row by row.
    expect(rowDriftClause(reading)).toContain("no row-level reading was taken");
    expect(rowDriftClause(reading)).not.toContain("match");
  });
});

// ── the defect, end to end through the real scaffold ──────────────

describe("#1287 criterion 1: a preserved file says WHICH rows no longer match", () => {
  test("the stale row is named, the hand edit survives, and the file is still preserved", () => {
    const { root, rulePath } = consumerWithGenerator();
    const before = readFileSync(rulePath, "utf-8");

    // The reading the consumer scaffolded at. Without this the case could run
    // over a row that never said anything, and "it changed" would be vacuous.
    expect(before, "fixture did not start at the DERIVED reading").toContain(
      PROJECT_STATE_DERIVED,
    );

    const edited = handEditAnUnrelatedRow(rulePath);
    removeGenerator(root);

    const actions: string[] = [];
    generateAgentsMdContent(root, "code", actions);
    const line = preservedLine(actions);

    // criterion 1 — the row, by name.
    expect(line, "the report named no row").toContain("PROJECT-STATE.md");
    expect(line).toContain("do not match");

    // criterion 3 of the issue, the half that must NOT change: #370 holds.
    const after = readFileSync(rulePath, "utf-8");
    expect(after, "the hand edit was discarded — this would be #370 again").toBe(edited);
    expect(after).toContain("#296");
    // And the row really is stale: the file still carries the sentence the
    // current generator would no longer write for this tree.
    expect(after).toContain(PROJECT_STATE_DERIVED);
    expect(after).not.toContain(PROJECT_STATE_UNDERIVED);
  }, 120_000);

  test("the reading is not vacuous — rows were actually compared", () => {
    const { root, rulePath } = consumerWithGenerator();
    handEditAnUnrelatedRow(rulePath);
    removeGenerator(root);
    const actions: string[] = [];
    generateAgentsMdContent(root, "code", actions);
    // An empty table would make every "nothing differs" answer true for free.
    expect(preservedLine(actions)).toMatch(/of (\d+) generated rows/);
    const n = Number(/of (\d+) generated rows/.exec(preservedLine(actions))![1]);
    expect(n).toBeGreaterThan(5);
  }, 120_000);
});

describe("#1287 criterion 3: the negative control", () => {
  test("a preserved file whose rows all match names no row", () => {
    // Preserved for a reason that is NOT a row: a prose paragraph appended
    // below the table. If this reported rows, "report everything" would score
    // as a fix and the case above would prove nothing.
    const { root, rulePath } = consumerWithGenerator();
    writeFileSync(
      rulePath,
      readFileSync(rulePath, "utf-8") + "\n<!-- a note this project keeps -->\n",
    );

    const actions: string[] = [];
    generateAgentsMdContent(root, "code", actions);
    const line = preservedLine(actions);

    expect(line).toContain("generated rows match");
    expect(line).not.toContain("do not match");
    expect(line).not.toContain("PROJECT-STATE.md");
  }, 120_000);
});

describe("#1287 criterion 4: this adds no new preservation", () => {
  test("an untouched file still takes the overwrite path and reports no rows", () => {
    const { root } = consumerWithGenerator();
    removeGenerator(root); // the generator's output changes; nobody edited the file

    const actions: string[] = [];
    generateAgentsMdContent(root, "code", actions);

    expect(actions).toContain("UPDATED: .claude/rules/key-files.md");
    expect(
      actions.filter(a => a.startsWith("PRESERVED: .claude/rules/key-files.md")),
      "an untouched file must not become preserved",
    ).toEqual([]);
    // And it really did receive the correction, which is the #370 half of the
    // contract this must not weaken.
    const after = readFileSync(join(root, ".claude", "rules", "key-files.md"), "utf-8");
    expect(after).toContain(PROJECT_STATE_UNDERIVED);
  }, 120_000);
});

// ── criterion 2: the mutation ─────────────────────────────────────

export function buildMutantSource(src: string, signature = BINDING_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second row-level reading exists and removing one would leave the other reporting.`,
    );
  }
  const relocated = src
    .replace(signature, MUTATED_BINDING)
    .replace(/from "(\.\.?\/[^"]+)"/g, (_m, spec: string) => `from "${resolve(STEPS_DIR, spec)}"`);
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten; ` +
        `the mutant would die on module resolution and that non-zero exit reads as a refusal`,
    );
  }
  return relocated;
}

interface Run {
  /** The module loaded and the driver printed. Zero actions is not a verdict. */
  ran: boolean;
  /** The generator did not throw. A throw leaves the file alone and reads as preservation. */
  noThrow: boolean;
  actions: string[];
  output: string;
}

/**
 * Run the whole fixture through `modulePath` in a child process.
 *
 * The fixture is BUILT inside the child, by the module under test, so the
 * mutant and the real source see the same planted bytes and neither can be
 * handed a tree the other did not produce.
 */
function runThrough(dir: string, modulePath: string, label: string): Run {
  const project = join(dir, `project-${label}`);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer" }, null, 2) + "\n");
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "src", "gen.ts"), GENERATOR_SRC);

  const driver = join(dir, `driver-${label}.ts`);
  writeFileSync(
    driver,
    `import { generateAgentsMdContent } from ${JSON.stringify(modulePath)};\n` +
      `import { readFileSync, writeFileSync, rmSync } from "fs";\n` +
      `import { join } from "path";\n` +
      `const root = process.argv[2];\n` +
      `const actions: string[] = [];\n` +
      `try {\n` +
      `  generateAgentsMdContent(root, "code", []);\n` +
      `  const p = join(root, ".claude", "rules", "key-files.md");\n` +
      `  const before = readFileSync(p, "utf-8");\n` +
      `  const after = before.replace(/^\\| project-state\\.json \\| ([^|]*)\\|/m, "| project-state.json | $1— (#296) |");\n` +
      `  if (after === before) throw new Error("hand edit did not apply in the child");\n` +
      `  writeFileSync(p, after);\n` +
      `  rmSync(join(root, "src", "gen.ts"));\n` +
      `  generateAgentsMdContent(root, "code", actions);\n` +
      `} catch (e) { actions.push("THREW: " + (e as Error).message); }\n` +
      `console.log("ACTIONS_JSON:" + JSON.stringify(actions));\n`,
  );

  const r = spawnSync("bun", [driver, project], { cwd: dir, encoding: "utf-8", timeout: 180_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /ACTIONS_JSON:(.*)/.exec(output);
  const actions = m ? (JSON.parse(m[1]) as string[]) : [];
  return { ran: r.status === 0 && m !== null, noThrow: !actions.some(a => a.startsWith("THREW:")), actions, output };
}

describe("#1287 criterion 2: removing the row reading makes the case go undetected", () => {
  test("the real source names the row; the mutant does not", () => {
    const dir = tmp("rule-row-drift-mutant-");
    const mutantPath = join(dir, "steps-mutant.ts");
    writeFileSync(mutantPath, buildMutantSource(readFileSync(STEPS, "utf-8")));

    const real = runThrough(dir, STEPS, "real");
    const mutant = runThrough(dir, mutantPath, "mutant");

    // `ran` and `noThrow` first, for both. A module that failed to load and a
    // generator that decided to say nothing produce the same empty list.
    expect(real.ran, `the real source did not run:\n${real.output}`).toBe(true);
    expect(real.noThrow, real.actions.join("\n")).toBe(true);
    expect(mutant.ran, `the mutant did not run:\n${mutant.output}`).toBe(true);
    expect(mutant.noThrow, mutant.actions.join("\n")).toBe(true);

    const realLine = preservedLine(real.actions);
    const mutantLine = preservedLine(mutant.actions);

    expect(realLine, "the real source failed to name the stale row").toContain("PROJECT-STATE.md");
    expect(
      mutantLine,
      "the mutant still named the row, so something other than the removed reading is reporting it",
    ).not.toContain("PROJECT-STATE.md");

    // Both still preserve, so the mutation removed the REPORT and nothing else.
    expect(mutantLine).toContain("hand-edited since the harness wrote it");
    expect(realLine).toContain("hand-edited since the harness wrote it");
  }, 300_000);
});
