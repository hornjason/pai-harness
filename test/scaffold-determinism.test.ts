/**
 * SC-364 — re-scaffold produces identical output (#111).
 *
 * `SCAFFOLD-DECOMPOSITION-SPEC.md:94` calls this "the critical gate: output
 * must be IDENTICAL before and after. Diff the generated files." Nothing
 * diffed generated files, and the spec recorded SC-364 as done.
 *
 * The test that carried the name asserted nothing: it called
 * `generateAgentBriefs(scan, briefsDir, actions)` — a one-argument function —
 * and compared two `actions` arrays that were both always empty, so
 * `expect([]).toEqual([])` passed no matter how non-deterministic the
 * generator was. #65 fixed the types, which made it a real assertion about one
 * pure function called twice in one process with a fixture scan. That is
 * closer to a tautology than to this gate.
 *
 * WHY THIS TEST CANNOT BE VACUOUS
 *
 * "Re-scaffold changed nothing" is trivially true if re-scaffold SKIPS
 * everything — which is exactly what it does for files that already exist
 * (run 2 of a probe reported "4 created, 17 skipped"). A test that scaffolds
 * twice and diffs would pass against a scaffold that had been gutted to a
 * no-op.
 *
 * So this corrupts a generated file first, then re-scaffolds, and requires the
 * original bytes back. That can only pass if the generator actually ran and
 * actually produced identical output. The corruption step is the thing that
 * makes it a check rather than a line in a report
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const HARNESS_ROOT = join(import.meta.dir, "..");
const SCAFFOLD = join(HARNESS_ROOT, "scripts", "scaffold-project.ts");

let project: string;

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: 240_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function scaffold(dir: string) {
  return sh("bun", [SCAFFOLD, dir, "--fix"], HARNESS_ROOT);
}

/**
 * Hash every file in the project except volatile infrastructure.
 *
 * `.git` changes on every commit the scaffold makes. `.fallow` is a binary
 * analysis cache keyed partly on absolute paths — it is a cache, not generated
 * output, and SC-364 is about generated files.
 */
function snapshot(dir: string, normalize = true): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === ".git" || e === ".fallow" || e === "node_modules") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const raw = readFileSync(p);
        const body = normalize ? normalizeVolatile(raw.toString("utf-8"), dir) : raw.toString("binary");
        out.set(relative(dir, p), createHash("sha256").update(body).digest("hex"));
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Declared volatile fields — provenance, not content.
 *
 * Each one is legitimately per-run and listing them here IS the claim being
 * made. Anything that becomes run-dependent and is NOT on this list fails the
 * comparison and forces a decision, rather than being absorbed by a loose
 * match. VOLATILE_FIELDS is asserted to stay exactly this size below.
 */
const VOLATILE_FIELDS = [
  // scaffold commits its own output, so HEAD moves between runs
  { name: "scanned-at-sha", re: /scanned-at-sha:\s*[0-9a-f]+/g, to: "scanned-at-sha: <SHA>" },
  // written once at creation
  { name: "scaffoldedAt", re: /"scaffoldedAt":\s*"[^"]*"/g, to: '"scaffoldedAt": "<TIME>"' },
];

function normalizeVolatile(body: string, dir: string): string {
  let out = body;
  for (const f of VOLATILE_FIELDS) out = out.replace(f.re, f.to);
  // The project's own absolute path appears in generated docs. Per-project by
  // nature, and the test fixture lives at a random temp path.
  return out.split(dir).join("<PROJECT>");
}

function diffKeys(a: Map<string, string>, b: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) changed.push(k);
  for (const k of b.keys()) if (!a.has(k)) changed.push(`${k} (added)`);
  return changed.sort();
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "sc364-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "bun test" } }));
  writeFileSync(join(project, "src", "index.ts"), "export const x = 1;\n");
  sh("git", ["init", "-q", "-b", "main", project], "/tmp");
  sh("git", ["-C", project, "config", "user.email", "test@example.invalid"], project);
  sh("git", ["-C", project, "config", "user.name", "Test"], project);
  sh("git", ["add", "-A"], project);
  sh("git", ["commit", "-q", "-m", "init"], project);

  // Scaffold TWICE to reach the fixed point. Run 1 generates CODE-MAP.md from
  // a scan taken BEFORE it writes .claude/agents/, specs/ and a devDependency,
  // so the map it ships describes a project that stops existing the moment the
  // run finishes. Run 2 regenerates it against the real tree.
  //
  // Converging first is what makes SC-364 a meaningful property rather than a
  // trick question: "identical output" is about the scaffold being a fixed
  // point, not about a first run predicting its own side effects. The
  // one-run-behind CODE-MAP is asserted explicitly below so it stays a known
  // property and cannot silently become something worse.
  scaffold(project);
  scaffold(project);
}, 420_000);

afterAll(() => {
  try { rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("SC-364: re-scaffold produces identical output", () => {
  test("the probe generated enough to be worth diffing", () => {
    // Without this, every assertion below could hold over an empty set — the
    // precise failure that let the old SC-364 test pass for months.
    const snap = snapshot(project);
    expect(snap.size, "scaffold produced almost nothing — the fixture is broken, not the scaffold").toBeGreaterThan(10);
    for (const expected of ["AGENTS.md", "CODE-MAP.md", join(".claude", "rules", "key-files.md")]) {
      expect([...snap.keys()], `scaffold did not generate ${expected}`).toContain(expected);
    }
  }, 300_000);

  test("re-scaffolding changes nothing", () => {
    const before = snapshot(project);
    scaffold(project);
    const after = snapshot(project);
    expect(diffKeys(before, after), "re-scaffold rewrote files with different content").toEqual([]);
  }, 300_000);

  test("corrupted generated files are restored to byte-identical content", () => {
    // The anti-vacuity step. "Nothing changed" is free if the scaffold skips
    // existing files; requiring the ORIGINAL BYTES BACK after corruption can
    // only pass if the generator ran and was deterministic.
    const before = snapshot(project);
    const targets = ["AGENTS.md", "CODE-MAP.md", join(".claude", "rules", "key-files.md")];
    for (const t of targets) writeFileSync(join(project, t), "CORRUPTED BY TEST\n");

    const corrupted = snapshot(project);
    expect(diffKeys(before, corrupted).length, "the corruption step did not actually change anything")
      .toBeGreaterThanOrEqual(targets.length);

    scaffold(project);
    const restored = snapshot(project);
    expect(diffKeys(before, restored), "re-scaffold did not reproduce the original bytes").toEqual([]);
  }, 300_000);

  test("CODE-MAP.md needs one extra run to describe the project scaffold just made", () => {
    // Documents the known limitation found while writing this gate, so it is a
    // recorded property rather than a surprise. A FRESH project's first
    // CODE-MAP.md undercounts: it is generated from a pre-scaffold scan, so it
    // misses .claude/agents/, specs/ and the devDependency the same run adds.
    const fresh = mkdtempSync(join(tmpdir(), "sc364-fresh-"));
    try {
      mkdirSync(join(fresh, "src"), { recursive: true });
      writeFileSync(join(fresh, "package.json"), JSON.stringify({ name: "p", scripts: { test: "bun test" } }));
      writeFileSync(join(fresh, "src", "index.ts"), "export const x = 1;\n");
      sh("git", ["init", "-q", "-b", "main", fresh], "/tmp");
      sh("git", ["-C", fresh, "config", "user.email", "test@example.invalid"], fresh);
      sh("git", ["-C", fresh, "config", "user.name", "Test"], fresh);
      sh("git", ["add", "-A"], fresh);
      sh("git", ["commit", "-q", "-m", "init"], fresh);

      scaffold(fresh);
      const first = readFileSync(join(fresh, "CODE-MAP.md"), "utf-8");
      scaffold(fresh);
      const second = readFileSync(join(fresh, "CODE-MAP.md"), "utf-8");

      expect(first, "first-run CODE-MAP.md already matches — the convergence gap closed, simplify this test")
        .not.toBe(second);
      expect(second, "second run should see the specs/ directory scaffold created").toContain("specs/");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }, 420_000);

  test("a deleted generated file comes back identical", () => {
    const before = snapshot(project);
    rmSync(join(project, ".claude", "rules", "key-files.md"));
    scaffold(project);
    const after = snapshot(project);
    expect(diffKeys(before, after), "a deleted rule was not regenerated identically").toEqual([]);
  }, 300_000);
});

describe("SC-364: volatile values are confined to declared fields", () => {
  // Two independently scaffolded copies of an IDENTICAL project differ in
  // exactly three places, all of which are legitimately per-project:
  //   config.json  scaffoldedAt   — creation time, written once
  //   CODE-MAP.md  scanned-at-sha — the project's own commit
  //   CODE-MAP.md  the absolute project path
  //
  // They are listed here rather than filtered silently, because the list IS
  // the claim: anything else becoming run-dependent should fail this test and
  // force a decision, instead of being absorbed by a loose comparison.
  test("the volatile set is exactly the two declared fields", () => {
    // The list is the claim. If a third volatile field is added, the raw
    // comparison below fails and someone has to justify it here rather than
    // widening a regex quietly.
    expect(VOLATILE_FIELDS.map(f => f.name)).toEqual(["scanned-at-sha", "scaffoldedAt"]);
  });

  test("raw output differs ONLY in the declared volatile fields", () => {
    // Normalized comparison proves determinism; this proves the normalization
    // is not hiding anything. Without it, a sloppy regex could mask real
    // non-determinism and the whole gate would read as green again.
    const rawBefore = snapshot(project, false);
    scaffold(project);
    const rawAfter = snapshot(project, false);

    for (const rel of diffKeys(rawBefore, rawAfter)) {
      const body = readFileSync(join(project, rel.replace(" (added)", "")), "utf-8");
      const touchesDeclared = VOLATILE_FIELDS.some(f => new RegExp(f.re.source).test(body));
      expect(touchesDeclared, `${rel} changed between runs but contains no declared volatile field`).toBe(true);
    }
  }, 300_000);

  test("no generated file embeds a wall-clock time outside config.json", () => {
    const snap = snapshot(project);
    const offenders: string[] = [];
    for (const rel of snap.keys()) {
      if (rel === join(".claude", "rungate", "config.json")) continue;
      const body = readFileSync(join(project, rel), "utf-8");
      // An ISO timestamp with sub-day precision is run-dependent; a plain date
      // is not, and several generated docs legitimately carry one.
      if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(body)) offenders.push(rel);
    }
    expect(offenders, "a generated file embeds a wall-clock timestamp, making its output unreproducible").toEqual([]);
  }, 300_000);
});
