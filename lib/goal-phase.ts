/**
 * Deterministic goal-phase parsing for ship.js.
 * Replaces LLM agent calls with regex-based extraction.
 */

export interface GoalData {
  issueGoal: string;
  successCriteria: string[];
  issueTitle: string;
  labels: string[];
}

interface IssueJson {
  title: string;
  body: string;
  labels: Array<{ name: string }> | string[];
}

/**
 * Extract success criteria (SC-* or AC-*) from an issue body.
 * Handles checkbox format (- [ ] SC-N: ...) and numbered list format (1. SC-N: ...).
 */
export function extractSuccessCriteria(body: string): string[] {
  if (!body) return [];

  const criteria: string[] = [];
  const lines = body.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match checkbox format: - [ ] SC-100: text or - [x] AC-1: text
    const checkboxMatch = trimmed.match(
      /^-\s*\[[ x]\]\s*((?:SC|AC)-\d+:\s*.+)$/i
    );
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim());
      continue;
    }
    // Match numbered list format: 1. SC-300: text
    const numberedMatch = trimmed.match(
      /^\d+\.\s*((?:SC|AC)-\d+:\s*.+)$/i
    );
    if (numberedMatch) {
      criteria.push(numberedMatch[1].trim());
    }
  }

  return criteria;
}

/**
 * Parse a GitHub issue JSON object into the GoalData schema.
 * Extracts issueGoal (first paragraph or title), successCriteria, issueTitle, and labels.
 */
export function parseGoalFromIssue(issue: IssueJson): GoalData {
  const issueTitle = issue.title || "";
  const body = issue.body || "";

  // Extract goal: first non-empty paragraph of the body, or title if body is empty/short
  let issueGoal = issueTitle;
  if (body.trim().length > 0) {
    // Split by double newline to get paragraphs, skip empty ones and heading lines
    const paragraphs = body.split(/\n\n+/).filter((p) => {
      const trimmed = p.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
    if (paragraphs.length > 0) {
      issueGoal = paragraphs[0].trim();
    }
  }

  const successCriteria = extractSuccessCriteria(body);

  // Labels can be objects with .name or plain strings
  const labels = (issue.labels || []).map((l: any) =>
    typeof l === "string" ? l : l.name
  );

  return { issueGoal, successCriteria, issueTitle, labels };
}
