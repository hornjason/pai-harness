/**
 * Covers SC-1917..SC-1921 (HARNESS-STANDARD.md), #471.
 *
 * `node_modules/` with a trailing slash does not match a SYMLINK named
 * `node_modules`, so `git add .` tracks it and the commit carries a mode
 * `120000` blob whose content is a machine-absolute path. Reported from a
 * consumer repo with two such entries, against a `.gitignore` that named
 * both correctly.
 *
 * `git status` was clean throughout. That is the whole problem, and it is
 * why SC-1920 asserts the detector never consults it.
 *
 * The fixtures are real repositories, built with the same two commands that
 * produced the report — `ln -s` and `git add .` — because the behaviour
 * under test belongs to git's ignore matching and a fixture that asserted
 * the parser would prove nothing about it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describeFindings, trackedAndIgnored } from "../lib/tracked-vs-ignored";

const REPO_ROOT = join(import.meta.dir, "..");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout ?? "";
}

/** A repository with a `.gitignore` and one commit's worth of ordinary files. */
function repo(ignore: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rg-471-")));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  writeFileSync(join(root, ".gitignore"), ignore);
  writeFileSync(join(root, "index.ts"), "export const x = 1;\n");
  return root;
}

describe("#471: a path cannot be both tracked and ignored", () => {
  test("SC-1917: a symlink a trailing-slash rule failed to match is caught", () => {
    // The reported case, reproduced by its own mechanism rather than
    // described: the rule names the path, the rule is correct, and the rule
    // does not match a link.
    const root = repo("node_modules/\n");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "rg-471-deps-")));
    roots.push(elsewhere);
    symlinkSync(elsewhere, join(root, "node_modules"));
    git(root, ["add", "."]);

    // The instrument, and the reason this is not visible in review: git
    // agrees that everything is fine.
    expect(git(root, ["status", "--porcelain"]).includes("??"), "the fixture left something untracked").toBe(false);

    // The SECOND instrument, and the reason the detector has two findings
    // rather than the one this was filed as. `check-ignore` does not match
    // the symlink either, so the tracked-and-ignored comparison on its own
    // reports nothing about the case that produced the issue.
    const askedDirectly = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd: root,
      input: "node_modules\0",
      encoding: "utf-8",
    });
    expect(askedDirectly.stdout, "check-ignore now matches the link, so the second finding is moot").toBe("");

    const reading = trackedAndIgnored(root);
    expect(reading.failure).toBeNull();
    const found = reading.findings.find(f => f.path === "node_modules");
    expect(found, "the tracked symlink was not caught").toBeDefined();
    expect(found?.reasons).toEqual(["absolute-symlink"]);

    // And a nested one, which is the second entry the report carried and the
    // case a rule anchored at the repository root would miss.
    mkdirSync(join(root, "dashboard"));
    symlinkSync(elsewhere, join(root, "dashboard", "node_modules"));
    git(root, ["add", "."]);
    expect(trackedAndIgnored(root).findings.map(f => f.path)).toContain("dashboard/node_modules");

    // A RELATIVE link is a repository making a statement about itself, and
    // it survives a clone. Without this the finding is "tracked symlink",
    // which is a different and much blunter rule.
    const portable = repo("\n");
    mkdirSync(join(portable, "pkg"));
    writeFileSync(join(portable, "pkg", "real.ts"), "export const y = 2;\n");
    symlinkSync(join("..", "pkg", "real.ts"), join(portable, "link.ts"));
    git(portable, ["add", "."]);
    expect(trackedAndIgnored(portable).findings, "a relative link was refused").toEqual([]);
  });

  test("SC-1918: the mode and the link target are reported, not just the path", () => {
    const root = repo("node_modules/\n");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "rg-471-deps2-")));
    roots.push(elsewhere);
    symlinkSync(elsewhere, join(root, "node_modules"));
    git(root, ["add", "."]);

    const found = trackedAndIgnored(root).findings.find(f => f.path === "node_modules");
    expect(found?.mode, "a tracked symlink read as an ordinary file").toBe("120000");
    // The content IS the host path. A directory of tracked files is
    // wasteful; a tracked link is what breaks on another machine, and the
    // mode is the only thing that tells them apart.
    expect(found?.linkTarget).toBe(elsewhere);
    expect(describeFindings(trackedAndIgnored(root)).join("\n")).toContain(`symlink -> ${elsewhere}`);

    // A tracked ordinary file that is also ignored is still a finding, and
    // it carries no link target rather than an empty-string one.
    const plain = repo("secrets.env\n");
    writeFileSync(join(plain, "secrets.env"), "k=v\n");
    git(plain, ["add", "-f", "secrets.env"]);
    const other = trackedAndIgnored(plain).findings.find(f => f.path === "secrets.env");
    expect(other?.mode).toBe("100644");
    expect(other?.linkTarget).toBeNull();
    expect(other?.reasons).toEqual(["tracked-and-ignored"]);
  });

  test("SC-1919: a repo whose rules and tracked set agree passes, over a non-empty corpus", () => {
    const root = repo("node_modules/\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.js"), "// dep\n");
    git(root, ["add", "."]);

    const reading = trackedAndIgnored(root);
    expect(reading.findings, "a clean repo was reported as contradictory").toHaveLength(0);
    // An empty corpus and a clean one are the same verdict, and this is the
    // only thing that separates them. Without it, a detector that stopped
    // listing anything would read exactly like a repository in good order.
    expect(reading.trackedCount, "nothing was compared, so the pass means nothing").toBeGreaterThan(1);
    expect(reading.failure).toBeNull();

    // The live tree, which is the corpus this check actually guards.
    const live = trackedAndIgnored(REPO_ROOT);
    expect(live.failure).toBeNull();
    expect(live.trackedCount, "the live tracked set came back empty").toBeGreaterThan(100);
    expect(describeFindings(live), "this repository tracks a path it should not track that way").toEqual([]);
  });

  test("SC-1920: it never asks git status, and a broken comparison is UNMEASURED", () => {
    // `git status` was clean in the reported case, so a detector that
    // consults it cannot see this class at all. Asserted against the source
    // because the absence of a call is not observable from the outside.
    const source = readFileSync(join(REPO_ROOT, "lib", "tracked-vs-ignored.ts"), "utf-8");
    const calls = [...source.matchAll(/run\(\s*root,\s*\[\s*"([a-z-]+)"/g)].map(m => m[1]);
    expect(calls.length, "the source stopped making any git calls, so this asserts nothing").toBeGreaterThan(1);
    expect(calls, "the detector consults git status, which is clean in exactly this case").not.toContain("status");

    // A comparison that could not be MADE is also a failure. `git ls-files`
    // succeeds here and `git check-ignore` exits 128, which is the exact
    // gap a `catch { return [] }` would turn into a clean bill of health —
    // the first shape in checks-must-be-able-to-fail.md.
    const broken = repo("node_modules/\n");
    mkdirSync(join(broken, "excl-dir"));
    git(broken, ["add", "."]);
    git(broken, ["config", "core.excludesFile", join(broken, "excl-dir")]);
    const brokenReading = trackedAndIgnored(broken);
    expect(brokenReading.failure, "a check-ignore that could not run reported nothing wrong").not.toBeNull();
    expect(brokenReading.failure).toContain("check-ignore");
    expect(brokenReading.trackedCount, "the tracked set it DID read is thrown away").toBeGreaterThan(0);

    // A directory that is not a repository is a failure, not a clean repo.
    // The same conflation as the bug, arriving in the detector.
    const notARepo = mkdtempSync(join(tmpdir(), "rg-471-bare-"));
    roots.push(notARepo);
    const reading = trackedAndIgnored(notARepo);
    expect(reading.failure, "an unusable repository reported a clean bill of health").not.toBeNull();
    expect(reading.findings).toHaveLength(0);
    expect(describeFindings(reading)[0]).toContain("UNMEASURED");
  });

  test("SC-1921: check-ignore is asked with --no-index, or it answers about the wrong set", () => {
    // `git check-ignore` SKIPS files in the index unless `--no-index`, so
    // without the flag it is asked about tracked paths and reports on
    // untracked ones: the comparison becomes a list against the empty set
    // and that arm can never fire. Measured rather than asserted on the
    // source, because the flag's effect is the whole of the first finding.
    const root = repo("secrets.env\n");
    writeFileSync(join(root, "secrets.env"), "k=v\n");
    git(root, ["add", "-f", "secrets.env", ".gitignore", "index.ts"]);

    const withoutFlag = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      input: "secrets.env\0",
      encoding: "utf-8",
    });
    expect(withoutFlag.stdout, "check-ignore no longer skips the index, so this case is moot").toBe("");

    const withFlag = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: root,
      input: "secrets.env\0",
      encoding: "utf-8",
    });
    expect(withFlag.stdout.replace(/\0/g, "")).toBe("secrets.env");
    expect(trackedAndIgnored(root).findings.map(f => f.path)).toContain("secrets.env");
  });
});
