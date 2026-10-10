/**
 * scaffold-ci-preservation.test.ts — #216. Re-scaffold must not destroy a
 * consumer's CI.
 *
 * `createCiWorkflows` ended in two unconditional `writeFileSync` calls. Every
 * re-scaffold therefore replaced `.github/workflows/ci.yml` wholesale, and
 * re-scaffolding is the documented way to onboard AND to update a consumer. On
 * our first real consumer that is a destroyed build, which is why SUCCESS.md
 * claim 5 ("the harness works on a repo that is not this one") cannot be made
 * until this holds.
 *
 * AC-1: a consumer job the harness cannot generate survives re-scaffold
 *       verbatim, read back out of the written file
 * AC-2: a write that would remove content the harness did not author is
 *       REFUSED, and the refusal names the jobs and the line delta
 * AC-5: the reported verb is derived from the measured before/after content —
 *       a content-removing write reports REPLACED with its line delta, and
 *       never CREATED
 *
 * AC-3 lives in test/scaffold-idempotent.test.ts (it needs the real pipeline),
 * AC-4 in test/unit/post-scaffold-commit.test.ts, AC-6 in
 * test/scaffold-ci-preservation-mutation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { harnessRegion, planManagedWrite } from "../lib/scaffold/managed-workflow";

let ROOT = "";
const CI = () => join(ROOT, ".github", "workflows", "ci.yml");
const readCi = () => readFileSync(CI(), "utf-8");

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "ci-preservation-"));
});
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * A job rungate has no way to generate: it deploys to the consumer's own
 * infrastructure with the consumer's own secret. Nothing in rungate's config
 * schema can produce it, so "regenerate from config" cannot reproduce it and
 * overwriting it is data loss rather than a refresh.
 */
const DEPLOY_JOB = [
  "  deploy:",
  "    needs: test",
  "    if: github.ref == 'refs/heads/main'",
  "    runs-on: ubuntu-latest",
  "    environment: production",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - name: Publish to the consumer's own registry",
  "        run: ./scripts/publish.sh --tag release",
  "        env:",
  "          REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}",
];

/** A step a consumer added INSIDE the harness-authored `test` job. */
const CONSUMER_STEP = ["      - name: consumer smoke test", "        run: ./scripts/smoke.sh"];

/** Scaffold ci.yml once, the way a consumer is first onboarded. */
function firstScaffold(): string[] {
  const actions: string[] = [];
  createCiWorkflows(ROOT, actions);
  return actions;
}

/**
 * Change the harness-owned half of the output.
 *
 * Without this the second run regenerates byte-identical content, the merge is
 * a no-op, and "the consumer's job survived" is satisfied by the harness never
 * having written anything — a vacuous pass of exactly the shape
 * .claude/rules/checks-must-be-able-to-fail.md names. Re-pointing the bun
 * version forces a real rewrite of the harness jobs around the consumer's one.
 */
function changeHarnessConfig(bunVersion: string): void {
  mkdirSync(join(ROOT, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(ROOT, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "consumer", ci: { bunVersion } }, null, 2) + "\n",
  );
}

function appendDeployJob(): void {
  writeFileSync(CI(), readCi() + DEPLOY_JOB.join("\n") + "\n");
}

/** Insert a consumer step into the harness-authored `test` job. */
function editHarnessJob(): void {
  const lines = readCi().split("\n");
  const at = lines.findIndex(l => l.trim() === "- run: bun test");
  expect(at).toBeGreaterThan(-1);
  lines.splice(at + 1, 0, ...CONSUMER_STEP);
  writeFileSync(CI(), lines.join("\n"));
}

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe("AC-1: a consumer-authored job survives re-scaffold verbatim", () => {
  test("zero consumer-authored job lines are removed, read back out of the file", () => {
    changeHarnessConfig("1.2.0");
    firstScaffold();
    appendDeployJob();
    const planted = readCi();

    changeHarnessConfig("1.3.0");
    createCiWorkflows(ROOT, []);

    const after = readCi().split("\n");
    const removed = DEPLOY_JOB.filter(l => !after.includes(l));
    expect(removed).toEqual([]);
    // Not vacuous: the harness half really was rewritten under the consumer's job.
    expect(readCi()).not.toBe(planted);
    expect(readCi()).toContain('bun-version: "1.3.0"');
    expect(readCi()).not.toContain('bun-version: "1.2.0"');
  });

  test("the job survives as one contiguous block, in order", () => {
    changeHarnessConfig("1.2.0");
    firstScaffold();
    appendDeployJob();
    changeHarnessConfig("1.3.0");
    createCiWorkflows(ROOT, []);

    const after = readCi().split("\n");
    const start = after.indexOf(DEPLOY_JOB[0]);
    expect(start).toBeGreaterThan(-1);
    expect(after.slice(start, start + DEPLOY_JOB.length)).toEqual(DEPLOY_JOB);
  });

  test("the merged file still parses, and carries both jobs", () => {
    firstScaffold();
    appendDeployJob();
    createCiWorkflows(ROOT, []);

    const parsed = Bun.YAML.parse(readCi()) as any;
    expect(Object.keys(parsed.jobs).sort()).toEqual(["deploy", "test"]);
    expect(parsed.jobs.deploy.environment).toBe("production");
    // and the harness half is still regenerated, not frozen
    expect(parsed.jobs.test.steps.some((s: any) => s.run === "bun test")).toBe(true);
  });

  test("a consumer top-level key the harness never emits also survives", () => {
    firstScaffold();
    writeFileSync(CI(), readCi() + "\nconcurrency:\n  group: consumer-ci\n  cancel-in-progress: true\n");

    createCiWorkflows(ROOT, []);

    const parsed = Bun.YAML.parse(readCi()) as any;
    expect(parsed.concurrency).toEqual({ group: "consumer-ci", "cancel-in-progress": true });
  });
});

/**
 * The marker's whole value rests on one claim: the harness-authored region can
 * be reconstructed out of the merged file byte-for-byte. If it cannot, the
 * hash never matches, every config change looks like consumer content, and the
 * scaffold refuses forever — which is how a fail-closed guard gets deleted.
 */
describe("the harness region is the exact inverse of the merge", () => {
  test("extracting the region from a merged file returns the generated bytes", () => {
    firstScaffold();
    const generated = readCi().split("\n").filter(l => !l.startsWith("# rungate-managed-sha256:")).join("\n");
    appendDeployJob();
    const merged = readCi().split("\n").filter(l => !l.startsWith("# rungate-managed-sha256:")).join("\n");

    expect(merged).not.toBe(generated); // not vacuous: the file really grew
    expect(harnessRegion(merged, generated)).toBe(generated);
  });

  test("a consumer edit INSIDE a harness job makes the region differ", () => {
    firstScaffold();
    const generated = readCi().split("\n").filter(l => !l.startsWith("# rungate-managed-sha256:")).join("\n");
    editHarnessJob();
    const edited = readCi().split("\n").filter(l => !l.startsWith("# rungate-managed-sha256:")).join("\n");

    expect(harnessRegion(edited, generated)).not.toBe(generated);
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe("AC-2: a write that would remove unauthored content is refused", () => {
  test("re-scaffold refuses, and the refusal names the job and the line delta", () => {
    firstScaffold();
    const before = readCi();
    editHarnessJob();
    const planted = readCi();

    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);

    const refusal = actions.find(a => a.startsWith("REFUSED:"));
    expect(refusal).toBeDefined();
    expect(refusal!).toContain("ci.yml");
    expect(refusal!).toContain("test"); // the job whose content would be lost
    expect(refusal!).toContain(`-${CONSUMER_STEP.length}`); // the line delta
    expect(refusal!).toContain("--force");

    // The refusal is the point: the consumer's file is untouched.
    expect(readCi()).toBe(planted);
    expect(readCi()).not.toBe(before);
  });

  test("a consumer ci.yml the harness never wrote is refused rather than replaced", () => {
    // No marker, and jobs whose content the merge cannot carry: this is the
    // "onboard a repo that already has CI" case, and it is the one that
    // destroys a real build.
    const handWritten = [
      "name: build",
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: make check",
      "",
    ].join("\n");
    mkdirSync(join(ROOT, ".github", "workflows"), { recursive: true });
    writeFileSync(join(ROOT, ".github", "workflows", "ci.yml"), handWritten);

    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    expect(actions.some(a => a.startsWith("REFUSED:"))).toBe(true);
    expect(readCi()).toBe(handWritten);
  });

  test("planManagedWrite reports the refusal with both the job names and the delta", () => {
    firstScaffold();
    const generated = readCi().split("\n").filter(l => !l.startsWith("# rungate-managed-sha256:")).join("\n");
    editHarnessJob();
    const plan = planManagedWrite(readCi(), generated);

    expect(plan.verb).toBe("REFUSED");
    expect(plan.atRiskJobs).toEqual(["test"]);
    expect(plan.lineDelta).toBe(-CONSUMER_STEP.length);
    expect(plan.refusal).toContain("test");
    expect(plan.refusal).toContain(`-${CONSUMER_STEP.length}`);
  });

  test("--force is what overrides it, and nothing else does", () => {
    firstScaffold();
    editHarnessJob();

    const refused: string[] = [];
    createCiWorkflows(ROOT, refused);
    expect(readCi()).toContain("./scripts/smoke.sh");

    const forced: string[] = [];
    createCiWorkflows(ROOT, forced, { force: true });
    expect(readCi()).not.toContain("./scripts/smoke.sh");
  });
});

// ── AC-5 ────────────────────────────────────────────────────────────────────

describe("AC-5: the action verb is measured, not assumed", () => {
  test("a first write reports CREATED", () => {
    const actions = firstScaffold();
    expect(actions.filter(a => a.startsWith("CREATED:")).length).toBe(2);
  });

  test("an unchanged re-write reports SKIP and does not touch the file", () => {
    firstScaffold();
    const before = readCi();
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    expect(actions.every(a => a.startsWith("SKIP:"))).toBe(true);
    expect(readCi()).toBe(before);
  });

  test("a merge that regenerates the harness half reports UPDATED", () => {
    changeHarnessConfig("1.2.0");
    firstScaffold();
    appendDeployJob();
    changeHarnessConfig("1.3.0");

    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const ci = actions.find(a => a.includes("ci.yml"))!;
    expect(ci.startsWith("UPDATED:")).toBe(true);
    // A harness-owned line DID disappear (the old bun version). That is not a
    // loss, because the harness can prove it wrote it — which is the whole
    // reason the marker exists, and the case a line-count guard would refuse.
    expect(ci).not.toContain("REFUSED");
  });

  test("a content-removing write reports REPLACED with its line delta, never CREATED", () => {
    firstScaffold();
    editHarnessJob();
    const beforeLines = readCi().split("\n").length;

    const actions: string[] = [];
    createCiWorkflows(ROOT, actions, { force: true });

    const afterLines = readCi().split("\n").length;
    expect(afterLines).toBeLessThan(beforeLines);

    const ci = actions.find(a => a.includes("ci.yml"))!;
    expect(ci.startsWith("REPLACED:")).toBe(true);
    expect(ci).toContain(`${afterLines - beforeLines}`);
    expect(ci).not.toContain("CREATED");

    // the AC's threshold, stated as the AC states it
    const contentRemovingReportedAsCreated = actions.filter(
      a => a.startsWith("CREATED:") && a.includes("ci.yml"),
    );
    expect(contentRemovingReportedAsCreated).toEqual([]);
  });

  test("the verb comes from the content, not from whether the path existed", () => {
    // Same path, three different readings, three different verbs.
    const seen: string[] = [];
    const take = () => {
      const a: string[] = [];
      createCiWorkflows(ROOT, a, { force: true });
      seen.push(a.find(x => x.includes("ci.yml"))!.split(":")[0]);
    };
    take();            // CREATED
    take();            // SKIP — identical content
    appendDeployJob();
    take();            // REPLACED — force drops the consumer job
    expect(seen).toEqual(["CREATED", "SKIP", "REPLACED"]);
  });
});
