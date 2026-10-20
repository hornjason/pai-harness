/**
 * #740 — `specs/bootstrap-data-flow/consumer-requirements.md` carried a
 * hand-maintained copy of the ownership table, frozen at the pre-#216 shape:
 * three columns, no `Strategy`, a blanket *"Do not edit them directly"* over a
 * set that includes two job-preserving workflows and a section-preserving brief
 * glob, and `.claude/rungate.json` as the place to change project config.
 *
 * The issue's acceptance is a grep for one sentence. A grep is the wrong
 * instrument for this defect, and naming why is the point of the file:
 *
 *  - **The cheapest wrong fix is to reword.** Delete the two lines the issue
 *    quotes, or write "Avoid editing the YAML", and the grep returns zero over
 *    a document that still tells a reader the generated workflows are
 *    file-owned. A check that passes under that repair certifies the
 *    regression it was written to block
 *    (`.claude/rules/checks-must-be-able-to-fail.md`, fifth shape).
 *  - **The grep under-counts.** The same claim is made twice more outside the
 *    quoted table — in the "Where to Create Things" block and in the File
 *    Location Contract — in words the grep does not match.
 *
 * So the property asserted here is agreement with `OWNED_FILES`, which is the
 * declaration `.claude/rules/harness-managed.md` is generated from: the spec
 * may not restate an edit prohibition about a path whose declared strategy is
 * something other than `regenerate`, may not carry a second hand-maintained
 * copy of the generated table, and must name the config path the loader
 * prefers and the scaffold writes.
 *
 * One exported binding, so there is one thing to mutate.
 *
 * What was broken to prove it, run and counted over this file (16 tests).
 * Every count predicted BEFORE the battery ran, and the baseline row read
 * before any mutation row — an instrument that has stopped reporting takes
 * the baseline down with it.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 16 pass, 0 fail | **16 pass, 0 fail** |
 * | the genuinely pre-#740 document, `git show origin/main:<spec>` | 2 | **2 of 16** |
 * | the cheapest wrong fix: that same document with ONLY the two sentences the issue greps for deleted | 2 | **2 of 16** |
 * | `consumerRequirementsOwnershipViolations` short-circuited to `return []` | 8 | **8 of 16** |
 * | the anchor refusal replaced by `return []` | 1 | **1 of 16** |
 * | the `regenerate` exemption dropped, so every strategy is a violation | 1 | **1 of 16** |
 *
 * Before believing any of those, the input on which mutant and original
 * differ, named and run rather than assumed: the shipped document. On
 * `origin/main` the decider returns **33** violations — 24 lines naming the
 * legacy monolith, 7 edit prohibitions about job-preserving and
 * section-preserving paths across three separate tables, one duplicate copy
 * of the generated table header, and the absent pointer. On the repaired
 * document it returns none.
 *
 * The issue's own grep found **2**. Seven of those 33 are the same claim it
 * was pointed at, worded differently.
 *
 * **The third row is the one that matters.** Under that repair the issue's
 * acceptance grep returns zero across the whole tree and the document still
 * tells a reader not to edit `ci.yml`, in two places the grep cannot see.
 * A check written to the grep would have certified it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { OWNED_FILES } from "../lib/scaffold/owned-files";

const ROOT = join(import.meta.dir, "..");
export const CONSUMER_REQUIREMENTS = join(
  ROOT,
  "specs",
  "bootstrap-data-flow",
  "consumer-requirements.md",
);

/**
 * The heading the claim lives under. Used as the readability control: a
 * document that does not contain it is not the document this check is about,
 * and returning `[]` for it would be a clean result produced by not looking
 * (#621).
 */
export const OWNERSHIP_ANCHOR = "## Harness-Managed Files";

/** The legacy monolith path. Still read by `resolveConfig` as a fallback, but
 * not what the scaffold writes and not what the declaration names. */
const MONOLITH = "rungate.json";

/** The header of the generated table, which must exist in exactly one place. */
const GENERATED_TABLE_HEADER = "what not to do";

/** The generated file this spec is required to defer to. */
const SOURCE_OF_TRUTH = ".claude/rules/harness-managed.md";

/**
 * The sentence #740's acceptance greps the whole tree for. Assembled from
 * parts on purpose: written as a literal, this file would itself be a hit.
 */
const ISSUE_GREP_SENTENCE = ["Don", "t edit the YAML"].join("'");

const PROHIBITIONS = [
  /don'?t edit/i,
  /do not edit/i,
  /don'?t hand-edit/i,
  /never edit/i,
  /avoid editing/i,
  /not to be edited/i,
];

/**
 * Every spelling of an owned path a prose document plausibly uses, paired with
 * the declared strategy. Derived from `OWNED_FILES` rather than listed, so a
 * new owned file is covered the day it is declared.
 */
export function ownedPathMentions(): { needle: string; path: string; strategy: string }[] {
  const out: { needle: string; path: string; strategy: string }[] = [];
  for (const f of OWNED_FILES) {
    if (f.path.includes("*")) {
      out.push({ needle: f.path.split("*")[0], path: f.path, strategy: f.strategy });
      continue;
    }
    out.push({ needle: f.path, path: f.path, strategy: f.strategy });
    const base = f.path.split("/").pop()!;
    if (base !== f.path) out.push({ needle: base, path: f.path, strategy: f.strategy });
  }
  return out;
}

/**
 * The single decider. Throws when the document cannot be read as the one the
 * claim is about — an unreadable position is UNMEASURED, not clean.
 */
export function consumerRequirementsOwnershipViolations(doc: string): string[] {
  if (!doc.includes(OWNERSHIP_ANCHOR)) {
    throw new Error(
      `cannot locate ${OWNERSHIP_ANCHOR} — the ownership claim has moved, and an ` +
        `absent section is not an absent claim`,
    );
  }

  const violations: string[] = [];
  const mentions = ownedPathMentions();
  const lines = doc.split("\n");

  lines.forEach((line, i) => {
    const n = i + 1;

    // (a) An edit prohibition about a path the declaration does not say that
    // about. `regenerate` rows really are "don't edit"; the other four
    // strategies are not, and that distinction is the whole of #216.
    if (PROHIBITIONS.some(p => p.test(line))) {
      // Deduped by declared path: `.github/workflows/ci.yml` and its basename
      // are two spellings of ONE row, and reporting both would make the count
      // a property of how the prose is written rather than of the defect.
      const hit = new Map<string, string>();
      for (const m of mentions) {
        if (m.strategy === "regenerate") continue;
        if (!line.includes(m.needle)) continue;
        hit.set(m.path, m.strategy);
      }
      for (const [path, strategy] of hit) {
        violations.push(
          `${n}: edit prohibition about \`${path}\`, whose declared strategy is ` +
            `${strategy} — ${line.trim()}`,
        );
      }
    }

    // (b) A second hand-maintained copy of the generated table. The header is
    // the signature: `ownedFilesTable()` is the only thing allowed to emit it,
    // and a copy in a hand-written spec cannot be reconciled against anything.
    if (line.trimStart().startsWith("|") && line.toLowerCase().includes(GENERATED_TABLE_HEADER)) {
      violations.push(`${n}: a hand-maintained copy of the generated ownership table — ${line.trim()}`);
    }

    // (c) The monolith config path. Legacy-supported by `resolveConfig`, but
    // not what the scaffold writes, so a reader told to edit it edits a file
    // the directory form shadows.
    if (line.includes(MONOLITH)) {
      violations.push(`${n}: names the legacy monolith \`${MONOLITH}\` — ${line.trim()}`);
    }
  });

  // (d) The spec has to point somewhere. Deleting the section would satisfy
  // (a)-(c) and leave a reader with nothing.
  if (!doc.includes(SOURCE_OF_TRUTH)) {
    violations.push(`the spec does not point at ${SOURCE_OF_TRUTH}, the generated source of truth`);
  }

  return violations;
}

const read = () => readFileSync(CONSUMER_REQUIREMENTS, "utf-8");

describe("#740: the consumer-requirements spec agrees with OWNED_FILES", () => {
  test("the live document restates no ownership claim the declaration contradicts", () => {
    expect(consumerRequirementsOwnershipViolations(read())).toEqual([]);
  });

  test("the live document points at the generated source of truth", () => {
    expect(read()).toContain(SOURCE_OF_TRUTH);
  });

  // The readability control. Without this, every case above is satisfiable by
  // a document that no longer contains the section at all.
  test("a document missing the section refuses rather than reporting clean", () => {
    expect(() => consumerRequirementsOwnershipViolations("# unrelated\n")).toThrow(
      /cannot locate/,
    );
  });

  test("the control is not vacuous: the live document contains the anchor", () => {
    expect(read()).toContain(OWNERSHIP_ANCHOR);
  });
});

describe("#740: the decider can fail, one defect at a time", () => {
  const withAnchor = (body: string) => `${OWNERSHIP_ANCHOR}\n\n${body}\n\n${SOURCE_OF_TRUTH}\n`;

  test("a prohibition about a job-preserving workflow is a violation", () => {
    const v = consumerRequirementsOwnershipViolations(
      withAnchor("| `.github/workflows/ci.yml` | regenerates | Don't edit it |"),
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("job-preserving");
  });

  test("the bare basename is caught too — the prose form the quoted table does not use", () => {
    const v = consumerRequirementsOwnershipViolations(
      withAnchor("| A custom CI workflow | elsewhere | Do not edit ci.yml |"),
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain(".github/workflows/ci.yml");
  });

  test("a prohibition about a section-preserving brief glob is a violation", () => {
    const v = consumerRequirementsOwnershipViolations(
      withAnchor("| `.claude/agents/*.md` | from config | Don't edit briefs |"),
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("section-preserving");
  });

  test("a prohibition about a regenerate path is NOT a violation", () => {
    expect(
      consumerRequirementsOwnershipViolations(withAnchor("`CODE-MAP.md` — do not edit, it regenerates")),
    ).toEqual([]);
  });

  test("a second copy of the generated table header is a violation", () => {
    const v = consumerRequirementsOwnershipViolations(
      withAnchor("| File | Strategy | How to customize | What NOT to do |"),
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("hand-maintained copy");
  });

  test("prose discussing what not to do is not a table header", () => {
    expect(
      consumerRequirementsOwnershipViolations(withAnchor("It is the source of truth for what not to do.")),
    ).toEqual([]);
  });

  test("the legacy monolith path is a violation wherever it appears", () => {
    const v = consumerRequirementsOwnershipViolations(
      withAnchor("**To change project config:** Edit `.claude/rungate.json` then re-scaffold."),
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("legacy monolith");
  });

  test("the directory form is not a violation", () => {
    expect(
      consumerRequirementsOwnershipViolations(
        withAnchor("**To change project config:** Edit `.claude/rungate/config.json` then re-scaffold."),
      ),
    ).toEqual([]);
  });

  test("a section with the claim removed and no pointer is still a violation", () => {
    const v = consumerRequirementsOwnershipViolations(`${OWNERSHIP_ANCHOR}\n\nNothing to see.\n`);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("generated source of truth");
  });

  // The cheapest wrong fix, named and run: repair only what the issue's grep
  // can see — the two rows carrying the quoted sentence — and leave the two
  // restatements of the same claim that live outside the table. The grep goes
  // to zero. This does not.
  test("fixing only what the issue's grep matches does not satisfy the check", () => {
    const repairedGrepOnly = withAnchor(
      [
        "See `.claude/rules/harness-managed.md`.",
        "",
        "| I need to create... | Put it here | Not here |",
        "| A custom CI workflow | `.github/workflows/my-workflow.yml` | Don't edit ci.yml or gates.yml |",
        "",
        "| What | Where | Wrong place | Enforcement |",
        "| CI/CD workflows (harness) | `.github/workflows/ci.yml`, `gates.yml` | Don't edit — harness-owned | Regenerated |",
      ].join("\n"),
    );
    // Assembled rather than written out, because the issue's acceptance is a
    // TREE-WIDE grep for this sentence: a test file carrying it as a literal
    // would be a hit, and the guard would fail the criterion it is proving.
    expect(repairedGrepOnly).not.toContain(ISSUE_GREP_SENTENCE);
    const v = consumerRequirementsOwnershipViolations(repairedGrepOnly);
    // Four: two paths named on each of the two surviving lines.
    expect(v.length).toBe(4);
    expect(v.join("\n")).toContain("job-preserving");
  });
});

describe("#740: the declaration is the source the check reads", () => {
  test("every owned path contributes at least one mention", () => {
    const paths = new Set(ownedPathMentions().map(m => m.path));
    expect(paths.size).toBe(OWNED_FILES.length);
  });

  test("the strategies carried are the declared ones", () => {
    for (const m of ownedPathMentions()) {
      const declared = OWNED_FILES.find(f => f.path === m.path)!;
      expect(m.strategy).toBe(declared.strategy);
    }
  });
});
