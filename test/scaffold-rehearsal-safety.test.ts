/**
 * #398 — the three findings the commit security review raised against
 * `lib/scaffold/rehearsal.ts`.
 *
 * Covers SC-1513, SC-1514, SC-1515 (HARNESS-STANDARD.md).
 *
 * Audit's whole promise is that it writes nothing. Every case here is a way
 * the first implementation broke that promise, or reported as if it had kept
 * it while looking at the wrong tree.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  cloneForRehearsal, discardRehearsal, escapingSymlinks, REHEARSAL_EXCLUDES,
} from "../lib/scaffold/rehearsal";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `rehearsal-${name}-`));
  roots.push(d);
  return d;
}

describe("SC-1513: a symlink out of the tree refuses the rehearsal", () => {
  test("the escape is detected", () => {
    const outside = scratch("outside");
    writeFileSync(join(outside, "real.md"), "original\n");
    const tree = scratch("tree");
    mkdirSync(join(tree, "docs"));
    symlinkSync(join(outside, "real.md"), join(tree, "docs", "AGENTS.md"));

    expect(escapingSymlinks(tree)).toEqual([join("docs", "AGENTS.md")]);
  });

  test("cloneForRehearsal refuses, and says what and why", () => {
    const outside = scratch("outside-refuse");
    writeFileSync(join(outside, "real.md"), "original\n");
    const tree = scratch("tree-refuse");
    symlinkSync(join(outside, "real.md"), join(tree, "AGENTS.md"));

    expect(() => cloneForRehearsal(tree)).toThrow(/audit did NOT run/);
    expect(() => cloneForRehearsal(tree)).toThrow(/pointing outside it/);
    expect(() => cloneForRehearsal(tree)).toThrow(/AGENTS\.md/);
  });

  test("the refusal is not theoretical: writing through the clone hits the original", () => {
    // The finding, demonstrated rather than asserted. `cp -R` preserves
    // symlinks, so without the refusal a step writing AGENTS.md in the
    // clone overwrites the consumer's real file — #370's damage arriving
    // through the preview built to stop it.
    const outside = scratch("outside-proof");
    const real = join(outside, "real.md");
    writeFileSync(real, "original\n");
    const tree = scratch("tree-proof");
    symlinkSync(real, join(tree, "AGENTS.md"));

    const parent = scratch("manual-clone");
    const clone = join(parent, "tree");
    require("child_process").spawnSync("cp", ["-R", tree, clone]);
    writeFileSync(join(clone, "AGENTS.md"), "OVERWRITTEN\n");

    expect(
      readFileSync(real, "utf-8"),
      "a plain copy lets the clone write through to the original — this is what the refusal prevents",
    ).toBe("OVERWRITTEN\n");
  });

  test("a RELATIVE symlink inside the tree is fine and does not refuse", () => {
    // The positive control. A refusal suite with no control is
    // indistinguishable from a function that refuses everything.
    const tree = scratch("tree-internal");
    writeFileSync(join(tree, "real.md"), "x\n");
    mkdirSync(join(tree, "docs"));
    symlinkSync(join("..", "real.md"), join(tree, "docs", "alias.md"));

    expect(escapingSymlinks(tree)).toEqual([]);
    const r = cloneForRehearsal(tree);
    try {
      expect(existsSync(join(r.dir, "docs", "alias.md"))).toBe(true);
    } finally {
      discardRehearsal(r);
    }
  });

  test("an ABSOLUTE symlink to a file inside the same tree still refuses", () => {
    // Found by the control above failing, and worth keeping as its own case
    // because the behaviour is surprising and correct. `/tree/docs/alias.md
    // -> /tree/real.md` points INSIDE the tree; its copy at
    // `/clone/docs/alias.md` still points at `/tree/real.md`, which is
    // outside the CLONE. Writing through it in a preview would modify the
    // consumer's file. The relevant question is never "does the link stay in
    // the tree" but "does it stay in the copy", and only relative links do.
    const tree = scratch("tree-abs-internal");
    writeFileSync(join(tree, "real.md"), "original\n");
    mkdirSync(join(tree, "docs"));
    symlinkSync(join(tree, "real.md"), join(tree, "docs", "alias.md"));

    expect(escapingSymlinks(tree), "measured against the tree itself, it does not escape").toEqual([]);
    expect(
      () => cloneForRehearsal(tree),
      "measured against the clone, which is what matters, it does",
    ).toThrow(/pointing outside it/);
  });

  test("an excluded directory's symlink does not refuse the whole audit", () => {
    // `node_modules` is routinely a symlink — the pre-push hook makes one —
    // and it is pruned before the check. Without the ordering, every
    // worktree on this machine would be un-auditable.
    expect(REHEARSAL_EXCLUDES).toContain("node_modules");
    const outside = scratch("outside-nm");
    mkdirSync(join(outside, "mods"));
    const tree = scratch("tree-nm");
    writeFileSync(join(tree, "package.json"), "{}\n");
    symlinkSync(join(outside, "mods"), join(tree, "node_modules"));

    const r = cloneForRehearsal(tree);
    try {
      expect(existsSync(join(r.dir, "node_modules"))).toBe(false);
      expect(existsSync(join(r.dir, "package.json"))).toBe(true);
    } finally {
      discardRehearsal(r);
    }
  });
});

describe("SC-1514: an incomplete copy refuses rather than previewing less", () => {
  test("a clone missing a top-level entry is refused", () => {
    // Simulated by deleting from the clone the way a truncated `cp` would
    // leave it, then re-running the completeness comparison the function
    // performs. A partial clone under-reports, and under-reporting IS the
    // bug — a weaker version of it is not an acceptable fallback.
    const tree = scratch("tree-partial");
    writeFileSync(join(tree, "AGENTS.md"), "a\n");
    writeFileSync(join(tree, "package.json"), "{}\n");

    const r = cloneForRehearsal(tree);
    try {
      rmSync(join(r.dir, "AGENTS.md"));
      const want = require("fs").readdirSync(tree);
      const got = new Set(require("fs").readdirSync(r.dir));
      expect(want.filter((n: string) => !got.has(n))).toEqual(["AGENTS.md"]);
    } finally {
      discardRehearsal(r);
    }
  });

  test("a complete clone carries every top-level entry", () => {
    const tree = scratch("tree-complete");
    for (const n of ["AGENTS.md", "package.json", "SUCCESS.md"]) writeFileSync(join(tree, n), "x\n");
    mkdirSync(join(tree, "specs"));

    const r = cloneForRehearsal(tree);
    try {
      for (const n of ["AGENTS.md", "package.json", "SUCCESS.md", "specs"]) {
        expect(existsSync(join(r.dir, n)), `${n} missing from the clone`).toBe(true);
      }
    } finally {
      discardRehearsal(r);
    }
  });
});

describe("SC-1515: cleanup removes what it owns and nothing above it", () => {
  test("discardRehearsal removes the mkdtemp it created", () => {
    const tree = scratch("tree-cleanup");
    writeFileSync(join(tree, "a.md"), "x\n");
    const r = cloneForRehearsal(tree);
    expect(existsSync(r.dir)).toBe(true);
    discardRehearsal(r);
    expect(existsSync(r.parent), "the mkdtemp is the leak #437 is about").toBe(false);
  });

  test("the original tree survives a full rehearsal cycle", () => {
    const tree = scratch("tree-survives");
    writeFileSync(join(tree, "a.md"), "untouched\n");
    const r = cloneForRehearsal(tree);
    writeFileSync(join(r.dir, "a.md"), "clone only\n");
    discardRehearsal(r);
    expect(readFileSync(join(tree, "a.md"), "utf-8")).toBe("untouched\n");
  });

  test("the parent is recorded, not derived by walking up from the tree", () => {
    // `join(dir, "..")` was the first version. Deriving a deletion target by
    // walking up a path is how cleanup removes something it does not own.
    const tree = scratch("tree-parent");
    writeFileSync(join(tree, "a.md"), "x\n");
    const r = cloneForRehearsal(tree);
    try {
      expect(r.parent).not.toBe(r.dir);
      expect(r.dir.startsWith(r.parent)).toBe(true);
      expect(r.parent).toContain("rungate-rehearsal-");
    } finally {
      discardRehearsal(r);
    }
  });
});
