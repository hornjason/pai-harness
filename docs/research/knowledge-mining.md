---
doc-type: research
status: active
owner: jason
created: 2026-09-19
updated: 2026-09-20
governs: Knowledge mining pipeline, temporal coupling, constraint extraction strategy
---

# Project Knowledge Mining for AI Agents Research

## Core Finding

Nobody has built the full "mine everything → extract rules → route to agents" pipeline. Industry has retrieval (Greptile, Sourcegraph), storage (Mem0, Zep), behavioral analysis (CodeScene) — but none produces machine-actionable rules from project history.

## What EXISTS

- **Greptile** — indexes codebases (git, PRs, issues) into semantic layer. API for AI agents.
- **Sourcegraph Cody** — code graph + AI. SCIP protocol for precise cross-repo references.
- **CodeScene** — behavioral git analysis. Hotspots, temporal coupling, knowledge distribution. Outputs dashboards, not rules.
- **Mem0/Zep/LangMem** — memory storage+retrieval. Store what you tell them, don't mine automatically.
- **Swimm** — auto-docs from code changes, detects doc decay. Adjacent but not rule mining.
- **Incident.io/Rootly/FireHydrant** — structure postmortems, don't extract code rules.

## What's MISSING (RunGate's opportunity)

1. **Automated rule extraction from AI session failures** — nobody does this
2. **Closed-loop learning**: session transcript → failure pattern → rule → CLAUDE.md → better next session
3. **Cross-source mining** (git + issues + sessions + docs) → actionable agent rules
4. **Temporal coupling → agent rules**: "when you modify A, also check B" from git co-change patterns

## DDB Temporal Coupling Findings (from git analysis)

- bootstrap-orchestrator.ts ↔ SetupPage.tsx: 21 co-changes, NO import link
- campaign-html-template.ts ↔ campaign-service.ts: 47 co-changes (strongest)
- ccsp-scraper.ts ↔ sf-scraper.ts: 14 co-changes, no shared interface
- All dashboard pages co-change 10-17 times (shared patterns)
- customer-routes.ts is a hub with 5+ strong couplings

## DDB Hotspots

- scrape-saleshub-product-page.ts: 5,433 lines, 149 fns, 107 commits (god-script)
- campaign-html-template.ts: 226 commits (most-changed file, ~1.2 changes/day)
- bootstrap-orchestrator.ts: 1,886 lines, 78 fns, 102 commits

## The Flywheel

Agent works → things break → mine failures → extract rules → route to briefs → agent performs better → fewer corrections → higher-quality signal → better rules. Compounding return. This is RunGate's endgame.

## How This Governs RunGate

Add temporal coupling analysis to RunGate's mining pipeline (Phase 4, SC-218-234). Build git co-change analysis into scaffold to auto-discover "when you modify A, check B" rules. Connect to AgentGrit's debrief pipeline for session-based rule extraction.
