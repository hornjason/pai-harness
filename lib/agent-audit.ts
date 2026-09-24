/**
 * Agent transcript auditing logic
 *
 * Provides audit functionality for agent transcripts, extracting this logic
 * from hooks for testability (per Hook Architecture Spec D-2).
 *
 * Used by: AgentVerdictCapture.hook.ts
 */

import { existsSync } from 'fs';
import { auditAgent, type Role } from '../scripts/audit-transcript';

export interface AgentAuditResult {
  role: Role;
  score: number;
  grade: string;
  totalCalls: number;
  rules: Array<{
    id: string;
    rule: string;
    verdict: 'FOLLOWED' | 'IGNORED';
    evidence: string;
    weight: number;
  }>;
  timestamp: string;
}

/**
 * Map hook agent role to audit role.
 * DA orchestrates and should be graded against DA criteria.
 */
export function mapRoleToAuditRole(role: string): Role {
  if (role === 'quinn') return 'quinn';
  if (role === 'marcus') return 'marcus';
  // DA, rook, and other roles use DA criteria
  return 'da';
}

/**
 * Run transcript audit for an agent.
 * Returns audit results or null if audit fails or transcript missing.
 * Non-blocking — catches all errors.
 */
export function runAgentAudit(
  transcriptPath: string | undefined,
  role: string,
): AgentAuditResult | null {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return null;
  }

  try {
    const auditRole = mapRoleToAuditRole(role);
    const audit = auditAgent(transcriptPath, auditRole);

    return {
      role: audit.role,
      score: audit.score,
      grade: audit.grade,
      totalCalls: audit.totalCalls,
      rules: audit.rules.map(r => ({
        id: r.id,
        rule: r.rule,
        verdict: r.verdict,
        evidence: r.evidence,
        weight: r.weight,
      })),
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    // Non-blocking — log and return null
    return null;
  }
}
