/**
 * #220 — a compound success criterion must assert every clause it states.
 *
 * `content-contains` captures exactly one bracket list and `matchPattern`
 * returns on the first registry hit, so a statement of the form
 * "FILE contains [a] and not contains [b]" bound, asserted [a], and discarded
 * the rest with no signal. The SC reported satisfied having checked half of
 * what it says — the defect class in .claude/rules/checks-must-be-able-to-fail.md:
 * a detector narrower than what it detects, where the guard's view of the input
 * silently shrinks.
 *
 * The sweep that sized this (posted to #220 before the fix) found 21 such SCs,
 * in three shapes — a negative clause on the same file, a negative clause on a
 * DIFFERENT file, and a POSITIVE clause on a different file. The third shape is
 * why nothing here is written in terms of negation: a fix aimed only at
 * "not contains" would leave the two positive-clause criteria just as
 * unasserted.
 *
 * ## Why no criterion id appears in this file's prose or titles
 *
 * `coverageClaimIds` (#149) reads comments and test titles in a test file as
 * claims to cover the criteria they name, and it matches on the bare id. Two
 * distinct namespaces collide there: the spec-wide ids in `specs/`, and the
 * per-issue numbering a GitHub issue uses for its own acceptance criteria.
 * Titling a describe block with this issue's first criterion id claimed
 * coverage of the unrelated bootstrap criterion that owns the same number
 * spec-wide, and the #149 guard caught it on the first full run. This issue's
 * criteria are therefore referred to by position, and real ids appear only
 * inside the corpus sweep, which derives them from the specs rather than
 * naming them. The colliding ids are not written out even to illustrate the
 * point, because writing one here is the mistake being described.
 *
 * Covers SC-694, SC-695, SC-696, SC-697, SC-698 of CONFIG-DRIVEN-TESTING-SPEC.md
 * — these are this file's own criteria, so claiming them is the convention
 * working as intended rather than the collision described above.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseCompoundClauses,
  unconsumedAssertion,
  extractSCs,
  isBehavioralSC,
  matchPattern,
} from "../lib/conformity";
import { collectSpecFiles } from "../lib/spec-files";

const ROOT = join(import.meta.dir, "..");
const SPECS = join(ROOT, "specs");

const scratch = () => mkdtempSync(join(tmpdir(), "rungate-compound-"));

/** A ParsedSC shaped like the real parser's output. */
const sc = (statement: string, id = "SC-9201") => ({
  id,
  statement,
  checked: true,
  file: "FIXTURE-SPEC.md",
  line: 1,
}) as any;

describe("#220 parseCompoundClauses — every clause is recovered", () => {
  test("a negative second clause on the same file is recovered, not discarded", () => {
    const clauses = parseCompoundClauses(
      "hooks/Guard.hook.ts contains [github, getIssue] and not contains [Bun.spawnSync, gh issue]",
    );
    expect(clauses).not.toBeNull();
    expect(clauses!.length).toBe(2);
    expect(clauses![0]).toEqual({ file: "hooks/Guard.hook.ts", items: ["github", "getIssue"], negated: false });
    expect(clauses![1]).toEqual({ file: "hooks/Guard.hook.ts", items: ["Bun.spawnSync", "gh issue"], negated: true });
  });

  test("'has no' is the same shape spelled differently", () => {
    const clauses = parseCompoundClauses('hooks/Commit.hook.ts contains [code, agent] and has no [=== "marcus"]');
    expect(clauses!.length).toBe(2);
    expect(clauses![1].negated).toBe(true);
    expect(clauses![1].items).toEqual(['=== "marcus"']);
  });

  test("a negative clause naming a DIFFERENT file keeps that file, not the head's", () => {
    const clauses = parseCompoundClauses(
      'scripts/github-op.ts contains [title-file] and workflows/ship.js not contains [--title "fix(#]',
    );
    expect(clauses!.length).toBe(2);
    expect(clauses![1].file).toBe("workflows/ship.js");
    expect(clauses![1].negated).toBe(true);
  });

  test("a POSITIVE second clause on another file is recovered — the defect is not about negation", () => {
    const clauses = parseCompoundClauses(
      "lib/branch.ts contains [isSafeBranchName] and workflows/ship.js contains [isSafeBranchName(shipBranch)]",
    );
    expect(clauses!.length).toBe(2);
    expect(clauses![1]).toEqual({
      file: "workflows/ship.js",
      items: ["isSafeBranchName(shipBranch)"],
      negated: false,
    });
  });

  test("the rationale clause is not mistaken for an assertion", () => {
    const clauses = parseCompoundClauses(
      "lib/a.ts contains [x] and not contains [y] — the second form was removed in #209 and must not return",
    );
    expect(clauses!.length).toBe(2);
    expect(clauses![1].items).toEqual(["y"]);
  });

  test("a rationale that itself contains the word 'and' does not become a clause", () => {
    const clauses = parseCompoundClauses("lib/a.ts contains [x] — the reader and the writer agree");
    expect(clauses).toBeNull();
  });

  test("a single-clause statement is not compound", () => {
    expect(parseCompoundClauses("AGENTS.md contains [Project Identity, Rules]")).toBeNull();
  });
});

describe("#220 first criterion — the guard asserts on its own view of the input", () => {
  test("a bracket list left unconsumed is named as a refusal", () => {
    const leftover = unconsumedAssertion("lib/a.ts contains [x] plus somehow [y, z]");
    expect(leftover).not.toBeNull();
    expect(leftover).toContain("[y, z]");
  });

  test("a fully consumed compound statement leaves nothing", () => {
    expect(unconsumedAssertion("lib/a.ts contains [x] and not contains [y]")).toBeNull();
  });

  test("prose residue is not a bracket-list assertion and is not refused here", () => {
    // Deliberate: ~8 SCs carry real requirements as prose ("and is under 3,000
    // tokens"). Refusing those turns 39 SCs malformed at once and is #211's
    // work, not this issue's. The line is drawn at a discarded bracket list.
    expect(unconsumedAssertion("docs/x.md exists for code projects and is under 3,000 tokens")).toBeNull();
  });
});

describe("#220 second criterion — registry ordering cannot defeat the negative clause", () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "config/matcher-registry.json"), "utf-8"));
  const nameAt = (n: string) => registry.findIndex((e: any) => e.name === n);

  test("the compound matcher precedes content-contains, so a compound can never be captured by it", () => {
    const compound = nameAt("content-contains-compound");
    const positive = nameAt("content-contains");
    expect(compound).toBeGreaterThanOrEqual(0);
    expect(positive).toBeGreaterThanOrEqual(0);
    expect(compound).toBeLessThan(positive);
  });

  test("content-contains' own regex is still the narrow one — the fix is ordering plus a new matcher, not a widening", () => {
    const positive = registry[nameAt("content-contains")];
    expect(positive.regex).toBe("^(\\S+)\\s+contains?\\s+\\[([^\\]]+)\\]");
  });
});

describe("#220 — the recovered clause is EXECUTED, not merely parsed", () => {
  test("a violated negative clause fails the assertion that previously passed", () => {
    const root = scratch();
    mkdirSync(join(root, "lib"), { recursive: true });
    // The positive half holds; the negative half is violated. Before #220 this
    // SC passed, because only the positive half was ever read.
    writeFileSync(join(root, "lib/a.ts"), "const github = 1;\nconst forbidden = 2;\n");

    const assertion = matchPattern(sc("lib/a.ts contains [github] and not contains [forbidden]"), root);
    expect(assertion).not.toBeNull();
    expect(() => assertion!(root)).toThrow();
  });

  test("the same SC passes when the negative clause genuinely holds", () => {
    const root = scratch();
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib/a.ts"), "const github = 1;\n");

    const assertion = matchPattern(sc("lib/a.ts contains [github] and not contains [forbidden]"), root);
    expect(() => assertion!(root)).not.toThrow();
  });

  test("a violated POSITIVE second clause on another file also fails", () => {
    const root = scratch();
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib/a.ts"), "const x = 1;\n");
    writeFileSync(join(root, "lib/b.ts"), "nothing relevant\n");

    const assertion = matchPattern(sc("lib/a.ts contains [x] and lib/b.ts contains [y]"), root);
    expect(() => assertion!(root)).toThrow();
  });

  test("an absence claim is about code, so a token appearing only in a comment does not violate it", () => {
    const root = scratch();
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks/Guard.hook.ts"),
      "/**\n * Blocks gh issue close when the gate has not passed.\n */\nconst github = 1;\n",
    );
    // This is the IssueCloseGuard shape: that hook's job is to intercept the
    // very CLI invocation it is forbidden to make, so the literal legitimately
    // appears in its own docblock. A detector that reads prose reports the
    // defect its own documentation describes.
    const assertion = matchPattern(
      sc("hooks/Guard.hook.ts contains [github] and not contains [gh issue]"),
      root,
    );
    expect(() => assertion!(root)).not.toThrow();
  });

  test("...but the same token in CODE still violates it — stripping comments did not blind the check", () => {
    const root = scratch();
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks/Guard.hook.ts"),
      'const github = 1;\nexecSync("gh issue close 1");\n',
    );
    const assertion = matchPattern(
      sc("hooks/Guard.hook.ts contains [github] and not contains [gh issue]"),
      root,
    );
    expect(() => assertion!(root)).toThrow();
  });

  test("the #209 statement that exposed this now has its negative clause evaluated", () => {
    // Verbatim the compound text whose tail was discarded, found during the
    // #209 run and worked around by splitting the requirement into a second
    // criterion. Splitting was right for that one line and was not a fix: the
    // matcher kept losing tails for everyone else. Here the original text is
    // run through the matcher again and the tail is asserted.
    const statement =
      "hooks/IssueCloseGuard.hook.ts contains [could not be, redactSecrets] and not contains [} catch {}]";

    const clauses = parseCompoundClauses(statement);
    expect(clauses!.length).toBe(2);
    expect(clauses![1]).toEqual({
      file: "hooks/IssueCloseGuard.hook.ts",
      items: ["} catch {}"],
      negated: true,
    });

    const root = scratch();
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks/IssueCloseGuard.hook.ts"),
      'const redactSecrets = 1;\nconst m = "could not be";\ntry { f(); } catch {}\n',
    );
    // The swallowed error the absence clause exists to forbid is present, so
    // the SC must fail. Before #220 this passed: both positive items are
    // there, and nothing read past them.
    expect(() => matchPattern(sc(statement), root)!(root)).toThrow();
  });

  test("comment stripping applies to code files only — a markdown absence claim reads the whole file", () => {
    const root = scratch();
    writeFileSync(join(root, "NOTES.md"), "# Title\n\nSee https://example.com/a for detail.\n");
    // `//` inside a URL is not a comment. Stripping it would silently shrink
    // the guard's view of a markdown file.
    const assertion = matchPattern(sc("NOTES.md contains [Title] and not contains [example.com]"), root);
    expect(() => assertion!(root)).toThrow();
  });
});

describe("#220 fourth criterion — the corpus carries no silently discarded assertion", () => {
  const ticked = collectSpecFiles(SPECS).flatMap((rel) =>
    extractSCs(readFileSync(join(SPECS, rel), "utf-8"), rel)
      .filter((s) => s.checked && !isBehavioralSC(s))
      .map((s) => ({ ...s, spec: rel })),
  );

  test("the sweep sees a real corpus, so an empty result cannot read as clean", () => {
    expect(ticked.length).toBeGreaterThan(200);
  });

  test("no ticked SC discards a bracket-list assertion", () => {
    const offenders = ticked
      .map((s) => ({ id: s.id, spec: (s as any).spec, leftover: unconsumedAssertion(s.statement) }))
      .filter((o) => o.leftover !== null);

    expect(
      offenders.map((o) => `${o.spec} ${o.id}: unasserted ${o.leftover}`),
    ).toEqual([]);
  });

  test("the compound SCs in the corpus all bind and all parse to more than one clause", () => {
    const compound = ticked.filter((s) => parseCompoundClauses(s.statement) !== null);
    // The sweep posted to #220 found 21. This is a ratchet in the honest
    // direction: it may rise as SCs are written, but every one of them must
    // bind and must recover every clause.
    expect(compound.length).toBeGreaterThanOrEqual(21);
    for (const s of compound) {
      expect(parseCompoundClauses(s.statement)!.length).toBeGreaterThanOrEqual(2);
      expect(matchPattern(s as any, ROOT)).not.toBeNull();
    }
  });
});
