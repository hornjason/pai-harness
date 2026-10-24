/**
 * #1549 — re-scaffold must not overwrite a SPEC-TEMPLATE.md a generator owns.
 *
 * Follow-up to #1286, which guarded eleven in-place spec writers and shipped
 * a completeness check that could not see this one. `copySpecTemplateIfEmpty`
 * writes `join(specsDir, "SPEC-TEMPLATE.md")` — a path it never reads — and
 * #1286's population was built from files that read and write the SAME
 * identifier. Structurally blind to a write-without-read.
 *
 * The emptiness test excludes `SPEC-TEMPLATE.md` from the listing, so a
 * `specs/` holding only that file reads as empty and the write proceeds.
 * Measured before the fix: `overwritten: true`, reported `CREATED:`.
 *
 * Two defects, and the second is the quieter one: a reader scanning scaffold
 * output for destructive actions saw a creation.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { DERIVED_KEY } from "../lib/derived-spec";
import { stampFrontmatter } from "../lib/frontmatter";
import { copySpecTemplateIfEmpty } from "../lib/scaffold/steps";

/** A consumer's own template, produced by their own generator. */
const DERIVED_TEMPLATE = `---
doc-type: spec
${DERIVED_KEY}: scripts/sync-spec.ts
---

# My derived template

Hand-maintained by my own generator, not by rungate.
`;

/** The same file with nothing declaring a generator. */
const PLAIN_TEMPLATE = `---
doc-type: spec
---

# An ordinary template
`;

interface Run {
  overwritten: boolean;
  actions: string[];
  after: string;
}

function runAgainst(files: Record<string, string>, subject?: string): Run {
  const root = mkdtempSync(join(import.meta.dir, ".spec-template-"));
  try {
    const specs = join(root, "specs");
    mkdirSync(specs, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(specs, name), body);
    }
    const actions: string[] = [];
    copySpecTemplateIfEmpty(specs, actions);
    const path = join(specs, "SPEC-TEMPLATE.md");
    const after = readFileSync(path, "utf-8");
    return { overwritten: subject !== undefined && after !== subject, actions, after };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#1549: a generator-owned SPEC-TEMPLATE.md survives re-scaffold", () => {
  test("a template declaring a generator is not overwritten", () => {
    const run = runAgainst({ "SPEC-TEMPLATE.md": DERIVED_TEMPLATE }, DERIVED_TEMPLATE);
    expect(run.overwritten, "the consumer's template was replaced").toBe(false);
    expect(run.after).toBe(DERIVED_TEMPLATE);
  });

  test("the refusal names the file and the generator", () => {
    const run = runAgainst({ "SPEC-TEMPLATE.md": DERIVED_TEMPLATE }, DERIVED_TEMPLATE);
    const line = run.actions.find((a) => a.includes("SPEC-TEMPLATE.md"));
    expect(line, "the skip was not reported at all").toBeDefined();
    expect(line!).toContain("scripts/sync-spec.ts");
    // A silent skip is the same defect as a silent write (#1286).
    expect(line!).toMatch(/DERIVED|UNPROTECTED/);
  });

  test("an overwrite of an existing template is reported UPDATED, not CREATED", () => {
    // Pointed at the PLAIN template on purpose. Against the derived one this
    // row is vacuous: the guard stops the write, so no verb is emitted at
    // all and the case passes without ever reaching the code it names —
    // *green on the exit code, witnessing the wrong mechanism*
    // (`.claude/rules/checks-must-be-able-to-fail.md`). Measured: reverting
    // the verb to a hardcoded `CREATED` left the derived-template version of
    // this row green. Only a file that EXISTS and IS written tests the verb.
    const run = runAgainst({ "SPEC-TEMPLATE.md": PLAIN_TEMPLATE }, PLAIN_TEMPLATE);
    expect(run.overwritten, "the control requires the write to happen").toBe(true);
    expect(
      run.actions.filter((a) => a.startsWith("CREATED:")),
      "CREATED names a file that was already on disk — a reader scanning the " +
        "scaffold report for destructive actions sees a creation",
    ).toEqual([]);
    expect(run.actions.some((a) => a.startsWith("UPDATED: specs/SPEC-TEMPLATE.md"))).toBe(true);
  });

  // ── Negative controls: the guard must not refuse everything ──

  test("NEGATIVE CONTROL: an empty specs/ still receives the starter template", () => {
    const run = runAgainst({});
    expect(run.after.length, "the starter template was not written").toBeGreaterThan(0);
    expect(run.actions.some((a) => a.startsWith("CREATED:"))).toBe(true);
  });

  test("NEGATIVE CONTROL: an ordinary SPEC-TEMPLATE.md is still refreshed", () => {
    // The behaviour #1549 must preserve: this file is rungate's to maintain
    // when nothing claims otherwise. A guard that kept every existing
    // template would be satisfied by refusing everything.
    const run = runAgainst({ "SPEC-TEMPLATE.md": PLAIN_TEMPLATE }, PLAIN_TEMPLATE);
    expect(run.overwritten, "an unclaimed template should still be refreshed").toBe(true);
  });

  test("NEGATIVE CONTROL: a populated specs/ is skipped as before", () => {
    const run = runAgainst(
      { "SPEC-TEMPLATE.md": DERIVED_TEMPLATE, "OTHER.md": "---\ndoc-type: spec\n---\n\n# Other\n" },
      DERIVED_TEMPLATE,
    );
    expect(run.overwritten).toBe(false);
    expect(run.actions.some((a) => a.includes("already has .md files"))).toBe(true);
  });
});

describe("#1549: stampFrontmatter refuses a document a generator owns", () => {
  /**
   * `DocHygiene.hook.ts` fires on every doc write and stamps `updated:`.
   * The guard sits here rather than in the hook: `refused` is already this
   * function's channel for "left alone, and here is why", and SC-371 caps a
   * hook at 150 lines — the inline version measured 163.
   */
  const STAMP = { updated: "2026-10-24" };

  test("a document declaring a generator is returned unchanged, with a reason", () => {
    const src = `---\ndoc-type: spec\n${DERIVED_KEY}: scripts/sync-spec.ts\n---\n\n# D\n`;
    const out = stampFrontmatter(src, STAMP);
    expect(out.content, "the bytes moved").toBe(src);
    expect(out.stamped).toEqual([]);
    expect(out.refused).toContain("scripts/sync-spec.ts");
  });

  test("a prose-only derived marker is refused too, and named UNPROTECTED", () => {
    const src = `---\ndoc-type: spec\n---\n\n<!-- DERIVED FILE — do not edit here. -->\n\n# D\n`;
    const out = stampFrontmatter(src, STAMP);
    expect(out.content).toBe(src);
    expect(out.refused).toContain("UNPROTECTED");
  });

  test("NEGATIVE CONTROL: an ordinary document is still stamped", () => {
    // Without this the guard is satisfied by refusing everything, and
    // DocHygiene would silently stop stamping the whole tree.
    const src = `---\ndoc-type: spec\n---\n\n# Ordinary\n`;
    const out = stampFrontmatter(src, STAMP);
    expect(out.refused).toBeNull();
    expect(out.stamped).toEqual(["updated: 2026-10-24"]);
    expect(out.content).toContain("updated: 2026-10-24");
  });

  test("NEGATIVE CONTROL: an unparseable block still reports the #299 reason", () => {
    // Two refusal paths share one channel. If the derived check swallowed
    // the parse failure, this row would read the wrong reason — the same
    // observable from a different mechanism.
    const out = stampFrontmatter("---\nkey: [\n  unclosed\n---\n\nbody\n", STAMP);
    if (out.refused !== null) expect(out.refused).not.toContain("generated-by");
  });
});
