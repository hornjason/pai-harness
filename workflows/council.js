export const meta = {
  name: 'council',
  description: 'Multi-round parallel debate with progressive transcript passing',
  whenToUse: 'Architecture decisions, tradeoff analysis, design reviews, any question needing multiple perspectives.',
  phases: [
    { title: 'Research', detail: 'Codebase scan — find relevant files, patterns, prior art' },
    { title: 'Round 1', detail: 'Independent positions — informed by research' },
    { title: 'Round 2', detail: 'Responses — must reference Round 1 points' },
    { title: 'Round 3', detail: 'Synthesis — identify convergence and disagreement' },
    { title: 'Synthesis', detail: 'Chair produces recommendation from all rounds' },
  ],
}

const POSITION_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string' },
    position: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
  required: ['agent', 'position', 'keyPoints', 'recommendation'],
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    convergencePoints: { type: 'array', items: { type: 'string' } },
    disagreements: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
    rationale: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    enforcementClassification: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          type: { type: 'string', enum: ['MECHANICAL', 'BEHAVIORAL'] },
          mechanism: { type: 'string' },
          whyNotMechanical: { type: 'string' },
        },
        required: ['item', 'type'],
      },
    },
    specAlignment: {
      type: 'object',
      properties: {
        specRef: { type: 'string' },
        aligned: { type: 'boolean' },
        divergenceReason: { type: 'string' },
      },
      required: ['aligned'],
    },
  },
  required: ['convergencePoints', 'disagreements', 'recommendation', 'rationale', 'enforcementClassification', 'specAlignment'],
}

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    relevantFiles: { type: 'array', items: { type: 'string' } },
    existingPatterns: { type: 'array', items: { type: 'string' } },
    priorArt: { type: 'array', items: { type: 'string' } },
    keyFindings: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['relevantFiles', 'keyFindings'],
}

// Parse args if passed as string
let parsedArgs = args || {}
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch { parsedArgs = {} }
}

if (!parsedArgs || !parsedArgs.topic) {
  return {
    status: 'ARGS_ERROR',
    message: 'Missing required args. Usage: Workflow({ name: "council", args: { topic: "Should we...", rounds: 3, members: ["architect","engineer","designer","security"] } })',
    received: parsedArgs,
  }
}

const TOPIC = parsedArgs.topic
const ROUNDS = parsedArgs.rounds || 3
const MEMBERS = parsedArgs.members || ['architect', 'engineer', 'designer', 'security']
const CONTEXT = parsedArgs.context || ''
const NO_RESEARCH = parsedArgs.noResearch || false
const ISSUE = parsedArgs.issue || null
const SLUG = parsedArgs.slug || null
const GOVERNING_SPEC = parsedArgs.governingSpec || null
const RESEARCH_DIR = SLUG ? `~/.rungate/${SLUG}` : '~/.rungate/council-research'

const MEMBER_PROMPTS = {
  architect: 'You are Serena Blackwood, a senior systems architect. Focus on: scalability, modularity, data flow, separation of concerns, long-term maintainability. Challenge over-engineering and under-engineering equally.',
  engineer: 'You are Marcus Webb, a principal engineer. Focus on: implementation feasibility, performance, testability, developer experience, edge cases. Ground abstract ideas in concrete code paths.',
  designer: 'You are Aditi Sharma, a UX/UI design specialist. Focus on: user experience, accessibility, information hierarchy, interaction patterns, cognitive load. Advocate for the end user.',
  security: 'You are Rook Blackburn, a security specialist. Focus on: attack surfaces, data exposure, authentication/authorization, input validation, compliance. Find what others miss.',
  product: 'You are a product manager. Focus on: user value, business impact, prioritization, MVP scope, measurable outcomes. Cut scope that doesn\'t directly serve the user.',
  devops: 'You are an infrastructure specialist. Focus on: deployment, monitoring, reliability, cost, operational burden. Flag anything that creates oncall pain.',
}

// ════════════════════════════════════════════════════════════
// PHASE 0: Research (codebase scan)
// ════════════════════════════════════════════════════════════

let researchContext = ''

if (!NO_RESEARCH) {
  phase('Research')
  log('Phase 0: Parallel research — codebase scan + external sources...')

  const [codebaseResearch, externalResearch] = await parallel([
    () => agent(`You are a codebase research agent. Search the LOCAL CODEBASE for facts relevant to a council debate.

TOPIC: ${TOPIC}
${CONTEXT ? `CONTEXT: ${CONTEXT}` : ''}
${GOVERNING_SPEC ? `\n**MANDATORY: Read this governing spec FIRST before any other research: ${GOVERNING_SPEC}\nExtract ALL design decisions from it. The council's recommendation MUST align with this spec or explicitly argue for amending it.**\n` : ''}

DO THIS:
1. grep for keywords from the topic — list every relevant file path with line numbers
2. READ the relevant sections of each file — extract the actual code/config, not just the path
3. Check PAI/ADR/ and PAI/specs/ for related design docs
4. **CRITICAL — Governing spec extraction:** If you find ADRs or specs related to this topic, you MUST:
   a. READ the full document (not just the filename)
   b. EXTRACT the specific design decisions, architectural choices, and constraints
   c. Quote the exact lines that govern this topic's design space
   d. List what the spec says the implementation SHOULD look like
   This is the most important step. A council that debates without knowing its governing spec will produce recommendations that contradict the spec.
5. If topic involves builds/deploys/infrastructure: READ the Makefile and extract relevant targets with their full commands
6. Check git log for recent related commits

YOUR FINAL TEXT OUTPUT IS YOUR RETURN VALUE. Structure it with these headers:

## Relevant Files
- path/file.ts:42 — description

## Existing Patterns
- Pattern name: how it works (cite file:line)

## Prior Art
- ADR-NNN: relevant section — key quote

## Governing Spec Decisions
- Decision 1: exact quote from spec
- Decision 2: exact quote from spec
(If no governing spec found, state "No governing spec found for this topic")


## Key Findings
- Most important discovery

## Warnings
- Gotcha or constraint

Be thorough. READ files, don't guess. Include line numbers. Facts only, no opinions.`, { label: 'codebase-researcher', phase: 'Research' }),

    () => agent(`You are an external research agent. Search the INTERNET and DOCUMENTATION for patterns relevant to a council debate.

TOPIC: ${TOPIC}
${CONTEXT ? `CONTEXT: ${CONTEXT}` : ''}

DO THIS:
1. Use WebSearch to find how other projects solve this problem — search 2-3 different queries
2. Use Context7 (resolve-library-id then query-docs) for any frameworks/tools mentioned in the topic
3. Find established design patterns and their trade-offs
4. Find anti-patterns — what has failed for others

YOUR FINAL TEXT OUTPUT IS YOUR RETURN VALUE. Structure it with these headers:

## Industry Patterns
- Pattern name (used by: project/tool): how it works

## Prior Art
- Framework/tool: relevant approach — key insight

## Key Findings
- Most important external pattern that applies

## Warnings
- Anti-pattern or failure mode from external sources

Search MULTIPLE sources. Include URLs. Facts only, no opinions.`, { label: 'external-researcher', phase: 'Research' })
  ])

  const parts = []

  if (codebaseResearch) {
    parts.push(`## Codebase Research\n\n${codebaseResearch}`)
    const lineCount = codebaseResearch.split('\n').filter(l => l.trim()).length
    log(`Codebase research: ${lineCount} content lines`)
  }

  if (externalResearch) {
    parts.push(`## External Research\n\n${externalResearch}`)
    const lineCount = externalResearch.split('\n').filter(l => l.trim()).length
    log(`External research: ${lineCount} content lines`)
  }

  researchContext = parts.length > 0 ? parts.join('\n\n---\n\n') : ''

  // Write slim research output — synthesis + sources only.
  // findings[] deferred until a real consumer defines what a "finding" means (#300)
  if (researchContext) {
    const sourceRefs = []
    const sections = researchContext.split(/^## /m).filter(s => s.trim())
    let keyFindings = ''

    for (const section of sections) {
      const lines = section.split('\n')
      const header = lines[0].trim()
      if (header === 'Codebase Research' || header === 'External Research') continue

      const bullets = lines.slice(1).filter(l => l.trim().startsWith('- ')).map(l => l.trim().replace(/^- /, '').replace(/`/g, ''))

      for (const bullet of bullets) {
        const fileRefs = bullet.match(/[\w\/.~-]+\.\w+:\d+/g) || []
        for (const ref of fileRefs) {
          if (!sourceRefs.find(s => s.name === ref)) sourceRefs.push({ name: ref, type: 'code' })
        }
        const urlRefs = bullet.match(/https?:\/\/\S+/g) || []
        for (const ref of urlRefs) {
          if (!sourceRefs.find(s => s.name === ref)) sourceRefs.push({ name: ref, type: 'web' })
        }
      }

      if (header === 'Key Findings') keyFindings = bullets.join(' ')
    }

    const researchOutput = {
      contractVersion: '1.0',
      query: TOPIC,
      sources: sourceRefs.length > 0 ? sourceRefs : [{ name: 'research-agents', type: 'code' }],
      synthesis: (keyFindings || 'No key findings extracted').slice(0, 1000),
      capturedAt: '(set-by-caller)'
    }

    await agent(`Write this JSON to ${RESEARCH_DIR}/research-output.json (create directory with mkdir -p if needed):\n${JSON.stringify(researchOutput)}`, { label: 'write-research', phase: 'Research' })
    log(`Research output: ${sourceRefs.length} sources, synthesis ${researchOutput.synthesis.length} chars → ${RESEARCH_DIR}/research-output.json`)
  }

  if (!researchContext) {
    log('Both research agents returned no results — proceeding without research context')
  }
} else {
  log('WARN: Research skipped (--noResearch flag) — council debates with training knowledge only. Findings may miss codebase patterns and external prior art.')
}

// ════════════════════════════════════════════════════════════
// ROUND 1: Independent Positions
// ════════════════════════════════════════════════════════════

phase('Round 1')
log(`Council convened: ${MEMBERS.length} members, ${ROUNDS} rounds`)
log(`Topic: ${TOPIC}`)

const round1 = await parallel(
  MEMBERS.map(member => () => agent(`
${MEMBER_PROMPTS[member] || `You are a ${member} specialist. Bring your domain expertise.`}

## Council Topic
${TOPIC}

${CONTEXT ? `## Additional Context\n${CONTEXT}` : ''}

${researchContext ? researchContext : ''}

## Instructions
This is Round 1 — give your INDEPENDENT position. You have not seen other council members' views.
- State your position clearly
- List 3-5 key points supporting your view
- Flag any concerns or risks you see
- Give a concrete recommendation

Be direct and specific. No hedging. Take a clear stance.
${researchContext ? '\n**SPEC ALIGNMENT:** If the research includes a governing spec or ADR, your recommendation MUST either align with its design decisions or explicitly state why the spec should be amended. Silent contradiction is not acceptable.' : ''}
  `, { label: `r1:${member}`, phase: 'Round 1', schema: POSITION_SCHEMA }))
)

const round1Transcript = round1
  .filter(Boolean)
  .map(r => `### ${r.agent}\n**Position:** ${r.position}\n**Key Points:**\n${r.keyPoints.map(p => `- ${p}`).join('\n')}\n**Concerns:** ${(r.concerns || []).join(', ')}\n**Recommendation:** ${r.recommendation}`)
  .join('\n\n---\n\n')

log(`Round 1 complete — ${round1.filter(Boolean).length} positions collected`)

if (ROUNDS < 2) {
  phase('Synthesis')
  const synthesis = await agent(`
You are the council chair. Synthesize Round 1 positions into a recommendation.

## Topic
${TOPIC}

## Round 1 Positions
${round1Transcript}

${researchContext ? researchContext : ''}

Identify: convergence points, disagreements, recommended path with rationale, risks, and next steps.
  `, { label: 'chair:synthesis', phase: 'Synthesis', schema: SYNTHESIS_SCHEMA })

  return { rounds: 1, research: NO_RESEARCH ? null : researchContext, round1: round1.filter(Boolean), synthesis: synthesis }
}

// ════════════════════════════════════════════════════════════
// ROUND 2: Responses (must reference Round 1)
// ════════════════════════════════════════════════════════════

phase('Round 2')
log('Round 2 — members respond to each other')

const round2 = await parallel(
  MEMBERS.map(member => () => agent(`
${MEMBER_PROMPTS[member] || `You are a ${member} specialist.`}

## Council Topic
${TOPIC}

${researchContext ? researchContext : ''}

## Round 1 Transcript (all positions)
${round1Transcript}

## Instructions — Round 2
You have now seen all Round 1 positions. In this round you MUST:
1. Reference at least 2 other members' points BY NAME (agree, challenge, or build on them)
2. Update your position if others raised valid points you hadn't considered
3. Identify the strongest counterargument to your position and address it
4. Sharpen your recommendation based on the discussion

Do NOT repeat your Round 1 position. Engage with the other perspectives.
${researchContext ? '\n**SPEC ALIGNMENT:** If the research includes a governing spec or ADR, your recommendation MUST either align with its design decisions or explicitly state why the spec should be amended. Silent contradiction is not acceptable.' : ''}
  `, { label: `r2:${member}`, phase: 'Round 2', schema: POSITION_SCHEMA }))
)

const round2Transcript = round2
  .filter(Boolean)
  .map(r => `### ${r.agent}\n**Position:** ${r.position}\n**Key Points:**\n${r.keyPoints.map(p => `- ${p}`).join('\n')}\n**Concerns:** ${(r.concerns || []).join(', ')}\n**Recommendation:** ${r.recommendation}`)
  .join('\n\n---\n\n')

log(`Round 2 complete — ${round2.filter(Boolean).length} responses collected`)

if (ROUNDS < 3) {
  phase('Synthesis')
  const synthesis = await agent(`
You are the council chair. Synthesize 2 rounds of debate into a recommendation.

## Topic
${TOPIC}

## Round 1 Positions
${round1Transcript}

## Round 2 Responses
${round2Transcript}

${researchContext ? researchContext : ''}

Identify: convergence points, remaining disagreements, recommended path, rationale, risks, next steps.
  `, { label: 'chair:synthesis', phase: 'Synthesis', schema: SYNTHESIS_SCHEMA })

  return { rounds: 2, research: NO_RESEARCH ? null : researchContext, round1: round1.filter(Boolean), round2: round2.filter(Boolean), synthesis: synthesis }
}

// ════════════════════════════════════════════════════════════
// ROUND 3: Synthesis (identify convergence)
// ════════════════════════════════════════════════════════════

phase('Round 3')
log('Round 3 — members synthesize and identify convergence')

const round3 = await parallel(
  MEMBERS.map(member => () => agent(`
${MEMBER_PROMPTS[member] || `You are a ${member} specialist.`}

## Council Topic
${TOPIC}

${researchContext ? researchContext : ''}

## Full Transcript

### Round 1
${round1Transcript}

### Round 2
${round2Transcript}

## Instructions — Round 3 (Final)
This is the final round. You MUST:
1. Identify where the council is CONVERGING (shared agreement)
2. Identify remaining DISAGREEMENTS that need resolution
3. State your FINAL recommendation, informed by all discussion
4. If you changed your position from Round 1, explain why
5. Propose specific NEXT STEPS the team should take

Focus on actionable conclusions, not further debate.
${researchContext ? '\n**SPEC ALIGNMENT:** If the research includes a governing spec or ADR, your recommendation MUST either align with its design decisions or explicitly state why the spec should be amended. Silent contradiction is not acceptable.' : ''}
  `, { label: `r3:${member}`, phase: 'Round 3', schema: POSITION_SCHEMA }))
)

const round3Transcript = round3
  .filter(Boolean)
  .map(r => `### ${r.agent}\n**Position:** ${r.position}\n**Key Points:**\n${r.keyPoints.map(p => `- ${p}`).join('\n')}\n**Recommendation:** ${r.recommendation}`)
  .join('\n\n---\n\n')

log(`Round 3 complete — ${round3.filter(Boolean).length} final positions collected`)

// ════════════════════════════════════════════════════════════
// SYNTHESIS: Chair produces recommendation
// ════════════════════════════════════════════════════════════

phase('Synthesis')
log('Chair synthesizing all 3 rounds')

const synthesis = await agent(`
You are the council chair — an impartial synthesizer. Your job is to distill 3 rounds of debate into a clear, actionable recommendation.

## Topic
${TOPIC}

## Round 1 — Independent Positions
${round1Transcript}

## Round 2 — Responses and Challenges
${round2Transcript}

## Round 3 — Final Positions and Convergence
${round3Transcript}

${researchContext ? researchContext : ''}

## Your Task
1. **Convergence points** — where did the council agree? List each point.
2. **Remaining disagreements** — what's still contested? Be specific.
3. **Recommendation** — your recommended path forward. Be decisive — pick one direction.
4. **Rationale** — why this path, given the discussion? Reference specific member arguments.
5. **Risks** — what could go wrong with this recommendation?
6. **Next steps** — concrete, actionable items to implement the recommendation.
7. **Enforcement classification** — for EACH recommendation and next step, classify:
   - MECHANICAL: can be enforced by code (gate check, hook, smoke test, schema validation). Specify the enforcement mechanism.
   - BEHAVIORAL: can only be enforced by a CLAUDE.md rule or human discipline. Explain why it can't be mechanical.
   The bar is: "mechanical-enforcement-over-rules" — behavioral rules get violated. If a recommendation CAN be a gate check, smoke test, or hook, it MUST be. Only recommend CLAUDE.md rules for things that genuinely can't be automated. If more than half of recommendations are BEHAVIORAL, flag this as a concern.
8. **Spec alignment** — Does your recommendation align with or contradict any governing spec/ADR found in the research? If a governing spec exists:
   - Set specRef to the spec path
   - Set aligned to true/false
   - If diverging, explain why and flag as "SPEC AMENDMENT REQUIRED" — the spec must be updated before implementation
   A recommendation that silently contradicts its governing spec is a council failure.

Be decisive. The council debated — now someone needs to decide.
`, { label: 'chair:synthesis', phase: 'Synthesis', schema: SYNTHESIS_SCHEMA })

log('Council complete')

// Write council-synthesis.json with schema-compliant envelope
if (SLUG) {
  const synthEnvelope = {
    contractVersion: '1.0',
    topic: TOPIC,
    decisions: [],
    capturedAt: '(set-by-caller)',
    ...synthesis,
  }
  await agent(`Write this JSON to ~/.rungate/${SLUG}/council-synthesis.json (create directory with mkdir -p if needed):\n${JSON.stringify(synthEnvelope)}`, { label: 'write-synthesis', phase: 'Synthesis' })
  log(`Council synthesis written to ~/.rungate/${SLUG}/council-synthesis.json`)

  // Save permanent record to docs/council/ in the repo
  const today = 'agent_fill_date'
  const topicSlug = TOPIC.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  await agent(`
Save the council synthesis as a permanent record in the repo.

1. Run: date +%Y-%m-%d to get today's date
2. Write a markdown file to ${PROJECT_ROOT}/docs/council/{date}-${topicSlug}.md with:
   - Frontmatter: doc-type: council, status: accepted, created: {date}, topic: "${TOPIC}"
   - Council topic, decisions, convergence points, recommendation
   - Members and round count

Content to save:
${JSON.stringify(synthEnvelope, null, 2)}

3. Stage and commit: git add docs/council/ && git commit -m "docs: council synthesis — ${TOPIC.slice(0, 50)}"
Do NOT push — the caller handles that.
  `, { label: 'save-council-doc', phase: 'Synthesis' })
  log('Council record saved to docs/council/')
}

return {
  topic: TOPIC,
  rounds: 3,
  members: MEMBERS,
  research: NO_RESEARCH ? null : researchContext,
  round1: round1.filter(Boolean),
  round2: round2.filter(Boolean),
  round3: round3.filter(Boolean),
  synthesis: synthesis,
}
