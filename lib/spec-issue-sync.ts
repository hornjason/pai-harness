/**
 * spec-issue-sync — reads GitHub issue bodies and extracts mechanical claims
 * to append as SC lines to governing spec files.
 *
 * AC-2 (#508): >= 2 exported functions for issue-to-spec sync.
 * Follows the pattern established by lib/spec-updater.ts.
 *
 * Issue: #508
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

export interface IssueClaim {
  id: string;
  claim: string;
  source_line: number;
  context: string;
}

export interface AppendClaimsResult {
  appended: boolean;
  claimsAdded: number;
  reason?: string;
}

/**
 * Extract mechanical claims from a GitHub issue body text.
 *
 * Detects:
 * - GATE markers: lines containing `**GATE:` or `**Gate:**`
 * - make commands: lines with `make <target>` in backticks
 * - Quinn action verbs: Quinn validates/captures/tests/navigates/compares/verifies
 *
 * Returns deduplicated list of claims.
 */
export function extractMechanicalClaims(body: string): IssueClaim[] {
  const claims: IssueClaim[] = [];
  const lines = body.split("\n");
  let claimCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // GATE markers
    if (line.includes("**GATE:") || line.includes("**Gate:**") || line.includes("**GATE")) {
      const gateText = line.replace(/\*\*/g, "").replace("GATE:", "").replace("Gate:", "").trim();
      claims.push({
        id: `ISSUE-CLAIM-${++claimCounter}`,
        claim: `Gate: ${gateText.slice(0, 80)}`,
        source_line: lineNum,
        context: line.trim().slice(0, 100),
      });
    }

    // make commands
    const makeMatch = line.match(/`(make\s+[\w-]+)`/);
    if (makeMatch) {
      const cmd = makeMatch[1];
      claims.push({
        id: `ISSUE-CLAIM-${++claimCounter}`,
        claim: `Spec requires ${cmd}`,
        source_line: lineNum,
        context: line.trim().slice(0, 100),
      });
    }

    // Quinn action patterns
    const quinnMatch = line.match(/Quinn\s+(validates|captures|tests|navigates|compares|verifies)/i);
    if (quinnMatch) {
      const action = quinnMatch[1].toLowerCase();
      claims.push({
        id: `ISSUE-CLAIM-${++claimCounter}`,
        claim: `Quinn ${action}`,
        source_line: lineNum,
        context: line.trim().slice(0, 100),
      });
    }
  }

  // Deduplicate by claim text (case-insensitive)
  const seen = new Set<string>();
  return claims.filter(c => {
    const key = c.claim.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Append extracted claims as SC lines to a spec file.
 *
 * - Skips claims already present in the spec (by claim text match)
 * - Appends new SC lines with issue number reference
 * - Returns count of claims actually added
 */
export function appendClaimsToSpec(
  specPath: string,
  claims: IssueClaim[],
  issueNumber: number
): AppendClaimsResult {
  if (!existsSync(specPath)) {
    return { appended: false, claimsAdded: 0, reason: `spec file not found at ${specPath}` };
  }

  if (claims.length === 0) {
    return { appended: false, claimsAdded: 0, reason: "no claims to append" };
  }

  let content = readFileSync(specPath, "utf-8");
  const contentLower = content.toLowerCase();
  let added = 0;

  // Find the highest existing SC number in the file
  const scMatches = content.match(/SC-(\d+)/g);
  let maxSC = 0;
  if (scMatches) {
    for (const m of scMatches) {
      const num = parseInt(m.replace("SC-", ""), 10);
      if (num > maxSC) maxSC = num;
    }
  }

  const linesToAppend: string[] = [];

  for (const claim of claims) {
    // Skip if claim text already exists in spec (case-insensitive)
    if (contentLower.includes(claim.claim.toLowerCase())) {
      continue;
    }

    maxSC++;
    const scId = `SC-${maxSC}`;
    linesToAppend.push(`- [ ] ${scId}: ${claim.claim} (#${issueNumber})`);
    added++;
  }

  if (added === 0) {
    return { appended: false, claimsAdded: 0, reason: "all claims already present" };
  }

  // Append new SC lines at end of file
  if (!content.endsWith("\n")) {
    content += "\n";
  }
  content += "\n## Issue Claims (#" + issueNumber + ")\n\n";
  content += linesToAppend.join("\n") + "\n";

  writeFileSync(specPath, content);

  return { appended: true, claimsAdded: added };
}
