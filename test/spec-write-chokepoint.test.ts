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
import { tmpdir } from "os";
import { join } from "path";
import {
  CHOKEPOINT,
  NOT_A_SPEC_PATH,
  OPAQUE_RATCHET,
  REASSIGNABLE_TARGETS,
  SWEPT_DIRS,
  SWEPT_JS_DIRS,
  WRITE_PRIMITIVES,
  declaredOpaque,
  opaqueDrift,
  opaqueFingerprint,
  shellCorpus,
  shellSpecWrites,
  specChokepointViolations,
  undeterminedTargets,
  writeSites,
  type WriteSite,
} from "../lib/spec-write-sweep";
import { EXPANSION_DEPTH, specTargetingOf, writeSitesIn } from "../lib/spec-write-ast";
import { parseTsModule } from "../lib/ts-ast";
import { writeSpec, maySpecBeWritten, maySpecBeReplaced } from "../lib/write-spec";
import { DERIVED_KEY } from "../lib/derived-spec";

const REPO = join(import.meta.dir, "..");
const GUARD_SOURCE = join(REPO, "lib", "derived-spec.ts");
const CHOKEPOINT_SOURCE = join(REPO, CHOKEPOINT);

/** The one line the write decision is made on, in `lib/derived-spec.ts`. */
const DECISION = 'return reading.status === "authored";';
/** Always-writable: the pre-#1286 behaviour, and the shape of the regression. */
const ALWAYS_WRITABLE = "return true;";

const scratch: string[] = [];
/**
 * No intermediate binding on purpose. `const d = mkdtempSync(join(
 * import.meta.dir, …))` reads as a repo-root identifier to the frozen
 * reference in `test/scratch-cleanup.test.ts` and not to the live parse
 * (#1482), which makes that census test red for a correct change and has to
 * be retired with a per-file carve-out. Pushing straight onto the list costs
 * one line and leaves the check in full force here.
 */
function tempRoot(tag: string): string {
  scratch.push(mkdtempSync(join(import.meta.dir, `.chokepoint-${tag}-`)));
  return scratch[scratch.length - 1];
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

  test("#1566: every reassignable target is declared, and no declaration is stale", () => {
    // The second reading the green above needs. A target built from a `let`
    // is one whose value at the write cannot be established, so without this
    // it reads exactly like a target the resolver followed and cleared.
    expect(
      undeterminedTargets(REPO).map((s) => `${s.file}::${s.target}`),
      "this write's target is built from a let/var, so the sweep cannot say " +
        "what it writes. Make the binding const, or add it to " +
        "REASSIGNABLE_TARGETS in lib/spec-write-sweep.ts with what it writes (#1566)",
    ).toEqual([]);

    // VACUITY CONTROL: the declared list must be non-empty and every entry
    // must still be in the population. An empty list with an empty verdict is
    // the two-empty-collections shape, and a stale entry is an exemption for
    // a site that no longer exists.
    const reassignable = new Set(
      writeSites(REPO)
        .filter((s) => s.reassignable)
        .map((s) => `${s.file}::${s.target}`),
    );
    expect(reassignable.size, "no site on this tree is reassignable — is the flag wired?").toBe(
      Object.keys(REASSIGNABLE_TARGETS).length,
    );
    expect(
      Object.keys(REASSIGNABLE_TARGETS).filter((k) => !reassignable.has(k)),
      "these sites are no longer reassignable — delete the entry",
    ).toEqual([]);
  });

  test("#1584: every opaque site is declared, and no declaration is stale", () => {
    // The consumer `opaque` did not have. A target the resolver could not
    // follow read identically to one it followed and cleared, because nothing
    // downstream distinguished the two — a fourth state no consumer reads is
    // the same as not having it.
    const { added, removed } = opaqueDrift(REPO);
    expect(
      added,
      `these write sites are OPAQUE — the sweep cannot establish what they ` +
        `write — and ${OPAQUE_RATCHET} does not say so. Resolve the target, or ` +
        `add the line verbatim to that file's \`sites\` array (#1584)`,
    ).toEqual([]);
    expect(
      removed,
      `${OPAQUE_RATCHET} declares these and the tree no longer has them. ` +
        `Delete the line in the same commit that earned it — a ratchet nobody ` +
        `lowers is a number nobody can interpret`,
    ).toEqual([]);
  });

  test("#1584: the opaque ratchet refuses in both directions, and an absent one is UNMEASURED", () => {
    // The gate above is an equality against a file I generated from the tree
    // it measures, so on its own it cannot tell a working ratchet from one
    // that compares two empty lists. These rows plant the three events.
    const root = mkdtempSync(join(tmpdir(), "rg1584-ratchet-"));
    try {
      mkdirSync(join(root, ".claude"), { recursive: true });
      mkdirSync(join(root, "lib"), { recursive: true });
      const ratchet = join(root, OPAQUE_RATCHET);
      const site = 'export function w(p: string) { writeFileSync(p, "x"); }\n';
      writeFileSync(join(root, "lib", "w.ts"), site);

      // UNMEASURED: no store at all is not an empty population.
      expect(() => opaqueDrift(root, ["lib"])).toThrow(/UNMEASURED/);
      writeFileSync(ratchet, JSON.stringify({ note: "", declared: [] }));
      expect(
        () => opaqueDrift(root, ["lib"]),
        "a store with no `sites` key read as an empty population",
      ).toThrow(/UNMEASURED/);

      // ADDED: an undeclared opaque site.
      writeFileSync(ratchet, JSON.stringify({ sites: [] }));
      const first = opaqueDrift(root, ["lib"]);
      expect(first.added).toEqual(["lib/w.ts::p | p: parameter"]);
      expect(first.removed).toEqual([]);

      // DECLARED: the same tree, written down. This is the negative control —
      // without it the row above passes for a gate that flags everything.
      writeFileSync(ratchet, JSON.stringify({ sites: first.added }));
      expect(opaqueDrift(root, ["lib"])).toEqual({ added: [], removed: [] });

      // CHANGED HOLES: same file, same target, a different reason. A ratchet
      // keyed on the site alone would stay green through this.
      writeFileSync(join(root, "lib", "w.ts"), 'import { p } from "./x";\nwriteFileSync(p, "y");\n');
      const changed = opaqueDrift(root, ["lib"]);
      expect(changed.added).toEqual(["lib/w.ts::p | p: import"]);
      expect(changed.removed).toEqual(["lib/w.ts::p | p: parameter"]);

      // MULTISET: three sites with the same fingerprint are three entries, so
      // a second and third copy cannot arrive under cover of the first.
      // Distinct function names, because re-declaring one name is not valid
      // TypeScript and Bun's transpiler drops all but the last declaration —
      // a fixture written that way measures the transpiler, not the ratchet.
      writeFileSync(
        join(root, "lib", "w.ts"),
        ["a", "b", "c"].map((n) => site.replace(" w(", ` ${n}(`)).join(""),
      );
      writeFileSync(ratchet, JSON.stringify({ sites: ["lib/w.ts::p | p: parameter"] }));
      expect(opaqueDrift(root, ["lib"]).added).toHaveLength(2);

      // REMOVED: the site resolves now, and the entry outlived it.
      writeFileSync(join(root, "lib", "w.ts"), 'const p = "out.txt";\nwriteFileSync(p, "x");\n');
      const gone = opaqueDrift(root, ["lib"]);
      expect(gone.added).toEqual([]);
      expect(gone.removed).toEqual(["lib/w.ts::p | p: parameter"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("#1584: the opaque gate and the reassignable gate are separate claims", () => {
    // Two deciders that agree are behaviourally one decider. Every
    // reassignable site is opaque, so the populations overlap by construction
    // and only their SIZES can say whether the wider one is doing any work.
    const sites = writeSites(REPO).filter((s) => s.file !== CHOKEPOINT);
    const opaque = sites.filter((s) => s.opaque);
    const reassignable = sites.filter((s) => s.reassignable);
    expect(reassignable.every((s) => s.opaque), "reassignable must imply opaque").toBe(true);
    expect(
      opaque.length,
      "the opaque population has collapsed onto the reassignable one — the " +
        "wider reading is no longer witnessing anything the narrow one misses",
    ).toBeGreaterThan(reassignable.length * 2);
    expect(declaredOpaque(REPO)).toHaveLength(opaque.length);
    expect(
      opaque.filter((s) => !declaredOpaque(REPO).includes(opaqueFingerprint(s))),
      "declared by count but not by content",
    ).toEqual([]);
  });

  test("#1566: the undetermined reading is a SEPARATE claim from the violation one", () => {
    // Two deciders that agree are behaviourally one decider. These answer
    // different questions about the same population and the counts must
    // differ, or one of them is dead and no behavioural test can say which.
    const sites = writeSites(REPO);
    const specTargeting = sites.filter((s) => s.specTargeting).length;
    const reassignable = sites.filter((s) => s.reassignable).length;
    expect(specTargeting).toBe(1); // the chokepoint
    expect(reassignable).toBe(Object.keys(REASSIGNABLE_TARGETS).length);
    expect(
      sites.filter((s) => s.specTargeting && s.reassignable),
      "a site is in both populations — the two readings are no longer separable here",
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

describe("#1548: a second unguarded writer inside an already-compliant file", () => {
  /**
   * The shape #1548 was filed for, and the reason it is answered here rather
   * than left open: `addFrontmatterToAdrs` was an unguarded sibling of a
   * guarded function in `lib/validators/spec-validators.ts`, the file was on
   * the old per-FILE list, and the sweep was green. A reviewer found it, and
   * a reviewer is a sampled instrument.
   *
   * The unit here is the call site, so the file being compliant everywhere
   * else buys the second writer nothing.
   */
  const MIXED = `
import { writeFileSync } from "fs";
import { join } from "path";
import { writeSpec } from "./write-spec";

export function stampSpecs(specsDir: string, body: string): void {
  writeSpec(join(specsDir, "A.md"), body);
}

export function stampAdrs(adrDir: string, body: string): void {
  const filePath = join(adrDir, "D.md");
  writeFileSync(filePath, body);
}
`;

  test("the unguarded sibling is named even though the file is otherwise compliant", () => {
    const root = tempRoot("sibling");
    plant(root, "lib/validators.ts", MIXED);
    const found = specChokepointViolations(root, ["lib"]);
    expect(found.map((s) => `${s.file}::${s.target}`)).toEqual(["lib/validators.ts::filePath"]);
  });

  test("an ADR path counts as a derived document, and `quadrant` does not", () => {
    // `mayWrite` asks who PRODUCES a file, not which directory it is in. The
    // boundary anchor is the other half: a bare /adr/i substring would make
    // every `quadrantPath` a derived document.
    const root = tempRoot("boundary");
    plant(
      root,
      "lib/b.ts",
      ["writeFileSync(quadrantPath, v);", "writeFileSync(inspectPath, v);"].join("\n"),
    );
    expect(specChokepointViolations(root, ["lib"])).toEqual([]);
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

  test("a move onto a generator-owned destination is refused, and says why", () => {
    // Round-4 AI-review finding. POSIX rename replaces its destination
    // silently, and `organizeProject` picks that destination from a
    // filename, so a stray `API-SPEC.md` could annihilate a generated spec
    // with no write primitive ever touching it. The question is about the
    // bytes being destroyed, never about the ones being moved.
    const root = tempRoot("replace");
    const dest = join(root, "API-SPEC.md");
    writeFileSync(dest, DERIVED_SPEC);
    const verdict = maySpecBeReplaced(dest, { label: "specs/API-SPEC.md" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal).toContain("specs/API-SPEC.md");
    expect(verdict.refusal).toContain("scripts/sync-spec.ts");
  });

  test("NEGATIVE CONTROL: a move onto an absent or authored destination proceeds", () => {
    // Without this, the guard above is satisfied by refusing every move.
    const root = tempRoot("replace-ok");
    expect(maySpecBeReplaced(join(root, "ABSENT.md")).allowed).toBe(true);
    const authored = join(root, "A.md");
    writeFileSync(authored, "---\ndoc-type: spec\n---\n\n# Plain\n");
    expect(maySpecBeReplaced(authored).allowed).toBe(true);
  });

  test("MUTANT: the move guard flips with mayWrite, so it is not a third decider", () => {
    const mutantReplace = require(join(mutantDir, "lib", "write-spec.ts"))
      .maySpecBeReplaced as typeof maySpecBeReplaced;
    const root = tempRoot("replace-mutant");
    const dest = join(root, "API-SPEC.md");
    writeFileSync(dest, DERIVED_SPEC);
    expect(maySpecBeReplaced(dest).allowed, "the real guard refuses").toBe(false);
    expect(mutantReplace(dest).allowed, "the mutant permits").toBe(true);
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
    // Transpiling drops comments, so a `.status ===` written in prose cannot
    // read as a decision. This replaced a hand-rolled comment blanker (#1566).
    const code = parseTsModule(src)!.js;
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
    // #1552 round 4. `executeProposals` renames a file onto a target chosen
    // from its NAME, and POSIX rename replaces its destination silently, so
    // a stray `API-SPEC.md` at the root can annihilate a generator-owned
    // `specs/API-SPEC.md` without any write primitive touching it. The
    // destination is `join(root, proposal.target)` — dynamic, so the sweep
    // cannot see it is a spec path, and silence here would be blindness.
    "lib/organize.ts": "lib/write-spec.ts",
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

  test("a rename or copy is read at its DESTINATION, not its source", () => {
    // Round-4 AI-review finding. `renameSync(src, dest)` and
    // `copyFileSync(src, dest)` write their second argument; reading the
    // first makes a copy INTO specs/ invisible and a copy OUT of specs/ a
    // false positive. Both directions, because one of them alone is
    // satisfied by reading neither argument.
    const root = tempRoot("dest-arg");
    plant(
      root,
      "lib/cp.ts",
      [
        'copyFileSync(join(assetsDir, "blank.md"), join(specsDir, "NEW-SPEC.md"));',
        'copyFileSync(join(specsDir, "OLD-SPEC.md"), join(backupDir, "copy.md"));',
      ].join("\n"),
    );
    const found = specChokepointViolations(root, ["lib"]);
    expect(found.map((s) => s.line), "only the write INTO specs/ is a violation").toEqual([1]);
    expect(found[0].target).toBe('join(specsDir, "NEW-SPEC.md")');
  });

  test("arguments are split by the parser, whatever the nesting", () => {
    // The depth bug the hand-rolled splitter first shipped with: restarting
    // the scan at each comma lost the depth the open paren contributed, so
    // argument two ran to the end of the file. The parser has no such state
    // to lose — this row is kept as the regression it was written for.
    const sites = writeSitesIn(
      'renameSync(join(a, b), `x${g(1, 2)}y`);\ncopyFileSync(/a,b/.source, "c,d");',
    );
    expect(sites.map((s) => s.target)).toEqual(["`x${g(1, 2)}y`", '"c,d"']);
  });

  test("MECHANICALLY GENERATED: no surrounding fragment hides a planted spec write", () => {
    // Four review rounds found four edge cases in the hand-rolled scanner this
    // replaced, each by example. Examples were what the reviewer called the
    // approach problem, and its own remedy was a generator rather than more
    // examples. The scanner is now a parser (#1566) and the generator is kept:
    // it is what demonstrates the parser is not merely wrong in new places.
    //
    // Bindings are suffixed per POSITION. Without that, `before === after`
    // declares the same `const` twice, which is a genuine SyntaxError — 7 of
    // the 100 cases were invalid programs, and the old scanner never noticed
    // because it never parsed. An invalid fixture tests the parser's error
    // path, not the detector.
    //
    // Every PAIR of fragments from the alphabet is placed before and after a
    // known spec write. The write must be found in all of them, and a known
    // non-spec write in the same contexts must never be.
    const alphabet = (s: string) => [
      "",
      `const re${s} = /["']x/;`,
      `const b${s} = text.replace(/\`/g, "");`,
      `const t${s} = \`a\${nested(\`b\${deep}\`)}c\`;`,
      "// writeFileSync(specPath, commented)",
      "/* writeFileSync(specPath, blocked) */",
      `const s${s} = "a string with specs/ inside it";`,
      `const div${s} = total / count / 2;`,
      `const tagged${s} = sql\`select \${col}\`;`,
      `const obj${s} = { "key, with comma": [1, 2] };`,
    ];
    const BEFORE = alphabet("A");
    const AFTER = alphabet("B");
    const PLANTED = 'writeFileSync(join(specsDir, "PLANTED-SPEC.md"), body);';
    const INNOCENT = 'writeFileSync(join(outDir, "report.json"), body);';

    const missed: string[] = [];
    const falsePositives: string[] = [];
    for (const before of BEFORE) {
      for (const after of AFTER) {
        const root = tempRoot("gen");
        plant(root, "lib/g.ts", [before, PLANTED, INNOCENT, after].join("\n"));
        const found = specChokepointViolations(root, ["lib"]);
        const targets = found.map((s) => s.target);
        if (!targets.includes('join(specsDir, "PLANTED-SPEC.md")')) {
          missed.push(`${before} ⟦…⟧ ${after}`);
        }
        if (targets.includes('join(outDir, "report.json")')) {
          falsePositives.push(`${before} ⟦…⟧ ${after}`);
        }
      }
    }
    expect(BEFORE.length * AFTER.length, "the generator produced no cases").toBe(100);
    expect(missed, "these contexts hid a planted spec write from the sweep").toEqual([]);
    expect(falsePositives, "these contexts made an unrelated write look like a spec").toEqual([]);
  });

  test("a backtick inside a regex literal does not swallow the next statements", () => {
    // Distinct from the row below, and from `blankComments`: the ARGUMENT
    // scanner does its own walk, and it had no regex awareness. `.replace(
    // /`/g, "")` in `lib/conformity.ts` read as a template-literal opener,
    // so an initialiser ran on for four hundred lines and dragged the word
    // "spec" in from unrelated prose. Two writes were flagged for it.
    const root = tempRoot("backtick");
    plant(
      root,
      "lib/t.ts",
      [
        'const out = text.replace(/`/g, "");',
        'const label = "a spec mentioned far away";',
        "writeFileSync(out, body);",
      ].join("\n"),
    );
    const sites = writeSites(root, ["lib"]);
    expect(sites.length).toBe(1);
    expect(sites[0].view, "the view stopped at the statement").not.toMatch(/spec/i);
    expect(sites[0].specTargeting).toBe(false);
  });

  test("a quote inside a regex literal does not open a string", () => {
    // `lib/` holds `/from ["']\\.[^"']*\\/derived-spec["']/`. Treating the
    // `"` inside it as a string opener swallows the rest of the file, and
    // every call site after it vanishes — a sweep that silently shrinks.
    const src = 'const re = /["\']x/; writeFileSync(specPath, v);';
    expect(writeSitesIn(src).map((s) => s.target)).toEqual(["specPath"]);
  });

  test(`the view follows ${EXPANSION_DEPTH} links of local initialiser`, () => {
    // Measured, not chosen: `scripts/split-spec.ts` needs three to reach the
    // word "spec", and at one link that write is invisible.
    const chain = [
      "const parentDir = dirname(specPath);",
      "const splitDir = join(parentDir, dirName);",
      "const filePath = join(splitDir, name);",
    ].join("\n");
    expect(specTargetingOf(writeSitesIn(`${chain}\nwriteFileSync(filePath, b);`)[0]!)).toBe(true);

    // NEGATIVE CONTROL: an identifier with no local binding expands to itself
    // and is reported unresolved rather than resolving to a neighbour's value.
    const lone = writeSitesIn(`${chain}\nwriteFileSync(unrelated, b);`)[0]!;
    expect(lone.view).toBe("unrelated");
    expect(lone.unresolved).toEqual(["unrelated: not-found"]);
  });

  test("a lone backtick in the view does not blind the rest of the chase", () => {
    // The round-3 AI-review finding, verbatim as a fixture. The VIEW is a
    // concatenation of initialiser fragments, not well-formed source, so a
    // backtick captured out of a regex literal really is unterminated there.
    // Swallowing to the end of the string dropped `helper` — and with it the
    // `"specs/report.md"` that makes this a spec write. An unterminated
    // literal is not a literal.
    const root = tempRoot("lone-backtick");
    plant(
      root,
      "lib/chain.ts",
      [
        "const outPath = mask + tail;",
        'const mask = raw.replace(/`/g, "");',
        "const tail = helper;",
        'const helper = "specs/report.md";',
        "writeFileSync(outPath, body);",
      ].join("\n"),
    );
    const found = specChokepointViolations(root, ["lib"]);
    expect(found.map((s) => s.line)).toEqual([5]);
  });

  test("a template literal's ${…} hole is code, and its identifiers are chased", () => {
    // The round-2 AI-review finding on this PR. Blanking the whole template
    // span erased `outDir`, so the view had nothing to chase, the literal
    // text named no spec, and a raw write straight to a spec path reported
    // nothing — "passes on an input it never looked at", in the sweep built
    // to end exactly that.
    const root = tempRoot("template");
    plant(
      root,
      "lib/tpl.ts",
      ["const outDir = specsDir;", "writeFileSync(`${outDir}/REPORT.md`, body);"].join("\n"),
    );
    const found = specChokepointViolations(root, ["lib"]);
    expect(found.map((s) => s.line)).toEqual([2]);
  });

  test("a template's literal text is still not a source of identifiers", () => {
    // The other half: keeping the holes must not re-open the `AGENTS.md` →
    // `md` bleed the blanking was added for.
    const root = tempRoot("template-neg");
    plant(
      root,
      "lib/tpl2.ts",
      ["const md = buildSpecMap();", "const dir = base;", "writeFileSync(`${dir}/AGENTS.md`, v);"].join(
        "\n",
      ),
    );
    expect(specChokepointViolations(root, ["lib"])).toEqual([]);
  });

  test("an identifier inside a string literal is not expanded", () => {
    // `join(root, "AGENTS.md")` yielded `md`, which matched an unrelated
    // `const md = …` elsewhere in the file and spliced its text into the
    // view. That alone put four AGENTS.md and CLAUDE.md writes on the
    // violation list, each for a word inside a filename.
    const src = [
      "const md = buildSpecMap();",
      'const p = join(root, "AGENTS.md");',
      "writeFileSync(p, v);",
    ].join("\n");
    expect(specTargetingOf(writeSitesIn(src)[0]!)).toBe(false);
  });

  test("no fragment can make the harvester stop reading before the end", () => {
    // Three AI-review rounds on this PR found three instances of ONE defect:
    // the scanner's view of its input silently shrinking. Round 1 was the
    // first-declaration-only lookup, round 2 the blanked template hole,
    // round 3 a lone backtick swallowing to EOF. A fourth instance is not
    // worth waiting for, so this asserts the PROPERTY instead of another
    // case — which is what `.claude/rules/checks-must-be-able-to-fail.md`
    // says to do when a guard's view of its input can shrink: assert on the
    // view itself.
    //
    // The invariant, restated for a parser (#1566): appending a fresh
    // identifier to any fragment must either put that identifier in the view,
    // or REFUSE. What is forbidden is the third outcome — parsing happily and
    // silently losing the tail, which is what every one of those three rounds
    // actually did. An unparseable fragment now throws UNMEASURED, so the
    // shrink cannot be silent.
    const MARKER = "zzTrailingMarker";
    const fragments = [
      "`", // lone backtick — round 3
      '"', // lone double quote
      "'", // lone single quote
      "/", // lone slash
      'raw.replace(/`/g, "")', // the round-3 chain's middle link
      "`${outDir}/X.md`", // a well-formed template
      '`${`${deep}`}`', // nested templates
      "/[\"']x/", // a regex holding both quote characters
      "join(a, `b`, 'c', \"d\")",
      "a + `unclosed ${b}",
      "`text` + ident",
    ];
    let parsed = 0;
    let refused = 0;
    const lost = fragments.filter((f) => {
      const src = `const zz = ${f} + ${MARKER};\nwriteFileSync(zz, v);`;
      let sites;
      try {
        sites = writeSitesIn(src);
      } catch {
        refused++;
        return false; // a refusal is loud, and loud is allowed
      }
      parsed++;
      return sites.length === 1 && !sites[0]!.view.includes(MARKER);
    });
    expect(
      lost,
      "the sweep parsed these fragments and silently lost everything after them, so a " +
        "spec write built from one is invisible while the report reads clean",
    ).toEqual([]);

    // Non-vacuity, both ways: if everything refused, the row asserts nothing
    // about reading; if nothing refused, the catch is dead and the row would
    // pass with the refusal path removed.
    expect(parsed, "no fragment parsed — the row proves nothing about the view").toBeGreaterThan(0);
    expect(refused, "no fragment refused — the UNMEASURED path is untested here").toBeGreaterThan(
      0,
    );
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
    //
    // The suffix fixtures are spelled to be MUTANT-SENSITIVE, which the first
    // version of this row was not: `safeWriteFileSync` holds `WriteFileSync`
    // with a capital W, so the case-sensitive pattern never matched it with
    // or without the lookbehind, and the row was green for a reason that had
    // nothing to do with the mechanism it is named for. The AI review on this
    // PR found that — a vacuous assertion inside the test written to catch
    // vacuous assertions. `xwriteFileSync` and `safe_writeFileSync` both
    // contain the exact lowercase spelling, so deleting the lookbehind turns
    // this row red.
    const root = tempRoot("suffix");
    plant(
      root,
      "lib/s.ts",
      [
        "xwriteFileSync(specPath, v);",
        "safe_writeFileSync(specPath, v);",
        "fs.writeFileSync(specPath, v);",
      ].join("\n"),
    );
    const sites = writeSites(root, ["lib"]);
    expect(sites.map((s) => s.line)).toEqual([3]);
  });

  test("a same-named binding in another function cannot hide a spec write", () => {
    // The high-severity AI-review finding on #1557, as a case, and the ONE
    // site in this suite whose classification MOVED when the name scan became
    // a scope resolution (#1566).
    //
    // Two functions each declare `filePath`. Three readings are possible:
    //   first-match name scan  → [3]     — reads report.json for BOTH, and the
    //                                      real spec write at 7 is MISSED.
    //   union of all bindings  → [3, 7]  — finds 7, and invents 3.
    //   scope resolution       → [7]     — each use reads its own binding.
    // The first is the defect; the second is what #1557 shipped; the third is
    // the only one that is simply correct.
    const two = [
      "export function writeReport(outDir: string, body: string) {",
      '  const filePath = join(outDir, "report.json");',
      "  writeFileSync(filePath, body);",
      "}",
      "export function writeTheSpec(specsDir: string, body: string) {",
      '  const filePath = join(specsDir, "NEW-SPEC.md");',
      "  writeFileSync(filePath, body);",
      "}",
    ].join("\n");
    const root = tempRoot("shadow");
    plant(root, "lib/two.ts", two);
    expect(specChokepointViolations(root, ["lib"]).map((s) => s.line)).toEqual([7]);

    // NEGATIVE CONTROL: the same file with the two bodies exchanged. A reading
    // that answered [7] because it always picks the LAST binding would answer
    // [7] here too; the correct reading tracks the spec, so it moves to [3].
    const swapped = tempRoot("shadow-swapped");
    plant(
      swapped,
      "lib/two.ts",
      [
        "export function writeTheSpec(specsDir: string, body: string) {",
        '  const filePath = join(specsDir, "NEW-SPEC.md");',
        "  writeFileSync(filePath, body);",
        "}",
        "export function writeReport(outDir: string, body: string) {",
        '  const filePath = join(outDir, "report.json");',
        "  writeFileSync(filePath, body);",
        "}",
      ].join("\n"),
    );
    expect(specChokepointViolations(swapped, ["lib"]).map((s) => s.line)).toEqual([3]);
  });

  test("the swept directories are the ones the issue enumerated", () => {
    expect([...SWEPT_DIRS]).toEqual(["lib", "scripts", "gates", "bin", "hooks"]);
    for (const d of SWEPT_DIRS) expect(existsSync(join(REPO, d)), `${d}/ exists`).toBe(true);
  });
});
