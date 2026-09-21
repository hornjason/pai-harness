---
doc-type: spec
status: draft
owner: jason
created: 2026-09-18
updated: 2026-09-18
governs: Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content assertions
testable: true
parent-spec: BOOTSTRAP-DATA-FLOW-SPEC.md
---

# Bootstrap Data Flow Test Plan

## Problem Statement

Specs get implemented halfway. Past experience shows that "file exists" tests pass with empty files, principles get listed but not explained, brief ordering goes wrong, and "close enough" implementations pass review. 163 SCs require a mechanical verification strategy that catches incomplete delivery at content level, not just structural level.

## Document Chain

```
BOOTSTRAP-DATA-FLOW-SPEC.md (WHAT to build — 163 SCs)
  ↓ governs
BOOTSTRAP-TEST-PLAN.md (HOW to verify — this document, 14 TPs)
  ↓ agent generates (reads SC text → writes test assertion)
test/phase-0.test.ts (scaffold output content verification)
test/phase-1.test.ts (knowledge extraction + doc hygiene + findings pipeline)
test/phase-2.test.ts (gate enforcement)
test/phase-3.test.ts (parallel work)
test/meta-sc-coverage.test.ts (catches untested SCs — triggers agent to write tests)
  ↓ runs against
test/fixtures/golden-project/ (synthetic project with known structure)
  ↓ scaffold produces
/tmp/rungate-phase{N}-test/ (ephemeral output, verified per phase)
  ↓ conformity writes
.rungate/conformity-findings.json (unified: findings + candidates + staleness)
  ↓ gate runner reads
workflow-state.json (conformityFindings field — agents read fix commands)
  ↓ agent executes
fixCommands → re-runs bun test → PASS
```

**Automation loop:** When spec changes → drift guard FAILS → meta-test lists untested SCs → agent writes tests for them → agent updates hash. No manual steps. The meta-test is the trigger that tells the agent "these SCs need tests."

When a spec changes (fully automated — no manual steps):
1. BOOTSTRAP-DATA-FLOW-SPEC.md updated → spec-drift hash triggers test FAIL
2. Meta-test lists untested SCs by ID
3. Agent reads each untested SC text from the spec
4. Agent writes test assertion (SC text IS the test specification — "SC-40: .gitignore has all security entries" → `expect(content).toContain("*.pem")`)
5. Agent runs tests → RED (implementation needed) or GREEN (already implemented)
6. Agent updates spec hash in test files
7. If RED → agent implements the feature → tests GREEN
8. Conformity findings JSON regenerated with current state

The SC text is the test oracle. An agent that can read "SC-40: .gitignore has full security template" can write the test assertion. This was proven in the first session — 85 tests written from SC text by the agent.

Nothing is verbal — every claim in the spec has a test, every test runs against real output, every detection result persists in a machine-readable file.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| TD-1 | Golden test fixture as primary oracle | Output-level diffing catches everything: missing content, wrong order, missing examples. A file-exists test passes with an empty file; a golden-diff test doesn't. |
| TD-2 | Content-assertion tests per SC (not file-existence) | Each SC gets a test that asserts CONTENT. `expect(content).toContain("DEEP MODULES")` not `expect(existsSync(file)).toBe(true)` |
| TD-3 | Phased implementation with gates between phases | Can't skip ahead. Phase N tests must pass before Phase N+1 starts. Prevents "close enough" on early phases. |
| TD-4 | Dogfood: ship the harness using the harness | Once brief assembly works, use the harness to ship remaining phases. If briefs produce correct agent behavior, they're correct. |
| TD-5 | Tests written BEFORE implementation (TDD) | All 149 SCs start RED. Implementation turns them GREEN. No test written after-the-fact to match existing behavior. |
| TD-6 | Spec-drift hash prevents future decay | Content hash of parent spec tracked in tests. Spec change = test FAIL until tests updated. Catches drift mechanically. |
| TD-7 | Golden fixture is the template for all future test plans | This approach becomes the standard for testing any spec in the harness. Fixture + content assertions + phased gates. |

## Golden Test Fixture

The fixture is a synthetic project with known, deterministic structure. Scaffold runs against it. Every output file is compared to expected output at content level.

### Fixture project structure

```
test/fixtures/golden-project/
├── src/
│   ├── index.ts              # Hono app, 3 routes (GET /, GET /api/health, POST /api/data)
│   ├── auth.ts               # Module with 2 exports (validateToken, refreshToken)
│   ├── db.ts                 # Module with 3 exports (query, insert, migrate)
│   └── utils/
│       └── format.ts         # Pure utility, 1 export (formatDate)
├── test/
│   └── auth.test.ts          # Existing test file (3 tests)
├── docs/
│   └── setup-guide.md        # Doc with frontmatter
├── specs/
│   └── api-spec.md           # Spec with testable: true, 2 SCs
├── docs/adr/
│   └── ADR-001-framework.md  # ADR with status: accepted
├── prompts/                  # All 24 RunGate prompt templates (harness-owned)
│   ├── ac-adversary.md       # Adversarial AC reviewer
│   ├── ac-format.md          # AC format requirements
│   ├── aditi.md              # Designer brief template
│   ├── blast-radius.md       # Blast radius assessment
│   ├── coding-principles.md  # Coding standards
│   ├── container-rebuild.md  # Container rebuild protocol
│   ├── container-verify.md   # Container verification
│   ├── discovery.md          # Discovery phase protocol
│   ├── environment.md        # Environment setup verification
│   ├── escalation-decision-tree.md  # Escalation decision tree
│   ├── evidence-hierarchy.md # Evidence tiers
│   ├── evidence-validator.md # Evidence validation
│   ├── marcus.md             # Engineer brief template
│   ├── prevention.md         # Prevention-oriented fixes
│   ├── prove-reproducer.md   # Prove reproducer protocol
│   ├── quinn-decision-tree.md # Quinn decision tree
│   ├── quinn-ui-brief.md     # Quinn UI testing methodology
│   ├── quinn.md              # QA brief template
│   ├── rca.md                # Root cause analysis
│   ├── read-before-write.md  # Read-before-write protocol
│   ├── regression.md         # Regression test requirements
│   ├── rook.md               # Security reviewer brief template
│   ├── serena.md             # Architect brief template
│   └── testing-strategy.md   # Testing strategy
├── .env.example              # PORT=3000, API_PORT=3000, DATABASE_URL=, SECRET_KEY=
├── package.json              # name: "golden-project", type: "module"
├── tsconfig.json             # strict: true
├── Makefile                  # dev: PORT=3000 bun run src/index.ts
└── .git/                     # Initialized repo
```

### Why this structure

- 3 routes → CODE-MAP must find them
- 2+ modules with known exports → consumer scan must detect them
- .env.example → envVars must populate (PORT, API_PORT, DATABASE_URL, SECRET_KEY)
- Makefile with port → rungate.json must detect port 3000
- Existing tests → test baseline must capture pass/fail count
- Spec with SCs → spec-drift must hash it
- ADR → doc hygiene must validate frontmatter
- Utility module with 1 export → tests can check shallow module detection
- All 24 RunGate prompts → scaffold injects into agent briefs as "Project Standards" section (SC-161), routes by keyword to relevant agents
- Prompt compliance → all 24 prompt files graded by agnix + RepoRails, hill climbed to reduce HIGH findings

### Expected output files

```
test/expected/
├── AGENTS.md                          # Exact expected AGENTS.md output
├── CODE-MAP.md                        # Exact expected CODE-MAP output
├── .claude/
│   ├── rungate.json                   # Exact expected config
│   └── agents/
│       ├── marcus.md                  # Full expected brief with principles, ordering, examples
│       ├── quinn.md                   # Full expected brief with journey format
│       ├── rook.md                    # Full expected brief with security checklist
│       ├── serena.md                  # Full expected brief with architecture review
│       └── aditi.md                   # Full expected brief with component spec
├── test/
│   └── scaffold-conformity.test.ts    # Expected conformity test
├── .github/
│   ├── copilot-instructions.md        # Expected tool bridge
│   └── workflows/
│       ├── ci.yml                     # Expected CI workflow
│       └── gates.yml                  # Expected gates workflow
├── .gitignore                         # Expected entries
├── CLAUDE.md                          # Expected bridge content
└── specs/
    └── SPEC-TEMPLATE.md               # Expected template
```

### Golden fixture test pattern

```typescript
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "fixtures/golden-project");
const EXPECTED = join(import.meta.dir, "expected");
const OUTPUT = "/tmp/golden-test-output";

describe("golden fixture: scaffold produces exact expected output", () => {
  beforeAll(() => {
    // Copy fixture to temp dir (don't modify fixture)
    execSync(`rm -rf ${OUTPUT} && cp -r ${FIXTURE} ${OUTPUT}`);
    // Run scaffold
    execSync(`bun run scripts/scaffold-project.ts ${OUTPUT}`, {
      cwd: join(import.meta.dir, ".."),
      timeout: 30000,
    });
  });

  // Auto-generate one test per expected file
  const expectedFiles = execSync(`find ${EXPECTED} -type f`)
    .toString().trim().split("\n").filter(Boolean);

  for (const expectedFile of expectedFiles) {
    const relativePath = expectedFile.replace(EXPECTED + "/", "");
    test(`${relativePath} matches expected`, () => {
      const outputFile = join(OUTPUT, relativePath);
      expect(existsSync(outputFile)).toBe(true);
      const expected = readFileSync(expectedFile, "utf-8");
      const actual = readFileSync(outputFile, "utf-8");
      expect(actual).toBe(expected);
    });
  }
});
```

### Maintaining the golden fixture

When the spec changes:
1. Update the expected output files to match the new spec
2. Run tests → they FAIL (because implementation hasn't changed)
3. Update implementation → tests pass
4. Spec-drift hash update confirms alignment

The expected output files ARE the spec materialized. They are not generated — they are hand-written to match the spec exactly. This is intentional: generated expected output would be a tautological test.

## Content Assertion Patterns

Beyond the golden fixture, each SC gets a targeted content assertion. These are the patterns:

### File content assertions

```typescript
// SC-115: Coding principles doc contains required sections
test("SC-115: coding principles has all required sections", () => {
  const content = readFileSync("prompts/coding-principles.md", "utf-8");
  const required = [
    "DEEP MODULES", "BOUNDARY VALIDATION", "EXHAUSTIVE MATCHING",
    "IMMUTABILITY", "BRANDED TYPES", "ERROR HANDLING", "ONE EXPORT"
  ];
  for (const section of required) {
    expect(content.toUpperCase()).toContain(section);
  }
  // Must have at least one code example
  expect(content).toMatch(/```typescript/);
});
```

### Brief structure assertions

```typescript
// SC-145: Brief section ordering
test("SC-145: marcus brief sections in correct order", () => {
  const brief = readFileSync(".claude/agents/marcus.md", "utf-8");
  const headings = [...brief.matchAll(/^## .+/gm)].map(m => m[0]);

  // Identity before principles
  const identity = headings.findIndex(h => /role|identity/i.test(h));
  const principles = headings.findIndex(h => /principles/i.test(h));
  const methodology = headings.findIndex(h => /methodology|coding|testing/i.test(h));

  expect(identity).toBeLessThan(principles);
  expect(principles).toBeLessThan(methodology);
});
```

### Three-tier rule authority assertions

```typescript
// SC-146: Brief has Always Do / Ask First / Never Do
test("SC-146: brief has three-tier rule authority", () => {
  const brief = readFileSync(".claude/agents/marcus.md", "utf-8");
  expect(brief).toContain("## Always Do");
  expect(brief).toContain("## Ask First");
  expect(brief).toContain("## Never Do");
});
```

### Gate enforcement assertions (contract tests)

```typescript
// SC-50: Evidence hierarchy enforced per AC type
test("SC-50: CODE AC with tier D only = FAIL", () => {
  const state = makeFixture({
    acs: [{
      id: "AC-1", type: "CODE",
      evidence: { type: "command-output", content: "grep result" },
      evidenceMethod: { type: "grep" },
      verdict: "PASS"
    }],
  });
  const result = runGate("ship", state);
  expect(result.fail).toBeGreaterThan(0);
  expect(result.output).toContain("evidence-tier");
});
```

### Rule count assertions

```typescript
// SC-138: Layer 1 template caps at 10 rules
test("SC-138: coding principles has ≤10 essential rules", () => {
  const content = readFileSync("prompts/coding-principles.md", "utf-8");
  const rules = content.match(/^[-*] \*\*.+\*\*/gm) || [];
  expect(rules.length).toBeLessThanOrEqual(10);
});

// SC-139: AGENTS.md rules under 200 words
test("SC-139: AGENTS.md rules content under 200 words", () => {
  const content = readFileSync("AGENTS.md", "utf-8");
  // Strip tables, headers, code blocks — count only prose rules
  const proseOnly = content
    .replace(/\|.*\|/g, "")
    .replace(/^#+ .+/gm, "")
    .replace(/```[\s\S]*?```/g, "");
  const wordCount = proseOnly.trim().split(/\s+/).length;
  expect(wordCount).toBeLessThanOrEqual(200);
});
```

### Activation mode assertions

```typescript
// SC-143: Every Layer 1 template declares activation mode
test("SC-143: all templates have activation mode", () => {
  const templates = readdirSync("prompts/").filter(f => f.endsWith(".md"));
  for (const tmpl of templates) {
    const content = readFileSync(`prompts/${tmpl}`, "utf-8");
    expect(content).toMatch(/activation:\s*(always-on|file-pattern|agent-decided|manual)/);
  }
});
```

## Phased Implementation

### Phase 0: Scaffold — all output files with correct content
**SCs:** 1-6, 8, 11, 15-21, 24-25, 37, 39-40, 73-78, 80, 82-90, 93-95, 97-101, 107, 114-126, 128, 138-148, 159-160
**Test:** Golden fixture — scaffold runs, EVERY output file checked for correct content against spec
**Gate:** `bun test test/phase-0.test.ts` — 0 failures
**Deliverable:** Scaffold creates all directories and files. Every file has the content the spec says it should have. No "file exists but content is wrong" — content is verified for all 13+ output files.

Output files verified:
- .gitignore (SC-40): all security entries
- package.json (SC-73): required fields added
- tsconfig.json (SC-74): recommended fields checked
- CLAUDE.md (SC-19): @AGENTS.md bridge
- AGENTS.md (SC-17, 18, 25, 94, 95, 128, 139): <150 lines, required sections, empty omitted, rules under 200 words
- CODE-MAP.md (SC-1, 39, 125, 126): git SHA frontmatter, correct sections, scan-paths
- .claude/rungate.json (SC-2, 4-6, 15-16, 21, 101, 107, 124): all fields detected or null, ports from Makefile, envVars from .env.example
- .claude/agents/marcus.md (SC-37, 115, 117, 138, 140-142, 145, 146): Core Principles, methodology refs, three-tier authority, section ordering, examples
- .claude/agents/quinn.md (SC-37, 55, 146): Core Principles, journey format ref, three-tier authority
- .claude/agents/rook.md (SC-37, 146): Core Principles, three-tier authority
- .claude/agents/serena.md (SC-37, 146): Core Principles, three-tier authority
- .claude/agents/aditi.md (SC-37, 146): Core Principles, three-tier authority
- .github/copilot-instructions.md (SC-123): points to AGENTS.md, create-if-missing
- .github/workflows/ci.yml (SC-82, 86, 87): managed header, bun test + typecheck
- .github/workflows/gates.yml (SC-83, 85): conformity + secret scan
- test/scaffold-conformity.test.ts (SC-24): imports all 9 suites
- specs/SPEC-TEMPLATE.md (SC-77): all frontmatter fields

### Phase 1: Knowledge extraction + doc hygiene + findings pipeline
**SCs:** 12-14, 22-23, 30, 75-76, 106, 137, 149-160
**Test:** Fixture with known bad docs → detection runs → findings written to unified JSON → gate runner reads + surfaces → agents get fix commands
**Gate:** `bun test test/phase-1.test.ts` — 0 failures
**Deliverable:**
- extract-constraints finds signal phrases from docs, pipes candidates to unified findings JSON
- Doc hygiene detects misplaced files (HYGIENE-7/8/9), bad frontmatter (HYGIENE-10), staleness
- All findings written to `.rungate/conformity-findings.json` with fix commands
- Gate runner reads findings JSON, prints structured output, stores in workflow-state.json
- AGENTS.md Commands table references findings JSON
- AGENTS.md Quick Reference #6 tells agents where to find fix commands
- Nothing is lost to stdout — all detection results persist in one machine-readable file

### Phase 2: Gate enforcement
**SCs:** 28-34, 48-72, 103-104, 109, 127, 129-135
**Depends on:** Phase 0
**Test:** Contract tests — workflow-state fixtures with known pass/fail conditions
**Gate:** `bun test test/phase-2.test.ts` — 0 failures
**Deliverable:** All gate checks enforce spec mechanically. Evidence hierarchy, RCA, blast radius, read-before-write, writer/verifier separation, test deletion prevention.

### Phase 3: Parallel work + CI
**SCs:** 45-47, 69-72, 110, 136
**Depends on:** Phase 2
**Test:** Worktree isolation, port allocation
**Gate:** `bun test test/phase-3.test.ts` — 0 failures
**Deliverable:** Parallel work isolation, container locking

### Phase 4: Dogfood — ship the harness using the harness
**SCs:** (meta-validation — no new SCs)
**Depends on:** Phase 0 (brief assembly works)
**Test:** Use the harness to create issues, ship implementations, run gates. If the harness ships itself correctly, briefs are proven correct.
**Gate:** Harness gates pass on harness code
**Deliverable:** Harness is self-hosting

## Post-Phase Spec Compliance Audit

After each phase completes, a compliance audit runs that produces a human-readable report. This is NOT a pass/fail test — it's a structured comparison of every spec claim against actual output. The report shows gaps that tests might miss and content that "passes" structurally but is incomplete semantically.

### Audit script

`bunx rungate audit-compliance <project-root> --phase N`

The script reads the parent spec (BOOTSTRAP-DATA-FLOW-SPEC.md) and the test plan, then produces a report:

```
╔══════════════════════════════════════════════════════════╗
║  SPEC COMPLIANCE AUDIT — Phase 0                        ║
╚══════════════════════════════════════════════════════════╝

SPEC: BOOTSTRAP-DATA-FLOW-SPEC.md (2,400+ lines, 149 SCs)
PROJECT: /path/to/project
PHASE: 0 (Pre-flight + static files)
DATE: 2026-09-18

── FILES ──────────────────────────────────────────────────

  File                              Spec says           Actual          Status
  ─────────────────────────────────────────────────────────────────────
  .gitignore                        Created Phase 0.11  exists, 24 ln   ✓ PASS
  package.json                      Phase 0.18          exists          ✓ PASS
  tsconfig.json                     Phase 0.19          exists          ✓ PASS
  specs/SPEC-TEMPLATE.md            Phase 0.12          exists          ✓ PASS
  test/scaffold-conformity.test.ts  Phase 0.13          MISSING         ✗ FAIL
  ...

── CONTENT CHECKS ─────────────────────────────────────────

  SC-40: .gitignore has security template
    Expected entries: node_modules, dist, .env*, .rungate, *.pem, *.key,
                      credentials.json, service-account*
    Found: node_modules ✓, dist ✓, .env* ✓, .rungate ✓, *.pem ✓,
           *.key ✓, credentials.json ✓, service-account* ✓
    Status: ✓ PASS (8/8 entries present)

  SC-73: package.json required fields
    name:              "golden-project"     ✓
    type:              "module"             ✓
    scripts.test:      MISSING              ✗ FAIL
    devDependencies:   rungate NOT found    ✗ FAIL
    Status: ✗ FAIL (2/4 fields present)

  SC-74: tsconfig.json recommended fields
    strict:            true                 ✓
    module:            "ESNext"             ✓
    Status: ✓ PASS (advisory — WARN only)

── BRIEF CONTENT (Phase 2 — preview only) ─────────────────

  File                      Exists  Sections  Principles  Examples  Order  Authority
  ──────────────────────────────────────────────────────────────────────────────────
  .claude/agents/marcus.md  N/A     —         —           —         —      —
  .claude/agents/quinn.md   N/A     —         —           —         —      —
  (Phase 2 not yet implemented — shown for completeness)

── SUMMARY ────────────────────────────────────────────────

  Files:    12 expected, 10 created, 2 missing
  Content:  8 SCs checked, 6 PASS, 2 FAIL
  Phase 0:  NOT COMPLETE — 2 failures must be resolved

  Missing:
    - test/scaffold-conformity.test.ts (SC-24)
    - package.json scripts.test field (SC-73)
```

### What the audit checks per file

For each file the spec says should exist:

| Check | What | How |
|-------|------|-----|
| Existence | File was created | `existsSync()` |
| Line count | Within spec limits (e.g., AGENTS.md ≤150) | `wc -l` |
| Required content | Spec-mandated entries/sections present | Keyword/pattern search |
| Content ordering | Sections in correct order (SC-140, SC-145) | Heading index comparison |
| Word count | Within budget (SC-139: rules ≤200 words) | Word count on prose |
| Rule count | Within caps (SC-138: ≤10 per template) | Pattern count |
| Examples present | Code examples exist (SC-142) | ` ```typescript` count |
| Authority tiers | Always Do / Ask First / Never Do (SC-146) | Section heading search |
| Frontmatter | Required fields present (SC-75, SC-76) | YAML parse |
| Cross-references | Pointers resolve to real files | `existsSync()` on referenced paths |

### Audit runs automatically after each phase gate

The phase test files include the audit as the LAST test:

```typescript
// At end of phase-0.test.ts
test("post-phase audit: compliance report", () => {
  const report = runComplianceAudit(OUTPUT, 0);
  console.log(report.formatted);  // Human-readable output
  
  // Store for cross-phase comparison
  writeFileSync(
    join(OUTPUT, ".rungate/audit-phase-0.json"),
    JSON.stringify(report.structured, null, 2)
  );
  
  // Phase is complete only if all checks pass
  expect(report.failures).toEqual([]);
});
```

### Cross-phase comparison

After Phase 1, the audit compares against Phase 0's report:

```
── PROGRESS SINCE PHASE 0 ─────────────────────────────────

  New files:     CODE-MAP.md, .claude/rungate.json
  Updated files: package.json (devDependencies added)
  SCs resolved:  SC-73 (was FAIL, now PASS)
  SCs remaining: 127 of 149
  Coverage:      15% → 22%
```

This gives a running view of implementation progress against the full spec — not just "did this phase pass" but "how much of the total spec is now fulfilled."

## Test File Organization

```
test/
├── fixtures/
│   └── golden-project/           # Synthetic project with known structure
├── expected/                     # Expected scaffold output (hand-written)
├── phase-0.test.ts               # Pre-flight + static file tests
├── phase-1.test.ts               # CODE-MAP + rungate.json tests
├── phase-2.test.ts               # AGENTS.md + brief assembly tests
├── phase-3.test.ts               # Knowledge extraction + doc hygiene tests
├── phase-4.test.ts               # Gate enforcement contract tests
├── phase-5.test.ts               # Parallel work + CI tests
├── golden-fixture.test.ts        # Full golden fixture diff test
├── contract.test.ts              # (existing) LIGHT/STANDARD tier contract tests
└── contract-negative.test.ts     # (existing) Negative case contract tests
```

## SC Coverage Matrix

Every SC must appear in exactly one phase test file. The coverage matrix prevents orphaned SCs:

| Phase | Test file | SC range | Count |
|-------|-----------|----------|-------|
| 0 | phase-0.test.ts | 40, 73-78, 80, 93, 97-100 | 12 |
| 1 | phase-1.test.ts | 1, 2, 15-16, 21, 39, 101, 107, 124-126 | 10 |
| 2 | phase-2.test.ts | 3-6, 8, 11, 17-19, 25, 37, 61-62, 88-90, 94-95, 114-122, 128, 138-146 | 37 |
| 3 | phase-3.test.ts | 12-14, 22-23, 30, 75-76, 106, 137 | 9 |
| 4 | phase-4.test.ts | 28-34, 48-72, 103-104, 109, 127, 129-135 | 39 |
| 5 | phase-5.test.ts | 45-47, 69-72, 82-87, 110, 136 | 13 |
| Anti | (spread across phases) | SC-A1, SC-A2, SC-A3 | 3 |
| Existing | contract*.test.ts | (subset overlap — existing gate tests) | — |
| Cross-cut | golden-fixture.test.ts | All output-producing SCs | — |
| **Total** | | | **123 + 3 anti + 23 gate/overlap** |

**Unaccounted SC check:** At test time, a meta-test reads all SC lines from the parent spec, reads all test files, and asserts every SC ID appears in at least one `test("SC-N:` string. Missing SC = FAIL.

```typescript
test("meta: every SC has a test", () => {
  const spec = readFileSync("specs/BOOTSTRAP-DATA-FLOW-SPEC.md", "utf-8");
  const scIds = [...spec.matchAll(/SC-(\d+|A\d+)/g)].map(m => m[1]);
  const unique = [...new Set(scIds)];

  const testFiles = globSync("test/phase-*.test.ts");
  const testContent = testFiles.map(f => readFileSync(f, "utf-8")).join("\n");

  const missing = unique.filter(id => !testContent.includes(`SC-${id}`));
  expect(missing).toEqual([]);
});
```

## Success Criteria

- [ ] TP-1: Golden test fixture exists at test/fixtures/golden-project/ with all required files
- [ ] TP-2: Expected output files exist at test/expected/ — hand-written, not generated
- [x] TP-3: Every SC (146 + 3 anti) appears in at least one phase test file — meta-test verifies
- [ ] TP-4: Phase tests are independently runnable — `bun test test/phase-N.test.ts`
- [ ] TP-5: All tests RED before implementation — `bun test` shows 149 failures
- [ ] TP-6: Phase gate enforced — phase N+1 tests import phase N's pass count and skip if phase N hasn't passed
- [ ] TP-7: Golden fixture diff test runs on every `bun test` — catches drift in any output file
- [ ] TP-8: Content assertions test CONTENT not existence — no `existsSync()` without a corresponding content check
- [x] TP-9: Meta-test validates SC coverage — missing SC in test files = FAIL
- [ ] TP-10: This test plan spec has spec-drift hash tracked — changes to BOOTSTRAP-DATA-FLOW-SPEC.md trigger re-evaluation
- [ ] TP-11: Post-phase compliance audit runs after each phase gate — produces human-readable report comparing every file and its contents against the spec
- [ ] TP-12: Compliance audit checks 10 dimensions per file: existence, line count, required content, ordering, word count, rule count, examples, authority tiers, frontmatter, cross-references
- [ ] TP-13: Cross-phase comparison shows progress delta — new files, updated files, SCs resolved since prior phase, total coverage %
- [ ] TP-14: `bunx rungate audit-compliance <root> --phase N` runnable standalone outside of test suite for manual verification

## SC-to-Phase Routing

Routing is automatic — the meta-test reads `### Phase N` subheaders from the Success Criteria section in `BOOTSTRAP-DATA-FLOW-SPEC.md`.

To add a new SC: paste it under the correct `### Phase` header. No routing table to maintain. The meta-test parses the section headers and routes each SC to the corresponding `test/phase-N.test.ts` file.

| Phase Header | Test File | What It Covers |
|---|---|---|
| `### Phase 0 — Scaffold Output` | `test/phase-0.test.ts` | Files, directories, content created by scaffold |
| `### Phase 1 — Knowledge Extraction + Doc Hygiene` | `test/phase-1.test.ts` | Constraint extraction, doc hygiene, findings pipeline |
| `### Phase 2 — Gate Enforcement + Ship Behavior` | `test/phase-2.test.ts` | Gates, evidence, ACs, briefs, ship-cycle behavior |
| `### Phase 3 — Parallel Work` | `test/phase-3.test.ts` | Worktrees, port allocation, concurrent agents |
| `### Anti-Criteria` | `test/anti.test.ts` | Must-NOT-happen conditions |

If an SC is not under any `### Phase` header, the meta-test reports it as "UNROUTED" — move it under the correct header to fix.

## Cautions

- Golden fixture expected output must be HAND-WRITTEN to match the spec. Auto-generating expected output from the implementation is a tautological test — it tests "does the code produce what the code produces" not "does the code produce what the spec says."
- Phase test files should not share test infrastructure beyond fixture creation utilities. Each phase must be independently debuggable.
- The SC coverage matrix will drift as SCs are added to the parent spec. The meta-test catches this mechanically — no behavioral reliance.
- Content assertions are FRAGILE if they match exact strings. Use patterns where possible (`toContain`, `toMatch`) rather than exact equality. Reserve exact equality for the golden fixture.
- Phase gate enforcement adds test ordering dependency. If Phase 1 is broken, Phase 2 tests should SKIP (not FAIL) to avoid masking the root cause with downstream failures.
- Dogfood phase (Phase 4) requires the harness to be functional enough to create issues and run gates. If Phase 2 gates are broken, dogfooding produces false confidence. Phase 4 only starts after Phase 2 passes.
