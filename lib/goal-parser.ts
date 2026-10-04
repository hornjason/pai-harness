/**
 * Deterministic goal parser for ship.js PHASE 1: GOAL.
 * Replaces LLM agent calls with regex-based extraction from GitHub issue JSON.
 */

// Patterns for success criteria / acceptance criteria extraction
const SC_CHECKBOX = /^[-*]\s*\[[ x]\]\s*((?:SC|AC)-\d+.*)/;
const SC_NUMBERED = /^\d+\.\s*((?:SC|AC)-\d+.*)/;
const SC_DASH = /^[-*]\s*((?:SC|AC)-\d+.*)/;

/**
 * Extract success criteria / acceptance criteria from issue body text.
 * Handles checkbox format (- [ ] SC-N), numbered lists (1. AC-N), and plain dashes (- SC-N).
 */
export function extractSuccessCriteria(body: string): string[] {
  if (!body) return [];

  const lines = body.split("\n");
  const criteria: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Try checkbox format first: - [ ] SC-100: description
    const checkboxMatch = SC_CHECKBOX.exec(trimmed);
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim());
      continue;
    }

    // Try numbered format: 1. AC-1: description
    const numberedMatch = SC_NUMBERED.exec(trimmed);
    if (numberedMatch) {
      criteria.push(numberedMatch[1].trim());
      continue;
    }

    // Try plain dash format: - SC-100: description
    const dashMatch = SC_DASH.exec(trimmed);
    if (dashMatch) {
      criteria.push(dashMatch[1].trim());
      continue;
    }
  }

  return criteria;
}

/**
 * Extract the goal statement from the issue body.
 * Uses the first non-heading, non-empty paragraph before any "## Success Criteria" or similar section.
 * Falls back to the issue title if no clear goal paragraph is found.
 */
function extractGoal(body: string | null, title: string): string {
  if (!body) return title;

  const lines = body.split("\n");
  const paragraphLines: string[] = [];
  let foundContent = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip heading lines
    if (trimmed.startsWith("#")) {
      // If we already collected paragraph text, stop
      if (foundContent && paragraphLines.length > 0) break;
      continue;
    }

    // Skip empty lines before content
    if (!trimmed && !foundContent) continue;

    // Stop at criteria sections
    if (/^([-*]\s*\[|[-*]\s*(?:SC|AC)-|\d+\.\s*(?:SC|AC)-)/.test(trimmed)) break;

    if (trimmed) {
      foundContent = true;
      paragraphLines.push(trimmed);
    } else if (foundContent) {
      // Empty line after content — end of first paragraph
      break;
    }
  }

  const goal = paragraphLines.join(" ").trim();
  return goal || title;
}

interface IssueJson {
  title: string;
  body: string | null;
  labels: Array<{ name: string }> | string[];
}

interface GoalData {
  issueGoal: string;
  successCriteria: string[];
  issueTitle: string;
  labels: string[];
}

/**
 * Parse a GitHub issue JSON object into the GOAL_SCHEMA format.
 * All four fields are populated deterministically.
 */
export function parseGoalFromIssue(issue: IssueJson): GoalData {
  const issueTitle = issue.title;
  const issueGoal = extractGoal(issue.body, issueTitle);
  const successCriteria = extractSuccessCriteria(issue.body || "");
  const labels = (issue.labels || []).map((l: any) =>
    typeof l === "string" ? l : l.name
  );

  return { issueGoal, successCriteria, issueTitle, labels };
}
