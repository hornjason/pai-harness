/**
 * Covers SC-2440..SC-2446 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md).
 *
 * `scripts/check-instruction-surface.ts` — the auto-loaded instruction surface,
 * measured and refused when it exceeds its declared budget (#1009).
 *
 * The defect this guards is not "a file got long". It is that the growth is
 * invisible from inside: every agent pays 44,000 tokens before it reads its
 * issue, nothing in the repository states the number, and the only reason it
 * was ever measured is that somebody read a system prompt by hand. #1009 moved
 * 120,256 bytes of measurement records into `reference/`; without an enforced
 * number they come back, because each individual addition is defensible.
 *
 * Every negative case runs TWICE: once against the real script, and once
 * against a mutant copy whose single exit-code constant is set to 0. The
 * second run is the evidence — "exit code != 0" cannot tell a refusal from a
 * crash, a typo or a module-resolution failure, and
 * `.claude/rules/checks-must-be-able-to-fail.md` counts five shipped bugs of
 * exactly that shape in one day.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  SURFACE_BUDGET_BYTES,
  SurfaceUnmeasured,
  isPathScoped,
  measureSurface,
  ruleBody,
} from "../scripts/check-instruction-surface";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-instruction-surface.ts");
const source = readFileSync(SCRIPT, "utf-8");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── The mutant ───────────────────────────────────────────────────────────
//
// Built once, in a temp directory OUTSIDE the repo. Running it from there is
// what proves the script has no relative imports: a later `from "../lib/..."`
// would make every mutant die on module resolution, exiting non-zero, which
// would read as "the mutation was rejected on the merits" when in fact the
// mutant never ran.
let MUTANT = "";
let MUTANT_DIR = "";

beforeAll(() => {
  MUTANT_DIR = mkdtempSync(join(tmpdir(), "surface-mutant-"));
  scratch.push(MUTANT_DIR);
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error(
      "could not build the mutant: no `REFUSE_EXIT = 1` in scripts/check-instruction-surface.ts",
    );
  }
  MUTANT = join(MUTANT_DIR, "check-instruction-surface.ts");
  writeFileSync(MUTANT, mutated);
});

function run(script: string, args: string[]) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8", timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Assert the real script refuses AND that the mutant does not. */
function refusesAndMutantDoesNot(args: string[]) {
  const real = run(SCRIPT, args);
  expect(real.code, `the real script accepted [${args.join(" ")}]\n${real.out}${real.err}`).toBe(1);
  const mutant = run(MUTANT, args);
  expect(
    mutant.code,
    `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for [${args.join(" ")}] — ` +
      `this case is not being caught by the refusal under test.\n${mutant.err}`,
  ).toBe(0);
  return real;
}

/** A tree shaped like a scaffolded repo, with the rule bodies given. */
function plantedRoot(rules: Record<string, string>, opts: { claude?: string | null } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "surface-root-"));
  scratch.push(root);
  if (opts.claude !== null) writeFileSync(join(root, "CLAUDE.md"), opts.claude ?? "# rules\n");
  writeFileSync(join(root, "AGENTS.md"), "# project\n");
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  for (const [name, body] of Object.entries(rules)) {
    const p = join(root, ".claude", "rules", name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

const filler = (n: number) => "x".repeat(n) + "\n";

// ── The properties the mutant protects ───────────────────────────────────

describe("SC-2440: the refusal has one site, and the mutant can reach it", () => {
  test("REFUSE_EXIT is declared once", () => {
    const decls = source.match(/REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to REFUSE_EXIT — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("no refusal bypasses the constant with a literal exit code", () => {
    const literals = source.match(/process\.exit\((?!main|0\))/g) || [];
    expect(
      literals,
      "a literal process.exit() bypasses REFUSE_EXIT, so the mutant cannot neutralise it",
    ).toEqual([]);
  });

  test("the script has no relative imports", () => {
    // Without this, the mutant run from a temp directory dies on module
    // resolution and every negative case reads as caught when it is not.
    const rel = (source.match(/from\s+"\.{1,2}\//g) || []).map(s => s.trim());
    expect(rel, "a relative import would make every mutant run fail to resolve").toEqual([]);
  });

  test("the budget has exactly one declaring position", () => {
    const decls = source.match(/SURFACE_BUDGET_BYTES\s*=/g) || [];
    expect(
      decls.length,
      "a second declaration of the budget is a second number to disagree with the first",
    ).toBe(1);
  });
});

// ── UNMEASURED fails; it does not skip and it does not pass ──────────────

describe("SC-2441: a reading that could not be taken FAILS", () => {
  test("a tree with no rule files is refused, not scored as a small surface", () => {
    // The single likeliest way this check becomes decorative: the directory
    // moves, the walk finds nothing, the total is 4,538 bytes and the budget
    // is met forever. Zero files is a scan that did not happen.
    const root = plantedRoot({});
    rmSync(join(root, ".claude", "rules"), { recursive: true, force: true });
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("UNMEASURED");
    expect(real.err).toContain("a scan that did not happen");
  });

  test("a tree missing CLAUDE.md is refused rather than measured as lighter", () => {
    const root = plantedRoot({ "a.md": "## A\n\nrule.\n" }, { claude: null });
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("UNMEASURED");
    expect(real.err).toContain("CLAUDE.md");
  });

  test("the library refuses in the same two cases, so the exit is not the only guard", () => {
    const empty = plantedRoot({});
    rmSync(join(empty, ".claude", "rules"), { recursive: true, force: true });
    expect(() => measureSurface(empty)).toThrow(SurfaceUnmeasured);
    const noClaude = plantedRoot({ "a.md": "## A\n\nrule.\n" }, { claude: null });
    expect(() => measureSurface(noClaude)).toThrow(SurfaceUnmeasured);
  });
});

// ── Over budget fails, and says by how much ──────────────────────────────

describe("SC-2442: over the declared budget is a refusal carrying the measurement", () => {
  test("a tree one rule over budget is refused and the message names the file", () => {
    const root = plantedRoot({ "huge.md": `## Huge\n\n${filler(SURFACE_BUDGET_BYTES + 1_000)}` });
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("over the");
    expect(real.err).toContain("huge.md");
    expect(real.err, "the failure must carry the current reading, not only the verdict").toMatch(
      /\d{2},\d{3} bytes/,
    );
  });

  test("the remedy names moving records, not deleting them", () => {
    // The cheapest wrong fix for this check is to delete the records that made
    // the file long — the exact failure `checks-must-be-able-to-fail.md` exists
    // to prevent. A refusal that does not say so invites it.
    const root = plantedRoot({ "huge.md": `## Huge\n\n${filler(SURFACE_BUDGET_BYTES + 10)}` });
    const real = run(SCRIPT, ["--root", root]);
    expect(real.code).toBe(1);
    expect(real.err).toContain("Move the worked examples");
    expect(real.err).toContain("reference/");
  });

  test("a tree just under budget passes, so the refusal is not unconditional", () => {
    // The positive control. Without it, a script that refused everything would
    // satisfy every case above.
    const root = plantedRoot({ "small.md": "## Small\n\nrule.\n" });
    const r = run(SCRIPT, ["--root", root]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("TOTAL");
  });
});

// ── The population is derived, not spelled ───────────────────────────────

describe("SC-2443: the population is derived from the tree", () => {
  test("a rule file nobody listed is counted", () => {
    // The staleness mode named in the issue: hardcode eleven filenames and the
    // check goes blind the moment somebody adds a twelfth.
    const base = plantedRoot({ "a.md": "## A\n\nrule.\n" });
    const before = measureSurface(base).totalBytes;
    const grown = plantedRoot({ "a.md": "## A\n\nrule.\n", "z-new.md": `## Z\n\n${filler(5_000)}` });
    const after = measureSurface(grown).totalBytes;
    expect(after - before, "a newly added rule file did not move the total").toBeGreaterThan(4_900);
  });

  test("a rule in a nested directory is counted", () => {
    const flat = plantedRoot({ "a.md": "## A\n\nrule.\n" });
    const nested = plantedRoot({ "a.md": "## A\n\nrule.\n", "sub/b.md": `## B\n\n${filler(3_000)}` });
    expect(measureSurface(nested).totalBytes - measureSurface(flat).totalBytes).toBeGreaterThan(
      2_900,
    );
  });
});

// ── What loads at launch, and what does not ──────────────────────────────

describe("SC-2444: a path-scoped rule is not part of the launch surface", () => {
  test("a huge path-scoped rule does not blow the budget", () => {
    // `paths:` is the only frontmatter key Claude Code reads; a rule carrying
    // one loads on demand. Counting it would make the budget a number about a
    // surface no agent pays for, and the first fix anyone reached for —
    // narrowing a glob — would not move it.
    const huge = `---\npaths:\n  - "src/**"\n---\n\n## Huge\n\n${filler(SURFACE_BUDGET_BYTES * 2)}`;
    const root = plantedRoot({ "scoped.md": huge });
    const r = run(SCRIPT, ["--root", root]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("path-scoped");
  });

  test("the same body without `paths:` DOES blow it — the exclusion is load-bearing", () => {
    // The input on which the scoped and unscoped readings differ. Without this
    // the exclusion could be unconditional and every case above would pass.
    const body = `## Huge\n\n${filler(SURFACE_BUDGET_BYTES * 2)}`;
    refusesAndMutantDoesNot(["--root", plantedRoot({ "unscoped.md": `---\ndescription: x\n---\n\n${body}` })]);
  });

  test("isPathScoped reads the frontmatter block and not the body", () => {
    expect(isPathScoped('---\npaths:\n  - "a"\n---\n\nbody\n')).toBe(true);
    expect(isPathScoped("---\ndescription: x\n---\n\npaths: not frontmatter\n")).toBe(false);
    expect(isPathScoped("## no frontmatter\n\npaths: nope\n")).toBe(false);
  });
});

describe("SC-2445: the measurement is of the body, because frontmatter is stripped", () => {
  test("frontmatter does not count toward the budget", () => {
    const bare = plantedRoot({ "a.md": "## A\n\nrule.\n" });
    const stamped = plantedRoot({
      "a.md": `---\ndescription: ${"d".repeat(2_000)}\ngenerated-sha: abc\n---\n\n## A\n\nrule.\n`,
    });
    expect(
      measureSurface(stamped).totalBytes,
      "frontmatter is stripped before a rule enters context, so it must not be billed",
    ).toBe(measureSurface(bare).totalBytes);
  });

  test("ruleBody strips exactly one leading block", () => {
    expect(ruleBody("---\na: 1\n---\n\nbody\n")).toBe("body\n");
    expect(ruleBody("no frontmatter\n")).toBe("no frontmatter\n");
  });
});

// ── This repository, measured ────────────────────────────────────────────

describe("SC-2446: this repository is inside its own budget", () => {
  test("the real tree measures under SURFACE_BUDGET_BYTES", () => {
    const reading = measureSurface(REPO_ROOT);
    expect(
      reading.totalBytes,
      `the auto-loaded surface is ${reading.totalBytes} bytes against a budget of ` +
        `${SURFACE_BUDGET_BYTES}. Move a record into reference/ and route to it from ` +
        `.claude/rules/docs-routing.md — see #1009. Raising the budget is a decision, not a fix.`,
    ).toBeLessThanOrEqual(SURFACE_BUDGET_BYTES);
  });

  test("the reading is not vacuously small", () => {
    // Guards the guard. A walk that found one file would pass the case above
    // for the worst possible reason.
    const reading = measureSurface(REPO_ROOT);
    const loaded = reading.entries.filter(e => !e.excluded);
    expect(loaded.length, "too few files in the population — the walk is broken").toBeGreaterThan(8);
    expect(reading.totalBytes, "the total is implausibly small").toBeGreaterThan(20_000);
    expect(loaded.map(e => e.file)).toContain("CLAUDE.md");
    expect(loaded.map(e => e.file)).toContain(".claude/rules/checks-must-be-able-to-fail.md");
  });

  test("SC-2447: the budget tracks the tree and cannot be inflated past it", () => {
    /**
     * Added because the battery said to add it. Predicted 3 red for the
     * mutation `SURFACE_BUDGET_BYTES = 64_000` → `10_000_000`; measured **0**.
     *
     * The cause is the shape this repository calls an assertion that holds
     * vacuously: every fixture above sizes its filler from the constant, so
     * raising the constant raises the fixtures with it and no case can tell
     * one budget from another. The check enforced that the surface was under
     * *some* number — which is the thing the issue says a budget must not be.
     *
     * The input on which mutant and original differ is this repository's own
     * tree: at 64,000 the budget sits 15% above the 55,764 it was set from; at
     * 10,000,000 it sits 17,840% above and governs nothing. So the bound is
     * stated against the MEASUREMENT rather than against a second constant —
     * a second constant would be two deciders that agree, and the mutation of
     * either would leave the other holding the case up.
     *
     * 1.35 is headroom for roughly two more rules of ordinary size. Raising
     * the budget to accommodate real growth stays legal and stays one visible
     * line in the diff; inflating it so it stops binding does not.
     */
    const measured = measureSurface(REPO_ROOT).totalBytes;
    const ceiling = Math.round(measured * 1.35);
    expect(
      SURFACE_BUDGET_BYTES,
      `the budget is ${SURFACE_BUDGET_BYTES} against a measured surface of ${measured}. A budget ` +
        `more than 35% above what it governs is a number that cannot go red. Move a record into ` +
        `reference/ instead of raising it (#1009).`,
    ).toBeLessThanOrEqual(ceiling);
  });

  test("the script agrees with the library on this repository", () => {
    // Two readers of one fact would be a pair that cannot disagree if the
    // script recomputed the total itself. It does not — this asserts that.
    const r = run(SCRIPT, ["--root", REPO_ROOT, "--json"]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(JSON.parse(r.out).totalBytes).toBe(measureSurface(REPO_ROOT).totalBytes);
  });
});
