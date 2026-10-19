/**
 * Covers SC-2151..SC-2157 (HARNESS-STANDARD.md), #606.
 *
 * `allocateScNumber` wrote `status: "read"` on three legs it never probed.
 * Measured on a tree holding one spec and none of `test/`, `lib/`, `scripts/`
 * or `gates/`:
 *
 *     {"kind":"source-mentions","status":"read","found":0,"reason":null}
 *
 * …which is also the output for a tree whose four directories were walked and
 * held no ids. A consumer whose tests live in `tests/` or `src/` produced the
 * first every run and the reading said it had asked.
 *
 * ## What this file must do that a count cannot
 *
 * Every case here pairs two trees whose `found` is EQUAL and asserts they are
 * still distinguishable. That is deliberate: `found` is the proxy, and the
 * cheapest wrong fix — flip the leg to `skipped` when `found === 0` — makes
 * the reported symptom go away while swapping the two cases instead of
 * separating them. A case built on `found` certifies that repair
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fifth shape).
 *
 * ## Why the fixtures are real git repositories
 *
 * `readScNamespace` shells out to `git worktree list` and `git for-each-ref`.
 * In a plain temp directory both fail and the reading correctly records two
 * further skipped sources — which would make every assertion about "how many
 * legs were skipped" a statement about git rather than about the legs this
 * issue is for. `git init` costs about a second and removes that variable.
 *
 * ## Why the planted ids are assembled at runtime
 *
 * `test/sc-fixture-namespace.test.ts` SC-1522 requires every SC id spelled
 * literally in source to be a real registry id or to sit above the 9000
 * fixture floor. The ids below are neither, so they are built from a number
 * and never appear in this file's text.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { allocateScNumber } from "../lib/create-sc";
import { describeReading } from "../lib/sc-id-cross-tree";
import type { SourceReading } from "../lib/sc-id-cross-tree";
import {
  buildScRegistry,
  SC_SOURCE_DIRS,
  scIdsSpelledInSourceReading,
  scMentionsInSource,
  unenumeratedScRegistry,
} from "../lib/sc-ids";
import { readScRegistry } from "../scripts/sync-sc-status";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** An id as a string, never as a literal — see the header. */
const id = (n: number): string => `SC-${n}`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
}

/**
 * A git repository with one commit and one spec, and whichever of
 * `SC_SOURCE_DIRS` the caller asks for.
 *
 * `sourceDirs` is the only dimension that varies between the paired trees in
 * every case below — #585's pair discipline, applied by making the second
 * half of each pair impossible to differ in anything else.
 */
function tree(opts: { specIds: string[]; sourceDirs: string[]; spell?: Record<string, string[]> }): string {
  // realpath, because on macOS `/var` is a symlink to `/private/var` and git
  // reports the resolved path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-606-")));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(
    join(root, "specs", "MAIN-SPEC.md"),
    ["# Fixture spec", "", ...opts.specIds.map(i => `- [ ] ${i}: a criterion`), ""].join("\n"),
  );
  for (const d of opts.sourceDirs) {
    mkdirSync(join(root, d), { recursive: true });
    for (const spelled of opts.spell?.[d] ?? []) {
      writeFileSync(join(root, d, "planted.ts"), `export const planted = ${JSON.stringify(spelled)};\n`);
    }
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base", "--allow-empty"]);
  return root;
}

const ENUMERATED_EMPTY = buildScRegistry([]);

function legOf(root: string, kind: SourceReading["kind"], reg = ENUMERATED_EMPTY): {
  leg: SourceReading;
  unmeasured: string[];
  sources: SourceReading[];
} {
  const { namespace } = allocateScNumber(root, "", reg);
  const leg = namespace.sources.find(s => s.kind === kind);
  expect(leg, `the reading does not name the ${kind} leg at all`).toBeDefined();
  return { leg: leg!, unmeasured: namespace.unmeasured, sources: namespace.sources };
}

describe("#606: a leg that was not probed says so by name", () => {
  test("SC-2151: no source directories and four empty ones differ on more than found", () => {
    // The pair. One dimension varies: whether the four directories exist.
    const none = tree({ specIds: [id(5101)], sourceDirs: [] });
    const empty = tree({ specIds: [id(5101)], sourceDirs: [...SC_SOURCE_DIRS] });

    const a = legOf(none, "source-mentions");
    const b = legOf(empty, "source-mentions");

    // THE PREMISE, asserted before anything else: the two trees are
    // indistinguishable on the count. Without this the case could be passing
    // because the fixtures happen to hold different numbers of ids, and it
    // would go green under a repair that only ever looks at `found`.
    expect(a.leg.found, "the two fixtures do not have an equal count, so this is not a test of the count")
      .toBe(b.leg.found);
    expect(a.leg.found).toBe(0);

    // And they are still different facts.
    expect(a.leg.status, "a tree with no source directories reported a completed read").toBe("skipped");
    expect(b.leg.status, "four present, readable, empty directories reported as unread").toBe("read");

    // A skip with no reason is a skip nobody can act on.
    expect(a.leg.reason ?? "", "the skipped leg carries no reason").not.toBe("");
    for (const d of SC_SOURCE_DIRS) {
      expect(a.leg.reason, `the reason does not name ${d}`).toContain(d);
    }
    expect(b.leg.reason, "a fully-walked leg invented a reason").toBeUndefined();
  });

  test("SC-2152: every source directory that could not be walked is named in unmeasured", () => {
    const none = tree({ specIds: [id(5201)], sourceDirs: [] });
    const empty = tree({ specIds: [id(5201)], sourceDirs: [...SC_SOURCE_DIRS] });

    const a = legOf(none, "source-mentions");
    const b = legOf(empty, "source-mentions");

    const names = (u: string[]): string[] =>
      SC_SOURCE_DIRS.filter(d => u.some(line => line.startsWith(`source directory ${d} could not be walked`)));

    expect(names(a.unmeasured).slice().sort(), "an unwalkable source directory is missing from unmeasured")
      .toEqual(SC_SOURCE_DIRS.slice().sort());
    expect(names(b.unmeasured), "a directory that WAS walked was reported as unmeasured").toEqual([]);

    // `unmeasured` is never empty on either — the clone on another machine is
    // outside anything this process can reach — so a non-empty list is not
    // the evidence. The NAMES are.
    expect(b.unmeasured.length, "a fully-read namespace claims to be complete").toBeGreaterThan(0);
  });

  test("SC-2153: a partial walk is read, contributes its ids, and still names what it missed", () => {
    // The fixture that would never occur to anyone writing a battery for this
    // feature, because every natural example is all-or-nothing (#492). Here
    // `test/` opens and three directories do not, so `found` is NON-zero and
    // the leg is nonetheless incomplete.
    const planted = id(5301);
    const partial = tree({ specIds: [id(5302)], sourceDirs: ["test"], spell: { test: [planted] } });

    // The instrument first: the walk really did reach the planted id, or the
    // assertions below are about a tree with nothing in it.
    const walk = scIdsSpelledInSourceReading(partial);
    expect([...walk.ids.keys()], "the fixture did not plant a readable id under test/").toContain(planted);
    expect(walk.walked, "the fixture's test/ was not walked").toEqual(["test"]);

    const { leg, unmeasured } = legOf(partial, "source-mentions");
    expect(leg.found, "a partial read reported no ids").toBeGreaterThan(0);
    // `read`, not `skipped`: three of four is a reading of three, and calling
    // it skipped would make it indistinguishable from a leg that opened none.
    expect(leg.status, "a partially-walked leg was folded into skipped").toBe("read");
    expect(leg.reason ?? "", "a partial read gave no account of the directories it missed").not.toBe("");
    for (const d of SC_SOURCE_DIRS.filter(d => d !== "test")) {
      expect(leg.reason, `the partial-read reason does not name ${d}`).toContain(d);
      expect(
        unmeasured.some(u => u.startsWith(`source directory ${d} could not be walked`)),
        `${d} was not walked and is not in unmeasured`,
      ).toBe(true);
    }
    expect(
      unmeasured.some(u => u.startsWith("source directory test could not be walked")),
      "a directory that WAS walked was reported as unmeasured",
    ).toBe(false);
  });

  test("SC-2154: an unenumerated registry is not a registry that declares nothing", () => {
    // Both registries hold zero declarations and the two readings must still
    // differ — the registry half of this issue, and the same shape as
    // SC-2151 one call frame up.
    const root = tree({ specIds: [id(5401)], sourceDirs: [...SC_SOURCE_DIRS] });
    const reason = "specs/ could not be enumerated in this fixture";

    const enumerated = legOf(root, "registry", ENUMERATED_EMPTY);
    const unenumerated = legOf(root, "registry", unenumeratedScRegistry(reason));

    expect(ENUMERATED_EMPTY.declaredById.size, "the enumerated fixture registry is not empty").toBe(0);
    expect(enumerated.leg.found, "the two registries do not have an equal count").toBe(unenumerated.leg.found);

    expect(enumerated.leg.status, "an enumerated empty registry read as unasked").toBe("read");
    expect(unenumerated.leg.status, "a registry nobody could enumerate reported as consulted").toBe("skipped");
    expect(unenumerated.leg.reason, "the skipped registry leg lost its reason").toContain(reason);
    expect(enumerated.leg.reason, "an enumerated registry leg invented a reason").toBeUndefined();

    const named = (u: string[]): boolean => u.some(line => line.includes("the spec registry was not enumerated"));
    expect(named(unenumerated.unmeasured), "an unenumerated registry is missing from unmeasured").toBe(true);
    expect(named(enumerated.unmeasured), "an enumerated registry was reported as unmeasured").toBe(false);
  });

  test("SC-2155: readScRegistry reports an absent specs/ as unenumerated", () => {
    // The producing side. A reading that faithfully reports a flag nobody
    // ever sets wrong is a reading of nothing, so the one producer the live
    // CLI uses is driven here too (#235: mutate both ends of the binding).
    const withSpecs = tree({ specIds: [id(5501)], sourceDirs: [] });
    const withoutSpecs = realpathSync(mkdtempSync(join(tmpdir(), "sc-606-nospecs-")));
    roots.push(withoutSpecs);

    const present = readScRegistry(join(withSpecs, "specs"));
    const absent = readScRegistry(join(withoutSpecs, "specs"));

    expect(present.enumeration.status, "a readable specs/ was reported as unenumerated").toBe("enumerated");
    expect(absent.enumeration.status, "an absent specs/ reported as a tree that declares nothing")
      .toBe("unenumerated");
    expect(absent.enumeration.reason ?? "", "the unenumerated registry carries no reason").not.toBe("");
    expect(absent.declaredById.size, "the fixture's absent specs/ somehow declared ids").toBe(0);

    // And the distinction survives the hop into the allocator, which is the
    // only place it is ever read.
    const root = tree({ specIds: [id(5502)], sourceDirs: [...SC_SOURCE_DIRS] });
    expect(legOf(root, "registry", absent).leg.status).toBe("skipped");
    expect(legOf(root, "registry", present).leg.status).toBe("read");
  });

  test("SC-2156: describeReading says a leg was skipped, because that is what a caller prints", () => {
    // `scripts/create-sc.ts` prints `describeReading` and the unmeasured
    // list, and nothing else. A distinction that stops at the data structure
    // never reaches an operator.
    const none = tree({ specIds: [id(5601)], sourceDirs: [] });
    const empty = tree({ specIds: [id(5601)], sourceDirs: [...SC_SOURCE_DIRS] });

    const bad = allocateScNumber(none, "", unenumeratedScRegistry("no specs/ here")).namespace;
    const good = allocateScNumber(empty, "", ENUMERATED_EMPTY).namespace;

    const describedBad = describeReading(bad);
    const describedGood = describeReading(good);
    expect(describedBad, "two readings with opposite coverage render identically").not.toBe(describedGood);
    expect(describedBad, "the rendered reading does not say anything was skipped").toContain("skipped");
    expect(describedGood, "a fully-read reading claims a skip").not.toContain("skipped");
  });

  test("SC-2157: the spec-content leg stays read in the worst reading there is", () => {
    // A repair that rewrites all three legs uniformly is cheap and looks
    // thorough, and it puts an unreachable branch into the one leg that was
    // always right: `specContent` is a string parameter already in memory,
    // so there is no state in which it failed to read.
    //
    // THIS CASE IS A CONTROL, NOT A WITNESS. It is green on the pre-#606
    // source and green after the fix, because there is no state of the code
    // in which it goes red for the original defect — the repair it guards
    // against can only arrive afterwards (#652). Counting it among the
    // witnesses would overstate what this file measures by one.
    //
    // Worst reading there is: no source directories and a registry nobody
    // could enumerate, so both of the OTHER legs are skipped in the same
    // reading. A uniform rewrite reaches this one on exactly that input.
    const none = tree({ specIds: [id(5701)], sourceDirs: [] });
    const content = `- [ ] ${id(5702)}: a criterion\n`;
    const { namespace } = allocateScNumber(none, content, unenumeratedScRegistry("no specs/ here"));

    const specLeg = namespace.sources.find(s => s.kind === "spec-content");
    expect(specLeg, "the spec-content leg is absent").toBeDefined();
    expect(specLeg!.status, "the leg that cannot fail to read was marked unread").toBe("read");
    expect(specLeg!.reason, "the leg that cannot fail to read invented a reason").toBeUndefined();
    expect(specLeg!.found, "the spec-content leg lost its count").toBe(1);
  });

  test("SC-2158: the walk's own reading separates an opened directory from a refused one", () => {
    // The unit beneath SC-2151. `scMentionsInSource` is where the `catch`
    // lives, so it is the only place that knows which directories it could
    // not open — a caller cannot recover that from a count, which is why the
    // fix is a return-shape change here and not only in the allocator.
    const none = tree({ specIds: [id(5801)], sourceDirs: [] });
    const empty = tree({ specIds: [id(5801)], sourceDirs: [...SC_SOURCE_DIRS] });

    const a = scMentionsInSource(none);
    const b = scMentionsInSource(empty);

    expect(a.mentions.length, "the fixtures do not have an equal count").toBe(b.mentions.length);
    expect(a.walked, "a tree with no source directories reported walking one").toEqual([]);
    expect(b.walked.slice().sort(), "a present, empty source directory was not recorded as walked")
      .toEqual(SC_SOURCE_DIRS.slice().sort());
    expect(a.unwalkable.map(u => u.dir).sort(), "the walk did not name the directories it refused")
      .toEqual(SC_SOURCE_DIRS.slice().sort());
    expect(a.unwalkable.every(u => u.reason !== ""), "an unwalkable directory carries no reason").toBe(true);
    expect(b.unwalkable, "a readable directory was reported as unwalkable").toEqual([]);
  });
});
