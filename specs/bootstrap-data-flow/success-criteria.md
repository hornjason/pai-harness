---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: Success Criteria + 3 more
testable: true
---

## Success Criteria

<!-- Phase subheaders route SCs to test files automatically. -->
<!-- The meta-test (test/meta-sc-coverage.test.ts) reads these headers. -->
<!-- To add a new SC: paste it under the correct ### Phase header. -->

### Phase 0 — Scaffold Output

- [ ] SC-1: Bootstrap Phase 1 (CODE-MAP + rungate) completes before Phase 2 (AGENTS.md + agents/)
- [x] SC-2: rungate.json consumers field populated from CODE-MAP consumer scan, not hardcoded patterns
- [x] SC-3: AGENTS.md environment section reads from rungate.json (not hardcoded)
- [x] SC-4: Zero hardcoded ports/URLs in ship.js — all from rungate.json fields
- [x] SC-5: Zero hardcoded commands in ship.js — all from rungate.json fields
- [x] SC-6: Zero hardcoded project names in ship.js — all from args or rungate.json
- [x] SC-8: All ship.js inline prompts >5 lines extracted to prompts/*.md templates
- [x] SC-11: Re-running scaffold always regenerates AGENTS.md from scratch — no audit-only path, no preserved sections. User rules belong in CLAUDE.md
- [x] SC-15: rungate.json generation falls back from Makefile → package.json → null for each field
- [x] SC-16: Null config fields cause workflow steps to SKIP (not error, not spawn rogue agents)
- [x] SC-17: AGENTS.md is under [150] lines — scaffold WARNS if over
- [ ] SC-18: Empty sections omitted from AGENTS.md (no consumers = no Consumers section)
- [x] SC-19: CLAUDE.md contains [@AGENTS.md] bridge for cross-tool compatibility
- [x] SC-20: src/index.ts exists (new code projects get stub as agent starting point)
- [x] SC-21: rungate.json has no hardcoded port numbers — all detected from Makefile/config or null
- [x] SC-24: Conformity test calls all 9 suites (scaffold, spec-discovery, spec-drift, doc-hygiene, agent-validation, fallow, constraint-candidates, package-validation, tsconfig-validation)
- [x] SC-25: AGENTS.md Commands section includes all harness commands (bun test, tsc, conformity, sync-tests, create-spec, create-adr, extract-constraints, re-scaffold)
- [x] SC-26: Spec template in project matches harness version — scaffold updates on re-run
- [x] SC-27: sync-spec-tests reads project's specs/ directory (not just harness specs)
- [x] SC-37: Every agent brief includes Core Principles block (verify-before-asserting, no gaps, read AGENTS.md)
- [x] SC-39: CODE-MAP.md staleness detected by git SHA comparison — regenerated when src/ has commits since last scan, not by arbitrary time/count thresholds
- [x] SC-40: Scaffold creates/verifies .gitignore with full security template (node_modules, dist, .env*, .rungate, *.pem, *.key, credentials.json, service-account*)
- [x] SC-73: package.json has required fields (name, type:module, scripts.test, devDependencies.rungate) — scaffold adds missing, never overwrites existing
- [x] SC-74: tsconfig.json has recommended fields (strict:true) — scaffold WARNs if missing, never overwrites
- [x] SC-75: Spec frontmatter has required fields (doc-type, status, testable, governs) — Spec Discovery FAILs if missing
- [x] SC-76: ADR frontmatter has required fields (doc-type:adr, status, created) — Doc Hygiene FAILs if missing
- [x] SC-77: `bunx rungate create-spec` creates spec with all required frontmatter fields pre-populated
- [x] SC-78: `bunx rungate create-adr` creates ADR with all required frontmatter fields pre-populated
- [x] SC-80: Phase 0 creates all 10 directories + all static files BEFORE any scan runs (Phase 1)
- [x] SC-82: .github/workflows/ci.yml exists (harness-owned, always regenerated from template + rungate.json)
- [x] SC-83: .github/workflows/gates.yml exists (harness-owned, always regenerated from template + rungate.json)
- [x] SC-84: CI workflow runs all conformity suites that `bun test` runs (same checks, CI-enforced)
- [x] SC-85: Gates workflow includes secret scan (HYGIENE-12) as CI check on every PR
- [x] SC-86: CI workflows read runner, bunVersion, branches from rungate.json ci section — defaults used when null
- [x] SC-87: CI workflow files include "Managed by rungate" header directing users to rungate.json for customization
- [x] SC-88: All 9 ship workflow prompt templates exist in harness prompts/ (discovery, marcus, quinn, rook, serena, aditi, environment, container-rebuild, container-verify)
- [x] SC-89: All 11 Layer 1 methodology templates exist in harness prompts/ (rca, blast-radius, prevention, regression, read-before-write, quinn-decision-tree, evidence-hierarchy, ac-format, coding-principles, testing-strategy, escalation-decision-tree)
- [x] SC-90: Brief-assembler embeds relevant Layer 1 methodology templates into per-agent briefs at ship time
- [x] SC-91: .git/hooks/pre-commit exists (scaffold creates with secret scan HYGIENE-12, in-repo not global)
- [x] SC-92: .git/hooks/pre-push exists (scaffold creates with conformity test, in-repo not global)
- [x] SC-93: All project hooks, scripts, and workflows are self-contained in repo — no global dependencies
- [x] SC-94: AGENTS.md has section [Where to Create Things] listing correct location for every file type agents create
- [x] SC-95: AGENTS.md has section [Available MCP Servers] listing MCP servers configured for the project with tool names
- [x] SC-97: Pre-flight checks git repo (git init if not), package.json (bun init if not), .gitignore (create if not)
- [x] SC-98: Pre-flight runs BEFORE Phase 0 — .gitignore exists before any git add
- [x] SC-99: Post-scaffold commits all harness files — "scaffold: initialize" for new, "scaffold: update" for existing
- [x] SC-100: Post-scaffold commit only runs if there are actual changes (no empty commits)
- [x] SC-101: rungate.json uses field-level merge — auto-detected fields overwritten, manual fields preserved
- [x] SC-107: Makefile fallback chain: each field tries Makefile → package.json → null in order
- [x] SC-114: AGENTS.md has section [Research Tools] listing available tools with usage examples
- [x] SC-115: Coding principles reference doc (deep modules, boundary validation, etc.) ships with harness and is referenced in Marcus briefs
- [x] SC-116: Coding principles doc auto-updated via Context7 or research on harness update — not static training data
- [x] SC-117: Testing strategy reference doc (PBT, contract tests, tautological trap) ships with harness and is referenced in Marcus briefs
- [x] SC-118: Writer/verifier separation enforced — gate checks that test author agent != code author agent (SC-66 mechanical)
- [x] SC-119: Test assertions reference AC thresholds, not implementation details — gate WARNs on test files with zero AC-ID references
- [x] SC-120: Context loading follows 5-layer architecture — CLAUDE.md → AGENTS.md → skills (on demand) → agent frontmatter → brief
- [x] SC-121: Agent frontmatter `skills` field preloads role-specific methodology — Marcus gets coding-principles + testing-strategy, Quinn gets journey-format
- [x] SC-122: AGENTS.md contains ONLY non-inferrable details — no info agents could discover by reading src/ or running commands
- [x] SC-123: .github/copilot-instructions.md exists (created if missing, never overwritten — scaffold skips on existing)
- [x] SC-124: rungate.json envVars field populated from .env.example if it exists — null if no .env.example
- [x] SC-125: CODE-MAP.md frontmatter includes scan-paths array listing directories scanned
- [x] SC-126: AGENTS.md has section [Code Style] auto-detected from runtime (Bun/Node), language (TS/JS), module system (ESM/CJS)
- [x] SC-128: AGENTS.md has section [Harness-Managed Files] with file/customize/don't table
- [x] SC-138: Agent briefs cap at 10 essential rules per Layer 1 template — instruction stacking beyond 16 degrades compliance 50%+
- [x] SC-139: AGENTS.md Rules section at most [200] words (excluding tables/headers) — always-on context must be lean
- [x] SC-140: Brief structure: Core Principles at START, ACs at END — methodology in middle (mitigates "Lost in the Middle" attention decay)
- [x] SC-141: Templates use positive framing ("use X" not "don't use Y") — negative instructions capped at 10 per brief
- [x] SC-142: Every Layer 1 template includes at least one code example per principle — examples outperform descriptions
- [x] SC-143: Each template declares activation mode: always-on, file-pattern, agent-decided, or manual
- [x] SC-144: Rule lifecycle: every rule in AGENTS.md has a `since` date in comment — rules older than 90 days without revalidation flagged at re-scaffold
- [x] SC-145: Brief-assembler orders sections: identity (role) → principles → methodology → ACs → verification commands — never methodology after ACs
- [x] SC-146: Every agent brief categorizes rules into three tiers: Always Do (autonomous), Ask First (needs approval), Never Do (hard stops) — gate validates "Never Do" items mechanically
- [x] SC-147: rungate.json includes `harnessVersion` (semver from harness package.json) and `scaffoldedAt` (ISO timestamp) — projects know what version they were scaffolded with
- [x] SC-148: Conformity test WARNs when installed harness version differs from `harnessVersion` in rungate.json — signals re-scaffold needed
- [x] SC-159: AGENTS.md has section [Commands] with `Check findings | cat .rungate/conformity-findings.json` row
- [x] SC-160: AGENTS.md Quick Reference includes "After test failures, read `.rungate/conformity-findings.json` for structured findings with fix commands"
- [ ] SC-251: AGENTS.md Documentation Routing auto-detects docs/ subdirectories and lists them with file counts
- [ ] SC-252: AGENTS.md Where to Create Things lists all doc types (Specs, ADRs, Research, Council, Guides) with required frontmatter fields
- [ ] SC-253: Re-scaffold on RunGate itself produces 0 warnings and correct AGENTS.md without hand editing
- [ ] SC-254: Cross-tool user rules via tool-agnostic PROJECT-RULES.md referenced from AGENTS.md (future enhancement — CLAUDE.md for now)

### Phase 1 — Knowledge Extraction + Doc Hygiene

- [x] SC-12: Bootstrap scans docs for non-inferrable rule candidates using signal phrases
- [x] SC-13: Extracted candidates presented for user confirmation before writing to AGENTS.md
- [x] SC-14: Staleness uses git log date with per-type thresholds (ADR exempt, spec 90d, guide 180d)
- [x] SC-22: Re-scaffold reports stale constraints (Hard Constraints referencing deleted files)
- [x] SC-23: Re-scaffold reports line count if AGENTS.md exceeds 150 lines
- [x] SC-30: Misplaced spec/ADR/doc files are FAIL not WARN (HYGIENE-7/8/9)
- [x] SC-106: Doc lifecycle: stale docs (beyond threshold) flagged for archive to reference/ — per-type thresholds applied
- [x] SC-137: Rejected constraint candidates logged to reference/rejected-constraints.md with content-hash dedup — same candidate never resurfaces
- [x] SC-149: Conformity findings written to `.rungate/conformity-findings.json` with structured format (ruleId, severity, file, message, fixCommand)
- [x] SC-150: Every FAIL finding includes a `fixCommand` — agents can execute it directly to resolve the issue
- [x] SC-154: Unified findings report includes `constraintCandidates` array with rule, source, hash, and status (pending/applied/rejected)
- [x] SC-155: Unified findings report includes `staleness` array with file, daysSince, threshold, and type
- [x] SC-156: HYGIENE-6 pipes extract-constraints results (candidates + staleness) into unified findings report — nothing lost to stdout
- [x] SC-157: Gate runner reads `.rungate/conformity-findings.json` after `bun test` completes and prints structured output (findings with fix commands, candidates, stale docs)
- [x] SC-158: Gate runner stores conformityFindings in workflow-state.json — agents read fix commands from workflow-state, not test output
- [x] SC-151: HYGIENE-7 detects spec files at root (not in specs/) and produces FAIL with `mv` fix command
- [x] SC-152: HYGIENE-8 detects ADR files outside docs/adr/ and produces FAIL with `mv` fix command
- [x] SC-153: HYGIENE-9 detects doc files at root (not in docs/, not allowlisted) and produces FAIL with `mv` fix command

### Phase 1.5 — Context Quality

- [ ] SC-161: Scaffold assembles agent briefs from prompts/*.md content files — no instruction text hardcoded in scaffold-project.ts
- [ ] SC-162: Every prompts/*.md file referenced by a brief template exists and contains ≥10 lines of content
- [ ] SC-163: Modifying a prompts/*.md file changes scaffold output on next run without editing scaffold source code

- [ ] SC-164: Agent brief Environment URLs match rungate.json dev section — extends SC-3 to brief-level validation with fixCommand "Re-run scaffold"
- [ ] SC-165: Quinn brief frontmatter includes tools: [Bash, Read, mcp__playwright__*]
- [ ] SC-166: Agent brief environment values match rungate.json dev section — mismatch produces FAIL with fixCommand "Re-run scaffold" (brief-level extension of SC-3/SC-4)
- [ ] SC-167: AGENTS.md Specs table governs and testable fields match actual spec frontmatter — cross-references AGENTS.md routing table against spec file metadata (distinct from SC-75 spec file validation)
- [x] SC-168: CODE-MAP.md exists for code projects and is under 3,000 tokens — over-budget produces WARN
- [x] SC-169: scaffold output .git/hooks/ files match mode 755 and contain scaffold-generated shebang line

- [ ] SC-170: Tier 1 files containing content not produced by scaffold trigger WARN OWNERSHIP-TIER1-EXTRA with fixCommand to relocate (extends SC-104 with extra-content detection)
- [ ] SC-173: Ownership tier assignment for every harness-touched file declared in lib/ownership-manifest.ts

- [ ] SC-174: Conformity wraps ctxlint tokens/* rule — instruction files exceeding thresholds produce WARN
- [ ] SC-175: Conformity wraps agentsmd claude-length-warn — CLAUDE.md beyond 200 lines produces WARN
- [ ] SC-176: Hard Constraints >20 rules produces WARN citing instruction stacking collapse
- [ ] SC-177: Budget findings include token count from ctxlint or ccinspect — RunGate does not implement own tokenizer

- [ ] SC-178: lib/conformity.ts contains [ctxlint, spawnSync]
- [ ] SC-179: lib/conformity.ts contains [agentsmd, spawnSync]
- [ ] SC-180: lib/conformity.ts contains [agnix, spawnSync]
- [ ] SC-181: Conformity runs RepoRails via Bun.spawnSync with REPORAILS-{ruleId} prefix
- [ ] SC-182: agentsmd score stored in findings JSON scores.agentsmd field
- [ ] SC-183: External tools optional — if not installed, WARN TOOL-NOT-INSTALLED-{name}
- [ ] SC-184: External tool findings include fixCommand from tool's fixHint/suggestion/fix field
- [ ] SC-230: Conformity runs ccinspect via Bun.spawnSync with CCINSPECT-{ruleId} prefix (56 rules: contradictions, scope/precedence, session analytics)

- [ ] SC-185: Agent instruction files contain no TODO/FIXME — wrap agentsmd todo-rot
- [ ] SC-186: No contradictory instructions across files — wrap ccinspect contradiction-keywords
- [ ] SC-187: No secrets/credentials in agent instruction files — wrap ctxlint content-secrets
- [x] SC-188: Conformity wraps ctxlint dead-hook — settings.json hook command paths resolve to present files
- [ ] SC-189: No machine-specific absolute paths in instruction files — wrap agentsmd/agnix
- [ ] SC-190: Total instruction count across always-loaded files under 150 (distinct from SC-17 line count and SC-139 word count — this counts discrete instructions)
- [ ] SC-191: Agent briefs reference AGENTS.md — never duplicate Hard Constraints inline
- [ ] SC-192: Conformity flags >70% token overlap between brief and AGENTS.md as SPRAWL-DUPLICATE
- [ ] SC-193: AGENTS.md workflow section references .rungate/conformity-findings.json
- [ ] SC-231: Generated content in scaffold output prefers positive framing — negative instructions ("never do X") without positive alternatives ("instead, do Y") produce WARN

- [ ] SC-194: Generated content passes inferability test — discoverable content produces WARN INFERABLE-CONTENT
- [ ] SC-195: Conformity cross-references instructions against CODE-MAP.md — nonexistent entities produce FAIL CODEBASE-GROUNDING

- [ ] SC-196: Scaffold runs external tool checks after generating briefs before writing final output
- [ ] SC-197: Post-generation quality check errors trigger regeneration — max 5 iterations
- [ ] SC-198: Composite quality threshold configurable in rungate.json — weights budget over coverage (agentsmd coverage excluded per SC-A6)
- [ ] SC-199: Final scores written to .rungate/scaffold-score.json
- [x] SC-200: Generate-score loop logs iteration findings count — monotonically decreasing proves convergence

- [x] SC-201: Hard Constraints contains only human-reviewed rules — auto-extracted go to review queue per SC-13 confirmation flow
- [ ] SC-202: New rules include provenance comment: source incident and date recurred
- [ ] SC-232: Constraint extraction enforces second-occurrence rule — rules promoted to Hard Constraints only after recurring in 2+ incidents (Anthropic best practice)

- [ ] SC-203: Postinstall checks .rungate-version stamp — re-scaffolds only when version changes
- [ ] SC-204: GitHub Actions workflow detects rungate version change and runs scaffold --refresh

- [ ] SC-233: Scaffold-generated content checked for contradiction against existing user-written content (Hard Constraints vs generated Environment, brief vs AGENTS.md routing) — distinct from sprawl-duplicate (SC-192)
- [ ] SC-234: External tool versions recorded in .rungate/tool-versions.json on each run — version mismatch from previous run produces INFO
- [ ] SC-255: Agent briefs reference prompts/*.md via pointer section, not inline injection — brief body under 120 lines excluding frontmatter
- [ ] SC-256: CODE-MAP.md includes function signatures and execution order for scripts/ files over 500 lines
- [ ] SC-257: docs/research/ files have doc-type: research frontmatter with governs field

### Phase 2 — Gate Enforcement + Ship Behavior

- [x] SC-7: Container-rebuild agent NOT spawned when prod.rebuild is null
- [x] SC-9: rungate-schema.ts includes test.rebuild, test.start, test.stop, test.apiBase fields
- [x] SC-10: Schema fields dev.typeCheck, prod.smokeTest, contextDocs read by at least one workflow
- [x] SC-28: Scope gate runs project conformity tests — FAIL blocks scope
- [x] SC-29: Verify gate runs project conformity tests — FAIL blocks verify
- [x] SC-31: Scope gate captures test baseline (pass/fail count + failing test names)
- [x] SC-32: Verify gate compares test count — fail increase = regression = FAIL
- [x] SC-33: Pre-existing test failures auto-filed as GitHub issues with "pre-existing" label
- [x] SC-34: Found issues during ship cycle either fixed, filed, or explicitly scoped out
- [x] SC-35: `bunx rungate create-spec` creates spec at specs/ with correct frontmatter
- [x] SC-36: `bunx rungate create-adr` creates ADR at docs/adr/ with auto-incremented number
- [x] SC-38: Ship cycle runs scaffold after verify gate PASS — auto-refresh CODE-MAP, briefs, AGENTS.md
- [x] SC-41: Conformity checks for secret patterns in staged/committed files (HYGIENE-12) — catches secrets on ALL tiers including LIGHT
- [x] SC-42: Completed slugs (DONE + proven) auto-archived after 24h
- [x] SC-43: Archived slugs deleted after 30 days
- [x] SC-44: Ship cycle checks for existing slug by issue number before creating new one
- [x] SC-48: ACs use Given/When/Then format with four required fields: trigger, output, verify command, exclusions
- [x] SC-49: Every AC has an executable verification command (oracle) — not prose description
- [x] SC-50: Evidence hierarchy enforced per AC — minimum tier: CODE→A, UI→B, BUG-FIX→S, static→C supplementary only
- [x] SC-51: Self-attestation (tier F) in any AC evidence = automatic FAIL regardless of other evidence
- [x] SC-52: Garbage test applied to every AC — "Could garbage data pass this?" If yes, AC is rejected
- [x] SC-53: RCA section required in Marcus brief for bug-fix issues — rootCause, prediction, predictionVerified
- [x] SC-54: Gate checks RCA fields populated on bug-fix issues — empty rootCause = WARN (graduates to FAIL after 30d)
- [x] SC-55: Quinn briefs use typed journey format — steps with action, wait_for, typed assertions, on_fail
- [x] SC-56: Quinn primary perception is browser_snapshot (a11y tree), screenshots only on FAIL or visual checks
- [x] SC-57: Quinn circuit breaker — 3 consecutive FAIL steps abort journey with partial results
- [x] SC-58: Proof-of-fix includes negative control (revert fix, confirm bug returns) for S-tier evidence
- [x] SC-59: Blast radius section in Marcus brief — filesRead ≥ filesChanged enforced
- [x] SC-60: Read-before-write ratio ≥ 3:1 — gate checks read vs write token count
- [x] SC-61: Brief-assembler generates per-role templates (Marcus, Quinn, Rook, Serena, Aditi) from three layers
- [x] SC-62: Templates are three-layered: harness-generic + project-config (rungate.json) + issue-specific (ACs)
- [x] SC-63: Spec content hash tracked — hash mismatch at gate = FAIL (tests must match current spec)
- [x] SC-64: Test count post ≥ pre at verify gate — decrease = FAIL "tests removed, verify no gaming"
- [x] SC-65: Prevention-oriented fixes: guard at boundary, type narrowing, pattern audit for same-bug-class
- [x] SC-66: Writer and verifier are separate agents — same agent cannot write code AND verify its own ACs
- [x] SC-67: Quinn journey steps auto-generated from UI-type ACs by brief-assembler
- [x] SC-68: Evidence without assertion = tier F — screenshot taken but nothing checked = self-attestation
- [x] SC-79: Conformity includes `runPackageValidation` check for package.json required fields
- [x] SC-81: Phase 0 file creation is additive — never overwrites existing content, only adds missing fields/entries
- [x] SC-96: rungate.json `mcp` section declares MCP servers available to agents — scaffold includes in agent briefs
- [x] SC-102: Re-scaffold auto-fixes broken refs, unlisted specs, missing CODE-MAP ref, and pages drift — not just reports them
- [x] SC-103: Evidence-to-tier mapping implemented in gate — evidenceMethod.type maps to correct tier per mapping table
- [x] SC-104: File ownership model enforced — Tier 1 (harness-owned) always regenerated, Tier 2 (co-owned/hybrid) preserves user sections across re-scaffold, Tier 3 (user-owned) validated for structure only — scaffold never writes to them
- [x] SC-105: Scaffold is idempotent — running from scratch produces same result as re-scaffold (Core Principle 6)
- [x] SC-108: Quinn journey stored in slug directory (~/.rungate/{slug}/quinn-journey.yaml) — ephemeral, follows slug lifecycle
- [x] SC-109: Fix-on-find: silently dropped issues = FAIL at verify gate, not WARN
- [x] SC-110: Port allocation for parallel worktrees checks for collisions before assigning offset
- [x] SC-111: Escalation decision tree embedded in every agent brief — agents know research tools exist
- [x] SC-112: Circuit breaker iteration 2 requires research tool invocation before next attempt — gate checks research evidence exists before allowing iteration 3
- [x] SC-113: rungate.json `research` section declares available research tools — brief-assembler includes only available tools
- [x] SC-127: All 3 gate prompt templates exist in harness prompts/ (ac-adversary.md, evidence-validator.md, prove-reproducer.md)
- [x] SC-129: Gate WARNs if a new module file has more exported functions than internal functions (shallow module signal)
- [x] SC-130: Gate WARNs if a module with >3 importers has no contract test
- [x] SC-131: Anti-criteria (SC-A*) use absence verification — Verify command must confirm absence, not presence
- [x] SC-132: Tier D evidence (grep) capped at 25% of total evidence portfolio per issue — gate FAIL if exceeded
- [x] SC-133: Brief-assembler rejects Quinn journeys over 8 steps and auto-splits into multiple journeys with entry conditions
- [x] SC-134: Files changed outside brief's listed files → WARN "Files changed outside brief: {list}"
- [x] SC-135: Gate cross-validates proofOfFix in workflow-state.json against prove-evidence.json — mismatch = FAIL

### Phase 3 — Parallel Work

- [x] SC-45: Container lock checked mechanically (Makefile target, not behavioral rule) — blocks rebuild/prove-up if lock exists
- [x] SC-46: Ship workflow supports worktree isolation for parallel execution
- [x] SC-47: Container lock released mechanically after test completion (cleanup triggers next queued issue)
- [x] SC-69: Parallel work: file-set overlap detection before assigning concurrent issues to agents
- [x] SC-70: Parallel work: port/namespace isolation beyond git worktree file isolation
- [x] SC-71: Parallel work: cap concurrent agents at 5 per session (diminishing returns beyond)
- [x] SC-72: Parallel work: sequential merge with CI verification between each PR
- [x] SC-136: Worktree branches use deterministic naming: issue-{N}-{slug}

### Phase 4 — Knowledge Mining

- [x] SC-205: rungate temporal-coupling command analyzes git co-change history → .rungate/temporal-couplings.json
- [x] SC-206: Temporal coupling JSON has fileA, fileB, coChanges, hasImportLink, auto-generated rule
- [x] SC-207: File pairs ≥10 co-changes with hasImportLink: false produce candidate rules routed to review queue (SC-201 flow) — not auto-inserted into briefs
- [x] SC-208: Scaffold reads temporal-couplings.json and includes only review-approved coupling rules (status=applied) in briefs

- [x] SC-209: rungate analyze-deps runs dependency-cruiser → .rungate/dependency-analysis.json
- [x] SC-210: Circular deps produce WARN — lists participating modules and hub module
- [x] SC-211: Orphan modules produce INFO with fixCommand
- [x] SC-212: Module boundary violations (data importing routes) produce WARN — graduates to FAIL after validation across projects

- [x] SC-213: rungate analyze-dead-code runs Knip → .rungate/dead-code.json filtered for entry points
- [x] SC-214: Knip entry points configurable in rungate.json analysis.entryPoints
- [x] SC-215: Unused backend files produce WARN DEAD-FILE
- [x] SC-216: Unresolved imports produce FAIL BROKEN-IMPORT (Knip-specific detection — distinct from fallow suite SC-24 which uses different heuristics)

- [x] SC-217: rungate analyze-hotspots computes hotspot score → .rungate/hotspots.json
- [x] SC-218: Top 5 hotspot files produce INFO — surfaced in briefs as "high-risk files"

- [x] SC-219: Tier 1 regex pre-filter uses signal-phrases.ts
- [x] SC-220: Tier 2 heuristic scorer assigns 0-5 using 5 checks (modal+action, actor subject, list item, imperative, code reference)
- [x] SC-221: Score ≥5 auto-promoted to high-confidence
- [x] SC-222: Score 3-4 sent to Tier 3 LLM classification
- [x] SC-223: Score ≤2 auto-filtered as noise
- [x] SC-224: Tier 3 LLM uses ≤200 tokens per candidate, total under $0.05
- [x] SC-225: Deduplicated cross-file — same rule appears once with all sources
- [x] SC-226: Top 20 candidates in findings JSON constraintCandidates array (extends SC-154), full list in .rungate/all-constraints.json

- [x] SC-227: Candidates have status field: pending/applied/rejected/deferred + reviewedAt
- [x] SC-228: Output adapts to AgentGrit inbox Pattern type when installed
- [x] SC-229: Candidates unreviewed >90 days auto-transition to deferred

### Phase 5 — Instruction Compliance

- [x] SC-236: `rungate test-navigability` spawns fresh agent with standard task, auditor scores transcript → .rungate/navigability-score.json (behavioral)
- [x] SC-237: navigability-score.json schema includes fileLoadRate, directHitRate, complianceRate, toolCallCount, canaryResults, timestamp
- [x] SC-238: Canary values planted in generated files are checked by auditor — score = canaries triggered correctly / total canaries
- [x] SC-239: `rungate rule-health` cross-references instruction quality (agnix/RepoRails scores) with behavioral compliance (auditor data) → .rungate/rule-health.json with KEEP/RETIRE/FAILING/STALE verdicts
- [x] SC-240: `lib/compliance.ts → runTemplateCompliance()` runs agnix + RepoRails on instruction files (prompts/*.md, AGENTS.md, .claude/agents/*.md, CLAUDE.md) via Bun.spawnSync — consumes their JSON output, does NOT reimplement scoring with regex
- [x] SC-241: `lib/compliance.ts → runGeneratedCompliance()` scores generated files after scaffold, compares against template baseline — scaffold cannot degrade instruction quality (score drop >0.05 = FAIL)
- [x] SC-242: `lib/compliance.ts → runBehavioralCompliance()` spawns fresh agent + auditor, checks each instruction followed or not, produces compliance-score.json with per-instruction rates (behavioral)
- [x] SC-243: Hill climb loop: FAIL instruction → apply 7 compliance factors to rewrite → re-score → max 5 iterations → escalate to mechanical (hook/gate) if still failing
- [x] SC-244: 7 compliance factors scored per instruction: specific (names file/command), strong-modal (must/always/never), positive (do Y not just don't X), observable (grep-able), positioned (top 20%), short-file (<120 lines), temporal-anchor (BEFORE/AFTER trigger)
- [x] SC-245: Compliance surface is exactly 4 file types: prompts/*.md, AGENTS.md, .claude/agents/*.md, CLAUDE.md — NOT hooks, workflows, CODE-MAP, .gitignore, tests
- [x] SC-246: Instructions that fail behavioral compliance after 5 hill-climb iterations escalate to mechanical enforcement (hook or gate) with ESCALATED-TO-MECHANICAL tag
- [x] SC-247: Compliance report written to .rungate/compliance-report.json with layer, surface, per-file scores, overall score, findings with factor/severity/suggestion
- [x] SC-248: Post-completion auditor spawns after every agent (Marcus, Quinn, Rook) — reads full transcript, classifies each action as FOUND-FROM-REPO / HAD-TO-DISCOVER / GOT-WRONG / MISSED, outputs to .rungate/navigability-score.json (behavioral)
- [x] SC-249: Agent briefs load only when spawned with matching `agentType` — ship/prove workflows must use `agentType: 'marcus'` not `'Engineer'`, matching `.claude/agents/{name}.md` filename
- [x] SC-250: Five-layer measurement model: (1) file loading — right files read, (2) content routing — pointers resolve, (3) prompt compliance — instructions followed, (4) context cost — tokens burned, (5) drift — trend across runs

### Anti-Criteria

- [ ] SC-A1: No workflow file imports or references values from a specific project (DDB, asaCommandCenter, etc.)
- [ ] SC-A2: No hardcoded file paths in rungate.json generation (no `dashboard/src/App.tsx`, no `callGemini` patterns)
- [ ] SC-A3: No references to "PAI" in lock files, work dirs, or runtime paths — all use "rungate" naming
- [ ] SC-A4: Generated briefs minimize inferable content — any included inferable content requires source justification (convenience, performance, context reduction)
- [ ] SC-A5: External tool findings never silently dropped — tool errors produce WARN, not silence
- [ ] SC-A6: Composite scoring never rewards inferable heading presence (agentsmd coverage excluded from threshold)

## Evaluated Concerns

Concerns raised during spec review, evaluated, and documented for future reference:

| Concern | Verdict | Reasoning |
|---------|---------|-----------|
| Framework changes (Hono→Express) | Not a gap | Re-scaffold + CODE-MAP detects whatever's in src/. Agent briefs regenerate with new structure |
| Monorepo support | Future work | Single-project repos are current target. Nested AGENTS.md per package is future scope |
| CI/CD setup | Handled | Harness creates ci.yml + gates.yml with quality gates. Custom CI (deploy, release) is project-specific |
| Branch protection / PR templates | Out of scope | Project-specific GitHub settings, not harness concern |
| Version migration (harness major bump) | Handled | `bun update rungate` — conformity tests catch breaking changes immediately |
| Collaborator onboarding | Handled | `bun install` gets devDep, `bun test` verifies conformity. No separate setup step |
| First git push | Fixed by SC-40 | .gitignore ensures clean first push |
| Dependency management (bun.lockb) | Handled | Standard bun behavior — lockb committed, node_modules gitignored |
| Mutation testing for test quality | Future work | AI tests: 91% coverage but 34% mutation score. Meta's approach raised to 89.5%. Valuable but heavyweight — test count comparison is minimum viable gate for now |
| LLM-as-judge for verification | Not adopted | 4 known bias modes (length, position, self-preference, non-determinism). Mechanical gates preferred over LLM judgment |
| Agent teams / swarm mode | Future work | Claude Code agent teams in research preview. Current harness uses single-agent-per-role. Parallel work via worktrees |
| Merge queue tooling (Graphite/Mergify) | Future work | Merge queue becomes bottleneck at scale. Current: sequential manual merge. Worth evaluating when parallel work is routine |
| Visual regression testing (Percy/Chromatic) | Future work | Pixel-diff tools exist but add infra complexity. A11y-first assertion covers functional; visual regression is supplementary |
| Context window management for long journeys | Handled by design | Quinn journeys capped at 5-8 steps. Instruction compliance decays from 73% at turn 5 to 33% by turn 16 (Gamage 2026) |

## Cautions

- Bootstrap Phase 1 depends on fallow being installed. If fallow fails, CODE-MAP.md should still generate from other scans (routes, components, dirs) — fallow sections empty, not entire file missing.
- rungate.json consumers field: auto-detection from CODE-MAP may miss consumers that are dynamically imported or configured at runtime. Manual override must be preserved on re-scan.
- Hard Constraints in AGENTS.md must survive regeneration — they're the one section that can't be auto-detected from code. **CRITICAL (council finding):** The preservation regex must handle Hard Constraints as the last section — the lookahead `(?=\n## |\s*$)` handles this (fixed).
- Prompt templates with ${VAR} placeholders: if a variable is undefined (field missing from config), the template should show a clear placeholder or instruction, not leave a raw ${VAR} string in the agent prompt.
- `rejected-constraints.md` must use content-hash dedup so rejections survive line-number changes across doc edits. Prevents the same false positive from resurfacing on every re-scan.
- No `--auto-accept` flag on extract-constraints. 70% false positive rate means human review is mandatory. `--dry-run` is the default.
- AGENTS.md over 150 lines: research shows 20-23% inference cost increase with no behavior improvement. LLM-generated context files decrease performance by 3% (ETH Zurich). Keep it concise, human-written, and focused on non-inferrable details.
- Scaffold partial failure: if scaffold fails halfway (e.g., CODE-MAP generated but rungate.json errors out), the project may have stale data. Recovery: re-run scaffold — it's idempotent, each file is independently valid. No rollback mechanism needed because each step overwrites cleanly.
- Secrets on LIGHT tier: LIGHT tier skips Rook (security scan). Without HYGIENE-12 (secret pattern check in conformity), an agent could commit an API key through LIGHT without any mechanical catch. HYGIENE-12 runs on ALL tiers via `bun test`, closing this gap.
- .gitignore on new projects: pre-flight creates .gitignore from full security template BEFORE `bun init` runs, ensuring secrets are excluded from the first commit. On existing projects, scaffold verifies required entries and appends missing ones.
- RCA WARN→FAIL graduation: SC-54 starts as WARN to avoid blocking existing workflows. After 30 days of data collection, evaluate false positive rate. If <10%, graduate to FAIL. If >10%, refine the check before graduating.
- Evidence hierarchy adoption: existing workflows have grep-heavy evidence. SC-50 enforcement should not retroactively break passing issues. Apply to NEW issues only — existing workflow-state.json files are grandfathered.
- Quinn a11y tree dependency: browser_snapshot() requires Playwright MCP server running. If MCP unavailable, Quinn falls back to screenshots with WARN. Never block QA on infra failure.
- Negative control cost: Step 5 (revert + re-test) adds ~30-60 seconds per prove cycle. Worth it for bug fixes (46% of validations are non-discriminating without it). Can skip for feature work where there's no "before" state.
- Typed journey generation: brief-assembler generates journeys from ACs with UI type. If AC threshold is too vague for typed assertion (e.g., "looks good"), the journey step gets `type: visual_check` which requires screenshot + human review — it doesn't silently skip.
- Three-layer merge conflicts: if project-config (Layer 2) and harness-generic (Layer 1) conflict, Layer 2 wins. Project knows its own constraints better than the generic template. Issue-specific (Layer 3) can override both — but gate still enforces minimums.
- Parallel work file-overlap detection (SC-69) is advisory at first. False positives (two issues legitimately touching shared utils) should not block. Start as WARN, graduate to FAIL after calibration.
- AI-generated code security: 44% of AI-generated tasks produce known security flaws (Veracode 2026). Rook scan on EVERY build cycle is not optional — it's the only mechanical catch for a 44% defect rate.
- Iterative refinement paradox: asking an agent to "improve" its own code 5+ times increases vulnerabilities 37.6% (IEEE-ISTAS 2025). The harness's circuit breaker (3 iterations max, research required at iteration 2) exists partly for this reason.
- Read-before-write enforcement: the 3:1 ratio (SC-60) is measured from workflow-state.json token counts, not file counts. Agents that read 1 file and change 3 are likely patching symptoms. The ratio is a heuristic — some surgical fixes legitimately have low ratios.
- Rule count caps (SC-138): the 25-rule ceiling is a design target, not a gate FAIL. The data shows compliance degrades at 16+, but the gate-first architecture compensates — the rules most likely to be forgotten are methodology steps, which gates enforce mechanically anyway.
- Brief assembly order (SC-140, SC-145): the U-shaped attention curve is real but varies by model and context length. The ordering is a best-effort optimization, not a guarantee. The primary defense remains mechanical gates, not attention management.
- Always-on 200-word budget (SC-139): measured as prose content in AGENTS.md, excluding table formatting, headers, and code blocks. Tables are information-dense and parse differently than prose rules.
- Activation mode declarations (SC-143): activation modes are metadata for the brief-assembler, not runtime config. The brief-assembler decides what to include based on mode + current context. A template with `mode: agent-decided` is included only when the brief-assembler judges it relevant to the issue type.
- Rule lifecycle 90-day flag (SC-144): the WARN is advisory, not blocking. Some rules are permanent (security constraints, architectural invariants). The flag is a prompt for human review, not an expiration.
- 15 tool-call compliance cliff: this is why the harness uses gates (post-hoc verification) rather than relying on agents to self-enforce rules during long sessions. The cliff validates the architectural decision, not a gap to fix.

## Research Sources

Research informing design decisions D-12 through D-23 and SCs 48-145:

| Topic | Key finding | Source |
|-------|------------|--------|
| AC format effectiveness | Human-refined specs: ~50% error reduction | Augment Code, ClearSpec |
| AC constrainedness vs acceptance | Well-constrained: 82.1% vs ambiguous: 66.1% | ArXiv PR Acceptance Study (7,156 PRs) |
| Evidence discrimination | 46% of validation events non-discriminating | BSG-VA framework (arXiv July 2026) |
| Self-attestation failure | 31.7% semantic drift miss rate same-agent | Independent-Checker Pattern |
| Test deletion gaming | Documented anti-pattern across multiple teams | DEV Community, FreeCodeCamp |
| Mutation testing | 91% coverage, 34% mutation score in AI tests | MutGen study, Meta FSE 2025 |
| SWE-bench false positives | 50% of passing PRs wouldn't merge | METR March 2026 |
| A11y tree vs screenshots | Degraded a11y: 80%→42% success | CHI 2026 (UC Berkeley + U Michigan) |
| Quinn failure pattern | Explore→Explore→Explore loop = failure | ASE 2025 trajectory research |
| Read-before-write | Context efficiency r=0.928 with solve rate | SWE-Explore (June 2026) |
| Token ratio | Top performers: 10:1 read-to-write | Epoch AI SWE-bench evaluation |
| Context file quality | LLM-generated: -3% success, +23% cost | ETH Zurich (Feb 2026) |
| Instruction compliance decay | 73% at turn 5 → 33% by turn 16 | Gamage et al. 2026 |
| AI code defect rate | 1.7-2.7x more defects than human | Multiple 2026 studies |
| AI security flaw rate | 44% of tasks produce known flaws | Veracode July 2026 |
| Change failure rate | Up ~30% since AI adoption | Cortex 2026 Benchmark |
| Iterative refinement risk | 37.6% vulnerability increase after 5 rounds | IEEE-ISTAS 2025 |
| Adversarial review | 3 agents with structured disagreement beat 5 | ICML 2026 Workshop |
| RCA vs symptom-fix | 63% of top scores retrieve, not derive | Cursor reward-hacking study 2026 |
| Hermes 4-phase protocol | Production-tested systematic debugging | NousResearch |
| Agentless pipeline | 27.33% SWE-bench Lite at $0.34/bug | FSE 2025 |
| AgentTrace | 94.9% Hit@1, 69x faster than LLM diagnosis | ICLR 2026 Workshop |
| Parallel agent conflicts | 41.7% cross-agent conflict rate | 33,596 PR study |
| Worktree isolation | Universal standard, 3-5 agents optimal | Claude Code, Codex, Devin |
| Merge queue bottleneck | Max 48 PRs/day at 30min CI | Industry analysis |
| Agent PR quality | AI PRs break main 1.9% vs human 4.4% | Mergify 200K+ merges |
| Deep module violations | AI agents: 10-50x more boundary violations/session | Ousterhout observation, SWE-bench analysis |
| Property-based testing | 984 bugs across 100 packages, 56% true bugs | Anthropic PBT research |
| AI test quality gap | 91% coverage, 34% mutation score | MutGen study |
| Mutation testing ROI | 55% fewer production bugs | Meta FSE 2025 (mutation score raised to 89.5%) |
| Testing pyramid inversion | PBT > contract > integration > unit for AI code | Multiple studies synthesis |
| Tautological testing | AI tests verify implementation, not specification | DEV Community, FreeCodeCamp pattern analysis |
| Consumer-driven contracts | Horizontal boundary testing catches 3x more AI-code bugs | Contract testing studies |
| Context loading architecture | Subagents load CLAUDE.md hierarchy + preloaded skills | Anthropic Claude Code docs (Context7) |
| Template compression | >150 lines methodology = 20-23% cost, no behavior improvement | ETH Zurich (Feb 2026) |
| Context budget | Heaviest agent (Marcus) uses 3.1% of 200k window; full cycle 11.1% | Rungate context budget analysis |
| Instruction stacking collapse | 96.4% → 57.7% compliance at 16 stacked rules; 44.7% at 20 | arXiv:2608.02639 (2026) |
| IFScale benchmark | 94% at 1-3 instructions → 68% at 500 | Jaroslawicz et al. 2025 |
| Instruction complexity cliff | Models reliably satisfy ~3 concurrent constraints | TianPan.co research |
| Lost in the Middle | 30-50% accuracy drop for middle-positioned content | Stanford TACL 2024, Veseli et al. 2025 |
| Context rot | All 18 models degraded as input length grew; degradation at 25% capacity | Chroma study (July 2025) |
| AGENTS.md length vs performance | >500 lines underperforms 200-line files on instruction-following | DeployHQ 2026 |
| AGENTS.md empirical study | Human-written: +4% success, -35-55% bugs; LLM-generated: -3% success | Gloaguen et al. 2026 |
| AGENTS.md adoption | 60,000+ repos, 25+ tools, Linux Foundation AAIF governance | agents.md, AAIF (Dec 2025) |
| Cursor activation modes | 4 modes: always-on, glob, agent-decided, manual | Cursor docs |
| Codex config separation | .codex/config.toml (how) vs AGENTS.md (what) | OpenAI Codex docs |
| Anthropic system prompt reduction | Removed 80% of Claude Code system prompt for Claude 5 without loss | Anthropic engineering blog |
| Second occurrence rule | Only add rule after same mistake happens twice | Anthropic Claude Code best practices |
| Aggressive language counterproductive | "CRITICAL!", "YOU MUST" produces worse results than calm instructions | Anthropic context engineering guide |
| Format: examples > descriptions | Specific tool mentions increase agent usage from 0.01 to 1.6x/task | Addy Osmani research |
| Positive > negative framing | Cap negative instructions at 10-15; past that, model confuses constraints | VirtusLab, Dust research |
| 15 tool-call compliance cliff | System prompt constraints lose influence past ~15 tool calls | Engineer documentation, attention dilution |
| Runtime compliance (C-Trace) | 97.7% recovery with semantic feedback vs 31.4% with bare denials | arXiv:2606.19242 |
| Microsoft Agent Governance | Sub-millisecond external policy enforcement at runtime | Microsoft Agent Governance Toolkit (April 2026) |
| Sourcegraph context engineering | 1,281 runs: more context degrades performance; smarter selection, not bigger windows | Sourcegraph CodeScaleBench (May 2026) |
| Spec-Driven Development | Dominant coding agent pattern: structured specs feed agent briefs | GitHub Spec Kit, Kiro (AWS), Claude Code Skills |
| Multi-agent production survival | 73% Fortune 500 run multi-agent; 62% of early deployments fail to reach prod | Multi-agent production survey 2026 |
| Compact at 60-75% capacity | Not 95%; primary lever for long-horizon agents | Anthropic effective harnesses blog |
| Google ADK context layers | Static/Turn/User/Cache — most structured production context architecture | Google ADK docs |
