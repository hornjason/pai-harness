/**
 * #1001 — `ProjectStateSync` ran a generator from wherever a tool call
 * pointed.
 *
 * Anything able to write `<anywhere>/project-state.json` and
 * `<anywhere>/scripts/update-project-state.ts` got code execution as the
 * user on the next `Write` or `Edit`. `Write` is gated far more loosely than
 * `Bash`, and the agent never ran a command — the hook ran it for them. That
 * is a permission-gate bypass, not a path-handling slip, and #971/#999's argv
 * conversion does nothing about it.
 *
 * ## The two inputs this battery is built around
 *
 * | input | must | why it is here |
 * |---|---|---|
 * | a planted root in an untrusted `mkdtemp` | **REFUSE** | the defect |
 * | a real root reached through a **symlink** | **ALLOW** | the live caller |
 *
 * The second is not padding. `/Users/jhorn/Projects/pai-harness` is a symlink
 * to `/Users/jhorn/Projects/rungate` and the real `project-state.json` is
 * written through it, so the obvious spelling of the fix —
 * `claimed !== repoRootFrom(claimed)` — refuses the only real caller there
 * is, silently, while looking like a security improvement. A battery with
 * only the first input ships that.
 *
 * ## The cheapest wrong fix, and the arm that kills it
 *
 * *"Allow anything under `$HOME/Projects`."* AC-4 plants its untrusted root
 * **inside a directory that passes a prefix test** and asserts refusal
 * anyway, so a prefix allowlist cannot make this battery green.
 *
 * Issue: #1001.
 */

import { afterAll, describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { realpathSync } from "fs";
import { GENERATOR_RELPATH, projectStateTarget } from "../lib/project-state-root";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
function tmp(prefix = "pst-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A directory holding the two files the hook keys on. `git` optional. */
function plant(dir: string, opts: { git?: boolean; generator?: "file" | "symlink" | "dir" | "none" } = {}) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "project-state.json"), "{}");
  const script = join(dir, GENERATOR_RELPATH);
  const gen = opts.generator ?? "file";
  if (gen === "file") writeFileSync(script, "// generator\n");
  if (gen === "dir") mkdirSync(script);
  if (gen === "symlink") {
    const outside = join(tmp(), "payload.ts");
    writeFileSync(outside, "// payload outside the repo\n");
    symlinkSync(outside, script);
  }
  if (opts.git) {
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  }
  return join(dir, "project-state.json");
}

describe("#1001 — the generator runs only at the root of a real repository", () => {
  test("AC-1: a planted root in an untrusted mkdtemp is REFUSED", () => {
    // The issue's own measured attack, as a case. /tmp is writable and the
    // directory has no relationship to any rungate project.
    const base = tmp();
    const r = projectStateTarget(plant(join(base, "not-a-project")));
    expect(r.ok, "the generator would have run in a planted /tmp directory").toBe(false);
    expect((r as { outcome: string }).outcome).toBe("declined-outside-repo");
  });

  test("AC-2 CONTROL: a real repository root with a real generator is ALLOWED", () => {
    // Without this, every refusal arm is equally consistent with a function
    // that refuses everything — which would pass the whole battery and break
    // the hook.
    const dir = tmp();
    const r = projectStateTarget(plant(dir, { git: true }));
    expect(r.ok, `a legitimate repo root was refused: ${JSON.stringify(r)}`).toBe(true);
    expect((r as { script: string }).script).toBe(join(realpathSync(dir), GENERATOR_RELPATH));
  });

  test("AC-3: a real root reached through a SYMLINK is allowed — the live caller's shape", () => {
    // `/Users/jhorn/Projects/pai-harness -> …/rungate`, measured on this
    // machine, is exactly this. The naive anchor compares a resolved
    // `repoRootFrom` answer against an UNRESOLVED claimed path, so it can
    // never agree through a link and refuses the only real caller.
    const real = tmp();
    plant(real, { git: true });
    const link = join(tmp(), "via-link");
    symlinkSync(real, link);

    const r = projectStateTarget(join(link, "project-state.json"));
    expect(r.ok, `a repo root reached through a symlink was refused: ${JSON.stringify(r)}`).toBe(true);
    // And it runs against the RESOLVED root, so cwd is stable whichever name
    // the caller used.
    expect((r as { projectRoot: string }).projectRoot).toBe(realpathSync(real));
  });

  test("AC-4: a planted root INSIDE a trusted-looking prefix is still refused", () => {
    // THE ARM THAT KILLS THE CHEAP FIX. "Allow anything under $HOME/Projects"
    // is a prefix test; this input satisfies any prefix test you like and is
    // still a directory an attacker made. The property is "root of a real
    // repository", which no prefix can express.
    const prefix = join(tmp(), "Projects");
    const r = projectStateTarget(plant(join(prefix, "looks-legit")));
    expect(r.ok, "a prefix allowlist would have executed this").toBe(false);
    expect((r as { outcome: string }).outcome).toBe("declined-outside-repo");
  });

  test("AC-5: a SUBDIRECTORY of a real repository is refused", () => {
    // Being inside a repo is not being its root. Without this the anchor
    // would accept `<repo>/node_modules/evil/`, which is writable by any
    // install.
    const repo = tmp();
    plant(repo, { git: true });
    const sub = join(repo, "nested");
    const r = projectStateTarget(plant(sub));
    expect(r.ok).toBe(false);
    expect((r as { outcome: string }).outcome).toBe("declined-not-repo-root");
    expect(((r as { detail: Record<string, unknown> }).detail.repoRoot)).toBe(realpathSync(repo));
  });

  test("AC-6: a LINKED WORKTREE is refused, and says so distinctly (#296)", () => {
    // `repoRootFrom` resolves `--git-common-dir`, so a linked worktree
    // reports the MAIN checkout and is not its own root. This is a
    // behaviour change: `PROJECT-STATE.md` is DA-owned and a worktree agent
    // must never write it, which #910 SC-3 raised while the hook was
    // registered on Write AND Edit and taking the other answer by default.
    const repo = tmp();
    plant(repo, { git: true });
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { stdio: "ignore" });
    const wt = join(tmp(), "wt");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "scratch", wt], { stdio: "ignore" });
    plant(wt);

    const r = projectStateTarget(join(wt, "project-state.json"));
    expect(r.ok, "the hook would regenerate a DA-owned file from inside a worktree").toBe(false);
    expect((r as { outcome: string }).outcome).toBe("declined-not-repo-root");
    // The detail is what makes a worktree distinguishable from a subdir in
    // the evidence file, so the #296 question is answerable from records.
    expect(((r as { detail: Record<string, unknown> }).detail.repoRoot)).toBe(realpathSync(repo));
  });

  test("AC-7: a SYMLINKED generator is refused even inside a trusted root", () => {
    // Confining the directory does nothing if a link inside it reaches out.
    // `lstat` rather than `stat` is the whole difference.
    const dir = tmp();
    const r = projectStateTarget(plant(dir, { git: true, generator: "symlink" }));
    expect(r.ok, "a symlinked generator pointing outside the repo was executed").toBe(false);
    expect((r as { outcome: string }).outcome).toBe("declined-symlinked-generator");
  });

  test("AC-8: a generator that is a DIRECTORY, or absent, is refused as no-generator", () => {
    const a = tmp();
    expect((projectStateTarget(plant(a, { git: true, generator: "dir" })) as { outcome: string }).outcome)
      .toBe("declined-no-generator");
    const b = tmp();
    expect((projectStateTarget(plant(b, { git: true, generator: "none" })) as { outcome: string }).outcome)
      .toBe("declined-no-generator");
  });

  test("AC-9: a root that does not exist is refused, and does not throw", () => {
    const r = projectStateTarget(join(tmp(), "nope", "project-state.json"));
    expect(r.ok).toBe(false);
    expect((r as { outcome: string }).outcome).toBe("declined-unresolvable-root");
  });

  test("AC-10: a flag-shaped path cannot reach the argv — resolution is the mechanism", () => {
    // A `file_path` of `-rf/project-state.json` built the argv
    // `-rf/scripts/update-project-state.ts` before this change, which `bun`
    // parses as options rather than as a script.
    //
    // There is deliberately NO `startsWith("-")` branch: after `realpathSync`
    // the path is absolute and that branch could never be taken, which is a
    // check that cannot fail. This arm asserts the property instead, over
    // the one input that used to produce it — a repository literally named
    // `-rf`, which resolves and is therefore ALLOWED, with an absolute argv.
    const base = tmp();
    const weird = join(base, "-rf");
    plant(weird, { git: true });

    const r = projectStateTarget(join(weird, "project-state.json"));
    expect(r.ok, `a legitimately-named repo was refused: ${JSON.stringify(r)}`).toBe(true);
    const script = (r as { script: string }).script;
    expect(script.startsWith("-"), "the generator path would be read by bun as a flag").toBe(false);
    expect(script.startsWith("/")).toBe(true);
  });

  test("AC-11: every refusal carries an outcome and the path it refused", () => {
    // A refusal that records nothing is indistinguishable from a hook that
    // never ran (#910). This asserts the shape across every decline the
    // battery produces, rather than once per arm.
    const cases = [
      projectStateTarget(plant(tmp())),
      projectStateTarget(plant(tmp(), { git: true, generator: "symlink" })),
      projectStateTarget(plant(tmp(), { git: true, generator: "none" })),
      projectStateTarget(join(tmp(), "nope", "project-state.json")),
    ];
    for (const c of cases) {
      expect(c.ok).toBe(false);
      const d = c as { outcome: string; detail: Record<string, unknown> };
      expect(d.outcome.startsWith("declined-"), `outcome is not a decline: ${d.outcome}`).toBe(true);
      expect(d.detail.filePath, "the record does not name the path it refused").toBeTruthy();
    }
  });
});

describe("#1001 — the hook itself refuses, and leaves evidence when it does", () => {
  /**
   * The REAL hook, as a subprocess with real stdin, against a work dir of
   * its own. Nothing is staged or rewritten: the arms below are about the
   * shipped file.
   */
  function runHook(filePath: string): { records: Array<Record<string, unknown>>; ran: boolean; marker: string } {
    const work = tmp("pst-work-");
    const marker = join(work, "EXECUTED");
    const r = execFileSync("bun", [join(ROOT, "hooks", "ProjectStateSync.hook.ts")], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath }, cwd: work }),
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, RUNGATE_WORK_DIR: work, PST_MARKER: marker },
      stdio: ["pipe", "pipe", "pipe"],
    });
    void r;
    let records: Array<Record<string, unknown>> = [];
    try {
      records = readFileSync(join(work, "hook-firings.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch {}
    return { records, ran: existsSync(marker), marker };
  }

  /** A generator that proves execution by writing `$PST_MARKER`. */
  function plantExecutable(dir: string, git: boolean): string {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "project-state.json"), "{}");
    writeFileSync(
      join(dir, GENERATOR_RELPATH),
      'import {writeFileSync} from "fs";\nwriteFileSync(process.env.PST_MARKER!, "arbitrary code ran as the user");\n',
    );
    if (git) execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    return join(dir, "project-state.json");
  }

  test("AC-12: the issue's measured attack does NOT execute, and the refusal is recorded", () => {
    // Verbatim shape of the proof-of-concept in #1001, run against the
    // shipped hook. Before this change it printed "arbitrary code ran as the
    // user" and exited 0 with a `synced` record.
    const base = tmp();
    const { records, ran } = runHook(plantExecutable(join(base, "not-a-project"), false));
    expect(ran, "ARBITRARY CODE EXECUTED from a planted /tmp directory").toBe(false);
    expect(
      records.map(r => r.outcome),
      "the hook refused silently — a decline and a hook that never ran are the same observation (#910)",
    ).toContain("declined-outside-repo");
  });

  test("AC-13 CONTROL: a real repository root DOES execute, and is recorded as synced", () => {
    // The input on which the hook must still work. Without it AC-12 is
    // equally consistent with a hook that refuses everything.
    const dir = tmp();
    const { records, ran } = runHook(plantExecutable(dir, true));
    expect(ran, "the hook no longer runs the generator for a legitimate project").toBe(true);
    expect(records.map(r => r.outcome)).toContain("synced");
  });
});
