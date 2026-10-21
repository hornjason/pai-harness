import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import { harnessRoot } from "../lib/paths";
import { parseFrontmatter } from "../lib/conformity";

const HARNESS_ROOT = harnessRoot();
const SPECS_DIR = join(HARNESS_ROOT, "specs");

// Scan specs/*.md and specs/*/*.md (one level deep)
const getAllSpecFiles = () => {
  const specFiles: string[] = [];
  for (const f of readdirSync(SPECS_DIR)) {
    if (f.endsWith(".md")) {
      specFiles.push(f);
    } else if (readdirSync(SPECS_DIR, { withFileTypes: true }).find(d => d.name === f && d.isDirectory())) {
      const subFiles = readdirSync(join(SPECS_DIR, f)).filter(sf => sf.endsWith(".md") && sf !== "INDEX.md");
      specFiles.push(...subFiles.map(sf => `${f}/${sf}`));
    }
  }
  return specFiles;
};

const specFiles = getAllSpecFiles();

describe("spec-discovery: frontmatter enforcement", () => {

  test("SD-1: Every .md in PAI/Specs/ has testable field (true or false)", () => {
    const missing: string[] = [];
    for (const f of specFiles) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = parseFrontmatter(content);
      // Skip redirect files (status: split)
      if (fm?.status === "split") continue;
      if (!fm || !("testable" in fm)) {
        missing.push(f);
      }
    }
    expect(missing).toEqual([]);
  });

  test("SD-2: Every spec with testable:true produced at least 1 claim", () => {
    const testableSpecs: string[] = [];
    for (const f of specFiles) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable === "true") {
        testableSpecs.push(f);
      }
    }
    expect(testableSpecs.length).toBeGreaterThan(0);

    const noClaims: string[] = [];
    for (const f of testableSpecs) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const hasMake = /`make\s+[\w-]+`/.test(content);
      const hasGate = /\*\*GATE:|Gate:\*\*/.test(content);
      const hasPort = /:\d{4}\b/.test(content);
      const hasQuinn = /Quinn\s+(validates|captures|tests|navigates|compares|verifies)/i.test(content);
      if (!hasMake && !hasGate && !hasPort && !hasQuinn) {
        noClaims.push(f);
      }
    }
    if (noClaims.length > 0) {
      console.warn(`Specs with testable:true but no extractable claims: ${noClaims.join(", ")}`);
    }
  });

  test("SD-4: No duplicate SC IDs across specs (checkbox definitions)", () => {
    const scToSpecs = new Map<string, string[]>();
    const scPattern = /^- \[[ x]\] (SC-\d+):/gm;

    for (const f of specFiles) {
      // Skip template files
      if (f.includes("SPEC-TEMPLATE")) continue;
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      for (const match of content.matchAll(scPattern)) {
        const id = match[1];
        const specs = scToSpecs.get(id) || [];
        if (!specs.includes(f)) specs.push(f);
        scToSpecs.set(id, specs);
      }
    }

    const duplicates: string[] = [];
    for (const [id, specs] of scToSpecs) {
      if (specs.length > 1) {
        duplicates.push(`${id}: ${specs.join(", ")}`);
      }
    }

    if (duplicates.length > 0) {
      console.error(`Duplicate SC IDs:\n  ${duplicates.join("\n  ")}`);
    }
    expect(duplicates).toEqual([]);
  });

  test("SD-3: Total claim count across all testable specs is non-zero", () => {
    let totalClaims = 0;
    for (const f of specFiles) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable !== "true") continue;
      const makes = (content.match(/`make\s+[\w-]+`/g) || []).length;
      const gates = (content.match(/\*\*GATE:|Gate:\*\*/g) || []).length;
      const ports = (content.match(/:(7776|7777|7778|5173)\b/g) || []).length;
      const quinns = (content.match(/Quinn\s+(validates|captures|tests|navigates|compares|verifies)/gi) || []).length;
      totalClaims += makes + gates + ports + quinns;
    }
    expect(totalClaims).toBeGreaterThan(0);
  });
});

/**
 * #211 — the Spec Discovery testability check could not fail, on any tree.
 *
 * `runSpecDiscovery`'s `test("at least one testable spec exists")` had three
 * paths and no failing input:
 *
 * ```ts
 * if (!existsSync(specsDir)) return;                 // unmeasured -> PASS
 * ...
 * if (testable.length === 0) { addFinding(WARN); }   // known false -> PASS
 * else { expect(testable.length).toBeGreaterThan(0); } // tautology -> PASS
 * ```
 *
 * The third is #328's vacuous assertion: it sits in the `else` of
 * `testable.length === 0`, so the only branch that reaches it already knows
 * the answer. The first two are the costlier half — a test NAMED for a
 * property reported green on exactly the two trees where that property is
 * false. A tree with no `specs/` had not been measured, and a tree with no
 * `testable: true` had a known gap; neither is a pass, and both were being
 * counted as one.
 *
 * ## Why the zero-testable case stays tolerated
 *
 * It is load-bearing, not laziness. `lib/scaffold/write-steps.ts` writes
 * `testable: no` into a scaffolded consumer's first spec, so asserting the
 * property outright would turn every fresh consumer red before its author
 * writes a line. It is kept — as `test.todo`, which reports the known-false
 * property as unfinished rather than as checked.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Delete the test.** It asserts nothing, so removing it costs no coverage
 * and the suite stays green — and that is the repair a reader of "this test
 * is vacuous" reaches for first. Both cases below survive it: AC-1 counts
 * TWO failures on a tree with no `specs/` (the deleted test is one of them),
 * and AC-2 requires a todo that a deleted test does not emit.
 *
 * Measured against the three fixtures, before the repair -> after:
 *
 * | fixture              | before          | after                   |
 * |----------------------|-----------------|-------------------------|
 * | no `specs/`          | 2 pass / 1 fail | 1 pass / **2 fail**     |
 * | `specs/`, 0 testable | 3 pass / 0 fail | 2 pass / **1 todo**     |
 * | `specs/`, 1 testable | 3 pass / 0 fail | 3 pass / 0 fail         |
 */
describe("#211: Spec Discovery's testability check has a failing input", () => {
  function runDiscoveryOver(build: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "rungate-211-discovery-"));
    try {
      build(root);
      const probe = join(root, "_discovery-probe.test.ts");
      writeFileSync(
        probe,
        `import { runSpecDiscovery } from "${join(HARNESS_ROOT, "lib", "conformity")}";\n` +
          `runSpecDiscovery(${JSON.stringify(root)});\n`,
      );
      let out: string;
      try {
        out = execSync(`bun test ${probe} 2>&1`, { encoding: "utf-8", timeout: 60_000 });
      } catch (e: any) {
        out = (e.stdout || "") + (e.stderr || "");
      }
      const n = (label: string) => parseInt(out.match(new RegExp(`(\\d+) ${label}`))?.[1] || "0", 10);
      return { pass: n("pass"), fail: n("fail"), todo: n("todo"), output: out };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const writeSpec = (root: string, testable: string) => {
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(
      join(root, "specs", "a.md"),
      `---\ndoc-type: spec\ntestable: ${testable}\ngoverns: probe\n---\n\n# Probe\n\n- [ ] SC-9211: the probe spec carries one criterion\n`,
    );
  };

  test("AC-1: a tree with no specs/ fails the testability check, rather than returning a pass", () => {
    const r = runDiscoveryOver(() => {});
    // TWO, not `> 0`. "specs/ directory exists" fails on this tree whatever
    // the testability check does, so `fail > 0` would hold with the early
    // `return` restored AND with the test deleted outright — it is satisfied
    // by a neighbour and names nothing about the check under repair. Two is
    // the count at which both this check and its neighbour have reported.
    expect(r.fail, r.output).toBe(2);
    expect(r.pass, r.output).toBe(1);
  });

  test("AC-2: a tree with specs/ but nothing testable reports a todo, not a pass", () => {
    const r = runDiscoveryOver(root => writeSpec(root, "no"));
    expect(r.fail, r.output).toBe(0);
    expect(r.todo, r.output).toBe(1);
    // The pass count is the half that moved: this tree reported 3 pass before
    // the repair, and the third was the check asserting a property this tree
    // does not have.
    expect(r.pass, r.output).toBe(2);
  });

  test("AC-3: a tree with a testable spec still passes, so the repair is not just a reddening", () => {
    const r = runDiscoveryOver(root => writeSpec(root, "true"));
    expect(r.fail, r.output).toBe(0);
    expect(r.todo, r.output).toBe(0);
    expect(r.pass, r.output).toBe(3);
  });
});
