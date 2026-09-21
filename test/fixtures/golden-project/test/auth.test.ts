import { expect, test } from "bun:test";
import { validateToken, refreshToken } from "../src/auth";

test("validates non-empty token", () => {
  expect(validateToken("abc123")).toBe(true);
});

test("rejects empty token", () => {
  expect(validateToken("")).toBe(false);
});

test("refreshes token with prefix", () => {
  expect(refreshToken("abc")).toBe("refreshed-abc");
});
