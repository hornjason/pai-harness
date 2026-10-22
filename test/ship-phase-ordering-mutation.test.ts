import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { harnessRoot } from "../lib/paths";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #273 — the six phase-ordering checks in test/spec-compliance.test.ts, proven
 * able to fail.
 *
 * They located their anchors with `indexOf` over the RAW text of
 * `workflows/ship.js`, and five of the eight strings they searched for occur
 * only inside comments. Three of the six compared one comment to another and
 * said nothing about code at all. The measurement that opened the issue:
 * gutting the PR step out of `ship.js` while leaving its comment in place left
 * all six green (6 pass, 0 fail) against a harness with zero `pr-upsert` call
 * sites.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` names the shape — a detector
 * narrower than what it detects — and names the remedy: break the thing the
 * check guards and watch it go red. So this file does not assert that the
 * anchors look like code. It builds mutant copies of `workflows/ship.js`,
 * spawns the real six checks against each one, and asserts what they do:
 *
 *  - PR-STEP-DELETED — the step removed, its `create-pr` comment left behind.
 *    At least two of the six must REFUSE. Under the old anchors all six passed.
 *  - BANNER-REWORD — every `// PHASE n:` banner reworded and moved to the top
 *    of the file. All six must stay GREEN. This is the other half: a check
 *    that goes red when prose is reformatted is measuring prose.
 *  - MOVE-1..MOVE-6 — one per ordering, each relocating the real code that
 *    ordering describes. The matching check must be named in the failures.
 *
 * The control run — the same mutant root carrying an UNMUTATED copy — is what
 * separates "red because the mutation worked" from "red because the spawn was
 * broken", and every assertion goes through `ran` first, because a filter that
 * matches nothing leaves bun reporting zero failures.
 *
 * Nothing is written inside the repo. Each mutant root is a temp directory of
 * symlinks to the real harness root with one real file in it: the mutated
 * `workflows/ship.js`. `harnessRoot()` returns `$HARNESS_ROOT` first, which is
 * how the spawned suite is pointed at it.
 */

/** The harness tree whose `workflows/ship.js` is the subject. */
const HR = harnessRoot();
/** The tree holding the SUITE under test — this worktree, not necessarily HR. */
const SUITE_ROOT = join(import.meta.dir, "..");
const SUITE_REL = "test/spec-compliance.test.ts";
const SHIP_SRC = readFileSync(join(HR, "workflows/ship.js"), "utf-8");

/**
 * The PR step, start and end. Declared as literals rather than regex-built so
 * that moving them aborts this file instead of quietly mutating nothing.
 */
// Unindented since #254 hoisted the step out of the container conditional —
// it is a top-level statement now, not the body of an else arm.
const PR_STEP_START = "prStep = await timedAgent(`";
const PR_STEP_END = "\n} })\n";
/** The comment the deletion deliberately LEAVES BEHIND — the old PO-3/PO-4 anchor. */
const PR_STEP_COMMENT = "create-pr";
/** The command the PR step actually runs. */
const PR_STEP_CALL = "pr-upsert";

const BANNER_RE = /^\/\/ PHASE (\d+): (.*)$/gm;

let SCRATCH = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "po-mutation-"));
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ── building a harness root whose ship.js is ours ───────────────────────────

/**
 * A harness root that is the real one in every respect except
 * `workflows/ship.js`. Everything else is a symlink, so the spawned suite
 * reads the real `prove.js`, `ship-and-heal.js`, `gate-executor.ts` and specs
 * — a mutant that died because a sibling file was missing would exit non-zero,
 * and a non-zero exit reads as a refusal it never made.
 */
function buildMutantRoot(shipSrc: string, name: string): string {
  const root = join(SCRATCH, name);
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(HR)) {
    if (entry === "workflows") continue;
    symlinkSync(join(HR, entry), join(root, entry));
  }
  mkdirSync(join(root, "workflows"));
  for (const f of readdirSync(join(HR, "workflows"))) {
    if (f === "ship.js") continue;
    symlinkSync(join(HR, "workflows", f), join(root, "workflows", f));
  }
  writeFileSync(join(root, "workflows", "ship.js"), shipSrc);
  return root;
}

interface Run {
  ran: number;
  red: number;
  failed: string[];
  output: string;
}

/**
 * Spawn the real ordering checks against `root`.
 *
 * `ran` is not a formality: a `-t` filter that matches nothing leaves bun
 * reporting zero failures, which is indistinguishable from every check
 * passing, and is also what a suite that failed to load looks like.
 */
function runOrdering(root: string, filter = "PO-"): Run {
  const r = spawnSync("bun", ["test", SUITE_REL, "-t", filter], {
    cwd: SUITE_ROOT,
    encoding: "utf-8",
    timeout: 180000,
    env: { ...process.env, HARNESS_ROOT: root },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const red = count("fail");
  const failed = [...output.matchAll(/\(fail\)\s+(.*)/g)].map(m => m[1].trim());
  if (process.env.PO_MUTATION_COUNTS) {
    console.log(`MUTATION-COUNT ${root.split("/").pop()}: ${red} red of ${count("pass") + red} — ${failed.map(f => f.split(">").pop()!.trim().split(":")[0]).join(", ") || "none"}`);
  }
  return { ran: count("pass") + red, red, failed, output };
}

/**
 * The `PO-n` ids named in a run's failure lines, sorted and deduplicated.
 *
 * Returning ids rather than a count is what lets a case say WHICH orderings
 * refused. A count of two is produced both by the two orderings that have
 * standing to notice a mutation and by two that went red because the mutant
 * stopped parsing; the ids separate them. Anything bun reported as failing
 * that carries no `PO-n` id — a load error, a thrown `beforeAll` — surfaces as
 * `?` rather than being silently dropped, because an unrecognised failure is
 * exactly the one worth seeing in the diff.
 */
function poIds(failed: string[]): string[] {
  return [...new Set(failed.map(f => /\bPO-(\d+)\b/.exec(f)?.[0] ?? `?(${f})`))].sort();
}

// ── the mutations ───────────────────────────────────────────────────────────

/**
 * Delete the PR step, leave its comment. The exact break the issue measured.
 */
export function prStepDeletedMutant(src: string): string {
  const occurrences = src.split(PR_STEP_START).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the PR step signature appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second copy exists and deleting one would leave the other shipping a PR.`,
    );
  }
  const start = src.indexOf(PR_STEP_START);
  const end = src.indexOf(PR_STEP_END, start);
  if (end < 0) {
    throw new Error("could not build the mutant: the PR step's terminator was not found after its signature");
  }
  return `${src.slice(0, start)}prStep = null // MUTANT: the PR step is gone, its comment is not\n${src.slice(end + PR_STEP_END.length)}`;
}

/**
 * Reword every `// PHASE n:` banner and move them all to the top, in reverse
 * order. Nothing executable moves.
 */
export function bannerRewordMutant(src: string): string {
  const banners = [...src.matchAll(BANNER_RE)];
  if (banners.length < 6) {
    throw new Error(
      `could not build the mutant: found ${banners.length} phase banners, expected at least 6 — ` +
        `the banners this mutation exists to prove irrelevant are not there to reword`,
    );
  }
  const relocated = banners
    .slice()
    .reverse()
    .map(m => `// STEP ${m[1]} is where the ${m[2].split(" ")[0].toLowerCase()} leg used to be announced`)
    .join("\n");
  const body = src.replace(BANNER_RE, "// (banner reworded and relocated by the #273 mutation harness)");
  return `${relocated}\n${body}`;
}

/**
 * Relocate the real code an ordering describes, by exchanging the position of
 * its two executable anchors. Structurally neutral — no backtick, brace or
 * line moves — so a check that goes red here went red about ORDER.
 */
export function relocateCode(src: string, earlier: string, later: string): string {
  const ia = src.indexOf(earlier);
  const ib = src.indexOf(later);
  if (ia < 0 || ib < 0) {
    throw new Error(
      `could not build the mutant: anchor not found (${earlier}: ${ia}, ${later}: ${ib}) — ` +
        `the ordering's executable anchors have moved and this harness is mutating nothing`,
    );
  }
  if (ia >= ib) {
    throw new Error(
      `could not build the mutant: ${earlier} does not precede ${later} in the real source, ` +
        `so there is no ordering here to invert`,
    );
  }
  return src.slice(0, ia) + later + src.slice(ia + earlier.length, ib) + earlier + src.slice(ib + later.length);
}

// ── the cases ───────────────────────────────────────────────────────────────

interface Move {
  check: string;
  earlier: string;
  later: string;
}

const MOVES: Record<string, Move> = {
  "MOVE-1": { check: "PO-1", earlier: "phase('Validate')", later: "phase('Commit')" },
  "MOVE-2": { check: "PO-2", earlier: "phase('Commit')", later: "phase('Verify')" },
  "MOVE-3": { check: "PO-3", earlier: "label: 'quinn-container'", later: "pr-upsert" },
  "MOVE-4": { check: "PO-4", earlier: "pr-upsert", later: "log('Running ship gate')" },
  "MOVE-5": { check: "PO-5", earlier: "log('Running ship gate')", later: "phase('Prove')" },
  "MOVE-6": { check: "PO-6", earlier: "phase('Implement')", later: "phase('Validate')" },
};

/**
 * Build the mutant, confirm the relocation actually landed IN CODE — not in a
 * region the stripper swallowed — then spawn all six checks against it.
 */
function runMove(name: string): Run {
  const move = MOVES[name];
  const mutant = relocateCode(SHIP_SRC, move.earlier, move.later);
  const code = stripJsComments(mutant);
  const ia = code.indexOf(move.earlier);
  const ib = code.indexOf(move.later);
  expect(ia, `${name}: ${move.earlier} vanished from the mutant's code`).toBeGreaterThan(0);
  expect(ib, `${name}: ${move.later} vanished from the mutant's code`).toBeGreaterThan(0);
  expect(ia, `${name}: the relocation did not invert the order`).toBeGreaterThan(ib);

  const run = runOrdering(buildMutantRoot(mutant, name));
  expect(run.ran, `${name}: the six checks did not run — ${run.output}`).toBe(6);
  // Its own ordering and no other. "at least this one is red" is satisfied by
  // a mutant that broke the file for everyone, and that mutant proves nothing
  // about whether the check it names is reading the code it claims to read.
  expect(
    poIds(run.failed),
    `${name}: relocating ${move.earlier} past ${move.later} should turn ${move.check} red and nothing else — failures were ${JSON.stringify(run.failed)}`,
  ).toEqual([move.check]);
  return run;
}

describe("#273: the phase-ordering checks measure code, and can go red", () => {

  test("CONTROL: the six checks pass against an unmutated copy", () => {
    // Everything below subtracts from this. Without it, a mutant that went red
    // because the spawn was misconfigured is indistinguishable from one that
    // went red on the merits.
    const run = runOrdering(buildMutantRoot(SHIP_SRC, "control"));
    expect(run.ran, `the six checks did not run — ${run.output}`).toBe(6);
    expect(run.red, `failures: ${JSON.stringify(run.failed)}`).toBe(0);
  }, 180000);

  test("PR-STEP-DELETED: deleting the PR step but not its comment turns the ordering red", () => {
    const mutant = prStepDeletedMutant(SHIP_SRC);
    // The point of the mutation, asserted rather than assumed: the step is
    // gone and the comment that used to stand in for it is still there.
    expect(mutant.split(PR_STEP_CALL).length - 1).toBe(0);
    expect(mutant).toContain(PR_STEP_COMMENT);
    expect(SHIP_SRC.split(PR_STEP_CALL).length - 1).toBeGreaterThan(0);

    const run = runOrdering(buildMutantRoot(mutant, "pr-deleted"));
    expect(run.ran, `the six checks did not run — ${run.output}`).toBe(6);
    // WHICH two, not merely how many. `red >= 2` is also satisfied by a mutant
    // that stopped parsing, or by PO-1 and PO-2 going red for a reason that has
    // nothing to do with the PR step — and a count that two different causes
    // produce cannot tell them apart. PO-3 and PO-4 are the two orderings whose
    // subject is the PR step; no other ordering mentions it, so no other
    // ordering has standing to notice its deletion.
    expect(
      poIds(run.failed),
      `a harness with zero ${PR_STEP_CALL} call sites was waved through, or went red somewhere it has no business — failures were ${JSON.stringify(run.failed)}`,
    ).toEqual(["PO-3", "PO-4"]);
  }, 180000);

  test("BANNER-REWORD: rewording and moving every phase banner leaves all six green", () => {
    const mutant = bannerRewordMutant(SHIP_SRC);
    for (const banner of [
      "PHASE 4: IMPLEMENT", "PHASE 5: VALIDATE", "PHASE 6: COMMIT",
      "PHASE 7: VERIFY", "PHASE 8: SHIP", "PHASE 9: PROVE",
    ]) {
      expect(SHIP_SRC).toContain(banner);
      expect(mutant).not.toContain(banner);
    }
    // Moved, not merely reworded: the banners now read backwards relative to
    // the code they used to label.
    expect(mutant.indexOf("STEP 9")).toBeLessThan(mutant.indexOf("STEP 1"));

    const run = runOrdering(buildMutantRoot(mutant, "banner-reword"));
    expect(run.ran, `the six checks did not run — ${run.output}`).toBe(6);
    expect(
      run.red,
      `an ordering check went red over reworded prose — failures were ${JSON.stringify(run.failed)}`,
    ).toBe(0);
  }, 180000);

  test("MOVE-1: relocating phase('Validate') past phase('Commit') turns PO-1 red", () => {
    expect(runMove("MOVE-1").red).toBeGreaterThanOrEqual(1);
  }, 180000);

  test("MOVE-2: relocating phase('Commit') past phase('Verify') turns PO-2 red", () => {
    expect(runMove("MOVE-2").red).toBeGreaterThanOrEqual(1);
  }, 180000);

  test("MOVE-3: relocating the quinn-container call past the pr-upsert command turns PO-3 red", () => {
    expect(runMove("MOVE-3").red).toBeGreaterThanOrEqual(1);
  }, 180000);

  test("MOVE-4: relocating the pr-upsert command past the ship-gate log turns PO-4 red", () => {
    expect(runMove("MOVE-4").red).toBeGreaterThanOrEqual(1);
  }, 180000);

  test("MOVE-5: relocating the ship-gate log past phase('Prove') turns PO-5 red", () => {
    expect(runMove("MOVE-5").red).toBeGreaterThanOrEqual(1);
  }, 180000);

  test("MOVE-6: relocating phase('Implement') past phase('Validate') turns PO-6 red", () => {
    expect(runMove("MOVE-6").red).toBeGreaterThanOrEqual(1);
  }, 180000);
});

// ── the anchor audit ────────────────────────────────────────────────────────
//
// Fixing six anchors is not the same as knowing what the other anchors in the
// suite are doing. specs/HARNESS-STANDARD.md carries a table classifying every
// remaining `indexOf` and `sliceBetween` anchor in test/spec-compliance.test.ts
// as code or comment. A table is prose, so it is EXECUTED here: every row's
// claim is re-derived from the file it names.

// Read from SUITE_ROOT, not HR. The audit is a three-way agreement between the
// suite, the table and the workflows, and all three have to come out of ONE
// tree or the agreement is between two versions of the repo. In CI the two
// roots are the same path; in a worktree they are not, and the tree being
// graded is the one the suite lives in.
const STANDARD_MD = readFileSync(join(SUITE_ROOT, "specs/HARNESS-STANDARD.md"), "utf-8");
const AUDIT_SHIP = readFileSync(join(SUITE_ROOT, "workflows/ship.js"), "utf-8");
const HEAL_SRC = readFileSync(join(SUITE_ROOT, "workflows/ship-and-heal.js"), "utf-8");

interface AnchorRow {
  anchor: string;
  searched: string;
  source: string;
  verdict: "code" | "comment";
}

function anchorRows(md: string): AnchorRow[] {
  const rows: AnchorRow[] = [];
  for (const line of md.split("\n")) {
    const m = /^\|(.+)\|\s*(code|comment)\s*\|\s*$/.exec(line);
    if (!m) continue;
    // Anchors are code-fenced, and one of them ENDS in a backtick
    // (`await agent(` + "`"), so it is double-fenced. Strip one or two
    // backticks plus CommonMark's optional padding space from each end.
    const cells = m[1]
      .split("|")
      .map(c => c.trim().replace(/^`{1,2} ?/, "").replace(/ ?`{1,2}$/, ""));
    if (cells.length !== 3) continue;
    // The source cell carries a line number for the reader. It is recorded,
    // not asserted: the classification is re-derived from the file on every
    // run, but a line that drifts when ship.js grows a paragraph is not a
    // defect worth turning an unrelated PR red over.
    rows.push({
      anchor: cells[0],
      searched: cells[1],
      source: cells[2].replace(/:\d+$/, ""),
      verdict: m[2] as "code" | "comment",
    });
  }
  return rows;
}

/**
 * Is the first occurrence of `anchor` in `src` inside a comment?
 *
 * Offsets survive `stripJsComments` — comment characters become spaces — so
 * the blanked copy at the same offset answers this exactly.
 */
function resolvesInComment(src: string, anchor: string): boolean | null {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  return stripJsComments(src).slice(i, i + anchor.length) !== anchor;
}

describe("#273: every anchor the suite still uses is classified, and the classification is true", () => {
  const rows = anchorRows(STANDARD_MD);

  test("AUDIT-1: the table classifies at least 18 anchors", () => {
    expect(rows.length).toBeGreaterThanOrEqual(18);
  });

  test("AUDIT-2: every classified anchor resolves where the table says it does", () => {
    const sources: Record<string, string> = {
      "workflows/ship.js": AUDIT_SHIP,
      "workflows/ship-and-heal.js": HEAL_SRC,
    };
    const wrong: string[] = [];
    for (const row of rows) {
      const src = sources[row.source];
      if (!src) {
        wrong.push(`${row.anchor}: unknown source "${row.source}"`);
        continue;
      }
      const inComment = resolvesInComment(src, row.anchor);
      if (inComment === null) {
        wrong.push(`${row.anchor}: not present in ${row.source} at all`);
        continue;
      }
      const actual = inComment ? "comment" : "code";
      if (actual !== row.verdict) wrong.push(`${row.anchor} in ${row.source}: table says ${row.verdict}, resolves to ${actual}`);
    }
    expect(wrong).toEqual([]);
  });

  test("AUDIT-3: every anchor the suite actually uses appears in the table", () => {
    // The table is only an audit if it is complete. Extracting the anchors
    // from the suite rather than listing them here is what keeps a newly
    // added, unclassified anchor from slipping past.
    const suite = readFileSync(join(SUITE_ROOT, SUITE_REL), "utf-8");
    const used = new Set<string>();
    for (const m of suite.matchAll(/(?:SHIP_JS|SHIP_CODE|HEAL_JS)\.(?:lastIndexOf|indexOf)\("((?:[^"\\]|\\.)*)"/g)) {
      used.add(JSON.parse(`"${m[1]}"`));
    }
    for (const m of suite.matchAll(/sliceBetween\((?:SHIP_JS|SHIP_CODE|HEAL_JS),\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g)) {
      used.add(JSON.parse(`"${m[1]}"`));
      used.add(JSON.parse(`"${m[2]}"`));
    }
    expect(used.size).toBeGreaterThanOrEqual(18);
    const classified = new Set(rows.map(r => r.anchor));
    expect([...used].filter(a => !classified.has(a))).toEqual([]);
  });

  test("AUDIT-4: the three anchors #273 calls out by name resolve as recorded", () => {
    // HEAL_JS.indexOf("GRADE") is the live example of the defect this issue is
    // about, still in the suite: it lands on a comment.
    expect(resolvesInComment(HEAL_SRC, "GRADE")).toBe(true);
    // 132 until #1035, which added 22 lines above it: the `test-config` prompt
    // stopped naming the project's config file by path and now runs
    // scripts/resolve-config.ts across the subprocess boundary instead. 154
    // until #1086, which added the 16-line SHELL-QUOTE block above it —
    // ship-and-heal.js builds shell commands and cannot import (#69), so it
    // now carries its own copy of `shellQuote`. The number moving is the
    // point of the arm — it records WHERE a comment-resolving anchor lands,
    // so an edit anywhere above it has to be noticed.
    expect(HEAL_SRC.slice(0, HEAL_SRC.indexOf("GRADE")).split("\n").length).toBe(170);
    expect(resolvesInComment(HEAL_SRC, "'SHIPPED'")).toBe(false);
    expect(resolvesInComment(HEAL_SRC, "label: 'remediate'")).toBe(false);
  });
});
