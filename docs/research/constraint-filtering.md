---
doc-type: research
status: active
owner: jason
created: 2026-09-19
updated: 2026-09-20
governs: Constraint extraction, context budgets, rule count limits
---

# Constraint Candidate Filtering Research

## Key Finding

Ran extract-constraints on DDB — found 352 signal phrases across 67 files. Too noisy for agent consumption. Agents degrade at 16+ rules (instruction compliance drops from 96.4% → 57.7%). Best-practice rules files across Cursor, Windsurf, Copilot are 10-20 enforced constraints max.

## Recommended Filter: Code-Specificity Scoring

**High confidence** → references specific function, file, module, or API. Auto-promote to review.
- Example: "Never call callGemini without sanitizePromptInput()"

**Medium confidence** → operational rule with specific tool/command. Batch review.
- Example: "Always deploy with make rebuild"

**Low confidence** → descriptive prose using "must/never" language. Auto-archive.
- Example: "Files are never deleted" (describes behavior, not enforceable constraint)

## Implementation Plan

1. Add confidence scorer to `extract-constraints.ts` — check if candidate contains function names, file paths, or module references from CODE-MAP.md
2. Cap findings JSON to top 20 highest-confidence candidates
3. Full list goes to `constraint-candidates-full.json` for batch review sessions
4. Deduplicate semantically — same rule stated differently across files

## Sources

- Semgrep Multimodal — triage-and-learn model for rule management
- dev.to analysis: "268 rules, 14 always-loaded" — most rules files make agents worse
- AI agents gradually ignore compliance rules as sessions grow longer (KuCoin research)
- arXiv:2608.02639 — instruction stacking collapse at 16 rules

## How This Governs RunGate

352 candidates is 20x over the attention budget. Without filtering, the candidates section is noise that agents ignore entirely. The constraint extraction pipeline (SC-214-217) must implement code-specificity scoring against CODE-MAP.md exports/routes. Cap output at 20 highest-confidence candidates.
