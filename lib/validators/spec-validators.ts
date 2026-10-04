/**
 * spec-validators.ts — Spec validation functions extracted from scaffold-project.ts
 *
 * Handles frontmatter injection, oversized spec detection, and governs alignment checks.
 * All functions take a directory path and an actions array for reporting.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

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

export interface FixOptions {
  fix: boolean;
}

/**
 * Add or complete frontmatter on spec files.
 * Injects doc-type, testable, governs fields if missing.
 * When opts.fix is false (dry-run), reports gaps without writing files.
 */
export function addFrontmatterToSpecs(specsDir: string, actions: string[], opts?: FixOptions): void {
  if (!existsSync(specsDir)) return;

  const fix = opts?.fix ?? true; // default true for backward compat
  const today = new Date().toISOString().split("T")[0];

  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(specsDir, file);
    const content = readFileSync(filePath, "utf-8");

    if (!content.startsWith("---\n")) {
      if (fix) {
        const frontmatter = `---\ndoc-type: spec\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\ngoverns: TODO — describe what this spec governs\ntestable: false\n---\n\n`;
        writeFileSync(filePath, frontmatter + content);
        actions.push(`UPDATED: specs/${file} (added frontmatter)`);
      } else {
        actions.push(`GAP: specs/${file} missing frontmatter`);
      }
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
        if (fix) {
          const newFm = `---\n${fm}\n${missing.join("\n")}\n---`;
          writeFileSync(filePath, newFm + content.substring(fmEnd + 4));
          actions.push(`UPDATED: specs/${file} (added missing frontmatter fields: ${missing.map(m => m.split(":")[0]).join(", ")})`);
        } else {
          actions.push(`GAP: specs/${file} missing frontmatter fields: ${missing.map(m => m.split(":")[0]).join(", ")}`);
        }
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
    // Check if file has any SC checkbox lines
    const hasSCLines = /^- \[[ x]\] SC-\d+:/m.test(content);
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
 * When opts.fix is false (dry-run), reports gaps without writing files.
 */
export function addFrontmatterToAdrs(adrDir: string, actions: string[], opts?: FixOptions): void {
  if (!existsSync(adrDir)) return;

  const fix = opts?.fix ?? true; // default true for backward compat
  const today = new Date().toISOString().split("T")[0];

  for (const file of readdirSync(adrDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(adrDir, file);
    const content = readFileSync(filePath, "utf-8");

    if (!content.startsWith("---\n")) {
      if (fix) {
        const frontmatter = `---\ndoc-type: adr\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\n---\n\n`;
        writeFileSync(filePath, frontmatter + content);
        actions.push(`UPDATED: docs/adr/${file} (added frontmatter)`);
      } else {
        actions.push(`GAP: docs/adr/${file} missing frontmatter`);
      }
    } else {
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd === -1) continue;
      const fm = content.substring(4, fmEnd);
      const missing: string[] = [];
      if (!fm.includes("doc-type:")) missing.push(`doc-type: adr`);
      if (!fm.includes("created:")) missing.push(`created: ${today}`);
      if (missing.length > 0) {
        if (fix) {
          const newFm = `---\n${fm}\n${missing.join("\n")}\n---`;
          writeFileSync(filePath, newFm + content.substring(fmEnd + 4));
          actions.push(`UPDATED: docs/adr/${file} (added missing: ${missing.map(m => m.split(":")[0]).join(", ")})`);
        } else {
          actions.push(`GAP: docs/adr/${file} missing frontmatter fields: ${missing.map(m => m.split(":")[0]).join(", ")}`);
        }
      }
    }
  }
}
