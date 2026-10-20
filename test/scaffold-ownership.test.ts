/**
 * Covers SC-837, SC-838, SC-839, SC-840, SC-841, SC-842 (SCAFFOLD-DECOMPOSITION-SPEC.md).
 *
 * #208 — `.claude/rules/harness-managed.md` claimed five file classes were
 * "regenerated on re-scaffold". Four were. `test/scaffold-conformity.test.ts`
 * went through `safeWrite`, which returns early on `existsSync`, so it was
 * written once and skipped forever while the run reported
 * `SKIP (already exists)` — indistinguishable from "already current".
 *
 * The defect underneath is that **ownership was prose**. A table in a doc
 * cannot be iterated, so nothing could notice a row describing behaviour the
 * code did not have. These tests are mostly about that: the declaration is
 * data, the generator reads it, and the doc is reconciled against it in both
 * directions.
 *
 * AC-1 names the way this ships green for free: "a generator that rewrites
 * every file in the repo satisfies the regeneration criteria". The
 * unowned-file case is the positive control that separates them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  OWNED_FILES,
  SCAFFOLD_REFUSE,
  bytesIdentical,
  commentSha,
  decideOwnedWrite,
  declaredCommentSha,
  ownedFilesTable,
  stampComment,
} from "../lib/scaffold/owned-files";
import {
  createCiWorkflows,
  generateConformityTest,
  ownedSections,
  ownedStrategy,
  regenerateOwned,
  safeWrite,
} from "../lib/scaffold/steps";
// The truth about what a generated workflow contains. `jobNames` is the
// parser `mergeJobsSection` itself uses, so a case built on it reads the
// same job list the preservation logic does rather than a second opinion.
import { jobNames } from "../lib/scaffold/managed-workflow";
// From its owner, not re-exported. #208 shipped a second copy of this
// predicate in steps.ts; importing from the one place SC-811 names means a
// mutation of it reaches both callers.
import { isHarnessItself } from "../lib/generators/agents-md";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "rungate-owned-"));
  scratch.push(d);
  return d;
};

describe("#208 SC-837: the declared list and the iterated list are the same object", () => {
  test("every owned path resolves to its declared strategy", () => {
    // The reconciliation that matters most: `ownedStrategy` is what the
    // generator calls, and it must agree with the declaration for every
    // entry. A lookup that silently fell through to the default would make
    // the whole list decorative.
    for (const owned of OWNED_FILES) {
      const probe = owned.path.replace("*", "example");
      expect(ownedStrategy(probe), `${owned.path} did not resolve to its own strategy`)
        .toBe(owned.strategy);
    }
  });

  test("the list is not empty and every entry is complete", () => {
    expect(OWNED_FILES.length).toBeGreaterThan(4);
    for (const f of OWNED_FILES) {
      expect(f.path.length, "an entry has no path").toBeGreaterThan(0);
      expect(f.customize.length, `${f.path} says nothing about how to customize it`)
        .toBeGreaterThan(0);
      expect(f.avoid.length, `${f.path} says nothing to avoid`).toBeGreaterThan(0);
    }
  });

  // covers SC-2131 (AGENT-BRIEF-TEMPLATE-SPEC.md)
  test("SC-2131: every section-preserving row declares WHICH section", () => {
    // #655. `decideOwnedWrite`'s fourth parameter defaults to AGENTS.md's
    // `## Hard Constraints`, so a row that declared the strategy and no
    // section would merge a brief against a heading no brief has — and
    // `preserveSections` returns the generated content untouched when it
    // finds no section, which is byte-identical to the pre-#655 bug and
    // reports nothing. Silent Default Substitution in the one position the
    // declaration is supposed to be the whole answer.
    const preserving = OWNED_FILES.filter(f => f.strategy === "section-preserving");
    expect(preserving.length, "no section-preserving rows — this case has nothing to check")
      .toBeGreaterThan(1);
    for (const f of preserving) {
      expect(f.sections, `${f.path} is section-preserving and names no section`).toBeDefined();
      expect(f.sections!.label.length, `${f.path}'s section has no label`).toBeGreaterThan(0);
      expect(f.sections!.anchors.length, `${f.path}'s section has nowhere to be re-inserted`)
        .toBeGreaterThan(0);
      // The lookup the generator calls, not the row read directly — the
      // #208 lesson applied to the new field.
      expect(ownedSections(f.path.replace("*", "example"))).toBe(f.sections);
    }

    // And the two are DIFFERENT sections. One heading for both files would
    // make a rule written in the wrong file look like it was in the right
    // one, and no behavioural case can see that.
    const labels = new Set(preserving.map(f => f.sections!.label));
    expect(labels.size, "two section-preserving files share one heading").toBe(preserving.length);
  });

  test("the DA-owned files are create-only, and nothing has tidied them away", () => {
    // #296. They look like scaffold artifacts, which is exactly why they
    // need to be declared: four parallel worktrees each rewriting one
    // shared state document cost run wf_0b15a933-b2b 2,565 lines of work.
    for (const p of ["project-state.json", "PROJECT-STATE.md"]) {
      const entry = OWNED_FILES.find(f => f.path === p);
      expect(entry, `${p} is no longer declared — it will be regenerated`).toBeDefined();
      expect(entry!.strategy, `${p} would be overwritten by re-scaffold`).toBe("create-only");
    }
  });

  test("the DA-owned files survive a write that would change them", () => {
    // The declaration above is data. This is the behaviour, and the two are
    // separate cases for a measured reason: deleting the `create-only`
    // branch from `decideOwnedWrite` left the declaration test green,
    // because reading the strategy is not the same as honouring it.
    //
    // No strategy argument — it resolves through `ownedStrategy`, so the
    // declaration is in the path rather than bypassed by the test.
    for (const label of ["project-state.json", "PROJECT-STATE.md"]) {
      const d = dir();
      const p = join(d, label);
      writeFileSync(p, "the DA wrote this\n");
      const actions: string[] = [];
      regenerateOwned(p, "the scaffold's idea\n", label, actions);
      expect(readFileSync(p, "utf-8"), `${label} was overwritten — #296 all over again`)
        .toBe("the DA wrote this\n");
      expect(actions.join("\n")).toContain(`UNCHANGED: ${label}`);
      expect(actions.join("\n")).not.toMatch(new RegExp(`^CHANGED: ${label}`, "m"));
    }
  });

  test("the conformity test is declared regenerate, which is the whole of #208", () => {
    const entry = OWNED_FILES.find(f => f.path === "test/scaffold-conformity.test.ts");
    expect(entry?.strategy).toBe("regenerate");
  });

  test("an undeclared file regenerates rather than being skipped", () => {
    // The direction this is allowed to be wrong in. Defaulting to
    // create-only would make forgetting to declare a file look exactly
    // like the bug.
    expect(ownedStrategy("some/file/nobody/declared.md")).toBe("regenerate");
  });
});

describe("#208 SC-842: the generator knows when the project it is writing is the harness", () => {
  // This is what made the fix safe to ship rather than a one-line change to
  // `safeWrite`. The template emitted `from "rungate/lib/conformity"`
  // unconditionally; rungate's own copy on disk imported `"../lib/conformity"`
  // and ran a different check set. So the file had been hand-adapted, and
  // `safeWrite`'s skip was the only thing preserving the adaptation.
  // Regenerating without this distinction would have replaced a working
  // self-hosted suite with a consumer-shaped one that cannot resolve its own
  // import.

  const pkgDir = (name: string | null) => {
    const d = mkdtempSync(join(tmpdir(), "selfhost-"));
    scratch.push(d);
    if (name !== null) writeFileSync(join(d, "package.json"), JSON.stringify({ name }));
    return d;
  };

  test("the harness is recognised, a consumer is not, and neither is a dir with no package.json", () => {
    expect(isHarnessItself(ROOT), "rungate does not recognise itself").toBe(true);
    expect(isHarnessItself(pkgDir("some-consumer"))).toBe(false);
    expect(isHarnessItself(pkgDir(null)), "an absent package.json must not read as the harness")
      .toBe(false);
  });

  test("unparseable package.json reads as a consumer, not as the harness", () => {
    const d = mkdtempSync(join(tmpdir(), "selfhost-"));
    scratch.push(d);
    writeFileSync(join(d, "package.json"), "{ not json");
    // The direction this is allowed to be wrong in: a consumer emitting a
    // bare-specifier import fails loudly at resolution. The harness emitting
    // one fails the same way, but only after the file was overwritten.
    expect(isHarnessItself(d)).toBe(false);
  });

  test("the import specifier follows, in both directions", () => {
    expect(generateConformityTest(ROOT)).toContain(`from "../lib/conformity"`);
    expect(generateConformityTest(ROOT)).not.toContain(`from "rungate/lib/conformity"`);
    const consumer = generateConformityTest(pkgDir("some-consumer"));
    expect(consumer).toContain(`from "rungate/lib/conformity"`);
    expect(consumer).not.toContain(`from "../lib/conformity"`);
  });

  test("the shipped conformity test IS the generator's output", () => {
    // The reconciliation that makes "regenerated" an honest word. Without
    // it the generator can emit anything and the file on disk stays the
    // hand-adapted one, which is the state #208 found.
    expect(readFileSync(join(ROOT, "test", "scaffold-conformity.test.ts"), "utf-8"))
      .toBe(generateConformityTest(ROOT));
  });

  test("the generated suite passes no argument its entry points do not take", () => {
    // Every call used to pass a `findings` array. No entry point has ever
    // accepted one — findings accumulate in a module-level collector. It
    // typechecked nowhere and did nothing anywhere, and survived because
    // the only tree that typechecks this file is rungate's, whose copy was
    // the hand-adapted one.
    for (const line of generateConformityTest(ROOT).split("\n")) {
      const call = /^(run[A-Za-z]+)\((.*)\);$/.exec(line);
      if (!call) continue;
      expect(call[2], `${call[1]} is called with more than a root`).toBe("ROOT");
    }
  });

  test("the generated suite runs runDirectoryValidation, which the template had dropped", () => {
    // rungate's hand-adapted copy ran it; the template did not. Regenerating
    // without it would have deleted a live check — the same silent coverage
    // loss as #208, pointed the other way.
    expect(generateConformityTest(ROOT)).toContain("runDirectoryValidation(ROOT);");
  });
});

describe("#208 SC-838: a drifted owned file is rewritten, an unowned file is never touched", () => {
  test("a drifted owned file is rewritten", () => {
    const d = dir();
    const p = join(d, "owned.ts");
    writeFileSync(p, "stale\n");
    const actions: string[] = [];
    regenerateOwned(p, "fresh\n", "owned.ts", actions, "regenerate");
    expect(readFileSync(p, "utf-8"), "the drifted file was left alone").toBe("fresh\n");
    expect(actions.join("\n")).toContain("CHANGED: owned.ts");
  });

  test("an unowned file is never touched", () => {
    // AC-1's positive control. A generator that rewrites everything
    // satisfies the case above for free; this is what separates them.
    const d = dir();
    const p = join(d, "mine.md");
    writeFileSync(p, "a human wrote this\n");
    const actions: string[] = [];
    safeWrite(p, "the generator's idea\n", "mine.md", actions);
    expect(readFileSync(p, "utf-8"), "a create-only file was overwritten")
      .toBe("a human wrote this\n");
    expect(actions.join("\n")).toContain("UNCHANGED: mine.md");
  });

  test("a missing owned file is created", () => {
    const d = dir();
    const p = join(d, "nested", "new.ts");
    const actions: string[] = [];
    regenerateOwned(p, "body\n", "new.ts", actions, "regenerate");
    expect(readFileSync(p, "utf-8")).toBe("body\n");
    expect(actions.join("\n")).toContain("CREATED: new.ts");
  });

  test("the old skip message is gone from the generator", () => {
    // SC-838's negative half. `SKIP (already exists)` describes the check
    // that was performed; it reads as "already current" and that reading is
    // what let #208 sit unnoticed.
    const src = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(src, "the misleading skip message is back")
      .not.toContain("SKIP: ${label} (already exists)");
  });
});

describe("#208 SC-839: `0 changed` is a measurement, not the absence of an attempt", () => {
  test("identical bytes report UNCHANGED after looking", () => {
    const d = dir();
    const p = join(d, "same.ts");
    writeFileSync(p, "body\n");
    const actions: string[] = [];
    regenerateOwned(p, "body\n", "same.ts", actions, "regenerate");
    const line = actions.join("\n");
    expect(line).toContain("UNCHANGED: same.ts");
    expect(line, "the report does not say WHY it was unchanged").toContain("byte-identical");
    // Anchored, because "UNCHANGED" CONTAINS "CHANGED" — a substring
    // assertion here fails against the correct output and would have been
    // "fixed" by deleting it. Position, not string.
    expect(line).not.toMatch(/^CHANGED: same\.ts/m);
  });

  test("bytesIdentical is false for an absent file, not true for an empty one", () => {
    expect(bytesIdentical(null, "")).toBe(false);
    expect(bytesIdentical("", "")).toBe(true);
    expect(bytesIdentical("a", "b")).toBe(false);
  });

  test("running twice reports no change the second time", () => {
    // AC-4: idempotence proven on the diff, not on the absence of writes.
    const d = dir();
    const p = join(d, "twice.ts");
    const first: string[] = [];
    regenerateOwned(p, "body\n", "twice.ts", first, "regenerate");
    const second: string[] = [];
    regenerateOwned(p, "body\n", "twice.ts", second, "regenerate");
    expect(first.join("")).toContain("CREATED");
    expect(second.join(""), "the second run reported a change").toContain("UNCHANGED");
    expect(readFileSync(p, "utf-8")).toBe("body\n");
  });
});

describe("#208 SC-840: a hand-edited owned file is preserved and reported", () => {
  // AC-5 asked for the policy to be chosen and justified rather than
  // resolved implicitly. It is preserve-and-report, matching #370's answer
  // to the same question: the skipped file is still on disk, the
  // overwritten one is gone, and only one of those is recoverable.
  test("a stamped file the harness wrote is updated", () => {
    const existing = stampComment("old body\n");
    const d = decideOwnedWrite("provenance", existing, "new body\n");
    expect(d.action).toBe("changed");
    expect(d.content).toBe(stampComment("new body\n"));
  });

  test("a hand-edited stamped file is preserved", () => {
    const tampered = stampComment("old body\n").replace("old body", "a human's edit");
    const d = decideOwnedWrite("provenance", tampered, "new body\n");
    expect(d.action).toBe("preserve");
    expect(d.reason).toContain("hand-edited");
  });

  test("a file with no marker at all is preserved, not adopted", () => {
    const d = decideOwnedWrite("provenance", "hand-authored\n", "generated\n");
    expect(d.action).toBe("preserve");
    expect(d.reason).toContain("no harness provenance marker");
  });

  test("the refusal is reported in the actions, with a way out", () => {
    const d = dir();
    const p = join(d, "edited.ts");
    writeFileSync(p, "hand-authored\n");
    const actions: string[] = [];
    regenerateOwned(p, "generated\n", "edited.ts", actions, "provenance");
    const line = actions.join("\n");
    expect(line).toContain(`${SCAFFOLD_REFUSE}: edited.ts`);
    expect(line, "the report does not say how to accept the generator's version")
      .toContain("delete the file and re-run");
    expect(readFileSync(p, "utf-8"), "a hand-edit was destroyed").toBe("hand-authored\n");
  });

  test("the stamp round-trips and the marker is not part of the body", () => {
    const stamped = stampComment("x\n");
    expect(declaredCommentSha(stamped)).toBe(commentSha("x\n"));
    expect(stampComment(stamped), "re-stamping changed the bytes").toBe(stamped);
  });
});

describe("#208 SC-841: the doc table is generated, not written", () => {
  const RULE = join(ROOT, ".claude", "rules", "harness-managed.md");

  test("every row in harness-managed.md comes from OWNED_FILES", () => {
    const shipped = readFileSync(RULE, "utf-8");
    const rows = shipped
      .split("\n")
      .filter(l => /^\| `/.test(l))
      .map(l => l.split("|")[1].trim().replace(/`/g, ""));
    for (const path of rows) {
      expect(OWNED_FILES.some(f => f.path === path), `${path} is a row with no OWNED_FILES entry`)
        .toBe(true);
    }
  });

  test("every OWNED_FILES entry appears as a row", () => {
    // Both directions. One alone lets the list and the doc diverge in the
    // untested direction, which is #208 with the arrow reversed.
    const shipped = readFileSync(RULE, "utf-8");
    for (const f of OWNED_FILES) {
      expect(shipped, `${f.path} is declared but absent from harness-managed.md`)
        .toContain(`\`${f.path}\``);
    }
  });

  test("the shipped table is byte-identical to the generated one", () => {
    // The strongest form: not "the rows agree" but "the file contains
    // exactly what the generator would write". A hand-edit to the table is
    // caught here rather than discovered by a consumer.
    expect(readFileSync(RULE, "utf-8"), "harness-managed.md's table has drifted from OWNED_FILES")
      .toContain(ownedFilesTable());
  });

  test("the strategy of every row is stated, which is what the old table lacked", () => {
    const table = ownedFilesTable();
    for (const f of OWNED_FILES) {
      expect(table).toContain(`| \`${f.path}\` | ${f.strategy} |`);
    }
    expect(table, "the strategy column is missing").toContain("| Strategy |");
  });
});

/**
 * #739, the unguarded half of #618. Ids need allocating — these cases carry
 * no SC- prefix on purpose (`.claude/rules/parallel-sessions.md`: an id
 * chosen against this tree cannot see another session's unmerged branch).
 *
 * The three cases above all compare the shipped `.md` against
 * `ownedFilesTable()`, and **both sides are derived from `OWNED_FILES`**.
 * They prove the doc and the source agree; they say nothing about what the
 * source SAYS. Revert both `avoid` strings to "Don't edit the YAML — it
 * regenerates", re-scaffold, and every one of them stays green over a rule
 * that again tells consumers not to edit a file rungate only partly owns —
 * which is the whole of #618.
 *
 * So the truth here is not `OWNED_FILES`. It is what the generator EMITS:
 * `createCiWorkflows` is driven into a temp dir, each generated file is
 * read back, and `jobNames()` is the list the row has to name. That binds
 * the doc to the workflow rather than to itself, so renaming a generated
 * job without updating the row goes red too.
 *
 * **The precondition these fixtures hold, named** — the config declares no
 * `ci.shards`, which is the shape every consumer gets until they opt in.
 * At `shards > 1` the generator emits `test-shard` ALONGSIDE `test`
 * (`lib/scaffold/steps.ts`, and `test-shard` is in `HARNESS_OWNED_JOBS`),
 * and the row names only `test`. That is the same under-description #618
 * was filed over, surviving conditionally, and closing it means editing a
 * row in `lib/scaffold/owned-files.ts` — which #739 explicitly excludes.
 * Reported on the PR rather than pinned green here.
 */
describe("#739: a job-preserving row names the job the generator actually emits", () => {
  const RULE = join(ROOT, ".claude", "rules", "harness-managed.md");
  const JOB_PRESERVING = OWNED_FILES.filter(f => f.strategy === "job-preserving");

  /** The unsharded workflow set, read off disk rather than described. */
  const emitted = (): Map<string, string[]> => {
    const root = dir();
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ slug: "owned739", test: { command: "bun test", timeout: 300000 }, ci: {} }),
    );
    createCiWorkflows(root, [], { force: true });

    const out = new Map<string, string[]>();
    for (const f of JOB_PRESERVING) {
      const p = join(root, f.path);
      // Not a skip. A job-preserving row whose file this generator does not
      // write is a row nothing here can measure, and an unmeasured row must
      // not read as a satisfied one.
      if (!existsSync(p)) {
        throw new Error(
          `${f.path} is declared job-preserving and createCiWorkflows wrote no such file. ` +
            `UNMEASURED, not a pass — point this case at whatever generator owns it.`,
        );
      }
      out.set(f.path, jobNames(readFileSync(p, "utf-8")));
    }
    return out;
  };

  test("there are job-preserving rows to check at all", () => {
    // "Delete the entry" is one of the two cheap wrong fixes this repo keeps
    // seeing (`.claude/rules/checks-must-be-able-to-fail.md`). With an empty
    // filter every loop below is vacuously green, so the population is
    // asserted before anything is asserted about it.
    expect(JOB_PRESERVING.length, "no job-preserving rows — the cases below check nothing")
      .toBeGreaterThanOrEqual(2);
  });

  test("every emitted job name appears in the row's avoid and customize text", () => {
    const jobs = emitted();
    for (const f of JOB_PRESERVING) {
      const names = jobs.get(f.path)!;
      // A file the parser found no jobs in is an empty list, and every name
      // in an empty list trivially appears anywhere. Same reason the slice
      // cases assert their cut is non-empty.
      expect(names.length, `${f.path} was generated with no jobs in it — nothing to check`)
        .toBeGreaterThan(0);
      for (const name of names) {
        // The BACKTICKED name, not a substring. A bare `includes("test")`
        // is satisfied by the word "latest", so a row reading "Don't edit —
        // the latest scaffold rewrites it" would certify the regression
        // this case exists to block.
        expect(f.avoid, `${f.path}: avoid does not name the generated \`${name}\` job — ${JSON.stringify(f.avoid)}`)
          .toContain(`\`${name}\``);
        expect(
          f.customize,
          `${f.path}: customize does not name the generated \`${name}\` job — ${JSON.stringify(f.customize)}`,
        ).toContain(`\`${name}\``);
      }
    }
  });

  test("the shipped CELL in harness-managed.md names it too, not merely the row", () => {
    // Sliced twice, and the second slice is the one that matters.
    //
    // Not the page: `harness-managed.md` says in prose further down that
    // "rungate owns the `test` job in `ci.yml`", so a whole-file search is
    // satisfied by that sentence whatever the table says.
    //
    // And not the ROW either: a row whose `avoid` cell has been reverted to
    // "Don't edit the YAML" still carries "`test`" in its `customize` cell,
    // so a row-level search goes green over exactly the #618 state. One
    // cell answering for the other is the same defect as one document
    // answering for a section — `.claude/rules/checks-must-be-able-to-fail.md`,
    // "search the slice, not the document".
    const shipped = readFileSync(RULE, "utf-8").split("\n");
    const jobs = emitted();
    for (const f of JOB_PRESERVING) {
      const row = shipped.find(l => l.startsWith(`| \`${f.path}\` |`));
      expect(row, `${f.path} has no table row in harness-managed.md`).toBeDefined();
      // `| path | strategy | customize | avoid |` — leading and trailing
      // empties from the outer pipes, so the two cells are 3 and 4.
      const cells = row!.split("|").map(c => c.trim());
      expect(cells.length, `${f.path}'s row is not the four-column shape this reads`).toBe(6);
      const names = jobs.get(f.path)!;
      // Its own non-empty guard, not the one in the case above. Measured:
      // with `jobNames` short-circuited to `return []` this case was GREEN
      // and only its sibling went red — an instrument that stopped
      // reporting, leaving a vacuous loop behind it.
      expect(names.length, `${f.path} was generated with no jobs in it — nothing to check`)
        .toBeGreaterThan(0);
      for (const name of names) {
        expect(cells[3], `${f.path}'s shipped customize cell does not name the generated \`${name}\` job`)
          .toContain(`\`${name}\``);
        expect(cells[4], `${f.path}'s shipped avoid cell does not name the generated \`${name}\` job`)
          .toContain(`\`${name}\``);
      }
    }
  });
});

describe("#208 AC-2: measured on this repo", () => {
  test("re-scaffolding rungate regenerates the conformity test rather than skipping it", () => {
    // The regression, executed. A clone is used rather than this tree so
    // the test cannot alter the repo it is measuring.
    const work = dir();
    const clone = join(work, "repo");
    mkdirSync(clone, { recursive: true });
    execSync(`git clone --depth 1 --quiet "${ROOT}" "${clone}"`, { stdio: "pipe" });

    // git clone only carries committed refs, so working-tree changes have
    // to be copied in or the run measures the old behaviour and passes for
    // the wrong reason. Learned the hard way on #370.
    //
    // ASKED FOR, not listed. The first version named four files, and the
    // next change added a fifth — `lib/harness-identity.ts`, untracked —
    // so the clone could not resolve an import and the case failed for a
    // reason that had nothing to do with what it measures. A hand-kept list
    // of "files that matter" is a detector narrower than what it detects;
    // git already knows the answer.
    const dirty = execSync(`git -C "${ROOT}" status --porcelain --untracked-files=all`, {
      encoding: "utf-8",
    })
      .split("\n")
      .map(l => l.slice(3).trim())
      .filter(rel => rel && !rel.startsWith(".claude/worktrees/") && existsSync(join(ROOT, rel)))
      // `--untracked-files=all` descends into untracked DIRECTORIES but not
      // through a symlink to one, which it reports as a single entry. Under
      // `scripts/test-clean-env.ts` the CI-shaped checkout has exactly that:
      // `node_modules` is symlinked in, so this list contained one path whose
      // `readFileSync` is EISDIR and the case died for a reason that has
      // nothing to do with scaffolding (#183). The filter is on what the path
      // IS rather than on its name — a name filter would be a list again.
      .filter(rel => statSync(join(ROOT, rel)).isFile());
    for (const rel of dirty) {
      mkdirSync(dirname(join(clone, rel)), { recursive: true });
      writeFileSync(join(clone, rel), readFileSync(join(ROOT, rel)));
    }

    // The invariant, asserted rather than the copy. A first draft demanded
    // `dirty.length > 0` and failed on CI for a correct reason: there the
    // tree is clean, the clone of HEAD already carries the change, and
    // copying nothing is right. "Something was dirty" is a fact about one
    // machine. "The clone's sources are the ones under test" is the fact
    // the case actually depends on, and it holds in both places.
    for (const rel of ["lib/scaffold/steps.ts", "scripts/scaffold-project.ts"]) {
      expect(
        readFileSync(join(clone, rel), "utf-8"),
        `${rel} in the clone is not the one being tested — the fixture would measure HEAD`,
      ).toBe(readFileSync(join(ROOT, rel), "utf-8"));
    }

    // Dependencies too. A clone has no `node_modules`, so the scaffold's
    // own `import { z } from "zod"` cannot resolve from /tmp. It passed
    // locally because bun fell back to auto-install and failed on CI where
    // that is off — the difference is removed rather than the failure
    // skipped, so both sides run the same thing for the same reason.
    symlinkSync(join(ROOT, "node_modules"), join(clone, "node_modules"), "dir");

    const conformity = join(clone, "test", "scaffold-conformity.test.ts");
    expect(existsSync(conformity), "the fixture does not have the file under test").toBe(true);
    writeFileSync(conformity, "// drifted\n");

    const out = execSync(`bun "${join(clone, "scripts", "scaffold-project.ts")}" "${clone}" --fix`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });

    expect(out, "the conformity test was skipped again")
      .not.toMatch(/SKIP: test\/scaffold-conformity\.test\.ts/);
    expect(readFileSync(conformity, "utf-8"), "the drifted conformity test was not regenerated")
      .not.toBe("// drifted\n");
  }, 240_000);
});

/**
 * #507: the symlink refusal belongs to the WRITER, not to one file.
 *
 * The hole was found by the security review of PR #502 and fixed there, in
 * `regenerateOwned` — the writer every owned file goes through. The case
 * that shipped with it drives `seedSuccessDoc`, which is `create-only`, and
 * says so: *"Asserted through SUCCESS.md because that is this PR's file."*
 *
 * Every other owned file is `regenerate` or `provenance`, and those are the
 * ones rewritten on every run. A refusal proven on one strategy and
 * described as belonging to all of them is the gap #507 exists to record,
 * so it is measured here rather than recorded.
 */
describe("#507 SC-1949: no owned file is written through a symlink, whatever its strategy", () => {
  const victimRoot = () => {
    const d = mkdtempSync(join(tmpdir(), "rungate-507-victim-"));
    scratch.push(d);
    return d;
  };

  test("a DANGLING symlink is refused on a regenerate-strategy file", () => {
    // Dangling is the input the two calls disagree about: `existsSync`
    // resolves the link and reports absent, `writeFileSync` follows it and
    // creates the target. Anywhere on the filesystem.
    const root = dir();
    const outside = victimRoot();
    const escaped = join(outside, "escaped.md");
    symlinkSync(escaped, join(root, "CODE-MAP.md"));
    expect(ownedStrategy("CODE-MAP.md"), "the fixture is not on the strategy it claims")
      .toBe("regenerate");
    expect(existsSync(join(root, "CODE-MAP.md")), "the fixture's link is not dangling").toBe(false);

    const actions: string[] = [];
    regenerateOwned(join(root, "CODE-MAP.md"), "# generated\n", "CODE-MAP.md", actions);

    expect(actions.join("\n"), "the writer wrote through the link").toContain(SCAFFOLD_REFUSE);
    expect(actions.join("\n")).toContain("is a symlink");
    expect(existsSync(escaped), "the scaffold wrote outside the project root").toBe(false);
  });

  test("a LIVE symlink to a file outside the project is refused too", () => {
    // The other half, and the one a dangling-only fix would miss: the
    // target exists, so `existsSync` and `writeFileSync` agree — and they
    // agree on overwriting somebody else's file.
    const root = dir();
    const outside = victimRoot();
    const victim = join(outside, "theirs.md");
    writeFileSync(victim, "do not touch\n");
    symlinkSync(victim, join(root, "AGENTS.md"));

    const actions: string[] = [];
    regenerateOwned(join(root, "AGENTS.md"), "# generated\n", "AGENTS.md", actions);

    expect(actions.join("\n")).toContain("is a symlink");
    expect(readFileSync(victim, "utf-8"), "the generator overwrote a file outside the project")
      .toBe("do not touch\n");
  });

  test("a real file on the same strategy is still written — the positive control", () => {
    // Without this, a writer that refused everything would satisfy both
    // cases above and the scaffold would be inert.
    const root = dir();
    const actions: string[] = [];
    regenerateOwned(join(root, "CODE-MAP.md"), "# generated\n", "CODE-MAP.md", actions);
    expect(readFileSync(join(root, "CODE-MAP.md"), "utf-8")).toContain("# generated");
    expect(actions.join("\n")).not.toContain(SCAFFOLD_REFUSE);
  });
});
