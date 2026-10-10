import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * scripts/rook-review-scope.ts — the security review's scope, taken from git
 * and refused when it is empty (#129).
 *
 * Every negative case runs TWICE: once against the real script, and once
 * against a mutant copy whose single exit-code constant is set to 0. The
 * second run is the evidence. A test that only asserts "exit code != 0" cannot
 * tell a refusal from a crash, a typo, or a module-resolution failure — and
 * .claude/rules/checks-must-be-able-to-fail.md counts five shipped bugs of
 * exactly that shape in one day. The mutant makes the removal of the refusal
 * observable: real refuses, mutant does not, so the case is caught on its
 * merits rather than by accident.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "rook-review-scope.ts");
const source = readFileSync(SCRIPT, "utf-8");

// ── The mutant ───────────────────────────────────────────────────────────
//
// Built once, in a temp directory OUTSIDE the repo. Running it from there is
// what proves the script has no relative imports: a later `from "../lib/..."`
// would make every mutant die on module resolution, exiting non-zero, which
// would read as "the mutation was rejected on the merits" when in fact the
// mutant never ran.

let MUTANT = "";
let MUTANT_DIR = "";

beforeAll(() => {
  MUTANT_DIR = mkdtempSync(join(tmpdir(), "rook-scope-mutant-"));
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error(
      "could not build the mutant: no `REFUSE_EXIT = 1` in scripts/rook-review-scope.ts",
    );
  }
  MUTANT = join(MUTANT_DIR, "rook-review-scope.ts");
  writeFileSync(MUTANT, mutated);
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/**
 * Assert a case is refused, and that the refusal is what is being observed.
 *
 * `mutantCode` is 0 for every case the script itself decides. The parse and
 * the git calls all funnel into the one `process.exit(REFUSE_EXIT)`, so there
 * is no case here where a non-zero mutant would be legitimate.
 */
function expectRefused(args: string[], reason: RegExp) {
  const real = run(SCRIPT, args);
  expect(real.code, `expected a refusal for [${args.join(" ")}]\n${real.err}`).not.toBe(0);
  expect(real.err).toMatch(reason);
  expect(real.out.trim(), "a refused run printed a scope on stdout").toBe("");

  const mutant = run(MUTANT, args);
  expect(
    mutant.code,
    `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for [${args.join(" ")}] — ` +
      `this case is not being caught by the refusal under test.\n${mutant.err}`,
  ).toBe(0);
}

// ── Fixture repositories ─────────────────────────────────────────────────

let FIX = "";
let repoWithChange = "";
let repoEmptyChange = "";
let repoThreeCommits = "";
let baseSha = "";
let changeSha = "";
let emptySha = "";
/** #171 fixture: origin/main, the reviewed commit, the remediation commit. */
let originSha = "";
let reviewedSha = "";
let remediationSha = "";

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
}

beforeAll(() => {
  FIX = mkdtempSync(join(tmpdir(), "rook-scope-fix-"));

  repoWithChange = join(FIX, "with-change");
  initRepo(repoWithChange);
  writeFileSync(join(repoWithChange, "a.ts"), "export const a = 1\n");
  git(repoWithChange, ["add", "-A"]);
  git(repoWithChange, ["commit", "-qm", "base"]);
  baseSha = git(repoWithChange, ["rev-parse", "HEAD"]);
  git(repoWithChange, ["checkout", "-qb", "work"]);
  writeFileSync(join(repoWithChange, "b.ts"), "export const b = 2\n");
  writeFileSync(join(repoWithChange, "a.ts"), "export const a = 99\n");
  git(repoWithChange, ["add", "-A"]);
  git(repoWithChange, ["commit", "-qm", "change"]);
  changeSha = git(repoWithChange, ["rev-parse", "HEAD"]);

  // The #129 shape: a branch cut from the base with nothing on it. This is
  // exactly what rook was handed twice in production — a worktree whose diff
  // against origin/main is empty — and it reported PASS both times.
  repoEmptyChange = join(FIX, "empty-change");
  initRepo(repoEmptyChange);
  writeFileSync(join(repoEmptyChange, "a.ts"), "export const a = 1\n");
  git(repoEmptyChange, ["add", "-A"]);
  git(repoEmptyChange, ["commit", "-qm", "base"]);
  git(repoEmptyChange, ["checkout", "-qb", "work"]);
  emptySha = git(repoEmptyChange, ["rev-parse", "HEAD"]);

  // #171: three commits on one branch, with a real origin/main ref behind all
  // of them. The remediation round only touched c.ts; the origin/main fallback
  // sees a.ts and b.ts as well, so the two answers are measurably different and
  // "--base narrowed the scope" cannot pass vacuously.
  repoThreeCommits = join(FIX, "three-commits");
  initRepo(repoThreeCommits);
  writeFileSync(join(repoThreeCommits, "a.ts"), "export const a = 1\n");
  git(repoThreeCommits, ["add", "-A"]);
  git(repoThreeCommits, ["commit", "-qm", "c1: the commit origin/main points at"]);
  originSha = git(repoThreeCommits, ["rev-parse", "HEAD"]);
  git(repoThreeCommits, ["update-ref", "refs/remotes/origin/main", originSha]);

  writeFileSync(join(repoThreeCommits, "a.ts"), "export const a = 2\n");
  writeFileSync(join(repoThreeCommits, "b.ts"), "export const b = 2\n");
  git(repoThreeCommits, ["add", "-A"]);
  git(repoThreeCommits, ["commit", "-qm", "c2: the commit the security review read"]);
  reviewedSha = git(repoThreeCommits, ["rev-parse", "HEAD"]);

  writeFileSync(join(repoThreeCommits, "c.ts"), "export const c = 3\n");
  git(repoThreeCommits, ["add", "-A"]);
  git(repoThreeCommits, ["commit", "-qm", "c3: the remediation round"]);
  remediationSha = git(repoThreeCommits, ["rev-parse", "HEAD"]);
});

afterAll(() => {
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

// ── The property the mutant protects ─────────────────────────────────────

describe("the refusal is routed through exactly one exit code", () => {
  test("REFUSE_EXIT is declared once", () => {
    const decls = source.match(/REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to REFUSE_EXIT — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("every process.exit goes through it", () => {
    const exits = source.match(/process\.exit\(([^)]*)\)/g) || [];
    expect(exits.length, "no process.exit at all — nothing can refuse").toBeGreaterThan(0);
    for (const e of exits) {
      expect(
        e,
        `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it and the ` +
          `negative tests below would pass for the wrong reason`,
      ).toBe("process.exit(REFUSE_EXIT)");
    }
  });

  test("the script has no relative imports", () => {
    // Without this, the mutant run from a temp directory dies on module
    // resolution — a non-zero exit that reads as a rejected mutation.
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, "a relative import would make every mutant run fail to resolve").toEqual([]);
  });
});

// ── SC-568: an empty scope is a refusal, not a clean review ──────────────

describe("SC-568: an empty review scope blocks the run", () => {
  test("a branch with no commits of its own is refused", () => {
    expectRefused(
      ["--project", repoEmptyChange, "--sha", emptySha, "--base", "main"],
      /empty/i,
    );
  });

  test("the refusal names the range it found nothing in", () => {
    const r = run(SCRIPT, ["--project", repoEmptyChange, "--sha", emptySha, "--base", "main"]);
    expect(r.err).toContain(emptySha.slice(0, 12));
  });

  test("no scope file is written when the scope is empty", () => {
    const out = join(FIX, "must-not-exist.json");
    const r = run(SCRIPT, [
      "--project", repoEmptyChange, "--sha", emptySha, "--base", "main", "--out", out,
    ]);
    expect(r.code).not.toBe(0);
    let wrote = true;
    try { readFileSync(out, "utf-8"); } catch { wrote = false; }
    expect(wrote, "a refused run still left a scope artefact behind").toBe(false);
  });

  test("comparing a commit against itself is refused", () => {
    // The degenerate case the production bug reduces to: base and head are the
    // same commit, the diff is empty, and nothing is reviewed.
    expectRefused(
      ["--project", repoWithChange, "--sha", changeSha, "--base", changeSha],
      /empty/i,
    );
  });
});

// ── Everything else that must fail closed ────────────────────────────────

describe("the scope fails closed on bad input", () => {
  test("no arguments", () => {
    expectRefused([], /--project/);
  });

  test("--project missing", () => {
    expectRefused(["--sha", changeSha], /--project/);
  });

  test("--sha missing", () => {
    expectRefused(["--project", repoWithChange], /--sha/);
  });

  test("--project is not a directory", () => {
    expectRefused(
      ["--project", join(FIX, "nope"), "--sha", changeSha],
      /does not exist|not a directory/i,
    );
  });

  test("--project is not a git repository", () => {
    const plain = join(FIX, "plain");
    mkdirSync(plain, { recursive: true });
    expectRefused(["--project", plain, "--sha", changeSha], /REFUSED/);
  });

  test("a ref name is not accepted where a SHA is required", () => {
    // The whole point of AC-2: "HEAD" means "whatever worktree you happen to
    // be in", which is how rook came to review an empty diff.
    expectRefused(["--project", repoWithChange, "--sha", "HEAD"], /not a commit SHA/i);
  });

  test("a too-short SHA is not accepted", () => {
    expectRefused(["--project", repoWithChange, "--sha", "abc123"], /not a commit SHA/i);
  });

  test("a SHA git does not know is refused", () => {
    expectRefused(
      ["--project", repoWithChange, "--sha", "0123456789abcdef0123456789abcdef01234567"],
      /does not know/i,
    );
  });

  test("a base ref with shell metacharacters is refused", () => {
    expectRefused(
      ["--project", repoWithChange, "--sha", changeSha, "--base", "main; rm -rf /"],
      /not a usable ref/i,
    );
  });

  test("a base ref git does not know is refused", () => {
    expectRefused(
      ["--project", repoWithChange, "--sha", changeSha, "--base", "origin/nonexistent"],
      /REFUSED/,
    );
  });

  test("an unknown option is refused rather than ignored", () => {
    expectRefused(
      ["--project", repoWithChange, "--sha", changeSha, "--everything", "yes"],
      /unknown option/i,
    );
  });

  test("a positional argument is refused rather than ignored", () => {
    expectRefused([repoWithChange, changeSha], /unexpected argument/i);
  });
});

// ── The happy path, so the refusals above are not vacuous ────────────────

describe("a real scope is reported", () => {
  test("changed files come back, sorted, with the resolved SHAs", () => {
    const r = run(SCRIPT, ["--project", repoWithChange, "--sha", changeSha, "--base", "main"]);
    expect(r.code, r.err).toBe(0);
    const scope = JSON.parse(r.out);
    expect(scope.files).toEqual(["a.ts", "b.ts"]);
    expect(scope.sha).toBe(changeSha);
    expect(scope.base).toBe(baseSha);
  });

  test("a short SHA resolves to the full one", () => {
    const r = run(SCRIPT, [
      "--project", repoWithChange, "--sha", changeSha.slice(0, 7), "--base", "main",
    ]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).sha).toBe(changeSha);
  });

  test("--out writes the same JSON to disk", () => {
    const out = join(FIX, "scope.json");
    const r = run(SCRIPT, [
      "--project", repoWithChange, "--sha", changeSha, "--base", "main", "--out", out,
    ]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual(JSON.parse(r.out));
  });

  test("the mutant is not simply a script that always exits 0", () => {
    // Guards the guard: if the mutant passed every input it would make every
    // expectRefused assertion above trivially true.
    const r = run(MUTANT, ["--project", repoWithChange, "--sha", changeSha, "--base", "main"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).files).toEqual(["a.ts", "b.ts"]);
  });
});

// ── #171: a re-review is scoped to the remediation, not to the branch ────

/**
 * The second review has to read the remediation, not the whole branch again.
 *
 * `--base origin/main` is the right scope for the FIRST review and the wrong
 * one for every review after it: the remediation round rewrites a handful of
 * files, and re-reviewing the entire branch buries the change rook is being
 * asked to look at a second time. So the re-review passes the commit the
 * previous review was pinned to as `--base`, and this proves the narrowing
 * happened by measuring both answers against the same repository.
 */
describe("#171: --base takes a 40-hex commit SHA and narrows the scope to that diff", () => {
  function scopeOf(args: string[]) {
    const r = run(SCRIPT, ["--project", repoThreeCommits, ...args]);
    expect(r.code, r.err).toBe(0);
    return JSON.parse(r.out) as { sha: string; base: string; files: string[] };
  }

  test("the fixture's base really is a 40-hex commit SHA", () => {
    // Without this the test below could be passing a short SHA, or a ref name,
    // and the AC would be unproven while the assertions stayed green.
    expect(reviewedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(remediationSha).toMatch(/^[0-9a-f]{40}$/);
    expect(reviewedSha).not.toBe(remediationSha);
  });

  test("only the remediation's files come back", () => {
    const scope = scopeOf(["--sha", remediationSha, "--base", reviewedSha]);
    expect(scope.files).toEqual(["c.ts"]);
    expect(scope.base, "the merge base was not resolved from the SHA passed as --base").toBe(
      reviewedSha,
    );
    expect(scope.sha).toBe(remediationSha);
  });

  test("the origin/main fallback would have returned a wider list", () => {
    // The control that makes the test above mean something. If both answers
    // were the same list, "--base narrowed the scope" would be true of a script
    // that ignored --base entirely.
    const wide = scopeOf(["--sha", remediationSha]);
    expect(wide.base, "the default base is no longer origin/main").toBe(originSha);
    expect(wide.files).toEqual(["a.ts", "b.ts", "c.ts"]);

    const narrow = scopeOf(["--sha", remediationSha, "--base", reviewedSha]);
    expect(narrow.files.length, "--base did not narrow anything").toBeLessThan(wide.files.length);
    for (const f of narrow.files) expect(wide.files).toContain(f);
    expect(
      wide.files.filter(f => !narrow.files.includes(f)),
      "the wider list contains nothing the narrow one dropped",
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("an ancestor passed as --base is used as the merge base, not re-derived", () => {
    // merge-base(c1, c3) is c1, so passing the first commit reproduces the
    // fallback's answer. That is the other direction of the same property: the
    // script measures from whatever commit it is given.
    const scope = scopeOf(["--sha", remediationSha, "--base", originSha]);
    expect(scope.base).toBe(originSha);
    expect(scope.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("a base that is a sibling, not an ancestor, still resolves through merge-base", () => {
    // The re-review's base comes back through an agent and may name a commit on
    // a branch that has since diverged. merge-base is what keeps that from
    // producing a diff full of other people's work.
    git(repoThreeCommits, ["checkout", "-q", "-b", "side", originSha]);
    writeFileSync(join(repoThreeCommits, "d.ts"), "export const d = 4\n");
    git(repoThreeCommits, ["add", "-A"]);
    git(repoThreeCommits, ["commit", "-qm", "a divergent commit"]);
    const sideSha = git(repoThreeCommits, ["rev-parse", "HEAD"]);
    git(repoThreeCommits, ["checkout", "-q", "main"]);

    const scope = scopeOf(["--sha", remediationSha, "--base", sideSha]);
    expect(scope.base, "the base was used literally instead of through merge-base").toBe(originSha);
    expect(scope.files, "d.ts leaked into the scope from the divergent branch").toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  test("a re-review whose remediation changed nothing is still refused", () => {
    // The #129 property has to survive the new base: base == sha is an empty
    // diff, and an empty re-review scope is as absent as an empty first one.
    expectRefused(
      ["--project", repoThreeCommits, "--sha", remediationSha, "--base", remediationSha],
      /empty/i,
    );
  });
});
