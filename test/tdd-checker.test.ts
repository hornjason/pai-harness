import { describe, test, expect } from "bun:test";
import { checkTDD } from "../lib/transcript-checker.js";

describe("TDD sequence checker", () => {
  test("detects TDD pattern (test before source)", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.verdict).toBe("TDD");
    expect(result.testFirst).toBe(true);
    expect(result.redPhase).toBe(true);
    expect(result.greenPhase).toBe(true);
  });

  test("detects TEST_AFTER pattern (source before test)", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.verdict).toBe("TEST_AFTER");
    expect(result.testFirst).toBe(false);
  });

  test("detects NO_TESTS when no test files written", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.verdict).toBe("NO_TESTS");
  });

  test("detects missing red phase (no test run after test write)", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/foo.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/foo.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.testFirst).toBe(true);
    expect(result.redPhase).toBe(false);
    expect(result.verdict).toBe("TEST_AFTER");
  });

  test("sequence captures all events in order", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"test/bar.test.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"lib/bar.ts"}}]}}',
    ].join("\n");

    const result = checkTDD(transcript);
    expect(result.sequence.length).toBe(3);
    expect(result.sequence[0].type).toBe("TEST_RUN");
    expect(result.sequence[1].type).toBe("WRITE_TEST");
    expect(result.sequence[2].type).toBe("WRITE_SOURCE");
  });
});
