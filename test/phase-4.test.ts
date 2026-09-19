import { describe, test, expect } from "bun:test";

describe("Phase 4 — Knowledge Mining", () => {
  test.todo("SC-205: temporal-coupling command outputs JSON");
  test.todo("SC-206: coupling JSON schema correct");
  test.todo("SC-207: high-coupling pairs route to review queue");
  test.todo("SC-208: only applied coupling rules in briefs");
  test.todo("SC-209: analyze-deps runs dependency-cruiser");
  test.todo("SC-210: circular deps produce WARN");
  test.todo("SC-211: orphan modules produce INFO");
  test.todo("SC-212: boundary violations produce WARN");
  test.todo("SC-213: analyze-dead-code runs Knip");
  test.todo("SC-214: Knip entry points configurable");
  test.todo("SC-215: unused files produce WARN");
  test.todo("SC-216: unresolved imports produce FAIL");
  test.todo("SC-217: hotspot scoring outputs JSON");
  test.todo("SC-218: top 5 hotspots surfaced in briefs");
  test.todo("SC-219: Tier 1 regex uses signal-phrases.ts");
  test.todo("SC-220: Tier 2 heuristic 0-5 scoring");
  test.todo("SC-221: score ≥5 auto-promoted");
  test.todo("SC-222: score 3-4 sent to LLM");
  test.todo("SC-223: score ≤2 auto-filtered");
  test.todo("SC-224: LLM cost cap ≤200 tokens per candidate");
  test.todo("SC-225: cross-file dedup");
  test.todo("SC-226: top 20 in findings, full list separate");
  test.todo("SC-227: candidate status lifecycle");
  test.todo("SC-228: AgentGrit inbox adapter");
  test.todo("SC-229: 90-day auto-deferred");
});
