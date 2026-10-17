/**
 * Covers SC-1964..SC-1967 (DOC-HYGIENE-ARCHITECTURE-SPEC.md), #508.
 *
 * HYGIENE-6 ends in `expect(true).toBe(true)` — a gate-shaped name over an
 * unconditional pass, deliberately, because it reports a review BACKLOG and
 * asserting that to zero would block every push. The leniency is right and
 * the consequence was not: with nothing asserted about the READING, the only
 * red the check could produce was a timeout, and that is the red it produced
 * four times before #508 made the staleness scan one git call.
 *
 * What the check can honestly assert is its own coverage. `0 candidates` over
 * 91 documents and `0 candidates` over 4 are the same line of output, and
 * `.claude/rules/checks-must-be-able-to-fail.md` names that shape after #492
 * measured it: a scan that reports a verdict should report how many files it
 * read of how many it could see.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { planDocScan } from "../lib/doc-scan-targets";
import { extractConstraints } from "../scripts/extract-constraints";

const REPO_ROOT = join(import.meta.dir, "..");

/** A project with `n` documents under `docs/`, each carrying one signal phrase. */
function project(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-508-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(dir, "docs", `DOC-${i}.md`),
      `# Doc ${i}\n\nDo not remove the guard on channel ${i} or the pipeline stalls.\n`,
    );
  }
  return dir;
}

describe("#508: the constraint scan reports what it read, not only what it found", () => {
  test("SC-1964: a planned document that cannot be read is named, and the rest are still read", async () => {
    const dir = project(3);
    try {
      const plan = planDocScan(dir);
      expect(plan.files.length, "the fixture planned nothing, so there is nothing to lose").toBe(3);

      // The file moves between the walk and the read — the race the branch
      // exists for, reproduced by handing back a plan the tree no longer
      // matches rather than by mocking the filesystem.
      const gone = plan.files[1]!;
      rmSync(gone);

      const result = await extractConstraints(dir, { apply: false, plan });

      expect(result.coverage.planned, "the plan's size was not carried through").toBe(3);
      expect(result.coverage.read, "a file that vanished was counted as read").toBe(2);
      expect(result.coverage.unread.map(u => u.file)).toEqual(["docs/DOC-1.md"]);
      expect(result.coverage.unread[0]!.reason, "the reason is not the errno that stopped the read").toBe("ENOENT");

      // The positive control, and the half that makes this a coverage reading
      // rather than a refusal: the two survivors were read, so one bad file
      // does not take the backlog report down with it. Without this, an
      // implementation that abandoned the whole scan at the first error would
      // satisfy every assertion above.
      expect(result.candidates.length, "the readable documents contributed nothing").toBe(2);
      expect(result.candidates.map(c => c.source).sort()).toEqual(["docs/DOC-0.md:3", "docs/DOC-2.md:3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1965: the counts are the scan's own and move with it", async () => {
    // A constant satisfies SC-1964's `planned` and `read` as readily as a
    // measurement does — `3` and `2` are what that fixture happens to have.
    // Two fixtures of different sizes are what makes them a reading.
    const small = project(2);
    const large = project(9);
    try {
      const a = await extractConstraints(small, { apply: false });
      const b = await extractConstraints(large, { apply: false });

      expect(a.coverage).toEqual({ planned: 2, read: 2, unread: [] });
      expect(b.coverage).toEqual({ planned: 9, read: 9, unread: [] });
      expect(a.coverage.read, "the two scans report the same number over different trees").not.toBe(b.coverage.read);
    } finally {
      rmSync(small, { recursive: true, force: true });
      rmSync(large, { recursive: true, force: true });
    }
  });

  test("SC-1966: a directory whose name ends in .md is not planned as a document", async () => {
    // The flat root scan asked the suffix and never asked the filesystem,
    // while the recursive walk beside it asks `statSync` before it decides.
    // So a directory called `NOTES.md` at the project root was planned as a
    // document, and `readFileSync` on it throws EISDIR — a plan naming a file
    // it could never read.
    const dir = project(1);
    try {
      mkdirSync(join(dir, "NOTES.md"));
      writeFileSync(join(dir, "README.md"), "# Readme\n\nDo not remove the health route; the probe depends on it.\n");

      const plan = planDocScan(dir);
      const planned = plan.files.map(f => f.slice(dir.length + 1)).sort();

      // Both halves. A plan that dropped every root-level `.md` would satisfy
      // the first assertion on its own, and that is the cheapest wrong fix
      // available here.
      expect(planned, "the directory was planned as a document").not.toContain("NOTES.md");
      expect(planned, "the real root-level document was dropped along with it").toContain("README.md");

      const result = await extractConstraints(dir, { apply: false });
      expect(result.coverage.unread, "the scan still planned something it could not read").toEqual([]);
      expect(result.coverage.read).toBe(plan.files.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1967: on this repository every planned document is read", async () => {
    // The live-tree case, and the one HYGIENE-6 itself asserts. Everything
    // above is a fixture; this is the tree the check runs over, where a
    // partial scan would otherwise be reported as a backlog of zero.
    const result = await extractConstraints(REPO_ROOT, { apply: false });

    expect(result.coverage.planned, "the scan of this repo planned almost nothing").toBeGreaterThan(50);
    expect(
      result.coverage.unread,
      "planned documents in this repo could not be read, so its candidate list is partial",
    ).toEqual([]);
    expect(result.coverage.read).toBe(result.coverage.planned);
  }, 30_000);
});
