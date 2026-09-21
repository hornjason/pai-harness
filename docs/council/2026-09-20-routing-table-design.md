---
doc-type: council
status: active
owner: jason
updated: 2026-09-20
---

# Council: Routing Table Design

## Verdict (Unanimous)

Keep the routing table in AGENTS.md. Fix the content behind it, not the mechanism.

## Convergence Points

1. Routing table IS the Claude Code skills pattern (name+description → deferred content). No DOCS.md, no contextDocs restructure, no LLM at scaffold time.
2. SC-270 (split large specs under 500 lines) is highest-impact fix — "a well-signposted door that opens into an unusable room."
3. Fill TODO governs values — routing table was 44% populated.
4. Merge Governing Spec Routing + Specs into single table — one lookup point.
5. contextDocs and Documentation Routing stay separate — different consumers.

## Security Fixes Identified

- Path traversal in brief-assembler.ts:139 (contextDocs accepts ../../.env)
- Governs field pipe injection in scaffold-project.ts:520 (no escaping)

## Decisions Produced

- D-7: Table merge (implemented)
- D-8: Governs authored LLM-once-then-static
- D-9: Content that doesn't match governs → new file
- D-10: Split files group under one routing entry
- D-11: Routing table shows non-obvious mappings only
- D-12: Directory name derived from filename, no LLM
- D-13: Routing and create tables are the same list

## Deep-Module Filter

Every recommendation removes agent steps, none adds. Zero new navigation hops.
