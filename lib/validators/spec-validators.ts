/**
 * spec-validators.ts — Spec validation functions extracted from scaffold-project.ts
 *
 * Handles frontmatter injection, oversized spec detection, and governs alignment checks.
 * All functions take a directory path and an actions array for reporting.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { localCalendarDay } from "../local-calendar-day";
import { SC_ID_SOURCE } from "../sc-ids";
import { skipLine } from "../derived-spec";
import { maySpecBeWritten, writeSpec } from "../write-spec";

/**
 * SC-278: Detect specs that exceed 500 lines and suggest splitting.
 */
export function detectOversizedSpecs(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;
  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: specsDir, absolute: false })) {
    const content = readFileSync(join(specsDir, file), "utf-8");
    const lineCount = content.split("\n").length;
    if (lineCount > 500) {
      actions.push(`WARN: specs/${file} is ${lineCount} lines (>500) — consider splitting with \`bun scripts/split-spec.ts specs/${file}\``);
    }
  }
}

/**
 * SC-279: Check that spec content aligns with its governs field.
 * Warns when a spec has too many H2 sections relative to its governs scope.
 */
export function checkGovernsAlignment(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;
  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const content = readFileSync(join(specsDir, file), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
    if (!gMatch || gMatch[1].trim().startsWith("TODO")) continue;
    // Check if the file has multiple unrelated H2 sections that don't match governs
    const h2s = content.match(/^## .+/gm) || [];
    if (h2s.length > 8) {
      actions.push(`WARN: specs/${file} has ${h2s.length} sections — may cover more than its governs ("${gMatch[1].trim().slice(0, 60)}"). Consider splitting.`);
    }
  }
}

/**
 * Add or complete frontmatter on spec files.
 * Injects doc-type, testable, governs fields if missing.
 *
 * Always writes. The `opts.fix` parameter and its gap-reporting branch were
 * removed in #398: audit no longer predicts what this would do, it runs this
 * against a throwaway clone, so a second non-writing code path has nothing
 * left to serve. Unreachable from the only caller for its whole life, and an
 * unreachable branch reporting gaps is a report nothing can contradict.
 */
export function addFrontmatterToSpecs(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;

  const today = localCalendarDay();

  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(specsDir, file);
    const content = readFileSync(filePath, "utf-8");

    // #1286: both writes below rewrite this spec's own bytes. On a spec a
    // generator owns, the frontmatter belongs in the generator — injecting
    // it here is discarded at the next run after breaking what pins it.
    const early = maySpecBeWritten(content);
    if (!early.allowed) {
      actions.push(skipLine(`specs/${file}`, early.reading));
      continue;
    }

    if (!content.startsWith("---\n")) {
      const frontmatter = `---\ndoc-type: spec\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\ngoverns: TODO — describe what this spec governs\ntestable: false\n---\n\n`;
      writeSpec(filePath, frontmatter + content, { label: `specs/${file}` });
      actions.push(`UPDATED: specs/${file} (added frontmatter)`);
    } else {
      // Validate existing frontmatter has required fields
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd === -1) continue;
      const fm = content.substring(4, fmEnd);
      const missing: string[] = [];
      if (!fm.includes("testable:")) missing.push(`testable: false`);
      if (!fm.includes("created:")) missing.push(`created: ${today}`);
      if (!fm.includes("governs:")) missing.push(`governs: TODO`);
      if (missing.length > 0) {
        const newFm = `---\n${fm}\n${missing.join("\n")}\n---`;
        writeSpec(filePath, newFm + content.substring(fmEnd + 4), { label: `specs/${file}` });
        actions.push(`UPDATED: specs/${file} (added missing frontmatter fields: ${missing.map(m => m.split(":")[0]).join(", ")})`);
      }
      // SC-269: WARN for specs with missing or TODO governs
      const governsMatch = fm.match(/governs:\s*(.+)/);
      if (!governsMatch || governsMatch[1].trim() === "TODO" || governsMatch[1].trim().startsWith("TODO")) {
        actions.push(`WARN: specs/${file} has no governs: field (or governs: TODO) — add a one-line description of what this spec governs`);
      }
    }
  }
}

/**
 * Issue #41: Detect spec files in docs/specs/ and suggest migration to specs/.
 * Takes a project root (not specs dir) since it needs to check docs/specs/.
 */
export function detectMisplacedSpecs(projectRoot: string, actions: string[]): void {
  const docsSpecsDir = join(projectRoot, "docs", "specs");
  if (!existsSync(docsSpecsDir)) return;
  const specFiles = readdirSync(docsSpecsDir).filter(f => f.endsWith(".md"));
  if (specFiles.length === 0) return;
  for (const file of specFiles) {
    actions.push(
      `WARN: docs/specs/${file} should be in specs/ — run \`bun scripts/migrate-specs.ts .\` to migrate`
    );
  }
}

/**
 * Issue #41: Detect specs in specs/ that lack SC checkbox lines and suggest conversion.
 */
export function detectUnconvertedSpecs(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;
  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md")) {
    const content = readFileSync(join(specsDir, file), "utf-8");
    // Check if this spec has frontmatter with testable field
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    // Check if file has any SC checkbox lines. Built from `SC_ID_SOURCE`
    // (#1298) — a spec whose criteria all carry a tracked prefix this does
    // not know reads as unconverted, and the WARN tells the author to run
    // `convert-spec.ts` over a spec that is already converted.
    const hasSCLines = new RegExp(`^- \\[[ x]\\] ${SC_ID_SOURCE}:`, "m").test(content);
    if (!hasSCLines) {
      actions.push(
        `WARN: specs/${file} has no SC checkboxes — run \`bun scripts/convert-spec.ts specs/${file}\` to convert`
      );
    }
  }
}

/**
 * Add or complete frontmatter on ADR files.
 * Injects doc-type, created fields if missing.
 *
 * Always writes — see `addFrontmatterToSpecs` for why the non-fix branch is
 * gone (#398).
 */
export function addFrontmatterToAdrs(adrDir: string, actions: string[]): void {
  if (!existsSync(adrDir)) return;

  const today = localCalendarDay();

  for (const file of readdirSync(adrDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(adrDir, file);
    const content = readFileSync(filePath, "utf-8");

    // #1286: the same guard as `addFrontmatterToSpecs` above, for the same
    // reason. The declaration is about who PRODUCES a file, not about which
    // directory it sits in — a generated ADR loses its injected frontmatter
    // at the next regeneration exactly as a generated spec does, and an
    // unguarded sibling beside a guarded one reads as an oversight because
    // that is what it was.
    const early = maySpecBeWritten(content);
    if (!early.allowed) {
      actions.push(skipLine(`docs/adr/${file}`, early.reading));
      continue;
    }

    if (!content.startsWith("---\n")) {
      const frontmatter = `---\ndoc-type: adr\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\n---\n\n`;
      writeSpec(filePath, frontmatter + content, { label: `docs/adr/${file}` });
      actions.push(`AUTO-FIXED: docs/adr/${file} (added frontmatter)`);
    } else {
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd === -1) continue;
      const fm = content.substring(4, fmEnd);
      const missing: string[] = [];
      if (!fm.includes("doc-type:")) missing.push(`doc-type: adr`);
      if (!fm.includes("created:")) missing.push(`created: ${today}`);

      // A doc-type that is present but WRONG (#42).
      //
      // The fixer used to key on whether the field existed while HYGIENE-10
      // keys on its VALUE (`lib/conformity.ts`: `fm["doc-type"] !== "adr"`).
      // So an ADR carrying `doc-type: guide` satisfied `fm.includes` and was
      // never touched — re-scaffold ran, reported nothing, and the warning
      // came back every single time. Two readers of one field disagreeing
      // about what it means is why the auto-fix could not clear the finding
      // it was written to clear.
      //
      // Corrected in place rather than appended: adding a second `doc-type:`
      // line would leave a document with two, and a parser taking the first
      // would keep the wrong one forever.
      const wrongType = fm.match(/^(\s*doc-type:\s*)(.+?)\s*$/m);
      let corrected = fm;
      let retyped: string | null = null;
      if (wrongType && wrongType[2] !== "adr") {
        retyped = wrongType[2];
        corrected = fm.replace(/^(\s*doc-type:\s*).+?\s*$/m, `$1adr`);
      }

      if (missing.length > 0 || retyped !== null) {
        const newFm = missing.length > 0
          ? `---\n${corrected}\n${missing.join("\n")}\n---`
          : `---\n${corrected}\n---`;
        writeSpec(filePath, newFm + content.substring(fmEnd + 4), {
          label: `docs/adr/${file}`,
        });
        const what = [
          ...(missing.length > 0 ? [`added missing: ${missing.map(m => m.split(":")[0]).join(", ")}`] : []),
          ...(retyped !== null ? [`doc-type was "${retyped}", set to adr`] : []),
        ];
        actions.push(`AUTO-FIXED: docs/adr/${file} (${what.join("; ")})`);
      }
    }
  }
}
