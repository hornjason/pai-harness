import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

/**
 * The experiment for #105: which tree does a path helper hand back, and does it
 * say so out loud when it does not know?
 *
 * `harnessRoot()` used to end with `join(process.env.HOME, ".claude")`. That
 * line is why a miss was never visible: an agent running inside a worktree, a
 * script run from a checkout without the HARNESS.md marker, and a genuinely
 * misconfigured run all resolved to the same plausible-looking directory and
 * read harness-owned files out of it. The read succeeded, the content came from
 * a different tree than the one under test, and nothing in the output said so.
 *
 * Every case below runs `lib/paths.ts` in a SUBPROCESS against a purpose-built
 * temp tree. That is deliberate: `harnessRoot()` resolves relative to
 * `import.meta.dir`, so the only way to ask "what does it do from a worktree"
 * is to put a copy of the module in one. It also keeps HARNESS_ROOT out of the
 * test runner's own environment.
 *
 * Per .claude/rules/checks-must-be-able-to-fail.md, each refusal case runs
 * TWICE — once against the real source, once against a mutant copy with the
 * single `REFUSE_IMPLICIT_ROOT` constant set to 0. The mutant assertion is the
 * point: it is the removal of the refusal, performed and observed, so a case
 * that later starts passing for an unrelated reason (a probe that fails to
 * launch, say, which also produces no root) stops being indistinguishable from
 * a case that is genuinely refused.
 */

const SRC = join(import.meta.dir, "..", "lib", "paths.ts");
const LIVE = "export const REFUSE_IMPLICIT_ROOT = 1;";
const DEAD = "export const REFUSE_IMPLICIT_ROOT = 0;";

const PROBE = `
import { harnessRoot, harnessRootFor, paiRoot } from "./lib/paths";
const mode = process.argv[2];
try {
  const value =
    mode === "static" ? harnessRoot({ staticReads: true, caller: "probe-static-read" })
    : mode === "explicit" ? harnessRootFor(process.argv[3]!)
    : mode === "pai" ? paiRoot()
    : harnessRoot({ caller: "probe-implicit" });
  console.log(JSON.stringify({ ok: true, value }));
} catch (e: any) {
  console.log(JSON.stringify({ ok: false, message: String(e && e.message) }));
}
`;

type Tree = { marker?: boolean; git?: boolean; dirty?: boolean; mutant?: boolean };

function makeTree(opts: Tree): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-root-")));
  mkdirSync(join(dir, "lib"), { recursive: true });

  let src = readFileSync(SRC, "utf-8");
  if (opts.mutant) {
    // The constant must appear exactly once in the source, or a refusal could
    // quietly bypass the mutation by inlining its own `throw`.
    expect(src.split(LIVE).length - 1).toBe(1);
    src = src.replace(LIVE, DEAD);
    expect(src).toContain(DEAD);
  }
  writeFileSync(join(dir, "lib", "paths.ts"), src);
  writeFileSync(join(dir, "probe.ts"), PROBE);
  if (opts.marker) writeFileSync(join(dir, "HARNESS.md"), "# marker\n");

  if (opts.git) {
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        encoding: "utf-8",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    if (opts.dirty) appendFileSync(join(dir, "HARNESS.md"), "edited\n");
  }
  return dir;
}

function probe(dir: string, mode: string, env: Record<string, string | undefined> = {}, arg?: string) {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) childEnv[k] = v;
  }
  if (env.HARNESS_ROOT === undefined) delete childEnv.HARNESS_ROOT;

  const args = ["run", join(dir, "probe.ts"), mode];
  if (arg !== undefined) args.push(arg);
  const r = spawnSync("bun", args, { cwd: dir, encoding: "utf-8", env: childEnv, timeout: 30_000 });
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  try {
    return JSON.parse(line) as { ok: boolean; value?: string; message?: string };
  } catch {
    throw new Error(`probe did not report: status=${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  }
}

describe("harnessRoot: the run's root, or a refusal", () => {
  test("a worktree and the main checkout agree on the run's root", () => {
    // A copy of the module living in its own marked tree — i.e. a linked
    // worktree, which carries HARNESS.md just like the main checkout. Without
    // HARNESS_ROOT this would resolve to the worktree; with it, the run's root
    // wins, so the file read and the file under test are the same file.
    const worktree = makeTree({ marker: true, git: true });
    const runRoot = makeTree({ marker: true, git: true });

    const r = probe(worktree, "default", { HARNESS_ROOT: runRoot });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(runRoot);
    expect(r.value).not.toBe(worktree);
  }, 60_000);

  test("no-env regression: unset HARNESS_ROOT refuses instead of falling back to HOME", () => {
    const dir = makeTree({ marker: false });
    const home = makeTree({ marker: false });

    const r = probe(dir, "default", { HOME: home });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("probe-implicit"); // names the caller
    expect(r.message).toContain("HARNESS_ROOT"); // fix one
    expect(r.message).toContain("harnessRootFor"); // fix two
    // The deleted line, asserted by its effect: nothing resolves to ~/.claude.
    expect(r.message).not.toContain(join(home, ".claude"));
  }, 60_000);

  test("POSITIVE CONTROL: with the refusal removed, the same inputs do not refuse", () => {
    const dir = makeTree({ marker: false, mutant: true });
    const home = makeTree({ marker: false });

    const r = probe(dir, "default", { HOME: home });
    expect(r.ok).toBe(true); // mutant hands back a root instead of refusing
    expect(r.message).toBeUndefined();
  }, 60_000);

  test("an explicit root is preferred over the module-relative guess", () => {
    const dir = makeTree({ marker: true });
    const other = makeTree({ marker: true });

    const r = probe(dir, "explicit", { HARNESS_ROOT: other }, dir);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(dir);

    // An explicit root is the caller saying which tree it means, so an empty
    // one is a bug at the call site, not a cue to go looking.
    const empty = probe(dir, "explicit", { HARNESS_ROOT: other }, "");
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain("harnessRootFor");
  }, 60_000);

  test("a dirty implicit root is refused for reads of harness-owned static files", () => {
    const dirty = makeTree({ marker: true, git: true, dirty: true });

    const r = probe(dirty, "static");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("probe-static-read"); // names the caller
    expect(r.message).toContain(dirty);
    expect(r.message).toContain("HARNESS_ROOT");
    expect(r.message).toContain("harnessRootFor");
  }, 60_000);

  test("POSITIVE CONTROL: with the refusal removed, the same dirty tree is accepted", () => {
    const dirty = makeTree({ marker: true, git: true, dirty: true, mutant: true });

    const r = probe(dirty, "static");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(dirty);
  }, 60_000);

  test("a clean implicit root still serves static reads", () => {
    const clean = makeTree({ marker: true, git: true });

    const r = probe(clean, "static");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(clean);
  }, 60_000);

  test("the HOME fallback line is gone from the source, not reworded", () => {
    const src = readFileSync(SRC, "utf-8");
    expect(src).not.toMatch(/return join\(process\.env\.HOME[^)]*\)\s*,\s*["']\.claude["']\)/);
    // paiRoot() legitimately owns ~/.claude; harnessRoot() must not consult
    // HOME at all. Slice the function body only — the prose below it discusses
    // ~/.claude for unrelated reasons.
    const start = src.indexOf("export function harnessRoot(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("process.env.HOME");
    expect(body).not.toContain(".claude");
  });

  test("the fallback literal is absent from the whole module, not just harnessRoot", () => {
    // AC-2 as a count rather than a shape: the exact expression that made a
    // wrong tree resolve silently must not survive anywhere in the file, in
    // harnessRoot or copied into a neighbour.
    const src = readFileSync(SRC, "utf-8");
    expect(src.split(`join(process.env.HOME || "", ".claude")`).length - 1).toBe(0);
  });

  test("paiRoot still prefers PAI_ROOT, then the home .claude directory", () => {
    // The other half of AC-2, and the reason the literal cannot simply be
    // deleted: ~/.claude genuinely IS the PAI root. Removing the guess from
    // harnessRoot must not quietly remove it from paiRoot too, so assert both
    // branches by running them — a grep for absence cannot tell the difference
    // between "reworded" and "broken".
    const dir = makeTree({ marker: true });
    const home = makeTree({ marker: false });
    const explicit = makeTree({ marker: false });

    const viaHome = probe(dir, "pai", { HOME: home, PAI_ROOT: undefined });
    expect(viaHome.ok).toBe(true);
    expect(viaHome.value).toBe(join(home, ".claude"));

    const viaEnv = probe(dir, "pai", { HOME: home, PAI_ROOT: explicit });
    expect(viaEnv.ok).toBe(true);
    expect(viaEnv.value).toBe(explicit);
  }, 60_000);

  test("the mutant is runnable: lib/paths.ts has no relative imports", () => {
    // Without this, a later `from "../lib/x"` would make every mutant die on
    // module resolution — which reads as the mutation having been rejected on
    // the merits rather than never having run.
    const src = readFileSync(SRC, "utf-8");
    expect(src).not.toMatch(/from\s+["']\.\.?\//);
  });
});
