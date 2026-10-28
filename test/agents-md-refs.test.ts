/**
 * Covers SC-846, SC-847, SC-848 (AGENTS-MD-TEMPLATE-SPEC.md).
 *
 * #380 — `refreshAgentsMd`'s broken-link check read a backtick span as a
 * file path. AGENTS.md has a Commands table whose commands end in
 * filenames, so the whole command string went to `existsSync`. On this repo
 * it produced three reports, three false positives and zero true positives:
 * the check had never once validated a real reference here.
 *
 * Both directions are asserted throughout, because narrowing a detector to
 * buy green is shape two of `.claude/rules/checks-must-be-able-to-fail.md`
 * and this change is exactly that kind of narrowing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPathReference, referencedPaths } from "../lib/agents-md-refs";
import { refreshAgentsMd } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");

describe("#380 SC-846: a command that ends in a filename is not a file reference", () => {
  test("the three spans this repo actually reported are rejected", () => {
    // Verbatim from AGENTS.md's Commands table at the time of the fix.
    for (const span of [
      "bun test test/scaffold-conformity.test.ts",
      "bun scripts/typecheck.ts",
      "bun scripts/test-clean-env.ts",
    ]) {
      expect(isPathReference(span), `${span} is still read as a path`).toBe(false);
    }
  });

  test("a real relative path is still a reference", () => {
    // The other direction, and the one that matters: narrowing the detector
    // until it reports nothing would satisfy the case above for free.
    for (const span of [
      "CODE-MAP.md",
      "PROJECT-STATE.md",
      ".claude/rungate/config.json",
      "lib/scaffold/steps.ts",
      "docs/adr/ADR-002-config-access.md",
      "tsconfig.json",
      ".github/workflows/ci.yml",
    ]) {
      expect(isPathReference(span), `${span} stopped being checked`).toBe(true);
    }
  });

  test("the boundary is whitespace and path characters, both ways", () => {
    // SC-B. These are the cases that decide the predicate, written down so
    // a future widening has to argue with them rather than with a comment.
    expect(isPathReference("a.md")).toBe(true);
    expect(isPathReference("a b.md"), "whitespace makes it a phrase").toBe(false);
    expect(isPathReference("https://example.com/x.md"), "a URL is not a path").toBe(false);
    expect(isPathReference("--config=x.json"), "a flag is not a path").toBe(false);
    expect(isPathReference("specs/<name>.md"), "a placeholder is not a path").toBe(false);
    expect(isPathReference("$DIR/x.ts"), "a variable is not a path").toBe(false);
    expect(isPathReference("specs/*.md"), "a glob is not a path").toBe(false);
    expect(isPathReference("README"), "no extension, nothing to resolve").toBe(false);
    expect(isPathReference("x.rs"), "an extension the check cannot resolve").toBe(false);
    // The end anchor, which nothing else reaches. `^` plus a character
    // class with no space in it already rejects every command, so dropping
    // `$` scored 0 until this case existed — and without `$` the span is
    // accepted on its `.json` prefix and then resolved whole.
    expect(isPathReference("config.json.example"), "an unknown extension after a known one")
      .toBe(false);
    expect(isPathReference("ADR-002.md"), "a known extension last is still a path").toBe(true);
  });
});

describe("#380 SC-847: the real AGENTS.md produces no false positives and does not go blind", () => {
  const content = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");

  test("every reference the predicate accepts resolves on disk", () => {
    const unresolved = referencedPaths(content).filter(
      rel => !require("fs").existsSync(join(ROOT, rel)),
    );
    expect(unresolved, `AGENTS.md names files that do not exist`).toEqual([]);
  });

  test("the Commands table's spans are not among them", () => {
    const refs = referencedPaths(content);
    for (const ref of refs) {
      expect(ref, "a command string is being treated as a path").not.toMatch(/\s/);
    }
  });

  test("a dangling reference planted in the document IS reported", () => {
    // The positive control, and it has to be here rather than over the
    // shipped file. "Zero unresolved references" is produced just as readily
    // by a scan that resolves nothing at all — which is the state this check
    // shipped in: three reports, none of them real.
    const planted = `${content}\n\nSee \`docs/nope.md\` for details.\n`;
    const refs = referencedPaths(planted);
    expect(refs, "the scan did not see a planted reference").toContain("docs/nope.md");
    expect(require("fs").existsSync(join(ROOT, "docs/nope.md"))).toBe(false);
    // And a planted REAL reference is seen too, so the scan is not merely
    // finding things that happen not to exist.
    expect(referencedPaths(`${content}\n\`CODE-MAP.md\`\n`)).toContain("CODE-MAP.md");
  });

  test("rungate's own AGENTS.md names one file, and the check has real work to do here", () => {
    // Measured, and written down because it is the uncomfortable half of
    // the finding. The check reported three spans here, all false; its
    // true-positive count was zero because there was nothing true to find.
    // D-15 capped AGENTS.md at 100 lines and moved the routing and key-file
    // tables into `.claude/rules/`, so every real path reference left with
    // them. What remained was a Commands table full of command strings.
    //
    // It stopped being zero on 2026-10-28, which this test's previous
    // revision said to handle by UPDATING the assertion rather than
    // deleting the reference. `## Hard Constraints` rule 5 cites the spec
    // that holds the measurement it argues against, because a rule whose
    // evidence is a bare number is a rule nobody can check. So the
    // population is now exactly one, asserted by name: the check is no
    // longer vacuous here, and a second path arriving is a deliberate
    // edit somebody should see in this diff.
    expect(referencedPaths(content)).toEqual(["specs/CODE-REVIEW-CONVERGENCE-SPEC.md"]);
    // And it resolves — the half that makes naming it worth anything.
    expect(require("fs").existsSync(join(ROOT, "specs/CODE-REVIEW-CONVERGENCE-SPEC.md"))).toBe(true);
  });
});

describe("#380 SC-848: refreshAgentsMd itself stops reporting commands as missing files", () => {
  // EXECUTED, not grepped. The first version of this asserted that the
  // function's source text contained "referencedPaths" — and the mutation
  // that replaced the call with `const refs: string[] = []` left it GREEN,
  // because the comment above the call says the word too. A detector
  // satisfied by the prose warning against the thing is the self-reference
  // trap `.claude/rules/checks-must-be-able-to-fail.md` names.

  function audit(agentsMd: string): string[] {
    const d = mkdtempSync(join(tmpdir(), "agents-refs-"));
    try {
      writeFileSync(join(d, "AGENTS.md"), agentsMd);
      const actions: string[] = [];
      refreshAgentsMd(d, "code", actions);
      return actions;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  /** The broken-reference count the audit reports. */
  function brokenCount(agentsMd: string): number {
    const line = audit(agentsMd).find(a => a.startsWith("AUDITED: AGENTS.md"));
    expect(line, "the audit reported nothing at all").toBeDefined();
    if (/all references valid/.test(line!)) return 0;
    return Number(/\((\d+) broken refs/.exec(line!)?.[1] ?? NaN);
  }

  test("a Commands table of command strings reports zero broken references", () => {
    // The regression. Every one of these ends in a real extension and none
    // of them is a path; all three were reported before the fix.
    expect(
      brokenCount(
        "# p\n\n| Action | Command |\n|---|---|\n" +
          "| Test | `bun test test/scaffold-conformity.test.ts` |\n" +
          "| Type check | `bun scripts/typecheck.ts` |\n" +
          "| CI | `bun scripts/test-clean-env.ts` |\n",
      ),
    ).toBe(0);
  });

  test("a genuinely dangling path is still reported", () => {
    // The positive control, through the real function. Without it, a
    // predicate narrowed to `return false` passes the case above.
    expect(brokenCount("# p\n\nSee `docs/nope.md` and `lib/gone.ts`.\n")).toBe(2);
  });

  test("the two scans agree: the staleness scan sees no span the link scan rejects", () => {
    // They had separate patterns. Two scans with two ideas of what a
    // reference is means the second silently stops covering spans the first
    // rejects, and nothing can notice because they never compare answers.
    const src = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const fn = src.slice(src.indexOf("export function refreshAgentsMd"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body, "a second inline backtick pattern survives in refreshAgentsMd")
      .not.toMatch(/`\(\[\^`\]\+/);
  });
});
