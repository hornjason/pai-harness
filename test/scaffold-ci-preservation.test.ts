/**
 * scaffold-ci-preservation.test.ts — re-scaffold must not destroy a consumer's
 * CI file (#216, SUCCESS.md claim 5: the harness works on a repo that is not
 * this one).
 *
 * `createCiWorkflows` used to end in two unconditional `writeFileSync` calls.
 * Re-scaffolding is the documented way to onboard AND to update a consumer, so
 * the first real consumer that had added a job of its own to `.github/workflows/
 * ci.yml` would have had that job deleted by the act of taking an update. The
 * harness cannot generate a deploy job, so it cannot regenerate one either.
 *
 * AC-1: a consumer job the harness cannot generate survives re-scaffold
 *       verbatim, read back out of the written file
 * AC-2: a write that would remove content the harness did not author is
 *       REFUSED, and the refusal names the dropped jobs and the line delta
 * AC-5: every reported action verb is derived from the measured before/after
 *       content — a content-removing write reports REPLACED with its delta,
 *       never CREATED
 *
 * AC-3 lives in test/scaffold-idempotent.test.ts (it needs the real pipeline),
 * AC-4 in test/unit/post-scaffold-commit.test.ts, and AC-6 in
 * test/scaffold-ci-preservation-mutation.test.ts.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows, resolveManagedWrite, writeManagedFile } from "../lib/scaffold/steps";

const CI_REL = join(".github", "workflows", "ci.yml");

function plantConfig(root: string): void {
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify(
      { project: "preservation-fixture", ci: { runner: "ubuntu-latest", bunVersion: "1.2.0", branches: ["main"] } },
      null,
      2,
    ) + "\n",
  );
}

/**
 * The canonical generated ci.yml, MEASURED by running the real generator into
 * a throwaway directory rather than pasted in here. A hand-written copy would
 * drift from the generator and the "removed content" fixtures below would then
 * be testing a file the harness never writes.
 */
let GENERATED_CI = "";

beforeAll(() => {
  const probe = mkdtempSync(join(tmpdir(), "ci-preserve-probe-"));
  try {
    plantConfig(probe);
    createCiWorkflows(probe, []);
    GENERATED_CI = readFileSync(join(probe, CI_REL), "utf-8");
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

/** A job no rungate generator emits, in the block form a human writes. */
const CONSUMER_JOB = [
  "",
  "  deploy-to-staging:",
  "    needs: test",
  "    runs-on: self-hosted",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - name: a step the harness knows nothing about",
  "        run: ./scripts/deploy.sh staging",
].join("\n");

let ROOT = "";

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "ci-preserve-"));
  plantConfig(ROOT);
  mkdirSync(join(ROOT, ".github", "workflows"), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const readCi = () => readFileSync(join(ROOT, CI_REL), "utf-8");
const jobsOf = (src: string) => Object.keys((Bun.YAML.parse(src) as any)?.jobs ?? {});

/**
 * Add one extra step inside the harness-OWNED `test` job, at whatever
 * indentation the generator actually used. Hard-coding the indent would make
 * the fixture silently stop being a content-removing write the first time the
 * generated YAML is reindented, and the AC-5 cases would pass vacuously.
 */
function withExtraHarnessStep(src: string): string {
  const lines = src.split("\n");
  const i = lines.findIndex(l => /^\s+- run: bun install$/.test(l));
  if (i < 0) throw new Error("fixture broken: generated ci.yml no longer has a `- run: bun install` step");
  const indent = lines[i].slice(0, lines[i].indexOf("-"));
  lines.splice(i + 1, 0, `${indent}- run: echo extra-step-the-harness-will-remove`);
  return lines.join("\n");
}

// ── AC-1 ───────────────────────────────────────────────────────────────────

describe("AC-1: a consumer-authored job survives re-scaffold verbatim", () => {
  beforeEach(() => {
    writeFileSync(join(ROOT, CI_REL), GENERATED_CI.replace(/\n*$/, "\n") + CONSUMER_JOB + "\n");
  });

  test("zero consumer-authored job lines are removed", () => {
    createCiWorkflows(ROOT, []);
    const after = readCi();
    const removed = CONSUMER_JOB.split("\n")
      .map(l => l.trimEnd())
      .filter(Boolean)
      .filter(line => !after.includes(line));
    expect(removed).toEqual([]);
  });

  test("the consumer job is still a job, not just surviving text", () => {
    createCiWorkflows(ROOT, []);
    const jobs = jobsOf(readCi());
    expect(jobs).toContain("deploy-to-staging");
    expect(jobs).toContain("test");
  });

  test("the preserved job keeps its steps intact", () => {
    createCiWorkflows(ROOT, []);
    const deploy = (Bun.YAML.parse(readCi()) as any).jobs["deploy-to-staging"];
    expect(deploy["runs-on"]).toBe("self-hosted");
    expect(deploy.needs).toBe("test");
    expect(JSON.stringify(deploy.steps)).toContain("./scripts/deploy.sh staging");
  });

  test("the harness still regenerates its OWN job — preservation is not a skip", () => {
    // A guard that preserved by declining to write at all would pass every
    // assertion above while silently freezing the harness-owned half.
    writeFileSync(
      join(ROOT, CI_REL),
      GENERATED_CI.replace('bun-version: "1.2.0"', 'bun-version: "0.0.1-stale"').replace(/\n*$/, "\n") +
        CONSUMER_JOB + "\n",
    );
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const after = readCi();
    expect(after).toContain('bun-version: "1.2.0"');
    expect(after).not.toContain("0.0.1-stale");
    expect(jobsOf(after)).toContain("deploy-to-staging");
  });

  test("the written file still parses as YAML", () => {
    createCiWorkflows(ROOT, []);
    expect(() => Bun.YAML.parse(readCi())).not.toThrow();
  });

  test("the action reports which job was carried forward", () => {
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    expect(actions.join("\n")).toContain("deploy-to-staging");
  });
});

// ── AC-2 ───────────────────────────────────────────────────────────────────

/**
 * Detection is semantic (`Bun.YAML.parse`) and preservation is textual (a
 * verbatim line slice). A flow mapping is the shape where the two disagree:
 * the parser sees the job, the slicer has no block to carry forward. The whole
 * point of the design is that THAT disagreement refuses rather than guessing,
 * because guessing is how the consumer's build gets deleted.
 */
const FLOW_MAPPING_CI = [
  "name: CI",
  'on: {push: {branches: ["main"]}}',
  "jobs: {release: {runs-on: ubuntu-latest, steps: [{run: ./release.sh}]}}",
  "",
].join("\n");

describe("AC-2: a write that would drop unowned content is refused", () => {
  beforeEach(() => {
    writeFileSync(join(ROOT, CI_REL), FLOW_MAPPING_CI);
  });

  test("writeManagedFile throws, naming the dropped job and the line delta", () => {
    let message = "";
    try {
      writeManagedFile(join(ROOT, CI_REL), GENERATED_CI, CI_REL, []);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("release");
    expect(message).toMatch(/line delta [+-]\d+/);
  });

  test("createCiWorkflows records REFUSED rather than destroying the file", () => {
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const refusal = actions.find(a => a.startsWith("REFUSED:"));
    expect(refusal).toBeDefined();
    expect(refusal!).toContain("release");
    expect(refusal!).toMatch(/line delta [+-]\d+/);
  });

  test("the consumer's bytes are untouched after the refusal", () => {
    createCiWorkflows(ROOT, []);
    expect(readCi()).toBe(FLOW_MAPPING_CI);
  });

  test("an unreadable existing file is refused, not overwritten", () => {
    const garbage = "\tthis: is not: valid yaml: at all\n\t\t- [unclosed\n";
    writeFileSync(join(ROOT, CI_REL), garbage);
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    expect(readCi()).toBe(garbage);
    expect(actions.join("\n")).toContain("REFUSED:");
  });

  test("--force is the documented escape hatch, and it is opt-in", () => {
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions, { force: true });
    expect(readCi()).toBe(GENERATED_CI);
    expect(actions.join("\n")).not.toContain("REFUSED:");
  });
});

// ── AC-5 ───────────────────────────────────────────────────────────────────

describe("AC-5: action verbs are derived from the measured before/after", () => {
  test("a content-removing write reports REPLACED with its line delta", () => {
    // One extra line inside the harness-OWNED `test` job: regeneration removes
    // it, which is allowed (the harness authored that job) but must be
    // reported as a removal rather than as a creation.
    writeFileSync(join(ROOT, CI_REL), withExtraHarnessStep(GENERATED_CI));

    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);

    const entry = actions.find(a => a.includes("ci.yml"));
    expect(entry).toBeDefined();
    expect(entry!.startsWith("REPLACED:")).toBe(true);
    expect(entry!).toMatch(/-1 lines/);
  });

  test("no content-removing write is ever reported as CREATED", () => {
    // The same removal, this time alongside a consumer job that must be
    // carried forward: the net line count GROWS, and the verb must still be
    // the one the removed line earns.
    writeFileSync(
      join(ROOT, CI_REL),
      withExtraHarnessStep(GENERATED_CI).replace(/\n*$/, "\n") + CONSUMER_JOB + "\n",
    );
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const entry = actions.find(a => a.includes("ci.yml"))!;
    expect(entry.startsWith("CREATED:")).toBe(false);
    expect(entry.startsWith("REPLACED:")).toBe(true);
    expect(jobsOf(readCi())).toContain("deploy-to-staging");
  });

  test("CREATED is reported only when there was no file before", () => {
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    expect(actions.some(a => a.startsWith("CREATED:") && a.includes("ci.yml"))).toBe(true);
  });

  test("an identical regeneration reports SKIP, not UPDATED", () => {
    writeFileSync(join(ROOT, CI_REL), GENERATED_CI);
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const entry = actions.find(a => a.includes("ci.yml"));
    expect(entry!.startsWith("SKIP:")).toBe(true);
  });

  test("resolveManagedWrite measures the verb rather than being told it", () => {
    expect(resolveManagedWrite(null, "a\nb\n").verb).toBe("CREATED");
    expect(resolveManagedWrite("a\nb\n", "a\nb\n").verb).toBe("SKIP");
    expect(resolveManagedWrite("jobs:\n  test:\n    runs-on: x\n", "jobs:\n  test:\n    runs-on: x\n    env: y\n").verb).toBe("UPDATED");

    const shrink = resolveManagedWrite(
      "jobs:\n  test:\n    runs-on: x\n    env: y\n",
      "jobs:\n  test:\n    runs-on: x\n",
    );
    expect(shrink.verb).toBe("REPLACED");
    expect(shrink.lineDelta).toBe(-1);
  });
});
