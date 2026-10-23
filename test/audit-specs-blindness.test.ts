/**
 * `audit-specs` reported a confident, wrong number, and three separate
 * narrownesses caused it. One binding fixes all three.
 *
 * The reporter carried its own, narrower spelling of two things the tree
 * already decides elsewhere:
 *
 *   1. **what a criterion id is** — `/^- \[ \] (SC-\w+):\s*(.+)$/gm`, against
 *      `lib/sc-ids.ts`, whose `TRACKED_ID_PREFIXES` is the single list and
 *      whose `SC_ID_SOURCE` is built from it (#1313). `SC-\w+` cannot match
 *      `CRC-A1`, so `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` — 56 criteria,
 *      `compliance: strict` — reported `total 0`.
 *   2. **what a spec file is** — `readdirSync(specsDir)`, against
 *      `lib/spec-files.ts`'s `collectSpecFiles`, which descends.
 *      `scripts/detect-sc-drift.ts` already carries a docblock about having
 *      fixed exactly this for itself, so the reporter and the gate disagreed
 *      about what a spec is and the gate was the one that was right.
 *
 * The third is inside the first: the literal `- [ ] ` cannot match a TICKED
 * criterion in ANY namespace, so the `SC-` side had been under-reporting for
 * its whole life. Nobody noticed because the number it printed was plausible.
 *
 * That is the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * pointing the wrong way: a REPORTER disagreeing with the GATES. The repair is
 * to delete the reporter's opinion, not to widen it.
 *
 * ## What is deliberately NOT widened
 *
 * Reporting a criterion costs a row in a table. Rewriting one EDITS A SPEC,
 * and #1286 is open about `--fix` damaging a file it should not have touched.
 * Those are different decisions with different risk, so `isRewriteCandidate`
 * holds the writer to the population it had before this change — measured, not
 * approximated. See AB-7 and AB-8.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { auditSpecs, isRewriteCandidate } from "../scripts/audit-specs";
import { collectSpecFiles } from "../lib/spec-files";
import { parseScDeclarations } from "../lib/sc-ids";
import { parseFrontmatter } from "../lib/conformity";

const REPO_ROOT = join(import.meta.dir, "..");
const AUDIT_SOURCE = join(REPO_ROOT, "scripts", "audit-specs.ts");

const FRONTMATTER = `---
doc-type: spec
status: active
testable: true
compliance: strict
updated: 2026-10-23
governs: a fixture
---

# Fixture

## Success Criteria

`;

/** A throwaway project root. Returns the root; the caller removes it. */
function fixtureRoot(specs: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "audit-specs-blindness-"));
  for (const [rel, body] of Object.entries(specs)) {
    const path = join(root, "specs", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, FRONTMATTER + body);
  }
  return root;
}

function withFixture(specs: Record<string, string>, fn: (root: string) => void) {
  const root = fixtureRoot(specs);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rowFor = (root: string, file: string) =>
  auditSpecs(root).specs.find((s) => s.specFile === file);

/** The source with both comment forms removed. See AB-3's second case. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── AB-1: the id namespace ───────────────────────────────────
//
// Distinguishing input: the `CRC-` line. The pre-change `SC-\w+` reports
// total 1 on this fixture; the shared binding reports 2.

describe("AB-1: every tracked namespace is read, not just SC-", () => {
  test("a CRC- criterion is counted beside an SC- one", () => {
    withFixture(
      {
        "NS-SPEC.md":
          "- [ ] SC-9510: AGENTS.md exists\n- [ ] CRC-9510: AGENTS.md exists\n",
      },
      (root) => {
        const row = rowFor(root, "NS-SPEC.md")!;
        expect(row).toBeDefined();
        expect(row.total).toBe(2);
        const seen = [...row.matchedSCs, ...row.unmatchedSCs, ...row.behavioralSCs]
          .map((c) => c.id)
          .sort();
        // Membership, not just the count: a reader that counted lines rather
        // than ids would satisfy `total === 2` and fail here.
        expect(seen).toEqual(["CRC-9510", "SC-9510"]);
      },
    );
  });

  test("the reporter reads whatever TRACKED_ID_PREFIXES says, with no list of its own", () => {
    // `audit-specs` must not name a namespace anywhere. A second list would
    // survive any mutation of the first, and the next prefix added to
    // `lib/sc-ids.ts` would be invisible here while both looked covered.
    const src = readFileSync(AUDIT_SOURCE, "utf-8");
    expect(code(src)).not.toContain("SC-\\w+");
    expect(code(src)).not.toMatch(/\bCRC\b/);
    expect(src).toContain('from "../lib/sc-ids"');
  });

  test("the live convergence spec is no longer invisible", () => {
    // Pre-change this row read `total 0` on a `compliance: strict` spec
    // declaring 56 criteria, and that zero read as "nothing to do".
    //
    // A FLOOR, not an equality: `rg-crc-bind` is concurrently binding these
    // and the count is not a property this case owns
    // (`.claude/rules/checks-must-be-able-to-fail.md`, on asserting a number
    // about a collection you do not own). Non-emptiness is the claim.
    const row = rowFor(REPO_ROOT, "CODE-REVIEW-CONVERGENCE-SPEC.md");
    expect(row, "the convergence spec is not in the audit at all").toBeDefined();
    expect(row!.compliance).toBe("strict");
    expect(row!.total).toBeGreaterThan(0);
  });
});

// ── AB-2: the checkbox state ─────────────────────────────────
//
// Distinguishing input: the two `- [x]` lines. The pre-change literal
// `- [ ] ` reports total 1 on this fixture; the shared binding reports 3.

describe("AB-2: a ticked criterion is counted and reported apart", () => {
  test("total is every criterion; ticked is how many are done", () => {
    withFixture(
      {
        "TICK-SPEC.md":
          "- [ ] SC-9511: AGENTS.md exists\n" +
          "- [x] SC-9512: AGENTS.md exists\n" +
          "- [x] SC-9513: specs/ directory exists\n",
      },
      (root) => {
        const row = rowFor(root, "TICK-SPEC.md")!;
        expect(row.total).toBe(3);
        expect(row.ticked).toBe(2);
        // The three-way split stays over the UNTICKED criteria only. Widening
        // it would put ticked criteria into `unmatched`, which feeds
        // `strictUnmatched`, the exit code and the `--fix` candidate set.
        expect(row.matched + row.unmatched + row.behavioral).toBe(1);
        expect(row.total).toBe(row.ticked + row.matched + row.unmatched + row.behavioral);
      },
    );
  });

  test("the live SC- side was under-reporting, and the totals now agree with the parser", () => {
    const result = auditSpecs(REPO_ROOT);
    // Derived from the same binding the code under test uses, so the margin
    // is not set by a narrower reading that happens to agree today (#507).
    let declared = 0;
    for (const f of collectSpecFiles(join(REPO_ROOT, "specs"))) {
      const content = readFileSync(join(REPO_ROOT, "specs", f), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm || fm.testable !== "true") continue;
      declared += parseScDeclarations(content, f).length;
    }
    expect(result.totalSCs).toBe(declared);
    // The pre-change reading was 66 — the unticked `SC-` criteria of the
    // top-level specs alone. A floor well above it, because the count is not
    // a property this case owns.
    expect(result.totalSCs).toBeGreaterThan(1000);
    expect(result.totalTicked).toBeGreaterThan(1000);
  });
});

// ── AB-3: spec discovery ─────────────────────────────────────
//
// Distinguishing input: the nested path. `readdirSync` reports the directory
// entry `nested`, which `.endsWith(".md")` drops, so the spec inside it is
// not merely unread — it is unreachable.

describe("AB-3: a spec in a subdirectory is a spec", () => {
  test("a nested spec is audited, and named by its path", () => {
    withFixture(
      {
        "TOP-SPEC.md": "- [ ] SC-9514: AGENTS.md exists\n",
        "nested/DEEP-SPEC.md": "- [ ] SC-9515: AGENTS.md exists\n",
      },
      (root) => {
        const files = auditSpecs(root).specs.map((s) => s.specFile).sort();
        expect(files).toEqual(["TOP-SPEC.md", "nested/DEEP-SPEC.md"]);
      },
    );
  });

  test("the reporter and the drift gate enumerate specs the same way", () => {
    // `scripts/detect-sc-drift.ts` already routes through `collectSpecFiles`.
    // Two walks would be two deciders about what a spec is, and the reporter
    // is the one people read.
    const src = readFileSync(AUDIT_SOURCE, "utf-8");
    expect(src).toContain('from "../lib/spec-files"');
    // Comments stripped both ways. A checker that greps for a call cannot
    // tell a call from a sentence ABOUT the call, and the docblock above the
    // new enumeration quotes the line it replaced — on purpose, so the next
    // reader knows what was wrong. Caught by this case on its first run.
    expect(code(src)).not.toContain("readdirSync");
  });

  test("the live bootstrap-data-flow specs are reachable", () => {
    const nested = auditSpecs(REPO_ROOT).specs.filter((s) =>
      s.specFile.startsWith("bootstrap-data-flow/"),
    );
    expect(nested.length).toBeGreaterThan(0);
    // Non-emptiness of the CRITERIA too: six rows all reading zero would
    // satisfy the line above while witnessing nothing.
    expect(nested.reduce((n, s) => n + s.total, 0)).toBeGreaterThan(0);
  });
});

// ── AB-4: the writer scope, held ─────────────────────────────
//
// The cheapest wrong fix, named: widen the reporter and let `--fix` follow it,
// because they read the same list. Measured on this tree that hands the
// rewriter 55 `CRC-` criteria in a spec another agent is concurrently binding
// and 91 in a split spec — a writer-scope change nobody asked for, arriving as
// a side effect of a reporter change.

describe("AB-4: reporting widened; writing did not", () => {
  test("--fix rewrites an unticked top-level SC- criterion and nothing else", () => {
    const unmatched = "a freeform requirement that no registry pattern can bind";
    withFixture(
      {
        "WRITE-SPEC.md":
          `- [ ] SC-9520: ${unmatched}\n` +
          `- [x] SC-9521: ${unmatched}\n` +
          `- [ ] CRC-9520: ${unmatched}\n`,
        "nested/WRITE-SPEC.md": `- [ ] SC-9522: ${unmatched}\n`,
      },
      (root) => {
        const before = {
          top: readFileSync(join(root, "specs", "WRITE-SPEC.md"), "utf-8"),
          nested: readFileSync(join(root, "specs", "nested", "WRITE-SPEC.md"), "utf-8"),
        };
        const result = auditSpecs(root, { fix: true });

        // Membership, predicted before the run: only the unticked, top-level
        // `SC-` criterion is a candidate.
        expect((result.rewrites ?? []).map((r) => r.scId)).toEqual(["SC-9520"]);

        const after = {
          top: readFileSync(join(root, "specs", "WRITE-SPEC.md"), "utf-8"),
          nested: readFileSync(join(root, "specs", "nested", "WRITE-SPEC.md"), "utf-8"),
        };
        // The nested file is byte-identical. Asserting only on `rewrites`
        // would pass over a writer that edited the file without recording it.
        expect(after.nested).toBe(before.nested);
        // The ticked and the CRC- lines are byte-identical inside a file the
        // writer DID touch, which is the half a file-level comparison misses.
        for (const id of ["SC-9521", "CRC-9520"]) {
          const line = (s: string) => s.split("\n").find((l) => l.includes(id));
          expect(line(after.top)).toBe(line(before.top));
        }
        expect(before.top).not.toBe(after.top);
      },
    );
  });

  test("the candidate set is the pre-change population exactly, on this tree", () => {
    // Not "roughly the same". The pre-change writer population is computable:
    // the old regex `^- \[ \] (SC-\w+):` over the flat spec list. If
    // `isRewriteCandidate` selects a different set on the live tree, this
    // change moved the writer, whatever the fixture above says.
    const specsDir = join(REPO_ROOT, "specs");
    const legacy = new Set<string>();
    for (const f of collectSpecFiles(specsDir)) {
      if (f.includes("/")) continue; // the old walk could not reach these
      const content = readFileSync(join(specsDir, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm || fm.testable !== "true") continue;
      for (const m of content.matchAll(/^- \[ \] (SC-\w+):\s*(.+)$/gm)) legacy.add(`${f}:${m[1]}`);
    }

    const current = new Set<string>();
    for (const f of collectSpecFiles(specsDir)) {
      const content = readFileSync(join(specsDir, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm || fm.testable !== "true") continue;
      for (const d of parseScDeclarations(content, f)) {
        if (isRewriteCandidate({ id: d.id, statement: d.statement, specFile: f, checked: d.checked }))
          current.add(`${f}:${d.id}`);
      }
    }

    // Non-vacuity first: two empty sets agree perfectly.
    expect(legacy.size).toBeGreaterThan(0);
    expect([...current].sort()).toEqual([...legacy].sort());
  });

  test("the scope is one predicate, so there is one thing to mutate", () => {
    const src = readFileSync(AUDIT_SOURCE, "utf-8");
    expect(src.match(/export function isRewriteCandidate\b/g)?.length ?? 0).toBe(1);
    // All three clauses live in it. A clause enforced upstream instead would
    // be a second decider, and a mutation of either would leave the other
    // holding the case up.
    for (const probe of [
      { id: "SC-9530", checked: false, specFile: "A.md", want: true },
      { id: "SC-9530", checked: true, specFile: "A.md", want: false },
      { id: "CRC-9530", checked: false, specFile: "A.md", want: false },
      { id: "SC-9530", checked: false, specFile: "sub/A.md", want: false },
    ]) {
      expect(
        isRewriteCandidate({ ...probe, statement: "x" }),
        `${probe.id} checked=${probe.checked} in ${probe.specFile}`,
      ).toBe(probe.want);
    }
  });
});
