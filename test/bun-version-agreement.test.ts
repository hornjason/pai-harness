/**
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-7 (#622).
 *
 * Nothing in this repository pinned the Bun version. Local was 1.3.14, CI's
 * `bun-version: "latest"` resolved to 1.4.3, and `release.yml` carried a third
 * spelling — a literal `"1.3.14"` nobody compared to anything. So the runtime
 * executing a given commit could change between two runs of that same commit,
 * with nothing in the diff to explain a new failure, and re-running a red job
 * was also a Bun upgrade.
 *
 * This is #621's shape one step down: there, three files named the project's
 * test command three ways; here, four workflow files named the runtime that
 * runs it. The remedy is the same — one declaration, one module that resolves
 * it, and a check that reads every position and refuses when they disagree.
 *
 * ## Why the extractor throws instead of returning nothing
 *
 * A check that reads four workflow files and compares what each says about Bun
 * is satisfied by finding nothing in all four — zero strings are trivially all
 * equal, and "no step names a moving tag" is true of a directory with no
 * setup-bun steps in it. That is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s third shape, and it is how
 * this particular check is most likely to die: `ci.yml` and `gates.yml` are
 * GENERATED, so a template change renames a step and the reading quietly
 * shrinks. So `setupBunStepsIn` refuses a file with no `jobs:` block, the
 * directory scan refuses when no file uses the action at all, and every case
 * asserts its own coverage before asserting anything about what it read.
 *
 * ## Why the reading is parsed, not grepped
 *
 * AC-2 asks for a grep. A grep for `bun-version: "latest"` is a detector
 * narrower than what it detects — `bun-version: latest` unquoted, `'latest'`
 * single-quoted and a flow mapping all defeat it, and all three are valid
 * workflow syntax that GitHub honours. So the property is asserted against
 * `Bun.YAML.parse`d steps, and the raw text is used for one thing only: the
 * number of `oven-sh/setup-bun@` occurrences must equal the number of steps
 * the parse found. That is the instrument check, not a second decider — it
 * catches a parse that silently stopped seeing steps, which is the failure
 * mode a text search cannot have and a parser can.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUN_VERSION_FILE,
  MOVING_BUN_TAGS,
  bunVersionReading,
  declaredBunVersion,
  isPinnedBunVersion,
  setupBunWith,
} from "../lib/bun-version";
import { createCiWorkflows } from "../lib/scaffold/steps";

const REPO_ROOT = join(import.meta.dir, "..");
/**
 * How many `setup-bun` steps `createCiWorkflows` emits: one in `ci.yml`, one
 * in `gates.yml`, and since #1013 one in `ai-review.yml`, which installs bun
 * for the findings adjudicator. Declared once, because three cases below
 * count them and three literals would drift apart.
 */
const GENERATED_BUN_STEPS = 3;

const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/** One `oven-sh/setup-bun` step, and what it says about which Bun to install. */
interface SetupBunStep {
  file: string;
  job: string;
  /** The `bun-version` input — a version literal spelled in the workflow. */
  version: string | null;
  /** The `bun-version-file` input — a pointer at the declaration. */
  versionFile: string | null;
}

/** Thrown when a position this check reads says nothing about Bun at all. */
class NoSetupBunError extends Error {}

function setupBunStepsIn(file: string, text: string): SetupBunStep[] {
  const doc = Bun.YAML.parse(text) as any;
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") {
    throw new NoSetupBunError(
      `${file} has no jobs: block, so no step in it can be read — ` +
        `four workflows naming nothing are not four workflows that agree.`,
    );
  }
  const found: SetupBunStep[] = [];
  for (const [job, body] of Object.entries<any>(jobs)) {
    for (const step of (body?.steps ?? []) as any[]) {
      if (typeof step?.uses !== "string" || !step.uses.startsWith("oven-sh/setup-bun@")) continue;
      const w = (step.with ?? {}) as Record<string, unknown>;
      found.push({
        file,
        job,
        version: w["bun-version"] === undefined ? null : String(w["bun-version"]),
        versionFile: w["bun-version-file"] === undefined ? null : String(w["bun-version-file"]),
      });
    }
  }
  // The instrument check. A parse that stopped seeing steps reads exactly like
  // a directory with nothing to find.
  const raw = (text.match(/oven-sh\/setup-bun@/g) ?? []).length;
  if (raw !== found.length) {
    throw new NoSetupBunError(
      `${file} names oven-sh/setup-bun ${raw} time(s) but the parse found ${found.length} step(s)`,
    );
  }
  return found;
}

function workflowFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

function setupBunStepsUnder(dir: string): SetupBunStep[] {
  const files = workflowFiles(dir);
  if (files.length === 0) throw new NoSetupBunError(`${dir} holds no workflow files`);
  const steps = files.flatMap(f => setupBunStepsIn(f, readFileSync(join(dir, f), "utf-8")));
  if (steps.length === 0) {
    throw new NoSetupBunError(
      `no workflow under ${dir} uses oven-sh/setup-bun, so nothing there declares a Bun version`,
    );
  }
  return steps;
}

// ── AC-2 / AC-3: this repository's own workflows ────────────────────────────

describe("AC-2: no workflow under .github/workflows resolves Bun from a moving tag", () => {
  test("every setup-bun step is read, and the scan says how many it read", () => {
    // The coverage assertion, first and on its own. Every case below is
    // satisfied by an empty reading, so the reading is established before any
    // of them run. Nine workflow files carry a setup-bun step today:
    // action-pins, ai-review, ci, claude-review, closing-references, gates,
    // issue-audit, release and suite-flake. `ai-review` joined in #1013,
    // which runs the findings
    // adjudicator through `bunx`; `claude-review` joined in #732, which needs bun on PATH
    // for the post-step that reads what the review actually did;
    // `action-pins` joined in #789, the weekly freshness check for the pins
    // this file is about; `suite-flake` joined in #323, which runs the suite
    // ten times on one tree and reads the series; `closing-references` joined
    // in #1362, which runs the closing-reference audit this branch adds.
    //
    // The floor and the list are two different claims, deliberately:
    // the floor says the scan read SOMETHING, so no case below is satisfied
    // by an empty reading; the list says WHICH, so a workflow that quietly
    // stops installing bun — or a new one that installs it from a tag nobody
    // reviewed — is named here rather than absorbed. Adding a workflow is
    // meant to turn this red once.
    const steps = setupBunStepsUnder(WORKFLOW_DIR);
    expect(steps.length, "fewer setup-bun steps than this repo has workflows that install bun")
      .toBeGreaterThanOrEqual(9);
    const files = new Set(steps.map(s => s.file));
    expect([...files].sort()).toEqual([
      "action-pins.yml",
      "ai-review.yml",
      "ci.yml",
      "claude-review.yml",
      "closing-references.yml",
      "gates.yml",
      "issue-audit.yml",
      "release.yml",
      "suite-flake.yml",
    ]);
  });

  test("no step names latest or canary", () => {
    const steps = setupBunStepsUnder(WORKFLOW_DIR);
    for (const step of steps) {
      expect(
        step.version === null || !MOVING_BUN_TAGS.includes(step.version as any),
        `${step.file} (${step.job}) resolves bun from the moving tag ${JSON.stringify(step.version)} — ` +
          `re-running that job is also a Bun upgrade`,
      ).toBe(true);
    }
  });
});

describe("AC-3: every setup-bun step resolves the version from the single declaration", () => {
  test("no workflow spells a Bun version literal of its own", () => {
    const steps = setupBunStepsUnder(WORKFLOW_DIR);
    for (const step of steps) {
      expect(step.version, `${step.file} (${step.job}) spells its own Bun version`).toBeNull();
      expect(step.versionFile, `${step.file} (${step.job}) resolves bun from nothing at all`)
        .toBe(BUN_VERSION_FILE);
    }
  });

  test("the declaration the steps point at exists, is a pin, and is what the module resolves", () => {
    const declared = declaredBunVersion(REPO_ROOT);
    expect(declared.source, declared.reason).toBe("bun-version-file");
    expect(isPinnedBunVersion(declared.version), `${declared.version} is not a pin`).toBe(true);
    // The file the workflows point at and the value the module resolves are
    // the same bytes, not two readings that happen to agree.
    const onDisk = readFileSync(join(REPO_ROOT, BUN_VERSION_FILE), "utf-8").trim();
    expect(declared.version).toBe(onDisk);
    expect(declared.conflict, "two declarations naming two versions").toBe("");
  });
});

// ── AC-1: one module, and the generator reads it ────────────────────────────

describe("AC-1: the generator derives the bun step from the module, not from a literal of its own", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rungate-bun-version-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(name: string, opts: { file?: string; configVersion?: string }): string {
    const root = join(dir, name);
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify(
        {
          project: name,
          ci: { runner: "ubuntu-latest", branches: ["main"], ...(opts.configVersion ? { bunVersion: opts.configVersion } : {}) },
        },
        null,
        2,
      ) + "\n",
    );
    if (opts.file) writeFileSync(join(root, BUN_VERSION_FILE), `${opts.file}\n`);
    createCiWorkflows(root, []);
    return root;
  }

  test("two projects differing only in the declaration produce different bun steps", () => {
    // The shared binding, shown by mutating the INPUT rather than by reading
    // the source: if the generator named a version of its own, these two would
    // agree. `lib/scaffold/steps.ts` had `harness?.ci?.bunVersion || "latest"`
    // and emitted it at two sites; #87 and #488 are the same collapse applied
    // to the typecheck and test steps directly beside it.
    const a = fixture("declares-1-2-3", { file: "1.2.3" });
    const b = fixture("declares-4-5-6", { file: "4.5.6" });
    const stepsA = setupBunStepsUnder(join(a, ".github", "workflows"));
    const stepsB = setupBunStepsUnder(join(b, ".github", "workflows"));
    expect(stepsA.length).toBe(GENERATED_BUN_STEPS);
    expect(stepsB.length).toBe(GENERATED_BUN_STEPS);
    // Both point at their own declaration, and the declarations differ.
    for (const s of [...stepsA, ...stepsB]) expect(s.versionFile).toBe(BUN_VERSION_FILE);
    expect(readFileSync(join(a, BUN_VERSION_FILE), "utf-8").trim()).toBe("1.2.3");
    expect(readFileSync(join(b, BUN_VERSION_FILE), "utf-8").trim()).toBe("4.5.6");
    expect(declaredBunVersion(a).version).toBe("1.2.3");
    expect(declaredBunVersion(b).version).toBe("4.5.6");
  });

  test("a project that declares only ci.bunVersion still gets that version and not latest", () => {
    // The rung below the file. A consumer on the documented config field has
    // no `.bun-version` for CI to read, so the generator emits the value the
    // operator declared — verbatim, which is the whole of AC-7 at this rung.
    const root = fixture("config-only", { configVersion: "1.2.0" });
    const steps = setupBunStepsUnder(join(root, ".github", "workflows"));
    expect(steps.length).toBe(GENERATED_BUN_STEPS);
    for (const s of steps) expect(s.version).toBe("1.2.0");
    const decision = declaredBunVersion(root);
    expect(decision.source).toBe("config");
    expect(decision.version).toBe("1.2.0");
  });

  test("a project declaring nothing is recorded as undeclared, never silently pinned", () => {
    // `.claude/rules/config-access.md`: a built-in default substituted for an
    // absent declaration must be loud. `latest` here is the consumer's status
    // quo, so it still ships — but the generated file says so in writing and
    // the decision names the state, because `0`, `{}` and silence are all
    // indistinguishable from success.
    const root = fixture("declares-nothing", {});
    const decision = declaredBunVersion(root);
    expect(decision.source).toBe("undeclared");
    expect(decision.version).toBeNull();
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
    expect(ci).toContain("UNPINNED");
  });
});

// ── AC-4: a run on a different Bun than the declared one says so ────────────

describe("AC-4: a mismatch between the running Bun and the declared one is loud", () => {
  /**
   * Fabricated on purpose. Driving this branch with `Bun.version` would make
   * the case assert whatever the machine happens to be running, and it would
   * pass on a machine where the mismatch cannot occur — which is every machine
   * that is already correct. The two constants are asserted to differ from the
   * real one below, so the case cannot go green by coincidence.
   */
  const DECLARED = "1.3.14-fabricated";
  const RUNNING = "9999.0.0-fabricated";

  test("the fabricated versions are not the machine's own", () => {
    expect(DECLARED).not.toBe(Bun.version);
    expect(RUNNING).not.toBe(Bun.version);
    expect(DECLARED).not.toBe(RUNNING);
  });

  test("a mismatch names both versions and both positions", () => {
    const r = bunVersionReading(
      { version: DECLARED, source: "bun-version-file", reason: "fixture", conflict: "" },
      RUNNING,
    );
    expect(r.state).toBe("mismatch");
    expect(r.line).toContain(DECLARED);
    expect(r.line).toContain(RUNNING);
    expect(r.line).toContain(BUN_VERSION_FILE);
    // Loud, not a footnote: a line a reader can scan a pasted log for.
    expect(r.line).toMatch(/WARNING|MISMATCH/);
  });

  test("a matching version is reported as a match rather than as silence", () => {
    const r = bunVersionReading(
      { version: DECLARED, source: "bun-version-file", reason: "fixture", conflict: "" },
      DECLARED,
    );
    expect(r.state).toBe("match");
    expect(r.line).toContain(DECLARED);
    expect(r.line).not.toMatch(/WARNING|MISMATCH/);
  });

  test("an undeclared version is UNMEASURED, which is neither a match nor a mismatch", () => {
    // The absence of a declaration must not be satisfiable as agreement
    // (`.claude/rules/checks-must-be-able-to-fail.md`): nothing to compare
    // against is a third state, and it is the one that has to be reportable.
    const r = bunVersionReading(
      { version: null, source: "undeclared", reason: "fixture declares nothing", conflict: "" },
      RUNNING,
    );
    expect(r.state).toBe("undeclared");
    expect(r.line).toContain("UNMEASURED");
    expect(r.line).toContain(RUNNING);
  });

  test("a conflict between two declarations is reported, not resolved in silence", () => {
    const r = bunVersionReading(
      {
        version: DECLARED,
        source: "bun-version-file",
        reason: "fixture",
        conflict: `${BUN_VERSION_FILE} says ${DECLARED} and ci.bunVersion says 1.0.0`,
      },
      DECLARED,
    );
    expect(r.line).toContain("1.0.0");
    expect(r.line).toMatch(/WARNING|MISMATCH/);
  });
});

// ── AC-5: a pasted clean-env result carries its own provenance ──────────────

describe("AC-5: the clean-env run prints the Bun it actually ran under", () => {
  test("exactly one line names the running bun version", () => {
    // Spawned, not described. A source-text assertion that the script imports
    // the module cannot tell a printed line from an unreachable one, and the
    // whole claim is about what a pasted log carries.
    const r = spawnSync(
      "bun",
      [
        join("scripts", "test-clean-env.ts"),
        "--no-ci-checkout",
        join("test", "unit", "secret-patterns.test.ts"),
      ],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 240_000 },
    );
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const naming = output
      .split("\n")
      .filter(line => new RegExp(`clean-env.*bun( version)? ${Bun.version.replace(/\./g, "\\.")}`).test(line));
    expect(naming.length, `provenance lines in:\n${output}`).toBe(1);
  }, 300_000);
});

// ── AC-7: an unresolvable declaration reaches CI verbatim ───────────────────

describe("AC-7: an unresolvable declared version produces workflows naming it, with no fallback", () => {
  /**
   * The negative control. Without it, AC-2 and AC-3 are satisfied by workflow
   * files that happen to carry the right string, and nothing establishes that
   * the generated text derives from the declaration rather than coincidentally
   * agreeing with it.
   *
   * The value is deliberately not plain semver, because the cheapest repair
   * for "CI fails on a bad pin" is a well-formedness guard with `|| "latest"`
   * behind it — the fallback this AC forbids. A `1.2.3`-shaped fixture would
   * survive that repair and certify it.
   */
  const UNRESOLVABLE = "9999.0.0-no-such-bun";
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rungate-bun-unresolvable-"));
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "unresolvable-fixture", ci: { runner: "ubuntu-latest", branches: ["main"] } }, null, 2) + "\n",
    );
    writeFileSync(join(root, BUN_VERSION_FILE), `${UNRESOLVABLE}\n`);
    createCiWorkflows(root, []);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the generated workflows resolve exactly the unresolvable value", () => {
    const steps = setupBunStepsUnder(join(root, ".github", "workflows"));
    expect(steps.length).toBe(GENERATED_BUN_STEPS);
    for (const step of steps) {
      expect(step.versionFile, `${step.file} stopped reading the declaration`).toBe(BUN_VERSION_FILE);
      expect(step.version, `${step.file} substituted a version of its own`).toBeNull();
    }
    // What CI will install is the file's bytes, unaltered by the generator.
    expect(readFileSync(join(root, BUN_VERSION_FILE), "utf-8").trim()).toBe(UNRESOLVABLE);
    expect(declaredBunVersion(root).version).toBe(UNRESOLVABLE);
  });

  test("no fallback to latest appears anywhere in the generated workflows", () => {
    for (const file of ["ai-review.yml", "ci.yml", "gates.yml"]) {
      const text = readFileSync(join(root, ".github", "workflows", file), "utf-8");
      for (const tag of MOVING_BUN_TAGS) {
        expect(text, `${file} fell back to ${tag}`).not.toMatch(
          new RegExp(`bun-version:\\s*["']?${tag}`),
        );
      }
    }
  });

  test("both generated workflows resolve the same declaration", () => {
    const steps = setupBunStepsUnder(join(root, ".github", "workflows"));
    const distinct = new Set(steps.map(s => `${s.version}|${s.versionFile}`));
    expect([...distinct]).toEqual([`null|${BUN_VERSION_FILE}`]);
    // And the emitter itself refuses to invent one: the same decision in, the
    // same bytes out, for the one function both steps are built from.
    const decision = declaredBunVersion(root);
    expect(setupBunWith(decision, "          ")).toContain(BUN_VERSION_FILE);
    expect(setupBunWith(decision, "          ")).not.toContain("latest");
  });

  test("the fallback mutation red count is recorded in the spec", () => {
    // AC-7 asks for the count in writing. The mutation itself is run by hand
    // and reverted — `.claude/rules/checks-must-be-able-to-fail.md` — so the
    // durable artefact is the row, and this is the check that it exists.
    const spec = readFileSync(join(REPO_ROOT, "specs", "HARNESS-STANDARD.md"), "utf-8");
    const start = spec.indexOf("### When the declaration is a runtime version (#622)");
    expect(start, "the #622 mutation section is not in HARNESS-STANDARD.md").toBeGreaterThan(-1);
    const rest = spec.slice(start);
    const end = rest.indexOf("\n### ", 1);
    // The slice, and the SC lines removed from it. A criterion that names its
    // own tokens is not evidence for them — #171's eleventh mutation row is
    // this exact trap, caught by the guard it describes.
    const section = (end === -1 ? rest : rest.slice(0, end))
      .split("\n")
      .filter(line => !/^- \[[ x]\] SC-\d+:/.test(line))
      .join("\n");
    expect(section.trim(), "the #622 section is empty once its SC lines are removed").not.toBe("");
    expect(section).toContain(UNRESOLVABLE);
    expect(section, "no mutation row naming the fallback").toMatch(/fallback/i);
    expect(section, "no red count beside the fallback row").toMatch(/\d+ of \d+/);
  });
});
