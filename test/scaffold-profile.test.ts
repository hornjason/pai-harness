/**
 * Covers #449 — `--profile=minimal` scaffolds the AI-friendly repo without the
 * ship harness.
 *
 * **Every exclusion is asserted in BOTH directions, in the same test.** A
 * guard is only observable by the difference between the profile that skips
 * the step and the profile that runs it. #398 learned this the expensive way
 * this afternoon: an `if (!rehearsing)` guard scored **0 red** under mutation,
 * because nothing asserted the step happened in the un-guarded case, so
 * removing the guard changed no assertion. An absent file proves nothing on
 * its own — the step may have been broken, the fixture may have been wrong, or
 * the path may never have been written by either profile.
 *
 * What was broken to prove this can fail, run and counted rather than
 * asserted — see the table in the PR body and `specs/HARNESS-STANDARD.md`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  DEFAULT_PROFILE,
  isRuleIncluded,
  isStepIncluded,
  parseProfile,
  RULES_NOT_MINIMAL,
  SCAFFOLD_PROFILES,
  STEPS_NOT_MINIMAL,
} from "../lib/scaffold/profiles";
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";

const ROOT = resolve(import.meta.dir, "..");
const SCAFFOLD = join(ROOT, "scripts", "scaffold-project.ts");
const FIXTURE = join(ROOT, "test", "fixtures", "golden-project");
const PIPELINE = join(ROOT, "lib", "scaffold", "write-steps.ts");

const temps: string[] = [];
afterAll(() => temps.forEach(d => rmSync(d, { recursive: true, force: true })));

/** Scaffold a fresh copy of the golden project at the given profile. */
function scaffoldAt(profile: "full" | "minimal"): string {
  const dir = mkdtempSync(join(tmpdir(), `profile-${profile}-`));
  temps.push(dir);
  const dest = join(dir, "project");
  mkdirSync(dest, { recursive: true });
  execSync(`cp -r ${FIXTURE}/. ${dest}/`);
  initFixtureRepo(dest);
  commitFixture(dest, "init fixture");
  execSync(`bun run ${SCAFFOLD} ${dest} --fix --profile=${profile}`, {
    timeout: 120000, encoding: "utf-8", stdio: "pipe",
  });
  return dest;
}

/**
 * The artefacts each excluded step is responsible for.
 *
 * `.claude/rungate/` is the directory layout, not the legacy
 * `.claude/rungate.json` monolith — a fresh scaffold writes the former and
 * only touches the latter when it already exists. The first draft of this
 * file asserted the monolith and the positive control caught it on the first
 * run: the path was absent under BOTH profiles, so the negative assertion was
 * passing over a step that had never written it. That is the exact failure
 * #398 scored 0 red on, found here only because full is asserted too.
 */
const STEP_ARTEFACTS: Record<string, string[]> = {
  generateOrAuditProjectHarness: [".claude/rungate/config.json", ".claude/rungate/roles.json"],
  generateAgentBriefsStep: [".claude/agents/marcus.md", ".claude/agents/quinn.md"],
  createCiWorkflows: [".github/workflows/ci.yml", ".github/workflows/gates.yml"],
};

// Scaffolding is slow, so both trees are built once and shared across cases.
const full = scaffoldAt("full");
const minimal = scaffoldAt("minimal");

describe("#449 PROFILE-1: minimal omits the harness, full emits it", () => {
  for (const [step, artefacts] of Object.entries(STEP_ARTEFACTS)) {
    for (const artefact of artefacts) {
      test(`${step} → ${artefact}: absent under minimal, present under full`, () => {
        // The positive half is the whole point. Without it, a step that
        // silently stopped working would satisfy the negative half forever.
        expect(existsSync(join(full, artefact)), `${artefact} missing under FULL — the guard is untestable`).toBe(true);
        expect(existsSync(join(minimal, artefact)), `${artefact} present under MINIMAL — the guard did not fire`).toBe(false);
      });
    }
  }

  for (const rule of RULES_NOT_MINIMAL.keys()) {
    test(`.claude/rules/${rule}: absent under minimal, present under full`, () => {
      expect(existsSync(join(full, ".claude", "rules", rule)), `${rule} missing under FULL`).toBe(true);
      expect(existsSync(join(minimal, ".claude", "rules", rule)), `${rule} present under MINIMAL`).toBe(false);
    });
  }
});

describe("#449 PROFILE-2: minimal still produces an AI-friendly repo", () => {
  // The exclusions are the interesting half, but a profile that also dropped
  // the structure would pass every case above while being useless.
  for (const path of [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/rules/key-files.md",
    ".claude/rules/docs-routing.md",
    "specs",
    "docs/adr",
    "PROJECT-STATE.md",
  ]) {
    test(`${path} is written under minimal`, () => {
      expect(existsSync(join(minimal, path))).toBe(true);
    });
  }

  test("the AGENTS.md generated under minimal does not advertise the ship workflow", () => {
    const agents = readFileSync(join(minimal, "AGENTS.md"), "utf-8");
    expect(agents).not.toContain("Skill(\"ship\")");
  });
});

describe("#449 PROFILE-3: the exclusion maps cannot silently empty", () => {
  // A rename that emptied a map would re-enable the step, and every negative
  // assertion above would still pass because the artefact simply would not be
  // excluded any more. Same protection STEPS_NOT_REHEARSED carries.
  test("every excluded step name is still called in the pipeline", () => {
    const source = readFileSync(PIPELINE, "utf-8");
    for (const step of STEPS_NOT_MINIMAL.keys()) {
      expect(source, `${step} is named in STEPS_NOT_MINIMAL but not called in write-steps.ts`).toContain(`${step}(`);
    }
  });

  test("the maps are non-empty", () => {
    expect(STEPS_NOT_MINIMAL.size).toBeGreaterThan(0);
    expect(RULES_NOT_MINIMAL.size).toBeGreaterThan(0);
  });

  test("every exclusion carries a non-trivial reason", () => {
    for (const [name, reason] of [...STEPS_NOT_MINIMAL, ...RULES_NOT_MINIMAL]) {
      expect(reason.length, `${name} has no usable reason`).toBeGreaterThan(20);
    }
  });
});

describe("#449 PROFILE-4: the flag is parsed, and a typo refuses", () => {
  test("absent means the default, and the default is full", () => {
    expect(parseProfile(undefined)).toBe("full");
    expect(parseProfile(null)).toBe("full");
    expect(DEFAULT_PROFILE).toBe("full");
  });

  for (const p of SCAFFOLD_PROFILES) {
    test(`${p} parses`, () => expect(parseProfile(p)).toBe(p));
  }

  test("an unrecognised value throws rather than defaulting", () => {
    // Silent Default Substitution: a typo that quietly scaffolded the full
    // harness would look exactly like the flag being honoured.
    expect(() => parseProfile("minimial")).toThrow(/Invalid --profile/);
    expect(() => parseProfile("")).toThrow(/Invalid --profile/);
  });

  test("the CLI refuses a bad --profile instead of scaffolding", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-bad-"));
    temps.push(dir);
    let code = 0;
    try {
      execSync(`bun run ${SCAFFOLD} ${dir} --fix --profile=nope`, { encoding: "utf-8", stdio: "pipe" });
    } catch (err: any) {
      code = err.status;
    }
    expect(code).not.toBe(0);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});

describe("#449 PROFILE-5: the predicates agree with the maps", () => {
  test("full includes everything", () => {
    for (const step of STEPS_NOT_MINIMAL.keys()) expect(isStepIncluded(step, "full")).toBe(true);
    for (const rule of RULES_NOT_MINIMAL.keys()) expect(isRuleIncluded(rule, "full")).toBe(true);
  });

  test("minimal excludes exactly what the maps name", () => {
    for (const step of STEPS_NOT_MINIMAL.keys()) expect(isStepIncluded(step, "minimal")).toBe(false);
    for (const rule of RULES_NOT_MINIMAL.keys()) expect(isRuleIncluded(rule, "minimal")).toBe(false);
    // A step not in the map runs under both.
    expect(isStepIncluded("createGitHooks", "minimal")).toBe(true);
    expect(isRuleIncluded("key-files.md", "minimal")).toBe(true);
  });
});
