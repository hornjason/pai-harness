/**
 * Two exported functions may not share a name and disagree about what it
 * means (#1398).
 *
 * `findingKey` was declared twice — `lib/ai-review-rounds.ts` keyed a finding
 * on file + line anchor + summary and could return `null`; `lib/scaffold/
 * ai-review-findings.ts` keyed it on file + summary and never could. A call
 * site reading `findingKey(f)` could not tell you which question it had just
 * asked, and the two answer different ones: one is an ADJUDICATION key
 * ("has this advisory already been counted on this run"), the other a
 * PERSISTENCE key ("is the thing this round raised the thing the last round
 * raised").
 *
 * ## What this file does NOT claim
 *
 * It does not claim the two rules can drift into each other. They cannot,
 * and that was measured rather than assumed before this guard was written:
 * collapsing the cross-round key onto a line number reddens 6 cases in
 * `test/ai-review-ledger-read.test.ts`, and adding the line to the payload
 * key reddens `AD-7` in `test/ai-review-advisory-findings.test.ts`. Both
 * mutants were predicted to survive and both were caught.
 *
 * So the risk this file covers is the one nothing else did: the NAME. A
 * third `findingKey` can be added tomorrow, in a third file, keyed a third
 * way, and no case anywhere would notice.
 *
 * ## Two guards, because one name and one identity are different questions
 *
 * `KEY-1` no exported `*Key`/`*Keys` function name is declared in more than
 * one file. This is what makes a call site's `advisoryKey(...)` legible
 * without knowing which module it came from.
 *
 * `KEY-2` every exported `*Key`/`*Keys` in the two finding-identity modules
 * states its identity, in its OWN docblock, and names the other.
 *
 * Together they cover AC-3: a third `findingKey` lands either under the same
 * name somewhere (KEY-1) or inside one of the two identity modules (KEY-2).
 * A new key under a NEW name in a THIRD module is deliberately not an error
 * — there is no ambiguity at a call site to protect against, and a guard
 * wider than its subject is how `.claude/rules/checks-must-be-able-to-fail.md`
 * says these go wrong.
 *
 * ## The extractor is run over planted sources as well as the real tree
 *
 * Every assertion about the repository is paired with one over a fixture
 * string, because a regex that matches nothing reads exactly like a tree
 * with no duplicates and no missing tags. The fixtures are the only thing
 * that can tell those apart.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { advisoryKey } from "../lib/scaffold/ai-review-findings";
import { carryKey } from "../lib/ai-review-rounds";

const ROOT = join(import.meta.dir, "..");

/** The tag a finding-identity key states its rule under. */
const IDENTITY_TAG = "@identity";

/**
 * The name #1398 retired, which no export may take again.
 *
 * Two functions held it and keyed findings differently. The name is the
 * defect: it describes the OBJECT being keyed and not the QUESTION being
 * asked, so any number of mutually inconsistent implementations can wear it
 * and every call site reads the same.
 */
const RETIRED_NAME = "findingKey";

/**
 * The two modules that key a FINDING, as opposed to a YAML node or a lock
 * file. Listed rather than inferred: every inference available here — the
 * parameter's name, its type, the module's path — is either wider than the
 * subject (`frontmatterKeys`, `counterKey`, `duplicateTopLevelKeys` are all
 * exported `*Key` functions and none of them keys a finding) or narrower
 * than it (`findingKey` in `ai-review-rounds.ts` took `unknown`). A short
 * explicit list that KEY-1 backstops is more honest than a clever predicate
 * that is wrong about one of them.
 */
const IDENTITY_MODULES = ["lib/ai-review-rounds.ts", "lib/scaffold/ai-review-findings.ts"] as const;

interface ExportedKey {
  name: string;
  file: string;
  /** The docblock immediately above the declaration, or `""` when there is none. */
  doc: string;
}

/**
 * Every exported function whose name ends in `Key` or `Keys`, with the
 * docblock that is its OWN rather than the file's.
 *
 * The docblock is taken as the `/** ... *\/` comment ending on the line
 * before the declaration, and nothing further up. A checker that searched
 * the whole file would pass on a module whose HEADER happens to mention the
 * tag while the function itself says nothing — which is the cheapest wrong
 * fix here and is the subject of the planted control below.
 */
function exportedKeys(source: string, file: string): ExportedKey[] {
  const out: ExportedKey[] = [];
  const decl = /^export (?:async )?function ([A-Za-z0-9_]*Keys?)\s*\(/gm;
  for (let m = decl.exec(source); m !== null; m = decl.exec(source)) {
    const before = source.slice(0, m.index);
    // The comment must END on the line immediately above the declaration:
    // allow only whitespace between its `*/` and the `export`.
    //
    // The leading `[\s\S]*` is GREEDY and load-bearing. Without it the first
    // `/**` in the file that can reach a `*/` before the declaration wins,
    // which is the MODULE HEADER — so a file whose header happened to state
    // an identity would satisfy the check for a function that stated none.
    // The greedy prefix backtracks to the LAST `/**` instead. Written the
    // wrong way first and caught by the planted control below, which is the
    // only row that could have caught it.
    const own = /[\s\S]*\/\*\*([\s\S]*?)\*\/\s*$/.exec(before);
    out.push({ name: m[1], file, doc: own === null ? "" : own[1] });
  }
  return out;
}

/**
 * The production trees a key function can be declared in.
 *
 * WALKED, not listed. A hardcoded file list is the one thing this guard
 * cannot be built on: AC-3 is "a third `findingKey` cannot be added", and
 * the obvious place to add one is a file that does not exist yet — which a
 * list, by construction, does not contain. The first draft of this function
 * listed the ten files that have a key today and would have been green
 * against a third key in an eleventh.
 */
const SCANNED_TREES = ["lib", "gates", "scripts", "bin"] as const;

/** Every exported key in the repository's own source. */
function repoKeys(): ExportedKey[] {
  const out: ExportedKey[] = [];
  for (const tree of SCANNED_TREES) {
    const dir = join(ROOT, tree);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, encoding: "utf-8" })) {
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
      const rel = `${tree}/${entry}`;
      const abs = join(ROOT, rel);
      if (!statSync(abs).isFile()) continue;
      out.push(...exportedKeys(readFileSync(abs, "utf-8"), rel));
    }
  }
  return out;
}

/** Names declared in more than one file, with the files, for the message. */
function duplicateNames(keys: readonly ExportedKey[]): string[] {
  const byName = new Map<string, Set<string>>();
  for (const k of keys) {
    const files = byName.get(k.name) ?? new Set<string>();
    files.add(k.file);
    byName.set(k.name, files);
  }
  return [...byName.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([name, files]) => `${name} in ${[...files].sort().join(" and ")}`);
}

describe("KEY-1 (#1398): no exported key function name means two things", () => {
  test("the population is real — the extractor finds the keys this repo has", () => {
    // The control for every negative below. A regex that matched nothing
    // would make "no duplicates" and "every key is tagged" both vacuously
    // true, which is the shape this repo has a rule file about.
    const keys = repoKeys();
    expect(keys.length, "the extractor found no exported key functions at all").toBeGreaterThanOrEqual(10);
    const names = keys.map(k => k.name);
    expect(names).toContain("carryKey");
    expect(names).toContain("advisoryKey");
    expect(names).toContain("frontmatterKeys");
  });

  test("no name is declared in two files", () => {
    expect(duplicateNames(repoKeys())).toEqual([]);
  });

  test("the CONTROL — the detector reports a planted duplicate, naming both files", () => {
    // Without this row, the case above is green against a `duplicateNames`
    // that can only ever return `[]`.
    const planted = [
      ...exportedKeys("/** k */\nexport function findingKey(f: unknown): string { return \"\"; }\n", "lib/a.ts"),
      ...exportedKeys("/** k */\nexport function findingKey(f: unknown): string { return \"\"; }\n", "lib/b.ts"),
    ];
    const dupes = duplicateNames(planted);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toContain("findingKey");
    expect(dupes[0]).toContain("lib/a.ts");
    expect(dupes[0]).toContain("lib/b.ts");
  });

  test("`findingKey` is a RETIRED name and no export may take it again", () => {
    // KEY-1's duplicate check does NOT cover this, which was measured the
    // embarrassing way: a third `findingKey` planted in a new file left all
    // twelve cases green, because after the rename it was the only
    // declaration of that name and therefore not a duplicate of anything.
    //
    // The bare name is retired precisely because it says nothing about which
    // question it answers. A key that cannot state its identity in its name
    // has to state it in its docblock, and `findingKey` did neither.
    const offenders = repoKeys().filter(k => k.name === RETIRED_NAME);
    expect(
      offenders.map(k => k.file),
      `${RETIRED_NAME} is retired (#1398) — an adjudication key is advisoryKey, a ` +
        `persistence key is carryKey, and a third kind needs its own name and an ` +
        `${IDENTITY_TAG} line`,
    ).toEqual([]);
  });

  test("the CONTROL — the retired-name check reports a planted third key", () => {
    // The row above is `toEqual([])`, which is also what a broken extractor
    // returns. This plants the exact mutant that slipped through: one
    // declaration, in a file nothing else references, under the retired name.
    const planted = exportedKeys(
      `/** A third key nobody declared an identity for. */\nexport function ${RETIRED_NAME}(f: unknown): string { return String(f); }\n`,
      "lib/zz-third.ts",
    );
    expect(planted.filter(k => k.name === RETIRED_NAME).map(k => k.file)).toEqual(["lib/zz-third.ts"]);
  });

  test("the CONTROL — two DIFFERENT names in two files are not a duplicate", () => {
    // The other direction: a detector that called everything a duplicate
    // would also satisfy the row above.
    const planted = [
      ...exportedKeys("/** k */\nexport function advisoryKey(f: unknown): string { return \"\"; }\n", "lib/a.ts"),
      ...exportedKeys("/** k */\nexport function carryKey(f: unknown): string { return \"\"; }\n", "lib/b.ts"),
    ];
    expect(duplicateNames(planted)).toEqual([]);
  });
});

describe("KEY-2 (#1398): a finding-identity key states its rule and names the other", () => {
  const identityKeys = (): ExportedKey[] =>
    IDENTITY_MODULES.flatMap(f => exportedKeys(readFileSync(join(ROOT, f), "utf-8"), f));

  test("the population is the two modules' keys, and it is not empty", () => {
    const keys = identityKeys();
    expect(keys.length, "no exported key found in the identity modules").toBeGreaterThanOrEqual(2);
    expect(keys.map(k => k.name).sort()).toEqual(["advisoryKey", "carryKey"]);
  });

  test("each states its identity in its own docblock", () => {
    for (const k of identityKeys()) {
      expect(k.doc, `${k.file}:${k.name} states no ${IDENTITY_TAG}`).toContain(IDENTITY_TAG);
    }
  });

  test("each names the other, so neither can be read without meeting its sibling", () => {
    const keys = identityKeys();
    for (const k of keys) {
      const others = keys.filter(o => o.name !== k.name).map(o => o.name);
      expect(others.length, "there is no sibling to name").toBeGreaterThan(0);
      const named = others.some(o => k.doc.includes(o));
      expect(named, `${k.file}:${k.name} does not name any of ${others.join(", ")}`).toBe(true);
    }
  });

  test("the CONTROL — an untagged key in an identity module is reported", () => {
    const planted = exportedKeys(
      "/** No identity here. */\nexport function thirdKey(f: unknown): string { return \"\"; }\n",
      "lib/ai-review-rounds.ts",
    );
    expect(planted).toHaveLength(1);
    expect(planted[0].doc).not.toContain(IDENTITY_TAG);
  });

  test("the CONTROL — a FILE-level tag does not satisfy the FUNCTION's docblock", () => {
    // The cheapest wrong fix: search the whole file for the tag rather than
    // the declaration's own comment. This source would pass that check and
    // must not pass this one — the header states an identity and the
    // function states nothing.
    const source = [
      "/**",
      ` * Module header. ${IDENTITY_TAG} file+summary`,
      " */",
      "import { x } from \"./y\";",
      "",
      "/** A third key, documented with no identity at all. */",
      "export function thirdKey(f: unknown): string { return \"\"; }",
      "",
    ].join("\n");
    expect(source, "the fixture does not contain the tag, so it tests nothing").toContain(IDENTITY_TAG);
    const planted = exportedKeys(source, "lib/ai-review-rounds.ts");
    expect(planted).toHaveLength(1);
    expect(
      planted[0].doc,
      "the extractor reached past the declaration's own docblock and took the file header",
    ).not.toContain(IDENTITY_TAG);
  });

  test("the CONTROL — a correctly tagged key IS accepted", () => {
    // So the two rows above are not satisfied by an extractor that refuses
    // everything.
    const planted = exportedKeys(
      [
        "/**",
        ` * ${IDENTITY_TAG} file+summary`,
        " * The other one is carryKey.",
        " */",
        "export function thirdKey(f: unknown): string { return \"\"; }",
        "",
      ].join("\n"),
      "lib/ai-review-rounds.ts",
    );
    expect(planted).toHaveLength(1);
    expect(planted[0].doc).toContain(IDENTITY_TAG);
    expect(planted[0].doc).toContain("carryKey");
  });
});

describe("KEY-3 (#1398): the two keys still answer different questions", () => {
  test("a line move is the SAME advisory finding and a DIFFERENT carried one", () => {
    // The behavioural difference the rename exists to make legible, asserted
    // so a later unification cannot quietly satisfy KEY-1 by deleting one.
    const finding = { severity: "HIGH", file: "lib/a.ts", line: 90, summary: "x" };
    const moved = { ...finding, line: 97 };
    expect(advisoryKey(finding), "the advisory key split one finding across a line move").toBe(
      advisoryKey(moved),
    );
    expect(
      carryKey(finding, "the original line"),
      "the carry key ignored the line's text",
    ).not.toBe(carryKey(moved, "a line that was edited"));
  });

  test("only the carry key can refuse to key a finding", () => {
    expect(carryKey({}, undefined)).toBeNull();
    expect(typeof advisoryKey({})).toBe("string");
  });
});
