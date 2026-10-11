import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { harnessRoot } from "../lib/paths";

/**
 * #273 — the six phase-ordering checks could not fail on the thing they
 * describe.
 *
 * PO-1..PO-6 in test/spec-compliance.test.ts located their anchors with
 * `indexOf` over the RAW text of workflows/ship.js, and five of the eight
 * strings they looked for — the `PHASE n:` banners and `create-pr` — occur in
 * that file only inside comments. Three of the six therefore compared one
 * comment to another. Run wf_61a6af0d-053 on #254 went red on two of them and
 * was right to. Measured before the fix: gutting the PR step out of ship.js
 * while leaving its comment in place left all six green (6 pass, 0 fail)
 * against a harness with zero `pr-upsert` call sites.
 *
 * This file is the positive control .claude/rules/checks-must-be-able-to-fail.md
 * asks for, and the mutation is on the DATA rather than on the checking code:
 * the six checks are spawned unchanged against a MUTANT HARNESS ROOT whose
 * workflows/ship.js has been damaged, with every other path symlinked back to
 * the real tree. Three properties make it work, all asserted rather than left
 * as conventions:
 *
 *  - **The checks are observed running.** A `-t` filter that matches nothing
 *    leaves bun reporting zero failures, which is indistinguishable from six
 *    passes — and is also what a spawn that died on module resolution looks
 *    like. Every case goes through `ran === 6` first.
 *  - **The mutation is observed landing.** Each case asserts what it did to
 *    the source — the token is gone, or still present exactly once and now
 *    after the thing it used to precede — so a mutation that silently no-ops
 *    cannot read as "the check caught it".
 *  - **Comments are left alone.** Every MOVE case relocates real code and
 *    asserts the comment-only tokens stay in their original order, so a check
 *    that goes red here is a check reading code. The banner-reword case is the
 *    other half: comments scrambled, all six still green.
 */

const SOURCE_ROOT = harnessRoot();
const SPEC_SUITE = join(import.meta.dir, "spec-compliance.test.ts");
const SHIP_REL = "workflows/ship.js";
const SHIP_SRC = readFileSync(join(SOURCE_ROOT, SHIP_REL), "utf-8");

/** Tokens that exist in ship.js ONLY inside comments. */
const COMMENT_ONLY = [
  "PHASE 4: IMPLEMENT",
  "PHASE 5: VALIDATE",
  "PHASE 6: COMMIT",
  "PHASE 7: VERIFY",
  "PHASE 8: SHIP",
  "PHASE 9: PROVE",
  "create-pr",
];

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

// ── building a mutant harness root ──────────────────────────────────────────

/**
 * A harness root that IS the real tree except for workflows/ship.js. Nothing
 * is written inside the repo: every other entry is a symlink, so the spawned
 * suite reads the real specs, prompts and sibling workflows and differs from a
 * clean run in exactly one file.
 */
function mutantRoot(mutate: (src: string) => string): { root: string; src: string } {
  const dir = mkdtempSync(join(tmpdir(), "po-mutant-"));
  scratch.push(dir);
  const root = join(dir, "root");
  mkdirSync(root);

  for (const entry of readdirSync(SOURCE_ROOT)) {
    if (entry === "workflows") continue;
    symlinkSync(join(SOURCE_ROOT, entry), join(root, entry));
  }
  mkdirSync(join(root, "workflows"));
  for (const f of readdirSync(join(SOURCE_ROOT, "workflows"))) {
    if (f === "ship.js") continue;
    symlinkSync(join(SOURCE_ROOT, "workflows", f), join(root, "workflows", f));
  }

  const src = mutate(SHIP_SRC);
  if (src === SHIP_SRC) {
    throw new Error("could not build the mutant: the mutation changed nothing in workflows/ship.js");
  }
  writeFileSync(join(root, SHIP_REL), src);
  return { root, src };
}

// ── running the six checks ──────────────────────────────────────────────────

interface Reading {
  ran: number;
  red: Set<string>;
  output: string;
}

function runOrdering(root: string): Reading {
  const r = spawnSync("bun", ["test", SPEC_SUITE, "-t", "PO-"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, HARNESS_ROOT: root },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const red = new Set<string>();
  for (const m of output.matchAll(/\(fail\)[^\n]*?\b(PO-[1-6])\b/g)) red.add(m[1]!);
  return { ran: count("pass") + count("fail"), red, output };
}

/** Every case goes through this: six checks executed, or the reading is void. */
function expectRanAllSix(reading: Reading): void {
  expect(reading.ran, `expected the six ordering checks to run; output was:\n${reading.output}`).toBe(6);
}

/** The comment-only tokens, in the order they appear in a source. */
function commentOrder(src: string): string[] {
  return [...COMMENT_ONLY].sort((a, b) => src.indexOf(a) - src.indexOf(b));
}

const REAL_COMMENT_ORDER = commentOrder(SHIP_SRC);

// ── mutations ───────────────────────────────────────────────────────────────

/** Delete the line a token sits on and append it, verbatim, at the end. */
function relocateLine(src: string, token: string): string {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l.includes(token));
  if (at < 0) throw new Error(`could not build the mutant: no line holds ${token}`);
  const [line] = lines.splice(at, 1);
  lines.push(`${line}`);
  return lines.join("\n");
}

/** Delete the line a token sits on. */
function deleteLine(src: string, token: string): string {
  const lines = src.split("\n");
  const kept = lines.filter((l) => !l.includes(token));
  if (kept.length === lines.length) throw new Error(`could not build the mutant: no line holds ${token}`);
  return kept.join("\n");
}

/**
 * The eight executable anchors, spelled out in a comment at the TOP of the
 * file in the wrong order and changing no code at all.
 *
 * This is the case that makes the comment stripper load-bearing rather than
 * decorative. Every other mutation here is caught with or without it, because
 * no comment in today's ship.js happens to contain any of the eight anchors —
 * and "today" is the whole problem: #273 exists because a token that reads
 * like code was matched inside prose. A raw `indexOf` resolves every anchor
 * below into this block and reads the orderings backwards.
 */
function impersonatingComment(src: string): string {
  const spelled = [
    "phase('Prove')",
    "log('Running ship gate')",
    "pr-upsert",
    "label: 'quinn-container'",
    "phase('Verify')",
    "phase('Commit')",
    "phase('Validate')",
    "phase('Implement')",
  ]
    .map((a) => `//   ${a}`)
    .join("\n");
  return `// #273 impersonation mutant — prose naming every anchor, in reverse:\n${spelled}\n${src}`;
}

/**
 * Reword every `PHASE n:` banner where it stands and move the originals to the
 * bottom of the file in reverse order — comments scrambled, code untouched.
 */
function rewordAndMoveBanners(src: string): string {
  let out = src;
  for (const banner of COMMENT_ONLY.filter((t) => t.startsWith("PHASE "))) {
    out = out.replace(banner, `step ${banner.slice(6, 7)} — reworded by the #273 mutation harness`);
  }
  const relocated = [...COMMENT_ONLY.filter((t) => t.startsWith("PHASE "))]
    .reverse()
    .map((b) => `// ${b}`)
    .join("\n");
  return `${out}\n${relocated}\n`;
}

// ── the baseline ────────────────────────────────────────────────────────────

describe("ship-phase-ordering-mutation: the six checks read code, not comments", () => {
  test("BASELINE: all six pass against the unmutated source", () => {
    const reading = runOrdering(SOURCE_ROOT);
    expectRanAllSix(reading);
    expect([...reading.red]).toEqual([]);
  }, 120000);

  test("PR-STEP-DELETION: deleting the pr-upsert step turns the PR orderings red", () => {
    // The measurement that opened #273, performed rather than described: the
    // step is gone, its `create-pr` comment is not, and the checks that claim
    // to order the PR against the container and the ship gate now have nothing
    // to order. Before the fix this printed 6 pass, 0 fail.
    const { root, src } = mutantRoot((s) => deleteLine(s, "pr-upsert"));
    expect(src).not.toContain("pr-upsert");
    expect(src, "the comment the old checks anchored on must survive").toContain("create-pr");

    const reading = runOrdering(root);
    expectRanAllSix(reading);
    expect(
      reading.red.size,
      `expected at least two ordering checks red; red was [${[...reading.red]}]\n${reading.output}`,
    ).toBeGreaterThanOrEqual(2);
    expect([...reading.red].sort()).toEqual(["PO-3", "PO-4"]);
  }, 120000);

  test("BANNER-REWORD: rewording and moving the phase banners leaves all six green", () => {
    // The other direction, and the reason the first result is meaningful: the
    // checks are now indifferent to comments. Measured against the pre-fix
    // suite, this same mutant was red on three of six — PO-1, PO-2 and PO-6,
    // exactly the three whose both anchors were comments.
    const { root, src } = mutantRoot(rewordAndMoveBanners);
    expect(src).toContain("reworded by the #273 mutation harness");
    expect(
      src.indexOf("PHASE 9: PROVE"),
      "the relocated banners must be out of order, or this proves nothing",
    ).toBeLessThan(src.indexOf("PHASE 4: IMPLEMENT"));

    const reading = runOrdering(root);
    expectRanAllSix(reading);
    expect([...reading.red]).toEqual([]);
  }, 120000);

  test("ANCHOR-IMPERSONATION: a comment spelling every anchor backwards changes nothing", () => {
    // The stripper's own positive control. Short-circuiting `stripJsComments`
    // to the identity leaves every other case in this file green — no comment
    // in ship.js happens to contain one of the eight anchors — so without this
    // case the stripper would be an unproven dependency of the thing that is
    // supposed to prove things.
    const { root, src } = mutantRoot(impersonatingComment);
    expect(src.endsWith(SHIP_SRC), "the mutation must add comments and change no code").toBe(true);
    expect(src.indexOf("phase('Prove')")).toBeLessThan(src.indexOf("phase('Implement')"));

    const reading = runOrdering(root);
    expectRanAllSix(reading);
    expect([...reading.red]).toEqual([]);
  }, 120000);
});

// ── one relocation per ordering ─────────────────────────────────────────────

/**
 * Relocate one EXECUTABLE token to the end of ship.js and assert the ordering
 * that describes it goes red. Three things are checked before the verdict is
 * believed, and each of them is a way this case could otherwise pass for a
 * reason that has nothing to do with the check working:
 *
 *  - the token still appears as often as it did, so this is a relocation and
 *    not a deletion;
 *  - the comment-only tokens are in their original order, so the red cannot
 *    be a check noticing a moved banner;
 *  - all six checks ran.
 *
 * The six cases are written out one at a time rather than generated from a
 * table so that each `MOVE-n` is a greppable literal in this file — a loop
 * would make the names exist only at runtime.
 */
function expectRelocationCaught(token: string, reds: string): void {
  const { root, src } = mutantRoot((s) => relocateLine(s, token));

  expect(src.split(token).length - 1, `${token} occurrences in the mutant`).toBe(
    SHIP_SRC.split(token).length - 1,
  );
  expect(commentOrder(src), "the mutation must not have touched a comment").toEqual(REAL_COMMENT_ORDER);

  const reading = runOrdering(root);
  expectRanAllSix(reading);
  expect(
    reading.red.has(reds),
    `${reds} should be red after relocating ${token}; red was [${[...reading.red]}]\n${reading.output}`,
  ).toBe(true);
}

describe("ship-phase-ordering-mutation: relocating the code, never its comment", () => {
  test("MOVE-1: PO-1 goes red when phase('Validate') is moved after Commit", () => {
    expectRelocationCaught("phase('Validate')", "PO-1");
  }, 120000);

  test("MOVE-2: PO-2 goes red when phase('Commit') is moved after Verify", () => {
    expectRelocationCaught("phase('Commit')", "PO-2");
  }, 120000);

  test("MOVE-3: PO-3 goes red when the container Quinn call is moved after the PR", () => {
    expectRelocationCaught("label: 'quinn-container'", "PO-3");
  }, 120000);

  test("MOVE-4: PO-4 goes red when the pr-upsert call is moved after the ship gate", () => {
    expectRelocationCaught("pr-upsert", "PO-4");
  }, 120000);

  test("MOVE-5: PO-5 goes red when the ship gate call is moved after Prove", () => {
    expectRelocationCaught("log('Running ship gate')", "PO-5");
  }, 120000);

  test("MOVE-6: PO-6 goes red when phase('Implement') is moved after Validate", () => {
    expectRelocationCaught("phase('Implement')", "PO-6");
  }, 120000);
});
