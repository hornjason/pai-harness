import { expect, test } from "bun:test";
import { greet, add } from "../src/index";

test("greet returns greeting", () => {
  expect(greet("World")).toBe("Hello, World!");
});

test("add returns sum", () => {
  expect(add(2, 3)).toBe(5);
});
