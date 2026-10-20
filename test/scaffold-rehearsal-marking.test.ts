/**
 * #642 — scaffold's audit-mode verbs are indistinguishable from `--fix` verbs
 * once the mode notice scrolls off.
 *
 * SC ids are NOT hand-written here: ids chosen against one tree cannot see
 * another session's unmerged branches, and four collisions in one day came
 * from exactly that. The ids for these cases need allocating by the DA.
 *
 * ## What is actually wrong, as measured rather than as filed
 *
 * The issue body's first diagnosis — a missing or stale write in
 * `writeManagedFile` — was withdrawn by its own author and is wrong: audit
 * clones the tree (`cloneForRehearsal`), runs the REAL write steps against
 * the clone, and discards it. Nothing is defective about the write path.
 *
 * What is defective is the REPORT. The mode is announced once, at the top,
 * by `rehearsalNotice`. Every line after `=== Scaffold Report ===` is then
 * emitted unqualified, so `REPLACED: .github/workflows/ci.yml (+114 lines)`
 * produced by an audit is byte-identical to the line produced by a run that
 * really wrote the file. `grep`, `| tail -25`, a scrolled terminal, and an
 * agent reading the last N lines of a tool result all consume ONE LINE. The
 * unit of consumption is narrower than the unit of qualification.
 *
 * ## Why the property here is PER-LINE and not "the two reports differ"
 *
 * The issue's final comment prescribes the check as *"an audit run and a
 * `--fix` run on the same tree produce report lines that are not equal,
 * because today they are character-for-character identical."* **That premise
 * is false and the check it describes cannot fail.** Measured on two planted
 * repositories before this test was written: the two reports already differ
 * today, on the defective tree, because `lib/scaffold/write-steps.ts:209`
 * guards `postScaffoldCommit` with `if (!rehearsing)` — so `--fix` emits one
 * extra line (`SKIP: post-scaffold commit (--commit not passed)`) and its
 * `Total:` says `5 skipped` where audit says `4`. A test asserting "the two
 * reports differ" PASSES right now, over the defect, having witnessed
 * nothing. That is `.claude/rules/checks-must-be-able-to-fail.md`'s fifth
 * shape, arriving in the issue's own prescription.
 *
 * The property that fails today is per-line: every line audit emits is
 * byte-identical to its `--fix` counterpart. So the cases below assert that
 * NO action line audit prints equals ANY line `--fix` prints — and, because
 * an empty intersection is trivially distinguishable, that the compared set
 * is non-empty: the unmarked forms of audit's lines must still overlap
 * `--fix`'s report, which is what proves the two runs are talking about the
 * same work.
 *
 * ## The cheapest wrong fix, named, and whether these cases survive it
 *
 * **Mark only the `Total:` line** (or only the first line). The issue's own
 * framing invites it — "a prefix on the line" reads as a single annotation —
 * and it makes the symptom in a screenshot go away while leaving every
 * `grep`, `tail` and scrolled-terminal consumer in exactly the position the
 * issue is about.
 *
 * These cases do NOT survive it, and that is deliberate: `every action line`
 * below counts marked lines against the number of actions rather than
 * asserting `>= 1`, and the end-to-end case compares EVERY audit action line
 * against the whole of `--fix`'s report. Marking one line leaves the rest
 * identical and both go red — measured, as row 3 below.
 *
 * ## What was broken to prove it
 *
 * Run and counted over `test/scaffold-rehearsal-marking.test.ts` +
 * `test/scaffold-audit-agreement.test.ts` + `test/scaffold-auto-fix.test.ts`
 * (31 tests). Every count was predicted before the battery ran, and **the
 * baseline row was read before any mutation row** — an instrument that has
 * stopped reporting takes the baseline down with it, and that is the row
 * nobody checks.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 31 pass, 0 fail | **31 pass, 0 fail** | — |
 * | `qualify` short-circuited to the identity — the genuine pre-#642 report | 3 | **3 of 31** | `reportScaffoldActions(["CREATED: AGENTS.md"], {rehearsed:true})`: the original prints `  CREATED: AGENTS.md [REHEARSAL — not applied]`, the mutant prints `  CREATED: AGENTS.md` |
 * | **the cheapest wrong fix** — only the first action line and the `Total:` marked | 3 | **3 of 31** | two actions under rehearsal: the original marks both, the mutant marks `CREATED: AGENTS.md` and leaves `REPLACED: CODE-MAP.md` bare |
 * | the LEADING `REHEARSED ` prefix the issue prescribes | 6 | **6 of 31** | `writtenPath("  REHEARSED CREATED: AGENTS.md")` returns `null` where the original returns `AGENTS.md`. The extra three reds are #398's own suite — `audit.paths` empties, so "the audit report is not empty" and "every path --fix writes is one audit named" both go red |
 * | `REHEARSAL_MARKER` emptied to `""` | 2 | **2 of 31** | the same call: the original appends 26 characters, the mutant appends none |
 * | the CLI stops passing its mode (`{rehearsed: false}` always) | 1 | **1 of 31** | `bun scripts/scaffold-project.ts <tree>` with no `--fix`: 56 of the original's report lines carry the marker, 0 of the mutant's do |
 *
 * **Row 4 is why the marker is trailing**, and it is the one row that is a
 * measurement rather than a confirmation: the constraint was named in triage
 * from reading `writtenPath`, and this is it applied and counted. Shipping
 * the issue's prescribed prefix would have left `test/scaffold-audit-
 * agreement.test.ts` comparing two empty sets.
 *
 * **Row 5 is 2 and not 3, and the missing one is recorded rather than
 * filed as noise.** "the Total line is qualified too" stays GREEN under an
 * empty marker, because `"anything".includes("")` is true — the case is a
 * witness of WHERE the marking lands, not of the marker having content.
 * `every action line` is the case that holds that, via its
 * `--fix`-must-not-carry-it direction.
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * `git status --porcelain` was empty afterwards, and the baseline was
 * re-measured at 31 pass / 0 fail.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { REHEARSAL_MARKER, reportScaffoldActions, writtenPath } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "scaffold-project.ts");

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** Capture what `reportScaffoldActions` prints, as lines. */
function printed(actions: string[], opts: { rehearsed: boolean }): string[] {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    reportScaffoldActions(actions, opts);
  } finally {
    console.log = log;
  }
  return lines;
}

/**
 * A consumer that has been scaffolded once and has since drifted, so `--fix`
 * both CREATES and REPLACES. Same shape as
 * `test/scaffold-audit-agreement.test.ts`'s fixture, for the same reason: a
 * tree with one kind of change lets a mode that qualifies one kind pass.
 */
function plantDriftedConsumer(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `scaffold-rehearsal-${name}-`));
  roots.push(root);
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  const write = (rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");

  write("package.json", JSON.stringify({ name, private: true }, null, 2));
  write("src/index.ts", "export const x = 1;\n");
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  write("AGENTS.md", "# stale\n\nThis is not what the generator produces.\n");
  write(".github/workflows/ci.yml", "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hand-edited\n");
  write("specs/EXAMPLE-SPEC.md", "# Example\n\nNo frontmatter, so a validator has something to say.\n");

  git("add", "-A");
  git("commit", "-qm", "planted");
  return root;
}

function runScaffold(root: string, args: string[]): string {
  const r = spawnSync("bun", [CLI, root, ...args], {
    cwd: ROOT, encoding: "utf-8", timeout: 300_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/**
 * The action lines of a run's `=== Scaffold Report ===` section, trimmed.
 *
 * Sliced rather than searched over the whole output, because the thing being
 * compared is a claim about the REPORT and the notice above it legitimately
 * says "audit" in one mode and nothing in the other. A whole-document search
 * would be satisfied by that difference — `.claude/rules/
 * checks-must-be-able-to-fail.md`, "search the slice, not the document".
 */
function reportLines(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex(l => l.includes("=== Scaffold Report ==="));
  if (start < 0) throw new Error(`no scaffold report in output:\n${out.slice(-2000)}`);
  const body = lines.slice(start + 1);
  const end = body.findIndex(l => l.startsWith("Total:"));
  if (end < 0) throw new Error(`report has no Total line:\n${out.slice(-2000)}`);
  return body.slice(0, end).map(l => l.trim()).filter(Boolean);
}

describe("#642: an audit's action lines say so, one line at a time", () => {
  test("every action line printed under rehearsal carries the marker", () => {
    const actions = [
      "CREATED: .gitignore (security template)",
      "REPLACED: .github/workflows/ci.yml (+114 lines, overwrote 4 edited line(s))",
      "UPDATED: package.json (rungate devDep)",
      "GENERATED: CODE-MAP.md",
      "SKIP: .git/hooks/pre-push (hand-written, not overwriting)",
      "AUDITED: AGENTS.md",
    ];

    const audit = printed(actions, { rehearsed: true });
    const fix = printed(actions, { rehearsed: false });

    const auditActions = audit.filter(l => l.startsWith("  "));
    const fixActions = fix.filter(l => l.startsWith("  "));

    // Non-empty, and the same count, so the comparison below is over
    // something rather than over nothing.
    expect(auditActions.length, "nothing was printed — the comparison is vacuous").toBe(actions.length);
    expect(fixActions.length).toBe(actions.length);

    // Counted, not sampled. `>= 1` is satisfied by marking the first line
    // only, which is the cheap wrong fix this case exists to block.
    const marked = auditActions.filter(l => l.includes(REHEARSAL_MARKER));
    expect(
      marked.length,
      `${auditActions.length - marked.length} audit line(s) are indistinguishable from a real write: ` +
      auditActions.filter(l => !l.includes(REHEARSAL_MARKER)).join(" | "),
    ).toBe(actions.length);

    // Direction two: `--fix` must NOT carry it, or the marker says nothing.
    expect(fixActions.filter(l => l.includes(REHEARSAL_MARKER))).toEqual([]);

    // And per line, which is the unit a consumer reads.
    for (let i = 0; i < actions.length; i++) {
      expect(auditActions[i], `line ${i} is byte-identical across the two modes`).not.toBe(fixActions[i]);
    }
  });

  test("the Total line is qualified too, and the per-line marking is not just it", () => {
    const actions = ["CREATED: AGENTS.md", "REPLACED: CODE-MAP.md"];
    const audit = printed(actions, { rehearsed: true });

    const total = audit.find(l => l.trimStart().startsWith("Total:"));
    expect(total, "no Total line").toBeDefined();
    expect(total).toContain(REHEARSAL_MARKER);

    // The Total line carrying it is NOT sufficient: strip it out and the
    // action lines must still each carry one.
    const actionLines = audit.filter(l => l.startsWith("  "));
    expect(actionLines.length).toBe(2);
    expect(actionLines.every(l => l.includes(REHEARSAL_MARKER))).toBe(true);
  });

  test("the marker does not move the path a written line names", () => {
    // `writtenPath` is the one binding `postScaffoldCommit` stages by and
    // `test/scaffold-audit-agreement.test.ts` compares audit's named paths
    // with. A LEADING `REHEARSED ` prefix would make it return null for every
    // audit line and quietly empty that suite's comparison — agreement by
    // both sides reporting nothing, which is the vacuous shape it was built
    // to avoid. A trailing marker is the constraint, and this is the case
    // that holds it.
    const actions = [
      "CREATED: AGENTS.md",
      "REPLACED: .github/workflows/ci.yml (+4 lines, overwrote 1 edited line(s))",
      "UPDATED: .git/hooks/pre-push (conformity check)",
    ];
    const audit = printed(actions, { rehearsed: true }).filter(l => l.startsWith("  "));
    const named = audit.map(writtenPath);
    expect(named).toEqual([
      "AGENTS.md",
      ".github/workflows/ci.yml",
      ".git/hooks/pre-push",
    ]);
  });
});

describe("#642 end-to-end: no line of an audit report equals a line of a --fix report", () => {
  test("two planted copies of one tree, audit against --fix, compared line by line", () => {
    const audited = plantDriftedConsumer("audit");
    const fixed = `${audited}-fix`;
    roots.push(fixed);
    cpSync(audited, fixed, { recursive: true });

    const auditLines = reportLines(runScaffold(audited, []));
    const fixLines = reportLines(runScaffold(fixed, ["--fix"]));

    expect(auditLines.length, "audit reported nothing — the comparison is vacuous").toBeGreaterThan(0);
    expect(fixLines.length, "--fix reported nothing — the comparison is vacuous").toBeGreaterThan(0);

    // The compared set must be NON-EMPTY, or "no line matches" is satisfied
    // by two runs that happen to do unrelated work. Stripping the marker has
    // to put audit's lines back on top of `--fix`'s, which is what proves
    // the two reports are about the same steps on the same tree.
    const fixSet = new Set(fixLines);
    const overlap = auditLines
      .map(l => l.split(REHEARSAL_MARKER).join(""))
      .filter(l => fixSet.has(l));
    expect(
      overlap.length,
      "audit and --fix share no work at all once the marker is removed — " +
      "this comparison would pass without the fix",
    ).toBeGreaterThan(0);

    // The property itself.
    const indistinguishable = auditLines.filter(l => fixSet.has(l));
    expect(
      indistinguishable,
      `${indistinguishable.length} of ${auditLines.length} audit lines are byte-identical to a --fix line`,
    ).toEqual([]);
  }, 600_000);
});
