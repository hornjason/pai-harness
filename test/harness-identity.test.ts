/**
 * Covers SC-843, SC-844, SC-845 (SCAFFOLD-DECOMPOSITION-SPEC.md).
 *
 * "Is the project being scaffolded the harness itself?" was answered in four
 * places with four inline implementations. #208 added the fourth — and the
 * commit message for it argued, about a different function, that two deciders
 * of the same fact survive any mutation of either. It was right, and the
 * change it shipped did the thing it warned about.
 *
 * The copies had already drifted, which is the concrete harm rather than the
 * tidiness argument:
 *
 * | site | unreadable package.json |
 * |---|---|
 * | `isHarnessItself` (the owner) | caught — reads as a consumer |
 * | `generateAgentBriefsStep`'s `isSelf` | **throws**, killing the scaffold run |
 * | `lib/scanner.ts` | caught |
 * | `lib/conformity.ts` PKG-3 | caught |
 *
 * Three of four agreed. Nothing could notice the fourth, because there was
 * nothing to compare it against.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isHarnessItself } from "../lib/generators/agents-md";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function fixture(pkg: string | null): string {
  const d = mkdtempSync(join(tmpdir(), "harness-id-"));
  scratch.push(d);
  if (pkg !== null) writeFileSync(join(d, "package.json"), pkg);
  return d;
}

describe("#380 SC-843: one predicate decides whether the project is the harness", () => {
  test("it answers the four cases, and the error cases do not throw", () => {
    expect(isHarnessItself(ROOT), "rungate does not recognise itself").toBe(true);
    expect(isHarnessItself(fixture(JSON.stringify({ name: "a-consumer" })))).toBe(false);
    expect(isHarnessItself(fixture(null)), "an absent package.json read as the harness")
      .toBe(false);
    // The drift that mattered. `generateAgentBriefsStep` had no try/catch, so
    // a half-written package.json aborted the whole scaffold run there and
    // was a shrug everywhere else.
    expect(() => isHarnessItself(fixture("{ not json"))).not.toThrow();
    expect(isHarnessItself(fixture("{ not json"))).toBe(false);
  });

  test("a package merely named LIKE the harness is not the harness", () => {
    // The direction this is allowed to be wrong in is toward "consumer": a
    // consumer form that runs in the harness is visibly wrong on the first
    // command, where the source form in a consumer resolves to nothing.
    expect(isHarnessItself(fixture(JSON.stringify({ name: "rungate-plugin" })))).toBe(false);
    expect(isHarnessItself(fixture(JSON.stringify({ name: "@scope/rungate" })))).toBe(false);
    expect(isHarnessItself(fixture(JSON.stringify({ name: "Rungate" })))).toBe(false);
  });
});

describe("#380 SC-844: there is one implementation, so there is one binding to mutate", () => {
  /** Every `.ts` file under lib/, excluding generated and vendored trees. */
  function libSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) libSources(p, out);
      else if (entry.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  /**
   * A comparison of a package name against the harness's own name.
   *
   * Two forms, and the second is not optional. The owner compares against
   * `HARNESS_PACKAGE` rather than the literal, so a detector that only knew
   * the literal would find ZERO sites — and `toEqual([...])` against zero is
   * the vacuous pass this whole file exists to prevent. The constant
   * indirection would have bought green by blindness, in the one check
   * written to stop exactly that.
   *
   * Deliberately NOT a search for the bare word `rungate`: it appears in
   * paths, messages and dependency keys throughout lib/, and counting those
   * would make the detector satisfied by prose — shape two of
   * `.claude/rules/checks-must-be-able-to-fail.md`.
   */
  const IDENTITY_COMPARISON = /name\s*===\s*(?:"rungate"|HARNESS_PACKAGE)/g;

  test("exactly one source in lib/ compares a package name to the harness's", () => {
    const sites: string[] = [];
    for (const file of libSources(join(ROOT, "lib"))) {
      const hits = readFileSync(file, "utf-8").match(IDENTITY_COMPARISON);
      if (hits) sites.push(`${file.slice(ROOT.length + 1)} (${hits.length})`);
    }
    expect(
      sites,
      `"is this the harness" is decided in more than one place:\n  ${sites.join("\n  ")}\n` +
        `Import isHarnessItself from lib/harness-identity.ts instead.`,
    ).toEqual(["lib/harness-identity.ts (1)"]);
  });

  test("the detector sees both forms, and is not satisfied by the bare word", () => {
    // The check's own positive control, in both directions. An exact-match
    // assertion on a list passes just as happily when the scan reaches
    // nothing at all, so the scan is proven to see sites it was not told
    // about — including the constant form, which is how the real one is
    // written and how a copy would most plausibly be written too.
    expect(`if (pkg.name === "rungate") return true;`.match(IDENTITY_COMPARISON)).toHaveLength(1);
    expect(`return p?.name === HARNESS_PACKAGE;`.match(IDENTITY_COMPARISON)).toHaveLength(1);
    expect(`const n = "rungate";`.match(IDENTITY_COMPARISON)).toBeNull();
    expect(`devDependencies["rungate"]`.match(IDENTITY_COMPARISON)).toBeNull();
    expect(`"node_modules/rungate/prompts"`.match(IDENTITY_COMPARISON)).toBeNull();
  });

  test("the owner is a leaf: it imports nothing that could pull a generator in", () => {
    // The reason the predicate moved here rather than staying where SC-811
    // named it. If this module grows an import, `lib/scanner.ts` starts
    // dragging it behind, and SC-365 / AC-3 is the constraint that forced
    // the move in the first place.
    const src = readFileSync(join(ROOT, "lib", "harness-identity.ts"), "utf-8");
    const imports = [...src.matchAll(/^import .*? from "(.+?)";$/gm)].map(m => m[1]);
    expect(imports.sort()).toEqual(["fs", "path"]);
  });

  test("the callers import it rather than reimplementing it", () => {
    for (const rel of [
      "lib/scaffold/steps.ts",
      "lib/scanner.ts",
      "lib/conformity.ts",
      "lib/generators/agents-md.ts",
    ]) {
      expect(readFileSync(join(ROOT, rel), "utf-8"), `${rel} does not import the predicate`)
        .toContain("isHarnessItself");
    }
  });

  test("the name SC-811 named still resolves, and to the same binding", () => {
    // `agents-md.ts` re-exports it. A re-export is one binding under two
    // names, which is the opposite of two deciders — but only if it really
    // is the same function object, so that is asserted rather than assumed.
    const viaOwner = require("../lib/harness-identity").isHarnessItself;
    const viaGenerator = require("../lib/generators/agents-md").isHarnessItself;
    expect(viaGenerator).toBe(viaOwner);
  });
});
