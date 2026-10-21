/**
 * #979 — the harness must hold exactly ONE managed-write path.
 *
 * `lib/scaffold/managed-workflow.ts` shipped a second, complete implementation
 * of the managed write — `planManagedWrite`, its own `harnessRegion`
 * extraction, its own `stripMarker`/`stampMarker` pair and its own
 * `# rungate-managed-sha256:` provenance format — beside the live
 * `createCiWorkflows -> writeManagedFile -> resolveManagedWrite ->
 * mergeManagedWorkflow` chain, which stamps `# generated-sha:`.
 *
 * ## Why a test rather than only a deletion
 *
 * The standing risk is not that module. It is that this repository can hold
 * two implementations of one feature and nothing notices, and the dead one
 * had the more descriptive names. #957 named `planManagedWrite` as the place a
 * provenance proof should live; an agent that took that at face value would
 * have written a correct-looking fix, with a green battery over it, in code no
 * execution path reaches — and the green would have been read as evidence
 * about the live path. It was caught only because someone went looking for the
 * caller.
 *
 * It had already escaped the repository. A consumer's own
 * `.claude/rules/harness-managed.md` describes `# rungate-managed-sha256:` as
 * the mechanism that decides whether their workflow is overwritten, and says
 * so "verified in the rungate source rather than inferred" — a true reading of
 * a module that has never run.
 *
 * ## What each case is
 *
 * Both cases are WITNESSES: each has a demonstrated failing input, namely the
 * tree as it stood before this file was added, where §1 measured 2 and §2
 * measured one unwritten marker. The `toBeGreaterThan(0)` assertions inside
 * them are INSTRUMENT CONTROLS — they prove the scan found something to read,
 * so a rename that matches nothing fails loudly instead of passing at zero,
 * which is the shape a count-based guard dies of.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";

const HARNESS = join(import.meta.dir, "..");

/** Every `.ts` file under `lib/`, recursively. */
function libFiles(dir = join(HARNESS, "lib")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...libFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `path` relative to the harness root, for a failure message worth reading. */
const rel = (f: string) => f.slice(HARNESS.length + 1);

const LIB = libFiles();

describe("#979: one managed-write path", () => {
  test("the instrument reads the tree it claims to read", () => {
    // Control. A recursive walk that silently stops finding files reports the
    // same clean zero as a clean tree, and both cases below are counts.
    expect(LIB.length, "the lib/ walk found no TypeScript files at all").toBeGreaterThan(50);
  });

  test("exactly one binding decides the verb of a managed write", () => {
    // The verb union is the signature of a managed-write decider: a function
    // that turns BEFORE and AFTER content into bytes, a verb, and a possible
    // refusal. Two of them is two answers to one question.
    //
    // Matched on the union's own text rather than on a list of known file
    // names, so a third implementation in a file nobody has thought of is
    // caught the same way.
    const deciders = LIB.filter(f => /"CREATED"\s*\|\s*"UPDATED"/.test(readFileSync(f, "utf-8"))).map(rel).sort();

    expect(deciders.length, "the verb-union pattern matched nothing — it was renamed, not removed").toBeGreaterThan(0);
    expect(
      deciders,
      "more than one binding decides a managed write. A second implementation of a shipped " +
        "feature is discoverable by name and reachable by nothing, so a fix written into it is " +
        "green and inert (#979). Delete the one nothing calls, or wire it and delete the other — " +
        "do not add it to this list.",
    ).toEqual(["lib/scaffold/steps.ts"]);
  });

  test("every provenance marker the harness declares is a marker it writes", () => {
    // A digest marker that no generated file carries cannot be proving
    // anything about any file, and reads to a consumer exactly like one that
    // does. This is the case that would have refused the dead module on the
    // day it stopped being written, and the one whose absence let a consumer
    // document `# rungate-managed-sha256:` as live.
    //
    // The declarations are read out of the source and the evidence out of the
    // real generator. Neither side is a list this file keeps.
    const declared = LIB.flatMap(f => {
      const matches = readFileSync(f, "utf-8").matchAll(
        /^export const ([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=\s*"([^"]*(?:sha256|generated-sha)[^"]*)"/gm,
      );
      return [...matches].map(m => ({ file: rel(f), name: m[1], literal: m[2] }));
    });

    expect(declared.length, "no provenance marker constant was found — the pattern no longer matches").toBeGreaterThan(
      0,
    );

    const root = mkdtempSync(join(tmpdir(), "rungate-979-"));
    let rendered: string;
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      createCiWorkflows(root, []);
      const dir = join(root, ".github", "workflows");
      rendered = readdirSync(dir)
        .map(f => readFileSync(join(dir, f), "utf-8"))
        .join("\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(rendered, "the generator wrote no workflow to measure against").toContain("jobs:");

    const unwritten = declared.filter(d => !rendered.includes(d.literal.trim()));
    expect(
      unwritten.map(d => `${d.name} (${d.file}) = ${JSON.stringify(d.literal)}`),
      "a provenance marker is declared and never written. Nothing on disk carries it, so the " +
        "code that reads it has never run and the format it documents does not exist (#979). " +
        "Delete it, or make the generator stamp it.",
    ).toEqual([]);
  });
});
