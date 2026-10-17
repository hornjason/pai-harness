/**
 * Covers SC-1884..SC-1888 (HARNESS-STANDARD.md), #549.
 *
 * `bunx rungate scaffold .` could not run on rungate. The rehearsal cloned
 * the whole tree and applied `REHEARSAL_EXCLUDES` afterwards, so 737 MB
 * across 104 worktrees was copied and then handed to a recursive `rm` that
 * died with `EFAULT: bad address in system call argument`. The exclude list
 * was right; the ORDERING defeated it.
 *
 * **"The excluded path is absent from the clone" is true under BOTH
 * orderings**, which the issue said out loud and which is the only reason
 * these cases are shaped the way they are. Absence cannot witness the fix.
 * Two things can:
 *
 *  - an excluded directory that CANNOT BE READ — copy-then-prune fails on
 *    it, copy-excluding never opens it;
 *  - the list of `cp` invocations, recorded through an injected runner, so
 *    "no work proportional to the excluded directory" is measured rather
 *    than asserted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync,
  existsSync, symlinkSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  cloneForRehearsal, copyTreeExcluding, discardRehearsal, REHEARSAL_EXCLUDES,
} from "../lib/scaffold/rehearsal";
import { generateScopedRules } from "../lib/generators/agents-md";
import { scanProject } from "../lib/scanner";

const roots: string[] = [];
const unlock: string[] = [];
afterAll(() => {
  for (const d of unlock) { try { chmodSync(d, 0o700); } catch { /* gone */ } }
  for (const r of roots) {
    spawnSync("chflags", ["-R", "nouchg,noschg", r]);
    rmSync(r, { recursive: true, force: true });
  }
});

function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `rehearsal-549-${name}-`));
  roots.push(d);
  return d;
}

/** A minimal tree the rehearsal will accept, plus whatever the case adds. */
function project(name: string): string {
  const root = scratch(name);
  writeFileSync(join(root, "README.md"), "# r\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

describe("#549: an excluded path is never read, not merely absent afterwards", () => {
  test("SC-1884: a clone succeeds over an excluded directory that cannot be opened", () => {
    // The differential. A directory at mode 000 is a directory `cp -R`
    // cannot copy — it exits non-zero — so copy-then-prune turns this tree
    // into `audit did NOT run: the tree could not be copied`, while
    // copy-excluding never opens it. The fixture is unreadable rather than
    // merely large because a size difference is a timing assertion and a
    // permission difference is a verdict.
    const root = project("unreadable");
    mkdirSync(join(root, ".claude", "worktrees", "wt-1"), { recursive: true });
    writeFileSync(join(root, ".claude", "worktrees", "wt-1", "big.txt"), "x".repeat(1024));
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
    chmodSync(join(root, ".claude", "worktrees"), 0o000);
    unlock.push(join(root, ".claude", "worktrees"));

    const r = cloneForRehearsal(root);
    roots.push(r.parent);
    // `.claude` itself is still there — only its excluded child is gone.
    expect(readdirSync(join(r.dir, ".claude")), "the exclude took its parent with it")
      .toEqual(["settings.json"]);
    expect(existsSync(join(r.dir, ".claude", "worktrees"))).toBe(false);
    expect(readdirSync(r.dir).sort()).toEqual([".claude", "README.md", "src"]);

    // The INSTRUMENT, and without it the row above passes on a tree whose
    // chmod silently did nothing: the same unreadable directory in a place
    // the exclude list does not name must refuse the clone.
    const other = project("unreadable-control");
    mkdirSync(join(other, "secrets"), { recursive: true });
    writeFileSync(join(other, "secrets", "x.txt"), "x\n");
    chmodSync(join(other, "secrets"), 0o000);
    unlock.push(join(other, "secrets"));
    expect(() => cloneForRehearsal(other), "mode 000 did not stop the copy, so the fixture proves nothing")
      .toThrow(/could not be copied/);
  });

  test("SC-1884: a destination the first attempt could not empty is a refusal, not a throw", () => {
    // Found on Linux CI, where the control above threw `EACCES: permission
    // denied, rm` instead of the refusal. `cp -Rc` fails over an unreadable
    // directory, the `-R` retry clears the destination first, and what the
    // first attempt left behind is an unreadable directory `rmSync` cannot
    // list. The throw escapes `cloneForRehearsal` entirely — the SAME defect
    // as the one `discardRehearsal` fixes, one function earlier, and the
    // reason both now go through one removal.
    //
    // Driven directly rather than through `cp`, so it does not depend on
    // what a platform's `cp` leaves behind after it fails.
    const src = project("stale-dst");
    const dst = join(scratch("stale-dst-dst"), "tree");
    mkdirSync(join(dst, "leftover"), { recursive: true });
    writeFileSync(join(dst, "leftover", "f.txt"), "x\n");
    chmodSync(join(dst, "leftover"), 0o000);
    unlock.push(join(dst, "leftover"));

    // The instrument: the destination really is one a plain recursive delete
    // refuses, or this is asserting against an ordinary empty directory.
    expect(() => rmSync(dst, { recursive: true, force: true }),
      "the leftover was removable anyway, so the fixture cannot witness the fix").toThrow();

    expect(copyTreeExcluding(src, dst, REHEARSAL_EXCLUDES, "-R", 10_000)).toBe(0);
    expect(readdirSync(dst).sort(), "the stale destination was copied into rather than replaced")
      .toEqual(["README.md", "src"]);
  });

  test("SC-1885: no copy is issued for anything under an excluded path", () => {
    // The cost half, measured. "Independent of the size of the excluded
    // directory" is a timing claim and timing is a flaky assertion; the
    // thing underneath it is that no WORK is issued, and the invocation
    // list says so exactly.
    const root = project("invocations");
    mkdirSync(join(root, ".claude", "worktrees", "a", "b"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(root, ".claude", "worktrees", "a", "b", `f${i}`), "x");
      writeFileSync(join(root, "node_modules", "pkg", `f${i}`), "x");
    }

    const dst = join(scratch("invocations-dst"), "tree");
    const calls: string[][] = [];
    const status = copyTreeExcluding(root, dst, REHEARSAL_EXCLUDES, "-R", 10_000,
      args => { calls.push(args); return 0; });
    expect(status).toBe(0);

    const sources = calls.map(a => a[1]!);
    expect(
      sources.filter(s => s.includes("worktrees") || s.includes("node_modules")),
      "work was issued for a path the clone excludes",
    ).toEqual([]);
    // One `cp` per surviving entry and not one more — the exclude's PARENT
    // is walked, so `.claude` costs a walk plus one copy of its one child,
    // not a copy of `.claude` entire.
    expect(sources.map(s => s.slice(root.length + 1)).sort())
      .toEqual([".claude/settings.json", "README.md", "src"]);

    // Adding a thousand more files under the exclude must not change that
    // list. This is the independence claim, driven rather than reasoned.
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(root, ".claude", "worktrees", "a", "b", `g${i}`), "x");
    }
    const after: string[][] = [];
    copyTreeExcluding(root, dst, REHEARSAL_EXCLUDES, "-R", 10_000,
      args => { after.push(args); return 0; });
    expect(after).toEqual(calls);
  });

  test("SC-1889: a directory the walk creates keeps the mode it had", () => {
    // Only the ancestors of an exclude are created by `mkdirSync` rather
    // than by `cp`, and `mkdirSync` uses the process umask. So a `.claude`
    // at 0o700 silently became 0o755 in the clone, and a step that reads
    // permissions would have reported on a tree that is not the
    // consumer's — which is the one thing a rehearsal may never do.
    // Measured: removing the chmod is 0 red without this case.
    const root = project("modes");
    mkdirSync(join(root, ".claude", "worktrees"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
    chmodSync(join(root, ".claude"), 0o700);

    const dst = join(scratch("modes-dst"), "tree");
    copyTreeExcluding(root, dst, REHEARSAL_EXCLUDES, "-R", 10_000);
    expect(lstatSync(join(dst, ".claude")).mode & 0o777, "the walked directory was created with the umask")
      .toBe(0o700);

    // The control: a directory `cp` copies whole was never at risk, and
    // saying so keeps the row pointed at the branch it is about.
    chmodSync(join(root, "src"), 0o750);
    const dst2 = join(scratch("modes-dst-2"), "tree");
    copyTreeExcluding(root, dst2, REHEARSAL_EXCLUDES, "-R", 10_000);
    expect(lstatSync(join(dst2, "src")).mode & 0o777).toBe(0o750);
  });

  test("SC-1886: a symlinked ancestor of an exclude is copied as a link, never walked", () => {
    // `.claude -> /real/.claude` while excluding `.claude/worktrees`. The
    // old code's answer was "prune nothing and let `escapingSymlinks`
    // refuse", because `rmSync(..., { recursive: true })` follows a
    // symlinked parent and would have deleted the consumer's real
    // worktrees. The copy side has to reach the same answer for the same
    // reason: descending would READ the consumer's tree, and the clone
    // would stop being a clone.
    const root = project("ancestor-link");
    const real = scratch("ancestor-link-real");
    mkdirSync(join(real, "worktrees", "wt-1"), { recursive: true });
    writeFileSync(join(real, "worktrees", "wt-1", "keep.txt"), "keep\n");
    writeFileSync(join(real, "settings.json"), "{}\n");
    symlinkSync(real, join(root, ".claude"));

    const dst = join(scratch("ancestor-link-dst"), "tree");
    copyTreeExcluding(root, dst, REHEARSAL_EXCLUDES, "-R", 10_000);

    expect(lstatSync(join(dst, ".claude")).isSymbolicLink(), "the link was followed and the tree flattened")
      .toBe(true);
    expect(readlinkSync(join(dst, ".claude"))).toBe(real);
    // The real tree is untouched — nothing was read into the clone and
    // nothing was deleted out of it.
    expect(existsSync(join(real, "worktrees", "wt-1", "keep.txt"))).toBe(true);

    // And the clone is then REFUSED, because an ancestor pointing out of it
    // is exactly what `escapingSymlinks` is for. Without this the row above
    // is satisfied by a copier that quietly previews someone else's tree.
    expect(() => cloneForRehearsal(root), "a tree escaping through .claude was previewed anyway")
      .toThrow(/pointing outside it/);
  });

  test("SC-1887: an excluded path that is itself a link is skipped and its target survives", () => {
    // The common case — the pre-push hook makes `node_modules` a link.
    // Previously it was copied and then unlinked; now it is never read.
    const root = project("excluded-link");
    const real = scratch("excluded-link-real");
    writeFileSync(join(real, "installed.txt"), "deps\n");
    symlinkSync(real, join(root, "node_modules"));

    const r = cloneForRehearsal(root);
    roots.push(r.parent);
    expect(existsSync(join(r.dir, "node_modules")), "the excluded link was copied into the clone")
      .toBe(false);
    expect(existsSync(join(real, "installed.txt")), "the link's target was deleted").toBe(true);
    // The audit still ran — an excluded link must not refuse it.
    expect(existsSync(join(r.dir, "README.md"))).toBe(true);
  });
});

describe("#549: the hand-added routing row the broken scaffold forced", () => {
  function routingRows(root: string): string[] {
    const routing = generateScopedRules(scanProject(root)).find(r => r.filename === "specs-routing.md");
    expect(routing, `the generator produced no specs-routing.md for ${root}`).toBeTruthy();
    return routing!.content.split("\n").filter(l => l.startsWith("| "));
  }

  test("SC-1890: a spec the scan can see gets a generated row, so no row needs adding by hand", () => {
    // The cost #549 names beyond the error message. With `scaffold` unable to
    // run, a new spec's row has to be added to `.claude/rules/specs-routing.md`
    // by hand — which converts a GENERATED file into a provenance-preserved
    // one (#370), so it stops regenerating and every subsequent spec needs the
    // same manual step.
    //
    // Asserted as the PROPERTY rather than by naming one spec. A case that
    // names the spec whose row was added by hand measures which checkout it is
    // running in: the row is absent until that branch lands, present after,
    // and the test reports the generator as broken in both of the states where
    // it is working correctly. The property — the scan sees a spec, the
    // generator writes its row — is what makes dropping the divergence safe,
    // and it is true in every checkout.
    const root = project("routing");
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "A-BRAND-NEW-SPEC.md"),
      "---\ndoc-type: spec\ntestable: true\ngov0: x\ngoverns: something this project does\n---\n# A\n");

    const rows = routingRows(root);
    expect(rows.some(l => l.includes("A-BRAND-NEW-SPEC.md")),
      `a spec dropped into specs/ produced no row; rows were:\n${rows.join("\n")}`).toBe(true);
    // The instrument: `includes` over a table would also be true of a
    // substring that drifted in from somewhere else, so a name the project
    // does not have must NOT appear.
    expect(rows.some(l => l.includes("A-SPEC-THAT-IS-NOT-THERE.md")),
      "the table names a spec the project does not contain").toBe(false);
  });

  test("SC-1890: every spec this repo's scan found is in this repo's generated table", () => {
    // The same property against the real tree, which is the one the hand edit
    // was made in. Driven off the scan's own list rather than a filename, so
    // adding or removing a spec cannot make it stale.
    const root = join(import.meta.dir, "..");
    const scan = scanProject(root);
    expect(scan.specs.length, "the scan found no specs, so containing all of them proves nothing")
      .toBeGreaterThan(10);

    const rows = routingRows(root);
    const absent = scan.specs.map(s => s.file).filter(f => !rows.some(l => l.includes(`| ${f} |`)));
    expect(absent, `the scan found specs the routing table does not list`).toEqual([]);
  });
});

describe("#549: a clone that refuses to be deleted is handled, not thrown", () => {
  test("SC-1888: an immutable file in the clone does not survive the discard", () => {
    // `cp -Rc` is a clonefile and a clonefile carries BSD FILE FLAGS. This
    // repository sets `uchg` on `gates/prompts/*.md` — the prompt
    // immutability feature, working — so the clone holds immutable files
    // and `rm` answers "Operation not permitted", which bun reports as
    // `EFAULT: bad address in system call argument, rm`. That throw killed
    // a scaffold run whose report had already printed, and it is the error
    // #549 was filed with. The 737 MB directory made it slower and held
    // most of the flagged copies; the thing `rm` refused was a flag.
    if (process.platform !== "darwin") {
      // Said rather than skipped. BSD file flags do not exist on Linux, so
      // there is nothing for this case to measure there — and a silent
      // return would be indistinguishable from a pass.
      console.warn("SC-1888: UNMEASURED on this platform — BSD file flags are macOS/BSD only");
      return;
    }
    const root = project("immutable");
    const locked = join(root, "src", "locked.md");
    writeFileSync(locked, "immutable\n");
    expect(spawnSync("chflags", ["uchg", locked]).status, "chflags is unavailable, so the fixture is empty")
      .toBe(0);

    const r = cloneForRehearsal(root);
    const cloned = join(r.dir, "src", "locked.md");
    expect(existsSync(cloned)).toBe(true);
    // The INSTRUMENT: the flag has to have survived the copy, or the case
    // is removing an ordinary file and proving nothing.
    expect(
      spawnSync("ls", ["-lO", cloned], { encoding: "utf-8" }).stdout,
      "the clone did not carry the uchg flag, so this fixture cannot witness the fix",
    ).toContain("uchg");

    expect(discardRehearsal(r), "the clone could not be removed").toBeNull();
    expect(existsSync(r.parent), "the rehearsal clone is still on disk").toBe(false);
  });

  test("SC-1888: a clone that truly cannot be removed is reported, not thrown", () => {
    // The report has already printed by the time cleanup runs, so a throw
    // here loses the audit. A silent return loses the leak, which is #437.
    const holder = scratch("undeletable");
    const parent = join(holder, "rungate-rehearsal-x");
    mkdirSync(join(parent, "tree"), { recursive: true });
    writeFileSync(join(parent, "tree", "f.txt"), "x\n");
    // A directory with no write permission cannot have its children
    // removed, so the recursive delete of `parent` fails from above.
    chmodSync(holder, 0o500);
    unlock.push(holder);

    const leaked = discardRehearsal({ dir: join(parent, "tree"), parent, method: "copy", source: holder });
    expect(leaked, "an undeletable clone reported success").not.toBeNull();
    expect(leaked).toContain(parent);
    expect(leaked, "the warning does not say the consumer's tree is safe")
      .toContain("nothing in the consumer's tree was touched");

    chmodSync(holder, 0o700);
    // …and the ordinary case still returns null, or the row above is
    // satisfied by a function that always complains.
    expect(discardRehearsal({ dir: join(parent, "tree"), parent, method: "copy", source: holder }))
      .toBeNull();
  });
});
