---
doc-type: spec
status: draft
owner: jason
created: 2026-09-22
updated: 2026-09-22
governs: Parallel agent coordination — file-claim manifests and module-boundary decomposition to prevent merge conflicts in multi-agent AFK work
testable: yes
---

# Parallel Agent Coordination

## Problem Statement

When multiple agents work in parallel on independent issues, they may modify the same files — producing merge conflicts that waste agent work or silently break code. Session 2026-09-22 demonstrated this: Streams A (#560) and B (#559) both modified `ship.js` and `prove.js` independently. The merge succeeded because the designs converged, but divergent changes would have discarded one agent's work entirely.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | File-claim manifest: agents declare target files before starting | Catches overlap at schedule time, not merge time. Cheap pre-flight vs expensive rework |
| D-2 | Module-boundary decomposition: wave planning must check file overlap | Prevention > detection. If two issues touch the same file, they serialize, not parallelize |
| D-3 | Claim granularity is file-level, not line-level | Line-level is fragile (refactors shift lines). File-level is conservative but safe |
| D-4 | Overlap = serialize, not block | Both issues still ship — just not in the same wave. No work is lost |

## Target State

Before launching a wave of parallel agents, a pre-flight check:
1. Each issue's target files are predicted (from spec `governs`, CODE-MAP, or explicit declaration)
2. File sets are compared pairwise across all issues in the wave
3. Overlapping issues are moved to the next wave (serialized)
4. Agents receive their file-claim manifest — they WARN if they touch unclaimed files

Post-wave, an integration check verifies no unclaimed file modifications slipped through.

## Success Criteria

- SC-410: Wave planner predicts target files per issue before agent launch
- SC-411: Pairwise file overlap check runs before wave launch — overlapping issues serialize
- SC-412: Agents receive file-claim manifest in their prompt
- SC-413: Post-wave integration check detects unclaimed file modifications
- SC-414: Module-boundary decomposition rules documented — issue authors check file overlap at creation time
- SC-415: Wave planner uses CODE-MAP.md module boundaries for file prediction when no explicit claim exists
