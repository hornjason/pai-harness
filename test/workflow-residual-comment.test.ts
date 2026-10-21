/**
 * #955 and #957 — the two things #956 left behind, worked together because
 * they are one question asked from opposite ends: does the comment block that
 * explains a top-level key end up next to that key, on a consumer whose file
 * the merge is editing rather than creating.
 *
 * ## #955 — a generated-only `on:` sub-key must not separate the two
 *
 * #942 emits a column-zero comment block immediately above `concurrency:`.
 * Before #956 that run lived in the SECTION ABOVE IT, so #917's sub-key merge
 * appended a generated-only `on:` sub-key after it and the block was left
 * introducing a trigger it says nothing about.
 *
 * **Measured on `origin/main` at b3ee1269: #955 no longer reproduces.** #956's
 * `splitIntroducingComment` moves that run onto the key it introduces before
 * `mergeTopLevelSection` ever sees the section, so the appended sub-key lands
 * above it. The cases below are a regression pin, not a fix: they fail on the
 * pre-#956 reader and pass on this one, and nothing else in the tree asserts
 * the interaction between the sub-key merge and the introducing-comment split.
 *
 * ## #957 — the residue a consumer is still holding
 *
 * #956 deliberately leaves a section the consumer ALREADY has untouched,
 * comments included (its AC-2), which is #917's precedent one level up and is
 * right: a comment is the consumer's statement about their own file. So a
 * consumer who took `concurrency:` through the #941 defect holds the bare key
 * for ever — no re-scaffold can give them the thirteen lines saying why
 * `cancel-in-progress` is an expression and not `true`.
 *
 * The discriminator is PROVENANCE, not presence. The caller knows whether the
 * file on disk still hashes to the digest the harness stamped on it; if it
 * does, the harness wrote those bytes and the bare key is its own residue
 * rather than the consumer's choice.
 *
 * ### The cheapest wrong fix, named before the repair
 *
 * **Insert the generated block wherever the key has no comment above it.** One
 * condition, it repairs this repository, and it re-imposes a comment on every
 * consumer who deliberately DELETED one — every run, with no way to opt out.
 * AC-2's three arms are what refuse it: a file with no marker, a file whose
 * marker no longer matches its body, and a file carrying the consumer's own
 * commentary all have to come back unchanged. The first two go green under
 * that repair.
 *
 * ### Witnesses and controls
 *
 * Say which, or the next reader counts twelve.
 *
 * - **Witnesses** — red before the repair, green after: the two #955 cases,
 *   AC-1's merge case, AC-2's end-to-end stamped arm, AC-3's two cases and
 *   AC-4.
 * - **Controls** — green on BOTH sides by construction, and evidence of
 *   nothing on their own: the two fixture cases, AC-2's unstamped,
 *   stale-marker and consumer-commentary arms. They exist to stop a repair
 *   that injects unconditionally from reading as a repair that proves
 *   anything, and there is no state of the code in which they go red for the
 *   original defect.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file (12) plus `workflow-added-section-comment`
 * (10) — #941's battery is in scope because #957 must not loosen its AC-2.
 * Every count was predicted before the battery ran — the predictions are the
 * `Predicted` column below, written down first — and **the baseline row was
 * read before any mutation row**: an instrument that has stopped reporting takes
 * the baseline down with it, and that is the row nobody mutates anything to
 * produce. All six matched, so the rows below name WHICH cases went red
 * rather than only how many — a count correct about the wrong assertion is
 * not coverage.
 *
 * | Row | Predicted | Measured | Which cases, and the input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 22 pass, 0 fail | **22 pass, 0 fail** | — |
 * | `restorableIntro` short-circuited to `return []` — the pre-#957 behaviour | 4 | **4 of 22** | #957 AC-1 ×2, AC-3 block-count, AC-4. `{VERIFIED, consumerIntro: [], generatedIntro: ["# x"]}`: original returns `["# x"]`, mutant `[]` |
 * | **the cheapest wrong fix**: the provenance guard removed, so a key with no comment gets one whatever the marker says | 3 | **3 of 22** | #957 AC-2 no-marker and stale-marker, **and #941 AC-2's not-injected case**. `{UNPROVEN, consumerIntro: [], generatedIntro: ["# x"]}`: original `[]`, mutant `["# x"]` |
 * | the `consumerIntro` guard removed | 3 | **3 of 22** | #957 AC-2 commentary, AC-3 ×2. `{VERIFIED, consumerIntro: ["# mine"], generatedIntro: ["# x"]}`: original `[]`, mutant `["# x"]` — and on run 2 the block it wrote is the commentary it then writes past |
 * | `proven` hardcoded to `"VERIFIED"` in `writeManagedFile` | 2 | **2 of 22** | #957 AC-2 no-marker and stale-marker. An unstamped rewind: original reads UNPROVEN, mutant VERIFIED |
 * | `proven` hardcoded to `"UNPROVEN"` | 3 | **3 of 22** | #957 AC-1 end-to-end, AC-3 block-count, AC-4. A stamped rewind, mirrored. AC-1's merge case stays green — it passes the reading by hand, which is why the end-to-end arm exists beside it |
 * | `splitIntroducingComment` short-circuited to `return [lines, []]` — the genuinely pre-#956 reader | 9 | **9 of 22** | #955's adjacency case; #957 AC-1 ×2, AC-3 block-count, AC-4; #941 AC-1 ×2, AC-3, AC-4 block-once. The #955 fixture: original leaves the 13-line block above `concurrency:`, mutant leaves it empty |
 *
 * The last row is what makes #955's two cases witnesses rather than
 * decoration: the defect is fixed, so only reinstating the pre-#956 reader
 * can redden them, and it does. #955's second case is a control — a merge
 * that simply failed to append the sub-key would satisfy the adjacency
 * assertion perfectly, and that control stays green under every row.
 *
 * None of the six mutations is left in the tree; all were run and reverted,
 * and `lib/scaffold/managed-workflow.ts` and `lib/scaffold/steps.ts` were
 * confirmed byte-identical to the measured source afterwards by sha256.
 *
 * **Provenance.** Measured twice. First on the branch as originally written,
 * then **re-measured in full after rebasing onto #952/#959** — which landed in
 * the generated `concurrency:` block itself, rewriting its comment from 13
 * lines to 18 and keying a push on its own sha. All six rows and the baseline
 * reproduce exactly, same counts and the same named cases. A row measured on a
 * tree nobody can check out is a claim rather than a count
 * (`.claude/rules/parallel-sessions.md`), and a rebase retires the tree a row
 * was taken on as surely as a new commit does. Nothing here spells a line of
 * that block: every expectation is read off the real render, so #959 moved
 * both sides of every comparison and no assertion needed editing.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { mergeManagedWorkflow, topLevelKeyOrder } from "../lib/scaffold/managed-workflow";
import { createCiWorkflows } from "../lib/scaffold/steps";
import { stampWorkflow, workflowBody, workflowCensus } from "../lib/scaffold/workflow-census";

const REPO_ROOT = join(import.meta.dir, "..");

// ── readers of this file's own, deliberately ───────────────────────────────
//
// Nothing below calls `splitTopLevel`. A case that reads its subject with the
// subject's own reader agrees with it by construction and cannot witness a
// change to it (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).

/** The line index of a top-level key, or -1. */
function keyLine(text: string, key: string): number {
  return text.split("\n").findIndex(l => l === `${key}:` || l.startsWith(`${key}: `));
}

/**
 * The contiguous run of column-zero `#` lines immediately above a top-level
 * key — the block that introduces it, with no blank line in between.
 *
 * A run reaching line zero is the managed banner. It introduces the FILE, not
 * the first key, and the merge replaces it wholesale.
 */
function commentBlockAbove(text: string, key: string): string[] {
  const lines = text.split("\n");
  const at = keyLine(text, key);
  if (at < 0) throw new Error(`no top-level \`${key}:\` in the workflow`);
  let from = at;
  while (from > 0 && lines[from - 1].startsWith("#")) from--;
  return from === 0 ? [] : lines.slice(from, at);
}

/** The same text with a key's introducing comment block removed. */
function withoutCommentBlockAbove(text: string, key: string): string {
  const lines = text.split("\n");
  const at = keyLine(text, key);
  const block = commentBlockAbove(text, key);
  return [...lines.slice(0, at - block.length), ...lines.slice(at)].join("\n");
}

/**
 * The span of one top-level section, ended the way YAML ends it.
 *
 * A COMMENT does not close a block mapping at any column, so a reader that
 * stops at the first column-zero line reports the sub-keys after it absent
 * when they are not — which is #955's own note about the detection being the
 * more useful half. Terminating on a column-zero line that is NOT a comment is
 * what the parser under test does.
 */
function sectionRegion(text: string, key: string): string[] {
  const lines = text.split("\n");
  const start = keyLine(text, key);
  if (start < 0) throw new Error(`no top-level \`${key}:\` in the workflow`);
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (/^\S/.test(lines[end]) && !lines[end].startsWith("#")) break;
  }
  return lines.slice(start, end);
}

/** Sub-key names declared directly under a top-level key. */
function subKeysOf(text: string, key: string): string[] {
  const body = sectionRegion(text, key).slice(1);
  let base = -1;
  for (const l of body) {
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    const indent = l.length - l.trimStart().length;
    if (indent > 0 && (base < 0 || indent < base)) base = indent;
  }
  if (base < 0) return [];
  return body
    .filter(l => l.length - l.trimStart().length === base && /^[A-Za-z0-9_.\-]+:(\s|$)/.test(l.trim()))
    .map(l => l.trim().replace(/:.*$/, ""));
}

/** A sub-key and the indented comment run introducing it, removed. */
function withoutSubKey(text: string, key: string, sub: string): string {
  const lines = text.split("\n");
  const start = keyLine(text, key);
  const at = lines.findIndex((l, i) => i > start && l.trim() === `${sub}:`);
  if (at < 0) throw new Error(`no \`${key}.${sub}\` in the workflow`);
  let from = at;
  while (from > 0 && lines[from - 1].trimStart().startsWith("#") && lines[from - 1].trim() !== "") from--;
  return [...lines.slice(0, from), ...lines.slice(at + 1)].join("\n");
}

// ── driving the real generator ─────────────────────────────────────────────

/** The ci.yml a fresh scaffold writes into an empty repository, marker off. */
function freshRender(): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-955-fresh-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    createCiWorkflows(root, []);
    return workflowBody(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface Scaffolded {
  /** Only the `ci.yml` lines of the scaffold's action log. */
  actions: string[];
  /** The bytes on disk afterwards, marker included. */
  raw: string;
  /** Those bytes with the provenance marker removed. */
  body: string;
  /** What the census makes of the file BEFORE the scaffold ran. */
  provenanceBefore: string;
}

/**
 * Put `ciYml` on disk in a scratch repository and re-scaffold over it.
 *
 * End to end on purpose. The merge takes the provenance reading as an
 * argument, so a case that passes it by hand asserts the merge honours the
 * reading — not that the reading is computed from the right bytes, which is
 * where #957's whole discrimination lives.
 */
function scaffoldOver(ciYml: string, configFrom?: string): Scaffolded {
  const root = mkdtempSync(join(tmpdir(), "rungate-957-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    if (configFrom !== undefined) {
      cpSync(join(configFrom, ".claude", "rungate"), join(root, ".claude", "rungate"), { recursive: true });
    }
    const path = join(root, ".github", "workflows", "ci.yml");
    writeFileSync(path, ciYml);
    const before = workflowCensus(root).files.find(f => f.name === "ci.yml")?.status ?? "ABSENT";
    const actions: string[] = [];
    createCiWorkflows(root, actions);
    const raw = readFileSync(path, "utf-8");
    return {
      actions: actions.filter(a => a.includes("ci.yml")),
      raw,
      body: workflowBody(raw),
      provenanceBefore: before,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const GENERATED = freshRender();

/** Top-level keys the generator introduces with a column-zero comment block. */
const COMMENTED = topLevelKeyOrder(GENERATED).filter(k => commentBlockAbove(GENERATED, k).length > 0);

/** The first such key, and the one both issues are measured on. */
const KEY = COMMENTED[0];

// ── the fixture, before anything is concluded from it ──────────────────────

describe("#955/#957 the fixture: the generated template carries what these cases measure", () => {
  test("a top-level key is introduced by a column-zero comment block, and an `on:` sub-key precedes it", () => {
    // Without this every comparison below holds vacuously over empty arrays:
    // a template whose keys carry no comments agrees with a merge that drops
    // every comment, and with one that never restores any.
    expect(COMMENTED.length, "no top-level key in the generated workflow has a comment above it").toBeGreaterThan(0);
    expect(subKeysOf(GENERATED, "on").length, "the generated `on:` declares no sub-keys to rewind").toBeGreaterThan(1);
    expect(keyLine(GENERATED, KEY), `\`${KEY}:\` does not sit after \`on:\``).toBeGreaterThan(keyLine(GENERATED, "on"));
  });

  test("rewinding the fixture really removes what the merge is being asked to put back", () => {
    const sub = subKeysOf(GENERATED, "on")[0];
    expect(subKeysOf(withoutSubKey(GENERATED, "on", sub), "on"), "the sub-key survived the rewind").not.toContain(sub);
    expect(
      commentBlockAbove(withoutCommentBlockAbove(GENERATED, KEY), KEY),
      `\`${KEY}:\`'s block survived the rewind, so AC-1 would pass without the fix`,
    ).toEqual([]);
  });
});

// ── #955 ───────────────────────────────────────────────────────────────────

describe("#955: a generated-only `on:` sub-key does not separate a block from the key it introduces", () => {
  test("the block above the next top-level key is still the generator's, and still adjacent", () => {
    // The defect, exactly: the appended sub-key lands between the block and
    // the key, so the reader above finds the block empty. Not "the text is
    // somewhere in the file" — adjacency IS the property.
    const sub = subKeysOf(GENERATED, "on")[0];
    const before = withoutSubKey(GENERATED, "on", sub);
    const merged = mergeManagedWorkflow(before, GENERATED);

    expect(
      commentBlockAbove(merged, KEY),
      `an appended \`on.${sub}\` orphaned the block introducing \`${KEY}:\``,
    ).toEqual(commentBlockAbove(GENERATED, KEY));
  });

  test("the sub-key is nevertheless inside `on:`, which is what makes the orphaning possible", () => {
    // The control for the case above. A merge that simply failed to append
    // the sub-key would satisfy the adjacency assertion perfectly.
    const sub = subKeysOf(GENERATED, "on")[0];
    const merged = mergeManagedWorkflow(withoutSubKey(GENERATED, "on", sub), GENERATED);
    expect(subKeysOf(merged, "on"), `the merge did not append \`on.${sub}\` at all`).toContain(sub);
  });
});

// ── #957 ───────────────────────────────────────────────────────────────────

describe("#957 AC-1: a section the harness can prove it wrote, with no commentary, gets the block", () => {
  test("the restored block is the generator's own, byte for byte", () => {
    const before = withoutCommentBlockAbove(GENERATED, KEY);
    const merged = mergeManagedWorkflow(before, GENERATED, [], "VERIFIED");

    expect(
      commentBlockAbove(merged, KEY),
      `a provable \`${KEY}:\` did not get the block introducing it back`,
    ).toEqual(commentBlockAbove(GENERATED, KEY));
  });

  test("end to end, a file whose marker still matches its body gets it", () => {
    const rewound = withoutCommentBlockAbove(GENERATED, KEY);
    const run = scaffoldOver(stampWorkflow(rewound));

    expect(run.provenanceBefore, "the stamped fixture is not what the census calls harness-written").toBe(
      "generated-and-unchanged",
    );
    expect(run.actions.filter(a => a.startsWith("REFUSED")), "the repair refused the write").toEqual([]);
    expect(commentBlockAbove(run.body, KEY)).toEqual(commentBlockAbove(GENERATED, KEY));
  });
});

describe("#957 AC-2: a section the harness cannot prove, or one the consumer has annotated, is untouched", () => {
  test("no marker at all: the block does not arrive", () => {
    // The arm that refuses the cheapest wrong fix. This file is exactly as
    // comment-less as the stamped one above and differs in one thing only.
    const rewound = withoutCommentBlockAbove(GENERATED, KEY);
    const run = scaffoldOver(rewound);

    expect(run.provenanceBefore, "the unstamped fixture carries a marker after all").toBe("NOT-OWNED");
    expect(
      commentBlockAbove(run.body, KEY),
      `the harness wrote its own commentary into a \`${KEY}:\` it cannot prove it authored`,
    ).toEqual([]);
  });

  test("a marker that no longer matches the body: the block does not arrive", () => {
    // The other half of unprovable, and the one a boolean "has a marker"
    // reading gets wrong. The file says the harness wrote it; the digest says
    // somebody has been in it since.
    const rewound = withoutCommentBlockAbove(GENERATED, KEY);
    const stale = stampWorkflow(rewound).replace(/^(# generated-sha: )[0-9a-f]{16}$/m, "$1" + "f".repeat(16));
    const run = scaffoldOver(stale);

    expect(run.provenanceBefore, "the stale fixture is not what the census calls hand-edited").toBe(
      "generated-and-hand-edited",
    );
    expect(commentBlockAbove(run.body, KEY), "a hand-edited file received the generator's commentary").toEqual([]);
  });

  test("the consumer's own comment survives, unchanged and not joined by the generator's", () => {
    // #917's precedent, one level up. Provable provenance is necessary and not
    // sufficient: the consumer has written something about this key, and a
    // harness that overwrites it is the data loss #216 exists to prevent.
    const mine = ["# Ours. Raised with the platform team, do not revert.", "# See INFRA-4412."];
    const rewound = withoutCommentBlockAbove(GENERATED, KEY)
      .split("\n")
      .flatMap(l => (l === `${KEY}:` ? [...mine, l] : [l]))
      .join("\n");
    const run = scaffoldOver(stampWorkflow(rewound));

    expect(commentBlockAbove(run.body, KEY), "the consumer's own commentary was replaced or added to").toEqual(mine);
    expect(run.body, "the generator's block was merged in beside the consumer's").not.toContain(
      commentBlockAbove(GENERATED, KEY)[0],
    );
  });
});

describe("#957 AC-3: idempotent — written once, and the run after it is a byte-identical no-op", () => {
  test("the second scaffold writes nothing: SKIP, same bytes, no refusal", () => {
    // The inverse defect, and the one that bites. A repair that re-derives the
    // block each run appends a copy per upgrade — the key has a comment from
    // the second run onward and nothing strips the previous one.
    const rewound = withoutCommentBlockAbove(GENERATED, KEY);
    const first = scaffoldOver(stampWorkflow(rewound));
    const second = scaffoldOver(first.raw);

    expect(second.raw, "the second scaffold moved bytes").toBe(first.raw);
    expect(second.actions.some(a => a.startsWith("SKIP:")), `the second scaffold is not a no-op: ${second.actions.join(" | ")}`).toBe(true);
    expect(second.actions.filter(a => a.startsWith("REFUSED")), "the repaired file is refused by the run after it").toEqual([]);
  });

  test("the block appears exactly once, however many times the scaffold runs", () => {
    const rewound = withoutCommentBlockAbove(GENERATED, KEY);
    const first = commentBlockAbove(GENERATED, KEY)[0];
    const twice = scaffoldOver(scaffoldOver(stampWorkflow(rewound)).raw);
    const count = twice.body.split("\n").filter(l => l === first).length;

    expect(count, `\`${KEY}:\`'s block appears ${count} times after two scaffolds`).toBe(1);
  });
});

describe("#957 AC-4: measured on this repository's own ci.yml, which is the live instance", () => {
  test("re-scaffolding this repository's workflow leaves the key introduced by the generator's block", () => {
    // The live instance, rewound rather than read. Once the repair lands here
    // the file carries the block, and a case asserting "it is bare today"
    // would stop witnessing anything the moment it worked. Rewinding keeps it
    // a witness for as long as the file is the harness's.
    const onDisk = join(REPO_ROOT, ".github", "workflows", "ci.yml");
    expect(existsSync(onDisk), "this repository has no ci.yml to measure").toBe(true);

    const census = workflowCensus(REPO_ROOT).files.find(f => f.name === "ci.yml");
    expect(
      census?.status,
      "this repository's ci.yml is no longer harness-written, so it is not the instance #957 measured",
    ).toBe("generated-and-unchanged");

    const body = workflowBody(readFileSync(onDisk, "utf-8"));
    const rewound = withoutCommentBlockAbove(body, KEY);
    const run = scaffoldOver(stampWorkflow(rewound), REPO_ROOT);

    expect(run.actions.filter(a => a.startsWith("REFUSED")), "the live instance refuses the repair").toEqual([]);
    expect(
      commentBlockAbove(run.body, KEY),
      `this repository's \`${KEY}:\` is still bare after a re-scaffold`,
    ).toEqual(commentBlockAbove(GENERATED, KEY));
  });
});
