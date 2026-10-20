/**
 * #759 — a write strategy declared on a row, implemented in the one decider,
 * and never passed to it by anything.
 *
 * `decideOwnedWrite` implemented a `provenance` branch with a `//`
 * line-comment marker. Nothing ever passed it `"provenance"`. The one
 * `OWNED_FILES` row declaring that strategy is `.claude/rules/*.md`, and
 * those files are written by `decideRuleWrite`, which implements the same
 * idea with a FRONTMATTER key because a markdown file has no line comments.
 * Two implementations of "has anyone touched this since", one unreachable,
 * and the reachable one was not the one the ownership table pointed at.
 *
 * #530's shape: built, exported, thoroughly unit-tested, wired to nothing.
 * `test/scaffold-ownership.test.ts` exercised the dead branch directly, so a
 * coverage tool reported it covered — it was simply never reached by a run.
 * The mutation that exposed it changed the shared factory's prefix from `//`
 * to `#` and measured **0 of 46** where 2 was predicted.
 *
 * ## The bigger half, found while fixing it
 *
 * `decideOwnedWrite` had no `job-preserving` branch either, and no refusal —
 * so that strategy fell through to the regenerate tail at the bottom of the
 * function. `.github/workflows/ci.yml` and `gates.yml` declare it, and they
 * are written by `writeManagedFile`, which merges jobs. Nothing passed
 * `job-preserving` to `decideOwnedWrite` either, so nothing was broken.
 *
 * But `regenerateOwned`'s `strategy` parameter DEFAULTS to
 * `ownedStrategy(label)`, which reads the row. One call to
 * `regenerateOwned(…, "ci.yml", actions)` with the argument left off would
 * have replaced a consumer's entire workflow — every job they had written —
 * and reported `CHANGED: regenerated output differs`.
 *
 * A dead branch and a silently wrong one are the same colour in a green
 * suite. `decideOwnedWrite` now throws for any strategy it does not
 * implement, and `DECIDED_HERE` is the declaration of which those are.
 *
 * ## The decision #759 asked to be recorded (its SC-3)
 *
 * **The `//` path is removed, not revived.** Routing `.claude/rules/*.md`
 * through it was the alternative and it cannot work: the marker has to be a
 * comment in the file's own syntax, markdown has none, and the frontmatter
 * form already exists and is live. Keeping both would leave the next person
 * to add an owned file choosing between two functions with no statement of
 * which one runs. `stampComment`, `commentSha`, `declaredCommentSha` and
 * `commentBody` are gone with it; `lineCommentProvenance`, the shared
 * factory, stays — `.github/workflows/` instantiates it with `#` and that
 * instantiation IS reached.
 *
 * The `provenance` strategy stays on the row, because it describes the
 * behaviour those files genuinely have. What changed is that the row now
 * names the binding that provides it.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Change the `.claude/rules/*.md` row to say `regenerate` and delete the
 * `provenance` member of the union.** The dead branch goes, the declaration
 * stops pointing at something unreachable, nothing in the suite complains,
 * and it is a lie: those files are preserved when hand-edited, which is the
 * opposite of `regenerate`, so the table would now mis-describe the one
 * behaviour a consumer most needs to predict. `AC-2b` is the case that
 * survives it — it asserts the row's declared strategy against what the
 * generator DOES to that path, so a row claiming `regenerate` over a file
 * that is preserved goes red.
 *
 * ## What was broken to prove these can fail
 *
 * Recorded in the battery table at the foot of this file, after the cases.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DECIDED_HERE,
  OWNED_FILES,
  type WriteStrategy,
  decideOwnedWrite,
  lineCommentProvenance,
} from "../lib/scaffold/owned-files";
import { decideRuleWrite } from "../lib/rule-provenance";
import { ownedStrategy } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");

/** Every strategy any row declares. */
function declaredStrategies(): WriteStrategy[] {
  return [...new Set(OWNED_FILES.map(f => f.strategy))];
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rungate-759-"));
}

describe("#759 AC-1: which strategies the decider actually receives", () => {
  test("every strategy DECIDED_HERE has a branch, and every branch is declared", () => {
    // From the function's behaviour, not from reading its source: a
    // strategy with a branch returns a decision, one without now throws.
    // A source-text scan for `strategy === "x"` would assert that a string
    // appears, and a branch can be present and unreachable — which is the
    // entire subject of this issue.
    for (const s of DECIDED_HERE) {
      expect(
        () => decideOwnedWrite(s, null, "body\n"),
        `'${s}' is listed in DECIDED_HERE and the function refuses it`,
      ).not.toThrow();
    }

    const union: WriteStrategy[] = [
      "regenerate", "provenance", "job-preserving", "section-preserving", "create-only",
    ];
    for (const s of union.filter(s => !DECIDED_HERE.includes(s))) {
      expect(
        () => decideOwnedWrite(s, null, "body\n"),
        `'${s}' is not in DECIDED_HERE and the function accepted it anyway — ` +
          `it fell through to whichever branch sits at the bottom`,
      ).toThrow();
    }
  });

  test("AC-1b: an unimplemented strategy is refused, not silently regenerated", () => {
    // The landmine, as an input. Before #759 this returned
    // `{action: "changed", content: generated}` — a consumer's whole
    // workflow replaced, reported as an ordinary regeneration.
    const consumerWorkflow = "name: CI\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n";
    let threw: Error | null = null;
    try {
      decideOwnedWrite("job-preserving", consumerWorkflow, "name: CI\njobs:\n  test: {}\n");
    } catch (e) { threw = e as Error; }

    expect(threw, "a strategy with no branch produced a decision").not.toBeNull();
    expect(
      threw!.message,
      `the refusal does not name the strategy: ${threw!.message}`,
    ).toContain("job-preserving");
    expect(
      threw!.message,
      "the refusal does not say what serves it instead, so nobody can act on it",
    ).toContain("writeManagedFile");
  });

  test("the default strategy for a workflow label is the one that would have clobbered it", () => {
    // Establishes the premise of AC-1b rather than asserting it in prose:
    // `regenerateOwned`'s default really does resolve to `job-preserving`
    // for this label, so the forgotten-argument path is reachable and the
    // throw above is load-bearing rather than theoretical.
    expect(ownedStrategy(".github/workflows/ci.yml")).toBe("job-preserving");
    expect(DECIDED_HERE).not.toContain("job-preserving");
  });
});

describe("#759 AC-2: every declared strategy is reachable, or says what serves it", () => {
  test("no row declares a strategy with nothing behind it", () => {
    const orphans = OWNED_FILES.filter(
      f => !DECIDED_HERE.includes(f.strategy) && !f.servedBy,
    ).map(f => `${f.path} declares '${f.strategy}'`);

    expect(
      orphans,
      `these rows declare a strategy decideOwnedWrite does not implement and name no ` +
        `other binding, so the declaration points at nothing:\n  ${orphans.join("\n  ")}\n` +
        `Either implement it there, or add servedBy naming the function that does.`,
    ).toEqual([]);

    // Non-vacuity: the check is only meaningful if some row is in the
    // served-elsewhere class at all. All three were invisible before #759.
    expect(
      OWNED_FILES.filter(f => f.servedBy).length,
      "no row names another binding, so this case cannot distinguish anything",
    ).toBeGreaterThan(0);
  });

  test("AC-2b: the declared strategy matches what the generator does to that path", () => {
    // The case that survives the cheapest wrong fix. Re-declaring
    // `.claude/rules/*.md` as `regenerate` would clear every structural
    // check above and describe the file's behaviour backwards.
    //
    // Driven through the binding the row names, over a hand-edited file —
    // the one input on which `regenerate` and `provenance` differ.
    const row = OWNED_FILES.find(f => f.path === ".claude/rules/*.md");
    expect(row, "the rules row is gone, so this case is asserting nothing").toBeDefined();
    expect(row!.strategy).toBe("provenance");

    const handEdited = "---\ndescription: mine\n---\n\nsomething a person wrote\n";
    const d = decideRuleWrite(handEdited, "generated body\n");
    expect(
      d.action,
      `the row says '${row!.strategy}', which means a hand-edit survives, and the ` +
        `binding it names reports '${d.action}'`,
    ).toBe("preserve");
    expect(d.content, "a preserved file was handed content to write").toBeUndefined();
  });

  test("every servedBy names a binding that exists in the tree", () => {
    // A `servedBy` nobody can follow is the declaration problem again, one
    // level up. The name is matched against the source, so a rename that
    // does not update the row is caught.
    for (const f of OWNED_FILES.filter(f => f.servedBy)) {
      const binding = f.servedBy!.split(" ")[0];
      const found = readdirSync(join(ROOT, "lib"), { recursive: true, withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(".ts"))
        .some(e => readFileSync(join(e.parentPath ?? e.path, e.name), "utf-8")
          .includes(`export function ${binding}(`));
      expect(found, `${f.path} says it is served by '${binding}', which is not exported anywhere in lib/`).toBe(true);
    }
  });
});

describe("#759 AC-4/AC-5: the surviving marker's prefix is pinned", () => {
  test("the committed workflows carry a marker a YAML parser reads as a comment", () => {
    // The input on which a prefix mutation and the original differ, and the
    // reason the original battery measured 0: the factory stamps AND reads
    // through one prefix, so changing it changes both sides consistently
    // and every round-trip case stays green. Only bytes already on disk,
    // written by an earlier run, can tell.
    const dir = join(ROOT, ".github", "workflows");
    const stamped = readdirSync(dir)
      .filter(n => /\.ya?ml$/.test(n))
      .map(n => ({ name: n, text: readFileSync(join(dir, n), "utf-8") }))
      .filter(f => /generated-sha:/.test(f.text));

    expect(
      stamped.length,
      "no committed workflow carries a provenance marker, so this case reads nothing",
    ).toBeGreaterThan(0);

    for (const f of stamped) {
      expect(
        f.text.startsWith("# generated-sha: "),
        `${f.name} does not open with a '#' comment marker. A marker in any other ` +
          `syntax is content to a YAML parser, and the file stops parsing.`,
      ).toBe(true);
    }
  });

  test("the line marker and the frontmatter marker are different shapes", () => {
    // AC-4's distinction, kept after the `//` path was removed. The two
    // survivors must not converge: a frontmatter key is inside a `---`
    // block and a line comment is the first line of the document.
    const yaml = lineCommentProvenance("#").stamp("name: CI\n");
    const md = "---\ngenerated-sha: abc\n---\n\nbody\n";
    expect(yaml.startsWith("# generated-sha: ")).toBe(true);
    expect(yaml.startsWith("---")).toBe(false);
    expect(md.startsWith("---")).toBe(true);
  });

  test("a prefix the factory is given is the prefix it reads back", () => {
    const hash = lineCommentProvenance("#");
    const slash = lineCommentProvenance("//");
    const stamped = hash.stamp("body\n");
    expect(hash.declared(stamped)).not.toBeNull();
    expect(
      slash.declared(stamped),
      "a reader with the wrong prefix found a marker anyway, so the prefix is not load-bearing",
    ).toBeNull();
  });
});

describe("#759 AC-6: each row reconciled against the generator, not the prose", () => {
  test("a create-only row is seeded once and never rewritten", () => {
    // Executed, per path class, rather than compared to the table. The
    // table is the thing under suspicion.
    const d = scratch();
    try {
      const p = join(d, "project-state.json");
      writeFileSync(p, '{"mine":true}\n');
      const decision = decideOwnedWrite(ownedStrategy("project-state.json"), readFileSync(p, "utf-8"), "{}\n");
      expect(decision.action).toBe("unchanged");
      expect(decision.content, "a create-only file was handed replacement bytes").toBeUndefined();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("a regenerate row is rewritten when the bytes differ", () => {
    const decision = decideOwnedWrite(ownedStrategy("CODE-MAP.md"), "old\n", "new\n");
    expect(decision.action).toBe("changed");
    expect(decision.content).toBe("new\n");
  });

  test("a section-preserving row carries its declared section forward", () => {
    const row = OWNED_FILES.find(f => f.path === "AGENTS.md");
    expect(row?.sections, "the row declares no section to preserve").toBeDefined();
    const heading = row!.sections!.label;
    const existing = `# P\n\n${heading}\n\nmine, and non-inferable\n`;
    const decision = decideOwnedWrite(ownedStrategy("AGENTS.md"), existing, "# P\n\ngenerated\n");
    expect(decision.action, `a ${heading} edit was not carried forward`).not.toBe("refuse");
    expect(decision.content ?? "", "the preserved section is missing from the output")
      .toContain("mine, and non-inferable");
  });

  test("the two served-elsewhere classes are not reached through this decider at all", () => {
    // The reconciliation #759's SC-6 asks for, stated as the negative: for
    // these rows the generator does NOT route here, and the case proves it
    // by showing the route refuses rather than by reading a table.
    for (const f of OWNED_FILES.filter(f => f.servedBy)) {
      expect(
        () => decideOwnedWrite(f.strategy, "existing\n", "generated\n"),
        `${f.path} is served by ${f.servedBy} and decideOwnedWrite accepted its strategy`,
      ).toThrow();
    }
  });
});

describe("#759: the dead path is gone, and stays gone", () => {
  test("nothing in lib/ instantiates the line-comment marker with //", () => {
    // The `#` instantiation is live (`.github/workflows/`). A `//` one
    // would be the removed path returning under another name, and the only
    // file that can hold it is one that imports the factory.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!e.name.endsWith(".ts")) continue;
        const text = readFileSync(abs, "utf-8");
        if (/lineCommentProvenance\(\s*["']\/\//.test(text)) {
          offenders.push(abs.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, "lib"));
    expect(
      offenders,
      `the '//' provenance path is back in: ${offenders.join(", ")}. #759 removed it ` +
        `because no owned file uses '//' comments; if one now does, give it a row and ` +
        `a branch rather than reviving a path nothing routes to.`,
    ).toEqual([]);

    // Positive control: the scan can see an instantiation when there is
    // one, so an empty result above means absence rather than a dead walk.
    const live: string[] = [];
    const walk2 = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk2(abs); continue; }
        if (e.name.endsWith(".ts") && /lineCommentProvenance\(/.test(readFileSync(abs, "utf-8"))) {
          live.push(abs);
        }
      }
    };
    walk2(join(ROOT, "lib"));
    expect(live.length, "the scan found no instantiation at all — it is reading nothing").toBeGreaterThan(0);
  });
});

/**
 * ## The battery
 *
 * Run over this file + `test/scaffold-ownership.test.ts` +
 * `test/rule-provenance.test.ts` (66 tests). Every count predicted before
 * the run, and **the baseline row read first** — an instrument that has
 * stopped reporting takes the baseline down with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 66 pass, 0 fail | **66 pass, 0 fail** | — |
 * | M1 the unimplemented-strategy throw removed — the pre-#759 fall-through | 4 | **3 of 66** | `decideOwnedWrite("job-preserving", consumerWorkflow, gen)`: the original throws, the mutant returns `{action:"changed"}` and hands back bytes that replace every job the consumer wrote |
 * | M2 `job-preserving` added to `DECIDED_HERE` with no branch added | 3 | **3 of 66** | the same input: the declaration says it is implemented, so the throw stops firing and the fall-through returns |
 * | M3 **the cheapest wrong fix**: the rules row re-declared `regenerate`, `servedBy` dropped | 2 | **2 of 66** | a hand-edited rule file: the row claims rewrite, `decideRuleWrite` preserves |
 * | M4 `servedBy` dropped from the two workflow rows only | 2 | **2 of 66** | the orphan scan, and the refusal message that no longer names `writeManagedFile` |
 * | M5 the `//` path restored — `lineCommentProvenance("//")` re-instantiated in `lib/` | 1 | **1 of 66** | the scan over `lib/` |
 * | M6 `lineCommentProvenance` ignores its prefix (marker hardcoded to `#\|//`) | 1 | **1 of 66** | `lineCommentProvenance("//").declared(hashStamped)`: the original is `null`, the mutant finds a marker |
 * | M7 the committed `ai-review.yml` marker rewritten to `// generated-sha:` | 1 | **2 of 66** | the bytes on disk — the input the original 0-red battery did not have |
 * | M8 `decideRuleWrite`'s preserve branch returns `update` | 4 | **8 of 66** | a hand-edited rule file |
 *
 * **M7 is the row this issue exists for.** #722's battery changed the
 * factory's prefix and measured **0 of 46**, because the factory stamps AND
 * reads through one prefix: change it and both sides move together, so every
 * round-trip case stays green. The only witness is bytes an EARLIER run
 * wrote, which is why `AC-4` reads committed files rather than calling the
 * factory twice. The extra red is `#208 AC-2`'s real-run case — a `//` first
 * line is not a YAML comment, so the workflow stops parsing. Squarely about
 * the mutated behaviour, and the sharpest statement of why the prefix is
 * load-bearing.
 *
 * **M8 came back double and every extra red is the real kind** — #370's
 * three real-run cases and its two predicate cases, all about preserve
 * versus overwrite. Not a crashing mutant: 58 cases still pass. The fact it
 * records is that the repointed SC-840 cases now sit on a binding four other
 * cases already depend on, which is the opposite of where they were.
 *
 * **M1 came back LOW at 3.** The differing input is named above and three
 * cases witness it; the prediction was simply one too many. Not a collapsed
 * pair — there is no fourth case that should have seen it.
 *
 * None of the eight mutations is left in the tree. `lib/scaffold/owned-files.ts`,
 * `lib/rule-provenance.ts` and the two workflow files were restored from `cp`
 * backups and confirmed byte-identical by sha256, never by `git checkout --`.
 */
