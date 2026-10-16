/**
 * #516: a squash merge can land a PR at a commit behind its head, and until
 * now nothing compared content afterwards.
 *
 * Covers the guard in `scripts/verify-merge-content.ts`.
 *
 * ## What is being proved, and how
 *
 * The fixture is a real git repository with a real squash merge that drops a
 * real commit — not a hand-written pair of SHAs. That matters because the
 * defect is a property of how squash merges interact with ancestry, and a
 * fixture that describes the situation rather than reproducing it would be
 * asserting that the script can compare two strings.
 *
 * Every negative case runs TWICE: against the real script, and against a
 * mutant copy whose `REFUSE_EXIT` is `0`. Real must refuse and mutant must
 * not. The second assertion is the point — it is the removal of the non-zero
 * exit, performed and observed, so a case that later starts passing for an
 * unrelated reason stops being indistinguishable from one genuinely caught
 * (`.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job is
 * to exit non-zero").
 *
 * **What catches what, measured rather than assumed.** The worked example in
 * that rule reports a renamed constant as `could not build the mutant`. Here
 * it does not, and the difference is worth stating so nobody credits the
 * builder with a guard it does not supply: this file IMPORTS `REFUSE_EXIT`,
 * so a rename is a module-resolution error before `beforeAll` runs. The
 * three checks in the builder are live and were each measured by mutation —
 * a second declaration of the constant, a refusal written as a literal
 * `process.exit(1)`, and a relative import each abort the file by name.
 *
 * ## The ancestry control
 *
 * `git merge-base --is-ancestor` is the check a reader reaches for first, and
 * it does not work. The "clean" case below asserts that the reviewed head is
 * NOT an ancestor of the merge commit even when every byte landed — which is
 * true of every squash merge this repo makes. A guard built on ancestry would
 * fire on the normal case; this records why this one is built on blobs.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  ABSENT,
  REFUSE_EXIT,
  blobAt,
  divergenceReport,
  parseArgs,
  verifyMergeContent,
} from "../scripts/verify-merge-content";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "verify-merge-content.ts");
const scratch: string[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();

const write = (root: string, rel: string, body: string) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

const commit = (root: string, rel: string, body: string, msg: string) => {
  write(root, rel, body);
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD");
};

/**
 * A repo whose `feature` branch has three commits, squash-merged at the
 * commit `stopAt` steps behind the head. `stopAt = 0` is a correct merge.
 *
 * This is #500's shape exactly: the merge is made from a commit that is not
 * the head, so the later commits' content never reaches main while every
 * ancestry question still answers "merged".
 */
function repoWithSquashMerge(stopAt: number) {
  const root = mkdtempSync(join(tmpdir(), "rg-516-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  commit(root, "lib/a.ts", "export const a = 1;\n", "base");
  commit(root, "README.md", "# r\n", "base 2");
  const mainBase = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "feature");
  const c1 = commit(root, "lib/a.ts", "export const a = 2;\n", "feature 1");
  const c2 = commit(root, "lib/b.ts", "export const b = 1;\n", "feature 2");
  const c3 = commit(root, "lib/a.ts", "export const a = 3; // the reviewed fix\n", "feature 3");
  const head = git(root, "rev-parse", "HEAD");
  const landAt = [c3, c2, c1][stopAt];

  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--squash", landAt);
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `squash of feature@${stopAt} behind`);
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "feature");
  git(root, "checkout", "-q", "main");

  return { root, head, merged, base: mainBase, c1, c2, c3 };
}

/** A copy of the script with `REFUSE_EXIT` set to 0, in its own directory. */
let mutant = "";
beforeAll(() => {
  const src = readFileSync(SCRIPT, "utf-8");
  const decl = "export const REFUSE_EXIT = 1;";
  const hits = src.split(decl).length - 1;
  if (hits !== 1) {
    throw new Error(`could not build the mutant: the exit constant appears ${hits} times, not once`);
  }
  // A literal `process.exit(1)` would bypass the mutation entirely and leave
  // every negative case below passing for a reason unrelated to the guard.
  const literalExits = src.match(/process\.exit\(\s*[0-9]/g) ?? [];
  if (literalExits.length > 0) {
    throw new Error(`could not build the mutant: ${literalExits.length} refusal(s) exit with a literal code`);
  }
  // The mutant runs from a temp directory; a relative import would die on
  // module resolution, exiting non-zero, which reads as the mutation being
  // rejected on the merits.
  const relative = src.match(/^\s*import\s[^;]*?from\s+["']\.{1,2}\//gm) ?? [];
  if (relative.length > 0) {
    throw new Error(`could not build the mutant: ${relative.length} relative import(s)`);
  }
  const dir = mkdtempSync(join(tmpdir(), "rg-516-mut-"));
  scratch.push(dir);
  mutant = join(dir, "verify-merge-content.ts");
  writeFileSync(mutant, src.replace(decl, "export const REFUSE_EXIT = 0;"));
});

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const run = (script: string, args: string[]) => {
  const r = Bun.spawnSync(["bun", script, ...args], { cwd: ROOT });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
};

/** Both halves of a negative case: the real script and the mutant. */
function bothRefuse(args: string[], expectText: string) {
  const real = run(SCRIPT, args);
  expect(real.code, `the real script did not refuse:\n${real.err}`).toBe(REFUSE_EXIT);
  expect(real.err).toContain(expectText);
  const mut = run(mutant, args);
  expect(mut.code, `the mutant refused too, so the exit is not routed through REFUSE_EXIT:\n${mut.err}`)
    .toBe(0);
}

describe("#516: a merge is verified by content, because ancestry cannot see a dropped commit", () => {
  test("a squash merge one commit behind the head is REFUSED, and the file is named", () => {
    const { root, head, merged, base } = repoWithSquashMerge(1);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", base], "lib/a.ts");
  });

  test("the refusal says which blob was reviewed and which one landed", () => {
    const { root, head, merged, base } = repoWithSquashMerge(1);
    const v = verifyMergeContent(root, head, merged, base);
    expect(v.divergent.map(d => d.path), "the dropped file was not reported").toEqual(["lib/a.ts"]);
    const d = v.divergent[0];
    expect(d.head, "the reviewed blob was not recorded").not.toBe(ABSENT);
    expect(d.merged, "the merged blob was not recorded").not.toBe(ABSENT);
    expect(d.head).not.toBe(d.merged);
    expect(divergenceReport(v)).toContain("1 of 2 reviewed file(s) did not land");
  });

  test("a merge TWO commits behind loses a whole file, and ABSENT is reported as such", () => {
    // `lib/b.ts` exists only from the second commit, so a merge made at the
    // first never has it. "The merge dropped the commit that created this
    // file" and "the content differs" are the same defect and must both be
    // caught — an ABSENT that read as a comparison error would be silence.
    const { root, head, merged, base } = repoWithSquashMerge(2);
    const v = verifyMergeContent(root, head, merged, base);
    expect(v.divergent.map(d => d.path).sort()).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(v.divergent.find(d => d.path === "lib/b.ts")!.merged, "a missing file was not ABSENT")
      .toBe(ABSENT);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", base], "lib/b.ts");
  });

  test("a CORRECT squash merge passes — and is not an ancestor, which is the whole point", () => {
    // The control, in two parts. Without the first, every case above is
    // satisfied by a check that refuses everything.
    const { root, head, merged, base } = repoWithSquashMerge(0);
    const r = run(SCRIPT, ["--project", root, "--head", head, "--merged", merged, "--base", base]);
    expect(r.code, `a correct merge was refused:\n${r.err}`).toBe(0);
    expect(JSON.parse(r.out).divergent, "a correct merge reported divergence").toEqual([]);

    // The second part is why this guard compares blobs. The reviewed head is
    // NOT an ancestor of the merge commit even though every byte landed, so
    // an ancestry-based guard would fire HERE — on the normal case, on every
    // squash merge this repo makes.
    let isAncestor = true;
    try {
      git(root, "merge-base", "--is-ancestor", head, merged);
    } catch {
      isAncestor = false;
    }
    expect(isAncestor, "squash merges preserved ancestry, so this guard's premise is wrong")
      .toBe(false);
  });

  test("an override must be justified, and the reason is recorded", () => {
    const { root, head, merged, base } = repoWithSquashMerge(1);
    // Unexplained: refused. A waiver nobody has to justify is a warning.
    bothRefuse(
      ["--project", root, "--head", head, "--merged", merged, "--base", base, "--accept", "lib/a.ts"],
      "without --reason",
    );
    // Explained: allowed, and the reason survives into the artefact.
    const ok = run(SCRIPT, [
      "--project", root, "--head", head, "--merged", merged, "--base", base,
      "--accept", "lib/a.ts", "--reason", "conflict resolved by hand during merge",
    ]);
    expect(ok.code, `an explained override was still refused:\n${ok.err}`).toBe(0);
    const v = JSON.parse(ok.out);
    expect(v.acceptedReason).toBe("conflict resolved by hand during merge");
    expect(v.divergent[0].accepted, "the waived path was not marked accepted").toBe(true);
  });

  test("accepting ONE path does not waive another", () => {
    // The override is per-path, asserted rather than assumed: a waiver that
    // quietly covers everything is the same silence in a different costume.
    const { root, head, merged, base } = repoWithSquashMerge(2);
    bothRefuse(
      ["--project", root, "--head", head, "--merged", merged, "--base", base,
        "--accept", "lib/a.ts", "--reason", "deliberate"],
      "lib/b.ts",
    );
  });

  test("an empty scope is REFUSED, not reported as a clean merge", () => {
    // `base...head` touching nothing compares nothing, and a comparison of
    // nothing succeeds for every merge there has ever been. This is the
    // vacuous-assertion shape, and it is the way this guard would most
    // plausibly go quietly wrong.
    const { root, head, merged } = repoWithSquashMerge(0);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", head], "touches no files");
  });

  test("a ref is refused where a SHA is required", () => {
    const { root, merged, base } = repoWithSquashMerge(0);
    bothRefuse(["--project", root, "--head", "HEAD", "--merged", merged, "--base", base], "is not a commit SHA");
  });

  test("blobAt reports ABSENT rather than throwing, and the value is comparable", () => {
    const { root, head } = repoWithSquashMerge(0);
    expect(blobAt(root, head, "lib/a.ts")).toMatch(/^[0-9a-f]{40}$/);
    expect(blobAt(root, head, "nope/missing.ts")).toBe(ABSENT);
  });

  test("parseArgs collects repeated --accept and refuses an unknown flag", () => {
    expect(parseArgs(["--accept", "a", "--accept", "b"]).accept).toEqual(["a", "b"]);
    expect(() => parseArgs(["--nope", "x"])).toThrow("unknown option");
    expect(() => parseArgs(["--head"])).toThrow("needs a value");
  });
});
