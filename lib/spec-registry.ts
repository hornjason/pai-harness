/**
 * spec-registry.ts — Shared governs-field discovery module
 *
 * SC-505: exports [getGoverningSpecs, getGovernedFiles, getUngoverned]
 * SC-506: contains [governs, frontmatter, specs/, invertedIndex]
 *
 * Centralizes frontmatter governs-field parsing from specs/ directory.
 * Three consumers (scanner.ts, spec-validators.ts, doc-hygiene.ts) previously
 * parsed governs independently — this module is the single contract (DEC-003).
 *
 * Issue: #24
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface SpecGoverns {
  file: string;
  governs: string;
}

/**
 * Parse governs from frontmatter of a markdown file.
 * Returns the governs string or null if missing/TODO/too short.
 */
function parseGoverns(content: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
  if (!gMatch) return null;

  const governs = gMatch[1].trim();
  if (governs === 'TODO' || governs.startsWith('TODO') || governs.length <= 5) {
    return null;
  }

  return governs;
}

/**
 * Scan specs/ directory and return all specs with valid governs frontmatter.
 * Skips SPEC-TEMPLATE.md and INDEX.md files.
 */
export function getGoverningSpecs(root: string, specDirs: string[] = ['specs']): SpecGoverns[] {
  const results: SpecGoverns[] = [];

  for (const dir of specDirs) {
    const specsDir = join(root, dir);
    if (!existsSync(specsDir)) continue;

    // Top-level spec files
    const files = readdirSync(specsDir)
      .filter(f => f.endsWith('.md') && f !== 'SPEC-TEMPLATE.md' && f !== 'INDEX.md');

    for (const file of files) {
      try {
        const content = readFileSync(join(specsDir, file), 'utf-8');
        const governs = parseGoverns(content);
        if (governs) {
          results.push({ file, governs });
        }
      } catch { /* skip unreadable */ }
    }

    // Subdirectory specs
    try {
      const subDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const sub of subDirs) {
        const subPath = join(specsDir, sub);
        const subFiles = readdirSync(subPath)
          .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'SPEC-TEMPLATE.md');

        for (const file of subFiles) {
          try {
            const content = readFileSync(join(subPath, file), 'utf-8');
            const governs = parseGoverns(content);
            if (governs) {
              results.push({ file: `${sub}/${file}`, governs });
            }
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

/**
 * Build an invertedIndex mapping governs text to spec files.
 * Key: governs text, Value: array of spec file paths.
 */
export function getGovernedFiles(root: string, specDirs: string[] = ['specs']): Record<string, string[]> {
  const specs = getGoverningSpecs(root, specDirs);
  const invertedIndex: Record<string, string[]> = {};

  for (const spec of specs) {
    if (!invertedIndex[spec.governs]) {
      invertedIndex[spec.governs] = [];
    }
    invertedIndex[spec.governs].push(spec.file);
  }

  return invertedIndex;
}

/**
 * Return spec files that have NO valid governs field (missing, TODO, or too short).
 * These are ungoverned specs that need attention.
 */
export function getUngoverned(root: string, specDirs: string[] = ['specs']): string[] {
  const ungoverned: string[] = [];

  for (const dir of specDirs) {
    const specsDir = join(root, dir);
    if (!existsSync(specsDir)) continue;

    const files = readdirSync(specsDir)
      .filter(f => f.endsWith('.md') && f !== 'SPEC-TEMPLATE.md' && f !== 'INDEX.md');

    for (const file of files) {
      try {
        const content = readFileSync(join(specsDir, file), 'utf-8');
        const governs = parseGoverns(content);
        if (!governs) {
          ungoverned.push(file);
        }
      } catch { /* skip unreadable */ }
    }
  }

  return ungoverned;
}
