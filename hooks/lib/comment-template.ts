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

export const TEMPLATE_RULES = [
  { marker: '## AC-', required: ['Type:', 'Metric:', 'Threshold:', 'Baseline:', 'Evidence Method:', 'Pass Criteria:'] },
  { marker: '## ATTEMPT', required: ['Approach:', 'Files Changed:', 'Result:', 'Evidence:', 'Why It Failed:'] },
  { marker: '## DISCOVERY', required: ['### Docs read', '### Issue context'] },
  { marker: '## Completion Report', required: ['### Evidence per AC', '### Ship Scorecard'] },
  { marker: '## Sizing Declaration', required: ['Predicted:', 'Files:'] },
  { marker: '## Sizing Outcome', required: ['Declared:', 'Actual:'] },
];

/** The `--body` text of a `gh issue comment`, heredoc or quoted, or ''. */
export function extractCommentBody(command: string): string {
  const heredoc = command.match(/--body\s+"?\$\(cat\s+<<'?EOF'?\s*\n?([\s\S]*?)\nEOF/);
  if (heredoc) return heredoc[1];
  const quoted = command.match(/(?:--body|-b)\s+["']([^"']*(?:(?:\\.)[^"']*)*)['"]/);
  return quoted ? quoted[1] : '';
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
