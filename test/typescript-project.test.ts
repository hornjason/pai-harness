/**
 * One decider for "is this a TypeScript project, and what type-checks it?" (#87).
 *
 * Covers SC-1479, SC-1480, SC-1481, SC-1482, SC-1483
 * (SCAFFOLD-DECOMPOSITION-SPEC.md).
 *
 * The contradiction #87 was filed over: `createTsconfig` skipped a project
 * with no hand-written TypeScript, `createCiWorkflows` and the AGENTS.md
 * generator both emitted nothing for a project with no tsconfig — and then
 * TSC-1 hard-asserted that the file those three had agreed not to produce
 * existed. A consumer could not satisfy all of them at once.
 *
 * TSC-1 is the half that has to be EXECUTED to mean anything, so it is: the
 * real `runTsconfigValidation` is spawned under `bun test` against planted
 * project trees, and the failure count is read with the harness's own parser.
 * A direct call cannot distinguish a conditional check from one that passes
 * because the assertion never ran.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  TS_SOURCE_DIRS,
  containsTypeScript,
  typeScriptSourceDirs,
  isTypeScriptProject,
  tsconfigVerdict,
  typecheckDecision,
} from "../lib/typescript-project";
import { extractTestFailureCount } from "../gates/gate-executor";

const ROOT = join(import.meta.dir, "..");
const CONFORMITY = join(ROOT, "lib", "conformity.ts");

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "rg-tsproj-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

let seq = 0;
/** A project tree described as `relative path -> contents`. */
function project(files: Record<string, string>): string {
  const root = join(scratch, `p${seq++}`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true }, include: ["lib/**/*.ts"] });

// ── SC-1479 ─────────────────────────────────────────────────────────────────

describe("SC-1479: one predicate answers whether a project needs a tsconfig", () => {
  test("TypeScript source and no tsconfig is applicable and absent", () => {
    const root = project({ "lib/a.ts": "export const a = 1;\n" });
    const v = tsconfigVerdict(root);
    expect(v.applicable).toBe(true);
    expect(v.present).toBe(false);
    expect(v.dirs).toEqual(["lib"]);
    expect(v.reason, "the failure has to name the directories that caused it").toContain("lib/");
  });

  test("no TypeScript source anywhere is NOT applicable", () => {
    const root = project({ "README.md": "# a python project\n", "main.py": "print(1)\n" });
    const v = tsconfigVerdict(root);
    expect(v.applicable).toBe(false);
    expect(v.present).toBe(false);
    expect(v.reason).toContain("NOT APPLICABLE");
  });

  test("a tsconfig in a project with no TypeScript is not an error either", () => {
    // The control for the case above. "Not applicable" must not become a new
    // assertion in the other direction — a consumer keeping a tsconfig for
    // editor support is not a finding.
    const root = project({ "tsconfig.json": TSCONFIG, "main.py": "print(1)\n" });
    const v = tsconfigVerdict(root);
    expect(v.applicable).toBe(false);
    expect(v.present).toBe(true);
  });

  test("both present is the satisfied case", () => {
    const root = project({ "tsconfig.json": TSCONFIG, "lib/a.ts": "export const a = 1;\n" });
    const v = tsconfigVerdict(root);
    expect(v.applicable).toBe(true);
    expect(v.present).toBe(true);
  });

  test("a .d.ts is not hand-written source, and neither is node_modules", () => {
    const root = project({
      "lib/types.d.ts": "declare const x: number;\n",
      "lib/node_modules/dep/index.ts": "export const dep = 1;\n",
    });
    expect(containsTypeScript(join(root, "lib"))).toBe(false);
    expect(isTypeScriptProject(root)).toBe(false);
  });

  test("test/ is deliberately not a source directory", () => {
    // Including it would hand a fresh consumer 4 errors from `bun:test` and
    // `rungate/lib/conformity`, which it did not cause and cannot fix.
    const root = project({ "test/a.test.ts": 'import { test } from "bun:test";\n' });
    expect(TS_SOURCE_DIRS).not.toContain("test");
    expect(typeScriptSourceDirs(root)).toEqual([]);
  });

  test("the dirs come back in TS_SOURCE_DIRS order, not readdir order", () => {
    const root = project({
      "workflows/w.ts": "export const w = 1;\n",
      "src/i.ts": "export const i = 1;\n",
      "lib/l.ts": "export const l = 1;\n",
    });
    expect(typeScriptSourceDirs(root)).toEqual(["src", "lib", "workflows"]);
  });
});

// ── SC-1480 ─────────────────────────────────────────────────────────────────

/**
 * Spawn the REAL `runTsconfigValidation` over a planted root.
 *
 * `bun test` is the only way to observe a `describe`/`test` pair — calling the
 * function from inside this file would register its tests in THIS suite, where
 * a failure is indistinguishable from a failure of the file. The findings are
 * printed from a test declared after it, which is the only position that can
 * see what TSC-1 recorded while it ran.
 */
function runTsc1(projectRoot: string): { failures: number; ran: number; findings: Array<Record<string, string>> } {
  const file = join(scratch, `tsc1-${seq++}.test.ts`);
  writeFileSync(
    file,
    `import { test } from "bun:test";\n` +
      `import { runTsconfigValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
      `clearFindings();\n` +
      `runTsconfigValidation(${JSON.stringify(projectRoot)});\n` +
      `test("zz-report-findings", () => {\n` +
      `  console.log("FINDINGS:" + JSON.stringify(getFindings().filter(f => f.ruleId === "TSC-1")));\n` +
      `});\n`,
  );
  const r = spawnSync("bun", ["test", file], { cwd: ROOT, encoding: "utf-8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const marker = out.match(/FINDINGS:(\[.*\])/);
  const pass = Number(out.match(/(\d+) pass/)?.[1] ?? 0);
  return {
    failures: extractTestFailureCount(out),
    // The reporter test is one of them, so a `ran` of 0 means the file never
    // loaded — which otherwise reads exactly like a clean pass.
    ran: pass + extractTestFailureCount(out),
    findings: marker ? JSON.parse(marker[1]) : [],
  };
}

describe("SC-1480: TSC-1 fails where a tsconfig is owed and records a reason where it is not", () => {
  test("TypeScript source and no tsconfig turns TSC-1 red", () => {
    const root = project({ "lib/a.ts": "export const a = 1;\n" });
    const r = runTsc1(root);
    expect(r.ran, "the spawned suite never loaded").toBeGreaterThan(0);
    expect(r.failures, "TSC-1 did not fail for a project that owes a tsconfig").toBe(1);
  });

  test("no TypeScript source leaves TSC-1 green", () => {
    const root = project({ "main.py": "print(1)\n" });
    const r = runTsc1(root);
    expect(r.ran).toBeGreaterThan(0);
    expect(r.failures, "TSC-1 still demanded a tsconfig from a non-TypeScript project").toBe(0);
  });

  test("the green case is RECORDED, not silent", () => {
    // The control that makes the case above worth having. A check that skips
    // and says nothing is indistinguishable from a check that was satisfied —
    // `.claude/rules/config-access.md` names it Silent Default Substitution.
    const root = project({ "main.py": "print(1)\n" });
    const r = runTsc1(root);
    expect(r.findings.length, "TSC-1 passed over a project without recording why").toBe(1);
    expect(r.findings[0]!.severity).toBe("WARN");
    expect(r.findings[0]!.message).toContain("UNMEASURED");
  });

  test("a satisfied TSC-1 records nothing — UNMEASURED is not a synonym for OK", () => {
    const root = project({ "tsconfig.json": TSCONFIG, "lib/a.ts": "export const a = 1;\n" });
    const r = runTsc1(root);
    expect(r.failures).toBe(0);
    expect(r.findings).toEqual([]);
  });

  test("TSC-1 reads the shared predicate rather than a second copy", () => {
    const src = readFileSync(CONFORMITY, "utf-8");
    expect(src).toContain("tsconfigVerdict");
    expect(src, "a local existsSync on tsconfig.json is the predicate reintroduced")
      .not.toMatch(/existsSync\(join\(root, "tsconfig\.json"\)\)\)\.toBe\(true\)/);
  });
});

// ── SC-1481 ─────────────────────────────────────────────────────────────────

describe("SC-1481: one decider produces the CI step, the doc row and dev.typeCheck", () => {
  test("no tsconfig means no command at all, and says so", () => {
    const d = typecheckDecision(project({ "main.py": "print(1)\n" }));
    expect(d.command).toBeNull();
    expect(d.source).toBe("none");
    expect(d.reason).toContain("help text");
  });

  test("the project's own typecheck script wins", () => {
    // This branch is what makes a ratchet reachable for a consumer at all:
    // `files:` ships neither scripts/typecheck.ts nor tsconfig.json, so the
    // on-disk branch below can never fire outside the harness itself.
    const root = project({
      "tsconfig.json": TSCONFIG,
      "package.json": JSON.stringify({ scripts: { typecheck: "bun scripts/typecheck.ts" } }),
      "scripts/typecheck.ts": "// a ratchet\n",
    });
    const d = typecheckDecision(root);
    expect(d.command).toBe("bun run typecheck");
    expect(d.source).toBe("package-script");
  });

  test("an empty typecheck script is not a declaration", () => {
    const root = project({
      "tsconfig.json": TSCONFIG,
      "package.json": JSON.stringify({ scripts: { typecheck: "   " } }),
    });
    expect(typecheckDecision(root).source).toBe("tsc");
  });

  test("scripts/typecheck.ts on disk is the next answer", () => {
    const root = project({
      "tsconfig.json": TSCONFIG,
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "scripts/typecheck.ts": "// a ratchet\n",
    });
    expect(typecheckDecision(root).command).toBe("bun scripts/typecheck.ts");
    expect(typecheckDecision(root).source).toBe("ratchet");
  });

  test("a tsconfig and nothing else is plain tsc", () => {
    const root = project({ "tsconfig.json": TSCONFIG });
    expect(typecheckDecision(root).command).toBe("bunx tsc --noEmit");
  });

  test("an unreadable package.json does not cost the type check", () => {
    const root = project({ "tsconfig.json": TSCONFIG, "package.json": "{ not json" });
    expect(typecheckDecision(root).command).toBe("bunx tsc --noEmit");
  });

  test("the CI generator emits exactly what the decider returned", async () => {
    const { createCiWorkflows } = await import("../lib/scaffold/steps");
    const root = project({
      "tsconfig.json": TSCONFIG,
      "package.json": JSON.stringify({ scripts: { typecheck: "bun scripts/typecheck.ts" } }),
    });
    createCiWorkflows(root, []);
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
    expect(ci).toContain(`- run: ${typecheckDecision(root).command}`);
    // The old ladder had no package-script branch, so this is the divergence.
    expect(ci, "the generator kept its own copy of the ladder").not.toContain("- run: bunx tsc --noEmit");
  });

  test("a non-TypeScript project gets a CI file that says why there is no step", () => {
    const { createCiWorkflows } = require("../lib/scaffold/steps");
    const root = project({ "main.py": "print(1)\n" });
    createCiWorkflows(root, []);
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
    expect(ci).not.toContain("tsc --noEmit");
    expect(ci, "an absent step must be visible in the generated file, not inferred from its absence")
      .toContain("# No type check:");
  });

  test("the AGENTS.md row advertises the command the decider returned", () => {
    const { generateAgentsMdContent } = require("../lib/scaffold/steps");
    const root = project({
      "tsconfig.json": TSCONFIG,
      "lib/a.ts": "export const a = 1;\n",
      "package.json": JSON.stringify({ name: "p", scripts: { typecheck: "bun scripts/typecheck.ts" } }),
    });
    const md = generateAgentsMdContent(root, "code", []);
    expect(md).toContain("| Type check | `bun run typecheck` |");
    expect(md, "the doc kept its own copy of the ladder").not.toContain("bunx tsc --noEmit");
  });

  test("and omits the row entirely when there is nothing to run", () => {
    const { generateAgentsMdContent } = require("../lib/scaffold/steps");
    const root = project({ "main.py": "print(1)\n", "package.json": JSON.stringify({ name: "p" }) });
    expect(generateAgentsMdContent(root, "code", [])).not.toContain("| Type check |");
  });

  test("dev.typeCheck is null rather than a command that can only fail", () => {
    // `gates/gate-executor.ts` RUNS whatever lands here. `bunx tsc --noEmit`
    // without a tsconfig prints 147 lines of help and exits 1, which the gate
    // reported as "Type check FAIL" at every non-TypeScript consumer.
    //
    // MEASURED: the first version of this asked `lib/scanner.ts`'s
    // `scanProject`, which has no `dev` block at all — so `?? null` was null
    // whatever the generator did, and restoring the old constant scored ZERO
    // against it. The field is written by `generateOrAuditProjectHarness`, so
    // that is what gets run, and the value is read back off disk.
    const { generateOrAuditProjectHarness } = require("../lib/scaffold/steps");
    const root = project({ "main.py": "print(1)\n", "package.json": JSON.stringify({ name: "p" }) });
    generateOrAuditProjectHarness(root, []);
    const config = JSON.parse(readFileSync(join(root, ".claude", "rungate", "config.json"), "utf-8"));
    expect(Object.hasOwn(config.dev, "typeCheck"), "the field vanished rather than going null").toBe(true);
    expect(config.dev.typeCheck).toBeNull();
  });

  test("a TypeScript consumer still gets a runnable dev.typeCheck", () => {
    // The control. "Always null" would satisfy the case above and switch the
    // verify gate's type check off for every consumer instead of fixing it.
    const { generateOrAuditProjectHarness } = require("../lib/scaffold/steps");
    const root = project({
      "tsconfig.json": TSCONFIG,
      "lib/a.ts": "export const a = 1;\n",
      "package.json": JSON.stringify({ name: "p" }),
    });
    generateOrAuditProjectHarness(root, []);
    const config = JSON.parse(readFileSync(join(root, ".claude", "rungate", "config.json"), "utf-8"));
    expect(config.dev.typeCheck).toBe("bunx tsc --noEmit");
  });
});

// ── SC-1482 ─────────────────────────────────────────────────────────────────

describe("SC-1482: the ratchet runs the pinned compiler", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  test("typescript is pinned exactly, not by range", () => {
    const pinned = pkg.devDependencies?.typescript;
    expect(pinned, "`bunx tsc` resolved TypeScript 7.0.2 — the Go port — with nothing pinned").toBeDefined();
    expect(pinned, "a range re-opens the hole one patch release at a time").toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the lockfile carries the same version", () => {
    expect(readFileSync(join(ROOT, "bun.lock"), "utf-8")).toContain(`typescript@${pkg.devDependencies.typescript}`);
  });

  test("the script spawns the installed binary, not whatever the registry resolves", () => {
    const src = readFileSync(join(ROOT, "scripts", "typecheck.ts"), "utf-8");
    expect(src).toContain("node_modules");
    expect(src, "a bunx fallback silently restores the unpinned behaviour").not.toMatch(/spawnSync\("bunx"/);
  });

  test("it refuses rather than falling back when the binary is absent", () => {
    // Executed, because "the file contains a refusal" is satisfied by a
    // refusal nothing reaches. The mutant copy runs from a directory with no
    // node_modules at all.
    const src = readFileSync(join(ROOT, "scripts", "typecheck.ts"), "utf-8");
    const copy = join(scratch, "typecheck-copy.ts");
    writeFileSync(copy, src);
    const r = spawnSync("bun", [copy], { cwd: scratch, encoding: "utf-8" });
    expect(r.status, "a missing compiler produced a result instead of a refusal").not.toBe(0);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("bun install");
  });

  test("package.json declares the typecheck script AGENTS.md documents", () => {
    expect(pkg.scripts?.typecheck).toBe("bun scripts/typecheck.ts");
  });
});

// ── SC-1483 ─────────────────────────────────────────────────────────────────

/**
 * The singleton is MECHANICAL, not a convention — SC-844's shape, applied to
 * the predicate #87 found five copies of the question for.
 */
const SOURCE_DIR_DECIDERS = [
  /function\s+containsTypeScript\s*\(/,
  /const\s+TS_SOURCE_DIRS\s*=/,
];

function scanLib(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const body = readFileSync(abs, "utf-8");
      if (SOURCE_DIR_DECIDERS.some(re => re.test(body))) hits.push(abs.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, "lib"));
  return hits.sort();
}

describe("SC-1483: exactly one module decides what a TypeScript source tree is", () => {
  test("lib/ holds one definition of the predicate and the directory list", () => {
    expect(scanLib()).toEqual(["lib/typescript-project.ts"]);
  });

  test("the scan can see a second copy when there is one", () => {
    // Without this, an empty result and a correct result are the same value.
    const planted = join(ROOT, "lib", "__sc1483-planted.ts");
    try {
      writeFileSync(planted, "const TS_SOURCE_DIRS = [\"src\"] as const;\n");
      expect(scanLib()).toEqual(["lib/__sc1483-planted.ts", "lib/typescript-project.ts"]);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  test("the four former callers import it rather than re-deriving it", () => {
    const reads = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
    expect(reads("lib/scaffold/steps.ts")).toContain('from "../typescript-project"');
    expect(reads("lib/generators/agents-md.ts")).toContain('from "../typescript-project"');
    expect(reads("lib/conformity.ts")).toContain('from "./typescript-project"');
  });
});
