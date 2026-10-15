/**
 * #398 — scaffold's audit mode reports 0 changes on a tree where `--fix`
 * modifies 16 files.
 *
 * Covers SC-1510, SC-1511, SC-1512 (HARNESS-STANDARD.md).
 *
 * `rungate scaffold <path>` without `--fix` calls itself a preview —
 * "Mode: audit (pass --fix to apply changes)" — and reports
 * `0 created, 0 replaced, 0 skipped, 0 refused` on a tree that `--fix` then
 * rewrites. It is not a conservative preview; it is a report with nothing in
 * it, because the audit branch is four `existsSync` checks standing in for
 * twenty-five write steps. Two code paths that share no code cannot agree
 * except by accident.
 *
 * `--fix` is the DESTRUCTIVE mode: #370 is `--fix` truncating
 * `.claude/rules/checks-must-be-able-to-fail.md` from 262 lines to 65 — the
 * rule three specs cite by path. Audit is the one thing between a consumer
 * and that, and it reports clean no matter what is about to happen. A
 * preview that under-reports is worse than no preview, because it converts
 * "I checked first" into false confidence.
 *
 * ## Why the property is "the two modes agree" and nothing narrower
 *
 * A test asserting "audit reports N changes" pins today's template set and
 * goes stale on the next generator edit, and someone then updates the number
 * rather than the code. "Audit and fix agree" needs no judgement about what
 * the right answer is, stays true forever, and fails the moment one step
 * forgets its audit branch — which is the actual bug, one step at a time
 * rather than a global switch.
 *
 * Both modes are run as SUBPROCESSES over planted repositories, and the
 * comparison is between the paths audit NAMES and the paths `--fix`
 * ACTUALLY WROTE as git reports them. Comparing audit's report to fix's
 * report would pass if both were empty, which is the vacuous form and is
 * most of the current defect.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { writtenPath } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "scaffold-project.ts");

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/**
 * A consumer that has been scaffolded once and has since drifted — which is
 * every consumer that has not re-scaffolded recently, and the population the
 * issue measured on agentgrit.
 */
function plantDriftedConsumer(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `scaffold-audit-${name}-`));
  roots.push(root);
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  const write = (rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");

  write("package.json", JSON.stringify({ name, private: true }, null, 2));
  write("src/index.ts", "export const x = 1;\n");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }, null, 2));

  // Drift: present but stale, so --fix REPLACES rather than CREATES. Both
  // outcomes have to be in the fixture or a mode that reports only one kind
  // passes (SC-1511).
  write("AGENTS.md", "# stale\n\nThis is not what the generator produces.\n");
  write(".github/workflows/ci.yml", "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hand-edited\n");
  write("specs/EXAMPLE-SPEC.md", "# Example\n\nNo frontmatter, so a validator has something to say.\n");

  git("add", "-A");
  git("commit", "-qm", "planted");
  return root;
}

interface Run { code: number; out: string; paths: Set<string> }

function runScaffold(root: string, args: string[]): Run {
  const r = spawnSync("bun", [CLI, root, ...args], {
    cwd: ROOT, encoding: "utf-8", timeout: 300_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const paths = new Set<string>();
  for (const line of out.split("\n")) {
    const p = writtenPath(line);
    if (p) paths.add(p);
  }
  return { code: r.status ?? -1, out, paths };
}

/** What git says actually changed — the ground truth both modes answer to. */
function dirtyPaths(root: string): Set<string> {
  const r = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf-8" });
  const out = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const p = line.slice(3).trim();
    if (p) out.add(p);
  }
  return out;
}

describe("SC-1510: audit names what --fix performs", () => {
  test("the audit report is not empty on a tree --fix rewrites", () => {
    // The headline symptom, stated on its own so a regression says which
    // half broke rather than only that the sets differ.
    const fixture = plantDriftedConsumer("empty");
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });

    runScaffold(copy, ["--fix"]);
    const actuallyChanged = dirtyPaths(copy);
    expect(
      actuallyChanged.size,
      "the fixture does not drift — this test would pass vacuously",
    ).toBeGreaterThan(0);

    const audit = runScaffold(fixture, []);
    expect(
      audit.paths.size,
      `--fix changed ${actuallyChanged.size} paths and audit named none`,
    ).toBeGreaterThan(0);
  }, 300_000);

  test("audit writes nothing", () => {
    // Separate claim from "reports correctly", and the only one that makes
    // the preview safe. Compared as the tree git sees, not as a count.
    const fixture = plantDriftedConsumer("readonly");
    const before = dirtyPaths(fixture);
    runScaffold(fixture, []);
    expect(dirtyPaths(fixture)).toEqual(before);
  }, 300_000);

  test("every path audit names is one --fix writes", () => {
    // Direction one: audit must not invent work. A preview that over-reports
    // trains a consumer to ignore it, which costs the same as under-reporting
    // one incident later.
    const fixture = plantDriftedConsumer("no-phantoms");
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });

    const audit = runScaffold(fixture, []);
    runScaffold(copy, ["--fix"]);
    const changed = dirtyPaths(copy);

    const phantom = [...audit.paths].filter(p => !changed.has(p));
    expect(phantom, "audit named paths --fix never wrote").toEqual([]);
  }, 300_000);

  test("every path --fix writes is one audit named", () => {
    // Direction two, and the one that is red today. Kept apart from the
    // first because a mode that reports nothing satisfies the first.
    const fixture = plantDriftedConsumer("no-silent");
    const copy = `${fixture}-fix`;
    roots.push(copy);
    cpSync(fixture, copy, { recursive: true });

    const audit = runScaffold(fixture, []);
    runScaffold(copy, ["--fix"]);
    const changed = dirtyPaths(copy);

    const unreported = [...changed].filter(p => !audit.paths.has(p));
    expect(unreported, "--fix wrote paths audit never mentioned").toEqual([]);
  }, 300_000);
});

describe("SC-1511: the fixture exercises more than one outcome", () => {
  test("--fix both creates and replaces on this fixture", () => {
    // Without this the agreement property could hold over a fixture with one
    // kind of change, and a mode that reports only creations would pass.
    const copy = plantDriftedConsumer("outcomes");
    const r = runScaffold(copy, ["--fix"]);
    expect(r.out, "no CREATED lines — the fixture is already complete").toMatch(/\bCREATED: /);
    expect(r.out, "no REPLACED/UPDATED lines — the fixture does not drift").toMatch(/\b(REPLACED|UPDATED): /);
  }, 300_000);
});

describe("SC-1512: one binding decides what counts as a written path", () => {
  test("writtenPath is the shared extractor, not a second copy", () => {
    // `postScaffoldCommit` already derives "scaffold wrote this" from the
    // report to decide what to stage. A second extractor here would let the
    // two disagree about the same line, and this comparison would then be
    // measuring the test's regex rather than the tool's behaviour.
    const steps = require("fs").readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const inlineExtractors = steps.match(/CREATED\|UPDATED\|REPLACED/g) ?? [];
    expect(
      inlineExtractors.length,
      "the verb list appears more than once in steps.ts — one of them is not writtenPath",
    ).toBe(1);
  });

  test.each([
    ["  CREATED: AGENTS.md", "AGENTS.md"],
    ["  REPLACED: .github/workflows/ci.yml (+4 lines, overwrote 1 edited line(s))", ".github/workflows/ci.yml"],
    ["  UPDATED: .git/hooks/pre-push (conformity check)", ".git/hooks/pre-push"],
    ["  GENERATED: CODE-MAP.md", "CODE-MAP.md"],
  ])("%s names %s", (line, path) => {
    expect(writtenPath(line)).toBe(path);
  });

  test.each([
    "  SKIP: .git/hooks/pre-push (hand-written, not overwriting)",
    "  GAP: CODE-MAP.md missing — run with --fix to generate",
    "  WARN: specs/EXAMPLE-SPEC.md has no frontmatter",
    "  REFUSED: .github/workflows/ci.yml",
    "Mode: audit (pass --fix to apply changes)",
  ])("%s names no written path", line => {
    // The negative control. An extractor that returned a path for SKIP would
    // make audit and fix agree by both over-reporting, which is agreement
    // for the wrong reason.
    expect(writtenPath(line)).toBeNull();
  });
});
