/**
 * Covers SC-1530..SC-1535 (PARALLEL-AGENT-COORDINATION-SPEC.md), issue #400.
 *
 * Two validators in `workflows/ship.js` answered "is this path safe", and they
 * agreed only on traversal:
 *
 *   validateFilePaths  — regex set over the raw string, at STAGING time
 *   escapesWorktree    — segment walk over an already-normalised key, at
 *                        COLLECTION time
 *
 * So the audit accepted a reported path carrying a shell metacharacter, a null
 * byte, or 500+ characters, reported the run clean, and staging refused it
 * afterwards — late, in a different phase, with a different message. Nobody
 * was misled while staging still refused; the cost is that the audit's verdict
 * could not be relied on, and the next caller to trust it instead of
 * re-validating inherits the hole.
 *
 * ## Why the parity assertion is not the whole test
 *
 * Once both phases call one predicate, parity is satisfied by a predicate that
 * refuses NOTHING. Removing a rule makes both sides permissive together and a
 * pure parity test stays green — the exact vacuity
 * `.claude/rules/checks-must-be-able-to-fail.md` is about, and the exact trap
 * #397 and #399 each hit once: a test parameterised by the thing it checks
 * cannot check it.
 *
 * So every corpus row carries a LITERAL expected verdict, written out by hand
 * and derived from nothing. Each row is asserted three times — staging against
 * the literal, the audit against the literal, and the two against each other.
 * Removing a rule from the shared predicate turns the first two red; changing
 * one phase and not the other turns the third red. That is SC-1535's "red in
 * both directions", and it is why the literals are here rather than computed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const WT_A = "/tmp/wt-a";
const WT_B = "/tmp/wt-b";

interface Violation {
  worktreePath: string;
  path: string;
  claimant: string | null;
  detail: string;
}

function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

/**
 * Both blocks, evaluated together, because #400's whole point is that they now
 * share one decider. Loading COLLECT-CLAIM alone would throw on the first call
 * — which is the structural proof that the audit really does reach into the
 * security block rather than keeping a second copy of the rules.
 */
function loadBothPhases(): {
  validateFilePaths: (p: string[]) => { valid: string[]; rejected: string[] };
  buildSafeGitAdd: (p: string[]) => string;
  auditWorktreeClaims: (r: unknown) => { violations: Violation[]; candidates: unknown[] };
  claimKey: (wt: string, p: unknown) => string;
  pathRefusal: (p: string) => { rule: string; boundary: boolean } | null;
} {
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${block("SECURITY-HELPERS")}
     ${block("COLLECT-CLAIM")}
     return { validateFilePaths, buildSafeGitAdd, auditWorktreeClaims, claimKey, pathRefusal }`,
  )("/repo", () => {});
}

const { validateFilePaths, auditWorktreeClaims, claimKey, pathRefusal } = loadBothPhases();

/**
 * One corpus, one literal verdict each.
 *
 * `rule` is the name the audit must print when it refuses, and `boundary`
 * separates "this path is not inside the worktree at all" from "it is inside
 * and still cannot be handled safely" — SC-1532's distinction, because
 * "not inside its own worktree" is a wrong sentence to show an operator about
 * `lib/a;rm.ts`.
 */
interface Row {
  path: string;
  refused: boolean;
  rule: string | null;
  boundary: boolean;
  why: string;
}

const CORPUS: Row[] = [
  // ── permitted ───────────────────────────────────────────────
  { path: "lib/a.ts", refused: false, rule: null, boundary: false, why: "an ordinary source file" },
  { path: "a.ts", refused: false, rule: null, boundary: false, why: "a file at the root" },
  { path: "test/sub-dir/x.test.ts", refused: false, rule: null, boundary: false, why: "nested, hyphenated" },
  { path: "docs/adr/ADR-001.md", refused: false, rule: null, boundary: false, why: "dots inside a segment" },
  { path: "x".repeat(500), refused: false, rule: null, boundary: false, why: "exactly at the limit, not over it" },

  // ── outside the worktree ────────────────────────────────────
  { path: "/etc/passwd", refused: true, rule: "an absolute path", boundary: true, why: "absolute" },
  { path: "../outside.ts", refused: true, rule: "a `..` segment", boundary: true, why: "climbs out" },
  { path: "a/../../b.ts", refused: true, rule: "a `..` segment", boundary: true, why: "climbs out mid-path" },
  { path: "..", refused: true, rule: "a `..` segment", boundary: true, why: "the parent itself" },

  // ── inside the worktree, and still unsafe ───────────────────
  // Every one of these was accepted by the audit before #400 and refused by
  // staging afterwards. They are the issue.
  { path: "lib/a;rm.ts", refused: true, rule: "a shell metacharacter", boundary: false, why: "command separator" },
  { path: "lib/$(whoami).ts", refused: true, rule: "a shell metacharacter", boundary: false, why: "substitution" },
  { path: "lib/it's.ts", refused: true, rule: "a shell metacharacter", boundary: false, why: "quote" },
  { path: "lib/a*.ts", refused: true, rule: "a shell metacharacter", boundary: false, why: "glob" },
  { path: "lib/a\u0000b.ts", refused: true, rule: "a null byte", boundary: false, why: "truncates in C" },
  { path: `lib/${"x".repeat(500)}.ts`, refused: true, rule: "over 500 characters", boundary: false, why: "over the limit" },
  { path: "lib/foo..", refused: true, rule: "a segment ending in `..`", boundary: false, why: "staging's regex refuses it, so the audit must too" },
];

/**
 * The corpus is compared on KEYS, not on raw reports.
 *
 * `claimKey` runs before the audit's check and strips the worktree prefix, so
 * `/tmp/wt-a/lib/a.ts` is absolute to staging and relative to the audit — a
 * divergence that is correct and by design (`relativizePaths` exists for it).
 * Comparing those would make this file fail for a reason it is not about. A
 * row that normalises to something else is therefore a corpus bug, and this
 * asserts it rather than leaving it to be discovered as a confusing failure.
 */
describe("SC-1530: the corpus is canonical, so the two phases see one string", () => {
  for (const row of CORPUS) {
    test(`claimKey leaves ${JSON.stringify(row.path).slice(0, 44)} alone`, () => {
      expect(claimKey(WT_A, row.path)).toBe(row.path);
    });
  }
});

/** A worktree that claimed the path and reported it. Two participants, so
 *  SINGLE_WORKTREE_EXEMPT is not what decides the answer. */
function auditVerdict(path: string): Violation | null {
  const got = auditWorktreeClaims([
    { worktreePath: WT_A, filesChanged: [path], claimedFiles: [path] },
    { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
  ]).violations.filter(v => v.worktreePath === WT_A);
  if (got.length > 1) {
    throw new Error(`${path} produced ${got.length} violations — the row drives more than one kind`);
  }
  return got[0] ?? null;
}

describe("SC-1531: staging and the audit refuse the same paths", () => {
  for (const row of CORPUS) {
    const label = `${JSON.stringify(row.path).slice(0, 44)} — ${row.why}`;

    test(`staging: ${label}`, () => {
      // Against the LITERAL. If this read the predicate it would be the
      // predicate agreeing with itself.
      expect(validateFilePaths([row.path]).rejected.length > 0).toBe(row.refused);
    });

    test(`audit: ${label}`, () => {
      expect(auditVerdict(row.path) !== null).toBe(row.refused);
    });

    test(`parity: ${label}`, () => {
      // The third assertion is the one that catches a change to one phase and
      // not the other, which is what #400 was.
      expect(auditVerdict(row.path) !== null).toBe(
        validateFilePaths([row.path]).rejected.length > 0,
      );
    });
  }
});

describe("SC-1532: a refused path is told which rule refused it", () => {
  for (const row of CORPUS.filter(r => r.refused)) {
    test(`${JSON.stringify(row.path).slice(0, 44)} names "${row.rule}"`, () => {
      const v = auditVerdict(row.path);
      expect(v, "expected a violation").not.toBeNull();
      expect(v!.detail).toContain(row.rule!);
    });
  }

  test("a path inside the worktree is not called a boundary escape", () => {
    // The sentence an operator reads has to be true. `lib/a;rm.ts` IS inside
    // the worktree; it is merely unsafe, and saying otherwise sends them to
    // look for a path that is not there.
    for (const row of CORPUS.filter(r => r.refused && !r.boundary)) {
      expect(auditVerdict(row.path)!.detail, row.path).not.toContain(
        "not inside its own worktree",
      );
    }
  });

  test("a path outside the worktree still says so", () => {
    for (const row of CORPUS.filter(r => r.refused && r.boundary)) {
      expect(auditVerdict(row.path)!.detail, row.path).toContain(
        "not inside its own worktree",
      );
    }
  });
});

describe("SC-1533: one predicate, reached by both phases", () => {
  test("the rule table is declared exactly once in ship.js", () => {
    // A second table would survive any mutation of the first and the parity
    // above would go green for the wrong reason.
    const declarations = (shipSource.match(/const CONTRIBUTABLE_PATH_RULES = \[/g) || []).length;
    expect(declarations, "CONTRIBUTABLE_PATH_RULES must be declared once").toBe(1);
  });

  test("the decider is declared once and called from both phases", () => {
    const security = block("SECURITY-HELPERS");
    const collect = block("COLLECT-CLAIM");
    expect((shipSource.match(/function pathRefusal\(/g) || []).length).toBe(1);
    // Declared in the security block, which is the half mirrored by
    // lib/workflow-security.ts, and reached from the collection block.
    expect(security).toContain("function pathRefusal(");
    expect(collect).toContain("pathRefusal(");
  });

  test("neither copy of validateFilePaths keeps a second set of rules", () => {
    // This is the defect #400 is about, met inside #400's own fix. The first
    // draft added the table and the decider to lib/workflow-security.ts and
    // left `validateFilePaths` THERE still running its original regex chain —
    // two deciders in the file whose whole subject is that there was more
    // than one. Nothing could see it: the chain and the table agreed on every
    // corpus row, so the ship-versus-library parity above stayed green, and
    // it surfaced only because a mutation of the library's 500-character rule
    // turned one test red where two were expected.
    //
    // A count of the regex names cannot express this — `resolveEvidencePath`
    // and `buildSafeSSHCommand` use them legitimately. The property is local:
    // this one function asks the decider and tests nothing itself.
    const sources: Array<[string, string]> = [
      ["workflows/ship.js", shipSource],
      [
        "lib/workflow-security.ts",
        readFileSync(join(REPO_ROOT, "lib", "workflow-security.ts"), "utf-8"),
      ],
    ];
    for (const [name, src] of sources) {
      const at = src.indexOf("function validateFilePaths(");
      expect(at, `${name}: no validateFilePaths`).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf("\n}", at));
      expect(body, `${name} must ask the shared decider`).toContain("pathRefusal(");
      for (const rule of ["SHELL_METACHARACTERS", "PATH_TRAVERSAL", "NULL_BYTE", "length > 500"]) {
        expect(body.includes(rule), `${name} applies ${rule} itself instead of asking the table`).toBe(false);
      }
    }
  });

  test("every rule in the table is reachable by some corpus row", () => {
    // A rule nothing exercises is a rule whose removal nothing notices, and
    // the mutation table in the spec would be measuring five rules while
    // claiming six.
    const refusedRules = new Set(CORPUS.filter(r => r.refused).map(r => r.rule!));
    const tabled = new Set<string>();
    for (const p of CORPUS) {
      const r = pathRefusal(p.path);
      if (r) tabled.add(r.rule);
    }
    expect([...tabled].sort()).toEqual([...refusedRules].sort());
    expect(tabled.size).toBe(6);
  });
});
