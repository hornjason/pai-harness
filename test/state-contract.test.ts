import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * #317 — `workflow-state.json` and the schema that claims to describe it are
 * reconciled mechanically.
 *
 * This is the one file every gate reads, and nothing checked that its
 * producers and its consumers were talking about the same fields.
 * `writeWorkflowState` validates with `.passthrough()`, so an undeclared field
 * is neither rejected nor stripped — it is invisible to the contract. A
 * producer can write `treeUnderTes`, the reader sees `undefined`, and most
 * checks early-return on `undefined`, so the run goes green. That is the
 * fail-open shape `.claude/rules/checks-must-be-able-to-fail.md` names, in the
 * place it costs the most.
 *
 * The three sets are extracted from source on every run rather than listed, so
 * the reconciliation cannot go stale the way a hand-maintained inventory does.
 * Measured at `cd647770`, before the fix: three fields were written and never
 * declared (`buildCommit`, which gates shipping, plus `compliance` and
 * `mergeCommitSha`), and two were declared and touched by nothing at all
 * (`proofOfFix`, `quinnJourneyPath`).
 */

/**
 * The three readings live in `scripts/contract-parity.ts` (#626).
 *
 * They were written here and moved there when `contract-parity`'s field
 * reachability category came to need them. A script cannot import a file that
 * calls `describe` at module scope, so the alternative was a second copy of
 * the schema walk — a producer and a consumer that must agree with nothing
 * comparing them, which is the defect #626 exists to find, committed by the
 * check built to find it. One binding each, so there is one site to mutate,
 * and the cases below are unchanged.
 */
import {
  SOURCE_DIRS,
  orphanDeclarationViolations,
  readFields,
  stateTouchingFiles,
  undeclaredReadViolations,
  undeclaredWriteViolations,
  writtenFields,
} from "../scripts/contract-parity";

export {
  orphanDeclarationViolations,
  readFields,
  stateTouchingFiles,
  undeclaredReadViolations,
  undeclaredWriteViolations,
  writtenFields,
};

const ROOT = join(import.meta.dir, "..");

describe("#317: the workflow-state contract is reconciled with its producers and consumers", () => {
  test("every field a gate READS is declared in the schema", () => {
    // `buildCommit` was exactly this: it decides at the ship gate whether a
    // run has a commit at all, and the schema had never heard of it.
    const v = undeclaredReadViolations();
    expect(v, `undeclared fields are being read:\n${v.join("\n")}`).toEqual([]);
  });

  test("every field a producer WRITES is declared in the schema", () => {
    // `.passthrough()` means an undeclared write is accepted silently, so this
    // is the only thing standing between the state file and a typo'd field
    // name that no reader will ever see.
    const v = undeclaredWriteViolations();
    expect(v, `undeclared fields are being written:\n${v.join("\n")}`).toEqual([]);
  });

  test("every field the schema DECLARES is read or written by something", () => {
    // The other direction, and the one a contract usually lacks. A declared
    // field nobody produces is a reader's trap: any check that comes to rely
    // on it passes vacuously, forever, because the value is always undefined.
    const v = orphanDeclarationViolations();
    expect(
      v,
      `the schema declares fields nothing in gates/, lib/, scripts/ or ` +
        `workflows/ produces or consumes: ${v.join(", ")}`,
    ).toEqual([]);
  });

  test("the reconciliation is looking at a real corpus", () => {
    // Every assertion above is a filter over three extracted sets, and all
    // three are satisfied by extracting nothing. This is the control: an
    // extractor that silently stops matching — a renamed helper, a moved
    // directory, a regex that no longer fits the source — would otherwise turn
    // this whole file green while checking nothing.
    expect(stateTouchingFiles().length, "no files touching workflow-state.json").toBeGreaterThan(20);
    expect(readFields().size, "no sf() reads found").toBeGreaterThan(10);
    expect(writtenFields().size, "no state writes found").toBeGreaterThan(10);
  });
});

/**
 * The reconciliations run against a planted tree, so that "green on the repo"
 * is not the only evidence they work.
 *
 * Green on the repo is what a reconciliation that matches nothing also looks
 * like. The corpus control above rules out the empty-extraction case; these
 * rule out the rest, by building a four-file harness in a scratch directory
 * where each violation is present by construction and each is then removed.
 * Every case is paired — a check that refuses unconditionally satisfies the
 * red half on its own.
 */
describe("#317: each reconciliation is able to fail", () => {
  const SCRATCH = mkdtempSync(join(ROOT, ".state-contract-scratch-"));

  /** A miniature harness: a schema, a reader and a writer. */
  function plant(opts: { declared: string[]; read: string[]; written: string[] }): string {
    rmSync(SCRATCH, { recursive: true, force: true });
    for (const d of SOURCE_DIRS) mkdirSync(join(SCRATCH, d), { recursive: true });
    writeFileSync(
      join(SCRATCH, "gates", "schema.ts"),
      `export const WorkflowStateSchema = z.object({\n` +
        opts.declared.map(f => `  ${f}: z.string().optional(),`).join("\n") +
        `\n});\n`,
    );
    // Both mention workflow-state.json, which is how the derived file set
    // finds them — the same way it finds the real producers.
    writeFileSync(
      join(SCRATCH, "gates", "reader.ts"),
      `// reads workflow-state.json\n` + opts.read.map(f => `const _${f} = sf("${f}");`).join("\n") + "\n",
    );
    writeFileSync(
      join(SCRATCH, "scripts", "writer.ts"),
      `// writes workflow-state.json\n` + opts.written.map(f => `state.${f} = "x";`).join("\n") + "\n",
    );
    return SCRATCH;
  }

  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  // A schema big enough to clear `declaredFields`' floor of 10, so the planted
  // cases exercise the reconciliation rather than its own sanity check.
  const BASE = Array.from({ length: 12 }, (_, i) => `field${i}`);

  test("an undeclared READ is caught, and declaring it clears the violation", () => {
    const red = undeclaredReadViolations(plant({ declared: BASE, read: [...BASE, "ghostRead"], written: BASE }));
    expect(red.join("\n")).toContain("ghostRead");

    const green = undeclaredReadViolations(
      plant({ declared: [...BASE, "ghostRead"], read: [...BASE, "ghostRead"], written: BASE }),
    );
    expect(green, "declaring the field did not clear the violation").toEqual([]);
  });

  test("an undeclared WRITE is caught, and declaring it clears the violation", () => {
    // The typo case, which is the one `.passthrough()` makes invisible at
    // runtime: a producer writing a field name no reader will ever match.
    const red = undeclaredWriteViolations(plant({ declared: BASE, read: BASE, written: [...BASE, "treeUnderTes"] }));
    expect(red.join("\n")).toContain("treeUnderTes");

    const green = undeclaredWriteViolations(
      plant({ declared: [...BASE, "treeUnderTes"], read: BASE, written: [...BASE, "treeUnderTes"] }),
    );
    expect(green, "declaring the field did not clear the violation").toEqual([]);
  });

  test("a DECLARED field nothing produces is caught, and giving it a writer clears it", () => {
    const red = orphanDeclarationViolations(plant({ declared: [...BASE, "orphan"], read: BASE, written: BASE }));
    expect(red).toContain("orphan");

    const green = orphanDeclarationViolations(
      plant({ declared: [...BASE, "orphan"], read: BASE, written: [...BASE, "orphan"] }),
    );
    expect(green, "giving the field a producer did not clear the violation").toEqual([]);
  });
});
