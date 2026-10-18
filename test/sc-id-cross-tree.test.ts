/**
 * Covers SC-1908..SC-1911 (HARNESS-STANDARD.md), #503.
 *
 * Two sessions allocated `SC-1706..1710` within minutes of each other on
 * 2026-10-16, in two worktrees of this repository. Each read the highest id
 * in its own `specs/` and took the next block. Each was right. The guard that
 * exists to catch a duplicate id, `test/spec-sc-ids-unique.test.ts`, was green
 * in both trees independently and stayed green until a rebase put the two
 * blocks in one place.
 *
 * ## The fixtures are real git repositories, not directories
 *
 * The thing under test is `git worktree list`, so a fixture that fakes its
 * output would be testing the parser and nothing else. Each case below runs
 * `git init` and `git worktree add`, which costs about a second for the file
 * and buys the only thing worth having here: the sibling is a sibling for the
 * same reason the one that bit us was.
 *
 * ## Why the ids are computed rather than written
 *
 * `test/sc-fixture-namespace.test.ts` (SC-1522) requires every SC id spelled
 * literally in source to be a real registry id or to sit at or above the
 * 9000 fixture floor. Both are wrong here: a real id would make this file
 * claim coverage it does not provide, and a 9000-range id is exactly what
 * `readScNamespace` is specified to DROP, so a fixture built from one could
 * not witness the feature at all. The ids below are assembled at runtime, so
 * they are absent from the source text that both guards read, and present in
 * the temp repositories where the behaviour lives.
 *
 * The `SC-2012`..`SC-2015` in the test titles below are the exception, and a
 * deliberate one: they are coverage CLAIMS in a declaring position
 * (`.claude/rules/claiming-sc-coverage.md`), they are real registry ids, and
 * they are never handed to the allocator.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { allocateScNumber, nextSCNumber } from "../lib/create-sc";
import { describeReading, readScNamespace, siblingWorktrees } from "../lib/sc-id-cross-tree";
import type { ScRegistry } from "../lib/sc-ids";
import { buildScRegistry, scIdsSpelledInSource } from "../lib/sc-ids";
import { readScRegistry } from "../scripts/sync-sc-status";

const ROOT = join(import.meta.dir, "..");

/**
 * "This tree declares no success criteria", STATED rather than defaulted.
 *
 * `allocateScNumber` took the registry as an OPTIONAL third argument, and the
 * two call sites below omitted it. Both are synthetic trees where no spec
 * declares anything, so the defaulted answer and the stated answer agree on
 * every input this file has — which is exactly why omitting it read as
 * correct for as long as it did. The empty registry is built by the real
 * constructor, so "no declarations" is a value the production parser produces
 * rather than a shape this file invented.
 */
const NO_SPEC_DECLARATIONS: ScRegistry = buildScRegistry([]);

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** An id as a string, never as a literal — see the header. */
const id = (n: number): string => `SC-${n}`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
}

function writeSpec(root: string, name: string, ids: string[]): void {
  mkdirSync(join(root, "specs"), { recursive: true });
  const body = ["# Fixture spec", "", "## Success Criteria", "", ...ids.map(i => `- [ ] ${i}: a criterion`), ""];
  writeFileSync(join(root, "specs", name), body.join("\n"));
}

/** A git repository with one commit, so branches and worktrees are possible. */
function repo(specIds: string[]): string {
  // realpath, because on macOS `/var` is a symlink to `/private/var` and git
  // reports the resolved path. A fixture comparing the two spellings fails
  // for a reason that has nothing to do with the feature.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-xtree-")));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  writeSpec(root, "MAIN-SPEC.md", specIds);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

describe("#503: the SC namespace is the machine, not the checkout", () => {
  test("SC-1908: an id only a sibling worktree has typed is already taken", () => {
    const mine = id(4101);
    const theirs = id(4102);
    const root = repo([mine]);
    const sibling = join(root, "..", `sib-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "theirs", sibling]);
    roots.push(sibling);
    // UNCOMMITTED in the sibling, which is the state the collision happened
    // in: a session that has written the SC line and not yet committed.
    writeSpec(sibling, "THEIR-SPEC.md", [theirs]);

    const reading = readScNamespace(root);

    // The instrument first: this id exists in NO tree but the sibling, so a
    // reading that found it through the root's own specs or through a commit
    // would be satisfying the assertion by a route that bypasses the feature.
    expect(
      readFileSync(join(root, "specs", "MAIN-SPEC.md"), "utf-8"),
      "the fixture leaked the sibling's id into the root tree",
    ).not.toContain(theirs);
    expect(committedAnywhere(root, theirs), "the fixture committed the id, so the ref scan would find it").toBe(false);

    expect([...reading.ids.keys()], "a sibling worktree's uncommitted id is invisible").toContain(theirs);
    expect(reading.ids.get(theirs)).toContain(sibling);
  });

  test("SC-1909: an id committed on a branch with no worktree is already taken", () => {
    const theirs = id(4203);
    const root = repo([id(4201)]);
    const sibling = join(root, "..", `gone-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "abandoned", sibling]);
    writeSpec(sibling, "ABANDONED-SPEC.md", [theirs]);
    git(sibling, ["add", "-A"]);
    git(sibling, ["commit", "-q", "-m", "their block"]);
    // The worktree goes away; the branch does not. This is the half the
    // worktree walk cannot see and the ref scan exists for.
    // `worktree remove`, not a delete plus `prune`: prune honours
    // `gc.worktreePruneExpire`, which defaults to three months, so the
    // deleted tree is still listed and the fixture would not be testing the
    // branch-with-no-worktree case at all.
    git(root, ["worktree", "remove", "--force", sibling]);
    expect(siblingWorktrees(root).paths, "the fixture did not actually remove the worktree").toHaveLength(0);

    const reading = readScNamespace(root);
    expect([...reading.ids.keys()], "an id on an unmerged branch is invisible").toContain(theirs);
    expect(reading.ids.get(theirs)).toContain("refs");
  });

  test("SC-1910: a source it could not read is named, never dropped", () => {
    const root = repo([id(4301)]);
    const sibling = join(root, "..", `broken-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "broken", sibling]);
    roots.push(sibling);
    // A worktree git still lists whose tree is not there. `git worktree list`
    // reports it without `prunable` until a prune runs, so the reading meets
    // a path it cannot open — the case where returning silently would make an
    // unread tree indistinguishable from a tree with no ids in it.
    rmSync(join(sibling, "specs"), { recursive: true, force: true });

    const reading = readScNamespace(root);
    const skipped = reading.sources.filter(s => s.status === "skipped");
    expect(skipped.map(s => s.label), "an unreadable worktree was dropped silently").toContain(sibling);
    expect(skipped.every(s => (s.reason ?? "") !== ""), "a skipped source carries no reason").toBe(true);
    expect(reading.unmeasured.join("\n")).toContain(sibling);

    // And on a clean read it is still not empty: no process on this machine
    // can see a clone on another one, and `0`, `{}` and `SKIP` are
    // indistinguishable from success (`.claude/rules/config-access.md`).
    const clean = readScNamespace(repo([id(4302)]));
    expect(clean.sources.filter(s => s.status === "skipped")).toHaveLength(0);
    expect(clean.unmeasured.length, "a fully-read namespace claims to be complete").toBeGreaterThan(0);

    // "asked and there are none" and "could not ask" are opposite facts, and
    // an empty array says both. A directory that is not a repository at all
    // is the second one, and it must not read as the first.
    const notARepo = mkdtempSync(join(tmpdir(), "sc-xtree-bare-"));
    roots.push(notARepo);
    const asked = siblingWorktrees(notARepo);
    expect(asked.paths).toHaveLength(0);
    expect(asked.failure, "a repository that could not be asked reported no siblings").not.toBeNull();
  });

  test("SC-1912: the allocator composes all three widths, not two of them", () => {
    // SC-1911 drives `nextSCNumber` with ids the test assembled itself, so it
    // cannot witness a CALLER that reads the namespace and forgets to pass
    // it, or passes the registry alone. `allocateScNumber` is the one place
    // the three widths compose, and this drives that.
    const mine = 4501;
    const theirs = 4502;
    const root = repo([id(mine)]);
    const sibling = join(root, "..", `compose-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "compose", sibling]);
    roots.push(sibling);
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs)]);

    const own = `- [ ] ${id(mine)}: a criterion\n`;
    const first = allocateScNumber(root, own, NO_SPEC_DECLARATIONS);
    expect(first.number, "the allocator re-issued a number a sibling already took").toBeGreaterThan(theirs);
    // The reading travels with the number, because the number is a floor.
    expect(first.namespace.unmeasured.length).toBeGreaterThan(0);

    // A second value, or "reads the namespace" is indistinguishable from
    // "adds a constant to what the spec content says".
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs + 60)]);
    expect(allocateScNumber(root, own, NO_SPEC_DECLARATIONS).number).toBeGreaterThan(theirs + 60);
  });

  test("SC-1911: the allocator does not re-issue a sibling's number", () => {
    const mine = 4401;
    const theirs = 4402;
    const root = repo([id(mine)]);
    const sibling = join(root, "..", `alloc-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "alloc", sibling]);
    roots.push(sibling);
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs)]);

    const own = `- [ ] ${id(mine)}: a criterion\n`;
    // What the pre-fix allocator does, and it is correct about its own tree.
    expect(nextSCNumber(own), "the fixture does not reproduce the collision").toBe(theirs);

    const namespace = readScNamespace(root);
    const withNamespace = nextSCNumber(own, undefined, [...namespace.ids.keys()]);
    expect(withNamespace, "the allocator handed out a number the sibling already took").toBeGreaterThan(theirs);

    // Two different sibling values, because one cannot tell "reads the
    // namespace" from "adds a constant".
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs + 40)]);
    const again = readScNamespace(root);
    expect(nextSCNumber(own, undefined, [...again.ids.keys()])).toBeGreaterThan(theirs + 40);

    // The reserved range stays reserved: a fixture id is spelled, not claimed,
    // and counting one as taken would push every future criterion past 9000.
    writeSpec(sibling, "THEIR-SPEC.md", [id(9500)]);
    const reserved = readScNamespace(root);
    expect([...reserved.ids.keys()]).not.toContain(id(9500));
    expect(nextSCNumber(own, undefined, [...reserved.ids.keys()])).toBe(mine + 1);
  });
});

/**
 * #593 — the third width was OPTIONAL, so the composition was a suggestion.
 *
 * `allocateScNumber(root, specContent, reg?)` reads source mentions and the
 * cross-tree namespace itself and takes the spec registry from its caller.
 * Omit the argument and `nextSCNumber` never reaches
 * `reg?.declaredById.keys()` — the allocator skips the spec declarations
 * entirely and returns a number with a reading beside it as though it had
 * asked everything. Its own docstring, one line above the `?`, says a caller
 * must not be able to "assemble two of the three and believe it asked".
 *
 * ## Why the proof has to be a compile and not a call
 *
 * Making the parameter required changes NO runtime behaviour: every call that
 * passes three arguments behaves identically either way. The whole of the
 * defect is what the signature PERMITS, so the only instrument that can see
 * it is the type checker, and the probes below are compiled by the pinned
 * compiler `scripts/typecheck.ts` spawns rather than by a different one the
 * registry happens to resolve (#87).
 *
 * Three probes, one compile, because a count with no control is not a
 * measurement:
 *
 * | Probe | What only it reaches |
 * |---|---|
 * | three arguments | the instrument. An error here means the probe could never have compiled, which reads exactly like the arity being enforced |
 * | two arguments | the defect verbatim — the call sites that shipped |
 * | `undefined` as the registry | the CHEAPEST wrong fix. Widening the parameter to `ScRegistry \| undefined` while keeping it required makes the two-argument probe go green and reinstates the defect in one character |
 */
describe("#593: the spec registry is not an optional leg", () => {
  /**
   * The compiler `scripts/typecheck.ts` uses, not whatever `bunx` resolves.
   * An unpinned major version is a different diagnostic set (#87), and a
   * probe that measures TypeScript rather than this signature is worse than
   * no probe.
   */
  const TSC = join(ROOT, "node_modules", ".bin", "tsc");

  const PROBE_OK = "three-arguments.ts";
  const PROBE_TWO = "two-arguments.ts";
  const PROBE_UNDEFINED = "undefined-registry.ts";

  /**
   * Inside the repo rather than under `/tmp`, so the probe resolves the same
   * `node_modules` and the same `tsconfig.json` the real check does (#176),
   * and with an `mkdtemp` suffix so two runs cannot share it (#323 SC-6).
   */
  let probeDir = "";
  let probeOutput = "";
  let probeStatus: number | null = null;
  const probeErrors = new Map<string, string[]>();

  /**
   * The name is assembled rather than written, and that is not style.
   * SC-2015 below scans every `.ts` and `.js` in the tree for a call that
   * omits the registry, and a probe source carrying the literal text of the
   * defect would be a violation of the guard in the file that proves the
   * guard works. The alternative is an exemption for this path, and an
   * exemption is a hole (`.claude/rules/checks-must-be-able-to-fail.md`).
   */
  const CALL = ["allocate", "Sc", "Number"].join("");

  beforeAll(() => {
    probeDir = mkdtempSync(join(ROOT, ".sc-arity-probe-"));
    const header =
      `import { ${CALL} } from "../lib/create-sc";\n` +
      `import { buildScRegistry } from "../lib/sc-ids";\n` +
      `const reg = buildScRegistry([]);\n`;
    writeFileSync(join(probeDir, PROBE_OK), `${header}export const ok = ${CALL}("/nowhere", "", reg).number;\n`);
    writeFileSync(join(probeDir, PROBE_TWO), `${header}export const two = ${CALL}("/nowhere", "").number;\n`);
    writeFileSync(
      join(probeDir, PROBE_UNDEFINED),
      `${header}export const u = ${CALL}("/nowhere", "", undefined).number;\n`,
    );
    // Extends the project's own tsconfig, so the probe is compiled under the
    // settings the tree is compiled under. A probe with hand-written
    // compilerOptions measures the options, not the signature.
    writeFileSync(
      join(probeDir, "tsconfig.json"),
      JSON.stringify({ extends: "../tsconfig.json", include: [PROBE_OK, PROBE_TWO, PROBE_UNDEFINED] }, null, 2),
    );

    const r = spawnSync(TSC, ["--noEmit", "-p", join(probeDir, "tsconfig.json")], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    probeOutput = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    probeStatus = r.status;
    for (const line of probeOutput.split("\n")) {
      const m = /^(\S.*?)\(\d+,\d+\): error (TS\d+):/.exec(line);
      if (!m) continue;
      const file = basename(m[1]!);
      probeErrors.set(file, [...(probeErrors.get(file) ?? []), m[2]!]);
    }
  }, 300_000);

  afterAll(() => {
    if (probeDir !== "") rmSync(probeDir, { recursive: true, force: true });
  });

  /**
   * Read the instrument before reading any result
   * (`.claude/rules/checks-must-be-able-to-fail.md`). A compiler that never
   * ran reports no errors, which is indistinguishable from a signature that
   * permits everything.
   */
  function expectInstrumentHealthy(): void {
    expect(existsSync(TSC), `no ${TSC} — run \`bun install\`; refusing to report an arity I did not measure`).toBe(true);
    expect(probeOutput, "tsc printed its usage instead of compiling the probe").not.toContain(
      "tsc: The TypeScript Compiler",
    );
    expect(probeStatus, "tsc was killed rather than finishing").not.toBeNull();
    expect(
      probeErrors.get(PROBE_OK) ?? [],
      `the three-argument control did not compile, so nothing below measures the arity:\n${probeOutput}`,
    ).toEqual([]);
  }

  // covers SC-2012 (HARNESS-STANDARD.md), with the probe below
  test(
    "the registry argument is required",
    () => {
      expectInstrumentHealthy();
      // TS2554 is "Expected 3 arguments, but got 2" — the call the two
      // shipped call sites above were making until this issue.
      expect(
        probeErrors.get(PROBE_TWO) ?? [],
        `a two-argument allocation type-checked, so the spec registry is still skippable:\n${probeOutput}`,
      ).toContain("TS2554");
    },
    300_000,
  );

  test(
    "a registry of undefined is rejected, so the cheapest widening does not reinstate it",
    () => {
      expectInstrumentHealthy();
      // The fifth shape, applied forward in time. `reg: ScRegistry | undefined`
      // is one character, makes the case above go green, and hands every
      // caller back the defaulted answer under a name that looks deliberate.
      // TS2345 is "Argument of type 'undefined' is not assignable".
      expect(
        probeErrors.get(PROBE_UNDEFINED) ?? [],
        `\`undefined\` was accepted as the registry, which is the omission wearing an argument:\n${probeOutput}`,
      ).toContain("TS2345");
    },
    300_000,
  );

  test("SC-2013: the registry leg changes the answer", () => {
    const mine = 6001;
    const root = repo([id(mine)]);
    const ownSpec = `- [ ] ${id(mine)}: a criterion\n`;

    // The margin is computed from the SAME reading the code under test uses,
    // not from this tree's spec maximum (#507): the allocator reads sibling
    // worktrees and every branch ref, and a probe computed from a narrower
    // reading agrees right up until another session moves the maximum.
    const without = allocateScNumber(root, ownSpec, NO_SPEC_DECLARATIONS).number;
    const onlyInTheRegistry = id(without + 5);

    // A spec declaring an id NO source file spells and no tree holds. It
    // exists in the registry and nowhere else, so the registry is the only
    // leg that can see it — and it is parsed by the production reader from a
    // real spec file, because a hand-built Map would be testing the test.
    const specsDir = mkdtempSync(join(tmpdir(), "sc-registry-only-"));
    roots.push(specsDir);
    writeFileSync(join(specsDir, "REGISTRY-ONLY-SPEC.md"), `- [ ] ${onlyInTheRegistry}: a criterion\n`);
    const reg = readScRegistry(specsDir);

    expect([...reg.declaredById.keys()], "the fixture's spec did not parse into a declaration").toContain(
      onlyInTheRegistry,
    );
    // The other two legs must be blind to it, or the assertion below is
    // satisfied by a route that bypasses the registry entirely.
    expect([...readScNamespace(root).ids.keys()], "the fixture leaked its id into the cross-tree namespace").not.toContain(
      onlyInTheRegistry,
    );
    expect([...scIdsSpelledInSource(root).keys()], "the fixture leaked its id into the source scan").not.toContain(
      onlyInTheRegistry,
    );

    // Greater than, not a literal: the tree moves, and the property is that
    // the registry raised the floor at all.
    expect(
      allocateScNumber(root, ownSpec, reg).number,
      "the registry leg made no difference to the allocated number",
    ).toBeGreaterThan(without);
  });

  test("SC-2014: the reading names the legs consulted", () => {
    const mine = 6101;
    const root = repo([id(mine)]);
    const sibling = join(root, "..", `legs-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "legs", sibling]);
    roots.push(sibling);
    writeSpec(sibling, "THEIR-SPEC.md", [id(mine + 1)]);

    const { namespace } = allocateScNumber(root, `- [ ] ${id(mine)}: a criterion\n`, NO_SPEC_DECLARATIONS);
    const kinds = new Set(namespace.sources.map(s => s.kind));
    // Every width the allocator composed, named in the reading it hands back.
    // A caller cannot print the number without printing what produced it.
    for (const leg of ["spec-content", "registry", "source", "worktree", "refs"] as const) {
      expect(kinds, `the allocator consulted the ${leg} leg and the reading does not name it`).toContain(leg);
    }

    // "consulted an empty registry" and "did not consult one" are opposite
    // facts, and a leg that is absent says both.
    const registry = namespace.sources.find(s => s.kind === "registry");
    expect(registry?.status, "the registry leg is not recorded as read").toBe("read");
    expect(registry?.found, "an empty registry reported declarations it does not have").toBe(0);

    // And the one-line account the CLI prints counts them, so the legs are
    // not merely present in a structure nobody renders.
    const read = namespace.sources.filter(s => s.status === "read").length;
    expect(describeReading(namespace)).toContain(`${read} source(s)`);
    expect(describeReading(namespace), "the printed account does not name the registry leg").toContain("registry");
  });

  test("SC-2015: no caller omits the registry", () => {
    // The compile probes prove a two-argument call is refused. This is the
    // other direction: that nothing in the tree is still making one through a
    // route the compiler was never pointed at (a `.js` workflow, a dynamic
    // import, a cast). Grep-level, and cheap, and it is the check that would
    // have caught this issue on the day the second call site was written.
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of ["lib", "scripts", "test", "gates", "hooks", "workflows"]) {
      const abs = join(ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const file of new Bun.Glob("**/*.{ts,js}").scanSync({ cwd: abs, absolute: true })) {
        scanned++;
        const src = readFileSync(file, "utf-8");
        // No file is exempt, including this one — the probe sources above
        // assemble the name so that the guard does not need a hole cut in it
        // for the file that proves it works.
        for (const call of callsTo(CALL, src)) {
          if (call.arity < 3) offenders.push(`${basename(file)}: ${call.text}`);
        }
      }
    }
    // A scan that read nothing reports no offenders, which is the clean
    // result wearing the same face. State the coverage with the verdict.
    expect(scanned, "the call-site scan walked no files at all").toBeGreaterThan(100);
    expect(offenders, "a caller is still taking the defaulted answer").toEqual([]);
  });
});

/**
 * Every call to `name` in `src`, with how many top-level arguments it passes.
 *
 * Depth-aware rather than `\(([^)]*)\)`, which is the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`: the lazy form stops at the
 * first `)` it meets, so a nested call or a template substitution truncates
 * the argument list and a three-argument call reads as a one-argument one.
 * Measured — the first draft of SC-2015 reported this very file as an
 * offender for `allocateScNumber(root, \`...${id(mine)}...\`, reg)`.
 *
 * Strings and template literals are skipped, so a comma inside one is not an
 * argument separator.
 */
function callsTo(name: string, src: string): Array<{ text: string; arity: number }> {
  const out: Array<{ text: string; arity: number }> = [];
  const open = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const m of src.matchAll(open)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    let commas = 0;
    let body = "";
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === quote) break;
          i++;
        }
      } else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 1) commas++;
      if (depth > 0) body += src[i];
      i++;
    }
    // A declaration, not a call: `function allocateScNumber(root: string,`.
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    const arity = body.trim() === "" ? 0 : commas + 1;
    out.push({ text: `${name}(${body.replace(/\s+/g, " ").trim()})`, arity });
  }
  return out;
}

/** Is this id committed anywhere reachable? `git grep` exits 1 on no match. */
function committedAnywhere(root: string, scId: string): boolean {
  try {
    git(root, ["grep", "-q", scId, "HEAD"]);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}
