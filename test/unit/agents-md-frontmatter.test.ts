import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateAgentsMd } from '../../lib/generators/agents-md';
import { mockProjectScan } from '../../lib/generators/types';
import { localCalendarDay } from '../../lib/local-calendar-day';

function scanAt(root: string) {
  return mockProjectScan({ root, name: 'demo' });
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'agentsmd-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('AGENTS.md frontmatter (#63)', () => {
  it('emits frontmatter when no AGENTS.md exists yet', () => {
    const out = withRoot(root => generateAgentsMd(scanAt(root)));
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('doc-type: reference');
    expect(out).toContain('status: active');
    expect(out).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
  });

  it('preserves an existing owner across re-scaffold', () => {
    // Re-scaffolding used to strip the block entirely, losing a hand-set owner.
    const out = withRoot(root => {
      writeFileSync(join(root, 'AGENTS.md'), '---\ndoc-type: reference\nstatus: active\nowner: jason\nupdated: 2020-01-01\n---\n\n# demo\n');
      return generateAgentsMd(scanAt(root));
    });
    expect(out).toContain('owner: jason');
  });

  it('preserves unrecognized custom keys', () => {
    const out = withRoot(root => {
      writeFileSync(join(root, 'AGENTS.md'), '---\nowner: jason\nteam: platform\n---\n\n# demo\n');
      return generateAgentsMd(scanAt(root));
    });
    expect(out).toContain('team: platform');
  });

  it('refreshes updated rather than carrying a stale date', () => {
    const out = withRoot(root => {
      writeFileSync(join(root, 'AGENTS.md'), '---\nowner: jason\nupdated: 2020-01-01\n---\n\n# demo\n');
      return generateAgentsMd(scanAt(root));
    });
    expect(out).not.toContain('updated: 2020-01-01');
    // #600. This followed the generator: it asserted the UTC day because the
    // generator stamped the UTC day, so between 20:00 EDT and midnight the
    // two were wrong together and the case stayed green. It is a DEPENDENT
    // assertion, not an independent day-stamp site — it has to name whatever
    // rule `generateAgentsMd` uses, which is now the shared helper.
    expect(out).toContain(`updated: ${localCalendarDay()}`);
  });

  it('drops a value that would terminate the block early', () => {
    // Re-emitted verbatim, so a delimiter in a value could split the file
    // into two documents and smuggle keys past the parser next round-trip.
    const out = withRoot(root => {
      writeFileSync(join(root, 'AGENTS.md'), '---\nowner: jason\nevil: "x\n---\ninjected: true\n---\n\n# demo\n');
      return generateAgentsMd(scanAt(root));
    });
    expect(out).not.toContain('injected: true');
    expect(out.split(/^---$/m).length - 1).toBe(2);
  });

  it('drops an absurdly long value', () => {
    const out = withRoot(root => {
      writeFileSync(join(root, 'AGENTS.md'), `---\nowner: jason\nbloat: ${'x'.repeat(500)}\n---\n\n# demo\n`);
      return generateAgentsMd(scanAt(root));
    });
    expect(out).not.toContain('x'.repeat(500));
    expect(out).toContain('owner: jason');
  });

  it('produces exactly one frontmatter block', () => {
    const out = withRoot(root => {
      writeFileSync(join(root, 'AGENTS.md'), '---\nowner: jason\n---\n\n# demo\n');
      return generateAgentsMd(scanAt(root));
    });
    expect(out.split(/^---$/m).length - 1).toBe(2);
  });
});

describe('AGENTS.md convert-spec command row (#63)', () => {
  it('lists convert-spec when the script exists', () => {
    const out = withRoot(root => {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'convert-spec.ts'), '// stub\n');
      return generateAgentsMd(scanAt(root));
    });
    expect(out).toContain('| Convert spec |');
    expect(out).toContain('bun scripts/convert-spec.ts');
  });

  it('omits convert-spec for consumers without the script', () => {
    const out = withRoot(root => generateAgentsMd(scanAt(root)));
    expect(out).not.toContain('| Convert spec |');
  });
});
