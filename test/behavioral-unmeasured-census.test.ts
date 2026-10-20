/**
 * #758 — a behavioral criterion with no reading is green and
 * indistinguishable from one that passed. The SUPPLY half of #328.
 *
 * #328 connected the consumption end: `planSCTests` asks the cache before it
 * classifies, so a fresh `passed: false` entry now becomes an assertion that
 * throws. Nothing guarantees an entry is ever WRITTEN. The two writers —
 * `lib/agent-audit.ts` and `scripts/test-brief.ts` — run during a ship run or
 * a brief test and never during an ordinary `bun test`, so on this tree all
 * 35 ticked `(behavioral)` criteria take the other branch: reported,
 * ratcheted, and not checked.
 *
 * Measured 2026-10-19, before this file existed: `.rungate/behavioral-results.json`
 * does not exist, and the run's only figure about any of it is
 * `behavioralCount`, which counts the criteria that were ROUTED. A criterion
 * that was measured and passed is an ordinary `assert` entry and never
 * reaches that counter — so `behavioralCount: 0` is what a fully measured run
 * produces AND what a project with no behavioral criteria produces, and the
 * number that matters, how many went unread, was written down nowhere.
 *
 * `0`, `{}`, `null`, `SKIP` and silence are indistinguishable from success;
 * `UNMEASURED` is not (`.claude/rules/config-access.md`).
 *
 * ## The shape of the fix is #597's, not a new one
 *
 * Keep the whole reading and derive the boolean; one discriminator; name
 * every reason. `behavioralCensus` returns the four per-criterion states and
 * the three cache states, `reading` is a projection of its own lists, and
 * `behavioralCensusLine` renders a figure rather than a line per criterion.
 *
 * ## Two deciders, collapsed before this file was written
 *
 * `behavioralPattern` asked `readFreshCache` whether a reading was fresh and
 * the census asked `isStale`. Same question, same input, always agreeing —
 * the fourth shape, and a mutation of either would have left the other
 * holding every case here up. Both now route through `behavioralReading`,
 * which is the one binding to mutate.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Print the number of routed criteria — `behavioral.length` — as the
 * unmeasured count.** It is one line, it is already in hand at the report
 * site, and on this tree it prints 35, which is the right answer. It is
 * right for the wrong reason: that list is the unmeasured half BY
 * CONSTRUCTION, so it carries no denominator and can never say `3 of 35`.
 * The day somebody runs the writers it prints 3 unmeasured out of nothing,
 * and a reader cannot tell that from 3 out of 3.
 *
 * `AC-1b` is the case that survives it: it asserts the line names a
 * population the routed list does not contain, by driving a cache in which
 * some criteria ARE fresh and requiring both halves in the figure.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/behavioral-cache.test.ts` +
 * `test/behavioral-cache-binds-suite.test.ts` (43 tests). Every count was
 * predicted before the battery ran, and **the baseline row was read first** —
 * an instrument that has stopped reporting takes the baseline down with it,
 * and that is the row nobody mutates anything to produce.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 43 pass, 0 fail | **43 pass, 0 fail** | — |
 * | M1 the census reports the unmeasured count as zero — the row the issue asks for | 6 | **7 of 43** | an absent cache over 2 ids: the original is UNMEASURED naming both, the mutant is MEASURED naming none |
 * | M2 `behavioralCacheState` folds `unreadable` into `absent` | 1 | **2 of 43** | a file containing `{ this is not json` |
 * | M3 `behavioralReading` stops calling `isStale` | 3 | **6 of 43** | an entry 8 days old: the original says `stale`, the mutant `fresh-pass` |
 * | M4 the empty-population reason removed | 1 | **1 of 43** | `behavioralCensus([], path)` |
 * | M5 **the cheapest wrong fix**: the line prints no denominator | 3 | **2 of 43** | 2 fresh of 3 ids: the original says `2/3`, the mutant `1 criteria have no fresh reading` |
 * | M6 an undateable timestamp treated as fresh | 1 | **1 of 43** | `timestamp: "not a date"` |
 * | M7 the `total > 0` clause dropped from the reading | 1 | **1 of 43** | `behavioralCensus([], path)` — M4's input, a different binding |
 * | M8 the date stripped from the ratchet's docblock | 1 | **1 of 43** | the docblock itself — and **0 of 43** with AC-6's slice widened to the whole file |
 *
 * **M3 came back double, and the extra reds are the real kind.** Three of the
 * six are pre-existing cases — `#328 AC-2`'s stale-PASS case, `readFreshCache
 * excludes stale entries`, and `behavioralPattern returns null for a stale
 * result`. That is the collapse paying out: `behavioralReading` is now the
 * one binding those three depend on too, so the prediction was wrong and the
 * check is better than it was. Not a crashing mutant — 37 cases still pass
 * and every red is about staleness.
 *
 * **M1 and M2 are the same kind of miss, smaller**: one more case each
 * witnesses the mutated behaviour than I counted, and both extras are
 * squarely about it.
 *
 * **M5 came back LOW, and it is not a collapsed pair.** The third case I
 * predicted asserts a 35-criterion population still renders ONE line, and
 * the mutant renders one line too — correctly green. The differing input is
 * named above and two cases witness it.
 *
 * **M8 is why AC-6 cuts a slice.** This file's own header names `#758`, a
 * date and the number 35, so a whole-file search is satisfied by prose about
 * the rule rather than by the justification the rule demands — measured at 0
 * red with the slice widened, against 1 red with it intact. `.claude/rules/
 * checks-must-be-able-to-fail.md`'s "search the slice, not the document",
 * caught by the arithmetic rather than by reading.
 *
 * None of the eight mutations is left in the tree; all were run and reverted,
 * and `lib/behavioral-cache.ts` was confirmed byte-identical to the measured
 * source afterwards by sha256, never by `git checkout --`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  behavioralCensus,
  behavioralCensusLine,
  behavioralReading,
  type BehavioralCache,
} from "../lib/behavioral-cache";
import { extractSCs, isBehavioralSC } from "../lib/conformity";
import { collectSpecFiles } from "../lib/spec-files";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many ticked `(behavioral)` criteria this repository cannot measure.
 *
 * **35, measured 2026-10-19 on `main` at `824f0cae` (#758).** Every one of
 * the 35 ticked behavioral criteria in `specs/` is in the `absent` state:
 * `.rungate/behavioral-results.json` is not committed and is not written by
 * `bun test`, so the number is a property of the repository and reads the
 * same on every machine and in CI.
 *
 * Both ways. Over it means a new behavioral criterion arrived with nothing
 * able to measure it; under it means the project gained a measurement source
 * and the progress has to be banked in the commit that earned it, or the
 * number becomes one nobody can interpret.
 *
 * **Why this is not `BEHAVIORAL_TICKED_RATCHET` wearing a second hat.** That
 * constant bounds how many ticked behavioral criteria EXIST; this one bounds
 * how many of them go unread. They are 35 and 35 today because the answer to
 * the second question is currently "all of them", and two numbers that cannot
 * differ are one number. `AC-4c` is the case that holds them apart: it
 * asserts the relationship rather than the value, so the day a criterion
 * gains a reading the two diverge and the case says which one moved.
 */
const UNMEASURED_RATCHET = 35;

const SPECS = join(import.meta.dir, "..", "specs");

/** Ticked `(behavioral)` criteria, read off `specs/` the way the engine does. */
function tickedBehavioralIds(): string[] {
  const ids: string[] = [];
  for (const rel of collectSpecFiles(SPECS)) {
    const src = readFileSync(join(SPECS, rel), "utf-8");
    for (const sc of extractSCs(src, rel)) {
      if (sc.checked && isBehavioralSC(sc)) ids.push(sc.id);
    }
  }
  return ids;
}

/** A cache file written to a scratch path, so no case reads machine state. */
function withCache(entries: BehavioralCache | string | null, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rungate-758-"));
  try {
    const path = join(dir, "behavioral-results.json");
    if (typeof entries === "string") writeFileSync(path, entries);
    else if (entries !== null) writeFileSync(path, JSON.stringify(entries, null, 2));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function entry(ageDays: number, passed = true) {
  return {
    passed,
    evidence: "a transcript the writer read",
    timestamp: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
  };
}

describe("#758 AC-1: the run reports the reading as a figure", () => {
  test("the line names how many have a fresh reading and how many do not", () => {
    withCache({ "SC-9801": entry(1), "SC-9802": entry(1, false) }, path => {
      const c = behavioralCensus(["SC-9801", "SC-9802", "SC-9803"], path);
      const line = behavioralCensusLine(c);

      expect(line, "the figure does not say how many were read").toContain("2/3");
      expect(line).toContain("pass 1");
      expect(line).toContain("fail 1");
      expect(line).toContain("no entry 1");
      // A figure, not a line per criterion: 3 criteria, one line, and it
      // stays one line at 35.
      expect(line.split("\n").length, "the figure spans more than one line").toBe(1);
    });
  });

  test("AC-1b: the figure carries a denominator the routed list cannot supply", () => {
    // The case that survives the cheapest wrong fix. `behavioral.length` at
    // the report site is 1 here — only SC-9803 is routed — and a figure built
    // from it could say "1 unmeasured" and never "1 of 3". Both halves have
    // to be in the line, and the measured half has to be non-zero, or the
    // assertion is satisfied by the unmeasured half alone.
    withCache({ "SC-9801": entry(1), "SC-9802": entry(1) }, path => {
      const c = behavioralCensus(["SC-9801", "SC-9802", "SC-9803"], path);
      expect(c.unmeasured, "the routed half is not what this case varies").toEqual(["SC-9803"]);
      expect(c.counts["fresh-pass"], "no criterion was measured, so the denominator is untestable").toBe(2);
      expect(behavioralCensusLine(c)).toContain("2/3");
    });
  });

  test("a 35-criterion population still renders one line", () => {
    const ids = Array.from({ length: 35 }, (_, i) => `SC-98${String(i).padStart(2, "0")}`);
    withCache(null, path => {
      expect(behavioralCensusLine(behavioralCensus(ids, path)).split("\n").length).toBe(1);
    });
  });
});

describe("#758 AC-2: a stale reading is unmeasured, and says so", () => {
  test("the pair differs only in the timestamp", () => {
    // One fixture, two ages. Varying anything else would make this a
    // comparison of two hand-written cases rather than of the threshold.
    const fresh = entry(1);
    const stale = { ...fresh, timestamp: new Date(Date.now() - 8 * DAY_MS).toISOString() };
    expect(fresh.passed, "the pair varies the verdict too").toBe(stale.passed);

    withCache({ "SC-9801": fresh }, freshPath => {
      const c = behavioralCensus(["SC-9801"], freshPath);
      expect(c.reading).toBe("MEASURED");
      expect(c.counts["fresh-pass"]).toBe(1);
      expect(c.unmeasured).toEqual([]);
    });

    withCache({ "SC-9801": stale }, stalePath => {
      const c = behavioralCensus(["SC-9801"], stalePath);
      expect(
        c.reading,
        "a reading taken a fortnight ago certified a criterion as if taken now",
      ).toBe("UNMEASURED");
      expect(c.counts.stale).toBe(1);
      expect(c.counts["fresh-pass"], "a stale PASS was counted as a pass").toBe(0);
      expect(c.unmeasured).toEqual(["SC-9801"]);
      expect(
        c.unmeasuredReasons.join(" "),
        `the staleness is not named: ${c.unmeasuredReasons.join(" | ")}`,
      ).toContain("stale");
    });
  });

  test("a stale FAIL and a stale PASS are both unmeasured, not a verdict", () => {
    withCache({ "SC-9801": entry(8), "SC-9802": entry(8, false) }, path => {
      const c = behavioralCensus(["SC-9801", "SC-9802"], path);
      expect(c.counts.stale).toBe(2);
      expect(c.counts["fresh-fail"], "a stale failure was reported as a current one").toBe(0);
    });
  });
});

describe("#758 AC-3: an absent cache is not a measured pass", () => {
  const ids = ["SC-9801", "SC-9802"];

  test("absent and all-measured are distinguishable", () => {
    let absent!: ReturnType<typeof behavioralCensus>;
    let measured!: ReturnType<typeof behavioralCensus>;
    withCache(null, p => { absent = behavioralCensus(ids, p); });
    withCache({ "SC-9801": entry(1), "SC-9802": entry(1) }, p => { measured = behavioralCensus(ids, p); });

    expect(measured.reading).toBe("MEASURED");
    expect(absent.reading).toBe("UNMEASURED");
    expect(absent.cacheState).toBe("absent");
    expect(measured.cacheState).toBe("present");
    expect(
      absent.unmeasuredReasons.join(" "),
      "the absent cache is not named as the reason",
    ).toContain("does not exist");
    // The whole readings differ, not merely a field somebody could drop.
    expect(JSON.stringify(absent)).not.toBe(JSON.stringify(measured));
  });

  test("an unreadable cache is a third state, not an absent one", () => {
    // `readCache` returns `{}` for a missing file AND for a corrupt one, and
    // that conflation is the thing this census exists to undo. A corrupt
    // cache is never a missing cache (`.claude/rules/config-access.md`).
    let corrupt!: ReturnType<typeof behavioralCensus>;
    let absent!: ReturnType<typeof behavioralCensus>;
    withCache("{ this is not json", p => { corrupt = behavioralCensus(ids, p); });
    withCache(null, p => { absent = behavioralCensus(ids, p); });

    expect(corrupt.cacheState).toBe("unreadable");
    expect(absent.cacheState).toBe("absent");
    expect(corrupt.reading).toBe("UNMEASURED");
    expect(corrupt.unmeasuredReasons.join(" ")).toContain("could not be parsed");
    expect(
      corrupt.unmeasuredReasons,
      "a corrupt cache reported the same reason as a missing one",
    ).not.toEqual(absent.unmeasuredReasons);
  });

  test("an empty population is UNMEASURED, not a clean sweep", () => {
    // Zero unread criteria out of zero criteria is the number a scan that
    // collected nothing also produces. Said first in `unmeasuredReasons`,
    // because the two counts below it are 0 in both cases.
    withCache({ "SC-9801": entry(1) }, path => {
      const c = behavioralCensus([], path);
      expect(c.reading).toBe("UNMEASURED");
      expect(c.total).toBe(0);
      expect(c.unmeasuredReasons.join(" ")).toContain("collected");
    });
  });

  test("a JSON array is unreadable, not a cache with no entries", () => {
    withCache("[]", p => {
      expect(behavioralCensus(ids, p).cacheState).toBe("unreadable");
    });
  });
});

describe("#758 AC-4: the unmeasured population is bounded both ways", () => {
  // Measured against the cache AS THE REPOSITORY SHIPS IT — absent. The live
  // `.rungate/behavioral-results.json` is untracked and is written by a ship
  // run, so ratcheting against it would make this case red on any machine
  // that had run one and green again after seven days (#507: the margin set
  // by something outside the case).
  function shippedCensus() {
    let c!: ReturnType<typeof behavioralCensus>;
    withCache(null, p => { c = behavioralCensus(tickedBehavioralIds(), p); });
    return c;
  }

  test("AC-4a: it may fall but never rise", () => {
    const c = shippedCensus();
    expect(c.total, "no ticked behavioral criteria were collected at all").toBeGreaterThan(0);
    expect(
      c.unmeasured.length,
      `${c.unmeasured.length} ticked (behavioral) criteria have no reading, ratchet is ` +
        `${UNMEASURED_RATCHET}. A new behavioral criterion with nothing able to measure ` +
        `it is a criterion that is green because nobody looked. Either give it a reading, ` +
        `or raise UNMEASURED_RATCHET in this file with the date and the reason.\n  ` +
        c.unmeasured.join("\n  "),
    ).toBeLessThanOrEqual(UNMEASURED_RATCHET);
  });

  test("AC-4b: progress is banked in the commit that earns it", () => {
    const c = shippedCensus();
    expect(
      UNMEASURED_RATCHET - c.unmeasured.length,
      `the unmeasured population is now ${c.unmeasured.length}; lower UNMEASURED_RATCHET ` +
        `to ${c.unmeasured.length} in this file, with the date, so the next rise is caught ` +
        `from the number you earned rather than from the one before it.`,
    ).toBe(0);
  });

  test("AC-4c: this ratchet and the ticked-population ratchet are held apart", () => {
    // Both are 35 today, and two numbers that cannot differ are one number.
    // The relationship is what is asserted, so the day a criterion gains a
    // reading they diverge and this case names which one moved.
    const c = shippedCensus();
    const ticked = tickedBehavioralIds().length;
    expect(
      c.unmeasured.length,
      "more criteria are unread than exist, which is arithmetically impossible",
    ).toBeLessThanOrEqual(ticked);
    expect(
      c.unmeasured.length,
      `${ticked - c.unmeasured.length} ticked behavioral criteria now have a reading in ` +
        `the repository as it ships. That is the thing #758 is about and it is good news: ` +
        `lower UNMEASURED_RATCHET and say in the comment what started measuring them.`,
    ).toBe(ticked);
  });

  test("the live cache is reported, and never ratcheted", () => {
    // A reading of machine state, asserted only for shape. Whatever a
    // developer's tree holds, the census must answer with one of three
    // states rather than throwing or inventing a fourth.
    const c = behavioralCensus(tickedBehavioralIds(), join(import.meta.dir, "..", ".rungate", "behavioral-results.json"));
    expect(["absent", "unreadable", "present"]).toContain(c.cacheState);
    console.log(`#758 live tree — ${behavioralCensusLine(c)}`);
  });
});

describe("#758 AC-6: the number is justified where it is declared", () => {
  test("the ratchet carries a date and an issue in the comment above it", () => {
    // Search the slice, not the document: this file names #758 and a date in
    // its header, so a whole-file search would be satisfied by prose about
    // the rule rather than by the justification the rule demands.
    const src = readFileSync(import.meta.path, "utf-8");
    const at = src.indexOf("const UNMEASURED_RATCHET =");
    expect(at, "the ratchet declaration moved or was renamed").toBeGreaterThan(-1);

    const open = src.lastIndexOf("/**", at);
    expect(open, "the ratchet carries no docblock at all").toBeGreaterThan(-1);
    const justification = src.slice(open, at);
    expect(justification.length, "the slice between the docblock and the constant is empty").toBeGreaterThan(0);

    expect(justification, "the justification names no issue").toContain("#758");
    expect(
      /\b20\d\d-\d\d-\d\d\b/.test(justification),
      `the justification carries no date, so nobody can tell when ${UNMEASURED_RATCHET} was true:\n${justification}`,
    ).toBe(true);
    expect(
      justification,
      "the justification does not state the number it is justifying",
    ).toContain(String(UNMEASURED_RATCHET));
  });
});

describe("#758: the one decider", () => {
  test("every consumer of freshness routes through behavioralReading", () => {
    // The collapse, asserted rather than promised. `behavioralPattern` and
    // the census both ask this function; a second freshness test anywhere
    // would always agree with it and no case here could tell them apart.
    expect(behavioralReading(undefined)).toBe("absent");
    expect(behavioralReading(entry(1))).toBe("fresh-pass");
    expect(behavioralReading(entry(1, false))).toBe("fresh-fail");
    expect(behavioralReading(entry(8))).toBe("stale");
    expect(
      behavioralReading({ passed: true, evidence: "", timestamp: "not a date" }),
      "an undateable reading read as brand new",
    ).toBe("absent");
  });
});
