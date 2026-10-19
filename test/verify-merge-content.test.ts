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
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import {
  ABSENT,
  REFUSE_EXIT,
  divergenceReport,
  entryOf,
  mergeScope,
  parseArgs,
  treeEntries,
  unacceptedDivergences,
  unresolvablePaths,
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

/** One commit touching several paths, for scopes where the ORDER is the subject. */
const commit2 = (root: string, files: [string, string][], msg: string) => {
  for (const [rel, body] of files) write(root, rel, body);
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
  // The mutant runs from a temp directory, so a relative specifier would die
  // on module resolution — exiting non-zero, which reads as the mutation
  // being rejected on the merits.
  //
  // This REFUSED outright until #640 moved `treeEntries` into
  // `lib/tree-entries.ts`, so that the run-branch containment check and this
  // script ask one binding rather than two that agree. The refusal was the
  // right behaviour and it fired exactly as designed; what it cannot do is
  // tell a layering fix from a mistake. So the specifiers are now REWRITTEN
  // to absolute paths against the script's own directory, and anything the
  // rewriter could not resolve still aborts the file — which is the property
  // that matters (`.claude/rules/checks-must-be-able-to-fail.md`: a mutant
  // that dies on module resolution is not a mutant).
  let rewritten = src.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_m, open: string, spec: string, close: string) => `${open}${resolve(dirname(SCRIPT), spec)}${close}`,
  );
  const unresolved = rewritten.match(/from\s+["']\.{1,2}\//g) ?? [];
  if (unresolved.length > 0) {
    throw new Error(
      `could not build the mutant: ${unresolved.length} relative specifier(s) the rewriter could not see`,
    );
  }
  // The waiver filter was written out twice in the first cut — once in the
  // report, once in the CLI — and mutating either left the other deciding,
  // so the row measured 0 red and both copies read as covered. One binding,
  // asserted here rather than left as a convention, because the next person
  // to inline it would see a green suite.
  const waiverFilters = src.match(/!d\.accepted/g) ?? [];
  if (waiverFilters.length !== 1) {
    throw new Error(
      `could not build the mutant: the waiver filter appears ${waiverFilters.length} times, not once — ` +
        `two deciders answering one question are behaviourally one, and no test can tell them apart`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "rg-516-mut-"));
  scratch.push(dir);
  mutant = join(dir, "verify-merge-content.ts");
  rewritten = rewritten.replace(decl, "export const REFUSE_EXIT = 0;");
  writeFileSync(mutant, rewritten);
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
    //
    // The status is asserted, not just the throw. `--is-ancestor` exits 0
    // for an ancestor and 1 for a genuine non-ancestor, but 128 for a bad
    // object — and a bare `catch { isAncestor = false }` reads all three as
    // "not an ancestor". Measured during review: pointing this probe at
    // 0000…0000 left every test green, so the sentence this whole guard's
    // design rests on was being held up by a command that did not run.
    let status: number | null = null;
    try {
      git(root, "merge-base", "--is-ancestor", head, merged);
      status = 0;
    } catch (e) {
      status = (e as { status?: number }).status ?? null;
    }
    expect(status, "`merge-base --is-ancestor` did not run — a broken probe reads as a non-ancestor")
      .toBe(1);
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

  test("a tree lookup reports ABSENT rather than throwing, and carries the mode", () => {
    const { root, head } = repoWithSquashMerge(0);
    const tree = treeEntries(root, head);
    expect(entryOf(tree, "lib/a.ts")).toMatch(/^100644 blob [0-9a-f]{40}$/);
    expect(entryOf(tree, "nope/missing.ts")).toBe(ABSENT);
  });

  test("parseArgs collects repeated --accept and refuses an unknown flag", () => {
    expect(parseArgs(["--accept", "a", "--accept", "b"]).accept).toEqual(["a", "b"]);
    expect(() => parseArgs(["--nope", "x"])).toThrow("unknown option");
    expect(() => parseArgs(["--head"])).toThrow("needs a value");
  });
});

/**
 * Six merges that lost work while the first cut of this guard printed
 * "N file(s) landed as reviewed" and exited 0.
 *
 * Every one was built and measured during the security review of PR #527,
 * and every one is the same failure in a different costume: the guard
 * answering a narrower question than the one it is named after. The happy
 * path was never wrong — which is why none of this was visible from the
 * passing suite above.
 *
 * Each case names the path the old code took to green, because a case whose
 * failure mode is not written down is a case the next refactor satisfies by
 * accident.
 */
describe("#516 review: merges that dropped work and still reported clean", () => {
  /** A repo on `main` with `build(feature, main)` producing head and merged. */
  function repo(
    base: (root: string) => void,
    feature: (root: string) => void,
    landOnMain: (root: string) => void,
  ) {
    const root = mkdtempSync(join(tmpdir(), "rg-516r-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    base(root);
    git(root, "add", "-A");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
    const baseSha = git(root, "rev-parse", "HEAD");

    git(root, "checkout", "-q", "-b", "feature");
    feature(root);
    const head = git(root, "rev-parse", "HEAD");

    git(root, "checkout", "-q", "main");
    landOnMain(root);
    const merged = git(root, "rev-parse", "HEAD");
    return { root, head, merged, base: baseSha };
  }

  test("F1: a dropped file whose name is not ASCII is REFUSED, not compared ABSENT to ABSENT", () => {
    // `git diff --name-only` C-quotes `café.ts` to `"caf\303\251.ts"`,
    // quotes included. Fed back to `rev-parse` that resolves on NEITHER
    // commit, so both sides came back ABSENT and ABSENT === ABSENT. Two
    // files, 100% dropped, `2 file(s) landed as reviewed`, exit 0 — and the
    // count made it read as MORE covered, not less.
    const { root, head, merged, base } = repo(
      r => write(r, "lib/a.ts", "a\n"),
      r => {
        commit(r, "plain.ts", "p\n", "f1 plain");
        write(r, "café.ts", "x\n");
        write(r, "naïve-dir/fix.ts", "y\n");
        git(r, "add", "-A");
        git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "f2 non-ascii");
      },
      r => commit(r, "plain.ts", "p\n", "squash at f1 — the non-ascii commit is dropped"),
    );

    const v = verifyMergeContent(root, head, merged, base);
    expect(v.compared, "the scope was C-quoted, so the paths never resolved")
      .toEqual(["café.ts", "naïve-dir/fix.ts", "plain.ts"]);
    expect(v.divergent.map(d => d.path).sort()).toEqual(["café.ts", "naïve-dir/fix.ts"]);
    for (const d of v.divergent) expect(d.merged, "a dropped file was not reported ABSENT").toBe(ABSENT);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", base], "café.ts");
  });

  test("F2: a dropped `chmod +x` is REFUSED — same bytes, different mode", () => {
    // `rev-parse <commit>:<path>` answers with a blob, so a mode change is
    // invisible to it. In this repo a hook that loses its exec bit is
    // silently inert, which is the quietest possible way for a merge to
    // drop work: the file is there and the content is right.
    const { root, head, merged, base } = repo(
      r => {
        write(r, "hook.sh", "#!/bin/sh\necho hi\n");
        write(r, "lib/a.ts", "a\n");
      },
      r => {
        write(r, "lib/a.ts", "a2\n");
        // On disk as well as in the index: a working tree whose mode
        // disagrees with HEAD makes the later `checkout main` refuse.
        chmodSync(join(r, "hook.sh"), 0o755);
        git(r, "add", "-A");
        git(r, "update-index", "--chmod=+x", "hook.sh");
        git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chmod +x and edit");
      },
      r => commit(r, "lib/a.ts", "a2\n", "squash that lost the chmod"),
    );

    const v = verifyMergeContent(root, head, merged, base);
    expect(v.divergent.map(d => d.path), "the mode-only divergence was not seen").toEqual(["hook.sh"]);
    const d = v.divergent[0];
    expect(d.head.startsWith("100755 "), `head mode was ${d.head}`).toBe(true);
    expect(d.merged.startsWith("100644 "), `merged mode was ${d.merged}`).toBe(true);
    expect(d.head.split(" ")[2], "the OIDs must be equal — mode is the only difference, which is the point")
      .toBe(d.merged.split(" ")[2]);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", base], "hook.sh");
  });

  test("F2b: a symlink that landed as a regular file is REFUSED — identical OID, different type", () => {
    // Sharper than the mode case and identical in shape: a symlink's blob IS
    // the target path, so `link.ts -> lib/a.ts` and a 12-byte regular file
    // reading `lib/a.ts` are the same OID. Only the 120000/100644 distinction
    // separates a working link from a file full of a path.
    const { root, head, merged, base } = repo(
      r => {
        write(r, "lib/a.ts", "a\n");
        write(r, "link.ts", "placeholder\n");
      },
      r => {
        rmSync(join(r, "link.ts"));
        symlinkSync("lib/a.ts", join(r, "link.ts"));
        git(r, "add", "-A");
        git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "make it a symlink");
      },
      r => commit(r, "link.ts", "lib/a.ts", "squash that landed the bytes as a regular file"),
    );

    const v = verifyMergeContent(root, head, merged, base);
    expect(v.divergent.map(d => d.path), "a symlink replaced by a file was not seen").toEqual(["link.ts"]);
    const d = v.divergent[0];
    expect(d.head.split(" ").slice(0, 2).join(" ")).toBe("120000 blob");
    expect(d.merged.split(" ").slice(0, 2).join(" ")).toBe("100644 blob");
    expect(d.head.split(" ")[2], "the blobs must match, or this case is testing the content check")
      .toBe(d.merged.split(" ")[2]);
  });

  test("F3a: work reverted WITHIN the branch and landed anyway is REFUSED", () => {
    // The net diff is `base...head`, so a path the branch changed and then
    // changed back is not in it at all — head equals base there. A squash
    // merge that captures the first commit lands the reverted content on
    // main, and the scope that would have caught it never included the file.
    // This is the reviewer-demanded removal, arriving on main anyway.
    const { root, head, merged, base } = repo(
      r => write(r, "lib/policy.ts", "export const MODE = \"SAFE\";\n"),
      r => {
        commit(r, "lib/policy.ts", "export const MODE = \"DANGEROUS\";\n", "f1 risky");
        commit(r, "lib/other.ts", "o\n", "f2 unrelated");
        commit(r, "lib/policy.ts", "export const MODE = \"SAFE\";\n", "f3 revert, as review asked");
      },
      // Everything else lands correctly. Only the reverted path differs, so
      // the case cannot pass on an unrelated divergence.
      r => commit2(r, [
        ["lib/policy.ts", "export const MODE = \"DANGEROUS\";\n"],
        ["lib/other.ts", "o\n"],
      ], "squash that captured f1 and f2 but not the revert"),
    );

    const { paths } = mergeScope(root, base, head);
    expect(paths.get("lib/policy.ts"), "the reverted path must be in scope via the commit walk")
      .toBe("?");

    const v = verifyMergeContent(root, head, merged, base);
    expect(v.divergent.map(d => d.path), "the reverted-then-landed file was not caught")
      .toEqual(["lib/policy.ts"]);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", base], "lib/policy.ts");
  });

  test("F3b: a half-dropped rename is REFUSED — the legacy file survived on main", () => {
    // `git mv a b` with the addition landing and the deletion not. Rename
    // detection reports only the destination, so the SOURCE was never
    // compared: the merged tree held BOTH files, the guard printed
    // "2 file(s) landed as reviewed", and the legacy module stayed alive.
    // `--no-renames` is what makes this two ordinary records.
    const { root, head, merged, base } = repo(
      r => write(r, "lib/old.ts", "export const v = 1;\n"),
      r => {
        git(r, "mv", "lib/old.ts", "lib/new.ts");
        git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "rename");
      },
      r => commit(r, "lib/new.ts", "export const v = 1;\n", "squash that only applied the addition"),
    );

    expect(treeEntries(root, merged).has("lib/old.ts"), "the fixture must leave the legacy file on main")
      .toBe(true);

    // The STATUSES, not just the paths — and this is the assertion that
    // gives `--no-renames` an input nothing else reaches. Measured: with the
    // flag dropped, the commit walk still puts both halves in scope, so the
    // divergence below is caught anyway and the row came back 0 red. Two
    // deciders holding up one case, which is the fourth shape. What the walk
    // CANNOT supply is the status: a three-field `R100` record desyncs the
    // pair stream, and `unresolvablePaths` reads these letters.
    expect(Object.fromEntries(mergeScope(root, base, head).paths), "the rename was not split in two")
      .toEqual({ "lib/new.ts": "A", "lib/old.ts": "D" });

    const v = verifyMergeContent(root, head, merged, base);
    expect(v.compared, "the deleted half of the rename was dropped from scope")
      .toEqual(["lib/new.ts", "lib/old.ts"]);
    expect(v.divergent.map(d => d.path)).toEqual(["lib/old.ts"]);
    expect(v.divergent[0].head, "the reviewed head deleted it, so head must be ABSENT").toBe(ABSENT);
    bothRefuse(["--project", root, "--head", head, "--merged", merged, "--base", base], "lib/old.ts");
  });

  test("F4: --accept waives ONE path and the count says so — the filter is one binding", () => {
    // Measured at 0 red: replacing `divergent.filter(d => !d.accepted)` with
    // `divergent` left every test green, because the only assertion was
    // `toContain("lib/b.ts")` and that is true of both. The mutant reports
    // `2 of 2` and lists the waived path as a failure. So the count and the
    // ABSENCE of the accepted path are what this asserts.
    const { root, head, merged, base } = repoWithSquashMerge(2);
    const v = verifyMergeContent(root, head, merged, base, ["lib/a.ts"], "deliberate");
    expect(v.divergent.map(d => d.path).sort()).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(unacceptedDivergences(v).map(d => d.path), "the waiver did not remove the path")
      .toEqual(["lib/b.ts"]);

    const report = divergenceReport(v);
    expect(report, "the waived path was counted as a failure").toContain("1 of 2 reviewed file(s)");
    expect(report, "the waived path was listed as a failure").not.toContain("lib/a.ts");
    expect(report).toContain("lib/b.ts");
  });

  test("F6: --out writes the record for a refusal that THROWS, not only for a verdict", () => {
    // The comment said "written whatever the verdict". It was false for
    // every refusal raised before a verdict exists — empty scope, a bad SHA,
    // --accept without --reason — all of which left no artefact at all. The
    // refused run is exactly the run whose record somebody wants later.
    const { root, head, merged, base } = repoWithSquashMerge(1);
    const dir = mkdtempSync(join(tmpdir(), "rg-516-out-"));
    scratch.push(dir);

    const thrown = join(dir, "thrown.json");
    const bad = run(SCRIPT, ["--project", root, "--head", head, "--merged", merged, "--base", head,
      "--out", thrown]);
    expect(bad.code, "the empty-scope refusal did not fire").toBe(REFUSE_EXIT);
    expect(JSON.parse(readFileSync(thrown, "utf-8")).refused, "no artefact was written for a thrown refusal")
      .toContain("touches no files");

    const landed = join(dir, "verdict.json");
    const ok = run(SCRIPT, ["--project", root, "--head", head, "--merged", merged, "--base", base,
      "--out", landed]);
    expect(ok.code).toBe(REFUSE_EXIT);
    expect(JSON.parse(readFileSync(landed, "utf-8")).divergent.map((d: { path: string }) => d.path))
      .toEqual(["lib/a.ts"]);
  });

  test("F7: comparing a commit with itself is REFUSED, and so is a SHA that resolves to nothing", () => {
    // A tree compared against itself cannot diverge, so it reports success
    // for any argument at all. A well-formed SHA that resolves to nothing is
    // the same hole one step further: every lookup is ABSENT on both sides,
    // and ABSENT matches ABSENT.
    const { root, head, merged, base } = repoWithSquashMerge(1);
    bothRefuse(["--project", root, "--head", head, "--merged", head, "--base", base],
      "are the same commit");
    bothRefuse(["--project", root, "--head", head, "--merged", "0".repeat(40), "--base", base],
      "does not resolve to a commit");
    // The control: the same arguments with two real, different commits pass
    // through both refusals and reach the comparison.
    expect(verifyMergeContent(root, head, merged, base).compared.length).toBeGreaterThan(0);
  });

  test("F8: a `multiple merge bases` warning reaches the verdict instead of being dropped", () => {
    // git prints this to stderr and exits 0, and the first cut piped stderr
    // and discarded it on success. It means the scope was computed against
    // an ARBITRARY choice of base, so the one reader who could act on it —
    // whoever reads the artefact — was the one guaranteed never to see it.
    //
    // A criss-cross history is how two merge bases happen: two branches off
    // a common commit, each merging the other's ORIGINAL tip. Merging the
    // branch NAME instead collapses it to one base, because by then the
    // other side has already absorbed this one.
    const root = mkdtempSync(join(tmpdir(), "rg-516x-"));
    scratch.push(root);
    git(root, "init", "-q", "-b", "main");
    commit(root, "a.ts", "a\n", "root");
    git(root, "checkout", "-q", "-b", "x");
    const x1 = commit(root, "x.ts", "x\n", "x1");
    git(root, "checkout", "-q", "main");
    git(root, "checkout", "-q", "-b", "y");
    const y1 = commit(root, "y.ts", "y\n", "y1");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", "-m", "y+x1", x1);
    const crossBase = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "x");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", "-m", "x+y1", y1);
    const head = commit(root, "late.ts", "l\n", "head past the criss-cross");
    git(root, "checkout", "-q", "main");
    const merged = commit(root, "late.ts", "l\n", "landed");

    const v = verifyMergeContent(root, head, merged, crossBase);
    expect(v.warnings.join("\n"), "git's ambiguity warning was discarded")
      .toContain("multiple merge bases");

    // The control: an unambiguous history warns about nothing, so the key is
    // reporting what git said rather than always carrying text.
    const clean = repoWithSquashMerge(1);
    expect(verifyMergeContent(clean.root, clean.head, clean.merged, clean.base).warnings).toEqual([]);
  });

  test("F9: the scope is sorted, which the commit walk makes a real question", () => {
    // git emits the net diff in tree order and the commit walk appends to
    // it, so a path only the walk can see arrives LAST however it sorts.
    // Here `aaa.ts` is reverted within the branch and `zzz.ts` is not, which
    // puts insertion order and sorted order in opposite directions. An
    // artefact nobody can diff against the previous run is one nobody reads.
    const { root, head, merged, base } = repo(
      r => write(r, "aaa.ts", "1\n"),
      r => {
        commit(r, "aaa.ts", "2\n", "f1 change aaa");
        commit(r, "zzz.ts", "z\n", "f2 add zzz");
        commit(r, "aaa.ts", "1\n", "f3 revert aaa");
      },
      r => commit2(r, [["aaa.ts", "2\n"], ["zzz.ts", "z\n"]], "squash at f2"),
    );
    const v = verifyMergeContent(root, head, merged, base);
    expect(v.compared, "insertion order is zzz-then-aaa; sorted is the other way")
      .toEqual(["aaa.ts", "zzz.ts"]);
    expect(v.divergent.map(d => d.path)).toEqual(["aaa.ts"]);
  });

  test("the unresolvable-path guard refuses a lookup failure, which compares equal to itself", () => {
    // Given directly rather than through a repository, because with `-z` in
    // place no git fixture reaches it — and a row that cannot fail measures
    // nothing. A path the diff calls MODIFIED that the head tree does not
    // hold is a failed lookup, and two failed lookups agree.
    const headTree = new Map([["kept.ts", "100644 blob aaaa"]]);
    expect(unresolvablePaths(new Map([["kept.ts", "M"]]), headTree)).toEqual([]);
    expect(unresolvablePaths(new Map([["gone.ts", "M"]]), headTree), "a modified path missing at head is a failed lookup")
      .toEqual(["gone.ts"]);
    expect(unresolvablePaths(new Map([["added.ts", "A"]]), headTree)).toEqual(["added.ts"]);
    // A DELETED path is legitimately absent at head, and a path only the
    // commit walk saw has no status to contradict. Neither is a failure.
    expect(unresolvablePaths(new Map([["gone.ts", "D"]]), headTree), "a deletion must not be read as a lookup failure")
      .toEqual([]);
    expect(unresolvablePaths(new Map([["gone.ts", "?"]]), headTree)).toEqual([]);
  });
});
