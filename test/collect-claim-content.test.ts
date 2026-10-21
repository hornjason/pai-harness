/**
 * #892: the collection guard decides on the claim ledger alone, so "two
 * worktrees edited a file differently" and "two worktrees produced identical
 * content" are the same refusal.
 *
 * Run `wf_161c4e96-f01` — 24 agents, ~35 minutes, 0 errors — reached Commit and
 * was refused because one worktree reported a file it had not claimed. The rule
 * is right. The content was not in conflict at all: the overlapping files were
 * byte-identical across all three preserved branches, and one branch was a
 * strict superset of the other two. Nothing in the audit had ever looked at the
 * bytes, so a run with nothing to lose died exactly like a run that would have
 * lost work.
 *
 * This file is the SECOND READING, and the three properties that make it a
 * reading rather than a relaxation:
 *
 *   IDENTICAL  — nothing is contested, so the path collects and the violation
 *                is not raised (AC-1).
 *   DIFFERENT  — still refused, and the sentence now says the copies diverge
 *                rather than only that the file was unclaimed (AC-2).
 *   UNMEASURED — a copy that could not be read is REFUSED, naming the exact
 *                path and the reader's own reason. `0`, `{}`, `null` and
 *                silence are indistinguishable from success and UNMEASURED is
 *                not (`.claude/rules/config-access.md`), so a comparison that
 *                did not happen is never a comparison that passed (AC-3).
 *
 * ## Where it may be consulted, and where it may not (AC-4)
 *
 * Five of the block's arms are facts about the FILE or about the RUN — a
 * DA-owned write, a co-owned registry two worktrees wrote, a path that cannot
 * be staged, two claimants, and a run in which nobody issued a claim. No
 * reading of the bytes can make any of them collectable, so every AC-4 case
 * below supplies readings that say IDENTICAL for every path in its fixture and
 * watches the arm refuse anyway. Each of those cases also carries a
 * single-claimant path that IS kept, because a battery whose fixtures all fail
 * for the same reason cannot tell "the arm is ahead of the reading" from "the
 * reading never worked at all" (`.claude/rules/checks-must-be-able-to-fail.md`,
 * the precondition section).
 *
 * ## One comparator, injected (AC-5)
 *
 * `contentComparison` in `lib/claim-content.ts` is the only thing in the tree
 * that compares two copies. The audit CONSUMES its reading and never performs
 * one: `workflows/ship.js` runs in the Workflow sandbox with no module loading
 * (#69), so a second comparison inlined there would be a second decider for one
 * question, and a mutation of either would leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape). Every
 * reading handed to the audit below is produced by the real `contentComparison`
 * with an injected reader, so the two halves are tied together rather than
 * described to each other.
 *
 * ## Marker extraction rather than import
 *
 * ship.js is not a module (#69) — same technique and same reason as
 * test/collect-claim-enforcement.test.ts and test/claim-refusal-kinds.test.ts.
 * Source text is not the evidence here: every verdict below is produced by
 * RUNNING the block, because "ship.js contains the word IDENTICAL" stays true
 * after the arm that reads it stops being reachable.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  contentComparison,
  type ClaimCopyReader,
  type ContentComparison,
} from "../lib/claim-content";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

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

interface ClaimAudit {
  violations: Violation[];
  candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
}

type Audit = (results: unknown, readings?: unknown) => ClaimAudit;

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

const claimSource = block("COLLECT-CLAIM");
const securitySource = block("SECURITY-HELPERS");

/**
 * The real block, loaded with the path-safety decider it calls (#400).
 *
 * SECURITY-HELPERS is loaded UNMUTATED even when `source` is a mutant, so a
 * mutant can never die on a missing `pathRefusal` and read as the mutation
 * having worked.
 */
function loadBlock(source: string = claimSource): {
  auditWorktreeClaims: Audit;
  contentReadingKey: (worktreePath: string, path: string) => string;
} {
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${securitySource}\n${source}\nreturn { auditWorktreeClaims, contentReadingKey }`,
  )("/repo", () => {}) as {
    auditWorktreeClaims: Audit;
    contentReadingKey: (worktreePath: string, path: string) => string;
  };
}

const { auditWorktreeClaims, contentReadingKey } = loadBlock();

const paths = (a: ClaimAudit) => a.violations.map(v => v.path).sort();
const keptBy = (a: ClaimAudit, wt: string) =>
  a.candidates.find(c => c.worktreePath === wt)?.filesChanged ?? [];
const detailFor = (a: ClaimAudit, path: string) =>
  a.violations.find(v => v.path === path)?.detail ?? "";

/** A reader that answers from a table of worktree-absolute path → bytes. */
function readerOver(files: Record<string, string>): ClaimCopyReader {
  return (absolutePath: string) => {
    const bytes = files[absolutePath];
    if (bytes === undefined) {
      return { readable: false, reason: `ENOENT: no such file, open '${absolutePath}'` };
    }
    // A digest of the bytes, not the bytes: the audit compares digests, and a
    // reader that handed back content would make the comparison a different
    // one from the production reader's.
    return { readable: true, digest: `sha:${Buffer.from(bytes).toString("base64")}` };
  };
}

/**
 * The readings for one run, produced by the REAL comparator.
 *
 * Nothing in this file hand-writes a reading. A table of `{reading:
 * "IDENTICAL"}` literals would test the audit against the test's own opinion of
 * what the comparator says, which is the artifact-as-ground-truth shape (#530):
 * it agrees with whatever you put in it.
 */
function readingsFor(
  rows: Array<{ worktree: string; path: string; claimant: string }>,
  read: ClaimCopyReader,
): Record<string, ContentComparison> {
  const out: Record<string, ContentComparison> = {};
  for (const row of rows) {
    out[contentReadingKey(row.worktree, row.path)] = contentComparison({
      path: row.path,
      reportingWorktree: row.worktree,
      claimingWorktree: row.claimant,
      read,
    });
  }
  return out;
}

// ── AC-1: identical copies are not a conflict ────────────────

describe("AC-1: an unclaimed path whose copy is IDENTICAL collects", () => {
  // wf_161c4e96-f01: WT_A reported a file WT_B claimed, and the two copies
  // were the same bytes.
  const RESULTS = [
    { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/shared.ts"], claimedFiles: ["lib/a.ts"] },
    {
      worktreePath: WT_B,
      filesChanged: ["lib/b.ts", "lib/shared.ts"],
      claimedFiles: ["lib/b.ts", "lib/shared.ts"],
    },
  ];
  const SAME = readerOver({
    [`${WT_A}/lib/shared.ts`]: "export const x = 1\n",
    [`${WT_B}/lib/shared.ts`]: "export const x = 1\n",
  });
  const readings = readingsFor(
    [{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }],
    SAME,
  );

  test("the reading the comparator produced really is IDENTICAL", () => {
    // The premise, asserted rather than assumed: if the fixture's two copies
    // were not the same bytes, every assertion below would be about the
    // DIFFERENT arm while reading as though it were about this one.
    expect(readings[contentReadingKey(WT_A, "lib/shared.ts")]!.reading).toBe("IDENTICAL");
  });

  test("no violation is raised for that path", () => {
    const audit = auditWorktreeClaims(RESULTS, readings);
    expect(audit.violations.map(v => v.detail)).toEqual([]);
  });

  test("the path appears in the reporting worktree's candidates", () => {
    // The violation list going empty is half the claim. The collector is
    // handed the CANDIDATES, so a path that raised no violation and also did
    // not survive the pruning is a file that silently did not collect.
    const audit = auditWorktreeClaims(RESULTS, readings);
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts", "lib/shared.ts"]);
    expect(keptBy(audit, WT_B)).toEqual(["lib/b.ts", "lib/shared.ts"]);
  });

  test("control: the SAME fixture with no reading supplied is still refused", () => {
    // Without this the AC-1 cases are indistinguishable from an audit that
    // refuses nothing, and they would also be silent about AC-9: a caller that
    // omits the reading must get exactly the verdict it got before.
    const audit = auditWorktreeClaims(RESULTS);
    expect(paths(audit)).toEqual(["lib/shared.ts"]);
    expect(detailFor(audit, "lib/shared.ts")).toBe(
      `${WT_A} reported lib/shared.ts, which it did not claim — that file is claimed by ${WT_B}`,
    );
  });

  test("the claimant's own report of its own file is untouched by the reading", () => {
    const audit = auditWorktreeClaims(RESULTS, readings);
    expect(keptBy(audit, WT_B)).toContain("lib/shared.ts");
  });
});

// ── AC-2: differing copies are still refused, and say so ─────

describe("AC-2: an unclaimed path whose copy DIFFERS is refused for that reason", () => {
  const RESULTS = [
    { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/shared.ts"], claimedFiles: ["lib/a.ts"] },
    {
      worktreePath: WT_B,
      filesChanged: ["lib/b.ts", "lib/shared.ts"],
      claimedFiles: ["lib/b.ts", "lib/shared.ts"],
    },
  ];
  const DIVERGED = readerOver({
    [`${WT_A}/lib/shared.ts`]: "export const x = 1\n",
    [`${WT_B}/lib/shared.ts`]: "export const x = 2\n",
  });
  const readings = readingsFor(
    [{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }],
    DIVERGED,
  );

  test("the reading the comparator produced really is DIFFERENT", () => {
    expect(readings[contentReadingKey(WT_A, "lib/shared.ts")]!.reading).toBe("DIFFERENT");
  });

  test("the collection is refused and the path does not collect", () => {
    const audit = auditWorktreeClaims(RESULTS, readings);
    expect(paths(audit)).toEqual(["lib/shared.ts"]);
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts"]);
  });

  test("the refusal names the divergence and the claiming worktree, not only the claim", () => {
    const detail = detailFor(auditWorktreeClaims(RESULTS, readings), "lib/shared.ts");
    expect(detail).toContain(WT_B);
    expect(detail).toContain("not the same bytes");
    expect(detail).toContain("lib/shared.ts");
  });

  test("the refusal is NOT the sentence the unread case produces", () => {
    // The whole value of the second reading is that an operator can tell the
    // two apart. Two refusals that read alike cost the same recovery whichever
    // one it was (#300).
    const withReading = detailFor(auditWorktreeClaims(RESULTS, readings), "lib/shared.ts");
    const withoutReading = detailFor(auditWorktreeClaims(RESULTS), "lib/shared.ts");
    expect(withReading).not.toBe(withoutReading);
    expect(withoutReading).not.toContain("not the same bytes");
  });
});

// ── AC-3: an unreadable copy is UNMEASURED, and refuses ──────

describe("AC-3: a copy that could not be read is UNMEASURED and refuses", () => {
  const RESULTS = [
    { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/shared.ts"], claimedFiles: ["lib/a.ts"] },
    {
      worktreePath: WT_B,
      filesChanged: ["lib/b.ts", "lib/shared.ts"],
      claimedFiles: ["lib/b.ts", "lib/shared.ts"],
    },
  ];
  /** The claimant's copy is gone; the reporting worktree's is there. */
  const HALF = readerOver({ [`${WT_A}/lib/shared.ts`]: "export const x = 1\n" });
  const readings = readingsFor([{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }], HALF);

  test("the comparator reports UNMEASURED and names the side that failed", () => {
    const reading = readings[contentReadingKey(WT_A, "lib/shared.ts")]!;
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unreadable.map(u => u.side)).toEqual(["claiming"]);
    expect(reading.unreadable[0]!.path).toBe(`${WT_B}/lib/shared.ts`);
  });

  test("the collection is refused", () => {
    const audit = auditWorktreeClaims(RESULTS, readings);
    expect(paths(audit)).toEqual(["lib/shared.ts"]);
    expect(keptBy(audit, WT_A)).toEqual(["lib/a.ts"]);
  });

  test("the refusal names the exact path that could not be read and the reason", () => {
    const detail = detailFor(auditWorktreeClaims(RESULTS, readings), "lib/shared.ts");
    expect(detail).toContain("UNMEASURED");
    expect(detail).toContain(`${WT_B}/lib/shared.ts`);
    expect(detail).toContain("ENOENT");
  });

  test("both sides unreadable names both paths", () => {
    const none = readerOver({});
    const both = readingsFor([{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }], none);
    const detail = detailFor(auditWorktreeClaims(RESULTS, both), "lib/shared.ts");
    expect(detail).toContain(`${WT_A}/lib/shared.ts`);
    expect(detail).toContain(`${WT_B}/lib/shared.ts`);
  });

  test("a readings object with no entry for the path is UNMEASURED, not permission", () => {
    // The fail-open this arm is most likely to grow: a caller that supplied
    // readings but could not produce one for this path. An absent entry is a
    // comparison that did not happen.
    const audit = auditWorktreeClaims(RESULTS, {});
    expect(paths(audit)).toEqual(["lib/shared.ts"]);
    expect(detailFor(audit, "lib/shared.ts")).toContain("UNMEASURED");
  });

  test("a reader that reports success with no digest is UNMEASURED, not IDENTICAL", () => {
    // `undefined === undefined` is true, so two copies nobody could read would
    // compare equal without this.
    const silent: ClaimCopyReader = () => ({ readable: true });
    const quiet = readingsFor([{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }], silent);
    expect(quiet[contentReadingKey(WT_A, "lib/shared.ts")]!.reading).toBe("UNMEASURED");
    expect(paths(auditWorktreeClaims(RESULTS, quiet))).toEqual(["lib/shared.ts"]);
  });

  test("a reader that throws is UNMEASURED carrying its own message", () => {
    const throws: ClaimCopyReader = p => {
      throw new Error(`EACCES: permission denied, open '${p}'`);
    };
    const refused = readingsFor([{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }], throws);
    expect(refused[contentReadingKey(WT_A, "lib/shared.ts")]!.reading).toBe("UNMEASURED");
    expect(detailFor(auditWorktreeClaims(RESULTS, refused), "lib/shared.ts")).toContain("EACCES");
  });
});

// ── AC-4: the reading is reached from one arm only ───────────

describe("AC-4: every other arm refuses with byte-identical copies in hand", () => {
  /**
   * One fixture shape per arm, each carrying TWO unclaimed paths:
   *
   *   `path`  — the arm's own, which must still be refused, and
   *   a single-claimant path that must be KEPT, so the case cannot pass
   *   because the reading was never consulted at all.
   */
  const ARMS: Array<{ arm: string; path: string; token: string; results: unknown[] }> = [
    {
      arm: "boundary escape",
      path: `${WT_B}/lib/b.ts`,
      token: "not inside its own worktree",
      results: [
        {
          worktreePath: WT_A,
          filesChanged: [`${WT_B}/lib/b.ts`, "lib/a.ts", "lib/shared.ts"],
          claimedFiles: ["lib/a.ts"],
        },
        {
          worktreePath: WT_B,
          filesChanged: ["lib/b.ts", "lib/shared.ts"],
          claimedFiles: ["lib/b.ts", "lib/shared.ts"],
        },
      ],
    },
    {
      arm: "path refusal inside the worktree",
      path: "lib/a;rm.ts",
      token: "cannot be staged",
      results: [
        {
          worktreePath: WT_A,
          filesChanged: ["lib/a;rm.ts", "lib/a.ts", "lib/shared.ts"],
          claimedFiles: ["lib/a;rm.ts", "lib/a.ts"],
        },
        {
          worktreePath: WT_B,
          filesChanged: ["lib/b.ts", "lib/shared.ts"],
          claimedFiles: ["lib/b.ts", "lib/shared.ts"],
        },
      ],
    },
    {
      arm: "DA-owned",
      path: "PROJECT-STATE.md",
      token: "DA-owned",
      results: [
        {
          worktreePath: WT_A,
          filesChanged: ["PROJECT-STATE.md", "lib/a.ts", "lib/shared.ts"],
          claimedFiles: ["lib/a.ts"],
        },
        {
          worktreePath: WT_B,
          filesChanged: ["lib/b.ts", "lib/shared.ts"],
          claimedFiles: ["lib/b.ts", "lib/shared.ts"],
        },
      ],
    },
    {
      arm: "co-owned conflict",
      path: ALLOWLISTS,
      token: "co-owned registry",
      results: [
        {
          worktreePath: WT_A,
          filesChanged: [ALLOWLISTS, "lib/a.ts", "lib/shared.ts"],
          claimedFiles: ["lib/a.ts"],
        },
        {
          worktreePath: WT_B,
          filesChanged: [ALLOWLISTS, "lib/b.ts", "lib/shared.ts"],
          claimedFiles: ["lib/b.ts", "lib/shared.ts"],
        },
      ],
    },
    {
      arm: "two claimants",
      path: "lib/contested.ts",
      token: "a file may have one claimant",
      results: [
        {
          worktreePath: WT_A,
          filesChanged: ["lib/contested.ts", "lib/a.ts", "lib/shared.ts"],
          claimedFiles: ["lib/a.ts", "lib/contested.ts"],
        },
        {
          worktreePath: WT_B,
          filesChanged: ["lib/b.ts", "lib/shared.ts"],
          claimedFiles: ["lib/b.ts", "lib/shared.ts", "lib/contested.ts"],
        },
      ],
    },
    {
      arm: "no claim issued",
      path: "lib/orphan.ts",
      token: "issued a claim at all",
      results: [
        { worktreePath: WT_A, filesChanged: ["lib/orphan.ts", "lib/a.ts"] },
        { worktreePath: WT_B, filesChanged: ["lib/b.ts"] },
      ],
    },
  ];

  /** Every path in every fixture reads as the same bytes from every worktree. */
  const IDENTICAL_EVERYWHERE: ClaimCopyReader = () => ({ readable: true, digest: "sha:same" });

  for (const row of ARMS) {
    test(`${row.arm} refuses even when the two copies are the same bytes`, () => {
      const all: Array<{ worktree: string; path: string; claimant: string }> = [];
      for (const r of row.results as Array<{ worktreePath: string; filesChanged: string[] }>) {
        for (const p of r.filesChanged) {
          // Every pairing the audit could possibly ask for, so an arm that
          // reached the reading would find one rather than falling into
          // UNMEASURED for want of an entry.
          all.push({ worktree: r.worktreePath, path: p, claimant: WT_A });
          all.push({ worktree: r.worktreePath, path: p, claimant: WT_B });
        }
      }
      const readings = readingsFor(all, IDENTICAL_EVERYWHERE);
      const audit = auditWorktreeClaims(row.results, readings);
      expect(detailFor(audit, row.path), `${row.arm} stopped refusing`).toContain(row.token);
      expect(keptBy(audit, WT_A)).not.toContain(row.path);
    });
  }

  test("the IDENTICAL reading really is reachable in these same fixtures", () => {
    // The precondition case. Without it, six arms refusing proves only that
    // something refused — a reading that was never consulted anywhere would
    // produce exactly this table.
    const row = ARMS[2]!; // DA-owned: its fixture also carries lib/shared.ts
    const readings = readingsFor(
      [{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }],
      IDENTICAL_EVERYWHERE,
    );
    const audit = auditWorktreeClaims(row.results, readings);
    expect(keptBy(audit, WT_A)).toContain("lib/shared.ts");
  });

  test("the single-claimant arm is the only one the reading can reach", () => {
    // Stated as a behaviour rather than as a comment: for every arm above, the
    // verdict with IDENTICAL readings equals the verdict with no readings at
    // all. If the reading leaked into one of them, the two would diverge.
    for (const row of ARMS) {
      const all = (row.results as Array<{ worktreePath: string; filesChanged: string[] }>).flatMap(
        r =>
          r.filesChanged.flatMap(p => [
            { worktree: r.worktreePath, path: p, claimant: WT_A },
            { worktree: r.worktreePath, path: p, claimant: WT_B },
          ]),
      );
      const withReading = auditWorktreeClaims(row.results, readingsFor(all, IDENTICAL_EVERYWHERE));
      const withoutReading = auditWorktreeClaims(row.results);
      expect(
        detailFor(withReading, row.path),
        `${row.arm} changed its refusal because of a content reading`,
      ).toBe(detailFor(withoutReading, row.path));
    }
  });
});

// ── AC-5: one comparator, injected, defaulting to the disk ───

describe("AC-5: one exported binding performs the comparison", () => {
  test("exactly one declaration across lib/ and scripts/", () => {
    const out = execFileSync(
      "bash",
      [
        "-lc",
        "grep -rn 'export function contentComparison' lib/ scripts/ 2>/dev/null | wc -l",
      ],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    ).trim();
    expect(
      Number(out),
      "a second comparator would survive any mutation of the first and both would read as covered",
    ).toBe(1);
  });

  test("the audit performs no comparison of its own", () => {
    // The ship.js block must CONSUME a reading. A digest or a byte comparison
    // inlined there is the second decider this binding exists to prevent, and
    // the sandbox cannot import the library to keep them in step (#69).
    expect(claimSource).not.toContain("createHash");
    expect(claimSource).not.toMatch(/readFileSync|Bun\.file/);
  });

  test("an injected reader forces IDENTICAL, DIFFERENT and UNMEASURED", () => {
    const same = contentComparison({
      path: "lib/x.ts",
      reportingWorktree: "/wt/a",
      claimingWorktree: "/wt/b",
      read: () => ({ readable: true, digest: "d1" }),
    });
    expect(same.reading).toBe("IDENTICAL");

    let n = 0;
    const differ = contentComparison({
      path: "lib/x.ts",
      reportingWorktree: "/wt/a",
      claimingWorktree: "/wt/b",
      read: () => ({ readable: true, digest: `d${++n}` }),
    });
    expect(differ.reading).toBe("DIFFERENT");

    const unread = contentComparison({
      path: "lib/x.ts",
      reportingWorktree: "/wt/a",
      claimingWorktree: "/wt/b",
      read: () => ({ readable: false, reason: "EISDIR: illegal operation on a directory" }),
    });
    expect(unread.reading).toBe("UNMEASURED");
    expect(unread.unreadable.map(u => u.path)).toEqual(["/wt/a/lib/x.ts", "/wt/b/lib/x.ts"]);
    expect(unread.unreadable[0]!.reason).toContain("EISDIR");
  });

  test("both sides are always read, so one side alone cannot satisfy a comparison", () => {
    const seen: string[] = [];
    contentComparison({
      path: "lib/x.ts",
      reportingWorktree: "/wt/a",
      claimingWorktree: "/wt/b",
      read: p => {
        seen.push(p);
        return { readable: true, digest: "d" };
      },
    });
    expect(seen).toEqual(["/wt/a/lib/x.ts", "/wt/b/lib/x.ts"]);
  });

  test("a failure with no reason still carries a sentence", () => {
    const silent = contentComparison({
      path: "lib/x.ts",
      reportingWorktree: "/wt/a",
      claimingWorktree: "/wt/b",
      read: () => ({ readable: false, reason: "   " }),
    });
    expect(silent.reading).toBe("UNMEASURED");
    expect(silent.unreadable[0]!.reason.length).toBeGreaterThan(10);
  });

  test("omitting the reader reads the filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "rungate-892-"));
    try {
      const plant = (wt: string, body: string) => {
        const file = join(root, wt, "lib", "x.ts");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
      };
      plant("a", "same\n");
      plant("b", "same\n");
      expect(
        contentComparison({
          path: "lib/x.ts",
          reportingWorktree: join(root, "a"),
          claimingWorktree: join(root, "b"),
        }).reading,
      ).toBe("IDENTICAL");

      plant("b", "different\n");
      expect(
        contentComparison({
          path: "lib/x.ts",
          reportingWorktree: join(root, "a"),
          claimingWorktree: join(root, "b"),
        }).reading,
      ).toBe("DIFFERENT");

      const absent = contentComparison({
        path: "lib/missing.ts",
        reportingWorktree: join(root, "a"),
        claimingWorktree: join(root, "b"),
      });
      expect(absent.reading).toBe("UNMEASURED");
      expect(absent.unreadable[0]!.reason).toContain("ENOENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── MUTANT: the cheapest wrong fix, performed and observed ───

describe("MUTANT: an unmeasured reading treated as permission", () => {
  /**
   * The 5pm repair, named before it arrives: the symptom is a refusal, so the
   * cheapest way to stop it is to permit everything the reading did not
   * explicitly call DIFFERENT. It makes the run go green, it reinstates the
   * #296 fail-open for every path nobody could read, and no assertion about
   * the IDENTICAL case can see it.
   *
   * So the collapse is PERFORMED on a copy of the block and observed, rather
   * than argued in prose. A mutation that cannot be built aborts the case —
   * a harness that silently no-ops when its anchor moves is the decorative
   * check `.claude/rules/checks-must-be-able-to-fail.md` is about.
   */
  const PERMITS = "reading.reading === 'IDENTICAL'";
  const FAIL_OPEN = "reading.reading !== 'DIFFERENT'";

  const RESULTS = [
    { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/shared.ts"], claimedFiles: ["lib/a.ts"] },
    {
      worktreePath: WT_B,
      filesChanged: ["lib/b.ts", "lib/shared.ts"],
      claimedFiles: ["lib/b.ts", "lib/shared.ts"],
    },
  ];
  const UNREADABLE = readingsFor(
    [{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }],
    readerOver({}),
  );

  function mutant(): Audit {
    const hits = claimSource.split(PERMITS).length - 1;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: the permission expression appears ${hits} times — ` +
          "a second site would survive this mutation and the proof would be decorative",
      );
    }
    return loadBlock(claimSource.replace(PERMITS, FAIL_OPEN)).auditWorktreeClaims;
  }

  test("the permission expression has exactly one site, so the mutation is total", () => {
    expect(claimSource.split(PERMITS).length - 1).toBe(1);
  });

  test("real: an unreadable comparison refuses", () => {
    expect(paths(auditWorktreeClaims(RESULTS, UNREADABLE))).toEqual(["lib/shared.ts"]);
  });

  test("mutant: the same unreadable comparison collects — the refusal is what the reading buys", () => {
    const audit = mutant()(RESULTS, UNREADABLE);
    expect(audit.violations).toEqual([]);
    expect(keptBy(audit, WT_A)).toContain("lib/shared.ts");
  });

  test("control: the mutant still refuses a DIFFERENT reading", () => {
    // Without this the row above is satisfied by a mutant that permits
    // everything, which would make the mutation a measurement of nothing.
    const diverged = readingsFor(
      [{ worktree: WT_A, path: "lib/shared.ts", claimant: WT_B }],
      readerOver({
        [`${WT_A}/lib/shared.ts`]: "one\n",
        [`${WT_B}/lib/shared.ts`]: "two\n",
      }),
    );
    expect(paths(mutant()(RESULTS, diverged))).toEqual(["lib/shared.ts"]);
  });
});
