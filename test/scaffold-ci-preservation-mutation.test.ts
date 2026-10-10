/**
 * scaffold-ci-preservation-mutation.test.ts — AC-6 of #216.
 *
 * .claude/rules/checks-must-be-able-to-fail.md: a guard is worth what it fails
 * on. "Re-scaffold preserves a consumer's job" is the easiest kind of claim to
 * satisfy vacuously — a fixture whose consumer job happens to be regenerated,
 * a write that never happened, an assertion over a file the generator did not
 * touch. So the preservation is REMOVED from a copy of the CI generator and
 * the same planted consumer file is run through both: the real source must
 * preserve it, the mutant must destroy it.
 *
 * Two properties make the mutation sound, and both are asserted rather than
 * assumed:
 *
 *  - The binding signature appears exactly once in lib/scaffold/steps.ts. A
 *    second preservation path would survive the mutation and the mutant would
 *    look like it had been "rejected on the merits".
 *  - The mutant has no relative imports left. It runs from a temp directory,
 *    so a specifier the rewriter missed would kill it on module resolution —
 *    a non-zero exit that reads as a refusal it never made. Every assertion
 *    below goes through `ran` first for the same reason.
 *
 * What was broken to prove the #216 guards, run and counted rather than
 * asserted. None is left in the tree; all were run and reverted.
 *
 * | Mutation | Red |
 * |---|---|
 * | `resolveManagedWrite` short-circuited to unconditional overwrite | 16 of 28 — preservation, refusal, every measured verb, the real-source half of both mutant cases, and the AC-3 twice-run case |
 * | `resolveManagedWrite` renamed | 4 of 5 in this file — every mutant-building case throws `the binding signature appears 0 times` |
 * | `measureWrite` stops measuring (always returns CREATED) | 3 of 16 in scaffold-ci-preservation.test.ts — REPLACED, the line delta, and the never-CREATED case |
 * | the `--commit` gate deleted from `postScaffoldCommit` | 2 of 12 in test/unit/post-scaffold-commit.test.ts |
 * | the dirty-tree refusal deleted from `postScaffoldCommit` | 1 of 12 — the commit lands on top of a human's edit |
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const STEPS = join(REPO_ROOT, "lib", "scaffold", "steps.ts");
const STEPS_DIR = dirname(STEPS);

/**
 * Declared as a literal, not regex-built: renaming `resolveManagedWrite` must
 * abort this file rather than quietly mutate nothing.
 */
const BINDING_SIGNATURE =
  "export function resolveManagedWrite(existing: string | null, generated: string): ManagedWrite {";

/** The mutation: preservation and refusal replaced by unconditional overwrite. */
const UNCONDITIONAL_OVERWRITE =
  '\n  return { content: generated, verb: "CREATED", lineDelta: 0, preservedJobs: [], droppedJobs: [], overwrittenLines: [], refusal: null }; // MUTANT: preservation removed';

export function buildMutantSource(src: string, signature = BINDING_SIGNATURE): string {
  const occurrences = src.split(signature).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the binding signature appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second preservation path exists and removing one would leave the other preserving.`,
    );
  }
  const shortCircuited = src.replace(signature, `${signature}${UNCONDITIONAL_OVERWRITE}`);

  const relocated = shortCircuited.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (_m, spec: string) => `from "${resolve(STEPS_DIR, spec)}"`,
  );
  const leftover = relocated.match(/from "\.\.?\//g) || [];
  if (leftover.length > 0) {
    throw new Error(
      `could not build the mutant: ${leftover.length} relative import(s) were not rewritten; ` +
        `the mutant would die on module resolution and that non-zero exit reads as a refusal`,
    );
  }
  return relocated;
}

let SCRATCH = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ci-preserve-mutation-"));
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const CI_REL = join(".github", "workflows", "ci.yml");

/** A consumer ci.yml carrying one job no rungate generator can emit. */
const PLANTED_CONSUMER_CI = [
  "name: CI",
  "",
  "on:",
  "  push:",
  "    branches:",
  '      - "main"',
  "  pull_request:",
  "    branches:",
  '      - "main"',
  "",
  "jobs:",
  "  test:",
  '    runs-on: "ubuntu-latest"',
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: bun test",
  "",
  "  deploy-to-staging:",
  "    runs-on: self-hosted",
  "    steps:",
  "      - run: ./scripts/deploy.sh staging",
  "",
].join("\n");

/** A consumer ci.yml the slicer cannot carry forward — the refusal path. */
const PLANTED_FLOW_MAPPING_CI = [
  "name: CI",
  'on: {push: {branches: ["main"]}}',
  "jobs: {release: {runs-on: ubuntu-latest, steps: [{run: ./release.sh}]}}",
  "",
].join("\n");

function plantProject(dir: string, ci: string): void {
  mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "mutant-fixture", ci: { runner: "ubuntu-latest", bunVersion: "1.2.0", branches: ["main"] } }, null, 2) + "\n",
  );
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, CI_REL), ci);
}

interface Run {
  ran: boolean;
  actions: string[];
  content: string;
  output: string;
}

/**
 * Run `createCiWorkflows` out of `modulePath` against a freshly planted
 * project and read the file back off disk.
 *
 * `ran` is not a formality: a module that fails to load produces no actions,
 * and "no actions" is indistinguishable from "the generator decided to do
 * nothing" — which is exactly what the mutant is supposed to NOT do.
 */
function runGenerator(modulePath: string, label: string, ci: string): Run {
  const project = join(SCRATCH, `project-${label}`);
  plantProject(project, ci);

  const driver = join(SCRATCH, `driver-${label}.ts`);
  writeFileSync(
    driver,
    `import { createCiWorkflows } from ${JSON.stringify(modulePath)};\n` +
      `const actions: string[] = [];\n` +
      `try { createCiWorkflows(process.argv[2], actions); } catch (e) { actions.push("THREW: " + (e as Error).message); }\n` +
      `console.log("ACTIONS_JSON:" + JSON.stringify(actions));\n`,
  );

  const r = spawnSync("bun", [driver, project], { cwd: SCRATCH, encoding: "utf-8", timeout: 120000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /ACTIONS_JSON:(.*)/.exec(output);
  return {
    ran: r.status === 0 && m !== null,
    actions: m ? (JSON.parse(m[1]) as string[]) : [],
    content: readFileSync(join(project, CI_REL), "utf-8"),
    output,
  };
}

function writeMutant(): string {
  const mutantPath = join(SCRATCH, "steps-mutant.ts");
  writeFileSync(mutantPath, buildMutantSource(readFileSync(STEPS, "utf-8")));
  return mutantPath;
}

const jobsOf = (src: string): string[] => {
  try {
    return Object.keys((Bun.YAML.parse(src) as any)?.jobs ?? {});
  } catch {
    return [];
  }
};

describe("AC-6: the preservation can be removed, and the removal is visible", () => {
  test("real source preserves the planted consumer job; the mutant destroys it", () => {
    const real = runGenerator(STEPS, "real", PLANTED_CONSUMER_CI);
    const mutant = runGenerator(writeMutant(), "mutant", PLANTED_CONSUMER_CI);

    // Neither half may be read as a result unless it actually ran.
    expect(real.ran).toBe(true);
    expect(mutant.ran).toBe(true);

    // Assertion 1 — the job, read back out of the written file.
    expect(jobsOf(real.content)).toContain("deploy-to-staging");
    expect(jobsOf(mutant.content)).not.toContain("deploy-to-staging");

    // Assertion 2 — the consumer's own line, verbatim.
    expect(real.content).toContain("./scripts/deploy.sh staging");
    expect(mutant.content).not.toContain("./scripts/deploy.sh staging");

    // Assertion 3 — the mutant really did write, so "not preserved" is a
    // destroyed file rather than a generator that never got that far.
    expect(mutant.content).toContain("runs-on:");
    expect(mutant.actions.join("\n")).toContain("ci.yml");
  }, 180_000);

  test("real source refuses the unpreservable file; the mutant overwrites it", () => {
    const real = runGenerator(STEPS, "real-flow", PLANTED_FLOW_MAPPING_CI);
    const mutant = runGenerator(writeMutant(), "mutant-flow", PLANTED_FLOW_MAPPING_CI);

    expect(real.ran).toBe(true);
    expect(mutant.ran).toBe(true);

    expect(real.content).toBe(PLANTED_FLOW_MAPPING_CI);
    expect(real.actions.join("\n")).toContain("REFUSED:");

    expect(mutant.content).not.toBe(PLANTED_FLOW_MAPPING_CI);
    expect(jobsOf(mutant.content)).not.toContain("release");
    expect(mutant.actions.join("\n")).not.toContain("REFUSED:");
  }, 180_000);

  test("a renamed binding aborts the harness instead of mutating nothing", () => {
    expect(() => buildMutantSource(readFileSync(STEPS, "utf-8"), "export function notTheBinding(): void {")).toThrow(
      /appears 0 times/,
    );
  });

  test("a duplicated binding aborts the harness", () => {
    const src = readFileSync(STEPS, "utf-8");
    expect(() => buildMutantSource(src + "\n" + BINDING_SIGNATURE + "\n}\n")).toThrow(/appears 2 times/);
  });

  test("the mutant carries no relative import the rewriter missed", () => {
    const mutant = buildMutantSource(readFileSync(STEPS, "utf-8"));
    expect(mutant.match(/from "\.\.?\//g)).toBeNull();
    expect(mutant).toContain("MUTANT: preservation removed");
  });
});
