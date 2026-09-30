import { describe, expect, test } from "bun:test";
import { deepMerge } from "../lib/deep-merge";

describe("deepMerge", () => {
  test("merges primitive values - override wins", () => {
    const base = { a: 1, b: 2 };
    const override = { b: 3 };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, b: 3 });
  });

  test("merges nested objects recursively", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const override = { a: { y: 99 } };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: { x: 1, y: 99 }, b: 3 });
  });

  test("replaces arrays instead of concatenating", () => {
    const base = { checks: ["a", "b", "c"] };
    const override = { checks: ["x", "y"] };
    const result = deepMerge(base, override);
    expect(result).toEqual({ checks: ["x", "y"] });
  });

  test("handles deep nesting with mixed types", () => {
    const base = {
      tier: {
        maxIterations: 5,
        checks: {
          verify: ["a", "b", "c"],
          ship: ["d", "e"],
        },
      },
    };
    const override = {
      tier: {
        maxIterations: 3,
        checks: {
          verify: ["x", "y"],
        },
      },
    };
    const result = deepMerge(base, override);
    expect(result).toEqual({
      tier: {
        maxIterations: 3,
        checks: {
          verify: ["x", "y"],
          ship: ["d", "e"],
        },
      },
    });
  });

  test("does not mutate base object", () => {
    const base = { a: { x: 1 } };
    const override = { a: { y: 2 } };
    const result = deepMerge(base, override);
    expect(base).toEqual({ a: { x: 1 } });
    expect(result).toEqual({ a: { x: 1, y: 2 } });
  });

  test("handles empty override", () => {
    const base = { a: 1, b: 2 };
    const override = {};
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("handles null and undefined values", () => {
    const base = { a: 1, b: null, c: undefined };
    const override = { b: 2, c: 3 };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });
});
