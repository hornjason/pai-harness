/**
 * Covers CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * The spec's convergence figures must BE the last stored reading, not a
 * transcription of it. This section has published two sets of wrong numbers
 * and both were retypings — one scored twelve never-reviewed pull requests as
 * one-round passes, the other carried a denominator the prose beside it had
 * already abandoned. A document that can drift from its own measurement will.
 *
 * The remedy is one command, printed in the failure.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CRC_BLOCK_BEGIN,
  CRC_BLOCK_END,
  spliceCrcBlock,
  type CrcReadingRow,
} from "../lib/crc-reading.ts";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, "specs/CODE-REVIEW-CONVERGENCE-SPEC.md");
const STORE = join(ROOT, "specs/crc-readings.json");

const REMEDY =
  "Do not edit the block by hand. Re-render it:\n" +
  "  bun scripts/crc-reading.ts --lo <LO> --hi <HI> --record " +
  "--write-spec specs/CODE-REVIEW-CONVERGENCE-SPEC.md\n" +
  "See .claude/rules/self-referential-tests.md.";

describe("the spec's measurement block is rendered, not retyped", () => {
  const store = JSON.parse(readFileSync(STORE, "utf-8")) as CrcReadingRow[];
  const document = readFileSync(SPEC, "utf-8");

  test("the store holds at least one reading, and every row names its range", () => {
    // A store that is present and empty would make every assertion below
    // vacuous — comparing a block against a render of nothing.
    expect(store.length).toBeGreaterThan(0);
    for (const row of store) {
      expect(Number.isInteger(row.lo)).toBe(true);
      expect(Number.isInteger(row.hi)).toBe(true);
      expect(row.lo).toBeLessThanOrEqual(row.hi);
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the spec carries both markers, in order", () => {
    const begin = document.indexOf(CRC_BLOCK_BEGIN);
    const end = document.indexOf(CRC_BLOCK_END);
    expect(begin, REMEDY).toBeGreaterThan(-1);
    expect(end, REMEDY).toBeGreaterThan(begin);
  });

  test("the block equals a render of the LAST stored row, byte for byte", () => {
    const expected = spliceCrcBlock(document, store[store.length - 1]);
    expect(expected).not.toBeNull();
    expect(document, REMEDY).toBe(expected as string);
  });

  test("it can fail: a render of a DIFFERENT row does not match", () => {
    // The negative control. Without it a splice that produced the empty
    // string, or a comparison of the document against itself, would be
    // green — `.claude/rules/checks-must-be-able-to-fail.md`.
    const last = store[store.length - 1];
    const moved: CrcReadingRow = { ...last, hi: last.hi + 1 };
    expect(spliceCrcBlock(document, moved)).not.toBe(document);
  });

  test("a document with no markers is refused rather than appended to", () => {
    expect(spliceCrcBlock("# a spec with no markers\n", store[0])).toBeNull();
  });
});
