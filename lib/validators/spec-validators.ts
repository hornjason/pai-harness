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

/**
 * Add or complete frontmatter on spec files.
 * Injects doc-type, testable, governs fields if missing.
 */
export function addFrontmatterToSpecs(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;

  const today = new Date().toISOString().split("T")[0];

  for (const file of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(specsDir, file);
    const content = readFileSync(filePath, "utf-8");

    if (!content.startsWith("---\n")) {
      const frontmatter = `---\ndoc-type: spec\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\ngoverns: TODO — describe what this spec governs\ntestable: false\n---\n\n`;
      writeFileSync(filePath, frontmatter + content);
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
        writeFileSync(filePath, newFm + content.substring(fmEnd + 4));
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
 * Add or complete frontmatter on ADR files.
 * Injects doc-type, created fields if missing.
 */
export function addFrontmatterToAdrs(adrDir: string, actions: string[]): void {
  if (!existsSync(adrDir)) return;

  const today = new Date().toISOString().split("T")[0];

  for (const file of readdirSync(adrDir).filter(f => f.endsWith(".md"))) {
    const filePath = join(adrDir, file);
    const content = readFileSync(filePath, "utf-8");

    if (!content.startsWith("---\n")) {
      const frontmatter = `---\ndoc-type: adr\nstatus: draft\nowner: TODO\ncreated: ${today}\nupdated: ${today}\n---\n\n`;
      writeFileSync(filePath, frontmatter + content);
      actions.push(`UPDATED: docs/adr/${file} (added frontmatter)`);
    } else {
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd === -1) continue;
      const fm = content.substring(4, fmEnd);
      const missing: string[] = [];
      if (!fm.includes("doc-type:")) missing.push(`doc-type: adr`);
      if (!fm.includes("created:")) missing.push(`created: ${today}`);
      if (missing.length > 0) {
        const newFm = `---\n${fm}\n${missing.join("\n")}\n---`;
        writeFileSync(filePath, newFm + content.substring(fmEnd + 4));
        actions.push(`UPDATED: docs/adr/${file} (added missing: ${missing.map(m => m.split(":")[0]).join(", ")})`);
      }
    }
  }
}
