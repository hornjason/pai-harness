/**
 * Covers SC-1663, SC-1664, SC-1665 (SCAFFOLD-DECOMPOSITION-SPEC.md), #481.
 *
 * `bunx rungate scaffold .` — the form the harness documents — crashed partway
 * through and left the project half-written. The same command with an absolute
 * root completed cleanly.
 *
 *   const dir = filePath.substring(0, filePath.lastIndexOf("/"));
 *   if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
 *
 * With a relative root a repo-root target carries no `/` at all, so
 * `lastIndexOf` is -1, `substring(0, -1)` is `""` — `substring` clamps a
 * negative end to zero — and `mkdirSync("")` throws ENOENT. Every repo-root
 * owned file reaches it; `project-state.json` is only the first one the step
 * order gets to.
 *
 * ## Why this is three tests and not one
 *
 * The one-line fix is `dirname()`, and a unit test over `regenerateOwned`
 * proves the line. It does not prove the command works, because the defect was
 * never visible at the line — it was visible in the ARGUMENT, which no unit
 * test chooses the way a user does. So the second test runs the real CLI with
 * the real argument, and the third compares the two invocations to EACH OTHER
 * over the same directory, which is the only form that catches a future
 * divergence in either direction.
 *
 * The third is the one that matters most and the one that is easiest to write
 * wrongly. Scaffolding two different fixture paths and diffing them compares
 * trees whose content legitimately embeds two different roots, so the
 * comparison needs a normaliser — and a normaliser is somewhere a real
 * difference can hide. Both runs therefore target the SAME directory, restored
 * from a pristine copy in between, so byte-identical means byte-identical.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

const HARNESS = resolve(import.meta.dir, "..");
const SCAFFOLD = join(HARNESS, "scripts", "scaffold-project.ts");

let work: string;
let pristine: string;
let project: string;

/** The smallest tree the scaffold will accept, carrying something to detect. */
function buildFixture(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "specs"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "rel-root-fixture", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ESNext" } }, null, 2) + "\n",
  );
  writeFileSync(join(dir, "src", "index.ts"), "export const hello = 1;\n");
  // The spec is load-bearing, and finding that out is half of this issue.
  // `generateProjectState` SKIPs a project with no SCs — "SKIP:
  // PROJECT-STATE.md (no SCs found in specs)" — so a fixture without one
  // never reaches the write at all and the crash does not reproduce. A
  // regression test for a half-write has to get as far as the half.
  writeFileSync(
    join(dir, "specs", "FIXTURE-SPEC.md"),
    [
      "---",
      "doc-type: spec",
      "testable: true",
      "governs: the fixture tree this test scaffolds",
      "---",
      "",
      "# Fixture Spec",
      "",
      "## Success Criteria",
      "",
      "- [ ] SC-1: src/index.ts exists",
      "",
    ].join("\n"),
  );
}

/** Every file in the tree, relative path → bytes. `.git` is not ours. */
function snapshot(dir: string, base = dir, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) snapshot(abs, base, out);
    else out.set(relative(base, abs), readFileSync(abs, "utf-8"));
  }
  return out;
}

function scaffold(root: string, cwd: string, writeMode = true): { code: number; out: string } {
  const proc = Bun.spawnSync({
    // `--fix` is the writing mode. Without it the run REHEARSES against a
    // clone and discards it — and the clone's path comes from `mkdtemp`, so
    // the audit takes the absolute branch no matter what the user typed. That
    // is the rehearsal-fidelity gap this issue names, confirmed from the code
    // rather than inferred: `scripts/scaffold-project.ts:97` hands
    // `rehearsal.dir` to the steps, never `projectPath`.
    cmd: ["bun", SCAFFOLD, root, ...(writeMode ? ["--fix"] : [])],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString() + proc.stderr.toString() };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "rg-481-"));
  pristine = join(work, "pristine");
  project = join(work, "project");
  buildFixture(pristine);
  cpSync(pristine, project, { recursive: true });
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("#481: the documented invocation", () => {
  test("SC-1664: the scaffold is invoked with a relative root and completes", () => {
    // `.` from inside the project — the form AGENTS.md documents and the form
    // that threw. Asserted on the exit code AND on the absence of the throw,
    // because a scaffold that catches its own ENOENT and carries on would
    // exit 0 while still not having written the file.
    const { code, out } = scaffold(".", project);
    expect(code, out).toBe(0);
    expect(out).not.toMatch(/ENOENT/);
    expect(out).not.toMatch(/no such file or directory, mkdir/);
  });

  test("the repo-root owned files are actually on disk afterwards", () => {
    // The arm that makes the one above mean something. A scaffold that
    // reported success and wrote nothing at the repo root would satisfy an
    // exit-code assertion exactly as a working one does — and "reported
    // CREATED for a write that crashed" is precisely what the rehearsal did.
    scaffold(".", project);
    for (const f of ["AGENTS.md", "project-state.json", "PROJECT-STATE.md"]) {
      expect(
        readFileSync(join(project, f), "utf-8").length,
        `${f} is absent or empty after a relative-root scaffold`,
      ).toBeGreaterThan(0);
    }
  });

  test("SC-1665: the relative and absolute invocations produce byte-identical trees", () => {
    // Both runs target the SAME directory, restored from the pristine copy in
    // between, so there is no root string to normalise away and no normaliser
    // for a real difference to hide behind.
    const abs = scaffold(project, project);
    expect(abs.code, abs.out).toBe(0);
    const fromAbsolute = snapshot(project);

    rmSync(project, { recursive: true, force: true });
    cpSync(pristine, project, { recursive: true });

    const rel = scaffold(".", project);
    expect(rel.code, rel.out).toBe(0);
    const fromRelative = snapshot(project);

    // Not vacuous: a scaffold that wrote nothing would make two empty maps
    // equal. The fixture carries five files, so anything under that is the
    // half-write this issue is about.
    expect(fromAbsolute.size, "the absolute run produced no tree to compare").toBeGreaterThan(5);

    expect([...fromRelative.keys()].sort()).toEqual([...fromAbsolute.keys()].sort());

    // Three things legitimately differ between any two runs, and each is
    // excluded by NAME with a reason rather than by a pattern. A normaliser is
    // the obvious place for a real difference to hide, so the narrower it is
    // the better: two of the three strip ONE LINE and leave the rest of the
    // file compared byte-for-byte.
    //
    //  - `scaffoldedAt` is a timestamp, and the two runs are seconds apart.
    //  - CODE-MAP's "Re-run …" line echoes the root the operator typed, which
    //    is the one place the two invocations SHOULD read differently — a
    //    re-run instruction naming a path the operator never used is worse
    //    than one that varies.
    //  - `.fallow/cache.bin` is a binary cache keyed on absolute paths.
    const normalise = (file: string, body: string): string =>
      body
        .split("\n")
        .filter(l => !(file === ".claude/rungate/config.json" && l.includes('"scaffoldedAt"')))
        .filter(l => !(file === "CODE-MAP.md" && l.includes("to refresh.")))
        .join("\n");

    const EXCLUDED = new Set([".fallow/cache.bin"]);
    // ...and the exclusion is itself asserted, so a file silently vanishing
    // from one run cannot be mistaken for a file deliberately skipped.
    //
    // This demanded that BOTH runs produced the file, and that is a
    // demand on the npm registry: `fallow` is an optional tool nobody
    // declares, `.fallow/cache.bin` exists only where it resolves, and
    // until #581 the scaffold reached for it with a bare `npx`. PR #580 —
    // three state files, no code — went red here when the fetch failed,
    // and the message blamed the two invocations for a network. Reproduced
    // with `npm_config_registry=http://127.0.0.1:1/` and no repo change.
    //
    // So the half this repo owns is asserted and the half it does not is
    // named: both-or-neither always, and non-vacuity only where the tool
    // that writes the file is installed.
    for (const f of EXCLUDED) {
      const inAbsolute = fromAbsolute.has(f);
      expect(inAbsolute, `${f} is excluded but only ONE invocation produced it`).toBe(fromRelative.has(f));
      if (!inAbsolute) {
        console.warn(
          `UNMEASURED: ${f} was produced by neither run — fallow is not installed here, ` +
            `so this exclusion was not exercised. An exclusion nothing produces is dead weight ` +
            `that can grow to cover a real divergence.`,
        );
      }
    }

    const differing = [...fromAbsolute.keys()]
      .filter(k => !EXCLUDED.has(k))
      .filter(k => normalise(k, fromAbsolute.get(k)!) !== normalise(k, fromRelative.get(k)!));
    expect(differing, `content differs between the two invocations: ${differing.join(", ")}`).toEqual([]);

    // The normaliser is not a licence to ignore those two files: everything
    // either side of the stripped line still has to match, and both files
    // have to be substantial. Without this, rewriting `normalise` to return
    // `""` would pass.
    for (const f of [".claude/rungate/config.json", "CODE-MAP.md"]) {
      expect(normalise(f, fromAbsolute.get(f)!).length, `${f} normalised to nothing`).toBeGreaterThan(200);
    }
  });
});

describe("#481: the audit says which input it substituted", () => {
  test("SC-1666: the rehearsal notice names the root it ran against and the one it did not", () => {
    // The audit cannot avoid substituting the root — a rehearsal has to run
    // somewhere else or it is not a rehearsal. What it can do is say so.
    // Without this line the audit reported `CREATED: project-state.json` for
    // a write that threw seconds later under --fix, and nothing in its output
    // distinguished "we checked this" from "we checked something adjacent".
    const { code, out } = scaffold(".", project, false);
    expect(code, out).toBe(0);
    expect(out).toContain("Root SUBSTITUTED");
    expect(out).toContain("UNMEASURED");
    // Both ends of the substitution, named. One without the other is a
    // sentence the reader cannot act on.
    expect(out, "the notice does not name the root the operator typed").toMatch(/not \.(\s|,|—)/);
    expect(out).toMatch(/ran against \/[^\s,]+/);
  });

  test("the notice still names the steps it did not rehearse", () => {
    // The pre-existing half. Appending to a sentence is the easiest way to
    // drop what was already in it.
    const { out } = scaffold(".", project, false);
    expect(out).toContain("Not rehearsed:");
    expect(out).toContain("postScaffoldCommit");
  });
});

describe("#481: the line the two invocations differ at", () => {
  /**
   * Driven as a subprocess rather than called in-process, because the input
   * that triggers it is a RELATIVE path, and making one of those meaningful
   * means changing the working directory — which in bun is process-global and
   * would leak into every other test file sharing the process.
   */
  function writeBareName(targetName: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "rg-481-unit-"));
    const script = join(dir, "probe.ts");
    writeFileSync(
      script,
      [
        `import { regenerateOwned } from ${JSON.stringify(join(HARNESS, "lib", "scaffold", "steps"))};`,
        `process.chdir(${JSON.stringify(dir)});`,
        `const actions: string[] = [];`,
        `regenerateOwned(${JSON.stringify(targetName)}, "x\\n", ${JSON.stringify(targetName)}, actions);`,
        `console.log(actions.join("\\n"));`,
      ].join("\n"),
    );
    const proc = Bun.spawnSync({ cmd: ["bun", script], cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString() + proc.stderr.toString();
    rmSync(dir, { recursive: true, force: true });
    return { code: proc.exitCode ?? -1, out };
  }

  test("SC-1663: a target with no directory separator resolves to the current directory", () => {
    const { code, out } = writeBareName("project-state.json");
    expect(code, out).toBe(0);
    expect(out).toContain("CREATED: project-state.json");
  });

  test("a target that DOES carry a separator still gets its directory made", () => {
    // The positive control, and the case that passed before the fix — which
    // is why a fixture using a nested path could not have caught this.
    //
    // **This case belongs to `regenerateOwned`'s own mkdir, and nothing else
    // in this file does.** Found by a prediction that missed: replacing
    // `dirname(filePath)` with the constant `"."` was predicted to turn 5 of
    // 7 red and turned exactly this one. The scaffold never depends on that
    // mkdir — every directory it writes into has already been made by an
    // earlier step, which is what `CREATED: .claude/agents/` and
    // `CREATED: .claude/rungate/` in its own output are. So the step that
    // makes the directory and the write that would make it are two deciders
    // answering one question, and no end-to-end case can tell them apart.
    //
    // They are kept apart rather than collapsed, because the mkdir is a
    // one-line fallback for a caller that has no directory-making step, and
    // deleting it would make the next such caller fail at write time instead
    // of at a named one. The cost of keeping it is this test: an input only
    // the fallback can reach, written down as the reason it exists.
    const { code, out } = writeBareName("nested/deeper/thing.json");
    expect(code, out).toBe(0);
    expect(out).toContain("CREATED: nested/deeper/thing.json");
  });
});
