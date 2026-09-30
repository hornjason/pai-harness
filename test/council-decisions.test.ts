import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Council decisions[] output', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'council-decisions-'))
  })

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  test('SYNTHESIS_SCHEMA includes decisions[] array', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    expect(content).toContain('SYNTHESIS_SCHEMA')
    expect(content).toContain('decisions')

    // Verify schema structure includes decisions array
    const schemaMatch = content.match(/const SYNTHESIS_SCHEMA = \{[\s\S]*?\n\}/m)
    expect(schemaMatch).toBeTruthy()
    expect(schemaMatch![0]).toContain('decisions')
    expect(schemaMatch![0]).toContain('type: \'array\'')
  })

  test('Decision schema has required fields: id, statement, target, disposition', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    // Find SYNTHESIS_SCHEMA and verify decisions array has correct structure
    expect(content).toContain('id')
    expect(content).toContain('statement')
    expect(content).toContain('target')
    expect(content).toContain('disposition')

    // Verify disposition enum
    const dispositionMatch = content.match(/disposition.*enum.*\[.*'accepted'.*'rejected'.*'deferred'.*\]/s)
    expect(dispositionMatch).toBeTruthy()
  })

  test('decision-reconcile.sh returns found/missing counts for valid decisions', () => {
    // Create a test council-synthesis.json with decisions
    const synthPath = join(tempDir, 'council-synthesis.json')
    const targetPath = join(tempDir, 'target.md')

    writeFileSync(targetPath, `# Target Doc\n\nDEC-001 This decision exists in the doc\n\n## Section\n\nSome content here.`)

    const synthesis = {
      contractVersion: '1.0',
      topic: 'Test topic',
      decisions: [
        {
          id: 'DEC-001',
          statement: 'This decision exists in the doc',
          target: { ref: targetPath },
          disposition: 'accepted'
        },
        {
          id: 'DEC-002',
          statement: 'This decision is missing',
          target: { ref: targetPath },
          disposition: 'rejected'
        }
      ],
      convergencePoints: [],
      disagreements: [],
      recommendation: 'Test',
      rationale: 'Test',
      enforcementClassification: [],
      specAlignment: { aligned: true }
    }

    writeFileSync(synthPath, JSON.stringify(synthesis, null, 2))

    // Run decision-reconcile.sh
    const scriptPath = join(process.cwd(), 'scripts/decision-reconcile.sh')
    let output = ''
    let exitCode = 0

    try {
      output = execSync(`bash "${scriptPath}" "${synthPath}"`, { encoding: 'utf8' })
    } catch (err: any) {
      output = err.stdout || ''
      exitCode = err.status || 1
    }

    // Verify output contains found/missing counts
    expect(output).toContain('FOUND: DEC-001')
    expect(output).toContain('MISSING: DEC-002')
    expect(output).toMatch(/Reconcile:.*1 found.*1 missing/)
    expect(exitCode).toBe(1) // Should fail when there are missing decisions
  })

  test('council workflow instructions require decisions[] in synthesis prompt', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    // Find the synthesis agent prompt
    const synthesisPromptMatch = content.match(/You are the council chair.*?schema: SYNTHESIS_SCHEMA/s)
    expect(synthesisPromptMatch).toBeTruthy()

    // Verify the prompt instructs the agent to output decisions
    const prompt = synthesisPromptMatch![0]
    expect(prompt).toContain('decisions')
    expect(prompt.toLowerCase()).toMatch(/decision.*id.*statement.*target.*disposition/)
  })

  test('council workflow runs decision-reconcile.sh after synthesis', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    // Verify there's a reconcile phase after synthesis
    expect(content).toContain('decision-reconcile.sh')

    // Should reference the synthesis file location
    expect(content).toMatch(/decision-reconcile\.sh.*council-synthesis\.json/s)
  })

  test('council workflow return value includes reconcile results', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    // Check that the return value includes reconcileResults
    const returnMatches = content.match(/return \{[\s\S]*?\}/g)
    expect(returnMatches).toBeTruthy()

    // At least one return should include reconcileResults
    const hasReconcile = returnMatches!.some(ret => ret.includes('reconcileResults'))
    expect(hasReconcile).toBe(true)
  })

  test('council workflow warns if decisions are missing from target docs', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    // Should have logic to warn about missing decisions
    expect(content).toMatch(/warn|WARN|missing/i)

    // Should check reconcile results and log warnings
    const hasWarningLogic = content.match(/reconcile.*missing/is) || content.match(/missing.*warn/is)
    expect(hasWarningLogic).toBeTruthy()
  })

  test('decision-reconcile.sh handles empty decisions array gracefully', () => {
    const synthPath = join(tempDir, 'council-synthesis-empty.json')
    const synthesis = {
      contractVersion: '1.0',
      topic: 'Test',
      decisions: [],
      convergencePoints: [],
      disagreements: [],
      recommendation: 'Test',
      rationale: 'Test',
      enforcementClassification: [],
      specAlignment: { aligned: true }
    }

    writeFileSync(synthPath, JSON.stringify(synthesis, null, 2))

    const scriptPath = join(process.cwd(), 'scripts/decision-reconcile.sh')
    let output = ''
    let exitCode = 0

    try {
      output = execSync(`bash "${scriptPath}" "${synthPath}"`, { encoding: 'utf8' })
      exitCode = 0
    } catch (err: any) {
      output = err.stdout || ''
      exitCode = err.status || 1
    }

    // Should succeed with 0 decisions
    expect(output).toMatch(/Reconcile:.*0 found.*0 missing/)
    expect(exitCode).toBe(0)
  })

  test('synthesis envelope preserves existing fields and adds decisions[]', async () => {
    const workflowPath = join(process.cwd(), 'workflows/council.js')
    const content = await Bun.file(workflowPath).text()

    // Find where synthEnvelope is created
    const envelopeMatch = content.match(/const synthEnvelope = \{[\s\S]*?\n\s*\}/m)
    expect(envelopeMatch).toBeTruthy()

    const envelope = envelopeMatch![0]
    // Should preserve existing fields and spread synthesis (which includes decisions)
    expect(envelope).toContain('contractVersion')
    expect(envelope).toContain('topic')
    expect(envelope).toContain('...synthesis')

    // Verify decisions is in SYNTHESIS_SCHEMA (which synthesis conforms to)
    expect(content).toContain('decisions:')
    const schemaMatch = content.match(/const SYNTHESIS_SCHEMA = \{[\s\S]*?required:[\s\S]*?\]/m)
    expect(schemaMatch).toBeTruthy()
    expect(schemaMatch![0]).toContain('decisions')
  })
})
