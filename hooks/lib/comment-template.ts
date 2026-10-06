/**
 * Issue-comment template validation, lifted out of IssueCloseGuard.
 *
 * HOOK-ARCHITECTURE-SPEC wants hooks to be thin triggers that delegate to
 * lib, and SC-371 caps a hook at 150 lines — which the guard crossed when
 * #140 made its failure handling explicit. Moving this out is the fix the
 * spec asks for rather than a cap raise, and it makes the rules unit-testable
 * without driving a subprocess.
 *
 * Returns the reason a comment should be refused, or null to allow it. The
 * caller owns the blocking, so the rules stay pure.
 */

import { readFileSync } from 'fs';

export const TEMPLATE_RULES = [
  { marker: '## AC-', required: ['Type:', 'Metric:', 'Threshold:', 'Baseline:', 'Evidence Method:', 'Pass Criteria:'] },
  { marker: '## ATTEMPT', required: ['Approach:', 'Files Changed:', 'Result:', 'Evidence:', 'Why It Failed:'] },
  { marker: '## DISCOVERY', required: ['### Docs read', '### Issue context'] },
  { marker: '## Completion Report', required: ['### Evidence per AC', '### Ship Scorecard'] },
  { marker: '## Sizing Declaration', required: ['Predicted:', 'Files:'] },
  { marker: '## Sizing Outcome', required: ['Declared:', 'Actual:'] },
];

/**
 * Whether this command posts an issue comment.
 *
 * Two forms now. `gh issue comment` is what a person types. `github-op.ts
 * comment` is what workflow steps run since #137 — the MCP tools those steps
 * used to name do not exist in this harness, so they went through the Octokit
 * script instead. Matching only the first would have quietly exempted every
 * comment the harness itself posts, which is most of them.
 */
export const COMMENT_INVOCATION = /gh\s+issue\s+comment\s+\d+|github-op\.ts\s+comment\b/;

/** The `--body` text of a comment command — heredoc, quoted, or a file. */
export function extractCommentBody(
  command: string,
  readFile: (path: string) => string = defaultReadFile,
): string {
  const heredoc = command.match(/--body\s+"?\$\(cat\s+<<'?EOF'?\s*\n?([\s\S]*?)\nEOF/);
  if (heredoc) return heredoc[1];

  // `--body-file` is how #137 passes anything with a newline in it, so the
  // template rules have to follow the body into the file or stop applying to
  // exactly the comments that carry templates.
  const file = command.match(/--body-file[\s=]+['"]?([^\s'"]+)/);
  if (file) {
    try {
      return readFile(file[1]);
    } catch {
      // Unreadable here means unreadable for the command too, which will fail
      // on its own. Nothing to validate, and refusing would block on a path
      // this hook simply cannot see (a heredoc writes it in the same command).
      return '';
    }
  }

  const quoted = command.match(/(?:--body|-b)\s+["']([^"']*(?:(?:\\.)[^"']*)*)['"]/);
  return quoted ? quoted[1] : '';
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

export function commentTemplateViolation(command: string): string | null {
  const body = extractCommentBody(command);
  if (!body) return null;

  if (/^## AC-\d+/m.test(body))
    return 'ACs (## AC-N) must be posted to the issue body via "gh issue edit --body", not as comments.';
  if (body.includes('### Docs read') && !body.includes('## DISCOVERY'))
    return 'Comment contains "### Docs read" but no "## DISCOVERY" heading. Use the DISCOVERY template.';
  if (body.includes('### Evidence per AC') && !body.includes('## Completion Report'))
    return 'Comment contains "### Evidence per AC" but no "## Completion Report" heading.';
  if (body.includes('REPLACE:'))
    return 'Comment body contains unfilled REPLACE: placeholder(s).';

  for (const rule of TEMPLATE_RULES) {
    if (!body.includes(rule.marker)) continue;
    const missing = rule.required.filter(f => !body.includes(f));
    if (missing.length) return `Template "${rule.marker}" missing fields: ${missing.join(', ')}. See TEMPLATES.md.`;
  }
  return null;
}
