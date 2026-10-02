/**
 * Spec Registry — governs-field discovery for spec files.
 *
 * SC-505: exports [getGoverningSpecs, getGovernedFiles, getUngoverned]
 * SC-506: contains [governs, frontmatter, specs/, invertedIndex]
 *
 * Three consumers already parse governs-field independently (scanner.ts,
 * conformity.ts, spec-validators.ts). This module centralizes the contract
 * so doc-hygiene, scaffold, and gate enforcement share one source of truth.
 *
 * Issue: #24
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface SpecEntry {
  /** Filename relative to specs/ (e.g. "GATE-CONTRACTS-SPEC.md" or "sub/SUB-SPEC.md") */
  file: string;
  /** Parsed governs field from frontmatter */
  governs: string;
  /** Full path to the spec file */
  path: string;
}

/**
 * Parse frontmatter from a markdown file's content.
 * Returns key-value pairs from YAML-style frontmatter block.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

/**
 * Check if a governs field value is valid (non-empty, not TODO).
 */
function isValidGoverns(governs: string | undefined): governs is string {
  if (!governs) return false;
  const trimmed = governs.trim();
  return trimmed.length > 0 && !trimmed.includes('TODO');
}

/**
 * Scan a single directory for spec files and extract governs frontmatter.
 */
function scanSpecDir(dir: string, prefix: string = ''): { governed: SpecEntry[]; ungoverned: string[] } {
  const governed: SpecEntry[] = [];
  const ungoverned: string[] = [];

  if (!existsSync(dir)) return { governed, ungoverned };

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subResult = scanSpecDir(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      governed.push(...subResult.governed);
      ungoverned.push(...subResult.ungoverned);
      continue;
    }

    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'SPEC-TEMPLATE.md') continue;
    if (entry.name === 'INDEX.md') continue;

    const filePath = join(dir, entry.name);
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);
    const relFile = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (fm && isValidGoverns(fm.governs)) {
      governed.push({
        file: relFile,
        governs: fm.governs,
        path: filePath,
      });
    } else {
      ungoverned.push(relFile);
    }
  }

  return { governed, ungoverned };
}

/**
 * Get all specs that have a valid governs field in their frontmatter.
 *
 * Scans specs/ directory (and subdirectories) under the given root.
 * Returns an array of SpecEntry objects with file, governs, and path.
 */
export function getGoverningSpecs(root: string): SpecEntry[] {
  const specsDir = join(root, 'specs');
  return scanSpecDir(specsDir).governed;
}

/**
 * Build an invertedIndex mapping governs text to spec file names.
 *
 * Used by doc-hygiene to look up which spec governs a given area.
 * Each governs value maps to an array of spec filenames that claim it.
 */
export function getGovernedFiles(root: string): Record<string, string[]> {
  const specs = getGoverningSpecs(root);
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
 * Get spec files that lack a valid governs field.
 *
 * Returns filenames (relative to specs/) that have no governs
 * or have TODO as their governs value.
 */
export function getUngoverned(root: string): string[] {
  const specsDir = join(root, 'specs');
  return scanSpecDir(specsDir).ungoverned;
}
