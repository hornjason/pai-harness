/**
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-7 (#622).
 * Covers SC-2065..SC-2070 (HARNESS-STANDARD.md).
 *
 * Nothing in this repository pinned the Bun version. `createCiWorkflows`
 * emitted `harness?.ci?.bunVersion || "latest"` into both generated
 * workflows, this project's config declared no `ci` block at all, and so
 * every CI job resolved whatever bun shipped that morning — while
 * `release.yml`, the one file somebody pinned by hand, said `1.3.14`. Two
 * spellings, a full minor apart, and nothing compared them.
 *
 * | File | What it named |
 * |---|---|
 * | `.github/workflows/ci.yml` | `latest` |
 * | `.github/workflows/gates.yml` | `latest` |
 * | `.github/workflows/issue-audit.yml` | `latest` |
 * | `.github/workflows/release.yml` | `1.3.14` |
 * | `.claude/rungate/config.json` | nothing |
 *
 * This is `test/test-command-agreement.test.ts` (#621) pointed at the step
 * directly above the one it collapsed, and it inherits that file's two
 * structural decisions for the same reasons.
 *
 * ## Why the extractors throw instead of returning nothing
 *
 * A check that reads N files and compares what it found is satisfied by
 * finding nothing in all N — zero strings are trivially all equal. Every
 * file here is generated or hand-maintained YAML, so a step rename or an
 * indentation change is all it takes for the regex to stop matching, and
 * the check would go quiet rather than red
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape). So an
 * extractor REFUSES when a `setup-bun` step names no version, when the
 * config declares none, and when no workflow in the tree sets bun up at
 * all, and `bunVersionAgreement` lets the refusal out rather than folding
 * it into an empty violation list.
 *
 * ## Why `latest` is a violation and not just a value
 *
 * `latest` agrees with itself. A tree where all five positions say `latest`
 * has perfect agreement and no pin, which is the state this issue is about,
 * so the agreement check alone cannot see it. The moving-target rule is the
 * second violation kind and it is asserted on a planted tree, not assumed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  BUN_VERSION_FIELD,
  bunVersionDecision,
  bunVersionReading,
  UNDECLARED_WORKFLOW_VERSION,
} from "../lib/bun-version";
import { createCiWorkflows } from "../lib/scaffold/steps";

export const REPO_ROOT = join(import.meta.dir, "..");

/** The declaration, and the directory every consumer of it lives in. */
export const CONFIG_JSON = join(".claude", "rungate", "config.json");
export const WORKFLOW_DIR = join(".github", "workflows");

/** One Bun version, and the position in the tree that names it. */
export interface NamedBunVersion {
  /** Repo-relative path. */
  file: string;
  /** Where inside the file — the field, the step. */
  where: string;
  version: string;
}

/** Thrown when a file this check reads names no Bun version at all. */
export class NoBunVersionError extends Error {}

function refuse(file: string, why: string): never {
  throw new NoBunVersionError(
    `${file} names no Bun version: ${why}. ` +
      `Files naming nothing are not files that agree — ` +
      `see .claude/rules/checks-must-be-able-to-fail.md.`,
  );
}

/**
 * A version that is not a pin. `latest` is the one that shipped; `canary`
 * is the other value `setup-bun` documents, and a rule that enumerated only
 * the value we were bitten by is the next bite.
 */
export const MOVING_TARGETS = ["latest", "canary"] as const;

/** The declaration itself: `ci.bunVersion` in the rungate config. */
export function bunVersionsNamedByConfig(text: string): NamedBunVersion[] {
  // Deliberately not caught: a corrupt config is never a missing config
  // (.claude/rules/config-access.md).
  const config = JSON.parse(text) as { ci?: { bunVersion?: unknown } };
  const declared = config?.ci?.bunVersion;
  if (typeof declared !== "string" || declared.trim() === "") {
    refuse(CONFIG_JSON, `\`${BUN_VERSION_FIELD}\` is not set`);
  }
  return [{ file: CONFIG_JSON, where: BUN_VERSION_FIELD, version: (declared as string).trim() }];
}

/**
 * Every version a workflow file names, one entry per `setup-bun` step.
 *
 * The step's own block is sliced out before the version is looked for: a
 * whole-file search would let one step's pin answer for another's, which is
 * exactly the drift being measured (`release.yml` pinned while the job
 * beside it did not).
 */
export function bunVersionsNamedByWorkflow(file: string, text: string): NamedBunVersion[] {
  const lines = text.split("\n");
  const found: NamedBunVersion[] = [];

  lines.forEach((line, i) => {
    if (!/uses:\s*oven-sh\/setup-bun@/.test(line)) return;
    const indent = line.search(/\S/);

    let version: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      // The step ends at the first line that is not nested inside it.
      if (l.search(/\S/) <= indent) break;
      if (/^\s*#/.test(l)) continue;
      const m = /^\s*bun-version:\s*["']?([^"'\s#]+)["']?/.exec(l);
      if (m) {
        version = m[1];
        break;
      }
    }

    if (version === null) {
      refuse(file, `its setup-bun step at line ${i + 1} names no \`bun-version\``);
    }
    found.push({ file, where: `the setup-bun step at line ${i + 1}`, version });
  });

  return found;
}

export interface BunVersionAgreement {
  versions: NamedBunVersion[];
  /** Every workflow file read, repo-relative — the scan's own coverage (#492). */
  scanned: string[];
  /** Empty when every position names the same pinned string. */
  violations: string[];
}

/**
 * The single binding: read the declaration and every workflow, and report
 * both a disagreement and a moving target as violations.
 *
 * A missing config, a missing workflow directory, a `setup-bun` step with no
 * version, and a tree where nothing sets bun up all THROW. None of them is a
 * clean reading, and every one would otherwise arrive here as "no
 * disagreement".
 */
export function bunVersionAgreement(root: string): BunVersionAgreement {
  const configPath = join(root, CONFIG_JSON);
  if (!existsSync(configPath)) {
    throw new NoBunVersionError(`${CONFIG_JSON} does not exist under ${root}, so it declares no Bun version`);
  }
  const versions = bunVersionsNamedByConfig(readFileSync(configPath, "utf-8"));

  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) {
    throw new NoBunVersionError(`${WORKFLOW_DIR} does not exist under ${root}, so no workflow names a Bun version`);
  }
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
  const scanned: string[] = [];
  let naming = 0;
  for (const f of files) {
    const rel = join(WORKFLOW_DIR, f);
    scanned.push(rel);
    const named = bunVersionsNamedByWorkflow(rel, readFileSync(join(dir, f), "utf-8"));
    if (named.length > 0) naming++;
    versions.push(...named);
  }
  if (naming === 0) {
    throw new NoBunVersionError(
      `none of the ${files.length} file(s) under ${WORKFLOW_DIR} has a setup-bun step, ` +
        `so this check read ${scanned.length} files and compared nothing`,
    );
  }

  const violations: string[] = [];
  for (const v of versions) {
    if ((MOVING_TARGETS as readonly string[]).includes(v.version)) {
      violations.push(
        `${v.file} (${v.where}) says \`${v.version}\`, which is a moving target and not a pinned version`,
      );
    }
  }
  const distinct = [...new Set(versions.map(v => v.version))];
  if (distinct.length > 1) {
    violations.push(
      `the Bun version is spelled ${distinct.length} different ways: ` +
        versions.map(v => `${v.file} (${v.where}) says \`${v.version}\``).join("; "),
    );
  }

  return { versions, scanned, violations };
}

// ── fixtures ────────────────────────────────────────────────────────────────

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bun-version-622-${tag}-`));
  scratch.push(dir);
  return dir;
}

/** A copy of the config and every workflow, optionally with one rewritten. */
function plantedTree(edit?: (file: string, text: string) => string): string {
  const root = scratchDir("tree");
  const files = [CONFIG_JSON, ...readdirSync(join(REPO_ROOT, WORKFLOW_DIR)).map(f => join(WORKFLOW_DIR, f))];
  for (const file of files) {
    const dest = join(root, file);
    mkdirSync(dirname(dest), { recursive: true });
    if (edit) writeFileSync(dest, edit(file, readFileSync(join(REPO_ROOT, file), "utf-8")));
    else copyFileSync(join(REPO_ROOT, file), dest);
  }
  return root;
}

/**
 * A version no registry can resolve, and nothing else in the tree names.
 * AC-7's whole point is that this exact string survives to the workflow.
 */
const UNRESOLVABLE = "9.9.9-not-a-real-bun";

/** A project whose only content is a config declaring `version`. */
function projectDeclaring(version: string | null): string {
  const root = scratchDir("project");
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  const config: Record<string, unknown> = { project: "bun-version-fixture" };
  if (version !== null) config.ci = { bunVersion: version };
  writeFileSync(join(root, ".claude", "rungate", "config.json"), JSON.stringify(config, null, 2) + "\n");
  return root;
}

function generatedWorkflows(root: string): { ci: string; gates: string } {
  createCiWorkflows(root, []);
  return {
    ci: readFileSync(join(root, WORKFLOW_DIR, "ci.yml"), "utf-8"),
    gates: readFileSync(join(root, WORKFLOW_DIR, "gates.yml"), "utf-8"),
  };
}

// ── the cases ───────────────────────────────────────────────────────────────

describe("#622: the Bun version is one string", () => {
  test("AC-1/AC-3: the config and every workflow name one pinned Bun version", () => {
    const { versions, scanned, violations } = bunVersionAgreement(REPO_ROOT);

    // Coverage first: a verdict over an unread file is not a verdict (#492).
    expect(scanned.length, "no workflow files were read").toBeGreaterThan(0);
    for (const file of scanned) {
      const text = readFileSync(join(REPO_ROOT, file), "utf-8");
      if (!/uses:\s*oven-sh\/setup-bun@/.test(text)) continue;
      expect(versions.filter(v => v.file === file).length, `nothing was extracted from ${file}`)
        .toBeGreaterThan(0);
    }
    expect(violations).toEqual([]);

    // …and the one string is the one the MODULE resolves, which is what
    // makes this a check on the declaration rather than on four files that
    // happen to have been edited together.
    const declared = versions.find(v => v.file === CONFIG_JSON);
    expect(declared, `${CONFIG_JSON} contributed nothing`).toBeDefined();
    const decision = bunVersionDecision(REPO_ROOT);
    expect(decision.source).toBe("config");
    expect(decision.version).toBe(declared!.version);
  });

  test("AC-2: no workflow names a moving Bun version, and a planted one is caught", () => {
    const dir = join(REPO_ROOT, WORKFLOW_DIR);
    const files = readdirSync(dir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length, "there are no workflow files to grep").toBeGreaterThan(0);

    const moving: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf-8");
      for (const target of MOVING_TARGETS) {
        if (new RegExp(`bun-version:\\s*["']?${target}\\b`).test(text)) moving.push(`${f} -> ${target}`);
      }
    }
    expect(moving).toEqual([]);

    // Proof the rule can fire: `latest` agrees with `latest`, so without
    // this violation kind a tree that pinned nothing would read as perfect
    // agreement — which is the tree this issue was filed about.
    const allLatest = plantedTree((_file, text) => text.replace(/bun-version:\s*"[^"]*"/g, 'bun-version: "latest"'))
    const latestConfig = join(allLatest, CONFIG_JSON);
    const config = JSON.parse(readFileSync(latestConfig, "utf-8"));
    config.ci = { ...(config.ci ?? {}), bunVersion: "latest" };
    writeFileSync(latestConfig, JSON.stringify(config, null, 2) + "\n");

    const result = bunVersionAgreement(allLatest);
    expect(result.violations.length, "every position says `latest` and nothing complained")
      .toBeGreaterThan(0);
    expect(result.violations.join("\n")).toContain("moving target");
    // …and it is NOT reported as a disagreement, because they do agree.
    expect(result.violations.some(v => v.includes("different ways"))).toBe(false);
  });

  test("AC-3: a position that names nothing refuses instead of agreeing", () => {
    expect(() => bunVersionsNamedByConfig(JSON.stringify({ project: "demo" }))).toThrow(NoBunVersionError);
    expect(() => bunVersionsNamedByConfig(JSON.stringify({ ci: { bunVersion: "  " } }))).toThrow(NoBunVersionError);
    // A corrupt config is never a missing config.
    expect(() => bunVersionsNamedByConfig("{ not json")).toThrow(SyntaxError);

    const noVersion = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: oven-sh/setup-bun@v2",
      "      - run: bun test",
      "",
    ].join("\n");
    expect(() => bunVersionsNamedByWorkflow("x.yml", noVersion)).toThrow(NoBunVersionError);

    // The slice is load-bearing: a pin in the NEXT step does not answer for
    // this one. Without it, one pinned file would certify an unpinned job.
    const pinnedNeighbour = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: oven-sh/setup-bun@v2",
      "      - uses: oven-sh/setup-bun@v2",
      "        with:",
      '          bun-version: "1.3.14"',
      "",
    ].join("\n");
    expect(() => bunVersionsNamedByWorkflow("x.yml", pinnedNeighbour)).toThrow(NoBunVersionError);

    // A tree whose workflows never set bun up reads zero versions, which is
    // not agreement.
    const bunless = projectDeclaring("1.3.14");
    mkdirSync(join(bunless, WORKFLOW_DIR), { recursive: true });
    writeFileSync(join(bunless, WORKFLOW_DIR, "other.yml"), "jobs:\n  lint:\n    steps:\n      - run: echo hi\n");
    expect(() => bunVersionAgreement(bunless)).toThrow(/compared nothing/);

    // An empty tree throws the refusal and not an ENOENT no caller can tell
    // from one.
    expect(() => bunVersionAgreement(scratchDir("empty"))).toThrow(NoBunVersionError);
  });

  test("AC-4: the reading tells match, mismatch and undeclared apart", () => {
    const where = "`ci.bunVersion` in .claude/rungate/config.json";

    // Fabricated on both sides — the machine's real version is not an input,
    // so this case means the same thing on every machine and in CI.
    const match = bunVersionReading({ running: "1.3.14", declared: "1.3.14", where });
    expect(match.agreement).toBe("match");
    expect(match.line).toContain("1.3.14");

    const mismatch = bunVersionReading({ running: "1.2.0", declared: "1.3.14", where });
    expect(mismatch.agreement).toBe("mismatch");
    expect(mismatch.line).toContain("MISMATCH");
    expect(mismatch.line).toContain("1.2.0");
    expect(mismatch.line).toContain("1.3.14");

    // UNMEASURED is not a match. An absent declaration is the state the
    // whole issue is about, and reporting it as agreement would make the
    // warning satisfiable by deleting the declaration.
    const undeclared = bunVersionReading({ running: "1.3.14", declared: null, where });
    expect(undeclared.agreement).toBe("undeclared");
    expect(undeclared.agreement).not.toBe("match");
    expect(undeclared.line).toContain("UNDECLARED");
    expect(undeclared.line).toContain("1.3.14");

    // Every reading names the running version in the SAME position, because
    // AC-5 counts exactly one line naming it and a second spelling of the
    // running version in the mismatch line would make that count two.
    for (const reading of [match, mismatch, undeclared]) {
      expect(reading.line.startsWith(`bun ${reading.running}`), reading.line).toBe(true);
      expect(reading.line.split(`bun ${reading.running}`).length - 1, reading.line).toBe(1);
    }
  });

  test(
    "AC-5: the clean-env script prints exactly one line naming the bun it ran under",
    () => {
      const r = spawnSync(
        "bun",
        ["scripts/test-clean-env.ts", "--no-ci-checkout", join("test", "unit", "secret-patterns.test.ts")],
        { cwd: REPO_ROOT, encoding: "utf-8", timeout: 240000 },
      );
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(output, "the script produced nothing").not.toBe("");

      const naming = output
        .split("\n")
        .filter(l => new RegExp(`clean-env.*bun( version)? ${Bun.version.replace(/\./g, "\\.")}`).test(l));
      expect(naming.length, `expected one provenance line, got:\n${output}`).toBe(1);
    },
    300000,
  );

  test("AC-7: an unresolvable declared version reaches both workflows verbatim", () => {
    const { ci, gates } = generatedWorkflows(projectDeclaring(UNRESOLVABLE));

    for (const [name, yml] of [["ci.yml", ci], ["gates.yml", gates]] as const) {
      expect(yml, name).toContain(`bun-version: "${UNRESOLVABLE}"`);
      // No silent fallback. `runs-on: "ubuntu-latest"` legitimately contains
      // the word, so the assertion is about the bun-version position.
      expect(/bun-version:\s*["']?latest/.test(yml), `${name} fell back to latest`).toBe(false);
      expect(() => Bun.YAML.parse(yml), `${name} does not parse`).not.toThrow();
    }
  });

  test("AC-7: a project declaring nothing is recorded as UNDECLARED, not silently defaulted", () => {
    const root = projectDeclaring(null);
    const decision = bunVersionDecision(root);
    expect(decision.source).toBe("undeclared");
    expect(decision.version).toBeNull();

    // Consumers who declare nothing keep today's behaviour — but the
    // substitution is written into the file that carries it, because `0`,
    // `{}` and a silent default are indistinguishable from a decision
    // (.claude/rules/config-access.md).
    const { ci, gates } = generatedWorkflows(root);
    for (const [name, yml] of [["ci.yml", ci], ["gates.yml", gates]] as const) {
      expect(yml, name).toContain(`bun-version: "${UNDECLARED_WORKFLOW_VERSION}"`);
      expect(yml, name).toContain("UNDECLARED");
      expect(() => Bun.YAML.parse(yml), `${name} does not parse`).not.toThrow();
    }
  });
});
