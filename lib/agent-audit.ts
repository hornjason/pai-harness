/**
 * Agent transcript auditing logic
 *
 * Provides audit functionality for agent transcripts, extracting this logic
 * from hooks for testability (per Hook Architecture Spec D-2).
 *
 * Used by: AgentVerdictCapture.hook.ts
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { auditAgent, type Role } from '../scripts/audit-transcript';
import { writeCache, type BehavioralCache } from './behavioral-cache';

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

/**
 * Populate behavioral-results cache from audit criteria results.
 * Maps SC IDs to audit criterion verdicts via behavioral-sc-map.json.
 * Non-blocking — catches all errors.
 *
 * Issue: #544 — extracted from AgentVerdictCapture.hook.ts
 */
export function populateBehavioralCache(
  auditResult: AgentAuditResult & { criteria?: Array<{ id: string; verdict: string; evidence: string }> },
  projectRoot: string,
): number {
  try {
    const mapPath = join(projectRoot, 'config', 'behavioral-sc-map.json');
    if (!existsSync(mapPath)) return 0;

    const scMap: Record<string, { criterionId: string }> = JSON.parse(readFileSync(mapPath, 'utf-8'));
    const criteriaResults = auditResult.criteria || [];
    const criterionMap = new Map<string, { id: string; verdict: string; evidence: string }>();
    for (const r of criteriaResults) criterionMap.set(r.id, r);

    const cacheData: BehavioralCache = {};
    const now = new Date().toISOString();
    for (const [scId, mapping] of Object.entries(scMap)) {
      const result = criterionMap.get(mapping.criterionId);
      if (result) {
        cacheData[scId] = {
          passed: result.verdict === 'FOLLOWED',
          evidence: `${result.id}: ${result.evidence}`,
          timestamp: now,
        };
      }
    }

    if (Object.keys(cacheData).length > 0) {
      const cachePath = join(projectRoot, '.rungate', 'behavioral-results.json');
      writeCache(cachePath, cacheData);
      return Object.keys(cacheData).length;
    }
  } catch {
    // Non-blocking
  }
  return 0;
}
