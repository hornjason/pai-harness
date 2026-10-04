/**
 * Deterministic goal parser for ship.js Goal phase.
 * Replaces LLM agent calls with regex-based extraction.
 * Issue #47: Pipeline optimization — deep module over shallow wrapper.
 */

export interface GoalData {
  issueGoal: string;
  successCriteria: string[];
  issueTitle: string;
  labels: string[];
}

interface GhIssueJson {
  title: string;
  body: string;
  labels: Array<{ name: string }> | string[];
}

/**
 * Extract success criteria from an issue body using regex patterns.
 * Supports multiple formats:
 *   - Checkbox: `- [ ] SC-1: description` or `- [x] SC-1: description`
 *   - Checkbox without prefix: `- [ ] description`
 *   - Numbered list: `1. SC-1: description`
 */
export function extractSuccessCriteria(body: string): string[] {
  if (!body) return [];

  const criteria: string[] = [];

  // Match checkbox items: - [ ] or - [x] followed by content
  const checkboxPattern = /^[ \t]*-\s+\[[ x]\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = checkboxPattern.exec(body)) !== null) {
    criteria.push(match[1].trim());
  }

  if (criteria.length > 0) return criteria;

  // Fallback: numbered list items under a "Success Criteria" or "Acceptance Criteria" heading
  const sectionMatch = body.match(
    /##\s+(?:Success|Acceptance)\s+Criteria\s*\n([\s\S]*?)(?=\n##\s|\n---|\z|$)/i
  );
  if (sectionMatch) {
    const section = sectionMatch[1];
    const numberedPattern = /^\s*\d+\.\s+(.+)$/gm;
    while ((match = numberedPattern.exec(section)) !== null) {
      criteria.push(match[1].trim());
    }
  }

  return criteria;
}

/**
 * Parse gh issue view JSON output into GOAL_SCHEMA fields.
 * Deterministic — no LLM needed.
 */
export function parseIssueGoal(issueJson: GhIssueJson): GoalData {
  const title = issueJson.title || "";
  const body = issueJson.body || "";
  const labels = (issueJson.labels || []).map((l) =>
    typeof l === "string" ? l : l.name
  );

  // Extract goal: first paragraph of body, or title if body is empty/short
  let issueGoal = title;
  if (body.length > 0) {
    // First paragraph = text before the first blank line or heading
    const paragraphMatch = body.match(/^([\s\S]*?)(?:\n\s*\n|\n##)/);
    if (paragraphMatch && paragraphMatch[1].trim().length > 0) {
      issueGoal = paragraphMatch[1].trim();
    }
  }

  const successCriteria = extractSuccessCriteria(body);

  return {
    issueGoal,
    issueTitle: title,
    successCriteria,
    labels,
  };
}
