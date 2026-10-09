/**
 * SC binding: checked criteria bind to real assertions, unchecked ones do not.
 *
 * Issue #209. Before this, `extractSCs` matched only `- [ ]`, so the 467
 * criteria already marked done produced no tests at all, and the ones it did
 * produce ran inside `try { assertion(root) } catch {}` — a body that cannot
 * go red. Both halves are the shape `.claude/rules/checks-must-be-able-to-fail.md`
 * is about: a check that passed because of what it never looked at.
 *
 * What was broken to prove each test here can fail is recorded next to it.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { extractSCs, collectExemptions, type ParsedSC } from "../lib/conformity";

const REPO_ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(REPO_ROOT, "specs");

/** Every SC line under specs/, at any depth. */
function allSpecSCs(): ParsedSC[] {
  const out: ParsedSC[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${entry}/`); continue; }
      if (!entry.endsWith(".md")) continue;
      out.push(...extractSCs(readFileSync(full, "utf-8"), `${prefix}${entry}`));
    }
  };
  walk(SPECS_DIR, "");
  return out;
}

// ── AC-1: extractSCs collects both checkbox states ──────────────────────────

describe("extractSCs collects checked and unchecked criteria alike", () => {
  test("records the checkbox state on each ParsedSC", () => {
    const scs = extractSCs(
      ["- [x] SC-1: AGENTS.md exists", "- [ ] SC-2: nothing.md exists", "- [X] SC-3: README.md exists"].join("\n"),
      "fixture.md",
    );
    expect(scs.map(s => s.id)).toEqual(["SC-1", "SC-2", "SC-3"]);
    expect(scs.map(s => s.checked)).toEqual([true, false, true]);
    expect(scs[0].statement).toBe("AGENTS.md exists");
  });

  /**
   * The floor is the whole point of this test: a narrowed pattern — the `- [ ]`
   * only regex this replaced — collects 107 here, so it fails loudly instead of
   * reporting a smaller, quieter suite. Broken to prove it: restoring
   * `/^- \[ \] (SC-\w+)/` drops the count to 107 and turns this red.
   */
  test("collects at least 300 SCs from specs/", () => {
    const scs = allSpecSCs();
    expect(scs.length).toBeGreaterThanOrEqual(300);
  });

  test("both checkbox states are represented in the real corpus", () => {
    const scs = allSpecSCs();
    expect(scs.filter(s => s.checked).length).toBeGreaterThanOrEqual(300);
    expect(scs.filter(s => !s.checked).length).toBeGreaterThan(0);
  });
});

// ── AC-2: checked criteria bind outside try/catch; unchecked emit todo ──────

/**
 * Runs the real generator against a throwaway project whose specs contain one
 * checked criterion that CANNOT pass and one unchecked criterion that also
 * cannot pass. The assertion is on bun's own tally, not on source text:
 *
 *   - the checked one must be counted as a failure (no swallowing `catch`)
 *   - the unchecked one must be counted as todo (no assertion run at all)
 *
 * Broken to prove it: wrapping `assertion(root)` back in `try { } catch {}`
 * makes `fail` 0 and turns the first expectation red; emitting a real `test`
 * for unchecked SCs makes `todo` 0 and turns the second red.
 */
function runGeneratorOn(
  specBody: string,
  allowlist?: object,
): { stdout: string; todo: number; scFailures: string[] } {
  const dir = join(import.meta.dir, "fixtures", `sc-binding-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "specs"), { recursive: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, "specs", "FIXTURE-SPEC.md"), specBody);
  if (allowlist) writeFileSync(join(dir, ".claude", "conformity-allowlists.json"), JSON.stringify(allowlist));
  const runner = join(dir, "generated.test.ts");
  writeFileSync(
    runner,
    `import { runScaffoldConformity } from ${JSON.stringify(join(REPO_ROOT, "lib", "conformity.ts"))};\n` +
      `runScaffoldConformity(${JSON.stringify(dir)});\n`,
  );
  try {
    const r = spawnSync("bun", ["test", runner], { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120000 });
    const stdout = `${r.stdout || ""}${r.stderr || ""}`;
    const todoMatch = stdout.match(/(\d+)\s+todo/);
    // The throwaway project trips unrelated scaffold checks (no AGENTS.md, no
    // package.json). Only failures attributable to the criteria under test are
    // counted, by name — a bare total would make these assertions pass or fail
    // on checks that have nothing to do with SC binding.
    const scFailures = [...stdout.matchAll(/^\(fail\)\s+(.*)$/gm)]
      .map(m => m[1])
      .filter(name => /SC-BIND|no pattern matcher|EXEMPT-RATCHET/.test(name));
    return { stdout, todo: todoMatch ? parseInt(todoMatch[1], 10) : 0, scFailures };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURE_FRONTMATTER = [
  "---",
  "doc-type: spec",
  "status: active",
  "testable: true",
  "compliance: strict",
  "governs: fixture",
  "---",
  "",
  "# Fixture",
  "",
  "## Success Criteria",
  "",
].join("\n");

describe("generated tests bind checked criteria and defer unchecked ones", () => {
  test("a checked criterion that cannot pass produces a failing test", () => {
    const r = runGeneratorOn(
      FIXTURE_FRONTMATTER + "- [x] SC-BIND1: definitely-not-here.md exists\n",
    );
    expect(r.scFailures.join(" ")).toContain("SC-BIND1");
  });

  test("an unchecked criterion that cannot pass produces a todo, not a failure", () => {
    const r = runGeneratorOn(
      FIXTURE_FRONTMATTER +
        "- [x] SC-BIND2: specs/FIXTURE-SPEC.md exists\n" +
        "- [ ] SC-BIND3: definitely-not-here.md exists\n",
    );
    expect(r.todo).toBeGreaterThanOrEqual(1);
    expect(r.scFailures).toEqual([]);
  });

  test("lib/conformity.ts runs the generated assertion outside any try/catch", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "conformity.ts"), "utf-8").split("\n");
    const idx = src.findIndex(l => l.includes("assertion(root);"));
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, idx - 4), idx + 7).join("\n");
    expect(window).not.toContain("catch");
    expect(window).not.toContain("try {");
  });
});

// ── AC-6: unmatched criteria need an exemption carrying a written reason ────

describe("strict-mode exemptions must carry a written reason", () => {
  test("an entry with no reason does not exempt", () => {
    const r = runGeneratorOn(
      FIXTURE_FRONTMATTER + "- [x] SC-BIND4: this statement matches no matcher whatsoever\n",
      { unmatchedSCs: [{ id: "SC-BIND4", spec: "FIXTURE-SPEC.md", reason: "" }] },
    );
    expect(r.scFailures.join(" ")).toContain("no pattern matcher");
  });

  test("an entry with a written reason exempts", () => {
    const r = runGeneratorOn(
      FIXTURE_FRONTMATTER + "- [x] SC-BIND5: this statement matches no matcher whatsoever\n",
      {
        unmatchedSCs: [
          { id: "SC-BIND5", spec: "FIXTURE-SPEC.md", reason: "prose criterion, no mechanical binding exists yet" },
        ],
      },
    );
    expect(r.scFailures).toEqual([]);
  });

  test("an exemption for a criterion that now matches is reported as stale", () => {
    const r = runGeneratorOn(
      FIXTURE_FRONTMATTER + "- [x] SC-BIND6: specs/FIXTURE-SPEC.md exists\n",
      {
        unmatchedSCs: [
          { id: "SC-BIND6", spec: "FIXTURE-SPEC.md", reason: "stale entry that should have been removed" },
        ],
      },
    );
    expect(r.scFailures.join(" ")).toContain("EXEMPT-RATCHET");
  });

  test("every exemption in this repo carries a reason of real length", () => {
    const exemptions = collectExemptions(REPO_ROOT);
    expect(exemptions.length).toBeGreaterThan(0);
    for (const e of exemptions) {
      expect(typeof e.reason).toBe("string");
      expect(e.reason.trim().length).toBeGreaterThanOrEqual(10);
      expect(e.spec.length).toBeGreaterThan(0);
      expect(existsSync(join(SPECS_DIR, e.spec))).toBe(true);
    }
  });
});
