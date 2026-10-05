import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hashAcDefinitions } from '../../gates/orchestrator';
import { computeACHash } from '../../lib/workflow-security';

const ORCHESTRATOR = join(import.meta.dir, '../../gates/orchestrator.ts');

const ACS = [
  { id: 'AC-1', type: 'static', statement: 'a', specElement: 'SC-1', threshold: { op: 'eq', value: 1 }, evidenceMethod: { type: 'COMMAND', command: 'bun test' } },
  { id: 'AC-2', type: 'static', statement: 'b', specElement: 'SC-2', threshold: undefined, evidenceMethod: { type: 'MANUAL' } },
];

describe('acHash is computed in exactly one place (#57)', () => {
  it('orchestrator no longer hand-rolls the hash', () => {
    // Two byte-identical copies of this projection + hash existed. #43 was an
    // acHash bug; duplication is how a fix lands in one copy and not the other.
    const src = readFileSync(ORCHESTRATOR, 'utf-8');
    const inlineHashes = src.match(/createHash\("sha256"\)\.update\(JSON\.stringify\(acDefs\)\)/g) || [];
    expect(inlineHashes).toHaveLength(0);
  });

  it('delegates to lib/workflow-security computeACHash', () => {
    expect(hashAcDefinitions(ACS)).toBe(computeACHash(ACS as any));
  });
});

describe('hashAcDefinitions behavior', () => {
  it('is stable across repeated calls', () => {
    expect(hashAcDefinitions(ACS)).toBe(hashAcDefinitions(ACS));
  });

  it('changes when a definition field changes', () => {
    const modified = [{ ...ACS[0], statement: 'CHANGED' }, ACS[1]];
    expect(hashAcDefinitions(modified)).not.toBe(hashAcDefinitions(ACS));
  });

  it('changes when evidenceMethod changes', () => {
    const modified = [{ ...ACS[0], evidenceMethod: { type: 'MANUAL' } }, ACS[1]];
    expect(hashAcDefinitions(modified)).not.toBe(hashAcDefinitions(ACS));
  });

  it('ignores verdict and evidence fields gates populate after scope', () => {
    // Including them caused the false mismatches ADR-009 exists to avoid.
    const withOutputs = ACS.map(ac => ({ ...ac, verdict: 'PASS', evidence: 'some output', actualValue: 42 }));
    expect(hashAcDefinitions(withOutputs)).toBe(hashAcDefinitions(ACS));
  });

  it('is order-independent', () => {
    expect(hashAcDefinitions([...ACS].reverse())).toBe(hashAcDefinitions(ACS));
  });

  it('handles an empty AC list', () => {
    expect(typeof hashAcDefinitions([])).toBe('string');
    expect(hashAcDefinitions([])).toHaveLength(64);
  });
});
