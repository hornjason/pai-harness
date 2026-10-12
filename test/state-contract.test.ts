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

const ROOT = join(import.meta.dir, "..");
const SOURCE_DIRS = ["gates", "lib", "scripts", "workflows"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Dotted entries are caches and scratch trees, never harness source.
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The files that touch the shared state, DERIVED rather than enumerated.
 *
 * A list would have to be edited by whoever adds the next writer, which is
 * precisely the person whose change this test exists to catch: a new producer
 * joins the harness by being left off the list, and the reconciliation reports
 * green over a field it never saw. Deriving the set means a new writer is in
 * scope the moment it mentions the file it writes.
 */
function stateTouchingFiles(root = ROOT): string[] {
  return SOURCE_DIRS.flatMap(d => walk(join(root, d))).filter(f => {
    const src = readFileSync(f, "utf-8");
    return src.includes("workflow-state.json") || src.includes("writeWorkflowState");
  });
}

/** Top-level field names of `WorkflowStateSchema`. */
function declaredFields(root = ROOT): Set<string> {
  const schema = readFileSync(join(root, "gates", "schema.ts"), "utf-8");
  const start = schema.indexOf("export const WorkflowStateSchema");
  expect(start, "WorkflowStateSchema is not where this test expects it").toBeGreaterThan(-1);
  const body = schema.slice(start);
  const end = body.indexOf("\n})");
  expect(end, "could not find the end of WorkflowStateSchema").toBeGreaterThan(-1);
  const names = (body.slice(0, end).match(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm) || [])
    .map(m => m.trim().replace(":", ""));
  // A zero-length reading is the vacuous case: every assertion below compares
  // against this set, and an empty one makes all three pass over anything.
  expect(names.length, "no fields parsed out of WorkflowStateSchema").toBeGreaterThan(10);
  return new Set(names);
}

/** Every `sf("<field>")` the gate suites read, root segment only. */
function readFields(root = ROOT): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of stateTouchingFiles(root)) {
    for (const m of readFileSync(f, "utf-8").matchAll(/sf\("([a-zA-Z][a-zA-Z0-9]*)/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1])!.push(f.replace(`${root}/`, ""));
    }
  }
  return found;
}

/**
 * Every `<ident>.<field> =` assignment onto a state object.
 *
 * Test files are excluded, and deliberately: a fixture planting a field is not
 * a producer. Counting one would let a dead schema term stay alive on the
 * strength of the fixture that mentions it — the self-reference trap, where
 * the evidence for a field being used is a file that exists only to exercise
 * it.
 */
function writtenFields(root = ROOT): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of stateTouchingFiles(root)) {
    if (/\.test\.(ts|js)$/.test(f)) continue;
    const src = readFileSync(f, "utf-8");
    for (const m of src.matchAll(/\b(?:state|s|ws|st)\.([a-zA-Z][a-zA-Z0-9]*)\s*(?:=[^=]|\?\?=)/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1])!.push(f.replace(`${root}/`, ""));
    }
  }
  return found;
}

/**
 * Whether a field name appears at all in non-test harness source, outside the
 * schema that declares it and the guide that documents it.
 *
 * This is deliberately the weakest of the three readings, and it is weak on
 * purpose. Most of the state is built as an object literal at bootstrap —
 * `{ schemaVersion: 2, startTs, ... }` — which the assignment regex above
 * cannot see, so a stricter test here would report a dozen live fields as
 * dead. What it still catches is the case that matters and admits no
 * innocent reading: a field the contract declares whose NAME occurs nowhere
 * in the harness at all. Nothing can be producing it, so every reader of it
 * is reading `undefined` forever.
 *
 * An earlier draft of this used "appears as an object-literal key anywhere in
 * a state-touching file", which matched every `name:` in every unrelated
 * literal in those files and passed over both known-dead fields. A reading
 * that broad is not evidence; it is the vacuous assertion this file is about.
 */
function mentionedInSource(field: string, root = ROOT): string[] {
  const word = new RegExp(`\\b${field}\\b`);
  return SOURCE_DIRS.flatMap(d => walk(join(root, d)))
    .filter(f => !/\.test\.(ts|js)$/.test(f))
    .filter(f => f !== join(root, "gates", "schema.ts"))
    .filter(f => word.test(readFileSync(f, "utf-8")))
    .map(f => f.replace(`${root}/`, ""));
}

// ── The three reconciliations ─────────────────────────────────────────
//
// Each is one exported function turning a reading into a list of violations,
// which is the shape .claude/rules/checks-must-be-able-to-fail.md prescribes
// for a guard with no exit code of its own: a single site to mutate, and a
// `root` parameter so the whole reconciliation can be run against a planted
// tree instead of the repo.

/** A check reading a field the contract does not describe. */
export function undeclaredReadViolations(root = ROOT): string[] {
  const declared = declaredFields(root);
  return [...readFields(root).entries()]
    .filter(([field]) => !declared.has(field))
    .map(([field, files]) => `${field} — read by ${[...new Set(files)].join(", ")}`);
}

/** A producer writing a field nothing promises to keep. */
export function undeclaredWriteViolations(root = ROOT): string[] {
  const declared = declaredFields(root);
  return [...writtenFields(root).entries()]
    .filter(([field]) => !declared.has(field))
    .map(([field, files]) => `${field} — written by ${[...new Set(files)].join(", ")}`);
}

/** A contract term nothing in the harness honours. */
export function orphanDeclarationViolations(root = ROOT): string[] {
  const read = readFields(root);
  const written = writtenFields(root);
  return [...declaredFields(root)].filter(
    f => !read.has(f) && !written.has(f) && mentionedInSource(f, root).length === 0,
  );
}

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
