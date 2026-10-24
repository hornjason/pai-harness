/**
 * #1552 — every `specs/` write goes through `lib/write-spec.ts`, and a raw
 * write primitive aimed at a spec path outside it is named.
 *
 * ## What this replaces, and what it cannot
 *
 * #1286 and #1549 guarded thirteen spec write paths one at a time. The
 * measured forget rate was 2 of 12, and both misses were found by re-deriving
 * the population rather than by any check — because the check was a per-FILE
 * classification sweep, and list membership is not reachability. It failed
 * when a known writer was unclassified; it could not fail when somebody added
 * a new unguarded one, and it was blind to a second write site inside an
 * already-classified file (#1548).
 *
 * The sweep here reads CALL SITES and their target expressions, so both of
 * those holes close. What it still cannot see is a path assembled across more
 * than `EXPANSION_DEPTH` statements, or handed in as a function parameter —
 * `hooks/DocHygiene.hook.ts` is exactly that, and it is carried below as a
 * declared `GUARDED_UPSTREAM` entry with its guard asserted, which is the one
 * thing the old file-level sweep did that this one does not.
 *
 * ## Read the baseline row first
 *
 * `BASELINE` runs before every mutation row. The check is green today with
 * nineteen migrated call sites, so a green reading proves nothing on its own:
 * the rows that matter are the planted violation, the reverted migration, and
 * the mutated decider.
 *
 * ## One decider
 *
 * `mayWrite` in `lib/derived-spec.ts` owns the refusal. `writeSpec` consults
 * it and routes the answer; it holds no comparison of its own. Two guards
 * answering one question are behaviourally one guard and no behavioural test
 * can tell them apart — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. The mutation rows below
 * replace `mayWrite`'s single comparison and watch `writeSpec` flip, which is
 * only possible because there is nothing else in the path to hold it up.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  CHOKEPOINT,
  EXPANSION_DEPTH,
  NOT_A_SPEC_PATH,
  SWEPT_DIRS,
  WRITE_PRIMITIVES,
  blankComments,
  expandView,
  shellCorpus,
  shellSpecWrites,
  specChokepointViolations,
  writeSites,
  type WriteSite,
} from "../lib/spec-write-sweep";
import { writeSpec, maySpecBeWritten } from "../lib/write-spec";
import { DERIVED_KEY } from "../lib/derived-spec";

const REPO = join(import.meta.dir, "..");
const GUARD_SOURCE = join(REPO, "lib", "derived-spec.ts");
const CHOKEPOINT_SOURCE = join(REPO, CHOKEPOINT);

/** The one line the write decision is made on, in `lib/derived-spec.ts`. */
const DECISION = 'return reading.status === "authored";';
/** Always-writable: the pre-#1286 behaviour, and the shape of the regression. */
const ALWAYS_WRITABLE = "return true;";

const scratch: string[] = [];
function tempRoot(tag: string): string {
  const d = mkdtempSync(join(import.meta.dir, `.chokepoint-${tag}-`));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Write a source file into a fixture tree, creating its directory. */
function plant(root: string, rel: string, src: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, src);
}

// ── The real tree ─────────────────────────────────────────────────

describe("#1552: the real tree routes every spec write through the chokepoint", () => {
  test("BASELINE: no raw write primitive aims at a spec path", () => {
    const sites = writeSites(REPO);
    // Vacuity control, read before the verdict: a sweep that found nothing
    // classifies perfectly and means nothing.
    expect(sites.length, "the sweep found no write sites at all").toBeGreaterThan(100);
    expect(
      specChokepointViolations(REPO).map((s) => `${s.file}:${s.line} ${s.target}`),
      `a raw write primitive aims at a spec path outside ${CHOKEPOINT}. Route it ` +
        `through writeSpec(), or — if the target is not a spec — add it to ` +
        `NOT_A_SPEC_PATH in lib/spec-write-sweep.ts with what it writes instead (#1552)`,
    ).toEqual([]);
  });

  test("POSITIVE CONTROL: the chokepoint's own write is the one site the sweep sees", () => {
    // Without this row the green above is satisfied by a detector that sees
    // nothing. The chokepoint really does write a spec path, and the
    // instrument really does find it — by name, not by count.
    const seen = writeSites(REPO)
      .filter((s) => s.specTargeting)
      .map((s) => s.file);
    expect(seen).toEqual([CHOKEPOINT]);
  });

  test("NEGATIVE CONTROL: writes that need no guard are scanned and stay unflagged", () => {
    // A guard that flags every write site is not more accurate, just louder.
    // Each of these is in the population — asserted, not assumed — and each
    // is unflagged for a reason recorded beside it.
    const reasons: Record<string, string> = {
      "lib/organize.ts::agentsPath": "AGENTS.md — the routing table, not a spec",
      "lib/scaffold/steps.ts::tsconfigPath": "a consumer's tsconfig.json",
      "lib/scaffold/steps.ts::gitignorePath": "a consumer's .gitignore",
    };
    const sites = writeSites(REPO);
    for (const [key, why] of Object.entries(reasons)) {
      const [file, target] = key.split("::");
      const hit = sites.filter((s) => s.file === file && s.target === target);
      expect(hit.length, `${key} is no longer in the scanned population (${why})`).toBeGreaterThan(
        0,
      );
      expect(
        hit.filter((s) => s.specTargeting),
        `${key} was flagged, and it is not a spec: ${why}`,
      ).toEqual([]);
    }
  });

  test("nothing is grandfathered: NOT_A_SPEC_PATH is empty, and no entry is stale", () => {
    // Every real spec write was MIGRATED, not exempted — that is the
    // difference between a chokepoint and a longer exemption list. The
    // mechanism stays for the first genuine over-report, and is exercised
    // against a fixture below rather than against this tree.
    expect(
      Object.keys(NOT_A_SPEC_PATH),
      "an entry here is a spec writer that was exempted instead of migrated — " +
        "route it through writeSpec(), or justify what it writes instead",
    ).toEqual([]);
    const keys = new Set(writeSites(REPO).map((s) => `${s.file}::${s.target}`));
    expect(
      Object.keys(NOT_A_SPEC_PATH).filter((k) => !keys.has(k)),
      "these sites no longer exist — delete the entry",
    ).toEqual([]);
  });
});

// ── Planting a violation, and watching it fire ───────────────────

describe("#1552: the check fires on a raw spec write", () => {
  /**
   * One fixture file holding both halves of the question: a write at a spec
   * path, and a write that legitimately needs no guard. Executed, not
   * described — a comment claiming a property is the reason nobody asserts it.
   */
  const FIXTURE = `
import { writeFileSync } from "fs";
import { join } from "path";

export function stampEverySpec(root: string, body: string): void {
  const specsDir = join(root, "specs");
  const target = join(specsDir, "OVERWRITTEN.md");
  // The regression: bytes on a spec path, no chokepoint.
  writeFileSync(target, body);
}

export function writeReport(root: string, json: string): void {
  // The negative control: a run artefact under the work dir. Nothing owns
  // these bytes but this process, so no guard applies and none is wanted.
  const reportPath = join(root, ".rungate", "findings.json");
  writeFileSync(reportPath, json);
}
`;

  let root: string;
  let found: WriteSite[];

  beforeAll(() => {
    root = tempRoot("planted");
    plant(root, "lib/unguarded.ts", FIXTURE);
    found = specChokepointViolations(root, ["lib"]);
  });

  test("the planted spec write is named, with its file, line and target", () => {
    expect(found.map((s) => `${s.file}:${s.target}`)).toEqual(["lib/unguarded.ts:target"]);
    expect(found[0].primitive).toBe("writeFileSync");
    // Counted independently of the sweep, so the line is a reading and not a
    // restatement: a report pointing at the wrong line is a report nobody can
    // act on, and off-by-one is invisible in a `toEqual([])`.
    const expected = FIXTURE.split("\n").findIndex((l) => l.includes("writeFileSync(target")) + 1;
    expect(found[0].line, "the reported line is the call, not the file").toBe(expected);
  });

  test("the exemption mechanism works, and is not used by this tree", () => {
    // Exercised against the fixture precisely because the real map is empty.
    // An untested escape hatch is the one that gets reached for while stuck.
    expect(
      specChokepointViolations(root, ["lib"], {
        "lib/unguarded.ts::target": "a fixture, classified to prove the lane exists",
      }),
    ).toEqual([]);
  });

  test("the legitimate write in the same file is scanned and not flagged", () => {
    const all = writeSites(root, ["lib"]);
    expect(all.map((s) => s.target).sort()).toEqual(["reportPath", "target"]);
    expect(all.find((s) => s.target === "reportPath")!.specTargeting).toBe(false);
  });

  test("routing the same write through writeSpec clears it", () => {
    // The remedy the failure message names, executed. Without this row the
    // check could be satisfied by something no caller can actually do.
    const fixed = tempRoot("fixed");
    plant(
      fixed,
      "lib/unguarded.ts",
      FIXTURE.replace("writeFileSync(target, body);", "writeSpec(target, body);"),
    );
    expect(specChokepointViolations(fixed, ["lib"])).toEqual([]);
  });
});

describe("#1552: reverting a real migration reddens the check", () => {
  /**
   * What was broken to make the new case fail, on REAL source rather than a
   * fixture: `scripts/sync-sc-status.ts`'s tick write is put back the way it
   * was before this issue, and the sweep names it.
   *
   * A fixture proves the detector works on code somebody wrote for it. This
   * proves it works on the code that was actually migrated, and it re-checks
   * that on every run — so a later refactor that puts the raw write back
   * cannot pass quietly.
   */
  const MIGRATED = "writeSpec(filePath, content, { label: specFile });";
  const REVERTED = "writeFileSync(filePath, content);";

  test("the migrated spelling appears exactly once, so the revert is unambiguous", () => {
    const src = readFileSync(join(REPO, "scripts", "sync-sc-status.ts"), "utf-8");
    expect(
      src.split(MIGRATED).length - 1,
      "the call this row reverts has moved — re-derive the revert before trusting the red",
    ).toBe(1);
  });

  test("the reverted source is named by the sweep", () => {
    const root = tempRoot("reverted");
    const src = readFileSync(join(REPO, "scripts", "sync-sc-status.ts"), "utf-8");
    plant(root, "scripts/sync-sc-status.ts", src.replace(MIGRATED, REVERTED));
    const violations = specChokepointViolations(root, ["scripts"]);
    expect(violations.map((s) => `${s.file}::${s.target}`)).toEqual([
      "scripts/sync-sc-status.ts::filePath",
    ]);
  });

  test("the UNREVERTED source is clean in the same fixture tree", () => {
    // The control for the row above: same sweep, same directory shape, the
    // real bytes. A red that appears for both is a red about the tree, not
    // about the revert.
    const root = tempRoot("unreverted");
    plant(
      root,
      "scripts/sync-sc-status.ts",
      readFileSync(join(REPO, "scripts", "sync-sc-status.ts"), "utf-8"),
    );
    expect(specChokepointViolations(root, ["scripts"])).toEqual([]);
  });
});

// ── Shell ────────────────────────────────────────────────────────

describe("#1552: shell redirects into specs/ are covered, and there are none", () => {
  test("BASELINE: the shell corpus is non-empty and holds no spec write", () => {
    const corpus = shellCorpus(REPO);
    expect(corpus.length, "nothing shell-shaped was scanned — the reading is vacuous").toBeGreaterThan(
      5,
    );
    expect(shellSpecWrites(REPO)).toEqual([]);
  });

  test("a planted redirect, tee and sed -i into specs/ each fire", () => {
    const root = tempRoot("shell");
    plant(
      root,
      "scripts/bad.sh",
      [
        "#!/usr/bin/env bash",
        'echo "- [x] done" > specs/MY-SPEC.md',
        'echo more | tee -a specs/OTHER-SPEC.md',
        "sed -i '' 's/a/b/' specs/THIRD-SPEC.md",
      ].join("\n"),
    );
    const hits = shellSpecWrites(root, ["scripts/bad.sh"]);
    expect(hits.map((h) => h.primitive)).toEqual(["redirect", "tee", "sed-i"]);
  });

  test("a redirect that is not into specs/ does not fire", () => {
    const root = tempRoot("shell-neg");
    plant(
      root,
      "scripts/fine.sh",
      ["#!/usr/bin/env bash", 'echo hi > /tmp/out.txt', "sed -i '' 's/a/b/' README.md"].join("\n"),
    );
    expect(shellSpecWrites(root, ["scripts/fine.sh"])).toEqual([]);
  });

  test("a commented-out redirect is not a write", () => {
    const root = tempRoot("shell-comment");
    plant(root, "scripts/c.sh", "# echo x > specs/A-SPEC.md");
    expect(shellSpecWrites(root, ["scripts/c.sh"])).toEqual([]);
  });
});

// ── One decider: mutating mayWrite reaches every writeSpec case ──

describe("#1552: mayWrite owns the refusal and writeSpec adds no second one", () => {
  let mutantWriteSpec: typeof writeSpec;
  let mutantDir: string;

  const DERIVED_SPEC = `---
doc-type: spec
governs: a fixture
${DERIVED_KEY}: scripts/sync-spec.ts
---

# Fixture
`;

  beforeAll(async () => {
    mutantDir = tempRoot("mutant");
    mkdirSync(join(mutantDir, "lib"), { recursive: true });
    const guard = readFileSync(GUARD_SOURCE, "utf-8");
    // Asserted below as well, but the build must refuse too: at zero the
    // mutant is a copy of the original and every row below is vacuous.
    if (guard.split(DECISION).length - 1 !== 1) {
      throw new Error("the write decision is not a single site — the mutant means nothing");
    }
    writeFileSync(join(mutantDir, "lib", "derived-spec.ts"), guard.replace(DECISION, ALWAYS_WRITABLE));
    writeFileSync(
      join(mutantDir, "lib", "write-spec.ts"),
      readFileSync(CHOKEPOINT_SOURCE, "utf-8"),
    );
    mutantWriteSpec = (await import(join(mutantDir, "lib", "write-spec.ts"))).writeSpec;
  });

  test("BASELINE: the real chokepoint refuses a derived spec and says why", () => {
    const root = tempRoot("real-write");
    const p = join(root, "D.md");
    writeFileSync(p, DERIVED_SPEC);
    const result = writeSpec(p, "REPLACED");
    expect(result.written).toBe(false);
    expect(result.reading.status).toBe("derived");
    expect(result.refusal).toContain("scripts/sync-spec.ts");
    expect(readFileSync(p, "utf-8"), "the bytes on disk did not move").toBe(DERIVED_SPEC);
  });

  test("NEGATIVE CONTROL: the real chokepoint writes an authored spec", () => {
    // Without this, "it refused" is satisfied by a chokepoint that refuses
    // everything — and a mutant that failed to load would be unattributable.
    const root = tempRoot("real-authored");
    const p = join(root, "A.md");
    writeFileSync(p, "---\ndoc-type: spec\n---\n\n# Plain\n");
    expect(writeSpec(p, "REPLACED").written).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("REPLACED");
  });

  test("a path that does not exist yet is a creation, and is written", () => {
    const root = tempRoot("create");
    const p = join(root, "NEW.md");
    expect(existsSync(p)).toBe(false);
    expect(writeSpec(p, "fresh").written).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("fresh");
  });

  test("MUTANT: removing mayWrite's comparison makes the chokepoint write the derived spec", () => {
    const root = tempRoot("mutant-write");
    const p = join(root, "D.md");
    writeFileSync(p, DERIVED_SPEC);
    const result = mutantWriteSpec(p, "REPLACED");
    // The whole point: one mutation, in the module that is supposed to own
    // the decision, reaches the chokepoint. If writeSpec held a second
    // comparison this row would stay green and nothing would say so.
    expect(result.written).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("REPLACED");
  });

  test("MUTANT: the early consult flips with it, so both land on one decider", () => {
    const mutantMay = require(join(mutantDir, "lib", "write-spec.ts"))
      .maySpecBeWritten as typeof maySpecBeWritten;
    expect(maySpecBeWritten(DERIVED_SPEC).allowed, "the real early consult refuses").toBe(false);
    expect(mutantMay(DERIVED_SPEC).allowed, "the mutant early consult permits").toBe(true);
  });

  test("the write decision appears exactly once in lib/derived-spec.ts", () => {
    expect(
      readFileSync(GUARD_SOURCE, "utf-8").split(DECISION).length - 1,
      "a second site turning a reading into a write survives any mutation of the first",
    ).toBe(1);
  });

  test("lib/write-spec.ts holds no decision of its own", () => {
    // The fourth shape, asserted rather than trusted: the chokepoint must
    // not compare a status, or it becomes a second decider and the mutation
    // rows above stop meaning what they say.
    const src = readFileSync(CHOKEPOINT_SOURCE, "utf-8");
    const code = blankComments(src);
    expect(
      [...code.matchAll(/\.status\s*[=!]==?/g)].map((m) => m[0]),
      "writeSpec compares a DerivedStatus — call mayWrite instead",
    ).toEqual([]);
    expect(code).toContain("mayWrite(");
  });

  test("the chokepoint keeps exactly one relative import, so the mutant binds", () => {
    // A mutant that resolves the REAL derived-spec is unmutated, and reads
    // identically to a guard that held.
    const src = readFileSync(CHOKEPOINT_SOURCE, "utf-8");
    expect([...src.matchAll(/from "(\.[^"]*)"/g)].map((m) => m[1])).toEqual(["./derived-spec"]);
  });

  test("the mutant guard really differs from the real one", () => {
    expect(readFileSync(join(mutantDir, "lib", "derived-spec.ts"), "utf-8")).not.toBe(
      readFileSync(GUARD_SOURCE, "utf-8"),
    );
  });
});

// ── What the chokepoint does not reach ───────────────────────────

describe("#1552: writers the static sweep cannot see are declared, not silent", () => {
  /**
   * A write whose target is a function parameter or external input. The sweep
   * cannot resolve it, so its absence from the violation list is the detector
   * being blind, not the site being safe — and silence is not a classification.
   *
   * The value is the module that holds the guard. The obligation moves; it
   * does not disappear. This is the one property #1286's per-file sweep had
   * that the call-site sweep does not, carried forward on its own rather than
   * by keeping a whole second mechanism.
   */
  const GUARDED_UPSTREAM: Record<string, string> = {
    "hooks/DocHygiene.hook.ts": "lib/frontmatter.ts",
  };

  for (const [writer, guard] of Object.entries(GUARDED_UPSTREAM)) {
    test(`${writer} cannot write unless ${guard} permits it`, () => {
      const guardSrc = readFileSync(join(REPO, guard), "utf-8");
      expect(guardSrc, `${guard} must call mayWrite`).toContain("mayWrite(");
      expect(guardSrc, `${guard} must import the binding`).toMatch(
        /from ["']\.[^"']*\/derived-spec["']/,
      );
      const writerSrc = readFileSync(join(REPO, writer), "utf-8");
      const mod = guard.replace(/^lib\//, "").replace(/\.ts$/, "");
      expect(writerSrc, `${writer} must go through ${guard}`).toContain(mod);
    });
  }

  test("the target expression is still what the sweep reads", () => {
    // If someone widens the detector to the whole line, this blindness
    // disappears and so does the reason for the list above. Then delete it.
    expect(
      writeSites(REPO).find((s) => s.file === "hooks/DocHygiene.hook.ts")?.specTargeting,
      "the sweep can now see DocHygiene's target — drop the GUARDED_UPSTREAM entry",
    ).toBe(false);
  });
});

// ── The instrument's own parts ───────────────────────────────────

describe("#1552: the sweep's reading is what it claims", () => {
  test("a write inside a comment is not a call site", () => {
    const root = tempRoot("comments");
    plant(
      root,
      "lib/c.ts",
      [
        "// writeFileSync(specPath, x)",
        "/* writeFileSync(specPath, y) */",
        'const url = "https://example.com/specs/a.md";',
        "export const n = 1;",
      ].join("\n"),
    );
    expect(writeSites(root, ["lib"])).toEqual([]);
  });

  test("blankComments preserves every byte offset", () => {
    const src = 'const a = 1; // writeFileSync\nconst b = "//not a comment";\n';
    const out = blankComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toContain('"//not a comment"');
    expect(out).not.toContain("writeFileSync");
  });

  test("a quote inside a regex literal does not open a string", () => {
    // `lib/` holds `/from ["']\\.[^"']*\\/derived-spec["']/`. Treating the
    // `"` inside it as a string opener swallows the rest of the file, and
    // every call site after it vanishes — a sweep that silently shrinks.
    const src = 'const re = /["\']x/; writeFileSync(specPath, v);';
    expect(blankComments(src)).toContain("writeFileSync(specPath, v)");
  });

  test(`the view follows ${EXPANSION_DEPTH} links of local initialiser`, () => {
    // Measured, not chosen: `scripts/split-spec.ts` needs three to reach the
    // word "spec", and at one link that write is invisible.
    const src = [
      'const parentDir = dirname(specPath);',
      'const splitDir = join(parentDir, dirName);',
      'const filePath = join(splitDir, name);',
    ].join("\n");
    expect(expandView(src, "filePath")).toMatch(/spec/i);
    expect(expandView(src, "unrelated"), "an unknown identifier expands to itself").toBe(
      "unrelated",
    );
  });

  test("an identifier inside a string literal is not expanded", () => {
    // `join(root, "AGENTS.md")` yielded `md`, which matched an unrelated
    // `const md = …` elsewhere in the file and spliced its text into the
    // view. That alone put four AGENTS.md and CLAUDE.md writes on the
    // violation list, each for a word inside a filename.
    const src = ['const md = buildSpecMap();', 'const p = join(root, "AGENTS.md");'].join("\n");
    expect(expandView(src, "p")).not.toMatch(/spec/i);
  });

  test("every primitive in WRITE_PRIMITIVES is actually detected", () => {
    const root = tempRoot("primitives");
    plant(
      root,
      "lib/p.ts",
      WRITE_PRIMITIVES.map((p, i) => `${p}(specPath${i}, v);`).join("\n"),
    );
    expect(writeSites(root, ["lib"]).map((s) => s.primitive).sort()).toEqual(
      [...WRITE_PRIMITIVES].sort(),
    );
  });

  test("a member call is seen; a name that merely ends in a primitive is not", () => {
    // Both halves, because the first draft of this sweep got the second right
    // by excluding `.` from the lookbehind — and that made
    // `require("fs").writeFileSync(reportPath, …)` in `lib/conformity.ts`
    // invisible. This row is why the detector is two sites wider than it was.
    const root = tempRoot("suffix");
    plant(
      root,
      "lib/s.ts",
      ["safeWriteFileSync(specPath, v);", "fs.writeFileSync(specPath, v);"].join("\n"),
    );
    const sites = writeSites(root, ["lib"]);
    expect(sites.map((s) => s.line)).toEqual([2]);
  });

  test("the swept directories are the ones the issue enumerated", () => {
    expect([...SWEPT_DIRS]).toEqual(["lib", "scripts", "gates", "bin", "hooks"]);
    for (const d of SWEPT_DIRS) expect(existsSync(join(REPO, d)), `${d}/ exists`).toBe(true);
  });
});
