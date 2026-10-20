/**
 * #328 — the behavioral verification path was built and never connected.
 *
 * `#328`'s original four mechanisms are mostly closed: the `expect(true)
 * .toBe(true)` body is a report now, and `BEHAVIORAL_TICKED_RATCHET` bounds
 * the population both ways at 35. This file is about the part that was built
 * afterwards and wired to nothing.
 *
 * `behavioralPattern` (`lib/conformity.ts:331`) turns a cached runtime result
 * into a real assertion — it THROWS when `entry.passed` is false. Measured on
 * this tree: its only callers are `test/behavioral-cache.test.ts`, which calls
 * it directly through `require`. **There is no production call site.** Control
 * for that search, because an empty grep over a tree you did not write is not
 * a reading: `isBehavioralSC` returns 5 hits in the same file.
 *
 * The reason it is unreachable is one line. `planSCTests` classifies first:
 *
 *     if (isBehavioralSC(sc)) return { kind: "behavioral", sc, ... };
 *
 * That runs before any cache lookup, so a behavioral SC becomes a `console.log`
 * line whatever the cache says about it.
 *
 * ## Two deciders, and the one with teeth is the one that does not look
 *
 * `scripts/sync-sc-status.ts:537` DOES consult the cache, and puts a behavioral
 * SC whose entry says `passed: false` into `failing`. So the tool that decides
 * whether to TICK a criterion reads the evidence, and the suite that decides
 * whether the build is GREEN does not. They can disagree, and when they do the
 * gate is the one that is wrong.
 *
 * A behavioral SC with a fresh `passed: false` entry is, today, reported and
 * passed. The error string inside `behavioralPattern` —
 * `Behavioral SC ${sc.id} failed: ${entry.evidence}` — cannot be produced by
 * any real run.
 *
 * ## One property, three syntaxes
 *
 * `.rungate/behavioral-results.json` is assembled by hand in three places:
 * `lib/agent-audit.ts:112` and `scripts/test-brief.ts:316` (both writers) and
 * `scripts/sync-sc-status.ts:528` (the reader). Nothing compares them. If one
 * drifts, a writer writes where no reader reads, and the symptom is an empty
 * cache — which is indistinguishable from "no behavioral results recorded
 * yet". That is #484's shape with a filesystem in the middle, and it is why
 * the path becomes one exported binding here rather than a fourth literal.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Call `behavioralPattern` from `planSCTests` and keep the `kind:
 * "behavioral"` return for everything else — but resolve the cache path with a
 * fourth inline `join(root, ".rungate", "behavioral-results.json")`.** It
 * works. Every case about verdicts below goes green. It also adds a fourth
 * independent spelling of a path whose whole failure mode is the spellings
 * drifting apart, in the commit that makes that path load-bearing for the
 * suite's colour.
 *
 * AC-4 is the case that survives it, and it is why AC-4 exists: it asserts
 * there is ONE binding and that no module builds the path by hand.
 *
 * ## Why a stale entry must not certify
 *
 * `readFreshCache` already drops entries older than seven days, and AC-2's
 * second case pins that at this seam specifically. A stale PASS is the
 * dangerous direction: it is a measurement that was true a fortnight ago being
 * read as one taken now. Dropping it returns the SC to `behavioral`, which is
 * reported and ratcheted — UNMEASURED, not passed.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { planSCTests, type ParsedSC } from "../lib/conformity";
import { behavioralCachePath, type BehavioralCache } from "../lib/behavioral-cache";

const REPO = join(import.meta.dir, "..");

const BEHAVIORAL: ParsedSC = {
  id: "SC-9328",
  statement: "the agent cites the governing spec before writing code (behavioral)",
  specFile: "specs/SESSION-AUDIT-SPEC.md",
  checked: true,
} as ParsedSC;

/** A project root carrying a behavioral cache with the given entries. */
function rootWithCache(entries: BehavioralCache): string {
  const root = mkdtempSync(join(tmpdir(), "rungate-328-"));
  const path = behavioralCachePath(root);
  mkdirSync(join(root, ".rungate"), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
  return root;
}

const now = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("#328 AC-1: a cached behavioral result reaches the suite", () => {
  test("a fresh PASSING entry plans as an assertion that holds", () => {
    const root = rootWithCache({
      "SC-9328": { passed: true, evidence: "cited ADR-009 before editing", timestamp: now() },
    });
    try {
      const [entry] = planSCTests([BEHAVIORAL], root);
      expect(entry.kind, "a cached behavioral result is still only reported").toBe("assert");
      // It must not throw — a verification path that fails closed on a PASS
      // would be worse than the silence it replaces.
      expect(() => (entry as any).assertion(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fresh FAILING entry plans as an assertion that THROWS, naming the id and the evidence", () => {
    // The whole issue. Today this SC is a console.log line and a green suite.
    const root = rootWithCache({
      "SC-9328": { passed: false, evidence: "wrote code with no spec cited", timestamp: now() },
    });
    try {
      const [entry] = planSCTests([BEHAVIORAL], root);
      expect(entry.kind, "a FAILED behavioral result does not reach the suite").toBe("assert");
      let thrown: Error | null = null;
      try { (entry as any).assertion(root); } catch (e: any) { thrown = e; }
      expect(thrown, "a failed behavioral result did not fail the suite").not.toBeNull();
      expect(thrown!.message).toContain("SC-9328");
      // The evidence, not just the verdict: "it failed" sends nobody anywhere.
      expect(thrown!.message).toContain("wrote code with no spec cited");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#328 AC-2: without a usable reading it stays UNMEASURED, not passed", () => {
  test("no cache entry leaves the SC reported and ratcheted, not asserted", () => {
    const root = rootWithCache({});
    try {
      const [entry] = planSCTests([BEHAVIORAL], root);
      expect(entry.kind).toBe("behavioral");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a STALE passing entry does not certify the SC", () => {
    // Eight days. The dangerous direction: a measurement that was true a
    // fortnight ago read as one taken now.
    const root = rootWithCache({
      "SC-9328": { passed: true, evidence: "passed, eight days ago", timestamp: daysAgo(8) },
    });
    try {
      const [entry] = planSCTests([BEHAVIORAL], root);
      expect(entry.kind, "a stale pass was treated as a current one").toBe("behavioral");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-behavioral SC is unaffected by the cache", () => {
    // The control. Without it, "consult the cache" is satisfied by a change
    // that routes every SC through it.
    const root = rootWithCache({
      "SC-9329": { passed: false, evidence: "irrelevant", timestamp: now() },
    });
    try {
      const plain = { id: "SC-9329", statement: "lib/foo.ts exports bar", specFile: "specs/X.md", checked: true } as ParsedSC;
      const [entry] = planSCTests([plain], root);
      expect(entry.kind).not.toBe("behavioral");
      expect(entry.kind).not.toBe("assert");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#328 AC-3: the verification path has a production caller", () => {
  test("behavioralPattern is called from lib/, not only from tests", () => {
    // The guard against this going dead again. It was defined, exported,
    // thoroughly unit-tested and never reached from a real run — which no
    // test of the function itself can detect, because those tests call it.
    const conformity = readFileSync(join(REPO, "lib", "conformity.ts"), "utf-8");
    const calls = conformity.match(/behavioralPattern\s*\(/g) || [];
    // One is the declaration; a caller makes two.
    expect(calls.length,
      "behavioralPattern has no call site in lib/conformity.ts — it is defined, " +
      "exported and unreachable from any real run").toBeGreaterThanOrEqual(2);
  });
});

describe("#328 AC-4: one binding for the cache path", () => {
  const FILES = [
    "lib/agent-audit.ts",
    "scripts/test-brief.ts",
    "scripts/sync-sc-status.ts",
    "lib/conformity.ts",
  ];

  test("behavioralCachePath resolves the documented location", () => {
    expect(behavioralCachePath("/tmp/p")).toBe(join("/tmp", "p", ".rungate", "behavioral-results.json"));
  });

  test("no module builds the path by hand", () => {
    // Two writers and a reader each spelled this themselves. A drift in any
    // one of them writes where nobody reads, and the symptom — an empty cache
    // — is indistinguishable from "nothing recorded yet".
    const offenders: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(join(REPO, f), "utf-8");
      text.split("\n").forEach((line, i) => {
        if (line.includes("behavioral-results.json") && line.includes("join(")) {
          offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, "these assemble the cache path instead of calling " +
      `behavioralCachePath():\n${offenders.join("\n")}`).toEqual([]);
  });
});
