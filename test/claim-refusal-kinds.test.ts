/**
 * #300 (#296 Phase 2): the claim guard's refusals are told apart by an
 * operator, not just by the diff.
 *
 * Covers SC-1432, SC-1433, SC-1434, SC-1435 (PARALLEL-AGENT-COORDINATION-SPEC.md).
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

function loadAudit(source: string = claimSource): Audit {
  return new Function(`${source}\nreturn auditWorktreeClaims`)() as Audit;
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
