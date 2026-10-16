/**
 * #296: the collection claim guard refuses three different things, and only
 * one of them is the bug SC-413 was written for.
 *
 * Two #274 runs died in the collector, ~75 minutes and 4,855 lines of
 * validated work on the floor, over three filenames:
 *
 *   wf_0b15a933-b2b  project-state.json                  CLAUDE.md told the agent to write it
 *   wf_536df065-969  .claude/conformity-allowlists.json   the pre-push hook REQUIRES writing it
 *   wf_536df065-969  gates/workflow.test.ts               genuine scope creep — correctly refused
 *
 * The second run carried an explicit prohibition naming project-state.json. It
 * worked, and the run then died on two filenames nobody had thought to
 * prohibit. Enumerating prohibitions in prose is a treadmill: the claim is
 * written from the decomposition plan (ship.js, `claimedFiles:
 * r.subIssue?.filesToModify`) BEFORE the work exists, so it cannot anticipate
 * a file the repo's own tooling demands every contributor touch.
 *
 * So the fix is not a bigger prohibition list in a prompt, it is two ownership
 * classes in the guard itself, and the whole point of this file is that the
 * three cases stay DIFFERENT:
 *
 *   1. CO-OWNED  — a shared registry no plan can claim in advance. One writer
 *                  per run is collectable; two writers is a refusal, because
 *                  collection copies whole files and the loser's entries
 *                  vanish silently.
 *   2. DA-OWNED  — project-state.json, PROJECT-STATE.md, SUCCESS.md. No
 *                  worktree may write them at all, claim or no claim, lone
 *                  worktree or not. The refusal has to say WHY, or the next
 *                  agent reads CLAUDE.md and does it again.
 *   3. UNCLAIMED — scope creep. SC-413 exists for exactly this and MUST KEEP
 *                  REFUSING. A change that makes all three pass is wrong, so
 *                  the gates/workflow.test.ts replay below is the primary
 *                  correctness constraint of this file, not an afterthought.
 *
 * And one fail-open living inside the guard itself: when `claimedFiles` is
 * absent on EVERY result the ownership map is empty, so `claimant` is null for
 * every path and the old `claimant === null || claimant === wt` fallthrough
 * KEPT EVERYTHING. A decomposition that emitted no claims silently disabled
 * SC-413. That is shape 1 of .claude/rules/checks-must-be-able-to-fail.md —
 * fail-open error handling — and the mutant at the bottom of this file
 * restores the fallthrough and watches it keep every file the real block
 * refuses. Real red, mutant green, one input.
 *
 * Marker extraction rather than import: ship.js runs in the Workflow sandbox
 * and is not a module (#69). Same technique, and the same reason, as
 * test/collect-claim-enforcement.test.ts — "ship.js contains the string
 * DA_OWNED_FILES" stays true after the set stops being consulted.
 *
 * What was broken to prove it, run and COUNTED rather than asserted, over
 * test/collect-claim-enforcement.test.ts + this file (64 tests). None is left
 * in the tree; all were run and reverted:
 *
 *   | Mutation                                             | Red     |
 *   |------------------------------------------------------|---------|
 *   | the claimant-null fallthrough restored in ship.js    | 8 of 64 |
 *   | `DA_OWNED_FILES` emptied                             | 6 of 64 |
 *   | `CO_OWNED_FILES` emptied                             | 4 of 64 |
 *   | `writers.length === 1` widened to `>= 1`             | 3 of 64 |
 *   | `claimPermits` renamed                               | 0 of 64 |
 *
 * That last row is reported rather than hidden, and it is not a gap: the
 * mutation binding here is the permission EXPRESSION, not the function name,
 * so a rename moves the single site without changing it. Row 1 is the one that
 * proves the harness aborts rather than no-ops — restoring the fallthrough in
 * the real source makes the signature appear zero times, and every
 * mutant-building case throws "could not build the mutant" instead of passing
 * quietly.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const PROJECT = "/Users/dev/proj";
const WT_A = `${PROJECT}/.claude/worktrees/wf_a`;
const WT_B = `${PROJECT}/.claude/worktrees/wf_b`;
const WT_C = `${PROJECT}/.claude/worktrees/wf_c`;
const WT_D = `${PROJECT}/.claude/worktrees/wf_d`;

/** The shared registry the pre-push hook makes every contributor write. */
const ALLOWLISTS = ".claude/conformity-allowlists.json";
const DA_OWNED = ["project-state.json", "PROJECT-STATE.md", "SUCCESS.md"];

interface Violation {
  worktreePath: string;
  path: string;
  claimant: string | null;
  detail: string;
}

interface ClaimAudit {
  violations: Violation[];
  candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
}

type Audit = (results: unknown) => ClaimAudit;

/** Slice a marked block out of ship.js. */
function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

const claimSource = block("COLLECT-CLAIM");

function loadAudit(source: string = claimSource): Audit {
  // SECURITY-HELPERS carries the path-safety decider the audit calls (#400),
  // and is loaded UNMUTATED even when `source` is a mutant, so a mutant can
  // never die on a missing `pathRefusal` and read as the mutation working.
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${block("SECURITY-HELPERS")}\n${source}\nreturn auditWorktreeClaims`,
  )("/repo", () => {}) as Audit;
}

const auditWorktreeClaims = loadAudit();

/** Every violation's path, sorted, for comparisons that do not care about order. */
const paths = (a: ClaimAudit) => a.violations.map(v => v.path).sort();
const keptBy = (a: ClaimAudit, wt: string) =>
  a.candidates.find(c => c.worktreePath === wt)?.filesChanged ?? [];
const allKept = (a: ClaimAudit) => a.candidates.flatMap(c => c.filesChanged).sort();

// ── AC-1: the co-owned registry becomes collectable ──────────

describe("AC-1: a co-owned registry no plan can claim is collectable", () => {
  test("CO_OWNED_FILES is declared exactly once in the COLLECT-CLAIM block", () => {
    const decls = claimSource.match(/const\s+CO_OWNED_FILES\s*=/g) || [];
    expect(
      decls.length,
      "a second declaration means a reader cannot tell which one the audit consults",
    ).toBe(1);
  });

  test("the set names the allowlists file verbatim, and that file exists", () => {
    // Inside the DECLARATION, not merely somewhere in the block: emptying the
    // set leaves every mention of the path in the docblock above it, and a
    // `toContain` over the whole block would stay green over a dead set.
    const decl = claimSource.match(/const\s+CO_OWNED_FILES\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(decl, "CO_OWNED_FILES is not a literal set — the assertion below cannot read it").not
      .toBeNull();
    expect(decl![1]).toContain(ALLOWLISTS);
    expect(
      existsSync(join(REPO_ROOT, ALLOWLISTS)),
      "the co-owned set names a path this repo does not have — the string is stale",
    ).toBe(true);
  });

  test("one worktree of a multi-worktree run writes it unclaimed, and it is kept", () => {
    // wf_536df065-969 exactly: the pre-push hook made one agent write the
    // ratchet, no sub-issue had claimed it, and the whole collection was
    // refused over it.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", ALLOWLISTS], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations, JSON.stringify(audit.violations)).toEqual([]);
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts", ALLOWLISTS]);
    expect(keptBy(audit, WT_B)).toEqual(["lib/b.ts"]);
  });

  test("control: an ORDINARY unclaimed path in the same fixture is still refused", () => {
    // Without this, "the co-owned file was kept" is indistinguishable from an
    // audit that refuses nothing — the shape counted five times in one day in
    // .claude/rules/checks-must-be-able-to-fail.md.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/sneaky.ts"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(paths(audit)).toEqual(["lib/sneaky.ts"]);
  });

  test("an explicit claim on the co-owned file is still honoured", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: [ALLOWLISTS], claimedFiles: [ALLOWLISTS] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations).toEqual([]);
    expect(keptBy(audit, WT_A)).toEqual([ALLOWLISTS]);
  });

  test("the co-owned exemption is keyed on the path, not on the word json", () => {
    // A detector wider than what it detects is the mirror of shape 2. If the
    // match were a suffix or a directory, every worktree's unclaimed JSON
    // would ride in on the registry's exemption.
    const audit = auditWorktreeClaims([
      {
        worktreePath: WT_A,
        filesChanged: [".claude/other-allowlists.json", `nested/${ALLOWLISTS}`, "lib/a.ts"],
        claimedFiles: ["lib/a.ts"],
      },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(paths(audit)).toEqual([".claude/other-allowlists.json", `nested/${ALLOWLISTS}`].sort());
  });
});

// ── AC-2: two writers of one registry is still a refusal ─────

describe("AC-2: two worktrees writing the co-owned registry is a refusal", () => {
  test("both writers are refused, and the refusal names the co-owned conflict", () => {
    // Collection copies whole files. Taking either copy drops the other's
    // ratchet entries with no diff anyone would notice, which is the #178
    // failure mode the claim guard exists to prevent — the exemption must not
    // reintroduce it.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", ALLOWLISTS], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts", ALLOWLISTS], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations).toHaveLength(2);
    expect(audit.violations.map(v => v.worktreePath).sort()).toEqual([WT_A, WT_B].sort());
    for (const v of audit.violations) {
      expect(v.path).toBe(ALLOWLISTS);
      expect(
        v.detail,
        "the refusal reads as scope creep, so the DA merges nothing and re-runs the same plan",
      ).toContain("co-owned");
      expect(v.detail).not.toContain("did not claim");
    }
  });

  test("neither copy becomes a collection candidate", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", ALLOWLISTS], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts", ALLOWLISTS], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(allKept(audit)).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("a claim by one of the two writers does not break the tie", () => {
    // Last-writer-wins with extra ceremony. The claimant's copy is complete
    // only if the other worktree's edit never happened, and it did.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: [ALLOWLISTS], claimedFiles: [ALLOWLISTS] },
      { worktreePath: WT_B, filesChanged: [ALLOWLISTS], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations).toHaveLength(2);
    expect(audit.candidates).toEqual([]);
  });

  test("the same worktree reporting the registry twice is one writer, not two", () => {
    // Two result rows, one worktree — the #228 participant-counting trap,
    // re-met on the co-owned path.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: [ALLOWLISTS], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations, JSON.stringify(audit.violations)).toEqual([]);
  });
});

// ── AC-3: DA-owned files are refused, and told why ───────────

describe("AC-3: DA-owned state files are refused with the reason", () => {
  test("DA_OWNED_FILES is declared exactly once and contains all three paths", () => {
    const decls = claimSource.match(/const\s+DA_OWNED_FILES\s*=/g) || [];
    expect(decls.length).toBe(1);
    const decl = claimSource.match(/const\s+DA_OWNED_FILES\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(decl, "DA_OWNED_FILES is not a literal set — the assertion below cannot read it").not
      .toBeNull();
    for (const p of DA_OWNED) expect(decl![1]).toContain(p);
  });

  test("all three, reported by a worktree, yield three DA-ownership violations", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", ...DA_OWNED], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations).toHaveLength(3);
    expect(paths(audit)).toEqual([...DA_OWNED].sort());
    for (const v of audit.violations) {
      expect(v.detail, `no reason given for ${v.path}`).toContain("DA-owned");
      expect(v.detail, "the refusal has to point at the rule, or the next agent repeats it").toContain("#296");
      expect(v.detail).not.toContain("did not claim");
    }
    expect(keptBy(audit, WT_A), "a DA-owned file reached the collector").toEqual(["lib/a.ts"]);
  });

  test("the lone-worktree exemption does not cover them — wf_0b15a933-b2b", () => {
    // The run that cost 2,565 lines had four worktrees, but the exemption is
    // the widest hole in the guard and DA ownership is not an exemption from
    // the CLAIM, it is a prohibition. A single-agent run must refuse too.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "project-state.json"] },
    ]);
    expect(paths(audit)).toEqual(["project-state.json"]);
    expect(audit.violations[0]!.detail).toContain("DA-owned");
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts"]);
  });

  test("a plan that CLAIMS a DA-owned file cannot authorise it", () => {
    // The claim comes from the decomposition plan, which is also written by a
    // model. A prohibition a claim can lift is a suggestion.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["PROJECT-STATE.md"], claimedFiles: ["PROJECT-STATE.md"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]!.detail).toContain("DA-owned");
    expect(audit.candidates).toEqual([{ worktreePath: WT_B, filesChanged: ["lib/b.ts"] }]);
  });

  test("an absolute report of a DA-owned file is normalised, not waved through", () => {
    // claimKey strips the worktree prefix. Without running the ownership check
    // on the SAME key the collector uses, reporting the absolute path would
    // route round the prohibition.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: [`${WT_A}/SUCCESS.md`] },
    ]);
    expect(paths(audit)).toEqual(["SUCCESS.md"]);
    expect(audit.violations[0]!.detail).toContain("DA-owned");
  });

  test("control: a lookalike under another directory is NOT DA-owned", () => {
    // `docs/SUCCESS.md` is an ordinary file. A prohibition matched by basename
    // would refuse correct work and send us back to the treadmill.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["docs/SUCCESS.md", "lib/project-state.json"] },
    ]);
    expect(audit.violations, JSON.stringify(audit.violations)).toEqual([]);
  });
});

// ── AC-4: scope creep is still scope creep ───────────────────

describe("AC-4: the scope-creep refusal is unchanged — wf_536df065-969 replayed", () => {
  const WT_10 = `${PROJECT}/.claude/worktrees/wf_536df065-969-10`;

  test("gates/workflow.test.ts, unclaimed and in neither ownership set, is refused once", () => {
    // The agent's fix was GOOD. It still cost the run 2,290 lines, and SC-413
    // is the reason we know it did. A change that lets this through has
    // deleted the guard and kept the file.
    const audit = auditWorktreeClaims([
      {
        worktreePath: WT_10,
        filesChanged: ["workflows/ship.js", "gates/workflow.test.ts"],
        claimedFiles: ["workflows/ship.js"],
      },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]!.worktreePath).toBe(WT_10);
    expect(audit.violations[0]!.path).toBe("gates/workflow.test.ts");
    expect(audit.violations[0]!.claimant).toBeNull();
    expect(
      audit.violations[0]!.detail,
      "scope creep acquired an ownership excuse — the three cases have collapsed into one",
    ).toContain("did not claim");
    expect(audit.violations[0]!.detail).not.toContain("DA-owned");
    expect(audit.violations[0]!.detail).not.toContain("co-owned");
    expect(keptBy(audit, WT_10)).toEqual(["workflows/ship.js"]);
  });

  test("and the claimant wording survives when another worktree owns the file", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_10, filesChanged: ["gates/workflow.test.ts"], claimedFiles: ["workflows/ship.js"] },
      { worktreePath: WT_B, filesChanged: ["gates/workflow.test.ts"], claimedFiles: ["gates/workflow.test.ts"] },
    ]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]!.claimant).toBe(WT_B);
    expect(audit.violations[0]!.detail).toContain("did not claim");
  });
});

// ── AC-5: no claim at all no longer means "claims everything" ─

/**
 * Four worktrees, no claim on any result. Today this keeps every file: the
 * ownership map is empty, so `claimant` is null for every path and the
 * fallthrough treats "nobody claimed it" as permission.
 */
const NO_CLAIM_FIXTURE = [
  { worktreePath: WT_A, filesChanged: ["lib/a.ts"] },
  { worktreePath: WT_B, filesChanged: ["lib/b.ts"] },
  { worktreePath: WT_C, filesChanged: ["lib/c.ts"] },
  { worktreePath: WT_D, filesChanged: ["workflows/ship.js"] },
];

describe("AC-5: a run where no worktree issued a claim is not unconstrained", () => {
  test("four worktrees, no claims — one violation per reported file", () => {
    const audit = auditWorktreeClaims(NO_CLAIM_FIXTURE);
    expect(
      audit.violations,
      "a decomposition that emits no claims silently disables SC-413",
    ).toHaveLength(4);
    expect(paths(audit)).toEqual(["lib/a.ts", "lib/b.ts", "lib/c.ts", "workflows/ship.js"]);
  });

  test("and those files are pruned out of the collection candidates", () => {
    // The refusal and the pruning are separate halves: the pruning is what
    // stops a copy being written even if a later caller ignores the refusal.
    expect(auditWorktreeClaims(NO_CLAIM_FIXTURE).candidates).toEqual([]);
  });

  test("the lone worktree with no claim still collects — #228 is not reverted", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/b.ts"] },
    ]);
    expect(audit.violations).toEqual([]);
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("one worktree claiming in a four-worktree run constrains only the others", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
      ...NO_CLAIM_FIXTURE.slice(1),
    ]);
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts"]);
    expect(paths(audit)).toEqual(["lib/b.ts", "lib/c.ts", "workflows/ship.js"]);
  });

  test("positive control: four worktrees that all claim what they changed pass", () => {
    const audit = auditWorktreeClaims(
      NO_CLAIM_FIXTURE.map(r => ({ ...r, claimedFiles: r.filesChanged })),
    );
    expect(audit.violations, JSON.stringify(audit.violations)).toEqual([]);
    expect(allKept(audit)).toEqual(["lib/a.ts", "lib/b.ts", "lib/c.ts", "workflows/ship.js"]);
  });
});

// ── AC-6: the fail-open restored, and watched ────────────────

describe("AC-6: MUTANT — the claimant-null fallthrough restored and observed", () => {
  /**
   * The single site, mutated by name. Per
   * .claude/rules/checks-must-be-able-to-fail.md the harness must ABORT rather
   * than silently no-op if the signature moves: a mutation harness that stops
   * finding its target reads as "the mutation was rejected on the merits".
   */
  const SIGNATURE = "return Array.isArray(claims) ? claims.includes(key) : claimant === wt";
  const FALLTHROUGH =
    "return Array.isArray(claims) ? claims.includes(key) : (claimant === null || claimant === wt)";

  function loadMutant(): Audit {
    const hits = claimSource.split(SIGNATURE).length - 1;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: the claim-permission signature appears ${hits} times`,
      );
    }
    return loadAudit(claimSource.replace(SIGNATURE, FALLTHROUGH));
  }

  test("the permission decision has exactly one site, so the mutation is total", () => {
    expect(claimSource.split(SIGNATURE).length - 1).toBe(1);
    expect(
      claimSource.includes(FALLTHROUGH),
      "the fail-open is still in the real source — nothing was fixed",
    ).toBe(false);
  });

  test("the real block refuses every file of the no-claim run", () => {
    expect(auditWorktreeClaims(NO_CLAIM_FIXTURE).violations).toHaveLength(4);
  });

  test("the mutant keeps every one of them — the fallthrough is what refuses", () => {
    const mutant = loadMutant()(NO_CLAIM_FIXTURE);
    expect(
      mutant.violations,
      "the fallthrough was restored and nothing changed — this test is not watching it",
    ).toEqual([]);
    expect(allKept(mutant)).toEqual(["lib/a.ts", "lib/b.ts", "lib/c.ts", "workflows/ship.js"]);
  });

  test("both copies still refuse scope creep — the fallthrough is not the whole check", () => {
    // Without this, the mutant going green above would be satisfied by a
    // mutant that refuses nothing at all for any reason.
    const creep = [
      { worktreePath: WT_A, filesChanged: ["gates/workflow.test.ts"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ];
    expect(auditWorktreeClaims(creep).violations).toHaveLength(1);
    expect(
      loadMutant()(creep).violations,
      "the mutant lost the scope-creep refusal, so the comparison above proves nothing",
    ).toHaveLength(1);
  });

  test("both copies still refuse DA-owned files — ownership is not the fallthrough", () => {
    const daOwned = [{ worktreePath: WT_A, filesChanged: ["project-state.json"] }];
    expect(auditWorktreeClaims(daOwned).violations).toHaveLength(1);
    expect(loadMutant()(daOwned).violations).toHaveLength(1);
  });
});
