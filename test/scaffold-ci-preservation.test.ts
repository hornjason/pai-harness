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

// ── AC-7 ───────────────────────────────────────────────────────────────────

/**
 * The real consumer, and the hole every case above is blind to.
 *
 * AC-2's fixture plants a consumer JOB, and the refusal it proves names a
 * dropped job. That cannot distinguish "refuses when it would lose content"
 * from "refuses when it would lose a job" — and the live implementation only
 * ever did the second. Measured against a throwaway worktree of the real
 * DailyBriefDashboard at e8ef2823: all twelve jobs survived, all eleven
 * `self-hosted` labels survived, and `concurrency`, `cancel-in-progress`,
 * `paths-ignore`, the top-level `workflow_dispatch` trigger and the consumer's
 * header comments were all destroyed — reported as a preserving `REPLACED
 * (+0 lines, preserved ...)` with `0 refused`.
 *
 * `cancel-in-progress` is not cosmetic there: that CI runs on one self-hosted
 * Mac Mini driving podman against fixed ports, so losing it means three
 * quickly-merged PRs start three concurrent container suites on the same ports.
 *
 * The fixture is taken verbatim from that file rather than written here, for
 * the reason the issue gave: a synthetic one is shaped by the same assumptions
 * as the code, and those assumptions are what was wrong.
 */
const DDB_CI = readFileSync(
  join(import.meta.dir, "fixtures", "consumer-ci", "ddb-ci.yml"),
  "utf-8",
);

/** Every non-blank, non-comment line of the consumer's file. */
const consumerLines = (src: string) =>
  src.split("\n").map(l => l.trim()).filter(l => l !== "");

describe("AC-7: content outside a job is consumer content too", () => {
  beforeEach(() => {
    writeFileSync(join(ROOT, CI_REL), DDB_CI);
  });

  test("no non-blank consumer line is lost, whether or not it sits in a job", () => {
    // The strong form, and the one that fails today. Stated over every line
    // rather than over a named key, because naming the keys would make this
    // exactly as narrow as the check it is replacing.
    createCiWorkflows(ROOT, []);
    const after = new Set(consumerLines(readCi()));
    const missing = consumerLines(DDB_CI).filter(l => !after.has(l));
    expect(
      missing,
      `${missing.length} consumer line(s) were dropped by a write that reported success`,
    ).toEqual([]);
  });

  test("the keys the real consumer lost are each present by name", () => {
    // Redundant with the line sweep above on purpose: when the sweep fails it
    // prints a list, and a reader needs to know which of these mattered.
    createCiWorkflows(ROOT, []);
    const after = readCi();
    for (const needle of [
      "concurrency:",
      "cancel-in-progress: true",
      "paths-ignore:",
      "workflow_dispatch:",
      "group: ci-${{ github.ref }}",
    ]) {
      expect(after, `${needle} was dropped`).toContain(needle);
    }
  });

  test("the consumer's header comments survive", () => {
    createCiWorkflows(ROOT, []);
    expect(readCi()).toContain("Council 4-gate model");
  });

  test("the self-hosted runner labels and lockfile flags survive", () => {
    createCiWorkflows(ROOT, []);
    const after = readCi();
    expect((after.match(/mac-mini-live/g) || []).length).toBe(
      (DDB_CI.match(/mac-mini-live/g) || []).length,
    );
    expect((after.match(/--no-optional --frozen-lockfile/g) || []).length).toBe(
      (DDB_CI.match(/--no-optional --frozen-lockfile/g) || []).length,
    );
  });

  test("the harness still adds its own job — preservation is not a skip", () => {
    // The positive control. A write that preserved everything by writing
    // nothing would pass every case above and onboard no one.
    createCiWorkflows(ROOT, []);
    const jobs = jobsOf(readCi());
    expect(jobs).toContain("shellcheck");
    expect(jobs.length).toBeGreaterThan(jobsOf(DDB_CI).length);
  });

  test("the result still parses as YAML", () => {
    createCiWorkflows(ROOT, []);
    expect(() => Bun.YAML.parse(readCi())).not.toThrow();
  });

  test("a second scaffold over the result changes nothing", () => {
    // Idempotency over a REAL consumer file, which is where a merge that
    // re-appends its own carry-forward every run shows up.
    createCiWorkflows(ROOT, []);
    const once = readCi();
    createCiWorkflows(ROOT, []);
    expect(readCi()).toBe(once);
  });

  test("losing consumer content is refused, not reported as a success", () => {
    // The binding between the two halves: if the merge ever stops carrying
    // something, the write must refuse rather than report a verb. Asserted by
    // measuring the written file against the report, so a relabelled
    // destructive write cannot satisfy it.
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const after = new Set(consumerLines(readCi()));
    const missing = consumerLines(DDB_CI).filter(l => !after.has(l));
    const refused = actions.some(a => a.startsWith("REFUSED:"));
    expect(
      missing.length === 0 || refused,
      `${missing.length} line(s) lost and the run reported: ${actions.join(" | ")}`,
    ).toBe(true);
  });
});

describe("AC-7: exactly one preservation implementation, and production calls it", () => {
  const LIB = join(import.meta.dir, "..", "lib", "scaffold");

  test("the live write path imports the section-aware merge", () => {
    // Stated as a POSITIVE binding, not as "nothing imports the dead module".
    // The negative form is the self-reference trap this repo has been bitten
    // by: a test that names the file it is checking for becomes a reference to
    // it, and goes green by mentioning it. An import specifier in the module
    // that actually runs cannot be satisfied by a comment anywhere.
    const steps = readFileSync(join(LIB, "steps.ts"), "utf-8");
    expect(
      /from\s+"\.\/managed-workflow"/.test(steps),
      "lib/scaffold/steps.ts does not import ./managed-workflow — the merge that " +
        "understands top-level sections is not the one production runs",
    ).toBe(true);
  });

  test("the refusal counts lines, not jobs", () => {
    // Behavioural rather than a source-text ban, which would have to name the
    // very expression the correct code also uses. One consumer line outside
    // any job, dropped: the refusal has to describe it as content outside a
    // job, which the job-name loss set could not express because a line that
    // belongs to no job never entered it.
    // A comment in the `jobs:` mapping head, above the first job. The merge
    // rebuilds that head from the generated file, so this is content it
    // genuinely cannot carry — which is what the refusal is the backstop for.
    // Named here because a refusal with no reachable trigger is a check that
    // cannot fail, and this is the trigger.
    const withJobsHeadComment = [
      "name: CI",
      "",
      "jobs:",
      "  # consumer note about job ordering",
      "  deploy:",
      "    runs-on: self-hosted",
      "    steps:",
      "      - run: ./scripts/deploy.sh",
      "",
    ].join("\n");
    const resolved = resolveManagedWrite(withJobsHeadComment, GENERATED_CI);
    expect(resolved.refusal, "a dropped non-job line did not refuse").not.toBeNull();
    expect(resolved.refusal!).toContain("content outside any job");
    expect(resolved.refusal!).toMatch(/\d+ line\(s\)/);
  });

  test("an edit inside a harness-owned job is overwritten, and said so", () => {
    // The case that is ALLOWED and still has to be reported. The file's own
    // banner says "do not edit", so regenerating it is correct — and
    // DailyBriefDashboard had edited the harness's gates job anyway, adding
    // `bun install --no-optional` for CI resilience on its self-hosted runner.
    // Refusing on this would make every update refuse; staying quiet about it
    // is the log that said CREATED while 470 lines went.
    const edited = GENERATED_CI.replace("- run: bun install", "- run: bun install --no-optional");
    expect(edited, "fixture broken: the generated ci.yml has no `bun install` step").not.toBe(
      GENERATED_CI,
    );
    writeFileSync(join(ROOT, CI_REL), edited);

    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    const line = actions.find(a => a.includes(CI_REL))!;

    expect(line, "the overwrite was not reported at all").toContain("overwrote");
    expect(line, "the report does not name what it overwrote").toContain("--no-optional");
    expect(line.startsWith("REFUSED:"), "an edit to a harness-owned job refused").toBe(false);
    expect(readCi(), "the harness did not actually regenerate its own job").not.toContain(
      "--no-optional",
    );
  });

  test("a clean regeneration reports no overwrite", () => {
    // Positive control for the clause above: if it were appended
    // unconditionally it would be decoration rather than a signal.
    writeFileSync(join(ROOT, CI_REL), DDB_CI);
    const actions: string[] = [];
    createCiWorkflows(ROOT, actions);
    expect(actions.find(a => a.includes(CI_REL))!).not.toContain("overwrote");
  });

  test("a trailing top-level comment no longer costs the consumer every job", () => {
    // Found while looking for a case the refusal could fire on. A `# note` at
    // column zero after the jobs is not a top-level key, so it landed in the
    // jobs section and set the mapping's base indentation to 0 — every job
    // then failed the `indent === base` test, the whole mapping was read as
    // section head, and the merge dropped all four consumer lines including
    // the job itself. The loss count refused it rather than writing it, so it
    // was never destructive; it was one refusal away from being so.
    const trailing = [
      "name: CI", "", "jobs:",
      "  deploy:", "    runs-on: self-hosted", "    steps:", "      - run: ./scripts/deploy.sh",
      "", "# consumer trailing note", "",
    ].join("\n");
    const resolved = resolveManagedWrite(trailing, GENERATED_CI);
    expect(resolved.refusal, `refused instead of merging: ${resolved.refusal}`).toBeNull();
    expect(resolved.content).toContain("deploy:");
    expect(resolved.content).toContain("# consumer trailing note");
    expect(Object.keys((Bun.YAML.parse(resolved.content) as any).jobs)).toContain("deploy");
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
