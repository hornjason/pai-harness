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

  // ONE run. The scaffold is a fixed point from the first invocation (#123) —
  // scaffolding twice here would hide a regression that reintroduces the
  // one-run-behind CODE-MAP, because run 2 would quietly repair it.
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

  test("corrupted harness-managed files are restored to byte-identical content", () => {
    // The anti-vacuity step. "Nothing changed" is free if the scaffold skips
    // existing files; requiring the ORIGINAL BYTES BACK after corruption can
    // only pass if the generator ran and was deterministic.
    //
    // `.claude/rules/key-files.md` was a third target here until #370, and
    // removing it is a contract change this test has to state rather than
    // absorb. A corrupted file and a hand-edited one are byte-identical to
    // any check, so "restore the original" and "never overwrite a human's
    // edit" cannot both hold over the same file. On 2026-10-13 the restoring
    // answer truncated `.claude/rules/checks-must-be-able-to-fail.md` from
    // 262 lines to 65 and reported success.
    //
    // The split is the one the repo already documents: AGENTS.md is
    // harness-owned (SC-11) and CODE-MAP.md is named in
    // `.claude/rules/harness-managed.md`, so both are unambiguously the
    // generator's. `.claude/rules/*.md` is the class where a human legitimately
    // edits a generated file, and it is governed by lib/rule-provenance.ts
    // instead — see the case below.
    const before = snapshot(project);
    const targets = ["AGENTS.md", "CODE-MAP.md"];
    for (const t of targets) writeFileSync(join(project, t), "CORRUPTED BY TEST\n");

    const corrupted = snapshot(project);
    expect(diffKeys(before, corrupted).length, "the corruption step did not actually change anything")
      .toBeGreaterThanOrEqual(targets.length);

    scaffold(project);
    const restored = snapshot(project);
    expect(diffKeys(before, restored), "re-scaffold did not reproduce the original bytes").toEqual([]);
  }, 300_000);

  test("an edited rule file is preserved instead, and the run says so", () => {
    // The other side of the split, asserted here rather than only in
    // test/rule-provenance.test.ts, because this is the file that used to
    // require the opposite. Without it the paragraph above is a comment
    // explaining why a case was deleted, and nothing holds the new contract.
    const path = join(project, ".claude", "rules", "key-files.md");
    const edited = readFileSync(path, "utf-8") + "\n<!-- a human wrote this -->\n";
    writeFileSync(path, edited);

    const report = scaffold(project);

    expect(readFileSync(path, "utf-8"), "the scaffold overwrote a hand-edited rule").toBe(edited);
    expect(report, "the withheld write was not reported").toContain(
      "PRESERVED: .claude/rules/key-files.md",
    );

    // Leave the fixture as the later cases expect to find it.
    writeFileSync(path, edited.replace("\n<!-- a human wrote this -->\n", ""));
  }, 300_000);

  test("a FRESH project's first CODE-MAP.md already describes what scaffold created", () => {
    // #123. generateCodeMapStep used to run in Phase 1, before the same run
    // wrote .claude/agents/, specs/ and a devDependency — so run 1 shipped a map
    // of a tree that stopped existing moments later (`specs/ 0 files`, no agents
    // directory). And because regeneration is skipped while the file is under 14
    // days old, no later run ever corrected it. The lag was permanent.
    //
    // WHY THIS IS NOT JUST `first === second`: that comparison is FREE under the
    // staleness skip — a scaffold that never regenerates CODE-MAP.md passes it
    // while shipping a wrong map forever. So the load-bearing assertions are the
    // CONTENT ones: the first map must name the directories and the dependency
    // that this very run created. Equality is then the fixed-point half.
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

      const report = scaffold(fresh);
      const first = readFileSync(join(fresh, "CODE-MAP.md"), "utf-8");

      // Each of these is a thing the SAME run created after the code map used
      // to be generated. Before #123 every one of them was absent or zero.
      //
      // The `specs/` witness USED TO BE a per-directory file count of `[1-9]`,
      // and #1163 removed that column — it was wrong in 22 of 50 consecutive
      // commits on this repo and no gate could hold it. This case is the one
      // consumer of the census that grep did not find, because it matched the
      // number rather than the header.
      //
      // The replacement is not weaker. `[1-9]` said only "the directory was
      // not empty"; the types cell says WHAT was in it, so `md` is direct
      // evidence that `copySpecTemplateIfEmpty` had already run when the map
      // was scanned. A scaffold that created `specs/` and put nothing in it
      // renders `| specs/ |  |` — measured, that is exactly what the empty
      // `scripts/` row looks like — so the empty-directory case still reds.
      expect(first, "first-run CODE-MAP.md does not list specs/ with a spec in it — scaffold wrote one this run")
        .toMatch(/\|\s*specs\/\s*\|[^|\n]*\bmd\b/);
      expect(first, "first-run CODE-MAP.md reports no devDependency — addPaiHarnessDevDep added one this run")
        .toMatch(/\|\s*Dev dependencies\s*\|\s*[1-9]/);
      // The third witness USED TO BE `| .claude/ | … agents … |`, and the
      // ONLY reason that cell ever contained the word `agents` was the defect
      // #1200 removed: `readdirSync(…, { recursive: true })` returns
      // directories as well as files, and `"agents".split(".").pop()` is
      // `"agents"`. The Types column reports file extensions now, so
      // `.claude/` reads `json, md` and no cell in CODE-MAP.md names a
      // subdirectory any more. #1200 predicted this move for the `specs/`
      // witness above and it survived; this one did not, because it was
      // reading the bug.
      //
      // So it moves, and the move is stated here. It also lands on a
      // STRONGER reading than the one it left. The property is ORDER —
      // `generateAgentBriefsStep` (Phase 1.5) must run before
      // `generateCodeMapStep` (Phase 3.5), which is the whole of #123 — and
      // the scaffold's own action log states that order outright instead of
      // letting it be inferred from a table cell. Nothing a future scanner
      // leaks into `Types` can satisfy it, and a `.claude/` row that exists
      // for some other step's sake cannot either.
      const briefsAt = report.indexOf("CREATED: .claude/agents/");
      const mapAt = report.indexOf("CREATED: CODE-MAP.md");
      expect(briefsAt, `the scaffold never reported creating .claude/agents/:\n${report}`)
        .toBeGreaterThan(-1);
      expect(mapAt, `the scaffold never reported creating CODE-MAP.md:\n${report}`).toBeGreaterThan(-1);
      expect(
        briefsAt,
        "CODE-MAP.md was written before .claude/agents/ existed — the Phase 3.5 ordering #123 fixed has regressed",
      ).toBeLessThan(mapAt);

      // ...and it is already the fixed point: a second run changes nothing.
      scaffold(fresh);
      const second = readFileSync(join(fresh, "CODE-MAP.md"), "utf-8");
      const norm = (s: string) => s.replace(/scanned-at-sha:\s*[0-9a-f]+/g, "<SHA>");
      expect(norm(second), "a second scaffold changed CODE-MAP.md — run 1 is not the fixed point")
        .toBe(norm(first));
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
