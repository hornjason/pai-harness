/**
 * Post-fix verification for ship-and-heal workflow.
 *
 * After a conformity fix is applied, verifies that the ROOT CAUSE was fixed
 * (generator/template updated) not just the symptom (generated output file).
 *
 * Ref: Ship-and-heal post-fix verification (PROJECT-STATE P1)
 */

export interface PostFixResult {
  /** Overall assessment */
  status: 'DURABLE' | 'WARN_NON_DURABLE' | 'UNKNOWN';
  /** Files changed that are generators/templates */
  generatorFilesChanged: string[];
  /** Files changed that are generated outputs */
  generatedFilesChanged: string[];
  /** Files changed that are neither (normal source) */
  otherFilesChanged: string[];
  /** Human-readable message */
  message: string;
}

/**
 * Known generator/template file patterns.
 * These are the SOURCE files that produce generated output.
 */
const GENERATOR_PATTERNS = [
  'scripts/scaffold-project.ts',
  'templates/',
  'specs/',  // Specs generate conformity tests
] as const;

/**
 * Known generated output file patterns.
 * These files are PRODUCED by running scaffold-project.ts.
 */
const GENERATED_PATTERNS = [
  '.claude/agents/',
  'CODE-MAP.md',
  'test/scaffold-conformity.test.ts',
  '.github/workflows/ci.yml',
  '.github/workflows/gates.yml',
] as const;

/**
 * Classify a file path as generator, generated, or other.
 */
function classifyFile(filePath: string): 'generator' | 'generated' | 'other' {
  // Check generator patterns
  for (const pattern of GENERATOR_PATTERNS) {
    if (filePath.includes(pattern)) {
      return 'generator';
    }
  }

  // Check generated patterns
  for (const pattern of GENERATED_PATTERNS) {
    if (filePath.includes(pattern)) {
      return 'generated';
    }
  }

  return 'other';
}

/**
 * Verify that a fix touched generator files, not just generated output.
 *
 * @param changedFiles - List of file paths that were changed during the fix
 * @returns Analysis of what was changed and whether the fix is durable
 *
 * @example
 * const result = verifyPostFix([
 *   '.claude/agents/marcus.md',
 *   'templates/agent-briefs/marcus.md'
 * ]);
 * if (result.status === 'WARN_NON_DURABLE') {
 *   console.warn(result.message);
 * }
 */
export function verifyPostFix(changedFiles: string[]): PostFixResult {
  const generatorFilesChanged: string[] = [];
  const generatedFilesChanged: string[] = [];
  const otherFilesChanged: string[] = [];

  // Classify each changed file
  for (const file of changedFiles) {
    const classification = classifyFile(file);
    switch (classification) {
      case 'generator':
        generatorFilesChanged.push(file);
        break;
      case 'generated':
        generatedFilesChanged.push(file);
        break;
      case 'other':
        otherFilesChanged.push(file);
        break;
    }
  }

  // Determine status
  let status: PostFixResult['status'];
  let message: string;

  if (generatedFilesChanged.length > 0 && generatorFilesChanged.length === 0) {
    // WARN: Only generated files were changed, no generator files
    status = 'WARN_NON_DURABLE';
    message = `Fix may not be durable — ${generatedFilesChanged.length} generated file(s) changed but no generator/template files updated. Next scaffold run will regenerate the broken version.`;
  } else if (generatorFilesChanged.length > 0) {
    // DURABLE: Generator files were changed
    status = 'DURABLE';
    message = `Fix is durable — ${generatorFilesChanged.length} generator/template file(s) updated.`;
  } else if (changedFiles.length === 0) {
    // UNKNOWN: No files changed
    status = 'UNKNOWN';
    message = 'No files changed during fix.';
  } else {
    // UNKNOWN: Only "other" files changed (not generator or generated)
    status = 'UNKNOWN';
    message = `${otherFilesChanged.length} source file(s) changed. Not scaffold-related.`;
  }

  return {
    status,
    generatorFilesChanged,
    generatedFilesChanged,
    otherFilesChanged,
    message,
  };
}

/**
 * Get list of changed files from git diff.
 *
 * @param cwd - Working directory (project root)
 * @param baseRef - Base ref to compare against (default: HEAD)
 * @returns Array of file paths changed
 */
export function getChangedFiles(cwd: string, baseRef: string = 'HEAD'): string[] {
  const { spawnSync } = require('child_process');

  // Get changed files since baseRef (unstaged + staged)
  const result = spawnSync('git', ['diff', '--name-only', baseRef], {
    cwd,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}
