/**
 * #1096 — a test that poisons `process.env` and spawns is measuring nothing.
 *
 * The premise is a RUNTIME divergence, and the first two cases execute it
 * rather than quoting it. If Bun ever starts passing a late write on, the
 * premise case goes red and this whole scan can be retired — which is the
 * only honest way to hold a check whose justification lives outside the
 * repository.
 *
 * The scan's population is DERIVED, never enumerated. A list of today's
 * members is written by whoever just fixed them, so it cannot fail on the
 * day it ships and nothing adds tomorrow's member to it. Every planted
 * fixture below is a tree built in `mkdtemp`, so the negative cases keep
 * witnessing after the real files move.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EXEMPT_MARKER,
  MIN_REASON,
  UnreadableScanError,
  lateEnvSpawnReading,
  lateEnvSpawnViolations,
} from "../lib/late-env-spawn";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A tree with one test file in it, and nothing else. */
function tree(body: string, name = "x.test.ts"): string {
  const d = mkdtempSync(join(tmpdir(), "rungate-1096-"));
  scratch.push(d);
  mkdirSync(join(d, "test"), { recursive: true });
  writeFileSync(join(d, "test", name), body);
  return d;
}

/** The probe both runtimes run, written once so neither row can differ. */
const PROBE = `
import { execFileSync } from "node:child_process";
process.env.RG_LATE_PROBE = "set-in-process";
try {
  console.log("SAW:" + execFileSync("printenv", ["RG_LATE_PROBE"], { encoding: "utf8" }).trim());
} catch { console.log("SAW:"); }
try {
  console.log("SPREAD:" + execFileSync("printenv", ["RG_LATE_PROBE"], { encoding: "utf8", env: { ...process.env } }).trim());
} catch { console.log("SPREAD:"); }
`;

function runProbe(runtime: string) {
  const d = mkdtempSync(join(tmpdir(), "rungate-1096-probe-"));
  scratch.push(d);
  const p = join(d, "probe.ts");
  writeFileSync(p, PROBE);
  const r = spawnSync(runtime, [p], { encoding: "utf-8", timeout: 60_000 });
  return {
    status: r.status,
    saw: /^SAW:(.*)$/m.exec(r.stdout ?? "")?.[1] ?? null,
    spread: /^SPREAD:(.*)$/m.exec(r.stdout ?? "")?.[1] ?? null,
    stderr: (r.stderr ?? "").trim(),
  };
}

describe("the premise, executed (#1096)", () => {
  test("Bun does not pass a late process.env write to a child given no env option", () => {
    const r = runProbe("bun");
    expect(r.status, `the probe did not run under bun: ${r.stderr}`).toBe(0);
    expect(
      r.saw,
      "Bun now passes a late env write on. The premise of lib/late-env-spawn.ts no longer holds and the scan should be retired, not loosened.",
    ).toBe("");
    // The same write DOES reach a child given an explicit env, which is why
    // `{ ...process.env }` is the whole fix and not a ceremony.
    expect(r.spread).toBe("set-in-process");
  });

  test("Node does, which is what makes this a runtime divergence and not a bad probe", () => {
    const r = runProbe("node");
    expect(
      r.status,
      `the Node control could not be taken (${r.stderr || "node not on PATH"}). ` +
        "Without it the Bun row is indistinguishable from printenv being unreliable " +
        "or the variable name being wrong, so this is UNMEASURED and not a pass.",
    ).toBe(0);
    expect(r.saw).toBe("set-in-process");
  });
});

describe("the scan over this repository (#1096)", () => {
  test("no spawn site is relying on an environment Bun will not pass on", () => {
    expect(lateEnvSpawnViolations(ROOT)).toEqual([]);
  });

  /**
   * The coverage control. "0 violations" over a scan that read nothing is
   * the same output as a clean tree, and only one of them is a result.
   *
   * Floors rather than counts: the numbers belong to the whole test
   * directory, which this case does not own, and an equality here would go
   * red on somebody else's new file (#637, #507).
   */
  test("the scan read this repository, and its population is not empty", () => {
    const r = lateEnvSpawnReading(ROOT);
    expect(r.filesScanned, "the walk found no test files").toBeGreaterThan(100);
    expect(r.spawnsExamined, "the spawn pattern matched nothing").toBeGreaterThan(100);
    expect(r.candidateFiles, "no file both writes process.env and spawns").toBeGreaterThan(0);
    expect(
      r.sites.length,
      "no bare spawn site exists at all, so the violation case above cannot fail for a real reason",
    ).toBeGreaterThan(0);
  });

  /**
   * The scan must not name a member, and this is the only case that can
   * say so.
   *
   * The cheapest wrong fix for a derived population is to stop deriving it:
   * add a `KNOWN` array of today's files, or an exemption list keyed by
   * path, the first time the scan reds someone. Both work, both are
   * invisible to every other case here — a list of files nobody in this
   * suite references cannot change any planted fixture's verdict — and
   * both reinstate the failure mode #1096 exists to avoid: a population
   * written by whoever just fixed it, which cannot fail on the day it
   * ships and which nothing adds tomorrow's member to.
   *
   * So the assertion is on the SOURCE: the module may know how to walk a
   * directory, and may not know the name of a single file it will find.
   */
  test("the scan enumerates no member — the population is derived or it is nothing", () => {
    const src = readFileSync(join(ROOT, "lib", "late-env-spawn.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // `+`, not `*`: the bare suffix `".test.ts"` is how the walk SELECTS and
    // is the one spelling allowed. A member always has something before it.
    const named = [...src.matchAll(/["'`]([^"'`\n]+\.test\.ts)["'`]/g)].map(m => m[1]);
    expect(
      named,
      "a test file is named in the scan's code; a derived population may know the SUFFIX, never a member",
    ).toEqual([]);
    expect(src, "the suffix is how the walk selects, and it is the only spelling allowed")
      .toContain('.endsWith(".test.ts")');
  });

  test("every site that survives carries a stated reason, not a marker", () => {
    for (const s of lateEnvSpawnReading(ROOT).sites) {
      expect(s.exemption, `${s.file}:${s.line} has no reason`).not.toBeNull();
      expect(
        (s.exemption ?? "").length,
        `${s.file}:${s.line} gives a ${(s.exemption ?? "").length}-character reason`,
      ).toBeGreaterThanOrEqual(MIN_REASON);
    }
  });
});

describe("what the scan calls a member (#1096)", () => {
  test("a bare spawn in a file that writes process.env is a violation", () => {
    const d = tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
spawnSync("printenv", ["RG_THING"], { encoding: "utf-8" });
`);
    const v = lateEnvSpawnViolations(d);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("test/x.test.ts:4");
    expect(v[0]).toContain("RG_THING");
  });

  test("the same spawn passing env: explicitly is not", () => {
    const d = tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
spawnSync("printenv", ["RG_THING"], { encoding: "utf-8", env: { ...process.env } });
`);
    expect(lateEnvSpawnViolations(d)).toEqual([]);
  });

  /**
   * The shorthand half, and it is not a nicety.
   *
   * `const env = { ...process.env }; delete env.X;` passed as `{ cwd, env }`
   * is the most careful site in this repository's population, and a
   * detector that only knew `env:` reported exactly that author. Measured
   * on the first run of this scan.
   */
  test("the { cwd, env } shorthand counts as explicit", () => {
    const d = tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
const env = { ...process.env };
delete env.RG_THING;
spawnSync("printenv", ["RG_THING"], { env });
`);
    expect(lateEnvSpawnViolations(d)).toEqual([]);
  });

  /**
   * Two over-counts from #1096's hand-written table, as cases.
   *
   * The issue listed eight files; three of them are in it because a grep
   * over raw source counted `execSync` inside a COMMENT and matched
   * `process.env.X === "1"`, which is a READ. Neither is a member, and a
   * scanner that cannot tell a call from a sentence about a call is the
   * defect `.claude/rules/checks-must-be-able-to-fail.md` names.
   */
  test("a read of process.env is not a write", () => {
    const d = tree(`
import { spawnSync } from "child_process";
const on = process.env.RG_THING === "1";
spawnSync("printenv", ["RG_THING"], { encoding: "utf-8" });
export { on };
`);
    expect(lateEnvSpawnViolations(d)).toEqual([]);
  });

  test("a spawn inside a comment or a string is not a spawn", () => {
    // One REAL spawn, passing env, so the scan has something to examine and
    // does not refuse the tree outright. If the stripping failed, the two
    // bare spawns below it — one commented, one quoted — would each be a
    // violation, so an empty result is this case's witness and not its
    // precondition.
    const d = tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
spawnSync("printenv", ["RG_THING"], { env: { ...process.env } });
// spawnSync("printenv", ["RG_THING"], { encoding: "utf-8" });
export const sample = 'execSync("printenv RG_THING")';
`);
    expect(lateEnvSpawnViolations(d)).toEqual([]);
    expect(lateEnvSpawnReading(d).spawnsExamined, "the real spawn was not seen either").toBe(1);
  });

  /**
   * The floor must measure the REASON, not the code it sits beside.
   *
   * The first version read the call's whole line into the reason, so
   * `late-env-ok: because` measured 66 characters instead of 7 and cleared
   * a 40-character floor with a seven-character excuse. Found by the
   * short-reason case below going green.
   */
  test("a trailing marker's reason stops at the end of the comment", () => {
    const d = tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
spawnSync("printenv", ["UNRELATED"], { encoding: "utf-8" }); // ${EXEMPT_MARKER} short
`);
    const v = lateEnvSpawnViolations(d);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("The reason given is 5 characters");
  });

  test("delete process.env.X is a change to the environment too", () => {
    const d = tree(`
import { spawnSync } from "child_process";
delete process.env.RG_THING;
spawnSync("printenv", ["RG_THING"], { encoding: "utf-8" });
`);
    expect(lateEnvSpawnViolations(d)).toHaveLength(1);
  });
});

describe("the exemption has to be a reason (#1096)", () => {
  const withReason = (reason: string) => tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
// ${EXEMPT_MARKER} ${reason}
spawnSync("printenv", ["UNRELATED"], { encoding: "utf-8" });
`);

  test("a marker with a short reason is still a violation", () => {
    const v = lateEnvSpawnViolations(withReason("because"));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("characters");
  });

  test("a marker with a stated reason clears the site", () => {
    expect(
      lateEnvSpawnViolations(
        withReason("this child reads UNRELATED and never RG_THING, so the write cannot reach it"),
      ),
    ).toEqual([]);
  });

  /**
   * The reason may span the whole comment block above the call, because a
   * reason long enough to satisfy MIN_REASON usually needs more than one
   * line. A fixed line window was the first version and it made the floor
   * and the window fight each other — the way to win was a shorter reason.
   */
  test("a reason spanning several comment lines is read whole", () => {
    const d = tree(`
import { spawnSync } from "child_process";
process.env.RG_THING = "x";
// ${EXEMPT_MARKER} this child reads only UNRELATED,
// which this file never writes, so no late write
// of RG_THING can reach it by any route at all.
spawnSync("printenv", ["UNRELATED"], { encoding: "utf-8" });
`);
    expect(lateEnvSpawnViolations(d)).toEqual([]);
  });
});

describe("a scan that could not read refuses (#1096)", () => {
  test("a tree with no test files is UNMEASURED, not clean", () => {
    const d = mkdtempSync(join(tmpdir(), "rungate-1096-empty-"));
    scratch.push(d);
    expect(() => lateEnvSpawnViolations(d)).toThrow(UnreadableScanError);
  });

  test("a tree whose test files contain no spawn at all is UNMEASURED", () => {
    const d = tree(`
process.env.RG_THING = "x";
export const nothing = true;
`);
    expect(() => lateEnvSpawnViolations(d)).toThrow(/spawn pattern has stopped matching/);
  });
});

describe("the fixed sites behave (#1096)", () => {
  /**
   * `test/config-trackable.test.ts` set a hermetic `HOME` and git config in
   * `beforeAll` and spawned git with no `env`, so the fixture was inert —
   * the whole point of it was that a developer's global `core.excludesFile`
   * must not change the verdict, and it still could.
   *
   * This is that fixture's own mechanism, measured directly rather than
   * asserted about the file: a global config written AFTER start is
   * honoured by a bare spawn and neutralised by an explicit one.
   */
  test("the hermetic-config pattern only works with an explicit env", () => {
    const d = mkdtempSync(join(tmpdir(), "rungate-1096-herm-"));
    scratch.push(d);
    const cfg = join(d, "gitconfig");
    const ex = join(d, "excludes");
    writeFileSync(ex, "planted.txt\n");
    writeFileSync(cfg, `[core]\n\texcludesFile = ${ex}\n`);
    const repo = join(d, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "planted.txt"), "x\n");

    const probe = join(d, "probe.ts");
    writeFileSync(probe, `
import { spawnSync } from "child_process";
process.env.GIT_CONFIG_GLOBAL = ${JSON.stringify(cfg)};
const bare = spawnSync("git", ["status", "--porcelain"], { cwd: ${JSON.stringify(repo)}, encoding: "utf-8" });
const expl = spawnSync("git", ["status", "--porcelain"], { cwd: ${JSON.stringify(repo)}, encoding: "utf-8", env: { ...process.env } });
console.log("BARE:" + bare.stdout.trim());
console.log("EXPL:" + expl.stdout.trim());
`);
    const r = spawnSync("bun", [probe], { encoding: "utf-8", timeout: 60_000 });
    expect(r.status, `the probe did not run: ${(r.stderr ?? "").trim()}`).toBe(0);
    expect(
      /^BARE:(.*)$/m.exec(r.stdout)?.[1],
      "the bare spawn honoured the late config, so this pattern was never inert and the fix changed nothing",
    ).toBe("?? planted.txt");
    expect(/^EXPL:(.*)$/m.exec(r.stdout)?.[1]).toBe("");
  });
});
