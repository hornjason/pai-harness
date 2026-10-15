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
  generateConformityTest,
  ownedStrategy,
  regenerateOwned,
  safeWrite,
} from "../lib/scaffold/steps";
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
