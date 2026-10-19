/**
 * #300 (#296 Phase 2): the claim guard's refusals are told apart by an
 * operator, not just by the diff.
 *
 * Covers SC-1432, SC-1433, SC-1434, SC-1435 (PARALLEL-AGENT-COORDINATION-SPEC.md).
 * Covers SC-2114, SC-2115 (#629).
 *
 * Phase 1 gave `auditWorktreeClaims` three ownership answers and each of them
 * got its own sentence. Nothing checked that the sentences stay different.
 * That matters because the sentence is the entire interface: a run dies, the
 * DA reads one line, and what it does next depends on which kind it was —
 * merge two edits of a shared registry, write a DA-owned file itself, or send
 * the agent back for exceeding its scope. Three refusals that read alike cost
 * the same ~75 minutes whichever one it was.
 *
 * ## Why a table rather than three assertions
 *
 * The issue is explicit, and it is the rule this repo keeps relearning:
 * "three checks that each pass against the same generic string is the vacuous
 * assertion `.claude/rules/checks-must-be-able-to-fail.md` names". So every
 * kind is a ROW, every row is DRIVEN through the real block, and the
 * comparisons below are pairwise over what came back. A fourth kind with no
 * row fails `the table covers every refusal the block can emit` rather than
 * being silently uncovered.
 *
 * ## Distinctness is asserted on the SHAPE, not the string
 *
 * Every refusal interpolates the worktree and the path, so two kinds reported
 * against different files differ as strings no matter how identical their
 * wording is. Comparing them raw would certify a guard that says
 * "wf_a reported X, which it did not claim" for all three kinds. `shape()`
 * blanks the substituted values and the comparison runs on what is left,
 * which is the only part an operator can learn anything from.
 *
 * ## Marker extraction, not import
 *
 * ship.js runs in the Workflow sandbox and is not a module (#69) — same
 * technique and same reason as test/collect-claim-ownership.test.ts. Source
 * text is NOT the evidence here: every message below is produced by running
 * the block, because "ship.js contains the word co-owned" stays true after
 * the branch that emits it stops being reachable.
 *
 * SC-5 pins the out-of-scope wording to what #296 SC-3 shipped, so rows 5 and
 * 6 may only be proven different from the others — never reworded.
 *
 * ## AC-7b (#627)
 *
 * #627 moves the claim/result pairing into one named binding the wave path
 * calls too, which changes WHAT reaches `auditWorktreeClaims` and not the
 * block below. The hazard is that "the suite is green" would be the only
 * evidence of that, and a suite is green for many reasons. So the AC-7b
 * describe at the bottom drives the three situations the pairing decides
 * between — an absent claim, an unclaimed file, and a claimed file that never
 * changed — through the real block over ONE set of paths, and compares what
 * came back. One executed run, three outcomes, pairwise distinct.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const PROJECT = "/Users/dev/proj";
const WT_A = `${PROJECT}/.claude/worktrees/wf_a`;
const WT_B = `${PROJECT}/.claude/worktrees/wf_b`;

const ALLOWLISTS = ".claude/conformity-allowlists.json";

interface Violation {
  worktreePath: string;
  path: string;
  claimant: string | null;
  detail: string;
}

type Audit = (results: unknown) => {
  violations: Violation[];
  candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
};

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

const claimSource = block("COLLECT-CLAIM");

// Counting below reads `claimSource` alone, because the row count is tied to
// the COLLECT-CLAIM block's refusal templates and nothing else. Evaluation
// needs both blocks: #400 moved the path-safety rules into SECURITY-HELPERS
// so staging and the audit share one decider, and the audit calls into it.
const securitySource = block("SECURITY-HELPERS");

function loadAudit(source: string = claimSource): Audit {
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${securitySource}\n${source}\nreturn auditWorktreeClaims`,
  )("/repo", () => {}) as Audit;
}

const auditWorktreeClaims = loadAudit();

/**
 * One row per refusal the block can emit.
 *
 * `token` is the row's DISCRIMINATOR: the phrase an operator would grep for,
 * which must appear in this kind's message and in no other's. `named` marks
 * the three kinds SC-5 calls out by name; the other three exist because the
 * table's job is to cover what the block emits, not what the issue remembered.
 */
interface Kind {
  kind: string;
  named: boolean;
  token: string;
  path: string;
  results: unknown[];
}

const OTHER_WORK = { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] };

const KINDS: Kind[] = [
  {
    kind: "escapes-worktree",
    named: false,
    token: "not inside its own worktree",
    path: `${WT_B}/lib/b.ts`,
    results: [
      {
        worktreePath: WT_A,
        filesChanged: [`${WT_B}/lib/b.ts`, "lib/a.ts"],
        claimedFiles: ["lib/a.ts"],
      },
      OTHER_WORK,
    ],
  },
  {
    // #400: inside the worktree, and still unstageable. Before #400 the audit
    // had no opinion on this at all — it reported the run clean and staging
    // refused the path two phases later, under a different message.
    kind: "unsafe but inside the worktree",
    named: false,
    token: "cannot be staged",
    path: "lib/a;rm.ts",
    results: [
      {
        worktreePath: WT_A,
        filesChanged: ["lib/a;rm.ts", "lib/a.ts"],
        claimedFiles: ["lib/a;rm.ts", "lib/a.ts"],
      },
      OTHER_WORK,
    ],
  },
  {
    // wf_0b15a933-b2b: CLAUDE.md told the agent to write it.
    kind: "DA-owned write",
    named: true,
    token: "DA-owned",
    path: "PROJECT-STATE.md",
    results: [
      {
        worktreePath: WT_A,
        filesChanged: ["lib/a.ts", "PROJECT-STATE.md"],
        claimedFiles: ["lib/a.ts"],
      },
      OTHER_WORK,
    ],
  },
  {
    // wf_536df065-969: the pre-push hook REQUIRES writing it, from everywhere.
    kind: "co-owned conflict",
    named: true,
    token: "co-owned registry",
    path: ALLOWLISTS,
    results: [
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", ALLOWLISTS], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts", ALLOWLISTS], claimedFiles: ["lib/b.ts"] },
    ],
  },
  {
    kind: "multiple claimants",
    named: false,
    token: "a file may have one claimant",
    path: "lib/shared.ts",
    results: [
      { worktreePath: WT_A, filesChanged: ["lib/shared.ts"], claimedFiles: ["lib/shared.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/shared.ts", "lib/b.ts"] },
    ],
  },
  {
    // wf_536df065-969 again, and the half SC-3 pins: genuine scope creep.
    kind: "out-of-scope unclaimed — another worktree owns it",
    named: true,
    token: "that file is claimed by",
    path: "gates/workflow.test.ts",
    results: [
      {
        worktreePath: WT_A,
        filesChanged: ["gates/workflow.test.ts"],
        claimedFiles: ["lib/a.ts"],
      },
      {
        worktreePath: WT_B,
        filesChanged: ["lib/b.ts"],
        claimedFiles: ["gates/workflow.test.ts", "lib/b.ts"],
      },
    ],
  },
  {
    // #629: this row is now the narrower of two. Claims WERE issued in this
    // run — WT_A claims lib/a.ts and WT_B claims lib/b.ts — and none of them
    // names the reported file. The sentence #296 SC-3 pinned is true of
    // exactly this case, which is why the split below adds an arm instead of
    // rewording it.
    kind: "out-of-scope unclaimed — nobody owns it",
    named: true,
    token: "no worktree claimed that file",
    path: "gates/workflow.test.ts",
    results: [
      {
        worktreePath: WT_A,
        filesChanged: ["gates/workflow.test.ts", "lib/a.ts"],
        claimedFiles: ["lib/a.ts"],
      },
      OTHER_WORK,
    ],
  },
  {
    // #629: the opposite fact under the same `claimant === null`. NOBODY
    // issued a claim, so the comparison never had an input — which is #627's
    // defect seen from the refusal, and a caller fault rather than an agent
    // one. Two participants, because one would take SINGLE_WORKTREE_EXEMPT
    // and collect everything (#228), and then this arm is unreachable.
    kind: "absent claim — no worktree issued one",
    named: false,
    token: "issued a claim at all",
    path: "gates/workflow.test.ts",
    results: [
      { worktreePath: WT_A, filesChanged: ["gates/workflow.test.ts", "lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"] },
    ],
  },
];

/** The one message this row's fixture produces, read off the real audit. */
function messageFor(row: Kind, audit: Audit = auditWorktreeClaims): string {
  const got = audit(row.results).violations.filter(
    v => v.path === row.path && v.worktreePath === WT_A,
  );
  if (got.length !== 1) {
    throw new Error(
      `${row.kind}: fixture produced ${got.length} violations for ${row.path} from ${WT_A} — ` +
        `the row no longer drives the kind it names`,
    );
  }
  return got[0]!.detail;
}

/**
 * The message with its substituted values blanked.
 *
 * Longest first, so `${WT_B}/lib/b.ts` is replaced as a worktree-qualified
 * path rather than being half-eaten by the `${WT_B}` replacement and leaving
 * a `<worktree>/lib/b.ts` that no longer matches the bare path.
 */
function shape(detail: string): string {
  const substitutions: Array<[string, string]> = [
    [`${WT_B}/lib/b.ts`, "<path>"],
    [WT_A, "<worktree>"],
    [WT_B, "<worktree>"],
    [ALLOWLISTS, "<path>"],
    ["lib/a;rm.ts", "<path>"],
    ["gates/workflow.test.ts", "<path>"],
    ["lib/shared.ts", "<path>"],
    ["PROJECT-STATE.md", "<path>"],
    ["project-state.json", "<path>"],
    ["SUCCESS.md", "<path>"],
  ];
  let out = detail;
  for (const [from, to] of substitutions) out = out.split(from).join(to);
  return out.replace(/\b\d+\b/g, "<n>");
}

// ── SC-1432: the table drives every kind, and covers all of them ──

describe("SC-1432: one row per refusal kind, each actually produced", () => {
  for (const row of KINDS) {
    test(`${row.kind} is emitted by the real block`, () => {
      // `messageFor` throws unless the fixture produced exactly one violation
      // at the named path, so a row whose fixture drifted into producing a
      // DIFFERENT kind fails here rather than quietly comparing the wrong
      // message in every assertion below.
      const detail = messageFor(row);
      expect(detail).toContain(row.token);
    });
  }

  test("the table covers every refusal the block can emit", () => {
    // A per-kind loop only makes a fourth kind impossible to add silently if
    // something ties the row count to the source. Two readings, because
    // either alone has a hole: a new push site with a reworded message leaves
    // the template count unchanged, and a new arm of an existing ternary
    // leaves the push-site count unchanged.
    //
    // #400 is the second reading earning its place: it added a kind without
    // adding a push site, by splitting the boundary refusal into a ternary.
    // Templates went 6 → 7, `detail:` sites stayed at 5.
    const detailSites = (claimSource.match(/detail:/g) || []).length;
    const templates = (claimSource.match(/`\$\{wt\} reported /g) || []).length;
    expect(
      templates,
      "a refusal template was added or removed without a row in KINDS",
    ).toBe(KINDS.length);
    expect(
      detailSites,
      "a refusal was added that does not open with the worktree and the path, so the template count above cannot see it",
    ).toBe(5);
  });

  test("the three kinds SC-5 names are all present", () => {
    // The table grew past the issue's three. That is the right direction, but
    // it must not be a way to drop one: SC-5's kinds are asserted by name.
    const named = KINDS.filter(k => k.named).map(k => k.kind);
    expect(named).toContain("DA-owned write");
    expect(named).toContain("co-owned conflict");
    expect(named.filter(k => k.startsWith("out-of-scope unclaimed"))).toHaveLength(2);
  });

  test("every refusal names the worktree and the path before the reason", () => {
    // Executed, not grepped. An operator reading a run log needs WHO and
    // WHAT in front of WHY, or the kind is the only thing they can act on.
    for (const row of KINDS) {
      expect(messageFor(row).startsWith(`${WT_A} reported ${row.path},`), row.kind).toBe(true);
    }
  });
});

// ── SC-1433: pairwise distinctness, on the shape ──────────────

describe("SC-1433: the refusals are pairwise distinguishable", () => {
  test("no two kinds share a message shape", () => {
    const shapes = KINDS.map(row => [row.kind, shape(messageFor(row))] as const);
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(
          shapes[i]![1],
          `${shapes[i]![0]} and ${shapes[j]![0]} read identically once the worktree and path are blanked — an operator cannot tell them apart`,
        ).not.toBe(shapes[j]![1]);
      }
    }
  });

  test("no shape contains another, so a substring match cannot be ambiguous", () => {
    // Equality is not the only collapse. If one kind's message is a prefix of
    // another's, `toContain` over the shorter one passes against both, and
    // every downstream assertion written that way goes vacuous.
    const shapes = KINDS.map(row => [row.kind, shape(messageFor(row))] as const);
    for (let i = 0; i < shapes.length; i++) {
      for (let j = 0; j < shapes.length; j++) {
        if (i === j) continue;
        expect(
          shapes[i]![1].includes(shapes[j]![1]),
          `${shapes[j]![0]}'s message is contained in ${shapes[i]![0]}'s`,
        ).toBe(false);
      }
    }
  });

  test("each kind's discriminator appears in exactly one kind's message", () => {
    // The property an operator actually uses: grep one phrase, learn one
    // thing. A token that matches two kinds is the generic string this test
    // exists to rule out, and `toContain` per kind would never see it.
    const messages = KINDS.map(row => [row.kind, messageFor(row)] as const);
    for (const row of KINDS) {
      const hits = messages.filter(([, m]) => m.includes(row.token)).map(([k]) => k);
      expect(hits, `"${row.token}" does not identify one kind`).toEqual([row.kind]);
    }
  });

  test("the two out-of-scope arms stay the wording #296 SC-3 pinned", () => {
    // SC-5 may prove these different; it may not change them. Asserted here
    // so a later distinctness fix cannot buy green by rewording the one
    // message another criterion holds fixed.
    const byKind = (k: string) => messageFor(KINDS.find(r => r.kind === k)!);
    expect(byKind("out-of-scope unclaimed — another worktree owns it")).toBe(
      `${WT_A} reported gates/workflow.test.ts, which it did not claim — that file is claimed by ${WT_B}`,
    );
    expect(byKind("out-of-scope unclaimed — nobody owns it")).toBe(
      `${WT_A} reported gates/workflow.test.ts, which it did not claim — no worktree claimed that file`,
    );
  });
});

// ── #629 AC-3: the two absent-claim arms, varying exactly one thing ────────

describe("#629 AC-3: an absent claim says WHICH absence it is", () => {
  /**
   * The pair, derived rather than written twice (#585).
   *
   * Two hand-written fixtures can differ in something nobody noticed, and
   * then the comparison measures that instead of the dimension it names. The
   * second half here is the first with `claimedFiles` deleted and nothing
   * else, and the derivation is asserted before anything is concluded from
   * it — so the only thing that can explain a difference in the refusal is
   * the presence of claims.
   */
  const withClaims = [
    {
      worktreePath: WT_A,
      filesChanged: ["gates/workflow.test.ts", "lib/a.ts"],
      claimedFiles: ["lib/a.ts"],
    },
    { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
  ];
  const withoutClaims = withClaims.map(({ claimedFiles, ...rest }) => rest);

  const detailFor = (results: unknown[]): string => {
    const got = auditWorktreeClaims(results).violations.filter(
      v => v.path === "gates/workflow.test.ts" && v.worktreePath === WT_A,
    );
    expect(got).toHaveLength(1);
    return got[0]!.detail;
  };

  test("the pair varies only the presence of claims", () => {
    expect(withClaims.map(r => r.worktreePath)).toEqual(withoutClaims.map(r => r.worktreePath));
    expect(withClaims.map(r => r.filesChanged)).toEqual(withoutClaims.map(r => r.filesChanged));
    expect(withClaims.every(r => Array.isArray(r.claimedFiles))).toBe(true);
    expect(withoutClaims.every(r => !("claimedFiles" in r))).toBe(true);
  });

  test("the two absences produce different refusals", () => {
    expect(detailFor(withClaims)).not.toBe(detailFor(withoutClaims));
  });

  test("the no-claim arm points upstream and the other does not", () => {
    // The whole point: the two call for opposite next actions, and the
    // operator has one line to decide from. A refusal that reads the same
    // either way costs the wrong investigation, which is what `claimant` was
    // already right about and the absent case was not.
    const absent = detailFor(withoutClaims);
    expect(absent).toContain("issued a claim at all");
    expect(absent).toContain("Fix the caller");
    expect(absent).toContain("#627");

    const outside = detailFor(withClaims);
    expect(outside).toContain("no worktree claimed that file");
    expect(outside).not.toContain("Fix the caller");
  });

  test("an empty claim array is an issued claim, not an absent one", () => {
    // `claimedFiles: []` is a plan that named no files — a claim that
    // arrived and said nothing, which is a planning problem. Reading it as
    // "no claim issued" would send an operator upstream to look for a relay
    // bug that is not there.
    const emptyClaims = withoutClaims.map(r => ({ ...r, claimedFiles: [] as string[] }));
    expect(detailFor(emptyClaims)).toBe(detailFor(withClaims));
  });

  test("a single worktree is still exempt, so the new arm did not widen the guard", () => {
    // SINGLE_WORKTREE_EXEMPT is checked before any of this (#228). A lone
    // agent with no claim collects, and a new refusal arm must not be
    // reachable for it — run wf_74366574-136 is what that costs.
    const lone = [{ worktreePath: WT_A, filesChanged: ["gates/workflow.test.ts"] }];
    const { violations, candidates } = auditWorktreeClaims(lone);
    expect(violations).toEqual([]);
    expect(candidates).toEqual([
      { worktreePath: WT_A, filesChanged: ["gates/workflow.test.ts"] },
    ]);
  });
});

// ── SC-1434: what the operator does next is in the message ────

describe("SC-1434: each refusal says what to do about it", () => {
  const REMEDY: Record<string, string[]> = {
    "DA-owned write": ["#296", "the DA will write it"],
    "co-owned conflict": ["#296", "Merge them in one place"],
    "co-owned conflict:writers": ["wf_a", "wf_b"],
  };

  test("the DA-owned refusal points at the rule and the alternative", () => {
    // Without both, the next agent reads CLAUDE.md's "update PROJECT-STATE.md
    // at milestones" line and does the same thing tomorrow — which is how
    // wf_0b15a933-b2b happened in the first place.
    const detail = messageFor(KINDS.find(r => r.kind === "DA-owned write")!);
    for (const token of REMEDY["DA-owned write"]!) expect(detail).toContain(token);
  });

  test("the co-owned refusal names every worktree that wrote it", () => {
    // "Merge them in one place" is unactionable without knowing which places.
    const detail = messageFor(KINDS.find(r => r.kind === "co-owned conflict")!);
    for (const token of REMEDY["co-owned conflict"]!) expect(detail).toContain(token);
    expect(detail).toContain(WT_A);
    expect(detail).toContain(WT_B);
  });

  test("the scope-creep refusal does NOT borrow an ownership excuse", () => {
    // The inverse of the above, and the primary correctness constraint of
    // #296: a change that makes all three read like ownership has deleted
    // SC-413 and kept the file.
    for (const kind of ["out-of-scope unclaimed — another worktree owns it", "out-of-scope unclaimed — nobody owns it"]) {
      const detail = messageFor(KINDS.find(r => r.kind === kind)!);
      expect(detail, kind).not.toContain("DA-owned");
      expect(detail, kind).not.toContain("co-owned");
    }
  });
});

// ── SC-1435: the distinctness check, broken and watched ───────

describe("SC-1435: MUTANT — two kinds collapsed into one message", () => {
  /**
   * The single site, mutated by text. Per
   * .claude/rules/checks-must-be-able-to-fail.md the harness must ABORT
   * rather than no-op if the template moves: a mutation that stops finding
   * its target reads as "the mutation was rejected on the merits", and this
   * file's whole subject is checks that pass for the wrong reason.
   */
  const CO_OWNED_TEMPLATE =
    "`${wt} reported ${key}, a co-owned registry that ${writers.length} worktrees wrote in this run (${writers.join(', ')}) — collection copies whole files, so taking one copy would drop the other edits. Merge them in one place (#296).`";
  const GENERIC = "`${wt} reported ${key}, which it did not claim — no worktree claimed that file`";

  function loadMutant(): Audit {
    const hits = claimSource.split(CO_OWNED_TEMPLATE).length - 1;
    if (hits !== 1) {
      throw new Error(`could not build the mutant: the co-owned template appears ${hits} times`);
    }
    return loadAudit(claimSource.replace(CO_OWNED_TEMPLATE, GENERIC));
  }

  const coOwned = KINDS.find(r => r.kind === "co-owned conflict")!;
  const unclaimed = KINDS.find(r => r.kind === "out-of-scope unclaimed — nobody owns it")!;

  test("the co-owned message has exactly one site, so the mutation is total", () => {
    expect(claimSource.split(CO_OWNED_TEMPLATE).length - 1).toBe(1);
    expect(
      claimSource.includes(GENERIC),
      "the generic template the mutant installs is already the only one in the source",
    ).toBe(true);
  });

  test("real: the two shapes differ", () => {
    expect(shape(messageFor(coOwned))).not.toBe(shape(messageFor(unclaimed)));
  });

  test("mutant: the two shapes become identical — the wording is what separates them", () => {
    const mutant = loadMutant();
    expect(
      shape(messageFor(coOwned, mutant)),
      "the co-owned template was replaced and the shapes still differ — the distinctness check is reading something else",
    ).toBe(shape(messageFor(unclaimed, mutant)));
  });

  test("mutant: the co-owned discriminator identifies nothing", () => {
    const mutant = loadMutant();
    const hits = KINDS.filter(row => messageFor(row, mutant).includes(coOwned.token));
    expect(hits).toEqual([]);
  });

  test("control: the mutant still refuses the same paths", () => {
    // Without this, "the mutant collapsed" would be satisfied by a mutant
    // that stopped refusing the co-owned conflict altogether — a different
    // defect, which would make the comparison above prove nothing about
    // wording.
    const mutant = loadMutant();
    for (const row of KINDS) {
      const real = auditWorktreeClaims(row.results).violations.map(v => v.path).sort();
      const mut = mutant(row.results).violations.map(v => v.path).sort();
      expect(mut, `${row.kind}: the mutant changed WHAT is refused, not just how it reads`).toEqual(real);
    }
  });
});

// ── AC-7b (#627): the three claim situations stay told apart ──

/**
 * One set of paths, three claim situations.
 *
 * Shared paths on purpose. The KINDS table above compares MESSAGES, and can
 * do that across fixtures because `shape()` blanks the substitutions. These
 * three are told apart by what the audit DOES — which paths it refuses and
 * which it lets through to the collector — and an outcome comparison is only
 * meaningful between fixtures whose paths are the same. Fixtures that varied
 * the paths too would differ no matter what the block decided.
 */
const AC7B_PATHS = { a: "lib/a.ts", x: "lib/x.ts", b: "lib/b.ts", never: "lib/never.ts" };

const AC7B_SITUATIONS: Array<{ kind: string; results: unknown[] }> = [
  {
    // The #627 failure itself: `integrateWave` handed `collectAgentWork` rows
    // whose `claimedFiles` was undefined, because it reached for `buildResult`
    // and left the plan behind. No claim was issued ANYWHERE in the run.
    kind: "absent claim",
    results: [
      { worktreePath: WT_A, filesChanged: [AC7B_PATHS.a, AC7B_PATHS.x] },
      { worktreePath: WT_B, filesChanged: [AC7B_PATHS.b] },
    ],
  },
  {
    // Claims issued and carried. One reported file is outside them — the
    // scope creep SC-413 exists for, and the case that MUST keep refusing.
    kind: "unclaimed file",
    results: [
      { worktreePath: WT_A, filesChanged: [AC7B_PATHS.a, AC7B_PATHS.x], claimedFiles: [AC7B_PATHS.a] },
      { worktreePath: WT_B, filesChanged: [AC7B_PATHS.b], claimedFiles: [AC7B_PATHS.b] },
    ],
  },
  {
    // A plan claims more than the work touched, which is ordinary: a
    // sub-issue lists four files and changes three. Not a refusal, and the
    // untouched claim must not become a collection candidate either.
    kind: "claimed file that never changed",
    results: [
      {
        worktreePath: WT_A,
        filesChanged: [AC7B_PATHS.a, AC7B_PATHS.x],
        claimedFiles: [AC7B_PATHS.a, AC7B_PATHS.x, AC7B_PATHS.never],
      },
      { worktreePath: WT_B, filesChanged: [AC7B_PATHS.b], claimedFiles: [AC7B_PATHS.b] },
    ],
  },
];

/** What the audit DID, as one comparable string per situation. */
function outcome(results: unknown[], audit: Audit = auditWorktreeClaims): string {
  const got = audit(results);
  const refused = got.violations.map(v => v.path).sort();
  const collected = got.candidates.flatMap(c => c.filesChanged).sort();
  return `refused=[${refused.join(",")}] collected=[${collected.join(",")}]`;
}

describe("AC-7b: absent, unclaimed and never-changed stay three different answers", () => {
  test("each situation's outcome is the one it is named for", () => {
    // Pinned by value rather than only by pairwise difference: three outcomes
    // can be pairwise distinct and all three wrong, which a distinctness
    // comparison alone cannot see.
    const by = (kind: string) => outcome(AC7B_SITUATIONS.find(s => s.kind === kind)!.results);

    // Nothing claimed anything, so nothing may be collected (#296 AC-5).
    expect(by("absent claim")).toBe(
      `refused=[${AC7B_PATHS.a},${AC7B_PATHS.b},${AC7B_PATHS.x}] collected=[]`,
    );
    // Exactly the file outside the claims, and only it.
    expect(by("unclaimed file")).toBe(
      `refused=[${AC7B_PATHS.x}] collected=[${AC7B_PATHS.a},${AC7B_PATHS.b}]`,
    );
    // Nothing refused — and `lib/never.ts` is in neither list, because a
    // claim is permission to change a file, not a report that one changed.
    expect(by("claimed file that never changed")).toBe(
      `refused=[] collected=[${AC7B_PATHS.a},${AC7B_PATHS.b},${AC7B_PATHS.x}]`,
    );
  });

  test("no two situations produce the same outcome", () => {
    const seen = AC7B_SITUATIONS.map(s => [s.kind, outcome(s.results)] as const);
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        expect(
          seen[i]![1],
          `${seen[i]![0]} and ${seen[j]![0]} are the same answer — the guard cannot tell a lost claim from a legitimate one`,
        ).not.toBe(seen[j]![1]);
      }
    }
  });

  test("the absent-claim run is the only one that collects nothing", () => {
    // The property the #627 refusal rests on, stated on its own: a run that
    // issued no claim has no collectable work, so a wave fix that merely
    // silences the refusal without restoring the claim is still broken.
    const collecting = AC7B_SITUATIONS.filter(
      s => !outcome(s.results).endsWith("collected=[]"),
    ).map(s => s.kind);
    expect(collecting).toEqual(["unclaimed file", "claimed file that never changed"]);
  });

  test("the two refusing situations still say 'did not claim'", () => {
    // The wording #296 SC-3 pinned, re-read here because AC-7b is about these
    // two staying refusals at all. Executed, not grepped.
    for (const kind of ["absent claim", "unclaimed file"]) {
      const got = auditWorktreeClaims(AC7B_SITUATIONS.find(s => s.kind === kind)!.results);
      expect(got.violations.length, kind).toBeGreaterThan(0);
      for (const v of got.violations) expect(v.detail, kind).toContain("did not claim");
    }
    // NOT asserted: that those two read DIFFERENTLY. Measured on this tree
    // they do not — both end "no worktree claimed that file", so an absent
    // claim and a lost one are one sentence. That is the split #629 carries,
    // and writing an equality here would make #629 edit this file to do it.
  });
});

describe("AC-7b: MUTANT — the absent-claim fallthrough restored and observed", () => {
  /**
   * The claim-permission expression, mutated by text. Same single site
   * `test/collect-claim-ownership.test.ts` mutates, widened differently: there
   * it is restored to the historical `claimant === null || claimant === wt`,
   * here to `true`, which is the cheapest repair for "#627's wave path hands
   * the audit rows with no claim" — let absent claims through and the wave
   * integrates. It also switches SC-413 off for every run.
   */
  const SIGNATURE = "return Array.isArray(claims) ? claims.includes(key) : claimant === wt";
  const WIDENED = "return Array.isArray(claims) ? claims.includes(key) : true";

  function loadWidened(): Audit {
    const hits = claimSource.split(SIGNATURE).length - 1;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: the claim-permission signature appears ${hits} times`,
      );
    }
    return loadAudit(claimSource.replace(SIGNATURE, WIDENED));
  }

  test("the permission decision has exactly one site, so the mutation is total", () => {
    expect(claimSource.split(SIGNATURE).length - 1).toBe(1);
    expect(
      claimSource.includes(WIDENED),
      "the widened form is already the only one in the source — nothing constrains an absent claim",
    ).toBe(false);
  });

  test("the mutant collapses the absent-claim run into the never-changed one", () => {
    const mutant = loadWidened();
    const absent = AC7B_SITUATIONS.find(s => s.kind === "absent claim")!;
    const neverChanged = AC7B_SITUATIONS.find(s => s.kind === "claimed file that never changed")!;
    expect(
      outcome(absent.results, mutant),
      "the guard was widened and the two still differ — the case above is reading something else",
    ).toBe(outcome(neverChanged.results, mutant));
    // And on the real block they differ, so the collapse is the mutation's.
    expect(outcome(absent.results)).not.toBe(outcome(neverChanged.results));
  });

  test("control: the mutant still refuses a DA-owned write", () => {
    // Without this, "the mutant collapsed the outcomes" would be satisfied by
    // a mutant that refuses nothing for any reason, and the comparison above
    // would prove nothing about the claim guard in particular.
    const daOwned = [
      { worktreePath: WT_A, filesChanged: [AC7B_PATHS.a, "PROJECT-STATE.md"], claimedFiles: [AC7B_PATHS.a] },
      { worktreePath: WT_B, filesChanged: [AC7B_PATHS.b], claimedFiles: [AC7B_PATHS.b] },
    ];
    const mutant = loadWidened();
    expect(mutant(daOwned).violations.map(v => v.path)).toEqual(["PROJECT-STATE.md"]);
    expect(mutant(daOwned).violations[0]!.detail).toContain("DA-owned");
  });
});
