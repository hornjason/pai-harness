/**
 * Covers SC-818, SC-819, SC-820 (SCAFFOLD-DECOMPOSITION-SPEC.md).
 *
 * Also covers SC-202 of bootstrap-data-flow/success-criteria.md — "new rules
 * include provenance comment: source incident and date". `lib/rule-provenance.ts`
 * has implemented that since #370 and this file has driven it since, but the
 * criterion's tick rested on a mention nothing credited (#327). Declared here
 * because this is where the behaviour is actually exercised.
 *
 * #370 — `bun bin/rungate.ts scaffold . --fix` on a clean checkout rewrote
 * eight `.claude/rules/*.md` files unconditionally and reported `GENERATED:`
 * for each. Measured on 2026-10-13, on this repo, with nothing else in the
 * tree:
 *
 *   .claude/rules/checks-must-be-able-to-fail.md | 197 ------------------
 *   .claude/rules/docs-routing.md                |   2 +-
 *   .claude/rules/key-files.md                   |   6 +-
 *
 * The first is the rule three specs cite by path and every mutation table in
 * the repo exists because of. It was truncated from 262 lines to 65 — the
 * generator's canonical opening survives, everything the repo added after it
 * does not. Exit 0, and `git status` says `M`, not `D`.
 *
 * The issue named the vacuous version of this test by name:
 *
 *   > A test that deletes a hand-authored rule file via the real scaffold
 *   > and fails. Asserting the scaffold "preserves files" without running it
 *   > over a file carrying hand-written content is the vacuous version.
 *
 * So the three scaffold cases below SPAWN `scripts/scaffold-project.ts` and
 * read what it left on disk. Each is paired: a hand-edited file must survive,
 * and a harness-written one must still be updated, because a scaffold that
 * preserved everything would satisfy the first case alone and is the other
 * half of the bug (#208).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateScopedRules } from "../lib/generators/agents-md";
import { mockProjectScan } from "../lib/generators/types";
import {
  PROVENANCE_KEY,
  bodySha,
  declaredSha,
  decideRuleWrite,
  ruleBody,
  stampProvenance,
} from "../lib/rule-provenance";

const ROOT = join(import.meta.dir, "..");
const SCAFFOLD = join(ROOT, "scripts", "scaffold-project.ts");
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-rules-"));
  scratch.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer" }, null, 2) + "\n");
  return dir;
}

function scaffold(dir: string) {
  const r = spawnSync("bun", [SCAFFOLD, dir, "--fix"], {
    encoding: "utf-8",
    cwd: dir,
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`scaffold failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const ruleAt = (dir: string, name: string) =>
  readFileSync(join(dir, ".claude", "rules", name), "utf-8");

describe("#370 SC-818: the generator does not overwrite what a human wrote", () => {
  test("a hand-authored rule file survives a real --fix run verbatim", () => {
    // The exact shape of the loss: a file the generator owns BY NAME, whose
    // content a human has extended. `key-files.md` is the real case — its
    // table comes from a scan and its `#296` annotation does not.
    const dir = project();
    scaffold(dir); // first run creates the rules
    const path = join(dir, ".claude", "rules", "key-files.md");
    const hand =
      readFileSync(path, "utf-8") +
      "\n| project-state.json | **DA-owned, never written from a worktree** (#296) | Reading state |\n";
    writeFileSync(path, hand);

    const report = scaffold(dir);

    expect(readFileSync(path, "utf-8"), "the hand-written annotation was discarded").toBe(hand);
    expect(report, "the run must say it withheld output, not stay silent").toContain(
      "PRESERVED: .claude/rules/key-files.md",
    );
  }, 300_000);

  test("truncation counts as overwriting — the 197-line case", () => {
    // Specifically the #370 damage rather than a generic edit: the generated
    // text is still a PREFIX of what is on disk, so any check comparing "does
    // the file contain the generated content" would pass over the loss.
    const dir = project();
    scaffold(dir);
    const path = join(dir, ".claude", "rules", "agent-principles.md");
    const extended = readFileSync(path, "utf-8") + "\n## For a script whose job is to exit non-zero\n\nRoute every refusal through one exported exit-code constant.\n";
    writeFileSync(path, extended);

    scaffold(dir);

    const after = readFileSync(path, "utf-8");
    expect(after).toBe(extended);
    expect(after, "the appended section is what #370 deleted").toContain("exit-code constant");
  }, 300_000);

  test("no rule file this repo ships is lost by scaffolding a copy of it", () => {
    // Over every rule the generator emits, not a chosen one. A per-file test
    // passes while the loop is wrong about the file nobody wrote a case for,
    // which is how checks-must-be-able-to-fail.md was lost.
    const dir = project();
    scaffold(dir);
    const rulesDir = join(dir, ".claude", "rules");
    const marked: Record<string, string> = {};
    for (const f of readdirSync(rulesDir)) {
      marked[f] = readFileSync(join(rulesDir, f), "utf-8") + `\n<!-- hand-written: ${f} -->\n`;
      writeFileSync(join(rulesDir, f), marked[f]);
    }
    expect(Object.keys(marked).length, "no rules were generated at all").toBeGreaterThanOrEqual(6);

    scaffold(dir);

    for (const [f, want] of Object.entries(marked)) {
      expect(readFileSync(join(rulesDir, f), "utf-8"), `${f} lost its hand-written content`).toBe(
        want,
      );
    }
  }, 300_000);
});

describe("#370 SC-819: a generator-owned rule file is still updated", () => {
  test("a scan change reaches an untouched rule file on the next --fix", () => {
    // The other direction, and the reason "never overwrite" is not the fix.
    // #208 is the same question from this side: a scaffold that preserved
    // everything would pass every case above and leave a generator fix
    // permanently unable to land.
    const dir = project();
    scaffold(dir);
    const before = ruleAt(dir, "docs-routing.md");

    mkdirSync(join(dir, "specs"), { recursive: true });
    writeFileSync(
      join(dir, "specs", "WIDGET-SPEC.md"),
      "---\ndoc-type: spec\ntestable: true\ngoverns: widgets\n---\n\n# Widget\n\n## Success Criteria\n\n- [ ] SC-1: widgets exist\n",
    );
    const report = scaffold(dir);

    expect(ruleAt(dir, "docs-routing.md"), "the rule did not pick up the new spec").not.toBe(before);
    expect(report).toContain("UPDATED: .claude/rules/docs-routing.md");
  }, 300_000);

  test("the marker the mechanism depends on is actually written to disk", () => {
    // A positive control on the stamp. Every preserve case above also passes
    // if the generator stops writing markers entirely — the files would all
    // read as hand-authored and nothing would ever be updated again.
    const dir = project();
    scaffold(dir);
    const rulesDir = join(dir, ".claude", "rules");
    for (const f of readdirSync(rulesDir)) {
      const text = readFileSync(join(rulesDir, f), "utf-8");
      expect(declaredSha(text), `${f} was written without a provenance marker`).toBe(bodySha(text));
    }
  }, 300_000);
});

describe("#370 SC-820: one predicate decides, and it is not a list of filenames", () => {
  const GEN = "---\ndescription: a rule\n---\n\n## Rule\n\nDo the thing.\n";

  test("an absent file is created", () => {
    const d = decideRuleWrite(null, GEN);
    expect(d.action).toBe("create");
    expect(declaredSha(d.content!)).toBe(bodySha(d.content!));
  });

  test("a file identical to the generator's output is adopted, not preserved", () => {
    // The bootstrap case. A tree written before provenance existed has no
    // markers, and without this row every one of its rule files would be
    // frozen as "hand-authored" forever.
    const d = decideRuleWrite(GEN, GEN);
    expect(d.action).toBe("update");
    expect(declaredSha(d.content!), "adoption must leave a marker behind").toBe(
      bodySha(d.content!),
    );
  });

  test("a marked file the harness wrote is updated", () => {
    const written = stampProvenance(GEN);
    const next = GEN.replace("Do the thing.", "Do the other thing.");
    expect(decideRuleWrite(written, next).action).toBe("update");
  });

  test("a marked file edited since is preserved, and says so", () => {
    const edited = stampProvenance(GEN) + "\nA human added this.\n";
    const d = decideRuleWrite(edited, GEN.replace("Do the thing.", "Do something else."));
    expect(d.action).toBe("preserve");
    expect(d.reason).toContain("hand-edited");
    expect(d.content, "a preserve decision must carry nothing to write").toBeUndefined();
  });

  test("an unmarked file that differs is preserved as hand-authored", () => {
    const d = decideRuleWrite("## My own rule\n\nMine.\n", GEN);
    expect(d.action).toBe("preserve");
    expect(d.reason).toContain("hand-authored");
  });

  test("the sha covers the body, so frontmatter churn is not an edit", () => {
    // `updated:` moves on its own. If the sha covered the whole file, every
    // rule would read as hand-edited one day after it was written and the
    // mechanism would silently become "never overwrite".
    const a = "---\ndescription: x\nupdated: 2026-10-01\n---\n\nBody.\n";
    const b = "---\ndescription: x\nupdated: 2026-10-13\n---\n\nBody.\n";
    expect(bodySha(a)).toBe(bodySha(b));
    expect(ruleBody(a)).toBe("Body.\n");
  });

  test("stamping twice leaves exactly one marker", () => {
    // Two `generated-sha` lines would make declaredSha read the first and
    // stop matching, which turns every file into a permanent preserve.
    const once = stampProvenance(GEN);
    const twice = stampProvenance(once);
    const count = twice.split("\n").filter(l => l.startsWith(`${PROVENANCE_KEY}:`)).length;
    expect(count).toBe(1);
    expect(declaredSha(twice)).toBe(bodySha(twice));
  });

  test("content with no frontmatter still gets a marker", () => {
    const d = decideRuleWrite(null, "## Bare\n\nNo frontmatter here.\n");
    expect(declaredSha(d.content!)).toBe(bodySha(d.content!));
  });
});

describe("#370 SC-821: nothing cites a rule file that is not there", () => {
  /**
   * The backstop the issue asks for. The provenance mechanism stops a rule
   * being overwritten; this catches one being deleted outright — by a future
   * scaffold mode, a bad rebase, or a hand `rm` — which nothing in the suite
   * currently notices. The deletion in #370 sat in a working tree through a
   * full green `bun test`.
   */
  /**
   * Where a citation is a ROUTE rather than a mention.
   *
   * Three directories are deliberately out of scope, and each was found by
   * this check reporting a file as missing that is missing on purpose:
   *
   * - `docs/adr/` — ADR-002 says of `.claude/rules/config-access.md`:
   *   "**Never created.** `.claude/rules/` holds eight files; this is not
   *   one." A document accurately recording a file's absence is not a
   *   dangling pointer, and treating it as one would make the only fix
   *   deleting the sentence.
   * - `test/` — fixtures invent rule names. `post-scaffold-commit.test.ts`
   *   asserts on the literal `GENERATED: .claude/rules/a.md`.
   * - `.claude/worktrees/` and `.rungate/` — copies and generated artefacts,
   *   which inflated the first run's citation counts to 126 and 130 files
   *   and took twelve seconds to walk.
   */
  const SCOPE = [
    "specs",
    "lib",
    "scripts",
    "gates",
    "hooks",
    "workflows",
    "bin",
    ".claude/rules",
  ];

  function citedRulePaths(): Map<string, string[]> {
    const cited = new Map<string, string[]>();
    const note = (file: string, text: string) => {
      for (const m of text.matchAll(/\.claude\/rules\/([a-z0-9-]+\.md)/g)) {
        if (!cited.has(m[1])) cited.set(m[1], []);
        const who = cited.get(m[1])!;
        if (!who.includes(file)) who.push(file);
      }
    };
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(md|ts|js)$/.test(e.name)) continue;
        note(p, readFileSync(p, "utf-8"));
      }
    };
    for (const d of SCOPE) walk(join(ROOT, d));
    for (const f of ["CLAUDE.md", "AGENTS.md"]) note(f, readFileSync(join(ROOT, f), "utf-8"));
    return cited;
  }

  test("every .claude/rules/*.md the repo routes to exists", () => {
    const cited = citedRulePaths();
    const present = new Set(readdirSync(join(ROOT, ".claude", "rules")));
    const missing = [...cited.entries()]
      .filter(([f]) => !present.has(f))
      .map(([f, who]) => `${f} — cited by ${who.length} file(s), e.g. ${who[0]}`);
    expect(missing, "a rule file the repo routes agents to is gone").toEqual([]);
  });

  test("every rule the generator emits is one of those files", () => {
    // The other direction. A generator that renamed a rule would leave the
    // old file orphaned and every citation of it pointing at nothing, and
    // the check above cannot see that: the old file still exists.
    const emitted = generateScopedRules(mockProjectScan({ name: "consumer" })).map(r => r.filename);
    const present = new Set(readdirSync(join(ROOT, ".claude", "rules")));
    expect(emitted.length).toBeGreaterThanOrEqual(6);
    for (const f of emitted) {
      expect(present.has(f), `the generator emits ${f} and this repo does not have it`).toBe(true);
    }
  });

  test("the scan is not vacuously empty", () => {
    // Without this, a regex that stopped matching would report zero missing
    // files and the check would pass over an empty tree — the assertion that
    // holds vacuously, shape 3 of checks-must-be-able-to-fail.md.
    const cited = citedRulePaths();
    expect(cited.size, "no rule citations found at all — the scan is broken").toBeGreaterThanOrEqual(
      5,
    );
    expect(
      cited.get("checks-must-be-able-to-fail.md")?.length ?? 0,
      "the most-cited rule in the repo registered zero citations",
    ).toBeGreaterThanOrEqual(3);
  });

  test("the scan reaches source, not only specs", () => {
    // Measured, not assumed: cutting SCOPE down to ["specs"] scored 0 red of
    // 16. Every other directory in the list was along for the ride, and a
    // citation added in lib/ or scripts/ would have gone unchecked — the
    // same "a predicate nobody consults" shape #360 found one layer down.
    const cited = citedRulePaths();
    const where = cited.get("checks-must-be-able-to-fail.md") ?? [];
    const dirs = new Set(where.map(p => p.slice(ROOT.length + 1).split("/")[0]));
    for (const d of ["specs", "lib", "scripts"]) {
      expect(dirs.has(d), `the scan never reached ${d}/ — SCOPE has stopped covering it`).toBe(
        true,
      );
    }
  });
});

// ── #1285: "fourth shape" is a namespace, and nothing allocates it ──────
//
// 159 files in `.ts`/`.js` alone cite a shape of
// `.claude/rules/checks-must-be-able-to-fail.md` by ORDINAL, and the count
// grew 156 → 157 → 159 over a few hours while two agents were measuring it.
// Renumbering the list — inserting a shape rather than appending one — is
// correct locally and silently invalidates every one of those citations.
// It is the SC-collision problem in different clothes: two correct edits,
// one broken union, invisible on either diff.
//
// Credit: rg-1167-reviewmd raised the namespace; the check extends
// `citedRulePaths`'s instrument rather than building a second one.
describe("#1285: every cited shape ordinal resolves to a shape that exists", () => {
  const SHAPE_RULE = "checks-must-be-able-to-fail.md";
  const ORDINALS = [
    "first", "second", "third", "fourth", "fifth",
    "sixth", "seventh", "eighth", "ninth", "tenth",
  ] as const;

  // The intro counts in CARDINALS ("Seven shapes to watch for") and the
  // citations name ORDINALS ("the seventh shape"). Two vocabularies for one
  // fact, which is half the reason the two readings drift.
  const CARDINALS = [
    "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten",
  ] as const;

  /** The citation scope. Wider than SCOPE above: most of these live in test/. */
  const ORDINAL_SCOPE = [
    "specs", "lib", "scripts", "gates", "hooks", "workflows", "bin", "test", ".claude/rules",
  ];

  function citedOrdinals(): Map<number, string[]> {
    const cited = new Map<number, string[]>();
    const re = new RegExp(`\\b(${ORDINALS.join("|")})\\s+shape\\b`, "gi");
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(md|ts|js)$/.test(e.name)) continue;
        for (const m of readFileSync(p, "utf-8").matchAll(re)) {
          const n = ORDINALS.indexOf(m[1].toLowerCase() as (typeof ORDINALS)[number]) + 1;
          if (!cited.has(n)) cited.set(n, []);
          const who = cited.get(n)!;
          if (!who.includes(p)) who.push(p);
        }
      }
    };
    for (const d of ORDINAL_SCOPE) walk(join(ROOT, d));
    return cited;
  }

  /**
   * The one binding, and a pure function of the rule text so the mutant is a
   * string rather than a spawn. Returns the two readings it took alongside
   * the violations, because a caller cannot tell "nothing is wrong" from
   * "nothing was read" if it only gets a list back.
   */
  function shapeReading(ruleText: string) {
    // The bullets under the intro, up to the first `###`.
    const body = ruleText.split("\n### ")[0];
    const listed = (body.match(/^- \*\*/gm) ?? []).length;
    // The intro's spelled count, which is prose and drifts independently.
    const m = body.match(new RegExp(`\\b(${CARDINALS.join("|")})\\s+shapes to watch for`, "i"));
    const declared = m ? CARDINALS.indexOf(m[1].toLowerCase() as (typeof CARDINALS)[number]) + 1 : 0;
    return { listed, declared };
  }

  function unresolved(ruleText: string, cited: Map<number, string[]>): string[] {
    const { listed } = shapeReading(ruleText);
    return [...cited.entries()]
      .filter(([n]) => n > listed)
      .map(([n, who]) => `${ORDINALS[n - 1]} shape — ${who.length} citation(s), e.g. ${who[0]}`)
      .sort();
  }

  const ruleText = readFileSync(join(ROOT, ".claude", "rules", SHAPE_RULE), "utf-8");

  test("the instrument reads a real list, and its two readings agree", () => {
    // The control, first, and both halves of it. A regex that stopped
    // matching reports zero bullets, and then EVERY citation is unresolved
    // and the next test fails loudly rather than quietly — but a reader
    // would not know which of the two had broken. And the spelled count is
    // a second reading of the same fact: "Seven shapes to watch for" above a
    // list of six is a renumber half-applied, which is the thing this
    // namespace is exposed to.
    const { listed, declared } = shapeReading(ruleText);
    expect(listed, "no shape bullets parsed — the instrument is broken").toBeGreaterThanOrEqual(5);
    expect(
      declared,
      `the intro says ${declared} shapes and the list has ${listed}. Update both, or the ` +
        `ordinal every other file cites stops meaning what the prose says it means (#1285)`,
    ).toBe(listed);
  });

  test("every ordinal the repo cites names a shape that exists", () => {
    const cited = citedOrdinals();
    // The non-vacuity floor, before the assertion. Borrowed from "the scan
    // is not vacuously empty" next door: without it a regex that stopped
    // matching reports zero violations over an empty set, which is exactly
    // the shape being enforced.
    expect(cited.size, "no shape ordinals found at all — the scan is broken").toBeGreaterThanOrEqual(2);
    expect(
      (cited.get(4) ?? []).length,
      "the most-cited ordinal in the repo registered zero citations",
    ).toBeGreaterThanOrEqual(10);

    expect(
      unresolved(ruleText, cited),
      `a file cites a shape by ordinal that ${SHAPE_RULE} no longer has. APPEND shapes, never ` +
        `insert — renumbering is correct locally and silently invalidates every citation ` +
        `elsewhere, and there are hundreds (#1285)`,
    ).toEqual([]);
  });

  test("the MUTANT — a renumber — is caught, so the case above is not vacuous", () => {
    // Two renumbers, because one of them proves almost nothing.
    //
    // Deleting ONE bullet invalidates only the highest ordinal, and the
    // highest ordinal is cited by two files: this one and the rule itself.
    // A check proved against that population is a check proved against its
    // own footnote. The population actually at risk is `fourth`, cited by
    // well over a hundred files — so the second mutant cuts the list to
    // three, which is both a realistic renumber and the length the consumer
    // template already uses.
    //
    // Deliberately not a figure (#1293). The count MOVES — it went 156 → 157
    // → 159 in a few hours while two of us measured it — and it is
    // scope-dependent: on main at ad54fb0b, "fourth shape" matched 133
    // `.ts`/`.js` files, 144 adding `.md`, 148 across all types, and 141
    // under this scanner's own scope. A bare number beside a check reads as
    // authoritative and three of those four are wrong for this instrument.
    // The binding is the floor asserted below, not a number in prose.
    const cited = citedOrdinals();
    expect(unresolved(ruleText, cited), "precondition: the real tree is clean").toEqual([]);

    const bullets = ruleText.match(/^- \*\*.*$/gm) ?? [];
    const listed = shapeReading(ruleText).listed;
    expect(bullets.length, "no bullets to remove — the mutation cannot apply").toBe(listed);

    const drop = (n: number) =>
      bullets.slice(-n).reduce((text, b) => text.replace(b, ""), ruleText);

    // M1: the minimal renumber. Catches the highest ordinal only.
    const m1 = drop(1);
    expect(m1, "M1 did not apply — this measures nothing").not.toBe(ruleText);
    expect(shapeReading(m1).listed).toBe(listed - 1);
    expect(unresolved(m1, cited).join(" ")).toContain(ORDINALS[listed - 1]);

    // M2: the renumber that reaches the population. `fourth` must be in it,
    // and the message must carry its real citation count, or the check is
    // protecting something smaller than it claims.
    const m2 = drop(listed - 3);
    expect(shapeReading(m2).listed, "M2 did not cut the list to three").toBe(3);
    const caught = unresolved(m2, cited);
    expect(caught.join(" "), "a renumber past the fourth shape went undetected").toContain(
      "fourth shape",
    );
    expect(
      (cited.get(4) ?? []).length,
      "the fourth shape is the population this check exists for",
    ).toBeGreaterThan(100);
  });
});
