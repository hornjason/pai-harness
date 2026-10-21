/**
 * The claim-content reading (#892, Phase 1 — sub-issue 892001).
 *
 * `auditWorktreeClaims` decides on the claim ledger ALONE. Run
 * `wf_161c4e96-f01` — 24 agents, 0 errors, ~35 minutes — reached Commit and
 * refused nine files as unclaimed whose bytes were IDENTICAL across all three
 * preserved worktrees, and produced no PR. The ledger disagreed with itself;
 * the content did not.
 *
 * This file covers the READING only: one binding that compares a reporting
 * worktree's copy of a path against the claiming worktree's copy and answers
 * IDENTICAL, DIFFERENT or UNMEASURED. Wiring it into the single-claimant arm
 * is a separate sub-issue, so nothing here drives the audit.
 *
 * AC labels are the issue's. No `SC-` id is claimed from this file: the ids
 * for #892 are reserved in `specs/sc-reservations.json` and are consumed by
 * the sub-issue that writes the spec section, not by this one.
 *
 * ## What was broken to prove these cases can fail
 *
 * Run and counted over this file, with the baseline row read BEFORE any
 * mutation row — an instrument that has stopped reporting takes the baseline
 * down with it, and that is the row nobody mutates anything to produce
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * Every count was predicted before the battery ran, and each row's
 * distinguishing input was printed from the mutant AND from the real source
 * before the row was believed — a mutant that behaves identically on every
 * input the cases supply is the code run twice, not a measurement.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 19 pass, 0 fail | **19 pass, 0 fail** | — |
 * | R1 the whole binding short-circuited to `return { reading: "IDENTICAL", … }` | 15 | **15 of 19** | two copies whose digests are `aaa` and `bbb`: the original returns `DIFFERENT`, the mutant `IDENTICAL` — and so does it for every unreadable input |
 * | R2 only the equality collapsed — `(a === b \|\| true)`, every read still taken | 3 | **3 of 19** | the same two copies. All eight UNMEASURED cases stay GREEN, which is what says the refusal is upstream of the comparison rather than a second copy of it |
 * | R3 the empty-reason substitution removed — an absent reason left as `""` | 1 | **1 of 19** | a reader failing with `reason: "   "` on both sides: the original carries `the reader reported a failure and gave no reason`, the mutant carries `["", ""]`, and an operator is told nothing |
 * | R4 the `typeof digest === "string"` usability check removed | 1 | **1 of 19** | a reader returning `{ readable: true }` with no digest on both sides: the original is UNMEASURED, the mutant compares `undefined` with `undefined` and answers **IDENTICAL** |
 *
 * R4 is the Silent Default Substitution this file exists to stop: two copies
 * nobody could read agreeing perfectly. R2 and R3 are the rows that say the
 * three readings are decided in three separable places — collapsing one leaves
 * the other two reporting exactly as before.
 *
 * None of the four mutations is left in the tree; all were run and reverted,
 * and `lib/claim-content.ts` was confirmed byte-identical to the measured
 * source afterwards by sha256
 * (`b8b3578ada2c4e848b6f16bb98eabdca80a9b0f26a2c6a816d82cd5a395053a6`).
 *
 * **The cheapest wrong fix, named: drop the claimant arm's violation
 * entirely** — stop refusing a reported-but-unclaimed file, on the grounds
 * that this run's content was fine. One line, the symptom goes away, and
 * SC-413 is gone with it. Nothing in THIS file survives or fails that repair,
 * because nothing here drives the audit — it is named so the sub-issue that
 * does the wiring inherits it, and the DIFFERENT and UNMEASURED cases below
 * are what make a refusal still reachable once it is wired.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import * as claimContent from "../lib/claim-content";
import { compareClaimedFileContent } from "../lib/claim-content";
import type { ClaimContentReader } from "../lib/claim-content";

const REPO_ROOT = join(import.meta.dir, "..");
const SOURCE = readFileSync(join(REPO_ROOT, "lib/claim-content.ts"), "utf8");

const REPORTING = "/run/wf-16";
const CLAIMING = "/run/wf-11";
const PATH = "src/daemon/auto-reflection.ts";

/** A reader that answers from a table keyed by the absolute path it is given. */
function readerOf(table: Record<string, ReturnType<ClaimContentReader>>): ClaimContentReader {
  return (p: string) => table[p] ?? { readable: false, reason: `no fixture for ${p}` };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "claim-content-"));
}

describe("#892 AC-5: one binding, and it is the only position that compares", () => {
  test("the module exports exactly one runtime binding", () => {
    // Executed, not described: types are erased, so the keys of the loaded
    // namespace are the runtime exports and nothing else.
    expect(Object.keys(claimContent)).toEqual(["compareClaimedFileContent"]);
  });

  test("the comparison is declared at exactly one position across lib/, scripts/ and workflows/", () => {
    const dirs = ["lib", "scripts", "workflows"];
    const hits: string[] = [];
    for (const dir of dirs) {
      const glob = new Bun.Glob("**/*.{ts,js,mjs}");
      for (const rel of glob.scanSync({ cwd: join(REPO_ROOT, dir) })) {
        const file = join(dir, rel);
        const src = readFileSync(join(REPO_ROOT, file), "utf8");
        const declarations = src.match(/function\s+compareClaimedFileContent\b/g) ?? [];
        for (let i = 0; i < declarations.length; i++) hits.push(file);
      }
    }
    expect(hits).toEqual(["lib/claim-content.ts"]);
  });
});

describe("#892 AC-1/AC-2: IDENTICAL and DIFFERENT, through an injected reader", () => {
  test("two copies with the same digest read IDENTICAL", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: true, digest: "aaa" },
        [`${CLAIMING}/${PATH}`]: { readable: true, digest: "aaa" },
      }),
    });
    expect(result.reading).toBe("IDENTICAL");
    expect(result.unreadable).toEqual([]);
    expect(result.path).toBe(PATH);
    expect(result.reportingPath).toBe(`${REPORTING}/${PATH}`);
    expect(result.claimingPath).toBe(`${CLAIMING}/${PATH}`);
  });

  test("two copies with different digests read DIFFERENT", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: true, digest: "aaa" },
        [`${CLAIMING}/${PATH}`]: { readable: true, digest: "bbb" },
      }),
    });
    expect(result.reading).toBe("DIFFERENT");
    expect(result.unreadable).toEqual([]);
  });

  test("the reader is asked for both sides, each at its own worktree", () => {
    // A comparison that only ever read one side would answer IDENTICAL for
    // free. The asked-for paths are recorded and asserted.
    const asked: string[] = [];
    compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: (p: string) => {
        asked.push(p);
        return { readable: true, digest: "aaa" };
      },
    });
    expect(asked).toEqual([`${REPORTING}/${PATH}`, `${CLAIMING}/${PATH}`]);
  });

  test("a path reported as an absolute path inside the reporting worktree is not re-rooted twice", () => {
    // claimKey in the audit normalises before this is ever called, so the
    // binding takes a relative path. A leading slash must not silently read
    // the claiming worktree's copy of someone else's absolute path: it joins,
    // and the two sides stay distinct.
    const asked: string[] = [];
    compareClaimedFileContent({
      path: `/${PATH}`,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: (p: string) => {
        asked.push(p);
        return { readable: true, digest: "aaa" };
      },
    });
    expect(asked).toEqual([`${REPORTING}/${PATH}`, `${CLAIMING}/${PATH}`]);
  });
});

describe("#892 AC-3: a copy that cannot be read is UNMEASURED, by name and reason", () => {
  test("the reporting copy is unreadable — the exact path and the reader's own reason travel", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: false, reason: "ENOENT: no such file or directory" },
        [`${CLAIMING}/${PATH}`]: { readable: true, digest: "aaa" },
      }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable).toEqual([
      {
        side: "reporting",
        path: `${REPORTING}/${PATH}`,
        reason: "ENOENT: no such file or directory",
      },
    ]);
  });

  test("the claiming copy is unreadable — the same, from the other side", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: true, digest: "aaa" },
        [`${CLAIMING}/${PATH}`]: { readable: false, reason: "EACCES: permission denied" },
      }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable).toEqual([
      { side: "claiming", path: `${CLAIMING}/${PATH}`, reason: "EACCES: permission denied" },
    ]);
  });

  test("both copies unreadable — both sides are named, neither is dropped", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: false, reason: "ENOENT" },
        [`${CLAIMING}/${PATH}`]: { readable: false, reason: "EISDIR" },
      }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable.map(u => u.side)).toEqual(["reporting", "claiming"]);
    expect(result.unreadable.map(u => u.reason)).toEqual(["ENOENT", "EISDIR"]);
  });

  test("an absent or empty reason is itself UNMEASURED, and says the reader gave none", () => {
    // The trap: a failure with no sentence beside it reads, to anyone
    // downstream, exactly like a failure nobody recorded.
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: false, reason: "   " },
        [`${CLAIMING}/${PATH}`]: { readable: false },
      }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable.map(u => u.reason)).toEqual([
      "the reader reported a failure and gave no reason",
      "the reader reported a failure and gave no reason",
    ]);
  });

  test("a reader that reports success with no digest is UNMEASURED, never IDENTICAL", () => {
    // Two copies nobody could read must not agree perfectly. `undefined`
    // equals `undefined`, which is the whole of Silent Default Substitution.
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: readerOf({
        [`${REPORTING}/${PATH}`]: { readable: true },
        [`${CLAIMING}/${PATH}`]: { readable: true },
      }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.reading).not.toBe("IDENTICAL");
    expect(result.unreadable.map(u => u.reason)).toEqual([
      "the reader reported success and returned no digest",
      "the reader reported success and returned no digest",
    ]);
  });

  test("a reader that throws is UNMEASURED carrying the thrown message", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: () => {
        throw new Error("the reader exploded");
      },
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable.map(u => u.reason)).toEqual([
      "the reader exploded",
      "the reader exploded",
    ]);
  });

  test("an empty path is UNMEASURED rather than a comparison of two directories", () => {
    const result = compareClaimedFileContent({
      path: "   ",
      reportingWorktree: REPORTING,
      claimingWorktree: CLAIMING,
      read: () => ({ readable: true, digest: "aaa" }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable.map(u => u.reason)).toEqual([
      "no path was given to compare",
      "no path was given to compare",
    ]);
  });

  test("a worktree with no path is UNMEASURED, and says which side had none", () => {
    const result = compareClaimedFileContent({
      path: PATH,
      reportingWorktree: "",
      claimingWorktree: CLAIMING,
      read: () => ({ readable: true, digest: "aaa" }),
    });
    expect(result.reading).toBe("UNMEASURED");
    expect(result.unreadable).toEqual([
      { side: "reporting", path: PATH, reason: "no worktree directory was given for this side" },
    ]);
  });
});

describe("#892 AC-5: omitting the reader reads the filesystem", () => {
  test("two real files with the same bytes read IDENTICAL", () => {
    const root = scratch();
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      mkdirSync(join(a, "src"), { recursive: true });
      mkdirSync(join(b, "src"), { recursive: true });
      writeFileSync(join(a, "src/x.ts"), "export const x = 1\n");
      writeFileSync(join(b, "src/x.ts"), "export const x = 1\n");

      const result = compareClaimedFileContent({
        path: "src/x.ts",
        reportingWorktree: a,
        claimingWorktree: b,
      });
      expect(result.reading).toBe("IDENTICAL");
      expect(result.unreadable).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two real files differing by ONE byte read DIFFERENT", () => {
    // One byte, because a reader comparing sizes, or mtimes, or the first
    // line, passes every fixture that differs more loudly than this.
    const root = scratch();
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      mkdirSync(join(a, "src"), { recursive: true });
      mkdirSync(join(b, "src"), { recursive: true });
      writeFileSync(join(a, "src/x.ts"), "export const x = 1\n");
      writeFileSync(join(b, "src/x.ts"), "export const x = 2\n");

      const result = compareClaimedFileContent({
        path: "src/x.ts",
        reportingWorktree: a,
        claimingWorktree: b,
      });
      expect(result.reading).toBe("DIFFERENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a real file absent on one side is UNMEASURED carrying that path and the OS reason", () => {
    const root = scratch();
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      mkdirSync(join(a, "src"), { recursive: true });
      mkdirSync(join(b, "src"), { recursive: true });
      writeFileSync(join(a, "src/x.ts"), "export const x = 1\n");

      const result = compareClaimedFileContent({
        path: "src/x.ts",
        reportingWorktree: a,
        claimingWorktree: b,
      });
      expect(result.reading).toBe("UNMEASURED");
      expect(result.unreadable.map(u => u.side)).toEqual(["claiming"]);
      expect(result.unreadable[0]!.path).toBe(join(b, "src/x.ts"));
      // The OS's own sentence, not one this module invented for it.
      expect(result.unreadable[0]!.reason).toContain("ENOENT");
      expect(result.unreadable[0]!.reason).toContain(join(b, "src/x.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the built-in reader compares BYTES, not a decoding of them", () => {
    // Two files that decode to the same string under a lossy decoder and are
    // not the same bytes. A digest over the buffer separates them; a utf8
    // read does not.
    const root = scratch();
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, "bin"), Buffer.from([0xff, 0xfe]));
      writeFileSync(join(b, "bin"), Buffer.from([0xff, 0xfd]));

      const result = compareClaimedFileContent({
        path: "bin",
        reportingWorktree: a,
        claimingWorktree: b,
      });
      expect(result.reading).toBe("DIFFERENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#892: the source says what it is, so the mutation has one site", () => {
  test("the equality that decides IDENTICAL appears exactly once in the module", () => {
    // One binding is only one DECIDER if the comparison inside it is not
    // written twice. A second copy survives any mutation of the first.
    const comparisons = SOURCE.match(/reportingDigest === claimingDigest/g) ?? [];
    expect(comparisons.length).toBe(1);
  });
});
