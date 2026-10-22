/**
 * Covers SC-2440..SC-2447 and SC-1933..SC-1937
 * (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md).
 *
 * `scripts/check-instruction-surface.ts` — the instruction surface an agent
 * loads, measured and refused when it exceeds its declared budget (#1009,
 * #544).
 *
 * #544 extended the measurement from the launch surface to the PEAK: for
 * every file in the repository, the launch surface plus every scoped rule
 * whose globs match that file. The launch reading is the peak's floor, so one
 * budget governs both and there is no second constant.
 *
 * The case that made this necessary is in this file, below SC-2444: *"a huge
 * path-scoped rule does not blow the budget"* passed, and passed for a reason
 * it never stated — its fixture plants a rule scoped to `src/**` in a tree
 * with no `src/` directory. The glob matched nothing, so the exclusion was
 * never tested against a file that would have exercised it. On the real tree
 * the same hole was 9,484 real bytes: `harness-managed.md` is path-scoped,
 * was excluded at `bytes: 0`, and put `.claude/agents/aditi.md` at 66,124
 * against a 64,000 budget that reported clean.
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
  MAX_EXPANDED_PATTERNS,
  SURFACE_BUDGET_BYTES,
  SurfaceUnmeasured,
  WARN_AT_FRACTION,
  expandBraces,
  headroom,
  isPathScoped,
  measureConcurrentLoad,
  measureSurface,
  ruleBody,
  rulePaths,
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

/**
 * A tree shaped like a scaffolded repo, with the rule bodies given.
 *
 * `opts.files` plants ordinary repository files — the population the peak
 * reading is taken over. Before #544 no fixture here planted one, which is
 * why the scoped-rule exclusion could be asserted against a glob that matched
 * nothing.
 */
function plantedRoot(
  rules: Record<string, string>,
  opts: { claude?: string | null; files?: Record<string, string> } = {},
): string {
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
  for (const [name, body] of Object.entries(opts.files ?? {})) {
    const p = join(root, name);
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
    // `TOTAL` until #544, when the one line became two: the launch floor and
    // the peak. A single total can no longer say which was compared.
    expect(r.out).toContain("LAUNCH");
    expect(r.out).toContain("PEAK");
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
  test("a huge path-scoped rule is not in the LAUNCH surface", () => {
    // `paths:` is the only frontmatter key Claude Code reads; a rule carrying
    // one loads on demand. Counting it at launch would make the budget a
    // number about a surface no agent pays for, and the first fix anyone
    // reached for — narrowing a glob — would not move it.
    //
    // #544: this fixture plants NO file under `src/`, so the glob matches
    // nothing and the rule is free at the peak as well as at launch. That is
    // what the case is now about, and the paired case below is the one that
    // plants the file. Until #544 only this half existed, and it read as
    // proof that a scoped rule is free — which on the real tree cost 9,484
    // bytes of unmeasured `harness-managed.md`.
    const huge = `---\npaths:\n  - "src/**"\n---\n\n## Huge\n\n${filler(SURFACE_BUDGET_BYTES * 2)}`;
    const root = plantedRoot({ "scoped.md": huge });
    const r = run(SCRIPT, ["--root", root]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("path-scoped");
    expect(measureSurface(root).totalBytes).toBeLessThan(1_000);
    expect(measureConcurrentLoad(root).peakFile, "no file matches `src/**` in this tree").toBe(
      null,
    );
  });

  test("the SAME rule with one matching file present IS refused at the peak", () => {
    // The input on which the two readings differ, and the whole of #544: the
    // bytes are identical, the frontmatter is identical, and the only change
    // is that the tree now contains a file the glob matches.
    const huge = `---\npaths:\n  - "src/**"\n---\n\n## Huge\n\n${filler(SURFACE_BUDGET_BYTES * 2)}`;
    const root = plantedRoot({ "scoped.md": huge }, { files: { "src/app.ts": "export {};\n" } });
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("peak instruction surface");
    expect(real.err).toContain("src/app.ts");
    expect(real.err).toContain("scoped.md");
    // The launch reading on this same tree is tiny. Without this line the
    // case would also pass if the peak had simply started billing every
    // scoped rule unconditionally, which is the over-correction.
    expect(measureSurface(root).totalBytes).toBeLessThan(1_000);
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
  test("the real tree measures under SURFACE_BUDGET_BYTES at its PEAK", () => {
    // #544: this was `measureSurface` — the launch floor — and it was green
    // while editing any file under `.claude/agents/**` or `.claude/rules/**`
    // cost 66,124 bytes. The peak is what an agent pays; the floor is what it
    // pays before it does anything.
    const reading = measureConcurrentLoad(REPO_ROOT);
    expect(
      reading.peakBytes,
      `the peak surface is ${reading.peakBytes} bytes on ${reading.peakFile} against a budget ` +
        `of ${SURFACE_BUDGET_BYTES}. Narrow a glob, or move a record into reference/ and route ` +
        `to it from .claude/rules/docs-routing.md — see #1009 and #544. Raising the budget is ` +
        `a decision, not a fix.`,
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
    // #544: bound against the PEAK, because the peak is what the budget now
    // governs. Binding it to the launch floor while the comparison was
    // against the peak would be the two-deciders shape in miniature.
    const measured = measureConcurrentLoad(REPO_ROOT).peakBytes;
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
    const emitted = JSON.parse(r.out);
    expect(emitted.totalBytes).toBe(measureSurface(REPO_ROOT).totalBytes);
    expect(emitted.concurrent.peakBytes).toBe(measureConcurrentLoad(REPO_ROOT).peakBytes);
  });
});

// ── #544: the peak, not the floor ────────────────────────────────────────

describe("SC-1933: the peak is the launch surface plus one file's scoped rules", () => {
  test("the reading names the maximum and the file that produces it", () => {
    const root = plantedRoot(
      {
        "a.md": `---\npaths:\n  - "lib/**"\n---\n\n${filler(3_000)}`,
        "b.md": `---\npaths:\n  - "lib/hot.ts"\n---\n\n${filler(2_000)}`,
        "c.md": `---\npaths:\n  - "docs/**"\n---\n\n${filler(9_000)}`,
      },
      { files: { "lib/hot.ts": "x\n", "lib/cold.ts": "x\n", "docs/g.md": "x\n" } },
    );
    const reading = measureConcurrentLoad(root);
    // `lib/hot.ts` loads a.md + b.md = 5,002 of filler; `docs/g.md` loads
    // 9,001 alone. The peak is the single worst FILE, so the larger single
    // rule wins and the overlap does not — which is the distinction a
    // "largest rule" reading and a "most rules" reading both get wrong.
    expect(reading.peakFile).toBe("docs/g.md");
    expect(reading.peakRules.map(r => r.file)).toEqual([".claude/rules/c.md"]);
    expect(reading.peakBytes - reading.launch.totalBytes).toBe(9_001);
  });

  test("overlapping rules on one file are summed", () => {
    const root = plantedRoot(
      {
        "a.md": `---\npaths:\n  - "lib/**"\n---\n\n${filler(3_000)}`,
        "b.md": `---\npaths:\n  - "lib/hot.ts"\n---\n\n${filler(9_000)}`,
      },
      { files: { "lib/hot.ts": "x\n", "lib/cold.ts": "x\n" } },
    );
    const reading = measureConcurrentLoad(root);
    expect(reading.peakFile).toBe("lib/hot.ts");
    expect(reading.peakRules.map(r => r.file)).toEqual([
      ".claude/rules/b.md",
      ".claude/rules/a.md",
    ]);
    expect(reading.peakBytes - reading.launch.totalBytes).toBe(12_002);
  });

  test("the launch surface is the peak's floor, so one budget governs both", () => {
    // The property that makes a second constant unnecessary. Asserted rather
    // than argued: if the peak could come back BELOW the launch reading, the
    // #1009 comparison would have been dropped for a weaker one.
    const reading = measureConcurrentLoad(REPO_ROOT);
    expect(reading.peakBytes).toBeGreaterThanOrEqual(reading.launch.totalBytes);
  });

  test("a walk that loses the tree is UNMEASURED, not a peak equal to the floor", () => {
    // Reachable only because the floor is stated against what the launch
    // reading already read. The mutation: make `walkFiles` skip every
    // directory, which is what a bad SKIP_DIRS entry does.
    const root = plantedRoot({ "a.md": "## A\n\nrule.\n" });
    const mutantSrc = source.replace(
      "const SKIP_DIRS = new Set([",
      "const SKIP_DIRS = new Set([String.raw`.claude`, ",
    );
    expect(mutantSrc, "the SKIP_DIRS declaration moved — this mutation is no longer applied").not.toBe(
      source,
    );
    const p = join(MUTANT_DIR, "walk-mutant.ts");
    writeFileSync(p, mutantSrc);
    const r = run(p, ["--root", root]);
    expect(r.code, `${r.out}${r.err}`).toBe(1);
    expect(r.err).toContain("UNMEASURED");
    expect(r.err).toContain("a walk that did not happen");
    // And the unmutated script is fine on the same tree — so the refusal is
    // the mutation's doing and not the fixture's.
    expect(run(SCRIPT, ["--root", root]).code).toBe(0);
  });
});

describe("SC-1934: over budget at the peak FAILs and names the overlapping rules", () => {
  test("the refusal names every rule loading on the worst file", () => {
    const root = plantedRoot(
      {
        "wide.md": `---\npaths:\n  - "lib/**"\n---\n\n${filler(SURFACE_BUDGET_BYTES / 2)}`,
        "narrow.md": `---\npaths:\n  - "lib/hot.ts"\n---\n\n${filler(SURFACE_BUDGET_BYTES / 2)}`,
      },
      { files: { "lib/hot.ts": "x\n" } },
    );
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("lib/hot.ts");
    expect(real.err).toContain("wide.md");
    expect(real.err).toContain("narrow.md");
  });

  test("glob-narrowing is the FIRST remedy and eviction the last", () => {
    // The spec's order, and the reason for it: an over-budget repository is
    // fixed by making a rule load less often before it is fixed by deleting
    // a rule that is right. A message that led with eviction would get the
    // good rule deleted, which is the cheapest wrong fix here.
    const root = plantedRoot(
      { "wide.md": `---\npaths:\n  - "lib/**"\n---\n\n${filler(SURFACE_BUDGET_BYTES + 10)}` },
      { files: { "lib/hot.ts": "x\n" } },
    );
    const r = run(SCRIPT, ["--root", root]);
    expect(r.code).toBe(1);
    const narrow = r.err.indexOf("NARROW A GLOB");
    const move = r.err.indexOf("Move the worked examples");
    const evict = r.err.indexOf("Evict the rule");
    expect(narrow).toBeGreaterThan(-1);
    expect(narrow).toBeLessThan(move);
    expect(move).toBeLessThan(evict);
  });

  test("the comparison is against the budget it is given, not against a constant", () => {
    /**
     * The #1009 lesson applied to the new reading. Every process-level case
     * above sizes its filler from `SURFACE_BUDGET_BYTES`, so raising the
     * constant raises the fixture and none of them can tell one budget from
     * another — measured as 0 red for that mutation, which is why SC-2447
     * exists.
     *
     * This case names an input on which two budgets differ: one tree, two
     * literal budgets, opposite verdicts. The sizes are literals and do not
     * move when the constant does.
     */
    const root = plantedRoot(
      { "wide.md": `---\npaths:\n  - "lib/**"\n---\n\n${filler(5_000)}` },
      { files: { "lib/hot.ts": "x\n" } },
    );
    const peak = measureConcurrentLoad(root, 4_000).peakBytes;
    expect(peak).toBeGreaterThan(4_000);
    expect(peak).toBeLessThan(8_000);
    expect(measureConcurrentLoad(root, 4_000).budgetBytes).toBe(4_000);
    expect(measureConcurrentLoad(root, 8_000).budgetBytes).toBe(8_000);
  });
});

describe("SC-1935: the total rule count is not capped — only concurrent load is", () => {
  test("forty rules that never co-match cost one rule's worth", () => {
    // The reading a count-based cap gets backwards. `docs/research/context-
    // management.md` measures collapse past ~16 rules IN CONTEXT; forty that
    // never load together are never in context together.
    const rules: Record<string, string> = {};
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      rules[`r${i}.md`] = `---\npaths:\n  - "mod${i}/**"\n---\n\n${filler(1_000)}`;
      files[`mod${i}/a.ts`] = "x\n";
    }
    const reading = measureConcurrentLoad(plantedRoot(rules, { files }));
    expect(reading.peakBytes - reading.launch.totalBytes).toBe(1_001);
    expect(run(SCRIPT, ["--root", plantedRoot(rules, { files })]).code).toBe(0);
  });

  test("two rules that always co-match cost two", () => {
    // The other half. Without it, a check that ignored overlap entirely
    // would satisfy the case above.
    const root = plantedRoot(
      {
        "a.md": `---\npaths:\n  - "mod/**"\n---\n\n${filler(1_000)}`,
        "b.md": `---\npaths:\n  - "mod/**"\n---\n\n${filler(1_000)}`,
      },
      { files: { "mod/a.ts": "x\n" } },
    );
    const reading = measureConcurrentLoad(root);
    expect(reading.peakBytes - reading.launch.totalBytes).toBe(2_002);
  });
});

describe("SC-1936: a glob matching every file is reported as unscoped", () => {
  test("a rule scoped to `**` is refused, naming the rule and the count", () => {
    // An un-narrowed glob converts a mined rule into a baseline one while
    // still reading as scoped — so it is excluded from the launch surface
    // and paid on every file. Strictly worse than declaring no `paths:`.
    const root = plantedRoot(
      { "everything.md": `---\npaths:\n  - "**"\n---\n\n${filler(500)}` },
      { files: { "lib/a.ts": "x\n" } },
    );
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("UNSCOPED");
    expect(real.err).toContain("everything.md");
    expect(real.err).toContain("A glob that excludes nothing is not a scope");
  });

  test("a rule that misses one file is NOT reported", () => {
    // The positive control. A check that fired on every scoped rule would
    // satisfy the case above and refuse the whole repository.
    const root = plantedRoot(
      { "nearly.md": `---\npaths:\n  - "lib/**"\n---\n\n${filler(500)}` },
      { files: { "lib/a.ts": "x\n", "other/b.ts": "x\n" } },
    );
    expect(measureConcurrentLoad(root).unscoped).toEqual([]);
    expect(run(SCRIPT, ["--root", root]).code).toBe(0);
  });

  test("this repository has no unscoped mined rule", () => {
    expect(measureConcurrentLoad(REPO_ROOT).unscoped.map(r => r.file)).toEqual([]);
  });
});

describe("SC-1937: per-rule glob expansion and size stay inside Claude Code's limits", () => {
  test("brace groups multiply, as the platform counts them", () => {
    expect(expandBraces("{a,b}/{c,d}/*.{ts,tsx}")).toHaveLength(8);
    expect(expandBraces("lib/**")).toEqual(["lib/**"]);
    expect(expandBraces("{a,{b,c}}/x")).toEqual(["a/x", "b/x", "c/x"]);
    // An unclosed brace is not an expansion. Returning [] here would make an
    // over-budget pattern read as costing nothing.
    expect(expandBraces("{a,b/x")).toEqual(["{a,b/x"]);
  });

  test("a rule over the 1,000-pattern budget is refused", () => {
    // 4 groups of 6 alternatives each: 1,296 patterns from one line.
    const g = "{a,b,c,d,e,f}";
    const root = plantedRoot(
      { "many.md": `---\npaths:\n  - "${g}/${g}/${g}/${g}/x.ts"\n---\n\n${filler(100)}` },
      { files: { "lib/a.ts": "x\n" } },
    );
    const real = refusesAndMutantDoesNot(["--root", root]);
    expect(real.err).toContain("GLOB BUDGET");
    expect(real.err).toContain("many.md");
    expect(measureConcurrentLoad(root).globOverruns[0]!.expandedPatterns).toBeGreaterThan(
      MAX_EXPANDED_PATTERNS,
    );
  });

  test("a rule just under the budget is not refused", () => {
    // 3 groups of 6: 216 patterns. The positive control for the case above.
    const g = "{a,b,c,d,e,f}";
    const root = plantedRoot(
      { "few.md": `---\npaths:\n  - "${g}/${g}/${g}/x.ts"\n---\n\n${filler(100)}` },
      { files: { "lib/a.ts": "x\n" } },
    );
    expect(measureConcurrentLoad(root).globOverruns).toEqual([]);
    expect(run(SCRIPT, ["--root", root]).code).toBe(0);
  });

  test("this repository's rules stay inside both limits", () => {
    const reading = measureConcurrentLoad(REPO_ROOT);
    expect(reading.globOverruns.map(r => r.file)).toEqual([]);
    expect(reading.oversized.map(r => r.file)).toEqual([]);
  });
});

// ── #1069: a passing reading reports how close it came ───────────────────
//
// The gate failed at 100% and was silent at 99.94%, so the first report of
// 36 bytes of headroom was a red shard on a file the agent had never opened.
// Each case below is paired with the control that makes it mean something:
// a warning that fires at 95% is only evidence if it is also observed NOT
// firing at 94%, and a warning that does not change the exit code is only
// evidence if the same tree is observed exiting 0.
describe("#1069: headroom is reported, and the last 5% warns without refusing", () => {
  // One tree, two budgets. Measuring one fixture against a budget on either
  // side of the threshold is what rules out the reading moving instead of the
  // threshold deciding — the thing under test is the comparison, not the file.
  const tree = () => plantedRoot({ "a.md": filler(1_000) });

  test("inside the band warns, and one byte of budget more does not", () => {
    const root = tree();
    const measured = measureConcurrentLoad(root).peakBytes;

    // Smallest budget for which `peak / budget` is still below the fraction.
    const justUnder = Math.floor(measured / WARN_AT_FRACTION) + 1;
    expect(headroom(measureConcurrentLoad(root, justUnder)).warn).toBe(false);
    expect(headroom(measureConcurrentLoad(root, justUnder - 1)).warn).toBe(true);
  });

  test("headroom is the budget minus the peak, and goes negative over it", () => {
    const root = tree();
    const measured = measureConcurrentLoad(root).peakBytes;
    expect(headroom(measureConcurrentLoad(root, measured + 500)).bytes).toBe(500);
    // Over budget is a reading, not an absence of one: the refusal is a
    // separate decision and this function must not pre-empt it.
    const over = headroom(measureConcurrentLoad(root, measured - 500));
    expect(over.bytes).toBe(-500);
    expect(over.warn).toBe(true);
  });

  test("the script prints the warning on stderr and still exits 0", () => {
    // 95% of 64,000 is 60,800. A body that size is under the budget, so the
    // only thing that can make this run non-zero is the warning doing more
    // than warn.
    const root = plantedRoot({ "big.md": filler(61_000) });
    const r = run(SCRIPT, ["--root", root]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.err).toContain("HEADROOM");
    expect(r.out).toContain("HEADROOM");
  });

  test("a tree well under budget prints headroom and no warning", () => {
    const root = plantedRoot({ "small.md": filler(1_000) });
    const r = run(SCRIPT, ["--root", root]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("HEADROOM");
    expect(r.err).not.toContain("HEADROOM");
  });

  test("--json carries the headroom so a caller need not recompute it", () => {
    const root = tree();
    const r = run(SCRIPT, ["--root", root, "--json"]);
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    const emitted = JSON.parse(r.out);
    expect(emitted.headroom).toEqual(headroom(measureConcurrentLoad(root)));
  });

  test("this repository reports a headroom somebody can act on", () => {
    // Not a second budget — SC-2446 owns that. This asserts the REPORT is
    // live on the real tree: a figure of zero would mean the reading never
    // reached the renderer, which is how 36 bytes went unremarked.
    const h = headroom(measureConcurrentLoad(REPO_ROOT));
    expect(h.bytes, "no headroom left — see SC-2446's remedy").toBeGreaterThan(0);
    expect(h.used).toBeGreaterThan(0);
    expect(h.used).toBeLessThan(1);
  });
});

describe("rulePaths reads both YAML spellings", () => {
  test("block and inline lists both parse, and the body does not", () => {
    // A spelling this misses measures as un-scoped, which moves the rule
    // into the launch surface and changes its BYTES, not only a label.
    expect(rulePaths('---\npaths:\n  - "lib/**"\n  - "gates/**"\ndescription: x\n---\n\nbody\n')).toEqual([
      "lib/**",
      "gates/**",
    ]);
    expect(rulePaths('---\npaths: ["lib/**", "gates/**"]\n---\n\nbody\n')).toEqual([
      "lib/**",
      "gates/**",
    ]);
    expect(rulePaths("---\ndescription: x\n---\n\npaths:\n  - lib/**\n")).toEqual([]);
    expect(rulePaths("## no frontmatter\n")).toEqual([]);
  });

  test("it agrees with isPathScoped on this repository's rules", () => {
    // Two readers of one fact. If `isPathScoped` says scoped and `rulePaths`
    // returns nothing, the rule is excluded from the launch surface AND
    // matches no file — free at both readings, which is the escape hatch.
    for (const r of measureConcurrentLoad(REPO_ROOT).peakRules) {
      expect(r.globs.length, `${r.file} is path-scoped but parsed to zero globs`).toBeGreaterThan(0);
    }
    const scoped = measureSurface(REPO_ROOT).entries.filter(e => e.excluded);
    expect(scoped.length, "no path-scoped rule in the tree — this case is vacuous").toBeGreaterThan(
      0,
    );
    for (const e of scoped) {
      expect(
        rulePaths(readFileSync(join(REPO_ROOT, e.file), "utf-8")).length,
        `${e.file} is excluded from the launch surface but declares no parseable globs`,
      ).toBeGreaterThan(0);
    }
  });
});
